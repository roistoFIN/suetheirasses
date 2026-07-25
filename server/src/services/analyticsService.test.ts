import { describe, it, expect } from 'vitest';
import {
  aggregateDecisionAnalytics,
  aggregateLawsuitAnalytics,
  aggregatePerformanceAnalytics,
  type EventLogRow,
  type LegalCaseHistoryRow,
} from './analyticsService';

function deployed(decisionName: string, roomId: string, playerId: string): EventLogRow {
  return { eventType: 'decision.deployed', roomId, playerId, payload: { decisionName } };
}
function rejected(decisionName: string, reason: string, roomId = 'room-1', playerId = 'p1'): EventLogRow {
  return { eventType: 'decision.rejected', roomId, playerId, payload: { decisionName, reason } };
}
function completed(roomId: string, winnerId: string): EventLogRow {
  return { eventType: 'game.completed', roomId, playerId: winnerId, payload: {} };
}

describe('aggregateDecisionAnalytics', () => {
  it('counts deployments and rejections per decision, most-deployed first', () => {
    const { decisions } = aggregateDecisionAnalytics(
      [deployed('Bot Attack', 'room-1', 'p1'), deployed('Bot Attack', 'room-1', 'p2'), deployed('New Factory', 'room-1', 'p1')],
      [rejected('New Factory', 'still maturing')],
      [],
    );

    expect(decisions.map((d) => d.decisionName)).toEqual(['Bot Attack', 'New Factory']);
    expect(decisions[0]).toMatchObject({ decisionName: 'Bot Attack', deployCount: 2, rejectCount: 0 });
    expect(decisions[1]).toMatchObject({ decisionName: 'New Factory', deployCount: 1, rejectCount: 1 });
  });

  it('correlates deployment with the eventual room winner to compute a win rate', () => {
    const { decisions, gamesConsidered } = aggregateDecisionAnalytics(
      [
        deployed('Bot Attack', 'room-1', 'winner-1'), // winner used it -> win
        deployed('Bot Attack', 'room-1', 'loser-1'), // loser used it -> loss
        deployed('Bot Attack', 'room-2', 'winner-2'), // another win
      ],
      [],
      [completed('room-1', 'winner-1'), completed('room-2', 'winner-2')],
    );

    expect(gamesConsidered).toBe(2);
    expect(decisions[0]).toMatchObject({ decisionName: 'Bot Attack', winCount: 2, lossCount: 1, winRate: 2 / 3 });
  });

  it('leaves winRate null when the room a decision was deployed in has no completed game yet', () => {
    const { decisions } = aggregateDecisionAnalytics([deployed('Bot Attack', 'room-1', 'p1')], [], []);
    expect(decisions[0].winRate).toBeNull();
  });

  it('surfaces up to 3 of the most common rejection reasons, most frequent first', () => {
    const { decisions } = aggregateDecisionAnalytics(
      [],
      [
        rejected('New Factory', 'still maturing'),
        rejected('New Factory', 'still maturing'),
        rejected('New Factory', 'still maturing'),
        rejected('New Factory', 'permanent effect cooldown'),
        rejected('New Factory', 'excluded'),
        rejected('New Factory', 'rare reason'),
      ],
      [],
    );

    expect(decisions[0].topRejectReasons).toEqual([
      { reason: 'still maturing', count: 3 },
      { reason: 'permanent effect cooldown', count: 1 },
      { reason: 'excluded', count: 1 },
    ]);
  });

  it('ignores a malformed row with no decisionName in its payload', () => {
    const { decisions } = aggregateDecisionAnalytics([{ eventType: 'decision.deployed', roomId: 'r', playerId: 'p', payload: {} }], [], []);
    expect(decisions).toEqual([]);
  });
});

