import { create } from 'zustand';
import type { ChatMessageBroadcast } from '@suetheirasses/shared';

/**
 * In-room chat — one continuous conversation for as long as a player stays in a given
 * room, spanning the WAITING lobby (Matchmaking.tsx's inline chat box), GAME_PHASE, and
 * AFTERMATH (both rendered via GamePhase.tsx / GameTimelineView.tsx's floating
 * ChatWidget). Lives in its own store, not gameStore, so it survives the component
 * unmount/remount that happens on every phase transition (App.tsx swaps Matchmaking for
 * GamePhase for GameTimelineView off the same `currentPhase` switch — see CLAUDE.md's
 * "no path-based routing" section) without needing to be threaded through as props.
 *
 * Ephemeral by design, matching the server's own "broadcast-only, nothing persisted"
 * chat model (see gameEngine.ts's `chat:message` handler): a page reload starts empty,
 * same as before this store existed.
 */
interface ChatState {
  /** Which room `messages`/`isVisible`/`unreadCount` belong to — lets `resetForRoom`
   * tell "still the same room" (keep history) apart from "a genuinely different room"
   * (clear it), the same distinction Matchmaking's old per-room reset effect made via
   * a `[room?.id]` dependency. */
  roomId: string | null;
  messages: ChatMessageBroadcast[];
  /** True while a chat surface is actually on-screen and presumed being read — the
   * lobby's always-visible inline box while mounted, or the floating popup panel while
   * open. Gates whether an incoming message bumps `unreadCount`. */
  isVisible: boolean;
  unreadCount: number;
  addMessage: (message: ChatMessageBroadcast) => void;
  /** Mark the chat surface as currently visible/being read — clears any accumulated unread count. */
  show: () => void;
  /** Mark the chat surface as no longer on-screen — subsequent messages accumulate `unreadCount` again. */
  hide: () => void;
  /** Called from socketStore's `room:joined` handler with the just-joined/rejoined room's id — clears history only if it's actually a different room than before. */
  resetForRoom: (roomId: string) => void;
}

export const useChatStore = create<ChatState>((set) => ({
  roomId: null,
  messages: [],
  isVisible: false,
  unreadCount: 0,

  addMessage: (message) =>
    set((state) => ({
      messages: [...state.messages, message],
      unreadCount: state.isVisible ? state.unreadCount : state.unreadCount + 1,
    })),

  show: () => set({ isVisible: true, unreadCount: 0 }),
  hide: () => set({ isVisible: false }),

  resetForRoom: (roomId) =>
    set((state) => (state.roomId === roomId ? {} : { roomId, messages: [], isVisible: false, unreadCount: 0 })),
}));
