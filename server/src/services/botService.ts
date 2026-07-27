/**
 * Pure decision-making for a server-injected AI bot player — no Prisma/Socket.IO, same
 * "thin orchestration in GameEngine, tested logic here" split analyticsService.ts already
 * established. `GameEngine.runBotTurn` is the caller: it reads real state (the bot's own
 * `PlayerTurnResult`, live cash), calls these functions to decide what to do, then does
 * the actual I/O (digDeeper/fileLawsuit/submitDecisions calls).
 *
 * The bot was originally deliberately unsophisticated (pure random picks, no risk
 * awareness) — upgraded after a user reported winning "using little thinking." Still
 * intentionally NOT optimal/exhaustive play (no lookahead, no `DecisionEngine.canDeploy`
 * validation, no `game_engine.json`/`game_config.json` changes — those are the actual game
 * balance, out of scope here): a heuristic scoring pass over the deck (`scoreDecision`)
 * biased toward better picks, targeting the human more often, easing off once its own
 * risk gauge is elevated, and now a genuine (if unsophisticated) hostile-takeover threat
 * via Buy Shares. Also now negotiates settlements against a real expected-value estimate
 * (`decideBotNegotiationAction`) rather than passively letting every offer sit until
 * Step 8b's timeout auto-accepted it, regardless of size. See each function's own doc
 * comment for the specific heuristic.
 */

import { getScheduleValue } from '../engine/calcEngine.js';
import type { DecisionDefinition, IncomingAttackInfo, LegalCaseData } from '@suethemchickens/shared';
import type { SubmittedDecisionEntry } from '@suethemchickens/shared';

/** Flat cash buffer the bot never spends below — roughly one turn's baseline
 * opex+staff cost (see CLAUDE.md's idle-player-breakeven section). Not admin-configurable
 * (unlike `enableBotPlayers`) — an internal safety constant, not a game-balance knob. */
export const BOT_CASH_RESERVE = 20_000;

/** `riskGauge` (0-100) at/above which the bot turns cautious: excludes `nature: 'Dirty'`
 * decisions entirely (see `pickBotDecisions`) and scores any that slip through anyway
 * (already-active ones aren't re-evaluated) more harshly. Self-preservation, not
 * optimal play — a real player might correctly judge a specific Dirty pick is still worth
 * the risk; the bot just backs off wholesale once already in the danger zone. */
export const BOT_RISK_CAUTION_THRESHOLD = 65;

/** Per-turn odds the bot even considers a Buy Shares move when it otherwise qualifies
 * (see `pickBotShareBuy`) — deliberately not every turn, so the bot doesn't telegraph a
 * takeover attempt as a metronomic drip the moment it has spare cash. */
export const BOT_BUY_SHARES_CHANCE = 0.35;

/** Spare cash (above the reserve) the bot needs before a Buy Shares move is worth
 * considering at all — below this, `fractionBought` would be too small to matter. */
export const BOT_BUY_SHARES_MIN_SPARE_CASH = 30_000;

/** Fraction of spare cash (above the reserve) the bot commits to one Buy Shares move,
 * when it decides to make one. Deliberately not "all of it" — same reserve-discipline
 * spirit as everything else here, and leaves room to keep buying in over several turns. */
export const BOT_BUY_SHARES_SPEND_FRACTION = 0.5;

/** Score bonus for a decision that targets (or otherwise bears on) the human specifically
 * — see `scoreDecision`. Applied on top of the decision's own cost-effectiveness score,
 * not a replacement for it: a bad targeting decision still loses to a great neutral one. */
const AGGRESSION_BONUS = 0.3;

/** Penalty subtracted from a `nature: 'Dirty'` decision's score once already past
 * `BOT_RISK_CAUTION_THRESHOLD` — the hard veto in `pickBotDecisions` already excludes
 * these outright at that point, but this also softly de-prioritizes them for a bot
 * approaching (not yet past) the threshold, easing off before it actually needs to. */
const DIRTY_RISK_PENALTY = 5;

