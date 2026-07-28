import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Container, Paper, Title, Button, Stack, Flex, Badge, Text, Box, Slider, Loader, Center, Image, Modal,
} from '@mantine/core';
import { LineChart } from '@mantine/charts';
import { IconPlayerPlay, IconPlayerPause } from '@tabler/icons-react';
import { useGameStore } from '../stores/gameStore';
import { useSocketStore } from '../stores/socketStore';
import ChatWidget from '../components/ChatWidget';
import FeedbackWidget from '../components/FeedbackWidget';
import AdSlot from '../components/AdSlot';
import {
  ServerEvents, ClientEvents,
  type GameTimelineResponse, type TimelineDecisionEvent, type TimelineLawsuitEvent,
  type PlayerVariables, type PlayerDerivedStats, type DecisionDefinition,
} from '@suethemchickens/shared';

// Duplicated from GamePhase.tsx (MONEY_FIELDS/natureTone/formatFieldLabel/
// formatImpactValue/EffectLine/summarizeEffects/likelihoodLabel) — same "duplicate small
// pure logic, keep in sync by hand" convention this file's own header comment already
// establishes, used here to render a decision-detail popup matching ActiveDecisionCard's
// own content without importing GamePhase internals.
const MONEY_FIELDS = new Set([
  'cash', 'assets', 'intangibleAssets', 'debt', 'reserves', 'operatingExpenses',
  'staffCost', 'materialCostPerTon', 'otherIncome', 'logisticsCostPerTon',
]);

const natureTone: Record<string, string> = { Traditional: 'green', 'Grey Area': 'yellow', Dirty: 'red' };

function formatFieldLabel(field: string): string {
  const isTarget = field.startsWith('target.');
  const clean = isTarget ? field.slice('target.'.length) : field;
  const spaced = clean.replace(/([A-Z])/g, ' $1').trim();
  const label = spaced.charAt(0).toUpperCase() + spaced.slice(1);
  return isTarget ? `Target's ${label.charAt(0).toLowerCase()}${label.slice(1)}` : label;
}

function formatImpactValue(field: string, type: 'absolute' | 'relative', value: number): string {
  const clean = field.startsWith('target.') ? field.slice('target.'.length) : field;
  if (type === 'relative') {
    const pctVal = Math.round(value * 100);
    return `${pctVal >= 0 ? '+' : ''}${pctVal}%`;
  }
  if (MONEY_FIELDS.has(clean)) {
    return `${value >= 0 ? '+' : '-'}$${Math.abs(Math.round(value)).toLocaleString()}`;
  }
  const rounded = Math.round(value * 100) / 100;
  return `${rounded >= 0 ? '+' : ''}${rounded}`;
}

interface EffectLine {
  field: string;
  timeline: string;
  isTarget: boolean;
}

/** See GamePhase.tsx's own `summarizeEffects` doc comment for why the trailing 'default'
 * schedule value is labeled "Permanent" for an own field (applied once, at maturity, never
 * re-applied — CLAUDE.md's "Root historical bug" section) vs "Every turn until Yr N" for a
 * `target.*` field (genuinely re-applied to the victim every turn until the statute of
 * limitations, or a successful lawsuit voids the instance first). */
function summarizeEffects(def: DecisionDefinition, statuteOfLimitationsYears?: number): EffectLine[] {
  const lines: EffectLine[] = [];
  for (const [field, impact] of Object.entries(def.impacts)) {
    const isTarget = field.startsWith('target.');
    const keys = Object.keys(impact.schedule).filter((k) => k !== 'default').map(Number).sort((a, b) => a - b);
    const parts: string[] = [];
    for (const k of keys) {
      const v = impact.schedule[k];
      if (v === 0) continue;
      parts.push(`Yr ${k}: ${formatImpactValue(field, impact.type, v)}`);
    }
    const ongoing = impact.schedule['default'];
    if (ongoing !== undefined && ongoing !== 0) {
      const label = isTarget
        ? `Every turn${statuteOfLimitationsYears !== undefined ? ` until Yr ${statuteOfLimitationsYears}` : ''}`
        : 'Permanent';
      parts.push(`${label}: ${formatImpactValue(field, impact.type, ongoing)}`);
    }
    if (parts.length === 0) continue;
    lines.push({ field: formatFieldLabel(field), timeline: parts.join(' → '), isTarget });
  }
  return lines;
}

