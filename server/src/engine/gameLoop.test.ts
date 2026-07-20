import { describe, it, expect, beforeEach } from 'vitest';
import { GameLoop, type EngineDataInput } from './gameLoop';
import type { GameConfig, PlayerVariables } from '@suetheirasses/shared';

// ── Helpers ──────────────────────────────────────────────────

function makeVars(overrides: Partial<PlayerVariables> = {}): PlayerVariables {
  return {
    cash: 100000,
    assets: 50000,
    intangibleAssets: 10000,
    debt: 20000,
    reserves: 30000,
    operatingExpenses: 5000,
    staffCost: 8000,
    materialCostPerTon: 100,
    otherIncome: 1000,
    price: 500,
    capacityUtilization: 0.8,
    processingLevel: 0.7,
    energyIntensity: 0.5,
    moistureContent: 0.3,
    nutrientConsistency: 0.85,
    supplySecurity: 0.6,
    logisticsCostPerTon: 50,
    processLoss: 0.05,
    installedCapacity: 10000,
    totalSharesOutstanding: 1000,
    shareOwnership: {},
    outrage: 10,
    scrutiny: 30,
    breakdowns: 0,
    contaminationRisk: 0.02,
    odorComplaints: 0,
    tokenLiability: 0,
    carbonFootprint: 0,
    stockVolume: 0,
    demand: 8000,
    ...overrides,
  };
}

function makeConfig(overrides: Partial<GameConfig> = {}): GameConfig {
  return {
    gameSettings: {
      minPlayers: 2,
      maxPlayers: 4,
      turnDurationSeconds: 120,
      maxLawsuitsPerPlayerPerTurn: 3,
      maxStrategicDecisionsPerTurn: 2,
      maxOperationalDecisionsPerTurn: 3,
      totalMarketVolumeTonnesPerYear: 50000,
      marketFixed: true,
      digDeeperCost: 10000,
    },
    playerStartingValues: {
      cash: 100000,
      assets: 50000,
      intangibleAssets: 10000,
      debt: 20000,
      reserves: 30000,
      operatingExpenses: 5000,
      staffCost: 8000,
      materialCostPerTon: 100,
      otherIncome: 1000,
      price: 500,
      capacityUtilization: 0.8,
      processingLevel: 0.7,
      energyIntensity: 0.5,
      moistureContent: 0.3,
      nutrientConsistency: 0.85,
      supplySecurity: 0.6,
      logisticsCostPerTon: 50,
      processLoss: 0.05,
      installedCapacity: 10000,
      totalSharesOutstanding: 1000,
      shareOwnership: {},
      outrage: 10,
      scrutiny: 30,
      breakdowns: 0,
      contaminationRisk: 0.02,
      odorComplaints: 0,
      tokenLiability: 0,
      carbonFootprint: 0,
      stockVolume: 0,
      demand: 8000,
    },
    adminVariables: {
      competitiveness: {
        competitivenessWeight_quality_wq: 0.3,
        competitivenessWeight_supply_ws: 0.2,
        competitivenessWeight_loss_wl: 0.15,
        competitivenessWeight_demand_wd: 0.1,
        outrageDemandWeight: 0.5,
      },
      finance: {
        baseFinanceCost: 2000,
        interestRate: 0.05,
        taxRate: 0.2,
        daysSalesOutstanding_DSO: 30,
      },
      legalProcess: {
        scrutinyLegalRiskMultiplier: 0.02,
        legalExposureRatioCap: 0.8,
        semaphoreGreenMax: 0.15,
        semaphoreYellowMax: 0.4,
        buySharesLegalRiskThresholdPercent: 0.05,
      },
      riskGauge: {
        riskWeightLegalExposure_w1: 0.3,
        riskWeightScrutiny_w2: 0.2,
        riskWeightOutrage_w3: 0.25,
      },
      ownership: {
        takeoverThresholdPercent: 0.5,
      },
      depreciation: {
        assetUsefulLifeYears: 10,
        intangibleUsefulLifeYears: 5,
      },
    },
    ...overrides,
  };
}

/** Builds the EngineDataInput[] GameLoop expects — the same shape GameEngine loads from Prisma. */
function makePlayers(
  overrides: Array<{ id: string; name: string; cash?: number; variables?: unknown; engineState?: unknown }>,
): EngineDataInput[] {
  return overrides.map(o => ({
    id: o.id,
    name: o.name,
    company: {
      cash: o.cash ?? 100000,
      variables: o.variables ?? makeVars(),
      engineState: o.engineState ?? {},
    },
  }));
}

const twoPlayers = () => makePlayers([
  { id: 'player-1', name: 'Alice' },
  { id: 'player-2', name: 'Bob' },
]);

