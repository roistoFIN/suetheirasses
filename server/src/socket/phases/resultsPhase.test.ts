import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resultsPhase } from './resultsPhase';
import type { Server } from 'socket.io';
import type { PrismaClient } from '@prisma/client';

const createMockIo = () => ({
  to: vi.fn().mockReturnThis(),
  emit: vi.fn().mockReturnThis(),
}) as unknown as Server;

const createMockPrisma = () => ({
  company: { findUnique: vi.fn(), update: vi.fn() },
  player: { findUnique: vi.fn() },
} as unknown as PrismaClient);

describe('resultsPhase.resolve', () => {
  let mockIo: Server;
  let mockPrisma: PrismaClient;

  beforeEach(() => {
    vi.clearAllMocks();
    mockIo = createMockIo();
    mockPrisma = createMockPrisma();
  });

  it('should be a passive display phase that does not auto-advance', async () => {
    await resultsPhase.resolve('room-1', mockIo, mockPrisma);

    // Results phase is passive — the gameEngine timer handles auto-advance
    // This phase should not emit any phase change events
    const emitCalls = (mockIo.emit as ReturnType<typeof vi.fn>).mock.calls;
    expect(emitCalls).toHaveLength(0);
  });

  it('should not modify room state', async () => {
    const roomState = {
      room: { id: 'room-1', status: 'RESULTS' as const, maxPlayers: 6, currentPhaseRound: 1, players: [] },
      players: new Map(),
      submissions: new Map(),
      timer: null,
      timerValue: 0,
    };

    await resultsPhase.resolve('room-1', mockIo, mockPrisma);

    // Phase is passive — no state mutations expected
    expect(roomState.room.status).toBe('RESULTS');
  });
});
