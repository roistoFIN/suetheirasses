import { describe, it, expect, beforeEach } from 'vitest';
import { useGameStore } from './gameStore';
import { RoomStatus } from '@suetheirasses/shared';
import type { Room, Player, PhaseChangedResponse, GameOverResponse, ErrorResponse, TurnResolutionResult, PlayerTurnResult } from '@suetheirasses/shared';

// Helper to create a mock room
const createMockRoom = (overrides: Partial<Room> = {}): Room => ({
  id: 'room-1',
  status: RoomStatus.WAITING,
  maxPlayers: 4,
  currentPhaseRound: 1,
  players: [],
  createdAt: new Date(),
  inviteOnly: false,
  ...overrides,
});

// Helper to create a mock player
const createMockPlayer = (overrides: Partial<Player> = {}): Player => ({
  id: 'player-1',
  name: 'Alice',
  roomId: 'room-1',
  isHost: false,
  bankrupt: false,
  ...overrides,
});

// Helper to reset store to a clean initial state
const resetStore = () => {
  const store = useGameStore.getState();
  // Reset to initial values using store methods
  store.updateRoom(createMockRoom());
  store.updatePlayer(createMockPlayer());
  store.updatePhase({ phase: RoomStatus.WAITING, round: 1, timeLimit: 0 });
  store.setError(null);
  store.setNotification(null);
  store.clearTurnResults();
  store.clearGameOver();
};

