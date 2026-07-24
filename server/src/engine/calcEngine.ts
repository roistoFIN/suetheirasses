/**
 * Calculation Engine — implements all financial & market formulas (the pure, scalar,
 * named-input ones — see the `Formula` DB table / defaultFormulas.ts for the current set)
 * 
 * Order of operations per player per turn:
 * 1. Depreciation ledger (per purchase)
 * 2. Competitiveness & market share
 * 3. Volume (supply cap)
 * 4. P&L
 * 5. Balance sheet
 * 6. Legal process
 * 7. Global Risk Gauge
 */

import type { PlayerVariables, AdminVariables } from '@suetheirasses/shared';
import { evalNamed, type FormulaSet } from './formulaEngine.js';

// ============================================================
// Constants for depreciation asset types
// ============================================================
const ASSET_LIFE = 10;       // years for physical assets
const INTANGIBLE_LIFE = 5;   // years for intangible assets

// ============================================================
// Share ownership — a company's cap table lives in
// `PlayerVariables.shareOwnership`, a `Record<string, number>` of fractions summing to
// 1.0. Two reserved sentinel keys, never a real player id:
//   "self"           — the company's own founding player's retained stake
//   "EXTERNAL_MARKET" — floating shares not held by any specific player
// Any other key is a real player id holding a cross-company stake (bought via Buy Shares).
// `totalSharesOutstanding` is a separate absolute count, used only for per-share pricing
// (`stockValue = marketEquity / totalSharesOutstanding`, below).
// ============================================================
export const SELF_OWNERSHIP_KEY = 'self';
export const EXTERNAL_MARKET_KEY = 'EXTERNAL_MARKET';

/** Divides every value in a shareOwnership map by their own sum, so it always reads as
 * exactly 1.0 in total — a cheap guard against float drift accumulating across many
 * turns of repeated dilution/acquisition math. Returns a NEW object (shareOwnership must
 * never be mutated in place — see `applySharesAmount`'s doc comment for why). */
export function renormalizeShareOwnership(shareOwnership: Record<string, number>): Record<string, number> {
  const sum = Object.values(shareOwnership).reduce((s, v) => s + v, 0);
  if (sum === 0) return { ...shareOwnership };
  const normalized: Record<string, number> = {};
  for (const [key, value] of Object.entries(shareOwnership)) {
    normalized[key] = value / sum;
  }
  return normalized;
}

/**
 * Share Issuance's effect: increases `totalSharesOutstanding` by
 * `sharesIssued` and dilutes every existing shareOwnership key proportionally
 * (`f' = f * oldTotal / newTotal`), crediting the newly issued shares 100% to
 * `EXTERNAL_MARKET`. Mutates `vars` in place (the caller, `applyDecisionImpacts`, already
 * works on its own local shallow copy `v`) — but always REPLACES `vars.shareOwnership`
 * with a brand-new object rather than writing into the existing one, since a shallow
 * `{ ...vars }` copy still shares the same nested `shareOwnership` object reference with
 * whatever `vars` it was copied from; mutating it in place would silently corrupt that
 * other reference too.
 */
function applySharesAmount(vars: PlayerVariables, sharesIssued: number): void {
  const oldTotal = vars.totalSharesOutstanding || 0;
  const newTotal = oldTotal + sharesIssued;
  if (newTotal <= 0) return;

  const diluted: Record<string, number> = {};
  for (const [key, fraction] of Object.entries(vars.shareOwnership ?? {})) {
    diluted[key] = oldTotal > 0 ? fraction * (oldTotal / newTotal) : 0;
  }
  diluted[EXTERNAL_MARKET_KEY] = (diluted[EXTERNAL_MARKET_KEY] ?? 0) + sharesIssued / newTotal;

  vars.totalSharesOutstanding = newTotal;
  vars.shareOwnership = renormalizeShareOwnership(diluted);
}

/**
 * Step 1: Apply depreciation ledger updates.
 * For each positive absolute addition to assets/intangibleAssets that represents
 * a genuine purchase, create a depreciation entry.
 */
