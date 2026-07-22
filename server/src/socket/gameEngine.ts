import { Server, Socket } from 'socket.io';
import { PrismaClient } from '@prisma/client';
import {
  RoomStatus,
  ClientEvents,
  ServerEvents,
  PHASE_TIMERS,
  PHASE_ORDER,
  MAX_PLAYERS,
  type Player,
  type Room,
  type RoomState,
  type RoomInfo,
  type Company,
  type GameOverResponse,
  type PlayerStanding,
  type DecisionDefinition,
  type GameConfig,
  type GameSettings,
  type TurnResolutionResult,
  type PlayerTurnResult,
  type AnnualReportEntry,
  type AdminRoomSnapshot,
  type FormulaInfo,
  type GameReadyUpdateResponse,
  type KpiHistoryResponse,
} from '@suetheirasses/shared';
import { validateRoomJoin, validateSubmitDecisions, validateDigDeeper, validateFileLawsuit, validateRoomRejoin, validateAnnualReportRequest, validateChatMessage, validateGameReady, validateRoomSetInviteOnly, validateKpiHistoryRequest, validateMakeOffer, validateAcceptOffer, validateGoToCourt, validateDigDeeperCase } from '../validation/schemas.js';
import { GameLoop } from '../engine/gameLoop.js';
import { generateAnnualReportBlurb } from '../services/llmService.js';

export class GameEngine {
  public rooms: Map<string, RoomState> = new Map();
  private playerToRoom: Map<string, string> = new Map();
  private prisma: PrismaClient;
  private io: Server;
  // Lock to prevent concurrent phase advances (race condition guard)
  private advancingRooms: Set<string> = new Set();
  // Heartbeat: track last activity per room to detect stale/disconnected rooms
  private roomLastActivity: Map<string, number> = new Map();
  private cleanupInterval: NodeJS.Timeout | null = null;
  // How long (ms) before a room with no connected players is considered stale
  private readonly STALE_ROOM_THRESHOLD = 60_000;
  // Reconnection grace period: players who disconnect are kept in the room (not
  // deleted) for this long, keyed by playerId since their old socketId is now dead.
  // Swept by the same heartbeat interval that cleans up stale rooms.
  private disconnectedPlayers: Map<string, { roomId: string; disconnectedAt: number }> = new Map();
  private readonly RECONNECT_GRACE_PERIOD_MS = 60_000;
  // Each room's last resolved turn (or round-1 starting snapshot) — re-sent to a
  // reconnecting player immediately instead of making them wait for the next turn.
  private lastTurnResults: Map<string, TurnResolutionResult> = new Map();
  // Core turn-resolution engine — authoritative source of all GAME_PHASE calculations (FORMULAS.md).
  // Definite-assignment: only ever used after loadGameData() resolves (see index.ts's
  // start() — awaited before httpServer.listen, so no socket can connect first).
  private gameLoop!: GameLoop;
  // In-memory mirror of the `decisions` table — the decision library, live-reloaded
  // (loadDecisions() called again) on every admin create/update/delete via /admin.
  // Also supplies the competitorsView fallback text for getAnnualReport when the LLM
  // is unreachable.
  private decisionsByName!: Map<string, DecisionDefinition>;
  // In-memory mirror of the `game_config` singleton row — gameSettings/
  // playerStartingValues/adminVariables, live-reloaded on every admin config edit.
  private gameConfig!: GameConfig;
  // In-memory mirror of the `formulas` table — the pure, scalar, named-input
  // formulas from FORMULAS.md §2-§7, live-reloaded on every admin formula edit.
  // Fixed key set (no create/delete via /admin) — see CLAUDE.md.
  private formulasByKey!: Map<string, { expression: string; description: string }>;

  constructor(io: Server, prisma: PrismaClient) {
    this.io = io;
    this.prisma = prisma;
    this.startHeartbeatCleanup();
  }

  /**
   * Loads the decision library + game config from the database — must be awaited
   * once, before the server starts accepting connections (see index.ts's start()).
   * Decisions/config used to be static JSON imports; the DB is now authoritative at
   * runtime and this is the only place that reads it at startup. `server/src/data/
   * *.json` remain on disk purely as the versioned seed source for `npm run db:seed`
   * (see prisma/seed.ts) — editing them directly no longer has any runtime effect.
   */
  async loadGameData(): Promise<void> {
    const configRow = await this.prisma.gameConfigRow.findUnique({ where: { id: 1 } });
    if (!configRow) {
      throw new Error('GameConfigRow (id=1) not found — run `npm run db:seed` to populate it.');
    }
    this.gameConfig = {
      gameSettings: configRow.gameSettings as unknown as GameSettings,
      playerStartingValues: configRow.playerStartingValues as unknown as GameConfig['playerStartingValues'],
      adminVariables: configRow.adminVariables as unknown as GameConfig['adminVariables'],
    };
    this.gameLoop = new GameLoop(this.gameConfig);

    const decisionRows = await this.prisma.decision.findMany();
    const decisions = decisionRows.map((r) => r.data as unknown as DecisionDefinition);
    this.decisionsByName = new Map(decisions.map((d) => [d.decision, d]));
    this.gameLoop.loadDecisions(decisions);

    const formulaRows = await this.prisma.formula.findMany();
    this.formulasByKey = new Map(formulaRows.map((r) => [r.key, { expression: r.expression, description: r.description }]));
    this.gameLoop.loadFormulas(formulaRows.map((r) => ({ key: r.key, expression: r.expression })));
  }

  /** Current formula set, for `GET /api/admin/formulas`. */
  getFormulasSnapshot(): FormulaInfo[] {
    return Array.from(this.formulasByKey.entries()).map(([key, v]) => ({ key, ...v }));
  }

  /**
   * Update one formula's expression/description — the key set is fixed (no create/
   * delete via /admin; each key is referenced by name at a specific calcEngine.ts
   * call site GameLoop hard-depends on). The caller (the `PUT /api/admin/formulas/:key`
   * route) must already have validated the expression's syntax and variable whitelist
   * via `validateFormulaUpdate` before calling this — a bad formula must never reach
   * here, since this writes straight through to GameLoop's live formula set.
   */
  async updateFormula(key: string, expression: string, description: string): Promise<{ success: boolean; reason?: 'not_found' }> {
    if (!this.formulasByKey.has(key)) return { success: false, reason: 'not_found' };

    await this.prisma.formula.update({ where: { key }, data: { expression, description } });
    this.formulasByKey.set(key, { expression, description });
    this.gameLoop.loadFormulas(
      Array.from(this.formulasByKey.entries()).map(([k, v]) => ({ key: k, expression: v.expression })),
    );
    return { success: true };
  }

  /** Submit one player's decisions for the current GAME_PHASE turn. */
  submitDecisions(roomId: string, playerId: string, decisions: import('@suetheirasses/shared').SubmittedDecisions): void {
    this.gameLoop.submitDecisions(roomId, playerId, decisions);
  }

  /**
   * "Dig Deeper" — pay to reveal the next tier of intel on one incoming attack. Unlike
   * `resolveGameTurn`, this happens instantly, outside the turn-resolution cycle: a
   * single Prisma write for the requesting player only, no broadcast to the room (the
   * attacker's identity is private intel for the investigating player alone).
   */
  async digDeeper(roomId: string, playerId: string, attackId: string): Promise<import('../engine/gameLoop.js').DigDeeperOutcome> {
    const dbPlayers = await this.loadActiveCompanyPlayers(roomId);
    const outcome = this.gameLoop.digDeeper(playerId, attackId, dbPlayers);
    if (outcome.success) {
      await this.prisma.company.update({
        where: { playerId },
        data: {
          cash: outcome.newCash,
          // GameLoop reads cash from variables.cash (JSONB), not the cash column — both
          // must be written or the next dig (or the next normal turn resolution) reads
          // stale pre-deduction cash back out.
          variables: outcome.variables as any,
          engineState: outcome.engineStateUpdate as any,
        },
      });
    }
    return outcome;
  }

  /**
   * Charge the flat lawsuit filing fee the instant a player files (SueModal's "File"
   * button) — like `digDeeper`, this happens instantly, outside the turn-resolution
   * cycle: a single Prisma write for the requesting player only. The lawsuit itself is
   * still only created/validated at the next turn resolution via the normal
   * `submitDecisions` → `LegalEngine.fileLawsuit` path — this method only ever moves cash.
   */
  async fileLawsuit(roomId: string, playerId: string): Promise<import('../engine/gameLoop.js').LawsuitFilingFeeOutcome> {
    const dbPlayers = await this.loadActiveCompanyPlayers(roomId);
    const outcome = this.gameLoop.chargeLawsuitFilingFee(roomId, playerId, dbPlayers);
    if (outcome.success) {
      await this.prisma.company.update({
        where: { playerId },
        data: {
          cash: outcome.newCash,
          // GameLoop reads cash from variables.cash (JSONB), not the cash column — both
          // must be written, same requirement as digDeeper's write.
          variables: outcome.variables as any,
        },
      });
    }
    return outcome;
  }

  /**
   * Make (or counter) a settlement offer on a case still `'negotiating'` — instant,
   * outside the turn-resolution cycle, same pattern as `digDeeper`/`fileLawsuit`. Unlike
   * those single-player actions, a case touches BOTH parties: on success, both parties'
   * Company rows are written and both parties' sockets (not just the requester's) get
   * the update, via `persistLegalCaseAction`/`emitLegalCaseUpdate`.
   */
  async makeOffer(roomId: string, playerId: string, caseId: string, amount: number): Promise<import('../engine/gameLoop.js').LegalCaseActionOutcome> {
    const dbPlayers = await this.loadActiveCompanyPlayers(roomId);
    const outcome = this.gameLoop.makeOffer(playerId, caseId, amount, dbPlayers);
    if (outcome.success) {
      await this.persistLegalCaseAction(outcome);
      this.emitLegalCaseUpdate(roomId, outcome);
    }
    return outcome;
  }

  /** Accept the other party's most recent offer — settles the case immediately. Same two-party persist/emit shape as `makeOffer`. */
  async acceptOffer(roomId: string, playerId: string, caseId: string): Promise<import('../engine/gameLoop.js').LegalCaseActionOutcome> {
    const dbPlayers = await this.loadActiveCompanyPlayers(roomId);
    const outcome = this.gameLoop.acceptOffer(playerId, caseId, dbPlayers);
    if (outcome.success) {
      await this.persistLegalCaseAction(outcome);
      this.emitLegalCaseUpdate(roomId, outcome);
    }
    return outcome;
  }

