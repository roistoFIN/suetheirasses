/**
 * Pure decision-making for a server-injected AI bot player — no Prisma/Socket.IO, same
 * "thin orchestration in GameEngine, tested logic here" split analyticsService.ts already
 * established. `GameEngine.runBotTurn` is the caller: it reads real state (the bot's own
 * `PlayerTurnResult`, live cash), calls these functions to decide what to do, then does
 * the actual I/O (digDeeper/fileLawsuit/submitDecisions calls).
 *
 * The bot is deliberately unsophisticated by design (confirmed with the user): random
 * decision picks bounded only by a cash-reserve check, no risk-gauge awareness, no
 * "avoid a bad decision" heuristic beyond affordability — matching this codebase's own
 * precedent for a non-strategic bot actor (the randomized-simulation scripts documented
 * in CLAUDE.md).
 */

import { getScheduleValue } from '../engine/calcEngine.js';
import type { DecisionDefinition, IncomingAttackInfo } from '@suetheirasses/shared';
import type { SubmittedDecisionEntry } from '@suetheirasses/shared';

/** Flat cash buffer the bot never spends below — roughly one turn's baseline
 * opex+staff cost (see CLAUDE.md's idle-player-breakeven section). Not admin-configurable
 * (unlike `enableBotPlayers`) — an internal safety constant, not a game-balance knob. */
export const BOT_CASH_RESERVE = 20_000;

/** The bot never attempts a share-transaction decision (Buy Shares/Sell Shares) — both
 * have `variableAmount: true` and empty `impacts`, so "affordable" isn't a simple schedule
 * lookup, and Buy Shares' dilution/legal-risk-threshold mechanics deserve a deliberate
 * amount-picking strategy rather than a random guess. Out of scope for this first version. */
function isEligibleForBot(def: DecisionDefinition): boolean {
  return !def.shareTransactionType;
}

/** A decision's own first-year cash impact (0 if it has none) — the same schedule-value
 * convention `calcEngine.getScheduleValue`/the client's `getDecisionSortValue` already use
 * for "what does this cost/pay on the turn it's deployed." */
function firstYearCashImpact(def: DecisionDefinition): number {
  const cashImpact = def.impacts?.cash;
  if (!cashImpact) return 0;
  return getScheduleValue(cashImpact.schedule, 0);
}

function shuffle<T>(items: T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

/**
 * Picks 1-2 random decisions the bot can afford without breaching the reserve, targeting
 * the human whenever a decision requires a target. Deliberately not exhaustively validated
 * against `DecisionEngine.canDeploy` (maturity locks, exclusions, per-turn budget) — an
 * ineligible pick is silently dropped by `GameLoop.processNewDecisions` the same way it
 * already is for any real player's rejected submission (see CLAUDE.md), so a bot "wasting"
 * a pick on something currently blocked just means it does slightly less that turn, not a
 * crash or a bad state.
 */
export function pickBotDecisions(
  deck: DecisionDefinition[],
  cash: number,
  humanPlayerId: string,
  reserve: number = BOT_CASH_RESERVE,
): SubmittedDecisionEntry[] {
  const affordable = deck.filter((def) => {
    if (!isEligibleForBot(def)) return false;
    const cost = firstYearCashImpact(def);
    return cash + cost >= reserve;
  });
  if (affordable.length === 0) return [];

  const pickCount = Math.min(affordable.length, Math.random() < 0.5 ? 1 : 2);
  return shuffle(affordable)
    .slice(0, pickCount)
    .map((def) => ({
      name: def.decision,
      targetId: def.requiresTarget ? humanPlayerId : undefined,
    }));
}

/**
 * Up to `maxPicks` incoming attacks worth spending a Dig Deeper on this turn, prioritizing
 * whichever is already partway investigated (mirrors the "smart" randomized-simulation
 * strategy documented in CLAUDE.md — never abandon a half-paid-for investigation). An
 * attack that's already fully revealed (`suggestedGroundName` present) needs no further
 * digging — see `shouldFileLawsuit` instead.
 */
export function pickAttacksToInvestigate(attacks: IncomingAttackInfo[], maxPicks = 2): IncomingAttackInfo[] {
  return [...attacks]
    .filter((a) => a.suggestedGroundName === undefined)
    .sort((a, b) => b.investigationLevel - a.investigationLevel)
    .slice(0, maxPicks);
}

/**
 * Whether a fully-investigated incoming attack is worth suing over: a real estimated win
 * chance above 30% (the user-specified threshold) and enough cash to cover the filing fee
 * without breaching the reserve. An attack that isn't fully revealed yet (no
 * `suggestedGroundName`/`successProbability`) never qualifies — nothing to sue over yet.
 */
export function shouldFileLawsuit(
  attack: IncomingAttackInfo,
  cash: number,
  filingCost: number,
  reserve: number = BOT_CASH_RESERVE,
): boolean {
  if (attack.suggestedGroundName === undefined || attack.successProbability === undefined) return false;
  if (attack.successProbability <= 0.3) return false;
  return cash - filingCost >= reserve;
}
