import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GameEngine } from './gameEngine';
import { RoomStatus, ServerEvents, PHASE_TIMERS, PHASE_ORDER } from '@suetheirasses/shared';
import type { Server, Socket } from 'socket.io';
import type { PrismaClient, Room as PrismaRoom, Player as PrismaPlayer, Company as PrismaCompany } from '@prisma/client';

// Real network I/O (llama.cpp) is out of scope for this layer per CLAUDE.md's test-layer
// guidance — mocked deterministically here; llmService's own fallback/caching/sanitizing
// behavior is covered separately in llmService.test.ts.
vi.mock('../services/llmService.js', () => ({
  generateAnnualReportBlurb: vi.fn(async ({ decisionName }: { decisionName: string }) => `blurb: ${decisionName}`),
}));
import { generateAnnualReportBlurb } from '../services/llmService.js';

const createMockIo = () => ({
  on: vi.fn(),
  to: vi.fn().mockReturnThis(),
  emit: vi.fn().mockReturnThis(),
}) as unknown as Server;

let playerCounter = 0;

const createMockPrisma = () => {
  const createdPlayers: Record<string, unknown>[] = [];
  const createdCompanies: PrismaCompany[] = [];

  const mockRoom = {
    create: vi.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => {
      const playerId = `db-player-${++playerCounter}`;
      const companyId = `company-${playerId}`;
      const dbPlayer = {
        id: playerId,
        name: (data.players.create as Record<string, unknown>).name as string,
        roomId: data.id as string,
        isHost: (data.players.create as Record<string, unknown>).isHost as boolean,
        bankrupt: false,
        socketId: (data.players.create as Record<string, unknown>).socketId as string,
        companyId,
        company: {
          id: companyId,
          playerId,
          cash: 100000,
          debt: 0,
          createdAt: new Date(),
          assets: [],
        },
      };
      createdPlayers.push(dbPlayer);

      const room: PrismaRoom = {
        id: data.id as string,
        status: data.status as RoomStatus,
        maxPlayers: (data.maxPlayers as number) ?? 4,
        currentPhaseRound: (data.currentPhaseRound as number) ?? 1,
        createdAt: (data.createdAt as Date) || new Date(),
      };

      return Promise.resolve({
        ...room,
        players: [dbPlayer],
      });
    }),
    findFirst: vi.fn().mockImplementation(({ where }: { where: Record<string, unknown> }) => {
      return Promise.resolve(null);
    }),
    findUnique: vi.fn().mockImplementation(({ where }: { where: Record<string, unknown> }) => {
      return Promise.resolve(null);
    }),
    update: vi.fn().mockResolvedValue({}),
    delete: vi.fn().mockResolvedValue({}),
  };

  const mockPlayer = {
    create: vi.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => {
      const playerId = `db-player-${++playerCounter}`;
      const companyId = `company-${playerId}`;
      const player: PrismaPlayer & { company: PrismaCompany } = {
        id: playerId,
        name: data.name as string,
        roomId: data.roomId as string,
        isHost: data.isHost as boolean,
        bankrupt: (data.bankrupt as boolean) || false,
        socketId: data.socketId as string,
        companyId,
        company: {
          id: companyId,
          playerId,
          cash: ((data.company as Record<string, unknown>)?.create as Record<string, unknown>)?.cash as number ?? 100000,
          debt: 0,
          createdAt: new Date(),
          assets: [],
        },
      };
      createdPlayers.push(player);
      createdCompanies.push(player.company);
      return Promise.resolve(player);
    }),
    findMany: vi.fn().mockImplementation(({ where }: { where?: Record<string, unknown> } = {}) => {
      return Promise.resolve(
        createdPlayers.filter((p: any) => {
          if (where?.roomId && p.roomId !== where.roomId) return false;
          if (where?.bankrupt !== undefined && p.bankrupt !== where.bankrupt) return false;
          return true;
        }),
      );
    }),
    findUnique: vi.fn(),
    delete: vi.fn().mockResolvedValue({}),
    update: vi.fn().mockResolvedValue({}),
    updateMany: vi.fn().mockResolvedValue({ count: 0 }),
  };

  const mockCompany = {
    findUnique: vi.fn().mockImplementation(({ where }: { where: { playerId: string } }) => {
      return Promise.resolve(createdCompanies.find((c) => c.playerId === where.playerId) || null);
    }),
    delete: vi.fn().mockResolvedValue({}),
    update: vi.fn().mockResolvedValue({}),
  };

  const mockPrisma: Partial<PrismaClient> = {
    room: mockRoom,
    player: mockPlayer,
    company: mockCompany,
    asset: {
      deleteMany: vi.fn().mockResolvedValue({}),
    },
    $transaction: vi.fn().mockImplementation(async (fn: (tx: Partial<PrismaClient>) => Promise<unknown>) => {
      return fn(mockPrisma as Partial<PrismaClient>);
    }),
  };

  return mockPrisma as unknown as PrismaClient;
};