  /** End negotiation and send a case to trial — only marks it `awaiting_trial`; the verdict is drawn the next time this room's turn actually resolves. Same two-party persist/emit shape as `makeOffer`. */
  async goToCourt(roomId: string, playerId: string, caseId: string): Promise<import('../engine/gameLoop.js').LegalCaseActionOutcome> {
    const dbPlayers = await this.loadActiveCompanyPlayers(roomId);
    const outcome = this.gameLoop.goToCourt(playerId, caseId, dbPlayers);
    if (outcome.success) {
      await this.persistLegalCaseAction(outcome);
      this.emitLegalCaseUpdate(roomId, outcome);
    }
    return outcome;
  }

  /** Pay `gameSettings.digDeeperCost` to reveal the probability of success on a case you're the defendant on — instant, outside the turn-resolution cycle. Same two-party persist/emit shape as `makeOffer`, even though only the defendant's cash moves. */
  async digDeeperOnCase(roomId: string, playerId: string, caseId: string): Promise<import('../engine/gameLoop.js').LegalCaseActionOutcome> {
    const dbPlayers = await this.loadActiveCompanyPlayers(roomId);
    const outcome = this.gameLoop.digDeeperOnCase(playerId, caseId, dbPlayers);
    if (outcome.success) {
      await this.persistLegalCaseAction(outcome);
      this.emitLegalCaseUpdate(roomId, outcome);
    }
    return outcome;
  }

  /** Writes both parties' Company rows for a successful `makeOffer`/`acceptOffer`/`goToCourt` outcome. `cash`/`variables` are only included in a party's write when they're actually present on that side's update (a settlement) — omitted entirely for an offer or a court decision, which never move cash. */
  private async persistLegalCaseAction(
    outcome: Extract<import('../engine/gameLoop.js').LegalCaseActionOutcome, { success: true }>,
  ): Promise<void> {
    for (const side of [outcome.plaintiff, outcome.defendant]) {
      await this.prisma.company.update({
        where: { playerId: side.playerId },
        data: {
          engineState: side.engineState as any,
          ...(side.cash !== undefined ? { cash: side.cash, variables: side.variables as any } : {}),
        },
      });
    }
  }

  /** Sends the updated case to both parties' sockets — never a room-wide broadcast, since
   * nobody but the two parties on a case has any business seeing it. Each recipient gets
   * their OWN `newCash` (undefined for a recipient whose cash didn't move). Silently
   * skips a party who's currently disconnected (`socketId` cleared by
   * `markPlayerDisconnected`) — they'll see the persisted update on reconnect or the
   * next `turn:resolved` either way. */
  private emitLegalCaseUpdate(
    roomId: string,
    outcome: Extract<import('../engine/gameLoop.js').LegalCaseActionOutcome, { success: true }>,
  ): void {
    const roomState = this.rooms.get(roomId);
    if (!roomState) return;
    for (const side of [outcome.plaintiff, outcome.defendant]) {
      const socketId = roomState.players.get(side.playerId)?.socketId;
      if (!socketId) continue;
      this.io.to(socketId).emit(ServerEvents.GAME_LEGAL_CASE_UPDATE, {
        case: outcome.case,
        newCash: side.cash,
      });
    }
  }

  /**
   * AI-narrated "annual report" text for one rival's active decisions — on demand
   * (opened from the Full Filing modal), never part of turn resolution. Re-derives the
   * rival's active decisions server-side from their Company row rather than trusting
   * anything the requesting client sent, same as `digDeeper`. Returns `null` if the
   * rival isn't found (unknown id, or bankrupted since the requester last saw them).
   */
  async getAnnualReport(roomId: string, rivalPlayerId: string): Promise<AnnualReportEntry[] | null> {
    const dbPlayers = await this.loadActiveCompanyPlayers(roomId);
    const summaries = this.gameLoop.getActiveDecisionSummaries(rivalPlayerId, dbPlayers);
    if (!summaries) return null;

    const entries = await Promise.all(
      summaries
        .map((s) => ({ summary: s, def: this.decisionsByName.get(s.decisionName) }))
        .filter((x): x is { summary: typeof x.summary; def: DecisionDefinition } => !!x.def?.competitorsView?.length)
        .map(async ({ summary, def }) => {
          const fallback = def.competitorsView![summary.elapsedYears % def.competitorsView!.length];
          const text = await generateAnnualReportBlurb({
            decisionName: summary.decisionName,
            description: summary.description,
            elapsedYears: summary.elapsedYears,
            fallback,
          });
          return { decisionName: summary.decisionName, text, year: summary.deployedYear + 1 };
        }),
    );
    return entries;
  }

  /**
   * KPI history (persisted `KpiSnapshot` rows, oldest round first) for either the
   * requesting player themselves (`includePrediction: true`, adds a 3-turn-ahead
   * `GameLoop.predictFutureKpis` projection) or a rival in the same room
   * (`includePrediction: false`, history only — predicting a rival's future from their
   * own decisions isn't offered, only real history). On demand, opened by clicking any
   * KPI card or breakdown line item in `GamePhase.tsx`, for either your own KPIs or a
   * rival's Full Filing report / mini-stats. Returns `null` only if the room itself is
   * unknown. The `kpiSnapshot` query is scoped to `player: { roomId }` — the same
   * distrust-the-client, scope-via-room pattern `getAnnualReport` uses — so a
   * `targetPlayerId` for a player in a different room (or no longer in this one) just
   * comes back with an empty `history` rather than leaking another room's data or
   * erroring. If the player has since gone bankrupt (excluded from
   * `loadActiveCompanyPlayers`), `predicted` just comes back empty rather than the whole
   * call failing — `history` is still real and worth returning.
   */
  async getKpiHistory(roomId: string, targetPlayerId: string, includePrediction: boolean): Promise<KpiHistoryResponse | null> {
    const roomState = this.rooms.get(roomId);
    if (!roomState) return null;

    const rows = await this.prisma.kpiSnapshot.findMany({
      where: { playerId: targetPlayerId, player: { roomId } },
      orderBy: { round: 'asc' },
    });
    const history = rows.map((r) => ({
      round: r.round,
      variables: r.variables as any,
      derived: r.derived as any,
      riskGauge: r.riskGauge,
    }));

    if (!includePrediction) {
      return { playerId: targetPlayerId, history, predicted: [] };
    }

    const dbPlayers = await this.loadActiveCompanyPlayers(roomId);
    const prediction = this.gameLoop.predictFutureKpis(targetPlayerId, roomState.room.currentPhaseRound, dbPlayers, 3);

    return { playerId: targetPlayerId, history, predicted: prediction.predicted, bankruptAtRound: prediction.bankruptAtRound };
  }

  /**
   * Broadcast each player's starting-position snapshot the instant the game starts,
   * so the client renders the game room immediately instead of a blank loading state
   * for the whole first round's timer.
   */
  async broadcastInitialSnapshot(roomId: string, round: number): Promise<void> {
    const dbPlayers = await this.loadActiveCompanyPlayers(roomId);
    const snapshot = this.gameLoop.getInitialSnapshot(roomId, round, dbPlayers);
    await this.persistKpiSnapshots(snapshot.players, round);
    this.lastTurnResults.set(roomId, snapshot);
    this.io.to(roomId).emit(ServerEvents.TURN_RESOLVED, snapshot);
  }

  /**
   * One `KpiSnapshot` row per player per round — the source of the KPI history graphs
   * (every KPI card/breakdown line item is clickable; see CLAUDE.md's "KPI history +
   * prediction graphs" section). `upsert`, not `create` — idempotent against a
   * hypothetical double-call for the same round (nothing currently does this, but a
   * unique-constraint crash on a UI-triggered write path is worse than a harmless
   * overwrite). Never called for a bankrupted player's final round — they're excluded
   * from `outcome.result.players`/`getInitialSnapshot`'s output the same way
   * `companyUpdates` excludes them (see `BankruptedPlayer.finalCash`'s doc comment);
   * their last real cash figure already lives on the Game Over screen instead.
   */
  private async persistKpiSnapshots(players: PlayerTurnResult[], round: number): Promise<void> {
    for (const p of players) {
      try {
        await this.prisma.kpiSnapshot.upsert({
          where: { playerId_round: { playerId: p.playerId, round } },
          create: {
            playerId: p.playerId,
            round,
            variables: p.variables as any,
            derived: p.derived as any,
            riskGauge: p.riskGauge,
          },
          update: {
            variables: p.variables as any,
            derived: p.derived as any,
            riskGauge: p.riskGauge,
          },
        });
      } catch (err) {
        // Same isolation as resolveGameTurn's per-player persistence loops above — a
        // player's row disappearing mid-resolution (grace-period race) must not abort
        // KPI history for the rest of the room, nor the turn:resolved broadcast that
        // follows this call.
        console.error(`[persistKpiSnapshots] Failed to persist KPI snapshot for player ${p.playerId}, round ${round}:`, err);
      }
    }
  }

  /**
   * Full monitoring snapshot of every in-memory room — unlike `room:list` (Quick Play
   * discovery, WAITING-only, non-full rooms only), this is every room in every phase
   * with every player, for the admin portal (`GET /api/admin/rooms`). Synchronous,
   * in-memory only — no DB round trip, since `this.rooms` is already the live state.
   */
  getAdminRoomsSnapshot(): AdminRoomSnapshot[] {
    const snapshot: AdminRoomSnapshot[] = [];
    for (const roomState of this.rooms.values()) {
      snapshot.push({
        id: roomState.room.id,
        status: roomState.room.status,
        round: roomState.room.currentPhaseRound,
        maxPlayers: roomState.room.maxPlayers,
        createdAt: roomState.room.createdAt.toISOString(),
        players: Array.from(roomState.players.values()).map((p) => ({
          id: p.id,
          name: p.name,
          isHost: p.isHost,
          bankrupt: p.bankrupt,
          connected: !!p.socketId,
        })),
      });
    }
    return snapshot;
  }

  /** Current decision library, for `GET /api/admin/decisions` — same in-memory map GameLoop reads from. */
  getDecisionsSnapshot(): DecisionDefinition[] {
    return Array.from(this.decisionsByName.values());
  }

  /** Current game config, for `GET /api/admin/config`. */
  getGameConfigSnapshot(): GameConfig {
    return this.gameConfig;
  }

