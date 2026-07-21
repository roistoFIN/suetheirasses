import { describe, it, expect } from 'vitest';

// ── Utility functions extracted from GamePhase for testing ──────────────

/** Format currency with Intl.NumberFormat */
function fmt(n: number): string {
  return '$' + new Intl.NumberFormat('en-US').format(Math.round(n));
}

/** Format percentage */
function pct(n: number): string {
  return (n * 100).toFixed(0) + '%';
}

/** Since-last-turn trend for KPI/intel display */
type Trend = 'up' | 'down' | 'same';

function computeTrend(current: number, previous: number | undefined, epsilon = 0.01): Trend | undefined {
  if (previous === undefined) return undefined;
  const diff = current - previous;
  if (Math.abs(diff) < epsilon) return 'same';
  return diff > 0 ? 'up' : 'down';
}

/** Determine semaphore color level based on probability */
function semaphoreLevel(p: number): 'green' | 'yellow' | 'red' {
  if (p < 0.15) return 'green';
  if (p < 0.4) return 'yellow';
  return 'red';
}

// ── Lawsuit grounds derivation (SueModal) — there is no fixed grounds catalog; every
// decision's legalRisks is a potential ground the moment a target actually deploys it ──

interface MinimalActiveDecisionForGrounds {
  decisionName: string;
}

interface MinimalLegalRisk {
  name: string;
  description: string;
}

interface MinimalDecisionDefForGrounds {
  decision: string;
  legalRisks?: MinimalLegalRisk[];
}

interface MinimalTarget {
  activeDecisions: MinimalActiveDecisionForGrounds[];
}

interface DerivedGround {
  decisionName: string;
  groundName: string;
  description: string;
}

function getGroundsAgainst(target: MinimalTarget, decisions: MinimalDecisionDefForGrounds[]): DerivedGround[] {
  const grounds: DerivedGround[] = [];
  for (const active of target.activeDecisions) {
    const def = decisions.find((d) => d.decision === active.decisionName);
    if (!def?.legalRisks) continue;
    for (const risk of def.legalRisks) {
      grounds.push({ decisionName: active.decisionName, groundName: risk.name, description: risk.description });
    }
  }
  return grounds;
}

// ── Decision Deck deployability (mirrors DecisionEngine.canDeploy, FORMULAS §9-§10) ──

interface MinimalDecisionDef {
  decision: string;
  excludes: string[];
}

interface MinimalActiveDecision {
  decisionName: string;
  isMatured: boolean;
  maturityYears: number;
  elapsedYears: number;
}

function getDeployability(
  def: MinimalDecisionDef,
  activeDecisions: MinimalActiveDecision[],
  allDecisions: MinimalDecisionDef[],
): { blocked: boolean; reason?: string } {
  const existing = activeDecisions.filter((d) => d.decisionName === def.decision);
  if (existing.length > 0 && !existing[existing.length - 1].isMatured) {
    const last = existing[existing.length - 1];
    return { blocked: true, reason: `Still maturing — ${Math.max(0, last.maturityYears - last.elapsedYears)} turn(s) left` };
  }

  for (const excluded of def.excludes) {
    const found = activeDecisions.find((d) => d.decisionName === excluded && !d.isMatured);
    if (found) return { blocked: true, reason: `Blocked while ${excluded} is maturing` };
  }

  for (const active of activeDecisions) {
    if (active.isMatured) continue;
    const activeDef = allDecisions.find((d) => d.decision === active.decisionName);
    if (activeDef?.excludes.includes(def.decision)) {
      return { blocked: true, reason: `Blocked by ${active.decisionName} until it matures` };
    }
  }

  return { blocked: false };
}

// ── Target-opponent requirement (FORMULAS §0 — any target.* impact field routes to a
// chosen opponent, not just decisions flagged requiresTarget in game_engine.json) ──

interface MinimalDecisionDefForTarget {
  requiresTarget?: boolean;
  impacts: Record<string, number>;
}

