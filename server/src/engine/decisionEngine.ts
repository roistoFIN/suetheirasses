/**
 * Decision Engine — manages decision deployment, exclusion rules, maturity tracking,
 * and impact application.
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
  /** True once a lost lawsuit cancelled this instance's forthcoming effects — see `hasPermanentEffect`/`canDeploy` and CLAUDE.md. */
  voidedByLawsuit: boolean;
  /** True the instant ANY lawsuit is filed against this specific instance — first come,
   * first served: once set, no further lawsuit (from anyone, on any ground) can ever
   * target this same instance again, regardless of how that first case resolves (settled,
   * won, or lost). See CLAUDE.md's "one lawsuit per decision instance, ever" section. */
  everSued: boolean;
  /** For a Buy Shares instance only — the fraction of the target company actually
   * acquired in this single transaction, stamped once at execution time (`GameLoop`'s
   * share-transaction step). Gates `legalRiskConditions.minPercentAcquiredInSingleTransaction`
   * generically — see `meetsLegalRiskConditions`/CLAUDE.md. */
  acquisitionFraction?: number;
}

/**
 * True if any of a decision's own (non-`target.*`/`competitor*`) impact fields carry a
 * non-zero `'default'` schedule value — meaning that field's effect keeps being re-applied
 * every turn forever once the schedule's explicit years run out, not just a one-time bump
 * (see `getScheduleValue`'s doc comment). Used to gate `canDeploy`'s redeploy-lock rule: a
 * decision that already delivered this kind of permanent improvement once (matured without
 * being voided by a lost lawsuit) can never be redeployed to stack it again. Deliberately
 * scoped to the decision's own fields only — `canDeploy` ORs this with the equivalent
 * `target.*` check (`hasPermanentImpactMap` over `getTargetImpacts`) itself, rather than
 * folding both into one function, since `collectTargetImpacts`'s statute-of-limitations
 * cutoff only ever needs the target-side half.
 */
export function hasPermanentEffect(def: DecisionDefinition): boolean {
  for (const [field, impact] of Object.entries(def.impacts)) {
    if (field.startsWith('target.') || field.startsWith('competitor')) continue;
    if ((impact.schedule['default'] ?? 0) !== 0) return true;
  }
  return false;
}

/** Same "non-zero 'default' schedule value somewhere" check as `hasPermanentEffect`, but
 * over an already-extracted target-impact map (e.g. Bot Attack's `target.outrage`) rather
 * than a whole `DecisionDefinition` — used by `collectTargetImpacts`'s own
 * statute-of-limitations cutoff, and by `canDeploy`'s redeploy-lock (ORed with
 * `hasPermanentEffect`, so a decision with only a permanent `target.*` effect and no
 * permanent self-effect — e.g. Patent Portfolio's ongoing `target.processingLevel: -0.2` —
 * still blocks its own redeployment while that debuff is live; this was a real gap until
 * audited, since every other permanent-target-effect decision in the seed library happens
 * to also carry a permanent self-cost that gated it incidentally). */