export function applyDepreciation(
  vars: PlayerVariables,
  depreciationLedger: Array<{
    id: string;
    assetType: 'assets' | 'intangibleAssets';
    originalValue: number;
    purchaseYear: number;
    usefulLife: number;
    annualAmount: number;
    remainingYears: number;
  }>,
  currentYear: number,
): { updatedVars: PlayerVariables; updatedLedger: typeof depreciationLedger; totalDepreciation: number } {
  let totalDepreciation = 0;
  const v = { ...vars };
  const ledger = [...depreciationLedger];

  // Process existing ledger entries — depreciate each one for the current year
  for (let i = 0; i < ledger.length; i++) {
    const entry = ledger[i];
    const yearsElapsed = currentYear - entry.purchaseYear;

    if (yearsElapsed >= entry.usefulLife) {
      // Fully depreciated — remove from ledger
      ledger.splice(i, 1);
      i--;
      continue;
    }

    // Apply this year's depreciation
    totalDepreciation += entry.annualAmount;
    const assetKey = entry.assetType as keyof Pick<PlayerVariables, 'assets' | 'intangibleAssets'>;
    (v[assetKey] as number) -= entry.annualAmount;
    ledger[i] = { ...entry, remainingYears: entry.remainingYears - 1 };
  }

  return { updatedVars: v, updatedLedger: ledger, totalDepreciation };
}

/**
 * Add a new depreciation entry when an asset purchase occurs. Any positive absolute
 * addition to `assets`/`intangibleAssets` on a decision's deployment year is treated as a
 * genuine purchase — not gated by a hardcoded decision-name allowlist (previously
 * `DEPRECIATING_ASSETS`, removed: it silently fell out of sync with the actual,
 * admin-editable decision library — see CLAUDE.md).
 */
export function addDepreciationEntry(
  assetType: 'assets' | 'intangibleAssets',
  value: number,
  currentYear: number,
): DepreciationLedgerEntry | null {
  if (value <= 0) return null;

  const usefulLife = assetType === 'assets' ? ASSET_LIFE : INTANGIBLE_LIFE;
  const annualAmount = value / usefulLife;

  return {
    id: crypto.randomUUID(),
    assetType,
    originalValue: value,
    purchaseYear: currentYear,
    usefulLife,
    annualAmount,
    remainingYears: usefulLife,
  };
}

/**
 * Step 2: Calculate competitiveness and market share for ALL players.
 *
 * effectiveDemand_i = (demand_i - outrageDemandWeight * outrage_i) / 100
 * competitiveness_i = (1/price_i) * (1 + wq*processingLevel_i + ws*supplySecurity_i
 *                                     - wl*processLoss_i + wd*effectiveDemand_i)
 * marketShare_i     = competitiveness_i / SUM_j(competitiveness_j)
 */
export function calculateCompetitivenessAndMarketShare(
  playerIds: string[],
  playersVars: PlayerVariables[],
  admin: AdminVariables,
  formulas: FormulaSet,
): Map<string, number> {
  if (playerIds.length !== playersVars.length) {
    throw new Error('playerIds and playersVars must have the same length');
  }

  const { competitivenessWeight_quality_wq: wq, competitivenessWeight_supply_ws: ws, competitivenessWeight_loss_wl: wl, competitivenessWeight_demand_wd: wd, outrageDemandWeight } = admin.competitiveness;

  // Calculate individual competitiveness
  const competitivenessMap = new Map<string, number>();

  for (let i = 0; i < playersVars.length; i++) {
    const v = playersVars[i];
    const effectiveDemand = evalNamed(formulas, 'effectiveDemand', { demand: v.demand, outrageDemandWeight, outrage: v.outrage });
    const competitiveness = evalNamed(formulas, 'competitiveness', {
      price: v.price, wq, processingLevel: v.processingLevel, ws, supplySecurity: v.supplySecurity,
      wl, processLoss: v.processLoss, wd, effectiveDemand,
    });
    competitivenessMap.set(playerIds[i], competitiveness);
  }

  // Sum all competitiveness values
  const totalCompetitiveness = Array.from(competitivenessMap.values()).reduce((sum, c) => sum + c, 0);

  if (totalCompetitiveness === 0) {
    // Equal share if no one has competitiveness
    const equalShare = 1 / playerIds.length;
    return new Map(playerIds.map(id => [id, equalShare]));
  }

  // Calculate market shares
  const marketShareMap = new Map<string, number>();
  for (const [id, comp] of competitivenessMap.entries()) {
    marketShareMap.set(id, comp / totalCompetitiveness);
  }

  return marketShareMap;
}

