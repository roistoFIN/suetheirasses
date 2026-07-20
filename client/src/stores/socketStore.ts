import { create } from 'zustand';
import { io, Socket } from 'socket.io-client';
import { ClientEvents, ServerEvents, type RoomJoinedResponse, type RoomRejoinPayload, type PhaseChangedResponse, type GameOverResponse, type ErrorResponse, type TurnResolutionResult, type GameDeckResponse, type DigDeeperResultPayload, type AnnualReportResultPayload } from '@suetheirasses/shared';
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

/**
 * Session persistence, for resuming an existing room/player identity after a page
 * reload, an accidental back button, or a brief network drop — the server keeps a
 * disconnected player around for a grace period (see `GameEngine.markPlayerDisconnected`),
 * but has nothing to resume TO unless the client remembers who it was.
 */
const SESSION_KEY = 'stita_session';

function saveSession(roomId: string, playerId: string): void {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify({ roomId, playerId }));
  } catch {
    // localStorage unavailable (private browsing, etc.) — reconnection just won't survive a reload.
  }
}

function loadSession(): RoomRejoinPayload | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (typeof parsed?.roomId !== 'string' || typeof parsed?.playerId !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

function clearSession(): void {
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch {
    // Nothing to clean up if storage isn't available in the first place.
  }
}

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

      // Fires on the first connect AND on every Socket.IO-driven auto-reconnect after
      // a transient drop — so a brief network blip with the tab still open self-heals
      // here too, not just a full page reload. No-op if there's no saved session.
      const session = loadSession();
      if (session) {
        useGameStore.getState().setIsRejoining(true);
        socket.emit(ClientEvents.ROOM_REJOIN, session);
      }
    });

    socket.on('disconnect', () => {
      console.log('Socket disconnected');
      set({ isConnected: false });
    });

    socket.on(ServerEvents.ROOM_JOINED, (data: RoomJoinedResponse) => {
      console.log('Room joined:', data);
      const { updateRoom, updatePlayer, setCompanies, setIsRejoining } = useGameStore.getState();
      updateRoom(data.room);
      updatePlayer(data.player);
      if (data.companies && data.companies.length > 0) {
        setCompanies(data.companies);
      }
      // Covers both a fresh join AND a successful rejoin — the server reuses this
      // same event for both, so this is also where a resumed session gets re-saved.
      saveSession(data.room.id, data.player.id);
      setIsRejoining(false);
    });

    socket.on(ServerEvents.ROOM_PLAYER_KICKED, (data: { kickedPlayerId: string; kickedPlayerName: string }) => {
      console.log('Player kicked:', data);
      const { kickPlayer, player } = useGameStore.getState();
      kickPlayer(data.kickedPlayerId);
      // If I'm the one who got kicked, there's no session left to resume.
      if (player && data.kickedPlayerId === player.id) {
        clearSession();
      }
    });

    socket.on(ServerEvents.ROOM_PLAYER_LEFT, (data: { playerId: string; playerName: string; roomId: string }) => {
      console.log('Player left (reconnect grace period expired):', data);
      const { kickPlayer, setNotification } = useGameStore.getState();
      kickPlayer(data.playerId); // same "remove from roster" logic as a kick
      setNotification(`${data.playerName}'s connection timed out`);
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

    socket.on(ServerEvents.TURN_RESOLVED, (data: TurnResolutionResult) => {
      console.log('Turn resolved:', data);
      const { handleTurnResolved } = useGameStore.getState();
      handleTurnResolved(data);
    });

    socket.on(ServerEvents.GAME_DECK, (data: GameDeckResponse) => {
      console.log('Game deck loaded:', data.decisions.length, 'decisions');
      const { setGameDeck } = useGameStore.getState();
      setGameDeck(data);
    });

    socket.on(ServerEvents.TIMER_UPDATE, (data: { timeLeft: number }) => {
      console.log('Timer update:', data);
      const { updateTimer } = useGameStore.getState();
      updateTimer(data.timeLeft);
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
      // Game's truly over — nothing left to reconnect to.
      clearSession();
    });

    socket.on(ServerEvents.ERROR, (data: ErrorResponse) => {
      console.error('Server error:', data);
      const { setError, setIsRejoining } = useGameStore.getState();
      setError(data);
      if (data.code === 'REJOIN_FAILED') {
        // Stale/expired/bogus session — clear it and fall through to the normal landing page.
        clearSession();
        setIsRejoining(false);
      }
    });

    socket.on(ServerEvents.GAME_DIG_DEEPER_RESULT, (data: DigDeeperResultPayload) => {
      console.log('Dig deeper result:', data);
      const { player, applyDigDeeperResult } = useGameStore.getState();
      if (player) applyDigDeeperResult(player.id, data);
    });

    socket.on(ServerEvents.GAME_ANNUAL_REPORT_RESULT, (data: AnnualReportResultPayload) => {
      console.log('Annual report result:', data.rivalPlayerId, data.entries.length, 'entries');
      const { applyAnnualReportResult } = useGameStore.getState();
      applyAnnualReportResult(data.rivalPlayerId, data.entries);
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
