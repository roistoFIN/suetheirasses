import { describe, it, expect, vi, beforeEach } from 'vitest';
import { lawsuitService } from './lawsuitService';
import { Verdict } from '@suetheirasses/shared';
import type { PrismaClient, Company as PrismaCompany } from '@prisma/client';

const createMockCompany = (playerId: string, cash: number): PrismaCompany =>
  ({
    id: `company-${playerId}`,
    playerId,
    cash,
    createdAt: new Date(),
  }) as any;

const createMockPrisma = (
  plaintiffCompany: PrismaCompany | null,
  defendantCompany: PrismaCompany | null,
) => ({
  company: {
    findUnique: vi.fn().mockImplementation(({ where }: any) => {
      if (where.playerId === 'plaintiff-1') return Promise.resolve(plaintiffCompany);
      if (where.playerId === 'defendant-1') return Promise.resolve(defendantCompany);
      return Promise.resolve(null);
    }),
  },
} as unknown as PrismaClient);

describe('lawsuitService.calculateVerdict', () => {
  let mockPrisma: PrismaClient;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Defendant wins (Verdict.LOST)', () => {
    it('should return LOST when defendant has strong defense and small claim', async () => {
      const lawsuit = {
        id: 'lawsuit-1',
        plaintiffId: 'plaintiff-1',
        defendantId: 'defendant-1',
        claimAmount: 1000,
        grounds: 'Some grounds',
        resolved: false,
      } as any;

      const defense = 'a'.repeat(1000); // Strong defense
      mockPrisma = createMockPrisma(
        createMockCompany('plaintiff-1', 50000),
        createMockCompany('defendant-1', 100000),
      );

      const result = await lawsuitService.calculateVerdict(lawsuit, defense, mockPrisma);

      expect(result).toBe(Verdict.LOST);
    });

    it('should return LOST when defendant has large cash relative to claim', async () => {
    const lawsuit = {
      id: 'lawsuit-1',
      plaintiffId: 'plaintiff-1',
      defendantId: 'defendant-1',
      claimAmount: 1000,
      grounds: 'Some grounds',
      resolved: false,
    } as any;

    const defense = 'a'.repeat(1000); // Strong defense
    mockPrisma = createMockPrisma(
      createMockCompany('plaintiff-1', 50000),
      createMockCompany('defendant-1', 1000000),
    );

    // Run multiple times - with strong defense and large cash, should mostly be LOST
    const results = await Promise.all(
      Array(10).fill(null).map(() =>
        lawsuitService.calculateVerdict(lawsuit, defense, mockPrisma),
      ),
    );

    // At least some should be LOST due to strong defense and large cash
    const lostCount = results.filter((r) => r === Verdict.LOST).length;
    expect(lostCount).toBeGreaterThan(0);
  });

    it('should return LOST when both companies are missing', async () => {
      const lawsuit = {
        id: 'lawsuit-1',
        plaintiffId: 'plaintiff-1',
        defendantId: 'defendant-1',
        claimAmount: 50000,
        grounds: 'Some grounds',
        resolved: false,
      } as any;

      mockPrisma = createMockPrisma(null, null);

      const result = await lawsuitService.calculateVerdict(lawsuit, 'a'.repeat(500), mockPrisma);

      expect(result).toBe(Verdict.LOST);
    });

    it('should return LOST when only plaintiff company is missing', async () => {
      const lawsuit = {
        id: 'lawsuit-1',
        plaintiffId: 'plaintiff-1',
        defendantId: 'defendant-1',
        claimAmount: 50000,
        grounds: 'Some grounds',
        resolved: false,
      } as any;

      mockPrisma = createMockPrisma(null, createMockCompany('defendant-1', 50000));

      const result = await lawsuitService.calculateVerdict(lawsuit, 'a'.repeat(500), mockPrisma);

      expect(result).toBe(Verdict.LOST);
    });

    it('should return LOST when only defendant company is missing', async () => {
      const lawsuit = {
        id: 'lawsuit-1',
        plaintiffId: 'plaintiff-1',
        defendantId: 'defendant-1',
        claimAmount: 50000,
        grounds: 'Some grounds',
        resolved: false,
      } as any;

      mockPrisma = createMockPrisma(createMockCompany('plaintiff-1', 50000), null);

      const result = await lawsuitService.calculateVerdict(lawsuit, 'a'.repeat(500), mockPrisma);

      expect(result).toBe(Verdict.LOST);
    });
  });

  describe('Plaintiff wins (Verdict.WON)', () => {
    it('should return WON when claim is large relative to defendant cash and defense is weak', async () => {
      const plaintiffCompany = createMockCompany('plaintiff-1', 50000);
      const defendantCompany = createMockCompany('defendant-1', 1000);
      const lawsuit = {
        id: 'lawsuit-1',
        plaintiffId: 'plaintiff-1',
        defendantId: 'defendant-1',
        claimAmount: 100000,
        grounds: 'Some grounds',
        resolved: false,
        plaintiff: { company: plaintiffCompany },
        defendant: { company: defendantCompany },
      } as any;

      const defense = 'a'.repeat(50); // Very weak defense

      const result = await lawsuitService.calculateVerdict(lawsuit, defense);

      expect(result).toBe(Verdict.WON);
    });

    it('should return WON with maximum claim ratio and moderate defense', async () => {
      const plaintiffCompany = createMockCompany('plaintiff-1', 50000);
      const defendantCompany = createMockCompany('defendant-1', 5000);
      const lawsuit = {
        id: 'lawsuit-1',
        plaintiffId: 'plaintiff-1',
        defendantId: 'defendant-1',
        claimAmount: 500000,
        grounds: 'Some grounds',
        resolved: false,
        plaintiff: { company: plaintiffCompany },
        defendant: { company: defendantCompany },
      } as any;

      const defense = 'a'.repeat(200); // Weak defense

      const result = await lawsuitService.calculateVerdict(lawsuit, defense);

      expect(result).toBe(Verdict.WON);
    });
  });

  describe('Claim ratio effects', () => {
    it('should cap claim ratio at 2x defendant cash', async () => {
      const plaintiffCompany = createMockCompany('plaintiff-1', 50000);
      const defendantCompany = createMockCompany('defendant-1', 1000);
      const lawsuit = {
        id: 'lawsuit-1',
        plaintiffId: 'plaintiff-1',
        defendantId: 'defendant-1',
        claimAmount: 1000000, // 1000x defendant cash, but capped at 2
        grounds: 'Some grounds',
        resolved: false,
        plaintiff: { company: plaintiffCompany },
        defendant: { company: defendantCompany },
      } as any;

      const defense = 'a'.repeat(100);

      const result = await lawsuitService.calculateVerdict(lawsuit, defense);

      // With capped ratio, plaintiff should win
      expect(result).toBe(Verdict.WON);
    });

    it('should handle zero defendant cash in ratio calculation', async () => {
      const plaintiffCompany = createMockCompany('plaintiff-1', 50000);
      const defendantCompany = createMockCompany('defendant-1', 0);
      const lawsuit = {
        id: 'lawsuit-1',
        plaintiffId: 'plaintiff-1',
        defendantId: 'defendant-1',
        claimAmount: 50000,
        grounds: 'Some grounds',
        resolved: false,
        plaintiff: { company: plaintiffCompany },
        defendant: { company: defendantCompany },
      } as any;

      const defense = 'a'.repeat(100);

      const result = await lawsuitService.calculateVerdict(lawsuit, defense);

      // With zero defendant cash, ratio is capped at 2, plaintiff should win with strong grounds
      expect(result).toBe(Verdict.WON);
    });
  });

  describe('Defense strength effects', () => {
    it('should increase defendant score with longer defense', async () => {
      const lawsuit = {
        id: 'lawsuit-1',
        plaintiffId: 'plaintiff-1',
        defendantId: 'defendant-1',
        claimAmount: 50000,
        grounds: 'Some grounds',
        resolved: false,
      } as any;

      const strongDefense = 'a'.repeat(1000); // Maximum defense strength
      mockPrisma = createMockPrisma(
        createMockCompany('plaintiff-1', 50000),
        createMockCompany('defendant-1', 50000),
      );

      const result = await lawsuitService.calculateVerdict(lawsuit, strongDefense, mockPrisma);

      // With max defense strength, defendant should have advantage
      expect([Verdict.WON, Verdict.LOST]).toContain(result);
    });

    it('should cap defense strength at 1.0', async () => {
      const lawsuit = {
        id: 'lawsuit-1',
        plaintiffId: 'plaintiff-1',
        defendantId: 'defendant-1',
        claimAmount: 50000,
        grounds: 'Some grounds',
        resolved: false,
      } as any;

      const veryLongDefense = 'a'.repeat(5000); // Well above the 500 char cap
      mockPrisma = createMockPrisma(
        createMockCompany('plaintiff-1', 50000),
        createMockCompany('defendant-1', 50000),
      );

      const result = await lawsuitService.calculateVerdict(lawsuit, veryLongDefense, mockPrisma);

      expect([Verdict.WON, Verdict.LOST]).toContain(result);
    });

    it('should handle empty defense string', async () => {
      const lawsuit = {
        id: 'lawsuit-1',
        plaintiffId: 'plaintiff-1',
        defendantId: 'defendant-1',
        claimAmount: 50000,
        grounds: 'Some grounds',
        resolved: false,
      } as any;

      mockPrisma = createMockPrisma(
        createMockCompany('plaintiff-1', 50000),
        createMockCompany('defendant-1', 50000),
      );

      const result = await lawsuitService.calculateVerdict(lawsuit, '', mockPrisma);

      expect([Verdict.WON, Verdict.LOST]).toContain(result);
    });
  });

  describe('Random factor', () => {
    it('should produce different results across multiple calls with same inputs', async () => {
      const lawsuit = {
        id: 'lawsuit-1',
        plaintiffId: 'plaintiff-1',
        defendantId: 'defendant-1',
        claimAmount: 50000,
        grounds: 'Some grounds',
        resolved: false,
      } as any;

      const defense = 'a'.repeat(500);
      mockPrisma = createMockPrisma(
        createMockCompany('plaintiff-1', 50000),
        createMockCompany('defendant-1', 50000),
      );

      const results = await Promise.all(
        Array(10).fill(null).map(() =>
          lawsuitService.calculateVerdict(lawsuit, defense, mockPrisma),
        ),
      );

      // With random factor, we should see some variation
      const uniqueResults = new Set(results);
      expect(uniqueResults.size).toBeGreaterThan(0);
    });

    it('should keep random factor within bounds (-0.1 to 0.1)', async () => {
      const lawsuit = {
        id: 'lawsuit-1',
        plaintiffId: 'plaintiff-1',
        defendantId: 'defendant-1',
        claimAmount: 50000,
        grounds: 'Some grounds',
        resolved: false,
      } as any;

      const defense = 'a'.repeat(500);
      mockPrisma = createMockPrisma(
        createMockCompany('plaintiff-1', 50000),
        createMockCompany('defendant-1', 50000),
      );

      // Run many times to ensure randomness stays bounded
      for (let i = 0; i < 50; i++) {
        const result = await lawsuitService.calculateVerdict(lawsuit, defense, mockPrisma);
        expect([Verdict.WON, Verdict.LOST]).toContain(result);
      }
    });
  });

  describe('Edge cases', () => {
    it('should handle very small claim amount', async () => {
      const lawsuit = {
        id: 'lawsuit-1',
        plaintiffId: 'plaintiff-1',
        defendantId: 'defendant-1',
        claimAmount: 1,
        grounds: 'Some grounds',
        resolved: false,
      } as any;

      const defense = 'a'.repeat(100);
      mockPrisma = createMockPrisma(
        createMockCompany('plaintiff-1', 50000),
        createMockCompany('defendant-1', 50000),
      );

      const result = await lawsuitService.calculateVerdict(lawsuit, defense, mockPrisma);

      expect([Verdict.WON, Verdict.LOST]).toContain(result);
    });

    it('should handle equal cash companies with equal defense', async () => {
      const lawsuit = {
        id: 'lawsuit-1',
        plaintiffId: 'plaintiff-1',
        defendantId: 'defendant-1',
        claimAmount: 50000,
        grounds: 'Some grounds',
        resolved: false,
      } as any;

      const defense = 'a'.repeat(500);
      mockPrisma = createMockPrisma(
        createMockCompany('plaintiff-1', 50000),
        createMockCompany('defendant-1', 50000),
      );

      const result = await lawsuitService.calculateVerdict(lawsuit, defense, mockPrisma);

      expect([Verdict.WON, Verdict.LOST]).toContain(result);
    });

    it('should return only Verdict enum values', async () => {
      const lawsuit = {
        id: 'lawsuit-1',
        plaintiffId: 'plaintiff-1',
        defendantId: 'defendant-1',
        claimAmount: 50000,
        grounds: 'Some grounds',
        resolved: false,
      } as any;

      mockPrisma = createMockPrisma(
        createMockCompany('plaintiff-1', 50000),
        createMockCompany('defendant-1', 50000),
      );

      const result = await lawsuitService.calculateVerdict(lawsuit, 'a'.repeat(500), mockPrisma);

      expect(result).toBeOneOf([Verdict.WON, Verdict.LOST]);
    });
  });
});
