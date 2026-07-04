import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resultsPhase } from './resultsPhase';
import { ServerEvents, RoomStatus, PHASE_TIMERS } from '@suetheirasses/shared';
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

  it('should broadcast phase change to next phase after RESULTS', async () => {
    await resultsPhase.resolve('room-1', mockIo, mockPrisma);

    expect(mockIo.to).toHaveBeenCalledWith('room-1');
    expect(mockIo.emit).toHaveBeenCalledWith(
      ServerEvents.PHASE_CHANGED,
      expect.objectContaining({
        phase: RoomStatus.LAWSUITS,
      }),
    );
  });

  it('should broadcast with correct timeLimit for LAWSUITS phase', async () => {
    await resultsPhase.resolve('room-1', mockIo, mockPrisma);

    const emitCalls = (mockIo.emit as any).mock.calls;
    const phaseCall = emitCalls.find((call: any[]) => call[0] === ServerEvents.PHASE_CHANGED);
    expect(phaseCall[1].timeLimit).toBe(PHASE_TIMERS[RoomStatus.LAWSUITS]);
  });

  it('should broadcast with round 1', async () => {
    await resultsPhase.resolve('room-1', mockIo, mockPrisma);

    const emitCalls = (mockIo.emit as any).mock.calls;
    const phaseCall = emitCalls.find((call: any[]) => call[0] === ServerEvents.PHASE_CHANGED);
    expect(phaseCall[1].round).toBe(1);
  });

  it('should emit to the correct room', async () => {
    await resultsPhase.resolve('room-1', mockIo, mockPrisma);

    expect(mockIo.to).toHaveBeenCalledWith('room-1');
  });

  it('should transition to LAWSUITS phase as the next phase', async () => {
    await resultsPhase.resolve('room-1', mockIo, mockPrisma);

    const emitCalls = (mockIo.emit as any).mock.calls;
    const phaseCall = emitCalls.find((call: any[]) => call[0] === ServerEvents.PHASE_CHANGED);
    expect(phaseCall[1].phase).toBe(RoomStatus.LAWSUITS);
  });

  it('should transition to the next phase in PHASE_ORDER', async () => {
    await resultsPhase.resolve('room-1', mockIo, mockPrisma);

    const emitCalls = (mockIo.emit as any).mock.calls;
    const phaseCall = emitCalls.find((call: any[]) => call[0] === ServerEvents.PHASE_CHANGED);
    // RESULTS is followed by LAWSUITS in PHASE_ORDER
    expect(phaseCall[1].phase).toBe(RoomStatus.LAWSUITS);
  });
});
