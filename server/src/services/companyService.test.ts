import { describe, it, expect, vi, beforeEach } from 'vitest';
import { companyService } from './companyService';
import { StrategyActionType } from '@suetheirasses/shared';
import type { PrismaClient, Company as PrismaCompany } from '@prisma/client';

// Mock PrCompany
const createMockCompany = (cash: number): PrismaCompany => ({
  id: 'company-1',
  playerId: 'player-1',
  cash,
  createdAt: new Date(),
});

// Mock Prisma
const createMockPrisma = (company: PrismaCompany) => ({
  company: {
    findUnique: vi.fn().mockResolvedValue(company),
    update: vi.fn().mockImplementation(({ data }) => {
      if (data.cash?.increment !== undefined) {
        company.cash += data.cash.increment;
      }
      return Promise.resolve({ ...company, cash: company.cash });
    }),
  },
} as unknown as PrismaClient);

describe('companyService.applyStrategy', () => {
  let mockPrisma: PrismaClient;
  let mockCompany: PrismaCompany;

  beforeEach(() => {
    vi.clearAllMocks();
    mockCompany = createMockCompany(100000);
    mockPrisma = createMockPrisma(mockCompany);
  });

  describe('INVEST action', () => {
    it('should deduct investment amount from cash', async () => {
      const result = await companyService.applyStrategy(
        'player-1',
        [{ type: StrategyActionType.INVEST, amount: 10000 }],
        mockPrisma,
      );

      expect(result.cashDelta).toBe(-10000);
      expect(result.changes).toContain('Invested $10000 in new ventures');
      expect(mockPrisma.company.update).toHaveBeenCalled();
    });

    it('should use default amount of 10000 when not specified', async () => {
      const result = await companyService.applyStrategy(
        'player-1',
        [{ type: StrategyActionType.INVEST }],
        mockPrisma,
      );

      expect(result.cashDelta).toBe(-10000);
    });

    it('should not deduct when insufficient funds', async () => {
      mockCompany = createMockCompany(5000);
      mockPrisma = createMockPrisma(mockCompany);

      const result = await companyService.applyStrategy(
        'player-1',
        [{ type: StrategyActionType.INVEST, amount: 10000 }],
        mockPrisma,
      );

      expect(result.cashDelta).toBe(0);
      expect(result.changes).toContain('Insufficient funds for investment of $10000');
      // update is still called with 0 increment
      expect(mockPrisma.company.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ cash: { increment: 0 } }),
        }),
      );
    });
  });

  describe('EXPAND action', () => {
    it('should deduct expansion cost from cash', async () => {
      const result = await companyService.applyStrategy(
        'player-1',
        [{ type: StrategyActionType.EXPAND, amount: 15000 }],
        mockPrisma,
      );

      expect(result.cashDelta).toBe(-15000);
      expect(result.changes).toContain('Expanded operations for $15000');
    });

    it('should use default cost of 15000 when not specified', async () => {
      const result = await companyService.applyStrategy(
        'player-1',
        [{ type: StrategyActionType.EXPAND }],
        mockPrisma,
      );

      expect(result.cashDelta).toBe(-15000);
    });

    it('should not deduct when insufficient funds', async () => {
      mockCompany = createMockCompany(10000);
      mockPrisma = createMockPrisma(mockCompany);

      const result = await companyService.applyStrategy(
        'player-1',
        [{ type: StrategyActionType.EXPAND, amount: 20000 }],
        mockPrisma,
      );

      expect(result.cashDelta).toBe(0);
      expect(result.changes).toContain('Insufficient funds for expansion costing $20000');
    });
  });

  describe('LAYOFF action', () => {
    it('should add savings to cash', async () => {
      const result = await companyService.applyStrategy(
        'player-1',
        [{ type: StrategyActionType.LAYOFF, amount: 5000 }],
        mockPrisma,
      );

      expect(result.cashDelta).toBe(5000);
      expect(result.changes).toContain('Laid off employees, saving $5000/turn');
    });

    it('should use default savings of 5000 when not specified', async () => {
      const result = await companyService.applyStrategy(
        'player-1',
        [{ type: StrategyActionType.LAYOFF }],
        mockPrisma,
      );

      expect(result.cashDelta).toBe(5000);
    });

    it('should not require minimum cash for layoff', async () => {
      mockCompany = createMockCompany(0);
      mockPrisma = createMockPrisma(mockCompany);

      const result = await companyService.applyStrategy(
        'player-1',
        [{ type: StrategyActionType.LAYOFF, amount: 3000 }],
        mockPrisma,
      );

      expect(result.cashDelta).toBe(3000);
    });
  });

  describe('AD_CAMPAIGN action', () => {
    it('should deduct ad campaign cost from cash', async () => {
      const result = await companyService.applyStrategy(
        'player-1',
        [{ type: StrategyActionType.AD_CAMPAIGN, amount: 8000 }],
        mockPrisma,
      );

      expect(result.cashDelta).toBe(-8000);
      expect(result.changes).toContain('Launched ad campaign for $8000');
    });

    it('should use default cost of 8000 when not specified', async () => {
      const result = await companyService.applyStrategy(
        'player-1',
        [{ type: StrategyActionType.AD_CAMPAIGN }],
        mockPrisma,
      );

      expect(result.cashDelta).toBe(-8000);
    });

    it('should not deduct when insufficient funds', async () => {
      mockCompany = createMockCompany(5000);
      mockPrisma = createMockPrisma(mockCompany);

      const result = await companyService.applyStrategy(
        'player-1',
        [{ type: StrategyActionType.AD_CAMPAIGN, amount: 10000 }],
        mockPrisma,
      );

      expect(result.cashDelta).toBe(0);
      expect(result.changes).toContain('Insufficient funds for ad campaign costing $10000');
    });
  });

  describe('RESEARCH_AND_DEVELOPMENT action', () => {
    it('should deduct R&D cost from cash', async () => {
      const result = await companyService.applyStrategy(
        'player-1',
        [{ type: StrategyActionType.RESEARCH_AND_DEVELOPMENT, amount: 12000 }],
        mockPrisma,
      );

      expect(result.cashDelta).toBe(-12000);
      expect(result.changes).toContain('Invested in R&D for $12000');
    });

    it('should use default cost of 12000 when not specified', async () => {
      const result = await companyService.applyStrategy(
        'player-1',
        [{ type: StrategyActionType.RESEARCH_AND_DEVELOPMENT }],
        mockPrisma,
      );

      expect(result.cashDelta).toBe(-12000);
    });

    it('should not deduct when insufficient funds', async () => {
      mockCompany = createMockCompany(10000);
      mockPrisma = createMockPrisma(mockCompany);

      const result = await companyService.applyStrategy(
        'player-1',
        [{ type: StrategyActionType.RESEARCH_AND_DEVELOPMENT, amount: 20000 }],
        mockPrisma,
      );

      expect(result.cashDelta).toBe(0);
      expect(result.changes).toContain('Insufficient funds for R&D costing $20000');
    });
  });

  describe('Unknown action type', () => {
    it('should handle unknown action types gracefully', async () => {
      const result = await companyService.applyStrategy(
        'player-1',
        [{ type: 'UNKNOWN_ACTION' as any }],
        mockPrisma,
      );

      expect(result.cashDelta).toBe(0);
      expect(result.changes).toContain('Unknown action: UNKNOWN_ACTION');
      // update is still called with 0 increment
      expect(mockPrisma.company.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ cash: { increment: 0 } }),
        }),
      );
    });
  });

  describe('Multiple actions', () => {
    it('should apply multiple actions and sum cash deltas', async () => {
      const result = await companyService.applyStrategy(
        'player-1',
        [
          { type: StrategyActionType.INVEST, amount: 10000 },
          { type: StrategyActionType.LAYOFF, amount: 5000 },
          { type: StrategyActionType.AD_CAMPAIGN, amount: 8000 },
        ],
        mockPrisma,
      );

      expect(result.cashDelta).toBe(-13000); // -10000 + 5000 - 8000
      expect(result.changes).toHaveLength(3);
    });

    it('should skip actions with insufficient funds but continue processing', async () => {
      mockCompany = createMockCompany(15000);
      mockPrisma = createMockPrisma(mockCompany);

      const result = await companyService.applyStrategy(
        'player-1',
        [
          { type: StrategyActionType.INVEST, amount: 20000 },
          { type: StrategyActionType.LAYOFF, amount: 5000 },
        ],
        mockPrisma,
      );

      expect(result.cashDelta).toBe(5000);
      expect(result.changes).toHaveLength(2);
      expect(result.changes).toContain('Insufficient funds for investment of $20000');
      expect(result.changes).toContain('Laid off employees, saving $5000/turn');
    });
  });

  describe('Company not found', () => {
    it('should throw an error when company does not exist', async () => {
      const mockPrismaNoCompany = {
        company: {
          findUnique: vi.fn().mockResolvedValue(null),
          update: vi.fn(),
        },
      } as unknown as PrismaClient;

      await expect(
        companyService.applyStrategy('player-1', [{ type: StrategyActionType.INVEST }], mockPrismaNoCompany),
      ).rejects.toThrow('Company not found');
    });
  });

  describe('Cash update in database', () => {
    it('should update company cash in the database', async () => {
      const updateMock = vi.fn().mockResolvedValue({ ...mockCompany, cash: 90000 });
      mockPrisma.company.update = updateMock;

      await companyService.applyStrategy(
        'player-1',
        [{ type: StrategyActionType.INVEST, amount: 10000 }],
        mockPrisma,
      );

      expect(updateMock).toHaveBeenCalledWith({
        where: { playerId: 'player-1' },
        data: { cash: { increment: -10000 } },
      });
    });
  });
});