/** Same "EFFECTS ON YOU" / "EFFECTS ON TARGET" grouping as GamePhase.tsx's `EffectsList`
 * — duplicated rather than imported, same convention as everything else in this file's
 * own header comment. */
function EffectsList({ effects }: { effects: EffectLine[] }) {
  const own = effects.filter((e) => !e.isTarget);
  const target = effects.filter((e) => e.isTarget);
  return (
    <Stack gap={8}>
      {own.length > 0 && (
        <Stack gap={2}>
          {target.length > 0 && (
            <Text size="xs" c="dimmed" style={{ fontStyle: 'italic', textTransform: 'uppercase' }}>Effects on you</Text>
          )}
          {own.map((line) => (
            <Flex key={line.field} justify="space-between" gap="xs">
              <Text size="xs" c="dimmed">{line.field}</Text>
              <Text size="xs" fw={700}>{line.timeline}</Text>
            </Flex>
          ))}
        </Stack>
      )}
      {target.length > 0 && (
        <Stack gap={2}>
          <Text size="xs" c="orange" style={{ fontStyle: 'italic', textTransform: 'uppercase' }}>Effects on target</Text>
          {target.map((line) => (
            <Flex key={line.field} justify="space-between" gap="xs">
              <Text size="xs" c="dimmed">{line.field}</Text>
              <Text size="xs" fw={700}>{line.timeline}</Text>
            </Flex>
          ))}
        </Stack>
      )}
    </Stack>
  );
}

/** 5-band verbal likelihood — same bands as GamePhase.tsx's own, deliberately not an exact
 * percentage (see CLAUDE.md's case-probability-chip section on why). */
function likelihoodLabel(p: number): string {
  if (p >= 0.8) return 'Highly Likely';
  if (p >= 0.6) return 'Likely';
  if (p >= 0.4) return 'Moderate';
  if (p >= 0.2) return 'Unlikely';
  return 'Highly Unlikely';
}

// ============================================================
// The Civilization-style game-over replay / live spectator view — one shared component
// used both as the finished-game replay (GameOver.tsx renders this with mode="finished")
// and as a live-updating view for an already-eliminated player who chose to keep
// watching (App.tsx renders this with mode="live"). See CLAUDE.md's game-timeline
// section for the full architecture; this file deliberately duplicates a couple of
// small pure helpers already defined in GamePhase.tsx (getKpiFieldValue, fmt) rather
// than importing from that file — matching this codebase's established "duplicate
// small pure logic, keep in sync by hand" convention (see GamePhase.utils.test.ts).
// ============================================================

function fmt(n: number): string {
  return '$' + new Intl.NumberFormat('en-US').format(Math.round(n));
}

/** Reads a dot-path field ('variables.cash', 'derived.equity', or the bare 'riskGauge')
 * out of one KpiSnapshotPoint-shaped object — duplicated from GamePhase.tsx's own
 * getKpiFieldValue, see this file's header comment for why. */
function getKpiFieldValue(point: { variables: PlayerVariables; derived: PlayerDerivedStats; riskGauge: number }, field: string): number {
  if (field === 'riskGauge') return point.riskGauge;
  const [bucket, key] = field.split('.') as ['variables' | 'derived', string];
  return (point[bucket] as unknown as Record<string, number | undefined>)?.[key] ?? 0;
}

/** Same 5 metrics/labels as GamePhase.tsx's OWN_KPI_DRILLDOWN_FIELD, for the same reason: one switchable race chart, not five separate ones. */
const METRIC_OPTIONS: Array<{ field: string; label: string }> = [
  { field: 'variables.cash', label: 'CASH' },
  { field: 'derived.equity', label: 'EQUITY' },
  { field: 'derived.revenue', label: 'REVENUE' },
  { field: 'derived.stockValue', label: 'STOCK VALUE' },
  { field: 'riskGauge', label: 'THREAT LEVEL' },
];