describe('aggregateLawsuitAnalytics', () => {
  function row(overrides: Partial<LegalCaseHistoryRow> = {}): LegalCaseHistoryRow {
    return {
      decisionName: 'Bot Attack',
      groundName: 'Computer Fraud and Abuse Act Claim',
      stakes: 10000,
      resolvedRound: null,
      verdict: null,
      ...overrides,
    };
  }

  it('groups by (decisionName, groundName) and counts filed/resolved/won', () => {
    const { grounds } = aggregateLawsuitAnalytics([
      row({ resolvedRound: 3, verdict: 'won' }),
      row({ resolvedRound: 4, verdict: 'lost' }),
      row(), // still open
    ]);

    expect(grounds).toHaveLength(1);
    expect(grounds[0]).toMatchObject({ filedCount: 3, resolvedCount: 2, wonCount: 1, winRate: 0.5 });
  });

  it('averages stakes across every filing regardless of resolution status', () => {
    const { grounds } = aggregateLawsuitAnalytics([row({ stakes: 10000 }), row({ stakes: 30000 })]);
    expect(grounds[0].avgStakes).toBe(20000);
  });

  it('leaves winRate null for a ground with no resolved cases yet', () => {
    const { grounds } = aggregateLawsuitAnalytics([row()]);
    expect(grounds[0].winRate).toBeNull();
  });

  it('sorts most-filed ground first', () => {
    const { grounds } = aggregateLawsuitAnalytics([
      row({ groundName: 'Rare Ground' }),
      row({ groundName: 'Common Ground' }),
      row({ groundName: 'Common Ground' }),
    ]);
    expect(grounds.map((g) => g.groundName)).toEqual(['Common Ground', 'Rare Ground']);
  });
});

describe('aggregatePerformanceAnalytics', () => {
  function turnRow(computeDurationMs: number, totalDurationMs: number): EventLogRow {
    return { eventType: 'turn.resolved', roomId: 'r', playerId: null, payload: { computeDurationMs, totalDurationMs } };
  }
  function llmRow(kind: string, latencyMs: number, success: boolean): EventLogRow {
    return { eventType: 'llm.call', roomId: null, playerId: null, payload: { kind, latencyMs, success } };
  }
  function errorRow(context: string): EventLogRow {
    return { eventType: 'error.persistence', roomId: 'r', playerId: null, payload: { context } };
  }

  it('averages turn compute/total duration and tracks the max', () => {
    const { turns } = aggregatePerformanceAnalytics([turnRow(10, 50), turnRow(20, 150)], [], []);
    expect(turns).toEqual({ count: 2, avgComputeMs: 15, avgTotalMs: 100, maxTotalMs: 150 });
  });

  it('returns zeroed turn stats when nothing has been logged yet', () => {
    const { turns } = aggregatePerformanceAnalytics([], [], []);
    expect(turns).toEqual({ count: 0, avgComputeMs: 0, avgTotalMs: 0, maxTotalMs: 0 });
  });

  it('buckets LLM calls by kind and computes a per-kind success rate', () => {
    const { llm } = aggregatePerformanceAnalytics(
      [],
      [llmRow('annualReport', 100, true), llmRow('annualReport', 200, false), llmRow('decisionGen', 90000, true)],
      [],
    );

    const annualReport = llm.find((l) => l.kind === 'annualReport')!;
    expect(annualReport).toMatchObject({ count: 2, avgLatencyMs: 150, successRate: 0.5 });
    const decisionGen = llm.find((l) => l.kind === 'decisionGen')!;
    expect(decisionGen).toMatchObject({ count: 1, avgLatencyMs: 90000, successRate: 1 });
  });

  it('counts errors by payload.context, most common first, falling back to eventType when context is missing', () => {
    const { errorCounts } = aggregatePerformanceAnalytics(
      [],
      [],
      [errorRow('resolveGameTurn:companyUpdate'), errorRow('resolveGameTurn:companyUpdate'), { eventType: 'error.persistence', roomId: 'r', playerId: null, payload: {} }],
    );

    expect(errorCounts[0]).toEqual({ context: 'resolveGameTurn:companyUpdate', count: 2 });
    expect(errorCounts[1]).toEqual({ context: 'error.persistence', count: 1 });
  });
});
