import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { PrismaClient } from '@prisma/client';
import { setupSocketHandlers } from './socket/gameEngine.js';
import { requireAdminToken } from './middleware/adminAuth.js';
import { validateDecisionDefinition, validateGameConfig, validateFormulaUpdate, validateFeedbackSubmit } from './validation/schemas.js';
import { generateDecisionCandidate, type DecisionGenRequest } from './services/decisionGenService.js';
import { logEvent } from './services/eventLogService.js';
import { aggregateDecisionAnalytics, aggregateLawsuitAnalytics, aggregatePerformanceAnalytics } from './services/analyticsService.js';
import type { FeedbackEntry, FeedbackSource, EventLogEntry, EventSeverity } from '@suetheirasses/shared';

const app = express();
const httpServer = createServer(app);
const PORT = process.env.PORT || 3001;

const prisma = new PrismaClient({
  log: process.env.NODE_ENV === 'development' ? ['query', 'warn', 'error'] : ['error'],
});

// Allowed origins: Vite dev (:5173), Docker client (:80), and any custom origins from CLIENT_URL
const DEFAULT_ORIGINS = ['http://localhost:5173', 'http://localhost:80', 'http://localhost'];
const allowedOrigins = process.env.CLIENT_URL
  ? [...new Set([...process.env.CLIENT_URL.split(',').map((url) => url.trim()), ...DEFAULT_ORIGINS])]
  : DEFAULT_ORIGINS;

const io = new Server(httpServer, {
  cors: {
    origin: allowedOrigins,
    credentials: true,
  },
  pingTimeout: 60000,
  pingInterval: 25000,
});

// Middleware
app.use(cors({
  origin: allowedOrigins,
  credentials: true,
}));
app.use(express.json());

// Health check endpoint
app.get('/health', async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ status: 'ok', timestamp: new Date().toISOString(), db: 'connected' });
  } catch {
    res.status(503).json({ status: 'degraded', timestamp: new Date().toISOString(), db: 'disconnected' });
  }
});

