/**
 * Writer for the `EventLog` table — the admin portal's Analytics tab (raw event feed,
 * decision-balance/lawsuit dashboards, error feed, performance charts) reads exclusively
 * from this table, never from GameLoop/GameEngine's in-memory state directly. Only ever
 * called from `GameEngine` (or a route handler with its own `PrismaClient`), never from
 * the pure `GameLoop` — same I/O boundary `persistKpiSnapshots`/`persistLegalCaseHistory`
 * already respect.
 *
 * Deliberately best-effort, same "must degrade invisibly" convention `llmService.ts`
 * already follows for its own external calls: a logging write must never be load-bearing
 * for actual gameplay. `logEvent`/`logEvents` catch and console.error internally rather
 * than propagating — a DB hiccup while writing telemetry must never abort a turn
 * resolution or bubble up as a socket error to a player who did nothing wrong.
 */

import type { Prisma, PrismaClient } from '@prisma/client';

/**
 * Fixed vocabulary of loggable events — not enforced at the DB level (`EventLog.eventType`
 * is a plain string column, same pragmatic style as `LegalCaseData.verdict`'s string
 * union), but every writer in this codebase should use one of these rather than an
 * ad-hoc string, so the admin feed's event-type filter dropdown stays complete. Extend
 * this list, not a one-off string, if you add a new loggable event.
 */
export const EVENT_TYPES = [
  // One per resolveTurn call — aggregate counts + timing, not per-entity detail.
  'turn.resolved',
  // One per submitted decision that actually deployed / was rejected by canDeploy.
  'decision.deployed',
  'decision.rejected',
  // One per elimination, any of the three reasons (bankruptcy/merger/forfeit).
  'player.eliminated',
  'player.disconnected',
  'player.reconnected',
  'player.kicked',
  // A server-injected AI opponent joined a lone player's room — see
  // GameEngine.addBotPlayer.
  'player.bot_joined',
  'room.stale_cleanup',
  // One per finished game — winner + basic shape, for cross-game analytics.
  'game.completed',
  // One per local-LLM call (annual report blurb, AI decision generation).
  'llm.call',
  // Surfaced from an existing swallowed catch block — see CLAUDE.md's per-player
  // persistence isolation sections. severity is always 'warning' or 'error' for these.
  'error.persistence',
  // One per makeOffer/acceptOffer/goToCourt/digDeeperOnCase call, success or rejection —
  // forensic trail for the negotiation-turn-order race class of bug (see CLAUDE.md's
  // negotiation-actions-vs-turn-resolution section). Added specifically because a
  // reported "wrong party got to move" bug couldn't be reproduced or pinned down from
  // code review alone; this exists so the NEXT occurrence leaves concrete evidence
  // (exact case state, actor, and server-computed turn-owner at the moment of the call)
  // instead of relying on a player's memory of what they clicked.
  'case.negotiation_action',
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export type EventSeverity = 'info' | 'warning' | 'error';

export interface EventLogInput {
  eventType: EventType;
  severity?: EventSeverity;
  roomId?: string;
  playerId?: string;
  payload?: Record<string, unknown>;
}

/** Log a single event. Never throws — see this module's own doc comment. */
export async function logEvent(prisma: PrismaClient, input: EventLogInput): Promise<void> {
  try {
    await prisma.eventLog.create({
      data: {
        eventType: input.eventType,
        severity: input.severity ?? 'info',
        roomId: input.roomId ?? null,
        playerId: input.playerId ?? null,
        payload: (input.payload ?? {}) as Prisma.InputJsonValue,
      },
    });
  } catch (err) {
    console.error(`[eventLogService] Failed to write "${input.eventType}" event:`, err);
  }
}

/**
 * Log several events in one round trip (e.g. every decision deployed/rejected in a
 * single turn) — `createMany`, still best-effort as a whole batch. A no-op for an empty
 * array so call sites don't need to guard "were there any" themselves.
 */
export async function logEvents(prisma: PrismaClient, inputs: EventLogInput[]): Promise<void> {
  if (inputs.length === 0) return;
  try {
    await prisma.eventLog.createMany({
      data: inputs.map((input) => ({
        eventType: input.eventType,
        severity: input.severity ?? 'info',
        roomId: input.roomId ?? null,
        playerId: input.playerId ?? null,
        payload: (input.payload ?? {}) as Prisma.InputJsonValue,
      })),
    });
  } catch (err) {
    console.error(`[eventLogService] Failed to write batch of ${inputs.length} events:`, err);
  }
}
