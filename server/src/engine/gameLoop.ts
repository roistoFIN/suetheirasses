/**
 * Game Loop Orchestrator — manages the full turn resolution cycle per FORMULAS.md.
 *
 * Each GAME_PHASE turn follows this sequence for ALL players simultaneously:
 *
 * Phase A — Decision Collection (interactive, within timer):
 *   Players submit strategic + operational decisions via socket events.
 *
 * Phase B — Turn Resolution (pure computation, when timer expires or all submit):
 *   1. Advance active decision instances by one year (FORMULAS §9)
 *   2. Apply depreciation ledger updates (FORMULAS §1)
 *   3. Calculate competitiveness & market share across all players (FORMULAS §2)
 *   4. Calculate volume per player with supply cap (FORMULAS §3)
 *   5. Calculate P&L per player (FORMULAS §4)
 *   6. Update balance sheet per player (FORMULAS §5)
 *   7. Evaluate legal risks from new decisions → create cases (FORMULAS §6)
 *   8. Lock open cases for trial / resolve awaiting trials
 *   9. Calculate risk gauge per player (FORMULAS §7)
 *
 * GameLoop is a pure computation engine — it never touches Prisma or Socket.IO. It takes
 * each player's current DB row (company variables + engine state) as plain input and
 * returns a TurnResolutionOutcome: the broadcast-ready result plus the exact company
 * updates and bankruptcy flags the caller needs to persist. GameEngine
 * (server/src/socket/gameEngine.ts) owns loading that input before the call and
 * persisting/broadcasting the outcome afterward.
 */

import type {
  PlayerVariables,
  AdminVariables,
  DecisionDefinition,
  GameConfig,
  PlayerTurnResult,
  TurnResolutionResult,
  LegalCaseData,
  SubmittedDecisions,
  IncomingAttackInfo,
  KpiSnapshotPoint,
} from '@suetheirasses/shared';
import {
  applyDepreciation,
  calculateCompetitivenessAndMarketShare,
  calculateVolume,
  calculatePL,
  updateBalanceSheet,
  calculateRiskGauge,
  calculateMaturityYears as calcMaturity,
  calculateAdjustedProbability,
  calculateLegalExposureRatio,
  applyTargetImpacts,
} from './calcEngine.js';
import { DecisionEngine, MAX_INVESTIGATION_LEVEL, summarizeTargetImpacts, summarizeOwnImpacts, pickBestGround } from './decisionEngine.js';
import type { DeployedDecision, TargetImpactResult } from './decisionEngine.js';
import { LegalEngine } from './legalEngine.js';
import { buildFormulaSet, type FormulaSet } from './formulaEngine.js';

// ============================================================
// Public input/output types — the boundary between GameLoop's pure
// computation and the caller's persistence/broadcast responsibilities
// ============================================================

/** One player's DB row as GameLoop needs it — a subset of what Prisma's `player.findMany` (with `company` included) returns. */
export interface EngineDataInput {
  id: string;
  name: string;
  company: {
    variables: unknown;
    engineState: unknown;
  } | null;
}

/** A single asset depreciation schedule entry, tracked per-player inside `Company.engineState`. */
export interface DepreciationEntry {
  id: string;
  assetType: 'assets' | 'intangibleAssets';
  originalValue: number;
  purchaseYear: number;
  usefulLife: number;
  annualAmount: number;
  remainingYears: number;
}

/**
 * A deployed decision instance as stored in `Company.engineState` JSONB — the serialized
 * counterpart of `DeployedDecision`. Stores `definitionName` (looked back up against the
 * loaded decision library on read, via `readEngineState`) rather than the full
 * `DecisionDefinition` object, since definitions are static and already loaded from
 * `game_engine.json` at startup — duplicating them per-instance into every player's DB
 * row would be redundant and, if ever read back as `.definitionName` (the reader's actual
 * expectation), silently wrong.
 */
export interface PersistedDecisionInstance {
  id: string;
  definitionName: string;
  deployedYear: number;
  elapsedYears: number;
  isMatured: boolean;
  /** The player this decision's `target.*` impacts route to — set when deployed against an opponent. */
  targetId?: string;
}

/** The `Company` row fields the caller must write back to the DB for one still-active player after a turn resolves. */
export interface CompanyPersistUpdate {
  playerId: string;
  cash: number;
  variables: PlayerVariables;
  engineState: {
    activeDecisions: PersistedDecisionInstance[];
    depreciationLedger: DepreciationEntry[];
    legalCases: LegalCaseData[];
    /** "Dig Deeper" progress: attacking decision instance id -> investigation level (1-3). */
    investigations: Record<string, number>;
  };
}

/** A player eliminated this turn — the caller must flag them bankrupt in the DB and broadcast `player:bankrupt`. */
export interface BankruptedPlayer {
  playerId: string;
  playerName: string;
  /** This player's actual (negative) cash balance at the moment of elimination — the caller must
   * persist this to their Company row too, since a bankrupted player is excluded from
   * `companyUpdates` (their engine state is done being touched) and would otherwise keep
   * whatever positive `cash` the DB had from their last still-active turn forever, including
   * on the Game Over / final-standings screen. */
  finalCash: number;
}

/** Everything resolveTurn computed: the `turn:resolved` broadcast payload plus the side effects the caller must apply. */
export interface TurnResolutionOutcome {
  result: TurnResolutionResult;
  companyUpdates: CompanyPersistUpdate[];
  bankruptedPlayers: BankruptedPlayer[];
}

/** Result of a `digDeeper` call — a lightweight, single-player, out-of-band mutation (not part of turn resolution). */
export type DigDeeperOutcome =
  | { success: false; reason: 'player_not_found' | 'invalid_attack' | 'already_fully_investigated' | 'insufficient_funds' }
  | {
      success: true;
      attackId: string;
      cost: number;
      newCash: number;
      attack: IncomingAttackInfo;
      /**
       * The requesting player's full `variables` JSONB to persist, cash already decremented.
       * Must be written alongside the `cash` column — `GameLoop` reads cash from
       * `variables.cash` (via `readVariables`), not the column, so writing only the column
       * would leave the next call (or the next normal turn resolution) reading stale cash.
       */
      variables: PlayerVariables;
      /** The requesting player's full engineState to persist — existing keys carried through unchanged, only `investigations` updated. */
      engineStateUpdate: CompanyPersistUpdate['engineState'];
    };

/** Result of a `chargeLawsuitFilingFee` call — a lightweight, single-player, out-of-band mutation (not part of turn resolution). */
export type LawsuitFilingFeeOutcome =
  | { success: false; reason: 'player_not_found' | 'insufficient_funds' | 'limit_reached' }
  | {
      success: true;
      cost: number;
      newCash: number;
      /** The requesting player's full `variables` JSONB to persist, cash already decremented —
       * same "must be written alongside the `cash` column" requirement as `DigDeeperOutcome.variables`. */
      variables: PlayerVariables;
    };

/** One party's persisted-state update from a `makeOffer`/`acceptOffer`/`goToCourt` call —
 * always needs its `engineState` written (the case changed inside it, even if nothing
 * else did); `cash`/`variables` are only present for the party whose cash actually moved
 * (a settlement, from `acceptOffer` or Step 8b's stale-offer auto-settle), same "must
 * stay in sync with the `cash` column" requirement as `DigDeeperOutcome.variables`. */
export interface LegalCaseSideUpdate {
  playerId: string;
  cash?: number;
  variables?: PlayerVariables;
  engineState: CompanyPersistUpdate['engineState'];
}

/** Result of a `makeOffer`/`acceptOffer`/`goToCourt` call — a two-party, out-of-band
 * mutation (not part of turn resolution). On success, the caller (`GameEngine`) persists
 * both `plaintiff` and `defendant` updates and emits `case` to both parties' sockets. */
export type LegalCaseActionOutcome =
  | {
      success: false;
      reason:
        | 'case_not_found'
        | 'not_negotiating'
        | 'not_a_party'
        | 'not_your_turn'
        | 'no_offer_to_accept'
        | 'invalid_amount'
        | 'not_defendant'
        | 'already_investigated'
        | 'insufficient_funds';
    }
  | {
      success: true;
      case: LegalCaseData;
      plaintiff: LegalCaseSideUpdate;
      defendant: LegalCaseSideUpdate;
    };

/** Result of a `predictFutureKpis` call — up to `turnsAhead` future points, fewer if the simulation shows the player going bankrupt partway through. */
export interface KpiPrediction {
  predicted: KpiSnapshotPoint[];
  bankruptAtRound?: number;
}

/** One active decision instance, read-only summary for narrating a rival's "annual report" (`GameEngine.getAnnualReport`). */
export interface ActiveDecisionSummary {
  instanceId: string;
  decisionName: string;
  description: string;
  deployedYear: number;
  elapsedYears: number;
}

// ============================================================
// Internal types — not exported, used only within this module
// ============================================================

/** Engine state stored per-player inside Company.variables JSONB */
interface CompanyEngineState {
  activeDecisions: DeployedDecision[];
  depreciationLedger: DepreciationEntry[];
  legalCases: LegalCaseData[];
  investigations: Record<string, number>;
}

interface PlayerTurnContext {
  playerId: string;
  playerName: string;
  vars: PlayerVariables;
  submittedDecisions: SubmittedDecisions | null;
  engineState: CompanyEngineState;
  /** cash_i(edellinen vuoro) — cash as loaded at turn start, before any of this turn's effects (FORMULAS §16 waterfall pool). */
  prevCash: number;
  /** Absolute deltas from newly deployed decisions on this turn (applied in processNewDecisions). */
  newDecisionAbsDeltas?: { revenueDelta: number; financeCostDelta: number; taxCostDelta: number; receivablesDelta: number; cashDelta: number };
}

