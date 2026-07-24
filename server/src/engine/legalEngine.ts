/**
 * Legal Engine — manages lawsuits filed by players against rivals.
 *
 * Lawsuits are never generated automatically just because a decision carries legal
 * risk — a player must deliberately file suit against a target over a specific ground,
 * and that ground must match one of the target's actually-deployed decisions (up to
 * `gameSettings.maxLawsuitsPerPlayerPerTurn` filings per turn).
 */

import type { DecisionDefinition, AdminVariables, LegalCaseData, PlayerVariables } from '@suetheirasses/shared';
import { getScheduleValue } from './calcEngine.js';
import { meetsLegalRiskConditions } from './decisionEngine.js';

/** Minimal shape of an active decision instance needed to validate/price a lawsuit. */
export interface TargetableDecisionInstance {
  id: string;
  decisionName: string;
  elapsedYears: number;
  /** For a Buy Shares instance only — see `meetsLegalRiskConditions`. */
  acquisitionFraction?: number;
}

export class LegalEngine {
  private definitions = new Map<string, DecisionDefinition>();

  setDefinitions(definitions: DecisionDefinition[]): void {
    this.definitions = new Map(definitions.map(d => [d.decision, d]));
  }

  /**
   * File a lawsuit: plaintiff sues target over `groundName`, a legal risk attached to
   * decision `decisionName`. Returns null only if the decision or ground name doesn't
   * exist in the decision library at all (a malformed/tampered request — the real client
   * only ever offers real decision+ground pairs, see GamePhase.tsx's `getGroundsAgainst`).
   *
   * Unlike that hard validation, whether the target *actually deployed* the cited
   * decision does **not** gate case creation — a player can knowingly gamble on a ground
   * the target may or may not have actually pursued (the whole-library ground catalog
   * deliberately includes every decision in the game, not just ones a specific target has
   * done). A guess that turns out wrong still creates a real case, just a hopeless one:
   * `baseProbability` is forced to 0 rather than priced off a real schedule, since there's
   * no genuine ground to argue — `resolveProbability`'s multiplication means
   * `adjustedProbability` stays 0 at trial too, regardless of the defendant's own scrutiny/
   * legal exposure. The plaintiff doesn't know this in advance (their side only sees the
   * real number if `plaintiffFullyInvestigated`, which a decision the target never
   * deployed can never satisfy — see CLAUDE.md); the defendant, who always sees the real
   * probability, does.
   *
   * When the target genuinely did deploy the cited decision, probability scales with how
   * long it's been active, using the same year-keyed schedule convention as decision
   * impacts — up to `statuteOfLimitationsYears` (`GameSettings.
   * statuteOfLimitationsYears`, default 10): once the target's cited instance has been
   * active at least that long, the ground is time-barred and treated exactly like a
   * wrong guess — a real case still gets created, `baseProbability` just forced to 0.
   * This is deliberately independent of the decision's own `isMatured` (maturity
   * governs when an impact schedule locks in, not legal liability) — a
   * long-matured decision can still be well within the limitations window, and vice
   * versa. Defaulted to `Infinity` (never time-barred) so existing callers/tests that
   * don't pass it keep the pre-feature behavior.
   *
   * `plaintiffFullyInvestigated` is computed by the caller (`GameLoop.resolveTurn`'s
   * Step 8, which has access to both the filing player's own investigation state and
   * the target's active decisions) and just stamped onto the resulting case here — see
   * CLAUDE.md's case-probability-chip section for why this is persisted rather than
   * recomputed client-side.
   *
   * `stakes` (the dollar amount that actually changes hands if this case resolves against
   * the defendant) is priced off `risk.impact` two different ways depending on its `type`
   * — `absolute` grounds (58 of 83 in the real library, all `target: 'cash'`) use the
   * schedule value directly, already a dollar figure. `relative` grounds (the other 25,
   * `target: 'equity'` or `'revenue'`) instead store a *fraction* (e.g. `-0.45`) meant to
   * be scaled against the defendant's own current value of that field — `targetVars` is
   * what supplies that value. Reading `risk.impact.schedule[...]` directly as dollars for
   * a relative ground (the bug this comment replaced) silently produced a stakes of
   * `0.45` — real money, just off by a factor of the defendant's entire equity/revenue —
   * which rounds to display as "$0" everywhere stakes are shown (the settlement offer
   * bracket, the trial-outcome "You paid/received" line). `target` is read generically
   * off `PlayerVariables`, never hardcoded to `'equity'`/`'revenue'` specifically, so an
   * admin adding a new relative-type ground against a different field works without a
   * code change.
   */
  fileLawsuit(
    plaintiffId: string,
    targetId: string,
    decisionName: string,
    groundName: string,
    targetActiveDecisions: TargetableDecisionInstance[],
    targetVars: PlayerVariables,
    roomId: string,
    plaintiffFullyInvestigated: boolean,
    statuteOfLimitationsYears = Infinity,
  ): LegalCaseData | null {
    const def = this.definitions.get(decisionName);
    if (!def?.legalRisks) return null;

    const risk = def.legalRisks.find(r => r.name === groundName);
    if (!risk) return null;

    const targetInstance = targetActiveDecisions.find(d => d.decisionName === decisionName);
    const timeBarred = !!targetInstance && targetInstance.elapsedYears >= statuteOfLimitationsYears;
    // A transaction too small to cross a decision's own legalRiskConditions (e.g. Buy
    // Shares' minPercentAcquiredInSingleTransaction) never had real legal risk to begin
    // with — same "real but hopeless" 0%-probability shape as a wrong guess/time-barred
    // ground, not a separate rejection (see meetsLegalRiskConditions/CLAUDE.md).
    const conditionsMet = !targetInstance || meetsLegalRiskConditions(def, targetInstance);
    const probability = targetInstance && !timeBarred && conditionsMet ? getScheduleValue(risk.probability, targetInstance.elapsedYears) : 0;
    const scheduleValue = risk.impact.schedule['default'] ?? risk.impact.schedule[1] ?? 0;
    const targetFieldValue = (targetVars as unknown as Record<string, unknown>)[risk.impact.target];
    const stakes = risk.impact.type === 'relative'
      ? Math.abs((typeof targetFieldValue === 'number' ? targetFieldValue : 0) * scheduleValue)
      : Math.abs(scheduleValue);

    return {
      id: crypto.randomUUID(),
      roomId,
      plaintiffId,
      defendantId: targetId,
      decisionName,
      groundName: risk.name,
      description: risk.description,
      // Only recorded for a genuine, still-actionable ground — a wrong guess or a
      // time-barred instance (baseProbability already forced to 0 either way) never
      // identifies a real instance to void later, even if the case somehow later settles.
      defendantDecisionInstanceId: targetInstance && !timeBarred ? targetInstance.id : undefined,
      baseProbability: probability,
      adjustedProbability: undefined,
      plaintiffFullyInvestigated,
      defendantInvestigated: false,
      stakes,
      status: 'negotiating',
      offers: [],
      turnsNegotiating: 0,
      verdict: undefined,
      createdAt: new Date(),
      resolvedAt: undefined,
    };
  }

  /**
   * Calculate adjusted probability at trial time based on defendant's scrutiny and legal exposure.
   * adjustedProbability_case = baseProbability_legalRisk
   *                            * (1 + scrutinyLegalRiskMultiplier * scrutiny_defendant / 100
   *                                 + legalExposureRatio_defendant)
   */
  resolveProbability(
    baseProbability: number,
    defendantScrutiny: number,
    defendantLegalExposureRatio: number,
    admin: AdminVariables,
  ): number {
    const { scrutinyLegalRiskMultiplier } = admin.legalProcess;
    return baseProbability * (1 + (scrutinyLegalRiskMultiplier * defendantScrutiny) / 100 + defendantLegalExposureRatio);
  }
}
