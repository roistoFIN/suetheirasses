import React, { useEffect, useRef, useState } from 'react';
import { ActionIcon, Box, Flex, Indicator, ScrollArea, Stack, Text, TextInput } from '@mantine/core';
import { IconMessage, IconSend, IconX } from '@tabler/icons-react';
import { useGameStore } from '../stores/gameStore';
import { useSocketStore } from '../stores/socketStore';
import { useChatStore } from '../stores/chatStore';
import { ClientEvents } from '@suetheirasses/shared';

// "Courtroom Ink" tokens, matching GamePhase.tsx's gpStyles / Matchmaking.tsx's mmStyles
// conventions — kept local since this is a small, self-contained widget.
const chatStyles = {
  // Positioning lives on this wrapper, not the ActionIcon it wraps — Mantine's
  // Indicator (used below for the unread badge) positions its badge relative to its
  // child's normal-flow box. Putting `position: fixed` directly on the ActionIcon would
  // pull it out of flow and collapse that box to zero size, leaving the badge stranded
  // wherever the collapsed box happened to be rather than tracking the button.
  fabWrapper: {
    position: 'fixed',
    bottom: 20,
    right: 20,
    zIndex: 100,
  } as React.CSSProperties,
  fab: {
    background: 'var(--ink-text)',
    color: 'var(--ink-parchment)',
    border: '2px solid var(--ink-gold)',
    boxShadow: '3px 4px 0 rgba(0,0,0,0.45)',
  } as React.CSSProperties,
  panel: {
    position: 'fixed',
    bottom: 84,
    right: 20,
    zIndex: 101,
    width: 320,
    maxWidth: 'calc(100vw - 40px)',
    background: 'var(--ink-parchment)',
    backgroundImage: 'var(--paper-texture)',
    border: '2px solid var(--ink-gold)',
    borderRadius: 4,
    boxShadow: '6px 8px 0 rgba(0,0,0,0.45)',
    display: 'flex',
    flexDirection: 'column',
  } as React.CSSProperties,
  header: {
    fontFamily: "'Rye', Georgia, serif",
    fontWeight: 400,
    color: 'var(--ink-text)',
    borderBottom: '2px solid var(--ink-hairline-light)',
    padding: '10px 12px',
  } as React.CSSProperties,
};

/**
 * Floating chat button + popup window — the in-game / game-over counterpart to the
 * room lobby's always-visible inline chat box (Matchmaking.tsx). Both read/write the
 * same shared `chatStore` (see its doc comment), so a conversation started in the lobby
 * is still there once the game starts and after it ends; this widget just changes how
 * it's presented once there's a full dashboard around it instead of a lobby screen.
 *
 * Rendered fixed in the page's bottom-right corner (GamePhase.tsx's floating Leave Game
 * button occupies the matching bottom-left spot — the two are a deliberate pair, not
 * independently placed). Mounted by GamePhase.tsx (GAME_PHASE) and GameTimelineView.tsx
 * (AFTERMATH's finished-game replay, and the live spectator view for an eliminated
 * player who chose to keep watching).
 */
const ChatWidget: React.FC = () => {
  const [open, setOpen] = useState(false);
  const [chatInput, setChatInput] = useState('');
  const chatViewportRef = useRef<HTMLDivElement>(null);
  const { send } = useSocketStore();
  const { player } = useGameStore();
  const { messages, unreadCount, show, hide } = useChatStore();

  // The store's own "visible" flag (which gates whether an incoming message counts as
  // unread) follows this popup's own open/closed state — see chatStore.ts.
  useEffect(() => {
    if (open) {
      show();
    } else {
      hide();
    }
  }, [open, show, hide]);

  // Also mark read/unread on unmount (e.g. the game ends and GamePhase swaps for
  // GameTimelineView while this widget was open) — otherwise the store would be left
  // thinking the (now-gone) panel is still visible, silently swallowing every message
  // that arrives before the next widget instance mounts and re-opens.
  useEffect(() => () => hide(), [hide]);

  useEffect(() => {
    if (!open) return;
    chatViewportRef.current?.scrollTo({ top: chatViewportRef.current.scrollHeight });
  }, [messages, open]);

  if (!player) return null;

  const handleSend = () => {
    const trimmed = chatInput.trim();
    if (!trimmed) return;
    send(ClientEvents.CHAT_MESSAGE, { message: trimmed });
    setChatInput('');
  };

  return (
    <>
      {open && (
        <Box style={chatStyles.panel}>
          <Flex justify="space-between" align="center" style={chatStyles.header}>
            <Text style={chatStyles.header}>💬 Chat</Text>
            <ActionIcon variant="subtle" color="dark" onClick={() => setOpen(false)} aria-label="Close chat">
              <IconX size={16} />
            </ActionIcon>
          </Flex>
          <ScrollArea h={200} viewportRef={chatViewportRef} type="auto" p={8} style={{ background: '#f6efd9' }}>
            <Stack gap={4}>
              {messages.length === 0 && (
                <Text size="sm" style={{ color: 'var(--ink-text-soft)' }}>
                  No messages yet — say hi.
                </Text>
              )}
              {messages.map((m, i) => (
                <Text key={i} size="sm" style={{ color: 'var(--ink-text)' }}>
                  <Text span fw={600}>
                    {m.playerId === player.id ? 'You' : m.playerName}:
                  </Text>{' '}
                  {m.message}
                </Text>
              ))}
            </Stack>
          </ScrollArea>
          <Flex gap="xs" p={8}>
            <TextInput
              placeholder="Type a message..."
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleSend();
              }}
              maxLength={500}
              style={{ flex: 1 }}
              size="sm"
            />
            <ActionIcon
              size="lg"
              variant="filled"
              disabled={!chatInput.trim()}
              onClick={handleSend}
              aria-label="Send message"
              style={{ background: 'var(--ink-text)', border: '2px solid var(--ink-gold)' }}
            >
              <IconSend size={16} />
            </ActionIcon>
          </Flex>
        </Box>
      )}

      <Box style={chatStyles.fabWrapper}>
        <Indicator
          label={unreadCount > 9 ? '9+' : unreadCount}
          size={18}
          color="red"
          disabled={open || unreadCount === 0}
          offset={6}
        >
          <ActionIcon
            size={50}
            radius="xl"
            onClick={() => setOpen((o) => !o)}
            style={chatStyles.fab}
            aria-label={open ? 'Close chat' : 'Open chat'}
          >
            <IconMessage size={22} />
          </ActionIcon>
        </Indicator>
      </Box>
    </>
  );
};

export default ChatWidget;
