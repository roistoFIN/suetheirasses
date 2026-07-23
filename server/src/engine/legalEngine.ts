/**
 * Legal Engine — manages lawsuits filed by players against rivals per FORMULAS.md §6.
 *
 * Lawsuits are never generated automatically just because a decision carries legal
 * risk — a player must deliberately file suit against a target over a specific ground,
 * and that ground must match one of the target's actually-deployed decisions (up to
 * `gameSettings.maxLawsuitsPerPlayerPerTurn` filings per turn).
 */

import type { DecisionDefinition, AdminVariables, LegalCaseData } from '@suetheirasses/shared';
import { getScheduleValue } from './calcEngine.js';

/** Minimal shape of an active decision instance needed to validate/price a lawsuit. */
export interface TargetableDecisionInstance {
  decisionName: string;
  elapsedYears: number;
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
   * impacts (FORMULAS §6, §9) — up to `statuteOfLimitationsYears` (`GameSettings.
   * statuteOfLimitationsYears`, default 10): once the target's cited instance has been
   * active at least that long, the ground is time-barred and treated exactly like a
   * wrong guess — a real case still gets created, `baseProbability` just forced to 0.
   * This is deliberately independent of the decision's own `isMatured` (FORMULAS §9
   * maturity governs when an impact schedule locks in, not legal liability) — a
   * long-matured decision can still be well within the limitations window, and vice
   * versa. Defaulted to `Infinity` (never time-barred) so existing callers/tests that
   * don't pass it keep the pre-feature behavior.
   *
   * `plaintiffFullyInvestigated` is computed by the caller (`GameLoop.resolveTurn`'s
   * Step 8, which has access to both the filing player's own investigation state and
   * the target's active decisions) and just stamped onto the resulting case here — see
   * CLAUDE.md's case-probability-chip section for why this is persisted rather than
   * recomputed client-side.
   */
  fileLawsuit(
    plaintiffId: string,
    targetId: string,
    decisionName: string,
    groundName: string,
    targetActiveDecisions: TargetableDecisionInstance[],
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
    const probability = targetInstance && !timeBarred ? getScheduleValue(risk.probability, targetInstance.elapsedYears) : 0;
    const stakes = Math.abs(risk.impact.schedule['default'] ?? risk.impact.schedule[1] ?? 0);

    return {
      id: crypto.randomUUID(),
      roomId,
      plaintiffId,
      defendantId: targetId,
      decisionName,
      groundName: risk.name,
      description: risk.description,
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
   * Per FORMULAS §6:
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
