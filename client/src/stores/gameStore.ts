import { create } from 'zustand';
import {
  RoomStatus,
  type Room,
  type Player,
  type Company,
  type PhaseChangedResponse,
  type ResultsRevealResponse,
  type GameOverResponse,
  type ErrorResponse,
} from '@suetheirasses/shared';

interface GameState {
  // Room state
  room: Room | null;
  updateRoom: (room: Room) => void;

  // Player state
  player: Player | null;
  updatePlayer: (player: Player) => void;
  updatePlayerReady: (data: { playerId: string; isReady: boolean }) => void;
  addPlayer: (player: Player) => void;
  markPlayerBankrupt: (playerId: string) => void;

  // Phase state
  currentPhase: RoomStatus | null;
  round: number;
  timer: number;
  updatePhase: (data: PhaseChangedResponse) => void;
  updateTimer: (timeLeft: number) => void;

  // Results
  results: ResultsRevealResponse | null;
  updateResults: (data: ResultsRevealResponse) => void;

  // Game over
  gameOver: GameOverResponse | null;
  setGameOver: (data: GameOverResponse) => void;

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
  currentPhase: null,
  round: 1,
  timer: 0,
  results: null,
  gameOver: null,
  error: null,
  notification: null,

  updateRoom: (room) => set({ room, currentPhase: room.status }),
  updatePlayer: (player) => set({ player }),
  updatePlayerReady: (data) =>
    set((state) => ({
      room: state.room
        ? {
            ...state.room,
            players: state.room.players.map((p) =>
              p.id === data.playerId ? { ...p, isReady: data.isReady } : p,
            ),
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
  updatePhase: (data) => set({ currentPhase: data.phase, round: data.round, timer: data.timeLimit }),
  updateTimer: (timeLeft) => set({ timer: timeLeft }),
  updateResults: (data) => set({ results: data, notification: 'Phase results revealed!' }),
  setGameOver: (data) => set({ gameOver: data, notification: `Game Over! ${data.winner?.name || 'Unknown'} wins!` }),
  setError: (error) => set({ error }),
  setNotification: (notification) => set({ notification }),
}));
