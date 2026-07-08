import { Server } from 'socket.io';
import { PrismaClient } from '@prisma/client';
import { ServerEvents, type LawsuitFilePayload } from '@suetheirasses/shared';

export const lawsuitsPhase = {
  async fileLawsuit(
    plaintiffSocketId: string,
    roomId: string,
    payload: LawsuitFilePayload,
    io: Server,
    prisma: PrismaClient,
  ): Promise<void> {
    // Single query: fetch plaintiff with company in one go
    const plaintiffWithCompany = await prisma.player.findFirst({
      where: {
        id: plaintiffSocketId,
        roomId,
      },
      include: { company: true },
    });

    const defendant = await prisma.player.findFirst({
      where: {
        id: payload.defendantId,
        roomId,
      },
    });

    if (!plaintiffWithCompany || !defendant) {
      throw new Error('Plaintiff or defendant not found in room');
    }

    if (plaintiffWithCompany.id === defendant.id) {
      throw new Error('Cannot sue yourself');
    }

    if (plaintiffWithCompany.bankrupt || defendant.bankrupt) {
      throw new Error('Cannot sue a bankrupt player');
    }

    if (!plaintiffWithCompany.company || Number(plaintiffWithCompany.company.cash) < 1000) {
      throw new Error('Insufficient funds to file lawsuit (requires $1,000 filing fee)');
    }

    // Use transaction for atomicity: create lawsuit + deduct fee
    await prisma.$transaction(async (tx) => {
      await tx.lawsuit.create({
        data: {
          id: crypto.randomUUID(),
          plaintiffId: plaintiffWithCompany.id,
          defendantId: defendant.id,
          claimAmount: payload.claimAmount,
          grounds: payload.grounds,
          resolved: false,
        },
      });

      await tx.company.update({
        where: { playerId: plaintiffWithCompany.id },
        data: { cash: { decrement: 1000 } },
      });
    });

    io.to(roomId).emit(ServerEvents.BOARD_UPDATE, {
      message: `${plaintiffWithCompany.name} filed a lawsuit against ${defendant.name}`,
    });
  },
};