function hasPermanentImpactMap(impacts: Map<string, { type: 'absolute' | 'relative'; schedule: Record<number | string, number> }>): boolean {
  for (const impact of impacts.values()) {
    if ((impact.schedule['default'] ?? 0) !== 0) return true;
  }
  return false;
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

/** Shared formatting core for both summarizeTargetImpacts and summarizeOwnImpacts below. */
function summarizeImpacts(
  impacts: Map<string, { type: 'absolute' | 'relative'; schedule: Record<number | string, number> }>,
  elapsedYears: number,
): string {
  const parts: string[] = [];
  for (const [field, impact] of impacts) {
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

/**
 * Human-readable summary of a decision's current cross-player effect, e.g.
 * "+20 Outrage, -20% Capacity Utilization" — used at investigation tier 2 ("what
 * trouble it is") to describe a DIRECT incoming attack (one with real `target.*`
 * impacts) without yet naming the attacker's suggested lawsuit ground.
 */
export function summarizeTargetImpacts(
  impacts: Record<string, { type: 'absolute' | 'relative'; schedule: Record<number | string, number> }>,
  elapsedYears: number,
): string {
  return summarizeImpacts(extractTargetImpacts(impacts), elapsedYears);
}

/**
 * Human-readable summary of a decision's OWN effect on the player who deployed it, e.g.
 * "-100000 Cash, +40% Installed Capacity" — the tier-2 counterpart to
 * `summarizeTargetImpacts` for an INDIRECT hint (a decision with no `target.*` impacts
 * at all, like New Factory or Water Pumping). There's no cross-player effect to
 * describe for these — impacts routed to a specific other player's variables — so this
 * summarizes what the decision did for its own deployer instead, which is what an
 * investigating rival actually wants to know ("what did they gain from this that I might
 * have grounds to sue over").
 */
export function summarizeOwnImpacts(
  impacts: Record<string, { type: 'absolute' | 'relative'; schedule: Record<number | string, number> }>,
  elapsedYears: number,
): string {
  const ownImpacts = new Map<string, { type: 'absolute' | 'relative'; schedule: Record<number | string, number> }>();
  for (const [field, impact] of Object.entries(impacts)) {
    if (field.startsWith('target.') || field.startsWith('competitor')) continue;
    ownImpacts.set(field, impact);
  }
  return summarizeImpacts(ownImpacts, elapsedYears);
}

/** The recommended lawsuit ground for an incoming attack, with an estimated win probability. */
export interface SuggestedGround {
  name: string;
  description: string;
  probability: number;
  /** Estimated dollar amount that would change hands if this ground is sued over and won
   * — priced the exact same way `LegalEngine.fileLawsuit` prices a real case's `stakes`
   * (see its own doc comment), so the number shown here before filing matches what the
   * real case will actually carry. Not adjusted by probability — this is "what's at
   * stake if it lands," not an expected value. */
  stakes: number;
}

/**
 * Suggests the strongest lawsuit ground against a decision's `legalRisks`, using the
 * SAME probability math as real trial resolution (`calculateAdjustedProbability`,
 * `gameLoop.ts` Step 8) evaluated against the attacker's current scrutiny/legal
 * exposure — an estimate shown at investigation tier 3. Real trial probability is
 * still recomputed fresh at resolution time; this never substitutes for it.
 *
 * `statuteOfLimitationsYears` (`GameSettings.statuteOfLimitationsYears`, default 10)
 * mirrors `LegalEngine.fileLawsuit`'s own time-bar: once `elapsedYears` reaches it, a
 * ground's probability is floored to 0 here too, so a "SUE NOW" suggestion never quotes
 * winnable-looking odds for a decision a real filing would immediately resolve to 0%
 * for being too old. Defaulted so existing callers/tests that don't pass it keep the
 * pre-feature behavior (never time-barred).
 *
 * `alreadyClaimed` (the instance's own `everSued` flag) floors probability to 0 the same
 * way — once any lawsuit has ever been filed against this specific instance, no further
 * one can win, first-come-first-served (see CLAUDE.md), so a suggestion must never quote
 * winnable odds for an instance that's already been claimed.
 *
 * `meetsConditions` (see `meetsLegalRiskConditions`) floors probability to 0 the same way
 * again — a decision like Buy Shares can carry `legalRiskConditions` gating its legal
 * risk on how much of a single transaction it actually was (e.g.
 * `minPercentAcquiredInSingleTransaction`); a purchase too small to cross that threshold
 * has no real legal exposure to suggest suing over.
 */
export function pickBestGround(
  def: DecisionDefinition,
  elapsedYears: number,
  attackerVars: PlayerVariables,
  admin: AdminVariables,
  formulas: FormulaSet,
  statuteOfLimitationsYears = Infinity,
  alreadyClaimed = false,
  meetsConditions = true,
): SuggestedGround | null {
  if (!def.legalRisks || def.legalRisks.length === 0) return null;
  const timeBarred = alreadyClaimed || !meetsConditions || elapsedYears >= statuteOfLimitationsYears;
  let best: SuggestedGround | null = null;
  for (const risk of def.legalRisks) {
    const base = timeBarred ? 0 : getScheduleValue(risk.probability, elapsedYears);
    // Same formula as real trial resolution (calcEngine's calculateAdjustedProbability
    // can exceed 1 for high scrutiny/exposure defendants, which trial resolution treats
    // as a guaranteed win — clamp to [0,1] here purely for a sane percentage display.
    const adjusted = Math.min(1, Math.max(0, calculateAdjustedProbability(base, attackerVars.scrutiny, attackerVars.legalExposureRatio ?? 0, admin, formulas)));
    if (!best || adjusted > best.probability) {
      // Mirrors LegalEngine.fileLawsuit's own stakes calc exactly (same fixed
      // 'default'-or-year-1 schedule read, same relative-vs-absolute branch) — see
      // SuggestedGround's doc comment for why this has to match the real thing.
      const scheduleValue = risk.impact.schedule['default'] ?? risk.impact.schedule[1] ?? 0;
      const targetFieldValue = (attackerVars as unknown as Record<string, unknown>)[risk.impact.target];
      const stakes = risk.impact.type === 'relative'
        ? Math.abs((typeof targetFieldValue === 'number' ? targetFieldValue : 0) * scheduleValue)
        : Math.abs(scheduleValue);
      best = { name: risk.name, description: risk.description, probability: adjusted, stakes };
    }
  }
  return best;
}

/**
 * Generically checks a decision's `legalRiskConditions` (a free-form, data-driven bag —
 * never a hardcoded decision name, see CLAUDE.md) against one deployed instance's own
 * recorded state. Today the only condition either engine or admin data actually sets is
 * `minPercentAcquiredInSingleTransaction` (Buy Shares) — checked against the instance's
 * `acquisitionFraction` (stamped once at execution time by the share-transaction step).
 * A decision with no `legalRiskConditions` at all (the overwhelming majority of the
 * library) always meets them trivially. An admin-added future condition this function
 * doesn't recognize is likewise ignored (treated as met) rather than blocking legal risk
 * for a decision nobody's wired a check for yet.
 */
export function meetsLegalRiskConditions(def: DecisionDefinition, instance: { acquisitionFraction?: number }): boolean {
  const minPercent = def.legalRiskConditions?.minPercentAcquiredInSingleTransaction;
  if (typeof minPercent !== 'number') return true;
  return (instance.acquisitionFraction ?? 0) >= minPercent;
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
    permanentEffectCooldownYears = Infinity,
  ): { allowed: boolean; reason?: string } {
    const existing = playerDecisions.filter(d => d.definition.decision === decisionName);

    // Can't deploy same decision twice unless the previous one has matured
    if (existing.length > 0 && !existing[existing.length - 1].isMatured) {
      return { allowed: false, reason: `Previous ${decisionName} hasn't matured yet` };
    }

    const def = this.definitions.get(decisionName);
    if (!def) return { allowed: false, reason: 'Unknown decision' };

    // A decision with a permanent (non-zero 'default') effect blocks redeploying itself
    // for `gameSettings.permanentEffectCooldownYears` turns after an instance matures —
    // otherwise deploying it again immediately would stack the same permanent KPI boost
    // with zero real investment/turn cost in between. Deliberately a SEPARATE, normally
    // much shorter clock from `statuteOfLimitationsYears` (which keeps governing legal
    // liability and how long a `target.*` effect keeps re-applying, completely unchanged)
    // — this used to reuse `statuteOfLimitationsYears` itself (10 by default), which, given
    // typical games run ~12-15 rounds, made every permanent-effect decision (New Factory,
    // Vertical Integration, Raw Material Monopoly, Venture Capital Shadow Money, Patent
    // Portfolio, Bot Attack, ...) an effective one-time-per-game pick unless an opponent
    // happened to sue it into `voidedByLawsuit` — even though the game's own documented
    // stacking math (`installedCapacity = base * (1 + 0.4 + 0.4)` for two matured New
    // Factorys) assumes redeploying the same permanent-effect decision more than once in a
    // game is normal, intended play. See CLAUDE.md. An instance voided by a lost lawsuit
    // never got to keep its effect at all, so it never blocks redeployment either.
    //
    // Checked on BOTH the decision's own fields (`hasPermanentEffect`) and its `target.*`
    // fields (`hasPermanentImpactMap` over the extracted target-impact map) — a decision
    // that only carries a permanent `target.*` debuff (no permanent self-effect at all,
    // e.g. Patent Portfolio's ongoing `target.processingLevel: -0.2`) would otherwise be
    // free to redeploy and stack indefinitely the instant its first instance matures, with
    // nothing gating the exact case this rule exists to prevent — just aimed at a rival's
    // KPI instead of the deployer's own. Most `target.*`-bearing decisions in the real
    // library also carry a permanent self-cost that already gates them incidentally (e.g.
    // Bot Attack's own ongoing `operatingExpenses`/`cash` effects), which is why this gap
    // stayed invisible until audited directly against the seed data.
    const hasPermanentTargetEffect = hasPermanentImpactMap(this.getTargetImpacts(def.impacts));
    if ((hasPermanentEffect(def) || hasPermanentTargetEffect) && existing.some(d => d.isMatured && !d.voidedByLawsuit && d.elapsedYears < permanentEffectCooldownYears)) {
      return { allowed: false, reason: `${decisionName} is still delivering its permanent effect and cannot be redeployed yet` };
    }

    // Forward exclusions — if this decision excludes another, that other must be matured
    for (const excluded of def.excludes) {
      const blocked = playerDecisions.find(d => d.definition.decision === excluded && !d.isMatured);
      if (blocked) {
        return { allowed: false, reason: `${excluded} is still maturing` };
      }
    }

    // Reverse exclusions — symmetrical rule
    for (const active of playerDecisions) {
      const activeDef = this.definitions.get(active.definition.decision);
      if (activeDef?.excludes.includes(decisionName) && !active.isMatured) {
        return { allowed: false, reason: `${active.definition.decision} blocks this until matured` };
      }
    }

    // NOTE: there is deliberately no "max N strategic/N operational decisions" check here
    // anymore — see CLAUDE.md's "canDeploy's level-limit check counted a player's entire
    // lifetime of active decisions" section for why a per-turn budget check has no business
    // being computed from `playerDecisions` (a player's ENTIRE historical active-decisions
    // list, which only ever grows and never shrinks) at all. The real "at most
    // maxStrategicDecisionsPerTurn/maxOperationalDecisionsPerTurn decisions of each level
    // per turn" budget is enforced by the caller, `GameLoop.processNewDecisions`
    // (`sub[bucket].slice(0, maxForBucket)`), which only ever attempts that many entries
    // from THIS turn's submission — no count needs recomputing in here at all.

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
      voidedByLawsuit: false,
      everSued: false,
    };
  }

  applyImpactsForYear(vars: PlayerVariables, impacts: Record<string, { type: 'absolute' | 'relative'; schedule: Record<number | string, number> }>, elapsedYears: number, currentYear?: number): import('./calcEngine.js').ApplyImpactsResult {
    const result = applyDecisionImpacts(vars, impacts, elapsedYears, currentYear);
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
   * Collect this turn's cross-player effects from a player's active decisions:
   * every active decision that was deployed against an opponent (`targetId` set) and carries
   * `target.*` fields contributes one entry, evaluated at its own current `elapsedYears` so the
   * effect follows the same maturity schedule as the decision's self-impacts.
   */
  collectTargetImpacts(activeDecisions: DeployedDecision[], statuteOfLimitationsYears = Infinity): TargetImpactResult[] {
    const results: TargetImpactResult[] = [];
    for (const d of activeDecisions) {
      if (!d.targetId) continue;
      if (d.voidedByLawsuit) continue;
      const impacts = extractTargetImpacts(d.definition.impacts);
      if (impacts.size === 0) continue;
      // A permanent target effect (e.g. Bot Attack's indefinite target.outrage) stops the
      // same way a permanent own-effect does — once the instance has been active as long
      // as it could still be sued over, it's no longer contributing anything.
      if (d.elapsedYears >= statuteOfLimitationsYears && hasPermanentImpactMap(impacts)) continue;
      results.push({ targetId: d.targetId, impacts, elapsedYears: d.elapsedYears });
    }
    return results;
  }

  // ── Phase B helpers ────────────────────────────────────────

  /**
   * Advance all active decisions by one year and apply their impacts.
   *
   * A decision's own (non-`target.*`) impact is applied at most once per explicit
   * schedule year, plus exactly once more at the moment it first falls through to
   * `'default'` (i.e. the turn maturity is reached) — never again after that. Before this,
   * every turn past maturity re-ran `applyInstance` at the (always-'default'-returning)
   * current `elapsedYears`, so a `'default'` value — whether a `relative` field
   * (`installedCapacity: {default: 0.4}`) or an `absolute` one
   * (`operatingExpenses: {default: 25000}`) — kept compounding/accumulating every single
   * turn for as long as the instance stayed alive (bounded only by
   * `statuteOfLimitationsYears`, default 10 turns — not actually "forever," but 10 turns of
   * continuous ×1.4 compounding is still ~29x). A real, reported finding from a randomized
   * multi-round simulation: New Factory's `installedCapacity` grew 350 → 490 → 686 → 960 →
   * 1345 → 1882 → 2635 over 7 turns from a single instance with zero other activity, and
   * the *same* mechanic on the cost side (`operatingExpenses`/`capacityUtilization`) was
   * independently driving early, hard-to-explain bankruptcies. "Permanent effect" was
   * meant to describe a one-time, lasting step-change ("this factory permanently raised
   * your capacity/costs"), not a perpetual annual re-investment nobody made — matches how
   * multiple *separate* instances were already documented to combine (`base * (1 + 0.4 +
   * 0.4)`, summed once against a stable base — a framing incompatible with any single
   * instance's own value compounding against itself turn over turn). See CLAUDE.md's
   * "advanceAndApply re-applied a matured decision's default effect every turn forever"
   * section.
   *
   * Deliberately scoped to a decision's *own* impacts only — `target.*` effects
   * (`collectTargetImpacts`/`applyTargetImpacts`, an ongoing attack against another player)
   * keep their existing "re-applies every turn until the statute of limitations" behavior
   * unchanged; that's a separate, offense/defense-balance question nobody asked to revisit
   * here, and changing it would weaken every attacking decision in the library at once.
   */
  advanceAndApply(
    _playerId: string,
    vars: PlayerVariables,
    activeDecisions: DeployedDecision[],
    currentYear: number,
    statuteOfLimitationsYears = Infinity,
  ): { updatedVars: PlayerVariables; updatedActiveDecisions: DeployedDecision[]; newDepreciationEntries: import('./calcEngine.js').DepreciationLedgerEntry[]; absDeltas: { revenueDelta: number; financeCostDelta: number; taxCostDelta: number; receivablesDelta: number; cashDelta: number } } {
    let v = { ...vars };
    const decisions = [...activeDecisions];
    const allNewDepEntries: import('./calcEngine.js').DepreciationLedgerEntry[] = [];
    const allAbsDeltas: Array<{ revenueDelta: number; financeCostDelta: number; taxCostDelta: number; receivablesDelta: number; cashDelta: number }> = [];

    for (const d of decisions) {
      d.elapsedYears++;

      // Check maturity
      const threshold = calcMaturity(d.definition.impacts);
      if (!d.isMatured && d.elapsedYears >= threshold) {
        d.isMatured = true;
      }

      // A lawsuit lost over this instance cancels its forthcoming effects entirely —
      // whatever was already applied in earlier turns stays, but no further schedule value
      // (including a permanent 'default' one) is ever applied again.
      if (d.voidedByLawsuit) continue;

      // A permanent ('default') effect stops being re-applied once this instance has been
      // active as long as it could still be sued over (gameSettings.statuteOfLimitationsYears)
      // — matches canDeploy's redeploy lock, which lifts at the exact same point. Forcing
      // isMatured here too covers the (unusual) admin config where the statute is set
      // shorter than the decision's own maturity schedule.
      if (hasPermanentEffect(d.definition) && d.elapsedYears >= statuteOfLimitationsYears) {
        d.isMatured = true;
        continue;
      }

      // Apply once per explicit schedule year, plus once more the turn 'default' is first
      // reached (elapsedYears === threshold) — never again after (elapsedYears > threshold)
      // — see this method's doc comment for why. A decision with no explicit years at all
      // (threshold 0, instant maturity) applies its 'default' exactly once, at deployment
      // (Step 1's applyImpactsForYear call with elapsedYears=0), and is skipped here on
      // every subsequent turn (elapsedYears starts at 1 on the very next call, already > 0).
      if (d.elapsedYears > threshold) continue;

      // Apply impacts — relative instances additively across matured instances
      const result = this.applyInstance(v, d.definition.impacts, d.elapsedYears, d.isMatured, currentYear);
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
    impacts: Record<string, { type: 'absolute' | 'relative'; schedule: Record<number | string, number> }>,
    elapsedYears: number,
    _isMatured: boolean,
    currentYear: number,
  ): { updatedVars: PlayerVariables; newDepreciationEntries: import('./calcEngine.js').DepreciationLedgerEntry[]; absDeltas: { revenueDelta: number; financeCostDelta: number; taxCostDelta: number; receivablesDelta: number; cashDelta: number } } {
    const result = applyDecisionImpacts(vars, impacts, elapsedYears, currentYear);
    return result;
  }
}
