import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  pickBotDecisions,
  pickBotShareBuy,
  pickAttacksToInvestigate,
  shouldFileLawsuit,
  scoreDecision,
  decideBotNegotiationAction,
  BOT_CASH_RESERVE,
  BOT_RISK_CAUTION_THRESHOLD,
  BOT_BUY_SHARES_MIN_SPARE_CASH,
  BOT_BUY_SHARES_SPEND_FRACTION,
} from './botService';
import type { DecisionDefinition, IncomingAttackInfo, LegalCaseData } from '@suethemchickens/shared';

function makeCase(overrides: Partial<LegalCaseData> = {}): LegalCaseData {
  return {
    id: 'case-1',
    roomId: 'room-1',
    plaintiffId: 'human-1',
    defendantId: 'bot-1',
    decisionName: 'Water Pumping',
    groundName: 'Environmental Violation',
    description: 'x',
    baseProbability: 0.5,
    adjustedProbability: undefined,
    plaintiffFullyInvestigated: false,
    defendantInvestigated: false,
    stakes: 100_000,
    status: 'negotiating',
    offers: [],
    turnsNegotiating: 0,
    verdict: undefined,
    createdAt: new Date('2024-01-01'),
    resolvedAt: undefined,
    ...overrides,
  };
}

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

  // Regression/new-behavior: the bot used to pick uniformly at random among everything
  // affordable. It now scores the deck (scoreDecision) and biases toward the better half.
  // With exactly 2 candidates, the better-scoring half is a single-element slice — shuffling
  // a 1-element array is a no-op — so the better one is deterministically ordered first,
  // making this assertable exactly rather than just statistically.
  it('prefers the better-scoring decision as its first pick when multiple are affordable', () => {
    const great = makeDecisionDef({
      decision: 'Great Pick',
      impacts: { cash: { type: 'absolute', schedule: { 1: 50_000, default: 0 } }, price: { type: 'relative', schedule: { 1: 0.3, default: 0 } } },
    });
    const poor = makeDecisionDef({
      decision: 'Poor Pick',
      impacts: { cash: { type: 'absolute', schedule: { 1: -10_000, default: 0 } }, price: { type: 'relative', schedule: { 1: -0.3, default: 0 } } },
    });
    const picks = pickBotDecisions([poor, great], 500_000, 'human-1');
    expect(picks[0]?.name).toBe('Great Pick');
  });

  // Regression: the original version checked each pick's affordability independently
  // against the STARTING cash, so two individually-affordable picks could collectively
  // breach the reserve in the same turn.
  it('never lets two picks in the same turn collectively breach the reserve, even though each is individually affordable', () => {
    const a = makeDecisionDef({ decision: 'A', impacts: { cash: { type: 'absolute', schedule: { 1: -15_000, default: 0 } } } });
    const b = makeDecisionDef({ decision: 'B', impacts: { cash: { type: 'absolute', schedule: { 1: -15_000, default: 0 } } } });
    const cash = BOT_CASH_RESERVE + 15_000; // affords exactly one of these, never both together
    for (let i = 0; i < 100; i++) {
      const picks = pickBotDecisions([a, b], cash, 'human-1');
      expect(picks.length).toBeLessThanOrEqual(1);
    }
  });

  it('excludes Dirty-nature decisions once riskGauge is at/above the caution threshold — self-preservation', () => {
    const dirty = makeDecisionDef({ decision: 'Dirty Pick', nature: 'Dirty', impacts: {} });
    const safe = makeDecisionDef({ decision: 'Safe Pick', nature: 'Traditional', impacts: {} });
    for (let i = 0; i < 20; i++) {
      const picks = pickBotDecisions([dirty, safe], 500_000, 'human-1', BOT_RISK_CAUTION_THRESHOLD);
      expect(picks.some((p) => p.name === 'Dirty Pick')).toBe(false);
    }
  });

  it('still allows a Dirty-nature decision below the caution threshold', () => {
    const dirty = makeDecisionDef({ decision: 'Dirty Pick', nature: 'Dirty', impacts: {} });
    const picks = pickBotDecisions([dirty], 500_000, 'human-1', BOT_RISK_CAUTION_THRESHOLD - 1);
    expect(picks.map((p) => p.name)).toEqual(['Dirty Pick']);
  });
});

