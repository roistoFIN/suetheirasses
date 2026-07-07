import { z } from 'zod';
import { StrategyActionType } from '@suetheirasses/shared';

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
  /** Target room ID/code. Optional — omitted to create a new room. */
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
 * Zod schema for a single strategic action within a strategy submission.
 *
 * Each action specifies a business decision (invest, expand, layoff, etc.)
 * with optional parameters like `target`, `amount`, and `details` depending on the action type.
 */
export const gameActionSchema = z.object({
  /** The type of strategic action to take. Required. */
  type: z.nativeEnum(StrategyActionType),
  /** Optional target identifier (e.g., asset ID, company name). */
  target: z.string().optional(),
  /** Optional monetary amount associated with the action. Must be ≥ 0 when provided. */
  amount: z.number().min(0).optional(),
  /** Optional free-text details or notes about the action. */
  details: z.string().optional(),
});

/**
 * Zod schema for the `strategy:submit` Socket.IO event payload.
 *
 * Players submit between 1 and 5 strategic actions per round.
 */
export const strategySubmitSchema = z.object({
  /** Array of strategic actions. Minimum 1, maximum 5. */
  actions: z.array(gameActionSchema).min(1).max(5),
});

/** Inferred TypeScript type for validated strategy submission payloads. */
export type StrategySubmitPayload = z.infer<typeof strategySubmitSchema>;

/**
 * Validates and parses raw data against the strategy submit schema.
 *
 * @param data - Raw payload from the `strategy:submit` Socket.IO event.
 * @returns Validated `StrategySubmitPayload` object.
 * @throws ZodValidationError if the payload fails any constraint.
 */
export function validateStrategySubmit(data: unknown): StrategySubmitPayload {
  return strategySubmitSchema.parse(data);
}

/**
 * Zod schema for the `lawsuit:file` Socket.IO event payload.
 *
 * Used during Phase 4 (Legal Suits) when a player files a lawsuit against an opponent.
 */
export const lawsuitFileSchema = z.object({
  /** ID of the defendant player. Must be non-empty. */
  defendantId: z.string().min(1),
  /** Claim amount in dollars. Range: $1,000 – $1,000,000. */
  claimAmount: z.number().min(1000).max(1000000),
  /** Legal grounds for the lawsuit. Minimum 10 characters, maximum 500. */
  grounds: z.string().min(10).max(500),
});

/** Inferred TypeScript type for validated lawsuit file payloads. */
export type LawsuitFilePayload = z.infer<typeof lawsuitFileSchema>;

/**
 * Validates and parses raw data against the lawsuit file schema.
 *
 * @param data - Raw payload from the `lawsuit:file` Socket.IO event.
 * @returns Validated `LawsuitFilePayload` object.
 * @throws ZodValidationError if the payload fails any constraint.
 */
export function validateLawsuitFile(data: unknown): LawsuitFilePayload {
  return lawsuitFileSchema.parse(data);
}

/**
 * Zod schema for the `lawsuit:respond` Socket.IO event payload.
 *
 * Used during Phase 5 (Resolution) when a defendant responds to an incoming lawsuit.
 */
export const lawsuitRespondSchema = z.object({
  /** ID of the lawsuit being responded to. Must be non-empty. */
  lawsuitId: z.string().min(1),
  /** Defense statement. Minimum 10 characters, maximum 1000. */
  defense: z.string().min(10).max(1000),
  /** Optional monetary offer to settle the lawsuit out of court. Must be ≥ 0. */
  settlementOffer: z.number().min(0).optional(),
});

/** Inferred TypeScript type for validated lawsuit response payloads. */
export type LawsuitRespondPayload = z.infer<typeof lawsuitRespondSchema>;

/**
 * Validates and parses raw data against the lawsuit respond schema.
 *
 * @param data - Raw payload from the `lawsuit:respond` Socket.IO event.
 * @returns Validated `LawsuitRespondPayload` object.
 * @throws ZodValidationError if the payload fails any constraint.
 */
export function validateLawsuitRespond(data: unknown): LawsuitRespondPayload {
  return lawsuitRespondSchema.parse(data);
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
