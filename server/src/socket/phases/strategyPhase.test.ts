import { describe, it, expect, vi, beforeEach } from 'vitest';
import { strategyPhase } from './strategyPhase';
import { RoomStatus, ServerEvents, type RoomState, type PhaseOutcome } from '@suetheirasses/shared';
import type { Server } from 'socket.io';
import type { PrismaClient } from '@prisma/client';

const createMockIo = () => ({
  to: vi.fn().mockReturnThis(),
  emit: vi.fn().mockReturnThis(),
}) as unknown as Server;

const createMockPrisma = () => ({
  company: {
    findUnique: vi.fn(),
    update: vi.fn(),
  },
  player: {
    findUnique: vi.fn(),
  },
} as unknown as PrismaClient);

const createMockRoomState = (
  status: RoomStatus,
  submissions: Map<string, any>,
  playerNames: Map<string, string>,
): RoomState => ({
  room: {
    id: 'room-1',
    status,
    maxPlayers: 6,
    currentPhaseRound: 1,
    players: [],
    createdAt: new Date(),
  } as any,
  players: new Map(
    Array.from(playerNames.entries()).map(([id, name]) => [
      id,
      { id, name, roomId: 'room-1', isReady: true, bankrupt: false } as any,
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
    expect(roomState.room.status).toBe(RoomStatus.RESULTS);
  });

  it('should include player names in outcomes', async () => {
    const submissions = new Map([
      ['player-1', { actions: [{ type: 'INVEST', amount: 10000 }] }],
    ]);

    const playerNames = new Map([['player-1', 'Alice']]);
    const roomState = createMockRoomState(RoomStatus.STRATEGY, submissions, playerNames);

    await strategyPhase.resolve('room-1', roomState, mockIo, mockPrisma);

    const emitCalls = (mockIo.emit as any).mock.calls;
    const resultsCall = emitCalls.find((call: any[]) => call[0] === ServerEvents.RESULTS_REVEAL);
    expect(resultsCall).toBeDefined();
    expect(resultsCall[1].outcomes[0].playerName).toBe('Alice');
  });

  it('should handle empty submissions', async () => {
    const submissions = new Map();
    const playerNames = new Map();
    const roomState = createMockRoomState(RoomStatus.STRATEGY, submissions, playerNames);

    await strategyPhase.resolve('room-1', roomState, mockIo, mockPrisma);

    expect(roomState.room.status).toBe(RoomStatus.RESULTS);
    const emitCalls = (mockIo.emit as any).mock.calls;
    const resultsCall = emitCalls.find((call: any[]) => call[0] === ServerEvents.RESULTS_REVEAL);
    expect(resultsCall).toBeDefined();
    expect(resultsCall[1].outcomes).toHaveLength(0);
  });

  it('should clear submissions after resolving', async () => {
    const submissions = new Map([['player-1', { actions: [] }]]);
    const playerNames = new Map([['player-1', 'Alice']]);
    const roomState = createMockRoomState(RoomStatus.STRATEGY, submissions, playerNames);

    await strategyPhase.resolve('room-1', roomState, mockIo, mockPrisma);

    expect(roomState.submissions.size).toBe(0);
  });

  it('should auto-advance to next phase after RESULTS timer', async () => {
    const submissions = new Map();
    const playerNames = new Map();
    const roomState = createMockRoomState(RoomStatus.STRATEGY, submissions, playerNames);

    await strategyPhase.resolve('room-1', roomState, mockIo, mockPrisma);

    // Fast-forward timer to trigger auto-advance
    vi.advanceTimersByTime(15000); // 15 seconds in ms

    expect(roomState.room.status).toBe(RoomStatus.LAWSUITS);
    expect(mockIo.emit).toHaveBeenCalledWith(
      ServerEvents.PHASE_CHANGED,
      expect.objectContaining({ phase: RoomStatus.LAWSUITS }),
    );
  });

  it('should broadcast phase change on auto-advance', async () => {
    const submissions = new Map();
    const playerNames = new Map();
    const roomState = createMockRoomState(RoomStatus.STRATEGY, submissions, playerNames);

    await strategyPhase.resolve('room-1', roomState, mockIo, mockPrisma);

    vi.advanceTimersByTime(15000);

    const emitCalls = (mockIo.emit as any).mock.calls;
    const phaseCall = emitCalls.find((call: any[]) => call[0] === ServerEvents.PHASE_CHANGED);
    expect(phaseCall).toBeDefined();
    expect(phaseCall[1].phase).toBe(RoomStatus.LAWSUITS);
    expect(phaseCall[1].timeLimit).toBe(90);
  });

  it('should use "Unknown" for missing player names', async () => {
    const submissions = new Map([['unknown-player', { actions: [] }]]);
    const playerNames = new Map(); // No player names
    const roomState = createMockRoomState(RoomStatus.STRATEGY, submissions, playerNames);

    await strategyPhase.resolve('room-1', roomState, mockIo, mockPrisma);

    const emitCalls = (mockIo.emit as any).mock.calls;
    const resultsCall = emitCalls.find((call: any[]) => call[0] === ServerEvents.RESULTS_REVEAL);
    expect(resultsCall[1].outcomes[0].playerName).toBe('Unknown');
  });
});
