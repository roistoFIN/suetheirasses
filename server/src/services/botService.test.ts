import { describe, it, expect, vi, afterEach } from 'vitest';
import { pickBotDecisions, pickAttacksToInvestigate, shouldFileLawsuit, BOT_CASH_RESERVE } from './botService';
import type { DecisionDefinition, IncomingAttackInfo } from '@suetheirasses/shared';

function makeDecisionDef(overrides: Partial<DecisionDefinition> = {}): DecisionDefinition {
  return {
    decision: 'Test Decision',
    level: 'Strategic',
    description: 'A test decision',
    nature: 'Traditional',
    offensiveAction: false,
    excludes: [],
    impacts: {},
    ...overrides,
  };
}

function makeAttack(overrides: Partial<IncomingAttackInfo> = {}): IncomingAttackInfo {
  return {
    attackId: 'attack-1',
    isIndirect: false,
    investigationLevel: 0,
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('pickBotDecisions', () => {
  it('excludes share-transaction decisions (Buy/Sell Shares) — out of scope for this bot', () => {
    const deck = [makeDecisionDef({ decision: 'Buy Shares', shareTransactionType: 'buy', requiresTarget: true, impacts: {} })];
    const picks = pickBotDecisions(deck, 100_000, 'human-1');
    expect(picks).toEqual([]);
  });

  it('never picks a decision whose year-1 cash cost would breach the reserve', () => {
    const cheap = makeDecisionDef({ decision: 'Cheap', impacts: { cash: { type: 'absolute', schedule: { 1: -1000, default: 0 } } } });
    const expensive = makeDecisionDef({ decision: 'Expensive', impacts: { cash: { type: 'absolute', schedule: { 1: -90_000, default: 0 } } } });
    const deck = [cheap, expensive];

    // Exactly enough for the cheap one plus reserve, not the expensive one.
    const cash = BOT_CASH_RESERVE + 1000;
    const picks = pickBotDecisions(deck, cash, 'human-1');

    expect(picks.map((p) => p.name)).toEqual(['Cheap']);
  });

  it('attaches the human player as targetId whenever a decision requiresTarget', () => {
    const attack = makeDecisionDef({ decision: 'Bot Attack', requiresTarget: true, impacts: {} });
    const picks = pickBotDecisions([attack], 500_000, 'human-42');
    expect(picks).toEqual([{ name: 'Bot Attack', targetId: 'human-42' }]);
  });

  it('leaves targetId undefined for a decision with no target concept', () => {
    const plain = makeDecisionDef({ decision: 'Plain Decision', impacts: {} });
    const picks = pickBotDecisions([plain], 500_000, 'human-42');
    expect(picks).toEqual([{ name: 'Plain Decision', targetId: undefined }]);
  });

  it('never picks more than 2 decisions even with a large affordable deck', () => {
    const deck = Array.from({ length: 10 }, (_, i) => makeDecisionDef({ decision: `Decision ${i}`, impacts: {} }));
    const picks = pickBotDecisions(deck, 500_000, 'human-1');
    expect(picks.length).toBeLessThanOrEqual(2);
  });

  it('returns an empty array when nothing is affordable', () => {
    const expensive = makeDecisionDef({ impacts: { cash: { type: 'absolute', schedule: { 1: -90_000, default: 0 } } } });
    const picks = pickBotDecisions([expensive], BOT_CASH_RESERVE, 'human-1');
    expect(picks).toEqual([]);
  });
});

describe('pickAttacksToInvestigate', () => {
  it('excludes attacks that are already fully revealed (have a suggestedGroundName)', () => {
    const revealed = makeAttack({ attackId: 'a', suggestedGroundName: 'Some Ground' });
    const notRevealed = makeAttack({ attackId: 'b', investigationLevel: 1 });
    const picks = pickAttacksToInvestigate([revealed, notRevealed]);
    expect(picks.map((a) => a.attackId)).toEqual(['b']);
  });

  it('prioritizes a partially-investigated attack over a fresh one', () => {
    const fresh = makeAttack({ attackId: 'fresh', investigationLevel: 0 });
    const partial = makeAttack({ attackId: 'partial', investigationLevel: 2 });
    const picks = pickAttacksToInvestigate([fresh, partial]);
    expect(picks.map((a) => a.attackId)).toEqual(['partial', 'fresh']);
  });

  it('caps at maxPicks', () => {
    const attacks = [
      makeAttack({ attackId: 'a', investigationLevel: 1 }),
      makeAttack({ attackId: 'b', investigationLevel: 2 }),
      makeAttack({ attackId: 'c', investigationLevel: 0 }),
    ];
    const picks = pickAttacksToInvestigate(attacks, 2);
    expect(picks).toHaveLength(2);
  });
});

describe('shouldFileLawsuit', () => {
  const filingCost = 15_000;

  it('is false when the attack is not yet fully revealed', () => {
    const attack = makeAttack({ investigationLevel: 2 });
    expect(shouldFileLawsuit(attack, 500_000, filingCost)).toBe(false);
  });

  it('is false when the estimated win chance is at or below 30%', () => {
    const attack = makeAttack({ suggestedGroundName: 'Ground', successProbability: 0.3 });
    expect(shouldFileLawsuit(attack, 500_000, filingCost)).toBe(false);
  });

  it('is true once the estimated win chance clears 30% and cash covers the fee plus reserve', () => {
    const attack = makeAttack({ suggestedGroundName: 'Ground', successProbability: 0.31 });
    expect(shouldFileLawsuit(attack, 500_000, filingCost)).toBe(true);
  });

  it('is false when filing would breach the reserve, even with good odds', () => {
    const attack = makeAttack({ suggestedGroundName: 'Ground', successProbability: 0.9 });
    const cash = BOT_CASH_RESERVE + filingCost - 1;
    expect(shouldFileLawsuit(attack, cash, filingCost)).toBe(false);
  });
});
