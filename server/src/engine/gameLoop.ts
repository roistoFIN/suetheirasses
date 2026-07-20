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
} from './calcEngine.js';
import { DecisionEngine } from './decisionEngine.js';
import type { DeployedDecision } from './decisionEngine.js';
import { LegalEngine } from './legalEngine.js';

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
  };
}

/** A player eliminated this turn — the caller must flag them bankrupt in the DB and broadcast `player:bankrupt`. */
export interface BankruptedPlayer {
  playerId: string;
  playerName: string;
}

/** Everything resolveTurn computed: the `turn:resolved` broadcast payload plus the side effects the caller must apply. */
export interface TurnResolutionOutcome {
  result: TurnResolutionResult;
  companyUpdates: CompanyPersistUpdate[];
  bankruptedPlayers: BankruptedPlayer[];
}

// ============================================================
// Internal types — not exported, used only within this module
// ============================================================

/** Engine state stored per-player inside Company.variables JSONB */
interface CompanyEngineState {
  activeDecisions: DeployedDecision[];
  depreciationLedger: DepreciationEntry[];
  legalCases: LegalCaseData[];
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

  // Per-room turn state (decisions submitted during Phase A)
  private submissions = new Map<string, Map<string, SubmittedDecisions>>();

  constructor(config: GameConfig) {
    this.config = config;
    this.adminVars = config.adminVariables;
  }