  /**
   * Create or update one decision — `isNew` picks which; the caller (the
   * `POST`/`PUT /api/admin/decisions` routes) already knows which one it's doing
   * from the HTTP verb. Writes the DB row, then live-reloads `GameLoop`'s in-memory
   * decision map so the change takes effect on the very next turn resolved, no
   * restart needed.
   */
  async upsertDecision(
    def: DecisionDefinition,
    isNew: boolean,
  ): Promise<{ success: boolean; reason?: 'already_exists' | 'not_found' }> {
    const exists = this.decisionsByName.has(def.decision);
    if (isNew && exists) return { success: false, reason: 'already_exists' };
    if (!isNew && !exists) return { success: false, reason: 'not_found' };

    await this.prisma.decision.upsert({
      where: { name: def.decision },
      create: { name: def.decision, data: def as any },
      update: { data: def as any },
    });
    this.decisionsByName.set(def.decision, def);
    this.gameLoop.loadDecisions(Array.from(this.decisionsByName.values()));
    return { success: true };
  }

  /**
   * Delete a decision — blocked if it's currently deployed in any active (non-
   * bankrupt) player's `engineState.activeDecisions` anywhere. Several places in
   * `GameLoop.resolveTurn`'s hot path dereference a decision instance's `.definition`
   * without a null check, so removing a definition still in use would crash the next
   * turn resolution for whoever has it deployed — this check is the safety net for
   * that, not a nice-to-have.
   */
  async deleteDecision(name: string): Promise<{ success: boolean; reason?: 'not_found' | 'in_use' }> {
    if (!this.decisionsByName.has(name)) return { success: false, reason: 'not_found' };
    if (await this.isDecisionInUse(name)) return { success: false, reason: 'in_use' };

    await this.prisma.decision.delete({ where: { name } });
    this.decisionsByName.delete(name);
    this.gameLoop.loadDecisions(Array.from(this.decisionsByName.values()));
    return { success: true };
  }

  /** Write the new config to the DB, then live-reload GameLoop's in-memory copy. */
  async updateGameConfigData(config: GameConfig): Promise<void> {
    await this.prisma.gameConfigRow.update({
      where: { id: 1 },
      data: {
        gameSettings: config.gameSettings as any,
        playerStartingValues: config.playerStartingValues as any,
        adminVariables: config.adminVariables as any,
      },
    });
    this.gameConfig = config;
    this.gameLoop.updateConfig(config);
  }

  /** Whether any non-bankrupt player, in any room, currently has this decision deployed. */
  private async isDecisionInUse(name: string): Promise<boolean> {
    const companies = await this.prisma.company.findMany({
      where: { player: { bankrupt: false } },
      select: { engineState: true },
    });
    return companies.some((c) => {
      const activeDecisions = (c.engineState as any)?.activeDecisions ?? [];
      return activeDecisions.some((d: any) => d.definitionName === name);
    });
  }

  /** Load every non-bankrupt player + company row GameLoop needs to resolve/preview a turn. */
  private async loadActiveCompanyPlayers(roomId: string) {
    return this.prisma.player.findMany({
      where: { roomId, bankrupt: false },
      include: { company: true },
    });
  }

  /**
   * Periodically clean up rooms where all players have disconnected (crash recovery),
   * and finalize the removal of any player whose reconnect grace period has expired
   * without them coming back via `room:rejoin`.
   */
  private startHeartbeatCleanup(): void {
    this.cleanupInterval = setInterval(() => {
      const now = Date.now();
      for (const [roomId, lastActivity] of this.roomLastActivity.entries()) {
        if (now - lastActivity > this.STALE_ROOM_THRESHOLD) {
          const roomState = this.rooms.get(roomId);
          if (roomState && roomState.players.size === 0) {
            console.log(`[Heartbeat] Cleaning up stale room ${roomId} (no players for ${this.STALE_ROOM_THRESHOLD}ms)`);
            this.rooms.delete(roomId);
            this.roomLastActivity.delete(roomId);
            this.lastTurnResults.delete(roomId);
            // Also clean up from DB to prevent ghost rooms
            this.prisma.room.delete({ where: { id: roomId } }).catch((err) => {
              if ((err as any).code !== 'P2025') {
                console.error(`[Heartbeat] Failed to delete stale room ${roomId} from DB:`, err.message);
              }
            });
          }
        }
      }

      for (const [playerId, { roomId, disconnectedAt }] of this.disconnectedPlayers.entries()) {
        if (now - disconnectedAt > this.RECONNECT_GRACE_PERIOD_MS) {
          // A GAME_PHASE turn resolution for this same room may be in flight right now
          // (the round timer runs independently of this sweep, so the two can land at
          // almost the same moment) — see finalizePlayerRemoval's doc comment for why
          // deleting this player's DB rows out from under it is unsafe. Skip this player
          // for now and let the next 10s tick retry; `disconnectedPlayers` isn't touched,
          // so nothing about their grace period is lost, just delayed a few seconds.
          if (this.advancingRooms.has(roomId)) continue;
          console.log(`[Heartbeat] Finalizing removal of player ${playerId} (no reconnect within ${this.RECONNECT_GRACE_PERIOD_MS}ms)`);
          this.finalizePlayerRemoval(roomId, playerId).catch((err) => {
            console.error(`[Heartbeat] Failed to finalize removal of player ${playerId}:`, err);
          });
        }
      }
    }, 10_000); // Check every 10 seconds
  }

  /** Update the last activity timestamp for a room. */
  private touchRoomActivity(roomId: string): void {
    this.roomLastActivity.set(roomId, Date.now());
  }

  /** Stop the heartbeat cleanup interval. */
  stop(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }

  getRoom(roomId: string): RoomState | undefined {
    return this.rooms.get(roomId);
  }

  getPlayerRoom(socketId: string): string | undefined {
    return this.playerToRoom.get(socketId);
  }

  async createRoom(player: Player): Promise<RoomState> {
    const roomId = crypto.randomUUID();

    // Use transaction for atomic room + player + company creation
    const room = await this.prisma.$transaction(async (tx) => {
      return tx.room.create({
        data: {
          id: roomId,
          status: RoomStatus.WAITING,
          maxPlayers: MAX_PLAYERS,
          players: {
            create: {
              name: player.name,
              isHost: true,
              socketId: player.socketId,
              company: {
                create: {
                  cash: 100000,
                },
              },
            },
          },
        },
        include: {
          players: { include: { company: true } },
        },
      });
    });

    const dbPlayer = room.players[0];
    const syncedPlayer: Player = {
      id: dbPlayer.id,
      name: dbPlayer.name,
      roomId: room.id,
      isHost: (dbPlayer as any).isHost ?? false,
      bankrupt: dbPlayer.bankrupt,
      companyId: dbPlayer.companyId ?? undefined,
      socketId: dbPlayer.socketId ?? player.socketId,
    };

    const roomState: RoomState = {
      room: room as any,
      players: new Map([[dbPlayer.id, syncedPlayer]]),
      timer: null,
      timerValue: 0,
      readyPlayerIds: new Set(),
      kickedNames: new Set(),
    };

    this.rooms.set(room.id, roomState);
    this.playerToRoom.set(player.socketId!, room.id);
    this.touchRoomActivity(room.id);

    return roomState;
  }

  async joinRoom(roomId: string, player: Player): Promise<RoomState> {
    const roomState = this.rooms.get(roomId);
    if (!roomState) {
      throw new Error('Room not found');
    }

    if (roomState.players.size >= roomState.room.maxPlayers) {
      throw new Error('Room is full');
    }

    if (roomState.kickedNames.has(player.name)) {
      throw new Error('You were removed from this room and cannot rejoin');
    }

    const existingPlayer = Array.from(roomState.players.values())
      .find((p: Player) => p.name === player.name);
    if (existingPlayer) {
      throw new Error('Player name already taken');
    }

    // Use transaction for atomic player + company creation
    const dbPlayer = await this.prisma.$transaction(async (tx) => {
      return tx.player.create({
        data: {
          name: player.name,
          roomId,
          isHost: false,
          socketId: player.socketId,
          company: {
            create: {
              cash: 100000,
            },
          },
        },
        include: { company: true },
      });
    });

    const syncedPlayer: Player = {
      id: dbPlayer.id,
      name: dbPlayer.name,
      roomId,
      isHost: (dbPlayer as any).isHost ?? false,
      bankrupt: dbPlayer.bankrupt,
      companyId: dbPlayer.companyId ?? undefined,
      socketId: dbPlayer.socketId ?? player.socketId,
    };

    roomState.players.set(dbPlayer.id, syncedPlayer);
    this.playerToRoom.set(player.socketId!, roomId);
    this.touchRoomActivity(roomId);

    return roomState;
  }

  /**
   * A socket disconnected — network hiccup, back button, refresh, whatever. Don't
   * delete the player yet: just mark them as having no live connection and keep
   * them in `roomState.players` (their open decisions/lawsuits keep resolving
   * normally, exactly like an AFK player who didn't submit this turn). They get
   * `RECONNECT_GRACE_PERIOD_MS` to reconnect via `room:rejoin` before the heartbeat
   * sweep calls `finalizePlayerRemoval`. No DB write happens here at all.
   */
  async markPlayerDisconnected(socketId: string): Promise<void> {
    const roomId = this.playerToRoom.get(socketId);
    if (!roomId) return;

    const roomState = this.rooms.get(roomId);
    if (!roomState) return;

    // Find the player by socketId in the room
    const player = Array.from(roomState.players.values()).find(
      (p: Player) => p.socketId === socketId
    ) as Player | undefined;

    this.playerToRoom.delete(socketId);
    if (!player) return; // already removed (e.g. kicked just before this fired)

    player.socketId = null;
    this.disconnectedPlayers.set(player.id, { roomId, disconnectedAt: Date.now() });
    this.touchRoomActivity(roomId);
  }

