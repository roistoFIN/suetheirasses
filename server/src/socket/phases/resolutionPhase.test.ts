import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolutionPhase } from './resolutionPhase';
import { ServerEvents, Verdict, RoomStatus, PHASE_TIMERS, type LawsuitRespondPayload } from '@suetheirasses/shared';
import type { Server } from 'socket.io';
import type { PrismaClient, Player as PrismaPlayer, Company as PrismaCompany } from '@prisma/client';

const createMockIo = () => ({
  to: vi.fn().mockReturnThis(),
  emit: vi.fn().mockReturnThis(),
}) as unknown as Server;

const createMockPlayer = (
  id: string,
  name: string,
  roomId: string,
  bankrupt: boolean,
): PrismaPlayer =>
  ({
    id,
    name,
    roomId,
    isReady: true,
    bankrupt,
    socketId: `socket-${id}`,
    companyId: `company-${id}`,
  } satisfies PrismaPlayer);

const createMockCompany = (playerId: string, cash: number): PrismaCompany =>
  ({
    id: `company-${playerId}`,
    playerId,
    cash,
    createdAt: new Date(),
  } satisfies PrismaCompany);

const createMockPrisma = (
  lawsuit: Record<string, unknown>,
  plaintiff: PrismaPlayer,
  defendant: PrismaPlayer,
  plaintiffCompany: PrismaCompany,
  defendantCompany: PrismaCompany,
): PrismaClient => {
  const mockCompanyUpdate = vi.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => {
    if ((data.cash as Record<string, unknown>)?.decrement) {
      defendantCompany.cash -= (data.cash as { decrement: number }).decrement;
      plaintiffCompany.cash += (data.cash as { decrement: number }).decrement;
    }
    if ((data.cash as Record<string, unknown>)?.increment) {
      plaintiffCompany.cash += (data.cash as { increment: number }).increment;
    }
    return Promise.resolve({});
  });

  const mockCompany = {
    findUnique: vi.fn().mockImplementation(({ where }: { where: { playerId: string } }) => {
      if (where.playerId === 'p1') return Promise.resolve(plaintiffCompany);
      if (where.playerId === 'p2') return Promise.resolve(defendantCompany);
      return Promise.resolve(null);
    }),
    update: mockCompanyUpdate,
  };

  const mockLawsuitUpdate = vi.fn().mockResolvedValue({ ...lawsuit });

  return {
    lawsuit: {
      findUnique: vi.fn().mockResolvedValue({
        ...lawsuit,
        plaintiff: { ...plaintiff, company: plaintiffCompany },
        defendant: { ...defendant, company: defendantCompany },
      }),
      update: mockLawsuitUpdate,
    },
    company: mockCompany,
    room: {
      update: vi.fn().mockResolvedValue({}),
    },
    player: {
      findUnique: vi.fn(),
      findMany: vi.fn().mockResolvedValue([
        { ...plaintiff, company: plaintiffCompany },
        { ...defendant, company: defendantCompany },
      ]),
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    $transaction: vi.fn().mockImplementation(async (fn: (tx: { lawsuit: { update: typeof mockLawsuitUpdate }, company: typeof mockCompany }) => Promise<unknown>) => {
      return fn({
        lawsuit: {
          update: mockLawsuitUpdate,
        },
        company: mockCompany,
      });
    }),
  } as unknown as PrismaClient;
};

