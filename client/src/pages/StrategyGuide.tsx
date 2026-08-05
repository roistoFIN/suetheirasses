import React from 'react';
import { Container, Paper, Title, Text, Stack, Group, Button, Divider } from '@mantine/core';
import { IconArrowLeft } from '@tabler/icons-react';

// "Courtroom Ink" tokens — see CLAUDE.md's *Client-side duplicated pure logic* section
// for why every page defines its own local copy instead of importing a shared one.
const strategyStyles = {
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

interface StrategySection {
  id: string;
  heading: string;
  body: React.ReactNode;
}

const SECTIONS: StrategySection[] = [
  {
    id: 'cash-discipline',
    heading: '1. Cash Discipline Beats a Flashy Opening',
    body: (
      <Text size="sm">
        The single most common way to lose is running out of cash, not losing a lawsuit or
        getting bought out — so before anything else, keep a real cushion. A decision that
        looks great on paper (big capacity or price gains) still has to clear its own cost,
        and the wealthier your company gets, the more a decision costs to deploy (a small,
        deliberate surcharge that scales with your own current cash). A company that spends
        cautiously in the early rounds and grows its cash cushion is much harder to bankrupt
        with a lawsuit or a lucky trial verdict later.
      </Text>
    ),
  },
  {
    id: 'reading-the-board',
    heading: '2. Read the Board Before You Spend to Investigate',
    body: (
      <Text size="sm">
        Competitor Intel and incoming-attack hint cards tell you more than they look like
        they do at a glance. Every hint already quotes a line from the attacker's own
        annual report — often a legible tell for what they actually deployed — so you can
        frequently form a strong, free guess before ever paying to Dig Deeper. Save the
        real spend for cases you intend to actually file over; see the{' '}
        <a href="/glossary" style={{ color: 'var(--ink-text)' }}>Glossary</a> if any of the
        terms on those cards aren't clear yet.
      </Text>
    ),
  },
  {
    id: 'offense',
    heading: '3. Offense: Pick Targets, Not Just Decisions',
    body: (
      <Text size="sm">
        A Dirty, targeted decision is only worth deploying if the damage it does to a
        specific rival is worth the legal exposure and scrutiny it costs you. Early game,
        a direct attack on the leader slows the game down for everyone by inviting
        retaliation; late game (once the round count climbs past the point most games
        naturally start to escalate), lawsuits and takeovers both get measurably more
        potent — a deliberately tuned pressure valve so two evenly matched survivors don't
        stalemate forever. Save your most aggressive plays for exactly that window if the
        game has gone long.
      </Text>
    ),
  },
  {
    id: 'defense',
    heading: "4. Defense: Manage Exposure, Don't Just React to It",
    body: (
      <Text size="sm">
        Every Dirty decision you deploy adds to your own legal exposure and risk gauge
        whether or not anyone ever sues you over it — a rival watching your Threat Level
        climb has real information, not a guess. Spreading dirty plays out instead of
        stacking several in one round keeps your exposure from spiking into obviously
        suspicious territory right when a rival is deciding whether digging deeper on you
        is worth the cost.
      </Text>
    ),
  },
  {
    id: 'litigation-math',
    heading: '5. The Litigation Math: Expected Value, Not Vibes',
    body: (
      <Text size="sm">
        A lawsuit costs a flat $15,000 to file no matter the outcome, so the question is
        never "could I win" but "is (my odds of winning) × (the stakes) worth more than the
        filing fee plus what Dig Deeper would have cost to actually know those odds." A
        wrong guess still creates a real, hopeless case — filing on a pure hunch is a bad
        bet almost every time; filing after confirming real odds and real stakes is a good
        one far more often. The same math applies in reverse when you're the defendant
        deciding whether to settle or risk a trial.
      </Text>
    ),
  },
  {
    id: 'financial-plays',
    heading: '6. Buy Shares vs. Litigation: Two Different Tools',
    body: (
      <Text size="sm">
        A hostile takeover sidesteps the legal system entirely — no odds, no negotiation,
        just capital. It's the stronger play against a rival with a high stock value but
        thin legal exposure (nothing to sue over) and a weaker one against a rival who's
        already cash-poor (you'd be overpaying for a company on the way to bankrupting
        itself for free). Litigation is the reverse: cheap leverage against a rival who's
        made a lot of legally risky moves, useless against one who's played it safe.
      </Text>
    ),
  },
  {
    id: 'endgame',
    heading: '7. The Endgame Is Usually a Two-Player Standoff',
    body: (
      <Text size="sm">
        Most games come down to two roughly even survivors circling each other. This is
        exactly the situation where the late-game lawsuit/takeover escalation kicks in the
        hardest, and where every legal case you've kept "in your pocket" (dug deeper on but
        never filed) becomes real ammunition. Don't burn every advantage the moment you
        find it in the midgame — the player still holding options when the field narrows to
        two usually has the edge.
      </Text>
    ),
  },
];

/**
 * `/strategy` — deeper strategic advice, distinct from `/rules` (what the numbers are)
 * and `/how-to-play` (how the screens work). Written from real, documented engine
 * behavior (see CLAUDE.md's *Cash-growth balance pass* and *Deck retune* sections for the
 * late-game escalation/company-size cost-scaling mechanics referenced below), not
 * generic game-strategy platitudes.
 */
const StrategyGuide: React.FC = () => {
  return (
    <Container size="sm" py="xl">
      <Paper p="xl" style={strategyStyles.paper}>
        <Title order={1} style={strategyStyles.title} mb="xs">🧠 Strategy Guide</Title>
        <Text size="sm" mb="xl" style={{ color: 'var(--ink-text-soft)' }}>
          Seven things that separate a player who outlasts the table from one who doesn't.
        </Text>

        <Stack gap="xl">
          {SECTIONS.map((section, i) => (
            <React.Fragment key={section.id}>
              {i > 0 && <Divider color="#cbb888" />}
              <Stack gap="xs">
                <Title order={3} style={strategyStyles.title}>{section.heading}</Title>
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
            Back to the hub
          </Button>
        </Group>
      </Paper>
    </Container>
  );
};

export default StrategyGuide;