  /**
   * Actually remove a player who never reconnected within the grace period — same
   * DB cleanup `removePlayer` always did, just deferred and keyed by `playerId`
   * (their old `socketId` is long dead by the time this runs). Broadcasts
   * `ROOM_PLAYER_LEFT` so the rest of the room learns they're actually gone.
   */
  private async finalizePlayerRemoval(roomId: string, playerId: string): Promise<void> {
    this.disconnectedPlayers.delete(playerId);

    const roomState = this.rooms.get(roomId);
    if (!roomState) return;

    const player = roomState.players.get(playerId);
    if (!player) return;

    // Clean up database records atomically using transaction
    try {
      await this.prisma.$transaction(async (tx) => {
        const company = await tx.company.findUnique({
          where: { playerId },
        });
        if (company) {
          await tx.asset.deleteMany({
            where: { companyId: company.id },
          });
          await tx.company.delete({
            where: { id: company.id },
          });
        }

        await tx.player.delete({
          where: { id: playerId },
        });
      });
    } catch (error) {
      console.error(`Failed to clean up player ${playerId} from DB:`, error);
    }

    roomState.players.delete(playerId);
    this.touchRoomActivity(roomId);

    this.io.to(roomId).emit(ServerEvents.ROOM_PLAYER_LEFT, {
      playerId,
      playerName: player.name,
      roomId,
    });

    if (roomState.players.size === 0) {
      this.rooms.delete(roomId);
      this.lastTurnResults.delete(roomId);
      // Also clean up the room from the database to prevent ghost rooms
      // from appearing in quick join queries
      try {
        await this.prisma.room.delete({
          where: { id: roomId },
        });
      } catch (error) {
        console.error(`Failed to clean up room ${roomId} from DB:`, error);
      }
    } else {
      // The player whose grace period just expired might have been the host.
      await this.promoteNewHostIfNeeded(roomState);
      this.broadcastRoomState(roomId, ServerEvents.ROOM_UPDATED, { room: this.buildRoomSnapshot(roomState) });
    }
  }

  async advancePhase(roomId: string): Promise<void> {
    // Mutex: skip if already advancing this room (prevents concurrent phase transitions)
    if (this.advancingRooms.has(roomId)) return;
    this.advancingRooms.add(roomId);

    try {
      const roomState = this.rooms.get(roomId);
      if (!roomState) return;

      const currentIdx = PHASE_ORDER.indexOf(roomState.room.status);
      const nextIdx = currentIdx + 1;

      if (nextIdx >= PHASE_ORDER.length) {
        // Already at the last phase — nothing further to advance to.
        return;
      }

      const nextPhase = PHASE_ORDER[nextIdx];

      // Persist phase change to database BEFORE mutating in-memory state
      // This prevents inconsistency if DB write fails
      await this.syncRoomToDB(roomId);

      // Now mutate in-memory state (safe - DB is already consistent)
      roomState.room.status = nextPhase;

      // Start timer if applicable
      this.clearTimer(roomId);
      this.startTimer(roomId, PHASE_TIMERS[nextPhase]);

      // Broadcast phase change
      this.broadcastRoomState(roomId, ServerEvents.PHASE_CHANGED, {
        phase: nextPhase,
        round: roomState.room.currentPhaseRound,
        timeLimit: PHASE_TIMERS[nextPhase],
      });
    } catch (error) {
      console.error(`Failed to advance phase for room ${roomId}:`, error);
      throw error;
    } finally {
      // Always release the lock, even on error
      this.advancingRooms.delete(roomId);
    }
  }

  /**
   * Resolve the current GAME_PHASE turn via GameLoop, then either loop into
   * another GAME_PHASE round or — once only one player remains — transition
   * to AFTERMATH. GAME_PHASE is not a single linear step in PHASE_ORDER; it
   * repeats every `turnDurationSeconds` until the game is over (FORMULAS §12).
   */
  async resolveGameTurn(roomId: string): Promise<void> {
    if (this.advancingRooms.has(roomId)) return;
    this.advancingRooms.add(roomId);

    try {
      const roomState = this.rooms.get(roomId);
      if (!roomState) return;

      const round = roomState.room.currentPhaseRound;
      const dbPlayers = await this.loadActiveCompanyPlayers(roomId);
      const outcome = this.gameLoop.resolveTurn(roomId, round, dbPlayers);

      // Persist bankruptcies first (matches GameLoop's original in-loop ordering),
      // then still-active players' updated engine state, then broadcast the turn.
      //
      // Each player's persistence is isolated in its own try/catch: a player's Company/
      // Player rows can vanish out from under this loop if they disconnected and their
      // reconnect grace period happened to expire mid-resolution — the heartbeat sweep
      // now skips finalizing a removal while this room is already resolving (see
      // startHeartbeatCleanup), but that only closes the common direction of the race,
      // not every possible one, so this loop stays defensive regardless. Without this,
      // a single missing row throws (Prisma P2025), aborts the whole loop, and the
      // outer catch swallows it — meaning `turn:resolved`/`phase:changed` never fire at
      // all and the room is left with no running timer, stuck until every client
      // manually refreshes. One player's missing row must never take the rest of the
      // room down with it.
      for (const bankrupted of outcome.bankruptedPlayers) {
        try {
          await this.prisma.player.update({
            where: { id: bankrupted.playerId },
            data: { bankrupt: true },
          });
          // Bankrupted players are deliberately excluded from outcome.companyUpdates (see
          // BankruptedPlayer.finalCash doc comment) — their negative cash has to be persisted
          // here instead, or the DB (and anything reading it later, e.g. buildGameOverPayload's
          // final-standings cash column) keeps showing their last still-active positive balance.
          await this.prisma.company.update({
            where: { playerId: bankrupted.playerId },
            data: { cash: bankrupted.finalCash },
          });
        } catch (err) {
          console.error(`[resolveGameTurn] Failed to persist bankruptcy for player ${bankrupted.playerId} (room ${roomId}):`, err);
        }
        this.io.to(roomId).emit(ServerEvents.PLAYER_BANKRUPT, {
          playerId: bankrupted.playerId,
          playerName: bankrupted.playerName,
        });
      }

      for (const update of outcome.companyUpdates) {
        try {
          await this.prisma.company.update({
            where: { playerId: update.playerId },
            data: {
              cash: update.cash,
              variables: update.variables as any,
              engineState: update.engineState as any,
            },
          });
        } catch (err) {
          console.error(`[resolveGameTurn] Failed to persist company update for player ${update.playerId} (room ${roomId}):`, err);
        }
      }

      await this.persistKpiSnapshots(outcome.result.players, round);

      this.lastTurnResults.set(roomId, outcome.result);
      this.io.to(roomId).emit(ServerEvents.TURN_RESOLVED, outcome.result);

      const result = outcome.result;
      if (result.gameOver) {
        roomState.room.status = RoomStatus.AFTERMATH;
        await this.syncRoomToDB(roomId);

        const gameOverPayload = await this.buildGameOverPayload(roomId, result.winnerId);
        this.io.to(roomId).emit(ServerEvents.GAME_OVER, gameOverPayload);

        this.broadcastRoomState(roomId, ServerEvents.PHASE_CHANGED, {
          phase: RoomStatus.AFTERMATH,
          round: roomState.room.currentPhaseRound,
          timeLimit: PHASE_TIMERS[RoomStatus.AFTERMATH],
        });
        this.startTimer(roomId, PHASE_TIMERS[RoomStatus.AFTERMATH]);
        return;
      }

      // Not over — loop into the next GAME_PHASE round. Ready status is per-round —
      // whoever was ready for the turn that just resolved doesn't stay "ready" for
      // the next one.
      roomState.room.currentPhaseRound = round + 1;
      await this.syncRoomToDB(roomId);
      roomState.readyPlayerIds.clear();
      this.io.to(roomId).emit(ServerEvents.GAME_READY_UPDATE, {
        readyPlayerIds: [],
        activePlayerCount: Array.from(roomState.players.values()).filter((p) => !p.bankrupt).length,
      });

      this.broadcastRoomState(roomId, ServerEvents.PHASE_CHANGED, {
        phase: RoomStatus.GAME_PHASE,
        round: roomState.room.currentPhaseRound,
        timeLimit: PHASE_TIMERS[RoomStatus.GAME_PHASE],
      });
      this.startTimer(roomId, PHASE_TIMERS[RoomStatus.GAME_PHASE]);
    } catch (error) {
      console.error(`Failed to resolve game turn for room ${roomId}:`, error);
    } finally {
      this.advancingRooms.delete(roomId);
    }
  }

  /**
   * Voluntary forfeit — the "Leave Game" button, GAME_PHASE only. Instantly marks the
   * requesting player bankrupt (same DB write + `player:bankrupt` broadcast shape as a
   * natural cash<0 elimination in `resolveGameTurn`) and, if that leaves at most one
   * active player, ends the game exactly like `resolveGameTurn`'s post-turn win check
   * does. Guarded by the same `advancingRooms` lock `resolveGameTurn` uses — both
   * mutate room/player state and must not interleave with an in-flight turn resolution.
   *
   * If the game continues, this player's ready flag (if any) no longer counts toward
   * "all active players ready" — `triggerImmediateResolution` tells the caller whether
   * removing it just satisfied that condition for everyone remaining. It's a flag, not
   * a direct `resolveGameTurn` call from in here, because this method still holds the
   * `advancingRooms` lock in its `finally` until it returns — calling back into
   * `resolveGameTurn` before that lock is released would just no-op.
   */
  async forfeitGame(roomId: string, playerId: string): Promise<{ success: boolean; reason?: string; triggerImmediateResolution?: boolean }> {
    if (this.advancingRooms.has(roomId)) {
      return { success: false, reason: 'turn_in_progress' };
    }
    this.advancingRooms.add(roomId);

    try {
      const roomState = this.rooms.get(roomId);
      if (!roomState || roomState.room.status !== RoomStatus.GAME_PHASE) {
        return { success: false, reason: 'not_in_game' };
      }

      const player = roomState.players.get(playerId);
      if (!player || player.bankrupt) {
        return { success: false, reason: 'not_active' };
      }

      await this.syncPlayerToDB(playerId, { bankrupt: true });
      player.bankrupt = true;
      this.io.to(roomId).emit(ServerEvents.PLAYER_BANKRUPT, {
        playerId: player.id,
        playerName: player.name,
      });

      const stillActive = await this.prisma.player.findMany({ where: { roomId, bankrupt: false } });
      if (stillActive.length <= 1) {
        this.clearTimer(roomId);
        roomState.room.status = RoomStatus.AFTERMATH;
        await this.syncRoomToDB(roomId);

        const gameOverPayload = await this.buildGameOverPayload(roomId, stillActive[0]?.id);
        this.io.to(roomId).emit(ServerEvents.GAME_OVER, gameOverPayload);
        this.broadcastRoomState(roomId, ServerEvents.PHASE_CHANGED, {
          phase: RoomStatus.AFTERMATH,
          round: roomState.room.currentPhaseRound,
          timeLimit: PHASE_TIMERS[RoomStatus.AFTERMATH],
        });
        this.startTimer(roomId, PHASE_TIMERS[RoomStatus.AFTERMATH]);
        return { success: true };
      }

      roomState.readyPlayerIds.delete(playerId);
      const readyUpdate: GameReadyUpdateResponse = {
        readyPlayerIds: Array.from(roomState.readyPlayerIds),
        activePlayerCount: stillActive.length,
      };
      this.io.to(roomId).emit(ServerEvents.GAME_READY_UPDATE, readyUpdate);

      return {
        success: true,
        triggerImmediateResolution: readyUpdate.activePlayerCount > 0 && readyUpdate.readyPlayerIds.length >= readyUpdate.activePlayerCount,
      };
    } finally {
      this.advancingRooms.delete(roomId);
    }
  }

