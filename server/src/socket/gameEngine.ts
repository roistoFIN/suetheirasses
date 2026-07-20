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
  type AnnualReportEntry,
} from '@suetheirasses/shared';
import { validateRoomJoin, validateSubmitDecisions, validateDigDeeper, validateRoomRejoin, validateAnnualReportRequest } from '../validation/schemas.js';
import { GameLoop } from '../engine/gameLoop.js';
import { generateAnnualReportBlurb } from '../services/llmService.js';
import gameEngineData from '../data/game_engine.json' with { type: 'json' };
import gameConfigData from '../data/game_config.json' with { type: 'json' };


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
  // Core turn-resolution engine — authoritative source of all GAME_PHASE calculations (FORMULAS.md)
  private gameLoop: GameLoop;
  // Static competitorsView fallback text per decision, for getAnnualReport when the LLM is unreachable.
  private decisionsByName: Map<string, DecisionDefinition>;

  constructor(io: Server, prisma: PrismaClient) {
    this.io = io;
    this.prisma = prisma;
    this.gameLoop = new GameLoop(gameConfigData as unknown as GameConfig);
    this.gameLoop.loadDecisions(gameEngineData as unknown as DecisionDefinition[]);
    this.decisionsByName = new Map(
      (gameEngineData as unknown as DecisionDefinition[]).map((d) => [d.decision, d]),
    );
    this.startHeartbeatCleanup();
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
   * Broadcast each player's starting-position snapshot the instant the game starts,
   * so the client renders the game room immediately instead of a blank loading state
   * for the whole first round's timer.
   */
  async broadcastInitialSnapshot(roomId: string, round: number): Promise<void> {
    const dbPlayers = await this.loadActiveCompanyPlayers(roomId);
    const snapshot = this.gameLoop.getInitialSnapshot(roomId, round, dbPlayers);
    this.lastTurnResults.set(roomId, snapshot);
    this.io.to(roomId).emit(ServerEvents.TURN_RESOLVED, snapshot);
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
      for (const bankrupted of outcome.bankruptedPlayers) {
        await this.prisma.player.update({
          where: { id: bankrupted.playerId },
          data: { bankrupt: true },
        });
        this.io.to(roomId).emit(ServerEvents.PLAYER_BANKRUPT, {
          playerId: bankrupted.playerId,
          playerName: bankrupted.playerName,
        });
      }

      for (const update of outcome.companyUpdates) {
        await this.prisma.company.update({
          where: { playerId: update.playerId },
          data: {
            cash: update.cash,
            variables: update.variables as any,
            engineState: update.engineState as any,
          },
        });
      }

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

      // Not over — loop into the next GAME_PHASE round.
      roomState.room.currentPhaseRound = round + 1;
      await this.syncRoomToDB(roomId);

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

  /** Builds the `room:joined` payload for one player — shared by the fresh-join and rejoin paths. */
  public buildRoomJoinedPayload(roomState: RoomState, player: Player): { room: Room; player: Player; companies: Company[] } {
    const allPlayers: Player[] = Array.from(roomState.players.values()).map((p: Player) => ({
      id: p.id,
      name: p.name,
      roomId: p.roomId,
      isHost: p.isHost,
      bankrupt: p.bankrupt,
      companyId: p.companyId ?? undefined,
      socketId: p.socketId ?? undefined,
    }));

    const fullRoom: Room = {
      id: roomState.room.id,
      status: roomState.room.status,
      maxPlayers: roomState.room.maxPlayers,
      currentPhaseRound: roomState.room.currentPhaseRound,
      players: allPlayers,
      createdAt: roomState.room.createdAt,
    };

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
        decisions: gameEngineData as unknown as DecisionDefinition[],
        gameSettings: gameConfigData.gameSettings as GameSettings,
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
          // Search for an available room with less than MAX_PLAYERS
          const availableRooms = await prisma.room.findMany({
            where: {
              status: RoomStatus.WAITING,
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
              } catch (joinError: any) {
                // Room filled up between the DB query and joinRoom — fall through to create a new room
                if (joinError.message === 'Room is full') {
                  continue;
                }
                throw joinError;
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
        socket.emit(ServerEvents.ERROR, {
          code: 'JOIN_FAILED',
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

      // Collect in-memory active rooms
      for (const [_roomId, roomState] of engine.rooms) {
        if (roomState.room.status === RoomStatus.WAITING && roomState.players.size < roomState.room.maxPlayers) {
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

      // Update room state for remaining players
      engine.broadcastRoomState(roomId, ServerEvents.ROOM_JOINED, {
        room: roomState.room,
        player: host,
        companies: [],
      });
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

      // Start the game — enter GAME_PHASE
      roomState.room.status = RoomStatus.GAME_PHASE;
      roomState.room.currentPhaseRound = 1;
      await engine.syncRoomToDB(roomId);
      engine.startTimer(roomId, PHASE_TIMERS[RoomStatus.GAME_PHASE]);

      engine.broadcastRoomState(roomId, ServerEvents.PHASE_CHANGED, {
        phase: RoomStatus.GAME_PHASE,
        round: 1,
        timeLimit: PHASE_TIMERS[RoomStatus.GAME_PHASE],
      });

      // Send the decision library + per-turn limits once — it's static for the
      // whole game, so the client can render the real Decision Deck immediately.
      engine.broadcastRoomState(roomId, ServerEvents.GAME_DECK, {
        decisions: gameEngineData as unknown as DecisionDefinition[],
        gameSettings: gameConfigData.gameSettings as GameSettings,
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

    // Disconnect — don't delete immediately, give them RECONNECT_GRACE_PERIOD_MS to
    // reconnect via room:rejoin (network hiccup, accidental back button, refresh).
    socket.on('disconnect', async () => {
      console.log(`Player disconnected: ${socket.id}`);
      await engine.markPlayerDisconnected(socket.id);
    });
  });

  return engine;
}