describe('scoreDecision', () => {
  it('scores a decision with a positive cash impact higher than an otherwise-identical one with a negative impact', () => {
    const good = makeDecisionDef({ impacts: { cash: { type: 'absolute', schedule: { 1: 30_000, default: 0 } } } });
    const bad = makeDecisionDef({ impacts: { cash: { type: 'absolute', schedule: { 1: -30_000, default: 0 } } } });
    expect(scoreDecision(good, 0)).toBeGreaterThan(scoreDecision(bad, 0));
  });

  it('scores raising a good-when-higher field (e.g. price) above lowering it', () => {
    const raises = makeDecisionDef({ impacts: { price: { type: 'relative', schedule: { 1: 0.2, default: 0 } } } });
    const lowers = makeDecisionDef({ impacts: { price: { type: 'relative', schedule: { 1: -0.2, default: 0 } } } });
    expect(scoreDecision(raises, 0)).toBeGreaterThan(scoreDecision(lowers, 0));
  });

  it('scores lowering a good-when-lower field (e.g. operatingExpenses) above raising it', () => {
    const lowers = makeDecisionDef({ impacts: { operatingExpenses: { type: 'absolute', schedule: { 1: -10_000, default: 0 } } } });
    const raises = makeDecisionDef({ impacts: { operatingExpenses: { type: 'absolute', schedule: { 1: 10_000, default: 0 } } } });
    expect(scoreDecision(lowers, 0)).toBeGreaterThan(scoreDecision(raises, 0));
  });

  it('ignores a field with no real formula reference (pure flavor text)', () => {
    const withFlavor = makeDecisionDef({ impacts: { energyIntensity: { type: 'relative', schedule: { 1: 0.9, default: 0 } } } });
    const withoutFlavor = makeDecisionDef({ impacts: {} });
    expect(scoreDecision(withFlavor, 0)).toBe(scoreDecision(withoutFlavor, 0));
  });

  it('adds a bonus for a decision that targets the human (requiresTarget)', () => {
    const targeted = makeDecisionDef({ requiresTarget: true, impacts: {} });
    const neutral = makeDecisionDef({ requiresTarget: false, impacts: {} });
    expect(scoreDecision(targeted, 0)).toBeGreaterThan(scoreDecision(neutral, 0));
  });

  it('adds the same bonus for an indirect decision with a target.* impact but no requiresTarget flag', () => {
    const indirect = makeDecisionDef({ requiresTarget: false, impacts: { 'target.cash': { type: 'absolute', schedule: { 1: -10_000, default: 0 } } } });
    const neutral = makeDecisionDef({ requiresTarget: false, impacts: {} });
    expect(scoreDecision(indirect, 0)).toBeGreaterThan(scoreDecision(neutral, 0));
  });

  it('penalizes a Dirty-nature decision once riskGauge reaches the caution threshold, not below it', () => {
    const dirty = makeDecisionDef({ nature: 'Dirty', impacts: {} });
    const scoreBelow = scoreDecision(dirty, BOT_RISK_CAUTION_THRESHOLD - 1);
    const scoreAtThreshold = scoreDecision(dirty, BOT_RISK_CAUTION_THRESHOLD);
    expect(scoreAtThreshold).toBeLessThan(scoreBelow);
  });
});

