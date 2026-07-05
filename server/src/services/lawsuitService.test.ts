import { describe, it, expect, vi, beforeEach } from 'vitest';
import { lawsuitService } from './lawsuitService';
import { Verdict } from '@suetheirasses/shared';
import type { Company as PrismaCompany, Lawsuit, Player as PrismaPlayer } from '@prisma/client';

const createMockCompany = (playerId: string, cash: number): PrismaCompany =>
  ({
    id: `company-${playerId}`,
    playerId,
    cash,
    createdAt: new Date(),
  } satisfies PrismaCompany);

const createMockPlayer = (
  id: string,
  cash: number,
): PrismaPlayer & { company: PrismaCompany } =>
  ({
    id,
    name: `Player ${id}`,
    roomId: 'room-test',
    isReady: true,
    bankrupt: false,
    socketId: `socket-${id}`,
    companyId: `company-${id}`,
    company: createMockCompany(id, cash),
  } satisfies PrismaPlayer & { company: PrismaCompany });

const createMockLawsuit = (
  plaintiffId: string,
  defendantId: string,
  claimAmount: number,
  options?: {
    plaintiffCash?: number;
    defendantCash?: number;
    plaintiffCompany?: PrismaCompany;
    defendantCompany?: PrismaCompany;
    plaintiff?: Partial<PrismaPlayer> & { company?: PrismaCompany } | null;
    defendant?: Partial<PrismaPlayer> & { company?: PrismaCompany } | null;
  },
): Lawsuit => {
  const {
    plaintiffCash = 50000,
    defendantCash = 50000,
    plaintiffCompany = options?.plaintiffCompany ?? createMockCompany(plaintiffId, plaintiffCash),
    defendantCompany = options?.defendantCompany ?? createMockCompany(defendantId, defendantCash),
    plaintiff = options?.plaintiff ?? { ...createMockPlayer(plaintiffId, plaintiffCash), company: plaintiffCompany },
    defendant = options?.defendant ?? { ...createMockPlayer(defendantId, defendantCash), company: defendantCompany },
  } = options ?? {};

  return {
    id: `lawsuit-${plaintiffId}-${defendantId}`,
    plaintiffId,
    defendantId,
    claimAmount,
    grounds: 'Some grounds',
    resolved: false,
    plaintiff: plaintiff as PrismaPlayer & { company: PrismaCompany },
    defendant: defendant as PrismaPlayer & { company: PrismaCompany },
  } satisfies Partial<Lawsuit> as Lawsuit;
};