function decisionNeedsTarget(def: MinimalDecisionDefForTarget): boolean {
  return def.requiresTarget === true || Object.keys(def.impacts).some((field) => field.startsWith('target.'));
}

/** Calculate adjusted probability for a defendant case */
function calculateAdjustedProbability(
  baseProbability: number,
  scrutiny: number,
  legalExposureRatio: number,
  scrutinyMultiplier = 0.3,
): number {
  const scrutinyFactor = (scrutinyMultiplier * scrutiny) / 100;
  return baseProbability + scrutinyFactor + Math.min(legalExposureRatio, 0.8);
}

/** Calculate risk gauge score */
function calculateRiskGauge(
  legalExposureRatio: number,
  scrutiny: number,
  outrage: number,
  w1 = 0.5,
  w2 = 0.25,
  w3 = 0.25,
): number {
  const legalTerm = w1 * (Math.min(legalExposureRatio, 0.8) / 0.8) * 100;
  const scrutinyTerm = w2 * (scrutiny / 100) * 100;
  const outrageTerm = w3 * (outrage / 100) * 100;
  return legalTerm + scrutinyTerm + outrageTerm;
}

/** Calculate equity from balance sheet components */
function calculateEquity(
  cash: number,
  receivables: number,
  assets: number,
  intangibleAssets: number,
  reserves: number,
  debt: number,
): number {
  return cash + receivables + assets + intangibleAssets + reserves - debt;
}

/** Calculate market equity (discounted by legal exposure) */
function calculateMarketEquity(equity: number, legalExposure: number): number {
  return Math.max(0, equity - legalExposure);
}

/** Calculate stock value per share */
function calculateStockValue(marketEquity: number, totalSharesOutstanding: number): number {
  if (totalSharesOutstanding <= 0) return 0;
  return marketEquity / totalSharesOutstanding;
}

/** Calculate receivables using DSO */
function calculateReceivables(revenue: number, dso: number): number {
  return revenue * (dso / 365);
}

/** Calculate legal exposure ratio with cap */
function calculateLegalExposureRatio(legalExposure: number, cash: number, cap = 0.8): number {
  if (cash <= 0) return cap; // prevent division by zero
  return Math.min(cap, legalExposure / cash);
}

// ── "YOU'VE BEEN SUED" modal trigger — newly-filed cases against me this turn ──

interface MinimalLegalCaseForSued {
  id: string;
  defendantId: string;
}

function detectNewlySuedCases<T extends MinimalLegalCaseForSued>(
  previousCases: T[],
  currentCases: T[],
  myPlayerId: string,
): T[] {
  const previouslySuedCaseIds = new Set(
    previousCases.filter((c) => c.defendantId === myPlayerId).map((c) => c.id),
  );
  return currentCases.filter((c) => c.defendantId === myPlayerId && !previouslySuedCaseIds.has(c.id));
}