  /**
   * Toggle one player's ready status for the in-flight turn. Returns `null` if the
   * room/player isn't in a state where readiness is meaningful (not GAME_PHASE, unknown
   * player, already-bankrupt player) — the caller no-ops on `null` rather than erroring,
   * since a stale ready click racing a phase change isn't really invalid input.
   */
  toggleReady(roomId: string, playerId: string, ready: boolean): GameReadyUpdateResponse | null {
    const roomState = this.rooms.get(roomId);
    if (!roomState || roomState.room.status !== RoomStatus.GAME_PHASE) return null;

    const player = roomState.players.get(playerId);
    if (!player || player.bankrupt) return null;

    if (ready) {
      roomState.readyPlayerIds.add(playerId);
    } else {
      roomState.readyPlayerIds.delete(playerId);
    }

    return {
      readyPlayerIds: Array.from(roomState.readyPlayerIds),
      activePlayerCount: Array.from(roomState.players.values()).filter((p) => !p.bankrupt).length,
    };
  }

  /** Build the winner + ranked standings payload once only one player remains (FORMULAS §12). */
  private async buildGameOverPayload(roomId: string, winnerId?: string): Promise<GameOverResponse> {
    const dbPlayers = await this.prisma.player.findMany({
      where: { roomId },
      include: { company: { include: { assets: true } } },
    });

    const toSharedPlayer = (p: (typeof dbPlayers)[number]): Player => ({
      id: p.id,
      name: p.name,
      roomId: p.roomId,
      isHost: (p as any).isHost ?? false,
      bankrupt: p.bankrupt,
      companyId: p.companyId ?? undefined,
      socketId: p.socketId ?? null,
    });

    const toSharedCompany = (p: (typeof dbPlayers)[number]): Company | null =>
      p.company
        ? {
            id: p.company.id,
            playerId: p.company.playerId,
            cash: Number(p.company.cash),
            debt: Number(p.company.debt),
            assets: p.company.assets.map((a) => ({ id: a.id, companyId: a.companyId, type: a.type, value: Number(a.value) })),
          }
        : null;

    const standings: PlayerStanding[] = dbPlayers
      .sort((a, b) => Number(b.company?.cash ?? 0) - Number(a.company?.cash ?? 0))
      .map((p, index) => ({
        player: toSharedPlayer(p),
        company: toSharedCompany(p),
        rank: index + 1,
      }));

    const winnerDbPlayer = dbPlayers.find((p) => p.id === winnerId) ?? dbPlayers.find((p) => !p.bankrupt) ?? dbPlayers[0];

    return {
      winner: toSharedPlayer(winnerDbPlayer),
      finalStandings: standings,
    };
  }

  startTimer(roomId: string, seconds: number): void {
    const roomState = this.rooms.get(roomId);
    if (!roomState) return;

    roomState.timerValue = seconds;
    this.broadcastTimer(roomId, seconds);

    roomState.timer = setInterval(() => {
      roomState.timerValue--;
      this.broadcastTimer(roomId, roomState.timerValue);

      if (roomState.timerValue <= 0) {
        this.clearTimer(roomId);
        if (roomState.room.status === RoomStatus.GAME_PHASE) {
          this.resolveGameTurn(roomId).catch((error) => {
            console.error(`Turn resolution failed for room ${roomId}:`, error);
          });
        } else {
          this.advancePhase(roomId).catch((error) => {
            console.error(`Timer-triggered phase advance failed for room ${roomId}:`, error);
          });
        }
      }
    }, 1000);
  }

  clearTimer(roomId: string): void {
    const roomState = this.rooms.get(roomId);
    if (!roomState) return;

    if (roomState.timer) {
      clearInterval(roomState.timer);
      roomState.timer = null;
    }
  }

  async syncRoomToDB(roomId: string): Promise<void> {
    const roomState = this.rooms.get(roomId);
    if (!roomState) return;

    await this.prisma.room.update({
      where: { id: roomId },
      data: {
        status: roomState.room.status,
        currentPhaseRound: roomState.room.currentPhaseRound,
      },
    });
  }

  async syncPlayerToDB(playerId: string, data: { isHost?: boolean; bankrupt?: boolean }): Promise<void> {
    await this.prisma.player.update({
      where: { id: playerId },
      data,
    });
  }

  private broadcastTimer(roomId: string, timeLeft: number): void {
    this.io.to(roomId).emit(ServerEvents.TIMER_UPDATE, { timeLeft });
  }

  public broadcastRoomState(roomId: string, event: string, data: unknown): void {
    this.io.to(roomId).emit(event, data);
  }

  /**
   * Rebuilds a `Room` snapshot fresh from `roomState.players` every time — never read
   * `roomState.room.players` directly for anything sent to a client. It's only ever
   * populated once, at room creation (from the single founding player Prisma's
   * `room.create` returns), and nothing keeps it in sync as players join/leave/get
   * kicked/get promoted to host afterward — broadcasting it as-is was a real bug (the
   * "host shown as a plain player to someone else" report) fixed by routing every
   * roster-affecting broadcast through this method instead.
   */
  public buildRoomSnapshot(roomState: RoomState): Room {
    const allPlayers: Player[] = Array.from(roomState.players.values()).map((p: Player) => ({
      id: p.id,
      name: p.name,
      roomId: p.roomId,
      isHost: p.isHost,
      bankrupt: p.bankrupt,
      companyId: p.companyId ?? undefined,
      socketId: p.socketId ?? undefined,
    }));

    return {
      id: roomState.room.id,
      status: roomState.room.status,
      maxPlayers: roomState.room.maxPlayers,
      currentPhaseRound: roomState.room.currentPhaseRound,
      players: allPlayers,
      createdAt: roomState.room.createdAt,
      inviteOnly: roomState.room.inviteOnly,
    };
  }

  /** Builds the `room:joined` payload for one player — shared by the fresh-join and rejoin paths. */
  public buildRoomJoinedPayload(roomState: RoomState, player: Player): { room: Room; player: Player; companies: Company[] } {
    const fullRoom = this.buildRoomSnapshot(roomState);

    return {
      room: fullRoom,
      player: {
        id: player.id,
        name: player.name,
        isHost: player.isHost,
        bankrupt: player.bankrupt,
        roomId: fullRoom.id,
      },
      companies: [],
    };
  }

  /**
   * Promote the earliest-remaining-joined player to host if the room currently has
   * none (the previous host was kicked, disconnected past the grace period, or left
   * voluntarily). No-ops if a host already exists or the room is now empty.
   * `roomState.players` is a `Map`, which iterates in insertion order, so the first
   * entry is genuinely the longest-tenured remaining player.
   */
  public async promoteNewHostIfNeeded(roomState: RoomState): Promise<void> {
    if (roomState.players.size === 0) return;
    const hasHost = Array.from(roomState.players.values()).some((p) => p.isHost);
    if (hasHost) return;

    const newHost = Array.from(roomState.players.values())[0];
    newHost.isHost = true;
    await this.prisma.player.update({ where: { id: newHost.id }, data: { isHost: true } });
  }

  /**
   * Voluntary departure from the WAITING-phase lobby — the "Leave Room" button.
   * Distinct from `forfeitGame` (GAME_PHASE's "Leave Game" forfeit): this actually
   * removes the player (DB row deleted, same cleanup as a kick) rather than marking
   * them bankrupt, since there's no game in progress to forfeit. Promotes a new host
   * if the leaver was one, and deletes the room outright if they were the last player
   * in it — mirroring `finalizePlayerRemoval`'s empty-room cleanup.
   */
  public async leaveRoom(roomId: string, playerId: string): Promise<{ success: boolean; reason?: string }> {
    const roomState = this.rooms.get(roomId);
    if (!roomState || roomState.room.status !== RoomStatus.WAITING) {
      return { success: false, reason: 'not_in_lobby' };
    }

    const player = roomState.players.get(playerId);
    if (!player) return { success: false, reason: 'not_found' };

    try {
      await this.prisma.$transaction(async (tx) => {
        const company = await tx.company.findUnique({ where: { playerId } });
        if (company) {
          await tx.asset.deleteMany({ where: { companyId: company.id } });
          await tx.company.delete({ where: { id: company.id } });
        }
        await tx.player.delete({ where: { id: playerId } });
      });
    } catch (error) {
      console.error(`Failed to clean up leaving player ${playerId} from DB:`, error);
      return { success: false, reason: 'db_error' };
    }

    roomState.players.delete(playerId);
    if (player.socketId) this.playerToRoom.delete(player.socketId);
    this.touchRoomActivity(roomId);

    if (roomState.players.size === 0) {
      this.rooms.delete(roomId);
      this.lastTurnResults.delete(roomId);
      try {
        await this.prisma.room.delete({ where: { id: roomId } });
      } catch (error) {
        console.error(`Failed to clean up room ${roomId} from DB:`, error);
      }
      return { success: true };
    }

    await this.promoteNewHostIfNeeded(roomState);
    this.broadcastRoomState(roomId, ServerEvents.ROOM_UPDATED, { room: this.buildRoomSnapshot(roomState) });

    return { success: true };
  }

