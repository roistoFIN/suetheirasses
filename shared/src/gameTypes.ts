// ============================================================
// Game Engine Types — shared between server and future admin panel
// ============================================================

/** A single decision definition loaded from game_engine.json */
export interface DecisionDefinition {
  decision: string;
  level: 'Strategic' | 'Operational';
  description: string;
  nature: 'Traditional' | 'Grey Area' | 'Dirty';
  offensiveAction: boolean;
  excludes: string[];
  impacts: Record<string, ImpactEntry>;
  legalRisks?: LegalRiskDefinition[];
  competitorsView?: string[];
  variableAmount?: boolean;
  requiresTarget?: boolean;
  legalRiskConditions?: Record<string, unknown>;
  /** Required whenever `impacts.cash` is set (FORMULAS §5) — buckets this decision's direct cash impact into the cash flow statement. */
  cashFlowCategory?: 'operating' | 'investing' | 'financing';
}

export interface ImpactEntry {
  type: 'absolute' | 'relative';
  schedule: Record<number | string, number>;
}

export interface LegalRiskDefinition {
  name: string;
  description: string;
  probability: Record<number | string, number>;
  impact: ImpactEntry & { target: string };
}

/** Admin-configurable constants from game_config.json */
export interface GameConfig {
  gameSettings: GameSettings;
  playerStartingValues: PlayerStartingValues;
  adminVariables: AdminVariables;
}

export interface GameSettings {
  minPlayers: number;
  maxPlayers: number;
  turnDurationSeconds: number;
  maxLawsuitsPerPlayerPerTurn: number;
  maxStrategicDecisionsPerTurn: number;
  maxOperationalDecisionsPerTurn: number;
  totalMarketVolumeTonnesPerYear: number;
  marketFixed: boolean;
  /** Cash cost of one "Dig Deeper" investigation click — deducted instantly, outside turn resolution. */
  digDeeperCost: number;
}

export interface PlayerStartingValues {
  cash: number;
  assets: number;
  intangibleAssets: number;
  debt: number;
  reserves: number;
  operatingExpenses: number;
  staffCost: number;
  materialCostPerTon: number;
  otherIncome: number;
  price: number;
  capacityUtilization: number;
  processingLevel: number;
  energyIntensity: number;
  moistureContent: number;
  nutrientConsistency: number;
  supplySecurity: number;
  logisticsCostPerTon: number;
  processLoss: number;
  installedCapacity: number;
  totalSharesOutstanding: number;
  shareOwnership: Record<string, number>;
  outrage: number;
  scrutiny: number;
  breakdowns: number;
  contaminationRisk: number;
  odorComplaints: number;
  tokenLiability: number;
  carbonFootprint: number;
  stockVolume: number;
  demand: number;
}

export interface AdminVariables {
  competitiveness: CompetitivenessConfig;
  legalProcess: LegalProcessConfig;
  riskGauge: RiskGaugeConfig;
  ownership: OwnershipConfig;
  finance: FinanceConfig;
  depreciation: DepreciationConfig;
}

export interface CompetitivenessConfig {
  competitivenessWeight_quality_wq: number;
  competitivenessWeight_supply_ws: number;
  competitivenessWeight_loss_wl: number;
  competitivenessWeight_demand_wd: number;
  outrageDemandWeight: number;
}

export interface LegalProcessConfig {
  semaphoreGreenMax: number;
  semaphoreYellowMax: number;
  scrutinyLegalRiskMultiplier: number;
  legalExposureRatioCap: number;
  buySharesLegalRiskThresholdPercent: number;
}

export interface RiskGaugeConfig {
  riskWeightLegalExposure_w1: number;
  riskWeightScrutiny_w2: number;
  riskWeightOutrage_w3: number;
}

export interface OwnershipConfig {
  takeoverThresholdPercent: number;
}

export interface FinanceConfig {
  baseFinanceCost: number;
  interestRate: number;
  taxRate: number;
  daysSalesOutstanding_DSO: number;
}

export interface DepreciationConfig {
  assetUsefulLifeYears: number;
  intangibleUsefulLifeYears: number;
}

// ============================================================
// Runtime Player State (computed each turn)
// ============================================================

/** All per-player variables that the game engine tracks */
export interface PlayerVariables {
  // Financial
  cash: number;
  assets: number;
  intangibleAssets: number;
  debt: number;
  reserves: number;
  operatingExpenses: number;
  staffCost: number;
  materialCostPerTon: number;
  otherIncome: number;

  // Production
  price: number;
  capacityUtilization: number;
  processingLevel: number;
  energyIntensity: number;
  moistureContent: number;
  nutrientConsistency: number;
  supplySecurity: number;
  logisticsCostPerTon: number;
  processLoss: number;
  installedCapacity: number;

  // Shares
  totalSharesOutstanding: number;
  shareOwnership: Record<string, number>;

  // Reputation & Risk
  outrage: number;
  scrutiny: number;
  breakdowns: number;
  contaminationRisk: number;
  odorComplaints: number;
  tokenLiability: number;
  carbonFootprint: number;
  stockVolume: number;
  demand: number;