describe('GamePhase utilities', () => {
  describe('fmt', () => {
    it('should format positive numbers correctly', () => {
      expect(fmt(1000)).toBe('$1,000');
      expect(fmt(1234567)).toBe('$1,234,567');
      expect(fmt(999999999)).toBe('$999,999,999');
    });

    it('should handle zero and negative numbers', () => {
      expect(fmt(0)).toBe('$0');
      // Intl.NumberFormat places the sign after the currency symbol: $-500
      expect(fmt(-500)).toBe('$-500');
    });

    it('should round decimals', () => {
      expect(fmt(1234.567)).toBe('$1,235');
      expect(fmt(1234.4)).toBe('$1,234');
    });
  });

  describe('pct', () => {
    it('should format decimal as percentage string', () => {
      expect(pct(0)).toBe('0%');
      expect(pct(0.5)).toBe('50%');
      expect(pct(1)).toBe('100%');
      expect(pct(0.33)).toBe('33%');
    });
  });

  describe('computeTrend', () => {
    it('should return undefined when there is no previous value (round 1)', () => {
      expect(computeTrend(100, undefined)).toBeUndefined();
    });

    it('should return "up" when the value increased', () => {
      expect(computeTrend(150, 100)).toBe('up');
    });

    it('should return "down" when the value decreased', () => {
      expect(computeTrend(80, 100)).toBe('down');
    });

    it('should return "same" for an exact match', () => {
      expect(computeTrend(100, 100)).toBe('same');
    });

    it('should treat sub-epsilon differences as "same" (avoid noisy float-precision arrows)', () => {
      expect(computeTrend(100.001, 100)).toBe('same');
      expect(computeTrend(99.999, 100)).toBe('same');
    });

    it('should respect a custom epsilon', () => {
      expect(computeTrend(101, 100, 0.5)).toBe('up');
      expect(computeTrend(100.3, 100, 0.5)).toBe('same');
    });

    it('should handle negative values correctly (e.g. cash going further negative)', () => {
      expect(computeTrend(-200, -100)).toBe('down');
      expect(computeTrend(-50, -100)).toBe('up');
    });
  });

  describe('semaphoreLevel', () => {
    it('should return green for low probability (< 0.15)', () => {
      expect(semaphoreLevel(0)).toBe('green');
      expect(semaphoreLevel(0.1)).toBe('green');
      expect(semaphoreLevel(0.14)).toBe('green');
    });

    it('should return yellow for medium probability (>= 0.15 and < 0.4)', () => {
      expect(semaphoreLevel(0.15)).toBe('yellow');
      expect(semaphoreLevel(0.25)).toBe('yellow');
      expect(semaphoreLevel(0.39)).toBe('yellow');
    });

    it('should return red for high probability (>= 0.4)', () => {
      expect(semaphoreLevel(0.4)).toBe('red');
      expect(semaphoreLevel(0.7)).toBe('red');
      expect(semaphoreLevel(1.0)).toBe('red');
    });
  });

  describe('calculateAdjustedProbability', () => {
    it('should calculate base probability when scrutiny and legalExposure are zero', () => {
      const result = calculateAdjustedProbability(0.1, 0, 0);
      expect(result).toBeCloseTo(0.1, 5);
    });

    it('should add scrutiny factor correctly', () => {
      // scrutiny=10, multiplier=0.3 → factor = (0.3 * 10) / 100 = 0.03
      const result = calculateAdjustedProbability(0.1, 10, 0);
      expect(result).toBeCloseTo(0.13, 5);
    });

    it('should add legal exposure ratio correctly', () => {
      // ler=0.2, no scrutiny
      const result = calculateAdjustedProbability(0.1, 0, 0.2);
      expect(result).toBeCloseTo(0.3, 5);
    });

    it('should cap legal exposure at 0.8', () => {
      // ler=0.9 should be capped to 0.8
      const result = calculateAdjustedProbability(0.1, 0, 0.9);
      expect(result).toBeCloseTo(0.9, 5); // 0.1 + 0.8 = 0.9
    });

    it('should combine scrutiny and legal exposure', () => {
      // base=0.05, scrutiny=20 → factor=0.06, ler=0.4
      const result = calculateAdjustedProbability(0.05, 20, 0.4);
      expect(result).toBeCloseTo(0.51, 5); // 0.05 + 0.06 + 0.4 = 0.51
    });
  });

  describe('calculateRiskGauge', () => {
    it('should return 0 when all inputs are zero', () => {
      expect(calculateRiskGauge(0, 0, 0)).toBe(0);
    });

    it('should weight legal exposure most heavily (w1=0.5)', () => {
      // ler=0.8 (max), scrutiny=0, outrage=0
      const result = calculateRiskGauge(0.8, 0, 0);
      expect(result).toBe(50); // 0.5 * (0.8/0.8) * 100 = 50
    });

    it('should combine all three factors correctly', () => {
      // ler=0.8, scrutiny=50, outrage=50
      const legalTerm = 0.5 * (0.8 / 0.8) * 100; // 50
      const scrutinyTerm = 0.25 * (50 / 100) * 100; // 12.5
      const outrageTerm = 0.25 * (50 / 100) * 100; // 12.5
      const expected = legalTerm + scrutinyTerm + outrageTerm; // 75

      const result = calculateRiskGauge(0.8, 50, 50);
      expect(result).toBeCloseTo(expected, 5);
    });

    it('should handle max values', () => {
      // ler=0.8, scrutiny=100, outrage=100
      const result = calculateRiskGauge(0.8, 100, 100);
      expect(result).toBe(100); // 50 + 25 + 25 = 100
    });

    it('should use custom weights when provided', () => {
      const result = calculateRiskGauge(0, 100, 100, 0, 0.5, 0.5);
      expect(result).toBe(100); // 0 + 50 + 50 = 100
    });
  });

  describe('calculateEquity', () => {
    it('should compute equity from balance sheet components', () => {
      const result = calculateEquity(100000, 30000, 1000000, 100000, 11360, 0);
      expect(result).toBe(1241360);
    });

    it('should subtract debt correctly', () => {
      const result = calculateEquity(100000, 0, 500000, 50000, 0, 200000);
      expect(result).toBe(450000);
    });

    it('should handle negative equity (insolvent)', () => {
      const result = calculateEquity(10000, 0, 50000, 0, 0, 100000);
      expect(result).toBe(-40000);
    });
  });

  describe('calculateMarketEquity', () => {
    it('should discount equity by legal exposure', () => {
      const result = calculateMarketEquity(1000000, 200000);
      expect(result).toBe(800000);
    });

    it('should return 0 when legal exposure exceeds equity', () => {
      const result = calculateMarketEquity(100000, 200000);
      expect(result).toBe(0);
    });

    it('should return full equity when no legal exposure', () => {
      const result = calculateMarketEquity(500000, 0);
      expect(result).toBe(500000);
    });
  });

  describe('calculateStockValue', () => {
    it('should divide market equity by shares outstanding', () => {
      const result = calculateStockValue(1200000, 10000);
      expect(result).toBe(120);
    });

    it('should handle zero shares gracefully', () => {
      const result = calculateStockValue(100000, 0);
      expect(result).toBe(0);
    });

    it('should return 0 for negative market equity (already handled by caller)', () => {
      const result = calculateStockValue(0, 10000);
      expect(result).toBe(0);
    });
  });

  describe('calculateReceivables', () => {
    it('should calculate receivables using DSO formula', () => {
      // revenue=365000, dso=45 → 365000 * (45/365) = 45000
      const result = calculateReceivables(365000, 45);
      expect(result).toBeCloseTo(45000, 5);
    });

    it('should handle zero revenue', () => {
      expect(calculateReceivables(0, 45)).toBe(0);
    });

    it('should handle DSO of 0', () => {
      expect(calculateReceivables(100000, 0)).toBe(0);
    });
  });

  describe('calculateLegalExposureRatio', () => {
    it('should compute ratio correctly without cap', () => {
      const result = calculateLegalExposureRatio(50000, 200000);
      expect(result).toBe(0.25);
    });

    it('should apply default cap of 0.8', () => {
      const result = calculateLegalExposureRatio(200000, 100000);
      expect(result).toBe(0.8); // capped at 0.8 even though actual is 2.0
    });

    it('should prevent division by zero when cash is 0', () => {
      const result = calculateLegalExposureRatio(10000, 0);
      expect(result).toBe(0.8); // returns cap to avoid NaN
    });

    it('should use custom cap when provided', () => {
      const result = calculateLegalExposureRatio(50000, 100000, 0.5);
      expect(result).toBe(0.5); // capped at 0.5 instead of default 0.8
    });
  });

  describe('getDeployability', () => {
    const newFactory: MinimalDecisionDef = { decision: 'New Factory', excludes: [] };
    const exclusiveDeal: MinimalDecisionDef = { decision: 'Exclusive Deal', excludes: ['Competitor Lock-in'] };
    const competitorLockIn: MinimalDecisionDef = { decision: 'Competitor Lock-in', excludes: ['Exclusive Deal'] };
    const allDecisions = [newFactory, exclusiveDeal, competitorLockIn];

    it('should allow deploying a decision with no active instance', () => {
      const result = getDeployability(newFactory, [], allDecisions);
      expect(result.blocked).toBe(false);
    });

    it('should block redeploying the same decision while it is still maturing', () => {
      const active: MinimalActiveDecision[] = [
        { decisionName: 'New Factory', isMatured: false, maturityYears: 2, elapsedYears: 1 },
      ];
      const result = getDeployability(newFactory, active, allDecisions);
      expect(result.blocked).toBe(true);
      expect(result.reason).toContain('maturing');
    });

    it('should allow redeploying the same decision once it has matured', () => {
      const active: MinimalActiveDecision[] = [
        { decisionName: 'New Factory', isMatured: true, maturityYears: 2, elapsedYears: 2 },
      ];
      const result = getDeployability(newFactory, active, allDecisions);
      expect(result.blocked).toBe(false);
    });

    it('should block a decision that excludes an active, unmatured decision (forward exclusion)', () => {
      const active: MinimalActiveDecision[] = [
        { decisionName: 'Competitor Lock-in', isMatured: false, maturityYears: 1, elapsedYears: 0 },
      ];
      const result = getDeployability(exclusiveDeal, active, allDecisions);
      expect(result.blocked).toBe(true);
      expect(result.reason).toContain('Competitor Lock-in');
    });

    it('should block a decision when an active, unmatured decision excludes it (reverse exclusion)', () => {
      const active: MinimalActiveDecision[] = [
        { decisionName: 'Exclusive Deal', isMatured: false, maturityYears: 1, elapsedYears: 0 },
      ];
      const result = getDeployability(competitorLockIn, active, allDecisions);
      expect(result.blocked).toBe(true);
      expect(result.reason).toContain('Exclusive Deal');
    });

    it('should not block a mutually-exclusive decision once the blocking one has matured (FORMULAS §10)', () => {
      const active: MinimalActiveDecision[] = [
        { decisionName: 'Competitor Lock-in', isMatured: true, maturityYears: 1, elapsedYears: 1 },
      ];
      const result = getDeployability(exclusiveDeal, active, allDecisions);
      expect(result.blocked).toBe(false);
    });
  });

  describe('decisionNeedsTarget', () => {
    it('should require a target when requiresTarget is explicitly true (e.g. Buy Shares)', () => {
      const buyShares: MinimalDecisionDefForTarget = {
        requiresTarget: true,
        impacts: { 'target.operatingExpenses': 0.05 },
      };
      expect(decisionNeedsTarget(buyShares)).toBe(true);
    });

    it('should require a target when a target.* impact field is present, even without the flag (e.g. Fox Release)', () => {
      const foxRelease: MinimalDecisionDefForTarget = {
        impacts: { 'target.assets': -50000 },
      };
      expect(decisionNeedsTarget(foxRelease)).toBe(true);
    });

    it('should require a target for Bot Attack-shaped impacts (target.capacityUtilization)', () => {
      const botAttack: MinimalDecisionDefForTarget = {
        impacts: { 'target.capacityUtilization': -0.1 },
      };
      expect(decisionNeedsTarget(botAttack)).toBe(true);
    });

    it('should not require a target for a decision with neither the flag nor a target.* field', () => {
      const newFactoryDecision: MinimalDecisionDefForTarget = {
        impacts: { installedCapacity: 0.4 },
      };
      expect(decisionNeedsTarget(newFactoryDecision)).toBe(false);
    });

    it('should not require a target for a self-only decision that merely mentions "target" mid-word', () => {
      const selfDecision: MinimalDecisionDefForTarget = {
        impacts: { operatingExpenses: -0.02 },
      };
      expect(decisionNeedsTarget(selfDecision)).toBe(false);
    });
  });

  describe('getGroundsAgainst', () => {
    const decisions: MinimalDecisionDefForGrounds[] = [
      {
        decision: 'Water Pumping',
        legalRisks: [{ name: 'Environmental Violation', description: 'Sue for environmental damage' }],
      },
      {
        decision: 'Buy Shares',
        legalRisks: [{ name: 'Securities Violation', description: 'Sue for failing to disclose ownership' }],
      },
      { decision: 'Safe Decision' }, // no legalRisks at all
    ];

    it('should return no grounds for a target with no active decisions', () => {
      const grounds = getGroundsAgainst({ activeDecisions: [] }, decisions);
      expect(grounds).toEqual([]);
    });

    it('should derive grounds only from decisions the target actually deployed', () => {
      const target: MinimalTarget = { activeDecisions: [{ decisionName: 'Water Pumping' }] };
      const grounds = getGroundsAgainst(target, decisions);

      expect(grounds).toHaveLength(1);
      expect(grounds[0]).toEqual({
        decisionName: 'Water Pumping',
        groundName: 'Environmental Violation',
        description: 'Sue for environmental damage',
      });
    });

    it('should not offer a ground for a decision the target never deployed', () => {
      const target: MinimalTarget = { activeDecisions: [{ decisionName: 'Water Pumping' }] };
      const grounds = getGroundsAgainst(target, decisions);

      expect(grounds.some((g) => g.decisionName === 'Buy Shares')).toBe(false);
    });

    it('should return no grounds for a decision with no legalRisks', () => {
      const target: MinimalTarget = { activeDecisions: [{ decisionName: 'Safe Decision' }] };
      const grounds = getGroundsAgainst(target, decisions);
      expect(grounds).toEqual([]);
    });

    it('should aggregate grounds across all of the target\'s active decisions', () => {
      const target: MinimalTarget = {
        activeDecisions: [{ decisionName: 'Water Pumping' }, { decisionName: 'Buy Shares' }],
      };
      const grounds = getGroundsAgainst(target, decisions);

      expect(grounds).toHaveLength(2);
      expect(grounds.map((g) => g.groundName)).toEqual(
        expect.arrayContaining(['Environmental Violation', 'Securities Violation']),
      );
    });
  });

  describe('detectNewlySuedCases', () => {
    const me = 'player-1';
    const rival = 'player-2';

    it('should return nothing when there are no cases at all', () => {
      expect(detectNewlySuedCases([], [], me)).toEqual([]);
    });

    it('should detect a case that appears against me for the first time', () => {
      const newCase = { id: 'case-1', defendantId: me };
      expect(detectNewlySuedCases([], [newCase], me)).toEqual([newCase]);
    });

    it('should not re-report a case that was already present last turn', () => {
      const existingCase = { id: 'case-1', defendantId: me };
      expect(detectNewlySuedCases([existingCase], [existingCase], me)).toEqual([]);
    });

    it('should ignore cases where I am the plaintiff, not the defendant', () => {
      const iAmSuingThem = { id: 'case-1', defendantId: rival };
      expect(detectNewlySuedCases([], [iAmSuingThem], me)).toEqual([]);
    });

    it('should only report the genuinely new case when mixed with an existing one', () => {
      const existingCase = { id: 'case-1', defendantId: me };
      const newCase = { id: 'case-2', defendantId: me };
      expect(detectNewlySuedCases([existingCase], [existingCase, newCase], me)).toEqual([newCase]);
    });

    it('should detect multiple new cases filed in the same turn', () => {
      const newCase1 = { id: 'case-1', defendantId: me };
      const newCase2 = { id: 'case-2', defendantId: me };
      const result = detectNewlySuedCases([], [newCase1, newCase2], me);
      expect(result).toEqual(expect.arrayContaining([newCase1, newCase2]));
      expect(result).toHaveLength(2);
    });

    it('should not report a case that has since resolved and disappeared as "new"', () => {
      const resolvedCase = { id: 'case-1', defendantId: me };
      // Case existed last turn, isn't present this turn — should never appear as "new".
      expect(detectNewlySuedCases([resolvedCase], [], me)).toEqual([]);
    });
  });
});