describe('GameEngine', () => {
  let engine: GameEngine;
  let mockIo: Server;
  let mockPrisma: PrismaClient;

  beforeEach(() => {
    vi.clearAllMocks();
    mockIo = createMockIo();
    mockPrisma = createMockPrisma();
    // Update prismaRef to point to the newly created mock
    (mockPrisma as Partial<PrismaClient>).room = mockPrisma.room;
    (mockPrisma as Partial<PrismaClient>).player = mockPrisma.player;
    (mockPrisma as Partial<PrismaClient>).company = mockPrisma.company;
    (mockPrisma as Partial<PrismaClient>).asset = mockPrisma.asset;
    engine = new GameEngine(mockIo, mockPrisma);
  });

  describe('createRoom', () => {
    it('should create a new room with the player', async () => {
      const player = {
        id: '',
        name: 'Alice',
        roomId: '',
        isHost: false,
        bankrupt: false,
        socketId: 'socket-1',
      };

      const roomState = await engine.createRoom(player);

      expect(roomState).toBeDefined();
      expect(roomState.room.status).toBe(RoomStatus.WAITING);
      expect(roomState.room.maxPlayers).toBe(4);
      expect(roomState.players.size).toBe(1);
      expect(mockPrisma.room.create).toHaveBeenCalled();
    });

    it('should initialize room with WAITING status', async () => {
      const player = {
        id: '',
        name: 'Alice',
        roomId: '',
        isHost: false,
        bankrupt: false,
        socketId: 'socket-1',
      };

      await engine.createRoom(player);

      const createCall = (mockPrisma.room.create as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(createCall[0].data.status).toBe(RoomStatus.WAITING);
    });

    it('should create a company for the player with $100,000 cash', async () => {
      const player = {
        id: '',
        name: 'Alice',
        roomId: '',
        isHost: false,
        bankrupt: false,
        socketId: 'socket-1',
      };

      await engine.createRoom(player);

      const createCall = (mockPrisma.room.create as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(createCall[0].data.players.create.company.create.cash).toBe(100000);
    });

    it('should generate a unique room ID', async () => {
      const player1 = {
        id: '',
        name: 'Alice',
        roomId: '',
        isHost: false,
        bankrupt: false,
        socketId: 'socket-1',
      };
      const player2 = {
        id: '',
        name: 'Bob',
        roomId: '',
        isHost: false,
        bankrupt: false,
        socketId: 'socket-2',
      };

      const room1 = await engine.createRoom(player1);
      const room2 = await engine.createRoom(player2);

      expect(room1.room.id).not.toBe(room2.room.id);
    });

    it('should store the room in the rooms map', async () => {
      const player = {
        id: '',
        name: 'Alice',
        roomId: '',
        isHost: false,
        bankrupt: false,
        socketId: 'socket-1',
      };

      const roomState = await engine.createRoom(player);
      const storedRoom = engine.getRoom(roomState.room.id);

      expect(storedRoom).toBeDefined();
      expect(storedRoom?.room.id).toBe(roomState.room.id);
    });

    it('should map the player socket to the room', async () => {
      const player = {
        id: '',
        name: 'Alice',
        roomId: '',
        isHost: false,
        bankrupt: false,
        socketId: 'socket-1',
      };

      const roomState = await engine.createRoom(player);
      const playerRoom = engine.getPlayerRoom('socket-1');

      expect(playerRoom).toBe(roomState.room.id);
    });

    it('should set player isHost to true when creating room', async () => {
      const player = {
        id: '',
        name: 'Alice',
        roomId: '',
        isHost: false,
        bankrupt: false,
        socketId: 'socket-1',
      };

      const roomState = await engine.createRoom(player);
      const roomPlayer = Array.from(roomState.players.values())[0];

      expect(roomPlayer.isHost).toBe(true);
    });
  });

  describe('joinRoom', () => {
   it('should join an existing room', async () => {
      const creator = {
        id: '',
        name: 'Alice',
        roomId: '',
        isHost: false,
        bankrupt: false,
        socketId: 'socket-1',
      };
      const roomState = await engine.createRoom(creator);
      const roomId = roomState.room.id;

      const joiner = {
        id: '',
        name: 'Bob',
        roomId: '',
        isHost: false,
        bankrupt: false,
        socketId: 'socket-2',
      };

      const joinedRoom = await engine.joinRoom(roomId, joiner);

      // joinRoom returns the roomState reference
      expect(joinedRoom).toBe(roomState);
      expect(engine.getPlayerRoom('socket-2')).toBe(roomId);
      expect(mockPrisma.player.create).toHaveBeenCalled();
    });

    it('should return the same roomState reference after joining', async () => {
      const creator = {
        id: '',
        name: 'Alice',
        roomId: '',
        isHost: false,
        bankrupt: false,
        socketId: 'socket-1',
      };
      const roomState = await engine.createRoom(creator);
      const roomId = roomState.room.id;

      const joiner = {
        id: '',
        name: 'Bob',
        roomId: '',
        isHost: false,
        bankrupt: false,
        socketId: 'socket-2',
      };

      const joinedRoom = await engine.joinRoom(roomId, joiner);

      // Both should reference the same Map
      expect(joinedRoom.players).toBe(roomState.players);
    });

    it('should throw when joining a non-existent room', async () => {
      const player = {
        id: '',
        name: 'Bob',
        roomId: '',
        isHost: false,
        bankrupt: false,
        socketId: 'socket-2',
      };

      await expect(engine.joinRoom('nonexistent-room', player)).rejects.toThrow('Room not found');
    });

    it('should throw when joining a full room', async () => {
      const creator = {
        id: '',
        name: 'Alice',
        roomId: '',
        isHost: false,
        bankrupt: false,
        socketId: 'socket-1',
      };
      const roomState = await engine.createRoom(creator);

      // Set maxPlayers to 1 to simulate a full room
      roomState.room.maxPlayers = 1;

      const joiner = {
        id: '',
        name: 'Bob',
        roomId: '',
        isHost: false,
        bankrupt: false,
        socketId: 'socket-2',
      };

      await expect(engine.joinRoom(roomState.room.id, joiner)).rejects.toThrow('Room is full');
    });

    it('should throw when player name is already taken', async () => {
      const creator = {
        id: '',
        name: 'Alice',
        roomId: '',
        isHost: false,
        bankrupt: false,
        socketId: 'socket-1',
      };
      const roomState = await engine.createRoom(creator);

      const duplicate = {
        id: '',
        name: 'Alice',
        roomId: '',
        isHost: false,
        bankrupt: false,
        socketId: 'socket-2',
      };

      await expect(engine.joinRoom(roomState.room.id, duplicate)).rejects.toThrow('Player name already taken');
    });

    it('should set joining player isHost to false', async () => {
      const creator = {
        id: '',
        name: 'Alice',
        roomId: '',
        isHost: false,
        bankrupt: false,
        socketId: 'socket-1',
      };
      const roomState = await engine.createRoom(creator);

      const joiner = {
        id: '',
        name: 'Bob',
        roomId: '',
        isHost: false,
        bankrupt: false,
        socketId: 'socket-2',
      };

      const joinedRoom = await engine.joinRoom(roomState.room.id, joiner);
      const joinerPlayer = Array.from(joinedRoom.players.values()).find((p) => p.socketId === 'socket-2');

      expect(joinerPlayer?.isHost).toBe(false);
    });

    it('should create a company for the joining player', async () => {
      const creator = {
        id: '',
        name: 'Alice',
        roomId: '',
        isHost: false,
        bankrupt: false,
        socketId: 'socket-1',
      };
      const roomState = await engine.createRoom(creator);

      const joiner = {
        id: '',
        name: 'Bob',
        roomId: '',
        isHost: false,
        bankrupt: false,
        socketId: 'socket-2',
      };

      await engine.joinRoom(roomState.room.id, joiner);

      expect(mockPrisma.player.create).toHaveBeenLastCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            company: expect.objectContaining({
              create: expect.objectContaining({ cash: 100000 }),
            }),
          }),
        }),
      );
    });
  });

  describe('markPlayerDisconnected', () => {
    it('keeps the player in the room and clears their socketId — no DB delete', async () => {
      const creator = {
        id: '',
        name: 'Alice',
        roomId: '',
        isHost: false,
        bankrupt: false,
        socketId: 'socket-1',
      };
      const roomState = await engine.createRoom(creator);
      const playerId = Array.from(roomState.players.keys())[0];

      await engine.markPlayerDisconnected('socket-1');

      // The old socketId->room mapping is gone (it's dead)...
      expect(engine.getPlayerRoom('socket-1')).toBeUndefined();
      // ...but the room and player are both still there, untouched in the DB.
      const room = engine.getRoom(roomState.room.id);
      expect(room).toBeDefined();
      expect(room!.players.has(playerId)).toBe(true);
      expect(room!.players.get(playerId)!.socketId).toBeNull();
      expect(mockPrisma.player.delete).not.toHaveBeenCalled();
      expect(mockPrisma.company.delete).not.toHaveBeenCalled();
    });

    it('should do nothing for unknown socket', async () => {
      await expect(engine.markPlayerDisconnected('unknown-socket')).resolves.toBeUndefined();
    });
  });

  describe('reconnect grace period (finalizePlayerRemoval via heartbeat sweep)', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('finalizes removal — DB delete, room cleanup, ROOM_PLAYER_LEFT broadcast — once the grace period elapses without a rejoin', async () => {
      vi.useFakeTimers();
      const localIo = createMockIo();
      const localPrisma = createMockPrisma();
      const localEngine = new GameEngine(localIo, localPrisma);

      const creator = {
        id: '',
        name: 'Alice',
        roomId: '',
        isHost: false,
        bankrupt: false,
        socketId: 'socket-1',
      };
      const roomState = await localEngine.createRoom(creator);
      const playerId = Array.from(roomState.players.keys())[0];

      await localEngine.markPlayerDisconnected('socket-1');
      expect(localPrisma.player.delete).not.toHaveBeenCalled();

      // Past both the 10s heartbeat tick and the 60s grace period.
      await vi.advanceTimersByTimeAsync(70_000);

      expect(localPrisma.player.delete).toHaveBeenCalled();
      expect(localEngine.getRoom(roomState.room.id)).toBeUndefined();
      expect(localIo.emit).toHaveBeenCalledWith(
        ServerEvents.ROOM_PLAYER_LEFT,
        expect.objectContaining({ playerId, playerName: 'Alice' }),
      );

      localEngine.stop();
    });

    it('reconnecting via rejoinRoom within the grace period cancels the pending removal', async () => {
      vi.useFakeTimers();
      const localIo = createMockIo();
      const localPrisma = createMockPrisma();
      const localEngine = new GameEngine(localIo, localPrisma);

      const creator = {
        id: '',
        name: 'Alice',
        roomId: '',
        isHost: false,
        bankrupt: false,
        socketId: 'socket-1',
      };
      const roomState = await localEngine.createRoom(creator);
      const playerId = Array.from(roomState.players.keys())[0];

      await localEngine.markPlayerDisconnected('socket-1');
      await vi.advanceTimersByTimeAsync(5_000); // well within the grace period

      const result = await localEngine.rejoinRoom(roomState.room.id, playerId, 'socket-2');
      expect(result.success).toBe(true);

      // Advance well past what would have been the original 60s deadline.
      await vi.advanceTimersByTimeAsync(70_000);

      expect(localPrisma.player.delete).not.toHaveBeenCalled();
      expect(localEngine.getRoom(roomState.room.id)).toBeDefined();

      localEngine.stop();
    });
  });

  describe('rejoinRoom', () => {
    it('returns failure when the room no longer exists', async () => {
      const result = await engine.rejoinRoom('nonexistent-room', 'some-player', 'socket-2');
      expect(result.success).toBe(false);
    });

    it('returns failure when the player no longer exists in the room', async () => {
      const creator = {
        id: '',
        name: 'Alice',
        roomId: '',
        isHost: false,
        bankrupt: false,
        socketId: 'socket-1',
      };
      const roomState = await engine.createRoom(creator);

      const result = await engine.rejoinRoom(roomState.room.id, 'bogus-player-id', 'socket-2');
      expect(result.success).toBe(false);
    });

    it('re-associates the player with the new socket and returns a ROOM_JOINED payload', async () => {
      const creator = {
        id: '',
        name: 'Alice',
        roomId: '',
        isHost: false,
        bankrupt: false,
        socketId: 'socket-1',
      };
      const roomState = await engine.createRoom(creator);
      const playerId = Array.from(roomState.players.keys())[0];
      await engine.markPlayerDisconnected('socket-1');

      const result = await engine.rejoinRoom(roomState.room.id, playerId, 'socket-2');

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.roomJoined.player.id).toBe(playerId);
      expect(engine.getPlayerRoom('socket-2')).toBe(roomState.room.id);
      expect(engine.getRoom(roomState.room.id)!.players.get(playerId)!.socketId).toBe('socket-2');
      // WAITING phase — no game deck or turn snapshot to resend yet.
      expect(result.gameDeck).toBeUndefined();
      expect(result.turnResolved).toBeUndefined();
      expect(result.gameOver).toBeUndefined();
    });

    it('resends the game deck + cached last-turn snapshot when rejoining mid-GAME_PHASE', async () => {
      const creator = {
        id: '',
        name: 'Alice',
        roomId: '',
        isHost: false,
        bankrupt: false,
        socketId: 'socket-1',
      };
      const roomState = await engine.createRoom(creator);
      const playerId = Array.from(roomState.players.keys())[0];
      roomState.room.status = RoomStatus.GAME_PHASE;
      await engine.broadcastInitialSnapshot(roomState.room.id, 1); // populates the lastTurnResults cache
      await engine.markPlayerDisconnected('socket-1');

      const result = await engine.rejoinRoom(roomState.room.id, playerId, 'socket-2');

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.gameDeck).toBeDefined();
      expect(result.turnResolved).toBeDefined();
      expect(result.turnResolved!.round).toBe(1);
      expect(result.gameOver).toBeUndefined();
    });

    it('resends the game-over payload when rejoining during AFTERMATH', async () => {
      const creator = {
        id: '',
        name: 'Alice',
        roomId: '',
        isHost: false,
        bankrupt: false,
        socketId: 'socket-1',
      };
      const roomState = await engine.createRoom(creator);
      const playerId = Array.from(roomState.players.keys())[0];
      roomState.room.status = RoomStatus.AFTERMATH;
      await engine.markPlayerDisconnected('socket-1');

      const result = await engine.rejoinRoom(roomState.room.id, playerId, 'socket-2');

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.gameOver).toBeDefined();
      expect(result.gameOver!.winner.id).toBe(playerId);
      expect(result.gameDeck).toBeUndefined();
      expect(result.turnResolved).toBeUndefined();
    });
  });

  describe('getRoom', () => {
    it('should return undefined for non-existent room', () => {
      const room = engine.getRoom('nonexistent');
      expect(room).toBeUndefined();
    });

    it('should return room state for existing room', async () => {
      const player = {
        id: '',
        name: 'Alice',
        roomId: '',
        isHost: false,
        bankrupt: false,
        socketId: 'socket-1',
      };
      const roomState = await engine.createRoom(player);

      const room = engine.getRoom(roomState.room.id);
      expect(room).toBeDefined();
      expect(room?.room.id).toBe(roomState.room.id);
    });
  });

  describe('getPlayerRoom', () => {
    it('should return undefined for unknown socket', () => {
      const roomId = engine.getPlayerRoom('unknown');
      expect(roomId).toBeUndefined();
    });

    it('should return room ID for known socket', async () => {
      const player = {
        id: '',
        name: 'Alice',
        roomId: '',
        isHost: false,
        bankrupt: false,
        socketId: 'socket-1',
      };
      const roomState = await engine.createRoom(player);

      const roomId = engine.getPlayerRoom('socket-1');
      expect(roomId).toBe(roomState.room.id);
    });
  });

  describe('startTimer', () => {
    it('should start a timer with the given seconds', async () => {
      const player = {
        id: '',
        name: 'Alice',
        roomId: '',
        isHost: false,
        bankrupt: false,
        socketId: 'socket-1',
      };
      const roomState = await engine.createRoom(player);

      engine.startTimer(roomState.room.id, 120);

      expect(roomState.timerValue).toBe(120);
      expect(mockIo.to).toHaveBeenCalledWith(roomState.room.id);
    });

    it('should broadcast timer update on start', async () => {
      const player = {
        id: '',
        name: 'Alice',
        roomId: '',
        isHost: false,
        bankrupt: false,
        socketId: 'socket-1',
      };
      const roomState = await engine.createRoom(player);

      engine.startTimer(roomState.room.id, 60);

      expect(mockIo.emit).toHaveBeenCalledWith(
        ServerEvents.TIMER_UPDATE,
        expect.objectContaining({ timeLeft: 60 }),
      );
    });

    it('should decrement timer every second', async () => {
      const player = {
        id: '',
        name: 'Alice',
        roomId: '',
        isHost: false,
        bankrupt: false,
        socketId: 'socket-1',
      };
      const roomState = await engine.createRoom(player);

      engine.startTimer(roomState.room.id, 3);

      // Wait for timer to tick
      await new Promise((resolve) => setTimeout(resolve, 1100));

      expect(roomState.timerValue).toBeLessThan(3);
    });

    it('should broadcast timer updates as it counts down', async () => {
      const player = {
        id: '',
        name: 'Alice',
        roomId: '',
        isHost: false,
        bankrupt: false,
        socketId: 'socket-1',
      };
      const roomState = await engine.createRoom(player);

      engine.startTimer(roomState.room.id, 3);

      await new Promise((resolve) => setTimeout(resolve, 1100));

      const emitCalls = (mockIo.emit as ReturnType<typeof vi.fn>).mock.calls;
      const timerCalls = emitCalls.filter((call: [string, ...unknown[]]) => call[0] === ServerEvents.TIMER_UPDATE);
      expect(timerCalls.length).toBeGreaterThan(1);
    });
  });

  describe('clearTimer', () => {
    it('should clear an active timer', async () => {
      const player = {
        id: '',
        name: 'Alice',
        roomId: '',
        isHost: false,
        bankrupt: false,
        socketId: 'socket-1',
      };
      const roomState = await engine.createRoom(player);

      engine.startTimer(roomState.room.id, 120);
      engine.clearTimer(roomState.room.id);

      expect(roomState.timer).toBeNull();
    });

    it('should do nothing for non-existent room', () => {
      engine.clearTimer('nonexistent');
      // Should not throw
    });
  });

  describe('advancePhase', () => {
    it('should advance to the next phase in order', async () => {
      const player = {
        id: '',
        name: 'Alice',
        roomId: '',
        isHost: false,
        bankrupt: false,
        socketId: 'socket-1',
      };
      const roomState = await engine.createRoom(player);

      await engine.advancePhase(roomState.room.id);

      expect(roomState.room.status).toBe(RoomStatus.GAME_PHASE);
    });

    it('should broadcast phase change event', async () => {
      const player = {
        id: '',
        name: 'Alice',
        roomId: '',
        isHost: false,
        bankrupt: false,
        socketId: 'socket-1',
      };
      const roomState = await engine.createRoom(player);

      await engine.advancePhase(roomState.room.id);

      expect(mockIo.emit).toHaveBeenCalledWith(
        ServerEvents.PHASE_CHANGED,
        expect.objectContaining({
          phase: RoomStatus.GAME_PHASE,
        }),
      );
    });

    it('should start timer for the new phase', async () => {
      const player = {
        id: '',
        name: 'Alice',
        roomId: '',
        isHost: false,
        bankrupt: false,
        socketId: 'socket-1',
      };
      const roomState = await engine.createRoom(player);

      await engine.advancePhase(roomState.room.id);

      expect(roomState.timer).toBeDefined();
      expect(roomState.timerValue).toBe(PHASE_TIMERS[RoomStatus.GAME_PHASE]);
    });

    it('should not advance past the last phase', async () => {
      const player = {
        id: '',
        name: 'Alice',
        roomId: '',
        isHost: false,
        bankrupt: false,
        socketId: 'socket-1',
      };
      const roomState = await engine.createRoom(player);

      // Advance through all phases to reach the final one
      for (let i = 1; i < PHASE_ORDER.length; i++) {
        await engine.advancePhase(roomState.room.id);
      }

      const lastPhase = PHASE_ORDER[PHASE_ORDER.length - 1];
      expect(roomState.room.status).toBe(lastPhase);
    });

    it('should advance from GAME_PHASE to AFTERMATH', async () => {
      const player = {
        id: '',
        name: 'Alice',
        roomId: '',
        isHost: false,
        bankrupt: false,
        socketId: 'socket-1',
      };
      const roomState = await engine.createRoom(player);

      // Advance to GAME_PHASE
      await engine.advancePhase(roomState.room.id);
      // Advance to AFTERMATH
      await engine.advancePhase(roomState.room.id);

      expect(roomState.room.status).toBe(RoomStatus.AFTERMATH);
      // AFTERMATH phase should have an active timer
      expect(roomState.timer).toBeDefined();
      expect(roomState.timerValue).toBe(PHASE_TIMERS[RoomStatus.AFTERMATH]);
    });

    it('should sync room state to database', async () => {
      const player = {
        id: '',
        name: 'Alice',
        roomId: '',
        isHost: false,
        bankrupt: false,
        socketId: 'socket-1',
      };
      const roomState = await engine.createRoom(player);

      await engine.advancePhase(roomState.room.id);

      expect(mockPrisma.room.update).toHaveBeenCalled();
    });

    it('should skip concurrent advancePhase calls for the same room (race condition guard)', async () => {
      const player = {
        id: '',
        name: 'Alice',
        roomId: '',
        isHost: false,
        bankrupt: false,
        socketId: 'socket-1',
      };
      const roomState = await engine.createRoom(player);

      // Spy on internal methods to track calls
      const syncRoomToDBSpy = vi.spyOn(engine as unknown as GameEngine, 'syncRoomToDB');
      const broadcastRoomStateSpy = vi.spyOn(engine as unknown as GameEngine, 'broadcastRoomState');

      // Fire two advancePhase calls concurrently
      const [result1, result2] = await Promise.all([
        engine.advancePhase(roomState.room.id),
        engine.advancePhase(roomState.room.id),
      ]);

      // Both should resolve without error
      expect(result1).toBeUndefined();
      expect(result2).toBeUndefined();

      // But internal operations should only execute once (second call skipped)
      expect(syncRoomToDBSpy).toHaveBeenCalledTimes(1);
      expect(broadcastRoomStateSpy).toHaveBeenCalledTimes(1);

      // Room should be in the next phase (GAME_PHASE), not advanced twice
      expect(roomState.room.status).toBe(RoomStatus.GAME_PHASE);
    });
  });

  describe('resolveGameTurn', () => {
    it('should resolve the turn and loop into another GAME_PHASE round when the game is not over', async () => {
      const host = { id: '', name: 'Alice', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-1' };
      const roomState = await engine.createRoom(host);
      await engine.joinRoom(roomState.room.id, { id: '', name: 'Bob', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-2' });

      roomState.room.status = RoomStatus.GAME_PHASE;
      roomState.room.currentPhaseRound = 1;

      await engine.resolveGameTurn(roomState.room.id);

      // Two solvent players, neither bankrupt — game continues into round 2
      expect(roomState.room.status).toBe(RoomStatus.GAME_PHASE);
      expect(roomState.room.currentPhaseRound).toBe(2);
      expect(roomState.timerValue).toBe(PHASE_TIMERS[RoomStatus.GAME_PHASE]);

      const phaseChangedCalls = (mockIo.emit as ReturnType<typeof vi.fn>).mock.calls.filter(
        (call: [string, ...unknown[]]) => call[0] === ServerEvents.PHASE_CHANGED,
      );
      expect(phaseChangedCalls.some((call) => (call[1] as any).round === 2)).toBe(true);
    });

    it('should transition to AFTERMATH and emit GAME_OVER when only one player remains', async () => {
      const host = { id: '', name: 'Alice', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-1' };
      const roomState = await engine.createRoom(host);
      roomState.room.status = RoomStatus.GAME_PHASE;
      roomState.room.currentPhaseRound = 3;

      // Simulate every other player already bankrupt in the DB — only the host remains
      (mockPrisma.player.findMany as ReturnType<typeof vi.fn>).mockImplementation(({ where }: any) =>
        Promise.resolve(
          where?.roomId === roomState.room.id
            ? [
                {
                  id: 'db-player-1',
                  name: 'Alice',
                  roomId: roomState.room.id,
                  bankrupt: false,
                  companyId: 'company-db-player-1',
                  company: { id: 'company-db-player-1', playerId: 'db-player-1', cash: 100000, debt: 0, assets: [] },
                },
              ]
            : [],
        ),
      );

      await engine.resolveGameTurn(roomState.room.id);

      expect(roomState.room.status).toBe(RoomStatus.AFTERMATH);
      const gameOverCalls = (mockIo.emit as ReturnType<typeof vi.fn>).mock.calls.filter(
        (call: [string, ...unknown[]]) => call[0] === ServerEvents.GAME_OVER,
      );
      expect(gameOverCalls).toHaveLength(1);
      expect(gameOverCalls[0][1]).toHaveProperty('winner');
      expect(gameOverCalls[0][1]).toHaveProperty('finalStandings');
    });

    it('should skip concurrent resolveGameTurn calls for the same room (race condition guard)', async () => {
      const host = { id: '', name: 'Alice', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-1' };
      const roomState = await engine.createRoom(host);
      await engine.joinRoom(roomState.room.id, { id: '', name: 'Bob', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-2' });
      roomState.room.status = RoomStatus.GAME_PHASE;
      roomState.room.currentPhaseRound = 1;

      await Promise.all([
        engine.resolveGameTurn(roomState.room.id),
        engine.resolveGameTurn(roomState.room.id),
      ]);

      // Only one resolution should have gone through — round advances by exactly 1
      expect(roomState.room.currentPhaseRound).toBe(2);
    });
  });

  describe('submitDecisions', () => {
    it('should forward validated decisions to the game loop for the room', async () => {
      const host = { id: '', name: 'Alice', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-1' };
      const roomState = await engine.createRoom(host);
      const playerId = Array.from(roomState.players.values())[0].id;

      engine.submitDecisions(roomState.room.id, playerId, { strategic: [{ name: 'New Factory' }], operational: [] });

      // No direct getter for submissions, but resolving the turn should not throw
      // and should reflect the submission was accepted without error.
      roomState.room.status = RoomStatus.GAME_PHASE;
      await expect(engine.resolveGameTurn(roomState.room.id)).resolves.not.toThrow();
    });
  });

  describe('broadcastInitialSnapshot', () => {
    it('should broadcast turn:resolved with starting values immediately, without waiting for a real round', async () => {
      const host = { id: '', name: 'Alice', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-1' };
      const roomState = await engine.createRoom(host);

      await engine.broadcastInitialSnapshot(roomState.room.id, 1);

      const turnResolvedCalls = (mockIo.emit as ReturnType<typeof vi.fn>).mock.calls.filter(
        (call: [string, ...unknown[]]) => call[0] === ServerEvents.TURN_RESOLVED,
      );
      expect(turnResolvedCalls).toHaveLength(1);
      const payload = turnResolvedCalls[0][1] as any;
      expect(payload.round).toBe(1);
      expect(payload.gameOver).toBe(false);
      expect(payload.players).toHaveLength(1);
      expect(payload.players[0].activeDecisions).toEqual([]);
    });
  });

  describe('syncRoomToDB', () => {
    it('should update room status in database', async () => {
      const player = {
        id: '',
        name: 'Alice',
        roomId: '',
        isHost: false,
        bankrupt: false,
        socketId: 'socket-1',
      };
      const roomState = await engine.createRoom(player);
      roomState.room.status = RoomStatus.GAME_PHASE;

      await engine.syncRoomToDB(roomState.room.id);

      expect(mockPrisma.room.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: roomState.room.id },
          data: expect.objectContaining({
            status: RoomStatus.GAME_PHASE,
          }),
        }),
      );
    });
  });

  describe('syncPlayerToDB', () => {
    it('should update player in database', async () => {
      const player = {
        id: '',
        name: 'Alice',
        roomId: '',
        isHost: false,
        bankrupt: false,
        socketId: 'socket-1',
      };
      const roomState = await engine.createRoom(player);
      const dbPlayer = Array.from(roomState.players.values())[0];

      await engine.syncPlayerToDB(dbPlayer.id, { isHost: true });

      expect(mockPrisma.player.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: dbPlayer.id },
          data: expect.objectContaining({
            isHost: true,
          }),
        }),
      );
    });
  });

  describe('broadcastRoomState', () => {
    it('should emit event to room', async () => {
      const player = {
        id: '',
        name: 'Alice',
        roomId: '',
        isHost: false,
        bankrupt: false,
        socketId: 'socket-1',
      };
      const roomState = await engine.createRoom(player);

      engine.broadcastRoomState(roomState.room.id, 'custom:event', { data: 'test' });

      expect(mockIo.to).toHaveBeenCalledWith(roomState.room.id);
      expect(mockIo.emit).toHaveBeenCalledWith('custom:event', { data: 'test' });
    });
  });

  describe('ROOM_PLAYER_JOINED - Multi-player room state', () => {
    it('should have all players in roomState.players after multiple joins', async () => {
      const creator = {
        id: '',
        name: 'Alice',
        roomId: '',
        isHost: false,
        bankrupt: false,
        socketId: 'socket-1',
      };
      const roomState = await engine.createRoom(creator);

      const joiner1 = {
        id: '',
        name: 'Bob',
        roomId: '',
        isHost: false,
        bankrupt: false,
        socketId: 'socket-2',
      };
      await engine.joinRoom(roomState.room.id, joiner1);

      const joiner2 = {
        id: '',
        name: 'Charlie',
        roomId: '',
        isHost: false,
        bankrupt: false,
        socketId: 'socket-3',
      };
      await engine.joinRoom(roomState.room.id, joiner2);

      expect(roomState.players.size).toBe(3);
      expect(Array.from(roomState.players.values()).map((p) => p.name)).toEqual(
        expect.arrayContaining(['Alice', 'Bob', 'Charlie']),
      );
    });

    it('should store each player with their correct socketId', async () => {
      const creator = {
        id: '',
        name: 'Alice',
        roomId: '',
        isHost: false,
        bankrupt: false,
        socketId: 'socket-1',
      };
      const roomState = await engine.createRoom(creator);

      const joiner = {
        id: '',
        name: 'Bob',
        roomId: '',
        isHost: false,
        bankrupt: false,
        socketId: 'socket-2',
      };
      await engine.joinRoom(roomState.room.id, joiner);

      const players = Array.from(roomState.players.values());
      const alice = players.find((p) => p.socketId === 'socket-1');
      const bob = players.find((p) => p.socketId === 'socket-2');

      expect(alice).toBeDefined();
      expect(alice?.name).toBe('Alice');
      expect(bob).toBeDefined();
      expect(bob?.name).toBe('Bob');
    });

    it('should allow finding a player by socketId after join', async () => {
      const creator = {
        id: '',
        name: 'Alice',
        roomId: '',
        isHost: false,
        bankrupt: false,
        socketId: 'socket-1',
      };
      const roomState = await engine.createRoom(creator);

      const joiner = {
        id: '',
        name: 'Bob',
        roomId: '',
        isHost: false,
        bankrupt: false,
        socketId: 'socket-2',
      };
      await engine.joinRoom(roomState.room.id, joiner);

      // This is the pattern used in the ROOM_JOIN handler to find the joining player
      const joiningPlayer = Array.from(roomState.players.values()).find(
        (p) => p.socketId === 'socket-2',
      );

      expect(joiningPlayer).toBeDefined();
      expect(joiningPlayer?.name).toBe('Bob');
      expect(joiningPlayer?.id).not.toBe(creator.id); // DB-generated ID
    });

    it('should maintain player order independence - finding by socketId works regardless of map position', async () => {
      const creator = {
        id: '',
        name: 'Alice',
        roomId: '',
        isHost: false,
        bankrupt: false,
        socketId: 'socket-1',
      };
      const roomState = await engine.createRoom(creator);

      // Add 3 more players
      for (let i = 2; i <= 4; i++) {
        const joiner = {
          id: '',
          name: `Player${i}`,
          roomId: '',
          isHost: false,
          bankrupt: false,
          socketId: `socket-${i}`,
        };
        await engine.joinRoom(roomState.room.id, joiner);
      }

      // Verify we can find each player by their socketId
      for (let i = 1; i <= 4; i++) {
        const player = Array.from(roomState.players.values()).find(
          (p) => p.socketId === `socket-${i}`,
        );
        expect(player).toBeDefined();
        expect(player?.name).toBe(i === 1 ? 'Alice' : `Player${i}`);
      }
    });

    it('should have unique player IDs for each player in the room', async () => {
      const creator = {
        id: '',
        name: 'Alice',
        roomId: '',
        isHost: false,
        bankrupt: false,
        socketId: 'socket-1',
      };
      const roomState = await engine.createRoom(creator);

      const joiner1 = {
        id: '',
        name: 'Bob',
        roomId: '',
        isHost: false,
        bankrupt: false,
        socketId: 'socket-2',
      };
      await engine.joinRoom(roomState.room.id, joiner1);

      const joiner2 = {
        id: '',
        name: 'Charlie',
        roomId: '',
        isHost: false,
        bankrupt: false,
        socketId: 'socket-3',
      };
      await engine.joinRoom(roomState.room.id, joiner2);

      const playerIds = Array.from(roomState.players.values()).map((p) => p.id);
      const uniqueIds = new Set(playerIds);
      expect(uniqueIds.size).toBe(3);
      expect(playerIds.length).toBe(3);
    });

    it('should preserve player isHost state after join', async () => {
      const creator = {
        id: '',
        name: 'Alice',
        roomId: '',
        isHost: false,
        bankrupt: false,
        socketId: 'socket-1',
      };
      const roomState = await engine.createRoom(creator);

      const joiner = {
        id: '',
        name: 'Bob',
        roomId: '',
        isHost: false,
        bankrupt: false,
        socketId: 'socket-2',
      };
      await engine.joinRoom(roomState.room.id, joiner);

      const players = Array.from(roomState.players.values());
      expect(players[0].isHost).toBe(true); // Creator is host
      expect(players[1].isHost).toBe(false); // Joiner is not host
    });
  });

  describe('getAnnualReport', () => {
    it('returns AI-narrated text per active decision, requesting the correct static fallback and elapsed years', async () => {
      (mockPrisma.player.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          id: 'player-2',
          name: 'Bob',
          company: {
            variables: {},
            engineState: {
              activeDecisions: [
                { id: 'inst-1', definitionName: 'Bot Attack', deployedYear: 2, elapsedYears: 1, isMatured: true, targetId: 'player-1' },
              ],
            },
          },
        },
      ]);

      const entries = await engine.getAnnualReport('room-1', 'player-2');

      expect(entries).toEqual([{ decisionName: 'Bot Attack', text: 'blurb: Bot Attack', year: 3 }]);
      expect(generateAnnualReportBlurb).toHaveBeenCalledWith({
        decisionName: 'Bot Attack',
        description: "Launch a coordinated cyberattack against a competitor's digital infrastructure to disrupt their logistics and operations.",
        elapsedYears: 1,
        fallback: 'Proactive digital capacity-loading evaluations of external logistical networks.',
      });
    });

    it('returns null for a rival not found among active players', async () => {
      (mockPrisma.player.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      const entries = await engine.getAnnualReport('room-1', 'nobody');

      expect(entries).toBeNull();
    });

    it('silently skips a decision instance whose definitionName no longer exists in the loaded library', async () => {
      (mockPrisma.player.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          id: 'player-2',
          name: 'Bob',
          company: {
            variables: {},
            engineState: {
              activeDecisions: [
                { id: 'inst-1', definitionName: 'Some Retired Decision', deployedYear: 1, elapsedYears: 0, isMatured: true },
              ],
            },
          },
        },
      ]);

      const entries = await engine.getAnnualReport('room-1', 'player-2');

      expect(entries).toEqual([]);
    });
  });
});