export class GameLoop {
  private decisionEngine = new DecisionEngine();
  private legalEngine = new LegalEngine();
  private config: GameConfig;
  private adminVars: AdminVariables;
  // The pure, scalar, named-input formulas from FORMULAS.md §2-§7 — DB-backed
  // (Formula table), loaded via loadFormulas() same as decisions/config. Empty
  // until GameEngine.loadGameData() populates it at startup (before the server
  // accepts connections), so this is never read before it's real.
  private formulas: FormulaSet = new Map();

  // Per-room turn state (decisions submitted during Phase A)
  private submissions = new Map<string, Map<string, SubmittedDecisions>>();

  constructor(config: GameConfig) {
    this.config = config;
    this.adminVars = config.adminVariables;
  }

  /**
   * Replace gameSettings/playerStartingValues/adminVariables in place — called both
   * for the initial DB-backed load (`GameEngine.loadGameData`) and every later admin
   * edit via `/admin` (`GameEngine.updateGameConfigData`). Takes effect on the next
   * turn resolved after the call; nothing in-flight needs to be re-run.
   */
  updateConfig(config: GameConfig): void {
    this.config = config;
    this.adminVars = config.adminVariables;
  }

  /** Load all decision definitions — from the DB via GameEngine.loadGameData(), not
   * from game_engine.json directly (that file is now seed-only, see prisma/seed.ts).
   * Safe to call again any time — DecisionEngine/LegalEngine just replace their
   * internal maps, so an admin edit takes effect on the next turn immediately. */
  loadDecisions(definitions: DecisionDefinition[]): void {
    this.decisionEngine.setDefinitions(definitions);
    this.legalEngine.setDefinitions(definitions);
  }

  /** Compile and load the named formulas from FORMULAS.md §2-§7 — from the DB via
   * GameEngine.loadGameData(). Safe to call again any time (GameEngine.updateFormula
   * does so after every admin edit) — replaces the whole set outright, taking effect
   * on the next turn resolved. */
  loadFormulas(rows: Array<{ key: string; expression: string }>): void {
    this.formulas = buildFormulaSet(rows);
  }

  // ============================================================
  // Phase A — Decision Collection
  // ============================================================

  submitDecisions(roomId: string, playerId: string, decisions: SubmittedDecisions): boolean {
    if (!this.submissions.has(roomId)) this.submissions.set(roomId, new Map());
    this.submissions.get(roomId)!.set(playerId, decisions);
    return true;
  }

  getSubmissionCount(roomId: string): number {
    return this.submissions.get(roomId)?.size ?? 0;
  }

  clearSubmissions(roomId: string): void {
    this.submissions.delete(roomId);
  }

  // ============================================================
  // Phase B — Turn Resolution (the core game loop step)
  // ============================================================

