import { describe, it, expect } from 'vitest';
import { DecisionEngine, hasPermanentEffect, pickBestGround, meetsLegalRiskConditions, type DeployedDecision } from './decisionEngine';
import type { DecisionDefinition, PlayerVariables, AdminVariables } from '@suetheirasses/shared';
import { buildFormulaSet } from './formulaEngine';
import { DEFAULT_FORMULA_SEEDS } from './defaultFormulas';

const DEFAULT_FORMULAS = buildFormulaSet(DEFAULT_FORMULA_SEEDS);

function makeAdmin(overrides: Partial<AdminVariables> = {}): AdminVariables {
  return {
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
      riskWeightSolvency_w5: 0,
    },
    ownership: {
      takeoverThresholdPercent: 0.5,
    },
    depreciation: {
      assetUsefulLifeYears: 10,
      intangibleUsefulLifeYears: 5,
    },
    ...overrides,
  };
}

// ── Helpers ──────────────────────────────────────────────────

function makeDecisionDef(overrides: Partial<DecisionDefinition> = {}): DecisionDefinition {
  return {
    decision: 'Test Decision',
    level: 'Strategic',
    description: 'A test decision',
    nature: 'Traditional',
    offensiveAction: false,
    excludes: [],
    impacts: {
      processingLevel: {
        type: 'absolute',
        schedule: { 1: 0.1, 2: 0.1, default: 0.2 },
      },
    },
    ...overrides,
  };
}

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

// ── Tests ────────────────────────────────────────────────────