// REST endpoint: get room info
app.get('/api/room/:roomId', async (req, res) => {
  try {
    const room = await prisma.room.findUnique({
      where: { id: req.params.roomId },
      include: {
        players: { include: { company: { include: { assets: true } } } },
      },
    });
    if (!room) {
      return res.status(404).json({ error: 'Room not found' });
    }
    res.json(room);
  } catch (error) {
    console.error('Error fetching room:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Player-submitted feedback (1-5 Likert rating + optional free text) — a plain public
// REST endpoint, not a socket event, since the landing-page form has no room/socket to
// piggyback on and the game-over form shouldn't behave differently just because one
// exists. Deliberately anonymous (no player/room id accepted or stored) — see the
// `Feedback` Prisma model's own doc comment.
app.post('/api/feedback', async (req, res) => {
  try {
    const feedback = validateFeedbackSubmit(req.body);
    await prisma.feedback.create({
      data: {
        rating: feedback.rating,
        message: feedback.message ?? null,
        source: feedback.source,
      },
    });
    res.status(201).json({ ok: true });
  } catch (error) {
    res.status(400).json({ error: 'Invalid feedback', message: error instanceof Error ? error.message : String(error) });
  }
});

// Socket.IO setup
const engine = setupSocketHandlers(io, prisma);

// Admin portal REST endpoints — gated by ADMIN_TOKEN (see middleware/adminAuth.ts).
app.get('/api/admin/rooms', requireAdminToken, (_req, res) => {
  res.json({ rooms: engine.getAdminRoomsSnapshot() });
});

app.get('/api/admin/config', requireAdminToken, (_req, res) => {
  res.json(engine.getGameConfigSnapshot());
});

// The decision library + game config now live in the database (see
// GameEngine.loadGameData()) and are editable here — writes take effect on the
// very next turn resolved anywhere, no restart needed (GameLoop.loadDecisions /
// updateConfig are re-called after every successful write).
app.get('/api/admin/decisions', requireAdminToken, (_req, res) => {
  res.json({ decisions: engine.getDecisionsSnapshot() });
});

app.post('/api/admin/decisions', requireAdminToken, async (req, res) => {
  try {
    const def = validateDecisionDefinition(req.body);
    const result = await engine.upsertDecision(def, true);
    if (!result.success) {
      res.status(409).json({ error: 'Decision already exists', reason: result.reason });
      return;
    }
    res.status(201).json(def);
  } catch (error) {
    res.status(400).json({ error: 'Invalid decision definition', message: error instanceof Error ? error.message : String(error) });
  }
});

app.put('/api/admin/decisions/:name', requireAdminToken, async (req, res) => {
  try {
    const def = validateDecisionDefinition(req.body);
    if (def.decision !== req.params.name) {
      res.status(400).json({ error: 'Renaming a decision is not supported — delete and create instead' });
      return;
    }
    const result = await engine.upsertDecision(def, false);
    if (!result.success) {
      res.status(404).json({ error: 'Decision not found', reason: result.reason });
      return;
    }
    res.json(def);
  } catch (error) {
    res.status(400).json({ error: 'Invalid decision definition', message: error instanceof Error ? error.message : String(error) });
  }
});

app.delete('/api/admin/decisions/:name', requireAdminToken, async (req, res) => {
  const result = await engine.deleteDecision(req.params.name);
  if (!result.success) {
    const status = result.reason === 'in_use' ? 409 : 404;
    const message = result.reason === 'in_use'
      ? 'Decision is currently deployed by an active player — cannot delete'
      : 'Decision not found';
    res.status(status).json({ error: message, reason: result.reason });
    return;
  }
  res.status(204).end();
});

// EXPERIMENTAL — asks the local llama.cpp/Qwen3-1.7B server (see decisionGenService.ts)
// to invent a new decision + its legal-risk grounds. Deliberately never writes to the
// DB itself: the response is a draft for the admin's own review, which still has to
// go through the normal, unmodified POST /api/admin/decisions (same
// decisionDefinitionSchema gate a hand-written decision goes through) to actually be
// saved. See CLAUDE.md's "AI decision generation (experimental)" section.
app.post('/api/admin/decisions/generate', requireAdminToken, async (req, res) => {
  const body = req.body ?? {};
  const request: DecisionGenRequest = {
    theme: typeof body.theme === 'string' ? body.theme.slice(0, 200) : undefined,
    level: body.level === 'Strategic' || body.level === 'Operational' || body.level === 'Financial' ? body.level : undefined,
    nature: ['Traditional', 'Grey Area', 'Dirty'].includes(body.nature) ? body.nature : undefined,
    offensive: body.offensive === true,
  };

  const existing = engine.getDecisionsSnapshot();
  const existingNames = existing.map((d) => d.decision);
  const fewShotExample = existing[Math.floor(Math.random() * existing.length)];

  const genStart = Date.now();
  const result = await generateDecisionCandidate(request, existingNames, fewShotExample);
  // Same "llm.call" event type getAnnualReport's own calls use (see GameEngine.logLlmCall)
  // — no room/player context exists for an admin-only tool, so both are left unset.
  await logEvent(prisma, {
    eventType: 'llm.call',
    severity: result.success ? 'info' : 'warning',
    payload: { kind: 'decisionGen', latencyMs: Date.now() - genStart, success: result.success, attempts: result.attempts },
  });
  if (!result.success) {
    res.status(502).json({ error: 'Generation failed', message: result.error, raw: result.raw, attempts: result.attempts });
    return;
  }
  res.json({ decision: result.decision, warnings: result.warnings, attempts: result.attempts });
});

app.put('/api/admin/config', requireAdminToken, async (req, res) => {
  try {
    const config = validateGameConfig(req.body);
    await engine.updateGameConfigData(config);
    res.json(config);
  } catch (error) {
    res.status(400).json({ error: 'Invalid game config', message: error instanceof Error ? error.message : String(error) });
  }
});

// The pure, scalar, named-input formulas (competitiveness, P&L, risk gauge, etc.) — DB-backed
// (see CLAUDE.md's "Formulas are DB-backed"). No POST/DELETE — the key set is
// fixed, since each one is referenced by name at a specific calcEngine.ts call
// site GameLoop hard-depends on; only the expression/description text is editable.
app.get('/api/admin/formulas', requireAdminToken, (_req, res) => {
  res.json({ formulas: engine.getFormulasSnapshot() });
});

// Read-only — feedback is collected via the public POST /api/feedback above and never
// written from the admin side. Anonymous by design (see the Feedback Prisma model), so
// there's nothing here to edit, only to review.
app.get('/api/admin/feedback', requireAdminToken, async (_req, res) => {
  const rows = await prisma.feedback.findMany({ orderBy: { createdAt: 'desc' } });
  const feedback: FeedbackEntry[] = rows.map((r) => ({
    id: r.id,
    rating: r.rating,
    message: r.message,
    source: r.source as FeedbackSource,
    createdAt: r.createdAt.toISOString(),
  }));
  res.json({ feedback });
});

app.put('/api/admin/formulas/:key', requireAdminToken, async (req, res) => {
  try {
    const { expression, description } = validateFormulaUpdate(req.params.key, req.body);
    const result = await engine.updateFormula(req.params.key, expression, description);
    if (!result.success) {
      res.status(404).json({ error: 'Formula not found', reason: result.reason });
      return;
    }
    res.json({ key: req.params.key, expression, description });
  } catch (error) {
    res.status(400).json({ error: 'Invalid formula', message: error instanceof Error ? error.message : String(error) });
  }
});

// ============================================================
// Admin Analytics tab — raw EventLog feed + three aggregate dashboards. All read-only,
// all built directly from the durable EventLog/LegalCaseHistory tables (never in-memory
// engine state), since the whole point is to survive individual games and answer
// cross-game questions ("how does decision X actually perform") after the fact. See
// CLAUDE.md's EventLog section for what gets logged and why.
// ============================================================

// Raw, filterable event feed — the "what happened in room X" bug-tracing view.
// `before` (an ISO timestamp) pages backward in time; `limit` is clamped to 500 so an
// admin can't accidentally request an unbounded scan.
app.get('/api/admin/events', requireAdminToken, async (req, res) => {
  const { eventType, severity, roomId, playerId, before } = req.query as Record<string, string | undefined>;
  const limitRaw = Number(req.query.limit);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 500) : 100;

  const where: Record<string, unknown> = {};
  if (eventType) where.eventType = eventType;
  if (severity) where.severity = severity;
  if (roomId) where.roomId = roomId;
  if (playerId) where.playerId = playerId;
  if (before) {
    const beforeDate = new Date(before);
    if (!Number.isNaN(beforeDate.getTime())) where.createdAt = { lt: beforeDate };
  }

  const rows = await prisma.eventLog.findMany({ where, orderBy: { createdAt: 'desc' }, take: limit });
  const events: EventLogEntry[] = rows.map((r) => ({
    id: r.id,
    eventType: r.eventType,
    severity: r.severity as EventSeverity,
    roomId: r.roomId,
    playerId: r.playerId,
    payload: r.payload as Record<string, unknown>,
    createdAt: r.createdAt.toISOString(),
  }));
  res.json({ events });
});

// Decision-balance dashboard — productionizes the one-off randomized-simulation balance
// analysis (see CLAUDE.md's decision-balance sections) against REAL played games instead
// of a synthetic script. Cross-references decision.deployed/decision.rejected events
// against game.completed events (roomId -> winning playerId) to compute a real win-rate
// correlation. Capped scans, not a full-table aggregate query — admin-portal scale, not
// hot-path, and JSONB payload fields aren't indexed for GROUP BY anyway.
app.get('/api/admin/analytics/decisions', requireAdminToken, async (_req, res) => {
  const MAX_EVENTS = 20_000;
  const [deployedRows, rejectedRows, completedRows] = await Promise.all([
    prisma.eventLog.findMany({ where: { eventType: 'decision.deployed' }, orderBy: { createdAt: 'desc' }, take: MAX_EVENTS }),
    prisma.eventLog.findMany({ where: { eventType: 'decision.rejected' }, orderBy: { createdAt: 'desc' }, take: MAX_EVENTS }),
    prisma.eventLog.findMany({ where: { eventType: 'game.completed' }, orderBy: { createdAt: 'desc' }, take: 5_000 }),
  ]);
  res.json(aggregateDecisionAnalytics(deployedRows, rejectedRows, completedRows));
});

// Lawsuit win-rate dashboard — read from LegalCaseHistory (already durable, already
// denormalized), not EventLog; a lawsuit's full lifecycle is already fully captured
// there (see CLAUDE.md's LegalCaseHistory section), so there's nothing to duplicate.
app.get('/api/admin/analytics/lawsuits', requireAdminToken, async (_req, res) => {
  const rows = await prisma.legalCaseHistory.findMany({ orderBy: { createdAt: 'desc' }, take: 20_000 });
  res.json(aggregateLawsuitAnalytics(rows.map((r) => ({ ...r, stakes: Number(r.stakes) }))));
});

// Performance dashboard — turn-resolution duration (GameLoop's own internal compute time
// vs. GameEngine's full wall-clock including persistence), LLM call latency/success rate
// by kind (annualReport / decisionGen), and an error-context breakdown (same rows the raw
// feed's severity=error filter shows, just pre-aggregated by `payload.context`).
app.get('/api/admin/analytics/performance', requireAdminToken, async (_req, res) => {
  const [turnRows, llmRows, errorRows] = await Promise.all([
    prisma.eventLog.findMany({ where: { eventType: 'turn.resolved' }, orderBy: { createdAt: 'desc' }, take: 2_000 }),
    prisma.eventLog.findMany({ where: { eventType: 'llm.call' }, orderBy: { createdAt: 'desc' }, take: 5_000 }),
    prisma.eventLog.findMany({ where: { severity: 'error' }, orderBy: { createdAt: 'desc' }, take: 2_000 }),
  ]);
  res.json(aggregatePerformanceAnalytics(turnRows, llmRows, errorRows));
});

// Graceful shutdown
process.on('SIGINT', async () => {
  engine.stop();
  await prisma.$disconnect();
  httpServer.close(() => {
    process.exit(0);
  });
});

// Start server with DB readiness check
async function start() {
  try {
    await prisma.$connect();
    // Must complete before the port opens — no socket can connect (and no admin
    // request can land) before the decision library + game config are loaded.
    await engine.loadGameData();
    httpServer.listen(PORT);
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

start();

export { io, prisma };