  resolveTurn(roomId: string, round: number, players: EngineDataInput[]): TurnResolutionOutcome {
    const t0 = Date.now();

    const dbPlayers = players;
    if (dbPlayers.length === 0) {
      return { result: { round, players: [], gameOver: false }, companyUpdates: [], bankruptedPlayers: [] };
    }

    // ── Build in-memory context per player ─────────────────────
    const ctxs = new Map<string, PlayerTurnContext>();
    const playerIds: string[] = [];

    for (const p of dbPlayers) {
      const company = p.company!;
      let vars = this.readVariables(company.variables as any);

      // First turn: seed starting values
      if (!vars.cash && !vars.assets) {
        vars = this.startingVars();
      }

      // Load engine state from JSONB on Company
      const engineState = this.readEngineState(company);

      ctxs.set(p.id, {
        playerId: p.id,
        playerName: p.name,
        vars,
        submittedDecisions: this.submissions.get(roomId)?.get(p.id) ?? null,
        engineState,
        prevCash: vars.cash,
        newDecisionAbsDeltas: undefined,
      });
      playerIds.push(p.id);
    }

    // ── Step 1 — Process newly submitted decisions ─────────────
    // Snapshot how many decisions were already active BEFORE this turn's new
    // submissions get deployed — Step 2 must only advance/re-apply THOSE, never
    // the ones Step 1 is about to push. A decision deployed this same turn
    // already gets its one deployment-year impact applied right here in Step 1
    // (processNewDecisions → applyImpactsForYear, elapsedYears=0); if Step 2 also
    // advanced it, its impact would apply a second time in the same turn it was
    // deployed (see CLAUDE.md's "A decision deployed this turn was double-
    // applying its own impact" section — a real, reproduced bug this snapshot
    // fixes, not a hypothetical).
    const preTurnActiveCount = new Map<string, number>();
    for (const [pid, ctx] of ctxs) {
      preTurnActiveCount.set(pid, ctx.engineState.activeDecisions.length);
    }

    for (const [, ctx] of ctxs) {
      if (!ctx.submittedDecisions) continue;
      this.processNewDecisions(ctx, round);
    }

    // ── Step 2 — Advance pre-existing active decisions by one year ──────
    // Extract absolute schedule deltas directly from impact application (FORMULAS §4-§5)
    const absDeltasMap = new Map<string, { revenueDelta: number; financeCostDelta: number; taxCostDelta: number; receivablesDelta: number; cashDelta: number }>();
    const varsList: PlayerVariables[] = [];
    const targetImpactQueue: TargetImpactResult[] = [];
    for (const [pid, ctx] of ctxs) {
      // Only the decisions present before Step 1 ran get advanced — anything Step 1
      // just pushed is appended (unadvanced, still at elapsedYears 0) after.
      const existingCount = preTurnActiveCount.get(pid) ?? 0;
      const preExisting = ctx.engineState.activeDecisions.slice(0, existingCount);
      const justDeployed = ctx.engineState.activeDecisions.slice(existingCount);
      const result = this.decisionEngine.advanceAndApply(
        pid,
        ctx.vars,
        preExisting,
        round,
      );
      ctx.vars = result.updatedVars;
      ctx.engineState.activeDecisions = [...result.updatedActiveDecisions, ...justDeployed];

      // Merge newly created depreciation entries into the ledger
      for (const entry of result.newDepreciationEntries) {
        ctx.engineState.depreciationLedger.push(entry);
      }

      // Merge with any absolute deltas from newly deployed decisions on this turn (processNewDecisions already applied them to ctx.vars)
      const newDecisionAbsDeltas = ctx.newDecisionAbsDeltas ?? { revenueDelta: 0, financeCostDelta: 0, taxCostDelta: 0, receivablesDelta: 0, cashDelta: 0 };
      absDeltasMap.set(pid, {
        revenueDelta: result.absDeltas.revenueDelta + newDecisionAbsDeltas.revenueDelta,
        financeCostDelta: result.absDeltas.financeCostDelta + newDecisionAbsDeltas.financeCostDelta,
        taxCostDelta: result.absDeltas.taxCostDelta + newDecisionAbsDeltas.taxCostDelta,
        receivablesDelta: result.absDeltas.receivablesDelta + newDecisionAbsDeltas.receivablesDelta,
        cashDelta: result.absDeltas.cashDelta + newDecisionAbsDeltas.cashDelta,
      });

      // Collect this player's outgoing target.* effects (FORMULAS §0/A1) — applied after
      // every player has advanced, so it doesn't matter which player's turn is processed
      // first in this loop.
      targetImpactQueue.push(...this.decisionEngine.collectTargetImpacts(ctx.engineState.activeDecisions));

      varsList.push(result.updatedVars);
    }

    // Apply queued target.* effects to their targets, then refresh varsList so the
    // Step 4 competitiveness/market-share calc sees the post-attack state.
    for (const entry of targetImpactQueue) {
      if (entry.targetId === undefined) continue;
      const targetCtx = ctxs.get(entry.targetId);
      if (!targetCtx) continue; // target no longer in the game (already bankrupt)
      targetCtx.vars = applyTargetImpacts(targetCtx.vars, entry.impacts, entry.elapsedYears);
    }
    for (let i = 0; i < playerIds.length; i++) {
      varsList[i] = ctxs.get(playerIds[i])!.vars;
    }

    // ── Step 3 — Depreciation ledger (FORMULAS §1) ────────────
    const depreciationMap = new Map<string, number>();
    for (const [pid, ctx] of ctxs) {
      const depResult = applyDepreciation(ctx.vars, ctx.engineState.depreciationLedger, round);
      ctx.vars = depResult.updatedVars;
      ctx.engineState.depreciationLedger = depResult.updatedLedger;
      depreciationMap.set(pid, depResult.totalDepreciation);
    }

    // ── Step 4 — Competitiveness & market share (FORMULAS §2) ─
    const marketShares = calculateCompetitivenessAndMarketShare(playerIds, varsList, this.adminVars, this.formulas);
    let si = 0;
    for (const pid of playerIds) {
      varsList[si].marketShare = marketShares.get(pid) || 0;
      // Also update ctx.vars with marketShare
      const ctx = ctxs.get(pid)!;
      ctx.vars.marketShare = varsList[si].marketShare;
      si++;
    }

    // ── Step 5 — Volume with supply cap (FORMULAS §3) ─────────
    const totalVol = this.config.gameSettings.totalMarketVolumeTonnesPerYear;
    for (const [, ctx] of ctxs) {
      ctx.vars.volume = calculateVolume(ctx.vars, ctx.vars.marketShare || 0, totalVol, this.formulas);
    }

    // ── Step 6 — P&L (FORMULAS §4) ────────────────────────────
    const plMap = new Map<string, ReturnType<typeof calculatePL>>();
    for (const [pid, ctx] of ctxs) {
      const dep = depreciationMap.get(pid) ?? 0;
      const deltas = absDeltasMap.get(pid) ?? { revenueDelta: 0, financeCostDelta: 0, taxCostDelta: 0, receivablesDelta: 0, cashDelta: 0 };
      plMap.set(pid, calculatePL(ctx.vars, ctx.vars.volume || 0, dep, this.adminVars, this.formulas, {
        revenueDelta: deltas.revenueDelta,
        financeCostDelta: deltas.financeCostDelta,
        taxCostDelta: deltas.taxCostDelta,
      }));
    }

    // ── Step 7 — Balance sheet (FORMULAS §5) ──────────────────
    // First, load existing legal cases from engineState (before calculating legal exposure).
    // Every case gets persisted into BOTH the plaintiff's and the defendant's own
    // engineState.legalCases at the end of the turn it's active in (Step 12) — each side
    // needs it in their own persisted state — so it's present in two different players'
    // engineState by the time it's loaded back here. Dedupe by id (last write wins, though
    // both copies are always identical) or this list — and, since Step 12 persists whatever
    // it finds back into every party's engineState again, the duplication too — doubles
    // every subsequent turn.
    const allCasesById = new Map<string, LegalCaseData>();
    for (const [, ctx] of ctxs) {
      for (const c of ctx.engineState.legalCases) {
        if (c.status !== 'resolved') {
          allCasesById.set(c.id, c);
        }
      }
    }
    const allCases: LegalCaseData[] = Array.from(allCasesById.values());

    // Calculate legal exposure for each player from their open cases
    const legalExposureMap = new Map<string, number>();
    for (const pid of playerIds) {
      const defendantCases = allCases.filter(c => c.defendantId === pid && c.status !== 'resolved');
      const legalExposure = defendantCases.reduce((sum, c) => sum + (c.adjustedProbability ?? c.baseProbability) * c.stakes, 0);
      legalExposureMap.set(pid, legalExposure);
    }

    for (const [pid, ctx] of ctxs) {
      const pl = plMap.get(pid)!;
      const dep = depreciationMap.get(pid) ?? 0;
      const deltas = absDeltasMap.get(pid) ?? { revenueDelta: 0, financeCostDelta: 0, taxCostDelta: 0, receivablesDelta: 0, cashDelta: 0 };
      const legalExposure = legalExposureMap.get(pid) ?? 0;
      const bs = updateBalanceSheet(ctx.vars, pl.netProfit, dep, pl.revenue, legalExposure, this.adminVars, this.formulas, deltas.receivablesDelta);
      ctx.vars.cash = bs.cash;
      ctx.vars.reserves = bs.reserves;
      ctx.vars.receivables = bs.receivables;
      ctx.vars.equity = bs.equity;
      ctx.vars.stockValue = bs.stockValue;
      ctx.vars.legalExposure = bs.legalExposure;
      ctx.vars.legalExposureRatio = calculateLegalExposureRatio(legalExposure, ctx.vars.cash, this.adminVars, this.formulas);
    }

    // Snapshot cases already negotiating BEFORE this turn's filings, for the
    // negotiation-timeout step below — a case filed this turn starts at
    // turnsNegotiating 0 and shouldn't be incremented in the same turn it's created.
    const negotiatingBeforeFiling = allCases.filter(c => c.status === 'negotiating');

    // Tracks cash actually RECEIVED this turn via case transfers per plaintiff — the
    // "case-siirrot: saatu" line of the operating cash flow (FORMULAS §5), feeding the
    // §16 bankruptcy waterfall pool. Declared here (rather than down at Step 9, where it
    // used to live) since a stale-offer auto-settlement in Step 8b is just as real a
    // same-turn cash receipt as a trial payout — both write into this same map.
    const legalReceivedThisTurn = new Map<string, number>();

    // ── Step 8 — Deliberate lawsuit filings (FORMULAS §6) ─────────────────────
    // Lawsuits are never automatic — a player must choose to sue a specific target
    // over a specific ground drawn from that target's actually-deployed decisions,
    // up to maxLawsuitsPerPlayerPerTurn filings per turn.
    const maxLawsuits = this.config.gameSettings.maxLawsuitsPerPlayerPerTurn;
    for (const [, ctx] of ctxs) {
      if (!ctx.submittedDecisions) continue;
      for (const filing of ctx.submittedDecisions.lawsuits.slice(0, maxLawsuits)) {
        const targetCtx = ctxs.get(filing.targetId);
        if (!targetCtx) continue;
        const targetActiveDecisions = targetCtx.engineState.activeDecisions.map(d => ({
          decisionName: d.definition.decision,
          elapsedYears: d.elapsedYears,
        }));

        // Does the plaintiff already know these odds from fully "Dig Deeper"-investigating
        // the underlying attack, and are they suing over its exact suggested ground? Mirrors
        // revealAttack's own level-3 computation exactly (same instance, same attacker vars),
        // since that's the live hint the plaintiff would have seen just before filing.
        // Direct decisions must actually target the plaintiff; indirect ones (no target at
        // all — see isIndirectEffect) just need to be an instance of the cited decision
        // name on the cited defendant, since we're already scoped to `targetCtx`'s own
        // decisions and there's no targeting relationship to further disambiguate by.
        let plaintiffFullyInvestigated = false;
        const attackInstance = targetCtx.engineState.activeDecisions.find((d) => {
          if (d.definition.decision !== filing.decisionName) return false;
          const targetImpacts = this.decisionEngine.getTargetImpacts(d.definition.impacts);
          return this.isIndirectEffect(d.definition, targetImpacts) || d.targetId === ctx.playerId;
        });
        if (attackInstance) {
          const rawLevel = ctx.engineState.investigations[attackInstance.id] ?? 0;
          const level = this.effectiveInvestigationLevel(rawLevel, ctxs.size);
          if (level >= MAX_INVESTIGATION_LEVEL) {
            const best = pickBestGround(attackInstance.definition, attackInstance.elapsedYears, targetCtx.vars, this.adminVars, this.formulas);
            plaintiffFullyInvestigated = best?.name === filing.groundName;
          }
        }

        const newCase = this.legalEngine.fileLawsuit(
          ctx.playerId,
          filing.targetId,
          filing.decisionName,
          filing.groundName,
          targetActiveDecisions,
          roomId,
          plaintiffFullyInvestigated,
        );
        if (newCase) allCases.push(newCase);
      }
    }

    // ── Step 8b — Negotiation timeout / stale-offer auto-settle (design addition,
    // not in FORMULAS.md) ──────────────────────────────────────────────────────
    // FORMULAS.md doesn't model a negotiation phase at all — a case is just "resolved
    // this turn" via a probability draw. The 'negotiating' status and its offer/accept
    // flow (`makeOffer`/`acceptOffer`/`goToCourt` below — instant, out-of-band actions,
    // not part of this turn cycle) are a richer addition than spec. Two distinct things
    // can leave a case dangling at a turn boundary, and each gets a different fallback:
    //
    // 1. A live offer was left on the table — someone made an offer (or counter) and
    //    the round ended before the other side responded (accepted, countered, or went
    //    to court). Rather than let it linger, the standing offer is treated as
    //    accepted: the case settles right here for the last offer's amount, no
    //    probability draw needed. This is the *only* way a case can settle besides an
    //    explicit `acceptOffer` call — same cash-transfer shape (defendant pays
    //    plaintiff), tracked in `legalReceivedThisTurn` exactly like a trial payout so
    //    the §16 bankruptcy pool sees it as real income received this turn.
    // 2. Nobody ever engaged at all (`offers` still empty) — the original gap this step
    //    was built to close: nothing else would ever move a case out of 'negotiating'
    //    between two solvent players (the only other exit was the bankruptcy waterfall
    //    at Step 10b cancelling/settling it if a party fell), so it would sit forever.
    //    This keeps the original fixed-timeout fallback, unchanged: after
    //    `negotiationPeriodTurns` turns of silence, force to trial. The existing
    //    trial-resolution loop right below reads the very same `allCases` objects this
    //    mutates, so a case crossing the threshold resolves in this SAME turn (not
    //    "starts waiting, resolves next turn") — the client never observes an
    //    `awaiting_trial` snapshot for a case that timed out this way.
    //
    // A case with active back-and-forth (every offer answered before its turn boundary)
    // never reaches branch 2's cap — by construction, any exchange that never explicitly
    // accepts or goes to court always has an unanswered offer sitting at the next
    // boundary check, so branch 1 settles it first. The cap only ever fires for a case
    // nobody ever makes a single offer on.
    const negotiationPeriodTurns = this.config.gameSettings.negotiationPeriodTurns;
    for (const case_ of negotiatingBeforeFiling) {
      case_.turnsNegotiating += 1;
      if (case_.offers.length > 0) {
        const lastOffer = case_.offers[case_.offers.length - 1];
        const defCtx = ctxs.get(case_.defendantId);
        const pltCtx = ctxs.get(case_.plaintiffId);
        if (defCtx && pltCtx) {
          defCtx.vars.cash -= lastOffer.amount;
          pltCtx.vars.cash += lastOffer.amount;
          legalReceivedThisTurn.set(
            case_.plaintiffId,
            (legalReceivedThisTurn.get(case_.plaintiffId) ?? 0) + lastOffer.amount,
          );
        }
        case_.status = 'resolved';
        case_.verdict = 'settled';
        case_.resolvedAt = new Date();
      } else if (case_.turnsNegotiating >= negotiationPeriodTurns) {
        case_.status = 'awaiting_trial';
      }
    }

    // Resolve awaiting trials from previous turns (FORMULAS §6 with legal exposure ratio)
    const casesResolvedThisTurn: LegalCaseData[] = [];
    for (const trial of allCases) {
      if (trial.status !== 'awaiting_trial') continue;
      const defCtx = ctxs.get(trial.defendantId);
      if (!defCtx) continue;
      const defLegalExposureRatio = calculateLegalExposureRatio(
        legalExposureMap.get(trial.defendantId) ?? 0,
        defCtx.vars.cash,
        this.adminVars,
        this.formulas,
      );
      const adjProb = calculateAdjustedProbability(
        trial.baseProbability,
        defCtx.vars.scrutiny,
        defLegalExposureRatio,
        this.adminVars,
        this.formulas,
      );
      const won = Math.random() < adjProb;
      trial.adjustedProbability = adjProb;
      trial.verdict = won ? 'won' : 'lost';
      trial.status = 'resolved';
      trial.resolvedAt = new Date();
      casesResolvedThisTurn.push(trial);
    }

    // ── Step 9 — Process resolved cases & apply cash settlements (FORMULAS §5, §16) ──
    // Apply verdict cash flows: loser pays stakes to winner. `legalReceivedThisTurn`
    // (declared up at Step 8b, which can also write into it) tracks amounts actually
    // RECEIVED this turn per player.
    for (const trial of casesResolvedThisTurn) {
      if (!trial.verdict) continue;
      const defCtx = ctxs.get(trial.defendantId);
      const pltCtx = ctxs.get(trial.plaintiffId);
      if (!defCtx || !pltCtx) continue;

      if (trial.verdict === 'won') {
        // Plaintiff won: defendant pays stakes to plaintiff
        defCtx.vars.cash -= trial.stakes;
        pltCtx.vars.cash += trial.stakes;
        legalReceivedThisTurn.set(
          trial.plaintiffId,
          (legalReceivedThisTurn.get(trial.plaintiffId) ?? 0) + trial.stakes,
        );
      } else {
        // Defendant won: no payment
      }
    }

    // ── Step 10 — Check for bankruptcies & mergers (FORMULAS §12, §16) ──────
    const playersStillActive: string[] = [];
    const playersToBankrupt: string[] = [];

    for (const pid of playerIds) {
      const ctx = ctxs.get(pid)!;
      // Bankruptcy: cash < 0 on any turn
      if (ctx.vars.cash < 0) {
        playersToBankrupt.push(pid);
        continue;
      }
      playersStillActive.push(pid);
    }

    // ── Step 10b — Bankruptcy case distribution (FORMULAS §16) ─────────────
    // When a player falls, ALL their still-unresolved cases lapse — both as
    // defendant and as plaintiff. Cases against them are paid from:
    //   jaettava_summa = cash_i (previous turn)
    //                   + this turn's POSITIVE income-side cash-flow lines
    //                     (revenue, other income, depreciation add-back,
    //                      positive decision cash impacts, legal cash received)
    //   — expense-side lines (opex, staff, COGS, finance cost, tax, capex
    //     spend) never reduce this pool (FORMULAS §16).
    // Paid to plaintiffs in filing order (oldest `createdAt` first), each in
    // full until the pool runs out; the rest get nothing.
    const bankruptedPlayers: BankruptedPlayer[] = [];
    for (const pid of playersToBankrupt) {
      const ctx = ctxs.get(pid)!;
      const pl = plMap.get(pid)!;
      const dep = depreciationMap.get(pid) ?? 0;
      const deltas = absDeltasMap.get(pid) ?? { revenueDelta: 0, financeCostDelta: 0, taxCostDelta: 0, receivablesDelta: 0, cashDelta: 0 };
      const legalReceived = legalReceivedThisTurn.get(pid) ?? 0;

      const pool = Math.max(0,
        ctx.prevCash
        + Math.max(0, pl.revenue)
        + Math.max(0, ctx.vars.otherIncome || 0)
        + dep
        + Math.max(0, deltas.cashDelta)
        + legalReceived,
      );

      // Find all unresolved cases where this player was the defendant, sorted
      // oldest-first by filing order (FORMULAS §14/§16)
      const casesAgainstDefunct = allCases
        .filter(c => c.defendantId === pid && c.status !== 'resolved')
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

      // Distribute pool to plaintiffs in filing order
      let remaining = pool;
      for (const case_ of casesAgainstDefunct) {
        if (remaining <= 0) break;
        const payment = Math.min(case_.stakes, remaining);
        const pltCtx = ctxs.get(case_.plaintiffId);
        if (pltCtx) {
          pltCtx.vars.cash += payment;
        }
        case_.status = 'resolved';
        case_.verdict = 'settled';
        case_.resolvedAt = new Date();
        remaining -= payment;
      }

      // All remaining unresolved cases touching the fallen player lapse without
      // payment — as defendant (pool exhausted) AND as plaintiff (FORMULAS §16).
      for (const case_ of allCases) {
        if (case_.status === 'resolved') continue;
        if (case_.defendantId === pid || case_.plaintiffId === pid) {
          case_.status = 'resolved';
          case_.verdict = 'cancelled';
          case_.resolvedAt = new Date();
        }
      }

      bankruptedPlayers.push({ playerId: pid, playerName: ctx.playerName, finalCash: ctx.vars.cash });
    }

    // ── Step 11 — Risk gauge (FORMULAS §7) ────────────────────
    const riskMap = new Map<string, number>();
    for (const pid of playersStillActive) {
      const ctx = ctxs.get(pid)!;
      const openCases = allCases
        .filter(c => c.defendantId === pid && c.status !== 'resolved')
        .map(c => ({ probability: c.adjustedProbability ?? c.baseProbability, stakes: c.stakes }));
      riskMap.set(pid, calculateRiskGauge(ctx.vars, openCases, this.adminVars, this.formulas));
    }

    // ── Step 12 — Collect Company persistence updates (all engine state in JSONB) ──
    const companyUpdates: CompanyPersistUpdate[] = [];
    for (const pid of playersStillActive) {
      const ctx = ctxs.get(pid)!;
      const saveVars = this.stripInternal(ctx.vars);
      companyUpdates.push({
        playerId: pid,
        cash: ctx.vars.cash,
        variables: saveVars,
        engineState: {
          activeDecisions: ctx.engineState.activeDecisions.map(d => ({
            id: d.id,
            definitionName: d.definition.decision,
            deployedYear: d.deployedYear,
            elapsedYears: d.elapsedYears,
            isMatured: d.isMatured,
            targetId: d.targetId,
          })),
          depreciationLedger: ctx.engineState.depreciationLedger,
          legalCases: allCases.filter(c => c.plaintiffId === pid || c.defendantId === pid),
          investigations: ctx.engineState.investigations,
        },
      });
    }

    // ── Step 13 — Build result ─────────────────────────────────
    const results: PlayerTurnResult[] = [];
    for (const pid of playersStillActive) {
      const ctx = ctxs.get(pid)!;
      const pl = plMap.get(pid)!;
      const dep = depreciationMap.get(pid) ?? 0;
      results.push({
        playerId: pid,
        playerName: ctx.playerName,
        variables: this.stripInternal(ctx.vars),
        derived: {
          equity: ctx.vars.equity || 0,
          revenue: pl.revenue,
          volume: ctx.vars.volume || 0,
          receivables: ctx.vars.receivables || 0,
          financeCost: pl.financeCost,
          taxCost: pl.taxCost,
          depreciation: dep,
          stockValue: ctx.vars.stockValue || 0,
          marketShare: ctx.vars.marketShare || 0,
          competitiveness: ctx.vars.competitiveness || 0,
        },
        activeDecisions: ctx.engineState.activeDecisions.map(d => ({
          id: d.id,
          decisionName: d.definition.decision,
          deployedYear: d.deployedYear,
          maturityYears: calcMaturity(d.definition.impacts),
          elapsedYears: d.elapsedYears,
          isMatured: d.isMatured,
        })),
        legalCases: allCases.filter(c => c.plaintiffId === pid || c.defendantId === pid),
        riskGauge: riskMap.get(pid) ?? 0,
        incomingAttacks: this.buildIncomingAttacks(pid, ctxs, playersStillActive),
      });
    }

    const gameOver = playersStillActive.length <= 1;
    let winnerId: string | undefined;
    if (gameOver && playersStillActive.length === 1) {
      winnerId = playersStillActive[0];
    }

    this.clearSubmissions(roomId);

    console.log(`[GameLoop] Turn ${round} resolved in ${Date.now() - t0}ms — room ${roomId}`);

    return {
      result: { round, players: results, gameOver, winnerId },
      companyUpdates,
      bankruptedPlayers,
    };
  }