  // Derived (computed each turn)
  equity?: number;
  revenue?: number;
  volume?: number;
  receivables?: number;
  financeCost?: number;
  taxCost?: number;
  depreciation?: number;
  stockValue?: number;
  marketShare?: number;
  competitiveness?: number;
  legalExposure?: number;
  legalExposureRatio?: number;
}

/** A single decision a player wants to deploy this turn, as submitted from the client. */
export interface SubmittedDecisionEntry {
  name: string;
  targetId?: string;
}

/**
 * A deliberate lawsuit filing for this turn — the player picks a target and a specific
 * ground drawn from one of the target's actually-deployed decisions (its `groundName`
 * matches one of that decision's `legalRisks[].name`). Lawsuits are never generated
 * automatically just because a decision carries legal risk — a player must choose to
 * sue over it (up to `gameSettings.maxLawsuitsPerPlayerPerTurn` per turn).
 */
export interface SubmittedLawsuitEntry {
  targetId: string;
  decisionName: string;
  groundName: string;
}

/** Payload for the `game:submitDecisions` socket event — one player's choices for the turn. */
export interface SubmittedDecisions {
  strategic: SubmittedDecisionEntry[];
  operational: SubmittedDecisionEntry[];
  lawsuits: SubmittedLawsuitEntry[];
}

/** An active decision instance on a player */
export interface ActiveDecisionInstance {
  id: string;
  decisionName: string;
  deployedYear: number;
  maturityYears: number;
  elapsedYears: number;
  isMatured: boolean;
}

/** A legal case in the system */
export interface LegalCaseData {
  id: string;
  roomId: string;
  plaintiffId: string;
  defendantId: string;
  /** Name of the decision that triggered this legal risk (e.g. "New Factory"). */
  decisionName: string;
  groundName: string;
  description: string;
  baseProbability: number;
  adjustedProbability?: number;
  stakes: number;
  status: 'negotiating' | 'awaiting_trial' | 'resolved';
  offers: Array<{ by: 'me' | 'them'; amount: number }>;
  myOffer?: number;
  /** 'won'/'lost' = decided at trial; 'settled'/'cancelled' = resolved via bankruptcy waterfall (FORMULAS §16). */
  verdict?: 'won' | 'lost' | 'settled' | 'cancelled';
  /** Filing time — used to order bankruptcy waterfall payouts oldest-first (FORMULAS §14, §16). */
  createdAt: Date;
  resolvedAt?: Date;
}

/**
 * An offensive decision currently targeting this player (a `target.*`-bearing decision
 * someone else deployed against them), revealed progressively as the player pays to
 * "Dig Deeper" on it. Fields below a given tier stay `undefined` — the server never
 * sends attacker identity or case details below the player's own unlocked investigation
 * level, so there's no client-side reveal to inspect via devtools before paying for it.
 */
export interface IncomingAttackInfo {
  /** Stable id of the attacking decision instance — pass back to `game:digDeeper`. */
  attackId: string;
  /** 0 = not yet investigated, 1-3 = how many "Dig Deeper" clicks have been spent on this attack. */
  investigationLevel: number;
  /** Revealed at investigationLevel >= 1 — who is behind it. */
  attackerId?: string;
  attackerName?: string;
  /** Revealed at investigationLevel >= 2 — what they're doing to you. */
  decisionName?: string;
  decisionDescription?: string;
  /** Human-readable summary of the current per-turn effect, e.g. "+20 Outrage, -20% Capacity Utilization". */
  effectSummary?: string;
  /** Revealed at investigationLevel >= 3 — the recommended lawsuit ground and an estimated win probability. */
  suggestedGroundName?: string;
  suggestedGroundDescription?: string;
  /** 0-1 estimate using the attacker's current scrutiny/legal exposure — the real probability is still recomputed at trial time. */
  successProbability?: number;
}

/** One rival's active decision, narrated for their "annual report" — see `game:getAnnualReport`. */
export interface AnnualReportEntry {
  decisionName: string;
  /** AI-generated (or, if the LLM is unavailable, static fallback) flavor text — never the real numbers. */
  text: string;
  /** Calendar year this filing covers (`deployedYear + 1`), matching the client's existing display. */
  year: number;
}

// ============================================================
// Turn Result — what gets broadcast after each turn resolves
// ============================================================

export interface PlayerTurnResult {
  playerId: string;
  playerName: string;
  variables: PlayerVariables;
  derived: {
    equity: number;
    revenue: number;
    volume: number;
    receivables: number;
    financeCost: number;
    taxCost: number;
    depreciation: number;
    stockValue: number;
    marketShare: number;
    competitiveness: number;
  };
  activeDecisions: ActiveDecisionInstance[];
  legalCases: LegalCaseData[];
  riskGauge: number;
  /** Offensive decisions currently targeting this player — see `IncomingAttackInfo`. */
  incomingAttacks: IncomingAttackInfo[];
}

export interface TurnResolutionResult {
  round: number;
  players: PlayerTurnResult[];
  gameOver: boolean;
  winnerId?: string;
}
