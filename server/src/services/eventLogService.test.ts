import { describe, it, expect, vi } from 'vitest';
import { logEvent, logEvents } from './eventLogService';

function makeMockPrisma(overrides: { create?: ReturnType<typeof vi.fn>; createMany?: ReturnType<typeof vi.fn> } = {}) {
  return {
    eventLog: {
      create: overrides.create ?? vi.fn().mockResolvedValue({}),
      createMany: overrides.createMany ?? vi.fn().mockResolvedValue({ count: 0 }),
    },
  } as any;
}

describe('logEvent', () => {
  it('writes the row with defaults for optional fields', async () => {
    const create = vi.fn().mockResolvedValue({});
    const prisma = makeMockPrisma({ create });

    await logEvent(prisma, { eventType: 'turn.resolved', roomId: 'room-1', payload: { round: 3 } });

    expect(create).toHaveBeenCalledWith({
      data: {
        eventType: 'turn.resolved',
        severity: 'info',
        roomId: 'room-1',
        playerId: null,
        payload: { round: 3 },
      },
    });
  });

  it('defaults roomId/playerId/payload to null/{} when omitted', async () => {
    const create = vi.fn().mockResolvedValue({});
    const prisma = makeMockPrisma({ create });

    await logEvent(prisma, { eventType: 'room.stale_cleanup' });

    expect(create).toHaveBeenCalledWith({
      data: { eventType: 'room.stale_cleanup', severity: 'info', roomId: null, playerId: null, payload: {} },
    });
  });

  it('passes an explicit severity through unchanged', async () => {
    const create = vi.fn().mockResolvedValue({});
    const prisma = makeMockPrisma({ create });

    await logEvent(prisma, { eventType: 'error.persistence', severity: 'error', payload: { context: 'x' } });

    expect(create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ severity: 'error' }) }));
  });

  // The whole point of this module (see its own doc comment): a DB failure while
  // logging telemetry must never propagate to the caller — a turn resolution or a
  // socket handler must complete normally even if EventLog itself is unreachable.
  it('never throws when the underlying write rejects', async () => {
    const create = vi.fn().mockRejectedValue(new Error('connection refused'));
    const prisma = makeMockPrisma({ create });
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(logEvent(prisma, { eventType: 'turn.resolved' })).resolves.toBeUndefined();
    expect(consoleSpy).toHaveBeenCalled();

    consoleSpy.mockRestore();
  });
});

describe('logEvents', () => {
  it('is a no-op for an empty array — no DB call at all', async () => {
    const createMany = vi.fn();
    const prisma = makeMockPrisma({ createMany });

    await logEvents(prisma, []);

    expect(createMany).not.toHaveBeenCalled();
  });

  it('writes every entry in one createMany call, with per-entry defaults applied', async () => {
    const createMany = vi.fn().mockResolvedValue({ count: 2 });
    const prisma = makeMockPrisma({ createMany });

    await logEvents(prisma, [
      { eventType: 'decision.deployed', roomId: 'room-1', playerId: 'p1', payload: { decisionName: 'Bot Attack' } },
      { eventType: 'decision.rejected', roomId: 'room-1', playerId: 'p2', payload: { decisionName: 'New Factory', reason: 'still maturing' } },
    ]);

    expect(createMany).toHaveBeenCalledWith({
      data: [
        { eventType: 'decision.deployed', severity: 'info', roomId: 'room-1', playerId: 'p1', payload: { decisionName: 'Bot Attack' } },
        { eventType: 'decision.rejected', severity: 'info', roomId: 'room-1', playerId: 'p2', payload: { decisionName: 'New Factory', reason: 'still maturing' } },
      ],
    });
  });

  it('never throws when the underlying batch write rejects', async () => {
    const createMany = vi.fn().mockRejectedValue(new Error('timeout'));
    const prisma = makeMockPrisma({ createMany });
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(logEvents(prisma, [{ eventType: 'turn.resolved' }])).resolves.toBeUndefined();
    expect(consoleSpy).toHaveBeenCalled();

    consoleSpy.mockRestore();
  });
});