  /**
   * Compute each player's starting-position snapshot — used when the host starts the
   * game, so players land straight in the game room showing their real starting numbers
   * instead of a blank "waiting" screen for the full first `turnDurationSeconds` window.
   * No decisions have been submitted yet, so this reuses the same formula pipeline as
   * resolveTurn (FORMULAS §2-§5) with zero decision impacts, zero legal cases, and zero
   * depreciation — nothing to persist, nothing that could produce a bankruptcy or
   * game-over. The real round-1 resolution still happens normally when the timer
   * expires. Like resolveTurn, this is pure: the caller is responsible for broadcasting
   * the returned snapshot.
   */
  getInitialSnapshot(_roomId: string, round: number, players: EngineDataInput[]): TurnResolutionResult {
    const dbPlayers = players;
    if (dbPlayers.length === 0) return { round, players: [], gameOver: false };

    const varsByPlayer = new Map<string, PlayerVariables>();
    const playerIds: string[] = [];
    const playerNames = new Map<string, string>();

    for (const p of dbPlayers) {
      const company = p.company!;
      let vars = this.readVariables(company.variables as any);
      if (!vars.cash && !vars.assets) {
        vars = this.startingVars();
      }
      varsByPlayer.set(p.id, vars);
      playerNames.set(p.id, p.name);
      playerIds.push(p.id);
    }

    // FORMULAS §2 — competitiveness & market share (zero-sum across all players)
    const varsList = playerIds.map(pid => varsByPlayer.get(pid)!);
    const marketShares = calculateCompetitivenessAndMarketShare(playerIds, varsList, this.adminVars, this.formulas);
    for (const pid of playerIds) {
      varsByPlayer.get(pid)!.marketShare = marketShares.get(pid) || 0;
    }

    // FORMULAS §3 — volume with supply cap
    const totalVol = this.config.gameSettings.totalMarketVolumeTonnesPerYear;
    for (const pid of playerIds) {
      const vars = varsByPlayer.get(pid)!;
      vars.volume = calculateVolume(vars, vars.marketShare || 0, totalVol, this.formulas);
    }

    const results: PlayerTurnResult[] = [];
    for (const pid of playerIds) {
      const vars = varsByPlayer.get(pid)!;
      // FORMULAS §4 — P&L (no decisions yet, so no absolute schedule deltas)
      const pl = calculatePL(vars, vars.volume || 0, 0, this.adminVars, this.formulas);
      // FORMULAS §5 — balance sheet (no legal exposure yet — no cases exist on turn 1)
      const bs = updateBalanceSheet(vars, pl.netProfit, 0, pl.revenue, 0, this.adminVars, this.formulas);
      vars.cash = bs.cash;
      vars.reserves = bs.reserves;
      vars.receivables = bs.receivables;
      vars.equity = bs.equity;
      vars.stockValue = bs.stockValue;
      vars.legalExposure = bs.legalExposure;
      vars.legalExposureRatio = 0;

      results.push({
        playerId: pid,
        playerName: playerNames.get(pid) ?? '',
        variables: this.stripInternal(vars),
        derived: {
          equity: vars.equity || 0,
          revenue: pl.revenue,
          volume: vars.volume || 0,
          receivables: vars.receivables || 0,
          financeCost: pl.financeCost,
          taxCost: pl.taxCost,
          depreciation: 0,
          stockValue: vars.stockValue || 0,
          marketShare: vars.marketShare || 0,
          competitiveness: vars.competitiveness || 0,
        },
        activeDecisions: [],
        legalCases: [],
        riskGauge: calculateRiskGauge(vars, [], this.adminVars, this.formulas),
        incomingAttacks: [],
      });
    }

    return { round, players: results, gameOver: false };
  }