/**
 * Step 3: Calculate volume (supply cap).
 * 
 * theoreticalVolume_i = marketShare_i * totalMarketVolume
 * maxSupply_i         = installedCapacity_i * capacityUtilization_i
 * volume_i            = MIN(theoreticalVolume_i, maxSupply_i)
 */
export function calculateVolume(
  vars: PlayerVariables,
  marketShare: number,
  totalMarketVolume: number,
  formulas: FormulaSet,
): number {
  const theoreticalVolume = evalNamed(formulas, 'theoreticalVolume', { marketShare, totalMarketVolume });
  const maxSupply = evalNamed(formulas, 'maxSupply', { installedCapacity: vars.installedCapacity, capacityUtilization: vars.capacityUtilization });
  return evalNamed(formulas, 'volume', { theoreticalVolume, maxSupply });
}

/**
 * Step 4: Calculate P&L.
 *
 * revenue_i        = volume_i * price_i + absolute revenue schedules
 * COGS_i           = (materialCostPerTon_i + logisticsCostPerTon_i) * volume_i
 * grossProfit_i    = revenue_i - COGS_i
 * EBITDA_i         = grossProfit_i - operatingExpenses_i - staffCost_i + otherIncome_i
 * EBIT_i           = EBITDA_i - depreciation_i
 * financeCost_i    = baseFinanceCost + debt_i * interestRate + absolute financeCost additions
 * profitBeforeTax_i = EBIT_i - financeCost_i
 * taxCost_i        = MAX(0, profitBeforeTax_i) * taxRate + absolute taxCost adjustments
 * netProfit_i      = profitBeforeTax_i - taxCost_i
 */
export function calculatePL(
  vars: PlayerVariables,
  volume: number,
  depreciation: number,
  admin: AdminVariables,
  formulas: FormulaSet,
  absScheduleDeltas?: {
    revenueDelta?: number;
    financeCostDelta?: number;
    taxCostDelta?: number;
  },
): {
  revenue: number;
  cogs: number;
  grossProfit: number;
  ebitda: number;
  ebit: number;
  financeCost: number;
  profitBeforeTax: number;
  taxCost: number;
  netProfit: number;
} {
  const { baseFinanceCost, interestRate, taxRate } = admin.finance;
  const { revenueDelta = 0, financeCostDelta = 0, taxCostDelta = 0 } = absScheduleDeltas ?? {};

  // Add decision-driven ABSOLUTE schedule additions to revenue
  const revenue = evalNamed(formulas, 'revenue', { volume, price: vars.price, revenueDelta });
  const cogs = evalNamed(formulas, 'cogs', { materialCostPerTon: vars.materialCostPerTon, logisticsCostPerTon: vars.logisticsCostPerTon, volume });
  const grossProfit = evalNamed(formulas, 'grossProfit', { revenue, cogs });
  const ebitda = evalNamed(formulas, 'ebitda', { grossProfit, operatingExpenses: vars.operatingExpenses, staffCost: vars.staffCost, otherIncome: vars.otherIncome });
  const ebit = evalNamed(formulas, 'ebit', { ebitda, depreciation });
  // Add decision-driven ABSOLUTE schedule additions to financeCost
  const financeCost = evalNamed(formulas, 'financeCost', { baseFinanceCost, debt: Number(vars.debt), interestRate, financeCostDelta });
  const profitBeforeTax = evalNamed(formulas, 'profitBeforeTax', { ebit, financeCost });
  // Add decision-driven ABSOLUTE schedule adjustments to taxCost
  const taxCost = evalNamed(formulas, 'taxCost', { profitBeforeTax, taxRate, taxCostDelta });
  const netProfit = evalNamed(formulas, 'netProfit', { profitBeforeTax, taxCost });

  return { revenue, cogs, grossProfit, ebitda, ebit, financeCost, profitBeforeTax, taxCost, netProfit };
}

