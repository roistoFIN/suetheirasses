import { PrismaClient } from '@prisma/client';
import { StrategyActionType, type GameAction } from '@suetheirasses/shared';

export const companyService = {
  async applyStrategy(
    playerId: string,
    actions: GameAction[],
    prisma: PrismaClient,
  ): Promise<{ cashDelta: number; changes: string[] }> {
    const company = await prisma.company.findUnique({
      where: { playerId },
    });

    if (!company) {
      throw new Error('Company not found');
    }

    let totalCashDelta = 0;
    const changes: string[] = [];

    for (const action of actions) {
      switch (action.type) {
        case StrategyActionType.INVEST: {
          const amount = action.amount || 10000;
          if (company.cash < amount) {
            changes.push(`Insufficient funds for investment of $${amount}`);
            continue;
          }
          totalCashDelta -= amount;
          changes.push(`Invested $${amount} in new ventures`);
          break;
        }
        case StrategyActionType.EXPAND: {
          const cost = action.amount || 15000;
          if (company.cash < cost) {
            changes.push(`Insufficient funds for expansion costing $${cost}`);
            continue;
          }
          totalCashDelta -= cost;
          changes.push(`Expanded operations for $${cost}`);
          break;
        }
        case StrategyActionType.LAYOFF: {
          const savings = action.amount || 5000;
          totalCashDelta += savings;
          changes.push(`Laid off employees, saving $${savings}/turn`);
          break;
        }
        case StrategyActionType.AD_CAMPAIGN: {
          const cost = action.amount || 8000;
          if (company.cash < cost) {
            changes.push(`Insufficient funds for ad campaign costing $${cost}`);
            continue;
          }
          totalCashDelta -= cost;
          changes.push(`Launched ad campaign for $${cost}`);
          break;
        }
        case StrategyActionType.RESEARCH_AND_DEVELOPMENT: {
          const cost = action.amount || 12000;
          if (company.cash < cost) {
            changes.push(`Insufficient funds for R&D costing $${cost}`);
            continue;
          }
          totalCashDelta -= cost;
          changes.push(`Invested in R&D for $${cost}`);
          break;
        }
        default:
          changes.push(`Unknown action: ${action.type}`);
      }
    }

    await prisma.company.update({
      where: { playerId },
      data: { cash: { increment: totalCashDelta } },
    });

    return { cashDelta: totalCashDelta, changes };
  },
};
