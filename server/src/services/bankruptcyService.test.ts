import { describe, it, expect, vi, beforeEach } from 'vitest';
import { bankruptcyService } from './bankruptcyService';
import type { PrismaClient, Player as PrismaPlayer, Company as PrismaCompany } from '@prisma/client';
import type { Server } from 'socket.io';
import { RoomStatus, type PlayerStanding } from '@suetheirasses/shared';

const createMockPlayer = (
  id: string,
  name: string,
  bankrupt: boolean,
  company: PrismaCompany | null,
): PrismaPlayer & { company: PrismaCompany | null } =>
  ({
    id,
    name,
    roomId: 'room-1',
    isReady: true,
    bankrupt,
    socketId: `socket-${id}`,
    companyId: company?.id ?? null,
    company,
  } satisfies PrismaPlayer & { company: PrismaCompany | null });

const createMockCompany = (cash: number, debt: number = 0): PrismaCompany =>
  ({
    id: `company-${cash}`,
    playerId: `player-${cash}`,
    cash,
    debt,
    createdAt: new Date(),
  } satisfies PrismaCompany);

const createMockIo = () => ({
  to: vi.fn().mockReturnThis(),
  emit: vi.fn().mockReturnThis(),
}) as unknown as Server;

const createMockPrisma = (players: (PrismaPlayer & { company: PrismaCompany | null })[]) =>
  ({
    player: {
      findMany: vi.fn().mockResolvedValue(players),
      update: vi.fn().mockImplementation(({ data }: { data?: Record<string, unknown> }) => {
        const player = players.find((p) => p.id === (data as Record<string, unknown>)?.id);
        if (player) {
          Object.assign(player, data);
        }
        return Promise.resolve({ ...player, ...data });
      }),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
  }) as unknown as PrismaClient;

describe('bankruptcyService.checkBankruptcy', () => {
  let mockPrisma: PrismaClient;
  let mockIo: Server;

  beforeEach(() => {
    vi.clearAllMocks();
    mockIo = createMockIo();
  });

  describe('No bankrupt players', () => {
    it('should return no bankrupt players when all companies have positive cash', async () => {
      const players = [
        createMockPlayer('p1', 'Player 1', false, createMockCompany(50000)),
        createMockPlayer('p2', 'Player 2', false, createMockCompany(30000)),
      ];
      mockPrisma = createMockPrisma(players);

      const result = await bankruptcyService.checkBankruptcy('room-1', mockPrisma, mockIo);

      expect(result.bankruptPlayers).toEqual([]);
      expect(result.gameOver).toBe(false);
      expect(result.winner).toBe(null);
      expect(mockIo.to).not.toHaveBeenCalled();
    });

    it('should mark player as bankrupt when cash is exactly 0', async () => {
      const players = [
        createMockPlayer('p1', 'Player 1', false, createMockCompany(0)),
        createMockPlayer('p2', 'Player 2', false, createMockCompany(50000)),
      ];
      mockPrisma = createMockPrisma(players);

      const result = await bankruptcyService.checkBankruptcy('room-1', mockPrisma, mockIo);

      expect(result.bankruptPlayers).toContain('p1');
    });
  });

  describe('Players going bankrupt', () => {
    it('should mark player as bankrupt when cash is 0', async () => {
      const players = [
        createMockPlayer('p1', 'Player 1', false, createMockCompany(0)),
        createMockPlayer('p2', 'Player 2', false, createMockCompany(50000)),
      ];
      mockPrisma = createMockPrisma(players);

      const result = await bankruptcyService.checkBankruptcy('room-1', mockPrisma, mockIo);

      expect(result.bankruptPlayers).toContain('p1');
      expect(mockPrisma.player.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: { in: ['p1'] } },
          data: { bankrupt: true },
        }),
      );
      expect(mockIo.to).toHaveBeenCalledWith('room-1');
      expect(mockIo.emit).toHaveBeenCalled();
    });

    it('should mark player as bankrupt when debt exceeds 10000', async () => {
      const players = [
        createMockPlayer('p1', 'Player 1', false, createMockCompany(50000, 10001)),
        createMockPlayer('p2', 'Player 2', false, createMockCompany(50000)),
      ];
      mockPrisma = createMockPrisma(players);

      const result = await bankruptcyService.checkBankruptcy('room-1', mockPrisma, mockIo);

      expect(result.bankruptPlayers).toContain('p1');
    });

    it('should not mark player as bankrupt when debt is exactly 10000', async () => {
      const players = [
        createMockPlayer('p1', 'Player 1', false, createMockCompany(50000, 10000)),
        createMockPlayer('p2', 'Player 2', false, createMockCompany(50000)),
      ];
      mockPrisma = createMockPrisma(players);

      const result = await bankruptcyService.checkBankruptcy('room-1', mockPrisma, mockIo);

      expect(result.bankruptPlayers).toEqual([]);
    });

    it('should not mark player as bankrupt when cash is positive', async () => {
      const players = [
        createMockPlayer('p1', 'Player 1', false, createMockCompany(1)),
        createMockPlayer('p2', 'Player 2', false, createMockCompany(50000)),
      ];
      mockPrisma = createMockPrisma(players);

      const result = await bankruptcyService.checkBankruptcy('room-1', mockPrisma, mockIo);

      expect(result.bankruptPlayers).toEqual([]);
    });

    it('should not re-mark already bankrupt players', async () => {
      const players = [
        createMockPlayer('p1', 'Player 1', true, createMockCompany(0)),
        createMockPlayer('p2', 'Player 2', false, createMockCompany(50000)),
      ];
      mockPrisma = createMockPrisma(players);

      const result = await bankruptcyService.checkBankruptcy('room-1', mockPrisma, mockIo);

      expect(result.bankruptPlayers).toEqual([]);
      expect(mockPrisma.player.update).not.toHaveBeenCalled();
    });

    it('should not mark player without company as bankrupt', async () => {
      const players = [
        createMockPlayer('p1', 'Player 1', false, null),
        createMockPlayer('p2', 'Player 2', false, createMockCompany(50000)),
      ];
      mockPrisma = createMockPrisma(players);

      const result = await bankruptcyService.checkBankruptcy('room-1', mockPrisma, mockIo);

      expect(result.bankruptPlayers).toEqual([]);
    });

    it('should emit PLAYER_BANKRUPT event for each bankrupt player', async () => {
      const players = [
        createMockPlayer('p1', 'Player 1', false, createMockCompany(0)),
        createMockPlayer('p2', 'Player 2', false, createMockCompany(-15000)),
        createMockPlayer('p3', 'Player 3', false, createMockCompany(50000)),
      ];
      mockPrisma = createMockPrisma(players);

      await bankruptcyService.checkBankruptcy('room-1', mockPrisma, mockIo);

      // Should emit for each bankrupt player
      const emitCalls = (mockIo.emit as ReturnType<typeof vi.fn>).mock.calls;
      const bankruptEmits = emitCalls.filter((call: [string, ...unknown[]]) => call[0] === 'player:bankrupt');
      expect(bankruptEmits.length).toBe(2);
    });
  });

  describe('Game over conditions', () => {
    it('should declare game over when only one active player remains', async () => {
      const players = [
        createMockPlayer('p1', 'Player 1', false, createMockCompany(50000)),
        createMockPlayer('p2', 'Player 2', true, createMockCompany(0)),
      ];
      mockPrisma = createMockPrisma(players);

      const result = await bankruptcyService.checkBankruptcy('room-1', mockPrisma, mockIo);

      expect(result.gameOver).toBe(true);
      expect(result.winner?.id).toBe('p1');
      expect(mockIo.emit).toHaveBeenCalledWith('game:over', expect.any(Object));
    });

    it('should declare game over when all players are bankrupt', async () => {
      const players = [
        createMockPlayer('p1', 'Player 1', true, createMockCompany(0)),
        createMockPlayer('p2', 'Player 2', true, createMockCompany(-20000)),
      ];
      mockPrisma = createMockPrisma(players);

      const result = await bankruptcyService.checkBankruptcy('room-1', mockPrisma, mockIo);

      expect(result.gameOver).toBe(true);
      expect(result.winner).toBe(null);
    });

    it('should not declare game over when multiple active players remain', async () => {
      const players = [
        createMockPlayer('p1', 'Player 1', false, createMockCompany(50000)),
        createMockPlayer('p2', 'Player 2', false, createMockCompany(30000)),
        createMockPlayer('p3', 'Player 3', true, createMockCompany(0)),
      ];
      mockPrisma = createMockPrisma(players);

      const result = await bankruptcyService.checkBankruptcy('room-1', mockPrisma, mockIo);

      expect(result.gameOver).toBe(false);
      expect(result.winner).toBe(null);
    });

    it('should emit GAME_OVER event with winner and standings', async () => {
      const players = [
        createMockPlayer('p1', 'Winner', false, createMockCompany(100000)),
        createMockPlayer('p2', 'Loser', true, createMockCompany(0)),
      ];
      mockPrisma = createMockPrisma(players);

      await bankruptcyService.checkBankruptcy('room-1', mockPrisma, mockIo);

      const gameOverCalls = (mockIo.emit as ReturnType<typeof vi.fn>).mock.calls.filter(
        (call: [string, ...unknown[]]) => call[0] === 'game:over',
      );
      expect(gameOverCalls.length).toBe(1);
      expect(gameOverCalls[0][1]).toHaveProperty('winner');
      expect(gameOverCalls[0][1]).toHaveProperty('finalStandings');
    });
  });

  describe('Player standings', () => {
    it('should rank players by cash descending', async () => {
      const players = [
        createMockPlayer('p1', 'Player 1', false, createMockCompany(30000)),
        createMockPlayer('p2', 'Player 2', false, createMockCompany(100000)),
        createMockPlayer('p3', 'Player 3', false, createMockCompany(50000)),
      ];
      mockPrisma = createMockPrisma(players);

      const result = await bankruptcyService.checkBankruptcy('room-1', mockPrisma, mockIo);

      expect(result.standings[0].rank).toBe(1);
      expect(result.standings[0].company?.cash).toBe(100000);
      expect(result.standings[1].rank).toBe(2);
      expect(result.standings[1].company?.cash).toBe(50000);
      expect(result.standings[2].rank).toBe(3);
      expect(result.standings[2].company?.cash).toBe(30000);
    });

    it('should treat null company cash as 0', async () => {
      const players = [
        createMockPlayer('p1', 'Player 1', false, null),
        createMockPlayer('p2', 'Player 2', false, createMockCompany(50000)),
      ];
      mockPrisma = createMockPrisma(players);

      const result = await bankruptcyService.checkBankruptcy('room-1', mockPrisma, mockIo);

      expect(result.standings[0].player?.name).toBe('Player 2');
      expect(result.standings[1].player?.name).toBe('Player 1');
    });

    it('should include all players in standings regardless of bankruptcy', async () => {
      const players = [
        createMockPlayer('p1', 'Player 1', false, createMockCompany(50000)),
        createMockPlayer('p2', 'Player 2', true, createMockCompany(0)),
        createMockPlayer('p3', 'Player 3', false, createMockCompany(30000)),
      ];
      mockPrisma = createMockPrisma(players);

      const result = await bankruptcyService.checkBankruptcy('room-1', mockPrisma, mockIo);

      expect(result.standings).toHaveLength(3);
    });
  });

  describe('Return structure', () => {
    it('should return correct structure for no bankruptcy', async () => {
      const players = [
        createMockPlayer('p1', 'Player 1', false, createMockCompany(50000)),
      ];
      mockPrisma = createMockPrisma(players);

      const result = await bankruptcyService.checkBankruptcy('room-1', mockPrisma, mockIo);

      expect(result).toHaveProperty('bankruptPlayers');
      expect(result).toHaveProperty('gameOver');
      expect(result).toHaveProperty('winner');
      expect(result).toHaveProperty('standings');
      expect(Array.isArray(result.bankruptPlayers)).toBe(true);
    });

    it('should return bankrupt player IDs in order', async () => {
      const players = [
        createMockPlayer('p1', 'Player 1', false, createMockCompany(0)),
        createMockPlayer('p2', 'Player 2', false, createMockCompany(50000)),
        createMockPlayer('p3', 'Player 3', false, createMockCompany(-20000)),
      ];
      mockPrisma = createMockPrisma(players);

      const result = await bankruptcyService.checkBankruptcy('room-1', mockPrisma, mockIo);

      expect(result.bankruptPlayers).toContain('p1');
      expect(result.bankruptPlayers).toContain('p3');
      expect(result.bankruptPlayers).not.toContain('p2');
    });
  });
});
