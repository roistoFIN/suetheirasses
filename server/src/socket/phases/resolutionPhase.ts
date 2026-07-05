import { Server } from 'socket.io';
import { PrismaClient } from '@prisma/client';
import { ServerEvents, LawsuitRespondPayload, RoomStatus, PHASE_TIMERS, PHASE_ORDER, Verdict } from '@suetheirasses/shared';
import { bankruptcyService, type BankruptcyResult } from '../../services/bankruptcyService';
import { lawsuitService } from '../../services/lawsuitService';

export const resolutionPhase = {
  async respondToLawsuit(
    defendantSocketId: string,
    roomId: string,
    payload: LawsuitRespondPayload,
    io: Server,
    prisma: PrismaClient,
  ): Promise<void> {
    // Fetch lawsuit with plaintiff, defendant, and both companies in one query
    const lawsuit = await prisma.lawsuit.findUnique({
      where: { id: payload.lawsuitId },
      include: {
        plaintiff: { include: { company: true } },
        defendant: { include: { company: true } },
      },
    });

    if (!lawsuit) {
      throw new Error('Lawsuit not found');
    }

    if (lawsuit.defendantId !== defendantSocketId) {
      throw new Error('Not authorized to respond to this lawsuit');
    }

    if (lawsuit.resolved) {
      throw new Error('This lawsuit has already been resolved');
    }

    // Resolve the lawsuit (companies are pre-loaded, no extra queries)
    const verdict = await lawsuitService.calculateVerdict(lawsuit, payload.defense);
    const resolution = this.generateResolution(lawsuit, verdict, payload);

    // Use transaction for all money transfers
    await prisma.$transaction(async (tx) => {
      await tx.lawsuit.update({
        where: { id: lawsuit.id },
        data: { resolved: true, verdict, resolution },
      });

      if (verdict === Verdict.WON) {
        await tx.company.update({
          where: { playerId: lawsuit.defendant.id },
          data: { cash: { decrement: lawsuit.claimAmount } },
        });
        await tx.company.update({
          where: { playerId: lawsuit.plaintiff.id },
          data: { cash: { increment: lawsuit.claimAmount } },
        });
      } else if (verdict === Verdict.SETTLED) {
        // Auto-settle at 50% of claim when defendant has strong defense but
        // the claim is large relative to their cash (risking bankruptcy).
        const defendantCompany = lawsuit.defendant?.company;
        const settlementAmount = Math.min(
          Math.floor(Number(lawsuit.claimAmount) * 0.5),
          defendantCompany ? Number(defendantCompany.cash) : 0,
        );
        await tx.company.update({
          where: { playerId: lawsuit.defendant.id },
          data: { cash: { decrement: settlementAmount } },
        });
        await tx.company.update({
          where: { playerId: lawsuit.plaintiff.id },
          data: { cash: { increment: settlementAmount } },
        });
      }
    });

    // Check for bankruptcy
    const bankruptcyResult = await bankruptcyService.checkBankruptcy(roomId, prisma, io);

    io.to(roomId).emit(ServerEvents.BOARD_UPDATE, {
      message: `${lawsuit.plaintiff.name} vs ${lawsuit.defendant.name}: ${verdict}`,
    });

    if (!bankruptcyResult.gameOver) {
      await prisma.room.update({
        where: { id: roomId },
        data: {
          status: RoomStatus.STRATEGY,
          currentPhaseRound: { increment: 1 },
        },
      });

      io.to(roomId).emit(ServerEvents.PHASE_CHANGED, {
        phase: RoomStatus.STRATEGY,
        round: bankruptcyResult.standings[0]?.rank || 1,
        timeLimit: PHASE_TIMERS[RoomStatus.STRATEGY],
      });
    }
  },

  generateResolution(lawsuit: any, verdict: Verdict, payload: LawsuitRespondPayload): string {
    switch (verdict) {
      case Verdict.WON:
        return `Court rules in favor of ${lawsuit.plaintiff.name}. ${lawsuit.defendant.name} must pay $${lawsuit.claimAmount}.`;
      case Verdict.LOST:
        return `Court dismisses the case. ${lawsuit.plaintiff.name}'s lawsuit is denied.`;
      case Verdict.SETTLED:
        return `Parties reached a settlement. ${lawsuit.defendant.name} pays $${payload.settlementOffer || 0}.`;
      default:
        return 'Case resolved.';
    }
  },
};
