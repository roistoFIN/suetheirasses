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
      where: { roomId },
      include: { company: true },
    });

    const bankruptPlayers: string[] = [];

    for (const player of players) {
      if (!player.bankrupt && player.company) {
        if (player.company.cash <= 0 || player.company.cash < -10000) {
          bankruptPlayers.push(player.id);
          await prisma.player.update({
            where: { id: player.id },
            data: { bankrupt: true },
          });

          io.to(roomId).emit(ServerEvents.PLAYER_BANKRUPT, {
            playerId: player.id,
            playerName: player.name,
          });
        }
      }
    }

    // Check if game is over
    const activePlayers = players.filter((p) => !p.bankrupt);
    const standings: PlayerStanding[] = players
      .sort((a, b) => {
        const aCash = a.company?.cash || 0;
        const bCash = b.company?.cash || 0;
        return bCash - aCash;
      })
      .map((p, index) => ({
        player: p,
        company: p.company,
        rank: index + 1,
      }));

    if (activePlayers.length <= 1) {
      io.to(roomId).emit(ServerEvents.GAME_OVER, {
        winner: activePlayers[0] || null,
        finalStandings: standings,
      });

      return { bankruptPlayers, gameOver: true, winner: activePlayers[0] || null, standings };
    }

    return { bankruptPlayers, gameOver: false, winner: null, standings };
  },
};
