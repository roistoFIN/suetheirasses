import { PrismaClient } from '@prisma/client';
import { Verdict } from '@suetheirasses/shared';

export const lawsuitService = {
  async calculateVerdict(
    lawsuit: any,
    defense: string,
  ): Promise<Verdict> {
    // Companies are now pre-loaded via include in resolutionPhase
    const plaintiffCompany = lawsuit.plaintiff?.company;
    const defendantCompany = lawsuit.defendant?.company;

    if (!plaintiffCompany || !defendantCompany) {
      return Verdict.LOST;
    }

    const claimRatio = Math.min(Number(lawsuit.claimAmount) / Math.max(Number(defendantCompany.cash), 1), 2);
    const defenseStrength = Math.min(defense.length / 500, 1);
    const plaintiffRandom = Math.random() * 0.2 - 0.1;
    const defendantRandom = Math.random() * 0.2 - 0.1;

    const plaintiffScore = 0.4 + claimRatio * 0.3 + plaintiffRandom;
    const defendantScore = 0.4 + defenseStrength * 0.3 - claimRatio * 0.15 + defendantRandom;

    if (defendantScore >= plaintiffScore) {
      return Verdict.LOST;
    }

    return Verdict.WON;
  },
};
