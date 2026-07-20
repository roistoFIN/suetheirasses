import { describe, it, expect } from 'vitest';
import { DecisionEngine, type DeployedDecision } from './decisionEngine';
import type { DecisionDefinition, PlayerVariables } from '@suetheirasses/shared';

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
      const result = engine.canDeploy([], 'Strategic A', 'Strategic', 2, 2);
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

      const result = engine.canDeploy(deployed, 'Same Decision', 'Strategic', 2, 2);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("hasn't matured");
    });

    it('should allow deploying same decision if previous is matured', () => {
      const def = makeDecisionDef({ decision: 'Same Decision' });
      engine.setDefinitions([def]);
      const deployed: DeployedDecision[] = [
        {
          id: 'd1',
          definition: def,
          deployedYear: 2020,
          elapsedYears: 5,
          isMatured: true,
        },
      ];

      const result = engine.canDeploy(deployed, 'Same Decision', 'Strategic', 2, 2);
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

      const result = engine.canDeploy(deployed, 'Exclusive Deal', 'Strategic', 2, 2);
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

      const result = engine.canDeploy(deployed, 'Competitor Lock-in', 'Strategic', 2, 2);
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

      const result = engine.canDeploy(deployed, 'Competitor Lock-in', 'Strategic', 2, 2);
      expect(result.allowed).toBe(true);
    });

    it('should block exceeding strategic limit', () => {
      const deployed: DeployedDecision[] = [
        makeDecisionDef({ decision: 'Strategic A' }),
        makeDecisionDef({ decision: 'Strategic B' }),
      ].map((d, i) => ({
        id: `d${i}`,
        definition: d,
        deployedYear: 2020,
        elapsedYears: 5,
        isMatured: true,
      }));

      const result = engine.canDeploy(deployed, 'Strategic A', 'Strategic', 2, 2);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('Max 2 strategic');
    });

    it('should block exceeding operational limit', () => {
      const opX = makeDecisionDef({ decision: 'Operational X', level: 'Operational' });
      const opY = makeDecisionDef({ decision: 'Operational Y', level: 'Operational' });
      engine.setDefinitions([opX, opY]);
      const deployed: DeployedDecision[] = [
        { id: 'd0', definition: opX, deployedYear: 2020, elapsedYears: 5, isMatured: true },
        { id: 'd1', definition: opY, deployedYear: 2020, elapsedYears: 5, isMatured: true },
      ];

      const result = engine.canDeploy(deployed, 'Operational X', 'Operational', 2, 2);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('Max 2 operational');
    });

    it('should return unknown decision for non-existent decision', () => {
      const result = engine.canDeploy([], 'Nonexistent', 'Strategic', 2, 2);
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('Unknown decision');
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
      const result = engine.applyImpactsForYear(vars, 'Test', def.impacts, 1);

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
      const result = engine.applyImpactsForYear(vars, 'Test', def.impacts, 0);

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

    it('should use default schedule when matured', () => {
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
          elapsedYears: 5,
          isMatured: true,
        },
      ];

      const vars = makeVars({ processingLevel: 0.5 });
      const result = engine.advanceAndApply('player-1', vars, deployed, 2026);

      expect(result.updatedVars.processingLevel).toBeCloseTo(0.7, 4);
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
  });
});
