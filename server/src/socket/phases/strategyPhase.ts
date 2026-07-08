import { Server } from 'socket.io';
import { PrismaClient } from '@prisma/client';
import { ServerEvents, type RoomState, type PhaseOutcome } from '@suetheirasses/shared';
import { companyService } from '../../services/companyService.js';

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

    // Broadcast results to all clients
    io.to(roomId).emit(ServerEvents.RESULTS_REVEAL, { outcomes });

    // Clear submissions after broadcasting
    roomState.submissions.clear();
  },
};
