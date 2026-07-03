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
    const lawsuit = await prisma.lawsuit.findUnique({
      where: { id: payload.lawsuitId },
      include: {
        plaintiff: true,
        defendant: true,
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

    // Resolve the lawsuit using lawsuitService
    const verdict = await lawsuitService.calculateVerdict(lawsuit, payload.defense, prisma);
    const resolution = this.generateResolution(lawsuit, verdict, payload);

    await prisma.lawsuit.update({
      where: { id: lawsuit.id },
      data: {
        resolved: true,
        verdict,
        resolution,
      },
    });

    // Apply verdict consequences
    if (verdict === Verdict.WON) {
      await prisma.company.updateMany({
        where: { playerId: lawsuit.defendantId },
        data: { cash: { decrement: lawsuit.claimAmount } },
      });

      await prisma.company.updateMany({
        where: { playerId: lawsuit.plaintiffId },
        data: { cash: { increment: lawsuit.claimAmount } },
      });
    } else if (verdict === Verdict.SETTLED && payload.settlementOffer) {
      const settlementAmount = Math.min(payload.settlementOffer, lawsuit.claimAmount);
      await prisma.company.updateMany({
        where: { playerId: lawsuit.defendantId },
        data: { cash: { decrement: settlementAmount } },
      });

      await prisma.company.updateMany({
        where: { playerId: lawsuit.plaintiffId },
        data: { cash: { increment: settlementAmount } },
      });
    }

    // Check for bankruptcy
    const bankruptcyResult = await bankruptcyService.checkBankruptcy(roomId, prisma, io);

    // Notify all players
    io.to(roomId).emit(ServerEvents.BOARD_UPDATE, {
      message: `${lawsuit.plaintiff.name} vs ${lawsuit.defendant.name}: ${verdict}`,
    });

    // If game is not over, advance to next phase
    if (!bankruptcyResult.gameOver) {
      const nextIdx = PHASE_ORDER.indexOf(RoomStatus.RESOLVING) + 1;
      if (nextIdx < PHASE_ORDER.length) {
        const nextPhase = PHASE_ORDER[nextIdx];
        io.to(roomId).emit(ServerEvents.PHASE_CHANGED, {
          phase: nextPhase,
          round: 1,
          timeLimit: PHASE_TIMERS[nextPhase],
        });
      }
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