/**
 * Step 5: Update balance sheet.
 *
 * cash_i       += netProfit_i + depreciation_i
 * reserves_i   += netProfit_i
 * receivables_i = revenue_i * (DSO / 365) + absolute receivables schedules
 * equity_i      = cash_i + receivables_i + assets_i + intangibleAssets_i + reserves_i - debt_i
 * marketEquity_i = MAX(0, equity_i - legalExposure_i)
 * stockValue_i   = marketEquity_i / totalSharesOutstanding_i
 */
export function updateBalanceSheet(
  vars: PlayerVariables,
  netProfit: number,
  depreciation: number,
  revenue: number,
  legalExposure: number,
  admin: AdminVariables,
  formulas: FormulaSet,
  absReceivablesDelta?: number,
): Pick<PlayerVariables, 'cash' | 'reserves' | 'receivables' | 'equity' | 'stockValue' | 'legalExposure'> {
  const { daysSalesOutstanding_DSO: DSO } = admin.finance;
  const receivablesDelta = absReceivablesDelta ?? 0;

  const newCash = evalNamed(formulas, 'newCash', { cash: vars.cash, netProfit, depreciation });
  const newReserves = evalNamed(formulas, 'newReserves', { reserves: vars.reserves, netProfit });
  // Add decision-driven ABSOLUTE schedule additions to receivables
  const receivables = evalNamed(formulas, 'receivables', { revenue, DSO, receivablesDelta });
  // Book equity (for financial statements)
  const equity = evalNamed(formulas, 'equity', {
    newCash, receivables, assets: vars.assets, intangibleAssets: vars.intangibleAssets, newReserves, debt: Number(vars.debt),
  });
  // Market equity (legal exposure reduces stock price)
  const marketEquity = evalNamed(formulas, 'marketEquity', { equity, legalExposure });
  const stockValue = evalNamed(formulas, 'stockValue', { marketEquity, totalSharesOutstanding: vars.totalSharesOutstanding });

  return {
    cash: newCash,
    reserves: newReserves,
    receivables,
    equity,
    stockValue,
    legalExposure,
  };
}

/**
 * Step 6: Calculate adjusted legal risk probability.
 * 
 * adjustedProbability_case = baseProbability_legalRisk
 *                            * (1 + scrutinyLegalRiskMultiplier * scrutiny_defendant / 100
 *                                 + legalExposureRatio_defendant)
 */
export function calculateAdjustedProbability(
  baseProbability: number,
  defendantScrutiny: number,
  defendantLegalExposureRatio: number,
  admin: AdminVariables,
  formulas: FormulaSet,
): number {
  const { scrutinyLegalRiskMultiplier } = admin.legalProcess;
  return evalNamed(formulas, 'adjustedProbability', {
    baseProbability, scrutinyLegalRiskMultiplier, defendantScrutiny, defendantLegalExposureRatio,
  });
}

/**
 * Calculate legal exposure ratio (capped) — feeds both the legal-risk probability
 * snowball effect and the Risk Gauge.
 * 
 * legalExposureRatio_i = MIN(legalExposureRatioCap, legalExposure_i / cash_i)
 */
export function calculateLegalExposureRatio(
  legalExposure: number,
  cash: number,
  admin: AdminVariables,
  formulas: FormulaSet,
): number {
  const { legalExposureRatioCap } = admin.legalProcess;
  // Guard stays in code, not the editable expression: legalExposureRatioCap is always
  // positive, so MIN(cap, 0) === 0 whenever cash <= 0 — this preserves the exact
  // current behavior (short-circuiting the division) rather than adding a new
  // safety net that wasn't there before.
  if (cash <= 0) return 0;
  return evalNamed(formulas, 'legalExposureRatio', { legalExposureRatioCap, legalExposure, cash });
}

