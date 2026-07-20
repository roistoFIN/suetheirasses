import React, { useEffect, useState } from 'react';
import type { Socket } from 'socket.io-client';
import {
  Modal, Stack, Text, Badge, Button, Flex, TextInput,
  Slider, Divider, Box,
} from '@mantine/core';
import { useGameStore } from '../stores/gameStore';
import { useSocketStore } from '../stores/socketStore';
import {
  ServerEvents, ClientEvents,
  type PlayerTurnResult, type LegalCaseData,
  type DecisionDefinition, type GameSettings, type SubmittedDecisions,
  type IncomingAttackInfo,
} from '@suetheirasses/shared';
import {
  IconClock, IconFileText,
  IconTrendingUp, IconTrendingDown, IconSearch, IconGavel,
  IconHelpCircle, IconLock, IconCheck, IconSwords, IconChevronDown,
  IconShield,
} from '@tabler/icons-react';

// ============================================================
// Types & Constants
// ============================================================
//
// Note: there is no fixed catalog of lawsuit grounds — every decision's `legalRisks`
// in game_engine.json is a potential ground the moment someone actually deploys that
// decision. See getGroundsAgainst() near SueModal, which derives grounds live from a
// target's real activeDecisions instead of a hardcoded list.

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

const semColors: Record<string, { bg: string; chipBg: string; chipBorder: string; textColor: string }> = {
  green: { bg: '#22c55e', chipBg: '#dcfce7', chipBorder: '#22c55e', textColor: '#15803d' },
  yellow: { bg: '#fbbf24', chipBg: '#fef3c7', chipBorder: '#f59e0b', textColor: '#b45309' },
  red: { bg: '#ef4444', chipBg: '#fee2e2', chipBorder: '#ef4444', textColor: '#b91c1c' },
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

// ============================================================
// Styles — WarRoomDashboard aesthetic (stamps, thick borders, shadows),
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

  semaphoreChip: (level: string): React.CSSProperties => {
    const colors = semColors[level];
    return {
      display: 'flex',
      alignItems: 'center',
      gap: 4,
      padding: '4px 10px',
      borderRadius: 9999,
      border: `2px solid ${colors.chipBorder}`,
      background: colors.chipBg,
      cursor: 'pointer',
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

  stamp: (tone: string): React.CSSProperties => ({
    display: 'inline-block',
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
  const { player, turnResults, timer, currentPhase, updateTimer, decisions, gameSettings } = useGameStore();
  const [myData, setMyData] = useState<PlayerTurnResult | null>(null);
  const [competitors, setCompetitors] = useState<PlayerTurnResult[]>([]);
  // Previous turn's snapshot — kept only to compute the "since last turn" trend arrows
  // on KPI cards and competitor intel; null/empty until a second turn has resolved.
  const [prevData, setPrevData] = useState<PlayerTurnResult | null>(null);
  const [prevCompetitors, setPrevCompetitors] = useState<Map<string, PlayerTurnResult>>(new Map());
  const [localTimer, setLocalTimer] = useState(timer);
  const [drillDown, setDrillDown] = useState<{ type: string; data?: PlayerTurnResult; field?: string } | null>(null);
  const [sueModalOpen, setSueModalOpen] = useState(false);
  // Set when a player jumps into the Sue flow via a fully-investigated attack's
  // "SUE NOW" shortcut — pre-fills SueModal's target + ground, still requires the
  // player's own "QUEUE LAWSUIT" confirmation click.
  const [sueSuggestion, setSueSuggestion] = useState<{ targetId: string; groundName: string } | null>(null);
  const [riskInfoCase, setRiskInfoCase] = useState<LegalCaseData | null>(null);
  const [loading, setLoading] = useState(true);

  // Pending decisions + lawsuits for this turn — shared between the Decision Deck and
  // the Sue modal, since both contribute to the same game:submitDecisions payload
  // (each submission is a full replacement, not an increment).
  const [pending, setPending] = useState<SubmittedDecisions>({ strategic: [], operational: [], lawsuits: [] });
  const submitPending = (next: SubmittedDecisions) => {
    setPending(next);
    socket?.emit(ClientEvents.GAME_SUBMIT_DECISIONS, next);
  };

  // Sync from store on turn resolution. Capture the outgoing values as "previous"
  // before overwriting, so KPI/intel trend arrows have something to compare against.
  useEffect(() => {
    if (!turnResults || !player) return;
    const myPlayer = turnResults.players.find((p) => p.playerId === player.id);
    if (myPlayer) {
      setMyData((current) => {
        setPrevData(current);
        return myPlayer;
      });
      const newCompetitors = turnResults.players.filter((p) => p.playerId !== player.id);
      setCompetitors((current) => {
        setPrevCompetitors(new Map(current.map((c) => [c.playerId, c])));
        return newCompetitors;
      });
      setLoading(false);
    }
  }, [turnResults, player]);

  // A new round means the server already cleared last turn's submissions — reset
  // local pending state so stale QUEUED badges don't linger on the new turn.
  useEffect(() => {
    setPending({ strategic: [], operational: [], lawsuits: [] });
  }, [turnResults?.round]);

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

  return (
    <div style={gpStyles.dashboard}>
      {/* ── Header ─────────────────────────────────────── */}
      <Flex justify="space-between" align="center" wrap="wrap" gap="sm" style={gpStyles.header}>
        <Text style={gpStyles.title}>{myData.playerName}</Text>
        <RiskGaugeBar value={riskGauge} seconds={localTimer} urgent={isUrgent} onClick={() => setDrillDown({ type: 'threat' })} />
      </Flex>

      {/* ── KPI Cards ──────────────────────────────────── */}
      <Flex wrap="wrap" gap="sm" style={gpStyles.kpiGrid}>
        <KpiCard label="CASH" value={fmt(vars.cash)} negative={vars.cash < 0} trend={computeTrend(vars.cash, prevData?.variables.cash)} onClick={() => setDrillDown({ type: 'cash', data: myData })} />
        <KpiCard label="EQUITY" value={fmt(derived.equity)} trend={computeTrend(derived.equity, prevData?.derived.equity)} onClick={() => setDrillDown({ type: 'equity', data: myData })} />
        <KpiCard label="REVENUE" value={fmt(derived.revenue)} trend={computeTrend(derived.revenue, prevData?.derived.revenue)} onClick={() => setDrillDown({ type: 'revenue', data: myData })} />
        <KpiCard label="STOCK VALUE" value={fmt(derived.stockValue)} trend={computeTrend(derived.stockValue, prevData?.derived.stockValue)} onClick={() => setDrillDown({ type: 'shares', data: myData })} />
      </Flex>

      {/* ── Two-column layout: Decisions | Legal ──────── */}
      <Flex wrap="wrap" gap="md">
        {/* Left column */}
        <Stack gap="md" style={{ flex: 1, minWidth: 320 }}>
          <SectionCard title="Active Strategies">
            {myData.activeDecisions.length === 0 ? (
              <Text c="dimmed" size="sm">No active strategies</Text>
            ) : (
              <Stack gap="sm">
                {myData.activeDecisions.map((d) => (
                  <ActiveDecisionCard key={d.id} decision={d} />
                ))}
              </Stack>
            )}
          </SectionCard>

          <SectionCard title="Decision Deck">
            <DecisionDeckView decisions={decisions} gameSettings={gameSettings} myData={myData} competitors={competitors} pending={pending} onSubmitPending={submitPending} />
          </SectionCard>
        </Stack>

        {/* Right column */}
        <Stack gap="md" style={{ flex: 1, minWidth: 320 }}>
          <SectionCard title={`Open Lawsuits (${myLegalCases.filter((c) => c.status !== 'resolved').length})`}>
            <Stack gap="sm">
              <IncomingAttackHints
                attacks={myData.incomingAttacks}
                cash={vars.cash}
                digDeeperCost={gameSettings?.digDeeperCost ?? 10000}
                socket={socket}
                onSueNow={(targetId, groundName) => {
                  setSueSuggestion({ targetId, groundName });
                  setSueModalOpen(true);
                }}
              />
              <Button variant="filled" color="red" leftSection={<IconSwords size={16} />} onClick={() => setSueModalOpen(true)} style={{ ...boldStyle }}>
                📋 SUE THEIR ASSES
              </Button>
              {myLegalCases.filter((c) => c.status !== 'resolved').length === 0 ? (
                <Text c="dimmed" size="sm">No open lawsuits</Text>
              ) : (
                <Stack gap="sm">
                  {myLegalCases
                    .filter((c) => c.status !== 'resolved')
                    .map((c) => (
                      <CaseCard
                        key={c.id}
                        caseData={c}
                        myPlayerId={myData.playerId}
                        playerNames={playerNames}
                        onInspect={(rivalName) => {
                          const rival = competitors.find((rp) => rp.playerName === rivalName);
                          if (rival) setDrillDown({ type: 'rival', data: rival });
                        }}
                        onRiskInfo={(caseItem) => setRiskInfoCase(caseItem)}
                      />
                    ))}
                </Stack>
              )}
            </Stack>
          </SectionCard>

          {competitors.length > 0 && (
            <SectionCard title="Competitor Intel">
              <RivalList rivals={competitors} prevRivals={prevCompetitors} onFullReport={(r) => setDrillDown({ type: 'rival', data: r })} onFieldClick={(r, field) => setDrillDown({ type: 'rival-field', data: r, field })} />
            </SectionCard>
          )}
        </Stack>
      </Flex>

      {/* ── Modals ─────────────────────────────────────── */}
      <Modal opened={drillDown !== null} onClose={() => setDrillDown(null)} size="lg" centered overlayProps={{ opacity: 0.55, color: 'var(--mantine-color-dark-9)' }}>
        {drillDown?.type === 'cash' && myData && <CashWaterfallView data={myData} />}
        {drillDown?.type === 'revenue' && myData && <RevenueView data={myData} />}
        {drillDown?.type === 'equity' && myData && <EquityView data={myData} />}
        {drillDown?.type === 'shares' && myData && <ShareView data={myData} rivals={competitors} />}
        {drillDown?.type === 'threat' && myData && <ThreatView data={myData} />}
        {drillDown?.type === 'rival' && drillDown.data && <RivalFullReportView rival={drillDown.data} decisions={decisions} />}
        {drillDown?.type === 'rival-field' && drillDown.data && drillDown.field && (
          <RivalFieldView rival={drillDown.data} field={drillDown.field} />
        )}
      </Modal>

      <Modal opened={sueModalOpen} onClose={() => { setSueModalOpen(false); setSueSuggestion(null); }} size="lg" centered title={<Text style={{ ...boldStyle, fontSize: '0.9rem' }}>📋 SUE THEIR ASSES</Text>}>
        <SueModal
          competitors={competitors}
          decisions={decisions}
          gameSettings={gameSettings}
          pending={pending}
          onSubmitPending={submitPending}
          prefillTargetId={sueSuggestion?.targetId}
          prefillGroundName={sueSuggestion?.groundName}
        />
      </Modal>

      <Modal opened={riskInfoCase !== null} onClose={() => setRiskInfoCase(null)} size="md" centered title={<Text style={{ ...boldStyle, fontSize: '0.85rem' }}>⚠️ RISK BREAKDOWN</Text>}>
        {riskInfoCase && <RiskBreakdownView caseData={riskInfoCase} vars={vars} />}
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
        {trend === 'up' && <IconTrendingUp size={16} style={{ color: '#16a34a' }} title="Up since last turn" />}
        {trend === 'down' && <IconTrendingDown size={16} style={{ color: '#dc2626' }} title="Down since last turn" />}
      </Flex>
    </Box>
  );
}

// ============================================================
// Sub-components — Risk Gauge Bar
// ============================================================

interface RiskGaugeBarProps {
  value: number;
  seconds: number;
  urgent?: boolean;
  onClick: () => void;
}

function RiskGaugeBar({ value, seconds, urgent, onClick }: RiskGaugeBarProps) {
  const pctVal = Math.max(0, Math.min(100, value));
  const critical = pctVal >= 70;
  const color = pctVal < 35 ? '#22c55e' : pctVal < 70 ? '#fbbf24' : '#ef4444';

  return (
    <Box style={{ ...gpStyles.sectionCard, cursor: 'pointer', maxWidth: 480 }} onClick={onClick}>
      <Flex justify="space-between" align="center">
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
        </Flex>
        <Badge variant="light" color={urgent ? 'red' : 'dark'} style={{ ...boldStyle, ...(urgent && { animation: 'pulse 1s infinite' }) }}>
          <Flex align="center" gap={4}><IconClock size={14} />{String(Math.floor(seconds / 60)).padStart(2, '0')}:{String(seconds % 60).padStart(2, '0')}</Flex>
        </Badge>
      </Flex>
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
  onInspect: (rivalName: string) => void;
  onRiskInfo: (caseItem: LegalCaseData) => void;
}

function CaseCard({ caseData, myPlayerId, playerNames, onInspect, onRiskInfo }: CaseCardProps) {
  const isDefendant = getCaseRole(caseData, myPlayerId) === 'defendant';
  const opponentName = getOpponentName(caseData, myPlayerId, playerNames);

  // Calculate display probability for defendant cases
  let displayProb = caseData.baseProbability;
  if (isDefendant && caseData.adjustedProbability !== undefined) {
    displayProb = caseData.adjustedProbability;
  }
  const sem = isDefendant ? semaphoreLevel(displayProb) : null;

  return (
    <div style={gpStyles.caseCard}>
      {/* Header row */}
      <Flex justify="space-between" align="flex-start" gap="sm">
        <Stack gap={4}>
          <Badge style={gpStyles.stamp('black')}>{isDefendant ? 'DEFENDANT' : 'PLAINTIFF'}</Badge>
          <Text style={{ ...boldStyle, fontSize: '0.95rem' }}>{opponentName}</Text>
          <Text size="xs" c="dimmed">{caseData.decisionName} — {caseData.groundName}</Text>
        </Stack>
        {isDefendant && sem && (
          <Box style={gpStyles.semaphoreChip(sem)} onClick={() => onRiskInfo(caseData)}>
            <Box h={8} w={8} style={{ background: semColors[sem].bg, borderRadius: '50%' }} />
            <Text style={{ fontWeight: 900 }}>{Math.round(displayProb * 100)}%</Text>
          </Box>
        )}
        {!isDefendant && (
          <Button variant="outline" size="xs" leftSection={<IconHelpCircle size={12} />} onClick={() => onInspect(opponentName)}>
            Investigate
          </Button>
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
          {/* Offer history */}
          {caseData.offers.length > 0 && (
            <Flex wrap="wrap" gap={4}>
              {caseData.offers.map((o, i) => (
                <Badge key={i} variant="light">{o.by === 'me' ? 'You' : 'Them'}: {fmt(o.amount)}</Badge>
              ))}
            </Flex>
          )}
          {/* Counter offer slider */}
          <div style={gpStyles.sliderContainer}>
            <Text style={{ ...boldStyle, fontSize: '0.7rem', color: '#6b7280', marginBottom: 8 }}>YOUR COUNTER</Text>
            <CounterOfferSlider caseData={caseData} />
          </div>
          {/* Accept / Court buttons */}
          <Flex gap="sm">
            <Button flex={1} size="xs" color="green" leftSection={<IconCheck size={13} />} disabled={!caseData.offers.some((o) => o.by === 'them')}>
              ACCEPT {fmt(caseData.offers.filter((o) => o.by === 'them').at(-1)?.amount ?? 0)}
            </Button>
            <Button flex={1} size="xs" color="red" leftSection={<IconSwords size={13} />} variant="filled">
              COURT
            </Button>
          </Flex>
        </Stack>
      )}
    </div>
  );
}

interface CounterOfferSliderProps {
  caseData: LegalCaseData;
}

function CounterOfferSlider({ caseData }: CounterOfferSliderProps) {
  const [slider, setSlider] = useState(caseData.myOffer ?? Math.round(caseData.stakes * 0.5));
  const lastTheirOffer = [...caseData.offers].reverse().find((o) => o.by === 'them')?.amount ?? Math.round(caseData.stakes * 0.1);
  const maxOffer = caseData.offers.length === 0 ? caseData.stakes : Math.max(...caseData.offers.map((o) => o.amount));

  return (
    <Flex align="center" gap="sm">
      <Slider flex={1} min={lastTheirOffer} max={maxOffer} step={500} value={slider} onChange={setSlider} color="#dc2626" />
      <Text style={{ ...boldStyle, fontSize: '0.8rem', minWidth: 70, textAlign: 'right' }}>{fmt(slider)}</Text>
    </Flex>
  );
}

// ============================================================
// Sub-components — Incoming Attack Hints
// ============================================================

interface IncomingAttackHintsProps {
  attacks: IncomingAttackInfo[];
  cash: number;
  digDeeperCost: number;
  socket: Socket | null;
  onSueNow: (targetId: string, groundName: string) => void;
}

function IncomingAttackHints({ attacks, cash, digDeeperCost, socket, onSueNow }: IncomingAttackHintsProps) {
  if (attacks.length === 0) return null;
  return (
    <Stack gap={6}>
      {attacks.map((attack) => (
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
  onSueNow: (targetId: string, groundName: string) => void;
}) {
  const fullyInvestigated = attack.investigationLevel >= 3;
  const canAfford = cash >= digDeeperCost;
  const headline = attack.attackerName ? `⚠️ ${attack.attackerName} did something to you.` : '⚠️ Somebody did something to you.';

  return (
    <div style={{ padding: 10, border: '3px solid #ea580c', borderRadius: 8, background: '#fff7ed' }}>
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
        <Box style={{ marginTop: 8, padding: 8, background: '#fff', border: '1px solid #fed7aa', borderRadius: 6 }}>
          <Text style={{ ...boldStyle, fontSize: '0.75rem' }}>Suggested: {attack.suggestedGroundName}</Text>
          <Text size="xs" c="dimmed" style={{ lineHeight: 1.4 }}>{attack.suggestedGroundDescription}</Text>
          <Text size="xs" style={{ marginTop: 4 }}>Estimated success: <strong>{Math.round((attack.successProbability ?? 0) * 100)}%</strong></Text>
          <Button
            size="xs"
            color="red"
            fullWidth
            mt={6}
            leftSection={<IconGavel size={12} />}
            onClick={() => onSueNow(attack.attackerId!, attack.suggestedGroundName!)}
          >
            SUE NOW
          </Button>
        </Box>
      )}

      {!fullyInvestigated && (
        <Button
          size="xs"
          variant="outline"
          color="orange"
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
  onFieldClick: (rival: PlayerTurnResult, field: string) => void;
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
  onFieldClick: (rival: PlayerTurnResult, field: string) => void;
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
            <MiniStatButton label="CASH" value={fmt(v.cash)} trend={computeTrend(v.cash, prevRival?.variables.cash)} onClick={() => onFieldClick(rival, 'cash')} />
            <MiniStatButton label="REVENUE" value={fmt(d.revenue)} trend={computeTrend(d.revenue, prevRival?.derived.revenue)} onClick={() => onFieldClick(rival, 'revenue')} />
            <MiniStatButton label="EQUITY" value={fmt(d.equity)} trend={computeTrend(d.equity, prevRival?.derived.equity)} onClick={() => onFieldClick(rival, 'equity')} />
            <MiniStatButton label="STOCK VALUE" value={fmt(d.stockValue)} trend={computeTrend(d.stockValue, prevRival?.derived.stockValue)} onClick={() => onFieldClick(rival, 'stockValue')} />
            <MiniStatButton label="DEBT" value={fmt(v.debt)} trend={computeTrend(v.debt, prevRival?.variables.debt)} invert onClick={() => onFieldClick(rival, 'debt')} />
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
  const isGood = trend === 'up' ? !invert : trend === 'down' ? invert : undefined;
  const arrowColor = isGood === undefined ? undefined : isGood ? '#16a34a' : '#dc2626';

  return (
    <Box style={gpStyles.rivalMiniStat} onClick={onClick}>
      <Text style={{ fontSize: '0.65rem', color: '#6b7280' }}>{label}</Text>
      <Flex align="center" gap={4}>
        <Text style={{ ...boldStyle, fontSize: '0.75rem' }}>{value}</Text>
        {trend === 'up' && <IconTrendingUp size={12} style={{ color: arrowColor }} title="Up since last turn" />}
        {trend === 'down' && <IconTrendingDown size={12} style={{ color: arrowColor }} title="Down since last turn" />}
      </Flex>
    </Box>
  );
}

// ============================================================
// Drill-down Modal Views
// ============================================================

// ── Cash Waterfall View ────────────────────────────────

interface CashWaterfallViewProps {
  data: PlayerTurnResult;
}

function CashWaterfallView({ data }: CashWaterfallViewProps) {
  const { variables: v, derived: d } = data;

  // FORMULAS §4-§5: Build waterfall showing how cash changed this turn
  const cogs = (v.materialCostPerTon + v.logisticsCostPerTon) * (d.volume || 0);
  const grossProfit = d.revenue - cogs;
  const ebitda = grossProfit - v.operatingExpenses - v.staffCost + v.otherIncome;
  const ebit = ebitda - d.depreciation;
  const financeCost = d.financeCost || 0;
  const profitBeforeTax = ebit - financeCost;
  const taxCost = d.taxCost || 0;
  const netProfit = profitBeforeTax - taxCost;
  // Starting cash = current cash - netProfit - depreciation (reverse of FORMULAS §5)
  const startingCash = v.cash - netProfit - d.depreciation;

  const rows = [
    { label: 'Revenue', value: d.revenue, type: 'plus' as const },
    { label: 'COGS (material + logistics × volume)', value: -cogs, type: 'minus' as const },
    { label: 'Gross profit', value: grossProfit, type: undefined },
    { label: 'Operating expenses', value: -v.operatingExpenses, type: 'minus' as const },
    { label: 'Staff costs', value: -v.staffCost, type: 'minus' as const },
    { label: 'Other income', value: v.otherIncome, type: 'plus' as const },
    { label: 'EBITDA', value: ebitda, type: undefined },
    { label: 'Depreciation', value: -d.depreciation, type: 'minus' as const },
    { label: 'EBIT', value: ebit, type: undefined },
    { label: 'Finance cost', value: -financeCost, type: 'minus' as const },
    { label: 'Profit before tax', value: profitBeforeTax, type: undefined },
    { label: 'Tax', value: -taxCost, type: 'minus' as const },
    { label: 'Net profit', value: netProfit, type: 'plus' as const },
    { label: 'Depreciation (non-cash add-back)', value: d.depreciation, type: 'plus' as const },
  ];

  let running = startingCash;
  return (
    <Stack gap={0} style={gpStyles.modalContent}>
      <Text style={{ ...boldStyle, fontSize: '0.8rem', marginBottom: 12 }}>CASH WATERFALL</Text>
      {rows.map((row, i) => {
        running += row.value;
        return (
          <Flex justify="space-between" align="center" key={i} style={gpStyles.statRow(row.type === 'minus' ? 'minus' : row.type === 'plus' ? 'plus' : undefined)}>
            <Text size="sm">{row.label}</Text>
            <Text style={{ ...boldStyle, fontSize: '0.85rem' }}>{fmt(row.value)}</Text>
          </Flex>
        );
      })}
      <Divider my="xs" />
      <Flex justify="space-between" align="center" style={gpStyles.totalRow}>
        <Text style={{ fontSize: '0.85rem' }}>Cash now</Text>
        <Text style={{ fontSize: '0.95rem' }}>{fmt(v.cash)}</Text>
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
}

function RevenueView({ data }: RevenueViewProps) {
  const { variables: v, derived: d } = data;

  const volume = d.volume || 0;
  const price = v.price;
  const revenue = d.revenue;

  return (
    <Stack gap="md" style={gpStyles.modalContent}>
      <Text style={{ ...boldStyle, fontSize: '0.8rem', marginBottom: 12 }}>REVENUE BREAKDOWN</Text>
      <Flex justify="space-between" style={gpStyles.statRow()}>
        <Text size="sm">Volume</Text><Text style={boldStyle}>{volume.toFixed(0)} t</Text>
      </Flex>
      <Flex justify="space-between" style={gpStyles.statRow()}>
        <Text size="sm">× Price</Text><Text style={boldStyle}>{fmt(price)} /t</Text>
      </Flex>
      <Divider my="xs" />
      <Flex justify="space-between" style={gpStyles.totalRow}>
        <Text style={{ fontSize: '0.85rem' }}>Revenue</Text>
        <Text style={{ fontSize: '0.95rem' }}>{fmt(revenue)}</Text>
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
}

function EquityView({ data }: EquityViewProps) {
  const { variables: v, derived: d } = data;

  // FORMULAS §5: equity = cash + receivables + assets + intangibleAssets + reserves - debt
  const bookEquity = v.cash + d.receivables + v.assets + v.intangibleAssets + v.reserves - v.debt;
  const LEGAL_EXPOSURE = v.legalExposure ?? 0;
  // FORMULAS §5: marketEquity = max(0, equity - legalExposure)
  const MARKET_EQUITY = Math.max(0, bookEquity - LEGAL_EXPOSURE);

  return (
    <Stack gap={0} style={gpStyles.modalContent}>
      <Text style={{ ...boldStyle, fontSize: '0.8rem', marginBottom: 12 }}>BALANCE SHEET</Text>
      <Flex justify="space-between" style={gpStyles.statRow('plus')}>
        <Text size="sm">Cash</Text><Text style={boldStyle}>{fmt(v.cash)}</Text>
      </Flex>
      <Flex justify="space-between" style={gpStyles.statRow('plus')}>
        <Text size="sm">Receivables</Text><Text style={boldStyle}>{fmt(d.receivables)}</Text>
      </Flex>
      <Flex justify="space-between" style={gpStyles.statRow('plus')}>
        <Text size="sm">Assets</Text><Text style={boldStyle}>{fmt(v.assets)}</Text>
      </Flex>
      <Flex justify="space-between" style={gpStyles.statRow('plus')}>
        <Text size="sm">Intangible assets</Text><Text style={boldStyle}>{fmt(v.intangibleAssets)}</Text>
      </Flex>
      <Flex justify="space-between" style={gpStyles.statRow('plus')}>
        <Text size="sm">Reserves</Text><Text style={boldStyle}>{fmt(v.reserves)}</Text>
      </Flex>
      <Flex justify="space-between" style={gpStyles.statRow('minus')}>
        <Text size="sm">Debt</Text><Text style={boldStyle}>-{fmt(v.debt)}</Text>
      </Flex>

      <Divider my="xs" />
      <Flex justify="space-between" style={gpStyles.totalRow}>
        <Text style={{ fontSize: '0.85rem' }}>Equity (book value)</Text>
        <Text style={{ fontSize: '0.95rem' }}>{fmt(bookEquity)}</Text>
      </Flex>

      {/* Market equity */}
      <Stack gap={0} mt="md" pt="md" style={{ borderTop: '1px solid var(--mantine-color-gray-2)' }}>
        <Flex justify="space-between" style={gpStyles.statRow('minus')}>
          <Text size="sm">Legal exposure (discount)</Text><Text style={boldStyle}>-{fmt(LEGAL_EXPOSURE)}</Text>
        </Flex>
        <Flex justify="space-between" style={gpStyles.totalRow}>
          <Text style={{ fontSize: '0.85rem' }}>Market equity (stock price basis)</Text>
          <Text style={{ fontSize: '0.95rem' }}>{fmt(MARKET_EQUITY)}</Text>
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
}

function ShareView({ data, rivals }: ShareViewProps) {
  const { variables: v, derived: d } = data;
  const outrageDemandWeight = 0.5;

  // Build market share visualization with rivals
  const allPlayers = [data, ...(rivals || [])];
  const totalMarketShare = allPlayers.reduce((sum, p) => sum + (p.derived.marketShare || 0), 0) || 1;

  return (
    <Stack gap="md" style={gpStyles.modalContent}>
      <Text style={{ ...boldStyle, fontSize: '0.8rem', marginBottom: 12 }}>SHARE VALUE FACTORS</Text>

      {/* Factor grid */}
      <Flex wrap="wrap" gap="xs">
        {[
          { label: 'PRICE (LOWER = BETTER)', value: `${fmt(v.price)}/t` },
          { label: 'PROCESSING LEVEL', value: pct(v.processingLevel) },
          { label: 'SUPPLY SECURITY', value: pct(v.supplySecurity) },
          { label: 'PROCESS LOSS (LOWER = BETTER)', value: pct(v.processLoss) },
        ].map((f) => (
          <Box key={f.label} p="sm" style={{ background: 'var(--mantine-color-gray-1)', border: '1px solid var(--mantine-color-gray-3)', borderRadius: 'var(--mantine-radius-sm)', flex: '1 1 45%' }}>
            <Text style={{ fontSize: '0.65rem', color: '#6b7280' }}>{f.label}</Text>
            <Text style={{ ...boldStyle, fontSize: '0.8rem' }}>{f.value}</Text>
          </Box>
        ))}
      </Flex>

      {/* Demand breakdown */}
      <div style={{ padding: '12px', background: 'var(--mantine-color-gray-1)', border: '1px solid var(--mantine-color-gray-3)', borderRadius: 'var(--mantine-radius-sm)' }}>
        <Text style={{ ...boldStyle, fontSize: '0.7rem', marginBottom: 8 }}>DEMAND BREAKDOWN</Text>
        <Flex justify="space-between" style={gpStyles.statRow()}>
          <Text size="xs">Marketing demand</Text><Text size="xs">{v.demand} pts</Text>
        </Flex>
        <Flex justify="space-between" style={gpStyles.statRow('minus')}>
          <Text size="xs">Outrage penalty ({v.outrage} × {outrageDemandWeight})</Text><Text size="xs">-{Math.round(outrageDemandWeight * v.outrage)} pts</Text>
        </Flex>
        <Divider my="xs" />
        <Flex justify="space-between" style={gpStyles.totalRow}>
          <Text style={{ fontSize: '0.75rem' }}>Net demand</Text>
          <Text style={{ fontSize: '0.8rem' }}>{Math.round(v.demand - outrageDemandWeight * v.outrage)} pts</Text>
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
            return (
              <Flex key={p.playerId} align="center" gap={4}>
                <Box h={8} w={8} style={{ background: color, borderRadius: '50%' }} />
                <Text size="xs">{p.playerName} {pct(share)}</Text>
              </Flex>
            );
          })}
        </Flex>
      </div>

      {/* Capacity cap */}
      <div style={{ padding: '12px', background: 'var(--mantine-color-gray-1)', border: '1px solid var(--mantine-color-gray-3)', borderRadius: 'var(--mantine-radius-sm)' }}>
        <Text style={{ ...boldStyle, fontSize: '0.7rem', marginBottom: 4 }}>CAPACITY CAP</Text>
        <Text size="sm">Installed capacity {v.installedCapacity?.toFixed(0)}t × {(v.capacityUtilization * 100).toFixed(0)}% utilization = {(v.installedCapacity * v.capacityUtilization)?.toFixed(0)}t ceiling</Text>
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
}

function ThreatView({ data }: ThreatViewProps) {
  const { variables: v } = data;

  // FORMULAS §7: risk = 100 * (w1*(ler/0.8) + w2*(scrutiny/100) + w3*(|outrage|/100))
  const w1 = 0.5, w2 = 0.25, w3 = 0.25;
  const legalExposureRatioCap = 0.8;
  const ler = v.legalExposureRatio ?? 0;
  const legalTerm = w1 * (ler / legalExposureRatioCap) * 100;
  const scrutinyTerm = w2 * (v.scrutiny / 100) * 100;
  const outrageTerm = w3 * (Math.abs(v.outrage) / 100) * 100;

  return (
    <Stack gap={0} style={gpStyles.modalContent}>
      <Text style={{ ...boldStyle, fontSize: '0.8rem', marginBottom: 12 }}>GLOBAL RISK GAUGE BREAKDOWN</Text>
      <Flex justify="space-between" style={gpStyles.statRow()}>
        <Text size="sm">Legal exposure ratio ({(ler * 100).toFixed(0)}%, weight 0.5)</Text><Text style={boldStyle}>{legalTerm.toFixed(1)}</Text>
      </Flex>
      <Flex justify="space-between" style={gpStyles.statRow()}>
        <Text size="sm">Scrutiny (weight 0.25)</Text><Text style={boldStyle}>{scrutinyTerm.toFixed(1)}</Text>
      </Flex>
      <Flex justify="space-between" style={gpStyles.statRow()}>
        <Text size="sm">Outrage (weight 0.25)</Text><Text style={boldStyle}>{outrageTerm.toFixed(1)}</Text>
      </Flex>

      <Divider my="xs" />
      <Flex justify="space-between" style={gpStyles.totalRow}>
        <Text style={{ fontSize: '0.85rem' }}>Threat level</Text>
        <Text style={{ fontSize: '0.95rem' }}>{Math.round(legalTerm + scrutinyTerm + outrageTerm)}</Text>
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
  decisions: DecisionDefinition[];
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

function RivalFullReportView({ rival, decisions }: RivalFullReportViewProps) {
  const { variables: v, derived: d } = rival;
  const { socket } = useSocketStore();
  const { annualReports, annualReportLoading, setAnnualReportLoading } = useGameStore();

  const rows = [
    ['Cash', fmt(v.cash)], ['Revenue', fmt(d.revenue)], ['Equity', fmt(d.equity)], ['Stock value', fmt(d.stockValue)], ['Debt', fmt(v.debt)],
    ['Assets', fmt(v.assets)], ['Intangible assets', fmt(v.intangibleAssets)], ['Reserves', fmt(v.reserves)],
    ['Receivables', fmt(d.receivables)], ['Operating expenses', fmt(v.operatingExpenses)], ['Staff cost', fmt(v.staffCost)],
    ['Material cost / ton', fmt(v.materialCostPerTon)], ['Depreciation', fmt(d.depreciation)],
    ['Finance cost', fmt(d.financeCost)], ['Tax cost', fmt(d.taxCost)], ['Other income', fmt(v.otherIncome)],
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
        {rows.map(([label, value]) => (
          <Flex justify="space-between" key={label} style={gpStyles.statRow()}>
            <Text size="sm">{label}</Text><Text style={boldStyle}>{value}</Text>
          </Flex>
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

// ── Rival Field View (trend display) ───────────────────

interface RivalFieldViewProps {
  rival: PlayerTurnResult;
  field: string;
}

function RivalFieldView({ rival, field }: RivalFieldViewProps) {
  // In production this would show historical trend data from filed statements
  return (
    <Stack gap="md">
      <Text style={{ ...boldStyle, fontSize: '0.8rem', marginBottom: 12 }}>{field.toUpperCase()} TREND — {rival.playerName}</Text>
      <Box p="md" style={{ background: 'var(--mantine-color-gray-1)', border: '1px solid var(--mantine-color-gray-3)', borderRadius: 'var(--mantine-radius-sm)', textAlign: 'center' }}>
        <Text style={boldStyle}>{fmt((rival.derived as any)[field] ?? (rival.variables as any)[field] ?? 0)}</Text>
        <Text size="xs" c="dimmed" style={{ fontStyle: 'italic' }}>Historical trend data will appear here once multi-turn tracking is implemented.</Text>
      </Box>
    </Stack>
  );
}

// ============================================================
// Sue Modal
// ============================================================

/** A ground you can actually sue someone over — derived from a decision the target
 * really deployed, never a fixed catalog (there's no fixed catalog; every decision's
 * legalRisks in game_engine.json is a potential ground once someone has done it). */
interface DerivedGround {
  decisionName: string;
  groundName: string;
  description: string;
}

function getGroundsAgainst(target: PlayerTurnResult, decisions: DecisionDefinition[]): DerivedGround[] {
  const grounds: DerivedGround[] = [];
  for (const active of target.activeDecisions) {
    const def = decisions.find((d) => d.decision === active.decisionName);
    if (!def?.legalRisks) continue;
    for (const risk of def.legalRisks) {
      grounds.push({ decisionName: active.decisionName, groundName: risk.name, description: risk.description });
    }
  }
  return grounds;
}

interface SueModalProps {
  competitors: PlayerTurnResult[];
  decisions: DecisionDefinition[];
  gameSettings: GameSettings | null;
  pending: SubmittedDecisions;
  onSubmitPending: (next: SubmittedDecisions) => void;
  /** Pre-select a target + ground — set via a fully-investigated attack's "SUE NOW" shortcut. */
  prefillTargetId?: string;
  prefillGroundName?: string;
}

function SueModal({ competitors, decisions, gameSettings, pending, onSubmitPending, prefillTargetId, prefillGroundName }: SueModalProps) {
  const [query, setQuery] = useState('');
  const [selectedGround, setSelectedGround] = useState<DerivedGround | null>(null);
  const [targetRival, setTargetRival] = useState<string>('');

  const target = competitors.find((c) => c.playerId === targetRival) ?? null;
  const grounds = target ? getGroundsAgainst(target, decisions) : [];
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
    const match = getGroundsAgainst(prefillTarget, decisions).find((g) => g.groundName === prefillGroundName);
    if (match) setSelectedGround(match);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefillTargetId, prefillGroundName]);

  const maxLawsuits = gameSettings?.maxLawsuitsPerPlayerPerTurn ?? Infinity;
  const atLimit = pending.lawsuits.length >= maxLawsuits;
  const alreadyQueued = (g: DerivedGround) =>
    pending.lawsuits.some((l) => l.targetId === targetRival && l.decisionName === g.decisionName && l.groundName === g.groundName);

  const handleFile = () => {
    if (!selectedGround || !targetRival || atLimit) return;
    onSubmitPending({
      ...pending,
      lawsuits: [...pending.lawsuits, { targetId: targetRival, decisionName: selectedGround.decisionName, groundName: selectedGround.groundName }],
    });
    setSelectedGround(null);
    setQuery('');
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
                <Text size="xs" c="red" style={{ cursor: 'pointer', textDecoration: 'underline' }} onClick={() => handleRemoveQueued(i)}>Remove</Text>
              </Flex>
            );
          })}
        </Stack>
      )}

      {/* Target selection */}
      <Stack gap={4}>
        <Text style={{ ...boldStyle, fontSize: '0.7rem', color: '#6b7280' }}>TARGET</Text>
        <select value={targetRival} onChange={(e) => { setTargetRival(e.target.value); setSelectedGround(null); }} style={{ width: '100%', padding: '10px 12px', border: '3px solid #333', borderRadius: 8, fontSize: '0.85rem' }}>
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
            {grounds.length === 0 ? `${target.playerName} hasn't made any risky decisions yet — nothing to sue over.` : `${results.length} match${results.length === 1 ? '' : 'es'}`}
          </Text>

          {/* Results list */}
          <Box style={{ maxHeight: 280, overflowY: 'auto' }}>
            {results.length === 0 && grounds.length > 0 && <Text size="xs" c="dimmed" style={{ fontStyle: 'italic' }}>No grounds match that search — try different words.</Text>}
            {results.map((g, i) => (
              <Box key={`${g.decisionName}-${g.groundName}-${i}`} style={{ ...gpStyles.groundsItem(false), opacity: alreadyQueued(g) ? 0.5 : 1 }} onClick={() => !alreadyQueued(g) && setSelectedGround(g)}>
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
            <Text size="xs" c="dimmed" style={{ cursor: 'pointer', textDecoration: 'underline' }} onClick={() => setSelectedGround(null)}>CHANGE</Text>
          </Flex>
          <Text size="xs" c="dimmed">from {selectedGround.decisionName}</Text>
          <Text size="xs" style={{ fontStyle: 'italic', lineHeight: 1.4 }}>{selectedGround.description}</Text>
        </div>
      )}

      {/* Submit */}
      <Button fullWidth color="red" variant="filled" disabled={!selectedGround || !targetRival || atLimit} leftSection={<IconGavel size={14} />} onClick={handleFile}>
        {atLimit ? `LAWSUIT LIMIT REACHED (${maxLawsuits})` : 'QUEUE LAWSUIT'}
      </Button>
      <Text size="xs" c="dimmed" style={{ fontStyle: 'italic', textAlign: 'center' }}>
        Filed lawsuits resolve when this turn ends, along with your decisions.
      </Text>
    </Stack>
  );
}

// ============================================================
// CSS animation for urgent timer pulse
// ============================================================

const styleTag = document.createElement('style');
styleTag.textContent = `
  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.5; }
  }
`;
if (!document.querySelector('[data-gamephase-styles]')) {
  styleTag.setAttribute('data-gamephase-styles', 'true');
  document.head.appendChild(styleTag);
}
