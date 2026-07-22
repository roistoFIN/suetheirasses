import { z } from 'zod';
import { parseFormula, collectIdentifiers, FormulaParseError } from '../engine/formulaEngine.js';

/**
 * Zod schema for the `room:join` Socket.IO event payload.
 *
 * Supports three modes:
 * - **Create room**: `{ playerName }` — server creates a new room, player becomes host
 * - **Join by ID**: `{ playerName, roomName }` — joins existing room by its unique code/UUID
 * - **Quick Play**: `{ playerName, searchForRoom: true }` — auto-joins least-populated room
 *
 * The `roomName` field accepts both short codes (e.g. CUID-style ~25 chars) and full
 * UUID v4 strings (36 chars) used in invite links (`?room=<uuid>`).
 */
export const roomJoinSchema = z.object({
  /** Player's display name (1–30 characters). Required. */
  playerName: z.string().min(1).max(30),
  /** Target room ID/code. Optional — omitted to create a new room. Max 40 characters (covers UUID v4's 36). */
  roomName: z.string().max(40).optional(),
  /** When true, server finds any available room instead of joining a specific one. */
  searchForRoom: z.boolean().optional(),
});

/** Inferred TypeScript type for validated room join payloads. */
export type RoomJoinPayload = z.infer<typeof roomJoinSchema>;

/**
 * Validates and parses raw data against the room join schema.
 *
 * @param data - Raw payload from the `room:join` Socket.IO event.
 * @returns Validated `RoomJoinPayload` object.
 * @throws ZodValidationError if the payload fails any constraint.
 */
export function validateRoomJoin(data: unknown): RoomJoinPayload {
  return roomJoinSchema.parse(data);
}

/**
 * Zod schema for the `room:rejoin` Socket.IO event payload — resume an existing
 * player session (within the server's disconnect grace period) on a new socket.
 * Both fields identify an existing DB row; there's no separate auth token in this
 * app (no passwords anywhere), so the id pair itself is the bearer credential,
 * same trust model as every other player id already used throughout the app.
 */
export const roomRejoinSchema = z.object({
  roomId: z.string().min(1).max(50),
  playerId: z.string().min(1).max(50),
});

/** Inferred TypeScript type for validated room rejoin payloads. */
export type RoomRejoinPayload = z.infer<typeof roomRejoinSchema>;

/**
 * Validates and parses raw data against the room rejoin schema.
 *
 * @param data - Raw payload from the `room:rejoin` Socket.IO event.
 * @returns Validated `RoomRejoinPayload` object.
 * @throws ZodValidationError if the payload fails any constraint.
 */
export function validateRoomRejoin(data: unknown): RoomRejoinPayload {
  return roomRejoinSchema.parse(data);
}

/** Zod schema for the `room:setInviteOnly` Socket.IO event payload. */
export const roomSetInviteOnlySchema = z.object({
  inviteOnly: z.boolean(),
});

/** Inferred TypeScript type for validated `room:setInviteOnly` payloads. */
export type RoomSetInviteOnlyPayload = z.infer<typeof roomSetInviteOnlySchema>;

/**
 * Validates and parses raw data against the `room:setInviteOnly` schema.
 *
 * @param data - Raw payload from the `room:setInviteOnly` Socket.IO event.
 * @returns Validated `RoomSetInviteOnlyPayload` object.
 * @throws ZodValidationError if the payload fails any constraint.
 */
export function validateRoomSetInviteOnly(data: unknown): RoomSetInviteOnlyPayload {
  return roomSetInviteOnlySchema.parse(data);
}

/**
 * Zod schema for the `chat:message` Socket.IO event payload.
 *
 * Used for in-room chat communication between players during the waiting phase.
 */
export const chatMessageSchema = z.object({
  /** Chat message text. Minimum 1 character, maximum 500. */
  message: z.string().min(1).max(500),
});

/** Inferred TypeScript type for validated chat message payloads. */
export type ChatMessagePayload = z.infer<typeof chatMessageSchema>;

/**
 * Validates and parses raw data against the chat message schema.
 *
 * @param data - Raw payload from the `chat:message` Socket.IO event.
 * @returns Validated `ChatMessagePayload` object.
 * @throws ZodValidationError if the payload fails any constraint.
 */
export function validateChatMessage(data: unknown): ChatMessagePayload {
  return chatMessageSchema.parse(data);
}

/** Zod schema for the `game:ready` Socket.IO event payload — toggles ready status for the in-flight turn. */
export const gameReadySchema = z.object({
  ready: z.boolean(),
});