/**
 * Majority-ownership takeover risk (0-1), for the Risk Gauge's 4th term — a deliberate
 * addition beyond the Risk Gauge's original 3-term design. Majority-ownership takeover
 * (any real player crossing `takeoverThresholdPercent` of this
 * company's `shareOwnership`) is a fully independent way to lose the game that the
 * original risk gauge never reflected at all; a player could sit at a comfortable
 * legal/reputational score while a rival held 48% of their company with zero warning.
 *
 * Deliberately keyed off the *largest single external holder's* stake, not
 * `1 - selfOwnership` — the actual elimination trigger only cares about one player
 * crossing the threshold, so dilution spread thin across many small holders or the
 * public float (`EXTERNAL_MARKET`, excluded here — it can never itself trigger a
 * takeover) correctly reads as low risk, while a single concentrated buyer correctly
 * reads as high risk even if the founder's own stake is still comfortably above 50%.
 *
 * Scaled linearly against `takeoverThresholdPercent` (0 at 0% held, 1.0 right at the
 * threshold) and capped at 1 — once a holder is AT the threshold the game has already
 * ended for this player via the real elimination check, so anything beyond 1 has no
 * further meaning here.
 */
export function calculateOwnershipRisk(
  shareOwnership: Record<string, number> | undefined,
  takeoverThresholdPercent: number,
): number {
  if (!shareOwnership || takeoverThresholdPercent <= 0) return 0;
  let maxExternalStake = 0;
  for (const [key, fraction] of Object.entries(shareOwnership)) {
    if (key === SELF_OWNERSHIP_KEY || key === EXTERNAL_MARKET_KEY) continue;
    if (fraction > maxExternalStake) maxExternalStake = fraction;
  }
  return Math.min(1, maxExternalStake / takeoverThresholdPercent);
}

/**
 * Naive one-turn-ahead cash projection (0-1 term input, the Risk Gauge's 5th term) — a
 * deliberate simplification, not the real prediction engine (`GameLoop.predictFutureKpis`,
 * which re-runs the full turn-resolution engine in a sandbox). Calling that from inside
 * Step 7: Calculate Global Risk Gauge — a weighted blend of 4 terms, 1 of which is a
 * deliberate addition beyond the gauge's original 3-term design.
 *
 * legalExposure_i = SUM(open case probability * stakes) for all open cases where i is defendant
 * legalExposureRatio_i = MIN(0.8, legalExposure_i / cash_i)
 * risk_i (0-100) = 100 * ( w1*(legalExposureRatio_i / 0.8)
 *                         + w2*(scrutiny_i / 100)
 *                         + w3*(outrage_i / 100)
 *                         + w4*ownershipRisk_i )
 *
 * The w4/ownershipRisk term is a deliberate deviation from the gauge's original 3-term
 * design — see `calculateOwnershipRisk`'s doc comment above and CLAUDE.md's "Risk Gauge
 * takeover term" section.
 *
 * A 5th term, legal-solvency risk (w5 * solvencyRisk — open cases' exposure against a
 * linearly-projected next-turn cash), existed briefly and was removed: by explicit
 * product decision, it read as near-duplicate information next to the legal-exposure-
 * ratio term (w1) in the Threat Level breakdown — both terms are driven by the same
 * open-case exposure, one against current cash and one against a naive one-turn
 * projection, and in practice tracked each other closely enough that showing both was
 * more redundant than illuminating. w5's weight (0.2) was folded back into w1-w4
 * proportionally, restoring the exact pre-w5 weights (0.4/0.2/0.2/0.2) — see
 * CLAUDE.md's "Risk Gauge solvency term" section for the term's original rationale and
 * this section's own note for why it was removed.
 */