/** Fixed-order categorical palette (validated via the dataviz skill's validate_palette.js
 * for both light and dark chart surfaces) — colors are assigned by a player's position in
 * `GameTimelineResponse.players` (server-ordered by createdAt, i.e. join order), never
 * re-cycled by rank, so the same player always keeps the same color across re-fetches. */
const PLAYER_COLORS = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100'];

function colorForPlayerIndex(index: number): string {
  return PLAYER_COLORS[index % PLAYER_COLORS.length];
}

const PLAYBACK_SPEEDS = [1, 2, 4] as const;

/** One entry in the cumulative "happenings" log — a decision deployment, or a lawsuit
 * being filed/resolved. Built once from a `GameTimelineResponse` (not scrub-position-
 * dependent itself); the log panel filters to `round <= scrubRound` at render time. */
export type HappeningEntry =
  | { id: string; type: 'decision'; round: number; playerName: string; decisionName: string; targetName?: string; acquisitionFraction?: number }
  | { id: string; type: 'lawsuitFiled'; round: number; lawsuit: TimelineLawsuitEvent; plaintiffName: string; defendantName: string }
  | { id: string; type: 'lawsuitResolved'; round: number; lawsuit: TimelineLawsuitEvent; plaintiffName: string; defendantName: string };

/** Pure — built once from the fetched response, sorted ascending by round. A lawsuit
 * contributes a 'lawsuitFiled' entry always, and a separate 'lawsuitResolved' entry only
 * once `resolvedRound` is set (it may still be open). */
export function buildHappenings(data: GameTimelineResponse): HappeningEntry[] {
  const nameById = new Map(data.players.map((p) => [p.playerId, p.playerName]));
  const nameOf = (id?: string) => (id ? nameById.get(id) ?? 'Unknown' : undefined);

  const entries: HappeningEntry[] = [];

  for (const d of data.decisions as TimelineDecisionEvent[]) {
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
    const plaintiffName = l.plaintiffName;
    const defendantName = l.defendantName;
    entries.push({ id: `lawsuit-filed-${l.id}`, type: 'lawsuitFiled', round: l.filedRound, lawsuit: l, plaintiffName, defendantName });
    if (l.resolvedRound !== undefined) {
      entries.push({ id: `lawsuit-resolved-${l.id}`, type: 'lawsuitResolved', round: l.resolvedRound, lawsuit: l, plaintiffName, defendantName });
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
      // Names the actual winner rather than the case's fixed plaintiff/defendant role —
      // "won by the plaintiff" told the reader nothing they didn't already know from the
      // "X vs. Y" header (a lawsuit's plaintiff never changes), while "won by X" is the
      // one thing this line adds. Includes the settlement dollar amount when known — a
      // negotiated settlement can differ from the pre-trial `stakes` estimate shown in
      // `lawsuitOddsAndStakes`, so this is the only place that number is ever surfaced.
      const verdictText = v === 'won' ? `won by ${h.plaintiffName}${amount !== undefined ? ` (${fmt(amount)})` : ''}`
        : v === 'lost' ? `won by ${h.defendantName}`
        : v === 'settled' ? `settled${amount !== undefined ? ` for ${fmt(amount)}` : ''}`
        : 'cancelled';
      return `${h.plaintiffName} vs. ${h.defendantName} (${h.lawsuit.groundName}) — ${verdictText}`;
    }
  }
}

/** Stakes + the plaintiff's OWN known odds at the moment they sued, for a lawsuit
 * happening (filed or resolved — both carry the same `TimelineLawsuitEvent`, and the
 * odds are stamped once at filing time, never recomputed, so they read the same either
 * way). Gated on `plaintiffFullyInvestigated` — the same "earned separately by each side"
 * rule the live game already applies (see CLAUDE.md's case-probability-chip section):
 * a plaintiff who sued on a hunch never actually knew their odds, so this shows "Unknown"
 * for them too, not a number they never had. Pure, exported for unit testing. */
