import { Server, Socket } from 'socket.io';
import { PrismaClient } from '@prisma/client';
import {
  RoomStatus,
  ClientEvents,
  ServerEvents,
  PHASE_TIMERS,
  PHASE_ORDER,
  type GameState,
  type Player,
  type Company,
  type RoomState,
} from '@suetheirasses/shared';
import { strategyPhase } from './phases/strategyPhase';
import { resultsPhase } from './phases/resultsPhase';
import { lawsuitsPhase } from './phases/lawsuitsPhase';
import { resolutionPhase } from './phases/resolutionPhase';
import {
  validateRoomJoin,
  validateStrategySubmit,
  validateLawsuitFile,
  validateLawsuitRespond,
} from '../validation/schemas';
import { companyService } from '../services/companyService';
import { lawsuitService } from '../services/lawsuitService';
import { bankruptcyService } from '../services/bankruptcyService';

export class GameEngine {
  public rooms: Map<string, RoomState> = new Map();
  private playerToRoom: Map<string, string> = new Map();
  private prisma: PrismaClient;
  private io: Server;

  constructor(io: Server, prisma: PrismaClient) {
    this.io = io;
    this.prisma = prisma;
  }

  getRoom(roomId: string): RoomState | undefined {
    return this.rooms.get(roomId);
  }

  getPlayerRoom(socketId: string): string | undefined {
    return this.playerToRoom.get(socketId);
  }

  async createRoom(player: Player): Promise<RoomState> {
    const roomId = crypto.randomUUID();
    const room = await this.prisma.room.create({
      data: {
        id: roomId,
        status: RoomStatus.WAITING,
        maxPlayers: 6,
        players: { create: { ...player, isReady: true } },
      },
      include: {
        players: { include: { company: true } },
      },
    });

    const roomState: RoomState = {
      room,
      players: new Map([[player.id, player]]),
      submissions: new Map(),
      timer: null,
      timerValue: 0,
    };

    this.rooms.set(room.id, roomState);
    this.playerToRoom.set(player.id, room.id);

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
      .find((p) => p.name === player.name);
    if (existingPlayer) {
      throw new Error('Player name already taken');
    }

    const dbPlayer = await this.prisma.player.create({
      data: {
        id: player.id,
        name: player.name,
        roomId,
        isReady: false,
      },
      include: { company: true },
    });

    roomState.players.set(player.id, { ...player, companyId: dbPlayer.companyId ?? undefined });
    this.playerToRoom.set(player.id, roomId);

    return roomState;
  }

  removePlayer(socketId: string): void {
    const roomId = this.playerToRoom.get(socketId);
    if (!roomId) return;

    const roomState = this.rooms.get(roomId);
    if (!roomState) return;

    roomState.players.delete(socketId);
    this.playerToRoom.delete(socketId);

    if (roomState.players.size === 0) {
      this.rooms.delete(roomId);
    }
  }

  advancePhase(roomId: string): void {
    const roomState = this.rooms.get(roomId);
    if (!roomState) return;

    const currentIdx = PHASE_ORDER.indexOf(roomState.room.status);
    const nextIdx = currentIdx + 1;

    if (nextIdx >= PHASE_ORDER.length) {
      // Game over - handled by resolution phase
      return;
    }

    const nextPhase = PHASE_ORDER[nextIdx];
    roomState.room.status = nextPhase;

    // Reset submissions for new phase
    roomState.submissions.clear();

    // Start timer if applicable
    this.clearTimer(roomId);
    if (nextPhase !== RoomStatus.RESULTS) {
      this.startTimer(roomId, PHASE_TIMERS[nextPhase]);
    }

    // Broadcast phase change
    this.broadcastRoomState(roomId, ServerEvents.PHASE_CHANGED, {
      phase: nextPhase,
      round: roomState.room.currentPhaseRound,
      timeLimit: PHASE_TIMERS[nextPhase],
    });
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
        this.advancePhase(roomId);
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

  private broadcastTimer(roomId: string, timeLeft: number): void {
    this.io.to(roomId).emit(ServerEvents.TIMER_UPDATE, { timeLeft });
  }

  public broadcastRoomState(roomId: string, event: string, data: unknown): void {
    this.io.to(roomId).emit(event, data);
  }

  private getGameState(roomId: string): GameState | null {
    const roomState = this.rooms.get(roomId);
    if (!roomState) return null;

    return {
      room: roomState.room,
      companies: [],
    };
  }
}

export function setupSocketHandlers(io: Server, prisma: PrismaClient): void {
  const engine = new GameEngine(io, prisma);

  io.on('connection', (socket: Socket) => {
    console.log(`Player connected: ${socket.id}`);

    // Matchmaking handlers
    socket.on(ClientEvents.ROOM_JOIN, async (payload) => {
      try {
        const validated = validateRoomJoin(payload);
        const player = {
          id: socket.id,
          name: validated.playerName,
          roomId: '',
          isReady: false,
          bankrupt: false,
          socketId: socket.id,
        };

        let roomState: RoomState;

        if (validated.roomName) {
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

        // Send room state to the joining player
        socket.emit(ServerEvents.ROOM_JOINED, {
          room: roomState.room,
          player: { id: player.id, name: player.name, isReady: true, bankrupt: false, roomId: roomState.room.id },
          companies: [],
        });

        // Notify other players
        engine.broadcastRoomState(
          roomState.room.id,
          ServerEvents.ROOM_PLAYER_READY,
          { playerId: player.id, playerName: player.name, isReady: true },
        );

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

    // Ready toggle
    socket.on(ClientEvents.ROOM_READY, async () => {
      const roomId = engine.getPlayerRoom(socket.id);
      if (!roomId) return;

      const roomState = engine.rooms.get(roomId);
      if (!roomState) return;

      const player = roomState.players.get(socket.id);
      if (!player) return;

      player.isReady = !player.isReady;

      engine.broadcastRoomState(roomId, ServerEvents.ROOM_PLAYER_READY, {
        playerId: player.id,
        playerName: player.name,
        isReady: player.isReady,
      });

      // Check if all players are ready
      const allReady = Array.from(roomState.players.values()).every((p) => p.isReady);
      if (allReady && roomState.room.status === RoomStatus.WAITING) {
        roomState.room.status = RoomStatus.STRATEGY;
        roomState.room.currentPhaseRound = 1;
        engine.startTimer(roomId, PHASE_TIMERS[RoomStatus.STRATEGY]);

        socket.to(roomId).emit(ServerEvents.PHASE_CHANGED, {
          phase: RoomStatus.STRATEGY,
          round: 1,
          timeLimit: PHASE_TIMERS[RoomStatus.STRATEGY],
        });
      }
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
    socket.on('disconnect', () => {
      console.log(`Player disconnected: ${socket.id}`);
      engine.removePlayer(socket.id);
    });
  });
}