describe('gameStore', () => {
  beforeEach(() => {
    resetStore();
  });

  describe('updateRoom', () => {
    it('should update room state', () => {
      const newRoom = createMockRoom({
        id: 'room-2',
        status: RoomStatus.GAME_PHASE,
      });

      useGameStore.getState().updateRoom(newRoom);

      expect(useGameStore.getState().room?.id).toBe('room-2');
      expect(useGameStore.getState().room?.status).toBe(RoomStatus.GAME_PHASE);
    });


  });

  describe('updatePlayer', () => {
    it('should update player state', () => {
      const newPlayer = createMockPlayer({
        id: 'player-2',
        name: 'Bob',
        isHost: true,
      });

      useGameStore.getState().updatePlayer(newPlayer);

      expect(useGameStore.getState().player?.id).toBe('player-2');
      expect(useGameStore.getState().player?.name).toBe('Bob');
      expect(useGameStore.getState().player?.isHost).toBe(true);
    });
  });

  describe('kickPlayer', () => {
    it('should remove a player from the room by playerId', () => {
      const room = createMockRoom({
        players: [
          createMockPlayer({ id: 'player-1', name: 'Alice' }),
          createMockPlayer({ id: 'player-2', name: 'Bob' }),
          createMockPlayer({ id: 'player-3', name: 'Charlie' }),
        ],
      });
      useGameStore.getState().updateRoom(room);

      useGameStore.getState().kickPlayer('player-2');

      expect(useGameStore.getState().room?.players.length).toBe(2);
      expect(useGameStore.getState().room?.players.map((p) => p.id)).toEqual(['player-1', 'player-3']);
    });

    it('should not modify room if player does not exist', () => {
      const room = createMockRoom({
        players: [
          createMockPlayer({ id: 'player-1', name: 'Alice' }),
          createMockPlayer({ id: 'player-2', name: 'Bob' }),
        ],
      });
      useGameStore.getState().updateRoom(room);

      useGameStore.getState().kickPlayer('nonexistent-player');

      expect(useGameStore.getState().room?.players.length).toBe(2);
    });

    it('should handle kicking the last player', () => {
      const room = createMockRoom({
        players: [
          createMockPlayer({ id: 'player-1', name: 'Alice' }),
        ],
      });
      useGameStore.getState().updateRoom(room);

      useGameStore.getState().kickPlayer('player-1');

      expect(useGameStore.getState().room?.players.length).toBe(0);
    });

    it('should not throw when kicking a non-existent player', () => {
      const room = createMockRoom({
        players: [
          createMockPlayer({ id: 'player-1', name: 'Alice' }),
        ],
      });
      useGameStore.getState().updateRoom(room);

      // Should not throw even if player doesn't exist
      expect(() => useGameStore.getState().kickPlayer('nonexistent')).not.toThrow();
    });

    it('should preserve other room properties when kicking a player', () => {
      const room = createMockRoom({
        id: 'room-1',
        status: RoomStatus.GAME_PHASE,
        maxPlayers: 4,
        currentPhaseRound: 3,
        players: [
          createMockPlayer({ id: 'player-1', name: 'Alice' }),
          createMockPlayer({ id: 'player-2', name: 'Bob' }),
        ],
      });
      useGameStore.getState().updateRoom(room);

      useGameStore.getState().kickPlayer('player-2');

      expect(useGameStore.getState().room?.id).toBe('room-1');
      expect(useGameStore.getState().room?.status).toBe(RoomStatus.GAME_PHASE);
      expect(useGameStore.getState().room?.maxPlayers).toBe(4);
      expect(useGameStore.getState().room?.currentPhaseRound).toBe(3);
    });
  });

  describe('addPlayer', () => {
    it('should add a new player to the room', () => {
      const room = createMockRoom({
        players: [
          createMockPlayer({ id: 'player-1', name: 'Alice' }),
        ],
      });
      useGameStore.getState().updateRoom(room);

      const newPlayer = createMockPlayer({
        id: 'player-2',
        name: 'Bob',
        isHost: false,
      });
      useGameStore.getState().addPlayer(newPlayer);

      expect(useGameStore.getState().room?.players.length).toBe(2);
      expect(useGameStore.getState().room?.players.find((p) => p.id === 'player-2')?.name).toBe('Bob');
    });

    it('should not throw when adding to a room with existing players', () => {
      const room = createMockRoom({
        players: [
          createMockPlayer({ id: 'player-1', name: 'Alice' }),
        ],
      });
      useGameStore.getState().updateRoom(room);

      // Should not throw
      expect(() => {
        useGameStore.getState().addPlayer(createMockPlayer({ id: 'player-2', name: 'Bob' }));
      }).not.toThrow();
    });

    it('should preserve existing players when adding a new one', () => {
      const room = createMockRoom({
        players: [
          createMockPlayer({ id: 'player-1', name: 'Alice', isHost: true }),
        ],
      });
      useGameStore.getState().updateRoom(room);

      const newPlayer = createMockPlayer({
        id: 'player-2',
        name: 'Bob',
        isHost: false,
      });
      useGameStore.getState().addPlayer(newPlayer);

      const alice = useGameStore.getState().room?.players.find((p) => p.id === 'player-1');
      expect(alice?.name).toBe('Alice');
      expect(alice?.isHost).toBe(true);
    });
  });

  describe('markPlayerBankrupt', () => {
    it('should mark a player as bankrupt', () => {
      const room = createMockRoom({
        players: [
          createMockPlayer({ id: 'player-1', name: 'Alice', bankrupt: false }),
        ],
      });
      useGameStore.getState().updateRoom(room);

      useGameStore.getState().markPlayerBankrupt('player-1');

      const player = useGameStore.getState().room?.players.find((p) => p.id === 'player-1');
      expect(player?.bankrupt).toBe(true);
    });

    it('should not modify state if player does not exist', () => {
      const room = createMockRoom({
        players: [
          createMockPlayer({ id: 'player-1', name: 'Alice' }),
        ],
      });
      useGameStore.getState().updateRoom(room);

      useGameStore.getState().markPlayerBankrupt('nonexistent');

      expect(useGameStore.getState().room?.players.length).toBe(1);
    });

    it('should not throw when marking a non-existent player as bankrupt', () => {
      const room = createMockRoom({
        players: [
          createMockPlayer({ id: 'player-1', name: 'Alice' }),
        ],
      });
      useGameStore.getState().updateRoom(room);

      // Should not throw even if player doesn't exist
      expect(() => useGameStore.getState().markPlayerBankrupt('nonexistent')).not.toThrow();
    });
  });

  describe('updatePhase', () => {
    it('should update phase and round from phase changed response', () => {
      const phaseData: PhaseChangedResponse = {
        phase: RoomStatus.GAME_PHASE,
        round: 2,
        timeLimit: 120,
      };

      useGameStore.getState().updatePhase(phaseData);

      expect(useGameStore.getState().currentPhase).toBe(RoomStatus.GAME_PHASE);
      expect(useGameStore.getState().round).toBe(2);
      expect(useGameStore.getState().timer).toBe(120);
    });


  });

  describe('updateTimer', () => {
    it('should update timer value', () => {
      useGameStore.getState().updateTimer(60);
      expect(useGameStore.getState().timer).toBe(60);
    });

    it('should handle timer decrement', () => {
      useGameStore.getState().updateTimer(120);
      useGameStore.getState().updateTimer(119);
      useGameStore.getState().updateTimer(118);

      expect(useGameStore.getState().timer).toBe(118);
    });
  });

  describe('handleTurnResolved', () => {
    it('should store turn resolution data', () => {
      const playerData: PlayerTurnResult = {
        playerId: 'player-1',
        playerName: 'Alice',
        variables: {
          cash: 100000, assets: 1000000, intangibleAssets: 100000, debt: 0,
          reserves: 0, operatingExpenses: 20000, staffCost: 10000,
          materialCostPerTon: 500, otherIncome: 0, price: 700,
          capacityUtilization: 1.0, processingLevel: 0.5, energyIntensity: 50,
          moistureContent: 0.3, nutrientConsistency: 0.3, supplySecurity: 0.5,
          logisticsCostPerTon: 50, processLoss: 0.1, installedCapacity: 350,
          totalSharesOutstanding: 10000, shareOwnership: { self: 1.0 },
          outrage: 0, scrutiny: 0, breakdowns: 0, contaminationRisk: 0,
          odorComplaints: 0, tokenLiability: 0, carbonFootprint: 0,
          stockVolume: 0, demand: 0,
        },
        derived: {
          equity: 1200000, revenue: 245000, volume: 350, receivables: 30000,
          financeCost: 5000, taxCost: 2800, depreciation: 3300, stockValue: 120,
          marketShare: 0.33, competitiveness: 1.2,
        },
        activeDecisions: [],
        legalCases: [],
        riskGauge: 15,
        incomingAttacks: [],
      };

      const turnResult: TurnResolutionResult = {
        round: 1,
        players: [playerData],
        gameOver: false,
      };

      useGameStore.getState().handleTurnResolved(turnResult);

      expect(useGameStore.getState().turnResults).toEqual(turnResult);
      expect(useGameStore.getState().round).toBe(1);
    });
  });

  describe('applyDigDeeperResult', () => {
    const makePlayer = (overrides: Partial<PlayerTurnResult> = {}): PlayerTurnResult => ({
      playerId: 'player-1',
      playerName: 'Alice',
      variables: {
        cash: 100000, assets: 1000000, intangibleAssets: 100000, debt: 0,
        reserves: 0, operatingExpenses: 20000, staffCost: 10000,
        materialCostPerTon: 500, otherIncome: 0, price: 700,
        capacityUtilization: 1.0, processingLevel: 0.5, energyIntensity: 50,
        moistureContent: 0.3, nutrientConsistency: 0.3, supplySecurity: 0.5,
        logisticsCostPerTon: 50, processLoss: 0.1, installedCapacity: 350,
        totalSharesOutstanding: 10000, shareOwnership: { self: 1.0 },
        outrage: 0, scrutiny: 0, breakdowns: 0, contaminationRisk: 0,
        odorComplaints: 0, tokenLiability: 0, carbonFootprint: 0,
        stockVolume: 0, demand: 0,
      },
      derived: {
        equity: 1200000, revenue: 245000, volume: 350, receivables: 30000,
        financeCost: 5000, taxCost: 2800, depreciation: 3300, stockValue: 120,
        marketShare: 0.33, competitiveness: 1.2,
      },
      activeDecisions: [],
      legalCases: [],
      riskGauge: 15,
      incomingAttacks: [{ attackId: 'attack-1', investigationLevel: 0 }],
      ...overrides,
    });

    it('patches only the requesting player\'s cash and matching attack entry', () => {
      const me = makePlayer();
      const rival = makePlayer({ playerId: 'player-2', playerName: 'Bob', incomingAttacks: [] });
      useGameStore.getState().handleTurnResolved({ round: 1, players: [me, rival], gameOver: false });

      useGameStore.getState().applyDigDeeperResult('player-1', {
        attackId: 'attack-1',
        cost: 10000,
        newCash: 90000,
        attack: { attackId: 'attack-1', investigationLevel: 1, attackerId: 'player-3', attackerName: 'Carol' },
      });

      const updated = useGameStore.getState().turnResults!.players;
      const updatedMe = updated.find((p) => p.playerId === 'player-1')!;
      const updatedRival = updated.find((p) => p.playerId === 'player-2')!;

      expect(updatedMe.variables.cash).toBe(90000);
      expect(updatedMe.incomingAttacks).toEqual([{ attackId: 'attack-1', investigationLevel: 1, attackerId: 'player-3', attackerName: 'Carol' }]);
      // Other fields untouched.
      expect(updatedMe.variables.assets).toBe(1000000);
      // Other players untouched.
      expect(updatedRival).toEqual(rival);
    });

    it('is a no-op when there are no turn results yet', () => {
      expect(() =>
        useGameStore.getState().applyDigDeeperResult('player-1', {
          attackId: 'attack-1',
          cost: 10000,
          newCash: 90000,
          attack: { attackId: 'attack-1', investigationLevel: 1 },
        }),
      ).not.toThrow();
      expect(useGameStore.getState().turnResults).toBeNull();
    });
  });

  describe('setGameOver', () => {
    it('should store game over data', () => {
      const gameOver: GameOverResponse = {
        winner: { id: 'player-1', name: 'Alice', roomId: 'room-1', isHost: false, bankrupt: false },
        finalStandings: [
          { player: { id: 'player-1', name: 'Alice', roomId: 'room-1', isHost: false, bankrupt: false }, company: null, rank: 1 },
          { player: { id: 'player-2', name: 'Bob', roomId: 'room-1', isHost: false, bankrupt: false }, company: null, rank: 2 },
        ],
      };

      useGameStore.getState().setGameOver(gameOver);

      expect(useGameStore.getState().gameOver).toEqual(gameOver);
      expect(useGameStore.getState().gameOver?.winner.name).toBe('Alice');
    });

    it('should overwrite previous game over state', () => {
      const gameOver1: GameOverResponse = {
        winner: { id: 'player-1', name: 'Alice', roomId: 'room-1', isHost: false, bankrupt: false },
        finalStandings: [],
      };
      const gameOver2: GameOverResponse = {
        winner: { id: 'player-2', name: 'Bob', roomId: 'room-1', isHost: false, bankrupt: false },
        finalStandings: [],
      };

      useGameStore.getState().setGameOver(gameOver1);
      useGameStore.getState().setGameOver(gameOver2);

      expect(useGameStore.getState().gameOver?.winner.name).toBe('Bob');
    });
  });

  describe('setError', () => {
    it('should store error data', () => {
      const error: ErrorResponse = {
        code: 'NOT_HOST',
        message: 'Only the host can perform this action',
      };

      useGameStore.getState().setError(error);

      expect(useGameStore.getState().error?.code).toBe('NOT_HOST');
      expect(useGameStore.getState().error?.message).toBe('Only the host can perform this action');
    });

    it('should clear error when set to null', () => {
      useGameStore.getState().setError({ code: 'ERROR', message: 'Something went wrong' });
      useGameStore.getState().setError(null);

      expect(useGameStore.getState().error).toBeNull();
    });
  });

  describe('setNotification', () => {
    it('should store notification message', () => {
      useGameStore.getState().setNotification('Player joined the room');

      expect(useGameStore.getState().notification).toBe('Player joined the room');
    });

    it('should clear notification when set to null', () => {
      useGameStore.getState().setNotification('Hello');
      useGameStore.getState().setNotification(null);

      expect(useGameStore.getState().notification).toBeNull();
    });
  });

  describe('initial state', () => {
    it('should have null player initially', () => {
      useGameStore.getState().updatePlayer(null as any);
      expect(useGameStore.getState().player).toBeNull();
    });

    it('should have null error initially', () => {
      expect(useGameStore.getState().error).toBeNull();
    });

    it('should have null notification initially', () => {
      expect(useGameStore.getState().notification).toBeNull();
    });

    it('should have round 1 after reset', () => {
      resetStore();
      expect(useGameStore.getState().round).toBe(1);
    });

    it('should have timer 0 after reset', () => {
      resetStore();
      expect(useGameStore.getState().timer).toBe(0);
    });

    it('should have null turnResults after reset', () => {
      resetStore();
      expect(useGameStore.getState().turnResults).toBeNull();
    });

    it('should have null gameOver after reset', () => {
      resetStore();
      expect(useGameStore.getState().gameOver).toBeNull();
    });
  });

  describe('isHost field', () => {
    it('should correctly track host status when updating player', () => {
      const hostPlayer = createMockPlayer({ id: 'player-1', name: 'Alice', isHost: true });
      const regularPlayer = createMockPlayer({ id: 'player-2', name: 'Bob', isHost: false });

      useGameStore.getState().updatePlayer(hostPlayer);

      const room = createMockRoom({
        players: [hostPlayer, regularPlayer],
      });
      useGameStore.getState().updateRoom(room);

      const alice = useGameStore.getState().room?.players.find((p) => p.id === 'player-1');
      const bob = useGameStore.getState().room?.players.find((p) => p.id === 'player-2');

      expect(alice?.isHost).toBe(true);
      expect(bob?.isHost).toBe(false);
    });

    it('should preserve isHost when kicking a non-host player', () => {
      const room = createMockRoom({
        players: [
          createMockPlayer({ id: 'player-1', name: 'Alice', isHost: true }),
          createMockPlayer({ id: 'player-2', name: 'Bob', isHost: false }),
        ],
      });
      useGameStore.getState().updateRoom(room);

      useGameStore.getState().kickPlayer('player-2');

      const remainingPlayer = useGameStore.getState().room?.players[0];
      expect(remainingPlayer?.isHost).toBe(true);
      expect(remainingPlayer?.name).toBe('Alice');
    });
  });
});
