import { PrismaClient } from '@prisma/client';
import { Verdict } from '@suetheirasses/shared';

export const lawsuitService = {
  async calculateVerdict(
    lawsuit: any,
    defense: string,
    prisma: PrismaClient,
  ): Promise<Verdict> {
    const plaintiffCompany = await prisma.company.findUnique({
      where: { playerId: lawsuit.plaintiffId },
    });

    const defendantCompany = await prisma.company.findUnique({
      where: { playerId: lawsuit.defendantId },
    });

    if (!plaintiffCompany || !defendantCompany) {
      return Verdict.LOST;
    }

    // Calculate verdict based on:
    // 1. Claim amount vs defendant cash (larger claims harder to defend)
    // 2. Defense strength (length of defense text, capped at 1000 chars)
    // 3. Random factor for unpredictability

    const claimRatio = Math.min(lawsuit.claimAmount / Math.max(defendantCompany.cash, 1), 2);
    const defenseStrength = Math.min(defense.length / 500, 1);
    const randomFactor = Math.random() * 0.2 - 0.1; // -0.1 to +0.1

    // Plaintiff score: higher with larger claims
    const plaintiffScore = 0.4 + claimRatio * 0.3 + randomFactor;
    // Defendant score: higher with stronger defense, lower with large claims
    const defendantScore = 0.4 + defenseStrength * 0.3 - claimRatio * 0.15 + randomFactor;

    if (defendantScore >= plaintiffScore) {
      return Verdict.LOST; // Defendant wins
    }

    return Verdict.WON; // Plaintiff wins
  },
};
