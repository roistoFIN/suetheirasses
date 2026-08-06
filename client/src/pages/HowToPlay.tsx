import React from 'react';
import { Container, Paper, Title, Text, Stack, List, Group, Button, Image, Divider, Alert, Box } from '@mantine/core';
import { IconArrowLeft, IconBulb } from '@tabler/icons-react';
import AdSlot from '../components/AdSlot';

// "Courtroom Ink" tokens — same tokens as Matchmaking.tsx's mmStyles/WhatsNew.tsx's
// wnStyles, defined locally per the codebase's established per-file duplication
// convention (see CLAUDE.md's *Client-side duplicated pure logic* section).
const htpStyles = {
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
  screenshot: {
    border: '1px solid #cbb888',
    borderRadius: 4,
    boxShadow: '4px 5px 0 rgba(0,0,0,0.35)',
  } as React.CSSProperties,
};

interface GuideSection {
  id: string;
  heading: string;
  screenshot?: { src: string; alt: string };
  body: React.ReactNode;
}

const SECTIONS: GuideSection[] = [
  {
    id: 'getting-started',
    heading: '1. Get a Table Together',
    screenshot: { src: '/images/how-to-play/getting-started-lobby.webp', alt: 'The room lobby, showing two players, an invite link, and a Start Game button' },
    body: (
      <Text size="sm">
        Create a room (or Quick Play into an open one) and share the invite link with up to
        3 friends. Nobody waiting? A server-controlled AI opponent joins automatically after
        a short delay, so a solo player is never stuck staring at an empty lobby. Once
        everyone's in, the host hits Start Game and the clock starts — each round runs live
        for 120 seconds, so decide fast.
      </Text>
    ),
  },
  {
    id: 'decisions',
    heading: '2. Deploy Decisions Every Round',
    screenshot: { src: '/images/how-to-play/decision-deck.webp', alt: 'The decision deck modal, showing Strategic/Operational/Financial category filters and a Buy Shares decision card' },
    body: (
      <Stack gap="sm">
        <Text size="sm">
          The Decision Deck is where the actual game happens. Every decision falls into one
          of three buckets — <b>Strategic</b>, <b>Operational</b>, and <b>Financial</b> (Buy/Sell
          Shares) — each with its own per-turn cap, so you can't just dump your whole hand in
          one round. Decisions also come in three flavors:
        </Text>
        <List size="sm" spacing={4}>
          <List.Item><b>Traditional</b> — safe, no legal exposure (build a factory, train staff).</List.Item>
          <List.Item><b>Grey Area</b> — mild risk (creative accounting, a strongly-worded press release).</List.Item>
          <List.Item><b>Dirty</b> — the good stuff, and a real lawsuit magnet (releasing a fox into a rival's henhouse is a real move you can make).</List.Item>
        </List>
        <Text size="sm">
          Every card shows exactly what it costs and what it does before you deploy it — no
          hidden numbers.
        </Text>
      </Stack>
    ),
  },
  {
    id: 'reading-the-signs',
    heading: "3. Read the Signs Before You Pay to Dig",
    screenshot: { src: '/images/how-to-play/attack-hint.webp', alt: 'An incoming-attack hint card quoting a rival\'s annual report flavor text, next to a Dig Deeper button and a Sue Them Chickens button' },
    body: (
      <Stack gap="sm">
        <Text size="sm">
          When a rival does something that affects you — directly or indirectly — a hint
          card shows up under Open Lawsuits, and Competitor Intel keeps a running readout on
          every rival's own numbers. You don't have to pay Dig Deeper right away to act on
          it.
        </Text>
        <Alert
          icon={<IconBulb size={18} />}
          color="yellow"
          variant="light"
          styles={{ root: { background: '#f6efd9', border: '1px solid #cbb888' } }}
        >
          <Text size="sm" fw={700} style={{ color: 'var(--ink-text)' }}>Tip: you can often guess without digging.</Text>
          <Text size="sm" style={{ color: 'var(--ink-text)' }}>
            Every hint card already comes with a quoted line from that rival's own annual
            report — flavor text that's frequently a pretty transparent tell for what they
            actually deployed (a suspiciously chipper line about "responsible agricultural
            stewardship" right after your numbers dip is rarely a coincidence). Cross-reference
            that against Competitor Intel's visible KPI swings for that same rival, and you
            can frequently form a strong guess for free. Dig Deeper is there for when you want
            certainty before committing to a $15,000 filing fee — not a prerequisite for
            suing at all.
          </Text>
        </Alert>
      </Stack>
    ),
  },
  {
    id: 'lawsuits',
    heading: '4. Sue Them Chickens',
    screenshot: { src: '/images/how-to-play/sue-modal.webp', alt: 'The Sue Them Chickens filing modal, showing a target dropdown and a File Lawsuit button for $15,000' },
    body: (
      <Text size="sm">
        Pick a target and file — filing charges a flat fee immediately, win or lose, so it's
        a real commitment, not a free roll. Once filed, the case enters negotiation: either
        side can make an offer, counter, accept, or force it to trial and let a probability
        draw decide. A defendant who's genuinely guilty of a dirty move is usually better off
        settling than risking a full trial payout — but only your own read on the odds (dug
        deeper or guessed from the signs above) tells you which situation you're actually in.
      </Text>
    ),
  },
  {
    id: 'winning',
    heading: '5. Outlast, Outlawyer, or Out-Acquire',
    screenshot: { src: '/images/how-to-play/game-over-standings.webp', alt: 'The Game Over KPI race chart and final cash standings between two players' },
    body: (
      <Text size="sm">
        There are three ways to take a rival down: bankrupt them through cash flow, win
        enough lawsuits to break them, or quietly buy up more than half their shares for a
        hostile takeover. Or just don't lose — a company that avoids overreaching often
        outlives one that swings for every dirty move on the board. Whoever's still standing
        when everyone else has gone bankrupt, forfeited, or been acquired wins the whole
        flock.
      </Text>
    ),
  },
];

/**
 * A real, crawlable URL (`/how-to-play`) — checked in App.tsx the same way `/admin` and
 * every other static page are, ahead of the game-phase switch. The illustrated,
 * screenshot-heavy companion to `/rules` (the precise reference) and Home.tsx's own short
 * pitch — see CLAUDE.md's *Consent-gated Google Analytics/Ads* section for the AdSense
 * rejection that originally prompted building this page. Screenshots live in
 * `client/public/images/how-to-play/` — resized/re-encoded to webp from the marketing
 * screenshot set, since the originals are multi-megabyte PNGs unfit for a content page's
 * load time. Carries its own manual `AdSlot` (`VITE_ADSENSE_SLOT_HOWTOPLAY`) below the
 * content, same convention as every other static page.
 */
const HowToPlay: React.FC = () => {
  return (
    <Container size="sm" py="xl">
      <Paper p="xl" style={htpStyles.paper}>
        <Title order={1} style={htpStyles.title} mb="xs">📖 How to Play, Illustrated</Title>
        <Text size="sm" mb="xl" style={{ color: 'var(--ink-text-soft)' }}>
          A screenshot walkthrough of a full game of Sue Them Chickens, from lobby to Game Over.
        </Text>

        <Stack gap="xl">
          {SECTIONS.map((section, i) => (
            <React.Fragment key={section.id}>
              {i > 0 && <Divider color="#cbb888" />}
              <Stack gap="sm">
                <Title order={3} style={htpStyles.title}>{section.heading}</Title>
                {section.screenshot && (
                  <Image
                    src={section.screenshot.src}
                    alt={section.screenshot.alt}
                    radius="sm"
                    style={htpStyles.screenshot}
                    loading={i === 0 ? 'eager' : 'lazy'}
                  />
                )}
                {section.body}
              </Stack>
            </React.Fragment>
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

      <Box mt="xl">
        <AdSlot slot={import.meta.env.VITE_ADSENSE_SLOT_HOWTOPLAY} />
      </Box>
    </Container>
  );
};

export default HowToPlay;
