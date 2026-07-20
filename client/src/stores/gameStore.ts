import { create } from 'zustand';
import {
  RoomStatus,
  type Room,
  type Player,
  type Company,
  type PhaseChangedResponse,
  type GameOverResponse,
  type ErrorResponse,
  type TurnResolutionResult,
  type DecisionDefinition,
  type GameSettings,
  type GameDeckResponse,
} from '@suetheirasses/shared';

interface GameState {
  // Room state
  room: Room | null;
  updateRoom: (room: Room) => void;

  // Player state — the current player's identity
  player: Player | null;
  updatePlayer: (player: Player) => void;
  kickPlayer: (playerId: string) => void;
  addPlayer: (player: Player) => void;
  markPlayerBankrupt: (playerId: string) => void;

  // Company state
  companies: Map<string, Company>;
  setCompanies: (companies: Company[]) => void;

  // Phase state
  currentPhase: RoomStatus | null;
  round: number;
  timer: number;
  updatePhase: (data: PhaseChangedResponse) => void;
  updateTimer: (timeLeft: number) => void;

  // Turn results — all players' computed states after each turn
  turnResults: TurnResolutionResult | null;
  handleTurnResolved: (data: TurnResolutionResult) => void;
  clearTurnResults: () => void;

  // Decision deck — the 45-decision library + per-turn limits, sent once per game
  decisions: DecisionDefinition[];
  gameSettings: GameSettings | null;
  setGameDeck: (data: GameDeckResponse) => void;

  // Game over
  gameOver: GameOverResponse | null;
  setGameOver: (data: GameOverResponse) => void;
  clearGameOver: () => void;

  // UI state
  error: ErrorResponse | null;
  setError: (error: ErrorResponse | null) => void;
  notification: string | null;
  setNotification: (message: string | null) => void;
}

export const useGameStore = create<GameState>((set) => ({
  // Initial state
  room: null,
  player: null,
  companies: new Map(),
  currentPhase: null,
  round: 1,
  timer: 0,

  turnResults: null,
  decisions: [],
  gameSettings: null,
  gameOver: null,
  error: null,
  notification: null,

  updateRoom: (room) => set({ room, currentPhase: room.status }),
  updatePlayer: (player) => set({ player }),
  kickPlayer: (playerId) =>
    set((state) => ({
      room: state.room
        ? {
            ...state.room,
            players: state.room.players.filter((p) => p.id !== playerId),
          }
        : null,
    })),
  addPlayer: (player) =>
    set((state) => ({
      room: state.room
        ? {
            ...state.room,
            players: [...state.room.players, player],
          }
        : null,
    })),
  markPlayerBankrupt: (playerId) =>
    set((state) => ({
      room: state.room
        ? {
            ...state.room,
            players: state.room.players.map((p) =>
              p.id === playerId ? { ...p, bankrupt: true } : p,
            ),
          }
        : null,
      notification: `Player has gone bankrupt!`,
    })),
  updatePhase: (data) =>
    set((state) => ({
      currentPhase: data.phase,
      round: data.round,
      timer: data.timeLimit,
      room: state.room ? { ...state.room, status: data.phase } : null,
    })),
  updateTimer: (timeLeft) => set({ timer: timeLeft }),
  handleTurnResolved: (data) =>
    set({
      turnResults: data,
      round: data.round,
    }),
  clearTurnResults: () => set({ turnResults: null }),
  setGameDeck: (data) => set({ decisions: data.decisions, gameSettings: data.gameSettings }),
  setGameOver: (data) => set({ gameOver: data, notification: `Game Over! ${data.winner?.name || 'Unknown'} wins!` }),
  clearGameOver: () => set({ gameOver: null }),
  setError: (error) => set({ error }),
  setNotification: (notification) => set({ notification }),
  setCompanies: (companies) => {
    const companyMap = new Map<string, Company>();
    for (const c of companies) {
      companyMap.set(c.id, c);
    }
    return set({ companies: companyMap });
  },
}));