describe('pickBotShareBuy', () => {
  it('never buys when the financial-decision budget is already used up this turn', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    expect(pickBotShareBuy(500_000, 2, 2)).toBeUndefined();
  });

  it('never buys when spare cash is below the minimum, even with a favorable roll', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const cash = BOT_CASH_RESERVE + BOT_BUY_SHARES_MIN_SPARE_CASH - 1;
    expect(pickBotShareBuy(cash, 0, 2)).toBeUndefined();
  });

  it('passes on an unfavorable per-turn roll even when otherwise eligible', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.99);
    expect(pickBotShareBuy(500_000, 0, 2)).toBeUndefined();
  });

  it('spends BOT_BUY_SHARES_SPEND_FRACTION of spare cash (above the reserve) when it does buy', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const cash = BOT_CASH_RESERVE + 100_000;
    expect(pickBotShareBuy(cash, 0, 2)).toBe(Math.round(100_000 * BOT_BUY_SHARES_SPEND_FRACTION));
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

describe('decideBotNegotiationAction', () => {
  const digDeeperCost = 10_000;

  it('waits when it is not the bot\'s turn to respond (the other party made the last offer... or rather, the bot itself did)', () => {
    // Bot is defendant; defendant just made the most recent offer, so it's the
    // plaintiff's turn to respond next, not the bot's.
    const case_ = makeCase({ defendantInvestigated: true, offers: [{ by: 'defendant', amount: 40_000 }] });
    expect(decideBotNegotiationAction(case_, 'defendant', 500_000, digDeeperCost)).toEqual({ type: 'wait' });
  });

  it('waits as plaintiff when the defendant has not opened yet — the defendant always moves first', () => {
    const case_ = makeCase({ offers: [] });
    expect(decideBotNegotiationAction(case_, 'plaintiff', 500_000, digDeeperCost)).toEqual({ type: 'wait' });
  });

  it('digs deeper on the case first, as defendant, when it doesn\'t yet know the odds and can afford to', () => {
    const case_ = makeCase({ defendantInvestigated: false, offers: [{ by: 'plaintiff', amount: 90_000 }] });
    expect(decideBotNegotiationAction(case_, 'defendant', 500_000, digDeeperCost)).toEqual({ type: 'digDeeperOnCase' });
  });

  it('falls back to a 50/50 assumption (rather than stalling) when it can\'t afford to dig', () => {
    const case_ = makeCase({
      defendantInvestigated: false, baseProbability: 0.9, stakes: 100_000,
      offers: [{ by: 'plaintiff', amount: 40_000 }],
    });
    const cash = BOT_CASH_RESERVE + digDeeperCost - 1; // can't afford the dig
    // fairValue at the 50/50 fallback = 0.5 * 100,000 = 50,000; the plaintiff's 40,000
    // ask is within BOT_DEFENDANT_ACCEPT_TOLERANCE (1.15x) of that, so: accept.
    expect(decideBotNegotiationAction(case_, 'defendant', cash, digDeeperCost)).toEqual({ type: 'accept' });
  });

  it('as defendant, opens with a below-fair-value offer when nothing has been offered yet', () => {
    const case_ = makeCase({ defendantInvestigated: true, baseProbability: 0.5, stakes: 100_000, offers: [] });
    const action = decideBotNegotiationAction(case_, 'defendant', 500_000, digDeeperCost);
    // fairValue = 50,000; opening = round(50,000 * 0.7) = 35,000.
    expect(action).toEqual({ type: 'counter', amount: 35_000 });
  });

  it('as defendant, accepts an ask already close to (or below) fair value', () => {
    const case_ = makeCase({
      defendantInvestigated: true, baseProbability: 0.3, stakes: 100_000,
      offers: [{ by: 'plaintiff', amount: 32_000 }], // fairValue = 30,000; within 1.15x
    });
    expect(decideBotNegotiationAction(case_, 'defendant', 500_000, digDeeperCost)).toEqual({ type: 'accept' });
  });

  it('as defendant, forces a trial instead of paying anything when the odds are heavily in its favor', () => {
    const case_ = makeCase({
      defendantInvestigated: true, baseProbability: 0.1, stakes: 100_000,
      offers: [{ by: 'plaintiff', amount: 80_000 }], // way above fairValue (10,000), and probability <= 0.15
    });
    expect(decideBotNegotiationAction(case_, 'defendant', 500_000, digDeeperCost)).toEqual({ type: 'goToCourt' });
  });

  it('as defendant, counters toward fair value when the ask is too high but the odds aren\'t lopsided enough to force a trial', () => {
    const case_ = makeCase({
      defendantInvestigated: true, baseProbability: 0.5, stakes: 100_000,
      offers: [{ by: 'plaintiff', amount: 90_000 }], // fairValue = 50,000, probability well above the court threshold
    });
    expect(decideBotNegotiationAction(case_, 'defendant', 500_000, digDeeperCost)).toEqual({ type: 'counter', amount: 50_000 });
  });

  it('as plaintiff, accepts a defendant\'s offer already close to (or above) fair value', () => {
    const case_ = makeCase({
      plaintiffId: 'bot-1', defendantId: 'human-1', plaintiffFullyInvestigated: true,
      baseProbability: 0.7, stakes: 100_000,
      offers: [{ by: 'defendant', amount: 60_000 }], // fairValue = 70,000; within 0.85x
    });
    expect(decideBotNegotiationAction(case_, 'plaintiff', 500_000, digDeeperCost)).toEqual({ type: 'accept' });
  });

  it('as plaintiff, forces a trial instead of settling cheap when the odds are heavily in its favor', () => {
    const case_ = makeCase({
      plaintiffId: 'bot-1', defendantId: 'human-1', plaintiffFullyInvestigated: true,
      baseProbability: 0.9, stakes: 100_000,
      offers: [{ by: 'defendant', amount: 20_000 }], // way below fairValue (90,000), probability >= 0.85
    });
    expect(decideBotNegotiationAction(case_, 'plaintiff', 500_000, digDeeperCost)).toEqual({ type: 'goToCourt' });
  });

  it('as plaintiff, counters toward fair value when the offer is too low but the odds aren\'t lopsided enough to force a trial', () => {
    const case_ = makeCase({
      plaintiffId: 'bot-1', defendantId: 'human-1', plaintiffFullyInvestigated: true,
      baseProbability: 0.5, stakes: 100_000,
      offers: [{ by: 'defendant', amount: 10_000 }], // fairValue = 50,000
    });
    expect(decideBotNegotiationAction(case_, 'plaintiff', 500_000, digDeeperCost)).toEqual({ type: 'counter', amount: 50_000 });
  });

  it('clamps a counter-offer to the current bracket even when fair value itself sits outside it', () => {
    // Bracket: defendant previously offered 40,000, plaintiff countered down to 80,000
    // (from the full 100,000 stakes) — bracket is [40,000, 80,000]. At a LOW probability
    // (0.2), fairValue (20,000) sits below the bracket's own floor: the plaintiff's ask
    // (80,000) is still well above tolerance (so no accept), and 0.2 is just above the
    // court threshold (0.15, so no forced trial either) — the counter must clamp UP to
    // the bracket's floor (40,000) rather than offering fairValue itself, which the
    // defendant already committed above via their own prior 40,000 offer.
    const case_ = makeCase({
      defendantInvestigated: true, baseProbability: 0.2, stakes: 100_000,
      offers: [
        { by: 'defendant', amount: 40_000 },
        { by: 'plaintiff', amount: 80_000 },
      ],
    });
    const action = decideBotNegotiationAction(case_, 'defendant', 500_000, digDeeperCost);
    expect(action).toEqual({ type: 'counter', amount: 40_000 });
  });
});