describe('resolutionPhase.respondToLawsuit', () => {
  let mockIo: Server;
  let mockPrisma: PrismaClient;

  const baseLawsuit = {
    id: 'lawsuit-1',
    plaintiffId: 'p1',
    defendantId: 'p2',
    claimAmount: 50000,
    grounds: 'Breach of contract',
    resolved: false,
    verdict: null,
    resolution: null,
  };

  const plaintiff = createMockPlayer('p1', 'Alice', 'room-1', false);
  const defendant = createMockPlayer('p2', 'Bob', 'room-1', false);
  const plaintiffCompany = createMockCompany('p1', 100000);
  const defendantCompany = createMockCompany('p2', 100000);

  beforeEach(() => {
    vi.clearAllMocks();
    plaintiffCompany.cash = 100000;
    defendantCompany.cash = 100000;
    mockPrisma = createMockPrisma(
      baseLawsuit,
      plaintiff,
      defendant,
      plaintiffCompany,
      defendantCompany,
    );
    mockIo = createMockIo();
  });

  it('should respond to a lawsuit successfully', async () => {
    const payload: LawsuitRespondPayload = {
      lawsuitId: 'lawsuit-1',
      defense: 'This is a strong defense with good arguments and evidence',
    };

    await resolutionPhase.respondToLawsuit('p2', 'room-1', payload, mockIo, mockPrisma);

    expect(mockPrisma.lawsuit.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'lawsuit-1' },
        data: expect.objectContaining({
          resolved: true,
        }),
      }),
    );
  });

  it('should reject when lawsuit is not found', async () => {
    mockPrisma = ({
      lawsuit: {
        findUnique: vi.fn().mockResolvedValue(null),
        update: vi.fn(),
      },
      company: { update: vi.fn() },
      room: { update: vi.fn() },
      $transaction: vi.fn(),
    } as unknown) as PrismaClient;

    const payload: LawsuitRespondPayload = {
      lawsuitId: 'nonexistent',
      defense: 'Defense',
    };

    await expect(
      resolutionPhase.respondToLawsuit('p2', 'room-1', payload, mockIo, mockPrisma),
    ).rejects.toThrow('Lawsuit not found');
  });

  it('should reject when defendant is not authorized', async () => {
    const payload: LawsuitRespondPayload = {
      lawsuitId: 'lawsuit-1',
      defense: 'Defense',
    };

    await expect(
      resolutionPhase.respondToLawsuit('p3', 'room-1', payload, mockIo, mockPrisma),
    ).rejects.toThrow('Not authorized to respond to this lawsuit');
  });

  it('should reject when lawsuit is already resolved', async () => {
    const resolvedLawsuit = { ...baseLawsuit, resolved: true };
    mockPrisma = createMockPrisma(
      resolvedLawsuit,
      plaintiff,
      defendant,
      plaintiffCompany,
      defendantCompany,
    );

    const payload: LawsuitRespondPayload = {
      lawsuitId: 'lawsuit-1',
      defense: 'Defense',
    };

    await expect(
      resolutionPhase.respondToLawsuit('p2', 'room-1', payload, mockIo, mockPrisma),
    ).rejects.toThrow('This lawsuit has already been resolved');
  });

  it('should decrement defendant cash and increment plaintiff cash on WON verdict', async () => {
    const payload: LawsuitRespondPayload = {
      lawsuitId: 'lawsuit-1',
      defense: 'a'.repeat(100),
    };

    await resolutionPhase.respondToLawsuit('p2', 'room-1', payload, mockIo, mockPrisma);

    const calls = (mockPrisma.company.update as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0][0]).toEqual(expect.objectContaining({
      where: { playerId: 'p2' },
      data: expect.objectContaining({ cash: { decrement: 50000 } }),
    }));
    expect(calls[1][0]).toEqual(expect.objectContaining({
      where: { playerId: 'p1' },
      data: expect.objectContaining({ cash: { increment: 50000 } }),
    }));
  });

  it('should not change cash on LOST verdict', async () => {
    // Mock Math.random to ensure deterministic LOST verdict
    // claimRatio = 50000/100000 = 0.5, defenseStrength = 1.0 (5000 chars)
    // With both random = 0: plaintiffScore = 0.4 + 0.5*0.3 + 0 = 0.55
    // defendantScore = 0.4 + 1.0*0.3 - 0.5*0.15 + 0 = 0.625
    // defendantScore >= plaintiffScore => LOST (not SETTLED because claimRatio 0.5 < 0.7)
    const randomStub = vi.spyOn(global.Math, 'random').mockReturnValue(0);

    const payload: LawsuitRespondPayload = {
      lawsuitId: 'lawsuit-1',
      defense: 'a'.repeat(5000), // Very strong defense to ensure LOST
    };

    await resolutionPhase.respondToLawsuit('p2', 'room-1', payload, mockIo, mockPrisma);

    randomStub.mockRestore();

    const companyUpdates = (mockPrisma.company.update as ReturnType<typeof vi.fn>).mock.calls;
    const cashUpdates = companyUpdates.filter(
      (call: [{ data?: { cash?: { decrement?: number; increment?: number } } }, ...unknown[]]) => call[0]?.data?.cash?.decrement || call[0]?.data?.cash?.increment,
    );
    expect(cashUpdates.length).toBe(0);
  });

  it('should decrement defendant cash and increment plaintiff cash on SETTLED verdict', async () => {
    // Mock Math.random to produce SETTLED:
    // claimRatio = 50000/100000 = 0.5, defenseStrength = 1.0 (1000 chars)
    // Need defendantScore >= plaintiffScore AND claimRatio > 0.7
    // With claimRatio=0.5: plaintiffScore = 0.4 + 0.15 + pr = 0.55 + pr
    // defendantScore = 0.4 + 0.3 - 0.075 + dr = 0.625 + dr
    // With pr=-0.1, dr=0: plaintiff=0.45, defendant=0.625 => defendant >= plaintiff
    // But claimRatio 0.5 < 0.7, so this gives LOST, not SETTLED
    // Need higher claimRatio: use claimAmount=80000, defendantCash=50000 => claimRatio=1.6
    // plaintiffScore = 0.4 + 0.48 + pr = 0.88 + pr
    // defendantScore = 0.4 + 0.3 - 0.24 + dr = 0.46 + dr
    // Need 0.46 + dr >= 0.88 + pr => dr - pr >= 0.42, but max dr-pr = 0.2
    // This CANNOT produce SETTLED with current formula!
    // Use claimAmount=40000, defendantCash=50000 => claimRatio=0.8
    // plaintiffScore = 0.4 + 0.24 + pr = 0.64 + pr
    // defendantScore = 0.4 + 0.3 - 0.12 + dr = 0.58 + dr
    // With pr=-0.1, dr=0.1: plaintiff=0.54, defendant=0.68 => SETTLED!
    let randomCallCount = 0;
    const randomStub = vi.spyOn(global.Math, 'random').mockImplementation(() => {
      randomCallCount++;
      return randomCallCount === 1 ? 0.0 : 1.0; // plaintiff: -0.1, defendant: 0.1
    });

    // Override the mock lawsuit with higher claimRatio
    const settlementLawsuit = {
      ...baseLawsuit,
      claimAmount: 40000,
    };
    const settlementDefendantCompany = createMockCompany('p2', 50000);
    mockPrisma = createMockPrisma(
      settlementLawsuit,
      plaintiff,
      defendant,
      plaintiffCompany,
      settlementDefendantCompany,
    );

    const payload: LawsuitRespondPayload = {
      lawsuitId: 'lawsuit-1',
      defense: 'a'.repeat(1000), // Strong defense
    };

    await resolutionPhase.respondToLawsuit('p2', 'room-1', payload, mockIo, mockPrisma);

    randomStub.mockRestore();

    const calls = (mockPrisma.company.update as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(2);

    // Defendant should pay 50% of claim (20000)
    expect(calls[0][0]).toEqual(expect.objectContaining({
      where: { playerId: 'p2' },
      data: expect.objectContaining({ cash: { decrement: 20000 } }),
    }));
    expect(calls[1][0]).toEqual(expect.objectContaining({
      where: { playerId: 'p1' },
      data: expect.objectContaining({ cash: { increment: 20000 } }),
    }));
  });

  it('should notify all players about the verdict', async () => {
    const payload: LawsuitRespondPayload = {
      lawsuitId: 'lawsuit-1',
      defense: 'a'.repeat(500),
    };

    await resolutionPhase.respondToLawsuit('p2', 'room-1', payload, mockIo, mockPrisma);

    expect(mockIo.emit).toHaveBeenCalledWith(
      ServerEvents.BOARD_UPDATE,
      expect.objectContaining({
        message: expect.stringContaining('vs'),
      }),
    );
  });

  it('should loop back to STRATEGY phase when game is not over', async () => {
    const payload: LawsuitRespondPayload = {
      lawsuitId: 'lawsuit-1',
      defense: 'a'.repeat(1000),
    };

    await resolutionPhase.respondToLawsuit('p2', 'room-1', payload, mockIo, mockPrisma);

    expect(mockPrisma.room.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: RoomStatus.STRATEGY,
        }),
      }),
    );
    expect(mockIo.emit).toHaveBeenCalledWith(
      ServerEvents.PHASE_CHANGED,
      expect.objectContaining({
        phase: RoomStatus.STRATEGY,
        timeLimit: PHASE_TIMERS[RoomStatus.STRATEGY],
      }),
    );
  });

  it('should increment the round when looping back to STRATEGY', async () => {
    const payload: LawsuitRespondPayload = {
      lawsuitId: 'lawsuit-1',
      defense: 'a'.repeat(1000),
    };

    await resolutionPhase.respondToLawsuit('p2', 'room-1', payload, mockIo, mockPrisma);

    expect(mockPrisma.room.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          currentPhaseRound: { increment: 1 },
        }),
      }),
    );
  });
});