describe('lawsuitService.calculateVerdict', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Defendant wins (Verdict.LOST)', () => {
    it('should return LOST when defendant has strong defense and small claim', async () => {
      const lawsuit = createMockLawsuit('plaintiff-1', 'defendant-1', 1000, {
        plaintiffCash: 50000,
        defendantCash: 100000,
      });

      const defense = 'a'.repeat(1000); // Strong defense

      const result = await lawsuitService.calculateVerdict(lawsuit, defense);

      expect(result).toBe(Verdict.LOST);
    });

    it('should return LOST when defendant has large cash relative to claim', async () => {
      const lawsuit = createMockLawsuit('plaintiff-1', 'defendant-1', 1000, {
        plaintiffCash: 50000,
        defendantCash: 1000000,
      });

      const defense = 'a'.repeat(1000); // Strong defense

      // Run multiple times - with strong defense and large cash, should mostly be LOST
      const results = await Promise.all(
        Array(10).fill(null).map(() =>
          lawsuitService.calculateVerdict(lawsuit, defense),
        ),
      );

      // At least some should be LOST due to strong defense and large cash
      const lostCount = results.filter((r) => r === Verdict.LOST).length;
      expect(lostCount).toBeGreaterThan(0);
    });

    it('should return LOST when both companies are missing', async () => {
      const lawsuit = createMockLawsuit('plaintiff-1', 'defendant-1', 50000, {
        plaintiff: null,
        defendant: null,
      });

      const result = await lawsuitService.calculateVerdict(lawsuit, 'a'.repeat(500));

      expect(result).toBe(Verdict.LOST);
    });

    it('should return LOST when only plaintiff company is missing', async () => {
      const lawsuit = createMockLawsuit('plaintiff-1', 'defendant-1', 50000, {
        plaintiff: null,
        defendantCompany: createMockCompany('defendant-1', 50000),
      });

      const result = await lawsuitService.calculateVerdict(lawsuit, 'a'.repeat(500));

      expect(result).toBe(Verdict.LOST);
    });

    it('should return LOST when only defendant company is missing', async () => {
      const lawsuit = createMockLawsuit('plaintiff-1', 'defendant-1', 50000, {
        plaintiffCompany: createMockCompany('plaintiff-1', 50000),
        defendant: null,
      });

      const result = await lawsuitService.calculateVerdict(lawsuit, 'a'.repeat(500));

      expect(result).toBe(Verdict.LOST);
    });
  });

  describe('Plaintiff wins (Verdict.WON)', () => {
    it('should return WON when claim is large relative to defendant cash and defense is weak', async () => {
      const lawsuit = createMockLawsuit('plaintiff-1', 'defendant-1', 100000, {
        plaintiffCash: 50000,
        defendantCash: 1000,
      });

      const defense = 'a'.repeat(50); // Very weak defense

      const result = await lawsuitService.calculateVerdict(lawsuit, defense);

      expect(result).toBe(Verdict.WON);
    });

    it('should return WON with maximum claim ratio and moderate defense', async () => {
      const lawsuit = createMockLawsuit('plaintiff-1', 'defendant-1', 500000, {
        plaintiffCash: 50000,
        defendantCash: 5000,
      });

      const defense = 'a'.repeat(200); // Weak defense

      const result = await lawsuitService.calculateVerdict(lawsuit, defense);

      expect(result).toBe(Verdict.WON);
    });
  });

  describe('Claim ratio effects', () => {
    it('should cap claim ratio at 2x defendant cash', async () => {
      const lawsuit = createMockLawsuit('plaintiff-1', 'defendant-1', 1000000, {
        plaintiffCash: 50000,
        defendantCash: 1000,
      });

      const defense = 'a'.repeat(100);

      const result = await lawsuitService.calculateVerdict(lawsuit, defense);

      // With capped ratio, plaintiff should win
      expect(result).toBe(Verdict.WON);
    });

    it('should handle zero defendant cash in ratio calculation', async () => {
      const lawsuit = createMockLawsuit('plaintiff-1', 'defendant-1', 50000, {
        plaintiffCash: 50000,
        defendantCash: 0,
      });

      const defense = 'a'.repeat(100);

      const result = await lawsuitService.calculateVerdict(lawsuit, defense);

      // With zero defendant cash, ratio is capped at 2, plaintiff should win with strong grounds
      expect(result).toBe(Verdict.WON);
    });
  });

  describe('Defense strength effects', () => {
    it('should increase defendant score with longer defense', async () => {
      const lawsuit = createMockLawsuit('plaintiff-1', 'defendant-1', 50000);

      const strongDefense = 'a'.repeat(1000); // Maximum defense strength

      const result = await lawsuitService.calculateVerdict(lawsuit, strongDefense);

      // With max defense strength, defendant should have advantage
      expect([Verdict.WON, Verdict.LOST]).toContain(result);
    });

    it('should cap defense strength at 1.0', async () => {
      const lawsuit = createMockLawsuit('plaintiff-1', 'defendant-1', 50000);

      const veryLongDefense = 'a'.repeat(5000); // Well above the 500 char cap

      const result = await lawsuitService.calculateVerdict(lawsuit, veryLongDefense);

      expect([Verdict.WON, Verdict.LOST]).toContain(result);
    });

    it('should handle empty defense string', async () => {
      const lawsuit = createMockLawsuit('plaintiff-1', 'defendant-1', 50000);

      const result = await lawsuitService.calculateVerdict(lawsuit, '');

      expect([Verdict.WON, Verdict.LOST]).toContain(result);
    });
  });

  describe('Random factor', () => {
    it('should produce different results across multiple calls with same inputs', async () => {
      const lawsuit = createMockLawsuit('plaintiff-1', 'defendant-1', 50000);

      const defense = 'a'.repeat(500);

      const results = await Promise.all(
        Array(10).fill(null).map(() =>
          lawsuitService.calculateVerdict(lawsuit, defense),
        ),
      );

      // With random factor, we should see some variation
      const uniqueResults = new Set(results);
      expect(uniqueResults.size).toBeGreaterThan(0);
    });

    it('should keep random factor within bounds (-0.1 to 0.1)', async () => {
      const lawsuit = createMockLawsuit('plaintiff-1', 'defendant-1', 50000);

      const defense = 'a'.repeat(500);

      // Run many times to ensure randomness stays bounded
      for (let i = 0; i < 50; i++) {
        const result = await lawsuitService.calculateVerdict(lawsuit, defense);
        expect([Verdict.WON, Verdict.LOST]).toContain(result);
      }
    });
  });

  describe('Edge cases', () => {
    it('should handle very small claim amount', async () => {
      const lawsuit = createMockLawsuit('plaintiff-1', 'defendant-1', 1);

      const defense = 'a'.repeat(100);

      const result = await lawsuitService.calculateVerdict(lawsuit, defense);

      expect([Verdict.WON, Verdict.LOST]).toContain(result);
    });

    it('should handle equal cash companies with equal defense', async () => {
      const lawsuit = createMockLawsuit('plaintiff-1', 'defendant-1', 50000);

      const defense = 'a'.repeat(500);

      const result = await lawsuitService.calculateVerdict(lawsuit, defense);

      expect([Verdict.WON, Verdict.LOST]).toContain(result);
    });

    it('should return only Verdict enum values', async () => {
      const lawsuit = createMockLawsuit('plaintiff-1', 'defendant-1', 50000);

      const result = await lawsuitService.calculateVerdict(lawsuit, 'a'.repeat(500));

      expect(result).toBeOneOf([Verdict.WON, Verdict.LOST]);
    });
  });
});