/** Inferred TypeScript type for validated `game:ready` payloads. */
export type GameReadyPayload = z.infer<typeof gameReadySchema>;

/**
 * Validates and parses raw data against the `game:ready` schema.
 *
 * @param data - Raw payload from the `game:ready` Socket.IO event.
 * @returns Validated `GameReadyPayload` object.
 * @throws ZodValidationError if the payload fails any constraint.
 */
export function validateGameReady(data: unknown): GameReadyPayload {
  return gameReadySchema.parse(data);
}

/**
 * Zod schema for the `game:submitDecisions` Socket.IO event payload.
 *
 * This only enforces structural sanity (types, lengths) — the actual game-balance
 * limits (max strategic/operational decisions, max lawsuits per turn) come from
 * game_config.json and are enforced by DecisionEngine.canDeploy / GameLoop's lawsuit
 * filing step, not hardcoded here.
 */
const decisionEntrySchema = z.object({
  name: z.string().min(1).max(100),
  targetId: z.string().min(1).max(50).optional(),
});

/** A deliberate lawsuit filing — sue a target over a ground drawn from one of their
 * actually-deployed decisions (never auto-generated just from legal risk, FORMULAS §6).
 * Exported and reused as-is for `game:fileLawsuit`'s payload — same shape as one entry
 * of `submitDecisionsSchema`'s `lawsuits` array. */
export const lawsuitEntrySchema = z.object({
  targetId: z.string().min(1).max(50),
  decisionName: z.string().min(1).max(100),
  groundName: z.string().min(1).max(200),
});

export const submitDecisionsSchema = z.object({
  strategic: z.array(decisionEntrySchema).max(20),
  operational: z.array(decisionEntrySchema).max(20),
  lawsuits: z.array(lawsuitEntrySchema).max(10),
});

/** Inferred TypeScript type for validated decision submission payloads. */
export type SubmitDecisionsPayload = z.infer<typeof submitDecisionsSchema>;

/**
 * Validates and parses raw data against the decision submission schema.
 *
 * @param data - Raw payload from the `game:submitDecisions` Socket.IO event.
 * @returns Validated `SubmitDecisionsPayload` object.
 * @throws ZodValidationError if the payload fails any constraint.
 */
export function validateSubmitDecisions(data: unknown): SubmitDecisionsPayload {
  return submitDecisionsSchema.parse(data);
}

/**
 * Zod schema for the `game:digDeeper` Socket.IO event payload — pay to reveal the next
 * tier of intel on one incoming attack, identified by the attacking decision instance's id.
 */
export const digDeeperSchema = z.object({
  attackId: z.string().min(1).max(100),
});

/** Inferred TypeScript type for validated dig-deeper payloads. */
export type DigDeeperPayload = z.infer<typeof digDeeperSchema>;

/**
 * Validates and parses raw data against the dig-deeper schema.
 *
 * @param data - Raw payload from the `game:digDeeper` Socket.IO event.
 * @returns Validated `DigDeeperPayload` object.
 * @throws ZodValidationError if the payload fails any constraint.
 */
export function validateDigDeeper(data: unknown): DigDeeperPayload {
  return digDeeperSchema.parse(data);
}

/** Inferred TypeScript type for a validated `game:fileLawsuit` payload. */
export type FileLawsuitPayload = z.infer<typeof lawsuitEntrySchema>;

/**
 * Validates and parses raw data against the lawsuit-entry schema.
 *
 * @param data - Raw payload from the `game:fileLawsuit` Socket.IO event.
 * @returns Validated `FileLawsuitPayload` object.
 * @throws ZodValidationError if the payload fails any constraint.
 */
export function validateFileLawsuit(data: unknown): FileLawsuitPayload {
  return lawsuitEntrySchema.parse(data);
}

/**
 * Zod schema for the `game:getAnnualReport` Socket.IO event payload — request narrated
 * flavor text for one rival's active decisions, identified by their player id.
 */
export const annualReportRequestSchema = z.object({
  rivalPlayerId: z.string().min(1).max(100),
});

/** Inferred TypeScript type for validated annual-report request payloads. */
export type AnnualReportRequestPayload = z.infer<typeof annualReportRequestSchema>;

/**
 * Validates and parses raw data against the annual-report-request schema.
 *
 * @param data - Raw payload from the `game:getAnnualReport` Socket.IO event.
 * @returns Validated `AnnualReportRequestPayload` object.
 * @throws ZodValidationError if the payload fails any constraint.
 */
