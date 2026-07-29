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
import { hasPermanentEffect } from '../engine/decisionEngine.js';
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

/** How many of the bot's own most-recent real (turn-resolved) cash readings
 * `isCashTrendDeclining` looks at — see its own doc comment for why a trend, not any
 * single turn's affordability check, is the thing that actually catches this. */
export const BOT_CASH_TREND_WINDOW = 3;

/** Multiplier applied to `BOT_CASH_RESERVE` once `isCashTrendDeclining` fires — see
 * `computeEffectiveReserve`. A real, reported bug: the bot could bankrupt itself within a
 * handful of turns even against a fully idle human, purely from its OWN decision picks.
 * `estimatedFirstYearCashEffect` (see its own doc comment) fixes the single biggest source
 * of that — the affordability check silently ignoring same-turn `operatingExpenses`/
 * `staffCost`/`otherIncome` movement — but several decisions in the library also have a
 * genuinely BACKLOADED cost (a schedule value that only lands in year 2-4, e.g. a
 * multi-year `financeCost` repayment on an up-front windfall — see CLAUDE.md's "Cash-
 * growth balance pass"), invisible to ANY check that only looks at the year of deployment.
 * Rather than trying to model every decision's full multi-year amortization (real
 * lookahead, deliberately out of scope for this bot — see this file's own header), this
 * reacts to the actual SYMPTOM instead: once the bot's own real cash has been net
 * declining over `BOT_CASH_TREND_WINDOW` turns, whatever the cause, it raises its own bar
 * for new discretionary spending until cash recovers — the same "self-preservation, not
 * optimal play" shape `BOT_RISK_CAUTION_THRESHOLD` already established for `riskGauge`,
 * just keyed off real cash movement instead of legal exposure. */
export const BOT_CASH_TREND_RESERVE_MULTIPLIER = 4;

/**
 * Whether the bot's own recent real cash history shows a net decline —
 * `BOT_CASH_TREND_WINDOW` turns of actual (turn-resolved) cash, oldest first. Deliberately
 * a net-over-the-window comparison (last entry vs. first), not "every consecutive pair
 * decreased" — a single big one-time capex turn followed by recovery shouldn't trip this,
 * only a genuinely sustained slide. Returns `false` until at least `BOT_CASH_TREND_WINDOW`
 * readings exist (no premature judgement off a partial history, e.g. a bot's first couple
 * of turns in a fresh game).
 */
export function isCashTrendDeclining(cashHistory: number[]): boolean {
  if (cashHistory.length < BOT_CASH_TREND_WINDOW) return false;
  const window = cashHistory.slice(-BOT_CASH_TREND_WINDOW);
  return window[window.length - 1] < window[0];
}

/** The reserve the bot should actually budget against this turn — `BOT_CASH_RESERVE`,
 * multiplied up by `BOT_CASH_TREND_RESERVE_MULTIPLIER` once `isCashTrendDeclining` fires
 * on the bot's own recent cash history, PLUS whatever `projectedNextTurnOwnCashEffect`
 * says is already coming due from decisions the bot has already deployed (only the
 * negative — i.e. cost — side; a projected net-positive next turn adds nothing here,
 * it's not extra spending money for THIS turn). Meant to be computed once per bot per
 * turn and passed as the `reserve` argument to `pickBotDecisions`/`pickBotShareBuy`/
 * `shouldFileLawsuit` alike, so every discretionary spend this turn backs off together
 * — both against a real recent decline AND a real known bill about to land, not just one
 * of them. */
export function computeEffectiveReserve(
  cashHistory: number[],
  projectedNextTurnOwnEffect = 0,
  baseReserve: number = BOT_CASH_RESERVE,
): number {
  const trendAdjusted = isCashTrendDeclining(cashHistory) ? baseReserve * BOT_CASH_TREND_RESERVE_MULTIPLIER : baseReserve;
  return trendAdjusted + Math.max(0, -projectedNextTurnOwnEffect);
}

