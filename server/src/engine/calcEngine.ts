/**
 * Calculation Engine — implements all financial & market formulas from FORMULAS.md
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

// Assets that create depreciation entries (genuine purchases)
export const DEPRECIATING_ASSETS = new Set([
  'New Factory',
  'Vertical Integration',
  'Off-Balance-Sheet Special Purpose Vehicle',
  'Energy Efficiency Retrofit',
  'Organic Shift',           // intangible variant
  'Pelleting Research and Development',
  'Patent Portfolio',
  'Quality Certification',
  'Raw Material Monopoly',   // intangible variant
]);

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
 * Add a new depreciation entry when an asset purchase occurs.
 */
export function addDepreciationEntry(
  decisionName: string,
  assetType: 'assets' | 'intangibleAssets',
  value: number,
  currentYear: number,
): DepreciationLedgerEntry | null {
  if (!DEPRECIATING_ASSETS.has(decisionName)) return null;
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

  // FORMULAS §4: Add decision-driven ABSOLUTE schedule additions to revenue
  const revenue = evalNamed(formulas, 'revenue', { volume, price: vars.price, revenueDelta });
  const cogs = evalNamed(formulas, 'cogs', { materialCostPerTon: vars.materialCostPerTon, logisticsCostPerTon: vars.logisticsCostPerTon, volume });
  const grossProfit = evalNamed(formulas, 'grossProfit', { revenue, cogs });
  const ebitda = evalNamed(formulas, 'ebitda', { grossProfit, operatingExpenses: vars.operatingExpenses, staffCost: vars.staffCost, otherIncome: vars.otherIncome });
  const ebit = evalNamed(formulas, 'ebit', { ebitda, depreciation });
  // FORMULAS §4: Add decision-driven ABSOLUTE schedule additions to financeCost
  const financeCost = evalNamed(formulas, 'financeCost', { baseFinanceCost, debt: Number(vars.debt), interestRate, financeCostDelta });
  const profitBeforeTax = evalNamed(formulas, 'profitBeforeTax', { ebit, financeCost });
  // FORMULAS §4: Add decision-driven ABSOLUTE schedule adjustments to taxCost
  const taxCost = evalNamed(formulas, 'taxCost', { profitBeforeTax, taxRate, taxCostDelta });
  const netProfit = evalNamed(formulas, 'netProfit', { profitBeforeTax, taxCost });

  return { revenue, cogs, grossProfit, ebitda, ebit, financeCost, profitBeforeTax, taxCost, netProfit };
}

/**
 * Step 5: Update balance sheet per FORMULAS §5.
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
  // FORMULAS §5: Add decision-driven ABSOLUTE schedule additions to receivables
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
 * Step 6: Calculate adjusted legal risk probability per FORMULAS §6.
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
 * Calculate legal exposure ratio (capped) per FORMULAS §6 & §7.
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
 * Step 7: Calculate Global Risk Gauge per FORMULAS §7.
 * 
 * legalExposure_i = SUM(open case probability * stakes) for all open cases where i is defendant
 * legalExposureRatio_i = MIN(0.8, legalExposure_i / cash_i)
 * risk_i (0-100) = 100 * ( w1*(legalExposureRatio_i / 0.8)
 *                         + w2*(scrutiny_i / 100)
 *                         + w3*(outrage_i / 100) )
 */
