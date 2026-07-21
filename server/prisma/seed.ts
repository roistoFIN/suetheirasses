import { PrismaClient } from '@prisma/client';
import type { DecisionDefinition, GameConfig } from '@suetheirasses/shared';
import gameEngineData from '../src/data/game_engine.json' with { type: 'json' };
import gameConfigData from '../src/data/game_config.json' with { type: 'json' };
import { DEFAULT_FORMULA_SEEDS } from '../src/engine/defaultFormulas.js';

/**
 * Seeds the `decisions`, `game_config`, and `formulas` tables from the versioned
 * JSON files / the hand-authored FORMULA_SEEDS above — the one-time (and
 * idempotent, safe-to-rerun) migration path from the old load-JSON-at-startup
 * model to the DB-backed one GameEngine.loadGameData() now reads from. Also the
 * disaster-recovery reset path: `npx prisma migrate reset && npm run db:seed`
 * restores the default decision library, config, and formulas exactly.
 */
async function main(): Promise<void> {
  const prisma = new PrismaClient();

  try {
    const decisions = gameEngineData as unknown as DecisionDefinition[];
    for (const decision of decisions) {
      await prisma.decision.upsert({
        where: { name: decision.decision },
        create: { name: decision.decision, data: decision as any },
        update: { data: decision as any },
      });
    }
    console.log(`Seeded ${decisions.length} decisions.`);

    const config = gameConfigData as unknown as GameConfig;
    await prisma.gameConfigRow.upsert({
      where: { id: 1 },
      create: {
        id: 1,
        gameSettings: config.gameSettings as any,
        playerStartingValues: config.playerStartingValues as any,
        adminVariables: config.adminVariables as any,
      },
      update: {
        gameSettings: config.gameSettings as any,
        playerStartingValues: config.playerStartingValues as any,
        adminVariables: config.adminVariables as any,
      },
    });
    console.log('Seeded game config.');

    for (const formula of DEFAULT_FORMULA_SEEDS) {
      await prisma.formula.upsert({
        where: { key: formula.key },
        create: formula,
        update: formula,
      });
    }
    console.log(`Seeded ${DEFAULT_FORMULA_SEEDS.length} formulas.`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error('Seed failed:', error);
  process.exit(1);
});
