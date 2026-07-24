import { describe, it, expect } from 'vitest';
import type { DecisionDefinition } from '@suetheirasses/shared';
import {
  clampDecisionCandidate,
  isViableCandidate,
  MAX_IMPACT_FIELDS,
  MAX_LEGAL_RISKS,
  MAX_PROBABILITY,
} from './decisionGenGuardrails';

function baseCandidate(overrides: Partial<DecisionDefinition> = {}): DecisionDefinition {
  return {
    decision: 'Test Decision',
    level: 'Operational',
    description: 'A test decision.',
    nature: 'Traditional',
    offensiveAction: false,
    excludes: [],
    impacts: { cash: { type: 'absolute', schedule: { default: -10000 } } },
    ...overrides,
  } as DecisionDefinition;
}

describe('clampDecisionCandidate', () => {
  it('passes a well-formed candidate through with no changes and no warnings', () => {
    const candidate = baseCandidate({ cashFlowCategory: 'operating' } as any);
    const { decision, warnings } = clampDecisionCandidate(candidate, ['Existing Decision']);
    expect(decision.decision).toBe('Test Decision');
    expect(decision.impacts.cash.schedule.default).toBe(-10000);
    expect(warnings).toHaveLength(0);
  });

  it('drops an impact field that is not a recognized KPI', () => {
    const candidate = baseCandidate({
      impacts: {
        cash: { type: 'absolute', schedule: { default: -10000 } },
        madeUpField: { type: 'absolute', schedule: { default: 999 } },
      } as any,
    });
    const { decision, warnings } = clampDecisionCandidate(candidate, []);
    expect(decision.impacts).not.toHaveProperty('madeUpField');
    expect(warnings.some((w) => w.message.includes('madeUpField'))).toBe(true);
  });

  it('caps the number of impact fields at MAX_IMPACT_FIELDS', () => {
    const manyImpacts: DecisionDefinition['impacts'] = {};
    const fields = ['cash', 'assets', 'debt', 'staffCost', 'reserves', 'otherIncome', 'outrage'];
    for (const f of fields) manyImpacts[f] = { type: 'absolute', schedule: { default: 100 } };
    const { decision, warnings } = clampDecisionCandidate(baseCandidate({ impacts: manyImpacts }), []);
    expect(Object.keys(decision.impacts)).toHaveLength(MAX_IMPACT_FIELDS);
    expect(warnings.some((w) => w.message.includes('exceeds the'))).toBe(true);
  });

  it('clamps an absolute cash value that wildly exceeds the real-data-derived range', () => {
    const candidate = baseCandidate({
      impacts: { cash: { type: 'absolute', schedule: { default: -99999999 } } },
    });
    const { decision, warnings } = clampDecisionCandidate(candidate, []);
    expect(decision.impacts.cash.schedule.default).toBeGreaterThan(-99999999);
    expect(decision.impacts.cash.schedule.default).toBe(-150000);
    expect(warnings.some((w) => w.message.includes('clamped'))).toBe(true);
  });

  it('clamps a relative multiplier field into its bounded range (a "500%" hallucination)', () => {
    const candidate = baseCandidate({
      impacts: { installedCapacity: { type: 'relative', schedule: { default: 5 } } },
    });
    const { decision } = clampDecisionCandidate(candidate, []);
    expect(decision.impacts.installedCapacity.schedule.default).toBeLessThanOrEqual(0.4);
  });

  it('coerces a field to its only real-data type when the model picks the wrong one (materialCostPerTon as "absolute")', () => {
    const candidate = baseCandidate({
      impacts: { materialCostPerTon: { type: 'absolute', schedule: { default: 100 } } } as any,
    });
    const { decision, warnings } = clampDecisionCandidate(candidate, []);
    expect(decision.impacts.materialCostPerTon.type).toBe('relative');
    expect(decision.impacts.materialCostPerTon.schedule.default).toBeLessThanOrEqual(0.2);
    expect(warnings.some((w) => w.message.includes('coerced from'))).toBe(true);
  });

  it('drops a non-year schedule key', () => {
    const candidate = baseCandidate({
      impacts: { cash: { type: 'absolute', schedule: { default: -1000, note: 42 } as any } },
    });
    const { decision } = clampDecisionCandidate(candidate, []);
    expect(decision.impacts.cash.schedule).not.toHaveProperty('note');
  });

  it('strips a target.* impact field that is not a recognized KPI', () => {
    const candidate = baseCandidate({
      impacts: {
        cash: { type: 'absolute', schedule: { default: -1000 } },
        'target.nonsenseField': { type: 'absolute', schedule: { default: 10 } },
      } as any,
    });
    const { decision } = clampDecisionCandidate(candidate, []);
    expect(decision.impacts).not.toHaveProperty('target.nonsenseField');
  });

  it('forces offensiveAction/requiresTarget true when a target.* impact survives clamping', () => {
    const candidate = baseCandidate({
      offensiveAction: false,
      impacts: { 'target.outrage': { type: 'absolute', schedule: { default: 20 } } } as any,
    });
    const { decision } = clampDecisionCandidate(candidate, []);
    expect(decision.offensiveAction).toBe(true);
    expect(decision.requiresTarget).toBe(true);
  });

  it('does not set requiresTarget when there is no target.* impact', () => {
    const { decision } = clampDecisionCandidate(baseCandidate(), []);
    expect(decision.requiresTarget).toBeUndefined();
  });

  it('caps legalRisks at MAX_LEGAL_RISKS and clamps probability into range', () => {
    const legalRisks = Array.from({ length: 5 }, (_, i) => ({
      name: `Ground ${i}`,
      description: `Sue over ground ${i}.`,
      probability: { default: 0.99 },
      impact: { type: 'absolute' as const, target: 'cash', schedule: { default: -50000 } },
    }));
    const { decision, warnings } = clampDecisionCandidate(baseCandidate({ legalRisks }), []);
    expect(decision.legalRisks).toHaveLength(MAX_LEGAL_RISKS);
    for (const risk of decision.legalRisks!) {
      expect(risk.probability.default).toBeLessThanOrEqual(MAX_PROBABILITY);
    }
    expect(warnings.some((w) => w.message.includes('exceeds the'))).toBe(true);
  });

  it('forces a legal risk\'s type to match its target regardless of what the model said', () => {
    const legalRisks = [
      {
        name: 'Equity Dilution Suit',
        description: 'Sue over equity dilution.',
        probability: { default: 0.3 },
        impact: { type: 'absolute' as const, target: 'equity', schedule: { default: -0.4 } },
      },
    ];
    const { decision } = clampDecisionCandidate(baseCandidate({ legalRisks }), []);
    expect(decision.legalRisks![0].impact.type).toBe('relative');
  });

  it('defaults an unsuable legal risk target ("outrage") to cash/absolute', () => {
    const legalRisks = [
      {
        name: 'Nonsense Suit',
        description: 'Sue over outrage directly.',
        probability: { default: 0.3 },
        impact: { type: 'absolute' as const, target: 'outrage', schedule: { default: -20 } },
      },
    ];
    const { decision, warnings } = clampDecisionCandidate(baseCandidate({ legalRisks }), []);
    expect(decision.legalRisks![0].impact.target).toBe('cash');
    expect(decision.legalRisks![0].impact.type).toBe('absolute');
    expect(warnings.some((w) => w.message.includes('not suable'))).toBe(true);
  });

  it('drops a legal risk with an empty name or description', () => {
    const legalRisks = [
      { name: '', description: 'x', probability: { default: 0.1 }, impact: { type: 'absolute' as const, target: 'cash', schedule: { default: -10000 } } },
    ];
    const { decision } = clampDecisionCandidate(baseCandidate({ legalRisks }), []);
    expect(decision.legalRisks).toBeUndefined();
  });

  it('drops duplicate legal-risk ground names (case-insensitive)', () => {
    const legalRisks = [
      { name: 'Fraud Suit', description: 'a', probability: { default: 0.2 }, impact: { type: 'absolute' as const, target: 'cash', schedule: { default: -10000 } } },
      { name: 'fraud suit', description: 'b', probability: { default: 0.2 }, impact: { type: 'absolute' as const, target: 'cash', schedule: { default: -20000 } } },
    ];
    const { decision } = clampDecisionCandidate(baseCandidate({ legalRisks }), []);
    expect(decision.legalRisks).toHaveLength(1);
  });

  it('renames a decision whose name collides with an existing one', () => {
    const { decision, warnings } = clampDecisionCandidate(baseCandidate({ decision: 'New Factory' }), ['New Factory']);
    expect(decision.decision).toBe('New Factory (AI)');
    expect(warnings.some((w) => w.path === 'decision')).toBe(true);
  });

  it('resolves a second collision by incrementing the suffix', () => {
    const { decision } = clampDecisionCandidate(
      baseCandidate({ decision: 'New Factory' }),
      ['New Factory', 'New Factory (AI)'],
    );
    expect(decision.decision).toBe('New Factory (AI 2)');
  });

  it('filters excludes down to real existing decision names and removes self-reference', () => {
    const candidate = baseCandidate({ decision: 'My Decision', excludes: ['Real Decision', 'Made Up Decision', 'My Decision'] });
    const { decision } = clampDecisionCandidate(candidate, ['Real Decision']);
    expect(decision.excludes).toEqual(['Real Decision']);
  });

  it('defaults cashFlowCategory to "operating" when impacts.cash is set but the category is missing', () => {
    const { decision, warnings } = clampDecisionCandidate(baseCandidate(), []);
    expect((decision as any).cashFlowCategory).toBe('operating');
    expect(warnings.some((w) => w.path === 'cashFlowCategory')).toBe(true);
  });

  it('omits cashFlowCategory entirely when impacts.cash is not set', () => {
    const candidate = baseCandidate({ impacts: { outrage: { type: 'absolute', schedule: { default: 10 } } } });
    const { decision } = clampDecisionCandidate(candidate, []);
    expect(decision).not.toHaveProperty('cashFlowCategory');
  });

  it('caps competitorsView at 4 entries and drops empty strings', () => {
    const candidate = baseCandidate({ competitorsView: ['a', '', 'b', 'c', 'd', 'e'] });
    const { decision } = clampDecisionCandidate(candidate, []);
    expect(decision.competitorsView).toEqual(['a', 'b', 'c', 'd']);
  });

  it('replaces a missing/empty description with a placeholder rather than leaving it blank', () => {
    const { decision, warnings } = clampDecisionCandidate(baseCandidate({ description: '   ' }), []);
    expect(decision.description.length).toBeGreaterThan(0);
    expect(warnings.some((w) => w.path === 'description')).toBe(true);
  });

  it('defaults an invalid level/nature rather than throwing', () => {
    const candidate = baseCandidate({ level: 'Weird' as any, nature: 'Weird' as any });
    const { decision } = clampDecisionCandidate(candidate, []);
    expect(decision.level).toBe('Operational');
    expect(decision.nature).toBe('Traditional');
  });
});

describe('isViableCandidate', () => {
  it('is false when every impact field was stripped out', () => {
    const candidate = baseCandidate({ impacts: { madeUpField: { type: 'absolute', schedule: { default: 1 } } } as any });
    const result = clampDecisionCandidate(candidate, []);
    expect(isViableCandidate(result)).toBe(false);
  });

  it('is true when at least one real impact survives', () => {
    const result = clampDecisionCandidate(baseCandidate(), []);
    expect(isViableCandidate(result)).toBe(true);
  });
});