describe('resolutionPhase.generateResolution', () => {
  it('should generate WON resolution message', () => {
    const lawsuit = {
      plaintiff: { name: 'Alice' },
      defendant: { name: 'Bob' },
      claimAmount: 50000,
    };
    const payload = {} as LawsuitRespondPayload;

    const result = resolutionPhase.generateResolution(
      lawsuit as unknown as Parameters<typeof resolutionPhase.generateResolution>[0],
      Verdict.WON,
      payload,
    );

    expect(result).toContain('Court rules in favor of Alice');
    expect(result).toContain('$50000');
  });

  it('should generate LOST resolution message', () => {
    const lawsuit = {
      plaintiff: { name: 'Alice' },
      defendant: { name: 'Bob' },
    };
    const payload = {} as LawsuitRespondPayload;

    const result = resolutionPhase.generateResolution(
      lawsuit as unknown as Parameters<typeof resolutionPhase.generateResolution>[0],
      Verdict.LOST,
      payload,
    );

    expect(result).toContain('Court dismisses the case');
    expect(result).toContain("Alice's lawsuit is denied");
  });

  it('should generate SETTLED resolution message', () => {
    const lawsuit = {
      plaintiff: { name: 'Alice' },
      defendant: { name: 'Bob' },
    };
    const payload = { settlementOffer: 25000 } as LawsuitRespondPayload;

    const result = resolutionPhase.generateResolution(
      lawsuit as unknown as Parameters<typeof resolutionPhase.generateResolution>[0],
      Verdict.SETTLED,
      payload,
    );

    expect(result).toContain('settlement');
    expect(result).toContain('$25000');
  });
});
