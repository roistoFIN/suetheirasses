import { describe, it, expect } from 'vitest';
import type { PlayerVariables, PlayerDerivedStats, GameTimelineResponse, TimelineLawsuitEvent } from '@suetheirasses/shared';

// ── Utility functions duplicated from GameTimelineView.tsx for testing ──────────────
// Same "duplicate small pure logic, keep this test file lightweight (no Mantine/
// tabler-icons/@mantine/charts import chain)" convention GamePhase.utils.test.ts
// already established — keep any copy in sync with the real implementation by hand.

function getKpiFieldValue(point: { variables: PlayerVariables; derived: PlayerDerivedStats; riskGauge: number }, field: string): number {
  if (field === 'riskGauge') return point.riskGauge;
  const [bucket, key] = field.split('.') as ['variables' | 'derived', string];
  return (point[bucket] as any)?.[key] ?? 0;
}

type HappeningEntry =
  | { id: string; type: 'decision'; round: number; playerName: string; decisionName: string; targetName?: string }
  | { id: string; type: 'lawsuitFiled'; round: number; lawsuit: TimelineLawsuitEvent; plaintiffName: string; defendantName: string }
  | { id: string; type: 'lawsuitResolved'; round: number; lawsuit: TimelineLawsuitEvent; plaintiffName: string; defendantName: string };

function buildHappenings(data: GameTimelineResponse): HappeningEntry[] {
  const nameById = new Map(data.players.map((p) => [p.playerId, p.playerName]));
  const nameOf = (id?: string) => (id ? nameById.get(id) ?? 'Unknown' : undefined);

  const entries: HappeningEntry[] = [];

  for (const d of data.decisions) {
    entries.push({
      id: `decision-${d.instanceId}`,
      type: 'decision',
      round: d.deployedYear,
      playerName: nameOf(d.playerId) ?? 'Unknown',
      decisionName: d.decisionName,
      targetName: nameOf(d.targetId),
    });
  }

  for (const l of data.lawsuits) {
    entries.push({ id: `lawsuit-filed-${l.id}`, type: 'lawsuitFiled', round: l.filedRound, lawsuit: l, plaintiffName: l.plaintiffName, defendantName: l.defendantName });
    if (l.resolvedRound !== undefined) {
      entries.push({ id: `lawsuit-resolved-${l.id}`, type: 'lawsuitResolved', round: l.resolvedRound, lawsuit: l, plaintiffName: l.plaintiffName, defendantName: l.defendantName });
    }
  }

  return entries.sort((a, b) => a.round - b.round);
}

function rankPlayersAtRound(
  data: GameTimelineResponse,
  round: number,
  field: string,
): Array<{ playerId: string; playerName: string; bankrupt: boolean; eliminatedRound?: number; value: number }> {
  return data.players
    .map((p) => {
      const history = data.kpiHistory[p.playerId] ?? [];
      let value = 0;
      for (const point of history) {
        if (point.round > round) break;
        value = getKpiFieldValue(point, field);
      }
      return { playerId: p.playerId, playerName: p.playerName, bankrupt: p.bankrupt, eliminatedRound: p.eliminatedRound, value };
    })
    .sort((a, b) => b.value - a.value);
}

// ── Fixtures ─────────────────────────────────────────────────────────

function makeData(overrides: Partial<GameTimelineResponse> = {}): GameTimelineResponse {
  return {
    roomId: 'room-1',
    currentRound: 5,
    gameOver: false,
    winnerId: undefined,
    players: [
      { playerId: 'p1', playerName: 'Alice', bankrupt: false },
      { playerId: 'p2', playerName: 'Bob', bankrupt: true, eliminatedRound: 3 },
    ],
    kpiHistory: {
      p1: [
        { round: 1, variables: {} as PlayerVariables, derived: {} as PlayerDerivedStats, riskGauge: 10 },
        { round: 2, variables: { cash: 90000 } as PlayerVariables, derived: {} as PlayerDerivedStats, riskGauge: 20 },
      ],
      p2: [
        { round: 1, variables: { cash: 50000 } as PlayerVariables, derived: {} as PlayerDerivedStats, riskGauge: 5 },
      ],
    },
    decisions: [],
    lawsuits: [],
    ...overrides,
  };
}

describe('getKpiFieldValue', () => {
  it('reads a variables.* dot-path', () => {
    expect(getKpiFieldValue({ variables: { cash: 500 } as PlayerVariables, derived: {} as PlayerDerivedStats, riskGauge: 0 }, 'variables.cash')).toBe(500);
  });

  it('reads a derived.* dot-path', () => {
    expect(getKpiFieldValue({ variables: {} as PlayerVariables, derived: { equity: 1234 } as PlayerDerivedStats, riskGauge: 0 }, 'derived.equity')).toBe(1234);
  });

  it('reads the bare riskGauge field', () => {
    expect(getKpiFieldValue({ variables: {} as PlayerVariables, derived: {} as PlayerDerivedStats, riskGauge: 42 }, 'riskGauge')).toBe(42);
  });

  it('falls back to 0 for a missing field', () => {
    expect(getKpiFieldValue({ variables: {} as PlayerVariables, derived: {} as PlayerDerivedStats, riskGauge: 0 }, 'variables.cash')).toBe(0);
  });
});

