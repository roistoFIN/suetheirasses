import { describe, it, expect } from 'vitest';
import type { PlayerVariables, PlayerDerivedStats, GameTimelineResponse, TimelineLawsuitEvent } from '@suethemchickens/shared';

// ── Utility functions duplicated from GameTimelineView.tsx for testing ──────────────
// Same "duplicate small pure logic, keep this test file lightweight (no Mantine/
// tabler-icons/@mantine/charts import chain)" convention GamePhase.utils.test.ts
// already established — keep any copy in sync with the real implementation by hand.

function fmt(n: number): string {
  return '$' + new Intl.NumberFormat('en-US').format(Math.round(n));
}

function getKpiFieldValue(point: { variables: PlayerVariables; derived: PlayerDerivedStats; riskGauge: number }, field: string): number {
  if (field === 'riskGauge') return point.riskGauge;
  const [bucket, key] = field.split('.') as ['variables' | 'derived', string];
  return (point[bucket] as any)?.[key] ?? 0;
}

type HappeningEntry =
  | { id: string; type: 'decision'; round: number; playerName: string; decisionName: string; targetName?: string; acquisitionFraction?: number }
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
      acquisitionFraction: d.acquisitionFraction,
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

function happeningLabel(h: HappeningEntry): string {
  switch (h.type) {
    case 'decision': {
      if (h.acquisitionFraction !== undefined && h.targetName) {
        return `${h.playerName} deployed ${h.decisionName} → ${h.targetName} (acquired ${Math.round(h.acquisitionFraction * 100)}% stake)`;
      }
      return h.targetName
        ? `${h.playerName} deployed ${h.decisionName} → ${h.targetName}`
        : `${h.playerName} deployed ${h.decisionName}`;
    }
    case 'lawsuitFiled':
      return `${h.plaintiffName} sued ${h.defendantName} over ${h.lawsuit.groundName}`;
    case 'lawsuitResolved': {
      const v = h.lawsuit.verdict;
      const amount = h.lawsuit.resolvedAmount;
      const verdictText = v === 'won' ? `won by ${h.plaintiffName}${amount !== undefined ? ` (${fmt(amount)})` : ''}`
        : v === 'lost' ? `won by ${h.defendantName}`
        : v === 'settled' ? `settled${amount !== undefined ? ` for ${fmt(amount)}` : ''}`
        : v === 'waterfall_payout' ? `closed — ${h.defendantName} was eliminated${amount !== undefined ? ` (${fmt(amount)} paid)` : ''}`
        : 'cancelled';
      return `${h.plaintiffName} vs. ${h.defendantName} (${h.lawsuit.groundName}) — ${verdictText}`;
    }
  }
}

interface EffectLine {
  field: string;
  timeline: string;
  isTarget: boolean;
}

interface MinimalDecisionDefForEffects {
  impacts: Record<string, { type: 'absolute' | 'relative'; schedule: Record<number | string, number> }>;
}

function formatFieldLabelForEffects(field: string): string {
  const isTarget = field.startsWith('target.');
  const clean = isTarget ? field.slice('target.'.length) : field;
  const spaced = clean.replace(/([A-Z])/g, ' $1').trim();
  const label = spaced.charAt(0).toUpperCase() + spaced.slice(1);
  return isTarget ? `Target's ${label.charAt(0).toLowerCase()}${label.slice(1)}` : label;
}

const EFFECTS_MONEY_FIELDS = new Set([
  'cash', 'assets', 'intangibleAssets', 'debt', 'reserves', 'operatingExpenses',
  'staffCost', 'materialCostPerTon', 'otherIncome', 'logisticsCostPerTon',
]);

