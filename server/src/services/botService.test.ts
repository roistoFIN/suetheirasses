import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  pickBotDecisions,
  pickBotShareBuy,
  pickAttacksToInvestigate,
  shouldFileLawsuit,
  scoreDecision,
  decideBotNegotiationAction,
  estimatedFirstYearCashEffect,
  isCashTrendDeclining,
  computeEffectiveReserve,
  projectedNextTurnOwnCashEffect,
  isStructurallyUnprofitable,
  BOT_CASH_RESERVE,
  BOT_RISK_CAUTION_THRESHOLD,
  BOT_BUY_SHARES_MIN_SPARE_CASH,
  BOT_BUY_SHARES_SPEND_FRACTION,
  BOT_CASH_TREND_WINDOW,
  BOT_CASH_TREND_RESERVE_MULTIPLIER,
  DEFAULT_INTEREST_RATE,
  type BotCogsContext,
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

  // Regression: a real, reported bug where the bot's attacks never actually landed. Almost
  // every real attacking decision in the seeded library (Bot Attack, Fox Release, Patent
  // Trolling, Talent Poaching, Union Agitation, etc. — 53 of them) carries a `target.*`
  // impact field but does NOT set `requiresTarget: true` in the actual data (only Buy/Sell
  // Shares do — see GamePhase.tsx's `decisionNeedsTarget` and this file's own `needsTarget`
  // helper, both of which already treat "has a target.* impact" as target-needing). This
  // line used to check `def.requiresTarget` directly instead of calling the already-defined
  // `needsTarget` helper (used one line above for the scoring bonus, but not reused here),
  // so `targetId` silently stayed `undefined` for every one of these — and
  // `DecisionEngine.collectTargetImpacts` skips any active decision with no `targetId`
  // entirely, meaning the attack was deployed but its harmful effect on the human never
  // applied. Only Buy Shares (real `requiresTarget: true`) was ever visibly landing,
  // matching the exact symptom reported: "the bot bought my shares and I noticed an effect,
  // but other decisions didn't affect my cash flow."
  it('attaches the human player as targetId for a decision with a target.* impact but no requiresTarget flag (matches the real seeded library)', () => {
    const attack = makeDecisionDef({
      decision: 'Bot Attack',
      impacts: { 'target.outrage': { type: 'absolute', schedule: { default: -8 } } },
    });
    const picks = pickBotDecisions([attack], 500_000, 'human-42');
    expect(picks).toEqual([{ name: 'Bot Attack', targetId: 'human-42' }]);
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

  // Regression: a decision like "Manure Futures Speculation" (cash +84,000 at year 1,
  // financeCost +12,000 at years 2-3) used to look like a pure windfall to the year-1-only
  // affordability check — the reserve check never saw the backloaded cost coming. Budgets
  // now use the worst realistic year across the whole schedule (worstCaseCashEffect), not
  // just year 1.
  it('never picks a decision whose worst-year (not just year-1) cash effect would breach the reserve', () => {
    const backloaded = makeDecisionDef({
      decision: 'Backloaded',
      impacts: {
        cash: { type: 'absolute', schedule: { 1: 84_000, default: 0 } },
        financeCost: { type: 'absolute', schedule: { 1: 0, 2: 200_000, default: 0 } },
      },
    });
    const cash = BOT_CASH_RESERVE + 10_000; // affords the year-1 number, not the year-2 one
    const picks = pickBotDecisions([backloaded], cash, 'human-1');
    expect(picks).toEqual([]);
  });

  it('excludes any new decision whose worst-case cash effect is negative once structurallyUnprofitable is signaled', () => {
    const costly = makeDecisionDef({ decision: 'Costly', impacts: { cash: { type: 'absolute', schedule: { 1: -1000, default: 0 } } } });
    const free = makeDecisionDef({ decision: 'Free', impacts: {} });
    const picks = pickBotDecisions([costly, free], 500_000, 'human-1', 0, BOT_CASH_RESERVE, DEFAULT_INTEREST_RATE, true);
    expect(picks.map((p) => p.name)).toEqual(['Free']);
  });

  it('still allows a non-negative-cost decision even while structurallyUnprofitable', () => {
    const positive = makeDecisionDef({ decision: 'Positive', impacts: { cash: { type: 'absolute', schedule: { 1: 1000, default: 0 } } } });
    const picks = pickBotDecisions([positive], 500_000, 'human-1', 0, BOT_CASH_RESERVE, DEFAULT_INTEREST_RATE, true);
    expect(picks.map((p) => p.name)).toEqual(['Positive']);
  });

  // Regression: the bot never validated against DecisionEngine.canDeploy at all, so it
  // kept "picking" a permanent-effect decision still on its redeploy-lock cooldown every
  // turn — GameLoop.processNewDecisions silently rejected the deployment, but the bot's
  // own cash accounting had already credited itself the full (never-realized) windfall,
  // inflating what it believed it could then afford to spend elsewhere.
  it('excludes a permanent-effect decision still within its own redeploy-lock cooldown', () => {
    const permanent = makeDecisionDef({
      decision: 'Convertible Note Overhang',
      impacts: { cash: { type: 'absolute', schedule: { default: 71_000 } } }, // 'default'-only => hasPermanentEffect
    });
    const activeDecisions = [{ decisionName: 'Convertible Note Overhang', elapsedYears: 1, isMatured: true, voidedByLawsuit: false }];
    const picks = pickBotDecisions([permanent], 500_000, 'human-1', 0, BOT_CASH_RESERVE, DEFAULT_INTEREST_RATE, false, activeDecisions, 3);
    expect(picks).toEqual([]);
  });

  it('allows redeploying a permanent-effect decision once its cooldown has passed', () => {
    const permanent = makeDecisionDef({
      decision: 'Convertible Note Overhang',
      impacts: { cash: { type: 'absolute', schedule: { default: 71_000 } } },
    });
    const activeDecisions = [{ decisionName: 'Convertible Note Overhang', elapsedYears: 5, isMatured: true, voidedByLawsuit: false }];
    const picks = pickBotDecisions([permanent], 500_000, 'human-1', 0, BOT_CASH_RESERVE, DEFAULT_INTEREST_RATE, false, activeDecisions, 3);
    expect(picks.map((p) => p.name)).toEqual(['Convertible Note Overhang']);
  });

  it('allows redeploying a permanent-effect decision whose prior instance was voided by a lost lawsuit', () => {
    const permanent = makeDecisionDef({
      decision: 'Convertible Note Overhang',
      impacts: { cash: { type: 'absolute', schedule: { default: 71_000 } } },
    });
    const activeDecisions = [{ decisionName: 'Convertible Note Overhang', elapsedYears: 1, isMatured: true, voidedByLawsuit: true }];
    const picks = pickBotDecisions([permanent], 500_000, 'human-1', 0, BOT_CASH_RESERVE, DEFAULT_INTEREST_RATE, false, activeDecisions, 3);
    expect(picks.map((p) => p.name)).toEqual(['Convertible Note Overhang']);
  });

  it('excludes ANY decision (not just permanent-effect ones) whose own prior instance has not yet matured', () => {
    const def = makeDecisionDef({ decision: 'Slow Ramp', impacts: {} });
    const activeDecisions = [{ decisionName: 'Slow Ramp', elapsedYears: 0, isMatured: false, voidedByLawsuit: false }];
    const picks = pickBotDecisions([def], 500_000, 'human-1', 0, BOT_CASH_RESERVE, DEFAULT_INTEREST_RATE, false, activeDecisions);
    expect(picks).toEqual([]);
  });

  it('excludes a decision forward-excluded by an unmatured active decision (canDeploy\'s mutual-exclusion rule)', () => {
    const def = makeDecisionDef({ decision: 'New Pick', excludes: ['Old Pick'] });
    const activeDecisions = [{ decisionName: 'Old Pick', elapsedYears: 0, isMatured: false, voidedByLawsuit: false }];
    const picks = pickBotDecisions([def], 500_000, 'human-1', 0, BOT_CASH_RESERVE, DEFAULT_INTEREST_RATE, false, activeDecisions);
    expect(picks).toEqual([]);
  });

  it('excludes a decision reverse-excluded by an unmatured active decision\'s own excludes list', () => {
    // 'Old Pick' isn't itself a candidate here (only its excludes list matters) — using a
    // separate 'Unrelated Pick' as the control keeps this isolated from the "own redeploy
    // lock" rule (which would otherwise also block 'Old Pick' from being a candidate,
    // conflating the two mechanisms in one assertion).
    const newDef = makeDecisionDef({ decision: 'New Pick' });
    const unrelatedDef = makeDecisionDef({ decision: 'Unrelated Pick' });
    const activeDecisions = [{ decisionName: 'Old Pick', elapsedYears: 0, isMatured: false, voidedByLawsuit: false }];
    // deck must include 'Old Pick' so its excludes list can be looked up by name, even
    // though 'Old Pick' itself isn't expected to appear among the picks.
    const oldDef = makeDecisionDef({ decision: 'Old Pick', excludes: ['New Pick'] });
    const picks = pickBotDecisions([newDef, unrelatedDef, oldDef], 500_000, 'human-1', 0, BOT_CASH_RESERVE, DEFAULT_INTEREST_RATE, false, activeDecisions);
    expect(picks.some((p) => p.name === 'New Pick')).toBe(false);
    expect(picks.some((p) => p.name === 'Unrelated Pick')).toBe(true);
  });

  // Regression for a real, reported bug: the bot would reliably bankrupt itself against a
  // fully idle human because the affordability check never accounted for COGS
  // (materialCostPerTon+logisticsCostPerTon)*volume, even though it's very often the
  // single largest real cost — see BotCogsContext's own doc comment. A decision with no
  // `cash`/DOLLAR_FIELDS impact at all used to look completely free regardless of how
  // much it permanently raised per-ton costs.
  it('rejects a decision whose real COGS cost would breach the reserve, once a live BotCogsContext is supplied', () => {
    const costly = makeDecisionDef({
      decision: 'Costly COGS Pick',
      impacts: { materialCostPerTon: { type: 'relative', schedule: { default: 0.5 } } }, // permanent +50%
    });
    const cogs: BotCogsContext = { volume: 350, materialCostPerTon: 500, logisticsCostPerTon: 50 };
    // Real cost: +50% of $500/ton = $250/ton more, times 350 tons = $87,500 — nowhere near
    // affordable against a $100k cash pile and the standard reserve.
    const picks = pickBotDecisions([costly], 100_000, 'human-1', 0, BOT_CASH_RESERVE, DEFAULT_INTEREST_RATE, false, [], Infinity, cogs);
    expect(picks).toEqual([]);
  });

  it('picks that same decision when no BotCogsContext is supplied — illustrates why GameEngine.runBotTurn must always pass live COGS state', () => {
    const costly = makeDecisionDef({
      decision: 'Costly COGS Pick',
      impacts: { materialCostPerTon: { type: 'relative', schedule: { default: 0.5 } } },
    });
    const picks = pickBotDecisions([costly], 100_000, 'human-1');
    expect(picks.map((p) => p.name)).toEqual(['Costly COGS Pick']);
  });
});

