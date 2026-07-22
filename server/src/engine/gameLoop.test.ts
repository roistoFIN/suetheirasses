import { describe, it, expect, beforeEach } from 'vitest';
import { GameLoop, type EngineDataInput } from './gameLoop';
import { DEFAULT_FORMULA_SEEDS } from './defaultFormulas';
import type { GameConfig, PlayerVariables, LegalCaseData } from '@suetheirasses/shared';

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
      negotiationPeriodTurns: 2,
      lawsuitFilingCost: 15000,
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

/** A negotiating case between player-1 (defendant) and player-2 (plaintiff), for the
 * makeOffer/acceptOffer/goToCourt tests below — bypasses filing a real lawsuit through
 * resolveTurn, since those methods only need a case already sitting in engineState. */
function makeCase(overrides: Partial<LegalCaseData> = {}): LegalCaseData {
  return {
    id: 'case-1',
    roomId: 'room-1',
    plaintiffId: 'player-2',
    defendantId: 'player-1',
    decisionName: 'Water Pumping',
    groundName: 'Environmental Violation',
    description: 'Sue for environmental damage',
    baseProbability: 0.12,
    adjustedProbability: undefined,
    plaintiffFullyInvestigated: false,
    stakes: 20000,
    status: 'negotiating',
    offers: [],
    turnsNegotiating: 0,
    verdict: undefined,
    createdAt: new Date('2024-01-01T00:00:00Z'),
    resolvedAt: undefined,
    ...overrides,
  };
}

/** Builds the two-party fixture makeOffer/acceptOffer/goToCourt need — the same case
 * object persisted into both parties' own engineState.legalCases, matching the real
 * "one case lives in both parties' engineState" invariant `resolveTurn` maintains. */
function playersWithCase(case_: LegalCaseData, cashByPlayer: Record<string, number> = {}): EngineDataInput[] {
  return makePlayers([
    { id: 'player-1', name: 'Alice', variables: makeVars({ cash: cashByPlayer['player-1'] ?? 100000 }), engineState: { legalCases: [case_] } },
    { id: 'player-2', name: 'Bob', variables: makeVars({ cash: cashByPlayer['player-2'] ?? 100000 }), engineState: { legalCases: [case_] } },
  ]);
}

// ── Tests ────────────────────────────────────────────────────