  /**
   * "Dig Deeper" — pay `gameSettings.digDeeperCost` to reveal the next tier of intel on
   * one incoming attack. Unlike `resolveTurn`, this is NOT part of the turn cycle: it's
   * a single-player, out-of-band action a client can trigger any time during GAME_PHASE,
   * independent of the turn timer. Still pure (no Prisma/Socket.IO) — the caller
   * (`GameEngine.digDeeper`) persists `engineStateUpdate`/`newCash` and emits the result
   * back to just the requesting socket.
   */
  digDeeper(playerId: string, attackId: string, players: EngineDataInput[]): DigDeeperOutcome {
    const byId = new Map<string, { name: string; vars: PlayerVariables; engineState: CompanyEngineState }>();
    for (const p of players) {
      if (!p.company) continue;
      let vars = this.readVariables(p.company.variables as any);
      // Same "first turn hasn't resolved yet, Company.variables is still {}" fallback
      // resolveTurn/getInitialSnapshot already apply — this is an instant, out-of-band
      // action that can in principle be triggered before any turn has ever resolved.
      if (!vars.cash && !vars.assets) vars = this.startingVars();
      byId.set(p.id, {
        name: p.name,
        vars,
        engineState: this.readEngineState(p.company),
      });
    }

    const me = byId.get(playerId);
    if (!me) return { success: false, reason: 'player_not_found' };

    // The attacking decision instance lives in SOME OTHER player's activeDecisions —
    // never trust the client past that. Direct ones must actually target this player;
    // indirect ones (isIndirectEffect) have no target at all, so any other active
    // player may legitimately dig into one (matches buildIncomingAttacks broadcasting
    // it to everyone in the first place).
    let attacker: { id: string; name: string; decision: DeployedDecision; isIndirect: boolean } | null = null;
    for (const [pid, state] of byId) {
      if (pid === playerId) continue;
      const inst = state.engineState.activeDecisions.find(d => d.id === attackId);
      if (!inst) continue;
      const targetImpacts = this.decisionEngine.getTargetImpacts(inst.definition.impacts);
      const isIndirect = this.isIndirectEffect(inst.definition, targetImpacts);
      if (!isIndirect && inst.targetId !== playerId) continue;
      if (!isIndirect && targetImpacts.size === 0) continue;
      attacker = { id: pid, name: state.name, decision: inst, isIndirect };
      break;
    }
    if (!attacker) return { success: false, reason: 'invalid_attack' };

    // byId's size is every active (non-bankrupt) player in the room, target included —
    // 2 means a heads-up game, where digDeeper's next raw level should skip straight to
    // level-2 content (see effectiveInvestigationLevel's doc comment).
    const activePlayerCount = byId.size;
    const currentLevel = me.engineState.investigations[attackId] ?? 0;
    if (this.effectiveInvestigationLevel(currentLevel, activePlayerCount) >= MAX_INVESTIGATION_LEVEL) {
      return { success: false, reason: 'already_fully_investigated' };
    }

    const cost = this.config.gameSettings.digDeeperCost;
    if (me.vars.cash < cost) return { success: false, reason: 'insufficient_funds' };

    const newLevel = currentLevel + 1;
    const newCash = me.vars.cash - cost;
    const newInvestigations = { ...me.engineState.investigations, [attackId]: newLevel };

    const attackerVars = byId.get(attacker.id)!.vars;
    const attack = this.revealAttack(attacker.id, attacker.name, attacker.decision, this.effectiveInvestigationLevel(newLevel, activePlayerCount), attackerVars, attacker.isIndirect);

    return {
      success: true,
      attackId,
      cost,
      newCash,
      attack,
      variables: this.stripInternal({ ...me.vars, cash: newCash }),
      engineStateUpdate: {
        activeDecisions: me.engineState.activeDecisions.map(d => ({
          id: d.id,
          definitionName: d.definition.decision,
          deployedYear: d.deployedYear,
          elapsedYears: d.elapsedYears,
          isMatured: d.isMatured,
          targetId: d.targetId,
        })),
        depreciationLedger: me.engineState.depreciationLedger,
        legalCases: me.engineState.legalCases,
        investigations: newInvestigations,
      },
    };
  }

  /**
   * Charge the flat `gameSettings.lawsuitFilingCost` filing fee the instant a player
   * actually files a lawsuit (SueModal's "File" button) — like `digDeeper`, this is a
   * single-player, out-of-band mutation independent of the turn timer, not part of
   * `resolveTurn`. The lawsuit itself is still only created/validated at the next turn
   * resolution via the normal submitDecisions → `LegalEngine.fileLawsuit` path (Step 8);
   * this only ever moves cash. Deliberately not refunded if that later validation
   * rejects the case (e.g. the target no longer has the cited decision deployed) —
   * filing is a real, deliberate action the instant it's paid for, by product decision.
   *
   * Capped at `gameSettings.maxLawsuitsPerPlayerPerTurn` using `this.submissions`, the
   * same in-memory per-round store `submitDecisions`/`resolveTurn` use — this player's
   * currently-queued lawsuit count (before the one about to be charged) must be under
   * the limit, or a client could rack up fee charges for filings Step 8's own
   * `.slice(0, maxLawsuits)` guard would silently drop anyway.
   */
  chargeLawsuitFilingFee(roomId: string, playerId: string, players: EngineDataInput[]): LawsuitFilingFeeOutcome {
    const me = players.find(p => p.id === playerId);
    if (!me?.company) return { success: false, reason: 'player_not_found' };

    const alreadyQueued = this.submissions.get(roomId)?.get(playerId)?.lawsuits.length ?? 0;
    if (alreadyQueued >= this.config.gameSettings.maxLawsuitsPerPlayerPerTurn) {
      return { success: false, reason: 'limit_reached' };
    }

    let vars = this.readVariables(me.company.variables as any);
    // Same "first turn hasn't resolved yet, Company.variables is still {}" fallback
    // resolveTurn/getInitialSnapshot already apply — filing (and guessing) a lawsuit is
    // now a realistic round-1 action (see getGroundsAgainst's whole-library ground
    // catalog), not just something that happens after a turn has populated real values.
    // Without this, vars.cash is undefined here, `undefined - cost` is NaN, and the
    // resulting Prisma company.update crashes with an invalid-argument error.
    if (!vars.cash && !vars.assets) vars = this.startingVars();
    const cost = this.config.gameSettings.lawsuitFilingCost;
    if (vars.cash < cost) return { success: false, reason: 'insufficient_funds' };

    const newCash = vars.cash - cost;
    return {
      success: true,
      cost,
      newCash,
      variables: this.stripInternal({ ...vars, cash: newCash }),
    };
  }