describe('estimatedFirstYearCashEffect', () => {
  it('is just the cash field alone when nothing else is set', () => {
    const def = makeDecisionDef({ impacts: { cash: { type: 'absolute', schedule: { 1: -25_000, default: 0 } } } });
    expect(estimatedFirstYearCashEffect(def)).toBe(-25_000);
  });

  // Regression: "Non-Disclosure Severance" (cash -25,000, staffCost +15,000) used to look
  // like a $25k spend when it actually cost ~$40k in real cash the very turn it deployed.
  it('folds in DOLLAR_FIELDS (operatingExpenses/staffCost/otherIncome/financeCost) alongside the cash field', () => {
    const def = makeDecisionDef({
      impacts: {
        cash: { type: 'absolute', schedule: { 1: -25_000, default: 0 } },
        staffCost: { type: 'absolute', schedule: { 1: 15_000, default: 0 } },
      },
    });
    expect(estimatedFirstYearCashEffect(def)).toBe(-40_000);
  });

  it('converts a debt impact into its financeCost-equivalent cost (debt * interestRate)', () => {
    const def = makeDecisionDef({ impacts: { debt: { type: 'absolute', schedule: { 1: 100_000, default: 0 } } } });
    expect(estimatedFirstYearCashEffect(def, 0.05)).toBe(-5000);
  });

  it('otherIncome contributes positively, not as a cost', () => {
    const def = makeDecisionDef({ impacts: { otherIncome: { type: 'absolute', schedule: { 1: 12_000, default: 0 } } } });
    expect(estimatedFirstYearCashEffect(def)).toBe(12_000);
  });

  // Regression for a real, reported bug: the bot would reliably bankrupt itself against a
  // fully idle human because NONE of its cash-aware functions accounted for COGS
  // (materialCostPerTon+logisticsCostPerTon)*volume — see BotCogsContext's own doc
  // comment. materialCostPerTon/logisticsCostPerTon are always RELATIVE in the real
  // library, so converting to a dollar cost needs the bot's own current $/ton rate.
  it('converts a RELATIVE materialCostPerTon impact into a real dollar COGS cost when a BotCogsContext is supplied', () => {
    const def = makeDecisionDef({ impacts: { materialCostPerTon: { type: 'relative', schedule: { 1: 0.1, default: 0 } } } });
    const cogs: BotCogsContext = { volume: 350, materialCostPerTon: 500, logisticsCostPerTon: 50 };
    // +10% of $500/ton = $50/ton more, times 350 tons sold = $17,500 real recurring cost.
    expect(estimatedFirstYearCashEffect(def, DEFAULT_INTEREST_RATE, cogs)).toBe(-17_500);
  });

  it('treats a COGS-affecting decision as free when no BotCogsContext is supplied (safe default for a caller with no live state)', () => {
    const def = makeDecisionDef({ impacts: { materialCostPerTon: { type: 'relative', schedule: { 1: 0.5, default: 0 } } } });
    expect(estimatedFirstYearCashEffect(def)).toBe(0);
  });
});

