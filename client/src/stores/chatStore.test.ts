import { describe, it, expect, beforeEach } from 'vitest';
import { useChatStore } from './chatStore';
import type { ChatMessageBroadcast } from '@suetheirasses/shared';

const createMessage = (overrides: Partial<ChatMessageBroadcast> = {}): ChatMessageBroadcast => ({
  playerId: 'player-1',
  playerName: 'Alice',
  message: 'hello',
  timestamp: new Date().toISOString(),
  ...overrides,
});

describe('chatStore', () => {
  beforeEach(() => {
    useChatStore.setState({ roomId: null, messages: [], isVisible: false, unreadCount: 0 });
  });

  describe('addMessage', () => {
    it('appends the message to history', () => {
      useChatStore.getState().addMessage(createMessage({ message: 'first' }));
      useChatStore.getState().addMessage(createMessage({ message: 'second' }));

      expect(useChatStore.getState().messages.map((m) => m.message)).toEqual(['first', 'second']);
    });

    it('increments unreadCount when the chat surface is not currently visible', () => {
      useChatStore.getState().addMessage(createMessage());
      useChatStore.getState().addMessage(createMessage());

      expect(useChatStore.getState().unreadCount).toBe(2);
    });

    it('does not increment unreadCount while the chat surface is visible (e.g. the popup is open)', () => {
      useChatStore.getState().show();
      useChatStore.getState().addMessage(createMessage());
      useChatStore.getState().addMessage(createMessage());

      expect(useChatStore.getState().unreadCount).toBe(0);
    });
  });

  describe('show / hide', () => {
    it('show() clears any accumulated unread count', () => {
      useChatStore.getState().addMessage(createMessage());
      expect(useChatStore.getState().unreadCount).toBe(1);

      useChatStore.getState().show();

      expect(useChatStore.getState().isVisible).toBe(true);
      expect(useChatStore.getState().unreadCount).toBe(0);
    });

    it('hide() lets subsequent messages accumulate unread again', () => {
      useChatStore.getState().show();
      useChatStore.getState().hide();
      useChatStore.getState().addMessage(createMessage());

      expect(useChatStore.getState().isVisible).toBe(false);
      expect(useChatStore.getState().unreadCount).toBe(1);
    });
  });

  describe('resetForRoom', () => {
    it('keeps existing history when called again for the same room', () => {
      useChatStore.getState().resetForRoom('room-1');
      useChatStore.getState().addMessage(createMessage({ message: 'still here' }));

      useChatStore.getState().resetForRoom('room-1');

      expect(useChatStore.getState().messages.map((m) => m.message)).toEqual(['still here']);
    });

    it('clears history, unread count, and visibility when the room actually changes — e.g. leaving one room and joining another', () => {
      useChatStore.getState().resetForRoom('room-1');
      useChatStore.getState().show();
      useChatStore.getState().addMessage(createMessage({ message: 'room 1 chatter' }));
      useChatStore.getState().hide();
      useChatStore.getState().addMessage(createMessage({ message: 'missed this one' }));

      useChatStore.getState().resetForRoom('room-2');

      expect(useChatStore.getState().roomId).toBe('room-2');
      expect(useChatStore.getState().messages).toEqual([]);
      expect(useChatStore.getState().unreadCount).toBe(0);
      expect(useChatStore.getState().isVisible).toBe(false);
    });

    // The continuous-history requirement this store exists for: the same room's
    // conversation (and any already-accumulated unread count) must survive the lobby →
    // game → game-over phase transitions, which is exactly "resetForRoom called again
    // with the same room id" from socketStore's room:joined handler — it does not fire
    // on every phase change, only on an actual (re)join.
    it('does not touch messages/unreadCount for phase transitions within the same room', () => {
      useChatStore.getState().resetForRoom('room-1');
      useChatStore.getState().addMessage(createMessage({ message: 'from the lobby' }));

      // Simulate the room:joined re-fire that happens on a rejoin, still the same room.
      useChatStore.getState().resetForRoom('room-1');

      expect(useChatStore.getState().messages.map((m) => m.message)).toEqual(['from the lobby']);
      expect(useChatStore.getState().unreadCount).toBe(1);
    });
  });
});
