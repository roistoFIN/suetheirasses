/**
 * Randomized simulation, same methodology as `gameLoop.simulation.test.ts` (see CLAUDE.md's
 * "Randomized-simulation testing" section) — but exercising `botService.ts`'s real
 * decision-making against the real seeded decision library, with the bot's human opponent
 * doing absolutely nothing every turn.
 *
 * Added after a user-reported bug: the bot would reliably bankrupt itself even when its
 * only opponent never submitted a single decision or lawsuit — a pure self-inflicted
 * failure with no adversary involved at all. Root-caused to several independent gaps, all
 * fixed in `botService.ts`/`GameEngine.runBotTurn` (see each function's own doc comment):
 *   - Affordability/scoring only ever read a decision's `cash` field at year 1, missing
 *     same-turn `operatingExpenses`/`staffCost`/`otherIncome`/`financeCost` movement and a
 *     `debt` impact's real financeCost-equivalent cost (`estimatedFirstYearCashEffect`).
 *   - Both were also blind to genuinely BACKLOADED costs (zero at deployment, landing in a
 *     later year) — fixed by scoring/budgeting against the single worst year across a
 *     decision's whole schedule, not just year 1 (`worstCaseCashEffect`, used internally by
 *     `scoreDecision`/`pickBotDecisions`).
 *   - No general "is my own cash trending down" or "am I already structurally
 *     unprofitable" self-preservation existed (`isCashTrendDeclining`/
 *     `computeEffectiveReserve`/`isStructurallyUnprofitable`).
 *   - No accounting for what ALREADY-active decisions will cost NEXT turn regardless of
 *     new picks (`projectedNextTurnOwnCashEffect`) — several already-active backloaded
 *     decisions could land their bills in the same future turn.
 *   - Biggest single lever: the bot never validated against `DecisionEngine.canDeploy` at
 *     all, so it kept "picking" a decision that would be silently rejected (redeploy-lock
 *     cooldown, still-maturing instance, mutual exclusion) — each rejected pick had
 *     already been credited to the bot's own running cash estimate, inflating what it
 *     believed it could then afford to spend on OTHER things that turn (Buy Shares chief
 *     among them), even though the credited windfall never actually landed.
 *   - `GameLoop.applyShareTransaction` charges the buyer's full requested spend even once
 *     `fractionBought` has already capped at 1 (100% owned) — nothing refunds the excess.
 *     `pickBotShareBuy`'s spend is now clamped to `maxUsefulSpend`, computed from the
 *     target's own `stockValue`/`totalSharesOutstanding`.
 *
 * This file's job is to keep the aggregate outcome of all those fixes true empirically,
 * the same way the other simulation suites keep decision-balance findings honest — a
 * regression here would mean the bot is bankrupting itself again, regardless of which
 * specific mechanism reintroduces it.
 */
import { describe, it, expect } from 'vitest';
import { GameLoop, type EngineDataInput } from '../engine/gameLoop.js';
import { DEFAULT_FORMULA_SEEDS } from '../engine/defaultFormulas.js';
import {
  pickBotDecisions,
  pickBotShareBuy,
  pickAttacksToInvestigate,
  shouldFileLawsuit,
  estimatedFirstYearCashEffect,
  computeEffectiveReserve,
  projectedNextTurnOwnCashEffect,
  isStructurallyUnprofitable,
  BOT_CASH_TREND_WINDOW,
} from './botService.js';
import type {
  DecisionDefinition,
  GameConfig,
  SubmittedDecisions,
  IncomingAttackInfo,
  SubmittedLawsuitEntry,
  ActiveDecisionInstance,
  PlayerVariables,
  PlayerDerivedStats,
} from '@suethemchickens/shared';
import gameEngineData from '../data/game_engine.json' with { type: 'json' };
import gameConfigData from '../data/game_config.json' with { type: 'json' };

const decisions = gameEngineData as unknown as DecisionDefinition[];
const config = gameConfigData as unknown as GameConfig;

interface BotState {
  variables: Partial<PlayerVariables>;
  derived: Partial<PlayerDerivedStats>;
  engineState: unknown;
  cash: number;
  active: boolean;
  incomingAttacks: IncomingAttackInfo[];
  activeDecisions: ActiveDecisionInstance[];
  lastRiskGauge: number;
}