  /**
   * Re-associate an existing player (previously disconnected, still within the
   * grace period) with a new socket. Returns everything the caller needs to emit —
   * this method does no Socket.IO I/O itself, matching the `digDeeper` pattern —
   * or `{ success: false }` if the room or player no longer exists (grace period
   * already expired, room cleaned up, or a stale/bogus session).
   */
  async rejoinRoom(roomId: string, playerId: string, socketId: string): Promise<
    | { success: false }
    | {
        success: true;
        roomJoined: { room: Room; player: Player; companies: Company[] };
        gameDeck?: { decisions: DecisionDefinition[]; gameSettings: GameSettings };
        turnResolved?: TurnResolutionResult;
        gameOver?: GameOverResponse;
      }
  > {
    const roomState = this.rooms.get(roomId);
    if (!roomState) return { success: false };

    const player = roomState.players.get(playerId);
    if (!player) return { success: false };

    player.socketId = socketId;
    this.playerToRoom.set(socketId, roomId);
    this.disconnectedPlayers.delete(playerId);
    this.touchRoomActivity(roomId);

    const result: {
      success: true;
      roomJoined: { room: Room; player: Player; companies: Company[] };
      gameDeck?: { decisions: DecisionDefinition[]; gameSettings: GameSettings };
      turnResolved?: TurnResolutionResult;
      gameOver?: GameOverResponse;
    } = {
      success: true,
      roomJoined: this.buildRoomJoinedPayload(roomState, player),
    };

    if (roomState.room.status === RoomStatus.GAME_PHASE) {
      result.gameDeck = {
        decisions: Array.from(this.decisionsByName.values()),
        gameSettings: this.gameConfig.gameSettings,
      };
      const lastTurn = this.lastTurnResults.get(roomId);
      if (lastTurn) result.turnResolved = lastTurn;
    } else if (roomState.room.status === RoomStatus.AFTERMATH) {
      result.gameOver = await this.buildGameOverPayload(roomId);
    }

    return result;
  }
}