describe('isCashTrendDeclining / computeEffectiveReserve', () => {
  it('is false with fewer than BOT_CASH_TREND_WINDOW readings', () => {
    expect(isCashTrendDeclining(Array(BOT_CASH_TREND_WINDOW - 1).fill(100))).toBe(false);
  });

  it('is true when cash over the window has net declined', () => {
    const history = [100_000, 80_000, 60_000].slice(0, BOT_CASH_TREND_WINDOW);
    expect(isCashTrendDeclining(history)).toBe(true);
  });

  it('is false when cash over the window has net risen, even with a dip in the middle', () => {
    const history = [100_000, 50_000, 120_000].slice(0, BOT_CASH_TREND_WINDOW);
    expect(isCashTrendDeclining(history)).toBe(false);
  });

  it('computeEffectiveReserve multiplies the base reserve once the trend is declining', () => {
    const declining = [100_000, 80_000, 60_000].slice(0, BOT_CASH_TREND_WINDOW);
    expect(computeEffectiveReserve(declining, 0, BOT_CASH_RESERVE)).toBe(BOT_CASH_RESERVE * BOT_CASH_TREND_RESERVE_MULTIPLIER);
  });

  it('computeEffectiveReserve adds the projected next-turn cost (if negative) on top', () => {
    const stable = [100_000, 100_000, 100_000].slice(0, BOT_CASH_TREND_WINDOW);
    expect(computeEffectiveReserve(stable, -30_000, BOT_CASH_RESERVE)).toBe(BOT_CASH_RESERVE + 30_000);
  });

  it('computeEffectiveReserve ignores a projected next-turn effect that is net positive', () => {
    const stable = [100_000, 100_000, 100_000].slice(0, BOT_CASH_TREND_WINDOW);
    expect(computeEffectiveReserve(stable, 30_000, BOT_CASH_RESERVE)).toBe(BOT_CASH_RESERVE);
  });
});

