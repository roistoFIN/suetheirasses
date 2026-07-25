/**
 * Pure aggregation logic behind the admin Analytics tab's three dashboards
 * (`GET /api/admin/analytics/*` in index.ts) — pulled out of the route handlers
 * specifically so it's unit-testable without a database, the same "thin handler, tested
 * method" split this codebase uses everywhere else (GameEngine's methods vs. its socket
 * handlers, etc.). Each function takes plain row objects (a structural subset of the
 * real Prisma row shape — no `@prisma/client` import needed here) and returns the exact
 * shape `index.ts` sends back as JSON.
 */

import type { DecisionAnalyticsEntry, LawsuitAnalyticsEntry, PerformanceLlmStat } from '@suetheirasses/shared';

export interface EventLogRow {
  eventType: string;
  roomId: string | null;
  playerId: string | null;
  payload: unknown;
}

export interface LegalCaseHistoryRow {
  decisionName: string;
  groundName: string;
  stakes: number | string;
  resolvedRound: number | null;
  verdict: string | null;
}

/**
 * Cross-references `decision.deployed`/`decision.rejected` events against
 * `game.completed` events (roomId -> winning playerId) to compute a real win/loss
 * correlation from actually-played games — see CLAUDE.md's decision-balance sections
 * for why this matters (the session's own randomized-simulation balance work was a
 * one-off script; this is the same idea running continuously against real data).
 */
export function aggregateDecisionAnalytics(
  deployedRows: EventLogRow[],
  rejectedRows: EventLogRow[],
  completedRows: EventLogRow[],
): { decisions: DecisionAnalyticsEntry[]; gamesConsidered: number } {
  const winnerByRoom = new Map<string, string>();
  for (const row of completedRows) {
    if (row.roomId && row.playerId) winnerByRoom.set(row.roomId, row.playerId);
  }

  interface Agg {
    deployCount: number;
    rejectCount: number;
    rejectReasons: Map<string, number>;
    winCount: number;
    lossCount: number;
  }
  const byName = new Map<string, Agg>();
  const ensure = (name: string): Agg => {
    let a = byName.get(name);
    if (!a) {
      a = { deployCount: 0, rejectCount: 0, rejectReasons: new Map(), winCount: 0, lossCount: 0 };
      byName.set(name, a);
    }
    return a;
  };

  for (const row of deployedRows) {
    const payload = row.payload as { decisionName?: string };
    if (!payload?.decisionName) continue;
    const agg = ensure(payload.decisionName);
    agg.deployCount++;
    if (row.roomId && row.playerId) {
      const winnerId = winnerByRoom.get(row.roomId);
      if (winnerId) {
        if (winnerId === row.playerId) agg.winCount++;
        else agg.lossCount++;
      }
    }
  }
  for (const row of rejectedRows) {
    const payload = row.payload as { decisionName?: string; reason?: string };
    if (!payload?.decisionName) continue;
    const agg = ensure(payload.decisionName);
    agg.rejectCount++;
    const reason = payload.reason ?? 'Unknown';
    agg.rejectReasons.set(reason, (agg.rejectReasons.get(reason) ?? 0) + 1);
  }

  const decisions: DecisionAnalyticsEntry[] = Array.from(byName.entries())
    .map(([decisionName, agg]) => {
      const totalOutcomes = agg.winCount + agg.lossCount;
      return {
        decisionName,
        deployCount: agg.deployCount,
        rejectCount: agg.rejectCount,
        topRejectReasons: Array.from(agg.rejectReasons.entries())
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([reason, count]) => ({ reason, count })),
        winCount: agg.winCount,
        lossCount: agg.lossCount,
        winRate: totalOutcomes > 0 ? agg.winCount / totalOutcomes : null,
      };
    })
    .sort((a, b) => b.deployCount - a.deployCount);

  return { decisions, gamesConsidered: winnerByRoom.size };
}

/** Read from `LegalCaseHistory` (already durable/denormalized) — a lawsuit's full
 * lifecycle is already fully captured there, so there's nothing to duplicate from EventLog. */