  /** Load all decision definitions from game_engine.json */
  loadDecisions(definitions: DecisionDefinition[]): void {
    this.decisionEngine.setDefinitions(definitions);
    this.legalEngine.setDefinitions(definitions);
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
    for (const [, ctx] of ctxs) {
      if (!ctx.submittedDecisions) continue;
      this.processNewDecisions(ctx, round);
    }

    // ── Step 2 — Advance all active decisions by one year ──────
    // Extract absolute schedule deltas directly from impact application (FORMULAS §4-§5)
    const absDeltasMap = new Map<string, { revenueDelta: number; financeCostDelta: number; taxCostDelta: number; receivablesDelta: number; cashDelta: number }>();
    const varsList: PlayerVariables[] = [];
    for (const [pid, ctx] of ctxs) {
      const result = this.decisionEngine.advanceAndApply(
        pid,
        ctx.vars,
        ctx.engineState.activeDecisions,
        round,
      );
      ctx.vars = result.updatedVars;
      ctx.engineState.activeDecisions = result.updatedActiveDecisions;

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

      varsList.push(result.updatedVars);
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
    const marketShares = calculateCompetitivenessAndMarketShare(playerIds, varsList, this.adminVars);
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
      ctx.vars.volume = calculateVolume(ctx.vars, ctx.vars.marketShare || 0, totalVol);
    }

    // ── Step 6 — P&L (FORMULAS §4) ────────────────────────────
    const plMap = new Map<string, ReturnType<typeof calculatePL>>();
    for (const [pid, ctx] of ctxs) {
      const dep = depreciationMap.get(pid) ?? 0;
      const deltas = absDeltasMap.get(pid) ?? { revenueDelta: 0, financeCostDelta: 0, taxCostDelta: 0, receivablesDelta: 0, cashDelta: 0 };
      plMap.set(pid, calculatePL(ctx.vars, ctx.vars.volume || 0, dep, this.adminVars, {
        revenueDelta: deltas.revenueDelta,
        financeCostDelta: deltas.financeCostDelta,
        taxCostDelta: deltas.taxCostDelta,
      }));
    }

    // ── Step 7 — Balance sheet (FORMULAS §5) ──────────────────
    // First, load existing legal cases from engineState (before calculating legal exposure)
    const allCases: LegalCaseData[] = [];
    for (const [, ctx] of ctxs) {
      for (const c of ctx.engineState.legalCases) {
        if (c.status !== 'resolved') {
          allCases.push(c);
        }
      }
    }

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
      const bs = updateBalanceSheet(ctx.vars, pl.netProfit, dep, pl.revenue, legalExposure, this.adminVars, deltas.receivablesDelta);
      ctx.vars.cash = bs.cash;
      ctx.vars.reserves = bs.reserves;
      ctx.vars.receivables = bs.receivables;
      ctx.vars.equity = bs.equity;
      ctx.vars.stockValue = bs.stockValue;
      ctx.vars.legalExposure = bs.legalExposure;
      ctx.vars.legalExposureRatio = calculateLegalExposureRatio(legalExposure, ctx.vars.cash, this.adminVars);
    }

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
        const newCase = this.legalEngine.fileLawsuit(
          ctx.playerId,
          filing.targetId,
          filing.decisionName,
          filing.groundName,
          targetActiveDecisions,
          roomId,
        );
        if (newCase) allCases.push(newCase);
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
      );
      const adjProb = calculateAdjustedProbability(
        trial.baseProbability,
        defCtx.vars.scrutiny,
        defLegalExposureRatio,
        this.adminVars,
      );
      const won = Math.random() < adjProb;
      trial.adjustedProbability = adjProb;
      trial.verdict = won ? 'won' : 'lost';
      trial.status = 'resolved';
      trial.resolvedAt = new Date();
      casesResolvedThisTurn.push(trial);
    }

    // ── Step 9 — Process resolved cases & apply cash settlements (FORMULAS §5, §16) ──
    // Apply verdict cash flows: loser pays stakes to winner. Track amounts actually
    // RECEIVED this turn per player — this is the "case-siirrot: saatu" line of the
    // operating cash flow (FORMULAS §5) and feeds the §16 bankruptcy waterfall pool.
    const legalReceivedThisTurn = new Map<string, number>();
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

      bankruptedPlayers.push({ playerId: pid, playerName: ctx.playerName });
    }

    // ── Step 11 — Risk gauge (FORMULAS §7) ────────────────────
    const riskMap = new Map<string, number>();
    for (const pid of playersStillActive) {
      const ctx = ctxs.get(pid)!;
      const openCases = allCases
        .filter(c => c.defendantId === pid && c.status !== 'resolved')
        .map(c => ({ probability: c.adjustedProbability ?? c.baseProbability, stakes: c.stakes }));
      riskMap.set(pid, calculateRiskGauge(ctx.vars, openCases, this.adminVars));
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
          })),
          depreciationLedger: ctx.engineState.depreciationLedger,
          legalCases: allCases.filter(c => c.plaintiffId === pid || c.defendantId === pid),
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
    const marketShares = calculateCompetitivenessAndMarketShare(playerIds, varsList, this.adminVars);
    for (const pid of playerIds) {
      varsByPlayer.get(pid)!.marketShare = marketShares.get(pid) || 0;
    }

    // FORMULAS §3 — volume with supply cap
    const totalVol = this.config.gameSettings.totalMarketVolumeTonnesPerYear;
    for (const pid of playerIds) {
      const vars = varsByPlayer.get(pid)!;
      vars.volume = calculateVolume(vars, vars.marketShare || 0, totalVol);
    }

    const results: PlayerTurnResult[] = [];
    for (const pid of playerIds) {
      const vars = varsByPlayer.get(pid)!;
      // FORMULAS §4 — P&L (no decisions yet, so no absolute schedule deltas)
      const pl = calculatePL(vars, vars.volume || 0, 0, this.adminVars);
      // FORMULAS §5 — balance sheet (no legal exposure yet — no cases exist on turn 1)
      const bs = updateBalanceSheet(vars, pl.netProfit, 0, pl.revenue, 0, this.adminVars);
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
        riskGauge: calculateRiskGauge(vars, [], this.adminVars),
      });
    }

    return { round, players: results, gameOver: false };
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
      })),
      depreciationLedger: (raw.depreciationLedger ?? []) as DepreciationEntry[],
      legalCases: (raw.legalCases ?? []) as LegalCaseData[],
    };
  }

  private processNewDecisions(ctx: PlayerTurnContext, year: number): void {
    const sub = ctx.submittedDecisions!;
    const maxStrat = this.config.gameSettings.maxStrategicDecisionsPerTurn;
    const maxOp = this.config.gameSettings.maxOperationalDecisionsPerTurn;

    // Track absolute deltas from newly deployed decisions on the same turn
    const newDecisionAbsDeltas: Array<{ revenueDelta: number; financeCostDelta: number; taxCostDelta: number; receivablesDelta: number; cashDelta: number }> = [];

    for (const { name } of sub.strategic.slice(0, maxStrat)) {
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
      const inst = this.decisionEngine.deploy(ctx.playerId, def, year);
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

    for (const { name } of sub.operational.slice(0, maxOp)) {
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
      const inst = this.decisionEngine.deploy(ctx.playerId, def, year);
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