/** Plays one full game: a real bot (using the actual `botService.ts` functions, the same
 * ones `GameEngine.runBotTurn` calls) against a human who submits nothing at all, ever —
 * no decisions, no lawsuits, no digs. Returns the round the bot went bankrupt, if any. */
function simulateIdleOpponentGame(roomId: string, maxRounds: number): { bankruptRound: number | undefined; finalCash: number } {
  const gameLoop = new GameLoop(config);
  gameLoop.loadFormulas(DEFAULT_FORMULA_SEEDS);
  gameLoop.loadDecisions(decisions);

  const humanId = 'human-1';
  const botId = 'bot-1';
  const playerIds = [humanId, botId];
  const state: Record<string, BotState> = {};
  for (const id of playerIds) {
    state[id] = { variables: {}, derived: {}, engineState: {}, cash: 100_000, active: true, incomingAttacks: [], activeDecisions: [], lastRiskGauge: 0 };
  }
  const cashHistory: number[] = [];
  let bankruptRound: number | undefined;
  let finalCash = state[botId].cash;

  for (let round = 1; round <= maxRounds; round++) {
    const activeIds = playerIds.filter((id) => state[id].active);
    if (activeIds.length <= 1) break;

    // The human does absolutely nothing, every single turn.
    gameLoop.submitDecisions(roomId, humanId, { strategic: [], operational: [], financial: [], lawsuits: [] });

    let cash = state[botId].cash;
    const { digDeeperCost, lawsuitFilingCost } = config.gameSettings;
    const interestRate = config.adminVariables.finance.interestRate;

    // Mirrors GameEngine.runBotTurn's own effective-reserve computation exactly.
    cashHistory.push(cash);
    if (cashHistory.length > BOT_CASH_TREND_WINDOW) cashHistory.shift();
    const projectedNextTurn = projectedNextTurnOwnCashEffect(state[botId].activeDecisions, decisions, interestRate);
    let effectiveReserve = computeEffectiveReserve(cashHistory, projectedNextTurn);
    const structurallyUnprofitable = isStructurallyUnprofitable(
      state[botId].variables.operatingExpenses ?? 0,
      state[botId].variables.staffCost ?? 0,
      state[botId].variables.otherIncome ?? 0,
      state[botId].derived.financeCost ?? 0,
      state[botId].derived.revenue ?? 0,
    );
    if (structurallyUnprofitable) effectiveReserve = Math.max(effectiveReserve, cash);

    const dugAttacks: IncomingAttackInfo[] = [];
    for (const attack of pickAttacksToInvestigate(state[botId].incomingAttacks)) {
      if (cash - digDeeperCost < effectiveReserve) break;
      const engineInputs: EngineDataInput[] = activeIds.map((pid) => ({ id: pid, name: pid, company: { variables: state[pid].variables, engineState: state[pid].engineState } }));
      const outcome = gameLoop.digDeeper(botId, attack.attackId, engineInputs);
      if (outcome.success) {
        state[botId].variables = outcome.variables;
        state[botId].engineState = outcome.engineStateUpdate;
        cash = outcome.newCash;
        dugAttacks.push(outcome.attack);
      }
    }

    const candidateAttacks = [...state[botId].incomingAttacks.filter((a) => a.suggestedGrounds !== undefined), ...dugAttacks];
    const lawsuits: SubmittedLawsuitEntry[] = [];
    for (const attack of candidateAttacks) {
      const bestGroundName = attack.suggestedGrounds?.[0]?.name;
      if (!attack.attackerId || !attack.decisionName || !bestGroundName) continue;
      if (!shouldFileLawsuit(attack, cash, lawsuitFilingCost, effectiveReserve)) continue;
      const engineInputs: EngineDataInput[] = activeIds.map((pid) => ({ id: pid, name: pid, company: { variables: state[pid].variables, engineState: state[pid].engineState } }));
      const fee = gameLoop.chargeLawsuitFilingFee(roomId, botId, engineInputs);
      if (!fee.success) continue;
      state[botId].variables = fee.variables;
      cash = fee.newCash;
      lawsuits.push({ targetId: attack.attackerId, decisionName: attack.decisionName, groundName: bestGroundName });
      gameLoop.submitDecisions(roomId, botId, { strategic: [], operational: [], financial: [], lawsuits });
    }

    const picks = pickBotDecisions(
      decisions,
      cash,
      humanId,
      state[botId].lastRiskGauge,
      effectiveReserve,
      interestRate,
      structurallyUnprofitable,
      state[botId].activeDecisions,
      config.gameSettings.permanentEffectCooldownYears,
    );
    const decisionsSub: SubmittedDecisions = { strategic: [], operational: [], financial: [], lawsuits };
    for (const entry of picks) {
      const def = decisions.find((d) => d.decision === entry.name);
      const bucket: 'strategic' | 'operational' | 'financial' = def?.level === 'Strategic' ? 'strategic' : def?.level === 'Financial' ? 'financial' : 'operational';
      decisionsSub[bucket].push(entry);
      if (def) cash += estimatedFirstYearCashEffect(def, interestRate);
    }

    let maxUsefulSpend = Infinity;
    const humanStockValue = state[humanId].variables.stockValue;
    const humanTotalShares = state[humanId].variables.totalSharesOutstanding;
    if (humanStockValue !== undefined && humanTotalShares) {
      const currentBotFraction = state[humanId].variables.shareOwnership?.[botId] ?? 0;
      maxUsefulSpend = Math.max(0, 1 - currentBotFraction) * humanTotalShares * humanStockValue;
    }
    const buyAmount = pickBotShareBuy(cash, decisionsSub.financial.length, config.gameSettings.maxFinancialDecisionsPerTurn ?? 2, effectiveReserve, maxUsefulSpend);
    if (buyAmount !== undefined) {
      decisionsSub.financial.push({ name: 'Buy Shares', targetId: humanId, amount: buyAmount });
    }
    gameLoop.submitDecisions(roomId, botId, decisionsSub);

    const engineInputs: EngineDataInput[] = activeIds.map((id) => ({ id, name: id, company: { variables: state[id].variables, engineState: state[id].engineState } }));
    const outcome = gameLoop.resolveTurn(roomId, round, engineInputs);

    for (const update of outcome.companyUpdates) {
      state[update.playerId].variables = update.variables;
      state[update.playerId].engineState = update.engineState;
      state[update.playerId].cash = update.cash;
    }
    for (const p of outcome.result.players) {
      state[p.playerId].incomingAttacks = p.incomingAttacks;
      state[p.playerId].activeDecisions = p.activeDecisions;
      state[p.playerId].derived = p.derived;
      if (p.playerId === botId) state[botId].lastRiskGauge = p.riskGauge;
    }
    for (const bp of outcome.bankruptedPlayers) {
      state[bp.playerId].active = false;
      state[bp.playerId].cash = bp.finalCash;
      if (bp.playerId === botId && bankruptRound === undefined) bankruptRound = round;
    }

    finalCash = state[botId].cash;
    if (outcome.result.gameOver) break;
  }

  return { bankruptRound, finalCash };
}