export function validateAnnualReportRequest(data: unknown): AnnualReportRequestPayload {
  return annualReportRequestSchema.parse(data);
}

/**
 * Zod schema for the `game:getKpiHistory` Socket.IO event payload — `targetPlayerId` is
 * optional (omitted means "my own data"); when present it's treated as a rival lookup.
 */
export const kpiHistoryRequestSchema = z.object({
  targetPlayerId: z.string().min(1).max(100).optional(),
});

/** Inferred TypeScript type for validated KPI-history request payloads. */
export type KpiHistoryRequestPayload = z.infer<typeof kpiHistoryRequestSchema>;

/**
 * Validates and parses raw data against the KPI-history-request schema.
 *
 * @param data - Raw payload from the `game:getKpiHistory` Socket.IO event.
 * @returns Validated `KpiHistoryRequestPayload` object.
 * @throws ZodValidationError if the payload fails any constraint.
 */
export function validateKpiHistoryRequest(data: unknown): KpiHistoryRequestPayload {
  return kpiHistoryRequestSchema.parse(data);
}

/** Zod schema for the `game:makeOffer` Socket.IO event payload — propose or counter a settlement amount on a case. */
export const makeOfferSchema = z.object({
  caseId: z.string().min(1).max(100),
  amount: z.number().positive(),
});

/** Inferred TypeScript type for validated make-offer payloads. */
export type MakeOfferPayload = z.infer<typeof makeOfferSchema>;

/**
 * Validates and parses raw data against the make-offer schema.
 *
 * @param data - Raw payload from the `game:makeOffer` Socket.IO event.
 * @returns Validated `MakeOfferPayload` object.
 * @throws ZodValidationError if the payload fails any constraint.
 */
export function validateMakeOffer(data: unknown): MakeOfferPayload {
  return makeOfferSchema.parse(data);
}

/** Zod schema for the `game:acceptOffer` Socket.IO event payload — accept the other party's most recent offer on a case. */
export const acceptOfferSchema = z.object({
  caseId: z.string().min(1).max(100),
});

/** Inferred TypeScript type for validated accept-offer payloads. */
export type AcceptOfferPayload = z.infer<typeof acceptOfferSchema>;

/**
 * Validates and parses raw data against the accept-offer schema.
 *
 * @param data - Raw payload from the `game:acceptOffer` Socket.IO event.
 * @returns Validated `AcceptOfferPayload` object.
 * @throws ZodValidationError if the payload fails any constraint.
 */
export function validateAcceptOffer(data: unknown): AcceptOfferPayload {
  return acceptOfferSchema.parse(data);
}

/** Zod schema for the `game:goToCourt` Socket.IO event payload — end negotiation on a case and send it to trial. */
export const goToCourtSchema = z.object({
  caseId: z.string().min(1).max(100),
});

/** Inferred TypeScript type for validated go-to-court payloads. */
export type GoToCourtPayload = z.infer<typeof goToCourtSchema>;

/**
 * Validates and parses raw data against the go-to-court schema.
 *
 * @param data - Raw payload from the `game:goToCourt` Socket.IO event.
 * @returns Validated `GoToCourtPayload` object.
 * @throws ZodValidationError if the payload fails any constraint.
 */
export function validateGoToCourt(data: unknown): GoToCourtPayload {
  return goToCourtSchema.parse(data);
}

// ============================================================
// Admin Portal — decision library + game config (REST, not socket events).
// Structural validation for the decision shape (mirrors submitDecisionsSchema's
// philosophy — doesn't re-verify formula semantics), but strict field-by-field
// validation for game config: every field there is a fixed, known number driving a
// real formula, so a typo'd key should be rejected, not silently ignored.
// ============================================================

const impactEntrySchema = z.object({
  type: z.enum(['absolute', 'relative']),
  schedule: z.record(z.string(), z.number()),
});

const legalRiskDefinitionSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  probability: z.record(z.string(), z.number()),
  impact: impactEntrySchema.extend({ target: z.string().min(1) }),
});

/** Zod schema for one decision definition — the body of `POST`/`PUT /api/admin/decisions`. */
export const decisionDefinitionSchema = z.object({
  decision: z.string().min(1).max(100),
  level: z.enum(['Strategic', 'Operational']),
  description: z.string().min(1),
  nature: z.enum(['Traditional', 'Grey Area', 'Dirty']),
  offensiveAction: z.boolean(),
  excludes: z.array(z.string()),
  impacts: z.record(z.string(), impactEntrySchema),
  legalRisks: z.array(legalRiskDefinitionSchema).optional(),
  competitorsView: z.array(z.string()).optional(),
  variableAmount: z.boolean().optional(),
  requiresTarget: z.boolean().optional(),
  legalRiskConditions: z.record(z.string(), z.unknown()).optional(),
  cashFlowCategory: z.enum(['operating', 'investing', 'financing']).optional(),
});

