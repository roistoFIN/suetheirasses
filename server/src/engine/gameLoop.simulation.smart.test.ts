/**
 * Randomized multi-round, 4-player simulation with "smart" players — the same real-data
 * simulation approach as `gameLoop.simulation.test.ts`, but suing is driven by investigation
 * instead of blind guessing: a player digs into up to 2 incoming attacks per turn (finishing
 * an already-started investigation before beginning a new one, and only while there's real
 * cash cushion left), and only files a lawsuit once an attack is fully investigated
 * (`investigationLevel === 3`, `pickBestGround`'s suggested ground) with a real (>20%)
 * estimated win chance. Everything else (decision deployment) is identical to the blind-suing
 * simulation, so any behavioral difference measured is attributable to suing strategy alone.
 *
 * Added after a manual comparison run (120 games per strategy) found:
 *   - Lawsuit win rate: blind guessing ~6%, informed (this file's strategy) ~50% — confirming
 *     `pickBestGround`'s surfaced win-probability estimate is a genuinely reliable signal, not
 *     just flavor text, and that the investigation mechanic meaningfully rewards the player
 *     who pays for it.
 *   - Lawsuit *volume* dropped ~4.5x (2911 → 641 across the same 120 games) — informed players
 *     are far more selective, exactly the intended "investigate before committing" incentive.
 *   - Zero crashes, zero invariant violations in either strategy — this file's job is to keep
 *     that true specifically for the `digDeeper` → informed-`fileLawsuit` path at volume (over
 *     10,000 `digDeeper` calls in that comparison run), which
 *     `gameLoop.simulation.test.ts`'s blind-only strategy never exercises at all.
 *
 * See CLAUDE.md for the full write-up and the decision-balance findings from the same run.
 */
import { describe, it, expect } from 'vitest';
import { GameLoop, type EngineDataInput } from './gameLoop.js';
import { DEFAULT_FORMULA_SEEDS } from './defaultFormulas.js';
import type { DecisionDefinition, GameConfig, SubmittedDecisions, IncomingAttackInfo } from '@suetheirasses/shared';
import gameEngineData from '../data/game_engine.json' with { type: 'json' };
import gameConfigData from '../data/game_config.json' with { type: 'json' };

const decisions = gameEngineData as unknown as DecisionDefinition[];
const config = gameConfigData as unknown as GameConfig;