describe('botService — bot vs. a fully idle human opponent', () => {
  it('does not throw across many independent games', () => {
    for (let i = 1; i <= 20; i++) {
      expect(() => simulateIdleOpponentGame(`idle-throw-${i}`, 40)).not.toThrow();
    }
  });

  // 20 rounds comfortably covers a realistic game length (CLAUDE.md: typical games run
  // ~11-18 rounds with informed play; 18 is also the default lateGameRoundThreshold). A
  // bot bankrupting itself well inside a realistic game length, with zero adversarial
  // pressure, is the exact bug this suite guards against. The threshold is intentionally
  // generous (not near-zero) — this bot is deliberately heuristic, not optimal (see
  // botService.ts's own header), so an occasional self-inflicted bankruptcy against the
  // full, unfiltered 200+ decision library isn't itself a regression; a HIGH rate is.
  it('bankrupts itself well within a realistic game length only rarely, not routinely', () => {
    let bankruptWithin20 = 0;
    const trials = 40;
    for (let i = 1; i <= trials; i++) {
      const { bankruptRound } = simulateIdleOpponentGame(`idle-realistic-${i}`, 20);
      if (bankruptRound !== undefined) bankruptWithin20++;
    }
    // Before the fixes this guards, the observed rate was routinely 80%+ even over a full
    // 60-round game (most of it landing well before round 20). A generous 50% ceiling
    // still catches a real regression while tolerating this bot's inherent randomness and
    // deliberately non-optimal play.
    expect(bankruptWithin20 / trials).toBeLessThan(0.5);
  });
});
