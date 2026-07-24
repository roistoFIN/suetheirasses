import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { PrismaClient } from '@prisma/client';
import { setupSocketHandlers } from './socket/gameEngine.js';
import { requireAdminToken } from './middleware/adminAuth.js';
import { validateDecisionDefinition, validateGameConfig, validateFormulaUpdate } from './validation/schemas.js';
import { generateDecisionCandidate, type DecisionGenRequest } from './services/decisionGenService.js';

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
  } catch (error: any) {
    res.status(400).json({ error: 'Invalid decision definition', message: error.message });
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
  } catch (error: any) {
    res.status(400).json({ error: 'Invalid decision definition', message: error.message });
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

  const result = await generateDecisionCandidate(request, existingNames, fewShotExample);
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
  } catch (error: any) {
    res.status(400).json({ error: 'Invalid game config', message: error.message });
  }
});

// The pure, scalar, named-input formulas (competitiveness, P&L, risk gauge, etc.) — DB-backed
// (see CLAUDE.md's "Formulas are DB-backed"). No POST/DELETE — the key set is
// fixed, since each one is referenced by name at a specific calcEngine.ts call
// site GameLoop hard-depends on; only the expression/description text is editable.
app.get('/api/admin/formulas', requireAdminToken, (_req, res) => {
  res.json({ formulas: engine.getFormulasSnapshot() });
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
  } catch (error: any) {
    res.status(400).json({ error: 'Invalid formula', message: error.message });
  }
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('Shutting down...');
  engine.stop();
  await prisma.$disconnect();
  httpServer.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

// Start server with DB readiness check
async function start() {
  try {
    await prisma.$connect();
    console.log('Database connected');
    // Must complete before the port opens — no socket can connect (and no admin
    // request can land) before the decision library + game config are loaded.
    await engine.loadGameData();
    console.log('Game data loaded from database');
    httpServer.listen(PORT, () => {
      console.log(`Game server running on port ${PORT}`);
      console.log(`Socket.IO server ready`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

start();

export { io, prisma };