  /**
   * Make (or counter) a settlement offer on a case still `'negotiating'` — like
   * `digDeeper`/`chargeLawsuitFilingFee`, an instant, out-of-band action independent of
   * the turn timer, not part of `resolveTurn`. Unlike those, this touches TWO players'
   * persisted state at once (a case lives in both the plaintiff's and defendant's own
   * `engineState.legalCases`, see the Step 7 dedup comment above) — the caller
   * (`GameEngine.makeOffer`) must persist both `plaintiff` and `defendant` updates.
   *
   * The defendant always moves first (`offers.length === 0`); after that, only the
   * role that did *not* make the most recent offer may respond. `amount` must fall
   * within `computeOfferBracket(case_)` — the bracket that's narrowed inward by every
   * offer so far, converging the two sides toward each other rather than letting either
   * one drift away from what's already been offered/asked.
   */
  makeOffer(playerId: string, caseId: string, amount: number, players: EngineDataInput[]): LegalCaseActionOutcome {
    const found = this.findCaseAndParties(caseId, players);
    if (!found) return { success: false, reason: 'case_not_found' };
    const { case: case_, plaintiff, defendant } = found;

    if (case_.status !== 'negotiating') return { success: false, reason: 'not_negotiating' };
    const role = this.roleInCase(playerId, case_);
    if (!role) return { success: false, reason: 'not_a_party' };
    if (role !== this.roleOnMove(case_)) return { success: false, reason: 'not_your_turn' };
    const { min, max } = this.computeOfferBracket(case_);
    if (!Number.isFinite(amount) || amount < min || amount > max) {
      return { success: false, reason: 'invalid_amount' };
    }

    const updatedCase: LegalCaseData = { ...case_, offers: [...case_.offers, { by: role, amount }] };

    return {
      success: true,
      case: updatedCase,
      plaintiff: { playerId: plaintiff.playerId, engineState: this.serializeEngineStateForCase(plaintiff.engineState, updatedCase) },
      defendant: { playerId: defendant.playerId, engineState: this.serializeEngineStateForCase(defendant.engineState, updatedCase) },
    };
  }

  /**
   * Accept the other party's most recent offer on a case still `'negotiating'` —
   * settles immediately for that amount (defendant pays plaintiff), same shape as Step
   * 8b's stale-offer auto-settle inside `resolveTurn`, just triggered explicitly instead
   * of by a turn boundary. Only the party who did *not* make that offer may accept it
   * (can't accept your own offer).
   */
  acceptOffer(playerId: string, caseId: string, players: EngineDataInput[]): LegalCaseActionOutcome {
    const found = this.findCaseAndParties(caseId, players);
    if (!found) return { success: false, reason: 'case_not_found' };
    const { case: case_, plaintiff, defendant } = found;

    if (case_.status !== 'negotiating') return { success: false, reason: 'not_negotiating' };
    if (case_.offers.length === 0) return { success: false, reason: 'no_offer_to_accept' };
    const role = this.roleInCase(playerId, case_);
    if (!role) return { success: false, reason: 'not_a_party' };
    const lastOffer = case_.offers[case_.offers.length - 1];
    if (lastOffer.by === role) return { success: false, reason: 'not_your_turn' };

    const updatedCase: LegalCaseData = { ...case_, status: 'resolved', verdict: 'settled', resolvedAt: new Date() };
    const newPlaintiffCash = plaintiff.vars.cash + lastOffer.amount;
    const newDefendantCash = defendant.vars.cash - lastOffer.amount;

    return {
      success: true,
      case: updatedCase,
      plaintiff: {
        playerId: plaintiff.playerId,
        cash: newPlaintiffCash,
        variables: this.stripInternal({ ...plaintiff.vars, cash: newPlaintiffCash }),
        engineState: this.serializeEngineStateForCase(plaintiff.engineState, updatedCase),
      },
      defendant: {
        playerId: defendant.playerId,
        cash: newDefendantCash,
        variables: this.stripInternal({ ...defendant.vars, cash: newDefendantCash }),
        engineState: this.serializeEngineStateForCase(defendant.engineState, updatedCase),
      },
    };
  }

  /**
   * End negotiation on a case still `'negotiating'` and send it to trial — either party
   * may call this at any time, regardless of whose turn it is to respond (unlike
   * `makeOffer`/`acceptOffer`); walking away from the table is a unilateral decision in
   * a way that offering/accepting aren't. Only marks the case `'awaiting_trial'` — no
   * verdict is drawn here. The next time this room's `resolveTurn` actually runs, the
   * existing trial-resolution loop picks up any `'awaiting_trial'` case the same way it
   * already does for one that got there via Step 8b's timeout, so there's exactly one
   * verdict-drawing code path for both origins.
   */
  goToCourt(playerId: string, caseId: string, players: EngineDataInput[]): LegalCaseActionOutcome {
    const found = this.findCaseAndParties(caseId, players);
    if (!found) return { success: false, reason: 'case_not_found' };
    const { case: case_, plaintiff, defendant } = found;

    if (case_.status !== 'negotiating') return { success: false, reason: 'not_negotiating' };
    const role = this.roleInCase(playerId, case_);
    if (!role) return { success: false, reason: 'not_a_party' };

    const updatedCase: LegalCaseData = { ...case_, status: 'awaiting_trial' };

    return {
      success: true,
      case: updatedCase,
      plaintiff: { playerId: plaintiff.playerId, engineState: this.serializeEngineStateForCase(plaintiff.engineState, updatedCase) },
      defendant: { playerId: defendant.playerId, engineState: this.serializeEngineStateForCase(defendant.engineState, updatedCase) },
    };
  }

  /**
   * Pay `gameSettings.digDeeperCost` to reveal the probability of success on a case
   * you're the DEFENDANT on. A case's `baseProbability`/`adjustedProbability` used to be
   * free intel for the defendant the instant it was filed — this makes it cost the same
   * "dig deeper" fee an incoming-attack investigation does, and gates it behind an
   * explicit action instead of showing it automatically. Unlike the 3-tier incoming-
   * attack investigation ladder (`digDeeper`), this is a single one-shot reveal scoped to
   * one case — there's only one thing to learn (the odds), not a progression of tiers.
   *
   * Same two-party persist shape as `makeOffer`/`acceptOffer`/`goToCourt` (the case is
   * spliced into both parties' `engineState.legalCases`), even though only the
   * defendant's cash moves — the plaintiff's own copy of the case still needs the
   * updated `defendantInvestigated` flag written back so the two copies never diverge.
   */
  digDeeperOnCase(playerId: string, caseId: string, players: EngineDataInput[]): LegalCaseActionOutcome {
    const found = this.findCaseAndParties(caseId, players);
    if (!found) return { success: false, reason: 'case_not_found' };
    const { case: case_, plaintiff, defendant } = found;

    if (playerId !== defendant.playerId) return { success: false, reason: 'not_defendant' };
    if (case_.defendantInvestigated) return { success: false, reason: 'already_investigated' };

    const cost = this.config.gameSettings.digDeeperCost;
    if (defendant.vars.cash < cost) return { success: false, reason: 'insufficient_funds' };

    const newCash = defendant.vars.cash - cost;
    const updatedCase: LegalCaseData = { ...case_, defendantInvestigated: true };

    return {
      success: true,
      case: updatedCase,
      plaintiff: {
        playerId: plaintiff.playerId,
        engineState: this.serializeEngineStateForCase(plaintiff.engineState, updatedCase),
      },
      defendant: {
        playerId: defendant.playerId,
        cash: newCash,
        variables: this.stripInternal({ ...defendant.vars, cash: newCash }),
        engineState: this.serializeEngineStateForCase(defendant.engineState, updatedCase),
      },
    };
  }