describe('buildHappenings', () => {
  it('returns one entry per decision deployment, resolving player/target names', () => {
    const data = makeData({
      decisions: [
        { instanceId: 'inst-1', playerId: 'p1', decisionName: 'Bot Attack', deployedYear: 2, targetId: 'p2', voidedByLawsuit: false },
      ],
    });

    const entries = buildHappenings(data);

    expect(entries).toEqual([
      { id: 'decision-inst-1', type: 'decision', round: 2, playerName: 'Alice', decisionName: 'Bot Attack', targetName: 'Bob' },
    ]);
  });

  it('leaves targetName undefined for a decision with no target', () => {
    const data = makeData({
      decisions: [{ instanceId: 'inst-1', playerId: 'p1', decisionName: 'New Factory', deployedYear: 1, voidedByLawsuit: false }],
    });

    const entry = buildHappenings(data)[0];
    expect(entry.type).toBe('decision');
    expect((entry as Extract<typeof entry, { type: 'decision' }>).targetName).toBeUndefined();
  });

  it('produces a lawsuitFiled entry for every lawsuit, plus a lawsuitResolved entry only once resolvedRound is set', () => {
    const openCase: TimelineLawsuitEvent = {
      id: 'case-open', plaintiffId: 'p1', plaintiffName: 'Alice', defendantId: 'p2', defendantName: 'Bob',
      decisionName: 'Water Pumping', groundName: 'Environmental Violation', description: 'x', stakes: 5000, filedRound: 2,
    };
    const resolvedCase: TimelineLawsuitEvent = {
      ...openCase, id: 'case-resolved', filedRound: 1, resolvedRound: 3, verdict: 'won',
    };
    const data = makeData({ lawsuits: [openCase, resolvedCase] });

    const entries = buildHappenings(data);

    expect(entries.filter((e) => e.type === 'lawsuitFiled')).toHaveLength(2);
    expect(entries.filter((e) => e.type === 'lawsuitResolved')).toHaveLength(1);
    expect(entries.find((e) => e.type === 'lawsuitResolved')).toEqual(
      expect.objectContaining({ round: 3, lawsuit: resolvedCase }),
    );
  });

  it('sorts every entry ascending by round, mixing decisions and lawsuits', () => {
    const data = makeData({
      decisions: [{ instanceId: 'inst-1', playerId: 'p1', decisionName: 'New Factory', deployedYear: 3, voidedByLawsuit: false }],
      lawsuits: [
        { id: 'case-1', plaintiffId: 'p2', plaintiffName: 'Bob', defendantId: 'p1', defendantName: 'Alice', decisionName: 'X', groundName: 'Y', description: 'x', stakes: 1, filedRound: 1 },
      ],
    });

    const rounds = buildHappenings(data).map((e) => e.round);

    expect(rounds).toEqual([...rounds].sort((a, b) => a - b));
    expect(rounds[0]).toBe(1);
  });
});

describe('rankPlayersAtRound', () => {
  it('ranks descending by the selected metric, using each player\'s last available snapshot at or before the given round', () => {
    const data = makeData();

    const ranking = rankPlayersAtRound(data, 2, 'variables.cash');

    // Alice's round-2 cash (90000) beats Bob's round-1 cash (50000, his only snapshot).
    expect(ranking.map((r) => r.playerId)).toEqual(['p1', 'p2']);
    expect(ranking[0].value).toBe(90000);
    expect(ranking[1].value).toBe(50000);
  });

  it('does not use a snapshot from after the given round', () => {
    const data = makeData();

    // At round 1, Alice's round-2 point (cash 90000) must not count yet.
    const ranking = rankPlayersAtRound(data, 1, 'variables.cash');
    const alice = ranking.find((r) => r.playerId === 'p1')!;

    expect(alice.value).toBe(0); // round 1's point has no `cash` key in this fixture
  });

  it('carries bankrupt/eliminatedRound through unchanged', () => {
    const data = makeData();

    const ranking = rankPlayersAtRound(data, 5, 'variables.cash');
    const bob = ranking.find((r) => r.playerId === 'p2')!;

    expect(bob.bankrupt).toBe(true);
    expect(bob.eliminatedRound).toBe(3);
  });

  it('defaults to 0 for a player with no snapshots at all yet', () => {
    const data = makeData({ kpiHistory: { p1: [], p2: [] } });

    const ranking = rankPlayersAtRound(data, 1, 'variables.cash');

    expect(ranking.every((r) => r.value === 0)).toBe(true);
  });
});
