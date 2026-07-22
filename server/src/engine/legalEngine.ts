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
   * one of the target's actually-deployed decisions (`decisionName`). Returns null if
   * the ground doesn't exist, or the target never deployed the cited decision — a
   * player can only sue over something the target actually did.
   *
   * Probability scales with how long the risky decision has been active, using the
   * same year-keyed schedule convention as decision impacts (FORMULAS §6, §9).
   */
  fileLawsuit(
    plaintiffId: string,
    targetId: string,
    decisionName: string,
    groundName: string,
    targetActiveDecisions: TargetableDecisionInstance[],
    roomId: string,
  ): LegalCaseData | null {
    const def = this.definitions.get(decisionName);
    if (!def?.legalRisks) return null;

    const risk = def.legalRisks.find(r => r.name === groundName);
    if (!risk) return null;

    const targetInstance = targetActiveDecisions.find(d => d.decisionName === decisionName);
    if (!targetInstance) return null;

    const probability = getScheduleValue(risk.probability, targetInstance.elapsedYears);
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
