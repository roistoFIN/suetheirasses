import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GameLoop, type EngineDataInput } from './gameLoop';
import { DEFAULT_FORMULA_SEEDS } from './defaultFormulas';
import { SELF_OWNERSHIP_KEY, EXTERNAL_MARKET_KEY } from './calcEngine';
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
      statuteOfLimitationsYears: 10,
      semaphoreGreenMax: 0.15,
      semaphoreYellowMax: 0.4,
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
      },
      riskGauge: {
        riskWeightLegalExposure_w1: 0.3,
        riskWeightScrutiny_w2: 0.2,
        riskWeightOutrage_w3: 0.25,
        riskWeightOwnership_w4: 0,
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
    defendantInvestigated: false,
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
      {
        decision: 'Buy Shares',
        level: 'Strategic',
        description: 'Buy a block of another company\'s shares',
        nature: 'Grey Area',
        offensiveAction: true,
        excludes: [],
        requiresTarget: true,
        variableAmount: true,
        shareTransactionType: 'buy',
        impacts: {},
        legalRisks: [
          {
            name: 'Breach of Corporate Fiduciary Duty & Raiding Injunction',
            description: 'Sue for the hostile stake acquisition',
            probability: { 1: 0.1, default: 0.08 },
            impact: { type: 'absolute', target: 'cash', schedule: { default: -35000 } },
          },
        ],
        legalRiskConditions: { minPercentAcquiredInSingleTransaction: 0.05 },
      },
      {
        decision: 'Sell Shares',
        level: 'Strategic',
        description: 'Sell held shares back to the external market',
        nature: 'Traditional',
        offensiveAction: false,
        excludes: [],
        requiresTarget: true,
        variableAmount: true,
        shareTransactionType: 'sell',
        impacts: {},
        legalRisks: [],
      },
      {
        decision: 'Share Issuance',
        level: 'Strategic',
        description: 'Issue new equity to the market',
        nature: 'Traditional',
        offensiveAction: false,
        excludes: [],
        impacts: {
          cash: { type: 'absolute', schedule: { 1: 150000, default: 0 } },
          sharesAmount: { type: 'absolute', schedule: { 1: 5000, default: 0 } },
        },
        legalRisks: [],
      },
      {
        decision: 'Risky Fundraising',
        level: 'Operational',
        description: 'Raise cash through a legally dubious scheme (relative-type legal-risk fixture)',
        nature: 'Dirty',
        offensiveAction: false,
        excludes: [],
        impacts: {
          cash: { type: 'absolute', schedule: { 1: 100000, default: 0 } },
        },
        legalRisks: [
          {
            name: 'Fraudulent Capital Procurement',
            description: 'Sue over the fraudulent fundraising scheme',
            probability: { 1: 0.3, default: 0.75 },
            impact: { type: 'relative', target: 'equity', schedule: { 1: -0.15, default: -0.45 } },
          },
          {
            name: 'Unfair Competition via Fundraising',
            description: 'Sue over the resulting unfair competitive advantage',
            probability: { 1: 0.1, default: 0.4 },
            impact: { type: 'relative', target: 'revenue', schedule: { 1: -0.1, default: -0.4 } },
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

    it('carries a target-bearing decision\'s targetId through to the client-facing activeDecisions entry (regression)', () => {
      // ActiveDecisionInstance used to have no targetId at all — the client's "Active
      // Decisions" box had no way to show/sort by who a player's own decision targeted,
      // even though the underlying deployed instance always tracked it.
      gameLoop.submitDecisions('room-1', 'player-1', {
        strategic: [],
        operational: [{ name: 'Bot Attack', targetId: 'player-2' }, { name: 'Quality Certification' }],
        lawsuits: [],
      });

      const outcome = gameLoop.resolveTurn('room-1', 1, twoPlayers());
      const activeDecisions = outcome.result.players[0].activeDecisions;

      expect(activeDecisions.find((d) => d.decisionName === 'Bot Attack')?.targetId).toBe('player-2');
      // A decision with no target concept at all carries no targetId, not an empty string.
      expect(activeDecisions.find((d) => d.decisionName === 'Quality Certification')?.targetId).toBeUndefined();
    });

    it('does not silently drop a later turn\'s decisions just because an earlier turn already used the same-level per-turn budget (regression)', () => {
      // A real, reported bug: canDeploy used to re-derive "how many decisions of this
      // level does this player have" from the player's ENTIRE historical
      // engineState.activeDecisions list (never pruned — matured decisions stay forever),
      // making the "max N per turn" check a lifetime cap in practice. Turn 1 here uses
      // the full strategic (2) and operational (3) budget this room's config allows —
      // completely normal play, not an edge case. Turn 2 then submits ONE more decision
      // of each level; both used to be silently dropped (canDeploy rejected them, so
      // processNewDecisions just `continue`d past them with no error, no active decision
      // created, and no trace left anywhere) even though they're entirely new decisions,
      // unrelated to anything deployed in turn 1.
      gameLoop.submitDecisions('room-1', 'player-1', {
        strategic: [{ name: 'New Factory' }, { name: 'Share Issuance' }],
        operational: [{ name: 'Quality Certification' }, { name: 'Water Pumping' }],
        lawsuits: [],
      });
      const outcome1 = gameLoop.resolveTurn('room-1', 1, twoPlayers());
      const aliceUpdate1 = outcome1.companyUpdates.find((u) => u.playerId === 'player-1')!;
      expect(outcome1.result.players[0].activeDecisions.map((d) => d.decisionName).sort()).toEqual(
        ['New Factory', 'Quality Certification', 'Share Issuance', 'Water Pumping'].sort(),
      );

      const players2 = makePlayers([
        { id: 'player-1', name: 'Alice', variables: aliceUpdate1.variables, engineState: aliceUpdate1.engineState },
        { id: 'player-2', name: 'Bob' },
      ]);
      gameLoop.submitDecisions('room-1', 'player-1', {
        strategic: [{ name: 'Buy Shares' }],
        operational: [{ name: 'Bot Attack', targetId: 'player-2' }],
        lawsuits: [],
      });
      const outcome2 = gameLoop.resolveTurn('room-1', 2, players2);

      const aliceNames = outcome2.result.players.find((p) => p.playerId === 'player-1')!.activeDecisions.map((d) => d.decisionName);
      expect(aliceNames).toContain('Buy Shares');
      expect(aliceNames).toContain('Bot Attack');
      // The other player must see the effect too — Bot Attack targets them, so it should
      // show up as an incoming attack, not just silently vanish for both parties.
      const bobIncoming = outcome2.result.players.find((p) => p.playerId === 'player-2')!.incomingAttacks;
      expect(bobIncoming.length).toBeGreaterThan(0);
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

    it('should broadcast an indirect-effect hint (a non-targeted, legalRisks-bearing decision) to EVERY other active player, not just one', () => {
      // Water Pumping has no target.* impacts at all — nobody is "the target" of it —
      // but it does carry legalRisks (weight-fraud suits), so it should still surface
      // as an incoming-attacks-style hint, just to everyone rather than one victim.
      gameLoop.submitDecisions('room-1', 'player-1', {
        strategic: [], operational: [{ name: 'Water Pumping' }], lawsuits: [],
      });

      const outcome = gameLoop.resolveTurn('room-1', 1, makePlayers([
        { id: 'player-1', name: 'Alice' },
        { id: 'player-2', name: 'Bob' },
        { id: 'player-3', name: 'Carol' },
      ]));
      const alice = outcome.result.players.find((p) => p.playerId === 'player-1')!;
      const bob = outcome.result.players.find((p) => p.playerId === 'player-2')!;
      const carol = outcome.result.players.find((p) => p.playerId === 'player-3')!;

      for (const rival of [bob, carol]) {
        expect(rival.incomingAttacks).toHaveLength(1);
        expect(rival.incomingAttacks[0].isIndirect).toBe(true);
        expect(rival.incomingAttacks[0].investigationLevel).toBe(0);
        // Un-investigated (3 active players, no heads-up shortcut) — nothing revealed yet.
        expect(rival.incomingAttacks[0].attackerId).toBeUndefined();
      }
      // Alice deployed it, so it's not "incoming" to herself.
      expect(alice.incomingAttacks).toHaveLength(0);
    });

    it('should NOT surface a hint at all for a decision with neither target.* impacts nor any legalRisks', () => {
      // New Factory (this test file's fixture definition, not the real game data) has
      // no target.* impacts and no legalRisks — nothing to reveal or sue over, so it's
      // neither a direct nor an indirect hint, just silent.
      gameLoop.submitDecisions('room-1', 'player-1', {
        strategic: [{ name: 'New Factory' }], operational: [], lawsuits: [],
      });

      const outcome = gameLoop.resolveTurn('room-1', 1, twoPlayers());
      const bob = outcome.result.players.find((p) => p.playerId === 'player-2')!;

      expect(bob.incomingAttacks).toHaveLength(0);
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

    it('should force baseProbability to 0 for a CORRECT ground once the target\'s decision instance is past the statute of limitations (makeConfig: 10 years)', () => {
      // Unlike the wrong-guess test above, Alice genuinely deployed Water Pumping — the
      // ground is real, just too old to sue over (elapsedYears already at the 10-year cap).
      const players = makePlayers([
        { id: 'player-1', name: 'Alice', engineState: { activeDecisions: [{ id: 'wp-1', definitionName: 'Water Pumping', deployedYear: 1, elapsedYears: 10, isMatured: true }] } },
        { id: 'player-2', name: 'Bob' },
      ]);
      gameLoop.submitDecisions('room-1', 'player-2', {
        strategic: [], operational: [],
        lawsuits: [{ targetId: 'player-1', decisionName: 'Water Pumping', groundName: 'Environmental Violation' }],
      });

      const outcome = gameLoop.resolveTurn('room-1', 11, players);

      const aliceCases = outcome.result.players.find((p) => p.playerId === 'player-1')?.legalCases;
      expect(aliceCases).toHaveLength(1);
      expect(aliceCases![0].groundName).toBe('Environmental Violation');
      expect(aliceCases![0].baseProbability).toBe(0);
    });

    it('should still price a real, non-zero probability for a correct ground just under the statute of limitations', () => {
      // Step 2 (advanceAndApply) increments elapsedYears BEFORE Step 8 reads it for
      // filing, so an instance that's 8 years old entering this turn is 9 by the time
      // the lawsuit is priced — still one year under makeConfig's 10-year cap.
      const players = makePlayers([
        { id: 'player-1', name: 'Alice', engineState: { activeDecisions: [{ id: 'wp-1', definitionName: 'Water Pumping', deployedYear: 1, elapsedYears: 8, isMatured: true }] } },
        { id: 'player-2', name: 'Bob' },
      ]);
      gameLoop.submitDecisions('room-1', 'player-2', {
        strategic: [], operational: [],
        lawsuits: [{ targetId: 'player-1', decisionName: 'Water Pumping', groundName: 'Environmental Violation' }],
      });

      const outcome = gameLoop.resolveTurn('room-1', 10, players);

      const aliceCases = outcome.result.players.find((p) => p.playerId === 'player-1')?.legalCases;
      expect(aliceCases![0].baseProbability).toBeGreaterThan(0);
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

      it('should also stamp plaintiffFullyInvestigated true for an INDIRECT decision (no targetId at all) fully dug in before suing the right ground', () => {
        // Water Pumping never sets targetId — the old lookup (d.targetId === ctx.playerId)
        // could never match it, so this path used to be structurally impossible to earn
        // regardless of investigation depth. Alice deploys it this same turn; Bob (an
        // otherwise-uninvolved bystander here, not Water Pumping's "victim" — it has none)
        // fully investigates it and sues over the real suggested ground.
        gameLoop.submitDecisions('room-1', 'player-1', {
          strategic: [], operational: [{ name: 'Water Pumping' }], lawsuits: [],
        });

        // First turn: deploy Water Pumping and capture its freshly generated instance id.
        const deployOutcome = gameLoop.resolveTurn('room-1', 1, withBotAttack());
        const wpInstance = deployOutcome.result.players
          .find((p) => p.playerId === 'player-1')!.activeDecisions
          .find((d) => d.decisionName === 'Water Pumping')!;

        // Second turn: Bob is already fully dug into that specific instance, and sues
        // over its real suggested ground.
        const persistedAlice = deployOutcome.companyUpdates.find((u) => u.playerId === 'player-1')!;
        gameLoop.submitDecisions('room-1', 'player-2', {
          strategic: [], operational: [],
          lawsuits: [{ targetId: 'player-1', decisionName: 'Water Pumping', groundName: 'Environmental Violation' }],
        });
        const players2 = makePlayers([
          { id: 'player-1', name: 'Alice', variables: persistedAlice.variables, engineState: persistedAlice.engineState },
          { id: 'player-2', name: 'Bob', engineState: { investigations: { [wpInstance.id]: 3 } } },
          { id: 'player-3', name: 'Carol' },
        ]);
        const outcome2 = gameLoop.resolveTurn('room-1', 2, players2);

        const bobCase = outcome2.result.players.find((p) => p.playerId === 'player-2')?.legalCases[0];
        expect(bobCase?.plaintiffFullyInvestigated).toBe(true);
      });
    });
  });

  describe('resolveTurn — relative-type legal-risk stakes are priced off the defendant\'s own current field, not the raw schedule fraction (regression)', () => {
    // A real, reported bug: a `relative`-type legal risk's schedule value is a fraction
    // (e.g. -0.45), meant to be scaled against the defendant's own current value of
    // `impact.target` (equity/revenue) — not read as a raw dollar figure the way an
    // `absolute`-type risk's schedule already is. Reading it as a raw figure silently
    // produced stakes like 0.45, which rounds to display as "$0" everywhere stakes are
    // shown (the settlement offer bracket, the "You paid/received" trial-outcome line).
    it('prices an equity-relative ground off the defendant\'s own turn-computed equity, not the raw schedule fraction', () => {
      gameLoop.submitDecisions('room-1', 'player-1', {
        strategic: [], operational: [{ name: 'Risky Fundraising' }], lawsuits: [],
      });
      gameLoop.submitDecisions('room-1', 'player-2', {
        strategic: [], operational: [],
        lawsuits: [{ targetId: 'player-1', decisionName: 'Risky Fundraising', groundName: 'Fraudulent Capital Procurement' }],
      });

      const outcome = gameLoop.resolveTurn('room-1', 1, twoPlayers());

      const aliceEquity = outcome.result.players.find((p) => p.playerId === 'player-1')!.derived.equity;
      const aliceCase = outcome.result.players.find((p) => p.playerId === 'player-1')!.legalCases[0];
      // Stakes always use the default schedule value regardless of elapsedYears — same
      // "not time-scaled the way probability is" convention absolute-type grounds already
      // follow (see the Environmental Violation test below, unaffected by this fix).
      expect(aliceCase.stakes).toBeCloseTo(aliceEquity * 0.45, 4);
      expect(aliceCase.stakes).toBeGreaterThan(1); // sanity check against the bug's sub-$1 output
    });

    it('prices a revenue-relative ground off the defendant\'s own turn-computed revenue, not the raw schedule fraction', () => {
      gameLoop.submitDecisions('room-1', 'player-1', {
        strategic: [], operational: [{ name: 'Risky Fundraising' }], lawsuits: [],
      });
      gameLoop.submitDecisions('room-1', 'player-2', {
        strategic: [], operational: [],
        lawsuits: [{ targetId: 'player-1', decisionName: 'Risky Fundraising', groundName: 'Unfair Competition via Fundraising' }],
      });

      const outcome = gameLoop.resolveTurn('room-1', 1, twoPlayers());

      const aliceRevenue = outcome.result.players.find((p) => p.playerId === 'player-1')!.derived.revenue;
      const aliceCase = outcome.result.players.find((p) => p.playerId === 'player-1')!.legalCases[0];
      expect(aliceCase.stakes).toBeCloseTo(aliceRevenue * 0.4, 4);
      expect(aliceCase.stakes).toBeGreaterThan(1);
    });

    it('still prices an absolute-type ground (e.g. Environmental Violation) exactly as before, unaffected by the relative-type fix', () => {
      gameLoop.submitDecisions('room-1', 'player-1', {
        strategic: [], operational: [{ name: 'Water Pumping' }], lawsuits: [],
      });
      gameLoop.submitDecisions('room-1', 'player-2', {
        strategic: [], operational: [],
        lawsuits: [{ targetId: 'player-1', decisionName: 'Water Pumping', groundName: 'Environmental Violation' }],
      });

      const outcome = gameLoop.resolveTurn('room-1', 1, twoPlayers());

      const aliceCase = outcome.result.players.find((p) => p.playerId === 'player-1')!.legalCases[0];
      expect(aliceCase.stakes).toBe(22050);
    });
  });

  describe('resolveTurn — lawsuit voids the sued decision (regression)', () => {
    /** Alice deploys Water Pumping (permanent -50/year materialCostPerTon effect,
     * matures instantly since it has only a 'default' schedule key) in turn 1; Bob
     * sues over it the same turn. Advances two more turns so the case crosses
     * makeConfig's negotiationPeriodTurns (2) and is forced to trial, resolving in
     * that same third turn — the same sequence as the "should force a case to
     * trial..." test above. Returns the players array for that third, trial-resolving
     * call so each test can control the verdict via Math.random. */
    function fileAndForceToTrial() {
      gameLoop.submitDecisions('room-1', 'player-1', {
        strategic: [], operational: [{ name: 'Water Pumping' }], lawsuits: [],
      });
      gameLoop.submitDecisions('room-1', 'player-2', {
        strategic: [], operational: [],
        lawsuits: [{ targetId: 'player-1', decisionName: 'Water Pumping', groundName: 'Environmental Violation' }],
      });
      const outcome1 = gameLoop.resolveTurn('room-1', 1, twoPlayers());
      const aliceUpdate1 = outcome1.companyUpdates.find(u => u.playerId === 'player-1')!;
      const bobUpdate1 = outcome1.companyUpdates.find(u => u.playerId === 'player-2')!;

      const players2 = makePlayers([
        { id: 'player-1', name: 'Alice', variables: aliceUpdate1.variables, engineState: aliceUpdate1.engineState },
        { id: 'player-2', name: 'Bob', variables: bobUpdate1.variables, engineState: bobUpdate1.engineState },
      ]);
      const outcome2 = gameLoop.resolveTurn('room-1', 2, players2);
      const aliceUpdate2 = outcome2.companyUpdates.find(u => u.playerId === 'player-1')!;
      const bobUpdate2 = outcome2.companyUpdates.find(u => u.playerId === 'player-2')!;

      const players3 = makePlayers([
        { id: 'player-1', name: 'Alice', variables: aliceUpdate2.variables, engineState: aliceUpdate2.engineState },
        { id: 'player-2', name: 'Bob', variables: bobUpdate2.variables, engineState: bobUpdate2.engineState },
      ]);
      return players3;
    }

    it('should void the sued instance when the plaintiff wins at trial — cancels forthcoming effects, matures it immediately, and frees it for redeployment', () => {
      const players3 = fileAndForceToTrial();

      const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0); // Math.random() < adjProb is always true → plaintiff wins
      const outcome3 = gameLoop.resolveTurn('room-1', 3, players3);
      randomSpy.mockRestore();

      const alice3 = outcome3.result.players.find((p) => p.playerId === 'player-1')!;
      expect(alice3.legalCases[0].verdict).toBe('won');

      const wpInstance3 = alice3.activeDecisions.find((d) => d.decisionName === 'Water Pumping')!;
      expect(wpInstance3.isMatured).toBe(true);
      expect(wpInstance3.voidedByLawsuit).toBe(true);

      // Forthcoming effects are cancelled — materialCostPerTon must not move again on
      // the very next turn (Water Pumping's -50/year would otherwise keep applying
      // forever, since it only has a 'default' schedule key).
      const aliceUpdate3 = outcome3.companyUpdates.find((u) => u.playerId === 'player-1')!;
      const players4 = makePlayers([
        { id: 'player-1', name: 'Alice', variables: aliceUpdate3.variables, engineState: aliceUpdate3.engineState },
        { id: 'player-2', name: 'Bob' },
      ]);
      const outcome4 = gameLoop.resolveTurn('room-1', 4, players4);
      const alice4 = outcome4.result.players.find((p) => p.playerId === 'player-1')!;
      expect(alice4.variables.materialCostPerTon).toBe(alice3.variables.materialCostPerTon);

      // The decision is now redeployable — canDeploy no longer blocks it now that its
      // only matured instance was voided rather than a successful completion.
      const aliceUpdate4 = outcome4.companyUpdates.find((u) => u.playerId === 'player-1')!;
      gameLoop.submitDecisions('room-1', 'player-1', {
        strategic: [], operational: [{ name: 'Water Pumping' }], lawsuits: [],
      });
      const players5 = makePlayers([
        { id: 'player-1', name: 'Alice', variables: aliceUpdate4.variables, engineState: aliceUpdate4.engineState },
        { id: 'player-2', name: 'Bob' },
      ]);
      const outcome5 = gameLoop.resolveTurn('room-1', 5, players5);
      const alice5 = outcome5.result.players.find((p) => p.playerId === 'player-1')!;
      expect(alice5.activeDecisions.filter((d) => d.decisionName === 'Water Pumping')).toHaveLength(2);
    });

    it('should NOT void the sued instance when the defendant wins at trial', () => {
      const players3 = fileAndForceToTrial();

      const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.999); // Math.random() < adjProb is always false → defendant wins
      const outcome3 = gameLoop.resolveTurn('room-1', 3, players3);
      randomSpy.mockRestore();

      const alice3 = outcome3.result.players.find((p) => p.playerId === 'player-1')!;
      expect(alice3.legalCases[0].verdict).toBe('lost');

      const wpInstance3 = alice3.activeDecisions.find((d) => d.decisionName === 'Water Pumping')!;
      expect(wpInstance3.voidedByLawsuit).toBe(false);
    });

    it('should void the sued instance when an unanswered offer auto-settles at a turn boundary (Step 8b)', () => {
      gameLoop.submitDecisions('room-1', 'player-1', {
        strategic: [], operational: [{ name: 'Water Pumping' }], lawsuits: [],
      });
      gameLoop.submitDecisions('room-1', 'player-2', {
        strategic: [], operational: [],
        lawsuits: [{ targetId: 'player-1', decisionName: 'Water Pumping', groundName: 'Environmental Violation' }],
      });
      const outcome1 = gameLoop.resolveTurn('room-1', 1, twoPlayers());
      const aliceUpdate1 = outcome1.companyUpdates.find((u) => u.playerId === 'player-1')!;
      const bobUpdate1 = outcome1.companyUpdates.find((u) => u.playerId === 'player-2')!;
      const caseId = aliceUpdate1.engineState.legalCases[0].id;

      // The defendant (Alice) makes an offer out-of-band — nobody responds before the
      // next turn boundary, so Step 8b treats the standing offer as accepted.
      const offerPlayers = makePlayers([
        { id: 'player-1', name: 'Alice', variables: aliceUpdate1.variables, engineState: aliceUpdate1.engineState },
        { id: 'player-2', name: 'Bob', variables: bobUpdate1.variables, engineState: bobUpdate1.engineState },
      ]);
      const offerOutcome = gameLoop.makeOffer('player-1', caseId, 5000, offerPlayers);
      expect(offerOutcome.success).toBe(true);
      if (!offerOutcome.success) return;

      const players2 = makePlayers([
        { id: 'player-1', name: 'Alice', variables: aliceUpdate1.variables, engineState: offerOutcome.defendant.engineState },
        { id: 'player-2', name: 'Bob', variables: bobUpdate1.variables, engineState: offerOutcome.plaintiff.engineState },
      ]);
      const outcome2 = gameLoop.resolveTurn('room-1', 2, players2);

      const alice2 = outcome2.result.players.find((p) => p.playerId === 'player-1')!;
      const case2 = alice2.legalCases[0];
      expect(case2.status).toBe('resolved');
      expect(case2.verdict).toBe('settled');

      const wpInstance2 = alice2.activeDecisions.find((d) => d.decisionName === 'Water Pumping')!;
      expect(wpInstance2.isMatured).toBe(true);
      expect(wpInstance2.voidedByLawsuit).toBe(true);
    });
  });

  describe('resolveTurn — a permanent effect naturally expires at the statute of limitations (regression)', () => {
    it('stops applying New Factory\'s permanent installedCapacity effect once it ages past makeConfig\'s statuteOfLimitationsYears (10), and frees it for redeployment', () => {
      const players = makePlayers([
        {
          id: 'player-1', name: 'Alice',
          variables: makeVars({ installedCapacity: 20000 }),
          engineState: { activeDecisions: [{ id: 'nf-1', definitionName: 'New Factory', deployedYear: 1, elapsedYears: 9, isMatured: true }] },
        },
        { id: 'player-2', name: 'Bob' },
      ]);

      const outcome = gameLoop.resolveTurn('room-1', 11, players);
      const alice = outcome.result.players.find((p) => p.playerId === 'player-1')!;

      // elapsedYears becomes 10 this turn — at the statute — so New Factory's permanent
      // +5000/turn installedCapacity effect no longer applies (it would have, pre-feature).
      expect(alice.variables.installedCapacity).toBe(20000);

      const nfInstance = alice.activeDecisions.find((d) => d.decisionName === 'New Factory')!;
      expect(nfInstance.elapsedYears).toBe(10);
      expect(nfInstance.isMatured).toBe(true);
      expect(nfInstance.voidedByLawsuit).toBe(false); // expired naturally, not sued over

      // And it's now redeployable — canDeploy no longer blocks it.
      const aliceUpdate = outcome.companyUpdates.find((u) => u.playerId === 'player-1')!;
      gameLoop.submitDecisions('room-1', 'player-1', { strategic: [{ name: 'New Factory' }], operational: [], lawsuits: [] });
      const players2 = makePlayers([
        { id: 'player-1', name: 'Alice', variables: aliceUpdate.variables, engineState: aliceUpdate.engineState },
        { id: 'player-2', name: 'Bob' },
      ]);
      const outcome2 = gameLoop.resolveTurn('room-1', 12, players2);
      const alice2 = outcome2.result.players.find((p) => p.playerId === 'player-1')!;
      expect(alice2.activeDecisions.filter((d) => d.decisionName === 'New Factory')).toHaveLength(2);
    });

    it('still blocks redeployment while the instance is younger than the statute of limitations', () => {
      const players = makePlayers([
        { id: 'player-1', name: 'Alice', engineState: { activeDecisions: [{ id: 'nf-1', definitionName: 'New Factory', deployedYear: 1, elapsedYears: 8, isMatured: true }] } },
        { id: 'player-2', name: 'Bob' },
      ]);
      gameLoop.submitDecisions('room-1', 'player-1', { strategic: [{ name: 'New Factory' }], operational: [], lawsuits: [] });

      const outcome = gameLoop.resolveTurn('room-1', 10, players);
      const alice = outcome.result.players.find((p) => p.playerId === 'player-1')!;
      expect(alice.activeDecisions.filter((d) => d.decisionName === 'New Factory')).toHaveLength(1);
    });
  });

  describe('resolveTurn — one lawsuit per decision instance, ever (regression)', () => {
    it('gives the first plaintiff a real case and a same-turn second plaintiff a hopeless (0%) one, first come first served', () => {
      gameLoop.submitDecisions('room-1', 'player-1', {
        strategic: [], operational: [{ name: 'Water Pumping' }], lawsuits: [],
      });
      gameLoop.submitDecisions('room-1', 'player-2', {
        strategic: [], operational: [],
        lawsuits: [{ targetId: 'player-1', decisionName: 'Water Pumping', groundName: 'Environmental Violation' }],
      });
      gameLoop.submitDecisions('room-1', 'player-3', {
        strategic: [], operational: [],
        lawsuits: [{ targetId: 'player-1', decisionName: 'Water Pumping', groundName: 'Environmental Violation' }],
      });
      const players = makePlayers([
        { id: 'player-1', name: 'Alice' },
        { id: 'player-2', name: 'Bob' },
        { id: 'player-3', name: 'Carol' },
      ]);

      const outcome = gameLoop.resolveTurn('room-1', 1, players);
      const aliceCases = outcome.result.players.find((p) => p.playerId === 'player-1')!.legalCases;
      expect(aliceCases).toHaveLength(2);

      const bobCase = aliceCases.find((c) => c.plaintiffId === 'player-2')!;
      const carolCase = aliceCases.find((c) => c.plaintiffId === 'player-3')!;
      expect(bobCase.baseProbability).toBeGreaterThan(0);
      expect(bobCase.defendantDecisionInstanceId).toBeDefined();
      expect(carolCase.baseProbability).toBe(0);
      expect(carolCase.defendantDecisionInstanceId).toBeUndefined();
    });

    it('keeps blocking a second lawsuit against the same instance even after the first case resolves and drops out of legalCases history', () => {
      gameLoop.submitDecisions('room-1', 'player-1', {
        strategic: [], operational: [{ name: 'Water Pumping' }], lawsuits: [],
      });
      gameLoop.submitDecisions('room-1', 'player-2', {
        strategic: [], operational: [],
        lawsuits: [{ targetId: 'player-1', decisionName: 'Water Pumping', groundName: 'Environmental Violation' }],
      });
      const outcome1 = gameLoop.resolveTurn('room-1', 1, twoPlayers());
      const originalCaseId = outcome1.companyUpdates.find((u) => u.playerId === 'player-1')!.engineState.legalCases[0].id;
      let aliceUpdate = outcome1.companyUpdates.find((u) => u.playerId === 'player-1')!;
      let bobUpdate = outcome1.companyUpdates.find((u) => u.playerId === 'player-2')!;

      const players2 = makePlayers([
        { id: 'player-1', name: 'Alice', variables: aliceUpdate.variables, engineState: aliceUpdate.engineState },
        { id: 'player-2', name: 'Bob', variables: bobUpdate.variables, engineState: bobUpdate.engineState },
      ]);
      const outcome2 = gameLoop.resolveTurn('room-1', 2, players2);
      aliceUpdate = outcome2.companyUpdates.find((u) => u.playerId === 'player-1')!;
      bobUpdate = outcome2.companyUpdates.find((u) => u.playerId === 'player-2')!;

      // Forced to trial this turn (negotiationPeriodTurns crossed) — force a defendant win
      // (verdict 'lost') so the instance stays un-voided, isolating the everSued mechanism
      // from the separate lawsuit-voiding one tested elsewhere.
      const players3 = makePlayers([
        { id: 'player-1', name: 'Alice', variables: aliceUpdate.variables, engineState: aliceUpdate.engineState },
        { id: 'player-2', name: 'Bob', variables: bobUpdate.variables, engineState: bobUpdate.engineState },
      ]);
      const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.999);
      const outcome3 = gameLoop.resolveTurn('room-1', 3, players3);
      randomSpy.mockRestore();
      const alice3 = outcome3.result.players.find((p) => p.playerId === 'player-1')!;
      expect(alice3.legalCases[0].verdict).toBe('lost');
      expect(alice3.activeDecisions.find((d) => d.decisionName === 'Water Pumping')!.voidedByLawsuit).toBe(false);
      aliceUpdate = outcome3.companyUpdates.find((u) => u.playerId === 'player-1')!;
      bobUpdate = outcome3.companyUpdates.find((u) => u.playerId === 'player-2')!;

      // One more turn — the resolved case drops out of persisted engineState.legalCases
      // entirely (the pre-existing "resolved cases are transient" behavior).
      const players4 = makePlayers([
        { id: 'player-1', name: 'Alice', variables: aliceUpdate.variables, engineState: aliceUpdate.engineState },
        { id: 'player-2', name: 'Bob', variables: bobUpdate.variables, engineState: bobUpdate.engineState },
      ]);
      const outcome4 = gameLoop.resolveTurn('room-1', 4, players4);
      aliceUpdate = outcome4.companyUpdates.find((u) => u.playerId === 'player-1')!;
      bobUpdate = outcome4.companyUpdates.find((u) => u.playerId === 'player-2')!;
      expect(aliceUpdate.engineState.legalCases.find((c) => c.id === originalCaseId)).toBeUndefined();

      // A fresh lawsuit against the same still-live (not voided) instance must still be
      // hopeless — the instance itself remembers it was already sued, independent of
      // whether the original case is still visible in anyone's persisted history.
      gameLoop.submitDecisions('room-1', 'player-2', {
        strategic: [], operational: [],
        lawsuits: [{ targetId: 'player-1', decisionName: 'Water Pumping', groundName: 'Environmental Violation' }],
      });
      const players5 = makePlayers([
        { id: 'player-1', name: 'Alice', variables: aliceUpdate.variables, engineState: aliceUpdate.engineState },
        { id: 'player-2', name: 'Bob', variables: bobUpdate.variables, engineState: bobUpdate.engineState },
      ]);
      const outcome5 = gameLoop.resolveTurn('room-1', 5, players5);
      const newCase = outcome5.result.players.find((p) => p.playerId === 'player-1')!.legalCases[0];
      expect(newCase.baseProbability).toBe(0);
      expect(newCase.defendantDecisionInstanceId).toBeUndefined();
    });

    it('allows suing a freshly redeployed instance of the same decision name — the block is per instance, not per name', () => {
      gameLoop.submitDecisions('room-1', 'player-1', {
        strategic: [], operational: [{ name: 'Water Pumping' }], lawsuits: [],
      });
      gameLoop.submitDecisions('room-1', 'player-2', {
        strategic: [], operational: [],
        lawsuits: [{ targetId: 'player-1', decisionName: 'Water Pumping', groundName: 'Environmental Violation' }],
      });
      const outcome1 = gameLoop.resolveTurn('room-1', 1, twoPlayers());
      let aliceUpdate = outcome1.companyUpdates.find((u) => u.playerId === 'player-1')!;
      let bobUpdate = outcome1.companyUpdates.find((u) => u.playerId === 'player-2')!;

      const players2 = makePlayers([
        { id: 'player-1', name: 'Alice', variables: aliceUpdate.variables, engineState: aliceUpdate.engineState },
        { id: 'player-2', name: 'Bob', variables: bobUpdate.variables, engineState: bobUpdate.engineState },
      ]);
      const outcome2 = gameLoop.resolveTurn('room-1', 2, players2);
      aliceUpdate = outcome2.companyUpdates.find((u) => u.playerId === 'player-1')!;
      bobUpdate = outcome2.companyUpdates.find((u) => u.playerId === 'player-2')!;

      // Force a plaintiff win this turn — voids the original instance and frees it for
      // redeployment (the separate lawsuit-voiding feature tested elsewhere).
      const players3 = makePlayers([
        { id: 'player-1', name: 'Alice', variables: aliceUpdate.variables, engineState: aliceUpdate.engineState },
        { id: 'player-2', name: 'Bob', variables: bobUpdate.variables, engineState: bobUpdate.engineState },
      ]);
      const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);
      const outcome3 = gameLoop.resolveTurn('room-1', 3, players3);
      randomSpy.mockRestore();
      aliceUpdate = outcome3.companyUpdates.find((u) => u.playerId === 'player-1')!;
      bobUpdate = outcome3.companyUpdates.find((u) => u.playerId === 'player-2')!;

      // Redeploy Water Pumping (allowed now the old instance is voided) and sue the NEW
      // instance in the very same turn.
      gameLoop.submitDecisions('room-1', 'player-1', {
        strategic: [], operational: [{ name: 'Water Pumping' }], lawsuits: [],
      });
      gameLoop.submitDecisions('room-1', 'player-2', {
        strategic: [], operational: [],
        lawsuits: [{ targetId: 'player-1', decisionName: 'Water Pumping', groundName: 'Environmental Violation' }],
      });
      const players4 = makePlayers([
        { id: 'player-1', name: 'Alice', variables: aliceUpdate.variables, engineState: aliceUpdate.engineState },
        { id: 'player-2', name: 'Bob', variables: bobUpdate.variables, engineState: bobUpdate.engineState },
      ]);
      const outcome4 = gameLoop.resolveTurn('room-1', 4, players4);
      const alice4 = outcome4.result.players.find((p) => p.playerId === 'player-1')!;
      expect(alice4.activeDecisions.filter((d) => d.decisionName === 'Water Pumping')).toHaveLength(2);
      expect(alice4.legalCases).toHaveLength(1);
      expect(alice4.legalCases[0].baseProbability).toBeGreaterThan(0);
    });
  });

  describe('resolveTurn — Buy/Sell Shares (share-ownership & takeover mechanic)', () => {
    // Fresh objects every call — GameLoop reads `company.variables` by reference
    // (no internal clone), so reusing one binding across two independent resolveTurn
    // calls in the same test (e.g. a baseline-vs-actual comparison) would let the first
    // call's mutations leak into the second's "starting" fixture.
    const makeTargetVars = (overrides: Partial<PlayerVariables> = {}) => makeVars({
      cash: 50000, totalSharesOutstanding: 10000, stockValue: 10,
      shareOwnership: { [SELF_OWNERSHIP_KEY]: 1.0 }, ...overrides,
    });
    const makeBuyerVars = (overrides: Partial<PlayerVariables> = {}) => makeVars({ cash: 100000, ...overrides });

    it('dilutes the target pro-rata and pays cash to the diluted owner', () => {
      const baseline = gameLoop.resolveTurn('room-baseline', 1, makePlayers([
        { id: 'player-1', name: 'Alice', variables: makeTargetVars() },
        { id: 'player-2', name: 'Bob', variables: makeBuyerVars() },
      ]));
      const baselineAlice = baseline.result.players.find((p) => p.playerId === 'player-1')!;
      const baselineBob = baseline.result.players.find((p) => p.playerId === 'player-2')!;

      gameLoop.submitDecisions('room-1', 'player-2', {
        strategic: [{ name: 'Buy Shares', targetId: 'player-1', amount: 20000 }], operational: [], lawsuits: [],
      });
      const outcome = gameLoop.resolveTurn('room-1', 1, makePlayers([
        { id: 'player-1', name: 'Alice', variables: makeTargetVars() },
        { id: 'player-2', name: 'Bob', variables: makeBuyerVars() },
      ]));
      const alice = outcome.result.players.find((p) => p.playerId === 'player-1')!;
      const bob = outcome.result.players.find((p) => p.playerId === 'player-2')!;

      // 20000 / stockValue(10) = 2000 shares of 10000 total = 20%.
      expect(alice.variables.shareOwnership[SELF_OWNERSHIP_KEY]).toBeCloseTo(0.8, 4);
      expect(alice.variables.shareOwnership['player-2']).toBeCloseTo(0.2, 4);

      // Isolate the transaction's cash effect from everything else a turn's P&L also
      // moves (same technique CLAUDE.md's Bot Attack regression test uses).
      expect(bob.variables.cash - baselineBob.variables.cash).toBeCloseTo(-20000, 2);
      expect(alice.variables.cash - baselineAlice.variables.cash).toBeCloseTo(4000, 2);
    });

    it('self-buyback reclaims a stake from EXTERNAL_MARKET without paying itself', () => {
      const vars = makeTargetVars({
        cash: 50000,
        shareOwnership: { [SELF_OWNERSHIP_KEY]: 0.6, [EXTERNAL_MARKET_KEY]: 0.4 },
      });
      gameLoop.submitDecisions('room-1', 'player-1', {
        strategic: [{ name: 'Buy Shares', targetId: 'player-1', amount: 20000 }], operational: [], lawsuits: [],
      });
      const outcome = gameLoop.resolveTurn('room-1', 1, makePlayers([
        { id: 'player-1', name: 'Alice', variables: vars },
      ]));
      const alice = outcome.result.players.find((p) => p.playerId === 'player-1')!;

      // fractionBought = 20000/10/10000 = 0.2. Founder's own 0.6 dilutes to 0.48, then
      // gains the full 0.2 back on top (self-targeting is the same buyer key as the
      // diluted "self" row) -> 0.68. EXTERNAL_MARKET dilutes from 0.4 to 0.32.
      expect(alice.variables.shareOwnership[SELF_OWNERSHIP_KEY]).toBeCloseTo(0.68, 4);
      expect(alice.variables.shareOwnership[EXTERNAL_MARKET_KEY]).toBeCloseTo(0.32, 4);
      // A single player was loaded — if self-buyback incorrectly tried to pay "itself"
      // as a separate diluted owner, this would double-count into a cash change beyond
      // just the "-20000 spent" side; can't isolate cleanly without a baseline here, but
      // the ownership math above is the real proof the self-referential leg netted to zero.
    });

    it('Sell Shares returns shares to EXTERNAL_MARKET only, never pro-rata to other players', () => {
      const vars = makeTargetVars({
        cash: 10000,
        shareOwnership: { [SELF_OWNERSHIP_KEY]: 0.7, [EXTERNAL_MARKET_KEY]: 0.3 },
      });
      const baseline = gameLoop.resolveTurn('room-baseline', 1, makePlayers([{ id: 'player-1', name: 'Alice', variables: makeTargetVars({ cash: 10000, shareOwnership: { [SELF_OWNERSHIP_KEY]: 0.7, [EXTERNAL_MARKET_KEY]: 0.3 } }) }]));
      const baselineAlice = baseline.result.players.find((p) => p.playerId === 'player-1')!;

      gameLoop.submitDecisions('room-1', 'player-1', {
        strategic: [{ name: 'Sell Shares', targetId: 'player-1', amount: 15000 }], operational: [], lawsuits: [],
      });
      const outcome = gameLoop.resolveTurn('room-1', 1, makePlayers([{ id: 'player-1', name: 'Alice', variables: vars }]));
      const alice = outcome.result.players.find((p) => p.playerId === 'player-1')!;

      // fractionSold = 15000/10/10000 = 0.15.
      expect(alice.variables.shareOwnership[SELF_OWNERSHIP_KEY]).toBeCloseTo(0.55, 4);
      expect(alice.variables.shareOwnership[EXTERNAL_MARKET_KEY]).toBeCloseTo(0.45, 4);
      expect(alice.variables.cash - baselineAlice.variables.cash).toBeCloseTo(15000, 2);
    });

    it('caps a Sell Shares sale at the current value of the actual holding', () => {
      const vars = makeTargetVars({ shareOwnership: { [SELF_OWNERSHIP_KEY]: 0.1, [EXTERNAL_MARKET_KEY]: 0.9 } });
      // Holding value = 0.1 * 10000 shares * $10 = $10,000 — request far more than that.
      gameLoop.submitDecisions('room-1', 'player-1', {
        strategic: [{ name: 'Sell Shares', targetId: 'player-1', amount: 500000 }], operational: [], lawsuits: [],
      });
      const outcome = gameLoop.resolveTurn('room-1', 1, makePlayers([{ id: 'player-1', name: 'Alice', variables: vars }]));
      const alice = outcome.result.players.find((p) => p.playerId === 'player-1')!;

      expect(alice.variables.shareOwnership[SELF_OWNERSHIP_KEY]).toBeCloseTo(0, 4);
      expect(alice.variables.shareOwnership[EXTERNAL_MARKET_KEY]).toBeCloseTo(1, 4);
    });

    it('resolves two same-target Buy Shares purchases in submission-arrival order (FIFO) — the second computes against the first\'s already-diluted cap table', () => {
      const vars = makeTargetVars();
      gameLoop.submitDecisions('room-1', 'player-2', {
        strategic: [{ name: 'Buy Shares', targetId: 'player-1', amount: 50000 }], operational: [], lawsuits: [],
      });
      gameLoop.submitDecisions('room-1', 'player-3', {
        strategic: [{ name: 'Buy Shares', targetId: 'player-1', amount: 50000 }], operational: [], lawsuits: [],
      });

      const outcome = gameLoop.resolveTurn('room-1', 1, makePlayers([
        { id: 'player-1', name: 'Alice', variables: vars },
        { id: 'player-2', name: 'Bob', variables: makeBuyerVars() },
        { id: 'player-3', name: 'Carol', variables: makeBuyerVars() },
      ]));
      const alice = outcome.result.players.find((p) => p.playerId === 'player-1')!;

      // Both buy the same fixed 50% of TOTAL shares outstanding (fractionBought is
      // always sharesBought/totalShares, independent of who currently holds what) — but
      // applied SEQUENTIALLY, each purchase dilutes EVERY existing holder at that moment,
      // including any earlier buyer. Bob (first) starts by diluting only "self" (0.5/0.5
      // split). Carol (second) then dilutes BOTH existing holders — self and Bob — by
      // another 50%, landing self=0.25, Bob=0.25, Carol=0.5. This is the correct,
      // intentional consequence of "always pro-rata from ALL current owners" applied
      // in strict arrival order, not a bug — a later buyer of the same size
      // ends up proportionally larger, since they dilute every earlier buyer too.
      expect(alice.variables.shareOwnership[SELF_OWNERSHIP_KEY]).toBeCloseTo(0.25, 4);
      expect(alice.variables.shareOwnership['player-2']).toBeCloseTo(0.25, 4);
      expect(alice.variables.shareOwnership['player-3']).toBeCloseTo(0.5, 4);
      const total = Object.values(alice.variables.shareOwnership).reduce((s, v) => s + v, 0);
      expect(total).toBeCloseTo(1, 4);
    });

    it('applies a resubmit-but-unrelated-change without resetting an already-queued Buy Shares entry\'s FIFO timestamp', () => {
      // player-2 queues Buy Shares first, then (still before the turn resolves) submits
      // an unrelated second decision — the full-replacement submission architecture means
      // this resends player-2's ENTIRE pending state, but Buy Shares' own timestamp must
      // stay pinned to when IT was first queued, not reset to "now".
      gameLoop.submitDecisions('room-1', 'player-2', {
        strategic: [{ name: 'Buy Shares', targetId: 'player-1', amount: 50000 }], operational: [], lawsuits: [],
      });
      gameLoop.submitDecisions('room-1', 'player-3', {
        strategic: [{ name: 'Buy Shares', targetId: 'player-1', amount: 50000 }], operational: [], lawsuits: [],
      });
      // player-2 touches something unrelated — full-replacement resend of their whole
      // submission, Buy Shares entry included verbatim.
      gameLoop.submitDecisions('room-1', 'player-2', {
        strategic: [{ name: 'Buy Shares', targetId: 'player-1', amount: 50000 }], operational: [{ name: 'Quality Certification' }], lawsuits: [],
      });

      const outcome = gameLoop.resolveTurn('room-1', 1, makePlayers([
        { id: 'player-1', name: 'Alice', variables: makeTargetVars() },
        { id: 'player-2', name: 'Bob', variables: makeBuyerVars() },
        { id: 'player-3', name: 'Carol', variables: makeBuyerVars() },
      ]));
      const alice = outcome.result.players.find((p) => p.playerId === 'player-1')!;

      // If player-2's resubmit had wrongly reset their Buy Shares timestamp to "now"
      // (after player-3's), the two buyers' resulting fractions would be swapped —
      // whichever result actually matches "Bob still resolved first" (same numbers as
      // the FIFO ordering test above) proves the timestamp survived the unrelated resubmit.
      expect(alice.variables.shareOwnership['player-2']).toBeCloseTo(0.25, 4);
      expect(alice.variables.shareOwnership['player-3']).toBeCloseTo(0.5, 4);
    });

    it('classifies Buy Shares as a direct attack (not broadcast to everyone) despite having no target.* impacts (isIndirectEffect regression)', () => {
      gameLoop.submitDecisions('room-1', 'player-2', {
        strategic: [{ name: 'Buy Shares', targetId: 'player-1', amount: 20000 }], operational: [], lawsuits: [],
      });
      gameLoop.submitDecisions('room-1', 'player-3', { strategic: [], operational: [], lawsuits: [] });

      const outcome = gameLoop.resolveTurn('room-1', 1, makePlayers([
        { id: 'player-1', name: 'Alice', variables: makeTargetVars() },
        { id: 'player-2', name: 'Bob', variables: makeBuyerVars() },
        { id: 'player-3', name: 'Carol', variables: makeVars() },
      ]));
      const alice = outcome.result.players.find((p) => p.playerId === 'player-1')!;
      const carol = outcome.result.players.find((p) => p.playerId === 'player-3')!;

      expect(alice.incomingAttacks).toHaveLength(1);
      expect(alice.incomingAttacks[0].isIndirect).toBe(false);
      expect(alice.incomingAttacks[0].decisionName === undefined || alice.incomingAttacks[0].decisionName === undefined).toBe(true); // not yet dug into
      // Carol was never the target — Buy Shares must not broadcast to her the way a
      // genuinely indirect (no-target) decision like Water Pumping would.
      expect(carol.incomingAttacks).toHaveLength(0);
    });

    it('cannot be sued over once the acquisition fraction falls short of legalRiskConditions.minPercentAcquiredInSingleTransaction', () => {
      gameLoop.submitDecisions('room-1', 'player-2', {
        // 1000 / 10 / 10000 = 1% — below the fixture's 5% minPercentAcquiredInSingleTransaction.
        strategic: [{ name: 'Buy Shares', targetId: 'player-1', amount: 1000 }], operational: [], lawsuits: [],
      });
      const outcome1 = gameLoop.resolveTurn('room-1', 1, makePlayers([
        { id: 'player-1', name: 'Alice', variables: makeTargetVars() },
        { id: 'player-2', name: 'Bob', variables: makeBuyerVars() },
      ]));
      const aliceUpdate1 = outcome1.companyUpdates.find((u) => u.playerId === 'player-1')!;
      const bobUpdate1 = outcome1.companyUpdates.find((u) => u.playerId === 'player-2')!;

      gameLoop.submitDecisions('room-1', 'player-1', {
        strategic: [], operational: [],
        lawsuits: [{ targetId: 'player-2', decisionName: 'Buy Shares', groundName: 'Breach of Corporate Fiduciary Duty & Raiding Injunction' }],
      });
      const outcome2 = gameLoop.resolveTurn('room-1', 2, makePlayers([
        { id: 'player-1', name: 'Alice', variables: aliceUpdate1.variables, engineState: aliceUpdate1.engineState },
        { id: 'player-2', name: 'Bob', variables: bobUpdate1.variables, engineState: bobUpdate1.engineState },
      ]));
      const bobCase = outcome2.result.players.find((p) => p.playerId === 'player-2')!.legalCases[0];

      expect(bobCase.baseProbability).toBe(0);
    });
  });

  describe('resolveTurn — majority-ownership takeover elimination', () => {
    it('eliminates the target once an acquirer crosses 50%, reusing the bankruptcy case waterfall to pay off open cases against the eliminated player', () => {
      const targetVars = makeVars({
        cash: 20000, totalSharesOutstanding: 10000, stockValue: 10,
        shareOwnership: { [SELF_OWNERSHIP_KEY]: 0.55, 'player-3': 0.45 },
      });
      // player-3 already holds a case against player-1 (the target) that should be paid
      // from the waterfall pool exactly like a bankruptcy would pay it.
      const existingCase: LegalCaseData = {
        id: 'case-1', roomId: 'room-1', plaintiffId: 'player-3', defendantId: 'player-1',
        decisionName: 'Water Pumping', groundName: 'Environmental Violation', description: 'x',
        baseProbability: 0.5, adjustedProbability: undefined, plaintiffFullyInvestigated: false,
        defendantInvestigated: false, stakes: 5000, status: 'negotiating', offers: [], turnsNegotiating: 0,
        verdict: undefined, createdAt: new Date('2024-01-01'), resolvedAt: undefined,
      };

      gameLoop.submitDecisions('room-1', 'player-2', {
        // 60000/10/10000 = 60% — crosses the 50% threshold, on top of the existing 45%
        // held by player-3 (a different acquirer — only ONE acquirer can be found; the
        // buyer here, player-2, is the one who ends up over 50%).
        strategic: [{ name: 'Buy Shares', targetId: 'player-1', amount: 60000 }], operational: [], lawsuits: [],
      });

      const outcome = gameLoop.resolveTurn('room-1', 1, makePlayers([
        { id: 'player-1', name: 'Alice', variables: targetVars, engineState: { legalCases: [existingCase] } },
        { id: 'player-2', name: 'Bob', variables: makeVars({ cash: 200000 }) },
        { id: 'player-3', name: 'Carol', variables: makeVars(), engineState: { legalCases: [existingCase] } },
      ]));

      expect(outcome.result.players.find((p) => p.playerId === 'player-1')).toBeUndefined();
      expect(outcome.result.gameOver).toBe(false); // player-3 (and the acquirer) still active
      const merged = outcome.bankruptedPlayers.find((b) => b.playerId === 'player-1')!;
      expect(merged.reason).toBe('merger');
      expect(merged.acquirerId).toBe('player-2');
      // A merger elimination gets the same final-snapshot capture as a bankruptcy —
      // both reasons flow through the same buildFinalSnapshot call.
      expect(merged.finalVariables).toBeDefined();
      expect(merged.finalDerived).toBeDefined();
      expect(typeof merged.finalRiskGauge).toBe('number');

      // Carol's case against Alice gets paid from the waterfall pool, same as a bankruptcy would.
      const carol = outcome.result.players.find((p) => p.playerId === 'player-3')!;
      expect(carol.legalCases[0].status).toBe('resolved');
      expect(carol.variables.cash).toBeGreaterThan(makeVars().cash); // received a payout
    });

    it('transfers the eliminated company\'s cash/assets/intangibleAssets to the acquirer', () => {
      const targetVars = makeVars({
        cash: 20000, assets: 80000, intangibleAssets: 5000,
        totalSharesOutstanding: 10000, stockValue: 10,
        shareOwnership: { [SELF_OWNERSHIP_KEY]: 1.0 },
      });
      const buyerVars = makeVars({ cash: 200000, assets: 10000, intangibleAssets: 1000 });

      gameLoop.submitDecisions('room-1', 'player-2', {
        strategic: [{ name: 'Buy Shares', targetId: 'player-1', amount: 60000 }], operational: [], lawsuits: [],
      });

      const outcome = gameLoop.resolveTurn('room-1', 1, makePlayers([
        { id: 'player-1', name: 'Alice', variables: targetVars },
        { id: 'player-2', name: 'Bob', variables: buyerVars },
      ]));
      const merged = outcome.bankruptedPlayers.find((b) => b.playerId === 'player-1')!;
      const bob = outcome.result.players.find((p) => p.playerId === 'player-2')!;

      // Bob's own assets/intangibleAssets grew by (at least) Alice's contributed values —
      // not an exact equality since Bob's own turn P&L/depreciation also move these fields,
      // but the eliminated company's finalCash/assets/intangibleAssets were all positive
      // contributions on top of whatever Bob's own turn produced.
      expect(merged.finalCash).toBeGreaterThan(0);
      expect(bob.variables.assets).toBeGreaterThanOrEqual(targetVars.assets + 10000 - 1000); // generous slack for Bob's own depreciation this turn
      expect(bob.variables.intangibleAssets).toBeGreaterThanOrEqual(targetVars.intangibleAssets + 1000 - 100);
    });

    it('does not complete a takeover if the prospective acquirer is bankrupt the same turn', () => {
      // Zero production (installedCapacity/capacityUtilization: 0) on BOTH players
      // suppresses volume/revenue entirely, so each player's cash change this turn is
      // just fixed costs — small and predictable — never enough to flip a deeply
      // negative or comfortably positive starting cash to the other sign.
      const targetVars = makeVars({
        cash: 500000, installedCapacity: 0, capacityUtilization: 0,
        totalSharesOutstanding: 10000, stockValue: 10,
        shareOwnership: { [SELF_OWNERSHIP_KEY]: 0.4, 'player-2': 0.6 },
      });
      // Bob (the would-be acquirer) is deeply insolvent this turn regardless of Alice.
      const buyerVars = makeVars({ cash: -500000, installedCapacity: 0, capacityUtilization: 0 });

      const outcome = gameLoop.resolveTurn('room-1', 1, makePlayers([
        { id: 'player-1', name: 'Alice', variables: targetVars },
        { id: 'player-2', name: 'Bob', variables: buyerVars },
      ]));

      const bankruptedIds = outcome.bankruptedPlayers.map((b) => b.playerId);
      expect(bankruptedIds).toContain('player-2');
      expect(bankruptedIds).not.toContain('player-1');
      // Alice survives — Bob's >50% stake never gets to trigger her elimination.
      expect(outcome.result.players.find((p) => p.playerId === 'player-1')).toBeDefined();
    });

    it('sweeps an eliminated player\'s cross-holdings in other, still-active companies back to EXTERNAL_MARKET', () => {
      // player-2 (going bankrupt this turn) holds a 30% cross-stake in player-3's company.
      const survivorVars = makeVars({
        cash: 500000, installedCapacity: 0, capacityUtilization: 0,
        shareOwnership: { [SELF_OWNERSHIP_KEY]: 0.7, 'player-2': 0.3 },
      });
      const bankruptVars = makeVars({ cash: -100000, installedCapacity: 0, capacityUtilization: 0 });

      const outcome = gameLoop.resolveTurn('room-1', 1, makePlayers([
        { id: 'player-2', name: 'Bob', variables: bankruptVars },
        { id: 'player-3', name: 'Carol', variables: survivorVars },
      ]));

      expect(outcome.bankruptedPlayers.map((b) => b.playerId)).toContain('player-2');
      const carol = outcome.result.players.find((p) => p.playerId === 'player-3')!;
      expect(carol.variables.shareOwnership['player-2']).toBeUndefined();
      expect(carol.variables.shareOwnership[EXTERNAL_MARKET_KEY]).toBeCloseTo(0.3, 4);
      expect(carol.variables.shareOwnership[SELF_OWNERSHIP_KEY]).toBeCloseTo(0.7, 4);

      // BankruptedPlayer must also carry a full final snapshot — persistKpiSnapshots
      // (the caller) excludes eliminated players from its normal per-turn write, so this
      // is the only place a bankrupted player's true end-of-game KPI numbers come from
      // (see CLAUDE.md's game-timeline section).
      const bob = outcome.bankruptedPlayers.find((b) => b.playerId === 'player-2')!;
      expect(bob.finalVariables.cash).toBeLessThan(0);
      expect(bob.finalDerived).toEqual(
        expect.objectContaining({
          equity: expect.any(Number),
          revenue: expect.any(Number),
          stockValue: expect.any(Number),
          marketShare: expect.any(Number),
        }),
      );
      expect(typeof bob.finalRiskGauge).toBe('number');
      expect(bob.finalRiskGauge).toBeGreaterThanOrEqual(0);
    });

    // Regression for the dead-config bug fixed alongside the Risk Gauge's ownership-risk
    // term: the elimination check used to hardcode `> 0.5` directly, ignoring
    // `adminVariables.ownership.takeoverThresholdPercent` even though it was seeded,
    // validated, and admin-editable the whole time. Confirms an admin-lowered threshold
    // actually takes effect on the real elimination trigger, not just on the gauge.
    it('honors an admin-configured takeoverThresholdPercent below 50%', () => {
      gameLoop.updateConfig({ ...config, adminVariables: { ...config.adminVariables, ownership: { takeoverThresholdPercent: 0.3 } } });

      const targetVars = makeVars({
        cash: 500000, installedCapacity: 0, capacityUtilization: 0,
        // Only 35% held by player-2 — would NOT trigger at the default 50% threshold,
        // but does at the admin-configured 30%.
        shareOwnership: { [SELF_OWNERSHIP_KEY]: 0.65, 'player-2': 0.35 },
      });
      const buyerVars = makeVars({ cash: 200000, installedCapacity: 0, capacityUtilization: 0 });

      const outcome = gameLoop.resolveTurn('room-1', 1, makePlayers([
        { id: 'player-1', name: 'Alice', variables: targetVars },
        { id: 'player-2', name: 'Bob', variables: buyerVars },
      ]));

      const merged = outcome.bankruptedPlayers.find((b) => b.playerId === 'player-1');
      expect(merged?.reason).toBe('merger');
      expect(merged?.acquirerId).toBe('player-2');
    });

    it('does not trigger at 35% under the default 50% threshold (control for the test above)', () => {
      const targetVars = makeVars({
        cash: 500000, installedCapacity: 0, capacityUtilization: 0,
        shareOwnership: { [SELF_OWNERSHIP_KEY]: 0.65, 'player-2': 0.35 },
      });
      const buyerVars = makeVars({ cash: 200000, installedCapacity: 0, capacityUtilization: 0 });

      const outcome = gameLoop.resolveTurn('room-1', 1, makePlayers([
        { id: 'player-1', name: 'Alice', variables: targetVars },
        { id: 'player-2', name: 'Bob', variables: buyerVars },
      ]));

      expect(outcome.bankruptedPlayers.find((b) => b.playerId === 'player-1')).toBeUndefined();
      expect(outcome.result.players.find((p) => p.playerId === 'player-1')).toBeDefined();
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
    function makeAttackFixture(overrides: { victimCash?: number; victimInvestigations?: Record<string, number>; attackerElapsedYears?: number } = {}): EngineDataInput[] {
      return makePlayers([
        {
          id: 'player-1',
          name: 'Alice',
          engineState: {
            activeDecisions: [
              { id: ATTACK_ID, definitionName: 'Bot Attack', deployedYear: 1, elapsedYears: overrides.attackerElapsedYears ?? 0, isMatured: true, targetId: 'player-2' },
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

    it('dig 3 still names a suggested ground but quotes 0% once the attack is past the statute of limitations (makeConfig: 10 years)', () => {
      const outcome = gameLoop.digDeeper('player-2', ATTACK_ID, makeAttackFixture({ victimInvestigations: { [ATTACK_ID]: 2 }, attackerElapsedYears: 10 }));

      expect(outcome.success).toBe(true);
      if (!outcome.success) return;
      expect(outcome.attack.suggestedGroundName).toBe('CFAA Digital Sabotage Lawsuit');
      expect(outcome.attack.successProbability).toBe(0);
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

  describe('digDeeper — indirect effects (no target.* impacts, just legalRisks)', () => {
    // Water Pumping has no targetId concept at all — Alice deploys it for her own
    // benefit, and it's Bob (or anyone else active) digging into background market
    // activity, not investigating a personal attack. Carol keeps this non-heads-up,
    // matching the direct-attack digDeeper describe block above.
    const WATER_PUMPING_ID = 'wp-1';
    function makeIndirectFixture(overrides: { investigatorInvestigations?: Record<string, number> } = {}): EngineDataInput[] {
      return makePlayers([
        {
          id: 'player-1',
          name: 'Alice',
          engineState: {
            activeDecisions: [
              { id: WATER_PUMPING_ID, definitionName: 'Water Pumping', deployedYear: 1, elapsedYears: 0, isMatured: false },
            ],
          },
        },
        {
          id: 'player-2',
          name: 'Bob',
          variables: makeVars({ cash: 100000 }),
          engineState: { investigations: overrides.investigatorInvestigations ?? {} },
        },
        { id: 'player-3', name: 'Carol' },
      ]);
    }

    it('dig 1 reveals only the deployer\'s identity, same as a direct attack', () => {
      const outcome = gameLoop.digDeeper('player-2', WATER_PUMPING_ID, makeIndirectFixture());

      expect(outcome.success).toBe(true);
      if (!outcome.success) return;
      expect(outcome.attack.isIndirect).toBe(true);
      expect(outcome.attack.investigationLevel).toBe(1);
      expect(outcome.attack.attackerId).toBe('player-1');
      expect(outcome.attack.attackerName).toBe('Alice');
      expect(outcome.attack.decisionName).toBeUndefined();
    });

    it('dig 2 summarizes the deployer\'s OWN effects (there is no target.* effect to summarize)', () => {
      const outcome = gameLoop.digDeeper('player-2', WATER_PUMPING_ID, makeIndirectFixture({ investigatorInvestigations: { [WATER_PUMPING_ID]: 1 } }));

      expect(outcome.success).toBe(true);
      if (!outcome.success) return;
      expect(outcome.attack.investigationLevel).toBe(2);
      expect(outcome.attack.decisionName).toBe('Water Pumping');
      expect(outcome.attack.effectSummary).toContain('Material Cost Per Ton');
      expect(outcome.attack.suggestedGroundName).toBeUndefined();
    });

    it('dig 3 adds the suggested lawsuit ground and a success probability, same mechanism as a direct attack', () => {
      const outcome = gameLoop.digDeeper('player-2', WATER_PUMPING_ID, makeIndirectFixture({ investigatorInvestigations: { [WATER_PUMPING_ID]: 2 } }));

      expect(outcome.success).toBe(true);
      if (!outcome.success) return;
      expect(outcome.attack.investigationLevel).toBe(3);
      expect(outcome.attack.suggestedGroundName).toBe('Environmental Violation');
      expect(outcome.attack.successProbability).toBeGreaterThan(0);
    });

    it('lets any other active player dig in, not just a single "victim" (there is none)', () => {
      // Carol digs instead of Bob — should work exactly the same, since indirect
      // effects have no single target to gate digging by.
      const outcome = gameLoop.digDeeper('player-3', WATER_PUMPING_ID, makePlayers([
        { id: 'player-1', name: 'Alice', engineState: { activeDecisions: [{ id: WATER_PUMPING_ID, definitionName: 'Water Pumping', deployedYear: 1, elapsedYears: 0, isMatured: false }] } },
        { id: 'player-2', name: 'Bob' },
        { id: 'player-3', name: 'Carol', variables: makeVars({ cash: 100000 }) },
      ]));

      expect(outcome.success).toBe(true);
      if (!outcome.success) return;
      expect(outcome.attack.attackerId).toBe('player-1');
    });

    it('fails with invalid_attack — the deployer cannot dig into their own indirect decision', () => {
      const outcome = gameLoop.digDeeper('player-1', WATER_PUMPING_ID, makeIndirectFixture());

      expect(outcome).toEqual({ success: false, reason: 'invalid_attack' });
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

  describe('digDeeperOnCase', () => {
    // Fixture: plaintiffId 'player-2', defendantId 'player-1' (see makeCase).
    it('charges the defendant digDeeperCost and reveals the odds by flipping defendantInvestigated', () => {
      const case_ = makeCase({ defendantInvestigated: false });
      const outcome = gameLoop.digDeeperOnCase('player-1', 'case-1', playersWithCase(case_, { 'player-1': 100000, 'player-2': 50000 }));

      expect(outcome.success).toBe(true);
      if (!outcome.success) return;
      expect(outcome.case.defendantInvestigated).toBe(true);
      expect(outcome.defendant.cash).toBe(90000);
      expect(outcome.defendant.variables?.cash).toBe(90000);
      // The plaintiff's own persisted copy carries the updated flag too, but their cash
      // never moves — this is a defendant-only cost.
      expect(outcome.plaintiff.cash).toBeUndefined();
      expect(outcome.plaintiff.engineState.legalCases[0].defendantInvestigated).toBe(true);
      expect(outcome.defendant.engineState.legalCases[0].defendantInvestigated).toBe(true);
    });

    it('rejects the plaintiff trying to dig deeper on their own filed case', () => {
      const outcome = gameLoop.digDeeperOnCase('player-2', 'case-1', playersWithCase(makeCase()));

      expect(outcome).toEqual({ success: false, reason: 'not_defendant' });
    });

    it('rejects a case already investigated', () => {
      const case_ = makeCase({ defendantInvestigated: true });
      const outcome = gameLoop.digDeeperOnCase('player-1', 'case-1', playersWithCase(case_));

      expect(outcome).toEqual({ success: false, reason: 'already_investigated' });
    });

    it('rejects the defendant when they cannot afford digDeeperCost', () => {
      const case_ = makeCase();
      const outcome = gameLoop.digDeeperOnCase('player-1', 'case-1', playersWithCase(case_, { 'player-1': 5000 }));

      expect(outcome).toEqual({ success: false, reason: 'insufficient_funds' });
    });

    it('rejects an unknown case id', () => {
      const outcome = gameLoop.digDeeperOnCase('player-1', 'no-such-case', playersWithCase(makeCase()));

      expect(outcome).toEqual({ success: false, reason: 'case_not_found' });
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

    it('does not keep re-applying an already-matured decision\'s effect into future predicted turns (regression — a decision\'s own effect lands once, at maturity, then holds)', () => {
      // 'Bot Attack' only touches the deploying player's own vars via a flat, instant-
      // maturity `cash: -12000` (no explicit schedule years — its other two impact fields
      // are `target.*`, routed to whichever rival is targeted, never back onto the
      // attacker themselves). In real play that -12000 lands exactly once, at deployment
      // (Step 1's applyImpactsForYear call) — by the time an instance like this sits in
      // engineState at isMatured:true, its one-time cost has already happened and is
      // already baked into whatever cash value is persisted alongside it; nothing further
      // should ever come from it again, in a real turn or in a sandboxed prediction. This
      // used to assert the opposite (`toBeLessThan`, an ever-widening gap) — a real,
      // reported finding from a randomized-play simulation that a matured decision's
      // 'default' effect was being re-applied every single subsequent turn forever
      // (bounded only by the statute of limitations) instead of landing once and holding.
      const withAttack = makePlayers([
        { id: 'player-1', name: 'Alice', variables: makeVars({ cash: 500000 }), engineState: { activeDecisions: [{ id: 'inst-1', definitionName: 'Bot Attack', deployedYear: 1, elapsedYears: 0, isMatured: true, targetId: 'player-2' }] } },
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
        expect(predictedWithAttack.predicted[i].variables.cash).toBeCloseTo(predictedWithoutAttack.predicted[i].variables.cash, 5);
      }
    });

    it('keeps applying a still-maturing decision\'s remaining schedule into predicted turns, but stops for good once it matures', () => {
      // 'New Factory' (this file's fixture) has cash: {1: -30000, default: -30000} — a
      // one-year-explicit-then-permanent schedule, maturity threshold 1 — deployed fresh
      // (elapsedYears 0, not yet matured). suppressRevenue pins capacityUtilization at 0
      // for the whole prediction (nothing in this fixture's New Factory ever changes
      // capacityUtilization), which pins maxSupply/volume/revenue at 0 regardless of
      // installedCapacity's own growth — isolating New Factory's direct cash-schedule
      // effect from the revenue-side confound its installedCapacity bump would otherwise
      // introduce (see makePredictFixture's own doc comment on why New Factory normally
      // "swamps its own cash schedule").
      const withDecision = makePredictFixture(500000, { withDecision: true, suppressRevenue: true });
      const withoutDecision = makePredictFixture(500000, { withDecision: false, suppressRevenue: true });

      const predictedWith = gameLoop.predictFutureKpis('player-1', 5, withDecision, 3);
      const predictedWithout = gameLoop.predictFutureKpis('player-1', 5, withoutDecision, 3);

      // Predicted turn 1 (elapsedYears 0->1, exactly at the maturity threshold): the
      // 'default' cash value is consulted for the first time here — the gap opens up.
      const gapTurn1 = predictedWithout.predicted[0].variables.cash - predictedWith.predicted[0].variables.cash;
      expect(gapTurn1).toBeCloseTo(30000, 1);

      // Predicted turns 2 and 3 (elapsedYears 1->2, 2->3: both past the threshold): no
      // further cash is drained by this instance — the gap must not keep growing.
      const gapTurn2 = predictedWithout.predicted[1].variables.cash - predictedWith.predicted[1].variables.cash;
      const gapTurn3 = predictedWithout.predicted[2].variables.cash - predictedWith.predicted[2].variables.cash;
      expect(gapTurn2).toBeCloseTo(gapTurn1, 1);
      expect(gapTurn3).toBeCloseTo(gapTurn1, 1);
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