describe('DecisionEngine', () => {
  let engine: DecisionEngine;

  beforeEach(() => {
    engine = new DecisionEngine();
    engine.setDefinitions([
      makeDecisionDef({ decision: 'Strategic A', level: 'Strategic' }),
      makeDecisionDef({ decision: 'Strategic B', level: 'Strategic' }),
      makeDecisionDef({ decision: 'Operational X', level: 'Operational' }),
      makeDecisionDef({ decision: 'Operational Y', level: 'Operational' }),
      makeDecisionDef({
        decision: 'Exclusive Deal',
        level: 'Strategic',
        excludes: ['Competitor Lock-in'],
      }),
      makeDecisionDef({
        decision: 'Competitor Lock-in',
        level: 'Strategic',
        excludes: ['Exclusive Deal'],
      }),
    ]);
  });

  describe('setDefinitions / getDef', () => {
    it('should load decision definitions', () => {
      expect(engine.getDef('Strategic A')).toBeDefined();
      expect(engine.getDef('Strategic A')!.level).toBe('Strategic');
    });

    it('should return undefined for unknown decisions', () => {
      expect(engine.getDef('Nonexistent')).toBeUndefined();
    });
  });

  describe('canDeploy', () => {
    it('should allow deploying a new decision', () => {
      const result = engine.canDeploy([], 'Strategic A');
      expect(result.allowed).toBe(true);
    });

    it('should block deploying same decision twice if not matured', () => {
      const def = makeDecisionDef({ decision: 'Same Decision' });
      const deployed: DeployedDecision[] = [
        {
          id: 'd1',
          definition: def,
          deployedYear: 2020,
          elapsedYears: 1,
          isMatured: false,
        },
      ];

      const result = engine.canDeploy(deployed, 'Same Decision');
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("hasn't matured");
    });

    it('should allow deploying same decision if previous is matured', () => {
      // No permanent ('default') effect on this one — this test is about the
      // matured-redeploy pathway in general, not the permanent-effect lock covered
      // by its own describe block below.
      const def = makeDecisionDef({ decision: 'Same Decision', impacts: { cash: { type: 'absolute', schedule: { 1: -1000 } } } });
      engine.setDefinitions([def]);
      const deployed: DeployedDecision[] = [
        {
          id: 'd1',
          definition: def,
          deployedYear: 2020,
          elapsedYears: 5,
          isMatured: true,
          voidedByLawsuit: false,
        },
      ];

      const result = engine.canDeploy(deployed, 'Same Decision');
      expect(result.allowed).toBe(true);
    });

    it('should block if this decision excludes an active one', () => {
      const exclusiveDef = makeDecisionDef({ decision: 'Exclusive Deal', excludes: ['Competitor Lock-in'] });
      const lockinDef = makeDecisionDef({ decision: 'Competitor Lock-in' });
      const deployed: DeployedDecision[] = [
        {
          id: 'd1',
          definition: lockinDef,
          deployedYear: 2020,
          elapsedYears: 1,
          isMatured: false,
        },
      ];

      const result = engine.canDeploy(deployed, 'Exclusive Deal');
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('Competitor Lock-in');
    });

    it('should block if an active decision excludes this one', () => {
      const exclusiveDef = makeDecisionDef({ decision: 'Exclusive Deal', excludes: ['Competitor Lock-in'] });
      const lockinDef = makeDecisionDef({ decision: 'Competitor Lock-in' });
      const deployed: DeployedDecision[] = [
        {
          id: 'd1',
          definition: exclusiveDef,
          deployedYear: 2020,
          elapsedYears: 1,
          isMatured: false,
        },
      ];

      const result = engine.canDeploy(deployed, 'Competitor Lock-in');
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('Exclusive Deal');
    });

    it('should allow reverse exclusion if the blocking decision is matured', () => {
      const exclusiveDef = makeDecisionDef({ decision: 'Exclusive Deal', excludes: ['Competitor Lock-in'] });
      const lockinDef = makeDecisionDef({ decision: 'Competitor Lock-in' });
      const deployed: DeployedDecision[] = [
        {
          id: 'd1',
          definition: exclusiveDef,
          deployedYear: 2020,
          elapsedYears: 5,
          isMatured: true,
        },
      ];

      const result = engine.canDeploy(deployed, 'Competitor Lock-in');
      expect(result.allowed).toBe(true);
    });

    // Regression coverage for a real, reported bug: canDeploy used to accept
    // maxStrategic/maxOperational and re-derive "how many decisions of this level does
    // this player already have" from the FULL playerDecisions array — which is a
    // player's entire historical active-decisions list (matured or not, voided or not),
    // never pruned across turns. That made the check a lifetime cap in practice, not a
    // per-turn one: the moment a player had ever accumulated maxStrategic/maxOperational
    // decisions of a level (typically their very first turn, using their normal budget),
    // canDeploy silently refused every further decision of that level for the rest of the
    // game — regardless of maturity, and regardless of whether those old instances were
    // later voided by a lost lawsuit. The real per-turn budget was (and still is) enforced
    // entirely by the caller (`GameLoop.processNewDecisions`'s `.slice(0, maxForBucket)`,
    // see gameLoop.test.ts's "should enforce strategic decision limit"), so canDeploy
    // re-deriving and re-enforcing its own (buggy) copy of the same limit was both
    // redundant and wrong. canDeploy no longer takes a level/max-count at all.
    it('does not block a new decision just because the player has many old, matured decisions of the same level (regression)', () => {
      const noPermanentImpacts = { cash: { type: 'absolute' as const, schedule: { 1: -1000 } } };
      const stratA = makeDecisionDef({ decision: 'Strategic A', impacts: noPermanentImpacts });
      const stratB = makeDecisionDef({ decision: 'Strategic B', impacts: noPermanentImpacts });
      const stratC = makeDecisionDef({ decision: 'Strategic C', impacts: noPermanentImpacts });
      engine.setDefinitions([stratA, stratB, stratC]);
      const deployed: DeployedDecision[] = [stratA, stratB].map((d, i) => ({
        id: `d${i}`,
        definition: d,
        deployedYear: 2020,
        elapsedYears: 5,
        isMatured: true,
        voidedByLawsuit: false,
      }));

      const result = engine.canDeploy(deployed, 'Strategic C');
      expect(result.allowed).toBe(true);
    });

    it('does not block a new decision because of old decisions later voided by a lost lawsuit (regression)', () => {
      const noPermanentImpacts = { cash: { type: 'absolute' as const, schedule: { 1: -1000 } } };
      const opX = makeDecisionDef({ decision: 'Operational X', level: 'Operational', impacts: noPermanentImpacts });
      const opY = makeDecisionDef({ decision: 'Operational Y', level: 'Operational', impacts: noPermanentImpacts });
      const opZ = makeDecisionDef({ decision: 'Operational Z', level: 'Operational', impacts: noPermanentImpacts });
      engine.setDefinitions([opX, opY, opZ]);
      const deployed: DeployedDecision[] = [
        { id: 'd0', definition: opX, deployedYear: 2020, elapsedYears: 5, isMatured: true, voidedByLawsuit: true },
        { id: 'd1', definition: opY, deployedYear: 2020, elapsedYears: 5, isMatured: true, voidedByLawsuit: true },
      ];

      const result = engine.canDeploy(deployed, 'Operational Z');
      expect(result.allowed).toBe(true);
    });

    it('should return unknown decision for non-existent decision', () => {
      const result = engine.canDeploy([], 'Nonexistent');
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('Unknown decision');
    });

    describe('permanent-effect redeploy lock', () => {
      // makeDecisionDef's default impacts (processingLevel with a non-zero 'default'
      // schedule value) is itself a permanent-effect decision — see hasPermanentEffect.
      it('should block redeploying a permanent-effect decision whose instance is still delivering its effect (no statute passed — never expires)', () => {
        const def = makeDecisionDef({ decision: 'Permanent Boost' });
        engine.setDefinitions([def]);
        const deployed: DeployedDecision[] = [
          { id: 'd1', definition: def, deployedYear: 2020, elapsedYears: 5, isMatured: true, voidedByLawsuit: false },
        ];

        const result = engine.canDeploy(deployed, 'Permanent Boost');
        expect(result.allowed).toBe(false);
        expect(result.reason).toContain('still delivering its permanent effect');
      });

      it('should allow redeploying a permanent-effect decision whose only matured instance was voided by a lost lawsuit', () => {
        const def = makeDecisionDef({ decision: 'Permanent Boost' });
        engine.setDefinitions([def]);
        const deployed: DeployedDecision[] = [
          { id: 'd1', definition: def, deployedYear: 2020, elapsedYears: 5, isMatured: true, voidedByLawsuit: true },
        ];

        const result = engine.canDeploy(deployed, 'Permanent Boost');
        expect(result.allowed).toBe(true);
      });

      it('should block redeploying while the matured instance is younger than the statute of limitations', () => {
        const def = makeDecisionDef({ decision: 'Permanent Boost' });
        engine.setDefinitions([def]);
        const deployed: DeployedDecision[] = [
          { id: 'd1', definition: def, deployedYear: 2020, elapsedYears: 9, isMatured: true, voidedByLawsuit: false },
        ];

        const result = engine.canDeploy(deployed, 'Permanent Boost', 10);
        expect(result.allowed).toBe(false);
      });

      it('should allow redeploying once the matured instance has aged past the statute of limitations (its effect has expired)', () => {
        const def = makeDecisionDef({ decision: 'Permanent Boost' });
        engine.setDefinitions([def]);
        const deployed: DeployedDecision[] = [
          { id: 'd1', definition: def, deployedYear: 2020, elapsedYears: 10, isMatured: true, voidedByLawsuit: false },
        ];

        const result = engine.canDeploy(deployed, 'Permanent Boost', 10);
        expect(result.allowed).toBe(true);
      });

      it('should still allow redeploying a non-permanent-effect decision after it matured', () => {
        const def = makeDecisionDef({
          decision: 'One-Time Boost',
          impacts: { cash: { type: 'absolute', schedule: { 1: -1000 } } },
        });
        engine.setDefinitions([def]);
        const deployed: DeployedDecision[] = [
          { id: 'd1', definition: def, deployedYear: 2020, elapsedYears: 5, isMatured: true, voidedByLawsuit: false },
        ];

        const result = engine.canDeploy(deployed, 'One-Time Boost');
        expect(result.allowed).toBe(true);
      });

      // Regression coverage for a real gap found by auditing the redeploy lock against the
      // real seed library: `hasPermanentEffect` only looks at a decision's own fields, so a
      // decision whose ONLY permanent effect is a `target.*` one (no permanent self-effect
      // at all — Patent Portfolio's real shape: finite own cash/intangibleAssets, but a
      // `target.processingLevel: default -0.2`) used to be completely unblocked the moment
      // its first instance matured, letting a player stack unlimited concurrent copies of
      // the same permanent debuff on one rival. canDeploy now also checks the target-impact
      // map via the same `hasPermanentImpactMap` helper `collectTargetImpacts` already uses.
      it('should block redeploying a decision whose only permanent effect is a target.* one (Patent-Portfolio-shaped gap, regression)', () => {
        const def = makeDecisionDef({
          decision: 'IP Moat',
          impacts: {
            cash: { type: 'absolute', schedule: { 1: -15000, 2: -15000, default: 0 } },
            'target.processingLevel': { type: 'relative', schedule: { 1: 0, 2: -0.1, default: -0.2 } },
          },
        });
        engine.setDefinitions([def]);
        const deployed: DeployedDecision[] = [
          { id: 'd1', definition: def, deployedYear: 2020, elapsedYears: 5, isMatured: true, voidedByLawsuit: false },
        ];

        const result = engine.canDeploy(deployed, 'IP Moat');
        expect(result.allowed).toBe(false);
        expect(result.reason).toContain('still delivering its permanent effect');
      });

      it('should allow redeploying a target.*-only-permanent-effect decision once voided by a lost lawsuit', () => {
        const def = makeDecisionDef({
          decision: 'IP Moat',
          impacts: {
            cash: { type: 'absolute', schedule: { 1: -15000, 2: -15000, default: 0 } },
            'target.processingLevel': { type: 'relative', schedule: { 1: 0, 2: -0.1, default: -0.2 } },
          },
        });
        engine.setDefinitions([def]);
        const deployed: DeployedDecision[] = [
          { id: 'd1', definition: def, deployedYear: 2020, elapsedYears: 5, isMatured: true, voidedByLawsuit: true },
        ];

        const result = engine.canDeploy(deployed, 'IP Moat');
        expect(result.allowed).toBe(true);
      });
    });
  });

  describe('hasPermanentEffect', () => {
    it('should be true for a decision with a non-zero default schedule value on an own field', () => {
      const def = makeDecisionDef({ impacts: { processingLevel: { type: 'absolute', schedule: { 1: 0.1, default: 0.2 } } } });
      expect(hasPermanentEffect(def)).toBe(true);
    });

    it('should be false for a decision whose schedule never falls through to a non-zero default', () => {
      const def = makeDecisionDef({ impacts: { cash: { type: 'absolute', schedule: { 1: -1000 } } } });
      expect(hasPermanentEffect(def)).toBe(false);
    });

    it('should be false for a decision whose only non-zero default is a target.* or competitor field', () => {
      const def = makeDecisionDef({
        impacts: {
          'target.outrage': { type: 'absolute', schedule: { default: 10 } },
          competitorAwareness: { type: 'absolute', schedule: { default: 1 } },
        },
      });
      expect(hasPermanentEffect(def)).toBe(false);
    });
  });

  describe('pickBestGround', () => {
    const def = makeDecisionDef({
      decision: 'Water Pumping',
      legalRisks: [
        {
          name: 'Environmental Violation',
          description: 'Sue for environmental damage',
          probability: { 1: 0.06, 2: 0.12, default: 0.18 },
          impact: { type: 'absolute', target: 'cash', schedule: { default: 22050 } },
        },
      ],
    });
    const attackerVars = { scrutiny: 30, legalExposureRatio: 0 };

    it('should return a non-zero probability by default', () => {
      const best = pickBestGround(def, 2, attackerVars, makeAdmin(), DEFAULT_FORMULAS);
      expect(best?.probability).toBeGreaterThan(0);
    });

    it('should floor probability to 0 once already claimed (everSued), regardless of elapsedYears', () => {
      const best = pickBestGround(def, 2, attackerVars, makeAdmin(), DEFAULT_FORMULAS, Infinity, true);
      expect(best?.name).toBe('Environmental Violation');
      expect(best?.probability).toBe(0);
    });

    it('should still floor probability to 0 when time-barred, independent of alreadyClaimed', () => {
      const best = pickBestGround(def, 10, attackerVars, makeAdmin(), DEFAULT_FORMULAS, 10, false);
      expect(best?.probability).toBe(0);
    });

    it('should floor probability to 0 when meetsConditions is false (e.g. a Buy Shares purchase below its legalRiskConditions threshold)', () => {
      const best = pickBestGround(def, 2, attackerVars, makeAdmin(), DEFAULT_FORMULAS, Infinity, false, false);
      expect(best?.name).toBe('Environmental Violation');
      expect(best?.probability).toBe(0);
    });
  });

  describe('meetsLegalRiskConditions', () => {
    it('should be true (trivially) for a decision with no legalRiskConditions at all', () => {
      const def = makeDecisionDef({ legalRiskConditions: undefined });
      expect(meetsLegalRiskConditions(def, { acquisitionFraction: 0 })).toBe(true);
    });

    it('should be true when the instance meets or exceeds the configured minimum', () => {
      const def = makeDecisionDef({ legalRiskConditions: { minPercentAcquiredInSingleTransaction: 0.05 } });
      expect(meetsLegalRiskConditions(def, { acquisitionFraction: 0.05 })).toBe(true);
      expect(meetsLegalRiskConditions(def, { acquisitionFraction: 0.4 })).toBe(true);
    });

    it('should be false when the instance falls short of the configured minimum', () => {
      const def = makeDecisionDef({ legalRiskConditions: { minPercentAcquiredInSingleTransaction: 0.05 } });
      expect(meetsLegalRiskConditions(def, { acquisitionFraction: 0.01 })).toBe(false);
    });

    it('should treat a missing acquisitionFraction as 0 (fails any positive threshold)', () => {
      const def = makeDecisionDef({ legalRiskConditions: { minPercentAcquiredInSingleTransaction: 0.05 } });
      expect(meetsLegalRiskConditions(def, {})).toBe(false);
    });

    it('should be true (ignored) for an unrecognized condition key the engine has no check wired for', () => {
      const def = makeDecisionDef({ legalRiskConditions: { someFutureCondition: 42 } });
      expect(meetsLegalRiskConditions(def, { acquisitionFraction: 0 })).toBe(true);
    });
  });

  describe('deploy', () => {
    it('should create a new deployed decision instance', () => {
      const def = makeDecisionDef({ decision: 'New Decision' });
      const instance = engine.deploy('player-1', def, 2024);

      expect(instance.id).toBeDefined();
      expect(instance.definition.decision).toBe('New Decision');
      expect(instance.deployedYear).toBe(2024);
      expect(instance.elapsedYears).toBe(0);
      expect(instance.voidedByLawsuit).toBe(false);
      expect(instance.everSued).toBe(false);
    });

    it('should be immediately matured if no schedule keys (default only)', () => {
      const def = makeDecisionDef({
        decision: 'Instant Decision',
        impacts: {
          processingLevel: {
            type: 'absolute',
            schedule: { default: 0.1 },
          },
        },
      });
      const instance = engine.deploy('player-1', def, 2024);

      expect(instance.isMatured).toBe(true);
    });

    it('should not be matured if schedule has keys beyond default', () => {
      const def = makeDecisionDef({
        decision: 'Delayed Decision',
        impacts: {
          processingLevel: {
            type: 'absolute',
            schedule: { 1: 0.05, 2: 0.05, default: 0.1 },
          },
        },
      });
      const instance = engine.deploy('player-1', def, 2024);

      expect(instance.isMatured).toBe(false);
    });
  });

  describe('applyImpactsForYear', () => {
    it('should apply absolute impacts for a given year', () => {
      const def = makeDecisionDef({
        decision: 'Test',
        impacts: {
          processingLevel: {
            type: 'absolute',
            schedule: { 1: 0.1, 2: 0.1, default: 0.2 },
          },
        },
      });

      const vars = makeVars({ processingLevel: 0.5 });
      const result = engine.applyImpactsForYear(vars, def.impacts, 1);

      expect(result.updatedVars.processingLevel).toBeCloseTo(0.6, 4);
    });

    it('should apply relative impacts for a given year', () => {
      const def = makeDecisionDef({
        decision: 'Test',
        impacts: {
          processingLevel: {
            type: 'relative',
            schedule: { 1: 0.2, default: 0.3 },
          },
        },
      });

      const vars = makeVars({ processingLevel: 0.5 });
      // elapsedYears=0 → key "1" (deployment-year multiplier of 0.2)
      const result = engine.applyImpactsForYear(vars, def.impacts, 0);

      expect(result.updatedVars.processingLevel).toBeCloseTo(0.5 * 1.2, 4);
    });
  });

  describe('advanceAndApply', () => {
    it('should advance elapsed years and apply impacts', () => {
      const def = makeDecisionDef({
        decision: 'Test',
        impacts: {
          processingLevel: {
            type: 'absolute',
            schedule: { 1: 0.1, 2: 0.1, default: 0.2 },
          },
        },
      });

      const deployed: DeployedDecision[] = [
        {
          id: 'd1',
          definition: def,
          deployedYear: 2020,
          elapsedYears: 0,
          isMatured: false,
        },
      ];

      const vars = makeVars({ processingLevel: 0.5 });
      const result = engine.advanceAndApply('player-1', vars, deployed, 2021);

      expect(result.updatedActiveDecisions[0].elapsedYears).toBe(1);
      expect(result.updatedVars.processingLevel).toBeCloseTo(0.6, 4);
    });

    it('should mature decisions when elapsed years reach threshold', () => {
      const def = makeDecisionDef({
        decision: 'Test',
        impacts: {
          processingLevel: {
            type: 'absolute',
            schedule: { 1: 0.1, 2: 0.1, default: 0.2 },
          },
        },
      });

      const deployed: DeployedDecision[] = [
        {
          id: 'd1',
          definition: def,
          deployedYear: 2020,
          elapsedYears: 1,
          isMatured: false,
        },
      ];

      const vars = makeVars({ processingLevel: 0.5 });
      const result = engine.advanceAndApply('player-1', vars, deployed, 2023);

      expect(result.updatedActiveDecisions[0].isMatured).toBe(true);
      expect(result.updatedActiveDecisions[0].elapsedYears).toBe(2);
    });

    it('applies the default schedule value exactly once, the turn maturity is first reached', () => {
      const def = makeDecisionDef({
        decision: 'Test',
        impacts: {
          processingLevel: {
            type: 'absolute',
            schedule: { 1: 0.05, 2: 0.05, default: 0.2 },
          },
        },
      });

      const deployed: DeployedDecision[] = [
        {
          id: 'd1',
          definition: def,
          deployedYear: 2020,
          elapsedYears: 1,
          isMatured: false,
        },
      ];

      const vars = makeVars({ processingLevel: 0.5 });
      // elapsedYears becomes 2 this call — exactly at threshold (maxKey 2), the first turn
      // 'default' (0.2) is consulted at all.
      const result = engine.advanceAndApply('player-1', vars, deployed, 2022);

      expect(result.updatedVars.processingLevel).toBeCloseTo(0.7, 4);
    });

    it('does not re-apply the default value on later turns once already past maturity (regression — used to compound/accumulate every turn forever)', () => {
      // A real, reported finding from a randomized-play simulation: New Factory's
      // installedCapacity (a `relative` field) compounded ×1.4 every single turn once
      // matured — 350 → 490 → 686 → 960 → ... — and the identical mechanic on `absolute`
      // fields (operatingExpenses/capacityUtilization) was independently driving
      // hard-to-explain bankruptcies. A decision's own 'default' effect must land once,
      // at maturity, and then hold — never accumulate turn after turn.
      const def = makeDecisionDef({
        decision: 'Test',
        impacts: {
          processingLevel: {
            type: 'absolute',
            schedule: { 1: 0.05, 2: 0.05, default: 0.2 },
          },
        },
      });

      const deployed: DeployedDecision[] = [
        {
          id: 'd1',
          definition: def,
          deployedYear: 2020,
          elapsedYears: 5, // already well past threshold (2) — 'default' already applied once
          isMatured: true,
        },
      ];

      const vars = makeVars({ processingLevel: 0.5 });
      const result = engine.advanceAndApply('player-1', vars, deployed, 2026);

      expect(result.updatedVars.processingLevel).toBe(0.5);
      expect(result.updatedActiveDecisions[0].elapsedYears).toBe(6);
    });

    it('compounds a relative default value only once, not every subsequent turn (regression)', () => {
      const def = makeDecisionDef({
        decision: 'Capacity Booster',
        impacts: {
          installedCapacity: { type: 'relative', schedule: { default: 0.4 } },
        },
      });

      let vars = makeVars({ installedCapacity: 10000 });
      let deployed: DeployedDecision[] = [
        { id: 'd1', definition: def, deployedYear: 2020, elapsedYears: 0, isMatured: true, voidedByLawsuit: false },
      ];

      // Turn 1: threshold is 0 (no explicit years) — elapsedYears becomes 1, already > 0,
      // so this call itself does not apply anything (the deployment-year application
      // already happened via processNewDecisions/applyImpactsForYear in a real turn, not
      // through advanceAndApply — this test isolates advanceAndApply's own behavior).
      let result = engine.advanceAndApply('player-1', vars, deployed, 2021);
      expect(result.updatedVars.installedCapacity).toBe(10000);

      // Turn 2, 3: still no further compounding.
      vars = result.updatedVars;
      deployed = result.updatedActiveDecisions;
      result = engine.advanceAndApply('player-1', vars, deployed, 2022);
      expect(result.updatedVars.installedCapacity).toBe(10000);

      vars = result.updatedVars;
      deployed = result.updatedActiveDecisions;
      result = engine.advanceAndApply('player-1', vars, deployed, 2023);
      expect(result.updatedVars.installedCapacity).toBe(10000);
    });

    it('should handle multiple active decisions', () => {
      const def1 = makeDecisionDef({
        decision: 'Test1',
        impacts: {
          processingLevel: {
            type: 'absolute',
            schedule: { 1: 0.1, default: 0.1 },
          },
        },
      });
      const def2 = makeDecisionDef({
        decision: 'Test2',
        impacts: {
          supplySecurity: {
            type: 'absolute',
            schedule: { 1: 0.05, default: 0.05 },
          },
        },
      });

      const deployed: DeployedDecision[] = [
        {
          id: 'd1',
          definition: def1,
          deployedYear: 2020,
          elapsedYears: 0,
          isMatured: false,
        },
        {
          id: 'd2',
          definition: def2,
          deployedYear: 2020,
          elapsedYears: 0,
          isMatured: false,
        },
      ];

      const vars = makeVars({ processingLevel: 0.5, supplySecurity: 0.4 });
      const result = engine.advanceAndApply('player-1', vars, deployed, 2021);

      expect(result.updatedActiveDecisions).toHaveLength(2);
      expect(result.updatedVars.processingLevel).toBeCloseTo(0.6, 4);
      expect(result.updatedVars.supplySecurity).toBeCloseTo(0.45, 4);
    });

    it('should not mutate the original vars object', () => {
      const def = makeDecisionDef({
        decision: 'Test',
        impacts: {
          processingLevel: {
            type: 'absolute',
            schedule: { 1: 0.1, default: 0.1 },
          },
        },
      });

      const deployed: DeployedDecision[] = [
        {
          id: 'd1',
          definition: def,
          deployedYear: 2020,
          elapsedYears: 0,
          isMatured: false,
        },
      ];

      const vars = makeVars({ processingLevel: 0.5 });
      const originalProcessingLevel = vars.processingLevel;

      engine.advanceAndApply('player-1', vars, deployed, 2021);

      expect(vars.processingLevel).toBe(originalProcessingLevel);
    });

    it('should not mutate the original deployed decisions array', () => {
      const def = makeDecisionDef({
        decision: 'Test',
        impacts: {
          processingLevel: {
            type: 'absolute',
            schedule: { 1: 0.1, default: 0.1 },
          },
        },
      });

      const deployed: DeployedDecision[] = [
        {
          id: 'd1',
          definition: def,
          deployedYear: 2020,
          elapsedYears: 0,
          isMatured: false,
        },
      ];

      const originalLength = deployed.length;

      engine.advanceAndApply('player-1', makeVars(), deployed, 2021);

      expect(deployed.length).toBe(originalLength);
    });

    it('should not apply further impacts for an instance voided by a lost lawsuit, though it still advances elapsedYears', () => {
      const def = makeDecisionDef({
        decision: 'Sued Decision',
        impacts: {
          processingLevel: {
            type: 'absolute',
            schedule: { 1: 0.1, 2: 0.1, default: 0.2 },
          },
        },
      });

      const deployed: DeployedDecision[] = [
        {
          id: 'd1',
          definition: def,
          deployedYear: 2020,
          elapsedYears: 5,
          isMatured: true,
          voidedByLawsuit: true,
        },
      ];

      const vars = makeVars({ processingLevel: 0.5 });
      const result = engine.advanceAndApply('player-1', vars, deployed, 2026);

      expect(result.updatedVars.processingLevel).toBe(0.5);
      expect(result.updatedActiveDecisions[0].elapsedYears).toBe(6);
    });

    it('should stop applying a permanent effect once the instance ages past the statute of limitations, and force it matured', () => {
      const def = makeDecisionDef({
        decision: 'Aging Decision',
        impacts: {
          processingLevel: { type: 'absolute', schedule: { default: 0.2 } },
        },
      });

      const deployed: DeployedDecision[] = [
        { id: 'd1', definition: def, deployedYear: 2020, elapsedYears: 9, isMatured: true, voidedByLawsuit: false },
      ];

      const vars = makeVars({ processingLevel: 0.5 });
      const result = engine.advanceAndApply('player-1', vars, deployed, 2030, 10);

      // elapsedYears becomes 10 this call — at the statute, so no further impact applies.
      expect(result.updatedVars.processingLevel).toBe(0.5);
      expect(result.updatedActiveDecisions[0].elapsedYears).toBe(10);
      expect(result.updatedActiveDecisions[0].isMatured).toBe(true);
    });

    it('should force isMatured true on expiry even if the instance had not otherwise matured yet (short admin-configured statute)', () => {
      const def = makeDecisionDef({
        decision: 'Slow Maturing Decision',
        impacts: {
          processingLevel: { type: 'absolute', schedule: { 1: 0.05, 2: 0.05, 3: 0.05, default: 0.2 } },
        },
      });

      const deployed: DeployedDecision[] = [
        { id: 'd1', definition: def, deployedYear: 2020, elapsedYears: 1, isMatured: false, voidedByLawsuit: false },
      ];

      // statuteOfLimitationsYears (2) is shorter than this decision's own maturity (3).
      const result = engine.advanceAndApply('player-1', makeVars({ processingLevel: 0.5 }), deployed, 2022, 2);

      expect(result.updatedActiveDecisions[0].isMatured).toBe(true);
    });

    it('should not stop a non-permanent decision from applying its own explicit schedule value past the statute', () => {
      const def = makeDecisionDef({
        decision: 'Long Explicit Schedule',
        impacts: {
          processingLevel: { type: 'absolute', schedule: { 12: 0.3 } }, // no 'default' at all — not hasPermanentEffect
        },
      });

      const deployed: DeployedDecision[] = [
        { id: 'd1', definition: def, deployedYear: 2020, elapsedYears: 10, isMatured: true, voidedByLawsuit: false },
      ];

      const result = engine.advanceAndApply('player-1', makeVars({ processingLevel: 0.5 }), deployed, 2031, 10);

      expect(result.updatedVars.processingLevel).toBeCloseTo(0.8, 4);
    });
  });

  describe('collectTargetImpacts', () => {
    it('should collect target.* impacts from a targeted active decision', () => {
      const def = makeDecisionDef({
        decision: 'Bot Attack',
        impacts: { 'target.outrage': { type: 'absolute', schedule: { default: 10 } } },
      });
      const deployed: DeployedDecision[] = [
        { id: 'd1', definition: def, deployedYear: 2020, elapsedYears: 0, isMatured: true, targetId: 'rival-1', voidedByLawsuit: false },
      ];

      const results = engine.collectTargetImpacts(deployed);
      expect(results).toHaveLength(1);
      expect(results[0].targetId).toBe('rival-1');
      expect(results[0].impacts.has('outrage')).toBe(true);
    });

    it('should exclude a targeted decision instance voided by a lost lawsuit', () => {
      const def = makeDecisionDef({
        decision: 'Bot Attack',
        impacts: { 'target.outrage': { type: 'absolute', schedule: { default: 10 } } },
      });
      const deployed: DeployedDecision[] = [
        { id: 'd1', definition: def, deployedYear: 2020, elapsedYears: 0, isMatured: true, targetId: 'rival-1', voidedByLawsuit: true },
      ];

      const results = engine.collectTargetImpacts(deployed);
      expect(results).toHaveLength(0);
    });

    it('should exclude a permanent target.* effect once its instance ages past the statute of limitations', () => {
      const def = makeDecisionDef({
        decision: 'Bot Attack',
        impacts: { 'target.outrage': { type: 'absolute', schedule: { default: 10 } } },
      });
      const deployed: DeployedDecision[] = [
        { id: 'd1', definition: def, deployedYear: 2010, elapsedYears: 10, isMatured: true, targetId: 'rival-1', voidedByLawsuit: false },
      ];

      const results = engine.collectTargetImpacts(deployed, 10);
      expect(results).toHaveLength(0);
    });

    it('should still collect a permanent target.* effect while the instance is younger than the statute of limitations', () => {
      const def = makeDecisionDef({
        decision: 'Bot Attack',
        impacts: { 'target.outrage': { type: 'absolute', schedule: { default: 10 } } },
      });
      const deployed: DeployedDecision[] = [
        { id: 'd1', definition: def, deployedYear: 2010, elapsedYears: 9, isMatured: true, targetId: 'rival-1', voidedByLawsuit: false },
      ];

      const results = engine.collectTargetImpacts(deployed, 10);
      expect(results).toHaveLength(1);
    });
  });
});
