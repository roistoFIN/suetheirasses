import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GameEngine } from './gameEngine';
import { RoomStatus, ServerEvents, PHASE_TIMERS, PHASE_ORDER, type DecisionDefinition, type GameConfig } from '@suetheirasses/shared';
import type { Server, Socket } from 'socket.io';
import type { PrismaClient, Room as PrismaRoom, Player as PrismaPlayer, Company as PrismaCompany } from '@prisma/client';
import gameEngineData from '../data/game_engine.json' with { type: 'json' };
import gameConfigData from '../data/game_config.json' with { type: 'json' };
import { DEFAULT_FORMULA_SEEDS } from '../engine/defaultFormulas.js';

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
        inviteOnly: (data.inviteOnly as boolean) ?? false,
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
    // Backs GameEngine.isDecisionInUse — mirrors the real `where: { player: { bankrupt: false } }`
    // relational filter by cross-referencing each company's owning player's bankrupt flag.
    findMany: vi.fn().mockImplementation(({ where }: any = {}) => {
      const wantNonBankrupt = where?.player?.bankrupt === false;
      return Promise.resolve(
        createdCompanies
          .filter((c: any) => {
            if (!wantNonBankrupt) return true;
            const owner = createdPlayers.find((p: any) => p.id === c.playerId);
            return owner ? owner.bankrupt === false : true;
          })
          .map((c: any) => ({ engineState: c.engineState ?? {} })),
      );
    }),
    delete: vi.fn().mockResolvedValue({}),
    update: vi.fn().mockResolvedValue({}),
  };

  // Seeded from the real decision library/config, exactly like production data —
  // so every existing assertion depending on real decision content (e.g. the
  // getAnnualReport "Bot Attack" tests) keeps passing unchanged now that it's
  // sourced through the mocked DB instead of a direct JSON import.
  const decisionRows = new Map<string, { name: string; data: DecisionDefinition }>(
    (gameEngineData as unknown as DecisionDefinition[]).map((d) => [d.decision, { name: d.decision, data: d }]),
  );
  const seedConfig = gameConfigData as unknown as GameConfig;
  let gameConfigRow: { id: number; gameSettings: unknown; playerStartingValues: unknown; adminVariables: unknown } = {
    id: 1,
    gameSettings: seedConfig.gameSettings,
    playerStartingValues: seedConfig.playerStartingValues,
    adminVariables: seedConfig.adminVariables,
  };

  const mockDecision = {
    findMany: vi.fn().mockImplementation(() => Promise.resolve(Array.from(decisionRows.values()))),
    upsert: vi.fn().mockImplementation(({ where, create, update }: any) => {
      const row = decisionRows.has(where.name)
        ? { name: where.name, data: update.data }
        : { name: create.name, data: create.data };
      decisionRows.set(where.name, row);
      return Promise.resolve(row);
    }),
    delete: vi.fn().mockImplementation(({ where }: any) => {
      decisionRows.delete(where.name);
      return Promise.resolve({});
    }),
  };

  const mockGameConfigRow = {
    findUnique: vi.fn().mockImplementation(() => Promise.resolve(gameConfigRow)),
    update: vi.fn().mockImplementation(({ data }: any) => {
      gameConfigRow = { ...gameConfigRow, ...data };
      return Promise.resolve(gameConfigRow);
    }),
  };

  // Seeded from the real 23 formulas (same source prisma/seed.ts uses), so every
  // existing assertion depending on real formula content keeps passing unchanged.
  const formulaRows = new Map<string, { key: string; expression: string; description: string }>(
    DEFAULT_FORMULA_SEEDS.map((f) => [f.key, { ...f }]),
  );
  const mockFormula = {
    findMany: vi.fn().mockImplementation(() => Promise.resolve(Array.from(formulaRows.values()))),
    update: vi.fn().mockImplementation(({ where, data }: any) => {
      const existing = formulaRows.get(where.key);
      if (!existing) throw new Error(`Formula "${where.key}" not found`);
      const updated = { ...existing, ...data };
      formulaRows.set(where.key, updated);
      return Promise.resolve(updated);
    }),
  };

  const mockPrisma: Partial<PrismaClient> = {
    room: mockRoom,
    player: mockPlayer,
    company: mockCompany,
    decision: mockDecision as any,
    gameConfigRow: mockGameConfigRow as any,
    formula: mockFormula as any,
    asset: {
      deleteMany: vi.fn().mockResolvedValue({}),
    },
    kpiSnapshot: {
      upsert: vi.fn().mockResolvedValue({}),
      findMany: vi.fn().mockResolvedValue([]),
    } as any,
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

  beforeEach(async () => {
    vi.clearAllMocks();
    mockIo = createMockIo();
    mockPrisma = createMockPrisma();
    // Update prismaRef to point to the newly created mock
    (mockPrisma as Partial<PrismaClient>).room = mockPrisma.room;
    (mockPrisma as Partial<PrismaClient>).player = mockPrisma.player;
    (mockPrisma as Partial<PrismaClient>).company = mockPrisma.company;
    (mockPrisma as Partial<PrismaClient>).asset = mockPrisma.asset;
    engine = new GameEngine(mockIo, mockPrisma);
    // Decisions/config now load from the DB (see GameEngine.loadGameData) instead
    // of a synchronous JSON import — every test needs this awaited first.
    await engine.loadGameData();
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

    it('should throw when the name was kicked from this room, even after the name is free again', async () => {
      const creator = {
        id: '',
        name: 'Alice',
        roomId: '',
        isHost: false,
        bankrupt: false,
        socketId: 'socket-1',
      };
      const roomState = await engine.createRoom(creator);
      roomState.kickedNames.add('Bob');

      const rejoinAttempt = {
        id: '',
        name: 'Bob',
        roomId: '',
        isHost: false,
        bankrupt: false,
        socketId: 'socket-2',
      };

      await expect(engine.joinRoom(roomState.room.id, rejoinAttempt)).rejects.toThrow(
        'You were removed from this room and cannot rejoin',
      );
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

  describe('buildRoomSnapshot', () => {
    it('should rebuild players fresh from roomState.players, not the stale roomState.room.players', async () => {
      const creator = { id: '', name: 'Alice', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-1' };
      const roomState = await engine.createRoom(creator);
      await engine.joinRoom(roomState.room.id, { id: '', name: 'Bob', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-2' });

      // roomState.room.players (the embedded array from room creation) never gets
      // updated by joinRoom — this is exactly the staleness buildRoomSnapshot exists
      // to route around. Confirm the raw embedded array really is stale...
      expect(roomState.room.players).toHaveLength(1);

      // ...but the snapshot is not.
      const snapshot = engine.buildRoomSnapshot(roomState);
      expect(snapshot.players).toHaveLength(2);
      expect(snapshot.players.map((p) => p.name).sort()).toEqual(['Alice', 'Bob']);
    });

    it('should include inviteOnly', async () => {
      const creator = { id: '', name: 'Alice', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-1' };
      const roomState = await engine.createRoom(creator);
      roomState.room.inviteOnly = true;

      expect(engine.buildRoomSnapshot(roomState).inviteOnly).toBe(true);
    });
  });

  describe('promoteNewHostIfNeeded', () => {
    it('should no-op when a host already exists', async () => {
      const creator = { id: '', name: 'Alice', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-1' };
      const roomState = await engine.createRoom(creator);
      await engine.joinRoom(roomState.room.id, { id: '', name: 'Bob', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-2' });

      await engine.promoteNewHostIfNeeded(roomState);

      const hosts = Array.from(roomState.players.values()).filter((p) => p.isHost);
      expect(hosts).toHaveLength(1);
      expect(hosts[0].name).toBe('Alice');
    });

    it('should no-op on an empty room', async () => {
      const creator = { id: '', name: 'Alice', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-1' };
      const roomState = await engine.createRoom(creator);
      roomState.players.clear();

      await expect(engine.promoteNewHostIfNeeded(roomState)).resolves.not.toThrow();
    });

    it('should promote the earliest-remaining-joined player when no host exists', async () => {
      const creator = { id: '', name: 'Alice', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-1' };
      const roomState = await engine.createRoom(creator);
      await engine.joinRoom(roomState.room.id, { id: '', name: 'Bob', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-2' });
      await engine.joinRoom(roomState.room.id, { id: '', name: 'Carol', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-3' });

      // Simulate the original host having just left — no one is host anymore.
      const alice = Array.from(roomState.players.values()).find((p) => p.name === 'Alice')!;
      roomState.players.delete(alice.id);

      await engine.promoteNewHostIfNeeded(roomState);

      const bob = Array.from(roomState.players.values()).find((p) => p.name === 'Bob')!;
      const carol = Array.from(roomState.players.values()).find((p) => p.name === 'Carol')!;
      expect(bob.isHost).toBe(true);
      expect(carol.isHost).toBe(false);
      expect(mockPrisma.player.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: bob.id }, data: { isHost: true } }),
      );
    });
  });

  describe('leaveRoom', () => {
    it('should fail outside WAITING phase', async () => {
      const creator = { id: '', name: 'Alice', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-1' };
      const roomState = await engine.createRoom(creator);
      roomState.room.status = RoomStatus.GAME_PHASE;
      const alice = Array.from(roomState.players.values())[0];

      const result = await engine.leaveRoom(roomState.room.id, alice.id);

      expect(result).toEqual({ success: false, reason: 'not_in_lobby' });
    });

    it('should fail for an unknown player', async () => {
      const creator = { id: '', name: 'Alice', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-1' };
      const roomState = await engine.createRoom(creator);

      const result = await engine.leaveRoom(roomState.room.id, 'not-a-real-player');

      expect(result).toEqual({ success: false, reason: 'not_found' });
    });

    it('should remove the player and delete their DB rows', async () => {
      const creator = { id: '', name: 'Alice', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-1' };
      const roomState = await engine.createRoom(creator);
      const bobRoomState = await engine.joinRoom(roomState.room.id, { id: '', name: 'Bob', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-2' });
      const bob = Array.from(bobRoomState.players.values()).find((p) => p.name === 'Bob')!;

      const result = await engine.leaveRoom(roomState.room.id, bob.id);

      expect(result).toEqual({ success: true });
      expect(roomState.players.has(bob.id)).toBe(false);
      expect(mockPrisma.player.delete).toHaveBeenCalledWith(expect.objectContaining({ where: { id: bob.id } }));
      expect(engine.getPlayerRoom('socket-2')).toBeUndefined();
    });

    it('should promote a new host when the host leaves and others remain', async () => {
      const creator = { id: '', name: 'Alice', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-1' };
      const roomState = await engine.createRoom(creator);
      await engine.joinRoom(roomState.room.id, { id: '', name: 'Bob', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-2' });
      const alice = Array.from(roomState.players.values()).find((p) => p.name === 'Alice')!;

      const result = await engine.leaveRoom(roomState.room.id, alice.id);

      expect(result).toEqual({ success: true });
      const bob = Array.from(roomState.players.values()).find((p) => p.name === 'Bob')!;
      expect(bob.isHost).toBe(true);
    });

    it('should delete the room when the last player leaves', async () => {
      const creator = { id: '', name: 'Alice', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-1' };
      const roomState = await engine.createRoom(creator);
      const alice = Array.from(roomState.players.values())[0];
      const roomId = roomState.room.id;

      const result = await engine.leaveRoom(roomId, alice.id);

      expect(result).toEqual({ success: true });
      expect(engine.getRoom(roomId)).toBeUndefined();
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

    it('promotes a new host and broadcasts ROOM_UPDATED when the host\'s grace period expires and others remain', async () => {
      vi.useFakeTimers();
      const localIo = createMockIo();
      const localPrisma = createMockPrisma();
      const localEngine = new GameEngine(localIo, localPrisma);

      const creator = { id: '', name: 'Alice', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-1' };
      const roomState = await localEngine.createRoom(creator);
      await localEngine.joinRoom(roomState.room.id, { id: '', name: 'Bob', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-2' });

      await localEngine.markPlayerDisconnected('socket-1'); // the host
      await vi.advanceTimersByTimeAsync(70_000);

      const bob = Array.from(roomState.players.values()).find((p) => p.name === 'Bob')!;
      expect(bob.isHost).toBe(true);
      expect(localIo.emit).toHaveBeenCalledWith(
        ServerEvents.ROOM_UPDATED,
        expect.objectContaining({ room: expect.objectContaining({ players: expect.arrayContaining([expect.objectContaining({ name: 'Bob', isHost: true })]) }) }),
      );

      localEngine.stop();
    });

    it('defers finalizing removal while this room\'s turn is already resolving, then finalizes it once that resolution finishes (regression — the race this app used to have no protection against)', async () => {
      vi.useFakeTimers();
      const localIo = createMockIo();
      const localPrisma = createMockPrisma();
      const localEngine = new GameEngine(localIo, localPrisma);
      await localEngine.loadGameData();

      const creator = { id: '', name: 'Alice', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-1' };
      const roomState = await localEngine.createRoom(creator);
      await localEngine.joinRoom(roomState.room.id, { id: '', name: 'Bob', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-2' });
      roomState.room.status = RoomStatus.GAME_PHASE;
      roomState.room.currentPhaseRound = 1;

      // Bob disconnects (network hiccup, backgrounded tab, whatever) — his grace
      // period starts now.
      await localEngine.markPlayerDisconnected('socket-2');

      // Block resolveGameTurn's per-player persistence mid-flight, so it stays inside
      // its advancingRooms-held critical section for as long as this test needs —
      // simulating the round timer independently firing at almost the same moment
      // Bob's grace period is about to expire.
      let releaseUpdate: () => void = () => {};
      const blocker = new Promise<void>((resolve) => { releaseUpdate = resolve; });
      (localPrisma.company.update as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        await blocker;
        return {};
      });

      const turnPromise = localEngine.resolveGameTurn(roomState.room.id);

      // Cross both the 10s heartbeat tick and the 60s grace-period deadline while
      // resolveGameTurn is still stuck mid-flight (advancingRooms still holds this room).
      await vi.advanceTimersByTimeAsync(70_000);
      expect(localPrisma.player.delete).not.toHaveBeenCalled();

      // Let resolveGameTurn finish and release the lock.
      releaseUpdate();
      await turnPromise;

      // The next heartbeat tick (10s later) now finds the lock free and finalizes it.
      await vi.advanceTimersByTimeAsync(10_000);
      expect(localPrisma.player.delete).toHaveBeenCalled();

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

    it('should still complete and broadcast the turn even if one player\'s row disappeared mid-resolution (regression — a heartbeat-sweep/resolveGameTurn race)', async () => {
      // Simulates a player whose reconnect grace period expired (their Company/Player
      // rows deleted by finalizePlayerRemoval) at almost the exact moment this room's
      // turn was already resolving — a real race this app used to have no protection
      // against at all. Before the fix, one player's Prisma "record not found" here
      // would throw, abort the whole persistence loop, and the outer catch would
      // swallow it silently — turn:resolved/phase:changed never fire, the round timer
      // (already cleared by the caller) never restarts, and the room is stuck until
      // every client manually refreshes. Each player's persistence must be isolated.
      const host = { id: '', name: 'Alice', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-1' };
      const roomState = await engine.createRoom(host);
      await engine.joinRoom(roomState.room.id, { id: '', name: 'Bob', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-2' });
      roomState.room.status = RoomStatus.GAME_PHASE;
      roomState.room.currentPhaseRound = 1;

      const bobId = Array.from(roomState.players.values()).find((p) => p.name === 'Bob')!.id;

      const realUpdate = (mockPrisma.company.update as ReturnType<typeof vi.fn>).getMockImplementation();
      (mockPrisma.company.update as ReturnType<typeof vi.fn>).mockImplementation((args: any) => {
        if (args.where.playerId === bobId) {
          return Promise.reject(new Error('P2025: Record to update not found (simulated concurrent deletion)'));
        }
        return realUpdate ? realUpdate(args) : Promise.resolve({});
      });

      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await expect(engine.resolveGameTurn(roomState.room.id)).resolves.not.toThrow();

      // The room still fully resolved and looped into round 2 — Bob's missing row
      // didn't take the rest of the turn down with it.
      expect(roomState.room.status).toBe(RoomStatus.GAME_PHASE);
      expect(roomState.room.currentPhaseRound).toBe(2);
      expect(roomState.timerValue).toBe(PHASE_TIMERS[RoomStatus.GAME_PHASE]);

      const turnResolvedCalls = (mockIo.emit as ReturnType<typeof vi.fn>).mock.calls.filter(
        (call: [string, ...unknown[]]) => call[0] === ServerEvents.TURN_RESOLVED,
      );
      expect(turnResolvedCalls).toHaveLength(1);

      expect(consoleErrorSpy).toHaveBeenCalled();
      consoleErrorSpy.mockRestore();
    });
  });

  describe('toggleReady', () => {
    it('should return null outside GAME_PHASE', async () => {
      const host = { id: '', name: 'Alice', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-1' };
      const roomState = await engine.createRoom(host);
      const playerId = Array.from(roomState.players.values())[0].id;

      expect(engine.toggleReady(roomState.room.id, playerId, true)).toBeNull();
    });

    it('should return null for an unknown player', async () => {
      const host = { id: '', name: 'Alice', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-1' };
      const roomState = await engine.createRoom(host);
      roomState.room.status = RoomStatus.GAME_PHASE;

      expect(engine.toggleReady(roomState.room.id, 'not-a-real-player', true)).toBeNull();
    });

    it('should return null for an already-bankrupt player', async () => {
      const host = { id: '', name: 'Alice', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-1' };
      const roomState = await engine.createRoom(host);
      const playerId = Array.from(roomState.players.values())[0].id;
      roomState.room.status = RoomStatus.GAME_PHASE;
      roomState.players.get(playerId)!.bankrupt = true;

      expect(engine.toggleReady(roomState.room.id, playerId, true)).toBeNull();
    });

    it('should add the player to readyPlayerIds and report activePlayerCount', async () => {
      const host = { id: '', name: 'Alice', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-1' };
      const roomState = await engine.createRoom(host);
      await engine.joinRoom(roomState.room.id, { id: '', name: 'Bob', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-2' });
      const aliceId = Array.from(roomState.players.values()).find((p) => p.name === 'Alice')!.id;
      roomState.room.status = RoomStatus.GAME_PHASE;

      const result = engine.toggleReady(roomState.room.id, aliceId, true);

      expect(result).toEqual({ readyPlayerIds: [aliceId], activePlayerCount: 2 });
    });

    it('should remove the player from readyPlayerIds when un-readying', async () => {
      const host = { id: '', name: 'Alice', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-1' };
      const roomState = await engine.createRoom(host);
      const aliceId = Array.from(roomState.players.values())[0].id;
      roomState.room.status = RoomStatus.GAME_PHASE;

      engine.toggleReady(roomState.room.id, aliceId, true);
      const result = engine.toggleReady(roomState.room.id, aliceId, false);

      expect(result).toEqual({ readyPlayerIds: [], activePlayerCount: 1 });
    });

    it('should exclude bankrupt players from activePlayerCount', async () => {
      const host = { id: '', name: 'Alice', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-1' };
      const roomState = await engine.createRoom(host);
      const bobRoomState = await engine.joinRoom(roomState.room.id, { id: '', name: 'Bob', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-2' });
      const aliceId = Array.from(roomState.players.values()).find((p) => p.name === 'Alice')!.id;
      const bobId = Array.from(bobRoomState.players.values()).find((p) => p.name === 'Bob')!.id;
      roomState.room.status = RoomStatus.GAME_PHASE;
      roomState.players.get(bobId)!.bankrupt = true;

      const result = engine.toggleReady(roomState.room.id, aliceId, true);

      expect(result).toEqual({ readyPlayerIds: [aliceId], activePlayerCount: 1 });
    });
  });

  describe('resolveGameTurn — ready reset', () => {
    it('should clear readyPlayerIds and broadcast an empty game:readyUpdate for the next round', async () => {
      const host = { id: '', name: 'Alice', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-1' };
      const roomState = await engine.createRoom(host);
      await engine.joinRoom(roomState.room.id, { id: '', name: 'Bob', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-2' });
      const aliceId = Array.from(roomState.players.values()).find((p) => p.name === 'Alice')!.id;
      roomState.room.status = RoomStatus.GAME_PHASE;
      roomState.room.currentPhaseRound = 1;
      roomState.readyPlayerIds.add(aliceId);

      await engine.resolveGameTurn(roomState.room.id);

      expect(roomState.readyPlayerIds.size).toBe(0);
      const readyUpdateCalls = (mockIo.emit as ReturnType<typeof vi.fn>).mock.calls.filter(
        (call: [string, ...unknown[]]) => call[0] === ServerEvents.GAME_READY_UPDATE,
      );
      expect(readyUpdateCalls.length).toBeGreaterThan(0);
      expect(readyUpdateCalls[readyUpdateCalls.length - 1][1]).toEqual({ readyPlayerIds: [], activePlayerCount: 2 });
    });
  });

  describe('forfeitGame — ready interaction', () => {
    it('should drop the forfeiting player from readyPlayerIds and signal immediate resolution once everyone remaining is ready', async () => {
      const host = { id: '', name: 'Alice', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-1' };
      const roomState = await engine.createRoom(host);
      const bobRoomState = await engine.joinRoom(roomState.room.id, { id: '', name: 'Bob', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-2' });
      await engine.joinRoom(roomState.room.id, { id: '', name: 'Carol', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-3' });
      const aliceId = Array.from(roomState.players.values()).find((p) => p.name === 'Alice')!.id;
      const bobId = Array.from(bobRoomState.players.values()).find((p) => p.name === 'Bob')!.id;
      const carolId = Array.from(roomState.players.values()).find((p) => p.name === 'Carol')!.id;
      roomState.room.status = RoomStatus.GAME_PHASE;

      // Bob and Carol are both ready; Alice (about to forfeit) never clicked ready.
      roomState.readyPlayerIds.add(bobId);
      roomState.readyPlayerIds.add(carolId);

      // Two players remain non-bankrupt after Alice forfeits.
      (mockPrisma.player.findMany as ReturnType<typeof vi.fn>).mockImplementation(({ where }: any) =>
        Promise.resolve(
          where?.roomId === roomState.room.id && where?.bankrupt === false
            ? [{ id: bobId }, { id: carolId }]
            : [],
        ),
      );

      const result = await engine.forfeitGame(roomState.room.id, aliceId);

      expect(result).toEqual({ success: true, triggerImmediateResolution: true });
      expect(roomState.readyPlayerIds.has(aliceId)).toBe(false);
    });

    it('should not signal immediate resolution while a remaining active player still isn\'t ready', async () => {
      const host = { id: '', name: 'Alice', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-1' };
      const roomState = await engine.createRoom(host);
      const bobRoomState = await engine.joinRoom(roomState.room.id, { id: '', name: 'Bob', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-2' });
      await engine.joinRoom(roomState.room.id, { id: '', name: 'Carol', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-3' });
      const aliceId = Array.from(roomState.players.values()).find((p) => p.name === 'Alice')!.id;
      const bobId = Array.from(bobRoomState.players.values()).find((p) => p.name === 'Bob')!.id;
      const carolId = Array.from(roomState.players.values()).find((p) => p.name === 'Carol')!.id;
      roomState.room.status = RoomStatus.GAME_PHASE;

      // Only Bob is ready — Carol is not.
      roomState.readyPlayerIds.add(bobId);

      (mockPrisma.player.findMany as ReturnType<typeof vi.fn>).mockImplementation(({ where }: any) =>
        Promise.resolve(
          where?.roomId === roomState.room.id && where?.bankrupt === false
            ? [{ id: bobId }, { id: carolId }]
            : [],
        ),
      );

      const result = await engine.forfeitGame(roomState.room.id, aliceId);

      expect(result).toEqual({ success: true, triggerImmediateResolution: false });
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

    it('should persist a KpiSnapshot row for round 1 for every player in the snapshot', async () => {
      const host = { id: '', name: 'Alice', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-1' };
      const roomState = await engine.createRoom(host);

      await engine.broadcastInitialSnapshot(roomState.room.id, 1);

      expect(mockPrisma.kpiSnapshot!.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { playerId_round: { playerId: expect.any(String), round: 1 } },
        }),
      );
    });
  });

  describe('makeOffer / acceptOffer / goToCourt', () => {
    /** A negotiating case between two real room players — `player.findMany` overridden
     * to carry `company.variables`/`engineState` (the default mock company fixture, per
     * `createMockPrisma`, only has `cash`/`debt`/`assets`), since these are the fields
     * GameLoop's pure makeOffer/acceptOffer/goToCourt methods actually read. */
    async function makeTwoPartyCaseRoom() {
      const host = { id: '', name: 'Alice', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-1' };
      const roomState = await engine.createRoom(host);
      await engine.joinRoom(roomState.room.id, { id: '', name: 'Bob', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-2' });
      roomState.room.status = RoomStatus.GAME_PHASE;

      const [aliceId, bobId] = Array.from(roomState.players.keys());
      const case_ = {
        id: 'case-1',
        roomId: roomState.room.id,
        plaintiffId: bobId,
        defendantId: aliceId,
        decisionName: 'Water Pumping',
        groundName: 'Environmental Violation',
        description: 'Sue for environmental damage',
        baseProbability: 0.12,
        stakes: 20000,
        status: 'negotiating' as const,
        offers: [] as Array<{ by: 'plaintiff' | 'defendant'; amount: number }>,
        turnsNegotiating: 0,
        createdAt: new Date(),
      };

      (mockPrisma.player.findMany as ReturnType<typeof vi.fn>).mockImplementation(({ where }: any) =>
        Promise.resolve(
          where?.roomId === roomState.room.id
            ? [
                {
                  id: aliceId,
                  name: 'Alice',
                  roomId: roomState.room.id,
                  bankrupt: false,
                  company: { variables: { cash: 100000 }, engineState: { legalCases: [case_] } },
                },
                {
                  id: bobId,
                  name: 'Bob',
                  roomId: roomState.room.id,
                  bankrupt: false,
                  company: { variables: { cash: 50000 }, engineState: { legalCases: [case_] } },
                },
              ]
            : [],
        ),
      );

      return { roomState, aliceId, bobId };
    }

    it('makeOffer persists both parties\' Company rows and emits the update to both sockets', async () => {
      const { roomState, aliceId } = await makeTwoPartyCaseRoom();

      const outcome = await engine.makeOffer(roomState.room.id, aliceId, 'case-1', 10000);

      expect(outcome.success).toBe(true);
      expect(mockPrisma.company.update).toHaveBeenCalledTimes(2);
      const emittedTo = (mockIo.to as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
      expect(emittedTo).toEqual(expect.arrayContaining(['socket-1', 'socket-2']));
      const legalCaseUpdateCalls = (mockIo.emit as ReturnType<typeof vi.fn>).mock.calls.filter(
        (call: [string, ...unknown[]]) => call[0] === ServerEvents.GAME_LEGAL_CASE_UPDATE,
      );
      expect(legalCaseUpdateCalls).toHaveLength(2);
      // An offer never moves cash — neither recipient gets a newCash figure.
      for (const call of legalCaseUpdateCalls) {
        expect((call[1] as any).newCash).toBeUndefined();
        expect((call[1] as any).case.offers).toEqual([{ by: 'defendant', amount: 10000 }]);
      }
    });

    it('acceptOffer settles the case and gives each recipient their OWN new cash figure, not the other party\'s', async () => {
      const { roomState, aliceId, bobId } = await makeTwoPartyCaseRoom();
      // Seed a pending offer directly, bypassing a real makeOffer call.
      (mockPrisma.player.findMany as ReturnType<typeof vi.fn>).mockImplementation(({ where }: any) =>
        Promise.resolve(
          where?.roomId === roomState.room.id
            ? [
                { id: aliceId, name: 'Alice', roomId: roomState.room.id, bankrupt: false, company: { variables: { cash: 100000 }, engineState: { legalCases: [{ id: 'case-1', roomId: roomState.room.id, plaintiffId: bobId, defendantId: aliceId, decisionName: 'Water Pumping', groundName: 'Environmental Violation', description: 'x', baseProbability: 0.12, stakes: 20000, status: 'negotiating', offers: [{ by: 'defendant', amount: 10000 }], turnsNegotiating: 0, createdAt: new Date() }] } } },
                { id: bobId, name: 'Bob', roomId: roomState.room.id, bankrupt: false, company: { variables: { cash: 50000 }, engineState: { legalCases: [{ id: 'case-1', roomId: roomState.room.id, plaintiffId: bobId, defendantId: aliceId, decisionName: 'Water Pumping', groundName: 'Environmental Violation', description: 'x', baseProbability: 0.12, stakes: 20000, status: 'negotiating', offers: [{ by: 'defendant', amount: 10000 }], turnsNegotiating: 0, createdAt: new Date() }] } } },
              ]
            : [],
        ),
      );

      const outcome = await engine.acceptOffer(roomState.room.id, bobId, 'case-1');

      expect(outcome.success).toBe(true);
      const legalCaseUpdateCalls = (mockIo.emit as ReturnType<typeof vi.fn>).mock.calls.filter(
        (call: [string, ...unknown[]]) => call[0] === ServerEvents.GAME_LEGAL_CASE_UPDATE,
      );
      expect(legalCaseUpdateCalls).toHaveLength(2);
      const newCashValues = legalCaseUpdateCalls.map((call) => (call[1] as any).newCash).sort((a, b) => a - b);
      // Alice (defendant, started at 100000) pays 10000 -> 90000; Bob (plaintiff, started
      // at 50000) receives it -> 60000. Each socket gets only its own figure.
      expect(newCashValues).toEqual([60000, 90000]);
    });

    it('goToCourt marks the case awaiting_trial and moves no cash', async () => {
      const { roomState, aliceId } = await makeTwoPartyCaseRoom();

      const outcome = await engine.goToCourt(roomState.room.id, aliceId, 'case-1');

      expect(outcome.success).toBe(true);
      if (!outcome.success) return;
      expect(outcome.case.status).toBe('awaiting_trial');
      const legalCaseUpdateCalls = (mockIo.emit as ReturnType<typeof vi.fn>).mock.calls.filter(
        (call: [string, ...unknown[]]) => call[0] === ServerEvents.GAME_LEGAL_CASE_UPDATE,
      );
      for (const call of legalCaseUpdateCalls) {
        expect((call[1] as any).newCash).toBeUndefined();
      }
    });

    it('does not write to the DB or emit anything on a validation failure (e.g. not this player\'s turn)', async () => {
      const { roomState, bobId } = await makeTwoPartyCaseRoom();

      // Plaintiff (Bob) tries to make the opening offer — only the defendant may move first.
      const outcome = await engine.makeOffer(roomState.room.id, bobId, 'case-1', 10000);

      expect(outcome).toEqual({ success: false, reason: 'not_your_turn' });
      expect(mockPrisma.company.update).not.toHaveBeenCalled();
      const legalCaseUpdateCalls = (mockIo.emit as ReturnType<typeof vi.fn>).mock.calls.filter(
        (call: [string, ...unknown[]]) => call[0] === ServerEvents.GAME_LEGAL_CASE_UPDATE,
      );
      expect(legalCaseUpdateCalls).toHaveLength(0);
    });
  });

  describe('getKpiHistory', () => {
    it('returns this player\'s persisted history (oldest round first) plus a 3-turn prediction, tagged with their own playerId', async () => {
      const host = { id: '', name: 'Alice', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-1' };
      const roomState = await engine.createRoom(host);
      const aliceId = Array.from(roomState.players.keys())[0];
      roomState.room.status = RoomStatus.GAME_PHASE;
      roomState.room.currentPhaseRound = 2;

      (mockPrisma.kpiSnapshot!.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
        { round: 1, variables: {}, derived: {}, riskGauge: 5 },
      ]);

      const response = await engine.getKpiHistory(roomState.room.id, aliceId, true);

      expect(response).not.toBeNull();
      expect(response!.playerId).toBe(aliceId);
      expect(response!.history).toEqual([{ round: 1, variables: {}, derived: {}, riskGauge: 5 }]);
      expect(Array.isArray(response!.predicted)).toBe(true);
    });

    it('returns only real history for a rival lookup — no prediction is ever run', async () => {
      const host = { id: '', name: 'Alice', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-1' };
      const roomState = await engine.createRoom(host);
      const rivalId = 'rival-player-id';
      roomState.room.status = RoomStatus.GAME_PHASE;
      roomState.room.currentPhaseRound = 2;

      (mockPrisma.kpiSnapshot!.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
        { round: 1, variables: {}, derived: {}, riskGauge: 3 },
      ]);

      const response = await engine.getKpiHistory(roomState.room.id, rivalId, false);

      expect(response).not.toBeNull();
      expect(response!.playerId).toBe(rivalId);
      expect(response!.history).toEqual([{ round: 1, variables: {}, derived: {}, riskGauge: 3 }]);
      expect(response!.predicted).toEqual([]);
      expect(response!.bankruptAtRound).toBeUndefined();
      expect(mockPrisma.kpiSnapshot!.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { playerId: rivalId, player: { roomId: roomState.room.id } } }),
      );
    });

    it('returns null for a room that does not exist', async () => {
      const response = await engine.getKpiHistory('nonexistent-room', 'player-1', true);

      expect(response).toBeNull();
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

  describe('getAdminRoomsSnapshot', () => {
    it('returns an empty array when there are no in-memory rooms', () => {
      expect(engine.getAdminRoomsSnapshot()).toEqual([]);
    });

    it('reflects every room, in every phase, with every player — including disconnected and bankrupt ones', async () => {
      const creator = { id: '', name: 'Alice', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-1' };
      const roomState = await engine.createRoom(creator);
      const joiner = { id: '', name: 'Bob', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-2' };
      await engine.joinRoom(roomState.room.id, joiner);

      const [aliceId, bobId] = Array.from(roomState.players.keys());
      // Bob disconnects (kept in the room during the grace period, not removed)...
      await engine.markPlayerDisconnected('socket-2');
      // ...and Alice goes bankrupt (flagged in-memory the same way resolveGameTurn does).
      roomState.players.get(aliceId)!.bankrupt = true;

      const snapshot = engine.getAdminRoomsSnapshot();

      expect(snapshot).toHaveLength(1);
      const room = snapshot[0];
      expect(room.id).toBe(roomState.room.id);
      expect(room.status).toBe(RoomStatus.WAITING);
      expect(room.maxPlayers).toBe(4);
      expect(room.players).toHaveLength(2);

      const alice = room.players.find((p) => p.id === aliceId)!;
      expect(alice).toMatchObject({ name: 'Alice', isHost: true, bankrupt: true, connected: true });

      const bob = room.players.find((p) => p.id === bobId)!;
      expect(bob).toMatchObject({ name: 'Bob', isHost: false, bankrupt: false, connected: false });
    });
  });

  describe('upsertDecision', () => {
    const newDecision = {
      decision: 'Test Admin Decision',
      level: 'Operational' as const,
      description: 'A decision created for testing.',
      nature: 'Traditional' as const,
      offensiveAction: false,
      excludes: [],
      impacts: { cash: { type: 'absolute' as const, schedule: { default: -1000 } } },
    };

    it('creates a new decision and live-reloads it into GameLoop', async () => {
      const result = await engine.upsertDecision(newDecision, true);

      expect(result).toEqual({ success: true });
      expect(engine.getDecisionsSnapshot().find((d) => d.decision === 'Test Admin Decision')).toEqual(newDecision);
    });

    it('rejects creating a decision that already exists', async () => {
      const result = await engine.upsertDecision({ ...newDecision, decision: 'Bot Attack' }, true);

      expect(result).toEqual({ success: false, reason: 'already_exists' });
    });

    it('updates an existing decision and live-reloads the change', async () => {
      const updated = { ...newDecision, decision: 'Bot Attack', description: 'Updated description.' };

      const result = await engine.upsertDecision(updated, false);

      expect(result).toEqual({ success: true });
      expect(engine.getDecisionsSnapshot().find((d) => d.decision === 'Bot Attack')?.description).toBe('Updated description.');
    });

    it('rejects updating a decision that does not exist', async () => {
      const result = await engine.upsertDecision(newDecision, false);

      expect(result).toEqual({ success: false, reason: 'not_found' });
    });
  });

  describe('deleteDecision', () => {
    it('deletes an unused decision and removes it from GameLoop', async () => {
      const result = await engine.deleteDecision('Fox Release');

      expect(result).toEqual({ success: true });
      expect(engine.getDecisionsSnapshot().find((d) => d.decision === 'Fox Release')).toBeUndefined();
    });

    it('returns not_found for an unknown decision', async () => {
      const result = await engine.deleteDecision('Nonexistent Decision');

      expect(result).toEqual({ success: false, reason: 'not_found' });
    });

    it('rejects deletion while a non-bankrupt player currently has it deployed', async () => {
      const player = await mockPrisma.player.create({
        data: { name: 'Alice', roomId: 'room-1', isHost: true, bankrupt: false, socketId: 'socket-1' },
      } as any) as any;
      player.company.engineState = {
        activeDecisions: [{ id: 'inst-1', definitionName: 'Bot Attack', deployedYear: 1, elapsedYears: 0, isMatured: true }],
      };

      const result = await engine.deleteDecision('Bot Attack');

      expect(result).toEqual({ success: false, reason: 'in_use' });
      expect(engine.getDecisionsSnapshot().find((d) => d.decision === 'Bot Attack')).toBeDefined();
    });

    it('allows deletion once the only player with it deployed is bankrupt', async () => {
      const player = await mockPrisma.player.create({
        data: { name: 'Alice', roomId: 'room-1', isHost: true, bankrupt: true, socketId: 'socket-1' },
      } as any) as any;
      player.company.engineState = {
        activeDecisions: [{ id: 'inst-1', definitionName: 'Bot Attack', deployedYear: 1, elapsedYears: 0, isMatured: true }],
      };

      const result = await engine.deleteDecision('Bot Attack');

      expect(result).toEqual({ success: true });
    });
  });

  describe('updateGameConfigData', () => {
    it('persists the new config and live-reloads it into GameLoop', async () => {
      const newConfig = engine.getGameConfigSnapshot();
      const updated = { ...newConfig, gameSettings: { ...newConfig.gameSettings, digDeeperCost: 55555 } };

      await engine.updateGameConfigData(updated);

      expect(engine.getGameConfigSnapshot().gameSettings.digDeeperCost).toBe(55555);
      expect(mockPrisma.gameConfigRow.update).toHaveBeenCalledWith({
        where: { id: 1 },
        data: {
          gameSettings: updated.gameSettings,
          playerStartingValues: updated.playerStartingValues,
          adminVariables: updated.adminVariables,
        },
      });
    });
  });

  describe('updateFormula', () => {
    it('returns not_found for an unknown formula key', async () => {
      const result = await engine.updateFormula('notARealFormula', '1 + 1', 'bogus');

      expect(result).toEqual({ success: false, reason: 'not_found' });
    });

    it('persists the new expression/description and reflects it in getFormulasSnapshot', async () => {
      const result = await engine.updateFormula('revenue', 'volume * price * 2 + revenueDelta', 'doubled for testing');

      expect(result).toEqual({ success: true });
      const snapshot = engine.getFormulasSnapshot().find((f) => f.key === 'revenue');
      expect(snapshot).toEqual({ key: 'revenue', expression: 'volume * price * 2 + revenueDelta', description: 'doubled for testing' });
      expect(mockPrisma.formula.update).toHaveBeenCalledWith({
        where: { key: 'revenue' },
        data: { expression: 'volume * price * 2 + revenueDelta', description: 'doubled for testing' },
      });
    });

    it('live-reloads GameLoop — a changed formula affects the very next computation, no restart', async () => {
      const host = { id: '', name: 'Alice', roomId: '', isHost: false, bankrupt: false, socketId: 'socket-1' };
      const roomState = await engine.createRoom(host);

      await engine.broadcastInitialSnapshot(roomState.room.id, 1);
      const before = (mockIo.emit as ReturnType<typeof vi.fn>).mock.calls
        .filter((call: [string, ...unknown[]]) => call[0] === ServerEvents.TURN_RESOLVED)
        .pop()![1] as any;
      const revenueBefore = before.players[0].derived.revenue;

      await engine.updateFormula('revenue', 'volume * price * 2 + revenueDelta', 'doubled for testing');

      await engine.broadcastInitialSnapshot(roomState.room.id, 1);
      const after = (mockIo.emit as ReturnType<typeof vi.fn>).mock.calls
        .filter((call: [string, ...unknown[]]) => call[0] === ServerEvents.TURN_RESOLVED)
        .pop()![1] as any;
      const revenueAfter = after.players[0].derived.revenue;

      // Doubling the formula should double revenue (volume*price term dominates; revenueDelta is 0 pre-decisions)
      expect(revenueAfter).toBeCloseTo(revenueBefore * 2, 4);
    });
  });
});