  /**
   * Predict this player's own KPI trajectory `turnsAhead` turns into the future — by
   * literally reusing `resolveTurn` itself, sandboxed behind a synthetic room id that
   * can never collide with (or read/clear) any real room's `this.submissions` entry.
   * A key never passed to `submitDecisions` always reads back as "nobody submitted
   * anything" (line ~296's `this.submissions.get(roomId)?.get(p.id) ?? null`), so every
   * player in the sandbox — including the target themselves — deploys nothing new and
   * files no new lawsuits (Step 1/Step 8 both no-op on a null `submittedDecisions`);
   * only already-active decisions keep maturing/scheduling normally (`advanceAndApply`
   * increments `elapsedYears` unconditionally, independent of any submission). This is
   * deliberately the *real* math, not an approximation — competitiveness, market share,
   * P&L, balance sheet, depreciation, and risk gauge all run exactly as they would for a
   * real turn.
   *
   * Every rival is held completely frozen: the SAME original snapshot (loaded once,
   * before the loop) is fed back in on every iteration, never advanced with the target
   * player's own evolving state. This is the "doesn't take other players' decisions/
   * causes into account" product decision — market share/competitiveness still get
   * recomputed each iteration (they're relative, so the target's own growth can still
   * shift the split), but a rival's own decisions never mature, and rivals never deploy,
   * sue, or get sued by anyone further during the simulated window.
   *
   * One real consequence of reusing the real engine wholesale: if the target has any
   * existing case still `negotiating`, the real negotiation-timeout/trial-resolution
   * logic (Step 8b onward) runs inside the sandbox too — including its random verdict
   * draw, if `turnsNegotiating` crosses `negotiationPeriodTurns` within the predicted
   * window. That's accepted, not suppressed: it's a real mechanic driven by the
   * player's own existing situation (an already-filed case), not a new decision by
   * anyone else, and fidelity to the real engine was the whole point of this approach
   * over a client-side approximation. It does mean two predictions requested back to
   * back can differ if a case happens to resolve inside the window — that's expected,
   * not a bug.
   *
   * `round` must be the room's real, current round — `applyDepreciation` computes
   * `currentYear - entry.purchaseYear` (calcEngine.ts), so a fabricated small counter
   * (e.g. 1, 2, 3) instead of the real incrementing round number would desync every
   * existing depreciation ledger entry's remaining-years countdown.
   *
   * Stops early (fewer than `turnsAhead` points, `bankruptAtRound` set) if the target
   * would go bankrupt partway through the simulation — nothing meaningful to project
   * past that; `BankruptedPlayer.finalCash` isn't reused here since a bankrupt player
   * has no equity/derived stats left to plot, just the one round number.
   */
  predictFutureKpis(playerId: string, round: number, players: EngineDataInput[], turnsAhead: number): KpiPrediction {
    const me = players.find(p => p.id === playerId);
    if (!me?.company) return { predicted: [] };

    const rivals = players.filter(p => p.id !== playerId);
    const sandboxRoomId = `__predict__${playerId}`;
    const predicted: KpiSnapshotPoint[] = [];

    let meInput: EngineDataInput = me;
    for (let i = 1; i <= turnsAhead; i++) {
      const virtualRound = round + i;
      const outcome = this.resolveTurn(sandboxRoomId, virtualRound, [meInput, ...rivals]);

      if (outcome.bankruptedPlayers.some(b => b.playerId === playerId)) {
        return { predicted, bankruptAtRound: virtualRound };
      }

      const result = outcome.result.players.find(p => p.playerId === playerId);
      const update = outcome.companyUpdates.find(u => u.playerId === playerId);
      if (!result || !update) return { predicted, bankruptAtRound: virtualRound };

      predicted.push({
        round: virtualRound,
        variables: result.variables,
        derived: result.derived,
        riskGauge: result.riskGauge,
      });

      meInput = { id: playerId, name: me.name, company: { variables: update.variables, engineState: update.engineState } };
    }

    return { predicted };
  }

  /**
   * Read-only summary of one player's active decisions, for narrating their "annual
   * report" to a rival (`GameEngine.getAnnualReport`) — like `digDeeper`, a single-
   * player, out-of-band lookup that bypasses the turn cycle entirely and never
   * mutates anything. Returns `null` if the player isn't found (unknown id, or
   * bankrupted and no longer in the active-players list the caller loaded).
   */
  getActiveDecisionSummaries(playerId: string, players: EngineDataInput[]): ActiveDecisionSummary[] | null {
    const target = players.find((p) => p.id === playerId);
    if (!target?.company) return null;

    const engineState = this.readEngineState(target.company);
    return engineState.activeDecisions
      .filter((d) => !!d.definition)
      .map((d) => ({
        instanceId: d.id,
        decisionName: d.definition.decision,
        description: d.definition.description,
        deployedYear: d.deployedYear,
        elapsedYears: d.elapsedYears,
      }));
  }

  // ============================================================
  // Helpers
  // ============================================================

  /** Read engine state from Company JSONB (active decisions + depreciation ledger) */
  private readEngineState(company: any): CompanyEngineState {
    const raw = company?.engineState ?? {};
    return {
      activeDecisions: (raw.activeDecisions ?? []).map((d: any) => ({
        id: d.id,
        definition: this.decisionEngine.getDef(d.definitionName),
        deployedYear: d.deployedYear,
        elapsedYears: d.elapsedYears,
        isMatured: d.isMatured,
        targetId: d.targetId,
      })),
      depreciationLedger: (raw.depreciationLedger ?? []) as DepreciationEntry[],
      legalCases: (raw.legalCases ?? []) as LegalCaseData[],
      investigations: (raw.investigations ?? {}) as Record<string, number>,
    };
  }

  /**
   * Locate a case by id and load both parties' full state — shared lookup for
   * `makeOffer`/`acceptOffer`/`goToCourt`. Since the same case is persisted into both
   * the plaintiff's and defendant's own `engineState.legalCases` (Step 7's dedup
   * comment), it's found by scanning whichever loaded player happens to have it; `null`
   * if the case doesn't exist in any loaded player's state, or if — which shouldn't
   * happen while a case is still `'negotiating'`, since either party going bankrupt
   * resolves it via the Step 10b waterfall first — one of the two parties named on the
   * case isn't in `players` at all (e.g. already eliminated).
   */
  private findCaseAndParties(
    caseId: string,
    players: EngineDataInput[],
  ): {
    case: LegalCaseData;
    plaintiff: { playerId: string; vars: PlayerVariables; engineState: CompanyEngineState };
    defendant: { playerId: string; vars: PlayerVariables; engineState: CompanyEngineState };
  } | null {
    const byId = new Map<string, { vars: PlayerVariables; engineState: CompanyEngineState }>();
    for (const p of players) {
      if (!p.company) continue;
      byId.set(p.id, {
        vars: this.readVariables(p.company.variables as any),
        engineState: this.readEngineState(p.company),
      });
    }

    let found: LegalCaseData | undefined;
    for (const state of byId.values()) {
      found = state.engineState.legalCases.find(c => c.id === caseId);
      if (found) break;
    }
    if (!found) return null;

    const plaintiffState = byId.get(found.plaintiffId);
    const defendantState = byId.get(found.defendantId);
    if (!plaintiffState || !defendantState) return null;

    return {
      case: found,
      plaintiff: { playerId: found.plaintiffId, ...plaintiffState },
      defendant: { playerId: found.defendantId, ...defendantState },
    };
  }

  /** Which role (if any) `playerId` has on this case. */
  private roleInCase(playerId: string, case_: LegalCaseData): 'plaintiff' | 'defendant' | null {
    if (playerId === case_.plaintiffId) return 'plaintiff';
    if (playerId === case_.defendantId) return 'defendant';
    return null;
  }

  /** Whichever role did *not* make the case's most recent offer is the one currently
   * allowed to respond (counter or accept — `goToCourt` deliberately doesn't gate on
   * this, see its own doc comment). The defendant always moves first, while `offers` is
   * still empty. */
  private roleOnMove(case_: LegalCaseData): 'plaintiff' | 'defendant' {
    if (case_.offers.length === 0) return 'defendant';
    const lastOffer = case_.offers[case_.offers.length - 1];
    return lastOffer.by === 'plaintiff' ? 'defendant' : 'plaintiff';
  }

  /**
   * The valid `[min, max]` range for the *next* offer on this case, regardless of which
   * role is about to make it — negotiation only ever moves inward from the two starting
   * anchors (0, the full stakes) toward wherever the two sides' most recent offers
   * currently sit:
   * - `min` is the defendant's own most recent offer (what they've committed to paying
   *   so far) — 0 if they haven't offered yet.
   * - `max` is the plaintiff's own most recent offer (what they've committed to
   *   accepting so far) — the full `stakes` if they haven't offered yet.
   *
   * Each side's new offer can only ever tighten its own end of the bracket (a defendant
   * offer raises `min`, a plaintiff offer lowers `max`), so the range never widens and
   * `min <= max` always holds as long as every accepted offer was itself validated
   * against this same bracket — see the callers below.
   */
  private computeOfferBracket(case_: LegalCaseData): { min: number; max: number } {
    let min = 0;
    let max = case_.stakes;
    for (const offer of case_.offers) {
      if (offer.by === 'defendant') min = offer.amount;
      else max = offer.amount;
    }
    return { min, max };
  }

  /** Rebuilds one party's full persistable `engineState` (same serialized shape
   * `CompanyPersistUpdate`/`DigDeeperOutcome.engineStateUpdate` use) with `updatedCase`
   * spliced into their own `legalCases` by id — everything else (active decisions,
   * depreciation ledger, investigations) carried through unchanged. */
  private serializeEngineStateForCase(engineState: CompanyEngineState, updatedCase: LegalCaseData): CompanyPersistUpdate['engineState'] {
    return {
      activeDecisions: engineState.activeDecisions.map(d => ({
        id: d.id,
        definitionName: d.definition.decision,
        deployedYear: d.deployedYear,
        elapsedYears: d.elapsedYears,
        isMatured: d.isMatured,
        targetId: d.targetId,
      })),
      depreciationLedger: engineState.depreciationLedger,
      legalCases: engineState.legalCases.map(c => (c.id === updatedCase.id ? updatedCase : c)),
      investigations: engineState.investigations,
    };
  }

  /**
   * Scan every OTHER still-active player's activeDecisions for ones targeting `pid`,
   * revealing fields progressively per `pid`'s own persisted investigation level for
   * that attack (never the attacker's — this player only ever unlocks intel about
   * attacks against them, via `digDeeper`). A now-bankrupt attacker's decisions are
   * excluded — `attackerCtxIds` is the still-active player set for this turn.
   */
  /**
   * True for a decision with no `target.*` impacts at all (no single player it's routed
   * to) that still carries `legalRisks` — New Factory's nuisance suit, Water Pumping's
   * environmental suit, Night Dumping, etc. These broadcast an incoming-attack-style hint
   * to EVERY other active player (see buildIncomingAttacks), not just one target, since
   * there's no target to route it to. A decision with neither `target.*` impacts nor any
   * `legalRisks` (e.g. Sell Shares) is neither direct nor indirect — nothing to reveal or
   * sue over, so it never generates a hint at all.
   */
  private isIndirectEffect(def: DecisionDefinition, targetImpacts: Map<string, unknown>): boolean {
    return targetImpacts.size === 0 && !!def.legalRisks && def.legalRisks.length > 0;
  }