/** Score bonus for a decision that targets (or otherwise bears on) the human specifically
 * — see `scoreDecision`. Applied on top of the decision's own cost-effectiveness score,
 * not a replacement for it: a bad targeting decision still loses to a great neutral one. */
const AGGRESSION_BONUS = 0.3;

/** Penalty subtracted from a `nature: 'Dirty'` decision's score once already past
 * `BOT_RISK_CAUTION_THRESHOLD` — the hard veto in `pickBotDecisions` already excludes
 * these outright at that point, but this also softly de-prioritizes them for a bot
 * approaching (not yet past) the threshold, easing off before it actually needs to. */
const DIRTY_RISK_PENALTY = 5;

/** Fallback `admin.finance.interestRate` used to convert a `debt` impact into an
 * equivalent recurring `financeCost` for scoring/budgeting purposes (see `debtAsFinanceCost`)
 * when the real admin-configured rate isn't passed in — matches `game_config.json`'s
 * seeded default. Real callers (`GameEngine.runBotTurn`) should pass the actual configured
 * rate; this is only a sane fallback for tests/callers that don't have it on hand. */
export const DEFAULT_INTEREST_RATE = 0.05;

/** A `debt` impact isn't itself a dollar COST — it's principal, and by itself it can look
 * like free money to a naive scorer. Its real cost is the recurring `financeCost` it
 * generates via `financeCost = baseFinanceCost + debt*interestRate + financeCostDelta`
 * (see `calcEngine.ts`'s `calculatePL` doc comment) — a real, reported bug: neither `debt`
 * nor `financeCost` itself were in `FIELD_DIRECTION`/`DOLLAR_FIELDS` at all, so a decision
 * like "Payday Loan" (`cash`: +30,000, `debt`: +30,000, `financeCost`: +9,000) or "Manure
 * Futures Speculation" (`cash`: +84,000, `debt`: +60,000, `financeCost`: +12,000 for two
 * years) scored and budgeted as a near-pure windfall — the bot had no way to see the real,
 * permanent recurring cost these add to its own baseline `financeCost` (which, unlike the
 * schedule re-application itself, persists forever once the state variable is raised — see
 * CLAUDE.md's "Root historical bug" note) until it had stacked enough of them to bankrupt
 * itself within a handful of turns even against a fully idle human. This is exactly why
 * `financeCost` is now in `DOLLAR_FIELDS`/`FIELD_DIRECTION` directly, and why a `debt`
 * impact is converted here into its own financeCost-equivalent before being folded into
 * the same real-dollar-effect total. */
function debtAsFinanceCost(raw: number, interestRate: number): number {
  return raw * interestRate;
}

/** Same normalization for the year-1 cash impact itself (see `scoreDecision`). */
const CASH_SCORE_DIVISOR = 10_000;

/**
 * Direction each field's OWN impact should point for `scoreDecision` to treat it as
 * "good for the deploying player": `1` if a HIGHER value helps, `-1` if a LOWER value
 * does. Deliberately only the fields that actually feed a real formula
 * (`competitiveness`/`cogs`/`ebitda`/`financeCost` in `defaultFormulas.ts` —
 * `price`/`capacityUtilization`/`installedCapacity`/`processingLevel`/`supplySecurity`/
 * `processLoss`/`materialCostPerTon`/`logisticsCostPerTon`/`operatingExpenses`/
 * `staffCost`/`otherIncome`/`demand`/`financeCost`, plus `scrutiny`/`outrage` for the risk
 * gauge) — `energyIntensity`/`moistureContent`/`nutrientConsistency`/`contaminationRisk`/
 * `odorComplaints`/`breakdowns`/`carbonFootprint`/`stockVolume` are pure flavor text with
 * no formula reference anywhere in this codebase, so scoring them would just be noise, not
 * signal. `price` pointing "higher is better" is itself an approximation — a higher price
 * also lowers `competitiveness`'s `1/price` term, but production is capacity-bound rather
 * than market-share-bound in the vast majority of games (see CLAUDE.md), so more revenue
 * per ton at an unchanged capacity-bound volume is the common case. Good enough for "a
 * little smarter," not claimed to be exact.
 *
 * `financeCost` was a real, reported gap: a decision like "Payday Loan"/"Manure Futures
 * Speculation" (real dollar `financeCost` additions, on top of a `debt` increase — see
 * `debtAsFinanceCost`'s doc comment) scored as a near-pure cash windfall with zero
 * downside represented, since neither field was scored at all before this.
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
  financeCost: -1,
};

/** The subset of `FIELD_DIRECTION`'s keys whose ABSOLUTE-type values are raw dollar
 * amounts rather than an already-small fraction — scored/budgeted via `worstCaseCashEffect`/
 * `realCashEffectAtYear` (real dollars) rather than `scoreDecision`'s generic per-field
 * loop (which would otherwise compare a $9,000 `financeCost` swing directly against a
 * 0.2 `price` swing as if they were the same kind of number). */