export function setupSocketHandlers(io: Server, prisma: PrismaClient): GameEngine {
  const engine = new GameEngine(io, prisma);

  io.on('connection', (socket: Socket) => {
    console.log(`Player connected: ${socket.id}`);

    // Matchmaking handlers
    socket.on(ClientEvents.ROOM_JOIN, async (payload: any) => {
      try {
        const validated = validateRoomJoin(payload);
        const player: Player = {
          id: '', // Will be set by DB
          name: validated.playerName,
          roomId: '',
          isHost: false,
          bankrupt: false,
          socketId: socket.id,
        };

        let roomState: RoomState | undefined;

        if (validated.searchForRoom) {
          // Search for an available room with less than MAX_PLAYERS — invite-only
          // rooms are never a Quick Play candidate.
          const availableRooms = await prisma.room.findMany({
            where: {
              status: RoomStatus.WAITING,
              inviteOnly: false,
            },
            orderBy: {
              players: { _count: 'asc' },
            },
            select: {
              id: true,
              _count: {
                select: { players: true },
              },
            },
          });

          for (const room of availableRooms) {
            if (room._count.players < MAX_PLAYERS && engine.rooms.has(room.id)) {
              try {
                roomState = await engine.joinRoom(room.id, player);
                break;
              } catch {
                // This specific room rejected the join — full by the time we got here,
                // this player's name was kicked from it, whatever. Quick Play means
                // "any room," so just try the next candidate rather than surfacing a
                // room-specific error; falls through to creating a new room if none work.
                continue;
              }
            }
          }

          if (!roomState) {
            // No room found or all rooms filled up, create a new one
            roomState = await engine.createRoom(player);
          }
        } else if (validated.roomName) {
          // Join existing room by ID
          const room = await prisma.room.findFirst({
            where: {
              id: validated.roomName,
              status: RoomStatus.WAITING,
            },
            include: { players: true },
          });

          if (!room) {
            socket.emit(ServerEvents.ERROR, {
              code: 'ROOM_NOT_FOUND',
              message: 'Room not found',
            });
            return;
          }

          roomState = await engine.joinRoom(room.id, player);
        } else {
          // Create new room
          roomState = await engine.createRoom(player);
        }

        if (!roomState) {
          socket.emit(ServerEvents.ERROR, {
            code: 'JOIN_FAILED',
            message: 'Failed to join or create a room',
          });
          return;
        }

        // Find the joining player by socketId (not just the first player in the map)
        const joiningPlayer = Array.from(roomState.players.values()).find(
          (p: Player) => p.socketId === socket.id,
        ) as Player | undefined;

        if (!joiningPlayer) {
          socket.emit(ServerEvents.ERROR, {
            code: 'JOIN_FAILED',
            message: 'Failed to locate player in room state',
          });
          return;
        }

        // Send room state to the joining player
        const roomJoinedPayload = engine.buildRoomJoinedPayload(roomState, joiningPlayer);
        socket.emit(ServerEvents.ROOM_JOINED, roomJoinedPayload);

        // Notify other players about the new player (exclude the joining player)
        socket.broadcast.to(roomState.room.id).emit(ServerEvents.ROOM_PLAYER_JOINED, {
          playerId: joiningPlayer.id,
          playerName: joiningPlayer.name,
          isHost: joiningPlayer.isHost,
          roomId: roomJoinedPayload.room.id,
        });

        // Join socket room
        socket.join(roomState.room.id);
      } catch (error: any) {
        console.error(`Room join failed for ${payload.playerName}:`, error.message);
        const codeByMessage: Record<string, string> = {
          'Player name already taken': 'NAME_TAKEN',
          'Room is full': 'ROOM_FULL',
          'Room not found': 'ROOM_NOT_FOUND',
          'You were removed from this room and cannot rejoin': 'KICKED_FROM_ROOM',
        };
        socket.emit(ServerEvents.ERROR, {
          code: codeByMessage[error.message] ?? 'JOIN_FAILED',
          message: error.message || 'Failed to join room',
        });
      }
    });

    // Resume an existing session (within the disconnect grace period) on a new socket —
    // e.g. after a page refresh, an accidental back button, or a brief network drop.
    socket.on(ClientEvents.ROOM_REJOIN, async (payload: unknown) => {
      try {
        const { roomId, playerId } = validateRoomRejoin(payload);
        const result = await engine.rejoinRoom(roomId, playerId, socket.id);

        if (!result.success) {
          socket.emit(ServerEvents.ERROR, {
            code: 'REJOIN_FAILED',
            message: 'This session no longer exists — it may have expired or the game may have ended.',
          });
          return;
        }

        socket.join(roomId);
        socket.emit(ServerEvents.ROOM_JOINED, result.roomJoined);
        if (result.gameDeck) socket.emit(ServerEvents.GAME_DECK, result.gameDeck);
        if (result.turnResolved) socket.emit(ServerEvents.TURN_RESOLVED, result.turnResolved);
        if (result.gameOver) socket.emit(ServerEvents.GAME_OVER, result.gameOver);
      } catch (error: any) {
        socket.emit(ServerEvents.ERROR, {
          code: 'REJOIN_FAILED',
          message: error.message || 'Failed to rejoin room',
        });
      }
    });

    // List available rooms (merge in-memory active rooms with DB rooms for consistency)
    socket.on(ClientEvents.ROOM_LIST, async () => {
      const availableRooms: RoomInfo[] = [];

      // Collect in-memory active rooms — invite-only rooms never appear here, same
      // as they're never a Quick Play candidate.
      for (const [_roomId, roomState] of engine.rooms) {
        if (
          roomState.room.status === RoomStatus.WAITING &&
          !roomState.room.inviteOnly &&
          roomState.players.size < roomState.room.maxPlayers
        ) {
          availableRooms.push({
            id: roomState.room.id,
            status: roomState.room.status,
            maxPlayers: roomState.room.maxPlayers,
            currentPhaseRound: roomState.room.currentPhaseRound,
            playerCount: roomState.players.size,
          });
        }
      }

      // Also query DB to surface rooms that exist but haven't been loaded in-memory yet
      // (e.g., after a server restart or if the room was created via quick-play)
      const dbRooms = await prisma.room.findMany({
        where: {
          status: RoomStatus.WAITING,
          inviteOnly: false,
        },
        include: {
          _count: {
            select: { players: true },
          },
        },
      });

      const inMemoryRoomIds = new Set(availableRooms.map((r) => r.id));

      for (const dbRoom of dbRooms) {
        // Skip rooms already in the in-memory list (they have accurate player counts)
        if (inMemoryRoomIds.has(dbRoom.id)) continue;

        // Only include rooms that are not full
        if (dbRoom._count.players < dbRoom.maxPlayers) {
          availableRooms.push({
            id: dbRoom.id,
            status: dbRoom.status as RoomStatus,
            maxPlayers: dbRoom.maxPlayers,
            currentPhaseRound: dbRoom.currentPhaseRound,
            playerCount: dbRoom._count.players,
          });
        }
      }

      socket.emit(ServerEvents.ROOMS_LISTED, { rooms: availableRooms });
    });

    // Kick player (host only)
    socket.on(ClientEvents.ROOM_KICK, async (payload: { playerId: string }) => {
      const roomId = engine.getPlayerRoom(socket.id);
      if (!roomId) return;

      const roomState = engine.rooms.get(roomId);
      if (!roomState) return;

      // Find the host by socketId
      const host = Array.from(roomState.players.values()).find(
        (p: Player) => p.socketId === socket.id
      );
      if (!host || !host.isHost) {
        socket.emit(ServerEvents.ERROR, {
          code: 'NOT_HOST',
          message: 'Only the host can kick players',
        });
        return;
      }

      // Host cannot kick themselves
      if (payload.playerId === host.id) {
        socket.emit(ServerEvents.ERROR, {
          code: 'INVALID_KICK',
          message: 'Host cannot kick themselves',
        });
        return;
      }

      // Find the player to kick
      const playerToKick = roomState.players.get(payload.playerId);
      if (!playerToKick) return;

      const kickedSocketId = playerToKick.socketId;

      // FIX: Perform DB cleanup FIRST to ensure atomicity
      // If this fails, we keep the player in memory to prevent state corruption
      try {
        await prisma.$transaction(async (tx) => {
          const company = await tx.company.findUnique({
            where: { playerId: playerToKick.id },
          });
          if (company) {
            await tx.asset.deleteMany({
              where: { companyId: company.id },
            });
            await tx.company.delete({
              where: { id: company.id },
            });
          }

          await tx.player.delete({
            where: { id: playerToKick.id },
          });
        });
      } catch (error) {
        console.error(`Failed to clean up kicked player ${playerToKick.id} from DB:`, error);
        // Stop execution if DB cleanup fails to avoid inconsistent state
        return;
      }

      // Remove player from in-memory state ONLY after successful DB cleanup
      roomState.players.delete(playerToKick.id);
      // Blocks this name from rejoining the room (invite link or Quick Play) — see
      // RoomState.kickedNames' doc comment for the limits of this without real auth.
      roomState.kickedNames.add(playerToKick.name);

      // Notify all remaining players about the kick
      engine.broadcastRoomState(roomId, ServerEvents.ROOM_PLAYER_KICKED, {
        kickedPlayerId: playerToKick.id,
        kickedPlayerName: playerToKick.name,
      });

      // Disconnect the kicked player's socket if connected
      if (kickedSocketId) {
        const kickedSocket = io.sockets.sockets.get(kickedSocketId);
        if (kickedSocket) {
          kickedSocket.disconnect();
        }
      }

      // Refresh the roster for remaining players — never broadcast roomState.room
      // directly, its embedded `players` array is stale from room creation (see
      // buildRoomSnapshot's doc comment).
      await engine.promoteNewHostIfNeeded(roomState);
      engine.broadcastRoomState(roomId, ServerEvents.ROOM_UPDATED, { room: engine.buildRoomSnapshot(roomState) });
    });

    // Voluntary departure from the WAITING-phase lobby — "Leave Room". Distinct from
    // game:leave's GAME_PHASE forfeit (that marks the player bankrupt; this actually
    // removes them, same as a kick, since there's no game in progress).
    socket.on(ClientEvents.ROOM_LEAVE, async () => {
      const roomId = engine.getPlayerRoom(socket.id);
      if (!roomId) return;

      const roomState = engine.rooms.get(roomId);
      if (!roomState) return;

      const player = Array.from(roomState.players.values()).find(
        (p: Player) => p.socketId === socket.id,
      );
      if (!player) return;

      const result = await engine.leaveRoom(roomId, player.id);
      if (!result.success) {
        socket.emit(ServerEvents.ERROR, {
          code: 'LEAVE_ROOM_FAILED',
          message: result.reason || 'Unable to leave the room right now',
        });
        return;
      }

      socket.leave(roomId);
      socket.emit(ServerEvents.ROOM_LEFT, null);
    });

    // Host toggles Quick Play / Available Rooms discoverability — a direct room-code
    // or invite-link join is never affected by this, only auto-matching is.
    socket.on(ClientEvents.ROOM_SET_INVITE_ONLY, async (payload: unknown) => {
      const roomId = engine.getPlayerRoom(socket.id);
      if (!roomId) return;

      const roomState = engine.rooms.get(roomId);
      if (!roomState || roomState.room.status !== RoomStatus.WAITING) return;

      const host = Array.from(roomState.players.values()).find(
        (p: Player) => p.socketId === socket.id,
      );
      if (!host || !host.isHost) {
        socket.emit(ServerEvents.ERROR, {
          code: 'NOT_HOST',
          message: 'Only the host can change room visibility',
        });
        return;
      }

      let inviteOnly: boolean;
      try {
        ({ inviteOnly } = validateRoomSetInviteOnly(payload));
      } catch (error: any) {
        socket.emit(ServerEvents.ERROR, {
          code: 'INVALID_INVITE_ONLY',
          message: error.message || 'Invalid invite-only payload',
        });
        return;
      }

      roomState.room.inviteOnly = inviteOnly;
      await prisma.room.update({ where: { id: roomId }, data: { inviteOnly } });
      engine.broadcastRoomState(roomId, ServerEvents.ROOM_UPDATED, { room: engine.buildRoomSnapshot(roomState) });
    });

    // Start game (host only)
    socket.on(ClientEvents.ROOM_START_GAME, async () => {
      const roomId = engine.getPlayerRoom(socket.id);
      if (!roomId) return;

      const roomState = engine.rooms.get(roomId);
      if (!roomState) return;

      // Find the host by socketId
      const host = Array.from(roomState.players.values()).find(
        (p: Player) => p.socketId === socket.id
      );
      if (!host || !host.isHost) {
        socket.emit(ServerEvents.ERROR, {
          code: 'NOT_HOST',
          message: 'Only the host can start the game',
        });
        return;
      }

      // Only start from WAITING phase
      if (roomState.room.status !== RoomStatus.WAITING) return;

      // Need at least 2 players — the host can't sue/compete against themselves.
      // Client-side the Start Game button is already disabled for this case; this
      // is the server-authoritative enforcement of the same rule.
      if (roomState.players.size < 2) {
        socket.emit(ServerEvents.ERROR, {
          code: 'NOT_ENOUGH_PLAYERS',
          message: 'At least 2 players are required to start the game',
        });
        return;
      }

      // Start the game — enter GAME_PHASE
      roomState.room.status = RoomStatus.GAME_PHASE;
      roomState.room.currentPhaseRound = 1;
      roomState.readyPlayerIds.clear();
      await engine.syncRoomToDB(roomId);
      engine.startTimer(roomId, PHASE_TIMERS[RoomStatus.GAME_PHASE]);

      engine.broadcastRoomState(roomId, ServerEvents.PHASE_CHANGED, {
        phase: RoomStatus.GAME_PHASE,
        round: 1,
        timeLimit: PHASE_TIMERS[RoomStatus.GAME_PHASE],
      });
      engine.broadcastRoomState(roomId, ServerEvents.GAME_READY_UPDATE, {
        readyPlayerIds: [],
        activePlayerCount: Array.from(roomState.players.values()).filter((p) => !p.bankrupt).length,
      });

      // Send the decision library + per-turn limits once — it's static for the
      // whole game, so the client can render the real Decision Deck immediately.
      engine.broadcastRoomState(roomId, ServerEvents.GAME_DECK, {
        decisions: engine.getDecisionsSnapshot(),
        gameSettings: engine.getGameConfigSnapshot().gameSettings,
      });

      // Players land straight in the game room with real starting numbers —
      // no blank "waiting for game data" screen for the whole first round.
      await engine.broadcastInitialSnapshot(roomId, 1);
    });

    // Submit strategic/operational decisions for the current GAME_PHASE turn
    socket.on(ClientEvents.GAME_SUBMIT_DECISIONS, (payload: unknown) => {
      const roomId = engine.getPlayerRoom(socket.id);
      if (!roomId) return;

      const roomState = engine.rooms.get(roomId);
      if (!roomState || roomState.room.status !== RoomStatus.GAME_PHASE) return;

      const player = Array.from(roomState.players.values()).find(
        (p: Player) => p.socketId === socket.id,
      );
      if (!player) return;

      try {
        const validated = validateSubmitDecisions(payload);
        engine.submitDecisions(roomId, player.id, validated);
      } catch (error: any) {
        socket.emit(ServerEvents.ERROR, {
          code: 'INVALID_DECISIONS',
          message: error.message || 'Invalid decision submission',
        });
      }
    });

    // "Dig Deeper" — pay to reveal the next tier of intel on an incoming attack.
    // Instant, outside the turn-resolution cycle — result goes only to this socket.
    socket.on(ClientEvents.GAME_DIG_DEEPER, async (payload: unknown) => {
      const roomId = engine.getPlayerRoom(socket.id);
      if (!roomId) return;

      const roomState = engine.rooms.get(roomId);
      if (!roomState || roomState.room.status !== RoomStatus.GAME_PHASE) return;

      const player = Array.from(roomState.players.values()).find(
        (p: Player) => p.socketId === socket.id,
      );
      if (!player) return;

      try {
        const { attackId } = validateDigDeeper(payload);
        const outcome = await engine.digDeeper(roomId, player.id, attackId);
        if (!outcome.success) {
          socket.emit(ServerEvents.ERROR, {
            code: 'DIG_DEEPER_FAILED',
            message: outcome.reason,
          });
          return;
        }
        socket.emit(ServerEvents.GAME_DIG_DEEPER_RESULT, {
          attackId: outcome.attackId,
          cost: outcome.cost,
          newCash: outcome.newCash,
          attack: outcome.attack,
        });
      } catch (error: any) {
        socket.emit(ServerEvents.ERROR, {
          code: 'INVALID_DIG_DEEPER',
          message: error.message || 'Invalid dig deeper request',
        });
      }
    });

    // Charge the flat lawsuit filing fee the instant a player files (SueModal's "File"
    // button) — instant, outside the turn-resolution cycle, result goes only to this
    // socket. The client still separately queues the same { targetId, decisionName,
    // groundName } entry via game:submitDecisions for the case itself.
    socket.on(ClientEvents.GAME_FILE_LAWSUIT, async (payload: unknown) => {
      const roomId = engine.getPlayerRoom(socket.id);
      if (!roomId) return;

      const roomState = engine.rooms.get(roomId);
      if (!roomState || roomState.room.status !== RoomStatus.GAME_PHASE) return;

      const player = Array.from(roomState.players.values()).find(
        (p: Player) => p.socketId === socket.id,
      );
      if (!player) return;

      try {
        validateFileLawsuit(payload);
        const outcome = await engine.fileLawsuit(roomId, player.id);
        if (!outcome.success) {
          socket.emit(ServerEvents.ERROR, {
            code: 'FILE_LAWSUIT_FAILED',
            message: outcome.reason,
          });
          return;
        }
        socket.emit(ServerEvents.GAME_FILE_LAWSUIT_RESULT, {
          cost: outcome.cost,
          newCash: outcome.newCash,
        });
      } catch (error: any) {
        socket.emit(ServerEvents.ERROR, {
          code: 'INVALID_FILE_LAWSUIT',
          message: error.message || 'Invalid lawsuit filing request',
        });
      }
    });

    // Make (or counter) a settlement offer on a case still 'negotiating' — instant,
    // outside the turn-resolution cycle. On success, GameEngine.makeOffer already emits
    // game:legalCaseUpdate to both parties (including this socket) — nothing further to
    // send here. Only a failure needs an explicit response, to just this socket.
    socket.on(ClientEvents.GAME_MAKE_OFFER, async (payload: unknown) => {
      const roomId = engine.getPlayerRoom(socket.id);
      if (!roomId) return;

      const roomState = engine.rooms.get(roomId);
      if (!roomState || roomState.room.status !== RoomStatus.GAME_PHASE) return;

      const player = Array.from(roomState.players.values()).find(
        (p: Player) => p.socketId === socket.id,
      );
      if (!player) return;

      try {
        const { caseId, amount } = validateMakeOffer(payload);
        const outcome = await engine.makeOffer(roomId, player.id, caseId, amount);
        if (!outcome.success) {
          socket.emit(ServerEvents.ERROR, {
            code: 'MAKE_OFFER_FAILED',
            message: outcome.reason,
          });
        }
      } catch (error: any) {
        socket.emit(ServerEvents.ERROR, {
          code: 'INVALID_MAKE_OFFER_REQUEST',
          message: error.message || 'Invalid offer request',
        });
      }
    });

    // Accept the other party's most recent offer — settles the case immediately. Same
    // "success already broadcast, only failure needs a response" shape as game:makeOffer.
    socket.on(ClientEvents.GAME_ACCEPT_OFFER, async (payload: unknown) => {
      const roomId = engine.getPlayerRoom(socket.id);
      if (!roomId) return;

      const roomState = engine.rooms.get(roomId);
      if (!roomState || roomState.room.status !== RoomStatus.GAME_PHASE) return;

      const player = Array.from(roomState.players.values()).find(
        (p: Player) => p.socketId === socket.id,
      );
      if (!player) return;

      try {
        const { caseId } = validateAcceptOffer(payload);
        const outcome = await engine.acceptOffer(roomId, player.id, caseId);
        if (!outcome.success) {
          socket.emit(ServerEvents.ERROR, {
            code: 'ACCEPT_OFFER_FAILED',
            message: outcome.reason,
          });
        }
      } catch (error: any) {
        socket.emit(ServerEvents.ERROR, {
          code: 'INVALID_ACCEPT_OFFER_REQUEST',
          message: error.message || 'Invalid accept-offer request',
        });
      }
    });

    // End negotiation and send a case to trial — either party may call this at any time
    // while the case is negotiating. Same "success already broadcast, only failure needs
    // a response" shape as game:makeOffer.
    socket.on(ClientEvents.GAME_GO_TO_COURT, async (payload: unknown) => {
      const roomId = engine.getPlayerRoom(socket.id);
      if (!roomId) return;

      const roomState = engine.rooms.get(roomId);
      if (!roomState || roomState.room.status !== RoomStatus.GAME_PHASE) return;

      const player = Array.from(roomState.players.values()).find(
        (p: Player) => p.socketId === socket.id,
      );
      if (!player) return;

      try {
        const { caseId } = validateGoToCourt(payload);
        const outcome = await engine.goToCourt(roomId, player.id, caseId);
        if (!outcome.success) {
          socket.emit(ServerEvents.ERROR, {
            code: 'GO_TO_COURT_FAILED',
            message: outcome.reason,
          });
        }
      } catch (error: any) {
        socket.emit(ServerEvents.ERROR, {
          code: 'INVALID_GO_TO_COURT_REQUEST',
          message: error.message || 'Invalid go-to-court request',
        });
      }
    });

    // Defendant pays to reveal the probability of success on a case — instant, outside
    // the turn-resolution cycle. Same "success already broadcast via game:legalCaseUpdate,
    // only failure needs a response" shape as game:makeOffer.
    socket.on(ClientEvents.GAME_DIG_DEEPER_CASE, async (payload: unknown) => {
      const roomId = engine.getPlayerRoom(socket.id);
      if (!roomId) return;

      const roomState = engine.rooms.get(roomId);
      if (!roomState || roomState.room.status !== RoomStatus.GAME_PHASE) return;

      const player = Array.from(roomState.players.values()).find(
        (p: Player) => p.socketId === socket.id,
      );
      if (!player) return;

      try {
        const { caseId } = validateDigDeeperCase(payload);
        const outcome = await engine.digDeeperOnCase(roomId, player.id, caseId);
        if (!outcome.success) {
          socket.emit(ServerEvents.ERROR, {
            code: 'DIG_DEEPER_CASE_FAILED',
            message: outcome.reason,
          });
        }
      } catch (error: any) {
        socket.emit(ServerEvents.ERROR, {
          code: 'INVALID_DIG_DEEPER_CASE_REQUEST',
          message: error.message || 'Invalid dig-deeper-on-case request',
        });
      }
    });

    // Request AI-narrated "annual report" text for one rival — on demand (opened from
    // the Full Filing modal), outside the turn-resolution cycle, result goes only to
    // this socket. Never blocks/broadcasts anything else in the room.
    socket.on(ClientEvents.GAME_GET_ANNUAL_REPORT, async (payload: unknown) => {
      const roomId = engine.getPlayerRoom(socket.id);
      if (!roomId) return;

      const roomState = engine.rooms.get(roomId);
      if (!roomState || roomState.room.status !== RoomStatus.GAME_PHASE) return;

      const player = Array.from(roomState.players.values()).find(
        (p: Player) => p.socketId === socket.id,
      );
      if (!player) return;

      try {
        const { rivalPlayerId } = validateAnnualReportRequest(payload);
        const entries = await engine.getAnnualReport(roomId, rivalPlayerId);
        if (!entries) {
          socket.emit(ServerEvents.ERROR, {
            code: 'ANNUAL_REPORT_FAILED',
            message: 'Rival not found',
          });
          return;
        }
        socket.emit(ServerEvents.GAME_ANNUAL_REPORT_RESULT, { rivalPlayerId, entries });
      } catch (error: any) {
        socket.emit(ServerEvents.ERROR, {
          code: 'INVALID_ANNUAL_REPORT_REQUEST',
          message: error.message || 'Invalid annual report request',
        });
      }
    });

    // Request KPI history — either this player's own (+ 3-turn prediction) or a rival's
    // (history only) — on demand (opened by clicking any KPI card or breakdown line item
    // in GamePhase.tsx), outside the turn-resolution cycle. Result goes only to this
    // socket, never broadcast.
    socket.on(ClientEvents.GAME_GET_KPI_HISTORY, async (payload: unknown) => {
      const roomId = engine.getPlayerRoom(socket.id);
      if (!roomId) return;

      const roomState = engine.rooms.get(roomId);
      if (!roomState || roomState.room.status !== RoomStatus.GAME_PHASE) return;

      const player = Array.from(roomState.players.values()).find(
        (p: Player) => p.socketId === socket.id,
      );
      if (!player) return;

      try {
        const { targetPlayerId } = validateKpiHistoryRequest(payload);
        const isSelf = !targetPlayerId || targetPlayerId === player.id;
        const response = await engine.getKpiHistory(roomId, isSelf ? player.id : targetPlayerId, isSelf);
        if (!response) return;
        socket.emit(ServerEvents.GAME_KPI_HISTORY_RESULT, response);
      } catch (error: any) {
        socket.emit(ServerEvents.ERROR, {
          code: 'INVALID_KPI_HISTORY_REQUEST',
          message: error.message || 'Invalid KPI history request',
        });
      }
    });

    // Voluntary forfeit — "Leave Game" button, GAME_PHASE only. Instant bankruptcy
    // for the requesting player only; acks back to just this socket (GAME_LEFT) so
    // the client knows to reset and return to the landing page, separately from the
    // player:bankrupt broadcast every other player in the room also receives.
    socket.on(ClientEvents.GAME_LEAVE, async () => {
      const roomId = engine.getPlayerRoom(socket.id);
      if (!roomId) return;

      const roomState = engine.rooms.get(roomId);
      if (!roomState || roomState.room.status !== RoomStatus.GAME_PHASE) return;

      const player = Array.from(roomState.players.values()).find(
        (p: Player) => p.socketId === socket.id,
      );
      if (!player) return;

      const result = await engine.forfeitGame(roomId, player.id);
      if (!result.success) {
        socket.emit(ServerEvents.ERROR, {
          code: 'LEAVE_GAME_FAILED',
          message: result.reason || 'Unable to leave the game right now',
        });
        return;
      }
      socket.emit(ServerEvents.GAME_LEFT, null);

      // The player who just left might have been the last one anyone was waiting on.
      if (result.triggerImmediateResolution) {
        engine.clearTimer(roomId);
        engine.resolveGameTurn(roomId).catch((error) => {
          console.error(`Ready-triggered turn resolution failed for room ${roomId}:`, error);
        });
      }
    });

    // Ready toggle for the in-flight turn — once every active player is ready, the
    // turn resolves immediately instead of waiting out the rest of the timer.
    socket.on(ClientEvents.GAME_READY, (payload: unknown) => {
      const roomId = engine.getPlayerRoom(socket.id);
      if (!roomId) return;

      const roomState = engine.rooms.get(roomId);
      if (!roomState || roomState.room.status !== RoomStatus.GAME_PHASE) return;

      const player = Array.from(roomState.players.values()).find(
        (p: Player) => p.socketId === socket.id,
      );
      if (!player) return;

      let ready: boolean;
      try {
        ({ ready } = validateGameReady(payload));
      } catch (error: any) {
        socket.emit(ServerEvents.ERROR, {
          code: 'INVALID_READY',
          message: error.message || 'Invalid ready payload',
        });
        return;
      }

      const readyUpdate = engine.toggleReady(roomId, player.id, ready);
      if (!readyUpdate) return;

      engine.broadcastRoomState(roomId, ServerEvents.GAME_READY_UPDATE, readyUpdate);

      if (readyUpdate.activePlayerCount > 0 && readyUpdate.readyPlayerIds.length >= readyUpdate.activePlayerCount) {
        engine.clearTimer(roomId);
        engine.resolveGameTurn(roomId).catch((error) => {
          console.error(`Ready-triggered turn resolution failed for room ${roomId}:`, error);
        });
      }
    });

    // In-room lobby chat — WAITING phase only (the client only ever renders the chat
    // UI there). Ephemeral: broadcast-only, nothing persisted, no history replay for
    // a newly-joined/rejoined player, matching this event's existing doc comment.
    socket.on(ClientEvents.CHAT_MESSAGE, (payload: unknown) => {
      const roomId = engine.getPlayerRoom(socket.id);
      if (!roomId) return;

      const roomState = engine.rooms.get(roomId);
      if (!roomState || roomState.room.status !== RoomStatus.WAITING) return;

      const sender = Array.from(roomState.players.values()).find(
        (p: Player) => p.socketId === socket.id,
      );
      if (!sender) return;

      try {
        const { message } = validateChatMessage(payload);
        engine.broadcastRoomState(roomId, ServerEvents.CHAT_MESSAGE, {
          playerId: sender.id,
          playerName: sender.name,
          message,
          timestamp: new Date().toISOString(),
        });
      } catch (error: any) {
        socket.emit(ServerEvents.ERROR, {
          code: 'INVALID_CHAT_MESSAGE',
          message: error.message || 'Invalid chat message',
        });
      }
    });

    // Disconnect — don't delete immediately, give them RECONNECT_GRACE_PERIOD_MS to
    // reconnect via room:rejoin (network hiccup, accidental back button, refresh).
    socket.on('disconnect', async () => {
      console.log(`Player disconnected: ${socket.id}`);
      await engine.markPlayerDisconnected(socket.id);
    });
  });

  return engine;
}
