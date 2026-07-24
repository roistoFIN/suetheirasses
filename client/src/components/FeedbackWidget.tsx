import React, { useState } from 'react';
import { ActionIcon, Box, Flex, Text } from '@mantine/core';
import { IconMessageStar, IconX } from '@tabler/icons-react';
import FeedbackForm from './FeedbackForm';

// Same "Courtroom Ink" fab/panel shape as ChatWidget.tsx's own chatStyles — mirrored,
// not imported, since the two differ only in which corner they sit in (see this file's
// own doc comment) and neither is worth threading a shared style module for.
const feedbackStyles = {
  fabWrapper: {
    position: 'fixed',
    bottom: 20,
    left: 20,
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
    left: 20,
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
 * Floating feedback button + popup form — the game-over/replay screen's counterpart to
 * the landing page's inline "Feedback" button + Modal (Matchmaking.tsx). Both embed the
 * same `FeedbackForm`; this shell exists purely because GameTimelineView has no
 * About/Privacy-style inline button row to slot a third button into the way the landing
 * page does, so a floating fab (matching ChatWidget's own pattern) fits this page
 * better instead.
 *
 * Rendered bottom-left — the mirror image of ChatWidget's bottom-right corner.
 * GameTimelineView has no floating Leave button of its own to conflict with here (see
 * ChatWidget's doc comment for why), so bottom-left is free on this screen. Mounted
 * only for `mode === 'finished'` (a genuinely ended game) — not the live spectator
 * view, matching "start page and game-over pages" being the two places feedback was
 * asked for.
 */
const FeedbackWidget: React.FC = () => {
  const [open, setOpen] = useState(false);

  return (
    <>
      {open && (
        <Box style={feedbackStyles.panel}>
          <Flex justify="space-between" align="center" style={feedbackStyles.header}>
            <Text style={feedbackStyles.header}>💬 Feedback</Text>
            <ActionIcon variant="subtle" color="dark" onClick={() => setOpen(false)} aria-label="Close feedback">
              <IconX size={16} />
            </ActionIcon>
          </Flex>
          <Box p={12}>
            <FeedbackForm source="gameover" onClose={() => setOpen(false)} />
          </Box>
        </Box>
      )}

      <Box style={feedbackStyles.fabWrapper}>
        <ActionIcon
          size={50}
          radius="xl"
          onClick={() => setOpen((o) => !o)}
          style={feedbackStyles.fab}
          aria-label={open ? 'Close feedback' : 'Give feedback'}
        >
          <IconMessageStar size={22} />
        </ActionIcon>
      </Box>
    </>
  );
};

export default FeedbackWidget;