export function calculateRiskGauge(
  vars: PlayerVariables,
  openCases: Array<{ probability: number; stakes: number }>,
  admin: AdminVariables,
  formulas: FormulaSet,
): number {
  const { riskWeightLegalExposure_w1: w1, riskWeightScrutiny_w2: w2, riskWeightOutrage_w3: w3 } = admin.riskGauge;
  const { legalExposureRatioCap } = admin.legalProcess;

  // Calculate legal exposure (sum of probabilities × stakes for open cases) — a
  // genuine aggregation over a dynamic collection, stays as code, not a formula.
  const legalExposure = openCases.reduce((sum, c) => sum + c.probability * c.stakes, 0);

  // Calculate legal exposure ratio (normalized to cap)
  const legalExposureRatio = calculateLegalExposureRatio(legalExposure, vars.cash, admin, formulas);

  // The expression grammar has no ABS builtin — pre-compute it in code, same
  // treatment as every other pre-aggregated input (e.g. legalExposure above).
  const absOutrage = Math.abs(vars.outrage);

  return evalNamed(formulas, 'riskGauge', {
    w1, w2, w3, legalExposureRatio, legalExposureRatioCap, scrutiny: vars.scrutiny, absOutrage,
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
  // — this is where most decisions' permanent, post-maturity effect lives (FORMULAS §9).
  if (elapsedYears >= 0 && elapsedYears + 1 <= maxKey) {
    return schedule[String(elapsedYears + 1)] ?? schedule['default'] ?? 0;
  }
  return schedule['default'] ?? 0;
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

//** Absolute schedule deltas extracted from a single impact application (FORMULAS §4-§5). */
export interface AbsoluteScheduleDeltas {
  revenueDelta: number;
  financeCostDelta: number;
  taxCostDelta: number;
  receivablesDelta: number;
  /** Direct absolute `cash` schedule value applied this turn (FORMULAS §5/§16 — income-side line for the bankruptcy waterfall pool). */
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
  decisionName: string,
  impacts: Record<string, { type: 'absolute' | 'relative'; schedule: Record<number | string, number> }>,
  elapsedYears: number,
  currentYear?: number,
): ApplyImpactsResult {
  const v = { ...vars };
  const newDepreciationEntries: DepreciationLedgerEntry[] = [];
  // Track absolute additions to P&L fields (FORMULAS §4-§5)
  let revenueDelta = 0;
  let financeCostDelta = 0;
  let taxCostDelta = 0;
  let receivablesDelta = 0;
  let cashDelta = 0;

  // Phase 1 — accumulate per-field relative multipliers additively (FORMULAS §9)
  const fieldMultipliers = new Map<string, number>();

  for (const [field, impact] of Object.entries(impacts)) {
    if (field.startsWith('competitor')) continue; // Handled in cross-player resolution
    if (field.startsWith('target.')) continue; // Routed to the targeted player — see extractTargetImpacts/applyTargetImpacts

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

    const value = getScheduleValue(impact.schedule, elapsedYears);
    if (value === 0) continue;

    if (impact.type === 'absolute') {
      (v as any)[field] += value;

      // Track absolute additions to P&L fields for delta passing (FORMULAS §4-§5)
      if (field === 'revenue') revenueDelta += value;
      else if (field === 'financeCost') financeCostDelta += value;
      else if (field === 'taxCost') taxCostDelta += value;
      else if (field === 'receivables') receivablesDelta += value;
      else if (field === 'cash') cashDelta += value;

      // FORMULAS §1: Track genuine asset purchases that need depreciation entries.
      // Only create entries on the first year (elapsedYears === 0) when the purchase is new.
      if (elapsedYears === 0 && value > 0 && DEPRECIATING_ASSETS.has(decisionName)) {
        if (field === 'assets' || field === 'intangibleAssets') {
          const entry = addDepreciationEntry(decisionName, field as 'assets' | 'intangibleAssets', value, currentYear ?? 0);
          if (entry) {
            newDepreciationEntries.push(entry);
          }
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

  return { updatedVars: v, newDepreciationEntries, absDeltas: { revenueDelta, financeCostDelta, taxCostDelta, receivablesDelta, cashDelta } };
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
      (v as any)[field] += value;
    } else {
      const multiplier = fieldMultipliers.get(field) ?? 0;
      const currentVal = (v as any)[field];
      if (typeof currentVal === 'number' && currentVal !== 0) {
        (v as any)[field] = currentVal * (1 + multiplier);
      }
    }
  }

  return v;
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
