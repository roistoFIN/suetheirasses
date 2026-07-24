/**
 * Randomized multi-round, 4-player simulation against the REAL seeded decision library
 * (game_engine.json/game_config.json/defaultFormulas.ts — the exact data prisma/seed.ts
 * puts in Postgres), not this suite's usual small hand-written fixture decisions. Added
 * after a manual simulation run (random decisions + random lawsuits, 60 games) surfaced
 * two real bugs neither the fixture-based tests nor manual play had caught:
 *
 *   1. `applyDecisionImpacts`/`applyTargetImpacts`'s absolute-impact write was a bare
 *      `v[field] += value`, which corrupts an initially-`undefined` optional field
 *      (`revenue`/`financeCost`/`taxCost` — "Derived (computed each turn)" fields never
 *      seeded by `startingVars()`) to `NaN` the instant any decision targets it directly
 *      (Channel Stuffing→revenue, Tax Planning→taxCost, Payday Loan→financeCost) — and
 *      NaN then persists forever, since nothing else in a turn overwrites those three
 *      fields the way receivables/equity/etc. get freshly recomputed every turn.
 *   2. The `riskGauge` formula's scrutiny term (`MIN(1,scrutiny/100)`) had no lower
 *      clamp — `scrutiny` has no floor (unlike outrage, nothing drives it back up once
 *      negative), so a negative scrutiny value pushed the whole gauge below its
 *      documented 0-100 range.
 *
 * Both are fixed (see calcEngine.ts/defaultFormulas.ts and CLAUDE.md's "applyDecisionImpacts'
 * absolute-impact write corrupted an undefined field to NaN" section). This file keeps the
 * simulation itself as a permanent regression tool — a hand-written fixture library can
 * only ever exercise the specific fields/decisions someone thought to write a test for; a
 * real, evolving 83-legal-risk/45-decision library is exactly the kind of thing where a
 * one-off combination (a specific decision's specific field name) is what actually breaks,
 * not the general shape of the math. If you add a new decision whose `impacts` targets an
 * optional/derived `PlayerVariables` field, this is the test most likely to catch a
 * reintroduced version of bug #1 without anyone having to think to write a dedicated case.
 */
import { describe, it, expect } from 'vitest';
import { GameLoop, type EngineDataInput } from './gameLoop.js';
import { DEFAULT_FORMULA_SEEDS } from './defaultFormulas.js';
import type { DecisionDefinition, GameConfig, SubmittedDecisions } from '@suetheirasses/shared';
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
const allGrounds: { decisionName: string; groundName: string }[] = decisions.flatMap(
  (d) => (d.legalRisks ?? []).map((r) => ({ decisionName: d.decision, groundName: r.name })),
);

interface Violation { round: number; playerId?: string; message: string }

/** Every numeric field in `variables`/`derived` must be finite; riskGauge must be within
 * its documented [0,100] range; shareOwnership fractions must sum to ~1. */
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

/** Runs one full randomized game (up to maxRounds) and returns every invariant violation
 * found — empty means a clean run. Mirrors real client behavior: 1-2 decisions per active
 * player per turn (skipping ones that would obviously overdraw cash), 0-2 blind lawsuits
 * per turn (paid for via the real `chargeLawsuitFilingFee`, exactly like a live game). */
function simulateGame(seed: number, maxRounds: number): Violation[] {
  const rng = mulberry32(seed);
  const gameLoop = new GameLoop(config);
  gameLoop.loadFormulas(DEFAULT_FORMULA_SEEDS);
  gameLoop.loadDecisions(decisions);

  const roomId = `sim-${seed}`;
  const playerIds = ['p1', 'p2', 'p3', 'p4'];
  const state: Record<string, { variables: unknown; engineState: unknown; cash: number; active: boolean }> = {};
  for (const id of playerIds) state[id] = { variables: {}, engineState: {}, cash: 100000, active: true };

  const violations: Violation[] = [];

  for (let round = 1; round <= maxRounds; round++) {
    const activeIds = playerIds.filter((id) => state[id].active);
    if (activeIds.length <= 1) break;

    for (const id of activeIds) {
      const cash = state[id].cash;
      const sub: SubmittedDecisions = { strategic: [], operational: [], financial: [], lawsuits: [] };
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

      const numSuits = rng() < 0.4 ? (rng() < 0.3 ? 2 : 1) : 0;
      for (let i = 0; i < numSuits; i++) {
        const target = pick(activeIds.filter((oid) => oid !== id), rng);
        const ground = pick(allGrounds, rng);
        if (!target || !ground) continue;
        const engineInputsNow: EngineDataInput[] = activeIds.map((pid) => ({
          id: pid, name: pid, company: { variables: state[pid].variables, engineState: state[pid].engineState },
        }));
        const fee = gameLoop.chargeLawsuitFilingFee(roomId, id, engineInputsNow);
        if (!fee.success) continue;
        state[id].variables = fee.variables;
        state[id].cash = fee.newCash;
        sub.lawsuits.push({ targetId: target, decisionName: ground.decisionName, groundName: ground.groundName });
      }

      gameLoop.submitDecisions(roomId, id, sub);
    }

    const engineInputs: EngineDataInput[] = activeIds.map((id) => ({
      id, name: id, company: { variables: state[id].variables, engineState: state[id].engineState },
    }));
    const outcome = gameLoop.resolveTurn(roomId, round, engineInputs);
    checkInvariants(round, outcome, violations);

    for (const update of outcome.companyUpdates) {
      state[update.playerId].variables = update.variables;
      state[update.playerId].engineState = update.engineState;
      state[update.playerId].cash = update.cash;
    }
    for (const bp of outcome.bankruptedPlayers) {
      state[bp.playerId].active = false;
      state[bp.playerId].cash = bp.finalCash;
    }
    if (outcome.result.gameOver) break;
  }

  return violations;
}

