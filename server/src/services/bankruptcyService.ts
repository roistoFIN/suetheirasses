import { Server } from 'socket.io';
import { PrismaClient } from '@prisma/client';
import { ServerEvents, RoomStatus, PHASE_TIMERS, PHASE_ORDER, type PlayerStanding } from '@suetheirasses/shared';

export interface BankruptcyResult {
  bankruptPlayers: string[];
  gameOver: boolean;
  winner: PlayerStanding['player'] | null;
  standings: PlayerStanding[];
}

export const bankruptcyService = {
  async checkBankruptcy(
    roomId: string,
    prisma: PrismaClient,
    io: Server,
  ): Promise<BankruptcyResult> {
    const players = await prisma.player.findMany({
      where: { roomId, bankrupt: false },
      include: { company: true },
    });

    if (players.length === 0) {
      return { bankruptPlayers: [], gameOver: false, winner: null, standings: [] };
    }

    const bankruptPlayerIds: string[] = [];

    for (const player of players) {
      if (!player.bankrupt && player.company) {
        const isCashInsolvent = Number(player.company.cash) <= 0;
        const isOverleveraged = Number(player.company.debt) > 10000;
        if (isCashInsolvent || isOverleveraged) {
          bankruptPlayerIds.push(player.id);
          io.to(roomId).emit(ServerEvents.PLAYER_BANKRUPT, {
            playerId: player.id,
            playerName: player.name,
          });
        }
      }
    }

    // Batch update all bankrupt players in a single query
    if (bankruptPlayerIds.length > 0) {
      await prisma.player.updateMany({
        where: { id: { in: bankruptPlayerIds } },
        data: { bankrupt: true },
      });
    }

    // Re-fetch all players for standings (including newly bankrupt)
    const allPlayers = await prisma.player.findMany({
      where: { roomId },
      include: { company: true },
    });

    const activePlayers = allPlayers.filter((p) => !p.bankrupt);
    const standings: PlayerStanding[] = allPlayers
      .sort((a, b) => {
        const aCash = Number(a.company?.cash ?? 0);
        const bCash = Number(b.company?.cash ?? 0);
        return bCash - aCash;
      })
      .map((p, index) => ({
        player: p as any,
        company: p.company as any,
        rank: index + 1,
      }));

    if (activePlayers.length <= 1) {
      io.to(roomId).emit(ServerEvents.GAME_OVER, {
        winner: activePlayers[0] || null,
        finalStandings: standings,
      });

      return { bankruptPlayers: bankruptPlayerIds, gameOver: true, winner: activePlayers[0] || null, standings };
    }

    return { bankruptPlayers: bankruptPlayerIds, gameOver: false, winner: null, standings };
  },
};
