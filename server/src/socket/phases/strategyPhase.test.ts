import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { strategyPhase } from './strategyPhase';
import { RoomStatus, ServerEvents, type RoomState } from '@suetheirasses/shared';
import type { Server } from 'socket.io';
import type { PrismaClient } from '@prisma/client';

const createMockIo = () => ({
  to: vi.fn().mockReturnThis(),
  emit: vi.fn().mockReturnThis(),
}) as unknown as Server;

const createMockPrisma = () => ({
  company: {
    findUnique: vi.fn().mockResolvedValue({ cash: 100000 }),
    update: vi.fn(),
  },
  player: {
    findUnique: vi.fn(),
  },
} as unknown as PrismaClient);

const createMockRoomState = (
  status: RoomStatus,
  submissions: Map<string, { actions: { type: string; amount?: number }[] }>,
  playerNames: Map<string, string>,
): RoomState => ({
  room: {
    id: 'room-1',
    status,
    maxPlayers: 6,
    currentPhaseRound: 1,
    players: [],
    createdAt: new Date(),
  },
  players: new Map(
    Array.from(playerNames.entries()).map(([id, name]) => [
      id,
      { id, name, roomId: 'room-1', isHost: true, bankrupt: false },
    ]),
  ),
  submissions,
  timer: null,
  timerValue: 0,
});

describe('strategyPhase.resolve', () => {
  let mockIo: Server;
  let mockPrisma: PrismaClient;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockIo = createMockIo();
    mockPrisma = createMockPrisma();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should apply strategies for all players and broadcast results', async () => {
    const submissions = new Map([
      ['player-1', { actions: [{ type: 'INVEST', amount: 10000 }] }],
      ['player-2', { actions: [{ type: 'LAYOFF', amount: 5000 }] }],
    ]);

    const playerNames = new Map([
      ['player-1', 'Alice'],
      ['player-2', 'Bob'],
    ]);

    const roomState = createMockRoomState(RoomStatus.STRATEGY, submissions, playerNames);

    await strategyPhase.resolve('room-1', roomState, mockIo, mockPrisma);

    expect(mockIo.to).toHaveBeenCalledWith('room-1');
    expect(mockIo.emit).toHaveBeenCalledWith(
      ServerEvents.RESULTS_REVEAL,
      expect.objectContaining({ outcomes: expect.any(Array) }),
    );
    // Phase status is NOT changed here — the game engine handles phase transitions
  });

  it('should include player names in outcomes', async () => {
    const submissions = new Map([
      ['player-1', { actions: [{ type: 'INVEST', amount: 10000 }] }],
    ]);

    const playerNames = new Map([['player-1', 'Alice']]);
    const roomState = createMockRoomState(RoomStatus.STRATEGY, submissions, playerNames);

    await strategyPhase.resolve('room-1', roomState, mockIo, mockPrisma);

    const emitCalls = (mockIo.emit as ReturnType<typeof vi.fn>).mock.calls;
    const resultsCall = emitCalls.find((call: [string, ...unknown[]]) => call[0] === ServerEvents.RESULTS_REVEAL);
    expect(resultsCall).toBeDefined();
    expect((resultsCall as [string, { outcomes: { playerName: string }[] }])[1].outcomes[0].playerName).toBe('Alice');
  });

  it('should handle empty submissions', async () => {
    const submissions = new Map();
    const playerNames = new Map();
    const roomState = createMockRoomState(RoomStatus.STRATEGY, submissions, playerNames);

    await strategyPhase.resolve('room-1', roomState, mockIo, mockPrisma);

    const emitCalls = (mockIo.emit as ReturnType<typeof vi.fn>).mock.calls;
    const resultsCall = emitCalls.find((call: [string, ...unknown[]]) => call[0] === ServerEvents.RESULTS_REVEAL);
    expect(resultsCall).toBeDefined();
    expect((resultsCall as [string, { outcomes: unknown[] }])[1].outcomes).toHaveLength(0);
  });

  it('should clear submissions after resolving', async () => {
    const submissions = new Map([['player-1', { actions: [] }]]);
    const playerNames = new Map([['player-1', 'Alice']]);
    const roomState = createMockRoomState(RoomStatus.STRATEGY, submissions, playerNames);

    await strategyPhase.resolve('room-1', roomState, mockIo, mockPrisma);

    expect(roomState.submissions.size).toBe(0);
  });

  it('should NOT auto-advance to next phase — that is handled by the game engine', async () => {
    const submissions = new Map();
    const playerNames = new Map();
    const roomState = createMockRoomState(RoomStatus.STRATEGY, submissions, playerNames);

    await strategyPhase.resolve('room-1', roomState, mockIo, mockPrisma);

    // Strategy phase should NOT auto-advance — the game engine timer handles this
    expect(roomState.room.status).toBe(RoomStatus.STRATEGY);
    const emitCalls = (mockIo.emit as ReturnType<typeof vi.fn>).mock.calls;
    const phaseCall = emitCalls.find((call: [string, ...unknown[]]) => call[0] === ServerEvents.PHASE_CHANGED);
    expect(phaseCall).toBeUndefined();
  });

  it('should use "Unknown" for missing player names', async () => {
    const submissions = new Map([['unknown-player', { actions: [] }]]);
    const playerNames = new Map(); // No player names
    const roomState = createMockRoomState(RoomStatus.STRATEGY, submissions, playerNames);

    await strategyPhase.resolve('room-1', roomState, mockIo, mockPrisma);

    const emitCalls = (mockIo.emit as ReturnType<typeof vi.fn>).mock.calls;
    const resultsCall = emitCalls.find((call: [string, ...unknown[]]) => call[0] === ServerEvents.RESULTS_REVEAL);
    expect((resultsCall as [string, { outcomes: { playerName: string }[] }])[1].outcomes[0].playerName).toBe('Unknown');
  });
});
