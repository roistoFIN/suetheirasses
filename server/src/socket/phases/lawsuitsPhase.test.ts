import { describe, it, expect, vi, beforeEach } from 'vitest';
import { lawsuitsPhase } from './lawsuitsPhase';
import { ServerEvents, RoomStatus, type LawsuitFilePayload } from '@suetheirasses/shared';
import type { Server } from 'socket.io';
import type { PrismaClient, Player as PrismaPlayer, Company as PrismaCompany } from '@prisma/client';

const createMockIo = (): Server => ({
  to: vi.fn().mockReturnThis(),
  emit: vi.fn().mockReturnThis(),
}) as unknown as Server;

const createMockPlayer = (
  id: string,
  name: string,
  roomId: string,
  bankrupt: boolean,
  company: PrismaCompany | null,
): PrismaPlayer & { company: PrismaCompany | null } =>
  ({
    id,
    name,
    roomId,
    isReady: true,
    bankrupt,
    socketId: `socket-${id}`,
    companyId: company?.id ?? null,
    company,
  } satisfies PrismaPlayer & { company: PrismaCompany | null });

const createMockCompany = (playerId: string, cash: number): PrismaCompany =>
  ({
    id: `company-${playerId}`,
    playerId,
    cash,
    createdAt: new Date(),
  } satisfies PrismaCompany);

const createMockPrisma = (
  players: (PrismaPlayer & { company: PrismaCompany | null })[],
): PrismaClient => {
  const mockCompanyUpdate = vi.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => {
    return Promise.resolve({});
  });

  const mockCompany = {
    findUnique: vi.fn().mockImplementation(({ where }: { where: { playerId: string } }) => {
      const player = players.find((p) => p.id === where.playerId);
      return Promise.resolve(player?.company ?? null);
    }),
    update: mockCompanyUpdate,
  };

  const mockLawsuitCreate = vi.fn().mockImplementation((data: Record<string, unknown>) => {
    return Promise.resolve({ ...data, id: 'lawsuit-1', resolved: false });
  });

  return {
    player: {
      findFirst: vi.fn().mockImplementation(({ where }: { where: Record<string, unknown> }) => {
        const player = players.find((p) => p.id === (where as { id: string }).id);
        if (player && (where as { roomId: string }).roomId && player.roomId !== (where as { roomId: string }).roomId) return Promise.resolve(null);
        if (player) return Promise.resolve({ ...player, company: player.company });
        return Promise.resolve(null);
      }),
    },
    company: mockCompany,
    lawsuit: {
      create: mockLawsuitCreate,
    },
    $transaction: vi.fn().mockImplementation(async (fn: (tx: { lawsuit: { create: typeof mockLawsuitCreate }, company: typeof mockCompany }) => Promise<unknown>) => {
      // Pass the SAME mock functions so assertions on top-level mocks work
      return fn({
        lawsuit: {
          create: mockLawsuitCreate,
        },
        company: mockCompany,
      });
    }),
    room: {
      update: vi.fn().mockResolvedValue({}),
    },
  } as unknown as PrismaClient;
};

