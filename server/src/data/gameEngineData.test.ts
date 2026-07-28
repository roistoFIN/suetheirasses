import { describe, it, expect } from 'vitest';
import gameEngineData from './game_engine.json' with { type: 'json' };
import type { DecisionDefinition } from '@suethemchickens/shared';

const decisions = gameEngineData as unknown as DecisionDefinition[];

/**
 * Regression guard for a real, reported content-completeness bug (see CLAUDE.md's
 * *Every decision must bring a real benefit* section and its sibling gap covering
 * `target.*` fields): a decision's `impacts` entry can name a field that clearly matches
 * its own description/flavor (a marketing decision with a `demand` slot, an attack
 * decision with a `target.scrutiny` slot) but never actually gets a non-zero value filled
 * in — every schedule key stuck at 0. `GamePhase.tsx`'s `summarizeEffects` silently drops
 * any impact line whose entire schedule is zero, so the decision reads as having fewer
 * (or, for an attack decision with no other impact, effectively no) real effects than its
 * description promises. The first fix for this (the "18% gap" pass) only covered a
 * decision's own benefit fields; a second pass found the same bug independently affecting
 * `target.*` fields on attack decisions — 81 decisions, 104 fields, including one a player
 * directly reported ("Forged Regulatory Violation Notice" only ever showed a cash cost,
 * never the `target.scrutiny` harm its own description promises). This test makes the
 * "scan the whole library" step from that fix permanent rather than a one-off script, so
 * future content additions can't silently reintroduce the same class of bug.
 */
describe('game_engine.json — every declared impact field has a real (non-zero) effect', () => {
  it('has no impact field whose entire schedule is stuck at zero', () => {
    const offenders: string[] = [];
    for (const def of decisions) {
      for (const [field, impact] of Object.entries(def.impacts)) {
        const values = Object.values(impact.schedule);
        const allZero = values.length > 0 && values.every((v) => v === 0);
        if (allZero) {
          offenders.push(`${def.decision} / ${field}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