export function lawsuitOddsAndStakes(lawsuit: TimelineLawsuitEvent): string {
  const odds = lawsuit.plaintiffFullyInvestigated ? likelihoodLabel(lawsuit.baseProbability) : 'Unknown';
  return `Stakes: ${fmt(lawsuit.stakes)} · Odds (plaintiff's view): ${odds}`;
}

/** The decision-detail popup's content — mirrors GamePhase.tsx's `ActiveDecisionCard`/
 * `DecisionDetails` (description, level/nature, effects timeline, legal risks), plus this
 * happening's own context (who deployed it, which round, who it targeted). `def` comes
 * from `useGameStore().decisions` (the room's fixed decision deck) looked up by name —
 * `undefined` only if an admin deleted the definition entirely mid-game, an edge case
 * handled gracefully rather than crashing the popup. */
function DecisionHappeningPopupContent({
  happening,
  def,
  statuteOfLimitationsYears,
}: {
  happening: Extract<HappeningEntry, { type: 'decision' }>;
  def?: DecisionDefinition;
  statuteOfLimitationsYears?: number;
}) {
  if (!def) {
    return <Text size="sm" c="dimmed">This decision's details are no longer available.</Text>;
  }

  const effects = summarizeEffects(def, statuteOfLimitationsYears);
  const hasLegalRisk = !!def.legalRisks && def.legalRisks.length > 0;

  return (
    <Stack gap="sm">
      <Flex gap={6} wrap="wrap">
        <Badge color="gray">{def.level}</Badge>
        <Badge color={natureTone[def.nature] ?? 'gray'}>{def.nature}</Badge>
      </Flex>
      <Text size="sm" c="dimmed" style={{ lineHeight: 1.4 }}>{def.description}</Text>
      <Text size="xs" c="dimmed">
        Deployed by {happening.playerName} in Round {happening.round}
        {happening.targetName ? ` → ${happening.targetName}` : ''}
        {happening.acquisitionFraction !== undefined ? ` (acquired ${Math.round(happening.acquisitionFraction * 100)}% stake)` : ''}
      </Text>
      {effects.length > 0 && (
        <div style={{ padding: 8, background: '#fffdf6', border: '1px solid #ddcda0', borderRadius: 6 }}>
          <Text size="xs" fw={700} style={{ color: 'var(--ink-text)', marginBottom: 4 }}>EFFECTS</Text>
          <EffectsList effects={effects} />
        </div>
      )}
      {hasLegalRisk && (
        <div>
          <Text size="xs" fw={700} c="orange" style={{ marginBottom: 4 }}>⚖ LEGAL RISK</Text>
          <Stack gap={4}>
            {def.legalRisks!.map((r) => (
              <Text key={r.name} size="xs" c="dimmed"><b>{r.name}</b> — {r.description}</Text>
            ))}
          </Stack>
        </div>
      )}
    </Stack>
  );
}

/** Ranked standings at a given scrub round, for the currently-selected metric — the
 * value used is each player's last available snapshot at or before `round` (a player's
 * history simply stops at their last active round if eliminated). Pure, exported for
 * unit testing. */