describe('GameLoop', () => {
  let gameLoop: GameLoop;
  let config: GameConfig;

  beforeEach(() => {
    config = makeConfig();

    gameLoop = new GameLoop(config);
    gameLoop.loadFormulas(DEFAULT_FORMULA_SEEDS);
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
      // Three active players (not the usual twoPlayers() fixture) specifically to stay
      // OUT of the heads-up shortcut below — see effectiveInvestigationLevel's doc
      // comment — so this covers the plain, un-shortcut "nothing revealed below level 1"
      // baseline that still applies whenever more than one other player could be the
      // attacker.
      gameLoop.submitDecisions('room-1', 'player-1', {
        strategic: [],
        operational: [{ name: 'Bot Attack', targetId: 'player-2' }],
        lawsuits: [],
      });

      const outcome = gameLoop.resolveTurn('room-1', 1, makePlayers([
        { id: 'player-1', name: 'Alice' },
        { id: 'player-2', name: 'Bob' },
        { id: 'player-3', name: 'Carol' },
      ]));
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

    it('should reveal the attacker\'s identity for free in a heads-up (2-active-player) game — there is no one else it could be', () => {
      // With only one other active player, level 1's only content (who attacked me) is
      // never actually ambiguous, so it's surfaced without spending a dig — see
      // effectiveInvestigationLevel's doc comment in gameLoop.ts.
      gameLoop.submitDecisions('room-1', 'player-1', {
        strategic: [],
        operational: [{ name: 'Bot Attack', targetId: 'player-2' }],
        lawsuits: [],
      });

      const outcome = gameLoop.resolveTurn('room-1', 1, twoPlayers());
      const bob = outcome.result.players.find((p) => p.playerId === 'player-2')!;

      expect(bob.incomingAttacks).toHaveLength(1);
      expect(bob.incomingAttacks[0].investigationLevel).toBe(1);
      expect(bob.incomingAttacks[0].attackerId).toBe('player-1');
      expect(bob.incomingAttacks[0].attackerName).toBe('Alice');
      // Level 2 content (what the decision is/does) still isn't free — that's what the
      // first paid dig is for.
      expect(bob.incomingAttacks[0].decisionName).toBeUndefined();
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

    it('should not duplicate a case across turns just because it is persisted into both the plaintiff and defendant\'s own engineState (regression)', () => {
      // A case is persisted into BOTH parties' own engineState.legalCases at the end
      // of the turn it's filed in — each side needs it in their own persisted state.
      // Reconstructing allCases naively by concatenating every player's persisted
      // list would therefore double-count it (and double it again every subsequent
      // turn, since the duplicate gets re-persisted into both copies again).
      gameLoop.submitDecisions('room-1', 'player-1', {
        strategic: [], operational: [{ name: 'Water Pumping' }], lawsuits: [],
      });
      gameLoop.submitDecisions('room-1', 'player-2', {
        strategic: [], operational: [],
        lawsuits: [{ targetId: 'player-1', decisionName: 'Water Pumping', groundName: 'Environmental Violation' }],
      });

      const outcome1 = gameLoop.resolveTurn('room-1', 1, twoPlayers());
      const aliceUpdate = outcome1.companyUpdates.find(u => u.playerId === 'player-1')!;
      const bobUpdate = outcome1.companyUpdates.find(u => u.playerId === 'player-2')!;

      // Sanity check: both parties' own persisted state carries a copy of the same case.
      expect(aliceUpdate.engineState.legalCases).toHaveLength(1);
      expect(bobUpdate.engineState.legalCases).toHaveLength(1);
      expect(aliceUpdate.engineState.legalCases[0].id).toBe(bobUpdate.engineState.legalCases[0].id);

      const players = makePlayers([
        { id: 'player-1', name: 'Alice', variables: aliceUpdate.variables, engineState: aliceUpdate.engineState },
        { id: 'player-2', name: 'Bob', variables: bobUpdate.variables, engineState: bobUpdate.engineState },
      ]);
      const outcome2 = gameLoop.resolveTurn('room-1', 2, players);

      const aliceCasesTurn2 = outcome2.result.players.find((p) => p.playerId === 'player-1')?.legalCases;
      const bobCasesTurn2 = outcome2.result.players.find((p) => p.playerId === 'player-2')?.legalCases;
      expect(aliceCasesTurn2).toHaveLength(1);
      expect(bobCasesTurn2).toHaveLength(1);

      // And it must stay deduplicated on yet another turn, not just the first reload.
      const aliceUpdate2 = outcome2.companyUpdates.find(u => u.playerId === 'player-1')!;
      const bobUpdate2 = outcome2.companyUpdates.find(u => u.playerId === 'player-2')!;
      const players3 = makePlayers([
        { id: 'player-1', name: 'Alice', variables: aliceUpdate2.variables, engineState: aliceUpdate2.engineState },
        { id: 'player-2', name: 'Bob', variables: bobUpdate2.variables, engineState: bobUpdate2.engineState },
      ]);
      const outcome3 = gameLoop.resolveTurn('room-1', 3, players3);
      expect(outcome3.result.players.find((p) => p.playerId === 'player-1')?.legalCases).toHaveLength(1);
      expect(outcome3.result.players.find((p) => p.playerId === 'player-2')?.legalCases).toHaveLength(1);
    });

    it('should force a case to trial after negotiationPeriodTurns, resolving it that same turn (regression — a case had no path out of "negotiating" at all before this)', () => {
      gameLoop.submitDecisions('room-1', 'player-1', {
        strategic: [], operational: [{ name: 'Water Pumping' }], lawsuits: [],
      });
      gameLoop.submitDecisions('room-1', 'player-2', {
        strategic: [], operational: [],
        lawsuits: [{ targetId: 'player-1', decisionName: 'Water Pumping', groundName: 'Environmental Violation' }],
      });

      // Turn 1: freshly filed — never incremented the same turn it's created.
      const outcome1 = gameLoop.resolveTurn('room-1', 1, twoPlayers());
      const aliceUpdate1 = outcome1.companyUpdates.find(u => u.playerId === 'player-1')!;
      const bobUpdate1 = outcome1.companyUpdates.find(u => u.playerId === 'player-2')!;
      const case1 = aliceUpdate1.engineState.legalCases[0];
      expect(case1.status).toBe('negotiating');
      expect(case1.turnsNegotiating).toBe(0);

      // Turn 2: one full turn spent negotiating — makeConfig's negotiationPeriodTurns is 2, not reached yet.
      const players2 = makePlayers([
        { id: 'player-1', name: 'Alice', variables: aliceUpdate1.variables, engineState: aliceUpdate1.engineState },
        { id: 'player-2', name: 'Bob', variables: bobUpdate1.variables, engineState: bobUpdate1.engineState },
      ]);
      const outcome2 = gameLoop.resolveTurn('room-1', 2, players2);
      const aliceUpdate2 = outcome2.companyUpdates.find(u => u.playerId === 'player-1')!;
      const bobUpdate2 = outcome2.companyUpdates.find(u => u.playerId === 'player-2')!;
      const case2 = aliceUpdate2.engineState.legalCases[0];
      expect(case2.status).toBe('negotiating');
      expect(case2.turnsNegotiating).toBe(1);

      // Turn 3: crosses the threshold and resolves in this same turn.
      const players3 = makePlayers([
        { id: 'player-1', name: 'Alice', variables: aliceUpdate2.variables, engineState: aliceUpdate2.engineState },
        { id: 'player-2', name: 'Bob', variables: bobUpdate2.variables, engineState: bobUpdate2.engineState },
      ]);
      const outcome3 = gameLoop.resolveTurn('room-1', 3, players3);
      const aliceCase3 = outcome3.result.players.find((p) => p.playerId === 'player-1')?.legalCases[0];
      expect(aliceCase3?.status).toBe('resolved');
      expect(['won', 'lost']).toContain(aliceCase3?.verdict);
    });

    it('should still create a case — a hopeless, 0%-probability one — when the cited decision was never deployed by the target (a guess)', () => {
      // Alice deploys nothing risky; Bob guesses (wrongly) that she did — the SUE THEIR
      // ASSES modal offers the whole decision library's grounds, not just what a target
      // actually did, so this must still be a real, visible (if unwinnable) case, not a
      // silently-dropped filing.
      gameLoop.submitDecisions('room-1', 'player-2', {
        strategic: [], operational: [],
        lawsuits: [{ targetId: 'player-1', decisionName: 'Water Pumping', groundName: 'Environmental Violation' }],
      });

      const outcome = gameLoop.resolveTurn('room-1', 1, twoPlayers());

      const aliceCases = outcome.result.players.find((p) => p.playerId === 'player-1')?.legalCases;
      expect(aliceCases).toHaveLength(1);
      expect(aliceCases![0].baseProbability).toBe(0);
    });

    describe('plaintiffFullyInvestigated (persisted at filing time)', () => {
      // Bot Attack targets whoever `targetId` names and carries exactly one legal
      // ground ('CFAA Digital Sabotage Lawsuit') — Alice deploys it against Bob. Carol is
      // a third, otherwise-uninvolved active player included purely to keep this fixture
      // OUT of the heads-up investigation shortcut (effectiveInvestigationLevel) — the
      // "dug in but not all the way (level 2)" test below specifically needs level 2 to
      // still mean "not fully investigated," which only holds with more than one other
      // active player in the game.
      const withBotAttack = (investigations: Record<string, number> = {}) => makePlayers([
        {
          id: 'player-1', name: 'Alice',
          engineState: { activeDecisions: [{ id: 'attack-1', definitionName: 'Bot Attack', deployedYear: 1, elapsedYears: 0, isMatured: false, targetId: 'player-2' }] },
        },
        { id: 'player-2', name: 'Bob', engineState: { investigations } },
        { id: 'player-3', name: 'Carol' },
      ]);

      it('should stamp plaintiffFullyInvestigated true when the victim dug all the way in before suing over the matching ground', () => {
        gameLoop.submitDecisions('room-1', 'player-2', {
          strategic: [], operational: [],
          lawsuits: [{ targetId: 'player-1', decisionName: 'Bot Attack', groundName: 'CFAA Digital Sabotage Lawsuit' }],
        });

        const outcome = gameLoop.resolveTurn('room-1', 1, withBotAttack({ 'attack-1': 3 }));

        const bobCase = outcome.result.players.find((p) => p.playerId === 'player-2')?.legalCases[0];
        expect(bobCase?.plaintiffFullyInvestigated).toBe(true);
      });

      it('should leave plaintiffFullyInvestigated false when the victim never dug at all', () => {
        gameLoop.submitDecisions('room-1', 'player-2', {
          strategic: [], operational: [],
          lawsuits: [{ targetId: 'player-1', decisionName: 'Bot Attack', groundName: 'CFAA Digital Sabotage Lawsuit' }],
        });

        const outcome = gameLoop.resolveTurn('room-1', 1, withBotAttack());

        const bobCase = outcome.result.players.find((p) => p.playerId === 'player-2')?.legalCases[0];
        expect(bobCase?.plaintiffFullyInvestigated).toBe(false);
      });

      it('should leave plaintiffFullyInvestigated false when the victim dug in but not all the way (level 2)', () => {
        gameLoop.submitDecisions('room-1', 'player-2', {
          strategic: [], operational: [],
          lawsuits: [{ targetId: 'player-1', decisionName: 'Bot Attack', groundName: 'CFAA Digital Sabotage Lawsuit' }],
        });

        const outcome = gameLoop.resolveTurn('room-1', 1, withBotAttack({ 'attack-1': 2 }));

        const bobCase = outcome.result.players.find((p) => p.playerId === 'player-2')?.legalCases[0];
        expect(bobCase?.plaintiffFullyInvestigated).toBe(false);
      });

      it('should leave plaintiffFullyInvestigated false when suing over a different decision instance than the one investigated', () => {
        // Fully investigated 'attack-1', but files against a decision that isn't
        // actually targeting them at all (Water Pumping has no targetId concept).
        gameLoop.submitDecisions('room-1', 'player-1', {
          strategic: [], operational: [{ name: 'Water Pumping' }], lawsuits: [],
        });
        gameLoop.submitDecisions('room-1', 'player-2', {
          strategic: [], operational: [],
          lawsuits: [{ targetId: 'player-1', decisionName: 'Water Pumping', groundName: 'Environmental Violation' }],
        });

        const outcome = gameLoop.resolveTurn('room-1', 1, withBotAttack({ 'attack-1': 3 }));

        const bobCase = outcome.result.players.find((p) => p.playerId === 'player-2')?.legalCases[0];
        expect(bobCase?.plaintiffFullyInvestigated).toBe(false);
      });
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
      // Deployed turn 1 (elapsedYears 0, its one deployment-year impact already applied
      // in Step 1) then advanced exactly once at turn 2 — not twice (see the
      // "double-applying its own impact" regression test below for why this used to be 2).
      expect(outcome2.result.players[0].activeDecisions[0].elapsedYears).toBe(1);
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
        // Regression: finalCash must carry the real negative balance since the caller can't
        // get it from companyUpdates (this player is excluded from it) — without it, the
        // Company row's cash column is never updated off whatever positive value it had
        // before this turn, which surfaced as a bankrupt player showing positive cash on
        // the Game Over screen.
        expect(aliceBankrupt.finalCash).toBeLessThan(0);
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
      // Just deployed this same turn — Step 1 already applied its one deployment-year
      // impact; it must NOT also be advanced by Step 2 in the same turn (that was the
      // "double-applying its own impact" bug — see the regression test below).
      expect(outcome1.result.players[0].activeDecisions[0].elapsedYears).toBe(0);

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
      // First real advance — turn 2 is the first turn this decision existed BEFORE
      // Step 1 ran, so this is the first time Step 2 is allowed to touch it.
      expect(outcome2.result.players[0].activeDecisions[0].elapsedYears).toBe(1);
    });

    it('does not double-apply a decision\'s own impact in the same turn it is deployed (regression)', () => {
      // Real, reported bug: Step 1 (processNewDecisions) already applies a newly
      // deployed decision's deployment-year impact (elapsedYears 0) directly to
      // ctx.vars and pushes the instance into activeDecisions; Step 2
      // (advanceAndApply) used to then process ALL activeDecisions unconditionally,
      // including the one Step 1 had just pushed — incrementing its elapsedYears to
      // 1 and applying its impact AGAIN, all within the deployment turn itself.
      // 'Bot Attack' has only a flat `cash: -12000` self-effect with no per-year
      // schedule (single 'default' key), so a double-application shows up as an
      // unmistakable -24000 instead of -12000. Isolated via a baseline run with no
      // decision deployed at all, exactly like the negotiation Step 8b tests above —
      // diffing out everything else a turn's P&L/balance-sheet math also moves.
      gameLoop.submitDecisions('room-1', 'player-1', {
        strategic: [], operational: [{ name: 'Bot Attack', targetId: 'player-2' }], lawsuits: [],
      });
      const outcome = gameLoop.resolveTurn('room-1', 1, twoPlayers());

      // Baseline: identical fixture, different (submission-free) room, no decision
      // deployed at all — isolates exactly Bot Attack's cash effect from everything
      // else a turn's P&L/balance-sheet math also moves, same technique the
      // negotiation Step 8b tests above use.
      const baselineOutcome = gameLoop.resolveTurn('room-2', 1, twoPlayers());

      const aliceCash = outcome.result.players.find(p => p.playerId === 'player-1')!.variables.cash;
      const aliceBaselineCash = baselineOutcome.result.players.find(p => p.playerId === 'player-1')!.variables.cash;

      expect(aliceBaselineCash - aliceCash).toBeCloseTo(12000, 5);
      // And the instance itself must still be at elapsedYears 0 after its own deployment turn.
      const alice = outcome.result.players.find(p => p.playerId === 'player-1')!;
      expect(alice.activeDecisions.find(d => d.decisionName === 'Bot Attack')?.elapsedYears).toBe(0);
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
    // directly for the exact scenario under test. A third, otherwise-uninvolved active
    // player (Carol) is included specifically so this describe block's byId.size is 3,
    // NOT 2 — keeping it OUT of the heads-up shortcut (effectiveInvestigationLevel) so
    // these tests exercise the plain, un-shortcut 1-2-3 progression. The heads-up
    // (exactly 2 active players) shortcut has its own dedicated describe block below.
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
        { id: 'player-3', name: 'Carol' },
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
      // Carol stays in the roster here too, for the same "stay out of the heads-up
      // shortcut" reason makeAttackFixture includes her.
      const players = makePlayers([
        { id: 'player-1', name: 'Alice', engineState: { activeDecisions: [{ id: ATTACK_ID, definitionName: 'Bot Attack', deployedYear: 1, elapsedYears: 0, isMatured: true, targetId: 'player-2' }] } },
        { id: 'player-2', name: 'Bob', cash: digOutcome.newCash, engineState: digOutcome.engineStateUpdate },
        { id: 'player-3', name: 'Carol' },
      ]);

      const turnOutcome = gameLoop.resolveTurn('room-1', 2, players);
      const bobUpdate = turnOutcome.companyUpdates.find((u) => u.playerId === 'player-2')!;
      expect(bobUpdate.engineState.investigations[ATTACK_ID]).toBe(1);

      const bob = turnOutcome.result.players.find((p) => p.playerId === 'player-2')!;
      expect(bob.incomingAttacks[0].investigationLevel).toBe(1);
      expect(bob.incomingAttacks[0].attackerName).toBe('Alice');
    });
  });

  describe('digDeeper — heads-up (exactly 2 active players)', () => {
    // Same Bot Attack fixture as the digDeeper describe block above, minus Carol — with
    // only one other active player, who attacked me is never actually in question, so
    // investigation effectively starts one tier ahead (see effectiveInvestigationLevel's
    // doc comment in gameLoop.ts). This means only 2 paid digs are ever needed here, not
    // 3, and the raw persisted level this describe block reaches maxes out at 2.
    const ATTACK_ID = 'attack-1';
    function makeHeadsUpFixture(overrides: { victimInvestigations?: Record<string, number> } = {}): EngineDataInput[] {
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
          variables: makeVars({ cash: 100000 }),
          engineState: { investigations: overrides.victimInvestigations ?? {} },
        },
      ]);
    }

    it('dig 1 skips straight to the decision name and effect summary — identity was already free', () => {
      const outcome = gameLoop.digDeeper('player-2', ATTACK_ID, makeHeadsUpFixture());

      expect(outcome.success).toBe(true);
      if (!outcome.success) return;
      expect(outcome.attack.investigationLevel).toBe(2);
      expect(outcome.attack.attackerId).toBe('player-1');
      expect(outcome.attack.attackerName).toBe('Alice');
      expect(outcome.attack.decisionName).toBe('Bot Attack');
      expect(outcome.attack.effectSummary).toContain('Outrage');
      expect(outcome.attack.suggestedGroundName).toBeUndefined();
      // The persisted RAW level still only advances by 1 per dig, same as always — it's
      // only what gets revealed for a given raw level that shifts in a heads-up game.
      expect(outcome.engineStateUpdate.investigations[ATTACK_ID]).toBe(1);
    });

    it('dig 2 adds the suggested lawsuit ground and a success probability', () => {
      const outcome = gameLoop.digDeeper('player-2', ATTACK_ID, makeHeadsUpFixture({ victimInvestigations: { [ATTACK_ID]: 1 } }));

      expect(outcome.success).toBe(true);
      if (!outcome.success) return;
      expect(outcome.attack.investigationLevel).toBe(3);
      expect(outcome.attack.suggestedGroundName).toBe('CFAA Digital Sabotage Lawsuit');
      expect(outcome.attack.successProbability).toBeGreaterThan(0);
    });

    it('dig 3 fails — already fully investigated after only 2 paid digs, no charge', () => {
      const outcome = gameLoop.digDeeper('player-2', ATTACK_ID, makeHeadsUpFixture({ victimInvestigations: { [ATTACK_ID]: 2 } }));

      expect(outcome).toEqual({ success: false, reason: 'already_fully_investigated' });
    });
  });

  describe('chargeLawsuitFilingFee', () => {
    function makeFeeFixture(cash = 100000): EngineDataInput[] {
      return makePlayers([{ id: 'player-1', name: 'Alice', variables: makeVars({ cash }) }]);
    }

    it('charges the flat lawsuitFilingCost and returns the new cash', () => {
      // makeConfig's lawsuitFilingCost is 15000.
      const outcome = gameLoop.chargeLawsuitFilingFee('room-1', 'player-1', makeFeeFixture());

      expect(outcome.success).toBe(true);
      if (!outcome.success) return;
      expect(outcome.cost).toBe(15000);
      expect(outcome.newCash).toBe(85000);
      expect(outcome.variables.cash).toBe(85000);
    });

    it('fails with insufficient_funds and does not charge when cash is below the cost', () => {
      const outcome = gameLoop.chargeLawsuitFilingFee('room-1', 'player-1', makeFeeFixture(5000));

      expect(outcome).toEqual({ success: false, reason: 'insufficient_funds' });
    });

    it('fails with player_not_found for an unknown player', () => {
      const outcome = gameLoop.chargeLawsuitFilingFee('room-1', 'nonexistent', makeFeeFixture());

      expect(outcome).toEqual({ success: false, reason: 'player_not_found' });
    });

    it('fails with limit_reached once this player has already queued maxLawsuitsPerPlayerPerTurn lawsuits this round', () => {
      // makeConfig's maxLawsuitsPerPlayerPerTurn is 3.
      gameLoop.submitDecisions('room-1', 'player-1', {
        strategic: [],
        operational: [],
        lawsuits: [
          { targetId: 'player-2', decisionName: 'New Factory', groundName: 'ground-a' },
          { targetId: 'player-2', decisionName: 'New Factory', groundName: 'ground-b' },
          { targetId: 'player-2', decisionName: 'New Factory', groundName: 'ground-c' },
        ],
      });

      const outcome = gameLoop.chargeLawsuitFilingFee('room-1', 'player-1', makeFeeFixture());

      expect(outcome).toEqual({ success: false, reason: 'limit_reached' });
    });

    it('does not count another player\'s queued lawsuits toward this player\'s limit', () => {
      gameLoop.submitDecisions('room-1', 'player-2', {
        strategic: [],
        operational: [],
        lawsuits: [{ targetId: 'player-1', decisionName: 'New Factory', groundName: 'ground-a' }],
      });

      const outcome = gameLoop.chargeLawsuitFilingFee('room-1', 'player-1', makeFeeFixture());

      expect(outcome.success).toBe(true);
    });

    it('does not carry a room\'s queued-lawsuit count over to a different room', () => {
      gameLoop.submitDecisions('room-1', 'player-1', {
        strategic: [],
        operational: [],
        lawsuits: [
          { targetId: 'player-2', decisionName: 'New Factory', groundName: 'ground-a' },
          { targetId: 'player-2', decisionName: 'New Factory', groundName: 'ground-b' },
          { targetId: 'player-2', decisionName: 'New Factory', groundName: 'ground-c' },
        ],
      });

      const outcome = gameLoop.chargeLawsuitFilingFee('room-2', 'player-1', makeFeeFixture());

      expect(outcome.success).toBe(true);
    });
  });

  describe('makeOffer', () => {
    it('lets the defendant make the opening offer', () => {
      const outcome = gameLoop.makeOffer('player-1', 'case-1', 10000, playersWithCase(makeCase()));

      expect(outcome.success).toBe(true);
      if (!outcome.success) return;
      expect(outcome.case.offers).toEqual([{ by: 'defendant', amount: 10000 }]);
      expect(outcome.case.status).toBe('negotiating');
      // Neither party's cash moves on an offer — only accepting one does.
      expect(outcome.plaintiff.cash).toBeUndefined();
      expect(outcome.defendant.cash).toBeUndefined();
      // Both parties' own persisted copy of the case must carry the new offer.
      expect(outcome.plaintiff.engineState.legalCases[0].offers).toEqual(outcome.case.offers);
      expect(outcome.defendant.engineState.legalCases[0].offers).toEqual(outcome.case.offers);
    });

    it('rejects the plaintiff trying to make the opening offer — the defendant always moves first', () => {
      const outcome = gameLoop.makeOffer('player-2', 'case-1', 10000, playersWithCase(makeCase()));

      expect(outcome).toEqual({ success: false, reason: 'not_your_turn' });
    });

    it('lets the plaintiff counter after the defendant\'s opening offer', () => {
      const case_ = makeCase({ offers: [{ by: 'defendant', amount: 10000 }] });
      const outcome = gameLoop.makeOffer('player-2', 'case-1', 15000, playersWithCase(case_));

      expect(outcome.success).toBe(true);
      if (!outcome.success) return;
      expect(outcome.case.offers).toEqual([
        { by: 'defendant', amount: 10000 },
        { by: 'plaintiff', amount: 15000 },
      ]);
    });

    it('rejects a party trying to counter their own just-made offer', () => {
      const case_ = makeCase({ offers: [{ by: 'defendant', amount: 10000 }] });
      const outcome = gameLoop.makeOffer('player-1', 'case-1', 12000, playersWithCase(case_));

      expect(outcome).toEqual({ success: false, reason: 'not_your_turn' });
    });

    it('rejects an amount above the case\'s stakes', () => {
      const outcome = gameLoop.makeOffer('player-1', 'case-1', 999999, playersWithCase(makeCase({ stakes: 20000 })));

      expect(outcome).toEqual({ success: false, reason: 'invalid_amount' });
    });

    it('rejects a negative amount', () => {
      const outcome = gameLoop.makeOffer('player-1', 'case-1', -1, playersWithCase(makeCase()));

      expect(outcome).toEqual({ success: false, reason: 'invalid_amount' });
    });

    it('allows exactly 0 as the opening offer — the bracket floor is inclusive', () => {
      const outcome = gameLoop.makeOffer('player-1', 'case-1', 0, playersWithCase(makeCase()));

      expect(outcome.success).toBe(true);
    });

    describe('offer bracket narrows with each move (regression)', () => {
      // The valid range for the NEXT offer is always [defendant's own latest offer (0 if
      // none), plaintiff's own latest offer (stakes if none)] — narrowing inward on every
      // move rather than staying fixed at (0, stakes] for the whole negotiation. See
      // GameLoop.computeOfferBracket's doc comment for the full reasoning.
      const stakes = 20000;

      it('bounds the defendant\'s opening offer to [0, stakes]', () => {
        expect(gameLoop.makeOffer('player-1', 'case-1', -1, playersWithCase(makeCase({ stakes }))).success).toBe(false);
        expect(gameLoop.makeOffer('player-1', 'case-1', stakes + 1, playersWithCase(makeCase({ stakes }))).success).toBe(false);
        expect(gameLoop.makeOffer('player-1', 'case-1', 0, playersWithCase(makeCase({ stakes }))).success).toBe(true);
        expect(gameLoop.makeOffer('player-1', 'case-1', stakes, playersWithCase(makeCase({ stakes }))).success).toBe(true);
      });

      it('bounds the plaintiff\'s first counter to [defendant\'s offer, stakes]', () => {
        const case_ = makeCase({ stakes, offers: [{ by: 'defendant', amount: 8000 }] });
        expect(gameLoop.makeOffer('player-2', 'case-1', 7999, playersWithCase(case_)).success).toBe(false);
        expect(gameLoop.makeOffer('player-2', 'case-1', stakes + 1, playersWithCase(case_)).success).toBe(false);
        expect(gameLoop.makeOffer('player-2', 'case-1', 8000, playersWithCase(case_)).success).toBe(true);
        expect(gameLoop.makeOffer('player-2', 'case-1', stakes, playersWithCase(case_)).success).toBe(true);
      });

      it('bounds the defendant\'s second offer to [their own first offer, the plaintiff\'s counter] — NOT [0, stakes]', () => {
        const case_ = makeCase({
          stakes,
          offers: [
            { by: 'defendant', amount: 8000 },
            { by: 'plaintiff', amount: 15000 },
          ],
        });
        // Below the defendant's own first offer — rejected even though it's still > 0.
        expect(gameLoop.makeOffer('player-1', 'case-1', 7999, playersWithCase(case_)).success).toBe(false);
        // Above the plaintiff's counter — rejected even though it's still <= stakes.
        expect(gameLoop.makeOffer('player-1', 'case-1', 15001, playersWithCase(case_)).success).toBe(false);
        // Anywhere between the two latest offers is valid.
        expect(gameLoop.makeOffer('player-1', 'case-1', 8000, playersWithCase(case_)).success).toBe(true);
        expect(gameLoop.makeOffer('player-1', 'case-1', 12000, playersWithCase(case_)).success).toBe(true);
        expect(gameLoop.makeOffer('player-1', 'case-1', 15000, playersWithCase(case_)).success).toBe(true);
      });

      it('bounds the plaintiff\'s second counter to [the defendant\'s latest offer, the plaintiff\'s own first counter]', () => {
        const case_ = makeCase({
          stakes,
          offers: [
            { by: 'defendant', amount: 8000 },
            { by: 'plaintiff', amount: 15000 },
            { by: 'defendant', amount: 10000 },
          ],
        });
        expect(gameLoop.makeOffer('player-2', 'case-1', 9999, playersWithCase(case_)).success).toBe(false);
        expect(gameLoop.makeOffer('player-2', 'case-1', 15001, playersWithCase(case_)).success).toBe(false);
        expect(gameLoop.makeOffer('player-2', 'case-1', 10000, playersWithCase(case_)).success).toBe(true);
        expect(gameLoop.makeOffer('player-2', 'case-1', 15000, playersWithCase(case_)).success).toBe(true);
      });
    });

    it('rejects an offer on a case that has already left negotiation', () => {
      const outcome = gameLoop.makeOffer('player-1', 'case-1', 10000, playersWithCase(makeCase({ status: 'awaiting_trial' })));

      expect(outcome).toEqual({ success: false, reason: 'not_negotiating' });
    });

    it('rejects an unknown case id', () => {
      const outcome = gameLoop.makeOffer('player-1', 'nonexistent-case', 10000, playersWithCase(makeCase()));

      expect(outcome).toEqual({ success: false, reason: 'case_not_found' });
    });

    it('rejects a player who is neither the plaintiff nor the defendant on this case', () => {
      const players = [
        ...playersWithCase(makeCase()),
        ...makePlayers([{ id: 'player-3', name: 'Carol' }]),
      ];
      const outcome = gameLoop.makeOffer('player-3', 'case-1', 10000, players);

      expect(outcome).toEqual({ success: false, reason: 'not_a_party' });
    });
  });

  describe('acceptOffer', () => {
    it('settles the case at the last offer\'s amount, defendant paying plaintiff', () => {
      const case_ = makeCase({ offers: [{ by: 'defendant', amount: 10000 }] });
      const outcome = gameLoop.acceptOffer('player-2', 'case-1', playersWithCase(case_, { 'player-1': 100000, 'player-2': 50000 }));

      expect(outcome.success).toBe(true);
      if (!outcome.success) return;
      expect(outcome.case.status).toBe('resolved');
      expect(outcome.case.verdict).toBe('settled');
      expect(outcome.case.resolvedAt).toBeInstanceOf(Date);
      expect(outcome.defendant.cash).toBe(90000);
      expect(outcome.plaintiff.cash).toBe(60000);
      expect(outcome.defendant.variables?.cash).toBe(90000);
      expect(outcome.plaintiff.variables?.cash).toBe(60000);
      // Both parties' own persisted copy must carry the resolved case.
      expect(outcome.plaintiff.engineState.legalCases[0].status).toBe('resolved');
      expect(outcome.defendant.engineState.legalCases[0].status).toBe('resolved');
    });

    it('rejects the party who made the offer trying to accept their own offer', () => {
      const case_ = makeCase({ offers: [{ by: 'defendant', amount: 10000 }] });
      const outcome = gameLoop.acceptOffer('player-1', 'case-1', playersWithCase(case_));

      expect(outcome).toEqual({ success: false, reason: 'not_your_turn' });
    });

    it('rejects accepting when no offer has been made yet', () => {
      const outcome = gameLoop.acceptOffer('player-2', 'case-1', playersWithCase(makeCase()));

      expect(outcome).toEqual({ success: false, reason: 'no_offer_to_accept' });
    });

    it('accepts the most recent offer after a counter, not an earlier one', () => {
      const case_ = makeCase({
        offers: [
          { by: 'defendant', amount: 10000 },
          { by: 'plaintiff', amount: 15000 },
        ],
      });
      const outcome = gameLoop.acceptOffer('player-1', 'case-1', playersWithCase(case_, { 'player-1': 100000, 'player-2': 50000 }));

      expect(outcome.success).toBe(true);
      if (!outcome.success) return;
      expect(outcome.defendant.cash).toBe(85000);
      expect(outcome.plaintiff.cash).toBe(65000);
    });
  });

  describe('goToCourt', () => {
    it('lets the defendant end negotiation and send the case to trial without a verdict yet', () => {
      const outcome = gameLoop.goToCourt('player-1', 'case-1', playersWithCase(makeCase()));

      expect(outcome.success).toBe(true);
      if (!outcome.success) return;
      expect(outcome.case.status).toBe('awaiting_trial');
      expect(outcome.case.verdict).toBeUndefined();
      expect(outcome.plaintiff.cash).toBeUndefined();
      expect(outcome.defendant.cash).toBeUndefined();
    });

    it('lets the plaintiff end negotiation too — either party can walk away at any time, no turn-gating', () => {
      // Even mid-exchange, with the defendant's offer still awaiting the plaintiff's
      // response, the plaintiff can go straight to court instead of countering/accepting.
      const case_ = makeCase({ offers: [{ by: 'defendant', amount: 10000 }] });
      const outcome = gameLoop.goToCourt('player-2', 'case-1', playersWithCase(case_));

      expect(outcome.success).toBe(true);
      if (!outcome.success) return;
      expect(outcome.case.status).toBe('awaiting_trial');
    });

    it('rejects a case that has already left negotiation', () => {
      const outcome = gameLoop.goToCourt('player-1', 'case-1', playersWithCase(makeCase({ status: 'resolved', verdict: 'settled' })));

      expect(outcome).toEqual({ success: false, reason: 'not_negotiating' });
    });

    it('rejects a player who is neither the plaintiff nor the defendant on this case', () => {
      const players = [
        ...playersWithCase(makeCase()),
        ...makePlayers([{ id: 'player-3', name: 'Carol' }]),
      ];
      const outcome = gameLoop.goToCourt('player-3', 'case-1', players);

      expect(outcome).toEqual({ success: false, reason: 'not_a_party' });
    });
  });

  describe('negotiation turn-boundary fallbacks (Step 8b)', () => {
    it('auto-settles a case with a pending, unanswered offer at the very next turn boundary — the offer is treated as accepted', () => {
      // The defendant offered 10000 last turn; nobody accepted/countered/went to court
      // before this turn resolved. makeConfig's negotiationPeriodTurns is 2 — this must
      // settle on this very first boundary check, not wait for the cap.
      const case_ = makeCase({ offers: [{ by: 'defendant', amount: 10000 }] });
      const withOffer = playersWithCase(case_, { 'player-1': 100000, 'player-2': 50000 });
      // Identical fixture but with no case at all — isolates exactly the settlement's
      // cash effect from everything else a turn's P&L/balance-sheet math also moves,
      // by diffing this run against the one with the pending offer.
      const withoutCase = makePlayers([
        { id: 'player-1', name: 'Alice', variables: makeVars({ cash: 100000 }) },
        { id: 'player-2', name: 'Bob', variables: makeVars({ cash: 50000 }) },
      ]);

      const outcome = gameLoop.resolveTurn('room-1', 2, withOffer);
      const baseline = gameLoop.resolveTurn('room-1', 2, withoutCase);

      const aliceCase = outcome.result.players.find((p) => p.playerId === 'player-1')?.legalCases[0];
      const bobCase = outcome.result.players.find((p) => p.playerId === 'player-2')?.legalCases[0];
      expect(aliceCase?.status).toBe('resolved');
      expect(aliceCase?.verdict).toBe('settled');
      expect(bobCase?.status).toBe('resolved');
      expect(bobCase?.verdict).toBe('settled');

      const aliceCash = outcome.result.players.find((p) => p.playerId === 'player-1')!.variables.cash;
      const bobCash = outcome.result.players.find((p) => p.playerId === 'player-2')!.variables.cash;
      const aliceBaselineCash = baseline.result.players.find((p) => p.playerId === 'player-1')!.variables.cash;
      const bobBaselineCash = baseline.result.players.find((p) => p.playerId === 'player-2')!.variables.cash;

      // Defendant (Alice, player-1) paid the plaintiff (Bob, player-2) exactly the
      // offer amount, on top of whatever the rest of the turn's math already did.
      expect(aliceBaselineCash - aliceCash).toBeCloseTo(10000, 5);
      expect(bobCash - bobBaselineCash).toBeCloseTo(10000, 5);
    });

    it('does not auto-settle a case with no offers yet on its first boundary check — the original negotiationPeriodTurns cap still applies', () => {
      // No offer was ever made — must NOT be settled or forced to trial after just one
      // turn (negotiationPeriodTurns is 2); this is the pre-existing timeout path,
      // unaffected by the new offer-driven settle branch.
      const players = playersWithCase(makeCase());

      const outcome = gameLoop.resolveTurn('room-1', 2, players);

      const aliceCase = outcome.result.players.find((p) => p.playerId === 'player-1')?.legalCases[0];
      expect(aliceCase?.status).toBe('negotiating');
      expect(aliceCase?.turnsNegotiating).toBe(1);
    });
  });

  describe('predictFutureKpis', () => {
    // 'New Factory' (this file's fixture decision, not the real game_engine.json's) has
    // cash: { 1: -30000, default: -30000 } — it keeps draining 30k every year forever
    // once deployed, which makes it a convenient known quantity to isolate.
    function makePredictFixture(aliceCash: number, opts: { withDecision?: boolean; suppressRevenue?: boolean } = {}): EngineDataInput[] {
      const { withDecision = true, suppressRevenue = false } = opts;
      return makePlayers([
        {
          id: 'player-1',
          name: 'Alice',
          // Zeroing out capacityUtilization/installedCapacity drives volume (and so
          // revenue) to ~0, isolating fixed costs (operatingExpenses/staffCost, which
          // apply regardless of production) as the only meaningful cash drain — used
          // by the bankruptcy test below, since this fixture's default economy
          // otherwise grows cash by millions/turn (revenue swamps any single
          // decision's cash-schedule effect, real game_engine.json numbers aside).
          variables: makeVars(suppressRevenue ? { cash: aliceCash, capacityUtilization: 0, installedCapacity: 0 } : { cash: aliceCash }),
          engineState: {
            activeDecisions: withDecision
              ? [{ id: 'inst-1', definitionName: 'New Factory', deployedYear: 1, elapsedYears: 0, isMatured: false }]
              : [],
          },
        },
        { id: 'player-2', name: 'Bob' },
      ]);
    }

    it('keeps the player\'s own already-active decision applying its schedule into every predicted turn', () => {
      // 'Bot Attack' only touches the deploying player's own vars via a flat
      // `cash: -12000/turn` — its other two impact fields are `target.*`, routed to
      // whichever rival is targeted, never back onto the attacker themselves. That
      // makes it a cleanly isolated cash-only effect to compare against an otherwise-
      // identical fixture without it (unlike 'New Factory', whose installedCapacity
      // bump feeds back into volume/revenue and swamps its own cash schedule).
      const withAttack = makePlayers([
        { id: 'player-1', name: 'Alice', variables: makeVars({ cash: 500000 }), engineState: { activeDecisions: [{ id: 'inst-1', definitionName: 'Bot Attack', deployedYear: 1, elapsedYears: 0, isMatured: false, targetId: 'player-2' }] } },
        { id: 'player-2', name: 'Bob' },
      ]);
      const withoutAttack = makePlayers([
        { id: 'player-1', name: 'Alice', variables: makeVars({ cash: 500000 }) },
        { id: 'player-2', name: 'Bob' },
      ]);

      const predictedWithAttack = gameLoop.predictFutureKpis('player-1', 5, withAttack, 3);
      const predictedWithoutAttack = gameLoop.predictFutureKpis('player-1', 5, withoutAttack, 3);

      expect(predictedWithAttack.predicted).toHaveLength(3);
      expect(predictedWithoutAttack.predicted).toHaveLength(3);
      for (let i = 0; i < 3; i++) {
        expect(predictedWithAttack.predicted[i].variables.cash).toBeLessThan(predictedWithoutAttack.predicted[i].variables.cash);
      }
    });

    it('rounds are sequential starting at currentRound + 1', () => {
      const prediction = gameLoop.predictFutureKpis('player-1', 5, makePredictFixture(500000), 3);

      expect(prediction.predicted.map(p => p.round)).toEqual([6, 7, 8]);
    });

    it('stops early and sets bankruptAtRound once the projection would cross negative cash', () => {
      // Revenue suppressed (see makePredictFixture) so fixed costs alone drain this
      // small starting cash negative well within the 3-turn window.
      const prediction = gameLoop.predictFutureKpis('player-1', 1, makePredictFixture(20000, { suppressRevenue: true }), 3);

      expect(prediction.predicted.length).toBeLessThan(3);
      expect(prediction.bankruptAtRound).toBeDefined();
      expect(prediction.bankruptAtRound).toBeGreaterThan(1);
    });

    it('returns no predicted points for an unknown player id', () => {
      const prediction = gameLoop.predictFutureKpis('nonexistent', 5, makePredictFixture(500000), 3);

      expect(prediction).toEqual({ predicted: [] });
    });

    it('never touches the real room\'s in-flight submissions — a queued decision for the real room still applies after a prediction runs', () => {
      gameLoop.submitDecisions('room-1', 'player-1', {
        strategic: [{ name: 'Exclusive Deal' }],
        operational: [],
        lawsuits: [],
      });

      // Run a prediction in between — should not clear or otherwise disturb 'room-1'.
      gameLoop.predictFutureKpis('player-1', 1, makePredictFixture(500000), 3);

      const outcome = gameLoop.resolveTurn('room-1', 1, twoPlayers());
      const alice = outcome.result.players.find(p => p.playerId === 'player-1')!;
      expect(alice.activeDecisions.some(d => d.decisionName === 'Exclusive Deal')).toBe(true);
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
