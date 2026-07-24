import React, { useEffect, useRef, useState } from 'react';
import type { Socket } from 'socket.io-client';
import {
  Modal, Stack, Text, Badge, Button, Flex, TextInput,
  Slider, Divider, Box, Image, Loader,
} from '@mantine/core';
import { LineChart } from '@mantine/charts';
import { useGameStore } from '../stores/gameStore';
import { useSocketStore } from '../stores/socketStore';
import {
  ServerEvents, ClientEvents,
  type PlayerTurnResult, type LegalCaseData, type PlayerVariables, type PlayerDerivedStats,
  type DecisionDefinition, type GameSettings, type SubmittedDecisions,
  type IncomingAttackInfo, type TurnResolutionResult,
  type KpiHistoryResponse,
} from '@suetheirasses/shared';
import {
  IconClock, IconFileText,
  IconTrendingUp, IconTrendingDown, IconMinus, IconSearch, IconGavel,
  IconLock, IconCheck, IconSwords, IconChevronDown,
  IconShield, IconDoorExit,
} from '@tabler/icons-react';

// ============================================================
// Types & Constants
// ============================================================
//
// Note: there is no separate, hand-maintained catalog of lawsuit grounds — every
// decision's `legalRisks` in the (admin-editable, DB-backed) decision library is a
// selectable ground in the SUE THEIR ASSES modal, for every decision in the game, not
// just ones a specific target has actually deployed. See getGroundsAgainst() near
// SueModal: a player can knowingly guess a ground the target may or may not have
// actually pursued — a wrong guess still costs the filing fee (not refunded) but
// produces no case, exactly the risk/reward this mechanic is designed to allow.

/** Maps the 4 top KPI cards + Threat Level's `drillDown.type` to the KpiSnapshotPoint field their history/prediction graph should read — see KpiHistoryGraph. Rival drill-downs ('rival'/'rival-field') deliberately have no entry: rivals read `field`/`label` straight off `drillDown` instead (see RivalFieldView / RivalFullReportView), since a rival has no single "top" field the way each own-KPI type does. */
const OWN_KPI_DRILLDOWN_FIELD: Record<string, { field: string; label: string }> = {
  cash: { field: 'variables.cash', label: 'CASH' },
  equity: { field: 'derived.equity', label: 'EQUITY' },
  revenue: { field: 'derived.revenue', label: 'REVENUE' },
  shares: { field: 'derived.stockValue', label: 'STOCK VALUE' },
  threat: { field: 'riskGauge', label: 'THREAT LEVEL' },
};

// ============================================================
// Styles hook usage helper
// ============================================================

const DISPLAY = { fontFamily: "'Arial Black', Impact, 'Helvetica Neue', sans-serif" as const };
const boldStyle = { ...DISPLAY, fontWeight: 900 };

// ============================================================
// Utility functions
// ============================================================

function fmt(n: number): string {
  return '$' + new Intl.NumberFormat('en-US').format(Math.round(n));
}

function pct(n: number): string {
  return (n * 100).toFixed(0) + '%';
}

/** Defaults mirror `game_config.json`'s seeded values — used only until `game:deck` (and
 * its `gameSettings.semaphoreGreenMax`/`semaphoreYellowMax`) has actually arrived. */
function semaphoreLevel(p: number, greenMax = 0.15, yellowMax = 0.4): 'green' | 'yellow' | 'red' {
  if (p < greenMax) return 'green';
  if (p < yellowMax) return 'yellow';
  return 'red';
}

/** How a KPI moved since last turn. `undefined` means "no prior turn to compare" (round 1). */
type Trend = 'up' | 'down' | 'same';

function computeTrend(current: number, previous: number | undefined, epsilon = 0.01): Trend | undefined {
  if (previous === undefined) return undefined;
  const diff = current - previous;
  if (Math.abs(diff) < epsilon) return 'same';
  return diff > 0 ? 'up' : 'down';
}

/** The up/down/no-change indicator for a `Trend` — shared by every KPI display (top
 * cards, rival mini-stats, every breakdown row). `invert` flips which direction reads as
 * "good" (e.g. Debt, costs, Outrage, Threat Level itself — up is bad for these). Renders
 * nothing when `trend` is `undefined` (round 1, nothing to compare against yet) — the
 * dash is reserved for a genuine "no change" reading, not "no data yet". */
function TrendIcon({ trend, invert, size = 14 }: { trend?: Trend; invert?: boolean; size?: number }) {
  if (!trend) return null;
  if (trend === 'same') {
    return <IconMinus size={size} style={{ color: '#9ca3af' }} title="No change since last turn" />;
  }
  const isGood = trend === 'up' ? !invert : invert;
  const color = isGood ? '#16a34a' : '#dc2626';
  return trend === 'up'
    ? <IconTrendingUp size={size} style={{ color }} title="Up since last turn" />
    : <IconTrendingDown size={size} style={{ color }} title="Down since last turn" />;
}

const semColors: Record<string, { bg: string; chipBg: string; chipBorder: string; textColor: string }> = {
  green: { bg: '#22c55e', chipBg: '#dcfce7', chipBorder: '#22c55e', textColor: '#15803d' },
  yellow: { bg: '#fbbf24', chipBg: '#fef3c7', chipBorder: '#f59e0b', textColor: '#b45309' },
  red: { bg: '#ef4444', chipBg: '#fee2e2', chipBorder: '#ef4444', textColor: '#b91c1c' },
  /** A plaintiff never sees their own filed case's real probability — the semaphore
   * chip's "unknown" state, styled the same as the real thing but gray and unclickable. */
  gray: { bg: '#9ca3af', chipBg: '#f3f4f6', chipBorder: '#9ca3af', textColor: '#4b5563' },
};

/** Determine the viewing player's role in a case — 'role'/'opponent' are view
 * concerns derived from plaintiffId/defendantId, not stored on LegalCaseData. */
function getCaseRole(caseData: LegalCaseData, myPlayerId: string): 'plaintiff' | 'defendant' {
  return caseData.defendantId === myPlayerId ? 'defendant' : 'plaintiff';
}

function getOpponentName(caseData: LegalCaseData, myPlayerId: string, playerNames: Map<string, string>): string {
  const opponentId = caseData.defendantId === myPlayerId ? caseData.plaintiffId : caseData.defendantId;
  return playerNames.get(opponentId) ?? 'Unknown';
}

/**
 * Lawsuits filed against `myPlayerId` in `currentCases` that weren't already present
 * (by id) in `previousCases` — drives the "YOU'VE BEEN SUED" modal. Pure/exported so
 * it's unit-testable without a live turn cycle; the component only wires it into
 * state on each newly-resolved turn (see the turnResults sync effect below).
 */
export function detectNewlySuedCases(
  previousCases: LegalCaseData[],
  currentCases: LegalCaseData[],
  myPlayerId: string,
): LegalCaseData[] {
  const previouslySuedCaseIds = new Set(
    previousCases.filter((c) => c.defendantId === myPlayerId).map((c) => c.id),
  );
  return currentCases.filter((c) => c.defendantId === myPlayerId && !previouslySuedCaseIds.has(c.id));
}

/** One of my own cases (plaintiff or defendant) whose trial verdict just came in this turn. */
export interface ResolvedCaseForMe {
  case: LegalCaseData;
  /** From MY perspective, not the raw `verdict` field — a defendant's 'lost' verdict
   * (they didn't have to pay) is a WIN for that defendant, and vice versa. */
  outcome: 'won' | 'lost';
}

/**
 * Cases I'm a party to (plaintiff or defendant) that transitioned to a trial verdict
 * ('won'/'lost' — not 'settled'/'cancelled', which aren't a trial outcome and don't
 * match the "gavel drop" won/lost imagery) since the last turn. Drives the "CASE
 * WON"/"CASE LOST" modals. Pure/exported for the same reason as detectNewlySuedCases.
 */
export function detectNewlyResolvedCases(
  previousCases: LegalCaseData[],
  currentCases: LegalCaseData[],
  myPlayerId: string,
): ResolvedCaseForMe[] {
  const previouslyResolvedIds = new Set(
    previousCases.filter((c) => c.status === 'resolved').map((c) => c.id),
  );
  const results: ResolvedCaseForMe[] = [];
  for (const c of currentCases) {
    if (c.status !== 'resolved' || previouslyResolvedIds.has(c.id)) continue;
    if (c.verdict !== 'won' && c.verdict !== 'lost') continue;
    const amPlaintiff = c.plaintiffId === myPlayerId;
    const amDefendant = c.defendantId === myPlayerId;
    if (!amPlaintiff && !amDefendant) continue;
    // verdict 'won' = the plaintiff won (defendant pays) — flip it for the defendant's own perspective.
    const outcome: 'won' | 'lost' = amPlaintiff === (c.verdict === 'won') ? 'won' : 'lost';
    results.push({ case: c, outcome });
  }
  return results;
}

/** One of my own cases (plaintiff or defendant) that resolved by settlement (accepting an
 * offer, or a stale offer auto-settling at a turn boundary — see CLAUDE.md's negotiation
 * section) since the last turn, rather than a trial verdict. */
export interface SettledCaseForMe {
  case: LegalCaseData;
  role: 'plaintiff' | 'defendant';
}

/**
 * Cases I'm a party to that resolved via `verdict: 'settled'` (negotiation, not a trial —
 * see `detectNewlyResolvedCases` for the won/lost trial-verdict counterpart, and why
 * 'cancelled' — the bankruptcy-waterfall outcome — isn't covered by either: that's
 * surfaced via the separate bankruptcy takeover, not a settlement the player negotiated).
 * Drives the "Case settled" News item. Pure/exported for the same reason as
 * detectNewlySuedCases.
 */
export function detectNewlySettledCases(
  previousCases: LegalCaseData[],
  currentCases: LegalCaseData[],
  myPlayerId: string,
): SettledCaseForMe[] {
  const previouslyResolvedIds = new Set(
    previousCases.filter((c) => c.status === 'resolved').map((c) => c.id),
  );
  const results: SettledCaseForMe[] = [];
  for (const c of currentCases) {
    if (c.status !== 'resolved' || previouslyResolvedIds.has(c.id)) continue;
    if (c.verdict !== 'settled') continue;
    const amPlaintiff = c.plaintiffId === myPlayerId;
    const amDefendant = c.defendantId === myPlayerId;
    if (!amPlaintiff && !amDefendant) continue;
    results.push({ case: c, role: amPlaintiff ? 'plaintiff' : 'defendant' });
  }
  return results;
}

/**
 * The content of one "info window" — one case being sued/resolved/settled, or the round
 * simply advancing. Each one is wrapped into a `NewsItem` (below) and appended to the
 * News box's list rather than popping up automatically — see the News box's own doc
 * comment for why this replaced the old auto-popping single-Modal queue.
 *
 * Deliberately ONE case per event, never a batch — an earlier version bundled every case
 * that was sued/resolved-the-same-way/settled in a single turn into one `PostTurnEvent`
 * (`cases: LegalCaseData[]`), which was a real, reported bug: two lawsuits landing on the
 * same player the same turn (or two verdicts, or two settlements) produced only one News
 * row and one alert, silently hiding the second case's own outcome from the player. Each
 * case is its own event, its own row, and its own "you can win or lose this one
 * independently of any other" fact — nothing about them should ever be merged.
 */
type PostTurnEvent =
  | { type: 'sued'; case: LegalCaseData }
  | { type: 'verdict'; outcome: 'won' | 'lost'; case: LegalCaseData }
  | { type: 'settlement'; case: SettledCaseForMe }
  | { type: 'turnChange'; round: number };

/** One entry in the News box — a `PostTurnEvent` plus the round it was published in and a
 * stable id (for React's list key and, just as importantly, so a genuinely NEW row's
 * mount-triggered CSS flash animation never replays for an already-seen row on a later
 * re-render — see `NewsRow`). */
interface NewsItem {
  id: string;
  round: number;
  event: PostTurnEvent;
}

/** Short label shown for each News row — same wording the old modal titles used, minus the emoji. */
function newsTopic(event: PostTurnEvent): string {
  switch (event.type) {
    case 'sued': return 'You have been sued';
    case 'verdict': return event.outcome === 'won' ? 'Case won' : 'Case lost';
    case 'settlement': return 'Case settled';
    case 'turnChange': return 'Next turn';
  }
}

// ============================================================
// Styles — war-room dashboard aesthetic (stamps, thick borders, shadows),
// plain style objects using Mantine v7 CSS variables (see Timer.tsx for
// the established convention — Mantine v7 dropped @mantine/styles/createStyles).
// ============================================================

const DISPLAY_FONT = "'Arial Black', Impact, 'Helvetica Neue', sans-serif";

const gpStyles = {
  dashboard: {
    background: 'var(--mantine-color-gray-0)',
    borderRadius: 'var(--mantine-radius-md)',
    overflow: 'hidden',
    maxWidth: '100%',
    fontFamily: "'Helvetica Neue', Arial, sans-serif",
  } as React.CSSProperties,

  loadingOverlay: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 300,
    background: 'var(--mantine-color-gray-0)',
  } as React.CSSProperties,

  header: {
    borderBottom: '3px solid var(--mantine-color-dark-4)',
    background: '#fff',
    padding: 'var(--mantine-spacing-sm) var(--mantine-spacing-md)',
  } as React.CSSProperties,

  title: {
    fontFamily: DISPLAY_FONT,
    fontSize: '1.25rem',
    fontWeight: 900,
    color: 'var(--mantine-color-dark-8)',
  } as React.CSSProperties,

  kpiGrid: {
    padding: 'var(--mantine-spacing-md)',
  } as React.CSSProperties,

  kpiCard: {
    flex: '1 1 160px',
    background: '#fff',
    border: '2px solid var(--mantine-color-dark-4)',
    borderRadius: 'var(--mantine-radius-sm)',
    padding: 'var(--mantine-spacing-md)',
    cursor: 'pointer',
  } as React.CSSProperties,

  kpiLabel: {
    fontFamily: DISPLAY_FONT,
    fontSize: '0.7rem',
    letterSpacing: '0.02em',
    color: 'var(--mantine-color-dark-6)',
    marginBottom: 4,
  } as React.CSSProperties,

  sectionCard: {
    background: '#fff',
    border: '3px solid var(--mantine-color-dark-4)',
    borderRadius: 'var(--mantine-radius-md)',
    padding: 'var(--mantine-spacing-md)',
    boxShadow: '8px 8px 0 0 var(--mantine-color-dark-5)',
  } as React.CSSProperties,

  sectionTitle: {
    fontFamily: DISPLAY_FONT,
    fontSize: '0.85rem',
    fontWeight: 900,
    letterSpacing: '0.02em',
    color: 'var(--mantine-color-dark-8)',
    marginBottom: 'var(--mantine-spacing-sm)',
  } as React.CSSProperties,

  caseCard: {
    borderRadius: 'var(--mantine-radius-lg)',
    border: '3px solid var(--mantine-color-dark-4)',
    background: '#fff',
    padding: 'var(--mantine-spacing-md)',
    boxShadow: '4px 4px 0 0 var(--mantine-color-dark-5)',
  } as React.CSSProperties,

  activeDecisionCard: {
    borderRadius: 'var(--mantine-radius-sm)',
    border: '3px solid var(--mantine-color-dark-4)',
    background: '#fff',
    padding: 'var(--mantine-spacing-sm) var(--mantine-spacing-md)',
  } as React.CSSProperties,

  filterChip: (active: boolean): React.CSSProperties => ({
    cursor: 'pointer',
    fontFamily: DISPLAY_FONT,
    fontSize: '0.65rem',
    fontWeight: 900,
    letterSpacing: '0.03em',
    textTransform: 'uppercase',
    padding: '4px var(--mantine-spacing-sm)',
    borderRadius: 9999,
    border: '2px solid',
    borderColor: active ? 'var(--mantine-color-dark-8)' : 'var(--mantine-color-gray-4)',
    background: active ? 'var(--mantine-color-dark-8)' : '#fff',
    color: active ? '#fff' : 'var(--mantine-color-dark-6)',
  }),

  semaphoreChip: (level: string, clickable = true): React.CSSProperties => {
    const colors = semColors[level];
    return {
      display: 'flex',
      alignItems: 'center',
      gap: 4,
      padding: '4px 10px',
      borderRadius: 9999,
      border: `2px solid ${colors.chipBorder}`,
      background: colors.chipBg,
      cursor: clickable ? 'pointer' : 'default',
      flexShrink: 0,
    };
  },

  sliderContainer: {
    border: '2px solid var(--mantine-color-dark-4)',
    borderRadius: 'var(--mantine-radius-md)',
    padding: 'var(--mantine-spacing-sm)',
    background: 'var(--mantine-color-gray-0)',
  } as React.CSSProperties,

  rivalSection: {
    borderTop: '2px solid var(--mantine-color-gray-3)',
    paddingTop: 4,
  } as React.CSSProperties,

  rivalMiniStat: {
    background: 'var(--mantine-color-gray-1)',
    border: '1px solid var(--mantine-color-gray-4)',
    borderRadius: 'var(--mantine-radius-sm)',
    padding: 'var(--mantine-spacing-xs) var(--mantine-spacing-sm)',
    cursor: 'pointer',
  } as React.CSSProperties,

  modalContent: {
    gap: 'var(--mantine-spacing-xs)',
  } as React.CSSProperties,

  statRow: (tone?: string): React.CSSProperties => ({
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 'var(--mantine-spacing-xs) 0',
    borderBottom: '1px solid var(--mantine-color-gray-2)',
    color: tone === 'minus' ? '#dc2626' : tone === 'plus' ? '#16a34a' : 'var(--mantine-color-dark-8)',
    fontWeight: 500,
  }),

  totalRow: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingTop: 'var(--mantine-spacing-sm)',
    borderTop: '2px solid var(--mantine-color-dark-4)',
    marginTop: 4,
  } as React.CSSProperties,

  searchInput: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    border: '2px solid var(--mantine-color-dark-4)',
    borderRadius: 'var(--mantine-radius-sm)',
    padding: 'var(--mantine-spacing-xs) var(--mantine-spacing-sm)',
    background: '#fff',
  } as React.CSSProperties,

  groundsItem: (selected: boolean): React.CSSProperties => ({
    cursor: 'pointer',
    padding: 'var(--mantine-spacing-sm)',
    borderRadius: 'var(--mantine-radius-md)',
    border: selected ? '3px solid #dc2626' : '2px solid var(--mantine-color-gray-3)',
    background: selected ? '#fef2f2' : '#fff',
  }),

  // Mantine's Badge sets a fixed height/line-height from its own stylesheet (tied to its
  // default size, not to our custom padding/border below) — with a thick 3px border and
  // block-level (not flex) content layout, that leftover space collects above the text
  // instead of splitting evenly, pushing the label down until it visually overlaps the
  // bottom border. `inline-flex` + `alignItems: 'center'` centers the label regardless of
  // whatever fixed height Mantine applies; `height: 'auto'`/`lineHeight: 1` stop that
  // fixed height from fighting the centering in the first place.
  stamp: (tone: string): React.CSSProperties => ({
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: 'auto',
    lineHeight: 1,
    border: '3px solid',
    borderColor: tone === 'green' ? '#16a34a' : tone === 'yellow' ? '#f59e0b' : tone === 'red' ? '#dc2626' : tone === 'gray' ? '#6b7280' : 'var(--mantine-color-dark-8)',
    color: tone === 'green' ? '#15803d' : tone === 'yellow' ? '#b45309' : tone === 'red' ? '#b91c1c' : tone === 'gray' ? '#374151' : 'var(--mantine-color-dark-8)',
    background: tone === 'black' ? '#fff' : tone === 'green' ? '#f0fdf4' : tone === 'yellow' ? '#fefce8' : tone === 'gray' ? '#f3f4f6' : '#fef2f2',
    borderRadius: 4,
    padding: '2px 8px',
    fontSize: '0.65rem',
    fontFamily: DISPLAY_FONT,
    fontWeight: 900,
    letterSpacing: '0.03em',
  }),
};

// ============================================================
// Main GamePhase Component
// ============================================================

