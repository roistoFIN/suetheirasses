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
} from '@suetheirasses/shared';
import { strategyPhase } from './phases/strategyPhase.js';
import { lawsuitsPhase } from './phases/lawsuitsPhase.js';
import { resolutionPhase } from './phases/resolutionPhase.js';
import {
  validateRoomJoin,
  validateStrategySubmit,
  validateLawsuitFile,
  validateLawsuitRespond,
} from '../validation/schemas.js';


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

  constructor(io: Server, prisma: PrismaClient) {
    this.io = io;
    this.prisma = prisma;
    this.startHeartbeatCleanup();
  }

  /** Periodically clean up rooms where all players have disconnected (crash recovery). */
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
            // Also clean up from DB to prevent ghost rooms
            this.prisma.room.delete({ where: { id: roomId } }).catch((err) => {
              if ((err as any).code !== 'P2025') {
                console.error(`[Heartbeat] Failed to delete stale room ${roomId} from DB:`, err.message);
              }
            });
          }
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
      submissions: new Map(),
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

  async removePlayer(socketId: string): Promise<void> {
    const roomId = this.playerToRoom.get(socketId);
    if (!roomId) return;
    if (!roomId) return;

    const roomState = this.rooms.get(roomId);
    if (!roomState) return;

    // Find the player by socketId in the room
    const player = Array.from(roomState.players.values()).find(
      (p: Player) => p.socketId === socketId
    ) as Player | undefined;

    if (player) {
      // Clean up database records atomically using transaction
      try {
        await this.prisma.$transaction(async (tx) => {
          const company = await tx.company.findUnique({
            where: { playerId: player.id },
          });
          if (company) {
            await tx.asset.deleteMany({
              where: { companyId: company.id },
            });
            await tx.company.delete({
              where: { id: company.id },
            });
          }

          // Delete all lawsuits involving this player (as plaintiff or defendant)
          await tx.lawsuit.deleteMany({
            where: {
              OR: [
                { plaintiffId: player.id },
                { defendantId: player.id },
              ],
            },
          });

          await tx.player.delete({
            where: { id: player.id },
          });
        });
      } catch (error) {
        console.error(`Failed to clean up player ${player.id} from DB:`, error);
      }

      roomState.players.delete(player.id);
    }

    this.playerToRoom.delete(socketId);

    // Update activity timestamp after player removal
    this.touchRoomActivity(roomId);

    if (roomState.players.size === 0) {
      this.rooms.delete(roomId);
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
        // Game over - handled by resolution phase
        return;
      }

      const nextPhase = PHASE_ORDER[nextIdx];

      // Persist phase change to database BEFORE mutating in-memory state
      // This prevents inconsistency if DB write fails
      await this.syncRoomToDB(roomId);

      // Now mutate in-memory state (safe - DB is already consistent)
      roomState.room.status = nextPhase;

      // Reset submissions for new phase
      roomState.submissions.clear();

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
        this.advancePhase(roomId).catch((error) => {
          console.error(`Timer-triggered phase advance failed for room ${roomId}:`, error);
        });
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

        // Build the full room state with all players from the in-memory map
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

        // Send room state to the joining player
        socket.emit(ServerEvents.ROOM_JOINED, {
          room: fullRoom,
          player: {
            id: joiningPlayer.id,
            name: joiningPlayer.name,
            isHost: joiningPlayer.isHost,
            bankrupt: joiningPlayer.bankrupt,
            roomId: fullRoom.id,
          },
          companies: [],
        });

        // Notify other players about the new player (exclude the joining player)
        socket.broadcast.to(roomState.room.id).emit(ServerEvents.ROOM_PLAYER_JOINED, {
          playerId: joiningPlayer.id,
          playerName: joiningPlayer.name,
          isHost: joiningPlayer.isHost,
          roomId: fullRoom.id,
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

          await tx.lawsuit.deleteMany({
            where: {
              OR: [
                { plaintiffId: playerToKick.id },
                { defendantId: playerToKick.id },
              ],
            },
          });

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

      // Start the game
      roomState.room.status = RoomStatus.STRATEGY;
      roomState.room.currentPhaseRound = 1;
      await engine.syncRoomToDB(roomId);
      engine.startTimer(roomId, PHASE_TIMERS[RoomStatus.STRATEGY]);

      engine.broadcastRoomState(roomId, ServerEvents.PHASE_CHANGED, {
        phase: RoomStatus.STRATEGY,
        round: 1,
        timeLimit: PHASE_TIMERS[RoomStatus.STRATEGY],
      });
    });

    // Strategy submission
    socket.on(ClientEvents.STRATEGY_SUBMIT, async (payload) => {
      try {
        const roomId = engine.getPlayerRoom(socket.id);
        if (!roomId) return;

        const roomState = engine.rooms.get(roomId);
        if (!roomState || roomState.room.status !== RoomStatus.STRATEGY) return;

        const validated = validateStrategySubmit(payload);
        roomState.submissions.set(socket.id, validated);

        // Check if all players submitted
        if (roomState.submissions.size === roomState.players.size) {
          engine.clearTimer(roomId);
          await strategyPhase.resolve(roomId, roomState, io, prisma);
          // Transition to Results phase (passive display)
          await engine.advancePhase(roomId);
        }
      } catch (error: any) {
        socket.emit(ServerEvents.ERROR, {
          code: 'STRATEGY_SUBMIT_FAILED',
          message: error.message,
        });
      }
    });

    // Lawsuit filing
    socket.on(ClientEvents.LAWSUIT_FILE, async (payload) => {
      try {
        const roomId = engine.getPlayerRoom(socket.id);
        if (!roomId) return;

        const roomState = engine.rooms.get(roomId);
        if (!roomState || roomState.room.status !== RoomStatus.LAWSUITS) return;

        const validated = validateLawsuitFile(payload);
        await lawsuitsPhase.fileLawsuit(socket.id, roomId, validated, io, prisma);
      } catch (error: any) {
        socket.emit(ServerEvents.ERROR, {
          code: 'LAWSUIT_FILE_FAILED',
          message: error.message,
        });
      }
    });

    // Lawsuit response
    socket.on(ClientEvents.LAWSUIT_RESPOND, async (payload) => {
      try {
        const roomId = engine.getPlayerRoom(socket.id);
        if (!roomId) return;

        const roomState = engine.rooms.get(roomId);
        if (!roomState || roomState.room.status !== RoomStatus.RESOLVING) return;

        const validated = validateLawsuitRespond(payload);
        await resolutionPhase.respondToLawsuit(socket.id, roomId, validated, io, prisma);
      } catch (error: any) {
        socket.emit(ServerEvents.ERROR, {
          code: 'LAWSUIT_RESPOND_FAILED',
          message: error.message,
        });
      }
    });

    // Disconnect
    socket.on('disconnect', async () => {
      console.log(`Player disconnected: ${socket.id}`);
      await engine.removePlayer(socket.id);
    });
  });

  return engine;
}
