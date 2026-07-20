import { z } from 'zod';

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
 * actually-deployed decisions (never auto-generated just from legal risk, FORMULAS §6). */
const lawsuitEntrySchema = z.object({
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