export default function GamePhase() {
  const { socket } = useSocketStore();
  const { player, turnResults, timer, round, currentPhase, updateTimer, decisions, gameSettings } = useGameStore();
  const [myData, setMyData] = useState<PlayerTurnResult | null>(null);
  const [competitors, setCompetitors] = useState<PlayerTurnResult[]>([]);
  // Previous turn's snapshot — kept only to compute the "since last turn" trend arrows
  // on KPI cards and competitor intel; null/empty until a second turn has resolved.
  const [prevData, setPrevData] = useState<PlayerTurnResult | null>(null);
  const [prevCompetitors, setPrevCompetitors] = useState<Map<string, PlayerTurnResult>>(new Map());
  const [localTimer, setLocalTimer] = useState(timer);
  const [drillDown, setDrillDown] = useState<{ type: string; data?: PlayerTurnResult; field?: string; label?: string } | null>(null);
  // A breakdown-view row (e.g. "Operating expenses" inside the Cash Waterfall, or any row
  // inside a rival's Full Filing report) that has its own history graph — separate from
  // `drillDown` since it stacks as its own modal on top of whichever breakdown modal is
  // already open, rather than replacing it. `targetPlayerId` is always explicit — it's
  // the viewer's own id for own-breakdown rows, a rival's id for rival ones.
  const [kpiSubFieldGraph, setKpiSubFieldGraph] = useState<{ field: string; label: string; targetPlayerId: string } | null>(null);
  const [sueModalOpen, setSueModalOpen] = useState(false);
  const [decisionDeckModalOpen, setDecisionDeckModalOpen] = useState(false);
  // Set when a player jumps into the Sue flow via a fully-investigated attack's
  // "SUE NOW" shortcut — pre-fills SueModal's target + ground, still requires the
  // player's own "QUEUE LAWSUIT" confirmation click. decisionName disambiguates the
  // prefill match against the now target-independent, whole-library ground catalog
  // (see getGroundsAgainst) — two different decisions could in principle share an
  // identically-named ground, since the admin-editable decision library has no
  // uniqueness constraint on legal-risk names.
  const [sueSuggestion, setSueSuggestion] = useState<{ targetId: string; decisionName: string; groundName: string } | null>(null);
  const closeSueModal = () => {
    setSueModalOpen(false);
    setSueSuggestion(null);
  };
  const [riskInfoCase, setRiskInfoCase] = useState<LegalCaseData | null>(null);
  const [loading, setLoading] = useState(true);
  const [leaveConfirmOpen, setLeaveConfirmOpen] = useState(false);
  // News feed (sued / lawsuit verdict / settlement / turn change) — see NewsItem's doc
  // comment. Never auto-pops a modal; accumulates here and the player clicks a row to
  // open its info window (newsModalItem below), for the sake of not interrupting play.
  const [newsItems, setNewsItems] = useState<NewsItem[]>([]);
  // The News row currently clicked open, if any — replaces the old auto-shown "current
  // event" modal entirely; nothing sets this except a click on a News row.
  const [newsModalItem, setNewsModalItem] = useState<NewsItem | null>(null);
  // Ready state for the in-flight turn — authoritative from the server (game:readyUpdate),
  // not optimistic local state, so it can never drift from what every other player sees.
  const [readyPlayerIds, setReadyPlayerIds] = useState<string[]>([]);
  const [activePlayerCount, setActivePlayerCount] = useState(0);
  // Guards the turn-sync effect below against React 18 StrictMode's dev-only double
  // invocation of effects with no cleanup — without this, the same `turnResults` object
  // gets processed twice, and setNewsItems' append (non-idempotent by nature) ends up
  // adding the same event twice, producing a duplicate React key.
  const processedTurnResultsRef = useRef<TurnResolutionResult | null>(null);
  // The last round an info window was shown for — round 1 (initial game start) never
  // gets a "turn change" window of its own, since nothing changed FROM anything yet.
  const lastAnnouncedRoundRef = useRef<number | null>(null);

  // Pending decisions + lawsuits for this turn — shared between the Decision Deck and
  // the Sue modal, since both contribute to the same game:submitDecisions payload
  // (each submission is a full replacement, not an increment).
  const [pending, setPending] = useState<SubmittedDecisions>({ strategic: [], operational: [], lawsuits: [] });
  const submitPending = (next: SubmittedDecisions) => {
    setPending(next);
    socket?.emit(ClientEvents.GAME_SUBMIT_DECISIONS, next);
  };

  // Instant forfeit — server marks this player bankrupt and, per game:left, the
  // client resets straight back to the landing page (see socketStore.ts).
  const handleLeaveGame = () => {
    socket?.emit(ClientEvents.GAME_LEAVE, null);
    setLeaveConfirmOpen(false);
  };

  const isReady = !!player && readyPlayerIds.includes(player.id);
  const handleToggleReady = () => {
    socket?.emit(ClientEvents.GAME_READY, { ready: !isReady });
  };

  // Ready state is server-authoritative and per-round — it resets to an empty list
  // itself (game:readyUpdate) the moment a new round starts, so there's no local
  // reset-on-round-change effect needed here, just the listener.
  useEffect(() => {
    if (!socket) return;
    const handler = (data: { readyPlayerIds: string[]; activePlayerCount: number }) => {
      setReadyPlayerIds(data.readyPlayerIds);
      setActivePlayerCount(data.activePlayerCount);
    };
    socket.on(ServerEvents.GAME_READY_UPDATE, handler);
    return () => {
      socket.off(ServerEvents.GAME_READY_UPDATE, handler);
    };
  }, [socket]);

  // Sync from store on turn resolution. Capture the outgoing values as "previous"
  // before overwriting, so KPI/intel trend arrows have something to compare against.
  useEffect(() => {
    if (!turnResults || !player) return;
    // See processedTurnResultsRef's declaration — skips StrictMode's dev-only replay
    // of this same turnResults object so non-idempotent updates below (setEventQueue's
    // append) don't double-fire.
    if (processedTurnResultsRef.current === turnResults) return;
    processedTurnResultsRef.current = turnResults;
    const myPlayer = turnResults.players.find((p) => p.playerId === player.id);
    if (myPlayer) {
      // Read myData/competitors directly rather than via setState's functional-updater
      // form — the ref-guard above already guarantees this effect body runs at most
      // once per genuinely new turnResults, and updater callbacks are explicitly *not*
      // guaranteed single-invocation by React (StrictMode intentionally double-invokes
      // them in dev to catch impure updaters) — setNewsItems' append below is exactly
      // the kind of non-idempotent side effect that bit us when it lived in one.
      setPrevData(myData);
      // Detect lawsuits filed against me, any of my own cases whose verdict just came
      // in, and any of my own cases that settled by negotiation, since the last turn —
      // myData is null on the very first snapshot (nothing to have happened yet), so
      // this only ever fires for genuinely new events appearing in a resolved turn.
      // Tagged with turnResults.round (the round that JUST resolved, when these events
      // actually happened) — NOT the `round` state variable, which by this point may
      // already reflect the round phase:changed just advanced to (see the "must be keyed
      // on round, not turnResults?.round" fix elsewhere in this file for why the two can
      // differ within the same turn transition).
      if (myData) {
        const newlySued = detectNewlySuedCases(myData.legalCases, myPlayer.legalCases, player.id);
        const newlyResolved = detectNewlyResolvedCases(myData.legalCases, myPlayer.legalCases, player.id);
        const newlySettled = detectNewlySettledCases(myData.legalCases, myPlayer.legalCases, player.id);
        // One PostTurnEvent per case, never a batch — see PostTurnEvent's doc comment for
        // why (a real, reported bug where multiple same-turn cases collapsed into one
        // News row/alert, silently hiding every case after the first).
        const newEvents: PostTurnEvent[] = [
          ...newlySued.map((c): PostTurnEvent => ({ type: 'sued', case: c })),
          ...newlyResolved.map((r): PostTurnEvent => ({ type: 'verdict', outcome: r.outcome, case: r.case })),
          ...newlySettled.map((s): PostTurnEvent => ({ type: 'settlement', case: s })),
        ];
        if (newEvents.length > 0) {
          setNewsItems((prev) => [
            ...prev,
            ...newEvents.map((event) => ({ id: crypto.randomUUID(), round: turnResults.round, event })),
          ]);
        }
      }
      setMyData(myPlayer);

      const newCompetitors = turnResults.players.filter((p) => p.playerId !== player.id);
      setPrevCompetitors(new Map(competitors.map((c) => [c.playerId, c])));
      setCompetitors(newCompetitors);
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- myData/competitors are
    // intentionally read as "previous value" via closure, not tracked as deps; the
    // ref-guard above (not this dependency array) is what gates re-execution.
  }, [turnResults, player]);

  // "Next turn" News item — every round after the first (round 1 is the initial game
  // start, not a change from anything).
  useEffect(() => {
    if (lastAnnouncedRoundRef.current === null) {
      lastAnnouncedRoundRef.current = round;
      return;
    }
    if (round !== lastAnnouncedRoundRef.current) {
      lastAnnouncedRoundRef.current = round;
      setNewsItems((prev) => [...prev, { id: crypto.randomUUID(), round, event: { type: 'turnChange', round } }]);
    }
  }, [round]);

  // A new round means the server already cleared last turn's submissions — reset
  // local pending state so stale QUEUED badges don't linger on the new turn. Keyed on
  // `round` (from `phase:changed`), NOT `turnResults?.round`: `turn:resolved`'s `round`
  // field is the round that just finished resolving (captured before GameEngine
  // increments `currentPhaseRound`), while `phase:changed`'s `round` is the new round
  // now starting — the two are one apart, and `phase:changed` always arrives second for
  // the same turn. Gating on `turnResults?.round` used to fire this reset one full round
  // late, so a decision that had just resolved into `myData.activeDecisions` still had
  // its stale QUEUED entry sitting alongside it in "Active Decisions" for one extra turn
  // — a real, reproduced bug, not just a cosmetic lag.
  useEffect(() => {
    setPending({ strategic: [], operational: [], lawsuits: [] });
  }, [round]);

  // Timer countdown — sync with server updates
  useEffect(() => {
    if (currentPhase !== 'GAME_PHASE') return;

    // Use server timer as source of truth
    setLocalTimer(timer);

    const interval = setInterval(() => {
      setLocalTimer((t) => Math.max(0, t - 1));
    }, 1000);

    return () => clearInterval(interval);
  }, [timer, currentPhase]);

  // Listen for socket timer updates to refresh store
  useEffect(() => {
    if (!socket) return;
    const handler = (data: { timeLeft: number }) => {
      updateTimer(data.timeLeft);
    };
    socket.on(ServerEvents.TIMER_UPDATE, handler);
    return () => {
      socket.off(ServerEvents.TIMER_UPDATE, handler);
    };
  }, [socket, updateTimer]);

  if (loading || !myData) {
    return (
      <Box style={gpStyles.loadingOverlay}>
        <Stack align="center" gap="md">
          <IconClock size={48} style={{ opacity: 0.3 }} />
          <Text c="dimmed" fw={500}>Waiting for game data...</Text>
        </Stack>
      </Box>
    );
  }

  const { variables: vars, derived, riskGauge, legalCases: myLegalCases } = myData;
  const isUrgent = localTimer <= 20;
  const playerNames = new Map<string, string>([myData, ...competitors].map((p) => [p.playerId, p.playerName]));
  // "Active Decisions" box header count — active (resolved) + still-queued, per bucket,
  // same "count everything actually shown in the box" convention as "Open Lawsuits (N)".
  // activeDecisions has no `level` field of its own (only the deck's DecisionDefinition
  // does), so each active instance is looked back up by name to bucket it.
  const activeStrategicCount = myData.activeDecisions.filter((d) => decisions.find((def) => def.decision === d.decisionName)?.level === 'Strategic').length + pending.strategic.length;
  const activeOperationalCount = myData.activeDecisions.filter((d) => decisions.find((def) => def.decision === d.decisionName)?.level === 'Operational').length + pending.operational.length;
  const currentEvent = newsModalItem?.event ?? null;
  const dismissCurrentEvent = () => setNewsModalItem(null);

  return (
    <div style={gpStyles.dashboard}>
      {/* ── Header ─────────────────────────────────────── */}
      <Flex justify="space-between" align="center" wrap="wrap" gap="sm" style={gpStyles.header}>
        <Text style={gpStyles.title}>{myData.playerName}</Text>
        <Flex align="center" wrap="wrap" gap="sm">
          <RiskGaugeBar value={riskGauge} trend={computeTrend(riskGauge, prevData?.riskGauge)} onClick={() => setDrillDown({ type: 'threat', data: myData })} />
          <TurnBox
            round={round}
            seconds={localTimer}
            urgent={isUrgent}
            isReady={isReady}
            readyCount={readyPlayerIds.length}
            activePlayerCount={activePlayerCount}
            onToggleReady={handleToggleReady}
          />
          <Button
            size="xs"
            color="red"
            variant="outline"
            leftSection={<IconDoorExit size={14} />}
            onClick={() => setLeaveConfirmOpen(true)}
          >
            Leave Game
          </Button>
        </Flex>
      </Flex>

      {/* ── KPI Cards ──────────────────────────────────── */}
      <Flex wrap="wrap" gap="sm" style={gpStyles.kpiGrid}>
        <KpiCard label="CASH" value={fmt(vars.cash)} negative={vars.cash < 0} trend={computeTrend(vars.cash, prevData?.variables.cash)} onClick={() => setDrillDown({ type: 'cash', data: myData })} />
        <KpiCard label="EQUITY" value={fmt(derived.equity)} trend={computeTrend(derived.equity, prevData?.derived.equity)} onClick={() => setDrillDown({ type: 'equity', data: myData })} />
        <KpiCard label="REVENUE" value={fmt(derived.revenue)} trend={computeTrend(derived.revenue, prevData?.derived.revenue)} onClick={() => setDrillDown({ type: 'revenue', data: myData })} />
        <KpiCard label="STOCK VALUE" value={fmt(derived.stockValue)} trend={computeTrend(derived.stockValue, prevData?.derived.stockValue)} onClick={() => setDrillDown({ type: 'shares', data: myData })} />
      </Flex>

      {/* ── News ───────────────────────────────────────── */}
      <NewsBox items={newsItems} onSelect={setNewsModalItem} />

      {/* ── Two-column layout: Decisions | Legal ──────── */}
      <Flex wrap="wrap" gap="md">
        {/* Left column */}
        <Stack gap="md" style={{ flex: 1, minWidth: 320 }}>
          <SectionCard title={`Active Decisions (${activeStrategicCount} strategic and ${activeOperationalCount} operational)`}>
            <ActiveDecisionsBox
              pending={pending}
              activeDecisions={myData.activeDecisions}
              decisions={decisions}
              playerNames={playerNames}
              statuteOfLimitationsYears={gameSettings?.statuteOfLimitationsYears}
              round={round}
              onSubmitPending={submitPending}
              onOpenDeck={() => setDecisionDeckModalOpen(true)}
            />
          </SectionCard>
        </Stack>

        {/* Right column */}
        <Stack gap="md" style={{ flex: 1, minWidth: 320 }}>
          <SectionCard title={`Open Lawsuits (${myLegalCases.filter((c) => c.status !== 'resolved').length + pending.lawsuits.length})`}>
            <Stack gap="sm">
              <IncomingAttackHints
                attacks={myData.incomingAttacks}
                cash={vars.cash}
                digDeeperCost={gameSettings?.digDeeperCost ?? 10000}
                socket={socket}
                onSueNow={(targetId, decisionName, groundName) => {
                  setSueSuggestion({ targetId, decisionName, groundName });
                  setSueModalOpen(true);
                }}
                pendingLawsuits={pending.lawsuits}
                myLegalCases={myLegalCases}
              />
              <Button variant="filled" color="red" onClick={() => setSueModalOpen(true)} style={{ ...boldStyle }}>
                SUE THEIR ASSES (${(gameSettings?.lawsuitFilingCost ?? 0).toLocaleString()})
              </Button>
              <Stack gap="sm">
                {pending.lawsuits.map((entry, i) => (
                  <QueuedLawsuitCard
                    key={`pending-lawsuit-${i}`}
                    entry={entry}
                    targetName={competitors.find((c) => c.playerId === entry.targetId)?.playerName ?? entry.targetId}
                    onRemove={() => submitPending({ ...pending, lawsuits: pending.lawsuits.filter((_, j) => j !== i) })}
                  />
                ))}
                {myLegalCases
                  .filter((c) => c.status !== 'resolved')
                  .map((c) => (
                    <CaseCard
                      key={c.id}
                      caseData={c}
                      myPlayerId={myData.playerId}
                      playerNames={playerNames}
                      negotiationPeriodTurns={gameSettings?.negotiationPeriodTurns}
                      socket={socket}
                      onRiskInfo={(caseItem) => setRiskInfoCase(caseItem)}
                      cash={vars.cash}
                      digDeeperCost={gameSettings?.digDeeperCost ?? 10000}
                      semaphoreGreenMax={gameSettings?.semaphoreGreenMax}
                      semaphoreYellowMax={gameSettings?.semaphoreYellowMax}
                    />
                  ))}
              </Stack>
            </Stack>
          </SectionCard>

          {competitors.length > 0 && (
            <SectionCard title="Competitor Intel">
              <RivalList rivals={competitors} prevRivals={prevCompetitors} onFullReport={(r) => setDrillDown({ type: 'rival', data: r })} onFieldClick={(r, t) => setDrillDown({ type: 'rival-field', data: r, field: t.field, label: t.label })} />
            </SectionCard>
          )}
        </Stack>
      </Flex>

      {/* ── Modals ─────────────────────────────────────── */}
      <Modal opened={drillDown !== null} onClose={() => setDrillDown(null)} size="lg" centered overlayProps={{ opacity: 0.55, color: 'var(--mantine-color-dark-9)' }}>
        {drillDown && OWN_KPI_DRILLDOWN_FIELD[drillDown.type] && drillDown.data && (
          <>
            <Text style={{ ...boldStyle, fontSize: '0.8rem', marginBottom: 8 }}>{OWN_KPI_DRILLDOWN_FIELD[drillDown.type].label} — HISTORY &amp; PREDICTION</Text>
            <KpiHistoryGraph field={OWN_KPI_DRILLDOWN_FIELD[drillDown.type].field} label={OWN_KPI_DRILLDOWN_FIELD[drillDown.type].label} socket={socket} targetPlayerId={drillDown.data.playerId} />
            <Divider my="md" />
          </>
        )}
        {drillDown?.type === 'cash' && myData && <CashWaterfallView data={myData} prevData={prevData ?? undefined} onFieldClick={(t) => setKpiSubFieldGraph({ ...t, targetPlayerId: myData.playerId })} />}
        {drillDown?.type === 'revenue' && myData && <RevenueView data={myData} prevData={prevData ?? undefined} onFieldClick={(t) => setKpiSubFieldGraph({ ...t, targetPlayerId: myData.playerId })} />}
        {drillDown?.type === 'equity' && myData && <EquityView data={myData} prevData={prevData ?? undefined} onFieldClick={(t) => setKpiSubFieldGraph({ ...t, targetPlayerId: myData.playerId })} />}
        {drillDown?.type === 'shares' && myData && <ShareView data={myData} rivals={competitors} prevData={prevData ?? undefined} prevRivals={prevCompetitors} onFieldClick={(t) => setKpiSubFieldGraph({ ...t, targetPlayerId: myData.playerId })} />}
        {drillDown?.type === 'threat' && myData && <ThreatView data={myData} prevData={prevData ?? undefined} onFieldClick={(t) => setKpiSubFieldGraph({ ...t, targetPlayerId: myData.playerId })} />}
        {drillDown?.type === 'rival' && drillDown.data && myData && (
          <RivalFullReportView
            rival={drillDown.data}
            prevRival={prevCompetitors.get(drillDown.data.playerId)}
            decisions={decisions}
            myData={myData}
            competitors={competitors}
            onFieldClick={(t) => setKpiSubFieldGraph(t)}
          />
        )}
        {drillDown?.type === 'rival-field' && drillDown.data && drillDown.field && (
          <RivalFieldView rival={drillDown.data} field={drillDown.field} label={drillDown.label ?? drillDown.field} socket={socket} />
        )}
      </Modal>

      <Modal opened={kpiSubFieldGraph !== null} onClose={() => setKpiSubFieldGraph(null)} size="md" centered title={<Text style={{ ...boldStyle, fontSize: '0.85rem' }}>{kpiSubFieldGraph?.label} — HISTORY{myData && kpiSubFieldGraph?.targetPlayerId === myData.playerId ? ' & PREDICTION' : ''}</Text>}>
        {kpiSubFieldGraph && <KpiHistoryGraph field={kpiSubFieldGraph.field} label={kpiSubFieldGraph.label} socket={socket} targetPlayerId={kpiSubFieldGraph.targetPlayerId} />}
      </Modal>

      <Modal opened={sueModalOpen} onClose={closeSueModal} size="lg" centered title={<Text style={{ ...boldStyle, fontSize: '0.9rem' }}>📋 SUE THEIR ASSES</Text>}>
        <SueModal
          competitors={competitors}
          decisions={decisions}
          gameSettings={gameSettings}
          pending={pending}
          onSubmitPending={submitPending}
          prefillTargetId={sueSuggestion?.targetId}
          prefillDecisionName={sueSuggestion?.decisionName}
          prefillGroundName={sueSuggestion?.groundName}
          cash={vars.cash}
          socket={socket}
          onClose={closeSueModal}
        />
      </Modal>

      <Modal opened={decisionDeckModalOpen} onClose={() => setDecisionDeckModalOpen(false)} size="lg" centered title={<Text style={{ ...boldStyle, fontSize: '0.9rem' }}>📋 MAKE IMPORTANT DECISIONS</Text>}>
        <DecisionDeckView decisions={decisions} gameSettings={gameSettings} myData={myData} competitors={competitors} pending={pending} onSubmitPending={submitPending} />
      </Modal>

      <Modal opened={riskInfoCase !== null} onClose={() => setRiskInfoCase(null)} size="md" centered title={<Text style={{ ...boldStyle, fontSize: '0.85rem' }}>⚠️ RISK BREAKDOWN</Text>}>
        {riskInfoCase && <RiskBreakdownView caseData={riskInfoCase} vars={vars} />}
      </Modal>

      <Modal opened={leaveConfirmOpen} onClose={() => setLeaveConfirmOpen(false)} size="sm" centered title={<Text style={{ ...boldStyle, fontSize: '0.9rem' }}>🚪 LEAVE GAME</Text>}>
        <Stack gap="md">
          <Text size="sm">
            Leaving now instantly forfeits the game — you're marked bankrupt and there's
            no way back in. The rest of the game continues without you.
          </Text>
          <Flex justify="flex-end" gap="sm">
            <Button variant="default" onClick={() => setLeaveConfirmOpen(false)}>
              Cancel
            </Button>
            <Button color="red" onClick={handleLeaveGame}>
              Leave &amp; Forfeit
            </Button>
          </Flex>
        </Stack>
      </Modal>

      <Modal
        opened={!!currentEvent}
        onClose={dismissCurrentEvent}
        size="md"
        centered
        title={
          <Text style={{ ...boldStyle, fontSize: '0.9rem' }}>
            {newsModalItem && `TURN ${newsModalItem.round} — `}
            {currentEvent?.type === 'sued' && "⚖️ YOU'VE BEEN SUED"}
            {currentEvent?.type === 'verdict' && (currentEvent.outcome === 'won' ? '🏆 CASE WON' : '💩 CASE LOST')}
            {currentEvent?.type === 'settlement' && '🤝 CASE SETTLED'}
            {currentEvent?.type === 'turnChange' && `🔔 NEXT TURN`}
          </Text>
        }
      >
        {currentEvent?.type === 'sued' && (
          <Stack gap="md">
            <Image src="/images/sued.png" alt="Served with a lawsuit" radius="md" />
            <Box style={{ borderLeft: '3px solid var(--mantine-color-red-6)', paddingLeft: 8 }}>
              <Text size="sm" fw={600}>
                {playerNames.get(currentEvent.case.plaintiffId) ?? 'Unknown'} sued you over "{currentEvent.case.decisionName}"
              </Text>
              <Text size="sm" c="dimmed">
                Ground: {currentEvent.case.groundName} — Stakes: {fmt(currentEvent.case.stakes)}
              </Text>
            </Box>
            <Button fullWidth onClick={dismissCurrentEvent}>
              Close
            </Button>
          </Stack>
        )}

        {currentEvent?.type === 'verdict' && (
          <Stack gap="md">
            {(() => {
              // Exactly one case per event now (see PostTurnEvent's doc comment), so
              // whether I was plaintiff or defendant on THIS case is unambiguous — no
              // more "mixed batch" guessing needed.
              const c = currentEvent.case;
              const iAmPlaintiff = c.plaintiffId === player?.id;
              const wonAsDefendant = currentEvent.outcome === 'won' && !iAmPlaintiff;
              const src = currentEvent.outcome === 'lost'
                ? '/images/lawsuit-lost.png'
                : wonAsDefendant ? '/images/defender-won.png' : '/images/lawsuit-won.png';
              const alt = currentEvent.outcome === 'lost' ? 'Case lost' : wonAsDefendant ? 'Case dismissed' : 'Case won';
              return <Image src={src} alt={alt} radius="md" />;
            })()}
            {(() => {
              const c = currentEvent.case;
              const iAmPlaintiff = c.plaintiffId === player?.id;
              const opponentName = playerNames.get(iAmPlaintiff ? c.defendantId : c.plaintiffId) ?? 'Unknown';
              let outcomeLine: string;
              if (iAmPlaintiff && c.verdict === 'won') outcomeLine = `You received ${fmt(c.stakes)} from ${opponentName}`;
              else if (iAmPlaintiff && c.verdict === 'lost') outcomeLine = `You got nothing — the court sided with ${opponentName}`;
              else if (!iAmPlaintiff && c.verdict === 'won') outcomeLine = `You paid ${fmt(c.stakes)} to ${opponentName}`;
              else outcomeLine = `The case against you was dismissed — you paid nothing`;
              return (
                <Box style={{ borderLeft: `3px solid var(--mantine-color-${currentEvent.outcome === 'won' ? 'green' : 'red'}-6)`, paddingLeft: 8 }}>
                  <Text size="sm" fw={600}>
                    {iAmPlaintiff ? `You sued ${opponentName}` : `${opponentName} sued you`} over "{c.decisionName}"
                  </Text>
                  <Text size="sm" c="dimmed">
                    Ground: {c.groundName} — {outcomeLine}
                  </Text>
                </Box>
              );
            })()}
            <Button fullWidth onClick={dismissCurrentEvent}>
              Close
            </Button>
          </Stack>
        )}

        {currentEvent?.type === 'settlement' && (
          <Stack gap="md">
            <Image src="/images/settlement-proposal.png" alt="Settlement reached" radius="md" />
            {(() => {
              const { case: c, role } = currentEvent.case;
              const opponentName = playerNames.get(role === 'plaintiff' ? c.defendantId : c.plaintiffId) ?? 'Unknown';
              const lastOffer = c.offers[c.offers.length - 1]?.amount ?? c.stakes;
              const outcomeLine = role === 'plaintiff'
                ? `Settled — you received ${fmt(lastOffer)} from ${opponentName}`
                : `Settled — you paid ${fmt(lastOffer)} to ${opponentName}`;
              return (
                <Box style={{ borderLeft: '3px solid var(--mantine-color-yellow-6)', paddingLeft: 8 }}>
                  <Text size="sm" fw={600}>
                    {role === 'plaintiff' ? `You sued ${opponentName}` : `${opponentName} sued you`} over "{c.decisionName}"
                  </Text>
                  <Text size="sm" c="dimmed">
                    Ground: {c.groundName} — {outcomeLine}
                  </Text>
                </Box>
              );
            })()}
            <Button fullWidth onClick={dismissCurrentEvent}>
              Close
            </Button>
          </Stack>
        )}

        {currentEvent?.type === 'turnChange' && (
          <Stack gap="md">
            <Image src="/images/turn-change.png" alt="Turn change" radius="md" />
            <Text size="sm" ta="center" c="dimmed">
              Turn {currentEvent.round} has begun.
            </Text>
            <Button fullWidth onClick={dismissCurrentEvent}>
              Close
            </Button>
          </Stack>
        )}
      </Modal>
    </div>
  );
}

// ============================================================
// Sub-components — Header / KPI
// ============================================================

interface KpiCardProps {
  label: string;
  value: string;
  /** Since-last-turn trend — undefined on round 1, when there's nothing to compare against. */
  trend?: Trend;
  /** Show the value itself in red regardless of trend (e.g. cash < 0). */
  negative?: boolean;
  onClick?: () => void;
}

function KpiCard({ label, value, trend, negative, onClick }: KpiCardProps) {
  const color = negative ? '#dc2626' : undefined;
  return (
    <Box style={gpStyles.kpiCard} onClick={onClick}>
      <Text style={gpStyles.kpiLabel}>{label}</Text>
      <Flex align="center" gap="xs">
        <Text style={{ ...boldStyle, fontSize: '1.25rem', color }}>{value}</Text>
        <TrendIcon trend={trend} size={16} />
      </Flex>
    </Box>
  );
}

// ============================================================
// Sub-components — News
// ============================================================

interface NewsBoxProps {
  items: NewsItem[];
  onSelect: (item: NewsItem) => void;
}

/**
 * A persistent, scrollable feed of everything that's happened this game (being sued, a
 * lawsuit verdict, a negotiated settlement, a new turn starting) — replaces the old
 * behavior of auto-popping a "Got it"-dismissed Modal the instant each event happened.
 * By design, nothing here interrupts play: an event just appends a row, and the player
 * clicks it (any time, in any order) to see the same info window that used to show
 * automatically. Newest rows append at the bottom; the list auto-scrolls to follow new
 * arrivals, but only while the player is already at (or very near) the bottom — if
 * they've scrolled up to reread older news, a new arrival doesn't yank them back down
 * (the `stickToBottomRef` + `onScroll` distance check below is the whole mechanism).
 */
function NewsBox({ items, onSelect }: NewsBoxProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);

  const handleScroll = () => {
    const el = listRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottomRef.current = distanceFromBottom < 40;
  };

  useEffect(() => {
    if (stickToBottomRef.current && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [items.length]);

  return (
    <SectionCard title="News">
      {items.length === 0 ? (
        <Text c="dimmed" size="sm">No news yet</Text>
      ) : (
        <div
          ref={listRef}
          onScroll={handleScroll}
          style={{ maxHeight: 220, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 6, paddingRight: 4 }}
        >
          {items.map((item) => (
            <NewsRow key={item.id} item={item} onClick={() => onSelect(item)} />
          ))}
        </div>
      )}
    </SectionCard>
  );
}

interface NewsRowProps {
  item: NewsItem;
  onClick: () => void;
}

/** One News row — flashes red a few times right when it first mounts (i.e. the instant
 * it's added; existing rows never remount on a later re-render since `NewsBox` only ever
 * appends, so the `news-flash` animation naturally never replays for an already-seen
 * row) to catch the eye without demanding an immediate response the way the old
 * auto-popup Modal did. */
function NewsRow({ item, onClick }: NewsRowProps) {
  return (
    <Flex
      justify="space-between"
      align="center"
      onClick={onClick}
      style={{
        padding: '6px 10px',
        border: '2px solid #333',
        borderRadius: 6,
        cursor: 'pointer',
        background: '#fff',
        animation: 'news-flash 0.6s ease-in-out 3',
      }}
      title="Click for details"
    >
      <Text size="sm" style={{ textDecoration: 'underline', textDecorationStyle: 'dotted', textUnderlineOffset: 3 }}>
        {newsTopic(item.event)}
      </Text>
      <Text size="xs" c="dimmed" style={boldStyle}>TURN {item.round}</Text>
    </Flex>
  );
}

// ============================================================
// Sub-components — Risk Gauge Bar
// ============================================================

interface RiskGaugeBarProps {
  value: number;
  /** Since-last-turn trend — undefined on round 1, when there's nothing to compare against. */
  trend?: Trend;
  onClick: () => void;
}

function RiskGaugeBar({ value, trend, onClick }: RiskGaugeBarProps) {
  const pctVal = Math.max(0, Math.min(100, value));
  const critical = pctVal >= 70;
  const color = pctVal < 35 ? '#22c55e' : pctVal < 70 ? '#fbbf24' : '#ef4444';

  return (
    <Box style={{ ...gpStyles.sectionCard, cursor: 'pointer', maxWidth: 280 }} onClick={onClick}>
      <Flex align="center" gap="sm">
        <IconShield size={20} style={{ color: '#333' }} />
        <Stack gap={0}>
          <Text style={{ ...boldStyle, fontSize: '0.65rem', letterSpacing: '0.03em', color: '#444' }}>
            {critical ? 'THREAT — ALERT' : 'THREAT LEVEL'}
          </Text>
          <Box h={12} style={{ background: '#fff', border: '3px solid #333', borderRadius: 9999, overflow: 'hidden', width: 200 }}>
            <Box h="100%" style={{ background: color, width: `${pctVal}%`, transition: 'width 0.5s ease' }} />
          </Box>
        </Stack>
        <TrendIcon trend={trend} invert size={16} />
      </Flex>
    </Box>
  );
}

// ============================================================
// Sub-components — Turn Box (countdown + round number + Ready)
// ============================================================

interface TurnBoxProps {
  round: number;
  seconds: number;
  urgent?: boolean;
  isReady: boolean;
  readyCount: number;
  activePlayerCount: number;
  onToggleReady: () => void;
}

function TurnBox({ round, seconds, urgent, isReady, readyCount, activePlayerCount, onToggleReady }: TurnBoxProps) {
  return (
    <Box style={{ ...gpStyles.sectionCard, maxWidth: 220 }}>
      <Flex justify="space-between" align="center" gap="sm">
        <Text style={{ ...boldStyle, fontSize: '0.65rem', letterSpacing: '0.03em', color: '#444' }}>
          TURN {round}
        </Text>
        <Badge variant="light" color={urgent ? 'red' : 'dark'} style={{ ...boldStyle, ...(urgent && { animation: 'pulse 1s infinite' }) }}>
          <Flex align="center" gap={4}>
            <IconClock size={14} />
            {String(Math.floor(seconds / 60)).padStart(2, '0')}:{String(seconds % 60).padStart(2, '0')}
          </Flex>
        </Badge>
      </Flex>
      <Button
        fullWidth
        size="xs"
        mt={6}
        color={isReady ? 'green' : 'dark'}
        variant={isReady ? 'filled' : 'outline'}
        onClick={onToggleReady}
      >
        {isReady ? '✓ READY' : 'READY'} ({readyCount}/{activePlayerCount})
      </Button>
    </Box>
  );
}

// ============================================================
// Sub-components — Section Card wrapper
// ============================================================

interface SectionCardProps {
  title: string;
  children: React.ReactNode;
}

function SectionCard({ title, children }: SectionCardProps) {
  return (
    <div style={gpStyles.sectionCard}>
      <Text style={gpStyles.sectionTitle}>{title}</Text>
      {children}
    </div>
  );
}

// ============================================================
// Sub-components — Active Decision Card
// ============================================================

/** Description + collapsible effects/legal-risk panel for a decision that's already
 * deployed or queued — shared by `ActiveDecisionCard` and `QueuedDecisionCard` so both
 * show the same "what does this actually do" detail the Decision Deck's own
 * `DecisionCard` already provides. `def` is looked up by name against the loaded
 * decision library at each card's call site, since neither an `ActiveDecisionInstance`
 * nor a queued `SubmittedDecisionEntry` carries the full `DecisionDefinition` itself
 * (only `decisionName`/`name`) — undefined if the lookup ever fails, in which case
 * nothing renders (defensive; shouldn't happen since a decision in use can't be deleted,
 * see CLAUDE.md's "Deleting a decision is guarded" section). */
function DecisionDetails({ def }: { def?: DecisionDefinition }) {
  const [expanded, setExpanded] = useState(false);
  if (!def) return null;

  const effects = summarizeEffects(def);
  const hasLegalRisk = !!def.legalRisks && def.legalRisks.length > 0;
  const hasDetails = effects.length > 0 || hasLegalRisk;

  return (
    <>
      <Text size="xs" c="dimmed" style={{ marginTop: 6, lineHeight: 1.4 }}>{def.description}</Text>
      {hasDetails && (
        <Flex align="center" gap={6} style={{ marginTop: 6, cursor: 'pointer' }} onClick={() => setExpanded((e) => !e)}>
          <Text size="xs" style={{ ...boldStyle, color: '#4b5563' }}>{expanded ? 'HIDE DETAILS' : 'SHOW DETAILS'}</Text>
          <IconChevronDown size={12} style={{ color: '#6b7280', transform: expanded ? 'rotate(180deg)' : undefined, transition: 'transform 0.2s ease' }} />
        </Flex>
      )}
      {expanded && effects.length > 0 && (
        <div style={{ marginTop: 8, padding: 8, background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 6 }}>
          <Text size="xs" style={{ ...boldStyle, color: '#4b5563', marginBottom: 4 }}>EFFECTS</Text>
          <Stack gap={2}>
            {effects.map((line) => (
              <Flex key={line.field} justify="space-between" gap="xs">
                <Text size="xs" c="dimmed">{line.field}</Text>
                <Text size="xs" style={boldStyle}>{line.timeline}</Text>
              </Flex>
            ))}
          </Stack>
        </div>
      )}
      {expanded && hasLegalRisk && (
        <Text size="xs" c="orange" style={{ marginTop: 4, fontStyle: 'italic' }}>
          ⚖ Legal risk: {def.legalRisks!.map((r) => r.name).join(', ')}
        </Text>
      )}
    </>
  );
}

/** The four statuses an already-deployed decision instance can be in — the same four
 * `ActiveDecisionCard`'s badge already distinguished inline, pulled out into its own type
 * so the "Active Decisions" box's status filter can classify a card the exact same way
 * the card itself renders, with no risk of the two drifting apart. */
type ActiveDecisionStatus = 'voided' | 'expired' | 'matured' | 'maturing';

/** Mirrors the badge/status logic `ActiveDecisionCard` always computed inline — pulled out
 * so `ActiveDecisionsBox`'s status filter classifies a decision exactly the same way the
 * card itself does. `voidedByLawsuit` wins over "expired" (a voided instance's permanent
 * effect is already moot regardless of the statute), matching the card's original
 * ternary order. */
function getActiveDecisionStatus(
  decision: { isMatured: boolean; voidedByLawsuit: boolean; elapsedYears: number },
  def: DecisionDefinition | undefined,
  statuteOfLimitationsYears?: number,
): ActiveDecisionStatus {
  if (decision.voidedByLawsuit) return 'voided';
  if (def && hasPermanentEffect(def) && statuteOfLimitationsYears !== undefined && decision.elapsedYears >= statuteOfLimitationsYears) return 'expired';
  return decision.isMatured ? 'matured' : 'maturing';
}

interface ActiveDecisionCardProps {
  decision: {
    id: string;
    decisionName: string;
    deployedYear: number;
    maturityYears: number;
    elapsedYears: number;
    isMatured: boolean;
    /** True once a lawsuit cancelled this instance's forthcoming effects — see CLAUDE.md. */
    voidedByLawsuit: boolean;
  };
  /** Looked up by name against the loaded decision library at the call site — see `DecisionDetails`. */
  def?: DecisionDefinition;
  /** Used to tell whether a permanent-effect instance has aged past `gameSettings.statuteOfLimitationsYears` and stopped applying its effect — see CLAUDE.md. */
  statuteOfLimitationsYears?: number;
  /** Resolved from the instance's own `targetId` at the call site — set only for a decision that was aimed at a chosen opponent (e.g. Bot Attack). */
  targetName?: string;
}

function ActiveDecisionCard({ decision, def, statuteOfLimitationsYears, targetName }: ActiveDecisionCardProps) {
  const progress = decision.maturityYears > 0 ? Math.min(100, (decision.elapsedYears / decision.maturityYears) * 100) : 100;
  const status = getActiveDecisionStatus(decision, def, statuteOfLimitationsYears);
  const statusLabel = status === 'voided' ? 'VOIDED — SUED' : status === 'expired' ? 'EXPIRED' : status === 'matured' ? '✓ MATURED' : `${Math.round(progress)}%`;
  const statusTone = status === 'voided' || status === 'expired' ? 'gray' : status === 'matured' ? 'green' : 'yellow';

  return (
    <div style={gpStyles.activeDecisionCard}>
      <Flex justify="space-between" align="center">
        <Stack gap={0}>
          <Text style={{ ...boldStyle, fontSize: '0.9rem' }}>{decision.decisionName}</Text>
          {targetName && <Text size="xs" c="dimmed">→ {targetName}</Text>}
          <Text size="xs" c="dimmed">
            Deployed Year {decision.deployedYear + 1} ·{' '}
            {status === 'voided'
              ? 'Shut down by a lost lawsuit — free to redeploy'
              : status === 'expired'
                ? 'Permanent effect expired — free to redeploy'
                : status === 'matured' ? 'MATURED' : `${Math.max(0, decision.maturityYears - decision.elapsedYears)} turns left`}
          </Text>
        </Stack>
        <Badge style={gpStyles.stamp(statusTone)}>{statusLabel}</Badge>
      </Flex>
      {/* Progress bar */}
      {!decision.isMatured && (
        <Box mt="sm" h={6} style={{ background: '#e5e7eb', borderRadius: 3 }}>
          <Box h="100%" style={{ width: `${progress}%`, background: '#fbbf24', borderRadius: 3, transition: 'width 0.3s ease' }} />
        </Box>
      )}
      <DecisionDetails def={def} />
    </div>
  );
}

interface QueuedDecisionCardProps {
  name: string;
  /** Set when this decision targets a chosen opponent (e.g. Bot Attack) — resolved to a player name where possible. */
  targetName?: string;
  /** Looked up by name against the loaded decision library at the call site — see `DecisionDetails`. */
  def?: DecisionDefinition;
  onCancel: () => void;
}

/** A decision the player has selected this turn but that hasn't been submitted/resolved
 * yet — shown alongside `ActiveDecisionCard` in the "Active Decisions" list so a queued
 * pick doesn't only appear inside the Decision Deck modal (MAKE IMPORTANT DECISIONS).
 * Deliberately a separate, lighter component rather than reusing `ActiveDecisionCard`: a
 * pending `SubmittedDecisionEntry` (`{ name, targetId? }`) has no `id`/maturity/
 * deployedYear yet — those only exist once the decision has actually been deployed by a
 * turn resolving. Shares `DecisionDetails` (description + collapsible effects/legal-risk)
 * with `ActiveDecisionCard`, since a queued pick's own `DecisionDefinition` lookup is
 * identical — only the header row (progress vs. QUEUED badge) differs. */
function QueuedDecisionCard({ name, targetName, def, onCancel }: QueuedDecisionCardProps) {
  return (
    <div style={gpStyles.activeDecisionCard}>
      <Flex justify="space-between" align="center">
        <Stack gap={0}>
          <Text style={{ ...boldStyle, fontSize: '0.9rem' }}>{name}</Text>
          {targetName && <Text size="xs" c="dimmed">→ {targetName}</Text>}
        </Stack>
        <Flex align="center" gap={8}>
          <Badge style={gpStyles.stamp('red')}>QUEUED</Badge>
          <Text size="xs" c="red" style={{ cursor: 'pointer', textDecoration: 'underline' }} onClick={onCancel}>Cancel</Text>
        </Flex>
      </Flex>
      <DecisionDetails def={def} />
    </div>
  );
}

/** Caps the "Active Decisions" list to roughly 3 collapsed cards' worth of height before
 * scrolling kicks in — an approximation, not an exact fit: a card's real height varies
 * with whether it has a target line, a progress bar, or an expanded SHOW DETAILS panel,
 * none of which this constant can account for. Sized against a plain collapsed card
 * (~110px including the "sm" gap between cards). */
const ACTIVE_DECISIONS_MAX_HEIGHT = 360;

/** One row in the "Active Decisions" box's unified list — a still-queued pick or an
 * already-deployed instance, normalized to the handful of fields the box's filter/sort
 * needs regardless of which one it actually is. Kept as a discriminated union (not one
 * looser shape with optional fields) since `ActiveDecisionCard`/`QueuedDecisionCard`
 * still need their own real props to render — this is purely a filter/sort-time view. */
type DecisionBoxItem =
  | { kind: 'queued'; key: string; name: string; targetName?: string; def?: DecisionDefinition; onCancel: () => void }
  | { kind: 'active'; key: string; decision: PlayerTurnResult['activeDecisions'][number]; name: string; targetName?: string; def?: DecisionDefinition; status: ActiveDecisionStatus };

/** The status filter's options — 'Queued' for a not-yet-resolved pick, the same four
 * `getActiveDecisionStatus` distinguishes for an already-deployed one. */
type DecisionBoxFilterStatus = 'All' | 'Queued' | 'Maturing' | 'Matured' | 'Voided — Sued' | 'Expired';

const ACTIVE_DECISION_STATUS_LABELS: Record<ActiveDecisionStatus, DecisionBoxFilterStatus> = {
  voided: 'Voided — Sued',
  expired: 'Expired',
  matured: 'Matured',
  maturing: 'Maturing',
};

function decisionBoxItemStatus(item: DecisionBoxItem): DecisionBoxFilterStatus {
  return item.kind === 'queued' ? 'Queued' : ACTIVE_DECISION_STATUS_LABELS[item.status];
}

type DecisionBoxSortField = '' | 'turn' | 'target' | 'name';

/** A queued pick has no `deployedYear` yet (nothing to deploy until this turn resolves)
 * — sorts as "the current round" for the turn field, the same "not yet started, treat as
 * happening now" convention the box's own header count/queued badge already imply. */
function getDecisionBoxTurn(item: DecisionBoxItem, round: number): number {
  return item.kind === 'queued' ? round : item.decision.deployedYear + 1;
}

interface ActiveDecisionsBoxProps {
  pending: SubmittedDecisions;
  activeDecisions: PlayerTurnResult['activeDecisions'];
  decisions: DecisionDefinition[];
  /** playerId -> playerName, for resolving a decision's `targetId` to a display name — the
   * same map `GamePhase` already builds from `[myData, ...competitors]`. */
  playerNames: Map<string, string>;
  statuteOfLimitationsYears?: number;
  round: number;
  onSubmitPending: (next: SubmittedDecisions) => void;
  onOpenDeck: () => void;
}

/**
 * "Active Decisions" box body — the MAKE IMPORTANT DECISIONS button, a status filter, a
 * turn/attacked-player/name sort (same "native `<select>` + two direction chips" shape
 * the Decision Deck's own KPI sort already established), and the merged queued+active
 * list itself, capped to a fixed height so at most ~3 collapsed cards show at once with
 * the rest reachable by scrolling — see `ACTIVE_DECISIONS_MAX_HEIGHT`.
 */
function ActiveDecisionsBox({ pending, activeDecisions, decisions, playerNames, statuteOfLimitationsYears, round, onSubmitPending, onOpenDeck }: ActiveDecisionsBoxProps) {
  const [statusFilter, setStatusFilter] = useState<DecisionBoxFilterStatus>('All');
  const [sortField, setSortField] = useState<DecisionBoxSortField>('');
  const [sortDirection, setSortDirection] = useState<'desc' | 'asc'>('desc');

  const items: DecisionBoxItem[] = [
    ...(['strategic', 'operational'] as const).flatMap((bucket) =>
      pending[bucket].map((entry, i): DecisionBoxItem => ({
        kind: 'queued',
        key: `${bucket}-${i}`,
        name: entry.name,
        targetName: entry.targetId ? (playerNames.get(entry.targetId) ?? entry.targetId) : undefined,
        def: decisions.find((def) => def.decision === entry.name),
        onCancel: () => onSubmitPending({ ...pending, [bucket]: pending[bucket].filter((e) => e.name !== entry.name) }),
      })),
    ),
    ...activeDecisions.map((decision): DecisionBoxItem => {
      const def = decisions.find((d) => d.decision === decision.decisionName);
      return {
        kind: 'active',
        key: decision.id,
        decision,
        name: decision.decisionName,
        targetName: decision.targetId ? (playerNames.get(decision.targetId) ?? decision.targetId) : undefined,
        def,
        status: getActiveDecisionStatus(decision, def, statuteOfLimitationsYears),
      };
    }),
  ];

  const filtered = items.filter((item) => statusFilter === 'All' || decisionBoxItemStatus(item) === statusFilter);
  if (sortField) {
    filtered.sort((a, b) => {
      const diff = sortField === 'turn'
        ? getDecisionBoxTurn(a, round) - getDecisionBoxTurn(b, round)
        : sortField === 'target'
          ? (a.targetName ?? '').localeCompare(b.targetName ?? '')
          : a.name.localeCompare(b.name);
      return sortDirection === 'desc' ? -diff : diff;
    });
  }

  const statusOptions: DecisionBoxFilterStatus[] = ['All', 'Queued', 'Maturing', 'Matured', 'Voided — Sued', 'Expired'];

  return (
    <Stack gap="sm">
      <Button variant="filled" color="dark" onClick={onOpenDeck} style={{ ...boldStyle }}>
        MAKE IMPORTANT DECISIONS
      </Button>

      {items.length > 0 && (
        <Stack gap={6}>
          <Flex wrap="wrap" gap="xs">
            {statusOptions.map((s) => (
              <Badge key={s} style={gpStyles.filterChip(statusFilter === s)} onClick={() => setStatusFilter(s)}>{s}</Badge>
            ))}
          </Flex>
          <Flex gap="xs" wrap="wrap" align="center">
            <select
              value={sortField}
              onChange={(e) => setSortField(e.target.value as DecisionBoxSortField)}
              style={{ padding: '6px 8px', border: '2px solid var(--mantine-color-dark-4)', borderRadius: 8, fontSize: '0.75rem' }}
            >
              <option value="">No sorting</option>
              <option value="turn">Turn deployed</option>
              <option value="target">Attacked player</option>
              <option value="name">Decision name</option>
            </select>
            {sortField && (
              <Flex gap="xs">
                <Badge style={gpStyles.filterChip(sortDirection === 'desc')} onClick={() => setSortDirection('desc')}>Newest → Oldest / Z → A</Badge>
                <Badge style={gpStyles.filterChip(sortDirection === 'asc')} onClick={() => setSortDirection('asc')}>Oldest → Newest / A → Z</Badge>
              </Flex>
            )}
          </Flex>
        </Stack>
      )}

      {items.length > 0 && filtered.length === 0 ? (
        <Text c="dimmed" size="xs" style={{ fontStyle: 'italic' }}>No decisions match this filter.</Text>
      ) : (
        <Stack gap="sm" style={{ maxHeight: ACTIVE_DECISIONS_MAX_HEIGHT, overflowY: 'auto', paddingRight: 4 }}>
          {filtered.map((item) =>
            item.kind === 'queued' ? (
              <QueuedDecisionCard key={item.key} name={item.name} targetName={item.targetName} def={item.def} onCancel={item.onCancel} />
            ) : (
              <ActiveDecisionCard key={item.key} decision={item.decision} def={item.def} statuteOfLimitationsYears={statuteOfLimitationsYears} targetName={item.targetName} />
            ),
          )}
        </Stack>
      )}
    </Stack>
  );
}

// ============================================================
// Sub-components — Decision Deck
// ============================================================

/**
 * Whether a decision needs a chosen opponent before it can be deployed. The
 * `requiresTarget` flag in game_engine.json is only actually set on Buy Shares, but
 * every decision with a `target.*` impact field (Patent Trolling, Talent
 * Poaching, Raw Material Monopoly, Union Agitation, Bot Attack, Reporting Rivals,
 * Social Astroturf, Fox Release, Slander Chief Executive Officer, Patent Portfolio)
 * routes its effect to a specific opponent just the same, so it needs the same picker.
 */
function decisionNeedsTarget(def: DecisionDefinition): boolean {
  return def.requiresTarget === true || Object.keys(def.impacts).some((field) => field.startsWith('target.'));
}

/** Mirrors DecisionEngine.hasPermanentEffect (server, decisionEngine.ts) — kept in sync
 * by hand, same "duplicate small pure logic client-side" convention as getMaturityYears.
 * True if any of a decision's own fields (excluding "target." and "competitor"-prefixed
 * ones) carry a non-zero 'default' schedule value, meaning that field's effect keeps
 * being re-applied every turn forever once the schedule's explicit years run out. */
function hasPermanentEffect(def: DecisionDefinition): boolean {
  for (const [field, impact] of Object.entries(def.impacts)) {
    if (field.startsWith('target.') || field.startsWith('competitor')) continue;
    if ((impact.schedule['default'] ?? 0) !== 0) return true;
  }
  return false;
}

/** Mirrors DecisionEngine.canDeploy's exclusion rules so the
 * client never offers a deploy the server would silently reject. */
function getDeployability(
  def: DecisionDefinition,
  activeDecisions: PlayerTurnResult['activeDecisions'],
  allDecisions: DecisionDefinition[],
  statuteOfLimitationsYears = Infinity,
): { blocked: boolean; reason?: string } {
  const existing = activeDecisions.filter((d) => d.decisionName === def.decision);
  if (existing.length > 0 && !existing[existing.length - 1].isMatured) {
    const last = existing[existing.length - 1];
    return { blocked: true, reason: `Still maturing — ${Math.max(0, last.maturityYears - last.elapsedYears)} turn(s) left` };
  }

  // A decision with a permanent effect blocks redeploying itself for as long as an
  // instance is still actively delivering that effect — that window ends the same way an
  // instance stops being suable (gameSettings.statuteOfLimitationsYears), same as its
  // effect stops being re-applied server-side. A voided-by-lawsuit instance never counts,
  // since it never got to keep its effect at all.
  if (hasPermanentEffect(def) && existing.some((d) => d.isMatured && !d.voidedByLawsuit && d.elapsedYears < statuteOfLimitationsYears)) {
    return { blocked: true, reason: 'Still delivering its permanent effect — cannot be redeployed yet' };
  }

  for (const excluded of def.excludes) {
    const found = activeDecisions.find((d) => d.decisionName === excluded && !d.isMatured);
    if (found) return { blocked: true, reason: `Blocked while ${excluded} is maturing` };
  }

  for (const active of activeDecisions) {
    if (active.isMatured) continue;
    const activeDef = allDecisions.find((d) => d.decision === active.decisionName);
    if (activeDef?.excludes.includes(def.decision)) {
      return { blocked: true, reason: `Blocked by ${active.decisionName} until it matures` };
    }
  }

  return { blocked: false };
}

const natureTone: Record<string, string> = { Traditional: 'green', 'Grey Area': 'yellow', Dirty: 'red' };

// ── Decision effect summaries (what it does, when it starts, how long it lasts) ──

const MONEY_FIELDS = new Set([
  'cash', 'assets', 'intangibleAssets', 'debt', 'reserves', 'operatingExpenses',
  'staffCost', 'materialCostPerTon', 'otherIncome', 'logisticsCostPerTon',
]);

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

/** Every KPI field name a decision in the library can affect via its own impacts (never
 * `target.*`/`competitor*` ones — a decision's "Sort by Outrage" should mean the deploying
 * player's own outrage, not what it does to a chosen opponent) — populates the Decision
 * Deck's "SORT BY KPI" dropdown. Derived from the actual (DB-backed, admin-editable)
 * decision library rather than a hardcoded list, so a field nothing in the library touches
 * never shows up as a useless option. */
function getSortableKpiFields(decisions: DecisionDefinition[]): string[] {
  const fields = new Set<string>();
  for (const def of decisions) {
    for (const field of Object.keys(def.impacts)) {
      if (field.startsWith('target.') || field.startsWith('competitor')) continue;
      fields.add(field);
    }
  }
  return Array.from(fields).sort((a, b) => formatFieldLabel(a).localeCompare(formatFieldLabel(b)));
}

/** A decision's own effect on one KPI field at the moment it's deployed (elapsedYears=0)
 * — mirrors calcEngine's getScheduleValue(schedule, 0) convention (the explicit year-1
 * value if the schedule has one, else the ongoing 'default', else 0) — used purely to rank
 * decisions in the Decision Deck's sort, not for any real game math. 0 for a decision that
 * doesn't touch this field at all, so it sorts predictably alongside decisions that do. */
function getDecisionSortValue(def: DecisionDefinition, field: string): number {
  const impact = def.impacts[field];
  if (!impact) return 0;
  return impact.schedule[1] ?? impact.schedule['default'] ?? 0;
}

/** Max explicit numeric schedule key across all impacts — mirrors calcEngine's
 * calculateMaturityYears: 0 = instant, re-selectable immediately. */
function getMaturityYears(def: DecisionDefinition): number {
  let max = 0;
  for (const impact of Object.values(def.impacts)) {
    for (const key of Object.keys(impact.schedule)) {
      if (key === 'default') continue;
      const n = Number(key);
      if (!isNaN(n) && n > max) max = n;
    }
  }
  return max;
}

interface EffectLine {
  field: string;
  timeline: string;
}

/** Per-field "when it starts / how long it lasts" timeline, e.g. "Yr 1: -$100,000 → Yr 2: -$100,000". */
function summarizeEffects(def: DecisionDefinition): EffectLine[] {
  const lines: EffectLine[] = [];
  for (const [field, impact] of Object.entries(def.impacts)) {
    const keys = Object.keys(impact.schedule).filter((k) => k !== 'default').map(Number).sort((a, b) => a - b);
    const parts: string[] = [];
    for (const k of keys) {
      const v = impact.schedule[k];
      if (v === 0) continue;
      parts.push(`Yr ${k}: ${formatImpactValue(field, impact.type, v)}`);
    }
    const ongoing = impact.schedule['default'];
    if (ongoing !== undefined && ongoing !== 0) {
      parts.push(`Ongoing: ${formatImpactValue(field, impact.type, ongoing)}`);
    }
    if (parts.length === 0) continue;
    lines.push({ field: formatFieldLabel(field), timeline: parts.join(' → ') });
  }
  return lines;
}

interface DecisionDeckViewProps {
  decisions: DecisionDefinition[];
  gameSettings: GameSettings | null;
  myData: PlayerTurnResult;
  competitors: PlayerTurnResult[];
  pending: SubmittedDecisions;
  onSubmitPending: (next: SubmittedDecisions) => void;
}

function DecisionDeckView({ decisions, gameSettings, myData, competitors, pending, onSubmitPending }: DecisionDeckViewProps) {
  const [filterLevel, setFilterLevel] = useState<string>('All');
  const [filterNature, setFilterNature] = useState<string>('All');
  const [searchQuery, setSearchQuery] = useState('');
  const [sortField, setSortField] = useState<string>('');
  const [sortDirection, setSortDirection] = useState<'desc' | 'asc'>('desc');

  const q = searchQuery.trim().toLowerCase();
  const filtered = decisions.filter(
    (d) =>
      (filterLevel === 'All' || d.level === filterLevel) &&
      (filterNature === 'All' || d.nature === filterNature) &&
      (q === '' || d.decision.toLowerCase().includes(q) || d.description.toLowerCase().includes(q)),
  );
  if (sortField) {
    filtered.sort((a, b) => {
      const diff = getDecisionSortValue(a, sortField) - getDecisionSortValue(b, sortField);
      return sortDirection === 'desc' ? -diff : diff;
    });
  }
  const sortableFields = getSortableKpiFields(decisions);

  const togglePending = (def: DecisionDefinition, targetId?: string, amount?: number) => {
    const bucket = def.level === 'Strategic' ? 'strategic' : 'operational';
    const already = pending[bucket].some((e) => e.name === def.decision);
    onSubmitPending({
      ...pending,
      [bucket]: already
        ? pending[bucket].filter((e) => e.name !== def.decision)
        : [...pending[bucket], { name: def.decision, targetId, amount }],
    });
  };

  return (
    <Stack gap="md">
      {/* Filter chips — level (Strategic/Operational) and nature (Traditional/Grey Area/
          Dirty) are two independent filters, so each gets its own row rather than
          wrapping together into one line as if they were a single chip group. */}
      <Stack gap={6}>
        <Flex wrap="wrap" gap="xs">
          {['All', 'Strategic', 'Operational'].map((lvl) => (
            <Badge key={lvl} style={gpStyles.filterChip(filterLevel === lvl)} onClick={() => setFilterLevel(lvl)}>
              {lvl}
            </Badge>
          ))}
        </Flex>
        <Flex wrap="wrap" gap="xs">
          {['All', 'Traditional', 'Grey Area', 'Dirty'].map((nat) => (
            <Badge key={nat} style={gpStyles.filterChip(filterNature === nat)} onClick={() => setFilterNature(nat)}>
              {nat}
            </Badge>
          ))}
        </Flex>
      </Stack>

      {/* Search — same shape as SueModal's "SEARCH GROUNDS" field, matching by decision
          name or description. */}
      <Stack gap={4}>
        <Text style={{ ...boldStyle, fontSize: '0.7rem', color: '#6b7280' }}>SEARCH DECISIONS</Text>
        <div style={gpStyles.searchInput}>
          <IconSearch size={16} style={{ color: '#9ca3af' }} />
          <TextInput flex={1} placeholder="e.g. factory, water pumping, outrage…" value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} style={{ border: 'none', outline: 'none', background: 'transparent' }} />
        </div>
      </Stack>

      {/* Sort by KPI — any field a decision in the library can affect via its own impacts
          (excluding target-routed or competitor fields), ranked by that decision's
          deployment-year effect on the chosen field. Direction chips only appear once a
          KPI is actually chosen. */}
      <Stack gap={4}>
        <Text style={{ ...boldStyle, fontSize: '0.7rem', color: '#6b7280' }}>SORT BY KPI</Text>
        <Flex gap="xs" wrap="wrap" align="center">
          <select
            value={sortField}
            onChange={(e) => setSortField(e.target.value)}
            style={{ padding: '8px 10px', border: '2px solid var(--mantine-color-dark-4)', borderRadius: 8, fontSize: '0.8rem' }}
          >
            <option value="">No sorting</option>
            {sortableFields.map((field) => (
              <option key={field} value={field}>{formatFieldLabel(field)}</option>
            ))}
          </select>
          {sortField && (
            <Flex gap="xs">
              <Badge style={gpStyles.filterChip(sortDirection === 'desc')} onClick={() => setSortDirection('desc')}>Highest → Lowest</Badge>
              <Badge style={gpStyles.filterChip(sortDirection === 'asc')} onClick={() => setSortDirection('asc')}>Lowest → Highest</Badge>
            </Flex>
          )}
        </Flex>
      </Stack>

      {gameSettings && (
        <Text size="xs" c="dimmed" style={boldStyle}>
          {pending.strategic.length}/{gameSettings.maxStrategicDecisionsPerTurn} STRATEGIC · {pending.operational.length}/{gameSettings.maxOperationalDecisionsPerTurn} OPERATIONAL QUEUED
        </Text>
      )}

      {decisions.length === 0 ? (
        <Text c="dimmed" size="xs" style={{ fontStyle: 'italic' }}>Loading decision deck…</Text>
      ) : filtered.length === 0 ? (
        <Text c="dimmed" size="xs" style={{ fontStyle: 'italic' }}>No decisions match these filters/search.</Text>
      ) : (
        <Stack gap="sm" style={{ maxHeight: '60vh', overflowY: 'auto', paddingRight: 4 }}>
          {filtered.map((def) => {
            const bucket = def.level === 'Strategic' ? 'strategic' : 'operational';
            const isPending = pending[bucket].some((e) => e.name === def.decision);
            const atLimit = gameSettings
              ? pending[bucket].length >= (bucket === 'strategic' ? gameSettings.maxStrategicDecisionsPerTurn : gameSettings.maxOperationalDecisionsPerTurn)
              : false;
            const deployability = getDeployability(def, myData.activeDecisions, decisions, gameSettings?.statuteOfLimitationsYears);
            return (
              <DecisionCard
                key={def.decision}
                def={def}
                isPending={isPending}
                blocked={deployability}
                disabledByLimit={!isPending && atLimit}
                competitors={competitors}
                myData={myData}
                onToggle={(targetId, amount) => togglePending(def, targetId, amount)}
              />
            );
          })}
        </Stack>
      )}
    </Stack>
  );
}

interface DecisionCardProps {
  def: DecisionDefinition;
  isPending: boolean;
  blocked: { blocked: boolean; reason?: string };
  disabledByLimit: boolean;
  competitors: PlayerTurnResult[];
  /** Needed for a `variableAmount` decision's amount bracket (Buy Shares bounds by own
   * cash; Sell Shares bounds by the current value of the holding in whichever company
   * is targeted, own included) and for offering "Myself" as a target option. */
  myData: PlayerTurnResult;
  onToggle: (targetId?: string, amount?: number) => void;
}

/** Matches the server's `SELF_OWNERSHIP_KEY` sentinel (calcEngine.ts) — a company's own
 * founding player's stake in its own shareOwnership map. Duplicated here rather than
 * imported since this is server engine code — same "keep a small copy in sync by hand"
 * convention as `computeOfferBracket`/`getDeployability` elsewhere in this file. */
const SELF_OWNERSHIP_KEY = 'self';

/** Matches the server's `EXTERNAL_MARKET_KEY` sentinel (calcEngine.ts) — shares diluted
 * out to the public float rather than held by any specific player. Duplicated here for
 * the same reason as `SELF_OWNERSHIP_KEY` above. */
const EXTERNAL_MARKET_KEY = 'EXTERNAL_MARKET';

/** Current dollar value of `holderId`'s stake in `target` (its shareOwnership fraction *
 * totalSharesOutstanding * stockValue) — the upper bound for a Sell Shares amount. */
function shareholdingValue(target: PlayerTurnResult, holderId: string): number {
  const holderKey = target.playerId === holderId ? SELF_OWNERSHIP_KEY : holderId;
  const fraction = target.variables.shareOwnership?.[holderKey] ?? 0;
  return fraction * (target.variables.totalSharesOutstanding ?? 0) * (target.variables.stockValue ?? 0);
}

function DecisionCard({ def, isPending, blocked, disabledByLimit, competitors, myData, onToggle }: DecisionCardProps) {
  const [targetId, setTargetId] = useState('');
  const [expanded, setExpanded] = useState(false);
  const needsTarget = decisionNeedsTarget(def);
  // Buy Shares can self-buyback (reclaim previously-diluted-to-EXTERNAL_MARKET shares)
  // and Sell Shares can sell a holding in your own company — both get a
  // "Myself" option other target.*-bearing decisions (e.g. Bot Attack) never offer.
  const allowsSelfTarget = !!def.shareTransactionType;
  const needsAmount = def.variableAmount === true;
  const [amount, setAmount] = useState(0);

  const targetData = targetId === myData.playerId ? myData : competitors.find((c) => c.playerId === targetId);
  const amountBounds = !needsAmount ? null : def.shareTransactionType === 'sell'
    ? { min: 0, max: targetData ? Math.max(0, Math.round(shareholdingValue(targetData, myData.playerId))) : 0 }
    : { min: 0, max: Math.max(0, Math.round(myData.variables.cash)) };
  const clampedAmount = amountBounds ? Math.min(amount, amountBounds.max) : undefined;

  const deployDisabled = blocked.blocked
    || (!isPending && disabledByLimit)
    || (needsTarget && !isPending && !targetId)
    || (needsAmount && !isPending && (!amountBounds || amountBounds.max <= 0));
  const maturityYears = getMaturityYears(def);
  const effects = summarizeEffects(def);
  const hasLegalRisk = !!def.legalRisks && def.legalRisks.length > 0;
  const hasDetails = effects.length > 0 || hasLegalRisk;

  return (
    <div style={{ ...gpStyles.activeDecisionCard, opacity: blocked.blocked ? 0.6 : 1 }}>
      <Flex justify="space-between" align="flex-start" gap="sm">
        <Stack gap={0}>
          <Text size="xs" c="dimmed" style={boldStyle}>{def.level.toUpperCase()} · {def.nature.toUpperCase()}</Text>
          <Text style={{ ...boldStyle, fontSize: '0.9rem' }}>{def.decision}</Text>
        </Stack>
        <Flex gap={4} align="center">
          <Box h={12} w={12} style={{ borderRadius: '50%', background: semColors[natureTone[def.nature] ?? 'green']?.bg, border: '2px solid #333', flexShrink: 0 }} />
          {isPending && <Badge style={gpStyles.stamp('red')}>QUEUED</Badge>}
        </Flex>
      </Flex>
      <Text size="xs" c="dimmed" style={{ marginTop: 4, lineHeight: 1.4 }}>{def.description}</Text>

      {/* Collapsed by default — expand to see the effects timeline + legal risk */}
      {hasDetails && (
        <Flex align="center" gap={6} style={{ marginTop: 6, cursor: 'pointer' }} onClick={() => setExpanded((e) => !e)}>
          <Text size="xs" style={{ ...boldStyle, color: '#4b5563' }}>{expanded ? 'HIDE DETAILS' : 'SHOW DETAILS'}</Text>
          <IconChevronDown size={12} style={{ color: '#6b7280', transform: expanded ? 'rotate(180deg)' : undefined, transition: 'transform 0.2s ease' }} />
          {!expanded && (
            <Flex gap={4} align="center" style={{ marginLeft: 'auto' }}>
              <Badge style={gpStyles.stamp(maturityYears === 0 ? 'green' : 'yellow')}>{maturityYears === 0 ? 'INSTANT' : `${maturityYears}T`}</Badge>
              {hasLegalRisk && <Text size="xs" c="orange" title="Carries legal risk">⚖</Text>}
            </Flex>
          )}
        </Flex>
      )}

      {expanded && effects.length > 0 && (
        <div style={{ marginTop: 8, padding: 8, background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 6 }}>
          <Flex justify="space-between" align="center" style={{ marginBottom: 4 }}>
            <Text size="xs" style={{ ...boldStyle, color: '#4b5563' }}>EFFECTS</Text>
            <Badge style={gpStyles.stamp(maturityYears === 0 ? 'green' : 'yellow')}>
              {maturityYears === 0 ? 'INSTANT' : `MATURES IN ${maturityYears}T`}
            </Badge>
          </Flex>
          <Stack gap={2}>
            {effects.map((line) => (
              <Flex key={line.field} justify="space-between" gap="xs">
                <Text size="xs" c="dimmed">{line.field}</Text>
                <Text size="xs" style={boldStyle}>{line.timeline}</Text>
              </Flex>
            ))}
          </Stack>
        </div>
      )}

      {expanded && hasLegalRisk && (
        <Text size="xs" c="orange" style={{ marginTop: 4, fontStyle: 'italic' }}>
          ⚖ Legal risk: {def.legalRisks!.map((r) => r.name).join(', ')}
        </Text>
      )}
      {blocked.blocked && <Text size="xs" c="red" style={{ marginTop: 4 }}>{blocked.reason}</Text>}
      {needsTarget && !isPending && !blocked.blocked && (
        <select value={targetId} onChange={(e) => setTargetId(e.target.value)} style={{ width: '100%', marginTop: 8, padding: '6px 8px', border: '2px solid #333', borderRadius: 6, fontSize: '0.8rem' }}>
          <option value="">Select target…</option>
          {allowsSelfTarget && <option value={myData.playerId}>Myself</option>}
          {competitors.map((c) => (<option key={c.playerId} value={c.playerId}>{c.playerName}</option>))}
        </select>
      )}
      {needsAmount && !isPending && !blocked.blocked && amountBounds && (
        <Stack gap={2} style={{ marginTop: 8 }}>
          <Text size="xs" style={{ ...boldStyle, color: '#4b5563' }}>
            {def.shareTransactionType === 'sell' ? 'AMOUNT TO SELL' : 'INVESTMENT AMOUNT'}: {fmt(clampedAmount ?? 0)}
          </Text>
          <Slider
            min={amountBounds.min}
            max={Math.max(amountBounds.min + 1, amountBounds.max)}
            step={Math.max(1, Math.round(amountBounds.max / 100))}
            value={clampedAmount ?? 0}
            onChange={setAmount}
            disabled={amountBounds.max <= 0}
            color="#333"
          />
          <Text size="xs" c="dimmed">
            {amountBounds.max <= 0
              ? (def.shareTransactionType === 'sell' ? 'No holding to sell in that target.' : 'No cash available.')
              : `Range: ${fmt(amountBounds.min)} – ${fmt(amountBounds.max)}`}
          </Text>
        </Stack>
      )}
      <Button
        fullWidth
        size="xs"
        mt="sm"
        color={isPending ? 'gray' : 'dark'}
        variant={isPending ? 'outline' : 'filled'}
        disabled={deployDisabled}
        onClick={() => onToggle(needsTarget ? targetId : undefined, needsAmount ? clampedAmount : undefined)}
      >
        {isPending ? 'CANCEL' : 'DEPLOY'}
      </Button>
    </div>
  );
}

// ============================================================
// Sub-components — Case Card
// ============================================================

interface CaseCardProps {
  caseData: LegalCaseData;
  myPlayerId: string;
  playerNames: Map<string, string>;
  onRiskInfo: (caseItem: LegalCaseData) => void;
  /** For the "auto-resolves in N turns" countdown — undefined game:deck hasn't arrived yet. */
  negotiationPeriodTurns?: number;
  socket: Socket | null;
  /** This player's current cash — only used to gray out the defendant's own Dig Deeper button when they can't afford it. */
  cash: number;
  digDeeperCost: number;
  semaphoreGreenMax?: number;
  semaphoreYellowMax?: number;
}

function CaseCard({ caseData, myPlayerId, playerNames, onRiskInfo, negotiationPeriodTurns, socket, cash, digDeeperCost, semaphoreGreenMax, semaphoreYellowMax }: CaseCardProps) {
  const isDefendant = getCaseRole(caseData, myPlayerId) === 'defendant';
  const opponentName = getOpponentName(caseData, myPlayerId, playerNames);

  // Neither side gets the odds for free anymore. The plaintiff only sees them if they
  // fully "Dig Deeper"-investigated the underlying attack before suing over its exact
  // suggested ground (server-stamped onto the case at filing time, see CLAUDE.md). The
  // defendant only sees them after paying to "Dig Deeper" on this specific case
  // (`game:digDeeperCase`) — a one-shot reveal, unlike the plaintiff's pre-filing route.
  const knowsOdds = isDefendant ? caseData.defendantInvestigated : caseData.plaintiffFullyInvestigated;
  let displayProb = caseData.baseProbability;
  if (caseData.adjustedProbability !== undefined) {
    displayProb = caseData.adjustedProbability;
  }
  const sem = knowsOdds ? semaphoreLevel(displayProb, semaphoreGreenMax, semaphoreYellowMax) : null;
  const canAffordDig = cash >= digDeeperCost;

  const [digging, setDigging] = useState(false);
  const [digError, setDigError] = useState<string | null>(null);

  const handleDigDeeperOnCase = () => {
    if (!socket || digging) return;
    setDigging(true);
    setDigError(null);

    const cleanup = () => {
      socket.off(ServerEvents.GAME_LEGAL_CASE_UPDATE, onResult);
      socket.off(ServerEvents.ERROR, onError);
    };
    const onResult = (data: { case: LegalCaseData }) => {
      if (data.case.id !== caseData.id) return;
      cleanup();
      setDigging(false);
    };
    const onError = (data: { code: string; message: string }) => {
      if (data.code !== 'DIG_DEEPER_CASE_FAILED' && data.code !== 'INVALID_DIG_DEEPER_CASE_REQUEST') return;
      cleanup();
      setDigging(false);
      setDigError('Something went wrong — please try again.');
    };

    socket.on(ServerEvents.GAME_LEGAL_CASE_UPDATE, onResult);
    socket.on(ServerEvents.ERROR, onError);
    socket.emit(ClientEvents.GAME_DIG_DEEPER_CASE, { caseId: caseData.id });
  };

  return (
    <div style={gpStyles.caseCard}>
      {/* Header row */}
      <Flex justify="space-between" align="flex-start" gap="sm">
        <Stack gap={4}>
          <Badge style={gpStyles.stamp('black')}>{isDefendant ? 'DEFENDANT' : 'PLAINTIFF'}</Badge>
          <Text style={{ ...boldStyle, fontSize: '0.95rem' }}>{opponentName}</Text>
          <Text size="xs" c="dimmed">{caseData.decisionName} — {caseData.groundName}</Text>
        </Stack>
        {knowsOdds && sem && (
          <Box style={gpStyles.semaphoreChip(sem)} onClick={() => onRiskInfo(caseData)}>
            <Box h={8} w={8} style={{ background: semColors[sem].bg, borderRadius: '50%' }} />
            <Text style={{ fontWeight: 900 }}>{Math.round(displayProb * 100)}%</Text>
          </Box>
        )}
        {!knowsOdds && (
          <Box
            style={gpStyles.semaphoreChip('gray', false)}
            title={
              isDefendant
                ? 'Dig deeper on this case to reveal the probability of success.'
                : "You don't know the odds on a case you filed — dig deeper to the end on the underlying attack before suing to reveal them."
            }
          >
            <Box h={8} w={8} style={{ background: semColors.gray.bg, borderRadius: '50%' }} />
            <Text style={{ fontWeight: 900 }}>Unknown</Text>
          </Box>
        )}
      </Flex>

      {/* Description */}
      <Text size="xs" c="dimmed" style={{ fontStyle: 'italic', marginTop: 4, lineHeight: 1.4 }}>
        {caseData.description}
      </Text>

      {/* Stakes */}
      <Flex align="center" justify="space-between" mt="sm" p="sm" style={{ background: '#f3f4f6', border: '2px solid #333', borderRadius: 'var(--mantine-radius-sm)' }}>
        <Text style={{ ...boldStyle, fontSize: '0.7rem', color: '#4b5563' }}>STAKES</Text>
        <Text style={{ ...boldStyle, fontSize: '0.85rem' }}>{fmt(caseData.stakes)}</Text>
      </Flex>

      {/* Defendant-only: pay to reveal the probability of success on this case */}
      {isDefendant && !knowsOdds && (
        <Stack gap={4} mt="sm">
          <Button
            size="xs"
            variant="outline"
            color="gray"
            fullWidth
            loading={digging}
            disabled={!canAffordDig}
            onClick={handleDigDeeperOnCase}
          >
            🔍 Dig Deeper (${digDeeperCost.toLocaleString()}){!canAffordDig ? ' — not enough cash' : ''}
          </Button>
          {digError && (
            <Text size="xs" c="red" style={{ fontStyle: 'italic' }}>{digError}</Text>
          )}
        </Stack>
      )}

      {/* Status / Negotiation */}
      {caseData.status === 'awaiting_trial' ? (
        <Flex align="center" gap={6} mt="sm" p="sm" style={{ background: '#f3f4f6', border: '2px dashed #9ca3af', borderRadius: 'var(--mantine-radius-sm)' }}>
          <IconLock size={13} /> Awaiting verdict — resolves when the turn ends
        </Flex>
      ) : caseData.status === 'negotiating' && (
        <Stack gap="sm" mt="sm">
          {negotiationPeriodTurns !== undefined && (
            <Text size="xs" c="dimmed" style={{ fontStyle: 'italic' }}>
              {caseData.offers.length > 0
                ? '⚠️ A pending offer left unanswered when the turn ends is treated as accepted'
                : `⏳ Goes to trial automatically in ${Math.max(0, negotiationPeriodTurns - caseData.turnsNegotiating)} more turn(s) if nobody makes an offer`}
            </Text>
          )}
          <NegotiationPanel caseData={caseData} myPlayerId={myPlayerId} socket={socket} />
        </Stack>
      )}
    </div>
  );
}

/** Every value `CASE_ACTION_EVENT`/`CASE_ACTION_ERROR_CODE` are keyed by — the three
 * instant, out-of-band negotiation actions a case's `NegotiationPanel` can send. */
type CaseActionKind = 'offer' | 'accept' | 'court';

const CASE_ACTION_EVENT: Record<CaseActionKind, ClientEvents> = {
  offer: ClientEvents.GAME_MAKE_OFFER,
  accept: ClientEvents.GAME_ACCEPT_OFFER,
  court: ClientEvents.GAME_GO_TO_COURT,
};

const CASE_ACTION_ERROR_CODE: Record<CaseActionKind, string> = {
  offer: 'MAKE_OFFER_FAILED',
  accept: 'ACCEPT_OFFER_FAILED',
  court: 'GO_TO_COURT_FAILED',
};

/** Friendly copy for a failed `game:makeOffer`/`game:acceptOffer`/`game:goToCourt` — keyed by `LegalCaseActionOutcome`'s `reason`. */
const CASE_ACTION_ERROR_COPY: Record<string, string> = {
  case_not_found: 'This case could not be found.',
  not_negotiating: 'This case is no longer being negotiated.',
  not_a_party: "You're not a party to this case.",
  not_your_turn: "It's not your turn to act on this case yet.",
  no_offer_to_accept: "There's no offer to accept yet.",
  invalid_amount: "That's outside the current negotiating range — someone may have just made a new offer, refreshing it.",
};

/**
 * The valid `[min, max]` range for the next offer on this case — hand-kept in sync with
 * the server's own `GameLoop.computeOfferBracket` (same "duplicate small pure logic
 * client-side" convention `GamePhase.utils.test.ts` already uses, rather than importing
 * server internals into the client). `min` is the defendant's own most recent offer (0
 * if they haven't offered yet); `max` is the plaintiff's own most recent offer (the full
 * stakes if they haven't offered yet) — the bracket only ever narrows inward as each side
 * offers, never widens. The server is the actual authority here; this only drives the
 * slider's bounds so the UI doesn't let a player drag to a value the server would reject.
 */
function computeOfferBracket(caseData: LegalCaseData): { min: number; max: number } {
  let min = 0;
  let max = caseData.stakes;
  for (const offer of caseData.offers) {
    if (offer.by === 'defendant') min = offer.amount;
    else max = offer.amount;
  }
  return { min, max };
}

interface NegotiationPanelProps {
  caseData: LegalCaseData;
  myPlayerId: string;
  socket: Socket | null;
}

/** The interactive half of an open, still-`'negotiating'` case — offer history, a
 * counter-offer slider, and Offer/Counter/Accept/Court buttons, all wired to the instant,
 * out-of-band `game:makeOffer`/`game:acceptOffer`/`game:goToCourt` actions (same "fire
 * over the socket, don't wait for the turn timer" pattern as Dig Deeper and the lawsuit
 * filing fee). Every action's success arrives via the global `game:legalCaseUpdate`
 * listener (`socketStore.ts`), which patches `turnResults` — this component only listens
 * locally to know when ITS OWN in-flight request has landed, filtered by matching
 * `case.id`, purely to clear its own loading state; the actual UI update comes for free
 * from the re-render off the patched `caseData` prop. */
function NegotiationPanel({ caseData, myPlayerId, socket }: NegotiationPanelProps) {
  const role: 'plaintiff' | 'defendant' = caseData.plaintiffId === myPlayerId ? 'plaintiff' : 'defendant';
  const lastOffer = caseData.offers.length > 0 ? caseData.offers[caseData.offers.length - 1] : null;
  // The defendant always moves first; after that, whichever role did NOT make the most
  // recent offer is the one currently allowed to counter or accept. Going to court is
  // never turn-gated — either party can end negotiation at any time.
  const isMyTurnToRespond = lastOffer === null ? role === 'defendant' : lastOffer.by !== role;
  const { min: offerMin, max: offerMax } = computeOfferBracket(caseData);

  const [amount, setAmount] = useState(() => Math.round((offerMin + offerMax) / 2));
  const [submitting, setSubmitting] = useState<CaseActionKind | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // Re-seed the slider whenever a new offer actually lands (not on every render) — the
  // bracket narrows with each move, so the middle of the CURRENT range is a better
  // starting suggestion for a new counter than the previous offer's exact value (which
  // is now often sitting right at one edge of the new range, not a useful midpoint).
  useEffect(() => {
    setAmount(Math.round((offerMin + offerMax) / 2));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [caseData.offers.length]);

  const sendAction = (kind: CaseActionKind, payload: Record<string, unknown>) => {
    if (!socket || submitting) return;
    setSubmitting(kind);
    setActionError(null);

    const cleanup = () => {
      socket.off(ServerEvents.GAME_LEGAL_CASE_UPDATE, onResult);
      socket.off(ServerEvents.ERROR, onError);
    };
    const onResult = (data: { case: LegalCaseData }) => {
      if (data.case.id !== caseData.id) return;
      cleanup();
      setSubmitting(null);
    };
    const onError = (data: { code: string; message: string }) => {
      if (data.code !== CASE_ACTION_ERROR_CODE[kind]) return;
      cleanup();
      setSubmitting(null);
      setActionError(CASE_ACTION_ERROR_COPY[data.message] ?? 'Something went wrong — please try again.');
    };

    socket.on(ServerEvents.GAME_LEGAL_CASE_UPDATE, onResult);
    socket.on(ServerEvents.ERROR, onError);
    socket.emit(CASE_ACTION_EVENT[kind], { caseId: caseData.id, ...payload });
  };

  return (
    <Stack gap="sm">
      {caseData.offers.length > 0 && (
        <Flex wrap="wrap" gap={4}>
          {caseData.offers.map((o, i) => (
            <Badge key={i} variant="light">{o.by === role ? 'You' : 'Them'}: {fmt(o.amount)}</Badge>
          ))}
        </Flex>
      )}

      {isMyTurnToRespond ? (
        <>
          <div style={gpStyles.sliderContainer}>
            <Text style={{ ...boldStyle, fontSize: '0.7rem', color: '#6b7280', marginBottom: 8 }}>
              {lastOffer ? 'YOUR COUNTER' : 'YOUR OPENING OFFER'}
            </Text>
            <Flex align="center" gap="sm">
              <Slider flex={1} min={offerMin} max={offerMax} step={500} value={amount} onChange={setAmount} color="#dc2626" disabled={submitting !== null} />
              <Text style={{ ...boldStyle, fontSize: '0.8rem', minWidth: 70, textAlign: 'right' }}>{fmt(amount)}</Text>
            </Flex>
            <Text size="xs" c="dimmed" style={{ fontStyle: 'italic', marginTop: 4 }}>
              Range: {fmt(offerMin)} – {fmt(offerMax)}
            </Text>
          </div>
          <Flex gap="sm">
            {lastOffer && (
              <Button flex={1} size="xs" color="green" leftSection={<IconCheck size={13} />} loading={submitting === 'accept'} disabled={submitting !== null && submitting !== 'accept'} onClick={() => sendAction('accept', {})}>
                ACCEPT {fmt(lastOffer.amount)}
              </Button>
            )}
            <Button flex={1} size="xs" color="orange" variant="outline" loading={submitting === 'offer'} disabled={submitting !== null && submitting !== 'offer'} onClick={() => sendAction('offer', { amount })}>
              {lastOffer ? 'COUNTER' : 'MAKE OFFER'}
            </Button>
            <Button flex={1} size="xs" color="red" leftSection={<IconSwords size={13} />} variant="filled" loading={submitting === 'court'} disabled={submitting !== null && submitting !== 'court'} onClick={() => sendAction('court', {})}>
              COURT
            </Button>
          </Flex>
        </>
      ) : (
        <Flex align="center" justify="space-between" gap="sm">
          <Text size="xs" c="dimmed" style={{ fontStyle: 'italic' }}>
            Waiting for the other side to respond{lastOffer ? ` to your ${fmt(lastOffer.amount)} offer` : ''}…
          </Text>
          <Button size="xs" color="red" leftSection={<IconSwords size={13} />} variant="outline" loading={submitting === 'court'} disabled={submitting !== null} onClick={() => sendAction('court', {})}>
            COURT
          </Button>
        </Flex>
      )}

      {actionError && (
        <Text size="xs" c="red" style={{ fontStyle: 'italic' }}>{actionError}</Text>
      )}
    </Stack>
  );
}

interface QueuedLawsuitCardProps {
  entry: SubmittedDecisions['lawsuits'][number];
  targetName: string;
  onRemove: () => void;
}

/** A lawsuit the player has filed (fee already charged instantly, per `game:fileLawsuit`)
 * but whose case hasn't actually been created yet — that only happens once this turn
 * resolves (`LegalEngine.fileLawsuit`, Step 8). Shown alongside `CaseCard` in the "Open
 * Lawsuits" list so a queued filing doesn't only appear inside the Sue modal's own list.
 * Lighter than `CaseCard`: a queued `SubmittedLawsuitEntry` has no `id`/`stakes`/`status`/
 * `offers` yet — there's no real `LegalCaseData` to show until the case actually exists. */
function QueuedLawsuitCard({ entry, targetName, onRemove }: QueuedLawsuitCardProps) {
  return (
    <div style={gpStyles.caseCard}>
      <Flex justify="space-between" align="flex-start" gap="sm">
        <Stack gap={4}>
          <Badge style={gpStyles.stamp('red')}>QUEUED</Badge>
          <Text style={{ ...boldStyle, fontSize: '0.95rem' }}>{targetName}</Text>
          <Text size="xs" c="dimmed">{entry.decisionName} — {entry.groundName}</Text>
        </Stack>
      </Flex>
      <Text
        size="xs"
        c="red"
        style={{ cursor: 'pointer', textDecoration: 'underline', marginTop: 8 }}
        title="The filing fee already charged is not refunded"
        onClick={onRemove}
      >
        Remove
      </Text>
    </div>
  );
}

// ============================================================
// Sub-components — Incoming Attack Hints
// ============================================================

/**
 * Whether the player has already sued the attacker over this exact attacking decision
 * instance — once true, the hint should stop nagging the player about an attack they've
 * already acted on.
 *
 * A real case (from `myLegalCases`) is matched by `defendantDecisionInstanceId ===
 * attack.attackId` — the specific instance id, not "same decision name" — rather than
 * requiring the ground to be the one `suggestedGroundName` recommends (an earlier version
 * of this check did, and was a real, reported bug: suing over a manually-picked ground via
 * SueModal's own picker, or over the correct ground before investigating deep enough for
 * `suggestedGroundName` to even exist, left the hint stuck up forever even though a real
 * case against exactly this attack already existed). This is a stronger and more direct
 * signal than re-deriving "is this ground real" client-side: `LegalEngine.fileLawsuit`
 * (server/src/engine/legalEngine.ts) only ever stamps `defendantDecisionInstanceId` for a
 * genuine, still-actionable match — a wrong guess or a time-barred ground always leaves it
 * `undefined` — so matching on it is exactly "a real case exists against this attack,"
 * with zero client-side probability computation needed (no re-implementing the
 * admin-editable, DB-backed formula evaluation this app otherwise deliberately keeps
 * server-only — see CLAUDE.md's "Formulas are DB-backed" section). No investigationLevel
 * gate either: filing doesn't require having investigated the attacker at all (SUE THEIR
 * ASSES offers the whole decision library's grounds against any target, investigated or
 * not — see CLAUDE.md), so this shouldn't require it either.
 *
 * `pendingLawsuits` (queued this turn, not yet resolved into a real case) has no instance
 * id to match against — a queued entry is only `{ targetId, decisionName, groundName }` —
 * so it's matched more loosely, by attacker + decision name alone, on the assumption that
 * a lawsuit queued against this exact attacker over this exact decision is meant to
 * address this attack regardless of which ground was picked; `pending.lawsuits` for it is
 * cleared the moment the real case exists anyway, so this only ever covers the gap within
 * the same turn a lawsuit is filed.
 */
function isAttackAlreadySuedOver(
  attack: IncomingAttackInfo,
  pendingLawsuits: SubmittedDecisions['lawsuits'],
  myLegalCases: LegalCaseData[],
): boolean {
  if (!attack.attackerId || !attack.decisionName) return false;
  return (
    pendingLawsuits.some((l) => l.targetId === attack.attackerId && l.decisionName === attack.decisionName) ||
    myLegalCases.some((c) => c.defendantId === attack.attackerId && c.decisionName === attack.decisionName && c.defendantDecisionInstanceId === attack.attackId)
  );
}

interface IncomingAttackHintsProps {
  attacks: IncomingAttackInfo[];
  cash: number;
  digDeeperCost: number;
  socket: Socket | null;
  onSueNow: (targetId: string, decisionName: string, groundName: string) => void;
  pendingLawsuits: SubmittedDecisions['lawsuits'];
  myLegalCases: LegalCaseData[];
}

function IncomingAttackHints({ attacks, cash, digDeeperCost, socket, onSueNow, pendingLawsuits, myLegalCases }: IncomingAttackHintsProps) {
  const visibleAttacks = attacks.filter((a) => !isAttackAlreadySuedOver(a, pendingLawsuits, myLegalCases));
  if (visibleAttacks.length === 0) return null;
  return (
    <Stack gap={6}>
      {visibleAttacks.map((attack) => (
        <AttackHintCard key={attack.attackId} attack={attack} cash={cash} digDeeperCost={digDeeperCost} socket={socket} onSueNow={onSueNow} />
      ))}
    </Stack>
  );
}

function AttackHintCard({ attack, cash, digDeeperCost, socket, onSueNow }: {
  attack: IncomingAttackInfo;
  cash: number;
  digDeeperCost: number;
  socket: Socket | null;
  onSueNow: (targetId: string, decisionName: string, groundName: string) => void;
}) {
  const fullyInvestigated = attack.investigationLevel >= 3;
  const canAfford = cash >= digDeeperCost;
  // Direct (target.*) attacks keep the original alarmed orange/⚠️ treatment — they're
  // aimed specifically at you. Indirect ones (no target.* impacts at all, just a
  // legalRisks-bearing decision some other player deployed — New Factory, Water Pumping,
  // etc.) are background market activity, not a personal attack, so they get a calmer
  // blue/ℹ️ treatment and different copy to match, but the same investigation/Dig
  // Deeper/SUE NOW mechanics below are otherwise unchanged.
  const headline = attack.isIndirect
    ? (attack.attackerName ? `ℹ️ ${attack.attackerName} did something that indirectly affects you.` : 'ℹ️ Somebody did something that indirectly affects you.')
    : (attack.attackerName ? `⚠️ ${attack.attackerName} did something to you.` : '⚠️ Somebody did something to you.');
  const borderColor = attack.isIndirect ? '#2563eb' : '#ea580c';
  const background = attack.isIndirect ? '#eff6ff' : '#fff7ed';
  const suggestedBoxBorder = attack.isIndirect ? '#bfdbfe' : '#fed7aa';
  const digButtonColor = attack.isIndirect ? 'blue' : 'orange';

  return (
    <div style={{ padding: 10, border: `3px solid ${borderColor}`, borderRadius: 8, background }}>
      <Text style={{ ...boldStyle, fontSize: '0.8rem' }}>{headline}</Text>

      {/* Set server-side only at investigationLevel === 1 (attacker known, decision not
          yet revealed) — the same AI-narrated "annual report" flavor text the Full Filing
          report shows for a rival's decisions, deliberately vague enough not to leak
          anything the real decisionName/decisionDescription below don't already reveal
          more precisely once investigation goes one tier further. */}
      {!attack.decisionName && attack.annualReportBlurb && (
        <Text size="xs" c="dimmed" style={{ fontStyle: 'italic', lineHeight: 1.4, marginTop: 4 }}>
          "{attack.annualReportBlurb}" — from {attack.attackerName}'s annual report
        </Text>
      )}

      {attack.decisionName && (
        <Text size="xs" style={{ marginTop: 4 }}>
          <strong>{attack.decisionName}</strong>{attack.effectSummary ? ` — ${attack.effectSummary}` : ''}
        </Text>
      )}
      {attack.decisionDescription && (
        <Text size="xs" c="dimmed" style={{ fontStyle: 'italic', lineHeight: 1.4 }}>{attack.decisionDescription}</Text>
      )}

      {attack.suggestedGroundName && (
        <Box style={{ marginTop: 8, padding: 8, background: '#fff', border: `1px solid ${suggestedBoxBorder}`, borderRadius: 6 }}>
          <Text style={{ ...boldStyle, fontSize: '0.75rem' }}>Suggested: {attack.suggestedGroundName}</Text>
          <Text size="xs" c="dimmed" style={{ lineHeight: 1.4 }}>{attack.suggestedGroundDescription}</Text>
          <Text size="xs" style={{ marginTop: 4 }}>Estimated success: <strong>{Math.round((attack.successProbability ?? 0) * 100)}%</strong></Text>
          <Button
            size="xs"
            color="red"
            fullWidth
            mt={6}
            leftSection={<IconGavel size={12} />}
            onClick={() => onSueNow(attack.attackerId!, attack.decisionName!, attack.suggestedGroundName!)}
          >
            SUE NOW
          </Button>
        </Box>
      )}

      {!fullyInvestigated && (
        <Button
          size="xs"
          variant="outline"
          color={digButtonColor}
          fullWidth
          mt={8}
          disabled={!canAfford}
          onClick={() => socket?.emit(ClientEvents.GAME_DIG_DEEPER, { attackId: attack.attackId })}
        >
          🔍 Dig Deeper (${digDeeperCost.toLocaleString()}){!canAfford ? ' — not enough cash' : ''}
        </Button>
      )}
    </div>
  );
}

// ============================================================
// Sub-components — Rival List
// ============================================================

interface RivalListProps {
  rivals: PlayerTurnResult[];
  prevRivals: Map<string, PlayerTurnResult>;
  onFullReport: (rival: PlayerTurnResult) => void;
  onFieldClick: (rival: PlayerTurnResult, target: { field: string; label: string }) => void;
}

function RivalList({ rivals, prevRivals, onFullReport, onFieldClick }: RivalListProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  return (
    <Stack gap="xs">
      {rivals.map((rival) => (
        <RivalDossier key={rival.playerId} rival={rival} prevRival={prevRivals.get(rival.playerId)} expanded={expandedId === rival.playerId} onToggle={() => setExpandedId(expandedId === rival.playerId ? null : rival.playerId)} onFullReport={onFullReport} onFieldClick={onFieldClick} />
      ))}
    </Stack>
  );
}

interface RivalDossierProps {
  rival: PlayerTurnResult;
  /** Same rival's data from the previous turn — undefined on round 1. */
  prevRival?: PlayerTurnResult;
  expanded: boolean;
  onToggle: () => void;
  onFullReport: (rival: PlayerTurnResult) => void;
  onFieldClick: (rival: PlayerTurnResult, target: { field: string; label: string }) => void;
}

function RivalDossier({ rival, prevRival, expanded, onToggle, onFullReport, onFieldClick }: RivalDossierProps) {
  const { variables: v, derived: d } = rival;

  return (
    <div style={gpStyles.rivalSection}>
      <Flex justify="space-between" align="center" onClick={onToggle} style={{ cursor: 'pointer' }}>
        <Text style={{ ...boldStyle, fontSize: '0.8rem' }}>{rival.playerName}</Text>
        <IconChevronDown size={14} style={{ color: '#6b7280', transform: expanded ? 'rotate(180deg)' : undefined, transition: 'transform 0.2s ease' }} />
      </Flex>
      {expanded && (
        <Stack gap="sm" mt="xs">
          <Flex wrap="wrap" gap="xs">
            <MiniStatButton label="CASH" value={fmt(v.cash)} trend={computeTrend(v.cash, prevRival?.variables.cash)} onClick={() => onFieldClick(rival, { field: 'variables.cash', label: 'CASH' })} />
            <MiniStatButton label="REVENUE" value={fmt(d.revenue)} trend={computeTrend(d.revenue, prevRival?.derived.revenue)} onClick={() => onFieldClick(rival, { field: 'derived.revenue', label: 'REVENUE' })} />
            <MiniStatButton label="EQUITY" value={fmt(d.equity)} trend={computeTrend(d.equity, prevRival?.derived.equity)} onClick={() => onFieldClick(rival, { field: 'derived.equity', label: 'EQUITY' })} />
            <MiniStatButton label="STOCK VALUE" value={fmt(d.stockValue)} trend={computeTrend(d.stockValue, prevRival?.derived.stockValue)} onClick={() => onFieldClick(rival, { field: 'derived.stockValue', label: 'STOCK VALUE' })} />
            <MiniStatButton label="DEBT" value={fmt(v.debt)} trend={computeTrend(v.debt, prevRival?.variables.debt)} invert onClick={() => onFieldClick(rival, { field: 'variables.debt', label: 'DEBT' })} />
          </Flex>
          <Button fullWidth size="xs" variant="outline" leftSection={<IconFileText size={12} />} onClick={() => onFullReport(rival)}>
            FULL FILING
          </Button>
        </Stack>
      )}
    </div>
  );
}

interface MiniStatButtonProps {
  label: string;
  value: string;
  /** Since-last-turn trend — undefined on round 1. */
  trend?: Trend;
  /** For fields where "up" is bad news (e.g. debt) — flips arrow color, not direction. */
  invert?: boolean;
  onClick?: () => void;
}

function MiniStatButton({ label, value, trend, invert, onClick }: MiniStatButtonProps) {
  return (
    <Box style={gpStyles.rivalMiniStat} onClick={onClick}>
      <Text style={{ fontSize: '0.65rem', color: '#6b7280' }}>{label}</Text>
      <Flex align="center" gap={4}>
        <Text style={{ ...boldStyle, fontSize: '0.75rem' }}>{value}</Text>
        <TrendIcon trend={trend} invert={invert} size={12} />
      </Flex>
    </Box>
  );
}

// ============================================================
// KPI History + Prediction Graph
// ============================================================
//
// Every clickable stat (the 4 top KPI cards, Threat Level, and every individual
// tracked-field row inside their breakdown views below) opens the same generic graph,
// keyed by a dot-path into a KpiSnapshotPoint ('variables.cash', 'derived.equity',
// 'riskGauge', etc.) rather than one bespoke component per field — see CLAUDE.md's "KPI
// history + prediction graphs" section for why. Purely computed intermediate rows in the
// waterfall breakdowns (COGS, gross profit, EBITDA, EBIT, profit before tax, net profit,
// market equity, net demand) are deliberately NOT clickable — there's no single tracked
// field for them in KpiSnapshot/the prediction output to graph.

/** Reads a dot-path field ('variables.cash', 'derived.equity', or the bare 'riskGauge') out of one KpiSnapshotPoint — or any other object with the same variables/derived/riskGauge shape, e.g. a `PlayerTurnResult`, which is how breakdown-row trend arrows read a previous turn's value without a second lookup helper. */
function getKpiFieldValue(point: { variables: PlayerVariables; derived: PlayerDerivedStats; riskGauge: number }, field: string): number {
  if (field === 'riskGauge') return point.riskGauge;
  const [bucket, key] = field.split('.') as ['variables' | 'derived', string];
  return (point[bucket] as any)?.[key] ?? 0;
}

/** A breakdown-view row for a field that has history/prediction data behind it — click opens the KPI graph modal for that field. */
function ClickableStatRow({ label, value, colorType, trend, invert, onClick, title = 'Click for history + prediction' }: { label: string; value: React.ReactNode; colorType?: 'plus' | 'minus'; trend?: Trend; invert?: boolean; onClick: () => void; title?: string }) {
  return (
    <Flex justify="space-between" align="center" style={{ ...gpStyles.statRow(colorType), cursor: 'pointer' }} onClick={onClick} title={title}>
      <Text size="sm" style={{ textDecoration: 'underline', textDecorationStyle: 'dotted', textUnderlineOffset: 3 }}>{label}</Text>
      <Flex align="center" gap={4}>
        <Text style={{ ...boldStyle, fontSize: '0.85rem' }}>{value}</Text>
        <TrendIcon trend={trend} invert={invert} size={13} />
      </Flex>
    </Flex>
  );
}

interface KpiHistoryGraphProps {
  field: string;
  label: string;
  socket: Socket | null;
  /** Whose history to fetch — the viewer's own player id gets history + a 3-turn
   * prediction; any other (rival) id in the room gets history only, no prediction. */
  targetPlayerId: string;
}

/** Fetches fresh on every open (via game:getKpiHistory) rather than caching — the server
 * recomputes the 3-turn prediction from the current live state each time anyway, so a
 * cached response would go stale the moment another turn resolves. Two of these can be
 * mounted at once (a top-level graph plus a stacked sub-field one), possibly for two
 * different players — `payload.playerId` is checked against `targetPlayerId` before
 * applying a response, so a stale reply for a since-closed graph can never flash the
 * wrong player's data into this one. */
function KpiHistoryGraph({ field, socket, targetPlayerId }: KpiHistoryGraphProps) {
  const [data, setData] = useState<KpiHistoryResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!socket) return;
    setData(null);
    setLoading(true);
    const handler = (payload: KpiHistoryResponse) => {
      if (payload.playerId !== targetPlayerId) return;
      setData(payload);
      setLoading(false);
    };
    socket.on(ServerEvents.GAME_KPI_HISTORY_RESULT, handler);
    socket.emit(ClientEvents.GAME_GET_KPI_HISTORY, { targetPlayerId });
    return () => {
      socket.off(ServerEvents.GAME_KPI_HISTORY_RESULT, handler);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [socket, field, targetPlayerId]);

  if (loading || !data) {
    return (
      <Flex justify="center" align="center" p="lg">
        <Loader size="sm" />
      </Flex>
    );
  }

  const { history, predicted, bankruptAtRound } = data;
  if (history.length === 0 && predicted.length === 0) {
    return <Text size="xs" c="dimmed" ta="center">Not enough turns yet to show a history graph.</Text>;
  }

  const lastHistory = history[history.length - 1];
  const rows = [
    ...history.map((p, i) => ({
      round: p.round,
      actual: getKpiFieldValue(p, field),
      // The last history point is duplicated onto the 'predicted' series too, so the
      // dashed continuation visually connects to the solid line instead of leaving a gap.
      predicted: i === history.length - 1 ? getKpiFieldValue(p, field) : undefined,
    })),
    ...predicted.map((p) => ({ round: p.round, predicted: getKpiFieldValue(p, field) })),
  ];

  return (
    <Stack gap="xs">
      <LineChart
        h={220}
        data={rows}
        dataKey="round"
        series={[
          { name: 'actual', color: 'blue.6', label: 'Actual' },
          { name: 'predicted', color: 'red.6', strokeDasharray: '6 4', label: 'Predicted' },
        ]}
        withLegend
        withDots
        curveType="linear"
        valueFormatter={(v) => fmt(v)}
      />
      {predicted.length > 0 && !bankruptAtRound && (
        <Text size="xs" c="dimmed" style={{ fontStyle: 'italic' }}>
          Dashed line: next {predicted.length} turn{predicted.length === 1 ? '' : 's'} projected assuming only your own
          active decisions keep playing out — it does not account for other players' decisions.
        </Text>
      )}
      {bankruptAtRound && (
        <Text size="xs" c="red" style={{ fontStyle: 'italic' }}>
          Projection stops at round {bankruptAtRound} — if only your own decisions play out from here, you'd go
          bankrupt by then (this doesn't account for other players' decisions, which could change that).
        </Text>
      )}
      {lastHistory && history.length < 2 && (
        <Text size="xs" c="dimmed" style={{ fontStyle: 'italic' }}>
          Only one turn of history so far — the graph fills in as more turns resolve.
        </Text>
      )}
    </Stack>
  );
}

// ============================================================
// Drill-down Modal Views
// ============================================================

// ── Cash Waterfall View ────────────────────────────────

interface CashWaterfallViewProps {
  data: PlayerTurnResult;
  /** Previous turn's snapshot, for the trend arrow on every row — undefined on round 1. */
  prevData?: PlayerTurnResult;
  onFieldClick: (target: { field: string; label: string }) => void;
}

/** The waterfall's computed-only intermediates (COGS, gross profit, EBITDA, EBIT, profit
 * before tax, net profit) have no single tracked field in KpiSnapshot, so their trend
 * arrows are derived by recomputing the same P&L/balance-sheet math against the previous
 * turn's snapshot rather than reading a persisted field — shared by CashWaterfallView's
 * current- and previous-turn calls. */
function computeCashWaterfall(data: PlayerTurnResult) {
  const { variables: v, derived: d } = data;
  const cogs = (v.materialCostPerTon + v.logisticsCostPerTon) * (d.volume || 0);
  const grossProfit = d.revenue - cogs;
  const ebitda = grossProfit - v.operatingExpenses - v.staffCost + v.otherIncome;
  const ebit = ebitda - d.depreciation;
  const financeCost = d.financeCost || 0;
  const profitBeforeTax = ebit - financeCost;
  const taxCost = d.taxCost || 0;
  const netProfit = profitBeforeTax - taxCost;
  return { cogs, grossProfit, ebitda, ebit, financeCost, profitBeforeTax, taxCost, netProfit };
}

function CashWaterfallView({ data, prevData, onFieldClick }: CashWaterfallViewProps) {
  const { variables: v, derived: d } = data;
  const cur = computeCashWaterfall(data);
  const prev = prevData ? computeCashWaterfall(prevData) : undefined;
  // Starting cash = current cash - netProfit - depreciation (reverse of the newCash formula)
  const startingCash = v.cash - cur.netProfit - d.depreciation;

  // `field` is the KpiSnapshotPoint dot-path a row's history/prediction graph should
  // read — omitted for rows that are only computed here (COGS, gross profit, EBITDA,
  // EBIT, profit before tax, net profit), since there's no single tracked field for
  // those in KpiSnapshot/the prediction output; their trend is computed against `prev`
  // instead. `invert` marks cost rows, where the trend arrow reads "up = bad".
  const rows: { label: string; value: number; type: 'plus' | 'minus' | undefined; field?: string; trend?: Trend; invert?: boolean }[] = [
    { label: 'Revenue', value: d.revenue, type: 'plus', field: 'derived.revenue', trend: computeTrend(d.revenue, prevData?.derived.revenue) },
    { label: 'COGS (material + logistics × volume)', value: -cur.cogs, type: 'minus', trend: computeTrend(cur.cogs, prev?.cogs), invert: true },
    { label: 'Gross profit', value: cur.grossProfit, type: undefined, trend: computeTrend(cur.grossProfit, prev?.grossProfit) },
    { label: 'Operating expenses', value: -v.operatingExpenses, type: 'minus', field: 'variables.operatingExpenses', trend: computeTrend(v.operatingExpenses, prevData?.variables.operatingExpenses), invert: true },
    { label: 'Staff costs', value: -v.staffCost, type: 'minus', field: 'variables.staffCost', trend: computeTrend(v.staffCost, prevData?.variables.staffCost), invert: true },
    { label: 'Other income', value: v.otherIncome, type: 'plus', field: 'variables.otherIncome', trend: computeTrend(v.otherIncome, prevData?.variables.otherIncome) },
    { label: 'EBITDA', value: cur.ebitda, type: undefined, trend: computeTrend(cur.ebitda, prev?.ebitda) },
    { label: 'Depreciation', value: -d.depreciation, type: 'minus', field: 'derived.depreciation', trend: computeTrend(d.depreciation, prevData?.derived.depreciation), invert: true },
    { label: 'EBIT', value: cur.ebit, type: undefined, trend: computeTrend(cur.ebit, prev?.ebit) },
    { label: 'Finance cost', value: -cur.financeCost, type: 'minus', field: 'derived.financeCost', trend: computeTrend(cur.financeCost, prev?.financeCost), invert: true },
    { label: 'Profit before tax', value: cur.profitBeforeTax, type: undefined, trend: computeTrend(cur.profitBeforeTax, prev?.profitBeforeTax) },
    { label: 'Tax', value: -cur.taxCost, type: 'minus', field: 'derived.taxCost', trend: computeTrend(cur.taxCost, prev?.taxCost), invert: true },
    { label: 'Net profit', value: cur.netProfit, type: 'plus', trend: computeTrend(cur.netProfit, prev?.netProfit) },
    { label: 'Depreciation (non-cash add-back)', value: d.depreciation, type: 'plus', trend: computeTrend(d.depreciation, prevData?.derived.depreciation) },
  ];

  let running = startingCash;
  return (
    <Stack gap={0} style={gpStyles.modalContent}>
      <Text style={{ ...boldStyle, fontSize: '0.8rem', marginBottom: 12 }}>CASH WATERFALL</Text>
      {rows.map((row, i) => {
        running += row.value;
        const valueText = fmt(row.value);
        return row.field ? (
          <ClickableStatRow key={i} label={row.label} value={valueText} colorType={row.type} trend={row.trend} invert={row.invert} onClick={() => onFieldClick({ field: row.field!, label: row.label })} />
        ) : (
          <Flex justify="space-between" align="center" key={i} style={gpStyles.statRow(row.type)}>
            <Text size="sm">{row.label}</Text>
            <Flex align="center" gap={4}>
              <Text style={{ ...boldStyle, fontSize: '0.85rem' }}>{valueText}</Text>
              <TrendIcon trend={row.trend} invert={row.invert} size={13} />
            </Flex>
          </Flex>
        );
      })}
      <Divider my="xs" />
      <Flex justify="space-between" align="center" style={gpStyles.totalRow}>
        <Text style={{ fontSize: '0.85rem' }}>Cash now</Text>
        <Flex align="center" gap={4}>
          <Text style={{ fontSize: '0.95rem' }}>{fmt(v.cash)}</Text>
          <TrendIcon trend={computeTrend(v.cash, prevData?.variables.cash)} size={13} />
        </Flex>
      </Flex>
      <Text size="xs" c="dimmed" style={{ fontStyle: 'italic', marginTop: 8 }}>
        Depreciation is a non-cash expense — added back to net profit to get actual cash position.
      </Text>
    </Stack>
  );
}

// ── Revenue View ───────────────────────────────────────

interface RevenueViewProps {
  data: PlayerTurnResult;
  /** Previous turn's snapshot, for the trend arrow on every row — undefined on round 1. */
  prevData?: PlayerTurnResult;
  onFieldClick: (target: { field: string; label: string }) => void;
}

function RevenueView({ data, prevData, onFieldClick }: RevenueViewProps) {
  const { variables: v, derived: d } = data;

  const volume = d.volume || 0;
  const price = v.price;
  const revenue = d.revenue;

  return (
    <Stack gap="md" style={gpStyles.modalContent}>
      <Text style={{ ...boldStyle, fontSize: '0.8rem', marginBottom: 12 }}>REVENUE BREAKDOWN</Text>
      <ClickableStatRow label="Volume" value={`${volume.toFixed(0)} t`} trend={computeTrend(volume, prevData?.derived.volume)} onClick={() => onFieldClick({ field: 'derived.volume', label: 'Volume' })} />
      <ClickableStatRow label="× Price" value={`${fmt(price)} /t`} trend={computeTrend(price, prevData?.variables.price)} onClick={() => onFieldClick({ field: 'variables.price', label: 'Price' })} />
      <Divider my="xs" />
      <Flex justify="space-between" style={gpStyles.totalRow}>
        <Text style={{ fontSize: '0.85rem' }}>Revenue</Text>
        <Flex align="center" gap={4}>
          <Text style={{ fontSize: '0.95rem' }}>{fmt(revenue)}</Text>
          <TrendIcon trend={computeTrend(revenue, prevData?.derived.revenue)} size={13} />
        </Flex>
      </Flex>
      <Text size="xs" c="dimmed" style={{ fontStyle: 'italic' }}>
        Volume is set by your market share, capped by installed capacity — see SHARES for the breakdown.
      </Text>
    </Stack>
  );
}

// ── Equity View ────────────────────────────────────────

interface EquityViewProps {
  data: PlayerTurnResult;
  /** Previous turn's snapshot, for the trend arrow on every row — undefined on round 1. */
  prevData?: PlayerTurnResult;
  onFieldClick: (target: { field: string; label: string }) => void;
}

/** equity = cash + receivables + assets + intangibleAssets + reserves - debt; marketEquity = max(0, equity - legalExposure). Shared by EquityView's current- and previous-turn calls, so the two totals' trend arrows are diffed against the same formula rather than a persisted field. */
function computeEquity(data: PlayerTurnResult) {
  const { variables: v, derived: d } = data;
  const bookEquity = v.cash + d.receivables + v.assets + v.intangibleAssets + v.reserves - v.debt;
  const legalExposure = v.legalExposure ?? 0;
  const marketEquity = Math.max(0, bookEquity - legalExposure);
  return { bookEquity, legalExposure, marketEquity };
}

function EquityView({ data, prevData, onFieldClick }: EquityViewProps) {
  const { variables: v, derived: d } = data;
  const cur = computeEquity(data);
  const prev = prevData ? computeEquity(prevData) : undefined;

  return (
    <Stack gap={0} style={gpStyles.modalContent}>
      <Text style={{ ...boldStyle, fontSize: '0.8rem', marginBottom: 12 }}>BALANCE SHEET</Text>
      <ClickableStatRow label="Cash" value={fmt(v.cash)} colorType="plus" trend={computeTrend(v.cash, prevData?.variables.cash)} onClick={() => onFieldClick({ field: 'variables.cash', label: 'CASH' })} />
      <ClickableStatRow label="Receivables" value={fmt(d.receivables)} colorType="plus" trend={computeTrend(d.receivables, prevData?.derived.receivables)} onClick={() => onFieldClick({ field: 'derived.receivables', label: 'Receivables' })} />
      <ClickableStatRow label="Assets" value={fmt(v.assets)} colorType="plus" trend={computeTrend(v.assets, prevData?.variables.assets)} onClick={() => onFieldClick({ field: 'variables.assets', label: 'Assets' })} />
      <ClickableStatRow label="Intangible assets" value={fmt(v.intangibleAssets)} colorType="plus" trend={computeTrend(v.intangibleAssets, prevData?.variables.intangibleAssets)} onClick={() => onFieldClick({ field: 'variables.intangibleAssets', label: 'Intangible assets' })} />
      <ClickableStatRow label="Reserves" value={fmt(v.reserves)} colorType="plus" trend={computeTrend(v.reserves, prevData?.variables.reserves)} onClick={() => onFieldClick({ field: 'variables.reserves', label: 'Reserves' })} />
      <ClickableStatRow label="Debt" value={`-${fmt(v.debt)}`} colorType="minus" trend={computeTrend(v.debt, prevData?.variables.debt)} invert onClick={() => onFieldClick({ field: 'variables.debt', label: 'Debt' })} />

      <Divider my="xs" />
      <Flex justify="space-between" style={gpStyles.totalRow}>
        <Text style={{ fontSize: '0.85rem' }}>Equity (book value)</Text>
        <Flex align="center" gap={4}>
          <Text style={{ fontSize: '0.95rem' }}>{fmt(cur.bookEquity)}</Text>
          <TrendIcon trend={computeTrend(cur.bookEquity, prev?.bookEquity)} size={13} />
        </Flex>
      </Flex>

      {/* Market equity */}
      <Stack gap={0} mt="md" pt="md" style={{ borderTop: '1px solid var(--mantine-color-gray-2)' }}>
        <ClickableStatRow label="Legal exposure (discount)" value={`-${fmt(cur.legalExposure)}`} colorType="minus" trend={computeTrend(cur.legalExposure, prev?.legalExposure)} invert onClick={() => onFieldClick({ field: 'variables.legalExposure', label: 'Legal exposure' })} />
        <Flex justify="space-between" style={gpStyles.totalRow}>
          <Text style={{ fontSize: '0.85rem' }}>Market equity (stock price basis)</Text>
          <Flex align="center" gap={4}>
            <Text style={{ fontSize: '0.95rem' }}>{fmt(cur.marketEquity)}</Text>
            <TrendIcon trend={computeTrend(cur.marketEquity, prev?.marketEquity)} size={13} />
          </Flex>
        </Flex>
      </Stack>

      <Text size="xs" c="dimmed" style={{ fontStyle: 'italic', marginTop: 8 }}>
        Your stock price is priced off market equity, not book equity — open cases against you make your own shares cheaper to buy.
      </Text>
    </Stack>
  );
}

// ── Cap Table (ownership breakdown) ─────────────────────

interface CapTableRow {
  key: string;
  name: string;
  fraction: number;
  shares: number;
  value: number;
  color: string;
}

/** Small, stable categorical set for shareholders that are neither "you" nor the
 * company's own founder nor the public float — cycled in order of appearance (largest
 * stake first, since rows are pre-sorted by fraction) rather than generated, so a 5th+
 * holder folds back to reusing an earlier color instead of an indistinguishable new hue. */
const OTHER_HOLDER_COLORS = ['#2563eb', '#7c3aed', '#0d9488', '#c2410c'];

/** Builds every current shareholder of `target`'s company, largest stake first — the same
 * `shareOwnership`/`totalSharesOutstanding`/`stockValue` data `shareholdingValue` above
 * already reads for a single holder, just all of them at once for the OWNERSHIP (CAP
 * TABLE) panel behind STOCK VALUE. `viewerId` is always the local player's own id, used
 * only to label a row "You" instead of their real name — `target` itself may or may not
 * be the viewer's own company (this is shared between ShareView, where it always is, and
 * RivalFullReportView, where it never is). `allPlayers` (the viewer's own snapshot plus
 * every currently-active rival) resolves a shareOwnership key that's a real playerId into
 * a display name; a key with no match (a holder who has since been eliminated) falls back
 * to a generic label — their stake is swept to EXTERNAL_MARKET on elimination (see
 * CLAUDE.md's "Cross-holding cleanup"), so this can only be transiently stale, never a
 * permanent orphan. */
function buildCapTable(target: PlayerTurnResult, viewerId: string, allPlayers: PlayerTurnResult[]): CapTableRow[] {
  const totalShares = target.variables.totalSharesOutstanding ?? 0;
  const stockValue = target.derived.stockValue ?? 0;
  const ownership = target.variables.shareOwnership ?? {};
  let otherColorIdx = 0;

  return Object.entries(ownership)
    .filter(([, fraction]) => fraction > 0.0005)
    .sort(([, a], [, b]) => b - a)
    .map(([key, fraction]) => {
      let name: string;
      let color: string;
      if (key === SELF_OWNERSHIP_KEY) {
        const isViewer = target.playerId === viewerId;
        name = isViewer ? 'You' : target.playerName;
        color = isViewer ? '#dc2626' : '#9ca3af';
      } else if (key === EXTERNAL_MARKET_KEY) {
        name = 'Public Market';
        color = '#d1d5db';
      } else if (key === viewerId) {
        name = 'You';
        color = '#dc2626';
      } else {
        name = allPlayers.find((p) => p.playerId === key)?.playerName ?? 'Former Shareholder';
        color = OTHER_HOLDER_COLORS[otherColorIdx++ % OTHER_HOLDER_COLORS.length];
      }
      return { key, name, fraction, shares: fraction * totalShares, value: fraction * totalShares * stockValue, color };
    });
}

interface CapTableSectionProps {
  /** Whose company's cap table this renders — the viewer's own (from ShareView) or a rival's (from RivalFullReportView). */
  target: PlayerTurnResult;
  viewerId: string;
  allPlayers: PlayerTurnResult[];
}

/** OWNERSHIP (CAP TABLE) panel — a horizontal stacked bar (same visual language as the
 * "YOUR SHARE VS RIVALS" market-share bar below) plus a per-holder row list (name, %,
 * share count, $ value). Shared between ShareView and RivalFullReportView rather than
 * duplicated, since the only thing that differs between the two call sites is which
 * PlayerTurnResult is `target`. Deliberately no separate "takeover risk" callout — the
 * bar + sorted list already puts the largest outside stake at the top, and reading
 * "someone else owns 42%" off a labeled row doesn't need a second warning restating it. */
function CapTableSection({ target, viewerId, allPlayers }: CapTableSectionProps) {
  const rows = buildCapTable(target, viewerId, allPlayers);
  const totalShares = target.variables.totalSharesOutstanding ?? 0;

  return (
    <div style={{ padding: '12px', background: 'var(--mantine-color-gray-1)', border: '1px solid var(--mantine-color-gray-3)', borderRadius: 'var(--mantine-radius-sm)' }}>
      <Flex justify="space-between" align="center" mb={8}>
        <Text style={{ ...boldStyle, fontSize: '0.7rem' }}>OWNERSHIP (CAP TABLE)</Text>
        <Text size="xs" c="dimmed">{new Intl.NumberFormat('en-US').format(Math.round(totalShares))} shares total</Text>
      </Flex>
      <Flex h={12} style={{ borderRadius: 6, overflow: 'hidden', background: '#e5e7eb' }}>
        {rows.map((r) => (
          <Box key={r.key} h="100%" style={{ width: `${r.fraction * 100}%`, background: r.color }} />
        ))}
      </Flex>
      <Stack gap={4} mt="xs">
        {rows.map((r) => (
          <Flex key={r.key} justify="space-between" align="center">
            <Flex align="center" gap={6}>
              <Box h={8} w={8} style={{ background: r.color, borderRadius: '50%', flexShrink: 0 }} />
              <Text size="xs">{r.name}</Text>
            </Flex>
            <Flex align="center" gap={10}>
              <Text size="xs" c="dimmed">{new Intl.NumberFormat('en-US').format(Math.round(r.shares))} sh</Text>
              <Text size="xs" style={boldStyle}>{fmt(r.value)}</Text>
              <Text size="xs" style={{ minWidth: 32, textAlign: 'right' }}>{pct(r.fraction)}</Text>
            </Flex>
          </Flex>
        ))}
      </Stack>
    </div>
  );
}

// ── Share View ─────────────────────────────────────────

interface ShareViewProps {
  data: PlayerTurnResult;
  rivals?: PlayerTurnResult[];
  /** Previous turn's snapshot for `data`, for the trend arrow on every own-field row — undefined on round 1. */
  prevData?: PlayerTurnResult;
  /** Previous turn's snapshot per rival, keyed by playerId — for the trend arrow on each rival's market-share row. */
  prevRivals?: Map<string, PlayerTurnResult>;
  onFieldClick: (target: { field: string; label: string }) => void;
}

function ShareView({ data, rivals, prevData, prevRivals, onFieldClick }: ShareViewProps) {
  const { variables: v, derived: d } = data;
  const outrageDemandWeight = 0.5;

  // Build market share visualization with rivals
  const allPlayers = [data, ...(rivals || [])];
  const totalMarketShare = allPlayers.reduce((sum, p) => sum + (p.derived.marketShare || 0), 0) || 1;
  const netDemand = v.demand - outrageDemandWeight * v.outrage;
  const prevNetDemand = prevData ? prevData.variables.demand - outrageDemandWeight * prevData.variables.outrage : undefined;

  return (
    <Stack gap="md" style={gpStyles.modalContent}>
      <Text style={{ ...boldStyle, fontSize: '0.8rem', marginBottom: 12 }}>SHARE VALUE FACTORS</Text>

      {/* Factor grid */}
      <Flex wrap="wrap" gap="xs">
        {[
          { label: 'PRICE (LOWER = BETTER)', value: `${fmt(v.price)}/t`, field: 'variables.price', trend: computeTrend(v.price, prevData?.variables.price), invert: true },
          { label: 'PROCESSING LEVEL', value: pct(v.processingLevel), field: 'variables.processingLevel', trend: computeTrend(v.processingLevel, prevData?.variables.processingLevel) },
          { label: 'SUPPLY SECURITY', value: pct(v.supplySecurity), field: 'variables.supplySecurity', trend: computeTrend(v.supplySecurity, prevData?.variables.supplySecurity) },
          { label: 'PROCESS LOSS (LOWER = BETTER)', value: pct(v.processLoss), field: 'variables.processLoss', trend: computeTrend(v.processLoss, prevData?.variables.processLoss), invert: true },
        ].map((f) => (
          <Box
            key={f.label}
            p="sm"
            style={{ background: 'var(--mantine-color-gray-1)', border: '1px solid var(--mantine-color-gray-3)', borderRadius: 'var(--mantine-radius-sm)', flex: '1 1 45%', cursor: 'pointer' }}
            title="Click for history + prediction"
            onClick={() => onFieldClick({ field: f.field, label: f.label })}
          >
            <Text style={{ fontSize: '0.65rem', color: '#6b7280' }}>{f.label}</Text>
            <Flex align="center" gap={4}>
              <Text style={{ ...boldStyle, fontSize: '0.8rem', textDecoration: 'underline', textDecorationStyle: 'dotted', textUnderlineOffset: 3 }}>{f.value}</Text>
              <TrendIcon trend={f.trend} invert={f.invert} size={12} />
            </Flex>
          </Box>
        ))}
      </Flex>

      {/* Demand breakdown */}
      <div style={{ padding: '12px', background: 'var(--mantine-color-gray-1)', border: '1px solid var(--mantine-color-gray-3)', borderRadius: 'var(--mantine-radius-sm)' }}>
        <Text style={{ ...boldStyle, fontSize: '0.7rem', marginBottom: 8 }}>DEMAND BREAKDOWN</Text>
        <ClickableStatRow label="Marketing demand" value={`${v.demand} pts`} trend={computeTrend(v.demand, prevData?.variables.demand)} onClick={() => onFieldClick({ field: 'variables.demand', label: 'Marketing demand' })} />
        <ClickableStatRow label={`Outrage penalty (${v.outrage} × ${outrageDemandWeight})`} value={`-${Math.round(outrageDemandWeight * v.outrage)} pts`} colorType="minus" trend={computeTrend(v.outrage, prevData?.variables.outrage)} invert onClick={() => onFieldClick({ field: 'variables.outrage', label: 'Outrage' })} />
        <Divider my="xs" />
        <Flex justify="space-between" style={gpStyles.totalRow}>
          <Text style={{ fontSize: '0.75rem' }}>Net demand</Text>
          <Flex align="center" gap={4}>
            <Text style={{ fontSize: '0.8rem' }}>{Math.round(netDemand)} pts</Text>
            <TrendIcon trend={computeTrend(netDemand, prevNetDemand)} size={12} />
          </Flex>
        </Flex>
        <Text size="xs" c="dimmed" style={{ fontStyle: 'italic', marginTop: 8 }}>
          Outrage is currently costing you {Math.round(outrageDemandWeight * v.outrage)} demand points — dirty moves that spike outrage quietly shrink your market share.
        </Text>
      </div>

      {/* Market share bar */}
      <div style={{ padding: '12px', background: 'var(--mantine-color-gray-1)', border: '1px solid var(--mantine-color-gray-3)', borderRadius: 'var(--mantine-radius-sm)' }}>
        <Text style={{ ...boldStyle, fontSize: '0.7rem', marginBottom: 8 }}>YOUR SHARE VS RIVALS</Text>
        <Flex h={12} style={{ borderRadius: 6, overflow: 'hidden', background: '#e5e7eb' }}>
          {allPlayers.map((p, i) => {
            const share = (p.derived.marketShare || 0) / totalMarketShare;
            const color = i === 0 ? '#dc2626' : i === 1 ? '#9ca3af' : '#d1d5db';
            return <Box key={p.playerId} h="100%" style={{ width: `${share * 100}%`, background: color }} />;
          })}
        </Flex>
        <Flex wrap="wrap" gap="xs" mt="xs">
          {allPlayers.map((p, i) => {
            const share = (p.derived.marketShare || 0) / totalMarketShare;
            const color = i === 0 ? '#dc2626' : i === 1 ? '#9ca3af' : '#d1d5db';
            // Only my own entry (index 0) is clickable — this is "player's own KPIs," not a rival comparison.
            // The trend arrow, unlike the click, is shown for every player — it's a quick
            // read of "who's gaining/losing share," not a graph-opening affordance.
            const prevShare = i === 0 ? prevData?.derived.marketShare : prevRivals?.get(p.playerId)?.derived.marketShare;
            return (
              <Flex
                key={p.playerId}
                align="center"
                gap={4}
                style={i === 0 ? { cursor: 'pointer' } : undefined}
                title={i === 0 ? 'Click for history + prediction' : undefined}
                onClick={i === 0 ? () => onFieldClick({ field: 'derived.marketShare', label: 'Market share' }) : undefined}
              >
                <Box h={8} w={8} style={{ background: color, borderRadius: '50%' }} />
                <Text size="xs" style={i === 0 ? { textDecoration: 'underline', textDecorationStyle: 'dotted', textUnderlineOffset: 3 } : undefined}>{p.playerName} {pct(share)}</Text>
                <TrendIcon trend={computeTrend(p.derived.marketShare || 0, prevShare)} size={11} />
              </Flex>
            );
          })}
        </Flex>
      </div>

      {/* Ownership / cap table */}
      <CapTableSection target={data} viewerId={data.playerId} allPlayers={allPlayers} />

      {/* Capacity cap */}
      <div style={{ padding: '12px', background: 'var(--mantine-color-gray-1)', border: '1px solid var(--mantine-color-gray-3)', borderRadius: 'var(--mantine-radius-sm)' }}>
        <Text style={{ ...boldStyle, fontSize: '0.7rem', marginBottom: 4 }}>CAPACITY CAP</Text>
        <Flex align="center" gap={4} wrap="wrap">
          <Text size="sm">
            <Text component="span" style={{ cursor: 'pointer', textDecoration: 'underline', textDecorationStyle: 'dotted', textUnderlineOffset: 3 }} title="Click for history + prediction" onClick={() => onFieldClick({ field: 'variables.installedCapacity', label: 'Installed capacity' })}>
              Installed capacity {v.installedCapacity?.toFixed(0)}t
            </Text>
          </Text>
          <TrendIcon trend={computeTrend(v.installedCapacity, prevData?.variables.installedCapacity)} size={12} />
          <Text size="sm">
            {' × '}
            <Text component="span" style={{ cursor: 'pointer', textDecoration: 'underline', textDecorationStyle: 'dotted', textUnderlineOffset: 3 }} title="Click for history + prediction" onClick={() => onFieldClick({ field: 'variables.capacityUtilization', label: 'Capacity utilization' })}>
              {(v.capacityUtilization * 100).toFixed(0)}% utilization
            </Text>
          </Text>
          <TrendIcon trend={computeTrend(v.capacityUtilization, prevData?.variables.capacityUtilization)} size={12} />
          <Text size="sm">{' = '}{(v.installedCapacity * v.capacityUtilization)?.toFixed(0)}t ceiling</Text>
        </Flex>
        {d.volume && d.marketShare && (
          <Text size="xs" c="dimmed" style={{ fontStyle: 'italic', marginTop: 4 }}>
            Your demand-based share would support {(d.marketShare * 10000).toFixed(0)}t — capacity is the bottleneck this turn.
          </Text>
        )}
      </div>
    </Stack>
  );
}

// ── Threat View ────────────────────────────────────────

interface ThreatViewProps {
  data: PlayerTurnResult;
  /** Previous turn's snapshot, for the trend arrow on every row — undefined on round 1. */
  prevData?: PlayerTurnResult;
  onFieldClick: (target: { field: string; label: string }) => void;
}

// Mirrors calcEngine.ts's calculateRiskGauge — the Risk Gauge's original 3-term design
// (legal exposure, scrutiny, outrage) plus two deliberate later additions: w4/
// ownershipRisk (majority-ownership takeover) and w5/solvencyRisk
// (open lawsuits vs. a projected next-turn cash) — both fully independent ways to lose
// the game the original 3-term gauge never reflected at all. See CLAUDE.md's "Risk Gauge
// takeover term" and "Risk Gauge solvency term" sections. These are the *seeded default*
// weights/threshold, hand-mirrored client-side same as every other admin-editable
// constant this file duplicates for display (see computeOfferBracket/getDeployability)
// — they'll silently drift from an admin's live /admin edit, same pre-existing
// limitation those already have; the server's own riskGauge number (shown on the KPI
// card itself) is always the authoritative one, this is only the breakdown explaining it.
const THREAT_W1 = 0.32, THREAT_W2 = 0.16, THREAT_W3 = 0.16, THREAT_W4 = 0.16, THREAT_W5 = 0.2;
const THREAT_LEGAL_EXPOSURE_RATIO_CAP = 0.8;
const THREAT_TAKEOVER_THRESHOLD_PERCENT = 0.5;
const THREAT_SOLVENCY_CASH_FLOOR = 1;

/** Mirrors calcEngine.ts's calculateOwnershipRisk — the largest real-player (non-`self`,
 * non-`EXTERNAL_MARKET`) stake relative to the takeover threshold, scaled 0-1. Deliberately
 * the single largest holder, not a sum across holders — a takeover only ever needs ONE
 * player to cross the threshold, so dilution spread across several minority holders reads
 * as lower risk than one concentrated buyer closing in. */
function computeOwnershipRisk(shareOwnership: Record<string, number> | undefined): number {
  if (!shareOwnership) return 0;
  let maxExternalStake = 0;
  for (const [key, fraction] of Object.entries(shareOwnership)) {
    if (key === SELF_OWNERSHIP_KEY || key === EXTERNAL_MARKET_KEY) continue;
    if (fraction > maxExternalStake) maxExternalStake = fraction;
  }
  return Math.min(1, maxExternalStake / THREAT_TAKEOVER_THRESHOLD_PERCENT);
}

/** Mirrors calcEngine.ts's predictNextTurnCashLinear — a naive one-turn-ahead cash
 * projection (this turn's own net cash movement extrapolated forward), not the real
 * sandboxed prediction engine (`predictFutureKpis`) the KPI history graphs use. Client-
 * side this doubles as a genuine accuracy win over a from-scratch reimplementation: it
 * needs no new data at all, since `prevCash` here is just `prevData.variables.cash` —
 * the one-turn-back snapshot `GamePhase.tsx`'s trend arrows already keep in state. */
function predictNextTurnCashLinear(cashAfterThisTurn: number, cashBeforeThisTurn: number): number {
  return cashAfterThisTurn + (cashAfterThisTurn - cashBeforeThisTurn);
}

/** Mirrors calcEngine.ts's calculateSolvencyRisk — probability-weighted open-case
 * exposure against a projected next-turn cash, distinct from the legal-exposure-ratio
 * term (w1), which uses *current* cash and feeds adjustedProbability's snowball effect instead. */
function computeSolvencyRisk(legalExposure: number, predictedNextCash: number): number {
  if (legalExposure <= 0) return 0;
  return Math.min(1, legalExposure / Math.max(predictedNextCash, THREAT_SOLVENCY_CASH_FLOOR));
}

/** Mirrors gameLoop.ts's Step 11 openCases aggregation — every still-open (non-
 * `'resolved'`) case where `myPlayerId` is the defendant, probability-weighted the same
 * way (`adjustedProbability` if the case has one, else `baseProbability`). Deliberately
 * NOT reverse-derived from `legalExposureRatio` (which is already capped against current
 * cash by `legalExposureRatioCap` server-side) — a capped ratio would silently understate
 * exposure for exactly the players this term cares most about (already deep in legal
 * trouble), so this recomputes the same raw sum from `legalCases` instead, which the
 * client already has in full. */
function computeOpenLegalExposure(myPlayerId: string, legalCases: LegalCaseData[]): number {
  return legalCases
    .filter((c) => c.defendantId === myPlayerId && c.status !== 'resolved')
    .reduce((sum, c) => sum + (c.adjustedProbability ?? c.baseProbability) * c.stakes, 0);
}

/** The five weighted terms behind the Threat Level gauge — shared by ThreatView's
 * current- and previous-turn calls so the total's trend arrow is diffed against the same
 * formula rather than a persisted field. `prevCash` is the cash this player had BEFORE
 * the turn `data` reflects — for the current turn that's `prevData.variables.cash` (the
 * one-turn-back snapshot already in state); for the previous turn's own point (used only
 * to diff against, for the row's trend arrow) there is no snapshot further back than that
 * in client state, so it falls back to assuming no trend for that historical point —
 * the same "no real prior data, assume flat" default `calculateRiskGauge`'s own
 * `prevCash = vars.cash` parameter default uses server-side. */
function computeThreatTerms(data: PlayerTurnResult, prevCash: number) {
  const v = data.variables;
  const ler = v.legalExposureRatio ?? 0;
  const legalTerm = THREAT_W1 * (ler / THREAT_LEGAL_EXPOSURE_RATIO_CAP) * 100;
  // Both clamped to [0,1] before weighting, mirroring calcEngine.ts's riskGauge formula
  // exactly (MAX(0,MIN(1,scrutiny/100)) / MIN(1,absOutrage/100)) — scrutiny has no floor
  // and can legitimately go negative (no decision drives it back up the way outrage can
  // be reduced), so its term needs the lower clamp too, not just an upper one; outrage's
  // own Math.abs already guarantees non-negative, so only the upper clamp applies there.
  // A missing clamp here previously let this mirror (and, before the server-side fix, the
  // real riskGauge) dip below/exceed its documented 0-100 range — see CLAUDE.md.
  const scrutinyTerm = THREAT_W2 * Math.max(0, Math.min(1, v.scrutiny / 100)) * 100;
  const outrageTerm = THREAT_W3 * Math.min(1, Math.abs(v.outrage) / 100) * 100;
  const ownershipRisk = computeOwnershipRisk(v.shareOwnership);
  const ownershipTerm = THREAT_W4 * ownershipRisk * 100;
  const legalExposure = computeOpenLegalExposure(data.playerId, data.legalCases);
  const predictedNextCash = predictNextTurnCashLinear(v.cash, prevCash);
  const solvencyRisk = computeSolvencyRisk(legalExposure, predictedNextCash);
  const solvencyTerm = THREAT_W5 * solvencyRisk * 100;
  return { ler, legalTerm, scrutinyTerm, outrageTerm, ownershipRisk, ownershipTerm, predictedNextCash, solvencyRisk, solvencyTerm };
}

function ThreatView({ data, prevData, onFieldClick }: ThreatViewProps) {
  const { variables: v } = data;
  const cur = computeThreatTerms(data, prevData?.variables.cash ?? v.cash);
  const prev = prevData ? computeThreatTerms(prevData, prevData.variables.cash) : undefined;
  const total = cur.legalTerm + cur.scrutinyTerm + cur.outrageTerm + cur.ownershipTerm + cur.solvencyTerm;
  const prevTotal = prev ? prev.legalTerm + prev.scrutinyTerm + prev.outrageTerm + prev.ownershipTerm + prev.solvencyTerm : undefined;

  return (
    <Stack gap={0} style={gpStyles.modalContent}>
      <Text style={{ ...boldStyle, fontSize: '0.8rem', marginBottom: 12 }}>GLOBAL RISK GAUGE BREAKDOWN</Text>
      <ClickableStatRow label={`Legal exposure ratio (${(cur.ler * 100).toFixed(0)}%, weight 0.32)`} value={cur.legalTerm.toFixed(1)} trend={computeTrend(cur.legalTerm, prev?.legalTerm)} invert onClick={() => onFieldClick({ field: 'variables.legalExposureRatio', label: 'Legal exposure ratio' })} />
      <ClickableStatRow label="Scrutiny (weight 0.16)" value={cur.scrutinyTerm.toFixed(1)} trend={computeTrend(cur.scrutinyTerm, prev?.scrutinyTerm)} invert onClick={() => onFieldClick({ field: 'variables.scrutiny', label: 'Scrutiny' })} />
      <ClickableStatRow label="Outrage (weight 0.16)" value={cur.outrageTerm.toFixed(1)} trend={computeTrend(cur.outrageTerm, prev?.outrageTerm)} invert onClick={() => onFieldClick({ field: 'variables.outrage', label: 'Outrage' })} />
      {/* Both rows below are computed-only, no onFieldClick — neither "largest external
          shareholder's stake" nor "predicted next-turn cash" is a single persisted
          numeric field to open a history graph for, same "derived-of-derived, not a
          tracked field" treatment CashWaterfallView's COGS/EBITDA/etc. rows already get
          (see CLAUDE.md's KPI history section). */}
      <Flex justify="space-between" align="center" style={gpStyles.statRow()}>
        <Text size="sm">Ownership / takeover risk ({(cur.ownershipRisk * 100).toFixed(0)}% of the way to a takeover, weight 0.16)</Text>
        <Flex align="center" gap={4}>
          <Text style={{ ...boldStyle, fontSize: '0.85rem' }}>{cur.ownershipTerm.toFixed(1)}</Text>
          <TrendIcon trend={computeTrend(cur.ownershipTerm, prev?.ownershipTerm)} invert size={13} />
        </Flex>
      </Flex>
      <Flex justify="space-between" align="center" style={gpStyles.statRow()}>
        <Text size="sm">Legal solvency risk (open cases would consume {(cur.solvencyRisk * 100).toFixed(0)}% of predicted next-turn cash, weight 0.2)</Text>
        <Flex align="center" gap={4}>
          <Text style={{ ...boldStyle, fontSize: '0.85rem' }}>{cur.solvencyTerm.toFixed(1)}</Text>
          <TrendIcon trend={computeTrend(cur.solvencyTerm, prev?.solvencyTerm)} invert size={13} />
        </Flex>
      </Flex>

      <Divider my="xs" />
      <Flex justify="space-between" style={gpStyles.totalRow}>
        <Text style={{ fontSize: '0.85rem' }}>Threat level</Text>
        <Flex align="center" gap={4}>
          <Text style={{ fontSize: '0.95rem' }}>{Math.round(total)}</Text>
          <TrendIcon trend={computeTrend(total, prevTotal)} invert size={13} />
        </Flex>
      </Flex>

      <Text size="xs" c="dimmed" style={{ fontStyle: 'italic', marginTop: 8 }}>
        Legal exposure carries the most weight — it's also the one thing that snowballs, since it makes every open case more likely to succeed too. Ownership risk tracks the single largest outside stake in your company against the 50% takeover line — see OWNERSHIP (CAP TABLE) under STOCK VALUE for who actually holds it. Solvency risk is forward-looking: it projects next turn's cash from this turn's own trend and asks whether your open cases could actually break you.
      </Text>
    </Stack>
  );
}

// ── Risk Breakdown View (for defendant cases) ──────────

interface RiskBreakdownViewProps {
  caseData: LegalCaseData;
  vars: import('@suetheirasses/shared').PlayerVariables;
}

function RiskBreakdownView({ caseData, vars }: RiskBreakdownViewProps) {
  const SCRUTINY_MULTIPLIER = 0.3;
  const LEGAL_EXPOSURE_RATIO_CAP = 0.8;
  const legalExposureRatio = Math.min(LEGAL_EXPOSURE_RATIO_CAP, (vars.legalExposure ?? 0) / Math.max(0, vars.cash));
  const scrutinyFactor = (SCRUTINY_MULTIPLIER * vars.scrutiny) / 100;

  // adjustedProbability = baseProbability * (1 + scrutinyFactor + legalExposureRatio)
  const adjustedProb = caseData.baseProbability * (1 + scrutinyFactor + legalExposureRatio);

  return (
    <Stack gap={0} style={gpStyles.modalContent}>
      <Text style={{ ...boldStyle, fontSize: '0.8rem', marginBottom: 12 }}>ADJUSTED PROBABILITY</Text>
      <Flex justify="space-between" style={gpStyles.statRow()}>
        <Text size="sm">Base probability</Text><Text style={boldStyle}>{Math.round(caseData.baseProbability * 100)}%</Text>
      </Flex>
      <Flex justify="space-between" style={gpStyles.statRow('plus')}>
        <Text size="sm">Your scrutiny ({vars.scrutiny})</Text><Text style={boldStyle}>+{Math.round(scrutinyFactor * 100)}%</Text>
      </Flex>
      <Flex justify="space-between" style={gpStyles.statRow('plus')}>
        <Text size="sm">Legal exposure ratio (capped at 80%)</Text><Text style={boldStyle}>+{(legalExposureRatio * 100).toFixed(0)}%</Text>
      </Flex>

      <Divider my="xs" />
      <Flex justify="space-between" style={gpStyles.totalRow}>
        <Text style={{ fontSize: '0.85rem' }}>Adjusted probability</Text>
        <Text style={{ fontSize: '0.95rem' }}>{Math.round(adjustedProb * 100)}%</Text>
      </Flex>

      <Text size="xs" c="dimmed" style={{ fontStyle: 'italic', marginTop: 8 }}>
        More open cases against you, relative to your cash, make every one of them more likely to succeed — a snowball effect. Settling cases down brings this back.
      </Text>
    </Stack>
  );
}

// ── Full Report View (for rivals) ──────────────────────

interface RivalFullReportViewProps {
  rival: PlayerTurnResult;
  /** Previous turn's snapshot for this rival, for the trend arrow on every row — undefined on round 1 or if this is the first time this rival has been seen. */
  prevRival?: PlayerTurnResult;
  decisions: DecisionDefinition[];
  /** The viewer's own snapshot + every other active rival — needed only to resolve a name
   * for whichever real playerIds show up as shareholders in `rival`'s own cap table (see
   * CapTableSection/buildCapTable above), including the viewer's own id if they hold a
   * stake in this rival themselves. */
  myData: PlayerTurnResult;
  competitors: PlayerTurnResult[];
  onFieldClick: (target: { field: string; label: string; targetPlayerId: string }) => void;
}

/** Narrative "annual report" blurbs for a rival's active decisions — the flavor-text
 * `competitorsView` variants from game_engine.json, deterministically picked per
 * instance so rivals get a hint of what happened without seeing exact decision names. */
function buildAnnualReport(
  rival: PlayerTurnResult,
  decisions: DecisionDefinition[],
): Array<{ text: string; year: number }> {
  const reports: Array<{ text: string; year: number }> = [];
  for (const active of rival.activeDecisions) {
    const def = decisions.find((d) => d.decision === active.decisionName);
    if (!def?.competitorsView || def.competitorsView.length === 0) continue;
    const text = def.competitorsView[active.elapsedYears % def.competitorsView.length];
    reports.push({ text, year: active.deployedYear + 1 });
  }
  return reports;
}

/** Fields where the trend arrow reads "up = bad" (costs, debt) rather than the default "up = good". */
const RIVAL_REPORT_INVERT_FIELDS = new Set(['variables.debt', 'variables.operatingExpenses', 'variables.staffCost', 'variables.materialCostPerTon', 'derived.depreciation', 'derived.financeCost', 'derived.taxCost']);

function RivalFullReportView({ rival, prevRival, decisions, myData, competitors, onFieldClick }: RivalFullReportViewProps) {
  const { variables: v, derived: d } = rival;
  const { socket } = useSocketStore();
  const { annualReports, annualReportLoading, setAnnualReportLoading } = useGameStore();

  // Each row is clickable — opens a stacked modal with that field's real history graph
  // for this rival (see KpiHistoryGraph). No prediction for rivals, history only. The
  // trend arrow (unlike the graph) uses only prevRival — one turn's worth of "since last
  // time you looked" comparison, not the full persisted history.
  const rows: Array<{ label: string; field: string; value: string }> = [
    { label: 'Cash', field: 'variables.cash', value: fmt(v.cash) },
    { label: 'Revenue', field: 'derived.revenue', value: fmt(d.revenue) },
    { label: 'Equity', field: 'derived.equity', value: fmt(d.equity) },
    { label: 'Stock value', field: 'derived.stockValue', value: fmt(d.stockValue) },
    { label: 'Debt', field: 'variables.debt', value: fmt(v.debt) },
    { label: 'Assets', field: 'variables.assets', value: fmt(v.assets) },
    { label: 'Intangible assets', field: 'variables.intangibleAssets', value: fmt(v.intangibleAssets) },
    { label: 'Reserves', field: 'variables.reserves', value: fmt(v.reserves) },
    { label: 'Receivables', field: 'derived.receivables', value: fmt(d.receivables) },
    { label: 'Operating expenses', field: 'variables.operatingExpenses', value: fmt(v.operatingExpenses) },
    { label: 'Staff cost', field: 'variables.staffCost', value: fmt(v.staffCost) },
    { label: 'Material cost / ton', field: 'variables.materialCostPerTon', value: fmt(v.materialCostPerTon) },
    { label: 'Depreciation', field: 'derived.depreciation', value: fmt(d.depreciation) },
    { label: 'Finance cost', field: 'derived.financeCost', value: fmt(d.financeCost) },
    { label: 'Tax cost', field: 'derived.taxCost', value: fmt(d.taxCost) },
    { label: 'Other income', field: 'variables.otherIncome', value: fmt(v.otherIncome) },
  ];

  // Static text renders instantly; the AI-narrated version (server round trip to the
  // local LLM, see GameEngine.getAnnualReport) replaces it in place once it arrives.
  // If the LLM is down/unreachable, this stays on the static fallback forever — never
  // a blank or stuck-loading report.
  const staticReport = buildAnnualReport(rival, decisions);
  const aiEntries = annualReports.get(rival.playerId);
  const isLoadingAi = annualReportLoading.has(rival.playerId);
  const annualReport = aiEntries
    ? aiEntries.map((e) => ({ text: e.text, year: e.year }))
    : staticReport;

  useEffect(() => {
    if (!socket || aiEntries || isLoadingAi || staticReport.length === 0) return;
    setAnnualReportLoading(rival.playerId);
    socket.emit(ClientEvents.GAME_GET_ANNUAL_REPORT, { rivalPlayerId: rival.playerId });
    // Only re-request when switching to a different rival — the store's cached
    // result (or in-flight loading flag) covers repeat opens of the same one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [socket, rival.playerId]);

  return (
    <Stack gap="lg" style={gpStyles.modalContent}>
      <Stack gap={0}>
        <Text style={{ ...boldStyle, fontSize: '0.75rem', color: '#6b7280', marginBottom: 8 }}>FINANCIAL STATEMENT — {rival.playerName}</Text>
        {rows.map((row) => (
          <ClickableStatRow
            key={row.label}
            label={row.label}
            value={row.value}
            trend={prevRival ? computeTrend(getKpiFieldValue(rival, row.field), getKpiFieldValue(prevRival, row.field)) : undefined}
            invert={RIVAL_REPORT_INVERT_FIELDS.has(row.field)}
            title="Click for history"
            onClick={() => onFieldClick({ field: row.field, label: row.label, targetPlayerId: rival.playerId })}
          />
        ))}
      </Stack>
      <CapTableSection target={rival} viewerId={myData.playerId} allPlayers={[myData, ...competitors]} />
      <Stack gap={0}>
        <Text style={{ ...boldStyle, fontSize: '0.75rem', color: '#6b7280', marginBottom: 8 }}>ANNUAL REPORTS</Text>
        {annualReport.length === 0 ? (
          <Text size="xs" c="dimmed" style={{ fontStyle: 'italic' }}>No filings yet — {rival.playerName} hasn't deployed any strategies.</Text>
        ) : (
          <Stack gap={6}>
            {annualReport.map((r, i) => (
              <Text key={i} size="xs" c="dimmed" style={{ fontStyle: 'italic', lineHeight: 1.4 }}>
                "{r.text}" <Text component="span" size="xs" c="dimmed" style={{ fontStyle: 'normal' }}>— year {r.year}</Text>
              </Text>
            ))}
          </Stack>
        )}
      </Stack>
    </Stack>
  );
}

// ── Rival Field View (history graph) ───────────────────

interface RivalFieldViewProps {
  rival: PlayerTurnResult;
  field: string;
  label: string;
  socket: Socket | null;
}

function RivalFieldView({ rival, field, label, socket }: RivalFieldViewProps) {
  return (
    <Stack gap="md">
      <Text style={{ ...boldStyle, fontSize: '0.8rem', marginBottom: 8 }}>{label} — HISTORY — {rival.playerName}</Text>
      <KpiHistoryGraph field={field} label={label} socket={socket} targetPlayerId={rival.playerId} />
    </Stack>
  );
}

// ============================================================
// Sue Modal
// ============================================================

/** A ground a player can choose to sue someone over. Deliberately the *entire* legal-risk
 * catalog across every decision in the game — not filtered down to what the target has
 * actually deployed — so a player can gamble on a ground the target may or may not have
 * actually pursued; a wrong guess still costs the filing fee (see SueModal's `handleFile`)
 * but simply produces no case at the next turn resolution (`LegalEngine.fileLawsuit`
 * already returns null when the target never deployed the cited decision — this was
 * already the exact validation a real, deliberate guess needs, it just wasn't reachable
 * from the UI before). */
interface DerivedGround {
  decisionName: string;
  groundName: string;
  description: string;
}

function getGroundsAgainst(decisions: DecisionDefinition[]): DerivedGround[] {
  const grounds: DerivedGround[] = [];
  for (const def of decisions) {
    if (!def.legalRisks) continue;
    for (const risk of def.legalRisks) {
      grounds.push({ decisionName: def.decision, groundName: risk.name, description: risk.description });
    }
  }
  return grounds;
}

/** Friendly copy for a failed `game:fileLawsuit` — keyed by `LawsuitFilingFeeOutcome`'s `reason`. */
const FILE_LAWSUIT_ERROR_COPY: Record<string, string> = {
  insufficient_funds: "You can't afford the filing fee.",
  limit_reached: "You've already hit this turn's lawsuit limit.",
  player_not_found: 'Could not file lawsuit — please try again.',
};

interface SueModalProps {
  competitors: PlayerTurnResult[];
  decisions: DecisionDefinition[];
  gameSettings: GameSettings | null;
  pending: SubmittedDecisions;
  onSubmitPending: (next: SubmittedDecisions) => void;
  /** Pre-select a target + ground — set via a fully-investigated attack's "SUE NOW" shortcut. */
  prefillTargetId?: string;
  /** Disambiguates prefillGroundName against the whole-library ground catalog (see
   * getGroundsAgainst) — two different decisions could in principle share an identically
   * named ground. */
  prefillDecisionName?: string;
  prefillGroundName?: string;
  /** This player's current cash — used to disable filing (and explain why) when the flat filing fee isn't affordable. */
  cash: number;
  socket: Socket | null;
  /** Called right after a lawsuit is successfully filed — the modal closes itself instead
   * of staying open, since the newly-queued lawsuit now shows in the "Open Lawsuits" box
   * (via `QueuedLawsuitCard`) the moment this modal is gone. */
  onClose: () => void;
}

function SueModal({ competitors, decisions, gameSettings, pending, onSubmitPending, prefillTargetId, prefillDecisionName, prefillGroundName, cash, socket, onClose }: SueModalProps) {
  const [query, setQuery] = useState('');
  const [selectedGround, setSelectedGround] = useState<DerivedGround | null>(null);
  const [targetRival, setTargetRival] = useState<string>('');
  const [filing, setFiling] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);

  const target = competitors.find((c) => c.playerId === targetRival) ?? null;
  const grounds = target ? getGroundsAgainst(decisions) : [];
  const q = query.trim().toLowerCase();
  const results = q === '' ? grounds : grounds.filter((g) => g.groundName.toLowerCase().includes(q) || g.description.toLowerCase().includes(q));

  // Applied via a useEffect (not a useState initializer) so it works regardless of
  // whether Mantine keeps this component mounted across modal open/close cycles.
  useEffect(() => {
    if (!prefillTargetId) return;
    setTargetRival(prefillTargetId);
    if (!prefillGroundName) return;
    const prefillTarget = competitors.find((c) => c.playerId === prefillTargetId);
    if (!prefillTarget) return;
    const match = getGroundsAgainst(decisions).find((g) => g.decisionName === prefillDecisionName && g.groundName === prefillGroundName);
    if (match) setSelectedGround(match);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefillTargetId, prefillDecisionName, prefillGroundName]);

  const maxLawsuits = gameSettings?.maxLawsuitsPerPlayerPerTurn ?? Infinity;
  const atLimit = pending.lawsuits.length >= maxLawsuits;
  const alreadyQueued = (g: DerivedGround) =>
    pending.lawsuits.some((l) => l.targetId === targetRival && l.decisionName === g.decisionName && l.groundName === g.groundName);

  const filingCost = gameSettings?.lawsuitFilingCost ?? 0;
  const canAfford = cash >= filingCost;

  // Filing charges the flat filing fee instantly, out-of-band (same "instant, outside
  // turn resolution" pattern as Dig Deeper) — only once that charge actually succeeds
  // does the lawsuit get queued into `pending` for the case itself to be created at the
  // next turn resolution. Not refunded if that later validation rejects it (by product
  // decision) — see GameLoop.chargeLawsuitFilingFee's doc comment.
  const handleFile = () => {
    if (!selectedGround || !targetRival || atLimit || !canAfford || filing || !socket) return;
    setFiling(true);
    setFileError(null);

    const filedGround = selectedGround;
    const filedTarget = targetRival;

    const cleanup = () => {
      socket.off(ServerEvents.GAME_FILE_LAWSUIT_RESULT, onResult);
      socket.off(ServerEvents.ERROR, onError);
    };
    const onResult = () => {
      cleanup();
      setFiling(false);
      onSubmitPending({
        ...pending,
        lawsuits: [...pending.lawsuits, { targetId: filedTarget, decisionName: filedGround.decisionName, groundName: filedGround.groundName }],
      });
      setSelectedGround(null);
      setQuery('');
      onClose();
    };
    const onError = (data: { code: string; message: string }) => {
      if (data.code !== 'FILE_LAWSUIT_FAILED' && data.code !== 'INVALID_FILE_LAWSUIT') return;
      cleanup();
      setFiling(false);
      setFileError(FILE_LAWSUIT_ERROR_COPY[data.message] ?? 'Could not file lawsuit — please try again.');
    };

    socket.on(ServerEvents.GAME_FILE_LAWSUIT_RESULT, onResult);
    socket.on(ServerEvents.ERROR, onError);
    socket.emit(ClientEvents.GAME_FILE_LAWSUIT, { targetId: filedTarget, decisionName: filedGround.decisionName, groundName: filedGround.groundName });
  };

  return (
    <Stack gap="md">
      {gameSettings && (
        <Text size="xs" c="dimmed" style={boldStyle}>
          {pending.lawsuits.length}/{maxLawsuits} LAWSUITS QUEUED THIS TURN
        </Text>
      )}

      {/* Target selection */}
      <Stack gap={4}>
        <Text style={{ ...boldStyle, fontSize: '0.7rem', color: '#6b7280' }}>TARGET</Text>
        <select value={targetRival} onChange={(e) => { setTargetRival(e.target.value); setSelectedGround(null); setFileError(null); }} style={{ width: '100%', padding: '10px 12px', border: '3px solid #333', borderRadius: 8, fontSize: '0.85rem' }}>
          <option value="">Select opponent...</option>
          {competitors.map((c) => (<option key={c.playerId} value={c.playerId}>{c.playerName}</option>))}
        </select>
      </Stack>

      {target && !selectedGround && (
        <>
          {/* Search grounds */}
          <Stack gap={4}>
            <Text style={{ ...boldStyle, fontSize: '0.7rem', color: '#6b7280' }}>SEARCH GROUNDS</Text>
            <div style={gpStyles.searchInput}>
              <IconSearch size={16} style={{ color: '#9ca3af' }} />
              <TextInput flex={1} placeholder="e.g. weight fraud, patent, disclosure…" value={query} onChange={(e) => setQuery(e.target.value)} style={{ border: 'none', outline: 'none', background: 'transparent' }} />
            </div>
          </Stack>
          <Text size="xs" c="dimmed">
            {grounds.length === 0 ? 'No legal grounds are configured for this game.' : `${results.length} match${results.length === 1 ? '' : 'es'} — guessing wrong still costs the filing fee`}
          </Text>

          {/* Results list */}
          <Box style={{ maxHeight: 280, overflowY: 'auto' }}>
            {results.length === 0 && grounds.length > 0 && <Text size="xs" c="dimmed" style={{ fontStyle: 'italic' }}>No grounds match that search — try different words.</Text>}
            {results.map((g, i) => (
              <Box
                key={`${g.decisionName}-${g.groundName}-${i}`}
                style={{ ...gpStyles.groundsItem(false), opacity: alreadyQueued(g) ? 0.5 : 1 }}
                onClick={() => {
                  if (alreadyQueued(g)) return;
                  setSelectedGround(g);
                  setFileError(null);
                }}
              >
                <Text style={{ ...boldStyle, fontSize: '0.8rem' }}>{g.groundName}</Text>
                <Text size="xs" c="dimmed">from {g.decisionName}{alreadyQueued(g) ? ' — already queued' : ''}</Text>
                <Text size="xs" style={{ lineHeight: 1.4 }}>{g.description}</Text>
              </Box>
            ))}
          </Box>
        </>
      )}

      {selectedGround && (
        <div style={{ padding: 12, border: '3px solid #333', borderRadius: 8, background: '#f9fafb' }}>
          <Flex justify="space-between" align="center" gap="sm">
            <Text style={{ ...boldStyle, fontSize: '0.8rem' }}>{selectedGround.groundName}</Text>
            <Text size="xs" c="dimmed" style={{ cursor: 'pointer', textDecoration: 'underline' }} onClick={() => { setSelectedGround(null); setFileError(null); }}>CHANGE</Text>
          </Flex>
          <Text size="xs" c="dimmed">from {selectedGround.decisionName}</Text>
          <Text size="xs" style={{ fontStyle: 'italic', lineHeight: 1.4 }}>{selectedGround.description}</Text>
        </div>
      )}

      {/* Submit */}
      {fileError && (
        <Text size="xs" c="red" ta="center" style={boldStyle}>
          {fileError}
        </Text>
      )}
      <Button
        fullWidth
        color="red"
        variant="filled"
        disabled={!selectedGround || !targetRival || atLimit || !canAfford || filing}
        leftSection={<IconGavel size={14} />}
        onClick={handleFile}
      >
        {atLimit
          ? `LAWSUIT LIMIT REACHED (${maxLawsuits})`
          : !canAfford
          ? `NOT ENOUGH CASH ($${filingCost.toLocaleString()})`
          : filing
          ? 'FILING…'
          : `FILE LAWSUIT ($${filingCost.toLocaleString()})`}
      </Button>
      <Text size="xs" c="dimmed" style={{ fontStyle: 'italic', textAlign: 'center' }}>
        Filing charges the ${filingCost.toLocaleString()} fee instantly. The lawsuit itself
        resolves when this turn ends, along with your decisions.
      </Text>
    </Stack>
  );
}

// ============================================================
// CSS animations — urgent timer pulse, News row flash
// ============================================================

const styleTag = document.createElement('style');
styleTag.textContent = `
  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.5; }
  }
  @keyframes news-flash {
    0%, 100% { background-color: #fff; }
    50% { background-color: #fecaca; }
  }
`;
if (!document.querySelector('[data-gamephase-styles]')) {
  styleTag.setAttribute('data-gamephase-styles', 'true');
  document.head.appendChild(styleTag);
}
