/**
 * The pure, scalar, named-input formulas (competitiveness, market share, P&L,
 * balance sheet, legal-risk probability, risk gauge) — this list IS the source
 * of truth for these 23 expressions (calcEngine.ts calls each by name via
 * evalNamed, never inlines the math itself). Everything procedural/order-
 * dependent (turn execution order, depreciation ledger iteration, the
 * bankruptcy/merger waterfall, FIFO tie-breaking) is deliberately NOT here —
 * that stays as TypeScript in gameLoop.ts/calcEngine.ts, since it's control
 * flow over dynamic per-turn collections, not a fixed-input expression.
 * `absOutrage` in riskGauge is `Math.abs(vars.outrage)`, computed in code
 * before evaluation since the expression grammar has no ABS function.
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
    description: 'Demand adjusted for reputational outrage, normalized to the 0-1 scale used by processingLevel/supplySecurity/processLoss.',
  },
  {
    key: 'competitiveness',
    expression: '(1/price) * (1 + wq*processingLevel + ws*supplySecurity - wl*processLoss + wd*effectiveDemand)',
    description: "How competitive this player is in the market — lower price and higher quality/supply/demand factors increase it, higher process loss decreases it. Combined with every other player's competitiveness to determine market share.",
  },
  {
    key: 'theoreticalVolume',
    expression: 'marketShare * totalMarketVolume',
    description: "The tonnage this player's market share entitles them to, before checking supply capacity.",
  },
  {
    key: 'maxSupply',
    expression: 'installedCapacity * capacityUtilization',
    description: 'The maximum tonnage this player can actually produce, given installed capacity and how much of it is in use.',
  },
  {
    key: 'volume',
    expression: 'MIN(theoreticalVolume, maxSupply)',
    description: 'Actual sold volume — capped by whichever is smaller: market entitlement or production capacity.',
  },
  {
    key: 'revenue',
    expression: 'volume * price + revenueDelta',
    description: 'Total revenue: volume sold times price, plus any one-time absolute revenue effects from active decisions this turn.',
  },
  {
    key: 'cogs',
    expression: '(materialCostPerTon + logisticsCostPerTon) * volume',
    description: 'Cost of goods sold: per-ton material and logistics costs times volume.',
  },
  {
    key: 'grossProfit',
    expression: 'revenue - cogs',
    description: 'Revenue minus cost of goods sold.',
  },
  {
    key: 'ebitda',
    expression: 'grossProfit - operatingExpenses - staffCost + otherIncome',
    description: 'Gross profit minus operating expenses and staff costs, plus other income.',
  },
  {
    key: 'ebit',
    expression: 'ebitda - depreciation',
    description: "EBITDA minus this turn's depreciation charge.",
  },
  {
    key: 'financeCost',
    expression: 'baseFinanceCost + debt*interestRate + financeCostDelta',
    description: 'Cost of financing: a base cost plus interest on outstanding debt, plus any one-time absolute finance-cost effects from active decisions.',
  },
  {
    key: 'profitBeforeTax',
    expression: 'ebit - financeCost',
    description: 'EBIT minus finance costs.',
  },
  {
    key: 'taxCost',
    expression: 'MAX(0, profitBeforeTax) * taxRate + taxCostDelta',
    description: 'Tax owed — only charged on positive profit, plus any one-time absolute tax adjustments from active decisions.',
  },
  {
    key: 'netProfit',
    expression: 'profitBeforeTax - taxCost',
    description: "Profit before tax minus tax owed — this turn's bottom line.",
  },
  {
    key: 'newCash',
    expression: 'cash + netProfit + depreciation',
    description: 'New cash balance: previous cash plus net profit, with depreciation added back since it is a non-cash charge.',
  },
  {
    key: 'newReserves',
    expression: 'reserves + netProfit',
    description: 'Retained earnings reserve, accumulated turn over turn.',
  },
  {
    key: 'receivables',
    expression: 'revenue*(DSO/365) + receivablesDelta',
    description: 'Outstanding customer receivables, based on days-sales-outstanding, plus any one-time absolute receivables effects from active decisions.',
  },
  {
    key: 'equity',
    expression: 'newCash + receivables + assets + intangibleAssets + newReserves - debt',
    description: 'Book equity — the balance-sheet identity used for financial statements.',
  },
  {
    key: 'marketEquity',
    expression: 'MAX(0, equity - legalExposure)',
    description: 'Equity as the market sees it — reduced by open legal exposure, floored at zero. Drives stock price, distinct from book equity.',
  },
  {
    key: 'stockValue',
    expression: 'marketEquity / totalSharesOutstanding',
    description: 'Price per share, priced off market equity rather than book equity — open lawsuits directly cheapen the stock.',
  },
  {
    key: 'adjustedProbability',
    expression: 'baseProbability * (1 + scrutinyLegalRiskMultiplier*defendantScrutiny/100 + defendantLegalExposureRatio)',
    description: "A lawsuit's actual win probability at resolution time — the base probability scaled up by the defendant's scrutiny and legal exposure ratio, a snowball effect where more open cases against you make every one more likely to succeed.",
  },
  {
    key: 'legalExposureRatio',
    expression: 'MIN(legalExposureRatioCap, legalExposure/cash)',
    description: 'Legal exposure as a fraction of cash, capped — feeds both the lawsuit-probability snowball (adjustedProbability) and the Global Risk Gauge (riskGauge). Only evaluated when cash > 0; the surrounding code returns 0 otherwise, to avoid dividing by zero.',
  },
  {
    key: 'riskGauge',
    expression: 'MIN(100, 100*(w1*(legalExposureRatio/legalExposureRatioCap) + w2*MAX(0,MIN(1,scrutiny/100)) + w3*MIN(1,absOutrage/100) + w4*ownershipRisk))',
    description: 'Overall risk score (0-100) — a weighted blend of legal exposure, scrutiny, outrage, and majority-ownership takeover risk, each normalized to a 0-1 scale before weighting. The first three terms (w1/w2/w3) were the gauge\'s original design; the 4th (w4*ownershipRisk) is a deliberate later addition — majority-ownership takeover is a fully independent way to lose the game the original 3-term gauge never reflected — see CLAUDE.md\'s "Risk Gauge takeover term" section. A 5th term (legal-solvency risk) existed briefly and was removed by explicit product decision — it read as near-duplicate information next to the legal-exposure-ratio term in the Threat Level breakdown (both driven by the same open-case exposure), and its weight was folded back into w1-w4 proportionally. absOutrage is |outrage| (already non-negative, so its term only needs an upper clamp); scrutiny itself has no floor and can legitimately go negative (no decision drives it back up past 0 the way outrage-reducing decisions can with outrage), so its term is clamped on BOTH ends (MAX(0,MIN(1,...))) — the missing lower clamp here let the whole gauge dip below its documented 0-100 range whenever scrutiny went negative, a real bug found via random-play simulation. ownershipRisk is already pre-clamped to [0,1] in code (calculateOwnershipRisk), so it is not re-clamped here.',
  },
];
