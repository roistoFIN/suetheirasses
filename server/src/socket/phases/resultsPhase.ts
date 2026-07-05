import { Server } from 'socket.io';
import { PrismaClient } from '@prisma/client';

export const resultsPhase = {
  async resolve(
    roomId: string,
    io: Server,
    prisma: PrismaClient,
  ): Promise<void> {
    // Results phase is a passive 15-second display.
    // Outcomes are already broadcast by strategyPhase.
    // The game engine timer handles auto-advance to the next phase.
  },
};
