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

// ── Lawsuit grounds derivation (SueModal) — the whole decision library's legal-risk
// catalog, not scoped to what a specific target has actually deployed, so a player can
// knowingly guess a ground the target may or may not have actually pursued ──

interface MinimalLegalRisk {
  name: string;
  description: string;
}

interface MinimalDecisionDefForGrounds {
  decision: string;
  legalRisks?: MinimalLegalRisk[];
}

interface DerivedGround {
  decisionName: string;
  groundName: string;
  description: string;
}

function getGroundsAgainst(decisions: MinimalDecisionDefForGrounds[]): DerivedGround[] {
  const grounds: DerivedGround[] = [];
  for (const def of decisions) {
    if (!def.legalRisks) continue;
    for (const risk of def.legalRisks) {
      grounds.push({ decisionName: def.decision, groundName: risk.name, description: risk.description });
    }
  }
  return grounds;
}

// ── Decision Deck deployability (mirrors DecisionEngine.canDeploy) ──────────────────

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

// ── Target-opponent requirement (any target.* impact field routes to a
// chosen opponent, not just decisions flagged requiresTarget in game_engine.json) ──

interface MinimalDecisionDefForTarget {
  requiresTarget?: boolean;
  impacts: Record<string, number>;
}

function decisionNeedsTarget(def: MinimalDecisionDefForTarget): boolean {
  return def.requiresTarget === true || Object.keys(def.impacts).some((field) => field.startsWith('target.'));
}

// ── Decision Deck "SORT BY KPI" (own-effect fields only, deployment-year value) ──

function formatFieldLabel(field: string): string {
  const isTarget = field.startsWith('target.');
  const clean = isTarget ? field.slice('target.'.length) : field;
  const spaced = clean.replace(/([A-Z])/g, ' $1').trim();
  const label = spaced.charAt(0).toUpperCase() + spaced.slice(1);
  return isTarget ? `Target's ${label.charAt(0).toLowerCase()}${label.slice(1)}` : label;
}

interface MinimalImpactEntry {
  schedule: Record<number | string, number>;
}

interface MinimalDecisionDefForSort {
  impacts: Record<string, MinimalImpactEntry>;
}

function getSortableKpiFields(decisions: MinimalDecisionDefForSort[]): string[] {
  const fields = new Set<string>();
  for (const def of decisions) {
    for (const field of Object.keys(def.impacts)) {
      if (field.startsWith('target.') || field.startsWith('competitor')) continue;
      fields.add(field);
    }
  }
  return Array.from(fields).sort((a, b) => formatFieldLabel(a).localeCompare(formatFieldLabel(b)));
}

function getDecisionSortValue(def: MinimalDecisionDefForSort, field: string): number {
  const impact = def.impacts[field];
  if (!impact) return 0;
  return impact.schedule[1] ?? impact.schedule['default'] ?? 0;
}

// ── "Active Decisions" box filter/sort ───────────────────────────────────

interface MinimalDecisionDefForPermanence {
  impacts: Record<string, MinimalImpactEntry>;
}

function hasPermanentEffect(def: MinimalDecisionDefForPermanence): boolean {
  for (const [field, impact] of Object.entries(def.impacts)) {
    if (field.startsWith('target.') || field.startsWith('competitor')) continue;
    if ((impact.schedule['default'] ?? 0) !== 0) return true;
  }
  return false;
}

type ActiveDecisionStatus = 'voided' | 'expired' | 'matured' | 'maturing';

function getActiveDecisionStatus(
  decision: { isMatured: boolean; voidedByLawsuit: boolean; elapsedYears: number },
  def: MinimalDecisionDefForPermanence | undefined,
  statuteOfLimitationsYears?: number,
): ActiveDecisionStatus {
  if (decision.voidedByLawsuit) return 'voided';
  if (def && hasPermanentEffect(def) && statuteOfLimitationsYears !== undefined && decision.elapsedYears >= statuteOfLimitationsYears) return 'expired';
  return decision.isMatured ? 'matured' : 'maturing';
}

type DecisionBoxItem =
  | { kind: 'queued'; name: string; targetName?: string }
  | { kind: 'active'; name: string; targetName?: string; status: ActiveDecisionStatus; deployedYear: number };

type DecisionBoxFilterStatus = 'All' | 'Queued' | 'Maturing' | 'Matured' | 'Voided — Sued' | 'Expired';

const ACTIVE_DECISION_STATUS_LABELS: Record<ActiveDecisionStatus, DecisionBoxFilterStatus> = {
  voided: 'Voided — Sued',
  expired: 'Expired',
  matured: 'Matured',
  maturing: 'Maturing',
};

function decisionBoxItemStatus(item: DecisionBoxItem): DecisionBoxFilterStatus {
  return item.kind === 'queued' ? 'Queued' : ACTIVE_DECISION_STATUS_LABELS[item.status];
}

function getDecisionBoxTurn(item: DecisionBoxItem, round: number): number {
  return item.kind === 'queued' ? round : item.deployedYear + 1;
}