export function calculateRiskGauge(
  vars: PlayerVariables,
  openCases: Array<{ probability: number; stakes: number }>,
  admin: AdminVariables,
  formulas: FormulaSet,
): number {
  const {
    riskWeightLegalExposure_w1: w1, riskWeightScrutiny_w2: w2, riskWeightOutrage_w3: w3,
    riskWeightOwnership_w4: w4,
  } = admin.riskGauge;
  const { legalExposureRatioCap } = admin.legalProcess;
  const { takeoverThresholdPercent } = admin.ownership;

  // Calculate legal exposure (sum of probabilities × stakes for open cases) — a
  // genuine aggregation over a dynamic collection, stays as code, not a formula.
  const legalExposure = openCases.reduce((sum, c) => sum + c.probability * c.stakes, 0);

  // Calculate legal exposure ratio (normalized to cap)
  const legalExposureRatio = calculateLegalExposureRatio(legalExposure, vars.cash, admin, formulas);

  // The expression grammar has no ABS builtin — pre-compute it in code, same
  // treatment as every other pre-aggregated input (e.g. legalExposure above).
  const absOutrage = Math.abs(vars.outrage);

  const ownershipRisk = calculateOwnershipRisk(vars.shareOwnership, takeoverThresholdPercent);

  return evalNamed(formulas, 'riskGauge', {
    w1, w2, w3, w4, legalExposureRatio, legalExposureRatioCap, scrutiny: vars.scrutiny, absOutrage, ownershipRisk,
  });
}

/**
 * Determine which schedule value to use based on elapsed years since deployment.
 *
 * Schedule keys represent "year N" after deployment:
 *   key "1" = first year (deployment round), key "2" = second year, etc.
 *
 * Mapping: elapsedYears=0 → key 1, elapsedYears=1 → key 2, ..., elapsedYears=N-1 → key N,
 *          elapsedYears >= maxKey → default.
 *
 * Shared helper used by both applyDecisionImpacts and decisionEngine.applyInstance.
 */
export function getScheduleValue(
  schedule: Record<number | string, number>,
  elapsedYears: number,
): number {
  // Build ordered list of explicit numeric keys
  const numericKeys = Object.keys(schedule)
    .filter(k => k !== 'default')
    .map(Number)
    .sort((a, b) => a - b);
  const maxKey = numericKeys.length > 0 ? numericKeys[numericKeys.length - 1] : 0;

  // elapsedYears=0 maps to key 1, elapsedYears=1 maps to key 2, etc.
  // Once elapsedYears+1 exceeds the highest explicit key, fall through to 'default'
  // — this is where most decisions' permanent, post-maturity effect lives.
  if (elapsedYears >= 0 && elapsedYears + 1 <= maxKey) {
    return schedule[String(elapsedYears + 1)] ?? schedule['default'] ?? 0;
  }
  return schedule['default'] ?? 0;
}

// Fields with a hard floor of 0 and no ceiling — additive relative-multiplier stacking
// (see applyDecisionImpacts'/applyTargetImpacts' Phase 2 above) can otherwise drive one
// of these negative (e.g. several Maintenance-Neglect-style decisions stacking a large
// enough negative relative effect on the same field), which has no real-world meaning for
// any of the four. Applied unconditionally after every impact application, own-effect or
// target.*-routed alike, so the two code paths can never disagree about the floor.
const ZERO_FLOOR_FIELDS = ['processingLevel', 'capacityUtilization', 'installedCapacity', 'price'] as const;

function clampFloorZeroFields(v: PlayerVariables): PlayerVariables {
  for (const field of ZERO_FLOOR_FIELDS) {
    if (v[field] < 0) v[field] = 0;
  }
  return v;
}

/** A single depreciation ledger entry returned by applyDecisionImpacts for genuine asset purchases. */
export interface DepreciationLedgerEntry {
  id: string;
  assetType: 'assets' | 'intangibleAssets';
  originalValue: number;
  purchaseYear: number;
  usefulLife: number;
  annualAmount: number;
  remainingYears: number;
}

//** Absolute schedule deltas extracted from a single impact application. */
export interface AbsoluteScheduleDeltas {
  revenueDelta: number;
  financeCostDelta: number;
  taxCostDelta: number;
  receivablesDelta: number;
  /** Direct absolute `cash` schedule value applied this turn (income-side line for the bankruptcy/merger waterfall pool). */
  cashDelta: number;
}

/** Result of applying decision impacts — includes variables, depreciation entries, and absolute schedule deltas. */
export interface ApplyImpactsResult {
  updatedVars: PlayerVariables;
  newDepreciationEntries: DepreciationLedgerEntry[];
  /** Absolute additions to P&L fields that should be passed through to calculatePL/updateBalanceSheet. */
  absDeltas: AbsoluteScheduleDeltas;
}