function formatImpactValueForEffects(field: string, type: 'absolute' | 'relative', value: number): string {
  const clean = field.startsWith('target.') ? field.slice('target.'.length) : field;
  if (type === 'relative') {
    const pctVal = Math.round(value * 100);
    return `${pctVal >= 0 ? '+' : ''}${pctVal}%`;
  }
  if (EFFECTS_MONEY_FIELDS.has(clean)) {
    return `${value >= 0 ? '+' : '-'}$${Math.abs(Math.round(value)).toLocaleString()}`;
  }
  const rounded = Math.round(value * 100) / 100;
  return `${rounded >= 0 ? '+' : ''}${rounded}`;
}

// Same distinction as GamePhase.tsx's own `summarizeEffects` (see its doc comment): an
// own field's 'default' schedule value applies once, at maturity, and is never re-applied
// (GameLoop.advanceAndApply) — "Permanent" — while a `target.*` field's 'default' value
// genuinely re-applies to the victim every turn until the statute of limitations —
// "Every turn until Yr N".
function summarizeEffects(def: MinimalDecisionDefForEffects, statuteOfLimitationsYears?: number): EffectLine[] {
  const lines: EffectLine[] = [];
  for (const [field, impact] of Object.entries(def.impacts)) {
    const isTarget = field.startsWith('target.');
    const keys = Object.keys(impact.schedule).filter((k) => k !== 'default').map(Number).sort((a, b) => a - b);
    const parts: string[] = [];
    for (const k of keys) {
      const v = impact.schedule[k];
      if (v === 0) continue;
      parts.push(`Yr ${k}: ${formatImpactValueForEffects(field, impact.type, v)}`);
    }
    const ongoing = impact.schedule['default'];
    if (ongoing !== undefined && ongoing !== 0) {
      const label = isTarget
        ? `Every turn${statuteOfLimitationsYears !== undefined ? ` until Yr ${statuteOfLimitationsYears}` : ''}`
        : 'Permanent';
      parts.push(`${label}: ${formatImpactValueForEffects(field, impact.type, ongoing)}`);
    }
    if (parts.length === 0) continue;
    lines.push({ field: formatFieldLabelForEffects(field), timeline: parts.join(' → '), isTarget });
  }
  return lines;
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

function likelihoodLabel(p: number): string {
  if (p >= 0.8) return 'Highly Likely';
  if (p >= 0.6) return 'Likely';
  if (p >= 0.4) return 'Moderate';
  if (p >= 0.2) return 'Unlikely';
  return 'Highly Unlikely';
}

function lawsuitOddsAndStakes(lawsuit: TimelineLawsuitEvent): string {
  const odds = lawsuit.plaintiffFullyInvestigated ? likelihoodLabel(lawsuit.baseProbability) : 'Unknown';
  return `Stakes: $${new Intl.NumberFormat('en-US').format(Math.round(lawsuit.stakes))} · Odds (plaintiff's view): ${odds}`;
}

// ── Fixtures ─────────────────────────────────────────────────────────

function makeLawsuit(overrides: Partial<TimelineLawsuitEvent> = {}): TimelineLawsuitEvent {
  return {
    id: 'case-1', plaintiffId: 'p1', plaintiffName: 'Alice', defendantId: 'p2', defendantName: 'Bob',
    decisionName: 'Water Pumping', groundName: 'Environmental Violation', description: 'x',
    stakes: 20000, baseProbability: 0.5, plaintiffFullyInvestigated: false, filedRound: 1,
    ...overrides,
  };
}

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

  it('carries acquisitionFraction through for a Buy Shares deployment', () => {
    const data = makeData({
      decisions: [
        { instanceId: 'inst-1', playerId: 'p1', decisionName: 'Buy Shares', deployedYear: 4, targetId: 'p2', voidedByLawsuit: false, acquisitionFraction: 0.12 },
      ],
    });

    const entry = buildHappenings(data)[0];
    expect(entry.type).toBe('decision');
    expect((entry as Extract<typeof entry, { type: 'decision' }>).acquisitionFraction).toBe(0.12);
  });

  it('produces a lawsuitFiled entry for every lawsuit, plus a lawsuitResolved entry only once resolvedRound is set', () => {
    const openCase: TimelineLawsuitEvent = {
      id: 'case-open', plaintiffId: 'p1', plaintiffName: 'Alice', defendantId: 'p2', defendantName: 'Bob',
      decisionName: 'Water Pumping', groundName: 'Environmental Violation', description: 'x', stakes: 5000, filedRound: 2,
      baseProbability: 0.4, plaintiffFullyInvestigated: true,
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
        {
          id: 'case-1', plaintiffId: 'p2', plaintiffName: 'Bob', defendantId: 'p1', defendantName: 'Alice',
          decisionName: 'X', groundName: 'Y', description: 'x', stakes: 1, filedRound: 1,
          baseProbability: 0.5, plaintiffFullyInvestigated: false,
        },
      ],
    });

    const rounds = buildHappenings(data).map((e) => e.round);

    expect(rounds).toEqual([...rounds].sort((a, b) => a - b));
    expect(rounds[0]).toBe(1);
  });
});