const DOLLAR_FIELDS = new Set(['operatingExpenses', 'staffCost', 'otherIncome', 'financeCost']);

/** The bot never picks a share-transaction decision (Buy Shares/Sell Shares) through the
 * generic `pickBotDecisions` path — both have `variableAmount: true` and empty `impacts`,
 * so "affordable"/"cost-effective" isn't a simple schedule lookup the way every other
 * decision's score is. `pickBotShareBuy` is the dedicated Buy Shares strategy instead. */
function isEligibleForBot(def: DecisionDefinition): boolean {
  return !def.shareTransactionType;
}

/** Shared by `estimatedFirstYearCashEffect` (year of deployment, `elapsedYears` 0) and
 * `projectedNextTurnOwnCashEffect` (an already-active instance's NEXT turn, `elapsedYears`
 * whatever `advanceAndApply` will actually evaluate) — the real dollar cash effect a
 * decision's own fields produce at a specific `elapsedYears`, not just its `cash` field:
 * every `DOLLAR_FIELDS` field it also carries (`operatingExpenses`/`staffCost`/
 * `otherIncome`/`financeCost`), plus `debt`'s financeCost-equivalent (see
 * `debtAsFinanceCost`) — all of which flow straight through the same turn's P&L into an
 * equally real cash movement, even though they're different `PlayerVariables` fields. */
function realCashEffectAtYear(def: DecisionDefinition, elapsedYears: number, interestRate: number): number {
  const cashImpact = def.impacts.cash;
  let total = cashImpact ? getScheduleValue(cashImpact.schedule, elapsedYears) : 0;
  for (const field of DOLLAR_FIELDS) {
    const impact = def.impacts[field];
    if (!impact) continue;
    const raw = getScheduleValue(impact.schedule, elapsedYears);
    if (raw === 0) continue;
    total += FIELD_DIRECTION[field] * raw;
  }
  // debt is principal, not a same-turn cash cost by itself — but it's not free either:
  // it converts into a real recurring financeCost via debt*interestRate (see
  // debtAsFinanceCost's doc comment), which the reserve check needs to see coming.
  const debtImpact = def.impacts.debt;
  if (debtImpact) {
    const rawDebt = getScheduleValue(debtImpact.schedule, elapsedYears);
    if (rawDebt !== 0) total -= debtAsFinanceCost(rawDebt, interestRate);
  }
  return total;
}

/**
 * The REAL cash effect of deploying a decision this turn — not just its `cash` field (see
 * `realCashEffectAtYear`). A real, reported bug: the bot used to budget/pick against
 * `firstYearCashImpact` (the `cash` field alone), so a decision like "Non-Disclosure
 * Severance" (`cash`: -25,000, `staffCost`: +15,000) looked like a $25k spend to the
 * reserve check but actually cost ~$40k in real cash the very turn it was deployed — and
 * since a `DOLLAR_FIELDS` step change is a PERMANENT baseline shift, not a one-time
 * deduction (see CLAUDE.md's "Root historical bug" note — a matured decision's own value
 * applies once but the field simply stays elevated forever after), every such
 * underestimate also compounds every subsequent turn as a recurring, un-budgeted drag.
 * This under-counting is exactly why the bot could bankrupt itself within a handful of
 * turns even against a fully idle human: each individual pick cleared the reserve by the
 * (wrong, too-optimistic) accounting, while the real cumulative cash effect quietly ran
 * deep negative. See also `projectedNextTurnOwnCashEffect` for the other half of this bug
 * — a decision's cost can also be backloaded to a LATER year, invisible to this function.
 */