export function aggregateLawsuitAnalytics(rows: LegalCaseHistoryRow[]): { grounds: LawsuitAnalyticsEntry[] } {
  interface Agg {
    filedCount: number;
    resolvedCount: number;
    wonCount: number;
    stakesSum: number;
    stakesCount: number;
  }
  const byKey = new Map<string, { decisionName: string; groundName: string; agg: Agg }>();
  for (const r of rows) {
    const key = `${r.decisionName} ${r.groundName}`;
    let entry = byKey.get(key);
    if (!entry) {
      entry = { decisionName: r.decisionName, groundName: r.groundName, agg: { filedCount: 0, resolvedCount: 0, wonCount: 0, stakesSum: 0, stakesCount: 0 } };
      byKey.set(key, entry);
    }
    entry.agg.filedCount++;
    entry.agg.stakesSum += Number(r.stakes);
    entry.agg.stakesCount++;
    if (r.resolvedRound !== null) {
      entry.agg.resolvedCount++;
      if (r.verdict === 'won') entry.agg.wonCount++;
    }
  }

  const grounds: LawsuitAnalyticsEntry[] = Array.from(byKey.values())
    .map(({ decisionName, groundName, agg }) => ({
      groundName,
      decisionName,
      filedCount: agg.filedCount,
      resolvedCount: agg.resolvedCount,
      wonCount: agg.wonCount,
      winRate: agg.resolvedCount > 0 ? agg.wonCount / agg.resolvedCount : null,
      avgStakes: agg.stakesCount > 0 ? agg.stakesSum / agg.stakesCount : null,
    }))
    .sort((a, b) => b.filedCount - a.filedCount);

  return { grounds };
}

export interface PerformanceAnalytics {
  turns: { count: number; avgComputeMs: number; avgTotalMs: number; maxTotalMs: number };
  llm: PerformanceLlmStat[];
  errorCounts: Array<{ context: string; count: number }>;
}

/** Turn-resolution duration, LLM call latency/success rate by kind, and an
 * error-context breakdown — three independent aggregates over three EventLog slices. */
export function aggregatePerformanceAnalytics(
  turnRows: EventLogRow[],
  llmRows: EventLogRow[],
  errorRows: EventLogRow[],
): PerformanceAnalytics {
  let computeSum = 0;
  let totalSum = 0;
  let maxTotal = 0;
  for (const r of turnRows) {
    const p = r.payload as { computeDurationMs?: number; totalDurationMs?: number };
    computeSum += p?.computeDurationMs ?? 0;
    totalSum += p?.totalDurationMs ?? 0;
    maxTotal = Math.max(maxTotal, p?.totalDurationMs ?? 0);
  }
  const turns = {
    count: turnRows.length,
    avgComputeMs: turnRows.length ? Math.round(computeSum / turnRows.length) : 0,
    avgTotalMs: turnRows.length ? Math.round(totalSum / turnRows.length) : 0,
    maxTotalMs: maxTotal,
  };

  const llmByKind = new Map<string, { count: number; latencySum: number; successCount: number }>();
  for (const r of llmRows) {
    const p = r.payload as { kind?: string; latencyMs?: number; success?: boolean };
    const kind = p?.kind ?? 'unknown';
    let a = llmByKind.get(kind);
    if (!a) {
      a = { count: 0, latencySum: 0, successCount: 0 };
      llmByKind.set(kind, a);
    }
    a.count++;
    a.latencySum += p?.latencyMs ?? 0;
    if (p?.success) a.successCount++;
  }
  const llm: PerformanceLlmStat[] = Array.from(llmByKind.entries()).map(([kind, a]) => ({
    kind,
    count: a.count,
    avgLatencyMs: a.count ? Math.round(a.latencySum / a.count) : 0,
    successRate: a.count ? a.successCount / a.count : 0,
  }));

  const errorByContext = new Map<string, number>();
  for (const r of errorRows) {
    const p = r.payload as { context?: string };
    const context = p?.context ?? r.eventType;
    errorByContext.set(context, (errorByContext.get(context) ?? 0) + 1);
  }
  const errorCounts = Array.from(errorByContext.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([context, count]) => ({ context, count }));

  return { turns, llm, errorCounts };
}
