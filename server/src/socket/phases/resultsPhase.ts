import { Server } from 'socket.io';
import { PrismaClient } from '@prisma/client';
import { RoomStatus, ServerEvents, PHASE_TIMERS, PHASE_ORDER } from '@suetheirasses/shared';

export const resultsPhase = {
  async resolve(
    roomId: string,
    io: Server,
    prisma: PrismaClient,
  ): Promise<void> {
    // Results are already displayed by strategyPhase
    // Just ensure the phase transition happens
    const nextIdx = PHASE_ORDER.indexOf(RoomStatus.RESULTS) + 1;
    if (nextIdx >= PHASE_ORDER.length) {
      return;
    }

    const nextPhase = PHASE_ORDER[nextIdx];

    io.to(roomId).emit(ServerEvents.PHASE_CHANGED, {
      phase: nextPhase,
      round: 1,
      timeLimit: PHASE_TIMERS[nextPhase],
    });
  },
};