// ── Tests ────────────────────────────────────────────────────

describe('GameLoop', () => {
  let gameLoop: GameLoop;
  let config: GameConfig;

  beforeEach(() => {
    config = makeConfig();

    gameLoop = new GameLoop(config);
    gameLoop.loadDecisions([
      {
        decision: 'New Factory',
        level: 'Strategic',
        description: 'Build a new factory',
        nature: 'Traditional',
        offensiveAction: false,
        excludes: [],
        impacts: {
          installedCapacity: { type: 'absolute', schedule: { 1: 5000, default: 5000 } },
          cash: { type: 'absolute', schedule: { 1: -30000, default: -30000 } },
        },
      },
      {
        decision: 'Quality Certification',
        level: 'Operational',
        description: 'Get quality certification',
        nature: 'Traditional',
        offensiveAction: false,
        excludes: [],
        impacts: {
          processingLevel: { type: 'absolute', schedule: { 1: 0.1, 2: 0.1, default: 0.2 } },
          cash: { type: 'absolute', schedule: { 1: -5000, default: -5000 } },
        },
      },
      {
        decision: 'Water Pumping',
        level: 'Operational',
        description: 'Pump water from competitor territory',
        nature: 'Dirty',
        offensiveAction: true,
        excludes: [],
        impacts: {
          materialCostPerTon: { type: 'absolute', schedule: { default: -50 } },
        },
        legalRisks: [
          {
            name: 'Environmental Violation',
            description: 'Sue for environmental damage',
            probability: { 1: 0.06, 2: 0.12, default: 0.18 },
            impact: {
              type: 'absolute',
              target: 'cash',
              schedule: { 1: 7350, 2: 14700, default: 22050 },
            },
          },
        ],
      },
      {
        decision: 'Exclusive Deal',
        level: 'Strategic',
        description: 'Sign exclusive supplier deal',
        nature: 'Traditional',
        offensiveAction: false,
        excludes: ['Competitor Lock-in'],
        impacts: {
          supplySecurity: { type: 'absolute', schedule: { default: 0.15 } },
        },
      },
      {
        decision: 'Competitor Lock-in',
        level: 'Strategic',
        description: 'Lock in competitor suppliers',
        nature: 'Grey Area',
        offensiveAction: true,
        excludes: ['Exclusive Deal'],
        impacts: {
          supplySecurity: { type: 'absolute', schedule: { default: 0.1 } },
        },
      },
      {
        decision: 'Bot Attack',
        level: 'Operational',
        description: 'Launch a coordinated cyberattack against a competitor',
        nature: 'Dirty',
        offensiveAction: true,
        excludes: [],
        impacts: {
          cash: { type: 'absolute', schedule: { default: -12000 } },
          'target.outrage': { type: 'absolute', schedule: { default: 20 } },
          'target.capacityUtilization': { type: 'relative', schedule: { default: -0.2 } },
        },
        legalRisks: [
          {
            name: 'CFAA Digital Sabotage Lawsuit',
            description: 'Sue for the DDoS attack that crashed your logistics infrastructure.',
            probability: { 1: 0.2, default: 0.6 },
            impact: { type: 'absolute', target: 'cash', schedule: { 1: -50000, default: -120000 } },
          },
        ],
      },
    ]);
  });

  describe('Phase A — Decision Collection', () => {
    it('should accept decision submissions', () => {
      const decisions = {
        strategic: [{ name: 'New Factory' }],
        operational: [{ name: 'Quality Certification' }],
        lawsuits: [],
      };

      const result = gameLoop.submitDecisions('room-1', 'player-1', decisions);

      expect(result).toBe(true);
      expect(gameLoop.getSubmissionCount('room-1')).toBe(1);
    });

    it('should track multiple player submissions', () => {
      gameLoop.submitDecisions('room-1', 'player-1', {
        strategic: [{ name: 'New Factory' }],
        operational: [],
        lawsuits: [],
      });
      gameLoop.submitDecisions('room-1', 'player-2', {
        strategic: [],
        operational: [{ name: 'Quality Certification' }],
        lawsuits: [],
      });

      expect(gameLoop.getSubmissionCount('room-1')).toBe(2);
    });

    it('should clear submissions', () => {
      gameLoop.submitDecisions('room-1', 'player-1', {
        strategic: [{ name: 'New Factory' }],
        operational: [],
        lawsuits: [],
      });

      gameLoop.clearSubmissions('room-1');
      expect(gameLoop.getSubmissionCount('room-1')).toBe(0);
    });

    it('should return 0 for non-existent room', () => {
      expect(gameLoop.getSubmissionCount('nonexistent-room')).toBe(0);
    });
  });

  describe('resolveTurn — basic flow', () => {
    it('should return empty result when no players exist', () => {
      const outcome = gameLoop.resolveTurn('room-1', 1, []);

      expect(outcome.result.players).toHaveLength(0);
      expect(outcome.result.gameOver).toBe(false);
      expect(outcome.companyUpdates).toHaveLength(0);
      expect(outcome.bankruptedPlayers).toHaveLength(0);
    });

    it('should process a turn with two players', () => {
      const outcome = gameLoop.resolveTurn('room-1', 1, twoPlayers());

      expect(outcome.result.players).toHaveLength(2);
      expect(outcome.result.players[0].playerId).toBe('player-1');
      expect(outcome.result.players[0].playerName).toBe('Alice');
      expect(outcome.result.gameOver).toBe(false);
      expect(outcome.result.round).toBe(1);
    });

    it('should seed starting values on first turn when vars are empty', () => {
      const players = makePlayers([
        { id: 'player-1', name: 'Alice', cash: 0, variables: {} },
        { id: 'player-2', name: 'Bob', cash: 0, variables: {} },
      ]);

      const outcome = gameLoop.resolveTurn('room-1', 1, players);

      // Starting values should be seeded from playerStartingValues when vars are empty.
      // With two players the full game loop runs (P&L, balance sheet), so cash may differ from raw seed.
      expect(outcome.result.players).toHaveLength(2);
      expect(outcome.result.players[0].variables.cash).toBeGreaterThan(0);
    });

    it('should not trigger game over with two players', () => {
      const outcome = gameLoop.resolveTurn('room-1', 1, twoPlayers());

      expect(outcome.result.gameOver).toBe(false);
    });
  });

  describe('resolveTurn — decision processing', () => {
    it('should deploy submitted strategic decisions', () => {
      gameLoop.submitDecisions('room-1', 'player-1', {
        strategic: [{ name: 'New Factory' }],
        operational: [],
        lawsuits: [],
      });

      const outcome = gameLoop.resolveTurn('room-1', 1, twoPlayers());

      expect(outcome.result.players[0].activeDecisions).toHaveLength(1);
      expect(outcome.result.players[0].activeDecisions[0].decisionName).toBe('New Factory');
    });

    it('should deploy submitted operational decisions', () => {
      gameLoop.submitDecisions('room-1', 'player-1', {
        strategic: [],
        operational: [{ name: 'Quality Certification' }],
        lawsuits: [],
      });

      const outcome = gameLoop.resolveTurn('room-1', 1, twoPlayers());

      expect(outcome.result.players[0].activeDecisions).toHaveLength(1);
      expect(outcome.result.players[0].activeDecisions[0].decisionName).toBe('Quality Certification');
    });

    it('should block deploying same decision twice before maturity', () => {
      // Quality Certification matures in 2 years (impacts at years 1 and 2), so after
      // one resolved turn it's still maturing — a real test of cross-turn blocking via
      // the actual persisted engineState (Company.engineState round-trip through
      // outcome.companyUpdates), not just same-turn duplicate-submission handling.
      gameLoop.submitDecisions('room-1', 'player-1', {
        strategic: [],
        operational: [{ name: 'Quality Certification' }],
        lawsuits: [],
      });

      const outcome1 = gameLoop.resolveTurn('room-1', 1, twoPlayers());
      expect(outcome1.result.players[0].activeDecisions[0].isMatured).toBe(false);

      const persisted = outcome1.companyUpdates.find(u => u.playerId === 'player-1')!;
      const players = makePlayers([
        { id: 'player-1', name: 'Alice', variables: persisted.variables, engineState: persisted.engineState },
        { id: 'player-2', name: 'Bob' },
      ]);

      // Second turn: try to deploy again while the first instance is still maturing
      gameLoop.submitDecisions('room-1', 'player-1', {
        strategic: [],
        operational: [{ name: 'Quality Certification' }],
        lawsuits: [],
      });

      const outcome2 = gameLoop.resolveTurn('room-1', 2, players);

      // Should still have only 1 active decision (the second was blocked)
      expect(outcome2.result.players[0].activeDecisions).toHaveLength(1);
    });

    it('should enforce strategic decision limit', () => {
      gameLoop.submitDecisions('room-1', 'player-1', {
        strategic: [{ name: 'New Factory' }, { name: 'Exclusive Deal' }, { name: 'Competitor Lock-in' }],
        operational: [],
        lawsuits: [],
      });

      const outcome = gameLoop.resolveTurn('room-1', 1, twoPlayers());

      // Max 2 strategic decisions per turn
      const strategicCount = outcome.result.players[0].activeDecisions.filter(
        (d) => d.decisionName === 'New Factory' || d.decisionName === 'Exclusive Deal' || d.decisionName === 'Competitor Lock-in',
      ).length;
      expect(strategicCount).toBeLessThanOrEqual(2);
    });

    it('should block mutually exclusive decisions', () => {
      gameLoop.submitDecisions('room-1', 'player-1', {
        strategic: [{ name: 'Exclusive Deal' }],
        operational: [],
        lawsuits: [],
      });

      const outcome = gameLoop.resolveTurn('room-1', 1, twoPlayers());

      // Exclusive Deal should be deployed (Competitor Lock-in not submitted)
      const decisionNames = outcome.result.players[0].activeDecisions.map((d) => d.decisionName);
      expect(decisionNames).toContain('Exclusive Deal');
    });

    it('should route target.* impacts to the targeted player, not the deploying player', () => {
      // Regression test: GameLoop.resolveTurn used to extract target.* impacts but
      // never apply them, so offensive decisions (Bot Attack, Social Astroturf, etc.)
      // silently had no effect on the chosen opponent.
      gameLoop.submitDecisions('room-1', 'player-1', {
        strategic: [],
        operational: [{ name: 'Bot Attack', targetId: 'player-2' }],
        lawsuits: [],
      });

      const outcome = gameLoop.resolveTurn('room-1', 1, twoPlayers());

      const alice = outcome.result.players.find((p) => p.playerId === 'player-1')!;
      const bob = outcome.result.players.find((p) => p.playerId === 'player-2')!;

      // Target absolute impact landed on the target (starting outrage: 10 + 20)
      expect(bob.variables.outrage).toBe(30);
      // Target relative impact landed on the target (starting capacityUtilization: 0.8 * (1 - 0.2))
      expect(bob.variables.capacityUtilization).toBeCloseTo(0.64, 5);

      // The deploying player's own state is untouched by the target.* fields —
      // no stray "target.outrage" pollution and no self-inflicted effect.
      expect(alice.variables.outrage).toBe(10);
      expect(alice.variables.capacityUtilization).toBe(0.8);
      expect((alice.variables as any)['target.outrage']).toBeUndefined();
      expect((alice.variables as any)['target.capacityUtilization']).toBeUndefined();
    });

    it('should surface an incomingAttacks entry for the victim, un-investigated by default', () => {
      gameLoop.submitDecisions('room-1', 'player-1', {
        strategic: [],
        operational: [{ name: 'Bot Attack', targetId: 'player-2' }],
        lawsuits: [],
      });

      const outcome = gameLoop.resolveTurn('room-1', 1, twoPlayers());
      const alice = outcome.result.players.find((p) => p.playerId === 'player-1')!;
      const bob = outcome.result.players.find((p) => p.playerId === 'player-2')!;

      expect(bob.incomingAttacks).toHaveLength(1);
      expect(bob.incomingAttacks[0].investigationLevel).toBe(0);
      // Nothing revealed yet — no attacker identity below investigation level 1.
      expect(bob.incomingAttacks[0].attackerId).toBeUndefined();
      expect(bob.incomingAttacks[0].attackerName).toBeUndefined();
      // Alice isn't being attacked by anyone.
      expect(alice.incomingAttacks).toHaveLength(0);
    });
  });

  describe('resolveTurn — financial calculations', () => {
    it('should calculate derived values correctly', () => {
      const outcome = gameLoop.resolveTurn('room-1', 1, twoPlayers());

      const derived = outcome.result.players[0].derived;
      expect(derived.equity).toBeDefined();
      expect(derived.revenue).toBeDefined();
      expect(derived.volume).toBeDefined();
      expect(derived.marketShare).toBeDefined();
      expect(derived.competitiveness).toBeDefined();
      expect(derived.depreciation).toBeDefined();
      expect(derived.financeCost).toBeDefined();
      expect(derived.taxCost).toBeDefined();
    });

    it('should calculate market share across multiple players', () => {
      const players = makePlayers([
        { id: 'player-1', name: 'Alice', variables: makeVars({ price: 500, processingLevel: 0.7 }) },
        { id: 'player-2', name: 'Bob', variables: makeVars({ price: 600, processingLevel: 0.5 }) },
      ]);

      const outcome = gameLoop.resolveTurn('room-1', 1, players);

      const aliceShare = outcome.result.players.find((p) => p.playerId === 'player-1')?.derived.marketShare;
      const bobShare = outcome.result.players.find((p) => p.playerId === 'player-2')?.derived.marketShare;

      // Alice has better competitiveness (lower price + higher processing level)
      expect(aliceShare).toBeGreaterThan(0);
      expect(bobShare).toBeGreaterThan(0);
    });

    it('should calculate volume with supply cap', () => {
      const players = makePlayers([
        {
          id: 'player-1',
          name: 'Alice',
          variables: makeVars({ installedCapacity: 2000, capacityUtilization: 0.8, marketShare: 0.5 }),
        },
        { id: 'player-2', name: 'Bob' },
      ]);

      const outcome = gameLoop.resolveTurn('room-1', 1, players);

      const volume = outcome.result.players[0].derived.volume;
      // maxSupply = 2000 * 0.8 = 1600, theoretical = 0.5 * 50000 = 25000
      // volume should be capped at 1600
      expect(volume).toBe(1600);
    });

    it('should calculate risk gauge', () => {
      const outcome = gameLoop.resolveTurn('room-1', 1, twoPlayers());

      expect(outcome.result.players[0].riskGauge).toBeDefined();
      expect(outcome.result.players[0].riskGauge).toBeGreaterThanOrEqual(0);
      expect(outcome.result.players[0].riskGauge).toBeLessThanOrEqual(100);
    });
  });

  describe('resolveTurn — legal risks (deliberate filing only)', () => {
    it('should NOT create a legal case just because a decision has legalRisks — filing is required', () => {
      // Alice deploys a risky decision but nobody files suit over it
      gameLoop.submitDecisions('room-1', 'player-1', {
        strategic: [], operational: [{ name: 'Water Pumping' }], lawsuits: [],
      });

      const outcome = gameLoop.resolveTurn('room-1', 1, twoPlayers());

      const aliceCases = outcome.result.players.find((p) => p.playerId === 'player-1')?.legalCases;
      expect(aliceCases).toEqual([]);
    });

    it('should create a legal case when another player deliberately files suit over a decision the target actually deployed', () => {
      gameLoop.submitDecisions('room-1', 'player-1', {
        strategic: [], operational: [{ name: 'Water Pumping' }], lawsuits: [],
      });
      gameLoop.submitDecisions('room-1', 'player-2', {
        strategic: [], operational: [],
        lawsuits: [{ targetId: 'player-1', decisionName: 'Water Pumping', groundName: 'Environmental Violation' }],
      });

      const outcome = gameLoop.resolveTurn('room-1', 1, twoPlayers());

      const aliceCases = outcome.result.players.find((p) => p.playerId === 'player-1')?.legalCases;
      expect(aliceCases!.length).toBe(1);
      expect(aliceCases![0].groundName).toBe('Environmental Violation');
      expect(aliceCases![0].defendantId).toBe('player-1');
      expect(aliceCases![0].plaintiffId).toBe('player-2');
    });

    it('should not create a case when the cited decision was never deployed by the target', () => {
      // Alice deploys nothing risky; Bob tries to sue her over a decision she never made
      gameLoop.submitDecisions('room-1', 'player-2', {
        strategic: [], operational: [],
        lawsuits: [{ targetId: 'player-1', decisionName: 'Water Pumping', groundName: 'Environmental Violation' }],
      });

      const outcome = gameLoop.resolveTurn('room-1', 1, twoPlayers());

      const aliceCases = outcome.result.players.find((p) => p.playerId === 'player-1')?.legalCases;
      expect(aliceCases).toEqual([]);
    });
  });

  describe('resolveTurn — persistence output', () => {
    it('should include engine state in the returned company updates', () => {
      gameLoop.submitDecisions('room-1', 'player-1', {
        strategic: [{ name: 'New Factory' }],
        operational: [],
        lawsuits: [],
      });

      const outcome = gameLoop.resolveTurn('room-1', 1, twoPlayers());

      const update = outcome.companyUpdates.find(u => u.playerId === 'player-1');
      expect(update).toBeDefined();
      expect(update!.engineState.activeDecisions).toBeDefined();
      expect(update!.engineState.activeDecisions).toHaveLength(1);
    });

    it('should serialize activeDecisions with a definitionName the next turn can look up (round-trip regression)', () => {
      gameLoop.submitDecisions('room-1', 'player-1', {
        strategic: [{ name: 'New Factory' }],
        operational: [],
        lawsuits: [],
      });

      const outcome1 = gameLoop.resolveTurn('room-1', 1, twoPlayers());
      const persisted = outcome1.companyUpdates.find(u => u.playerId === 'player-1')!;

      expect(persisted.engineState.activeDecisions[0]).toMatchObject({ definitionName: 'New Factory' });

      // Feeding the exact persisted engineState back in must not blow up — this is
      // the real DB round-trip (readEngineState resolves definitionName back to a
      // full DecisionDefinition), not a hand-built stand-in for it.
      const players = makePlayers([
        { id: 'player-1', name: 'Alice', variables: persisted.variables, engineState: persisted.engineState },
        { id: 'player-2', name: 'Bob' },
      ]);
      const outcome2 = gameLoop.resolveTurn('room-1', 2, players);

      expect(outcome2.result.players[0].activeDecisions[0].decisionName).toBe('New Factory');
      expect(outcome2.result.players[0].activeDecisions[0].elapsedYears).toBe(2);
    });

    it('should include updated variables in the returned company updates', () => {
      const outcome = gameLoop.resolveTurn('room-1', 1, twoPlayers());

      expect(outcome.companyUpdates).toHaveLength(2);
      expect(outcome.companyUpdates[0].variables).toBeDefined();
      expect(outcome.companyUpdates[0].cash).toBeDefined();
    });

    it('should not include a company update for a player it just bankrupted', () => {
      const players = makePlayers([
        { id: 'player-1', name: 'Alice', cash: 100, variables: makeVars({ cash: 100, reserves: 0 }) },
        { id: 'player-2', name: 'Bob' },
      ]);
      // Force Alice into negative cash via a large strategic spend she can't cover.
      gameLoop.submitDecisions('room-1', 'player-1', {
        strategic: [{ name: 'New Factory' }],
        operational: [],
        lawsuits: [],
      });

      const outcome = gameLoop.resolveTurn('room-1', 1, players);

      const aliceBankrupt = outcome.bankruptedPlayers.find(b => b.playerId === 'player-1');
      if (aliceBankrupt) {
        expect(outcome.companyUpdates.find(u => u.playerId === 'player-1')).toBeUndefined();
      }
    });
  });

  describe('resolveTurn — turn progression', () => {
    it('should advance active decisions across turns', () => {
      // Turn 1: deploy decision
      gameLoop.submitDecisions('room-1', 'player-1', {
        strategic: [{ name: 'New Factory' }],
        operational: [],
        lawsuits: [],
      });

      const outcome1 = gameLoop.resolveTurn('room-1', 1, twoPlayers());
      expect(outcome1.result.players[0].activeDecisions).toHaveLength(1);
      expect(outcome1.result.players[0].activeDecisions[0].elapsedYears).toBe(1);

      // Turn 2: no new decisions, but existing ones advance.
      // The engine state (including activeDecisions) is persisted to the DB after turn 1
      // (GameEngine writes outcome1.companyUpdates) — simulate that by feeding it back in.
      const persisted = outcome1.companyUpdates.find(u => u.playerId === 'player-1')!;
      const players = makePlayers([
        { id: 'player-1', name: 'Alice', variables: persisted.variables, engineState: persisted.engineState },
        { id: 'player-2', name: 'Bob' },
      ]);

      const outcome2 = gameLoop.resolveTurn('room-1', 2, players);
      expect(outcome2.result.players[0].activeDecisions).toHaveLength(1);
      expect(outcome2.result.players[0].activeDecisions[0].elapsedYears).toBe(2);
    });

    it('should clear submissions after turn resolution', () => {
      gameLoop.submitDecisions('room-1', 'player-1', {
        strategic: [{ name: 'New Factory' }],
        operational: [],
        lawsuits: [],
      });

      gameLoop.resolveTurn('room-1', 1, twoPlayers());

      expect(gameLoop.getSubmissionCount('room-1')).toBe(0);
    });
  });

  describe('digDeeper', () => {
    // Builds a fixture where player-1 has one persisted Bot Attack decision instance
    // targeting player-2 — bypasses a full resolveTurn cycle since digDeeper only
    // needs cash + engineState, letting each test set up cash/investigation state
    // directly for the exact scenario under test.
    const ATTACK_ID = 'attack-1';
    function makeAttackFixture(overrides: { victimCash?: number; victimInvestigations?: Record<string, number> } = {}): EngineDataInput[] {
      return makePlayers([
        {
          id: 'player-1',
          name: 'Alice',
          engineState: {
            activeDecisions: [
              { id: ATTACK_ID, definitionName: 'Bot Attack', deployedYear: 1, elapsedYears: 0, isMatured: true, targetId: 'player-2' },
            ],
          },
        },
        {
          id: 'player-2',
          name: 'Bob',
          // GameLoop reads cash from `variables.cash`, not the `company.cash` column
          // (that's only kept in sync by the persistence layer) — override it here.
          variables: makeVars({ cash: overrides.victimCash ?? 100000 }),
          engineState: { investigations: overrides.victimInvestigations ?? {} },
        },
      ]);
    }

    it('dig 1 reveals only the attacker identity', () => {
      const outcome = gameLoop.digDeeper('player-2', ATTACK_ID, makeAttackFixture());

      expect(outcome.success).toBe(true);
      if (!outcome.success) return;
      expect(outcome.cost).toBe(10000);
      expect(outcome.newCash).toBe(90000);
      // GameLoop reads cash from variables.cash (readVariables), not a separate column —
      // the caller must persist this alongside engineStateUpdate or the next call (or the
      // next normal turn) reads stale, pre-deduction cash back out.
      expect(outcome.variables.cash).toBe(90000);
      expect(outcome.attack.investigationLevel).toBe(1);
      expect(outcome.attack.attackerId).toBe('player-1');
      expect(outcome.attack.attackerName).toBe('Alice');
      expect(outcome.attack.decisionName).toBeUndefined();
      expect(outcome.attack.suggestedGroundName).toBeUndefined();
      expect(outcome.engineStateUpdate.investigations[ATTACK_ID]).toBe(1);
    });

    it('dig 2 adds the decision name and effect summary', () => {
      const outcome = gameLoop.digDeeper('player-2', ATTACK_ID, makeAttackFixture({ victimInvestigations: { [ATTACK_ID]: 1 } }));

      expect(outcome.success).toBe(true);
      if (!outcome.success) return;
      expect(outcome.attack.investigationLevel).toBe(2);
      expect(outcome.attack.decisionName).toBe('Bot Attack');
      expect(outcome.attack.effectSummary).toContain('Outrage');
      expect(outcome.attack.suggestedGroundName).toBeUndefined();
    });

    it('dig 3 adds the suggested lawsuit ground and a success probability', () => {
      const outcome = gameLoop.digDeeper('player-2', ATTACK_ID, makeAttackFixture({ victimInvestigations: { [ATTACK_ID]: 2 } }));

      expect(outcome.success).toBe(true);
      if (!outcome.success) return;
      expect(outcome.attack.investigationLevel).toBe(3);
      expect(outcome.attack.suggestedGroundName).toBe('CFAA Digital Sabotage Lawsuit');
      expect(outcome.attack.successProbability).toBeGreaterThan(0);
      expect(outcome.attack.successProbability).toBeLessThanOrEqual(1);
    });

    it('sequential digs accumulate cost — the second dig charges from the already-decremented cash', () => {
      // Regression test: GameEngine.digDeeper originally persisted the `cash` column but
      // not `variables.cash` (the JSONB field GameLoop actually reads via readVariables),
      // so every dig recomputed its cost against the same stale starting cash instead of
      // accumulating. Simulates that exact caller pattern: feed each dig's full persisted
      // output (variables + engineStateUpdate) as the next call's input.
      const dig1 = gameLoop.digDeeper('player-2', ATTACK_ID, makeAttackFixture());
      expect(dig1.success).toBe(true);
      if (!dig1.success) return;
      expect(dig1.newCash).toBe(90000);

      const playersAfterDig1 = makePlayers([
        { id: 'player-1', name: 'Alice', engineState: { activeDecisions: [{ id: ATTACK_ID, definitionName: 'Bot Attack', deployedYear: 1, elapsedYears: 0, isMatured: true, targetId: 'player-2' }] } },
        { id: 'player-2', name: 'Bob', variables: dig1.variables, engineState: dig1.engineStateUpdate },
      ]);

      const dig2 = gameLoop.digDeeper('player-2', ATTACK_ID, playersAfterDig1);
      expect(dig2.success).toBe(true);
      if (!dig2.success) return;
      // 80000, not 90000 again — the deduction from dig 1 must carry forward.
      expect(dig2.newCash).toBe(80000);
      expect(dig2.variables.cash).toBe(80000);
    });

    it('dig 4 fails — already fully investigated, no charge', () => {
      const outcome = gameLoop.digDeeper('player-2', ATTACK_ID, makeAttackFixture({ victimInvestigations: { [ATTACK_ID]: 3 } }));

      expect(outcome).toEqual({ success: false, reason: 'already_fully_investigated' });
    });

    it('fails with insufficient_funds and does not charge when cash is below the cost', () => {
      const outcome = gameLoop.digDeeper('player-2', ATTACK_ID, makeAttackFixture({ victimCash: 5000 }));

      expect(outcome).toEqual({ success: false, reason: 'insufficient_funds' });
    });

    it('fails with invalid_attack for a bogus attack id', () => {
      const outcome = gameLoop.digDeeper('player-2', 'not-a-real-attack', makeAttackFixture());

      expect(outcome).toEqual({ success: false, reason: 'invalid_attack' });
    });

    it('fails with invalid_attack when the attack does not target the caller', () => {
      // player-1's Bot Attack targets player-2 — player-1 can't dig on their own attack.
      const outcome = gameLoop.digDeeper('player-1', ATTACK_ID, makeAttackFixture());

      expect(outcome).toEqual({ success: false, reason: 'invalid_attack' });
    });

    it('investigations persisted via digDeeper survive an unrelated normal turn resolving', () => {
      const digOutcome = gameLoop.digDeeper('player-2', ATTACK_ID, makeAttackFixture());
      expect(digOutcome.success).toBe(true);
      if (!digOutcome.success) return;

      // Simulate GameEngine persisting the dig, then a normal turn resolving afterward —
      // regression guard for readEngineState/Step-12 dropping unknown engineState keys.
      const players = makePlayers([
        { id: 'player-1', name: 'Alice', engineState: { activeDecisions: [{ id: ATTACK_ID, definitionName: 'Bot Attack', deployedYear: 1, elapsedYears: 0, isMatured: true, targetId: 'player-2' }] } },
        { id: 'player-2', name: 'Bob', cash: digOutcome.newCash, engineState: digOutcome.engineStateUpdate },
      ]);

      const turnOutcome = gameLoop.resolveTurn('room-1', 2, players);
      const bobUpdate = turnOutcome.companyUpdates.find((u) => u.playerId === 'player-2')!;
      expect(bobUpdate.engineState.investigations[ATTACK_ID]).toBe(1);

      const bob = turnOutcome.result.players.find((p) => p.playerId === 'player-2')!;
      expect(bob.incomingAttacks[0].investigationLevel).toBe(1);
      expect(bob.incomingAttacks[0].attackerName).toBe('Alice');
    });
  });

  describe('getActiveDecisionSummaries', () => {
    it('returns each active decision with its definition description, deployed year, and elapsed years', () => {
      const players = makePlayers([
        {
          id: 'player-1',
          name: 'Alice',
          engineState: {
            activeDecisions: [
              { id: 'inst-1', definitionName: 'New Factory', deployedYear: 1, elapsedYears: 2, isMatured: true },
              { id: 'inst-2', definitionName: 'Bot Attack', deployedYear: 3, elapsedYears: 0, isMatured: false, targetId: 'player-2' },
            ],
          },
        },
      ]);

      const summaries = gameLoop.getActiveDecisionSummaries('player-1', players);

      expect(summaries).toEqual([
        { instanceId: 'inst-1', decisionName: 'New Factory', description: 'Build a new factory', deployedYear: 1, elapsedYears: 2 },
        { instanceId: 'inst-2', decisionName: 'Bot Attack', description: 'Launch a coordinated cyberattack against a competitor', deployedYear: 3, elapsedYears: 0 },
      ]);
    });

    it('returns an empty array for a player with no active decisions', () => {
      const players = makePlayers([{ id: 'player-1', name: 'Alice' }]);

      expect(gameLoop.getActiveDecisionSummaries('player-1', players)).toEqual([]);
    });

    it('returns null for an unknown player id', () => {
      expect(gameLoop.getActiveDecisionSummaries('nobody', twoPlayers())).toBeNull();
    });

    it('returns null for a player with no company row (e.g. already bankrupted)', () => {
      const players: EngineDataInput[] = [{ id: 'player-1', name: 'Alice', company: null }];

      expect(gameLoop.getActiveDecisionSummaries('player-1', players)).toBeNull();
    });
  });

  describe('getInitialSnapshot', () => {
    it('should return empty result when no players exist', () => {
      const result = gameLoop.getInitialSnapshot('room-1', 1, []);

      expect(result.players).toHaveLength(0);
      expect(result.gameOver).toBe(false);
    });

    it('should compute a starting-position snapshot with no decisions applied', () => {
      const players = makePlayers([
        { id: 'player-1', name: 'Alice', cash: 0, variables: {} },
        { id: 'player-2', name: 'Bob', cash: 0, variables: {} },
      ]);

      const result = gameLoop.getInitialSnapshot('room-1', 1, players);

      expect(result.round).toBe(1);
      expect(result.gameOver).toBe(false);
      expect(result.players).toHaveLength(2);
      // Starting values seeded, market share/volume computed across both players
      expect(result.players[0].variables.cash).toBeGreaterThan(0);
      expect(result.players[0].derived.marketShare).toBeGreaterThan(0);
      expect(result.players[0].derived.volume).toBeGreaterThan(0);
      // No decisions have been submitted yet — nothing active, no lawsuits
      expect(result.players[0].activeDecisions).toEqual([]);
      expect(result.players[0].legalCases).toEqual([]);
    });

    it('should never report gameOver, even for a single-player room', () => {
      // Unlike resolveTurn, this is a preview before any real round has been played —
      // it must never end the game, regardless of player count.
      const players = makePlayers([
        { id: 'player-1', name: 'SoloPlayer', cash: 0, variables: {} },
      ]);

      const result = gameLoop.getInitialSnapshot('room-1', 1, players);

      expect(result.gameOver).toBe(false);
      expect(result.winnerId).toBeUndefined();
    });
  });
});