describe('projectedNextTurnOwnCashEffect', () => {
  const deck = [
    makeDecisionDef({
      decision: 'Manure Futures Speculation',
      impacts: {
        cash: { type: 'absolute', schedule: { 1: 84_000, default: 0 } },
        financeCost: { type: 'absolute', schedule: { 1: 0, 2: 12_000, 3: 12_000, default: 0 } },
      },
    }),
  ];

  it('projects a backloaded cost landing next turn that year-1 pricing never saw', () => {
    // elapsedYears 1 -> next turn is elapsedYears 2, well within maturityYears (3).
    const activeDecisions = [{ decisionName: 'Manure Futures Speculation', elapsedYears: 1, maturityYears: 3, voidedByLawsuit: false }];
    expect(projectedNextTurnOwnCashEffect(activeDecisions, deck)).toBe(-12_000);
  });

  it('projects nothing once the instance is past its own maturity threshold', () => {
    const activeDecisions = [{ decisionName: 'Manure Futures Speculation', elapsedYears: 3, maturityYears: 3, voidedByLawsuit: false }];
    expect(projectedNextTurnOwnCashEffect(activeDecisions, deck)).toBe(0);
  });

  it('projects nothing for an instance voided by a lost lawsuit', () => {
    const activeDecisions = [{ decisionName: 'Manure Futures Speculation', elapsedYears: 1, maturityYears: 3, voidedByLawsuit: true }];
    expect(projectedNextTurnOwnCashEffect(activeDecisions, deck)).toBe(0);
  });

  it('sums across multiple active decisions', () => {
    const activeDecisions = [
      { decisionName: 'Manure Futures Speculation', elapsedYears: 1, maturityYears: 3, voidedByLawsuit: false },
      { decisionName: 'Manure Futures Speculation', elapsedYears: 1, maturityYears: 3, voidedByLawsuit: false },
    ];
    // Both instances project to the same next elapsedYears (2) => -12,000 each.
    expect(projectedNextTurnOwnCashEffect(activeDecisions, deck)).toBe(-24_000);
  });
});

