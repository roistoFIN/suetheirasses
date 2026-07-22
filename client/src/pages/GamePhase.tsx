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
// produces no case, exactly the risk/reward FORMULAS.md's spec implies is possible.

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

function semaphoreLevel(p: number): 'green' | 'yellow' | 'red' {
  if (p < 0.15) return 'green';
  if (p < 0.4) return 'yellow';
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
 * The content of one "info window" — sued, a lawsuit verdict, a negotiated settlement, or
 * the round simply advancing. Each one is wrapped into a `NewsItem` (below) and appended
 * to the News box's list rather than popping up automatically — see the News box's own
 * doc comment for why this replaced the old auto-popping single-Modal queue.
 */
type PostTurnEvent =
  | { type: 'sued'; cases: LegalCaseData[] }
  | { type: 'verdict'; outcome: 'won' | 'lost'; cases: LegalCaseData[] }
  | { type: 'settlement'; cases: SettledCaseForMe[] }
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
    borderColor: tone === 'green' ? '#16a34a' : tone === 'yellow' ? '#f59e0b' : tone === 'red' ? '#dc2626' : 'var(--mantine-color-dark-8)',
    color: tone === 'green' ? '#15803d' : tone === 'yellow' ? '#b45309' : tone === 'red' ? '#b91c1c' : 'var(--mantine-color-dark-8)',
    background: tone === 'black' ? '#fff' : tone === 'green' ? '#f0fdf4' : tone === 'yellow' ? '#fefce8' : '#fef2f2',
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
        const won = newlyResolved.filter((r) => r.outcome === 'won').map((r) => r.case);
        const lost = newlyResolved.filter((r) => r.outcome === 'lost').map((r) => r.case);
        const newEvents: PostTurnEvent[] = [
          ...(newlySued.length > 0 ? [{ type: 'sued', cases: newlySued } as const] : []),
          ...(won.length > 0 ? [{ type: 'verdict', outcome: 'won', cases: won } as const] : []),
          ...(lost.length > 0 ? [{ type: 'verdict', outcome: 'lost', cases: lost } as const] : []),
          ...(newlySettled.length > 0 ? [{ type: 'settlement', cases: newlySettled } as const] : []),
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
        <Flex align="center" gap="sm">
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
            <Stack gap="sm">
              <Button variant="filled" color="dark" onClick={() => setDecisionDeckModalOpen(true)} style={{ ...boldStyle }}>
                MAKE IMPORTANT DECISIONS
              </Button>
              {myData.activeDecisions.length === 0 && pending.strategic.length === 0 && pending.operational.length === 0 ? (
                <Text c="dimmed" size="sm">No active decisions</Text>
              ) : (
                <Stack gap="sm">
                  {(['strategic', 'operational'] as const).flatMap((bucket) =>
                    pending[bucket].map((entry, i) => (
                      <QueuedDecisionCard
                        key={`${bucket}-${i}`}
                        name={entry.name}
                        targetName={entry.targetId ? (competitors.find((c) => c.playerId === entry.targetId)?.playerName ?? entry.targetId) : undefined}
                        onCancel={() => submitPending({ ...pending, [bucket]: pending[bucket].filter((e) => e.name !== entry.name) })}
                      />
                    )),
                  )}
                  {myData.activeDecisions.map((d) => (
                    <ActiveDecisionCard key={d.id} decision={d} />
                  ))}
                </Stack>
              )}
            </Stack>
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
              {myLegalCases.filter((c) => c.status !== 'resolved').length === 0 && pending.lawsuits.length === 0 ? (
                <Text c="dimmed" size="sm">No open lawsuits</Text>
              ) : (
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
                      />
                    ))}
                </Stack>
              )}
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
        {drillDown?.type === 'rival' && drillDown.data && (
          <RivalFullReportView
            rival={drillDown.data}
            prevRival={prevCompetitors.get(drillDown.data.playerId)}
            decisions={decisions}
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

      <Modal opened={sueModalOpen} onClose={() => { setSueModalOpen(false); setSueSuggestion(null); }} size="lg" centered title={<Text style={{ ...boldStyle, fontSize: '0.9rem' }}>📋 SUE THEIR ASSES</Text>}>
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
            <Stack gap="xs">
              {currentEvent.cases.map((c) => (
                <Box key={c.id} style={{ borderLeft: '3px solid var(--mantine-color-red-6)', paddingLeft: 8 }}>
                  <Text size="sm" fw={600}>
                    {playerNames.get(c.plaintiffId) ?? 'Unknown'} sued you over "{c.decisionName}"
                  </Text>
                  <Text size="sm" c="dimmed">
                    Ground: {c.groundName} — Stakes: {fmt(c.stakes)}
                  </Text>
                </Box>
              ))}
            </Stack>
            <Button fullWidth onClick={dismissCurrentEvent}>
              Close
            </Button>
          </Stack>
        )}

        {currentEvent?.type === 'verdict' && (
          <Stack gap="md">
            {(() => {
              // A 'won' event bundles every case that resolved 'won' for me this turn
              // (see detectNewlyResolvedCases) — almost always all-plaintiff or
              // all-defendant, but if a mixed batch ever happens, default to the
              // plaintiff-payout art rather than picking arbitrarily.
              const wonAsDefendantOnly = currentEvent.outcome === 'won' && currentEvent.cases.every((c) => c.plaintiffId !== player?.id);
              const src = currentEvent.outcome === 'lost'
                ? '/images/lawsuit-lost.png'
                : wonAsDefendantOnly ? '/images/defender-won.png' : '/images/lawsuit-won.png';
              const alt = currentEvent.outcome === 'lost' ? 'Case lost' : wonAsDefendantOnly ? 'Case dismissed' : 'Case won';
              return <Image src={src} alt={alt} radius="md" />;
            })()}
            <Stack gap="xs">
              {currentEvent.cases.map((c) => {
                const iAmPlaintiff = c.plaintiffId === player?.id;
                const opponentName = playerNames.get(iAmPlaintiff ? c.defendantId : c.plaintiffId) ?? 'Unknown';
                let outcomeLine: string;
                if (iAmPlaintiff && c.verdict === 'won') outcomeLine = `You received ${fmt(c.stakes)} from ${opponentName}`;
                else if (iAmPlaintiff && c.verdict === 'lost') outcomeLine = `You got nothing — the court sided with ${opponentName}`;
                else if (!iAmPlaintiff && c.verdict === 'won') outcomeLine = `You paid ${fmt(c.stakes)} to ${opponentName}`;
                else outcomeLine = `The case against you was dismissed — you paid nothing`;
                return (
                  <Box
                    key={c.id}
                    style={{ borderLeft: `3px solid var(--mantine-color-${currentEvent.outcome === 'won' ? 'green' : 'red'}-6)`, paddingLeft: 8 }}
                  >
                    <Text size="sm" fw={600}>
                      {iAmPlaintiff ? `You sued ${opponentName}` : `${opponentName} sued you`} over "{c.decisionName}"
                    </Text>
                    <Text size="sm" c="dimmed">
                      Ground: {c.groundName} — {outcomeLine}
                    </Text>
                  </Box>
                );
              })}
            </Stack>
            <Button fullWidth onClick={dismissCurrentEvent}>
              Close
            </Button>
          </Stack>
        )}

        {currentEvent?.type === 'settlement' && (
          <Stack gap="md">
            <Image src="/images/settlement-proposal.png" alt="Settlement reached" radius="md" />
            <Stack gap="xs">
              {currentEvent.cases.map(({ case: c, role }) => {
                const opponentName = playerNames.get(role === 'plaintiff' ? c.defendantId : c.plaintiffId) ?? 'Unknown';
                const lastOffer = c.offers[c.offers.length - 1]?.amount ?? c.stakes;
                const outcomeLine = role === 'plaintiff'
                  ? `Settled — you received ${fmt(lastOffer)} from ${opponentName}`
                  : `Settled — you paid ${fmt(lastOffer)} to ${opponentName}`;
                return (
                  <Box key={c.id} style={{ borderLeft: '3px solid var(--mantine-color-yellow-6)', paddingLeft: 8 }}>
                    <Text size="sm" fw={600}>
                      {role === 'plaintiff' ? `You sued ${opponentName}` : `${opponentName} sued you`} over "{c.decisionName}"
                    </Text>
                    <Text size="sm" c="dimmed">
                      Ground: {c.groundName} — {outcomeLine}
                    </Text>
                  </Box>
                );
              })}
            </Stack>
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

interface ActiveDecisionCardProps {
  decision: {
    id: string;
    decisionName: string;
    deployedYear: number;
    maturityYears: number;
    elapsedYears: number;
    isMatured: boolean;
  };
}

function ActiveDecisionCard({ decision }: ActiveDecisionCardProps) {
  const progress = decision.maturityYears > 0 ? Math.min(100, (decision.elapsedYears / decision.maturityYears) * 100) : 100;

  return (
    <div style={gpStyles.activeDecisionCard}>
      <Flex justify="space-between" align="center">
        <Stack gap={0}>
          <Text style={{ ...boldStyle, fontSize: '0.9rem' }}>{decision.decisionName}</Text>
          <Text size="xs" c="dimmed">Deployed Year {decision.deployedYear + 1} · {decision.isMatured ? 'MATURED' : `${Math.max(0, decision.maturityYears - decision.elapsedYears)} turns left`}</Text>
        </Stack>
        <Badge style={gpStyles.stamp(decision.isMatured ? 'green' : 'yellow')}>{decision.isMatured ? '✓ MATURED' : `${Math.round(progress)}%`}</Badge>
      </Flex>
      {/* Progress bar */}
      {!decision.isMatured && (
        <Box mt="sm" h={6} style={{ background: '#e5e7eb', borderRadius: 3 }}>
          <Box h="100%" style={{ width: `${progress}%`, background: '#fbbf24', borderRadius: 3, transition: 'width 0.3s ease' }} />
        </Box>
      )}
    </div>
  );
}

interface QueuedDecisionCardProps {
  name: string;
  /** Set when this decision targets a chosen opponent (e.g. Bot Attack) — resolved to a player name where possible. */
  targetName?: string;
  onCancel: () => void;
}

/** A decision the player has selected this turn but that hasn't been submitted/resolved
 * yet — shown alongside `ActiveDecisionCard` in the "Active Decisions" list so a queued
 * pick doesn't only appear inside the Decision Deck modal (MAKE IMPORTANT DECISIONS).
 * Deliberately a separate, lighter component rather than reusing `ActiveDecisionCard`: a
 * pending `SubmittedDecisionEntry` (`{ name, targetId? }`) has no `id`/maturity/
 * deployedYear yet — those only exist once the decision has actually been deployed by a
 * turn resolving. */
function QueuedDecisionCard({ name, targetName, onCancel }: QueuedDecisionCardProps) {
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
    </div>
  );
}

// ============================================================
// Sub-components — Decision Deck
// ============================================================

/**
 * Whether a decision needs a chosen opponent before it can be deployed. The
 * `requiresTarget` flag in game_engine.json is only actually set on Buy Shares, but
 * every decision with a `target.*` impact field (FORMULAS §0 — Patent Trolling, Talent
 * Poaching, Raw Material Monopoly, Union Agitation, Bot Attack, Reporting Rivals,
 * Social Astroturf, Fox Release, Slander Chief Executive Officer, Patent Portfolio)
 * routes its effect to a specific opponent just the same, so it needs the same picker.
 */
function decisionNeedsTarget(def: DecisionDefinition): boolean {
  return def.requiresTarget === true || Object.keys(def.impacts).some((field) => field.startsWith('target.'));
}

/** Mirrors DecisionEngine.canDeploy's exclusion rules (FORMULAS §9-§10) so the
 * client never offers a deploy the server would silently reject. */
function getDeployability(
  def: DecisionDefinition,
  activeDecisions: PlayerTurnResult['activeDecisions'],
  allDecisions: DecisionDefinition[],
): { blocked: boolean; reason?: string } {
  const existing = activeDecisions.filter((d) => d.decisionName === def.decision);
  if (existing.length > 0 && !existing[existing.length - 1].isMatured) {
    const last = existing[existing.length - 1];
    return { blocked: true, reason: `Still maturing — ${Math.max(0, last.maturityYears - last.elapsedYears)} turn(s) left` };
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

/** Max explicit numeric schedule key across all impacts — mirrors calcEngine's
 * calculateMaturityYears (FORMULAS §9): 0 = instant, re-selectable immediately. */
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

  const filtered = decisions.filter(
    (d) => (filterLevel === 'All' || d.level === filterLevel) && (filterNature === 'All' || d.nature === filterNature),
  );

  const togglePending = (def: DecisionDefinition, targetId?: string) => {
    const bucket = def.level === 'Strategic' ? 'strategic' : 'operational';
    const already = pending[bucket].some((e) => e.name === def.decision);
    onSubmitPending({
      ...pending,
      [bucket]: already
        ? pending[bucket].filter((e) => e.name !== def.decision)
        : [...pending[bucket], { name: def.decision, targetId }],
    });
  };

  return (
    <Stack gap="md">
      {/* Filter chips */}
      <Flex wrap="wrap" gap="xs">
        {['All', 'Strategic', 'Operational'].map((lvl) => (
          <Badge key={lvl} style={gpStyles.filterChip(filterLevel === lvl)} onClick={() => setFilterLevel(lvl)}>
            {lvl}
          </Badge>
        ))}
        {['All', 'Traditional', 'Grey Area', 'Dirty'].map((nat) => (
          <Badge key={nat} style={gpStyles.filterChip(filterNature === nat)} onClick={() => setFilterNature(nat)}>
            {nat}
          </Badge>
        ))}
      </Flex>

      {gameSettings && (
        <Text size="xs" c="dimmed" style={boldStyle}>
          {pending.strategic.length}/{gameSettings.maxStrategicDecisionsPerTurn} STRATEGIC · {pending.operational.length}/{gameSettings.maxOperationalDecisionsPerTurn} OPERATIONAL QUEUED
        </Text>
      )}

      {decisions.length === 0 ? (
        <Text c="dimmed" size="xs" style={{ fontStyle: 'italic' }}>Loading decision deck…</Text>
      ) : filtered.length === 0 ? (
        <Text c="dimmed" size="xs" style={{ fontStyle: 'italic' }}>No decisions match these filters.</Text>
      ) : (
        <Stack gap="sm" style={{ maxHeight: '60vh', overflowY: 'auto', paddingRight: 4 }}>
          {filtered.map((def) => {
            const bucket = def.level === 'Strategic' ? 'strategic' : 'operational';
            const isPending = pending[bucket].some((e) => e.name === def.decision);
            const atLimit = gameSettings
              ? pending[bucket].length >= (bucket === 'strategic' ? gameSettings.maxStrategicDecisionsPerTurn : gameSettings.maxOperationalDecisionsPerTurn)
              : false;
            const deployability = getDeployability(def, myData.activeDecisions, decisions);
            return (
              <DecisionCard
                key={def.decision}
                def={def}
                isPending={isPending}
                blocked={deployability}
                disabledByLimit={!isPending && atLimit}
                competitors={competitors}
                onToggle={(targetId) => togglePending(def, targetId)}
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
  onToggle: (targetId?: string) => void;
}

function DecisionCard({ def, isPending, blocked, disabledByLimit, competitors, onToggle }: DecisionCardProps) {
  const [targetId, setTargetId] = useState('');
  const [expanded, setExpanded] = useState(false);
  const needsTarget = decisionNeedsTarget(def);
  const deployDisabled = blocked.blocked || (!isPending && disabledByLimit) || (needsTarget && !isPending && !targetId);
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

      {/* Collapsed by default — expand to see the effects timeline + legal risk (FORMULAS §9) */}
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
          {competitors.map((c) => (<option key={c.playerId} value={c.playerId}>{c.playerName}</option>))}
        </select>
      )}
      <Button
        fullWidth
        size="xs"
        mt="sm"
        color={isPending ? 'gray' : 'dark'}
        variant={isPending ? 'outline' : 'filled'}
        disabled={deployDisabled}
        onClick={() => onToggle(needsTarget ? targetId : undefined)}
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
}

function CaseCard({ caseData, myPlayerId, playerNames, onRiskInfo, negotiationPeriodTurns, socket }: CaseCardProps) {
  const isDefendant = getCaseRole(caseData, myPlayerId) === 'defendant';
  const opponentName = getOpponentName(caseData, myPlayerId, playerNames);

  // The defendant always sees the odds. The plaintiff only sees them if they fully
  // "Dig Deeper"-investigated the underlying attack before suing over its exact
  // suggested ground — server-stamped onto the case at filing time, see CLAUDE.md.
  const knowsOdds = isDefendant || caseData.plaintiffFullyInvestigated;
  let displayProb = caseData.baseProbability;
  if (caseData.adjustedProbability !== undefined) {
    displayProb = caseData.adjustedProbability;
  }
  const sem = knowsOdds ? semaphoreLevel(displayProb) : null;

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
          <Box style={gpStyles.semaphoreChip('gray', false)} title="You don't know the odds on a case you filed — dig deeper to the end on the underlying attack before suing to reveal them.">
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
 * Whether the player has already sued the attacker over exactly the ground this attack's
 * hint card suggests, with a "correct" (non-zero win probability) case — once true, the
 * hint should stop nagging the player about an attack they've already acted on. Only ever
 * true from investigationLevel 3 onward: `suggestedGroundName`/`successProbability` don't
 * exist below that, and neither does the "SUE NOW" affordance this is meant to track the
 * outcome of. Deliberately scoped to the exact suggested ground, not "any lawsuit against
 * this attacker over this decision" — a manually-picked *different* ground for the same
 * attacking decision (via SueModal's own ground picker, not the SUE NOW shortcut) isn't
 * recognized as addressing this specific hint, since computing that ground's own win
 * probability client-side would mean re-implementing the admin-editable, DB-backed
 * formula evaluation this app deliberately keeps server-only (see CLAUDE.md's "Formulas
 * are DB-backed" section).
 *
 * Checks both `pendingLawsuits` (queued this turn, not yet resolved into a real case) and
 * `myLegalCases` (a real case already created from a prior turn's filing, any status) —
 * whichever the current game state actually has, since `pending.lawsuits` is cleared the
 * moment a real `LegalCaseData` exists.
 */
function isAttackAlreadySuedOver(
  attack: IncomingAttackInfo,
  pendingLawsuits: SubmittedDecisions['lawsuits'],
  myLegalCases: LegalCaseData[],
): boolean {
  if (!attack.attackerId || !attack.decisionName || !attack.suggestedGroundName) return false;
  if (!((attack.successProbability ?? 0) > 0)) return false;
  const matches = (targetId: string, decisionName: string, groundName: string) =>
    targetId === attack.attackerId && decisionName === attack.decisionName && groundName === attack.suggestedGroundName;
  return (
    pendingLawsuits.some((l) => matches(l.targetId, l.decisionName, l.groundName)) ||
    myLegalCases.some((c) => matches(c.defendantId, c.decisionName, c.groundName))
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
          { name: 'predicted', color: 'blue.6', strokeDasharray: '6 4', label: 'Predicted' },
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
 * arrows are derived by recomputing the same FORMULAS §4-§5 math against the previous
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
  // Starting cash = current cash - netProfit - depreciation (reverse of FORMULAS §5)
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

/** FORMULAS §5: equity = cash + receivables + assets + intangibleAssets + reserves - debt; marketEquity = max(0, equity - legalExposure). Shared by EquityView's current- and previous-turn calls, so the two totals' trend arrows are diffed against the same formula rather than a persisted field. */
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

// FORMULAS §7: risk = 100 * (w1*(ler/0.8) + w2*(scrutiny/100) + w3*(|outrage|/100))
const THREAT_W1 = 0.5, THREAT_W2 = 0.25, THREAT_W3 = 0.25;
const THREAT_LEGAL_EXPOSURE_RATIO_CAP = 0.8;

/** The three weighted terms behind the Threat Level gauge — shared by ThreatView's
 * current- and previous-turn calls so the total's trend arrow is diffed against the same
 * formula rather than a persisted field. */
function computeThreatTerms(v: PlayerVariables) {
  const ler = v.legalExposureRatio ?? 0;
  const legalTerm = THREAT_W1 * (ler / THREAT_LEGAL_EXPOSURE_RATIO_CAP) * 100;
  const scrutinyTerm = THREAT_W2 * (v.scrutiny / 100) * 100;
  const outrageTerm = THREAT_W3 * (Math.abs(v.outrage) / 100) * 100;
  return { ler, legalTerm, scrutinyTerm, outrageTerm };
}

function ThreatView({ data, prevData, onFieldClick }: ThreatViewProps) {
  const { variables: v } = data;
  const cur = computeThreatTerms(v);
  const prev = prevData ? computeThreatTerms(prevData.variables) : undefined;

  return (
    <Stack gap={0} style={gpStyles.modalContent}>
      <Text style={{ ...boldStyle, fontSize: '0.8rem', marginBottom: 12 }}>GLOBAL RISK GAUGE BREAKDOWN</Text>
      <ClickableStatRow label={`Legal exposure ratio (${(cur.ler * 100).toFixed(0)}%, weight 0.5)`} value={cur.legalTerm.toFixed(1)} trend={computeTrend(cur.legalTerm, prev?.legalTerm)} invert onClick={() => onFieldClick({ field: 'variables.legalExposureRatio', label: 'Legal exposure ratio' })} />
      <ClickableStatRow label="Scrutiny (weight 0.25)" value={cur.scrutinyTerm.toFixed(1)} trend={computeTrend(cur.scrutinyTerm, prev?.scrutinyTerm)} invert onClick={() => onFieldClick({ field: 'variables.scrutiny', label: 'Scrutiny' })} />
      <ClickableStatRow label="Outrage (weight 0.25)" value={cur.outrageTerm.toFixed(1)} trend={computeTrend(cur.outrageTerm, prev?.outrageTerm)} invert onClick={() => onFieldClick({ field: 'variables.outrage', label: 'Outrage' })} />

      <Divider my="xs" />
      <Flex justify="space-between" style={gpStyles.totalRow}>
        <Text style={{ fontSize: '0.85rem' }}>Threat level</Text>
        <Flex align="center" gap={4}>
          <Text style={{ fontSize: '0.95rem' }}>{Math.round(cur.legalTerm + cur.scrutinyTerm + cur.outrageTerm)}</Text>
          <TrendIcon
            trend={computeTrend(cur.legalTerm + cur.scrutinyTerm + cur.outrageTerm, prev ? prev.legalTerm + prev.scrutinyTerm + prev.outrageTerm : undefined)}
            invert
            size={13}
          />
        </Flex>
      </Flex>

      <Text size="xs" c="dimmed" style={{ fontStyle: 'italic', marginTop: 8 }}>
        Legal exposure carries the most weight — it's also the one thing that snowballs, since it makes every open case more likely to succeed too.
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

  // FORMULAS §6: adjustedProbability = baseProbability * (1 + scrutinyFactor + legalExposureRatio)
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

function RivalFullReportView({ rival, prevRival, decisions, onFieldClick }: RivalFullReportViewProps) {
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
      <Stack gap={0}>
        <Flex justify="space-between" align="center" style={{ marginBottom: 8 }}>
          <Text style={{ ...boldStyle, fontSize: '0.75rem', color: '#6b7280' }}>ANNUAL REPORT</Text>
          {aiEntries && <Text size="xs" c="dimmed" style={{ fontStyle: 'italic' }}>✨ AI-generated</Text>}
        </Flex>
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
      <Text size="xs" c="dimmed" style={{ fontStyle: 'italic' }}>
        Production-level detail (volume, recipe, processes) isn't visible to rivals — only the official filing above.
      </Text>
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
}

function SueModal({ competitors, decisions, gameSettings, pending, onSubmitPending, prefillTargetId, prefillDecisionName, prefillGroundName, cash, socket }: SueModalProps) {
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

  const handleRemoveQueued = (index: number) => {
    onSubmitPending({ ...pending, lawsuits: pending.lawsuits.filter((_, i) => i !== index) });
  };

  return (
    <Stack gap="md">
      {gameSettings && (
        <Text size="xs" c="dimmed" style={boldStyle}>
          {pending.lawsuits.length}/{maxLawsuits} LAWSUITS QUEUED THIS TURN
        </Text>
      )}

      {pending.lawsuits.length > 0 && (
        <Stack gap={4}>
          {pending.lawsuits.map((l, i) => {
            const t = competitors.find((c) => c.playerId === l.targetId);
            return (
              <Flex key={i} justify="space-between" align="center" style={{ padding: '6px 10px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 6 }}>
                <Text size="xs">{t?.playerName ?? l.targetId} — {l.groundName}</Text>
                <Text size="xs" c="red" style={{ cursor: 'pointer', textDecoration: 'underline' }} title="The filing fee already charged is not refunded" onClick={() => handleRemoveQueued(i)}>Remove</Text>
              </Flex>
            );
          })}
        </Stack>
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