describe('GameLoop — randomized 4-player simulation (regression, real decision library)', () => {
  it('produces no NaN/Infinity variables, no out-of-range riskGauge, and no ownership drift across many random seeds', () => {
    const allViolations: Violation[] = [];
    for (let seed = 1; seed <= 8; seed++) {
      allViolations.push(...simulateGame(seed, 40));
    }
    if (allViolations.length > 0) {
      console.error(`${allViolations.length} invariant violations across simulated games:`, allViolations.slice(0, 20));
    }
    expect(allViolations).toEqual([]);
  });

  it('does not throw for any random combination of decisions/lawsuits across many seeds', () => {
    for (let seed = 100; seed <= 115; seed++) {
      expect(() => simulateGame(seed, 30)).not.toThrow();
    }
  });

  it('regression: deploying Channel Stuffing no longer corrupts variables.revenue to NaN (a real bug found by this simulation)', () => {
    const gameLoop = new GameLoop(config);
    gameLoop.loadFormulas(DEFAULT_FORMULA_SEEDS);
    gameLoop.loadDecisions(decisions);
    const roomId = 'room-channel-stuffing';
    const players: EngineDataInput[] = [
      { id: 'p1', name: 'Alice', company: { variables: {}, engineState: {} } },
      { id: 'p2', name: 'Bob', company: { variables: {}, engineState: {} } },
    ];
    gameLoop.submitDecisions(roomId, 'p1', { strategic: [], operational: [{ name: 'Channel Stuffing' }], financial: [], lawsuits: [] });
    gameLoop.submitDecisions(roomId, 'p2', { strategic: [], operational: [], financial: [], lawsuits: [] });

    const outcome = gameLoop.resolveTurn(roomId, 1, players);
    const alice = outcome.result.players.find((p) => p.playerId === 'p1')!;
    expect(Number.isFinite(alice.variables.revenue)).toBe(true);
    expect(Number.isFinite(alice.derived.revenue)).toBe(true);
  });

  it('regression: a negative scrutiny value no longer pushes riskGauge below 0 (a real bug found by this simulation)', () => {
    const gameLoop = new GameLoop(config);
    gameLoop.loadFormulas(DEFAULT_FORMULA_SEEDS);
    gameLoop.loadDecisions(decisions);
    const roomId = 'room-negative-scrutiny';
    const players: EngineDataInput[] = [
      { id: 'p1', name: 'Alice', company: { variables: { ...(config.playerStartingValues as any), scrutiny: -50 }, engineState: {} } },
      { id: 'p2', name: 'Bob', company: { variables: {}, engineState: {} } },
    ];
    gameLoop.submitDecisions(roomId, 'p1', { strategic: [], operational: [], financial: [], lawsuits: [] });
    gameLoop.submitDecisions(roomId, 'p2', { strategic: [], operational: [], financial: [], lawsuits: [] });

    const outcome = gameLoop.resolveTurn(roomId, 1, players);
    const alice = outcome.result.players.find((p) => p.playerId === 'p1')!;
    expect(alice.riskGauge).toBeGreaterThanOrEqual(0);
  });

  it('regression: an idle player (never submits a decision) neither profits nor loses cash, turn over turn', () => {
    // Production is always capacity-bound at maxSupply = installedCapacity * capacityUtilization
    // (350 tons) rather than market-share-bound, for any 2-4 player game — see CLAUDE.md's
    // "How default values of variables could be changed so idle players break even" — so this
    // holds regardless of player count/symmetry. price/operatingExpenses were tuned so that
    // (price - materialCostPerTon - logisticsCostPerTon) * maxSupply exactly equals
    // operatingExpenses + staffCost + baseFinanceCost, i.e. profitBeforeTax = 0 at the seeded
    // defaults with zero decisions ever deployed.
    const gameLoop = new GameLoop(config);
    gameLoop.loadFormulas(DEFAULT_FORMULA_SEEDS);
    gameLoop.loadDecisions(decisions);
    const roomId = 'room-idle-breakeven';
    const state: Record<string, { variables: unknown; engineState: unknown }> = {
      p1: { variables: {}, engineState: {} },
      p2: { variables: {}, engineState: {} },
    };

    for (let round = 1; round <= 5; round++) {
      gameLoop.submitDecisions(roomId, 'p1', { strategic: [], operational: [], financial: [], lawsuits: [] });
      gameLoop.submitDecisions(roomId, 'p2', { strategic: [], operational: [], financial: [], lawsuits: [] });
      const players: EngineDataInput[] = ['p1', 'p2'].map((id) => ({
        id, name: id, company: { variables: state[id].variables, engineState: state[id].engineState },
      }));
      const outcome = gameLoop.resolveTurn(roomId, round, players);
      for (const update of outcome.companyUpdates) {
        state[update.playerId].variables = update.variables;
        state[update.playerId].engineState = update.engineState;
        expect(update.cash).toBeCloseTo(100000, 6);
      }
    }
  });
});
