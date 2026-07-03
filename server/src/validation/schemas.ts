import { z } from 'zod';
import { StrategyActionType } from '@suetheirasses/shared';

// Room Join Schema
export const roomJoinSchema = z.object({
  playerName: z.string().min(1).max(30),
  roomName: z.string().max(30).optional(),
});

export type RoomJoinPayload = z.infer<typeof roomJoinSchema>;

export function validateRoomJoin(data: unknown): RoomJoinPayload {
  return roomJoinSchema.parse(data);
}

// Strategy Submit Schema
export const gameActionSchema = z.object({
  type: z.nativeEnum(StrategyActionType),
  target: z.string().optional(),
  amount: z.number().min(0).optional(),
  details: z.string().optional(),
});

export const strategySubmitSchema = z.object({
  actions: z.array(gameActionSchema).min(1).max(5),
});

export type StrategySubmitPayload = z.infer<typeof strategySubmitSchema>;

export function validateStrategySubmit(data: unknown): StrategySubmitPayload {
  return strategySubmitSchema.parse(data);
}

// Lawsuit File Schema
export const lawsuitFileSchema = z.object({
  defendantId: z.string().min(1),
  claimAmount: z.number().min(1000).max(1000000),
  grounds: z.string().min(10).max(500),
});

export type LawsuitFilePayload = z.infer<typeof lawsuitFileSchema>;

export function validateLawsuitFile(data: unknown): LawsuitFilePayload {
  return lawsuitFileSchema.parse(data);
}

// Lawsuit Respond Schema
export const lawsuitRespondSchema = z.object({
  lawsuitId: z.string().min(1),
  defense: z.string().min(10).max(1000),
  settlementOffer: z.number().min(0).optional(),
});

export type LawsuitRespondPayload = z.infer<typeof lawsuitRespondSchema>;

export function validateLawsuitRespond(data: unknown): LawsuitRespondPayload {
  return lawsuitRespondSchema.parse(data);
}

// Chat Message Schema
export const chatMessageSchema = z.object({
  message: z.string().min(1).max(500),
});

export type ChatMessagePayload = z.infer<typeof chatMessageSchema>;

export function validateChatMessage(data: unknown): ChatMessagePayload {
  return chatMessageSchema.parse(data);
}