/**
 * Apply decision impacts to player variables.
 * Handles both absolute and relative types, respecting maturity schedules.
 *
 * Relative multipliers are accumulated additively across all fields before application,
 * so multiple matured instances SUM correctly: base * (1 + m1 + m2 + ...).
 *
 * Returns newly created depreciation entries for genuine asset purchases.
 */
export function applyDecisionImpacts(
  vars: PlayerVariables,
  impacts: Record<string, { type: 'absolute' | 'relative'; schedule: Record<number | string, number> }>,
  elapsedYears: number,
  currentYear?: number,
): ApplyImpactsResult {
  const v = { ...vars };
  const newDepreciationEntries: DepreciationLedgerEntry[] = [];
  // Track absolute additions to P&L fields
  let revenueDelta = 0;
  let financeCostDelta = 0;
  let taxCostDelta = 0;
  let receivablesDelta = 0;
  let cashDelta = 0;

  // Phase 1 — accumulate per-field relative multipliers additively
  const fieldMultipliers = new Map<string, number>();

  for (const [field, impact] of Object.entries(impacts)) {
    if (field.startsWith('competitor')) continue; // Handled in cross-player resolution
    if (field.startsWith('target.')) continue; // Routed to the targeted player — see extractTargetImpacts/applyTargetImpacts
    if (field === 'sharesAmount') continue; // Special-cased below — not a real PlayerVariables field, see applySharesAmount

    const value = getScheduleValue(impact.schedule, elapsedYears);
    if (value === 0) continue;

    if (impact.type === 'relative') {
      fieldMultipliers.set(field, (fieldMultipliers.get(field) ?? 0) + value);
    }
  }

  // Phase 2 — apply accumulated relative multipliers and absolute additions
  // Also track positive absolute additions to assets/intangibleAssets for depreciation ledger
  for (const [field, impact] of Object.entries(impacts)) {
    if (field.startsWith('competitor')) continue;
    if (field.startsWith('target.')) continue;

    if (field === 'sharesAmount') {
      // Share Issuance's own-share-count increase — not a real
      // PlayerVariables field, so never written generically like every other field
      // here. A positive value on the deployment year increases totalSharesOutstanding
      // and dilutes every existing shareOwnership key proportionally, crediting the
      // newly issued shares 100% to EXTERNAL_MARKET. See applySharesAmount's doc comment
      // for why this needed its own special case (mirrors the target.*/competitor* skip
      // pattern right above, for the same "not a field applyDecisionImpacts can write
      // generically" reason).
      const sharesIssued = elapsedYears === 0 ? getScheduleValue(impact.schedule, elapsedYears) : 0;
      if (sharesIssued > 0) {
        applySharesAmount(v, sharesIssued);
      }
      continue;
    }

    const value = getScheduleValue(impact.schedule, elapsedYears);
    if (value === 0) continue;

    if (impact.type === 'absolute') {
      // ?? 0 matters: several optional PlayerVariables fields (revenue, financeCost,
      // taxCost — all "Derived (computed each turn)" fields never seeded by
      // startingVars()) start genuinely undefined, not 0. A bare `+= value` on an
      // undefined base is `undefined + number` = NaN in JS, which then persists forever
      // (NaN + anything is still NaN, and nothing else in the turn ever overwrites these
      // three specific fields the way receivables/equity/etc. get freshly recomputed each
      // turn) — a real, reported bug: Channel Stuffing (impacts.revenue), Tax Planning
      // (impacts.taxCost), and Payday Loan (impacts.financeCost) each silently corrupted
      // the deploying player's own `variables.revenue`/`taxCost`/`financeCost` to NaN
      // forever, the instant any player anywhere first deployed one. Caught by a random
      // 4-player game simulation, not by hand — see CLAUDE.md's "applyDecisionImpacts'
      // absolute-impact write corrupted an undefined field to NaN" section.
      (v as any)[field] = ((v as any)[field] ?? 0) + value;

      // Track absolute additions to P&L fields for delta passing
      if (field === 'revenue') revenueDelta += value;
      else if (field === 'financeCost') financeCostDelta += value;
      else if (field === 'taxCost') taxCostDelta += value;
      else if (field === 'receivables') receivablesDelta += value;
      else if (field === 'cash') cashDelta += value;

      // Track genuine asset purchases that need depreciation entries.
      // Only create entries on the first year (elapsedYears === 0) when the purchase is
      // new — any decision with a positive assets/intangibleAssets addition qualifies,
      // regardless of name (see addDepreciationEntry's doc comment).
      if (elapsedYears === 0 && value > 0 && (field === 'assets' || field === 'intangibleAssets')) {
        const entry = addDepreciationEntry(field, value, currentYear ?? 0);
        if (entry) {
          newDepreciationEntries.push(entry);
        }
      }
    } else {
      const multiplier = fieldMultipliers.get(field) ?? 0;
      const currentVal = (v as any)[field];
      if (typeof currentVal === 'number' && currentVal !== 0) {
        (v as any)[field] = currentVal * (1 + multiplier);
      }
    }
  }

  return { updatedVars: clampFloorZeroFields(v), newDepreciationEntries, absDeltas: { revenueDelta, financeCostDelta, taxCostDelta, receivablesDelta, cashDelta } };
}