export function estimatedFirstYearCashEffect(def: DecisionDefinition, interestRate: number = DEFAULT_INTEREST_RATE): number {
  return realCashEffectAtYear(def, 0, interestRate);
}

/**
 * The bot's own dollar-denominated cash effect that its OWN already-active decisions will
 * apply NEXT turn, regardless of anything picked this turn — a real, reported bug: several
 * decisions in the library have genuinely BACKLOADED schedules (a `financeCost`/`cash`
 * value that's zero at deployment but lands in year 2-4, e.g. "Manure Futures
 * Speculation"'s `financeCost`: `{"1":0,"2":12000,"3":12000}`), invisible to any check
 * that only ever prices a decision at the moment it's picked
 * (`estimatedFirstYearCashEffect`). Once the bot has stacked several such decisions across
 * many turns, their deferred bills can land in the SAME future turn — an observed failure
 * mode where the bot's cash looked comfortable and stable for several turns running, then
 * crashed deeply negative in one turn from several already-active decisions' schedules
 * landing together, with nothing about that turn's OWN new picks being unaffordable in
 * isolation. `nextElapsedYears > instance.maturityYears` mirrors `DecisionEngine.
 * advanceAndApply`'s own "past its own maturity threshold, never applies its own schedule
 * again" gate (see CLAUDE.md's "Root historical bug" note) closely enough to predict what
 * it will actually do next turn, without re-implementing the whole engine — deliberately
 * NOT full lookahead (it only reasons about commitments ALREADY made, never simulates a
 * hypothetical future pick), so it stays within this bot's "no lookahead, no optimal play"
 * design (see this file's own header) while still being self-preserving. Meant to be
 * folded into the reserve `GameEngine.runBotTurn` budgets new spending against this turn
 * (see `computeEffectiveReserve`), not compared against `cash` directly.
 */
export function projectedNextTurnOwnCashEffect(
  activeDecisions: Array<{ decisionName: string; elapsedYears: number; maturityYears: number; voidedByLawsuit: boolean }>,
  deck: DecisionDefinition[],
  interestRate: number = DEFAULT_INTEREST_RATE,
): number {
  let total = 0;
  for (const instance of activeDecisions) {
    if (instance.voidedByLawsuit) continue;
    const nextElapsedYears = instance.elapsedYears + 1;
    if (nextElapsedYears > instance.maturityYears) continue;
    const def = deck.find((d) => d.decision === instance.decisionName);
    if (!def) continue;
    total += realCashEffectAtYear(def, nextElapsedYears, interestRate);
  }
  return total;
}

/**
 * Whether the bot's own current cost structure — `operatingExpenses`/`staffCost`/
 * `financeCost`, net of `otherIncome` — already exceeds its own revenue, i.e. it's losing
 * money on ordinary operations every turn regardless of anything new it picks. A real,
 * reported failure mode distinct from anything `isCashTrendDeclining`/
 * `projectedNextTurnOwnCashEffect` catch: a company can coast on a large cash cushion for
 * MANY turns while its underlying P&L is already deeply negative every single turn (many
 * stacked decisions each permanently raising `operatingExpenses`/`staffCost`/`financeCost`
 * — see CLAUDE.md's "Root historical bug"/margin-stacking notes for why these persist
 * forever once raised, even though the schedule that raised them stops re-applying) —
 * right up until the cushion runs out, at which point cash craters in what looks like one
 * sudden turn but was actually structural for a long time before that. Deliberately
 * approximate (ignores COGS/depreciation/tax — a bot heuristic, not the real P&L, see
 * `calcEngine.ts`'s `calculatePL`), but the omitted terms only ever make a genuinely
 * healthy company look slightly worse on paper, never make a genuinely sick one look
 * healthy — good enough for "should the bot stop digging," not a balance calculation.
 */
