// ============================================================
// Game Engine Types — shared between server and the /admin portal
// ============================================================

/** A single decision definition — DB-backed (`Decision` table), seeded from
 * server/src/data/game_engine.json, editable live via /admin. */
export interface DecisionDefinition {
  decision: string;
  level: 'Strategic' | 'Operational' | 'Financial';
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
  /** Required whenever `impacts.cash` is set — buckets this decision's direct cash impact into the cash flow statement. */
  cashFlowCategory?: 'operating' | 'investing' | 'financing';
  /** Marks this decision as a real share-ownership trade (Buy Shares / Sell Shares) rather
   * than a generic schedule-driven decision — read generically by the engine (never a
   * hardcoded decision-name check, see CLAUDE.md) to route it through the dedicated
   * share-transaction step instead of the normal `impacts` application. A decision with
   * this set should have empty `impacts` — its effect is computed dynamically from the
   * player-chosen `amount`/target, not a fixed schedule. */
  shareTransactionType?: 'buy' | 'sell';
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
  /** Buy Shares / Sell Shares — a decision-type category of its own (`level: 'Financial'`),
   * capped independently of the strategic/operational per-turn budgets. */
  maxFinancialDecisionsPerTurn: number;
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
   * 'awaiting_trial' (and resolves the turn after that). The base turn math has no
   * concept of a negotiation phase — this closes a real gap where, absent the (separately tracked,
   * not-yet-built) offer/settlement UI, a case between two solvent players had no path
   * out of 'negotiating' at all and would sit unresolved forever. */
  negotiationPeriodTurns: number;
  /** Statute of limitations, in years elapsed since a decision was deployed — once a
   * target's cited decision instance has been active this long (`elapsedYears >=` this
   * value), suing over it is time-barred: the case still gets created (same "real but
   * hopeless" shape as guessing a decision the target never deployed at all), but its
   * probability of winning is forced to 0, both at actual filing (`LegalEngine.fileLawsuit`)
   * and in the "suggested ground" estimate `pickBestGround` surfaces via Dig Deeper/SUE
   * NOW — so the suggestion a player sees never quotes odds a real filing wouldn't honor.
   * Independent of a decision's own `isMatured` (maturity is about when an impact
   * schedule locks in, not legal liability) — a decision can be long
   * matured and still well within the limitations window, or vice versa. */
  statuteOfLimitationsYears: number;
  /** Turns a permanent-effect decision's own matured instance blocks that same decision
   * from being redeployed — deliberately a SEPARATE, shorter clock from
   * `statuteOfLimitationsYears`, not a reuse of it. `DecisionEngine.canDeploy` used to gate
   * redeployment on `statuteOfLimitationsYears` itself (10 by default), which — given
   * typical games run ~12-15 rounds — made a permanent-effect decision (New Factory,
   * Vertical Integration, Raw Material Monopoly, Venture Capital Shadow Money, Patent
   * Portfolio, Bot Attack, etc.) effectively a one-time-per-game pick unless an opponent
   * happened to sue it into `voidedByLawsuit`, even though the game's own stacking math
   * (`installedCapacity = base * (1 + 0.4 + 0.4)` for two matured New Factorys) assumes
   * redeploying the same permanent-effect decision more than once in a game is a normal,
   * intended thing to do. `statuteOfLimitationsYears` keeps meaning exactly what it always
   * has — how long a decision instance stays legally suable, and how long its `target.*`
   * effect (an ongoing attack against a rival) keeps re-applying — this field governs only
   * "how soon can I build another one," independent of legal exposure. See CLAUDE.md. */
  permanentEffectCooldownYears: number;
  /** Lawsuit-odds coloring thresholds for `GamePhase.tsx`'s `semaphoreLevel` (green below
   * this, yellow below `semaphoreYellowMax`, red otherwise) — live here (not
   * `AdminVariables.legalProcess`) specifically because `GameSettings` is the one config
   * bag actually sent to the client via `game:deck`; `AdminVariables` never is. Previously
   * sat unused in `AdminVariables.legalProcess` while the client hardcoded its own copy of
   * these same two numbers — moved here so an admin edit actually reaches the client. */
  semaphoreGreenMax: number;
  semaphoreYellowMax: number;
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
  scrutinyLegalRiskMultiplier: number;
  legalExposureRatioCap: number;
}