/** Inferred TypeScript type for a validated decision definition. */
export type ValidatedDecisionDefinition = z.infer<typeof decisionDefinitionSchema>;

/**
 * Validates and parses raw data against the decision definition schema.
 *
 * @param data - Raw request body from `POST`/`PUT /api/admin/decisions`.
 * @returns Validated `ValidatedDecisionDefinition` object.
 * @throws ZodValidationError if the payload fails any constraint.
 */
export function validateDecisionDefinition(data: unknown): ValidatedDecisionDefinition {
  return decisionDefinitionSchema.parse(data);
}

const gameSettingsSchema = z.object({
  minPlayers: z.number(),
  maxPlayers: z.number(),
  turnDurationSeconds: z.number(),
  maxLawsuitsPerPlayerPerTurn: z.number(),
  maxStrategicDecisionsPerTurn: z.number(),
  maxOperationalDecisionsPerTurn: z.number(),
  totalMarketVolumeTonnesPerYear: z.number(),
  marketFixed: z.boolean(),
  digDeeperCost: z.number(),
  negotiationPeriodTurns: z.number(),
  lawsuitFilingCost: z.number(),
});

const playerStartingValuesSchema = z.object({
  cash: z.number(),
  assets: z.number(),
  intangibleAssets: z.number(),
  debt: z.number(),
  reserves: z.number(),
  operatingExpenses: z.number(),
  staffCost: z.number(),
  materialCostPerTon: z.number(),
  otherIncome: z.number(),
  price: z.number(),
  capacityUtilization: z.number(),
  processingLevel: z.number(),
  energyIntensity: z.number(),
  moistureContent: z.number(),
  nutrientConsistency: z.number(),
  supplySecurity: z.number(),
  logisticsCostPerTon: z.number(),
  processLoss: z.number(),
  installedCapacity: z.number(),
  totalSharesOutstanding: z.number(),
  shareOwnership: z.record(z.string(), z.number()),
  outrage: z.number(),
  scrutiny: z.number(),
  breakdowns: z.number(),
  contaminationRisk: z.number(),
  odorComplaints: z.number(),
  tokenLiability: z.number(),
  carbonFootprint: z.number(),
  stockVolume: z.number(),
  demand: z.number(),
});

const adminVariablesSchema = z.object({
  competitiveness: z.object({
    competitivenessWeight_quality_wq: z.number(),
    competitivenessWeight_supply_ws: z.number(),
    competitivenessWeight_loss_wl: z.number(),
    competitivenessWeight_demand_wd: z.number(),
    outrageDemandWeight: z.number(),
  }),
  legalProcess: z.object({
    semaphoreGreenMax: z.number(),
    semaphoreYellowMax: z.number(),
    scrutinyLegalRiskMultiplier: z.number(),
    legalExposureRatioCap: z.number(),
    buySharesLegalRiskThresholdPercent: z.number(),
  }),
  riskGauge: z.object({
    riskWeightLegalExposure_w1: z.number(),
    riskWeightScrutiny_w2: z.number(),
    riskWeightOutrage_w3: z.number(),
  }),
  ownership: z.object({
    takeoverThresholdPercent: z.number(),
  }),
  finance: z.object({
    baseFinanceCost: z.number(),
    interestRate: z.number(),
    taxRate: z.number(),
    daysSalesOutstanding_DSO: z.number(),
  }),
  depreciation: z.object({
    assetUsefulLifeYears: z.number(),
    intangibleUsefulLifeYears: z.number(),
  }),
});

/** Zod schema for the full game config — the body of `PUT /api/admin/config`. */
export const gameConfigSchema = z.object({
  gameSettings: gameSettingsSchema,
  playerStartingValues: playerStartingValuesSchema,
  adminVariables: adminVariablesSchema,
});

/** Inferred TypeScript type for a validated game config. */
export type ValidatedGameConfig = z.infer<typeof gameConfigSchema>;

/**
 * Validates and parses raw data against the game config schema.
 *
 * @param data - Raw request body from `PUT /api/admin/config`.
 * @returns Validated `ValidatedGameConfig` object.
 * @throws ZodValidationError if the payload fails any constraint.
 */
export function validateGameConfig(data: unknown): ValidatedGameConfig {
  return gameConfigSchema.parse(data);
}