describe('isStructurallyUnprofitable', () => {
  it('is true when operatingExpenses+staffCost+financeCost (net of otherIncome) exceeds revenue', () => {
    expect(isStructurallyUnprofitable(95_250, 26_000, 36_000, 84_000, 70_000)).toBe(true);
  });

  it('is false for a healthy company whose revenue covers its cost structure', () => {
    expect(isStructurallyUnprofitable(20_000, 10_000, 0, 5_000, 100_000)).toBe(false);
  });

  it('is false exactly at breakeven', () => {
    expect(isStructurallyUnprofitable(30_000, 10_000, 0, 10_000, 50_000)).toBe(false);
  });

  // Regression for a real, reported bug: this function used to omit COGS entirely, even
  // though `cogs = (materialCostPerTon + logisticsCostPerTon) * volume` (calcEngine.ts) is
  // very often the SINGLE LARGEST real cost — a live-play investigation found a traced
  // game reporting `false` here for 10+ straight rounds while the real (COGS-inclusive)
  // profit was -$40k to -$120k every turn, directly causing the bot's self-bankruptcy
  // against a fully idle human. Same "healthy" pre-COGS numbers as the false case above
  // (opex 20k, staff 10k, other 0, finance 5k, revenue 100k -> approxEbit without COGS is
  // +$65k) but $550/ton * 350 tons = $192,500 of COGS revenue can't possibly cover.
  it('is true once COGS is folded in, even though the pre-COGS numbers alone look healthy', () => {
    expect(isStructurallyUnprofitable(20_000, 10_000, 0, 5_000, 100_000, 500, 50, 350)).toBe(true);
  });

  it('still treats COGS as zero when materialCostPerTon/logisticsCostPerTon/volume are omitted (backward-compatible default)', () => {
    expect(isStructurallyUnprofitable(20_000, 10_000, 0, 5_000, 100_000)).toBe(false);
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

  // Regression: neither `debt` nor `financeCost` used to be scored at all, so a decision
  // like "Payday Loan"/"Manure Futures Speculation" (a real cash windfall funded by taking
  // on debt with a real recurring financeCost) scored as a near-pure windfall with none of
  // its real cost represented — the bot's own scoring was actively biased toward exactly
  // the decisions most likely to bankrupt it.
  it('scores a financeCost increase as a real cost, not invisibly', () => {
    const costly = makeDecisionDef({ impacts: { financeCost: { type: 'absolute', schedule: { 1: 9000, default: 0 } } } });
    const free = makeDecisionDef({ impacts: {} });
    expect(scoreDecision(costly, 0)).toBeLessThan(scoreDecision(free, 0));
  });

  it('scores a debt increase as a real cost via its financeCost-equivalent (debt * interestRate)', () => {
    const indebted = makeDecisionDef({ impacts: { debt: { type: 'absolute', schedule: { 1: 100_000, default: 0 } } } });
    const free = makeDecisionDef({ impacts: {} });
    expect(scoreDecision(indebted, 0, 0.05)).toBeLessThan(scoreDecision(free, 0, 0.05));
  });

  // Regression: scoring only ever read a decision's year-1 value, so a genuinely
  // backloaded cost (zero at deployment, landing hard in a later year) scored as
  // completely free at the exact moment the bot had to decide whether to pick it —
  // scoring is now pessimistic across the whole schedule (worstCaseCashEffect), not just
  // year 1.
  it('penalizes a backloaded financeCost cost even though its year-1 value is zero', () => {
    const backloaded = makeDecisionDef({ impacts: { financeCost: { type: 'absolute', schedule: { 1: 0, 2: 50_000, default: 0 } } } });
    const free = makeDecisionDef({ impacts: {} });
    expect(scoreDecision(backloaded, 0)).toBeLessThan(scoreDecision(free, 0));
  });

  // Regression for a real, reported bug: the bot's self-bankruptcy against a fully idle
  // human traced back to materialCostPerTon/logisticsCostPerTon never being scored as a
  // real dollar cost — they were scored via the generic per-field loop (a raw fractional
  // delta compared directly against unrelated 0-1-scale fields like price), never
  // multiplied by volume into an actual dollar figure. Now routed through the same
  // dollar-scaled worstCaseCashEffect path as DOLLAR_FIELDS/debt (see BotCogsContext's own
  // doc comment) — the real cost grows with volume, exactly the field the bot's OWN
  // capacity/demand-boosting picks keep growing.
  it('scores a materialCostPerTon-raising decision worse as the bot\'s own volume grows, via the dollar-scaled COGS path', () => {
    const def = makeDecisionDef({ impacts: { materialCostPerTon: { type: 'relative', schedule: { 1: 0.2, default: 0 } } } });
    const noCogsContext = scoreDecision(def, 0); // no BotCogsContext supplied -> zero dollar effect
    const smallVolume = scoreDecision(def, 0, DEFAULT_INTEREST_RATE, { volume: 100, materialCostPerTon: 500, logisticsCostPerTon: 0 });
    const largeVolume = scoreDecision(def, 0, DEFAULT_INTEREST_RATE, { volume: 1000, materialCostPerTon: 500, logisticsCostPerTon: 0 });
    expect(smallVolume).toBeLessThan(noCogsContext);
    expect(largeVolume).toBeLessThan(smallVolume);
  });

  it('does not double-count materialCostPerTon/logisticsCostPerTon between the dollar-scaled COGS path and the generic per-field loop', () => {
    // A decision that ONLY carries a materialCostPerTon impact, with no live COGS context
    // (volume 0), must score identically to a completely free decision — if the generic
    // per-field loop were still also scoring this field (the pre-fix behavior), it would
    // score strictly lower even at zero volume.
    const def = makeDecisionDef({ impacts: { materialCostPerTon: { type: 'relative', schedule: { 1: 0.2, default: 0 } } } });
    const free = makeDecisionDef({ impacts: {} });
    expect(scoreDecision(def, 0)).toBe(scoreDecision(free, 0));
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

  // Regression: GameLoop.applyShareTransaction charges the buyer's FULL requested amount
  // even once fractionBought has already capped at 1 (100% owned) — nothing refunds the
  // excess. A spare-cash-sized spend with no awareness of what the target is actually
  // worth could vastly overpay for a small/cheap company once the bot's own cash pile
  // outgrows it, a real observed cause of self-bankruptcy from one oversized Buy Shares
  // move. maxUsefulSpend clamps the spend to what's actually useful.
  it('clamps spend to maxUsefulSpend when it is lower than the spare-cash-based amount', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const cash = BOT_CASH_RESERVE + 100_000; // would otherwise spend 50,000
    expect(pickBotShareBuy(cash, 0, 2, BOT_CASH_RESERVE, 10_000)).toBe(10_000);
  });

  it('never buys at all once maxUsefulSpend is zero or negative — nothing left worth acquiring', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const cash = BOT_CASH_RESERVE + 100_000;
    expect(pickBotShareBuy(cash, 0, 2, BOT_CASH_RESERVE, 0)).toBeUndefined();
  });

  it('defaults maxUsefulSpend to Infinity (uncapped) when not passed — no behavior change for existing callers', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const cash = BOT_CASH_RESERVE + 100_000;
    expect(pickBotShareBuy(cash, 0, 2)).toBe(Math.round(100_000 * BOT_BUY_SHARES_SPEND_FRACTION));
  });
});

describe('pickAttacksToInvestigate', () => {
  it('excludes attacks that are already fully revealed (have suggestedGrounds)', () => {
    const revealed = makeAttack({ attackId: 'a', suggestedGrounds: [{ name: 'Some Ground', description: 'x', probability: 0.5, stakes: 1000 }] });
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
    const attack = makeAttack({ suggestedGrounds: [{ name: 'Ground', description: 'x', probability: 0.3, stakes: 1000 }] });
    expect(shouldFileLawsuit(attack, 500_000, filingCost)).toBe(false);
  });

  it('is true once the estimated win chance clears 30% and cash covers the fee plus reserve', () => {
    const attack = makeAttack({ suggestedGrounds: [{ name: 'Ground', description: 'x', probability: 0.31, stakes: 1000 }] });
    expect(shouldFileLawsuit(attack, 500_000, filingCost)).toBe(true);
  });

  it('is false when filing would breach the reserve, even with good odds', () => {
    const attack = makeAttack({ suggestedGrounds: [{ name: 'Ground', description: 'x', probability: 0.9, stakes: 1000 }] });
    const cash = BOT_CASH_RESERVE + filingCost - 1;
    expect(shouldFileLawsuit(attack, cash, filingCost)).toBe(false);
  });

  it('only ever weighs the single strongest ground (index 0), ignoring weaker alternatives even if listed', () => {
    // Already sorted probability-descending by pickAllGrounds — a weak second entry
    // should never accidentally drag the decision down (or up).
    const attack = makeAttack({
      suggestedGrounds: [
        { name: 'Strong', description: 'x', probability: 0.9, stakes: 1000 },
        { name: 'Weak', description: 'x', probability: 0.05, stakes: 1000 },
      ],
    });
    expect(shouldFileLawsuit(attack, 500_000, filingCost)).toBe(true);
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
