import { Server } from 'socket.io';
import { PrismaClient } from '@prisma/client';
import { ServerEvents, LawsuitFilePayload, RoomStatus, PHASE_TIMERS, PHASE_ORDER } from '@suetheirasses/shared';

export const lawsuitsPhase = {
  async fileLawsuit(
    plaintiffSocketId: string,
    roomId: string,
    payload: LawsuitFilePayload,
    io: Server,
    prisma: PrismaClient,
  ): Promise<void> {
    // Verify plaintiff and defendant are in the same room
    const [plaintiff, defendant] = await prisma.player.findMany({
      where: {
        id: { in: [plaintiffSocketId, payload.defendantId] },
        roomId,
      },
    });

    if (!plaintiff || !defendant) {
      throw new Error('Plaintiff or defendant not found in room');
    }

    if (plaintiff.id === defendant.id) {
      throw new Error('Cannot sue yourself');
    }

    if (plaintiff.bankrupt || defendant.bankrupt) {
      throw new Error('Cannot sue a bankrupt player');
    }

    // Check if plaintiff has enough cash for filing fee
    const plaintiffCompany = await prisma.company.findUnique({
      where: { playerId: plaintiff.id },
    });

    if (!plaintiffCompany || plaintiffCompany.cash < 1000) {
      throw new Error('Insufficient funds to file lawsuit (requires $1,000 filing fee)');
    }

    // Create lawsuit
    await prisma.lawsuit.create({
      data: {
        id: crypto.randomUUID(),
        plaintiffId: plaintiff.id,
        defendantId: defendant.id,
        claimAmount: payload.claimAmount,
        grounds: payload.grounds,
        resolved: false,
      },
    });

    // Deduct filing fee
    await prisma.company.update({
      where: { playerId: plaintiff.id },
      data: { cash: { decrement: 1000 } },
    });

    // Notify all players in room
    io.to(roomId).emit(ServerEvents.BOARD_UPDATE, {
      message: `${plaintiff.name} filed a lawsuit against ${defendant.name}`,
    });
  },
};
