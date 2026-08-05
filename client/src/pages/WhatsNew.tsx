import React from 'react';
import { Container, Paper, Title, Text, Stack, List, Badge, Group, Button } from '@mantine/core';
import { IconArrowLeft } from '@tabler/icons-react';

// "Courtroom Ink" tokens — same tokens as Matchmaking.tsx's mmStyles/GamePhase.tsx's
// gpStyles, defined locally per the codebase's established per-file duplication
// convention (see CLAUDE.md's *Client-side duplicated pure logic* section).
const wnStyles = {
  paper: {
    background: 'var(--ink-parchment)',
    backgroundImage: 'var(--paper-texture)',
    border: '1px solid #cbb888',
    borderRadius: 4,
    boxShadow: '6px 8px 0 rgba(0,0,0,0.45)',
  } as React.CSSProperties,
  title: {
    fontFamily: "'Rye', Georgia, serif",
    fontWeight: 400,
    color: 'var(--ink-text)',
  } as React.CSSProperties,
};

export interface WhatsNewEntry {
  version: string;
  date: string;
  tagline: string;
  highlights: string[];
}

/**
 * Player-facing patch notes, newest first. Sourced from real commit history (the
 * "bump to vX.XX" commits and everything bundled into that release), rewritten in
 * plain player language rather than the engine-internal terms the commit messages
 * themselves use. Update this array — and only this array — when cutting a new
 * version; the page below renders it with no other changes needed.
 */
export const WHATS_NEW_ENTRIES: WhatsNewEntry[] = [
  {
    version: '0.92',
    date: 'July 30, 2026',
    tagline: 'Real market economics',
    highlights: [
      "Market share now genuinely moves your revenue. The total market is sized fairly by table size, so a 2-player and a 4-player game both start on equal footing — it's only once a real competitive edge opens up that a rival's shrinking slice actually costs them money.",
      'Prices now behave like a real market: if everyone raises prices at once, total demand shrinks a little; if everyone cuts prices, it grows. Price is no longer just a tug-of-war over a fixed pie.',
      "Deploying a decision now costs a bit more the wealthier your company already is — a modest, cost-only surcharge (never applied to windfalls) meant to keep a runaway leader's moves from getting cheaper relative to everyone else's.",
      'Retuned several rival-attacking decisions (Bot Attack, Union Agitation and its siblings) to hit noticeably harder, now that their effects correctly land once and stick instead of quietly fading turn over turn.',
    ],
  },
  {
    version: '0.91',
    date: 'July 28, 2026',
    tagline: 'Fixed 81 decisions that silently did nothing',
    highlights: [
      "Found and fixed 81 decisions — 104 individual effects in total — that looked like they should do something but were secretly no-ops, including attack decisions like Forged Regulatory Violation Notice that were supposed to hurt a rival and simply didn't.",
      'The Game Over replay now names the actual winner of a resolved lawsuit ("won by Alice") instead of a generic "won by the plaintiff", and shows the real settlement dollar amount instead of leaving it blank.',
      'Fixed a rare race where a live settlement offer, negotiated at the exact instant a turn resolved, could get silently overwritten by that turn\'s own auto-settle logic. Affected actions now just ask you to try again a moment later instead of losing your offer.',
    ],
  },
  {
    version: '0.90',
    date: 'July 27, 2026',
    tagline: 'AI opponents and a smarter bot',
    highlights: [
      "Playing solo in a public room? You're no longer stuck waiting — the server now matches you against an AI-controlled opponent after a short delay.",
      "The bot got a real upgrade: it now weighs decisions by actual cost-effectiveness instead of picking at random, plays cautiously once its own risk gauge climbs, and actually negotiates lawsuits (countering, accepting fair offers, forcing a trial when the odds favor it) instead of ignoring them entirely.",
      'Fixed the bot reliably bankrupting itself for no adversarial reason at all — it now accounts for its own real cash trend and structural profitability before committing to new moves.',
      'Cleaned up how decision effects are displayed, and fixed several bugs around the very first round and round boundaries.',
    ],
  },
];

/**
 * A real, crawlable URL (`/whats-new`) — checked in App.tsx the same way `/admin` is,
 * ahead of the game-phase switch, since it has no relationship to live game state. Exists
 * for two reasons at once: it gives returning/curious players an actual changelog, and it
 * gives the site a second page with substantial original text content — see CLAUDE.md's
 * *Consent-gated Google Analytics/Ads* section and the AdSense "low-value content"
 * rejection that prompted both this page and Matchmaking.tsx's inline How to Play section.
 */
const WhatsNew: React.FC = () => {
  return (
    <Container size="sm" py="xl">
      <Paper p="xl" style={wnStyles.paper}>
        <Group justify="space-between" align="center" mb="md">
          <Title order={1} style={wnStyles.title}>📰 What's New</Title>
          <Badge color="gray" size="sm">v{WHATS_NEW_ENTRIES[0]?.version}</Badge>
        </Group>
        <Text size="sm" mb="xl" style={{ color: 'var(--ink-text-soft)' }}>
          A running log of what's changed in Sue Them Chickens, newest first.
        </Text>

        <Stack gap="xl">
          {WHATS_NEW_ENTRIES.map((entry) => (
            <Stack key={entry.version} gap="xs">
              <Group gap="sm" align="baseline">
                <Title order={3} style={wnStyles.title}>v{entry.version}</Title>
                <Text size="sm" style={{ color: 'var(--ink-text-soft)' }}>{entry.date}</Text>
              </Group>
              <Text size="sm" fw={700} style={{ color: 'var(--ink-text)' }}>{entry.tagline}</Text>
              <List size="sm" spacing={4}>
                {entry.highlights.map((line, i) => (
                  <List.Item key={i}>{line}</List.Item>
                ))}
              </List>
            </Stack>
          ))}
        </Stack>

        <Group justify="center" mt="xl">
          <Button
            component="a"
            href="/"
            variant="outline"
            color="dark"
            leftSection={<IconArrowLeft size={16} />}
          >
            Back to the game
          </Button>
        </Group>
      </Paper>
    </Container>
  );
};

export default WhatsNew;
