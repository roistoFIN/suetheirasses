import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Container, Paper, Title, Button, Stack, Flex, Badge, Text, Box, Slider, Loader, Center, Image,
} from '@mantine/core';
import { LineChart } from '@mantine/charts';
import { IconPlayerPlay, IconPlayerPause } from '@tabler/icons-react';
import { useGameStore } from '../stores/gameStore';
import { useSocketStore } from '../stores/socketStore';
import ChatWidget from '../components/ChatWidget';
import {
  ServerEvents, ClientEvents,
  type GameTimelineResponse, type TimelineDecisionEvent, type TimelineLawsuitEvent,
  type PlayerVariables, type PlayerDerivedStats,
} from '@suetheirasses/shared';

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
  return (point[bucket] as any)?.[key] ?? 0;
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
  | { id: string; type: 'decision'; round: number; playerName: string; decisionName: string; targetName?: string }
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
    case 'decision':
      return h.targetName
        ? `${h.playerName} deployed ${h.decisionName} → ${h.targetName}`
        : `${h.playerName} deployed ${h.decisionName}`;
    case 'lawsuitFiled':
      return `${h.plaintiffName} sued ${h.defendantName} over ${h.lawsuit.groundName}`;
    case 'lawsuitResolved': {
      const v = h.lawsuit.verdict;
      const verdictText = v === 'won' ? 'won by the plaintiff' : v === 'lost' ? 'lost by the plaintiff' : v === 'settled' ? 'settled' : 'cancelled';
      return `${h.plaintiffName} vs. ${h.defendantName} (${h.lawsuit.groundName}) — ${verdictText}`;
    }
  }
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
  const { round: liveRound, gameOver, player } = useGameStore();
  const { socket, returnToLanding } = useSocketStore();

  const [data, setData] = useState<GameTimelineResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [metric, setMetric] = useState(METRIC_OPTIONS[0].field);
  const [scrubRound, setScrubRound] = useState(1);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<(typeof PLAYBACK_SPEEDS)[number]>(1);
  const followLiveRef = useRef(true);

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
                      <Text size="sm">{happeningLabel(h)}</Text>
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
      </Container>
    </>
  );
}