  private buildIncomingAttacks(pid: string, ctxs: Map<string, PlayerTurnContext>, attackerCtxIds: string[]): IncomingAttackInfo[] {
    const myInvestigations = ctxs.get(pid)!.engineState.investigations;
    const attacks: IncomingAttackInfo[] = [];
    for (const attackerId of attackerCtxIds) {
      if (attackerId === pid) continue;
      const attackerCtx = ctxs.get(attackerId)!;
      for (const d of attackerCtx.engineState.activeDecisions) {
        const targetImpacts = this.decisionEngine.getTargetImpacts(d.definition.impacts);
        const isIndirect = this.isIndirectEffect(d.definition, targetImpacts);
        // Direct: only the specific player it targets sees it. Indirect: every other
        // active player sees it (there's no single target) — see isIndirectEffect's doc
        // comment for why decisions with neither trait are skipped entirely.
        if (!isIndirect && d.targetId !== pid) continue;
        if (!isIndirect && targetImpacts.size === 0) continue;
        const rawLevel = myInvestigations[d.id] ?? 0;
        const level = this.effectiveInvestigationLevel(rawLevel, attackerCtxIds.length);
        attacks.push(this.revealAttack(attackerId, attackerCtx.playerName, d, level, attackerCtx.vars, isIndirect));
      }
    }
    return attacks;
  }

  /**
   * In a heads-up game (exactly 2 active players), investigation level 1's only content —
   * the attacker's identity — is never actually ambiguous: there's only one other active
   * player, so it's obvious who it was without spending a dig on it. Callers pass a raw,
   * persisted investigation level (0-2 in a heads-up game, since level 3 becomes reachable
   * one dig earlier) through here to get the level that should actually be revealed/checked
   * against `MAX_INVESTIGATION_LEVEL` — one tier ahead of raw in a heads-up game, unchanged
   * otherwise. `activePlayerCount` must count every still-active player, the target included
   * (i.e. 2 means "just me and one attacker"), matching `playersStillActive.length` /
   * `byId.size` / `ctxs.size` at each of this method's call sites.
   */
  private effectiveInvestigationLevel(rawLevel: number, activePlayerCount: number): number {
    return activePlayerCount === 2 ? Math.min(rawLevel + 1, MAX_INVESTIGATION_LEVEL) : rawLevel;
  }

  /**
   * Builds the progressively-revealed intel for one incoming attack at the given
   * investigation level. `isIndirect` (see isIndirectEffect's doc comment) only changes
   * which impacts tier 2's `effectSummary` describes — the decision's own effects for an
   * indirect one (there's no `target.*` effect to summarize), the routed cross-player
   * effect for a direct one — everything else about the reveal ladder is identical.
   */
  private revealAttack(attackerId: string, attackerName: string, decision: DeployedDecision, level: number, attackerVars: PlayerVariables, isIndirect: boolean): IncomingAttackInfo {
    const info: IncomingAttackInfo = { attackId: decision.id, investigationLevel: level, isIndirect };
    if (level >= 1) {
      info.attackerId = attackerId;
      info.attackerName = attackerName;
    }
    if (level >= 2) {
      info.decisionName = decision.definition.decision;
      info.decisionDescription = decision.definition.description;
      info.effectSummary = isIndirect
        ? summarizeOwnImpacts(decision.definition.impacts, decision.elapsedYears)
        : summarizeTargetImpacts(decision.definition.impacts, decision.elapsedYears);
    }
    if (level >= 3) {
      const best = pickBestGround(decision.definition, decision.elapsedYears, attackerVars, this.adminVars, this.formulas);
      if (best) {
        info.suggestedGroundName = best.name;
        info.suggestedGroundDescription = best.description;
        info.successProbability = best.probability;
      }
    }
    return info;
  }

  private processNewDecisions(ctx: PlayerTurnContext, year: number): void {
    const sub = ctx.submittedDecisions!;
    const maxStrat = this.config.gameSettings.maxStrategicDecisionsPerTurn;
    const maxOp = this.config.gameSettings.maxOperationalDecisionsPerTurn;

    // Track absolute deltas from newly deployed decisions on the same turn
    const newDecisionAbsDeltas: Array<{ revenueDelta: number; financeCostDelta: number; taxCostDelta: number; receivablesDelta: number; cashDelta: number }> = [];

    for (const { name, targetId } of sub.strategic.slice(0, maxStrat)) {
      const def = this.decisionEngine.getDef(name);
      if (!def) continue;
      const ok = this.decisionEngine.canDeploy(
        ctx.engineState.activeDecisions,
        name,
        'Strategic',
        maxStrat,
        maxOp,
      );
      if (!ok.allowed) continue;
      const inst = this.decisionEngine.deploy(ctx.playerId, def, year, targetId);
      ctx.engineState.activeDecisions.push(inst);
      const result = this.decisionEngine.applyImpactsForYear(ctx.vars, name, def.impacts, 0, year);
      ctx.vars = result.updatedVars;
      // Merge newly created depreciation entries into the ledger
      for (const entry of result.newDepreciationEntries) {
        ctx.engineState.depreciationLedger.push(entry);
      }
      // Capture absolute schedule deltas from the deployment
      newDecisionAbsDeltas.push(result.absDeltas);
    }

    for (const { name, targetId } of sub.operational.slice(0, maxOp)) {
      const def = this.decisionEngine.getDef(name);
      if (!def) continue;
      const ok = this.decisionEngine.canDeploy(
        ctx.engineState.activeDecisions,
        name,
        'Operational',
        maxStrat,
        maxOp,
      );
      if (!ok.allowed) continue;
      const inst = this.decisionEngine.deploy(ctx.playerId, def, year, targetId);
      ctx.engineState.activeDecisions.push(inst);
      const result = this.decisionEngine.applyImpactsForYear(ctx.vars, name, def.impacts, 0, year);
      ctx.vars = result.updatedVars;
      for (const entry of result.newDepreciationEntries) {
        ctx.engineState.depreciationLedger.push(entry);
      }
      newDecisionAbsDeltas.push(result.absDeltas);
    }

    // Store merged deltas on context and apply to vars so they're available in absDeltasMap later.
    // Note: cashDelta is NOT re-applied here — applyImpactsForYear already added it directly to
    // ctx.vars.cash; it's only tracked so the §16 bankruptcy waterfall can read it later.
    if (newDecisionAbsDeltas.length > 0) {
      const merged = this.decisionEngine.aggregateAbsDeltas(newDecisionAbsDeltas);
      ctx.newDecisionAbsDeltas = merged;
      if (merged.revenueDelta !== 0) ctx.vars.revenue = (ctx.vars.revenue ?? 0) + merged.revenueDelta;
      if (merged.financeCostDelta !== 0) ctx.vars.financeCost = (ctx.vars.financeCost ?? 0) + merged.financeCostDelta;
      if (merged.taxCostDelta !== 0) ctx.vars.taxCost = (ctx.vars.taxCost ?? 0) + merged.taxCostDelta;
      if (merged.receivablesDelta !== 0) ctx.vars.receivables = (ctx.vars.receivables ?? 0) + merged.receivablesDelta;
    } else {
      ctx.newDecisionAbsDeltas = { revenueDelta: 0, financeCostDelta: 0, taxCostDelta: 0, receivablesDelta: 0, cashDelta: 0 };
    }
  }

  private readVariables(json: any): PlayerVariables {
    if (!json || typeof json !== 'object') return {} as PlayerVariables;
    return json as unknown as PlayerVariables;
  }

  private startingVars(): PlayerVariables {
    const s = this.config.playerStartingValues;
    return {
      cash: s.cash,
      assets: s.assets,
      intangibleAssets: s.intangibleAssets,
      debt: s.debt,
      reserves: s.reserves,
      operatingExpenses: s.operatingExpenses,
      staffCost: s.staffCost,
      materialCostPerTon: s.materialCostPerTon,
      otherIncome: s.otherIncome,
      price: s.price,
      capacityUtilization: s.capacityUtilization,
      processingLevel: s.processingLevel,
      energyIntensity: s.energyIntensity,
      moistureContent: s.moistureContent,
      nutrientConsistency: s.nutrientConsistency,
      supplySecurity: s.supplySecurity,
      logisticsCostPerTon: s.logisticsCostPerTon,
      processLoss: s.processLoss,
      installedCapacity: s.installedCapacity,
      totalSharesOutstanding: s.totalSharesOutstanding,
      shareOwnership: s.shareOwnership,
      outrage: s.outrage,
      scrutiny: s.scrutiny,
      breakdowns: s.breakdowns,
      contaminationRisk: s.contaminationRisk,
      odorComplaints: s.odorComplaints,
      tokenLiability: s.tokenLiability,
      carbonFootprint: s.carbonFootprint,
      stockVolume: s.stockVolume,
      demand: s.demand,
    } as PlayerVariables;
  }

  private stripInternal(v: PlayerVariables): PlayerVariables {
    const { _playerId, ...rest } = v as any;
    return rest;
  }
}