/** Rough divisor bringing a dollar-denominated absolute-type impact (operatingExpenses/
 * staffCost/otherIncome — the only such fields with a real formula reference, see
 * `FIELD_DIRECTION`'s doc comment) into roughly the same order of magnitude as a
 * relative-type fraction (~-0.3 to +0.5) or a 0-1-scale absolute field
 * (processingLevel/supplySecurity/processLoss) — deliberately approximate, this is a bot
 * heuristic, not a game-balance calculation. */
const DOLLAR_SCALE_DIVISOR = 10_000;

/** Same normalization for the year-1 cash impact itself (see `scoreDecision`). */
const CASH_SCORE_DIVISOR = 10_000;

/**
 * Direction each field's OWN impact should point for `scoreDecision` to treat it as
 * "good for the deploying player": `1` if a HIGHER value helps, `-1` if a LOWER value
 * does. Deliberately only the fields that actually feed a real formula
 * (`competitiveness`/`cogs`/`ebitda` in `defaultFormulas.ts` — `price`/`capacityUtilization`/
 * `installedCapacity`/`processingLevel`/`supplySecurity`/`processLoss`/
 * `materialCostPerTon`/`logisticsCostPerTon`/`operatingExpenses`/`staffCost`/`otherIncome`/
 * `demand`, plus `scrutiny`/`outrage` for the risk gauge) — `energyIntensity`/
 * `moistureContent`/`nutrientConsistency`/`contaminationRisk`/`odorComplaints`/
 * `breakdowns`/`carbonFootprint`/`stockVolume` are pure flavor text with no formula
 * reference anywhere in this codebase, so scoring them would just be noise, not signal.
 * `price` pointing "higher is better" is itself an approximation — a higher price also
 * lowers `competitiveness`'s `1/price` term, but production is capacity-bound rather than
 * market-share-bound in the vast majority of games (see CLAUDE.md), so more revenue per
 * ton at an unchanged capacity-bound volume is the common case. Good enough for "a little
 * smarter," not claimed to be exact.
 */
const FIELD_DIRECTION: Record<string, 1 | -1> = {
  price: 1,
  capacityUtilization: 1,
  installedCapacity: 1,
  processingLevel: 1,
  supplySecurity: 1,
  processLoss: -1,
  materialCostPerTon: -1,
  logisticsCostPerTon: -1,
  operatingExpenses: -1,
  staffCost: -1,
  otherIncome: 1,
  demand: 1,
  scrutiny: -1,
  outrage: -1,
};

/** See `DOLLAR_SCALE_DIVISOR`'s doc comment — the subset of `FIELD_DIRECTION`'s keys whose
 * ABSOLUTE-type values are raw dollar amounts rather than an already-small fraction. */
const DOLLAR_FIELDS = new Set(['operatingExpenses', 'staffCost', 'otherIncome']);

/** The bot never picks a share-transaction decision (Buy Shares/Sell Shares) through the
 * generic `pickBotDecisions` path — both have `variableAmount: true` and empty `impacts`,
 * so "affordable"/"cost-effective" isn't a simple schedule lookup the way every other
 * decision's score is. `pickBotShareBuy` is the dedicated Buy Shares strategy instead. */
function isEligibleForBot(def: DecisionDefinition): boolean {
  return !def.shareTransactionType;
}

/** A decision's own first-year cash impact (0 if it has none) — the same schedule-value
 * convention `calcEngine.getScheduleValue`/the client's `getDecisionSortValue` already use
 * for "what does this cost/pay on the turn it's deployed." Exported so `GameEngine.
 * runBotTurn` can decrement its own running `cash` tally by the same amount for each of
 * `pickBotDecisions`' picks before deciding on `pickBotShareBuy` — otherwise the two would
 * independently think the same spare cash is available, double-committing it. */
export function firstYearCashImpact(def: DecisionDefinition): number {
  const cashImpact = def.impacts?.cash;
  if (!cashImpact) return 0;
  return getScheduleValue(cashImpact.schedule, 0);
}

/** Whether a decision bears on a specific opponent at all — either it literally
 * `requiresTarget`, or it carries at least one `target.*` impact field (an indirect-effect
 * decision the deploying player didn't have to explicitly aim, but which still lands on
 * someone). Mirrors the `needsTarget` helper duplicated across this codebase's simulation
 * test harnesses (see CLAUDE.md's "Client-side duplicated pure logic" convention — same
 * "small pure logic, kept in sync by hand" pattern, applied here for the bot instead). */
