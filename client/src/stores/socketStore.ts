import { create } from 'zustand';
import { io, Socket } from 'socket.io-client';
import { ServerEvents, type RoomJoinedResponse, type PhaseChangedResponse, type ResultsRevealResponse, type GameOverResponse, type ErrorResponse } from '@suetheirasses/shared';
import { useGameStore } from './gameStore';

interface SocketState {
  socket: Socket | null;
  isConnected: boolean;
  connect: () => void;
  disconnect: () => void;
  send: (event: string, data: unknown) => void;
  on: (event: string, handler: (data: unknown) => void) => void;
  off: (event: string, handler?: (data: unknown) => void) => void;
}

const SERVER_URL = import.meta.env.VITE_SERVER_URL || 'http://localhost:3001';

export const useSocketStore = create<SocketState>((set, get) => ({
  socket: null,
  isConnected: false,

  connect: () => {
    if (get().socket?.connected) return;

    const socket = io(SERVER_URL, {
      autoConnect: true,
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionAttempts: 5,
    });

    socket.on('connect', () => {
      console.log('Socket connected:', socket.id);
      set({ isConnected: true });
    });

    socket.on('disconnect', () => {
      console.log('Socket disconnected');
      set({ isConnected: false });
    });

    socket.on(ServerEvents.ROOM_JOINED, (data: RoomJoinedResponse) => {
      console.log('Room joined:', data);
      const { updateRoom, updatePlayer, setCompanies } = useGameStore.getState();
      updateRoom(data.room);
      updatePlayer(data.player);
      if (data.companies && data.companies.length > 0) {
        setCompanies(data.companies);
      }
    });

    socket.on(ServerEvents.ROOM_PLAYER_KICKED, (data: { kickedPlayerId: string; kickedPlayerName: string }) => {
      console.log('Player kicked:', data);
      const { kickPlayer } = useGameStore.getState();
      kickPlayer(data.kickedPlayerId);
    });

    socket.on(ServerEvents.ROOM_PLAYER_JOINED, (data: { playerId: string; playerName: string; isHost: boolean; roomId: string }) => {
      console.log('Player joined:', data);
      const { addPlayer, room } = useGameStore.getState();
      // Guard against duplicate players (e.g., from reconnection or stale events)
      if (room && room.players.some((p) => p.id === data.playerId)) {
        console.warn(`Player ${data.playerId} already in room, skipping duplicate add`);
        return;
      }
      addPlayer({
        id: data.playerId,
        name: data.playerName,
        roomId: data.roomId,
        isHost: data.isHost,
        bankrupt: false,
      });
    });

    socket.on(ServerEvents.PHASE_CHANGED, (data: PhaseChangedResponse) => {
      console.log('Phase changed:', data);
      const { updatePhase } = useGameStore.getState();
      updatePhase(data);
    });

    socket.on(ServerEvents.TIMER_UPDATE, (data: { timeLeft: number }) => {
      console.log('Timer update:', data);
      const { updateTimer } = useGameStore.getState();
      updateTimer(data.timeLeft);
    });

    socket.on(ServerEvents.RESULTS_REVEAL, (data: ResultsRevealResponse) => {
      console.log('Results reveal:', data);
      const { updateResults } = useGameStore.getState();
      updateResults(data);
    });

    socket.on(ServerEvents.PLAYER_BANKRUPT, (data: { playerId: string; playerName: string }) => {
      console.log('Player bankrupt:', data);
      const { markPlayerBankrupt } = useGameStore.getState();
      markPlayerBankrupt(data.playerId);
    });

    socket.on(ServerEvents.GAME_OVER, (data: GameOverResponse) => {
      console.log('Game over:', data);
      const { setGameOver } = useGameStore.getState();
      setGameOver(data);
    });

    socket.on(ServerEvents.ERROR, (data: ErrorResponse) => {
      console.error('Server error:', data);
      const { setError } = useGameStore.getState();
      setError(data);
    });

    set({ socket, isConnected: true });
  },

  disconnect: () => {
    const { socket } = get();
    socket?.disconnect();
    set({ socket: null, isConnected: false });
  },

  send: (event: string, data: unknown) => {
    const { socket } = get();
    socket?.emit(event, data);
  },

  on: (event: string, handler: (data: unknown) => void) => {
    const { socket } = get();
    socket?.on(event, handler);
  },

  off: (event: string, handler?: (data: unknown) => void) => {
    const { socket } = get();
    if (handler) {
      socket?.off(event, handler);
    } else {
      socket?.off(event);
    }
  },
}));
