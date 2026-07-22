// ============================================================
// Game Engine Types — shared between server and the /admin portal
// ============================================================

/** A single decision definition — DB-backed (`Decision` table), seeded from
 * server/src/data/game_engine.json, editable live via /admin. */
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

/** Admin-configurable constants — DB-backed (`GameConfigRow` table), seeded from
 * server/src/data/game_config.json, editable live via /admin. */
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
  /** Flat cost of filing one lawsuit (the SUE THEIR ASSES flow) — deducted instantly the
   * moment a player files, outside turn resolution, same "instant" pattern as
   * `digDeeperCost`. Not refunded if the case is later rejected at turn resolution (e.g.
   * the target no longer has the cited decision deployed) — filing is a real, deliberate
   * action the instant it's paid for. */
  lawsuitFilingCost: number;
  /** Turns a case can sit at status 'negotiating' before it's automatically forced to
   * 'awaiting_trial' (and resolves the turn after that). FORMULAS.md doesn't model a
   * negotiation phase — this closes a real gap where, absent the (separately tracked,
   * not-yet-built) offer/settlement UI, a case between two solvent players had no path
   * out of 'negotiating' at all and would sit unresolved forever. */
  negotiationPeriodTurns: number;
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
  /** True if, at the moment of filing, the plaintiff had fully "Dig Deeper"-investigated
   * (investigation level 3) the underlying attack and sued over its exact suggested
   * ground — see CLAUDE.md's case-probability-chip section. Stamped once at filing time
   * and never recomputed afterward, so it can't regress even if the underlying attacking
   * decision later matures out or its deployer goes bankrupt. Gates whether the plaintiff
   * (not just the defendant) sees `baseProbability`/`adjustedProbability` client-side. */
  plaintiffFullyInvestigated: boolean;
  stakes: number;
  status: 'negotiating' | 'awaiting_trial' | 'resolved';
  /** Settlement offer history — a single neutral list, identical for both parties (this
   * same `LegalCaseData` object is persisted into both the plaintiff's and defendant's
   * own `engineState.legalCases`, see CLAUDE.md). `by` names the role that made the
   * offer, not a viewer-relative "me"/"them" — each client derives "You"/"Them" locally
   * by comparing `by` against its own role in the case. The defendant always moves
   * first (`offers.length === 0`); after that, whichever role did *not* make the most
   * recent offer is the one allowed to respond (counter, accept, or go to court). */
  offers: Array<{ by: 'plaintiff' | 'defendant'; amount: number }>;
  /** How many turns this case has spent at status 'negotiating' — see `GameSettings.negotiationPeriodTurns`. */
  turnsNegotiating: number;
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

/** Named so `KpiSnapshotPoint` (history/prediction graphs) can reuse the exact same shape without duplicating it. */
export interface PlayerDerivedStats {
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
}

export interface PlayerTurnResult {
  playerId: string;
  playerName: string;
  variables: PlayerVariables;
  derived: PlayerDerivedStats;
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

// ============================================================
// KPI History & Prediction — every clickable stat (the 4 top KPI cards, Threat Level,
// and every individual line item inside their breakdown views) opens a graph combining
// this player's own actual history with a 3-turn-ahead prediction. See CLAUDE.md's "KPI
// history + prediction graphs" section for why this is one generic point shape (the
// full variables/derived/riskGauge bag) rather than a handful of named fields — any
// numeric field within it is graphable without further backend changes.
// ============================================================

/** One turn's worth of KPI data — either an actual persisted `KpiSnapshot` row (history) or one predicted future turn. */
export interface KpiSnapshotPoint {
  round: number;
  variables: PlayerVariables;
  derived: PlayerDerivedStats;
  riskGauge: number;
}

/** Request payload for `game:getKpiHistory` — `targetPlayerId` omitted (or equal to the
 * requester's own id) means "my own data" (history + 3-turn prediction); any other id in
 * the same room is treated as a rival lookup (history only, no prediction — see
 * `GameEngine.getKpiHistory`). */
export interface GetKpiHistoryPayload {
  targetPlayerId?: string;
}

/** Response for `game:kpiHistoryResult` — sent only to the requesting socket. `playerId`
 * identifies whose data this is (self or a rival), so a client juggling more than one
 * open graph at once can tell a response apart from a stale request for a different
 * player. */
export interface KpiHistoryResponse {
  playerId: string;
  history: KpiSnapshotPoint[];
  /** Up to 3 points, fewer if `bankruptAtRound` cuts the simulation short. Always empty for a rival lookup — predicting a rival's future from their own decisions isn't offered, only real history. */
  predicted: KpiSnapshotPoint[];
  /** Set if the prediction simulation shows this player going bankrupt within the predicted window — `predicted` then has fewer than 3 points, stopping at the last turn that still had a solvent outcome. Never set for a rival lookup (no prediction is run). */
  bankruptAtRound?: number;
}