function needsTarget(def: DecisionDefinition): boolean {
  return !!def.requiresTarget || Object.keys(def.impacts).some((k) => k.startsWith('target.'));
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
 * A rough cost-effectiveness score for one decision — higher is better for the bot to
 * deploy. Combines: the decision's own year-1 cash impact (`CASH_SCORE_DIVISOR`-scaled);
 * every OTHER own-effect impact field listed in `FIELD_DIRECTION`, signed by whether that
 * field helps or hurts when it moves in the impact's direction; `AGGRESSION_BONUS` if the
 * decision bears on the human at all (`needsTarget`); and `DIRTY_RISK_PENALTY` against a
 * `nature: 'Dirty'` decision once `riskGauge` is already elevated. Deliberately crude
 * (magnitude comparisons across differently-scaled fields are approximate, not
 * game-balance-grade) — the goal is "meaningfully better than uniform random," not optimal
 * play, and this never touches `game_engine.json`/the real engine math itself.
 */
export function scoreDecision(def: DecisionDefinition, riskGauge: number): number {
  let score = firstYearCashImpact(def) / CASH_SCORE_DIVISOR;

  for (const [field, impact] of Object.entries(def.impacts)) {
    if (field === 'cash' || field === 'sharesAmount' || field.startsWith('target.') || field.startsWith('competitor')) continue;
    const direction = FIELD_DIRECTION[field];
    if (direction === undefined) continue;
    const raw = getScheduleValue(impact.schedule, 0);
    if (raw === 0) continue;
    const magnitude = impact.type === 'relative' || !DOLLAR_FIELDS.has(field) ? raw : raw / DOLLAR_SCALE_DIVISOR;
    score += direction * magnitude;
  }

  if (needsTarget(def)) score += AGGRESSION_BONUS;
  if (def.nature === 'Dirty' && riskGauge >= BOT_RISK_CAUTION_THRESHOLD) score -= DIRTY_RISK_PENALTY;

  return score;
}

/**
 * Picks 1-2 decisions the bot can afford without breaching the reserve, biased toward
 * better-scoring ones (`scoreDecision`) rather than uniform random, targeting the human
 * whenever a decision requires (or otherwise bears on) a target. Deliberately not
 * exhaustively validated against `DecisionEngine.canDeploy` (maturity locks, exclusions,
 * per-turn budget) — an ineligible pick is silently dropped by `GameLoop.
 * processNewDecisions` the same way it already is for any real player's rejected
 * submission (see CLAUDE.md), so a bot "wasting" a pick on something currently blocked
 * just means it does slightly less that turn, not a crash or a bad state.
 *
 * Affordability is checked against a running remaining-cash total across BOTH picks in the
 * same call, not each independently against the original starting cash — two individually-
 * affordable picks could otherwise collectively breach the reserve (a real gap in the
 * original random-pick version).
 *
 * The scored pool is split into a better half and a worse half (each independently
 * shuffled, better half tried first) rather than deterministically always taking the
 * single top-scoring decision — keeps the bot's play non-deterministic/harder to read
 * exactly, while still meaningfully favoring good picks over uniform random. Once already
 * at/above `BOT_RISK_CAUTION_THRESHOLD`, every `nature: 'Dirty'` decision is excluded
 * outright before scoring even runs — self-preservation, not just a soft penalty.
 */
export function pickBotDecisions(
  deck: DecisionDefinition[],
  cash: number,
  humanPlayerId: string,
  riskGauge = 0,
  reserve: number = BOT_CASH_RESERVE,
): SubmittedDecisionEntry[] {
  const cautious = riskGauge >= BOT_RISK_CAUTION_THRESHOLD;
  const eligible = deck.filter((def) => isEligibleForBot(def) && !(cautious && def.nature === 'Dirty'));
  if (eligible.length === 0) return [];

  const scored = eligible
    .map((def) => ({ def, score: scoreDecision(def, riskGauge) }))
    .sort((a, b) => b.score - a.score);
  const half = Math.max(1, Math.ceil(scored.length / 2));
  const orderedPool = [...shuffle(scored.slice(0, half)), ...shuffle(scored.slice(half))];

  const pickCount = Math.random() < 0.5 ? 1 : 2;
  const picks: SubmittedDecisionEntry[] = [];
  let remainingCash = cash;

  for (const { def } of orderedPool) {
    if (picks.length >= pickCount) break;
    const cost = firstYearCashImpact(def);
    if (remainingCash + cost < reserve) continue;
    picks.push({ name: def.decision, targetId: def.requiresTarget ? humanPlayerId : undefined });
    remainingCash += cost;
  }

  return picks;
}

/**
 * Whether (and how much) the bot spends on a Buy Shares move against the human this turn
 * — a genuine hostile-takeover threat, not just flavor: enough consecutive turns of this
 * and the bot can cross the majority-ownership threshold the same way a real player's
 * sustained buying would. Gated by: a real financial-decision slot still available this
 * turn (`financialPicksSoFar < maxFinancialPerTurn` — `pickBotDecisions` already may have
 * used one), enough spare cash above the reserve to be worth it
 * (`BOT_BUY_SHARES_MIN_SPARE_CASH`), and a per-turn coin flip (`BOT_BUY_SHARES_CHANCE`) so
 * it doesn't telegraph as a predictable drip. Spends `BOT_BUY_SHARES_SPEND_FRACTION` of
 * the spare cash when it does go ahead — never all of it, same reserve-discipline
 * everywhere else here. Returns `undefined` when the bot passes on it this turn.
 */
export function pickBotShareBuy(
  cash: number,
  financialPicksSoFar: number,
  maxFinancialPerTurn: number,
  reserve: number = BOT_CASH_RESERVE,
): number | undefined {
  if (financialPicksSoFar >= maxFinancialPerTurn) return undefined;
  const spare = cash - reserve;
  if (spare < BOT_BUY_SHARES_MIN_SPARE_CASH) return undefined;
  if (Math.random() >= BOT_BUY_SHARES_CHANCE) return undefined;
  return Math.round(spare * BOT_BUY_SHARES_SPEND_FRACTION);
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

/** Fraction above fair value (`probability * stakes`, from the defendant's own
 * cost-if-tried perspective) the bot will still accept an opponent's ask as the
 * defendant — some margin above pure expected value is rational: it avoids the risk of
 * an unfavorable trial swing and the hassle of further rounds, same reasoning a real
 * player weighs. */
const BOT_DEFENDANT_ACCEPT_TOLERANCE = 1.15;

/** Fraction of fair value below which the bot, as plaintiff, will still accept the
 * defendant's offer — symmetric reasoning to `BOT_DEFENDANT_ACCEPT_TOLERANCE`, just
 * from the other side: a bird in hand slightly below fair value beats the risk/hassle
 * of pushing further. */
const BOT_PLAINTIFF_ACCEPT_TOLERANCE = 0.85;

/** Probability thresholds past which the bot skips settling altogether and forces a
 * trial — win odds this lopsided make negotiating away part of a near-certain outcome
 * (as defendant, near-certain to owe nothing; as plaintiff, near-certain to win it all)
 * a bad trade regardless of what's offered. */
const BOT_DEFENDANT_COURT_THRESHOLD = 0.15;
const BOT_PLAINTIFF_COURT_THRESHOLD = 0.85;

export type BotNegotiationAction =
  | { type: 'wait' }
  | { type: 'digDeeperOnCase' }
  | { type: 'accept' }
  | { type: 'counter'; amount: number }
  | { type: 'goToCourt' };

/** Whichever role did NOT make the case's most recent offer is the one currently allowed
 * to respond — duplicated from `GameLoop`'s own private `roleOnMove` (server is
 * authoritative; this is purely to decide what the bot itself should do), same "duplicate
 * small pure logic, keep in sync by hand" convention this codebase's client-side
 * `NegotiationPanel` already follows for the identical logic. */
function roleOnMove(case_: LegalCaseData): 'plaintiff' | 'defendant' {
  if (case_.offers.length === 0) return 'defendant';
  const lastOffer = case_.offers[case_.offers.length - 1];
  return lastOffer.by === 'plaintiff' ? 'defendant' : 'plaintiff';
}

/** The valid `[min, max]` range for the next offer — duplicated from `GameLoop`'s own
 * private `computeOfferBracket` for the same reason `roleOnMove` is. */
function computeOfferBracket(case_: LegalCaseData): { min: number; max: number } {
  let min = 0;
  let max = case_.stakes;
  for (const offer of case_.offers) {
    if (offer.by === 'defendant') min = offer.amount;
    else max = offer.amount;
  }
  return { min, max };
}

/**
 * What the bot should do about one of its own open (`status: 'negotiating'`) legal
 * cases this turn — the "probability-correlated" settlement logic: rather than the flat
 * "accept whatever's pending" Step 8b's timeout fallback would otherwise apply by
 * default (a real, reported gap — the bot never actively negotiated at all, so any offer
 * a human made to it just sat there until the timeout auto-accepted it, however small),
 * this weighs the current offer against a genuine expected-value estimate,
 * `baseProbability * stakes` (the same probability the case's own odds chip would show a
 * fully-investigated human).
 *
 * Only acts when `roleOnMove(case_) === myRole` — otherwise the ball is in the other
 * party's court, nothing to do this turn. If the bot doesn't yet know its own odds
 * (`plaintiff`: gated on `plaintiffFullyInvestigated`, always true for a bot-filed case
 * since `shouldFileLawsuit` only ever fires on a fully-investigated attack; `defendant`:
 * gated on `defendantInvestigated`, false until it pays to dig on the case itself) and
 * can afford to learn them, it digs first rather than negotiating blind — mirrors the
 * same "investigate before committing" pacing `pickAttacksToInvestigate`/
 * `shouldFileLawsuit` already follow. Falls back to treating the case as a 50/50 shot if
 * it genuinely can't afford to find out, so a cash-poor bot doesn't stall a case forever.
 *
 * The defendant always moves first (`case_.offers.length === 0`) — with nothing yet to
 * compare against, it opens below fair value (leaving room to negotiate up) rather than
 * accepting nothing or immediately forcing a trial.
 */
export function decideBotNegotiationAction(
  case_: LegalCaseData,
  myRole: 'plaintiff' | 'defendant',
  cash: number,
  digDeeperCost: number,
  reserve: number = BOT_CASH_RESERVE,
): BotNegotiationAction {
  if (roleOnMove(case_) !== myRole) return { type: 'wait' };

  const knowsOdds = myRole === 'defendant' ? case_.defendantInvestigated : case_.plaintiffFullyInvestigated;
  if (!knowsOdds) {
    // Only the defendant can dig on a case at all (see digDeeperOnCase's own doc
    // comment) — a plaintiff without plaintiffFullyInvestigated has no way to learn
    // more and falls through to the 50/50 fallback below.
    if (myRole === 'defendant' && cash - digDeeperCost >= reserve) {
      return { type: 'digDeeperOnCase' };
    }
  }
  const probability = knowsOdds ? case_.baseProbability : 0.5;
  const fairValue = probability * case_.stakes;
  const bracket = computeOfferBracket(case_);

  if (case_.offers.length === 0) {
    // Defendant's opening move — nothing to compare against yet. Open below fair value,
    // leaving real room to negotiate upward rather than starting at (or above) it.
    const opening = Math.min(bracket.max, Math.max(bracket.min, Math.round(fairValue * 0.7)));
    return { type: 'counter', amount: opening };
  }

  const lastOffer = case_.offers[case_.offers.length - 1];
  if (myRole === 'defendant') {
    if (lastOffer.amount <= fairValue * BOT_DEFENDANT_ACCEPT_TOLERANCE) return { type: 'accept' };
    if (probability <= BOT_DEFENDANT_COURT_THRESHOLD) return { type: 'goToCourt' };
    const counter = Math.min(bracket.max, Math.max(bracket.min, Math.round(fairValue)));
    return { type: 'counter', amount: counter };
  } else {
    if (lastOffer.amount >= fairValue * BOT_PLAINTIFF_ACCEPT_TOLERANCE) return { type: 'accept' };
    if (probability >= BOT_PLAINTIFF_COURT_THRESHOLD) return { type: 'goToCourt' };
    const counter = Math.min(bracket.max, Math.max(bracket.min, Math.round(fairValue)));
    return { type: 'counter', amount: counter };
  }
}
