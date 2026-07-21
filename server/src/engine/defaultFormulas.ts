/**
 * The pure, scalar, named-input formulas from FORMULAS.md (§2-§7) — every
 * expression here is hand-transcribed to match calcEngine.ts's exact current
 * behavior (the code, not the Finnish prose, is the source of truth for exact
 * behavior — see CLAUDE.md). Everything procedural/order-dependent in
 * FORMULAS.md (execution phases, depreciation ledger iteration, bankruptcy
 * waterfall, FIFO tie-breaking) is deliberately NOT here — it stays as
 * TypeScript. `absOutrage` in riskGauge is `Math.abs(vars.outrage)`, computed
 * in code before evaluation since the expression grammar has no ABS function.
 *
 * Single source of truth for these 23 rows — `prisma/seed.ts` seeds the DB from
 * this list, and `calcEngine.test.ts`/`gameEngine.test.ts` build their test
 * fixtures from the same list, so there's no drift between what ships and what
 * the tests exercise.
 */
export interface DefaultFormulaSeed {
  key: string;
  expression: string;
  description: string;
}

export const DEFAULT_FORMULA_SEEDS: DefaultFormulaSeed[] = [
  {
    key: 'effectiveDemand',
    expression: '(demand - outrageDemandWeight * outrage) / 100',
    description: 'Demand adjusted for reputational outrage, normalized to the 0-1 scale used by processingLevel/supplySecurity/processLoss (FORMULAS §2).',
  },
  {
    key: 'competitiveness',
    expression: '(1/price) * (1 + wq*processingLevel + ws*supplySecurity - wl*processLoss + wd*effectiveDemand)',
    description: "How competitive this player is in the market — lower price and higher quality/supply/demand factors increase it, higher process loss decreases it (FORMULAS §2). Combined with every other player's competitiveness to determine market share.",
  },
  {
    key: 'theoreticalVolume',
    expression: 'marketShare * totalMarketVolume',
    description: "The tonnage this player's market share entitles them to, before checking supply capacity (FORMULAS §3).",
  },
  {
    key: 'maxSupply',
    expression: 'installedCapacity * capacityUtilization',
    description: 'The maximum tonnage this player can actually produce, given installed capacity and how much of it is in use (FORMULAS §3).',
  },
  {
    key: 'volume',
    expression: 'MIN(theoreticalVolume, maxSupply)',
    description: 'Actual sold volume — capped by whichever is smaller: market entitlement or production capacity (FORMULAS §3).',
  },
  {
    key: 'revenue',
    expression: 'volume * price + revenueDelta',
    description: 'Total revenue: volume sold times price, plus any one-time absolute revenue effects from active decisions this turn (FORMULAS §4).',
  },
  {
    key: 'cogs',
    expression: '(materialCostPerTon + logisticsCostPerTon) * volume',
    description: 'Cost of goods sold: per-ton material and logistics costs times volume (FORMULAS §4).',
  },
  {
    key: 'grossProfit',
    expression: 'revenue - cogs',
    description: 'Revenue minus cost of goods sold (FORMULAS §4).',
  },
  {
    key: 'ebitda',
    expression: 'grossProfit - operatingExpenses - staffCost + otherIncome',
    description: 'Gross profit minus operating expenses and staff costs, plus other income (FORMULAS §4).',
  },
  {
    key: 'ebit',
    expression: 'ebitda - depreciation',
    description: "EBITDA minus this turn's depreciation charge (FORMULAS §4).",
  },
  {
    key: 'financeCost',
    expression: 'baseFinanceCost + debt*interestRate + financeCostDelta',
    description: 'Cost of financing: a base cost plus interest on outstanding debt, plus any one-time absolute finance-cost effects from active decisions (FORMULAS §4).',
  },
  {
    key: 'profitBeforeTax',
    expression: 'ebit - financeCost',
    description: 'EBIT minus finance costs (FORMULAS §4).',
  },
  {
    key: 'taxCost',
    expression: 'MAX(0, profitBeforeTax) * taxRate + taxCostDelta',
    description: 'Tax owed — only charged on positive profit, plus any one-time absolute tax adjustments from active decisions (FORMULAS §4).',
  },
  {
    key: 'netProfit',
    expression: 'profitBeforeTax - taxCost',
    description: "Profit before tax minus tax owed — this turn's bottom line (FORMULAS §4).",
  },
  {
    key: 'newCash',
    expression: 'cash + netProfit + depreciation',
    description: 'New cash balance: previous cash plus net profit, with depreciation added back since it is a non-cash charge (FORMULAS §5).',
  },
  {
    key: 'newReserves',
    expression: 'reserves + netProfit',
    description: 'Retained earnings reserve, accumulated turn over turn (FORMULAS §5).',
  },
  {
    key: 'receivables',
    expression: 'revenue*(DSO/365) + receivablesDelta',
    description: 'Outstanding customer receivables, based on days-sales-outstanding, plus any one-time absolute receivables effects from active decisions (FORMULAS §5).',
  },
  {
    key: 'equity',
    expression: 'newCash + receivables + assets + intangibleAssets + newReserves - debt',
    description: 'Book equity — the balance-sheet identity used for financial statements (FORMULAS §5).',
  },
  {
    key: 'marketEquity',
    expression: 'MAX(0, equity - legalExposure)',
    description: 'Equity as the market sees it — reduced by open legal exposure, floored at zero (FORMULAS §5). Drives stock price, distinct from book equity.',
  },
  {
    key: 'stockValue',
    expression: 'marketEquity / totalSharesOutstanding',
    description: 'Price per share, priced off market equity rather than book equity — open lawsuits directly cheapen the stock (FORMULAS §5).',
  },
  {
    key: 'adjustedProbability',
    expression: 'baseProbability * (1 + scrutinyLegalRiskMultiplier*defendantScrutiny/100 + defendantLegalExposureRatio)',
    description: "A lawsuit's actual win probability at resolution time — the base probability scaled up by the defendant's scrutiny and legal exposure ratio, a snowball effect where more open cases against you make every one more likely to succeed (FORMULAS §6).",
  },
  {
    key: 'legalExposureRatio',
    expression: 'MIN(legalExposureRatioCap, legalExposure/cash)',
    description: 'Legal exposure as a fraction of cash, capped — feeds both the lawsuit-probability snowball (§6) and the Global Risk Gauge (§7). Only evaluated when cash > 0; the surrounding code returns 0 otherwise, to avoid dividing by zero.',
  },
  {
    key: 'riskGauge',
    expression: 'MIN(100, 100*(w1*(legalExposureRatio/legalExposureRatioCap) + w2*MIN(1,scrutiny/100) + w3*MIN(1,absOutrage/100)))',
    description: 'Overall risk score (0-100) — a weighted blend of legal exposure, scrutiny, and outrage, each normalized to a 0-1 scale before weighting (FORMULAS §7). absOutrage is |outrage|.',
  },
];
