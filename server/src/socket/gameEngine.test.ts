import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GameEngine } from './gameEngine';
import { RoomStatus, ServerEvents, PHASE_TIMERS, PHASE_ORDER, RESULTS_DISPLAY_DURATION } from '@suetheirasses/shared';
import type { Server, Socket } from 'socket.io';
import type { PrismaClient, Room as PrismaRoom, Player as PrismaPlayer, Company as PrismaCompany } from '@prisma/client';

const createMockIo = () => ({
  on: vi.fn(),
  to: vi.fn().mockReturnThis(),
  emit: vi.fn().mockReturnThis(),
}) as unknown as Server;

const createMockPrisma = () => {
  const createdPlayers: Record<string, unknown>[] = [];
  const createdCompanies: PrismaCompany[] = [];

  const mockRoom = {
    create: vi.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => {
      const dbPlayer = {
        id: `db-player-${Date.now()}`,
        name: (data.players.create as Record<string, unknown>).name as string,
        roomId: data.id as string,
        isReady: (data.players.create as Record<string, unknown>).isReady as boolean,
        bankrupt: false,
        socketId: (data.players.create as Record<string, unknown>).socketId as string,
        companyId: `company-${Date.now()}`,
        company: {
          id: `company-${Date.now()}`,
          playerId: `db-player-${Date.now()}`,
          cash: 100000,
          createdAt: new Date(),
        },
      };
      createdPlayers.push(dbPlayer);

      const room: PrismaRoom = {
        id: data.id as string,
        status: data.status as RoomStatus,
        maxPlayers: data.maxPlayers as number,
        currentPhaseRound: data.currentPhaseRound as number,
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
  };

  const mockPlayer = {
    create: vi.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => {
      const playerId = `db-player-${Date.now()}`;
      const companyId = `company-${playerId}`;
      const player: PrismaPlayer & { company: PrismaCompany } = {
        id: playerId,
        name: data.name as string,
        roomId: data.roomId as string,
        isReady: data.isReady as boolean,
        bankrupt: (data.bankrupt as boolean) || false,
        socketId: data.socketId as string,
        companyId,
        company: {
          id: companyId,
          playerId,
          cash: ((data.company as Record<string, unknown>)?.create as Record<string, unknown>)?.cash as number ?? 100000,
          createdAt: new Date(),
        },
      };
      createdPlayers.push(player);
      createdCompanies.push(player.company);
      return Promise.resolve(player);
    }),
    findUnique: vi.fn(),
    delete: vi.fn().mockResolvedValue({}),
    update: vi.fn().mockResolvedValue({}),
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
    lawsuit: {
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
    (mockPrisma as Partial<PrismaClient>).lawsuit = mockPrisma.lawsuit;
    engine = new GameEngine(mockIo, mockPrisma);
  });

  describe('createRoom', () => {
    it('should create a new room with the player', async () => {
      const player = {
        id: '',
        name: 'Alice',
        roomId: '',
        isReady: false,
        bankrupt: false,
        socketId: 'socket-1',
      };

      const roomState = await engine.createRoom(player);

      expect(roomState).toBeDefined();
      expect(roomState.room.status).toBe(RoomStatus.WAITING);
      expect(roomState.room.maxPlayers).toBe(6);
      expect(roomState.players.size).toBe(1);
      expect(mockPrisma.room.create).toHaveBeenCalled();
    });

    it('should initialize room with WAITING status', async () => {
      const player = {
        id: '',
        name: 'Alice',
        roomId: '',
        isReady: false,
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
        isReady: false,
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
        isReady: false,
        bankrupt: false,
        socketId: 'socket-1',
      };
      const player2 = {
        id: '',
        name: 'Bob',
        roomId: '',
        isReady: false,
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
        isReady: false,
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
        isReady: false,
        bankrupt: false,
        socketId: 'socket-1',
      };

      const roomState = await engine.createRoom(player);
      const playerRoom = engine.getPlayerRoom('socket-1');

      expect(playerRoom).toBe(roomState.room.id);
    });

    it('should set player isReady to true when creating room', async () => {
      const player = {
        id: '',
        name: 'Alice',
        roomId: '',
        isReady: false,
        bankrupt: false,
        socketId: 'socket-1',
      };

      const roomState = await engine.createRoom(player);
      const roomPlayer = Array.from(roomState.players.values())[0];

      expect(roomPlayer.isReady).toBe(true);
    });
  });

  describe('joinRoom', () => {
   it('should join an existing room', async () => {
      const creator = {
        id: '',
        name: 'Alice',
        roomId: '',
        isReady: false,
        bankrupt: false,
        socketId: 'socket-1',
      };
      const roomState = await engine.createRoom(creator);
      const roomId = roomState.room.id;

      const joiner = {
        id: '',
        name: 'Bob',
        roomId: '',
        isReady: false,
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
        isReady: false,
        bankrupt: false,
        socketId: 'socket-1',
      };
      const roomState = await engine.createRoom(creator);
      const roomId = roomState.room.id;

      const joiner = {
        id: '',
        name: 'Bob',
        roomId: '',
        isReady: false,
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
        isReady: false,
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
        isReady: false,
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
        isReady: false,
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
        isReady: false,
        bankrupt: false,
        socketId: 'socket-1',
      };
      const roomState = await engine.createRoom(creator);

      const duplicate = {
        id: '',
        name: 'Alice',
        roomId: '',
        isReady: false,
        bankrupt: false,
        socketId: 'socket-2',
      };

      await expect(engine.joinRoom(roomState.room.id, duplicate)).rejects.toThrow('Player name already taken');
    });

    it('should set joining player isReady to false', async () => {
      const creator = {
        id: '',
        name: 'Alice',
        roomId: '',
        isReady: false,
        bankrupt: false,
        socketId: 'socket-1',
      };
      const roomState = await engine.createRoom(creator);

      const joiner = {
        id: '',
        name: 'Bob',
        roomId: '',
        isReady: false,
        bankrupt: false,
        socketId: 'socket-2',
      };

      const joinedRoom = await engine.joinRoom(roomState.room.id, joiner);
      const joinerPlayer = Array.from(joinedRoom.players.values()).find((p) => p.socketId === 'socket-2');

      expect(joinerPlayer?.isReady).toBe(false);
    });

    it('should create a company for the joining player', async () => {
      const creator = {
        id: '',
        name: 'Alice',
        roomId: '',
        isReady: false,
        bankrupt: false,
        socketId: 'socket-1',
      };
      const roomState = await engine.createRoom(creator);

      const joiner = {
        id: '',
        name: 'Bob',
        roomId: '',
        isReady: false,
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

  describe('removePlayer', () => {
    it('should remove a player from the room', async () => {
      const creator = {
        id: '',
        name: 'Alice',
        roomId: '',
        isReady: false,
        bankrupt: false,
        socketId: 'socket-1',
      };
      const roomState = await engine.createRoom(creator);

      await engine.removePlayer('socket-1');

      expect(engine.getPlayerRoom('socket-1')).toBeUndefined();
      expect(engine.getRoom(roomState.room.id)).toBeUndefined();
    });

    it('should do nothing for unknown socket', async () => {
      await expect(engine.removePlayer('unknown-socket')).resolves.toBeUndefined();
    });

    it('should delete player company on removal', async () => {
      const creator = {
        id: '',
        name: 'Alice',
        roomId: '',
        isReady: false,
        bankrupt: false,
        socketId: 'socket-1',
      };
      await engine.createRoom(creator);

      await engine.removePlayer('socket-1');

      expect(mockPrisma.player.delete).toHaveBeenCalled();
    });

    it('should clear player from room state', async () => {
      const creator = {
        id: '',
        name: 'Alice',
        roomId: '',
        isReady: false,
        bankrupt: false,
        socketId: 'socket-1',
      };
      const roomState = await engine.createRoom(creator);

      await engine.removePlayer('socket-1');

      expect(engine.getRoom(roomState.room.id)).toBeUndefined();
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
        isReady: false,
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
        isReady: false,
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
        isReady: false,
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
        isReady: false,
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
        isReady: false,
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
        isReady: false,
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
        isReady: false,
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
        isReady: false,
        bankrupt: false,
        socketId: 'socket-1',
      };
      const roomState = await engine.createRoom(player);

      await engine.advancePhase(roomState.room.id);

      expect(roomState.room.status).toBe(RoomStatus.STRATEGY);
    });

    it('should broadcast phase change event', async () => {
      const player = {
        id: '',
        name: 'Alice',
        roomId: '',
        isReady: false,
        bankrupt: false,
        socketId: 'socket-1',
      };
      const roomState = await engine.createRoom(player);

      await engine.advancePhase(roomState.room.id);

      expect(mockIo.emit).toHaveBeenCalledWith(
        ServerEvents.PHASE_CHANGED,
        expect.objectContaining({
          phase: RoomStatus.STRATEGY,
        }),
      );
    });

    it('should start timer for the new phase', async () => {
      const player = {
        id: '',
        name: 'Alice',
        roomId: '',
        isReady: false,
        bankrupt: false,
        socketId: 'socket-1',
      };
      const roomState = await engine.createRoom(player);

      await engine.advancePhase(roomState.room.id);

      expect(roomState.timer).toBeDefined();
      expect(roomState.timerValue).toBe(PHASE_TIMERS[RoomStatus.STRATEGY]);
    });

    it('should clear submissions when advancing phase', async () => {
      const player = {
        id: '',
        name: 'Alice',
        roomId: '',
        isReady: false,
        bankrupt: false,
        socketId: 'socket-1',
      };
      const roomState = await engine.createRoom(player);
      roomState.submissions.set('player-1', { actions: [] });

      await engine.advancePhase(roomState.room.id);

      expect(roomState.submissions.size).toBe(0);
    });

    it('should not advance past the last phase', async () => {
      const player = {
        id: '',
        name: 'Alice',
        roomId: '',
        isReady: false,
        bankrupt: false,
        socketId: 'socket-1',
      };
      const roomState = await engine.createRoom(player);

      // Advance to the last phase (RESOLVING)
      for (let i = 1; i < PHASE_ORDER.length; i++) {
        await engine.advancePhase(roomState.room.id);
      }

      const lastPhase = PHASE_ORDER[PHASE_ORDER.length - 1];
      expect(roomState.room.status).toBe(lastPhase);
    });

    it('should start timer for RESULTS phase', async () => {
      const player = {
        id: '',
        name: 'Alice',
        roomId: '',
        isReady: false,
        bankrupt: false,
        socketId: 'socket-1',
      };
      const roomState = await engine.createRoom(player);

      // Advance to STRATEGY
      await engine.advancePhase(roomState.room.id);
      // Advance to RESULTS
      await engine.advancePhase(roomState.room.id);

      expect(roomState.room.status).toBe(RoomStatus.RESULTS);
      // RESULTS phase should have an active timer for the passive display
      expect(roomState.timer).not.toBeNull();
      expect(roomState.timerValue).toBe(RESULTS_DISPLAY_DURATION);
    });

    it('should sync room state to database', async () => {
      const player = {
        id: '',
        name: 'Alice',
        roomId: '',
        isReady: false,
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
        isReady: false,
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

      // Room should be in the next phase (STRATEGY), not advanced twice
      expect(roomState.room.status).toBe(RoomStatus.STRATEGY);
    });
  });

  describe('syncRoomToDB', () => {
    it('should update room status in database', async () => {
      const player = {
        id: '',
        name: 'Alice',
        roomId: '',
        isReady: false,
        bankrupt: false,
        socketId: 'socket-1',
      };
      const roomState = await engine.createRoom(player);
      roomState.room.status = RoomStatus.STRATEGY;

      await engine.syncRoomToDB(roomState.room.id);

      expect(mockPrisma.room.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: roomState.room.id },
          data: expect.objectContaining({
            status: RoomStatus.STRATEGY,
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
        isReady: false,
        bankrupt: false,
        socketId: 'socket-1',
      };
      const roomState = await engine.createRoom(player);
      const dbPlayer = Array.from(roomState.players.values())[0];

      await engine.syncPlayerToDB(dbPlayer.id, { isReady: true });

      expect(mockPrisma.player.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: dbPlayer.id },
          data: expect.objectContaining({
            isReady: true,
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
        isReady: false,
        bankrupt: false,
        socketId: 'socket-1',
      };
      const roomState = await engine.createRoom(player);

      engine.broadcastRoomState(roomState.room.id, 'custom:event', { data: 'test' });

      expect(mockIo.to).toHaveBeenCalledWith(roomState.room.id);
      expect(mockIo.emit).toHaveBeenCalledWith('custom:event', { data: 'test' });
    });
  });
});