export interface RiskGaugeConfig {
  riskWeightLegalExposure_w1: number;
  riskWeightScrutiny_w2: number;
  riskWeightOutrage_w3: number;
  /** Weight for majority-ownership takeover risk (see calcEngine.ts's
   * `calculateOwnershipRisk`) — a deliberate addition beyond the Risk Gauge's original
   * 3-term design, since majority-ownership takeover is a fully independent
   * way to lose the game the original gauge never reflected. */
  riskWeightOwnership_w4: number;
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
  /** Dollar amount for a `shareTransactionType` decision (Buy Shares' investment, Sell
   * Shares' sale) — chosen client-side, meaningless for any other decision. */
  amount?: number;
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
  /** `level: 'Financial'` decisions (Buy Shares / Sell Shares) — a bucket of its own,
   * capped by `gameSettings.maxFinancialDecisionsPerTurn`, independent of strategic/operational. */
  financial: SubmittedDecisionEntry[];
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
  /** True once a lawsuit resolved against this specific instance (trial verdict 'won' for
   * the plaintiff, or a settlement where the defendant paid out) — its forthcoming effects
   * are cancelled (whatever was already applied in earlier turns stays), it's forced to
   * `isMatured: true` immediately, and it no longer counts as a "successful" completion for
   * the permanent-effect redeploy lock below. See CLAUDE.md's lawsuit-voids-decision section. */
  voidedByLawsuit: boolean;
  /** For a Buy Shares instance only — the fraction of the target company actually
   * acquired in this single transaction, stamped once at execution time. Gates
   * `legalRiskConditions.minPercentAcquiredInSingleTransaction` (a purchase too small to
   * cross the configured threshold carries no real legal risk — see CLAUDE.md). */
  acquisitionFraction?: number;
  /** The player this decision's `target.*` impacts route to, if any — set at deployment
   * for a decision like Bot Attack that was aimed at a chosen opponent, `undefined` for
   * one with no target concept at all. Lets the "Active Decisions" box show/sort by who a
   * player's own decision targeted, the same way a still-queued `SubmittedDecisionEntry`
   * already can via its own `targetId`. */
  targetId?: string;
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
  /** The specific defendant decision instance this case is about, if the target actually
   * had a genuine (non-time-barred) matching instance deployed at filing time — undefined
   * for a wrong guess or a time-barred ground, same cases where `baseProbability` is forced
   * to 0. Lets a verdict/settlement void exactly the sued instance rather than guessing by
   * name, which would be ambiguous once a decision can be redeployed after being voided. */
  defendantDecisionInstanceId?: string;
  baseProbability: number;
  adjustedProbability?: number;
  /** True if, at the moment of filing, the plaintiff had fully "Dig Deeper"-investigated
   * (investigation level 3) the underlying attack and sued over its exact suggested
   * ground — see CLAUDE.md's case-probability-chip section. Stamped once at filing time
   * and never recomputed afterward, so it can't regress even if the underlying attacking
   * decision later matures out or its deployer goes bankrupt. Gates whether the plaintiff
   * (not just the defendant) sees `baseProbability`/`adjustedProbability` client-side. */
  plaintiffFullyInvestigated: boolean;
  /** True once the defendant has paid to "Dig Deeper" and reveal the probability of
   * success on this specific case — a single one-shot reveal (unlike the 3-tier incoming-
   * attack investigation ladder), gated behind `game:digDeeperCase`. Starts `false` for
   * every newly-filed case: the defendant no longer sees `baseProbability`/
   * `adjustedProbability` for free, they must dig deeper on the case itself first. */
  defendantInvestigated: boolean;
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
  /** 'won'/'lost' = decided at trial; 'settled'/'cancelled' = resolved via bankruptcy/merger waterfall. */
  verdict?: 'won' | 'lost' | 'settled' | 'cancelled';
  /** Filing time — used to order bankruptcy/merger waterfall payouts oldest-first. */
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
  /**
   * False for a genuine `target.*`-bearing attack aimed specifically at the receiving
   * player (Bot Attack, Social Astroturf, etc.) — only that one player ever sees it. True
   * for a decision with no target concept at all but that still carries `legalRisks`
   * (New Factory's nuisance suit, Water Pumping's environmental suit, Night Dumping,
   * etc.) — every OTHER active player sees the same entry, since there's no single
   * "victim" to route it to. Everything else about this type (investigation tiers, Dig
   * Deeper, suing) works identically either way; this only changes what headline copy
   * the client shows and which impacts `effectSummary` describes (the decision's own
   * effects for an indirect one, since there's no `target.*` effect to summarize).
   */
  isIndirect: boolean;
  /** 0 = not yet investigated, 1-3 = how many "Dig Deeper" clicks have been spent on this attack. */
  investigationLevel: number;
  /** Revealed at investigationLevel >= 1 — who is behind it. */
  attackerId?: string;
  attackerName?: string;
  /** AI-narrated (or, if the LLM is unavailable, static `competitorsView` fallback)
   * "annual report" flavor text for the attacking decision — set only while
   * investigationLevel === 1 (attacker known, but not yet the decision itself). Reuses
   * the exact same generation `game:getAnnualReport` uses for a rival's Full Filing —
   * deliberately vague, non-mechanical corporate PR-speak, so showing it a tier early
   * doesn't leak anything level 2's real `decisionName`/`decisionDescription`/
   * `effectSummary` don't already reveal more precisely. Omitted (not just empty) when
   * the attacking decision has no `competitorsView` entries to draw a fallback from. */
  annualReportBlurb?: string;
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
  /** Estimated dollar amount at stake if this ground is sued over and won — priced the
   * same way a real filed case's `LegalCaseData.stakes` is (see `DecisionEngine.
   * pickBestGround`/`LegalEngine.fileLawsuit`), so it matches what the real case will
   * actually carry once filed. Not an expected value — not discounted by `successProbability`. */
  suggestedGroundStakes?: number;
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

/** One other player buying a stake in THIS player's own company this turn, via Buy
 * Shares — see `PlayerTurnResult.sharesBoughtThisTurn`. Never includes a self-buyback
 * (buying back your own previously-diluted stake isn't news to yourself). */
export interface SharesBoughtEvent {
  buyerId: string;
  buyerName: string;
  /** The fraction of the WHOLE company that changed hands in this one purchase
   * (`acquisitionFraction` — same value `DeployedDecision.acquisitionFraction` stamps on
   * the buyer's own instance), not the buyer's resulting total stake. */
  fractionBought: number;
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
  /** Every OTHER player who bought a stake in this player's own company this turn — see `SharesBoughtEvent`. */
  sharesBoughtThisTurn: SharesBoughtEvent[];
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

// ============================================================
// Game Timeline — the Civilization-style game-over replay / live spectator view. Unlike
// `KpiHistoryResponse` (per-target, fetched per open graph), this returns the WHOLE
// room's history at once: every player (active or eliminated), every decision ever
// deployed, and every lawsuit ever filed/resolved. Used both as the finished-game replay
// (Game Over screen, everyone) and a live-updating spectator view (an eliminated player
// who chose to keep watching) — see CLAUDE.md's game-timeline section.
// ============================================================

/** One player's identity/elimination info for the timeline — not their KPI data itself, see `kpiHistory` below. */
export interface TimelinePlayerInfo {
  playerId: string;
  playerName: string;
  bankrupt: boolean;
  /** Round this player was eliminated in (bankruptcy, merger/takeover, or forfeit) — undefined while still active. */
  eliminatedRound?: number;
}

/** One decision deployment, for the timeline's "happenings" log — derived directly from a
 * player's persisted `Company.engineState.activeDecisions` (append-only, never pruned, so
 * this is fully recoverable at any point without a separate history table — see CLAUDE.md). */
export interface TimelineDecisionEvent {
  instanceId: string;
  playerId: string;
  decisionName: string;
  deployedYear: number;
  targetId?: string;
  voidedByLawsuit: boolean;
}

/** One lawsuit's full lifecycle, for the timeline's "happenings" log — sourced from the
 * new durable `LegalCaseHistory` table (the live `LegalCaseData` inside
 * `engineState.legalCases` only survives one extra turn past its own resolution, so it
 * can't answer "every lawsuit filed/resolved across the whole game" on its own). */
export interface TimelineLawsuitEvent {
  id: string;
  plaintiffId: string;
  plaintiffName: string;
  defendantId: string;
  defendantName: string;
  decisionName: string;
  groundName: string;
  description: string;
  stakes: number;
  filedRound: number;
  resolvedRound?: number;
  verdict?: 'won' | 'lost' | 'settled' | 'cancelled';
}

/** Response for `game:gameTimelineResult` — sent only to the requesting socket, the
 * whole room's history at once. Unlike every other on-demand request, this is valid in
 * both GAME_PHASE (live spectating) and AFTERMATH (finished replay). */
export interface GameTimelineResponse {
  roomId: string;
  currentRound: number;
  gameOver: boolean;
  /** The actual win condition — always source a "winner" display from this, never from
   * "whoever ranks first on whichever KPI metric the chart currently has selected,"
   * which can legitimately disagree (e.g. highest Equity vs. the real winner). */
  winnerId?: string;
  players: TimelinePlayerInfo[];
  kpiHistory: Record<string, KpiSnapshotPoint[]>;
  decisions: TimelineDecisionEvent[];
  lawsuits: TimelineLawsuitEvent[];
}