export function isStructurallyUnprofitable(
  operatingExpenses: number,
  staffCost: number,
  otherIncome: number,
  financeCost: number,
  revenue: number,
): boolean {
  const approxEbit = revenue - operatingExpenses - staffCost + otherIncome;
  return approxEbit - financeCost < 0;
}

/** For a cost-direction field (`direction: -1`, e.g. `operatingExpenses`/`staffCost`/
 * `financeCost`), the single WORST (highest) value this decision's schedule will EVER
 * produce, across every explicit year AND its `'default'` (steady-state) value — for a
 * benefit-direction field (`direction: 1`, e.g. `otherIncome`, or `cash` itself), the
 * single WORST (lowest) value. Deliberately pessimistic: "how bad could this field ever
 * get," not "how bad is it right now." */
function worstScheduleValue(schedule: Record<number | string, number>, direction: 1 | -1): number {
  const values = Object.values(schedule);
  if (values.length === 0) return 0;
  return direction === -1 ? Math.max(...values) : Math.min(...values);
}

/**
 * The pessimistic counterpart to `realCashEffectAtYear` — instead of one specific
 * `elapsedYears`, looks at every year (and `'default'`) a decision's cash-affecting fields
 * (`cash`/`DOLLAR_FIELDS`/`debt`) could ever produce and takes the single worst value per
 * field (`worstScheduleValue`), rather than whatever happens to be true at year 1. A real,
 * reported bug: `scoreDecision`/`estimatedFirstYearCashEffect` only ever read a decision's
 * YEAR-1 value, so a decision with a genuinely BACKLOADED cost (e.g. "Manure Futures
 * Speculation"'s `financeCost`: `{"1":0,"2":12000,"3":12000}`) scored and budgeted as
 * completely free at the exact moment the bot had to decide whether to pick it at all —
 * before `projectedNextTurnOwnCashEffect` (which only reasons about decisions ALREADY
 * active) could ever see it coming. Worse: since the bug made these decisions look
 * artificially FREE rather than merely underestimated, `scoreDecision` was actively
 * biased TOWARD picking exactly the decisions most likely to cause this — its own scoring
 * mechanism was the thing recommending the trap. Used for scoring and affordability
 * BEFORE a pick is made (`scoreDecision`/`pickBotDecisions`) — deliberately not used for
 * `projectedNextTurnOwnCashEffect`, which needs the real year for an instance already
 * committed to, not a worst-case blend across its whole remaining lifetime.
 */