function mulberry32(seed: number) {
  return function (): number {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(arr: T[], rng: () => number): T | undefined {
  return arr.length === 0 ? undefined : arr[Math.floor(rng() * arr.length)];
}

function needsTarget(def: DecisionDefinition): boolean {
  return !!def.requiresTarget || Object.keys(def.impacts).some((k) => k.startsWith('target.'));
}

const strategicDecisions = decisions.filter((d) => d.level === 'Strategic');
const operationalDecisions = decisions.filter((d) => d.level === 'Operational');
const financialDecisions = decisions.filter((d) => d.level === 'Financial');

interface Violation { round: number; playerId?: string; message: string }

/** Same invariant set as gameLoop.simulation.test.ts — kept duplicated rather than shared,
 * matching this codebase's established "duplicate small pure logic, keep in sync by hand"
 * convention for test helpers (see CLAUDE.md's Test layers section). */
function checkInvariants(round: number, outcome: ReturnType<GameLoop['resolveTurn']>, violations: Violation[]) {
  for (const p of outcome.result.players) {
    for (const [k, val] of Object.entries(p.variables)) {
      if (k === 'shareOwnership') continue;
      if (typeof val === 'number' && !Number.isFinite(val)) {
        violations.push({ round, playerId: p.playerId, message: `variables.${k} is not finite: ${val}` });
      }
    }
    for (const [k, val] of Object.entries(p.derived)) {
      if (typeof val === 'number' && !Number.isFinite(val)) {
        violations.push({ round, playerId: p.playerId, message: `derived.${k} is not finite: ${val}` });
      }
    }
    if (p.riskGauge < 0 || p.riskGauge > 100 || !Number.isFinite(p.riskGauge)) {
      violations.push({ round, playerId: p.playerId, message: `riskGauge out of [0,100]: ${p.riskGauge}` });
    }
    const ownership = p.variables.shareOwnership;
    if (ownership) {
      const sum = Object.values(ownership).reduce((a, b) => a + b, 0);
      if (Math.abs(sum - 1) > 0.01) {
        violations.push({ round, playerId: p.playerId, message: `shareOwnership sums to ${sum}, not 1.0` });
      }
    }
  }
}

interface SmartGameResult {
  violations: Violation[];
  lawsuitsFiled: number;
  lawsuitsWonByPlaintiff: number;
  lawsuitsWonByDefendant: number;
  digsPerformed: number;
}

/** Same decision-deployment logic as gameLoop.simulation.test.ts's simulateGame — only the
 * suing strategy differs (dig-then-sue instead of blind guessing). */
function simulateSmartGame(seed: number, maxRounds: number): SmartGameResult {
  const rng = mulberry32(seed);
  const gameLoop = new GameLoop(config);
  gameLoop.loadFormulas(DEFAULT_FORMULA_SEEDS);
  gameLoop.loadDecisions(decisions);

  const roomId = `smart-sim-${seed}`;
  const playerIds = ['p1', 'p2', 'p3', 'p4'];
  const state: Record<string, {
    variables: unknown; engineState: unknown; cash: number; active: boolean;
    incomingAttacks: IncomingAttackInfo[]; alreadySued: Set<string>;
  }> = {};
  for (const id of playerIds) {
    state[id] = { variables: {}, engineState: {}, cash: 100000, active: true, incomingAttacks: [], alreadySued: new Set() };
  }

  const violations: Violation[] = [];
  const result: SmartGameResult = { violations, lawsuitsFiled: 0, lawsuitsWonByPlaintiff: 0, lawsuitsWonByDefendant: 0, digsPerformed: 0 };

  for (let round = 1; round <= maxRounds; round++) {
    const activeIds = playerIds.filter((id) => state[id].active);
    if (activeIds.length <= 1) break;

    for (const id of activeIds) {
      const sub: SubmittedDecisions = { strategic: [], operational: [], financial: [], lawsuits: [] };
      let suitsThisTurn = 0;

      // Dig into up to 2 incoming attacks per turn, finishing an already-started
      // investigation before beginning a new one, and only while a real cash cushion
      // remains — mirrors a player who invests deliberately, not compulsively.
      const engineInputsForDig: EngineDataInput[] = activeIds.map((pid) => ({
        id: pid, name: pid, company: { variables: state[pid].variables, engineState: state[pid].engineState },
      }));
      const candidates = state[id].incomingAttacks
        .filter((a) => a.investigationLevel < 3)
        .sort((a, b) => b.investigationLevel - a.investigationLevel);
      let digsThisTurn = 0;
      for (const attack of candidates) {
        if (digsThisTurn >= 2) break;
        if (state[id].cash - config.gameSettings.digDeeperCost < 15000) break;
        const digOutcome = gameLoop.digDeeper(id, attack.attackId, engineInputsForDig);
        if (!digOutcome.success) continue;
        state[id].variables = digOutcome.variables;
        state[id].engineState = digOutcome.engineStateUpdate;
        state[id].cash = digOutcome.newCash;
        const idx = state[id].incomingAttacks.findIndex((a) => a.attackId === attack.attackId);
        if (idx >= 0) state[id].incomingAttacks[idx] = digOutcome.attack;
        digsThisTurn++;
        result.digsPerformed++;
      }

      // Only sue over a fully-investigated, genuinely promising suggested ground.
      for (const attack of state[id].incomingAttacks) {
        if (suitsThisTurn >= config.gameSettings.maxLawsuitsPerPlayerPerTurn) break;
        if (attack.investigationLevel < 3 || !attack.suggestedGroundName || !attack.attackerId || !attack.decisionName) continue;
        if ((attack.successProbability ?? 0) <= 0.2) continue;
        const key = `${attack.attackerId}:${attack.decisionName}:${attack.suggestedGroundName}`;
        if (state[id].alreadySued.has(key)) continue;
        if (state[id].cash < config.gameSettings.lawsuitFilingCost) continue;
        const engineInputsForFee: EngineDataInput[] = activeIds.map((pid) => ({
          id: pid, name: pid, company: { variables: state[pid].variables, engineState: state[pid].engineState },
        }));
        const fee = gameLoop.chargeLawsuitFilingFee(roomId, id, engineInputsForFee);
        if (!fee.success) continue;
        state[id].variables = fee.variables;
        state[id].cash = fee.newCash;
        sub.lawsuits.push({ targetId: attack.attackerId, decisionName: attack.decisionName, groundName: attack.suggestedGroundName });
        state[id].alreadySued.add(key);
        suitsThisTurn++;
        result.lawsuitsFiled++;
      }

      const cash = state[id].cash;
      const numDecisions = 1 + Math.floor(rng() * 2);
      for (let i = 0; i < numDecisions; i++) {
        const roll = rng();
        const wantStrategic = roll < 0.3 && sub.strategic.length < (config.gameSettings.maxStrategicDecisionsPerTurn ?? 1);
        const wantFinancial = !wantStrategic && roll < 0.55 && sub.financial.length < (config.gameSettings.maxFinancialDecisionsPerTurn ?? 1);
        const pool = wantStrategic ? strategicDecisions : wantFinancial ? financialDecisions : operationalDecisions;
        const def = pick(pool, rng);
        if (!def) continue;
        const yearOneCash = def.impacts.cash?.schedule?.[1] ?? def.impacts.cash?.schedule?.['default'] ?? 0;
        if (yearOneCash < 0 && cash + yearOneCash < -20000) continue;
        const entry: { name: string; targetId?: string; amount?: number } = { name: def.decision };
        if (needsTarget(def)) {
          const target = pick(activeIds.filter((oid) => oid !== id), rng);
          if (!target) continue;
          entry.targetId = target;
        }
        if (def.shareTransactionType) entry.amount = Math.max(5000, Math.floor(cash * (0.05 + rng() * 0.15)));
        if (def.level === 'Strategic') sub.strategic.push(entry);
        else if (def.level === 'Financial') sub.financial.push(entry);
        else sub.operational.push(entry);
      }

      gameLoop.submitDecisions(roomId, id, sub);
    }

    const engineInputs: EngineDataInput[] = activeIds.map((id) => ({
      id, name: id, company: { variables: state[id].variables, engineState: state[id].engineState },
    }));
    const outcome = gameLoop.resolveTurn(roomId, round, engineInputs);
    checkInvariants(round, outcome, violations);

    const seenCaseIds = new Set<string>();
    for (const p of outcome.result.players) {
      for (const c of p.legalCases) {
        if (c.status !== 'resolved' || seenCaseIds.has(c.id)) continue;
        seenCaseIds.add(c.id);
        if (c.verdict === 'won') result.lawsuitsWonByPlaintiff++;
        else if (c.verdict === 'lost') result.lawsuitsWonByDefendant++;
      }
    }

    for (const update of outcome.companyUpdates) {
      state[update.playerId].variables = update.variables;
      state[update.playerId].engineState = update.engineState;
      state[update.playerId].cash = update.cash;
    }
    for (const p of outcome.result.players) {
      state[p.playerId].incomingAttacks = p.incomingAttacks;
    }
    for (const bp of outcome.bankruptedPlayers) {
      state[bp.playerId].active = false;
      state[bp.playerId].cash = bp.finalCash;
    }
    if (outcome.result.gameOver) break;
  }

  return result;
}

describe('GameLoop — randomized 4-player simulation with informed (dig-then-sue) players', () => {
  it('produces no NaN/Infinity variables, no out-of-range riskGauge, and no ownership drift across many random seeds', () => {
    const allViolations: Violation[] = [];
    for (let seed = 1; seed <= 10; seed++) {
      allViolations.push(...simulateSmartGame(seed, 40).violations);
    }
    if (allViolations.length > 0) {
      console.error(`${allViolations.length} invariant violations across simulated games:`, allViolations.slice(0, 20));
    }
    expect(allViolations).toEqual([]);
  });

  it('does not throw across many seeds, including heavy digDeeper usage', () => {
    for (let seed = 100; seed <= 115; seed++) {
      expect(() => simulateSmartGame(seed, 30)).not.toThrow();
    }
  });

  it('wins a meaningfully higher share of lawsuits than blind guessing (~6%) once suits are gated on full investigation + a real probability estimate', () => {
    let filed = 0, won = 0, lost = 0, digs = 0;
    for (let seed = 1; seed <= 20; seed++) {
      const r = simulateSmartGame(seed, 40);
      filed += r.lawsuitsFiled;
      won += r.lawsuitsWonByPlaintiff;
      lost += r.lawsuitsWonByDefendant;
      digs += r.digsPerformed;
    }
    // Sanity check the test is actually exercising digDeeper at volume, not accidentally
    // filing zero suits (which would make the win-rate assertion below vacuously pass).
    expect(digs).toBeGreaterThan(50);
    expect(filed).toBeGreaterThan(10);
    const resolved = won + lost;
    expect(resolved).toBeGreaterThan(5);
    const winRate = won / resolved;
    // Comfortably above blind guessing's ~6% and below 100% (adjustedProbability can still
    // swing either way from the estimate shown at investigation time — see CLAUDE.md's
    // "A case's probability chip is earned separately by each side" section) — 25% is a
    // deliberately loose floor so this doesn't flake on RNG, just catches a real regression
    // in the investigation mechanic's calibration.
    expect(winRate).toBeGreaterThan(0.25);
  });
});
