/**
 * Decision Engine — manages decision deployment, exclusion rules, maturity tracking,
 * and impact application per FORMULAS.md §9-§10.
 */

import type { DecisionDefinition, PlayerVariables, AdminVariables } from '@suetheirasses/shared';
import {
  applyDecisionImpacts,
  calculateMaturityYears as calcMaturity,
  extractTargetImpacts,
  getScheduleValue,
  calculateAdjustedProbability,
} from './calcEngine.js';
import type { FormulaSet } from './formulaEngine.js';

export interface DeployedDecision {
  id: string;
  definition: DecisionDefinition;
  deployedYear: number;
  elapsedYears: number;
  isMatured: boolean;
  /** The player this decision's `target.*` impacts route to — set when the decision was deployed against an opponent. */
  targetId?: string;
}

/** Target impacts extracted from a decision — applied to the targeted player instead of self. */
export interface TargetImpactResult {
  targetId: string;
  impacts: Map<string, { type: 'absolute' | 'relative'; schedule: Record<number | string, number> }>;
  elapsedYears: number;
}

/** Number of "Dig Deeper" clicks it takes to fully reveal an incoming attack (who → what → suggested lawsuit). */
export const MAX_INVESTIGATION_LEVEL = 3;

/** "outrage" -> "Outrage", "capacityUtilization" -> "Capacity Utilization". */
function humanizeField(field: string): string {
  const words = field.replace(/([A-Z])/g, ' $1');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Human-readable summary of a decision's current cross-player effect, e.g.
 * "+20 Outrage, -20% Capacity Utilization" — used at investigation tier 2 ("what
 * trouble it is") to describe an incoming attack without yet naming the attacker's
 * suggested lawsuit ground.
 */
export function summarizeTargetImpacts(
  impacts: Record<string, { type: 'absolute' | 'relative'; schedule: Record<number | string, number> }>,
  elapsedYears: number,
): string {
  const targetImpacts = extractTargetImpacts(impacts);
  const parts: string[] = [];
  for (const [field, impact] of targetImpacts) {
    const value = getScheduleValue(impact.schedule, elapsedYears);
    if (value === 0) continue;
    const label = humanizeField(field);
    if (impact.type === 'relative') {
      parts.push(`${value > 0 ? '+' : ''}${Math.round(value * 100)}% ${label}`);
    } else {
      parts.push(`${value > 0 ? '+' : ''}${value} ${label}`);
    }
  }
  return parts.join(', ');
}

/** The recommended lawsuit ground for an incoming attack, with an estimated win probability. */
export interface SuggestedGround {
  name: string;
  description: string;
  probability: number;
}

/**
 * Suggests the strongest lawsuit ground against a decision's `legalRisks`, using the
 * SAME probability math as real trial resolution (`calculateAdjustedProbability`,
 * `gameLoop.ts` Step 8) evaluated against the attacker's current scrutiny/legal
 * exposure — an estimate shown at investigation tier 3. Real trial probability is
 * still recomputed fresh at resolution time; this never substitutes for it.
 */
export function pickBestGround(
  def: DecisionDefinition,
  elapsedYears: number,
  attackerVars: Pick<PlayerVariables, 'scrutiny' | 'legalExposureRatio'>,
  admin: AdminVariables,
  formulas: FormulaSet,
): SuggestedGround | null {
  if (!def.legalRisks || def.legalRisks.length === 0) return null;
  let best: SuggestedGround | null = null;
  for (const risk of def.legalRisks) {
    const base = getScheduleValue(risk.probability, elapsedYears);
    // Same formula as real trial resolution (calcEngine's calculateAdjustedProbability
    // can exceed 1 for high scrutiny/exposure defendants, which trial resolution treats
    // as a guaranteed win — clamp to [0,1] here purely for a sane percentage display.
    const adjusted = Math.min(1, Math.max(0, calculateAdjustedProbability(base, attackerVars.scrutiny, attackerVars.legalExposureRatio ?? 0, admin, formulas)));
    if (!best || adjusted > best.probability) {
      best = { name: risk.name, description: risk.description, probability: adjusted };
    }
  }
  return best;
}

export class DecisionEngine {
  private definitions = new Map<string, DecisionDefinition>();

  /** Load all decision definitions from game_engine.json */
  setDefinitions(definitions: DecisionDefinition[]): void {
    this.definitions = new Map(definitions.map(d => [d.decision, d]));
  }

  getDef(name: string): DecisionDefinition | undefined {
    return this.definitions.get(name);
  }

  /** Aggregate absolute schedule deltas across multiple decisions for one player. */
  aggregateAbsDeltas(
    deltasList: Array<{ revenueDelta: number; financeCostDelta: number; taxCostDelta: number; receivablesDelta: number; cashDelta: number }>,
  ): { revenueDelta: number; financeCostDelta: number; taxCostDelta: number; receivablesDelta: number; cashDelta: number } {
    let r = 0, f = 0, t = 0, rc = 0, c = 0;
    for (const d of deltasList) {
      r += d.revenueDelta;
      f += d.financeCostDelta;
      t += d.taxCostDelta;
      rc += d.receivablesDelta;
      c += d.cashDelta;
    }
    return { revenueDelta: r, financeCostDelta: f, taxCostDelta: t, receivablesDelta: rc, cashDelta: c };
  }

  // ── Phase A helpers ────────────────────────────────────────

  canDeploy(
    playerDecisions: DeployedDecision[],
    decisionName: string,
    level: 'Strategic' | 'Operational',
    maxStrategic: number,
    maxOperational: number,
  ): { allowed: boolean; reason?: string } {
    const existing = playerDecisions.filter(d => d.definition.decision === decisionName);

    // Can't deploy same decision twice unless the previous one has matured (FORMULAS §9)
    if (existing.length > 0 && !existing[existing.length - 1].isMatured) {
      return { allowed: false, reason: `Previous ${decisionName} hasn't matured yet` };
    }

    const def = this.definitions.get(decisionName);
    if (!def) return { allowed: false, reason: 'Unknown decision' };

    // Forward exclusions — if this decision excludes another, that other must be matured
    for (const excluded of def.excludes) {
      const blocked = playerDecisions.find(d => d.definition.decision === excluded && !d.isMatured);
      if (blocked) {
        return { allowed: false, reason: `${excluded} is still maturing` };
      }
    }

    // Reverse exclusions — symmetrical rule (FORMULAS §10)
    for (const active of playerDecisions) {
      const activeDef = this.definitions.get(active.definition.decision);
      if (activeDef?.excludes.includes(decisionName) && !active.isMatured) {
        return { allowed: false, reason: `${active.definition.decision} blocks this until matured` };
      }
    }

    // Level limits from game_config.json
    const stratCount = playerDecisions.filter(d => d.definition.level === 'Strategic').length;
    const opCount = playerDecisions.filter(d => d.definition.level === 'Operational').length;

    if (level === 'Strategic' && stratCount >= maxStrategic) {
      return { allowed: false, reason: `Max ${maxStrategic} strategic decisions per turn reached` };
    }
    if (level === 'Operational' && opCount >= maxOperational) {
      return { allowed: false, reason: `Max ${maxOperational} operational decisions per turn reached` };
    }

    return { allowed: true };
  }

  deploy(_playerId: string, definition: DecisionDefinition, currentYear: number, targetId?: string): DeployedDecision {
    const maturityYears = calcMaturity(definition.impacts);
    return {
      id: crypto.randomUUID(),
      definition,
      deployedYear: currentYear,
      elapsedYears: 0,
      isMatured: maturityYears === 0, // "default" only → matures immediately
      targetId,
    };
  }

  applyImpactsForYear(vars: PlayerVariables, name: string, impacts: Record<string, { type: 'absolute' | 'relative'; schedule: Record<number | string, number> }>, elapsedYears: number, currentYear?: number): import('./calcEngine.js').ApplyImpactsResult {
    const result = applyDecisionImpacts(vars, name, impacts, elapsedYears, currentYear);
    return result;
  }

  /**
   * Extract target.* fields from a decision's impacts for cross-player resolution.
   * Returns the cleaned field map (without "target." prefix) to be applied to the target player.
   */
  getTargetImpacts(impacts: Record<string, { type: 'absolute' | 'relative'; schedule: Record<number | string, number> }>): Map<string, { type: 'absolute' | 'relative'; schedule: Record<number | string, number> }> {
    return extractTargetImpacts(impacts);
  }

  /**
   * Collect this turn's cross-player effects from a player's active decisions (FORMULAS §0/A1):
   * every active decision that was deployed against an opponent (`targetId` set) and carries
   * `target.*` fields contributes one entry, evaluated at its own current `elapsedYears` so the
   * effect follows the same maturity schedule as the decision's self-impacts.
   */
  collectTargetImpacts(activeDecisions: DeployedDecision[]): TargetImpactResult[] {
    const results: TargetImpactResult[] = [];
    for (const d of activeDecisions) {
      if (!d.targetId) continue;
      const impacts = extractTargetImpacts(d.definition.impacts);
      if (impacts.size === 0) continue;
      results.push({ targetId: d.targetId, impacts, elapsedYears: d.elapsedYears });
    }
    return results;
  }

  // ── Phase B helpers ────────────────────────────────────────

  /** Advance all active decisions by one year and apply their impacts. */
  advanceAndApply(
    _playerId: string,
    vars: PlayerVariables,
    activeDecisions: DeployedDecision[],
    currentYear: number,
  ): { updatedVars: PlayerVariables; updatedActiveDecisions: DeployedDecision[]; newDepreciationEntries: import('./calcEngine.js').DepreciationLedgerEntry[]; absDeltas: { revenueDelta: number; financeCostDelta: number; taxCostDelta: number; receivablesDelta: number; cashDelta: number } } {
    let v = { ...vars };
    const decisions = [...activeDecisions];
    const allNewDepEntries: import('./calcEngine.js').DepreciationLedgerEntry[] = [];
    const allAbsDeltas: Array<{ revenueDelta: number; financeCostDelta: number; taxCostDelta: number; receivablesDelta: number; cashDelta: number }> = [];

    for (const d of decisions) {
      d.elapsedYears++;

      // Check maturity (FORMULAS §9)
      const threshold = calcMaturity(d.definition.impacts);
      if (!d.isMatured && d.elapsedYears >= threshold) {
        d.isMatured = true;
      }

      // Apply impacts — relative instances additively across matured instances
      const result = this.applyInstance(v, d.definition.decision, d.definition.impacts, d.elapsedYears, d.isMatured, currentYear);
      v = result.updatedVars;
      allNewDepEntries.push(...result.newDepreciationEntries);
      allAbsDeltas.push(result.absDeltas);
    }

    return {
      updatedVars: v,
      updatedActiveDecisions: decisions,
      newDepreciationEntries: allNewDepEntries,
      absDeltas: this.aggregateAbsDeltas(allAbsDeltas),
    };
  }

  private applyInstance(
    vars: PlayerVariables,
    decisionName: string,
    impacts: Record<string, { type: 'absolute' | 'relative'; schedule: Record<number | string, number> }>,
    elapsedYears: number,
    _isMatured: boolean,
    currentYear: number,
  ): { updatedVars: PlayerVariables; newDepreciationEntries: import('./calcEngine.js').DepreciationLedgerEntry[]; absDeltas: { revenueDelta: number; financeCostDelta: number; taxCostDelta: number; receivablesDelta: number; cashDelta: number } } {
    const result = applyDecisionImpacts(vars, decisionName, impacts, elapsedYears, currentYear);
    return result;
  }
}
