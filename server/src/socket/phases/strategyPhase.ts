import { Server } from 'socket.io';
import { PrismaClient } from '@prisma/client';
import { RoomStatus, ServerEvents, PHASE_TIMERS, PHASE_ORDER, type RoomState, type StrategySubmitPayload, type PhaseOutcome } from '@suetheirasses/shared';
import { companyService } from '../../services/companyService';

export const strategyPhase = {
  async resolve(
    roomId: string,
    roomState: RoomState,
    io: Server,
    prisma: PrismaClient,
  ): Promise<void> {
    // Apply strategies for each player
    const outcomes: PhaseOutcome[] = [];

    for (const [playerId, submission] of roomState.submissions.entries()) {
      try {
        const result = await companyService.applyStrategy(playerId, submission.actions, prisma);
        outcomes.push({
          playerId,
          playerName: roomState.players.get(playerId)?.name || 'Unknown',
          changes: result.changes.map((change) => ({
            type: 'STRATEGY_EXECUTED',
            description: change,
            cashDelta: 0, // Individual changes don't have separate deltas
          })),
        });
        // Add total cash delta as summary
        if (result.cashDelta !== 0) {
          outcomes[outcomes.length - 1].changes.push({
            type: 'TOTAL_CASH_CHANGE',
            description: `Total cash change: $${result.cashDelta}`,
            cashDelta: result.cashDelta,
          });
        }
      } catch (error: any) {
        console.error(`Strategy execution failed for player ${playerId}:`, error.message);
        outcomes.push({
          playerId,
          playerName: roomState.players.get(playerId)?.name || 'Unknown',
          changes: [{ type: 'STRATEGY_FAILED', description: error.message, cashDelta: 0 }],
        });
      }
    }

    // Transition to results phase
    roomState.room.status = RoomStatus.RESULTS;
    roomState.submissions.clear();

    // Broadcast results
    io.to(roomId).emit(ServerEvents.RESULTS_REVEAL, { outcomes });

    // Auto-advance to next phase after timer
    setTimeout(() => {
      const nextIdx = PHASE_ORDER.indexOf(RoomStatus.RESULTS) + 1;
      if (nextIdx < PHASE_ORDER.length) {
        const nextPhase = PHASE_ORDER[nextIdx];
        roomState.room.status = nextPhase;
        roomState.submissions.clear();
        io.to(roomId).emit(ServerEvents.PHASE_CHANGED, {
          phase: nextPhase,
          round: roomState.room.currentPhaseRound,
          timeLimit: PHASE_TIMERS[nextPhase],
        });
      }
    }, PHASE_TIMERS[RoomStatus.RESULTS] * 1000);
  },
};