describe('happeningLabel', () => {
  it('appends the acquired stake percentage for a Buy Shares deployment', () => {
    const data = makeData({
      decisions: [
        { instanceId: 'inst-1', playerId: 'p1', decisionName: 'Buy Shares', deployedYear: 4, targetId: 'p2', voidedByLawsuit: false, acquisitionFraction: 0.125 },
      ],
    });

    const entry = buildHappenings(data)[0];

    expect(happeningLabel(entry)).toBe('Alice deployed Buy Shares → Bob (acquired 13% stake)');
  });

  it('omits the percentage for an ordinary decision with no acquisitionFraction', () => {
    const data = makeData({
      decisions: [
        { instanceId: 'inst-1', playerId: 'p1', decisionName: 'Bot Attack', deployedYear: 2, targetId: 'p2', voidedByLawsuit: false },
      ],
    });

    const entry = buildHappenings(data)[0];

    expect(happeningLabel(entry)).toBe('Alice deployed Bot Attack → Bob');
  });

  const baseLawsuit: TimelineLawsuitEvent = {
    id: 'case-1', plaintiffId: 'p1', plaintiffName: 'Alice', defendantId: 'p2', defendantName: 'Bob',
    decisionName: 'Water Pumping', groundName: 'Environmental Violation', description: 'x', stakes: 5000,
    filedRound: 1, resolvedRound: 3, baseProbability: 0.4, plaintiffFullyInvestigated: true,
  };

  it('names the actual winner (plaintiff) rather than their fixed case role, for a won verdict', () => {
    const data = makeData({ lawsuits: [{ ...baseLawsuit, verdict: 'won', resolvedAmount: 5000 }] });
    const entry = buildHappenings(data).find((e) => e.type === 'lawsuitResolved')!;

    expect(happeningLabel(entry)).toBe('Alice vs. Bob (Environmental Violation) — won by Alice ($5,000)');
  });

  it('names the actual winner (defendant) for a lost verdict, with no dollar amount shown', () => {
    const data = makeData({ lawsuits: [{ ...baseLawsuit, verdict: 'lost' }] });
    const entry = buildHappenings(data).find((e) => e.type === 'lawsuitResolved')!;

    expect(happeningLabel(entry)).toBe('Alice vs. Bob (Environmental Violation) — won by Bob');
  });

  it('shows the actual settled dollar amount, which can differ from the pre-trial stakes estimate', () => {
    const data = makeData({ lawsuits: [{ ...baseLawsuit, verdict: 'settled', resolvedAmount: 3200 }] });
    const entry = buildHappenings(data).find((e) => e.type === 'lawsuitResolved')!;

    expect(happeningLabel(entry)).toBe('Alice vs. Bob (Environmental Violation) — settled for $3,200');
  });

  // Regression: a case explicitly sent to trial (or never negotiated at all) used to show
  // up as "settled" once the defendant was eliminated (bankruptcy/takeover) before it
  // could resolve any other way — see LegalCaseData.verdict's own doc comment.
  it('names the eliminated defendant and the actual amount paid for a waterfall_payout verdict, distinct from a real settlement', () => {
    const data = makeData({ lawsuits: [{ ...baseLawsuit, verdict: 'waterfall_payout', resolvedAmount: 1800 }] });
    const entry = buildHappenings(data).find((e) => e.type === 'lawsuitResolved')!;

    expect(happeningLabel(entry)).toBe('Alice vs. Bob (Environmental Violation) — closed — Bob was eliminated ($1,800 paid)');
  });

  it('shows no dollar amount for a cancelled case (bankruptcy/merger waterfall pool ran out, no payment at all)', () => {
    const data = makeData({ lawsuits: [{ ...baseLawsuit, verdict: 'cancelled' }] });
    const entry = buildHappenings(data).find((e) => e.type === 'lawsuitResolved')!;

    expect(happeningLabel(entry)).toBe('Alice vs. Bob (Environmental Violation) — cancelled');
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

describe('summarizeEffects', () => {
  it('labels an own field\'s default-only value "Permanent", not "Ongoing" (regression — see GamePhase.tsx\'s summarizeEffects doc comment)', () => {
    const def: MinimalDecisionDefForEffects = { impacts: { installedCapacity: { type: 'relative', schedule: { default: 0.15 } } } };
    expect(summarizeEffects(def)).toEqual([{ field: 'Installed Capacity', timeline: 'Permanent: +15%', isTarget: false }]);
  });

  it('labels a target field\'s default-only value "Every turn until Yr N" when the statute of limitations is known', () => {
    const def: MinimalDecisionDefForEffects = { impacts: { 'target.outrage': { type: 'absolute', schedule: { default: -8 } } } };
    expect(summarizeEffects(def, 10)).toEqual([{ field: "Target's outrage", timeline: 'Every turn until Yr 10: -8', isTarget: true }]);
  });

  it('marks isTarget so a caller can split effects on the deploying player from effects on their chosen opponent', () => {
    const def: MinimalDecisionDefForEffects = {
      impacts: {
        cash: { type: 'absolute', schedule: { default: -10000 } },
        'target.demand': { type: 'absolute', schedule: { default: -6 } },
      },
    };
    const lines = summarizeEffects(def);
    expect(lines.find((l) => l.field === 'Cash')?.isTarget).toBe(false);
    expect(lines.find((l) => l.isTarget)?.field).toBe("Target's demand");
  });
});

describe('lawsuitOddsAndStakes', () => {
  it('shows the plaintiff\'s known verbal odds and dollar stakes once fully investigated', () => {
    const lawsuit = makeLawsuit({ stakes: 45000, baseProbability: 0.85, plaintiffFullyInvestigated: true });
    expect(lawsuitOddsAndStakes(lawsuit)).toBe("Stakes: $45,000 · Odds (plaintiff's view): Highly Likely");
  });

  it('shows "Unknown" odds for a plaintiff who sued on a hunch (never fully investigated), even though stakes are still known', () => {
    const lawsuit = makeLawsuit({ stakes: 12000, baseProbability: 0.9, plaintiffFullyInvestigated: false });
    expect(lawsuitOddsAndStakes(lawsuit)).toBe("Stakes: $12,000 · Odds (plaintiff's view): Unknown");
  });

  it('maps every 5-band likelihood correctly', () => {
    const bands: Array<[number, string]> = [
      [0.05, 'Highly Unlikely'],
      [0.25, 'Unlikely'],
      [0.45, 'Moderate'],
      [0.65, 'Likely'],
      [0.85, 'Highly Likely'],
    ];
    for (const [baseProbability, label] of bands) {
      const lawsuit = makeLawsuit({ baseProbability, plaintiffFullyInvestigated: true });
      expect(lawsuitOddsAndStakes(lawsuit)).toContain(label);
    }
  });
});
