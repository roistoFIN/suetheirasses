import { Server } from 'socket.io';
import { PrismaClient } from '@prisma/client';

export const resultsPhase = {
  async resolve(
    _roomId: string,
    _io: Server,
    _prisma: PrismaClient,
  ): Promise<void> {
    // Results phase is a passive 15-second display.
    // Outcomes are already broadcast by strategyPhase.
    // The game engine timer handles auto-advance to the next phase.
  },
};