export function rankPlayersAtRound(
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

interface GameTimelineViewProps {
  mode: 'live' | 'finished';
}

export default function GameTimelineView({ mode }: GameTimelineViewProps) {
  const { round: liveRound, gameOver, player, decisions, gameSettings } = useGameStore();
  const { socket, returnToLanding } = useSocketStore();

  const [data, setData] = useState<GameTimelineResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [metric, setMetric] = useState(METRIC_OPTIONS[0].field);
  const [scrubRound, setScrubRound] = useState(1);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<(typeof PLAYBACK_SPEEDS)[number]>(1);
  const followLiveRef = useRef(true);
  const [decisionPopup, setDecisionPopup] = useState<Extract<HappeningEntry, { type: 'decision' }> | null>(null);

  // Fetch fresh on mount and, in live mode, again whenever a new round resolves —
  // matching KpiHistoryGraph's own "fetch fresh, don't cache" convention rather than
  // building a separate incremental-push mechanism.
  useEffect(() => {
    if (!socket) return;
    const handler = (payload: GameTimelineResponse) => {
      setData(payload);
      setLoading(false);
      setScrubRound((prev) => {
        if (mode === 'finished') return payload.currentRound;
        return followLiveRef.current ? payload.currentRound : Math.min(prev, payload.currentRound);
      });
    };
    socket.on(ServerEvents.GAME_TIMELINE_RESULT, handler);
    socket.emit(ClientEvents.GAME_GET_GAME_TIMELINE);
    return () => {
      socket.off(ServerEvents.GAME_TIMELINE_RESULT, handler);
    };
     
  }, [socket, mode === 'live' ? liveRound : 'static', mode === 'live' ? gameOver : 'static']);

  const maxRound = data?.currentRound ?? 1;

  // Play/pause ticking — same setInterval pattern as components/Timer.tsx, capped at
  // whatever the current max round is (live: grows as new rounds arrive; finished:
  // fixed at the final round).
  useEffect(() => {
    if (!playing) return;
    const interval = setInterval(() => {
      setScrubRound((prev) => {
        if (prev >= maxRound) {
          setPlaying(false);
          return prev;
        }
        return prev + 1;
      });
    }, 1000 / speed);
    return () => clearInterval(interval);
  }, [playing, speed, maxRound]);

  const happenings = useMemo(() => (data ? buildHappenings(data) : []), [data]);
  const visibleHappenings = useMemo(() => happenings.filter((h) => h.round <= scrubRound), [happenings, scrubRound]);

  const listRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const handleLogScroll = () => {
    const el = listRef.current;
    if (!el) return;
    stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };
  useEffect(() => {
    if (stickToBottomRef.current && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [visibleHappenings.length]);

  const chartRows = useMemo(() => {
    if (!data) return [];
    const rows: Array<Record<string, number>> = [];
    for (let r = 1; r <= scrubRound; r++) {
      const row: Record<string, number> = { round: r };
      for (const p of data.players) {
        const history = data.kpiHistory[p.playerId] ?? [];
        const point = history.find((pt) => pt.round === r);
        if (point) row[p.playerId] = getKpiFieldValue(point, metric);
      }
      rows.push(row);
    }
    return rows;
  }, [data, scrubRound, metric]);

  const ranking = useMemo(() => (data ? rankPlayersAtRound(data, scrubRound, metric) : []), [data, scrubRound, metric]);

  const handleScrub = (value: number) => {
    setScrubRound(value);
    if (mode === 'live') followLiveRef.current = value >= maxRound;
  };

  if (loading || !data) {
    return (
      <Center style={{ minHeight: '100vh' }}>
        <Loader />
      </Center>
    );
  }

  const winner = data.players.find((p) => p.playerId === data.winnerId);

  return (
    <>
      {/* Floating Chat button (bottom-right) — same shared history as the room lobby's
          inline chat box and the in-game screen's own ChatWidget instance (see
          chatStore.ts); mounted here for both the live spectator view and the finished-
          game replay (GameOver.tsx), matching this component's own dual-mode usage.
          This screen has no floating Leave button of its own to pair with (its
          mode==='live' "Leave & Return to Start" stays an inline header button, and
          mode==='finished' has no Leave action at all) — see CLAUDE.md for why the
          floating-Leave treatment was deliberately kept scoped to the in-game screen. */}
      <ChatWidget />
      {/* Floating Feedback button (bottom-left) — only for a genuinely finished game
          (mode="finished"), not the live spectator view, matching "start page and
          game-over pages" as the two places a feedback form was asked for. Bottom-left
          is free on this screen for the same reason ChatWidget's own comment already
          explains (no floating Leave button here to pair with/conflict with). */}
      {mode === 'finished' && <FeedbackWidget />}
      <Container size="lg" py="xl">
        <Paper p="xl" style={{ background: 'var(--ink-parchment)', backgroundImage: 'var(--paper-texture)', border: '1px solid #cbb888', borderRadius: 4, boxShadow: '6px 8px 0 rgba(0,0,0,0.45)' }}>
        <Flex justify="space-between" align="center" mb="md">
          <Title order={2} style={{ fontFamily: "'Rye', Georgia, serif", fontWeight: 400, color: 'var(--ink-text)' }}>
            {mode === 'live' ? '👀 Spectating' : '🏆 Game Over!'}
          </Title>
          {mode === 'live' && (
            <Button variant="outline" color="red" onClick={returnToLanding}>
              Leave &amp; Return to Start
            </Button>
          )}
        </Flex>

        {/* Only ever shown for a genuinely finished game, never while spectating a still-
            active one (mode="live") — the same gate the win badge right below already
            uses, so the two can never disagree about when the game is actually over. */}
        {mode === 'finished' && data.gameOver && winner && (
          <>
            <Image src="/images/game-over.png" alt="Game over" radius="md" mb="md" />
            <Flex justify="center" mb="lg">
              <Badge
                size="xl"
                px="xl"
                py="md"
                styles={{ root: { background: 'var(--ink-blood)', color: '#f4e9d0', border: '2px solid var(--ink-gold)', fontFamily: "'Rye', Georgia, serif", fontWeight: 400, textTransform: 'none', fontSize: '1rem' } }}
              >
                🎉 {winner.playerName} Wins!
              </Badge>
            </Flex>
          </>
        )}

        <Stack gap="lg">
          <Box>
            <Flex justify="space-between" align="center" mb="xs" wrap="wrap" gap="sm">
              <Text fw={700} size="sm" style={{ fontFamily: "'Courier Prime', monospace", color: 'var(--ink-text)' }}>KPI RACE</Text>
              <select value={metric} onChange={(e) => setMetric(e.target.value)} style={{ padding: '4px 8px' }}>
                {METRIC_OPTIONS.map((m) => (
                  <option key={m.field} value={m.field}>{m.label}</option>
                ))}
              </select>
            </Flex>
            <LineChart
              h={320}
              data={chartRows}
              dataKey="round"
              series={data.players.map((p, i) => ({ name: p.playerId, color: colorForPlayerIndex(i), label: p.playerName }))}
              withLegend
              curveType="linear"
              connectNulls={false}
              valueFormatter={(v) => fmt(v)}
            />
          </Box>

          <Box>
            <Flex align="center" gap="md" wrap="wrap">
              <Button
                size="sm"
                variant="light"
                leftSection={playing ? <IconPlayerPause size={16} /> : <IconPlayerPlay size={16} />}
                onClick={() => setPlaying((p) => !p)}
                disabled={scrubRound >= maxRound && !playing}
              >
                {playing ? 'Pause' : 'Play'}
              </Button>
              <Flex gap={4}>
                {PLAYBACK_SPEEDS.map((s) => (
                  <Button key={s} size="xs" variant={speed === s ? 'filled' : 'outline'} onClick={() => setSpeed(s)}>
                    {s}x
                  </Button>
                ))}
              </Flex>
              <Box style={{ flex: 1, minWidth: 200 }}>
                <Slider min={1} max={Math.max(maxRound, 1)} value={scrubRound} onChange={handleScrub} label={(v) => `Round ${v}`} />
              </Box>
              <Text size="sm" c="dimmed">Round {scrubRound} / {maxRound}</Text>
            </Flex>
          </Box>

          <Flex gap="lg" wrap="wrap" align="flex-start">
            <Box style={{ flex: '1 1 260px' }}>
              <Text fw={700} size="sm" mb="xs">STANDINGS — {METRIC_OPTIONS.find((m) => m.field === metric)?.label}</Text>
              <Stack gap={6}>
                {ranking.map((r, i) => (
                  <Flex key={r.playerId} justify="space-between" align="center" style={{ padding: '6px 10px', border: '1px solid #cbb888', borderRadius: 3, background: '#f6efd9' }}>
                    <Flex align="center" gap={8}>
                      <Badge color={r.playerId === data.winnerId ? 'gold' : i === 0 ? 'gray' : 'gray'}>#{i + 1}</Badge>
                      <Text size="sm" fw={r.playerId === player?.id ? 700 : 400}>
                        {r.playerName}{r.playerId === player?.id ? ' (You)' : ''}
                      </Text>
                      {r.bankrupt && (
                        <Badge size="xs" color="red">
                          {r.eliminatedRound ? `OUT — R${r.eliminatedRound}` : 'OUT'}
                        </Badge>
                      )}
                    </Flex>
                    <Text size="sm" fw={700}>
                      {metric === 'riskGauge' ? Math.round(r.value) : fmt(r.value)}
                    </Text>
                  </Flex>
                ))}
              </Stack>
            </Box>

            <Box style={{ flex: '2 1 360px' }}>
              <Text fw={700} size="sm" mb="xs">HAPPENINGS</Text>
              {visibleHappenings.length === 0 ? (
                <Text c="dimmed" size="sm">Nothing yet.</Text>
              ) : (
                <div
                  ref={listRef}
                  onScroll={handleLogScroll}
                  style={{ maxHeight: 280, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 6, paddingRight: 4 }}
                >
                  {visibleHappenings.map((h) => (
                    <Flex
                      key={h.id}
                      justify="space-between"
                      align="center"
                      onClick={() => handleScrub(h.round)}
                      style={{ padding: '6px 10px', border: '1px solid #cbb888', borderRadius: 3, cursor: 'pointer', background: '#f6efd9' }}
                      title="Click to jump to this round"
                    >
                      {h.type === 'decision' ? (
                        <Text size="sm">
                          {h.playerName} deployed{' '}
                          <Text
                            component="span"
                            fw={700}
                            style={{ textDecoration: 'underline', cursor: 'pointer' }}
                            onClick={(e) => {
                              e.stopPropagation();
                              setDecisionPopup(h);
                            }}
                            title="Click for decision details"
                          >
                            {h.decisionName}
                          </Text>
                          {h.targetName ? ` → ${h.targetName}` : ''}
                        </Text>
                      ) : (
                        <Stack gap={1}>
                          <Text size="sm">{happeningLabel(h)}</Text>
                          <Text size="xs" c="dimmed">{lawsuitOddsAndStakes(h.lawsuit)}</Text>
                        </Stack>
                      )}
                      <Text size="xs" c="dimmed" fw={700}>ROUND {h.round}</Text>
                    </Flex>
                  ))}
                </div>
              )}
            </Box>
          </Flex>
        </Stack>

        {mode === 'finished' && (
          <Center mt="xl">
            <Button size="lg" onClick={() => window.location.reload()}>
              Play Again
            </Button>
          </Center>
        )}
      </Paper>

      {/* Below the Paper, not inside it — this screen's happenings log/decision popups
          are clickable, so a manual ad placement stays out of that zone. Shown in both
          modes ('live' spectating and 'finished' Game Over), same rationale as the
          landing page's own AdSlot: see CLAUDE.md's *Consent-gated Google
          Analytics/Ads* section. */}
      <Box mt="xl">
        <AdSlot slot={import.meta.env.VITE_ADSENSE_SLOT_GAMEOVER} />
      </Box>
      </Container>

      {/* Decision-detail popup for a "deployed X" happening — themed the same as every
          other popup in the app (Modal + title styled with the same bold/parchment
          convention). `decisions` (the room's fixed deck) comes from useGameStore, still
          populated here since this view mounts without a room/store reset. */}
      <Modal
        opened={decisionPopup !== null}
        onClose={() => setDecisionPopup(null)}
        size="md"
        centered
        title={<Text fw={700} size="sm" style={{ fontFamily: "'Courier Prime', monospace", color: 'var(--ink-text)' }}>📋 {decisionPopup?.decisionName}</Text>}
      >
        {decisionPopup && (
          <DecisionHappeningPopupContent
            happening={decisionPopup}
            def={decisions.find((d) => d.decision === decisionPopup.decisionName)}
            statuteOfLimitationsYears={gameSettings?.statuteOfLimitationsYears}
          />
        )}
      </Modal>
    </>
  );
}