/**
 * Extract target.* fields from impacts — these are cross-player effects
 * that must be applied to the targeted player, not the decision-maker.
 * Returns a map of field name → impact entry (without the "target." prefix).
 */
export function extractTargetImpacts(
  impacts: Record<string, { type: 'absolute' | 'relative'; schedule: Record<number | string, number> }>,
): Map<string, { type: 'absolute' | 'relative'; schedule: Record<number | string, number> }> {
  const targets = new Map<string, typeof impacts[string]>();
  for (const [field, impact] of Object.entries(impacts)) {
    if (field.startsWith('target.')) {
      const cleanField = field.slice('target.'.length);
      targets.set(cleanField, impact);
    }
  }
  return targets;
}

/**
 * Apply extracted target impacts to a player's variables at a given elapsed year.
 * This is the same logic as applyDecisionImpacts but only for the target fields.
 */
export function applyTargetImpacts(
  vars: PlayerVariables,
  targetImpacts: Map<string, { type: 'absolute' | 'relative'; schedule: Record<number | string, number> }>,
  elapsedYears: number,
): PlayerVariables {
  const v = { ...vars };

  // Phase 1 — accumulate per-field relative multipliers additively
  const fieldMultipliers = new Map<string, number>();
  for (const [field, impact] of targetImpacts) {
    const value = getScheduleValue(impact.schedule, elapsedYears);
    if (value === 0) continue;
    if (impact.type === 'relative') {
      fieldMultipliers.set(field, (fieldMultipliers.get(field) ?? 0) + value);
    }
  }

  // Phase 2 — apply accumulated relative multipliers and absolute additions
  for (const [field, impact] of targetImpacts) {
    const value = getScheduleValue(impact.schedule, elapsedYears);
    if (value === 0) continue;
    if (impact.type === 'absolute') {
      // Same undefined-base-produces-NaN guard as applyDecisionImpacts' own absolute
      // branch above — none of the 9 real target.* fields currently hit this in
      // practice (all seeded, non-optional), but a future admin-added target.* mapping
      // to an optional field would otherwise silently reintroduce the same bug.
      (v as any)[field] = ((v as any)[field] ?? 0) + value;
    } else {
      const multiplier = fieldMultipliers.get(field) ?? 0;
      const currentVal = (v as any)[field];
      if (typeof currentVal === 'number' && currentVal !== 0) {
        (v as any)[field] = currentVal * (1 + multiplier);
      }
    }
  }

  return clampFloorZeroFields(v);
}

/**
 * Calculate maturity years for a decision (max numeric schedule key).
 */
export function calculateMaturityYears(impacts: Record<string, { type: 'absolute' | 'relative'; schedule: Record<number | string, number> }>): number {
  let maxYear = 0;

  for (const impact of Object.values(impacts)) {
    for (const key of Object.keys(impact.schedule)) {
      if (key !== 'default') {
        const numKey = parseInt(key, 10);
        if (!isNaN(numKey) && numKey > maxYear) {
          maxYear = numKey;
        }
      }
    }
  }

  return maxYear;
}