function worstCaseCashEffect(def: DecisionDefinition, interestRate: number): number {
  const cashImpact = def.impacts.cash;
  let total = cashImpact ? worstScheduleValue(cashImpact.schedule, 1) : 0;
  for (const field of DOLLAR_FIELDS) {
    const impact = def.impacts[field];
    if (!impact) continue;
    total += FIELD_DIRECTION[field] * worstScheduleValue(impact.schedule, FIELD_DIRECTION[field]);
  }
  const debtImpact = def.impacts.debt;
  if (debtImpact) {
    const worstDebt = worstScheduleValue(debtImpact.schedule, -1);
    total -= debtAsFinanceCost(worstDebt, interestRate);
  }
  return total;
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
export function scoreDecision(def: DecisionDefinition, riskGauge: number, interestRate: number = DEFAULT_INTEREST_RATE): number {
  // cash/DOLLAR_FIELDS/debt are all scored together via worstCaseCashEffect — pessimistic
  // across the WHOLE schedule (not just year 1), so a backloaded cost can't score as free
  // just because it hasn't landed yet (see worstCaseCashEffect's own doc comment for the
  // real, reported bug this fixes: the bot's own scoring used to actively prefer exactly
  // the decisions most likely to bankrupt it, since their downside was invisible at
  // pick time).
  let score = worstCaseCashEffect(def, interestRate) / CASH_SCORE_DIVISOR;

  for (const [field, impact] of Object.entries(def.impacts)) {
    if (field === 'cash' || field === 'debt' || field === 'sharesAmount' || DOLLAR_FIELDS.has(field) || field.startsWith('target.') || field.startsWith('competitor')) continue;
    const direction = FIELD_DIRECTION[field];
    if (direction === undefined) continue;
    const raw = getScheduleValue(impact.schedule, 0);
    if (raw === 0) continue;
    score += direction * raw;
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
  interestRate: number = DEFAULT_INTEREST_RATE,
  structurallyUnprofitable = false,
  activeDecisions: Array<{ decisionName: string; elapsedYears: number; isMatured: boolean; voidedByLawsuit: boolean }> = [],
  permanentEffectCooldownYears = Infinity,
): SubmittedDecisionEntry[] {
  const cautious = riskGauge >= BOT_RISK_CAUTION_THRESHOLD;
  const eligible = deck.filter((def) =>
    isEligibleForBot(def) &&
    !(cautious && def.nature === 'Dirty') &&
    // Already losing money every turn on its own cost structure (see
    // isStructurallyUnprofitable's doc comment) — stop digging: only decisions that don't
    // make the worst case any worse are even considered, same hard-veto shape as the
    // Dirty exclusion above, just keyed off real P&L health instead of legal risk.
    (!structurallyUnprofitable || worstCaseCashEffect(def, interestRate) >= 0) &&
    // A real, reported bug: the bot doesn't validate against DecisionEngine.canDeploy at
    // all (see this file's own header) — an ineligible pick is silently dropped by
    // GameLoop.processNewDecisions, same as a real player's rejected submission, which is
    // fine for a "wasted" pick in isolation. But `hasPermanentEffect`'s own redeploy lock
    // (canDeploy, decisionEngine.ts) specifically blocks a permanent-effect decision from
    // redeploying while a matured instance is still within `permanentEffectCooldownYears`
    // — and the bot's OWN cash accounting (`estimatedFirstYearCashEffect`/
    // `worstCaseCashEffect`) has no way to know a pick will be silently rejected, so it
    // kept optimistically crediting itself the full windfall of a "pick" that never
    // actually deployed, inflating what it believed it could then afford to spend
    // (Buy Shares chief among them) — a real, observed cause of self-bankruptcy distinct
    // from any single decision's own cost being underestimated. Mirrors canDeploy's exact
    // condition (`isMatured && !voidedByLawsuit && elapsedYears < cooldown`) rather than a
    // blunter "already active" exclusion, since stacking a permanent-effect decision IS
    // legitimately allowed once the cooldown has passed (see CLAUDE.md).
    !(hasPermanentEffect(def) && activeDecisions.some((d) => d.decisionName === def.decision && d.isMatured && !d.voidedByLawsuit && d.elapsedYears < permanentEffectCooldownYears)) &&
    // canDeploy's other, more basic redeploy rule, unconditional on hasPermanentEffect:
    // ANY decision can't be redeployed while its own most recent instance hasn't matured
    // yet — same phantom-cash risk as the permanent-effect case above, just for a
    // decision that's simply still ramping up rather than one with a lasting KPI boost.
    !activeDecisions.some((d) => d.decisionName === def.decision && !d.isMatured) &&
    // canDeploy's mutual-exclusion rule (forward: this decision excludes an unmatured
    // active one; reverse: an unmatured active decision's own excludes list names this
    // one) — same phantom-cash risk as the redeploy-lock checks above, just via a
    // different canDeploy rejection path.
    !def.excludes.some((excluded) => activeDecisions.some((d) => d.decisionName === excluded && !d.isMatured)) &&
    !activeDecisions.some((d) => !d.isMatured && deck.find((x) => x.decision === d.decisionName)?.excludes.includes(def.decision)),
  );
  if (eligible.length === 0) return [];

  const scored = eligible
    .map((def) => ({ def, score: scoreDecision(def, riskGauge, interestRate) }))
    .sort((a, b) => b.score - a.score);
  const half = Math.max(1, Math.ceil(scored.length / 2));
  const orderedPool = [...shuffle(scored.slice(0, half)), ...shuffle(scored.slice(half))];

  const pickCount = Math.random() < 0.5 ? 1 : 2;
  const picks: SubmittedDecisionEntry[] = [];
  let remainingCash = cash;

  for (const { def } of orderedPool) {
    if (picks.length >= pickCount) break;
    // Budgets pessimistically (worstCaseCashEffect, not just this year's value) — a
    // decision whose worst realistic year would breach the reserve isn't picked, even if
    // its year-1 number looks comfortably affordable.
    const cost = worstCaseCashEffect(def, interestRate);
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
 *
 * Clamped to `maxUsefulSpend` — a real, reported bug: `GameLoop.applyShareTransaction`
 * charges the buyer's FULL requested `amount` even once `fractionBought` has already
 * capped at 1 (100% owned) — nothing refunds the excess once there's nothing left to
 * usefully buy (the surplus just gets distributed to the diluted sellers instead, a pure
 * loss for the buyer). A spare-cash-sized spend with no awareness of the TARGET's actual
 * size could vastly overpay for a small/cheap company once the bot's own cash pile grows
 * past what the target is even worth — a real, observed cause of self-bankruptcy from a
 * single oversized Buy Shares move. Callers should compute `maxUsefulSpend` as
 * `(1 - currentBotOwnershipFraction) * totalSharesOutstanding * stockValue` (mirroring
 * `applyShareTransaction`'s own math) and pass `Infinity` only when the target's
 * `stockValue` genuinely isn't known yet (see CLAUDE.md's own `startingStockValue` note —
 * a rare, round-1-only case not worth replicating exactly here).
 */
export function pickBotShareBuy(
  cash: number,
  financialPicksSoFar: number,
  maxFinancialPerTurn: number,
  reserve: number = BOT_CASH_RESERVE,
  maxUsefulSpend: number = Infinity,
): number | undefined {
  if (financialPicksSoFar >= maxFinancialPerTurn) return undefined;
  if (maxUsefulSpend <= 0) return undefined;
  const spare = cash - reserve;
  if (spare < BOT_BUY_SHARES_MIN_SPARE_CASH) return undefined;
  if (Math.random() >= BOT_BUY_SHARES_CHANCE) return undefined;
  return Math.min(Math.round(spare * BOT_BUY_SHARES_SPEND_FRACTION), Math.floor(maxUsefulSpend));
}

/**
 * Up to `maxPicks` incoming attacks worth spending a Dig Deeper on this turn, prioritizing
 * whichever is already partway investigated (mirrors the "smart" randomized-simulation
 * strategy documented in CLAUDE.md — never abandon a half-paid-for investigation). An
 * attack that's already fully revealed (`suggestedGrounds` present) needs no further
 * digging — see `shouldFileLawsuit` instead.
 */
export function pickAttacksToInvestigate(attacks: IncomingAttackInfo[], maxPicks = 2): IncomingAttackInfo[] {
  return [...attacks]
    .filter((a) => a.suggestedGrounds === undefined)
    .sort((a, b) => b.investigationLevel - a.investigationLevel)
    .slice(0, maxPicks);
}

/**
 * Whether a fully-investigated incoming attack is worth suing over: a real estimated win
 * chance above 30% (the user-specified threshold) and enough cash to cover the filing fee
 * without breaching the reserve. Only ever weighs the single strongest ground
 * (`suggestedGrounds[0]`, already sorted probability-descending by `pickAllGrounds`) — the
 * bot still sues over its best option, same as before this field became a list; showing
 * every viable ground is a human-facing information upgrade, not a bot-strategy change.
 * An attack that isn't fully revealed yet (no `suggestedGrounds`) never qualifies —
 * nothing to sue over yet.
 */
export function shouldFileLawsuit(
  attack: IncomingAttackInfo,
  cash: number,
  filingCost: number,
  reserve: number = BOT_CASH_RESERVE,
): boolean {
  const best = attack.suggestedGrounds?.[0];
  if (!best) return false;
  if (best.probability <= 0.3) return false;
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