// ============================================================
// Admin Portal — formulas (FORMULAS.md §2-§7, DB-backed via the `Formula` table).
// The key set is fixed (no create/delete route) — only `expression`/`description`
// are ever written, and every expression is validated against BOTH syntax (via the
// real parser, not a regex) AND a fixed per-key variable whitelist before it's
// allowed anywhere near GameLoop. A formula that parses fine but references a
// variable calcEngine.ts never provides for that call site would throw at
// evaluation time, mid-turn, for every active game — this check catches that at
// save time instead.
// ============================================================

/** Every identifier calcEngine.ts actually supplies to each formula's evaluation
 * context — must stay in sync with the `evalNamed(formulas, key, { ... })` call
 * sites in calcEngine.ts. */
export const FORMULA_VARIABLES: Record<string, string[]> = {
  effectiveDemand: ['demand', 'outrageDemandWeight', 'outrage'],
  competitiveness: ['price', 'wq', 'processingLevel', 'ws', 'supplySecurity', 'wl', 'processLoss', 'wd', 'effectiveDemand'],
  theoreticalVolume: ['marketShare', 'totalMarketVolume'],
  maxSupply: ['installedCapacity', 'capacityUtilization'],
  volume: ['theoreticalVolume', 'maxSupply'],
  revenue: ['volume', 'price', 'revenueDelta'],
  cogs: ['materialCostPerTon', 'logisticsCostPerTon', 'volume'],
  grossProfit: ['revenue', 'cogs'],
  ebitda: ['grossProfit', 'operatingExpenses', 'staffCost', 'otherIncome'],
  ebit: ['ebitda', 'depreciation'],
  financeCost: ['baseFinanceCost', 'debt', 'interestRate', 'financeCostDelta'],
  profitBeforeTax: ['ebit', 'financeCost'],
  taxCost: ['profitBeforeTax', 'taxRate', 'taxCostDelta'],
  netProfit: ['profitBeforeTax', 'taxCost'],
  newCash: ['cash', 'netProfit', 'depreciation'],
  newReserves: ['reserves', 'netProfit'],
  receivables: ['revenue', 'DSO', 'receivablesDelta'],
  equity: ['newCash', 'receivables', 'assets', 'intangibleAssets', 'newReserves', 'debt'],
  marketEquity: ['equity', 'legalExposure'],
  stockValue: ['marketEquity', 'totalSharesOutstanding'],
  adjustedProbability: ['baseProbability', 'scrutinyLegalRiskMultiplier', 'defendantScrutiny', 'defendantLegalExposureRatio'],
  legalExposureRatio: ['legalExposureRatioCap', 'legalExposure', 'cash'],
  riskGauge: ['w1', 'w2', 'w3', 'legalExposureRatio', 'legalExposureRatioCap', 'scrutiny', 'absOutrage'],
};

/** Zod schema for the body of `PUT /api/admin/formulas/:key`. */
export const formulaUpdateSchema = z.object({
  expression: z.string().min(1).max(500),
  description: z.string().min(1).max(1000),
});

export type FormulaUpdatePayload = z.infer<typeof formulaUpdateSchema>;

/**
 * Validates a formula update: structural shape (Zod), expression syntax (the real
 * parser — throws a clear, position-annotated error on invalid syntax), and that
 * every variable the expression references is on that formula key's whitelist —
 * an unrecognized key means the formula would fail at evaluation time instead of
 * save time, so it's rejected here first.
 *
 * @param key - The formula key from the route param (`:key`), used to look up its
 *   variable whitelist. Must be a known key (checked by the caller against the
 *   loaded formula set — this function only validates shape/syntax/variables).
 * @throws ZodValidationError on shape violations, FormulaParseError on invalid
 *   syntax, or a plain Error naming the offending variable if it's not whitelisted.
 */
export function validateFormulaUpdate(key: string, data: unknown): FormulaUpdatePayload {
  const parsed = formulaUpdateSchema.parse(data);

  const allowedVariables = FORMULA_VARIABLES[key];
  if (!allowedVariables) {
    throw new FormulaParseError(`Unknown formula key "${key}"`);
  }

  const ast = parseFormula(parsed.expression);
  const usedVariables = collectIdentifiers(ast);
  const allowedSet = new Set(allowedVariables);
  for (const name of usedVariables) {
    if (!allowedSet.has(name)) {
      throw new FormulaParseError(
        `Unknown variable "${name}" — "${key}" only accepts: ${allowedVariables.join(', ')}`,
      );
    }
  }

  return parsed;
}