function sortDecisionBoxItems(items: DecisionBoxItem[], field: 'turn' | 'target' | 'name', direction: 'asc' | 'desc', round: number): DecisionBoxItem[] {
  const sorted = [...items];
  sorted.sort((a, b) => {
    const diff = field === 'turn'
      ? getDecisionBoxTurn(a, round) - getDecisionBoxTurn(b, round)
      : field === 'target'
        ? (a.targetName ?? '').localeCompare(b.targetName ?? '')
        : a.name.localeCompare(b.name);
    return direction === 'desc' ? -diff : diff;
  });
  return sorted;
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

// ── "CASE WON"/"CASE LOST" modal trigger — my own cases whose trial verdict just landed ──

interface MinimalLegalCaseForVerdict {
  id: string;
  status: 'negotiating' | 'awaiting_trial' | 'resolved';
  verdict?: 'won' | 'lost' | 'settled' | 'cancelled';
  plaintiffId: string;
  defendantId: string;
}

interface ResolvedCaseForMe<T> {
  case: T;
  outcome: 'won' | 'lost';
}

function detectNewlyResolvedCases<T extends MinimalLegalCaseForVerdict>(
  previousCases: T[],
  currentCases: T[],
  myPlayerId: string,
): ResolvedCaseForMe<T>[] {
  const previouslyResolvedIds = new Set(
    previousCases.filter((c) => c.status === 'resolved').map((c) => c.id),
  );
  const results: ResolvedCaseForMe<T>[] = [];
  for (const c of currentCases) {
    if (c.status !== 'resolved' || previouslyResolvedIds.has(c.id)) continue;
    if (c.verdict !== 'won' && c.verdict !== 'lost') continue;
    const amPlaintiff = c.plaintiffId === myPlayerId;
    const amDefendant = c.defendantId === myPlayerId;
    if (!amPlaintiff && !amDefendant) continue;
    const outcome: 'won' | 'lost' = amPlaintiff === (c.verdict === 'won') ? 'won' : 'lost';
    results.push({ case: c, outcome });
  }
  return results;
}

// ── "Case settled" News item trigger — my own cases resolved by negotiation, not a trial ──

interface SettledCaseForMe<T> {
  case: T;
  role: 'plaintiff' | 'defendant';
}

function detectNewlySettledCases<T extends MinimalLegalCaseForVerdict>(
  previousCases: T[],
  currentCases: T[],
  myPlayerId: string,
): SettledCaseForMe<T>[] {
  const previouslyResolvedIds = new Set(
    previousCases.filter((c) => c.status === 'resolved').map((c) => c.id),
  );
  const results: SettledCaseForMe<T>[] = [];
  for (const c of currentCases) {
    if (c.status !== 'resolved' || previouslyResolvedIds.has(c.id)) continue;
    if (c.verdict !== 'settled') continue;
    const amPlaintiff = c.plaintiffId === myPlayerId;
    const amDefendant = c.defendantId === myPlayerId;
    if (!amPlaintiff && !amDefendant) continue;
    results.push({ case: c, role: amPlaintiff ? 'plaintiff' : 'defendant' });
  }
  return results;
}

// ── Incoming attack hint disappears once a real case exists against this exact attacking
// decision instance — matched by instance id (defendantDecisionInstanceId), not by
// requiring the ground sued over to be the suggested one ──

interface MinimalIncomingAttack {
  attackId?: string;
  attackerId?: string;
  decisionName?: string;
}

interface MinimalPendingLawsuit {
  targetId: string;
  decisionName: string;
  groundName: string;
}

interface MinimalLegalCaseForAttack {
  defendantId: string;
  decisionName: string;
  defendantDecisionInstanceId?: string;
}

function isAttackAlreadySuedOver(
  attack: MinimalIncomingAttack,
  pendingLawsuits: MinimalPendingLawsuit[],
  myLegalCases: MinimalLegalCaseForAttack[],
): boolean {
  if (!attack.attackerId || !attack.decisionName) return false;
  return (
    pendingLawsuits.some((l) => l.targetId === attack.attackerId && l.decisionName === attack.decisionName) ||
    myLegalCases.some((c) => c.defendantId === attack.attackerId && c.decisionName === attack.decisionName && c.defendantDecisionInstanceId === attack.attackId)
  );
}

// ── Cap table (OWNERSHIP panel behind STOCK VALUE) — every current shareholder of a
// company, largest stake first, with a resolved display name ──

const SELF_OWNERSHIP_KEY = 'self';
const EXTERNAL_MARKET_KEY = 'EXTERNAL_MARKET';

interface MinimalPlayerForCapTable {
  playerId: string;
  playerName: string;
  variables: { totalSharesOutstanding?: number; shareOwnership?: Record<string, number> };
  derived: { stockValue?: number };
}

interface CapTableRow {
  key: string;
  name: string;
  fraction: number;
  shares: number;
  value: number;
  color: string;
}

const OTHER_HOLDER_COLORS = ['#2563eb', '#7c3aed', '#0d9488', '#c2410c'];

function buildCapTable(target: MinimalPlayerForCapTable, viewerId: string, allPlayers: MinimalPlayerForCapTable[]): CapTableRow[] {
  const totalShares = target.variables.totalSharesOutstanding ?? 0;
  const stockValue = target.derived.stockValue ?? 0;
  const ownership = target.variables.shareOwnership ?? {};
  let otherColorIdx = 0;

  return Object.entries(ownership)
    .filter(([, fraction]) => fraction > 0.0005)
    .sort(([, a], [, b]) => b - a)
    .map(([key, fraction]) => {
      let name: string;
      let color: string;
      if (key === SELF_OWNERSHIP_KEY) {
        const isViewer = target.playerId === viewerId;
        name = isViewer ? 'You' : target.playerName;
        color = isViewer ? '#dc2626' : '#9ca3af';
      } else if (key === EXTERNAL_MARKET_KEY) {
        name = 'Public Market';
        color = '#d1d5db';
      } else if (key === viewerId) {
        name = 'You';
        color = '#dc2626';
      } else {
        name = allPlayers.find((p) => p.playerId === key)?.playerName ?? 'Former Shareholder';
        color = OTHER_HOLDER_COLORS[otherColorIdx++ % OTHER_HOLDER_COLORS.length];
      }
      return { key, name, fraction, shares: fraction * totalShares, value: fraction * totalShares * stockValue, color };
    });
}

// ── Threat Level / Risk Gauge breakdown (ThreatView) — mirrors calcEngine.ts's
// calculateRiskGauge/calculateOwnershipRisk. The w4/ownershipRisk term is a deliberate
// addition beyond the Risk Gauge's original 3-term design — majority-ownership takeover
// is a fully independent way to lose the game the original gauge never reflected. A 5th
// term (legal-solvency risk, w5) existed briefly and was removed by explicit product
// decision — it read as near-duplicate information next to the legal-exposure-ratio term
// (both driven by the same open-case exposure), and its weight was folded back into
// w1-w4 proportionally, restoring the pre-solvency-term weights ──

const THREAT_W1 = 0.4, THREAT_W2 = 0.2, THREAT_W3 = 0.2, THREAT_W4 = 0.2;
const THREAT_LEGAL_EXPOSURE_RATIO_CAP = 0.8;
const THREAT_TAKEOVER_THRESHOLD_PERCENT = 0.5;

interface MinimalVarsForThreat {
  legalExposureRatio?: number;
  scrutiny: number;
  outrage: number;
  shareOwnership?: Record<string, number>;
  cash: number;
}

interface MinimalPlayerForThreat {
  variables: MinimalVarsForThreat;
}

function computeOwnershipRisk(shareOwnership: Record<string, number> | undefined): number {
  if (!shareOwnership) return 0;
  let maxExternalStake = 0;
  for (const [key, fraction] of Object.entries(shareOwnership)) {
    if (key === SELF_OWNERSHIP_KEY || key === EXTERNAL_MARKET_KEY) continue;
    if (fraction > maxExternalStake) maxExternalStake = fraction;
  }
  return Math.min(1, maxExternalStake / THREAT_TAKEOVER_THRESHOLD_PERCENT);
}

function computeThreatTerms(data: MinimalPlayerForThreat) {
  const v = data.variables;
  const ler = v.legalExposureRatio ?? 0;
  const legalTerm = THREAT_W1 * (ler / THREAT_LEGAL_EXPOSURE_RATIO_CAP) * 100;
  const scrutinyTerm = THREAT_W2 * Math.max(0, Math.min(1, v.scrutiny / 100)) * 100;
  const outrageTerm = THREAT_W3 * Math.min(1, Math.abs(v.outrage) / 100) * 100;
  const ownershipRisk = computeOwnershipRisk(v.shareOwnership);
  const ownershipTerm = THREAT_W4 * ownershipRisk * 100;
  return { ler, legalTerm, scrutinyTerm, outrageTerm, ownershipRisk, ownershipTerm };
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

    it('should not block a mutually-exclusive decision once the blocking one has matured', () => {
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

    it('should return no grounds when nothing in the library has legalRisks', () => {
      const grounds = getGroundsAgainst([{ decision: 'Safe Decision' }]);
      expect(grounds).toEqual([]);
    });

    it('should include a ground even if no player has ever deployed the decision it comes from — guessing is allowed', () => {
      const grounds = getGroundsAgainst(decisions);

      expect(grounds).toContainEqual({
        decisionName: 'Water Pumping',
        groundName: 'Environmental Violation',
        description: 'Sue for environmental damage',
      });
      expect(grounds).toContainEqual({
        decisionName: 'Buy Shares',
        groundName: 'Securities Violation',
        description: 'Sue for failing to disclose ownership',
      });
    });

    it('should skip a decision with no legalRisks at all', () => {
      const grounds = getGroundsAgainst(decisions);
      expect(grounds.some((g) => g.decisionName === 'Safe Decision')).toBe(false);
    });

    it('should aggregate grounds across the entire decision library, not just one decision', () => {
      const grounds = getGroundsAgainst(decisions);

      expect(grounds).toHaveLength(2);
      expect(grounds.map((g) => g.groundName)).toEqual(
        expect.arrayContaining(['Environmental Violation', 'Securities Violation']),
      );
    });
  });

  describe('getSortableKpiFields', () => {
    it('should return an empty list when nothing in the library has any impacts', () => {
      expect(getSortableKpiFields([{ impacts: {} }])).toEqual([]);
    });

    it('should collect own-effect fields across the whole library, deduplicated', () => {
      const decisions: MinimalDecisionDefForSort[] = [
        { impacts: { cash: { schedule: { 1: -1000 } } } },
        { impacts: { outrage: { schedule: { default: 5 } } } },
        { impacts: { cash: { schedule: { default: 200 } } } }, // same field as another decision
      ];
      expect(getSortableKpiFields(decisions)).toEqual(['cash', 'outrage']);
    });

    it('should exclude target.* and competitor-prefixed fields', () => {
      const decisions: MinimalDecisionDefForSort[] = [
        { impacts: { 'target.outrage': { schedule: { default: 10 } }, competitorAwareness: { schedule: { default: 1 } }, cash: { schedule: { 1: -500 } } } },
      ];
      expect(getSortableKpiFields(decisions)).toEqual(['cash']);
    });

    it('should return raw field names sorted by their human-readable label, not the raw name itself', () => {
      // "installedCapacity" formats to "Installed Capacity", which alphabetically comes
      // after "Cash" — this would sort the other way if sorted by raw field name instead.
      const decisions: MinimalDecisionDefForSort[] = [
        { impacts: { installedCapacity: { schedule: { default: 100 } }, cash: { schedule: { 1: -1 } } } },
      ];
      expect(getSortableKpiFields(decisions)).toEqual(['cash', 'installedCapacity']);
    });
  });

  describe('getDecisionSortValue', () => {
    it('should use the explicit year-1 schedule value when present', () => {
      const def: MinimalDecisionDefForSort = { impacts: { cash: { schedule: { 1: -30000, default: -5000 } } } };
      expect(getDecisionSortValue(def, 'cash')).toBe(-30000);
    });

    it('should fall back to the ongoing default when there is no explicit year-1 entry', () => {
      const def: MinimalDecisionDefForSort = { impacts: { outrage: { schedule: { default: 20 } } } };
      expect(getDecisionSortValue(def, 'outrage')).toBe(20);
    });

    it('should return 0 for a field the decision does not touch at all', () => {
      const def: MinimalDecisionDefForSort = { impacts: { cash: { schedule: { default: -100 } } } };
      expect(getDecisionSortValue(def, 'outrage')).toBe(0);
    });

    it('should return 0 when neither an explicit year-1 nor a default value exists', () => {
      const def: MinimalDecisionDefForSort = { impacts: { cash: { schedule: { 2: -100 } } } };
      expect(getDecisionSortValue(def, 'cash')).toBe(0);
    });
  });

  describe('getActiveDecisionStatus', () => {
    const maturing = { isMatured: false, voidedByLawsuit: false, elapsedYears: 1 };
    const matured = { isMatured: true, voidedByLawsuit: false, elapsedYears: 3 };

    it('returns "maturing" for a not-yet-matured, not-voided instance', () => {
      expect(getActiveDecisionStatus(maturing, undefined)).toBe('maturing');
    });

    it('returns "matured" once isMatured is true', () => {
      expect(getActiveDecisionStatus(matured, undefined)).toBe('matured');
    });

    it('returns "voided" regardless of maturity or statute of limitations', () => {
      const voided = { isMatured: true, voidedByLawsuit: true, elapsedYears: 100 };
      const def: MinimalDecisionDefForPermanence = { impacts: { cash: { schedule: { default: -1 } } } };
      expect(getActiveDecisionStatus(voided, def, 5)).toBe('voided');
    });

    it('returns "expired" once a permanent-effect instance ages past the statute of limitations', () => {
      const aged = { isMatured: true, voidedByLawsuit: false, elapsedYears: 10 };
      const permanentDef: MinimalDecisionDefForPermanence = { impacts: { operatingExpenses: { schedule: { default: 5000 } } } };
      expect(getActiveDecisionStatus(aged, permanentDef, 10)).toBe('expired');
    });

    it('does not return "expired" for a non-permanent decision no matter how old it is', () => {
      const aged = { isMatured: true, voidedByLawsuit: false, elapsedYears: 10 };
      const finiteDef: MinimalDecisionDefForPermanence = { impacts: { cash: { schedule: { 1: -1000 } } } };
      expect(getActiveDecisionStatus(aged, finiteDef, 5)).toBe('matured');
    });

    it('does not return "expired" when elapsedYears has not yet reached the statute', () => {
      const notYetAged = { isMatured: true, voidedByLawsuit: false, elapsedYears: 4 };
      const permanentDef: MinimalDecisionDefForPermanence = { impacts: { operatingExpenses: { schedule: { default: 5000 } } } };
      expect(getActiveDecisionStatus(notYetAged, permanentDef, 5)).toBe('matured');
    });
  });

  describe('decisionBoxItemStatus', () => {
    it('maps a queued item to "Queued" regardless of any active-decision fields', () => {
      const item: DecisionBoxItem = { kind: 'queued', name: 'Bot Attack' };
      expect(decisionBoxItemStatus(item)).toBe('Queued');
    });

    it('maps each active status to its filter label', () => {
      const base = { kind: 'active' as const, name: 'Bot Attack', deployedYear: 0 };
      expect(decisionBoxItemStatus({ ...base, status: 'voided' })).toBe('Voided — Sued');
      expect(decisionBoxItemStatus({ ...base, status: 'expired' })).toBe('Expired');
      expect(decisionBoxItemStatus({ ...base, status: 'matured' })).toBe('Matured');
      expect(decisionBoxItemStatus({ ...base, status: 'maturing' })).toBe('Maturing');
    });
  });

  describe('getDecisionBoxTurn', () => {
    it('uses the current round for a still-queued item, since it has no deployedYear yet', () => {
      const item: DecisionBoxItem = { kind: 'queued', name: 'Bot Attack' };
      expect(getDecisionBoxTurn(item, 7)).toBe(7);
    });

    it('uses deployedYear + 1 for an already-active item, ignoring the current round', () => {
      const item: DecisionBoxItem = { kind: 'active', name: 'Bot Attack', status: 'maturing', deployedYear: 2 };
      expect(getDecisionBoxTurn(item, 99)).toBe(3);
    });
  });

  describe('sortDecisionBoxItems', () => {
    it('sorts by turn deployed, newest first by default (desc)', () => {
      const items: DecisionBoxItem[] = [
        { kind: 'active', name: 'Old One', status: 'matured', deployedYear: 0 },
        { kind: 'active', name: 'New One', status: 'maturing', deployedYear: 3 },
        { kind: 'queued', name: 'Just Queued' }, // treated as the current round — strictly after New One's turn 4
      ];
      const sorted = sortDecisionBoxItems(items, 'turn', 'desc', 5);
      expect(sorted.map((i) => i.name)).toEqual(['Just Queued', 'New One', 'Old One']);
    });

    it('sorts by turn deployed ascending when asked', () => {
      const items: DecisionBoxItem[] = [
        { kind: 'active', name: 'New One', status: 'maturing', deployedYear: 4 },
        { kind: 'active', name: 'Old One', status: 'matured', deployedYear: 0 },
      ];
      const sorted = sortDecisionBoxItems(items, 'turn', 'asc', 5);
      expect(sorted.map((i) => i.name)).toEqual(['Old One', 'New One']);
    });

    it('sorts by attacked player name alphabetically, with no target sorting first', () => {
      const items: DecisionBoxItem[] = [
        { kind: 'active', name: 'Blind Decision', status: 'matured', deployedYear: 0 }, // no targetName
        { kind: 'active', name: 'Attack On Carol', targetName: 'Carol', status: 'matured', deployedYear: 0 },
        { kind: 'active', name: 'Attack On Alice', targetName: 'Alice', status: 'matured', deployedYear: 0 },
      ];
      const sorted = sortDecisionBoxItems(items, 'target', 'asc', 1);
      expect(sorted.map((i) => i.name)).toEqual(['Blind Decision', 'Attack On Alice', 'Attack On Carol']);
    });

    it('sorts by decision name, A→Z ascending and Z→A descending', () => {
      const items: DecisionBoxItem[] = [
        { kind: 'queued', name: 'Zebra Move' },
        { kind: 'queued', name: 'Aardvark Move' },
      ];
      expect(sortDecisionBoxItems(items, 'name', 'asc', 1).map((i) => i.name)).toEqual(['Aardvark Move', 'Zebra Move']);
      expect(sortDecisionBoxItems(items, 'name', 'desc', 1).map((i) => i.name)).toEqual(['Zebra Move', 'Aardvark Move']);
    });

    it('does not mutate the input array', () => {
      const items: DecisionBoxItem[] = [
        { kind: 'queued', name: 'Z' },
        { kind: 'queued', name: 'A' },
      ];
      const original = [...items];
      sortDecisionBoxItems(items, 'name', 'asc', 1);
      expect(items).toEqual(original);
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

  describe('detectNewlyResolvedCases', () => {
    const me = 'player-1';
    const rival = 'player-2';

    const negotiating = (overrides: Partial<MinimalLegalCaseForVerdict> = {}): MinimalLegalCaseForVerdict => ({
      id: 'case-1',
      status: 'negotiating',
      plaintiffId: me,
      defendantId: rival,
      ...overrides,
    });

    it('should return nothing when there are no cases at all', () => {
      expect(detectNewlyResolvedCases([], [], me)).toEqual([]);
    });

    it('should not report a case that is still negotiating', () => {
      const stillOpen = negotiating();
      expect(detectNewlyResolvedCases([stillOpen], [stillOpen], me)).toEqual([]);
    });

    it('should detect a win as plaintiff when the verdict is "won"', () => {
      const previous = negotiating({ status: 'awaiting_trial' });
      const current = { ...previous, status: 'resolved' as const, verdict: 'won' as const };
      expect(detectNewlyResolvedCases([previous], [current], me)).toEqual([{ case: current, outcome: 'won' }]);
    });

    it('should detect a loss as plaintiff when the verdict is "lost"', () => {
      const previous = negotiating({ status: 'awaiting_trial' });
      const current = { ...previous, status: 'resolved' as const, verdict: 'lost' as const };
      expect(detectNewlyResolvedCases([previous], [current], me)).toEqual([{ case: current, outcome: 'lost' }]);
    });

    it('should flip the outcome for the defendant\'s own perspective — verdict "won" (plaintiff wins) is a LOSS for me as defendant', () => {
      const previous = negotiating({ plaintiffId: rival, defendantId: me, status: 'awaiting_trial' });
      const current = { ...previous, status: 'resolved' as const, verdict: 'won' as const };
      expect(detectNewlyResolvedCases([previous], [current], me)).toEqual([{ case: current, outcome: 'lost' }]);
    });

    it('should flip the outcome for the defendant\'s own perspective — verdict "lost" (plaintiff loses) is a WIN for me as defendant', () => {
      const previous = negotiating({ plaintiffId: rival, defendantId: me, status: 'awaiting_trial' });
      const current = { ...previous, status: 'resolved' as const, verdict: 'lost' as const };
      expect(detectNewlyResolvedCases([previous], [current], me)).toEqual([{ case: current, outcome: 'won' }]);
    });

    it('should ignore a case I have nothing to do with', () => {
      const previous = negotiating({ plaintiffId: 'player-3', defendantId: 'player-4', status: 'awaiting_trial' });
      const current = { ...previous, status: 'resolved' as const, verdict: 'won' as const };
      expect(detectNewlyResolvedCases([previous], [current], me)).toEqual([]);
    });

    it('should not re-report a case that was already resolved last turn', () => {
      const alreadyResolved = negotiating({ status: 'resolved', verdict: 'won' });
      expect(detectNewlyResolvedCases([alreadyResolved], [alreadyResolved], me)).toEqual([]);
    });

    it('should ignore settled/cancelled verdicts — not a trial outcome', () => {
      const previous = negotiating({ status: 'awaiting_trial' });
      const settled = { ...previous, status: 'resolved' as const, verdict: 'settled' as const };
      const cancelled = { ...previous, status: 'resolved' as const, verdict: 'cancelled' as const };
      expect(detectNewlyResolvedCases([previous], [settled], me)).toEqual([]);
      expect(detectNewlyResolvedCases([previous], [cancelled], me)).toEqual([]);
    });

    it('should detect multiple cases resolving with mixed outcomes in the same turn', () => {
      const wonPrev = negotiating({ id: 'case-1', status: 'awaiting_trial' });
      const wonCurrent = { ...wonPrev, status: 'resolved' as const, verdict: 'won' as const };
      const lostPrev = negotiating({ id: 'case-2', plaintiffId: rival, defendantId: me, status: 'awaiting_trial' });
      const lostCurrent = { ...lostPrev, status: 'resolved' as const, verdict: 'won' as const }; // plaintiff (rival) won -> I (defendant) lost

      const result = detectNewlyResolvedCases([wonPrev, lostPrev], [wonCurrent, lostCurrent], me);
      expect(result).toEqual(expect.arrayContaining([
        { case: wonCurrent, outcome: 'won' },
        { case: lostCurrent, outcome: 'lost' },
      ]));
      expect(result).toHaveLength(2);
    });
  });

  describe('detectNewlySettledCases', () => {
    const me = 'player-1';
    const rival = 'player-2';

    const negotiating = (overrides: Partial<MinimalLegalCaseForVerdict> = {}): MinimalLegalCaseForVerdict => ({
      id: 'case-1',
      status: 'negotiating',
      plaintiffId: me,
      defendantId: rival,
      ...overrides,
    });

    it('should return nothing when there are no cases at all', () => {
      expect(detectNewlySettledCases([], [], me)).toEqual([]);
    });

    it('should not report a case that is still negotiating', () => {
      const stillOpen = negotiating();
      expect(detectNewlySettledCases([stillOpen], [stillOpen], me)).toEqual([]);
    });

    it('should detect a settlement as plaintiff', () => {
      const previous = negotiating();
      const current = { ...previous, status: 'resolved' as const, verdict: 'settled' as const };
      expect(detectNewlySettledCases([previous], [current], me)).toEqual([{ case: current, role: 'plaintiff' }]);
    });

    it('should detect a settlement as defendant', () => {
      const previous = negotiating({ plaintiffId: rival, defendantId: me });
      const current = { ...previous, status: 'resolved' as const, verdict: 'settled' as const };
      expect(detectNewlySettledCases([previous], [current], me)).toEqual([{ case: current, role: 'defendant' }]);
    });

    it('should ignore won/lost/cancelled verdicts — not a negotiated settlement', () => {
      const previous = negotiating({ status: 'awaiting_trial' });
      const won = { ...previous, status: 'resolved' as const, verdict: 'won' as const };
      const lost = { ...previous, status: 'resolved' as const, verdict: 'lost' as const };
      const cancelled = { ...previous, status: 'resolved' as const, verdict: 'cancelled' as const };
      expect(detectNewlySettledCases([previous], [won], me)).toEqual([]);
      expect(detectNewlySettledCases([previous], [lost], me)).toEqual([]);
      expect(detectNewlySettledCases([previous], [cancelled], me)).toEqual([]);
    });

    it('should ignore a case I have nothing to do with', () => {
      const previous = negotiating({ plaintiffId: 'player-3', defendantId: 'player-4' });
      const current = { ...previous, status: 'resolved' as const, verdict: 'settled' as const };
      expect(detectNewlySettledCases([previous], [current], me)).toEqual([]);
    });

    it('should not re-report a case that was already resolved last turn', () => {
      const alreadyResolved = negotiating({ status: 'resolved', verdict: 'settled' });
      expect(detectNewlySettledCases([alreadyResolved], [alreadyResolved], me)).toEqual([]);
    });
  });

  describe('isAttackAlreadySuedOver', () => {
    const attacker = 'player-2';
    const baseAttack = (overrides: Partial<MinimalIncomingAttack> = {}): MinimalIncomingAttack => ({
      attackId: 'bot-attack-inst-1',
      attackerId: attacker,
      decisionName: 'Bot Attack',
      ...overrides,
    });

    it('is false with no pending lawsuits and no real cases', () => {
      expect(isAttackAlreadySuedOver(baseAttack(), [], [])).toBe(false);
    });

    it('is true once a matching lawsuit is queued (pending, not yet resolved)', () => {
      const pending = [{ targetId: attacker, decisionName: 'Bot Attack', groundName: 'CFAA Digital Sabotage Lawsuit' }];
      expect(isAttackAlreadySuedOver(baseAttack(), pending, [])).toBe(true);
    });

    it('is true once a real case exists claiming this exact attacking instance, regardless of its status', () => {
      const cases = [{ defendantId: attacker, decisionName: 'Bot Attack', defendantDecisionInstanceId: 'bot-attack-inst-1' }];
      expect(isAttackAlreadySuedOver(baseAttack(), [], cases)).toBe(true);
    });

    it('is true (regression) even when the ground sued over is NOT the suggested one — a manually-picked ground now counts, as long as it claimed the real instance', () => {
      // This is the actual reported bug: a case existed against the real attacking
      // instance, but over a ground other than whatever pickBestGround would have
      // suggested, and the hint stayed stuck up forever under the old ground-name check.
      const cases = [{ defendantId: attacker, decisionName: 'Bot Attack', defendantDecisionInstanceId: 'bot-attack-inst-1' }];
      expect(isAttackAlreadySuedOver(baseAttack(), [], cases)).toBe(true);
    });

    it('is true (regression) even with no investigation at all — filing never required investigating the attacker first', () => {
      const cases = [{ defendantId: attacker, decisionName: 'Bot Attack', defendantDecisionInstanceId: 'bot-attack-inst-1' }];
      // A bare attack with only attackId/attackerId/decisionName revealed — the minimum
      // any incoming attack ever carries, well below investigationLevel 3.
      expect(isAttackAlreadySuedOver({ attackId: 'bot-attack-inst-1', attackerId: attacker, decisionName: 'Bot Attack' }, [], cases)).toBe(true);
    });

    it('is false when the queued lawsuit is against a different attacker', () => {
      const pending = [{ targetId: 'player-3', decisionName: 'Bot Attack', groundName: 'CFAA Digital Sabotage Lawsuit' }];
      expect(isAttackAlreadySuedOver(baseAttack(), pending, [])).toBe(false);
    });

    it('is false when the queued lawsuit is over a different decision', () => {
      const pending = [{ targetId: attacker, decisionName: 'Some Other Decision', groundName: 'CFAA Digital Sabotage Lawsuit' }];
      expect(isAttackAlreadySuedOver(baseAttack(), pending, [])).toBe(false);
    });

    it('is false when a real case exists for this attacker/decision but against a DIFFERENT instance (e.g. a redeployed one) than the one attacking now', () => {
      const cases = [{ defendantId: attacker, decisionName: 'Bot Attack', defendantDecisionInstanceId: 'some-other-instance' }];
      expect(isAttackAlreadySuedOver(baseAttack(), [], cases)).toBe(false);
    });

    it('is false when the real case is a wrong-guess/time-barred one with no claimed instance at all', () => {
      const cases = [{ defendantId: attacker, decisionName: 'Bot Attack', defendantDecisionInstanceId: undefined }];
      expect(isAttackAlreadySuedOver(baseAttack(), [], cases)).toBe(false);
    });
  });

  describe('buildCapTable', () => {
    const makePlayer = (playerId: string, playerName: string, overrides: Partial<MinimalPlayerForCapTable['variables']> = {}): MinimalPlayerForCapTable => ({
      playerId,
      playerName,
      variables: { totalSharesOutstanding: 1_000_000, shareOwnership: {}, ...overrides },
      derived: { stockValue: 2 },
    });

    it('labels the viewer\'s own company\'s self-key row "You", sorted largest-first, with correct share counts and dollar values', () => {
      const me = makePlayer('player-1', 'Alice', { shareOwnership: { [SELF_OWNERSHIP_KEY]: 0.6, [EXTERNAL_MARKET_KEY]: 0.4 } });
      const rows = buildCapTable(me, 'player-1', [me]);
      expect(rows).toEqual([
        { key: SELF_OWNERSHIP_KEY, name: 'You', fraction: 0.6, shares: 600_000, value: 1_200_000, color: '#dc2626' },
        { key: EXTERNAL_MARKET_KEY, name: 'Public Market', fraction: 0.4, shares: 400_000, value: 800_000, color: '#d1d5db' },
      ]);
    });

    it('labels a rival company\'s own self-key row with the rival\'s name, not "You"', () => {
      const rival = makePlayer('player-2', 'Bob Corp', { shareOwnership: { [SELF_OWNERSHIP_KEY]: 1.0 } });
      const rows = buildCapTable(rival, 'player-1', [rival]);
      expect(rows[0]).toMatchObject({ name: 'Bob Corp', color: '#9ca3af' });
    });

    it('labels the viewer\'s own real playerId as "You" when they hold a stake in someone else\'s company', () => {
      const rival = makePlayer('player-2', 'Bob Corp', { shareOwnership: { [SELF_OWNERSHIP_KEY]: 0.7, 'player-1': 0.3 } });
      const rows = buildCapTable(rival, 'player-1', [rival]);
      const myRow = rows.find((r) => r.key === 'player-1');
      expect(myRow).toMatchObject({ name: 'You', fraction: 0.3, color: '#dc2626' });
    });

    it('resolves a third player\'s real playerId to their name via allPlayers', () => {
      const me = makePlayer('player-1', 'Alice');
      const rival = makePlayer('player-2', 'Bob Corp', { shareOwnership: { [SELF_OWNERSHIP_KEY]: 0.6, 'player-3': 0.4 } });
      const carol = makePlayer('player-3', 'Carol Inc');
      const rows = buildCapTable(rival, 'player-1', [me, carol]);
      const carolRow = rows.find((r) => r.key === 'player-3');
      expect(carolRow).toMatchObject({ name: 'Carol Inc', fraction: 0.4 });
    });

    it('falls back to a generic label for a holder no longer among allPlayers (eliminated since)', () => {
      const rival = makePlayer('player-2', 'Bob Corp', { shareOwnership: { [SELF_OWNERSHIP_KEY]: 0.8, 'player-99': 0.2 } });
      const rows = buildCapTable(rival, 'player-1', [rival]);
      const orphanRow = rows.find((r) => r.key === 'player-99');
      expect(orphanRow?.name).toBe('Former Shareholder');
    });

    it('omits a holder whose fraction has rounded down to (effectively) zero', () => {
      const me = makePlayer('player-1', 'Alice', { shareOwnership: { [SELF_OWNERSHIP_KEY]: 0.9999, 'player-2': 0.0001 } });
      const rows = buildCapTable(me, 'player-1', [me]);
      expect(rows).toHaveLength(1);
      expect(rows[0].key).toBe(SELF_OWNERSHIP_KEY);
    });

    it('cycles through the other-holder color set in descending-fraction order, without reusing "You"/founder/public-market colors', () => {
      const me = makePlayer('player-1', 'Alice', {
        shareOwnership: { [SELF_OWNERSHIP_KEY]: 0.4, 'player-2': 0.3, 'player-3': 0.2, [EXTERNAL_MARKET_KEY]: 0.1 },
      });
      const bob = makePlayer('player-2', 'Bob');
      const carol = makePlayer('player-3', 'Carol');
      const rows = buildCapTable(me, 'player-1', [me, bob, carol]);
      expect(rows.map((r) => [r.name, r.color])).toEqual([
        ['You', '#dc2626'],
        ['Bob', OTHER_HOLDER_COLORS[0]],
        ['Carol', OTHER_HOLDER_COLORS[1]],
        ['Public Market', '#d1d5db'],
      ]);
    });
  });

  describe('computeThreatTerms (Threat Level / Risk Gauge breakdown)', () => {
    const player = (overrides: Partial<MinimalVarsForThreat> = {}): MinimalPlayerForThreat => ({
      variables: { scrutiny: 0, outrage: 0, cash: 100000, ...overrides },
    });

    it('is 0 across the board with no legal exposure, scrutiny, outrage, or outside shareholders', () => {
      const terms = computeThreatTerms(player());
      expect(terms).toEqual({
        ler: 0, legalTerm: 0, scrutinyTerm: 0, outrageTerm: 0,
        ownershipRisk: 0, ownershipTerm: 0,
      });
    });

    it('clamps a negative scrutiny value to a 0 term, not a negative one (regression — found by random-play simulation)', () => {
      // Unlike outrage (already non-negative via Math.abs before this function ever sees
      // it), scrutiny has no floor of its own — a negative value used to flow straight
      // through into a negative scrutinyTerm with no lower clamp, mirroring the same gap
      // the real riskGauge formula had (see calcEngine.ts/CLAUDE.md).
      const terms = computeThreatTerms(player({ scrutiny: -80 }));
      expect(terms.scrutinyTerm).toBe(0);
    });

    it('is 0 when only self and EXTERNAL_MARKET hold shares — neither can trigger a takeover', () => {
      const terms = computeThreatTerms(player({ shareOwnership: { [SELF_OWNERSHIP_KEY]: 0.7, [EXTERNAL_MARKET_KEY]: 0.3 } }));
      expect(terms.ownershipRisk).toBe(0);
      expect(terms.ownershipTerm).toBe(0);
    });

    it('rises as the largest external holder approaches the 50% takeover threshold', () => {
      const terms = computeThreatTerms(player({ shareOwnership: { [SELF_OWNERSHIP_KEY]: 0.75, rival: 0.25 } }));
      expect(terms.ownershipRisk).toBeCloseTo(0.5, 5); // 0.25 / 0.5
      expect(terms.ownershipTerm).toBeCloseTo(THREAT_W4 * 0.5 * 100, 5); // weight 0.2 -> 10
    });

    it('caps ownership risk at 1 once a holder is at or beyond the threshold', () => {
      const terms = computeThreatTerms(player({ shareOwnership: { [SELF_OWNERSHIP_KEY]: 0.1, rival: 0.9 } }));
      expect(terms.ownershipRisk).toBe(1);
      expect(terms.ownershipTerm).toBeCloseTo(THREAT_W4 * 100, 5); // weight 0.2 -> 20
    });

    it('uses the single largest external stake, not a sum across multiple holders', () => {
      const terms = computeThreatTerms(player({ shareOwnership: { [SELF_OWNERSHIP_KEY]: 0.5, rivalA: 0.3, rivalB: 0.2 } }));
      expect(terms.ownershipRisk).toBeCloseTo(0.6, 5); // rivalA alone (0.3) / 0.5, not 0.5 combined
    });

    it('combines all four terms at their configured weights', () => {
      const terms = computeThreatTerms(
        player({ legalExposureRatio: 0.8, scrutiny: 100, outrage: 100, shareOwnership: { [SELF_OWNERSHIP_KEY]: 0.5, rival: 0.5 } }),
      );
      // w1*1 + w2*1 + w3*1 + w4*1 = 0.4 + 0.2 + 0.2 + 0.2 = 1.0 -> 100
      expect(terms.legalTerm + terms.scrutinyTerm + terms.outrageTerm + terms.ownershipTerm).toBeCloseTo(100, 5);
    });
  });
});