describe('lawsuitsPhase.fileLawsuit', () => {
  let mockIo: Server;
  let mockPrisma: PrismaClient;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should file a lawsuit successfully', async () => {
    const plaintiffCompany = createMockCompany('p1', 50000);
    const defendantCompany = createMockCompany('p2', 50000);
    const plaintiff = createMockPlayer('p1', 'Alice', 'room-1', false, plaintiffCompany);
    const defendant = createMockPlayer('p2', 'Bob', 'room-1', false, defendantCompany);

    mockPrisma = createMockPrisma([plaintiff, defendant]);
    mockIo = createMockIo();

    const payload: LawsuitFilePayload = {
      defendantId: 'p2',
      claimAmount: 50000,
      grounds: 'Breach of contract and negligence in business dealings',
    };

    await lawsuitsPhase.fileLawsuit('p1', 'room-1', payload, mockIo, mockPrisma);

    expect(mockPrisma.lawsuit.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          plaintiffId: 'p1',
          defendantId: 'p2',
          claimAmount: 50000,
        }),
      }),
    );
    expect(mockPrisma.company.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { playerId: 'p1' },
        data: expect.objectContaining({ cash: { decrement: 1000 } }),
      }),
    );
    expect(mockIo.emit).toHaveBeenCalledWith(
      ServerEvents.BOARD_UPDATE,
      expect.objectContaining({
        message: expect.stringContaining('filed a lawsuit'),
      }),
    );
  });

  it('should reject suing yourself', async () => {
    const plaintiffCompany = createMockCompany('p1', 50000);
    const plaintiff = createMockPlayer('p1', 'Alice', 'room-1', false, plaintiffCompany);

    mockPrisma = createMockPrisma([plaintiff]);
    mockIo = createMockIo();

    const payload: LawsuitFilePayload = {
      defendantId: 'p1',
      claimAmount: 50000,
      grounds: 'Self-inflicted damages',
    };

    await expect(
      lawsuitsPhase.fileLawsuit('p1', 'room-1', payload, mockIo, mockPrisma),
    ).rejects.toThrow(/Cannot sue yourself|Plaintiff or defendant not found in room/);
  });

  it('should reject suing a bankrupt player', async () => {
    const plaintiffCompany = createMockCompany('p1', 50000);
    const defendantCompany = createMockCompany('p2', 50000);
    const plaintiff = createMockPlayer('p1', 'Alice', 'room-1', false, plaintiffCompany);
    const defendant = createMockPlayer('p2', 'Bob', 'room-1', true, defendantCompany);

    mockPrisma = createMockPrisma([plaintiff, defendant]);
    mockIo = createMockIo();

    const payload: LawsuitFilePayload = {
      defendantId: 'p2',
      claimAmount: 50000,
      grounds: 'Breach of contract',
    };

    await expect(
      lawsuitsPhase.fileLawsuit('p1', 'room-1', payload, mockIo, mockPrisma),
    ).rejects.toThrow('Cannot sue a bankrupt player');
  });

  it('should reject suing a bankrupt plaintiff', async () => {
    const plaintiffCompany = createMockCompany('p1', 50000);
    const defendantCompany = createMockCompany('p2', 50000);
    const plaintiff = createMockPlayer('p1', 'Alice', 'room-1', true, plaintiffCompany);
    const defendant = createMockPlayer('p2', 'Bob', 'room-1', false, defendantCompany);

    mockPrisma = createMockPrisma([plaintiff, defendant]);
    mockIo = createMockIo();

    const payload: LawsuitFilePayload = {
      defendantId: 'p2',
      claimAmount: 50000,
      grounds: 'Breach of contract',
    };

    await expect(
      lawsuitsPhase.fileLawsuit('p1', 'room-1', payload, mockIo, mockPrisma),
    ).rejects.toThrow('Cannot sue a bankrupt player');
  });

  it('should reject when plaintiff has insufficient funds for filing fee', async () => {
    const plaintiffCompany = createMockCompany('p1', 500);
    const defendantCompany = createMockCompany('p2', 50000);
    const plaintiff = createMockPlayer('p1', 'Alice', 'room-1', false, plaintiffCompany);
    const defendant = createMockPlayer('p2', 'Bob', 'room-1', false, defendantCompany);

    mockPrisma = createMockPrisma([plaintiff, defendant]);
    mockIo = createMockIo();

    const payload: LawsuitFilePayload = {
      defendantId: 'p2',
      claimAmount: 50000,
      grounds: 'Breach of contract',
    };

    await expect(
      lawsuitsPhase.fileLawsuit('p1', 'room-1', payload, mockIo, mockPrisma),
    ).rejects.toThrow('Insufficient funds to file lawsuit (requires $1,000 filing fee)');
  });

  it('should reject when plaintiff has no company', async () => {
    const plaintiff = createMockPlayer('p1', 'Alice', 'room-1', false, null);
    const defendantCompany = createMockCompany('p2', 50000);
    const defendant = createMockPlayer('p2', 'Bob', 'room-1', false, defendantCompany);

    mockPrisma = createMockPrisma([plaintiff, defendant]);
    mockIo = createMockIo();

    const payload: LawsuitFilePayload = {
      defendantId: 'p2',
      claimAmount: 50000,
      grounds: 'Breach of contract',
    };

    await expect(
      lawsuitsPhase.fileLawsuit('p1', 'room-1', payload, mockIo, mockPrisma),
    ).rejects.toThrow('Insufficient funds to file lawsuit (requires $1,000 filing fee)');
  });

  it('should reject when plaintiff or defendant not found in room', async () => {
    const plaintiff = createMockPlayer('p1', 'Alice', 'room-1', false, createMockCompany('p1', 50000));

    mockPrisma = createMockPrisma([plaintiff]);
    mockIo = createMockIo();

    const payload: LawsuitFilePayload = {
      defendantId: 'nonexistent',
      claimAmount: 50000,
      grounds: 'Breach of contract',
    };

    await expect(
      lawsuitsPhase.fileLawsuit('p1', 'room-1', payload, mockIo, mockPrisma),
    ).rejects.toThrow('Plaintiff or defendant not found in room');
  });

  it('should deduct exactly $1,000 filing fee', async () => {
    const plaintiffCompany = createMockCompany('p1', 50000);
    const defendantCompany = createMockCompany('p2', 50000);
    const plaintiff = createMockPlayer('p1', 'Alice', 'room-1', false, plaintiffCompany);
    const defendant = createMockPlayer('p2', 'Bob', 'room-1', false, defendantCompany);

    mockPrisma = createMockPrisma([plaintiff, defendant]);
    mockIo = createMockIo();

    const payload: LawsuitFilePayload = {
      defendantId: 'p2',
      claimAmount: 50000,
      grounds: 'Breach of contract and negligence',
    };

    await lawsuitsPhase.fileLawsuit('p1', 'room-1', payload, mockIo, mockPrisma);

    expect(mockPrisma.company.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          cash: { decrement: 1000 },
        }),
      }),
    );
  });
});
