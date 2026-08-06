import React from 'react';
import { Container, Paper, Title, Text, Stack, List, Group, Button, Divider, Table, Box } from '@mantine/core';
import { IconArrowLeft } from '@tabler/icons-react';
import AdSlot from '../components/AdSlot';
import { usePageMeta } from '../lib/usePageMeta';

// "Courtroom Ink" tokens — see CLAUDE.md's *Client-side duplicated pure logic* section
// for why every page defines its own local copy instead of importing a shared one.
const rulesStyles = {
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

/**
 * `/rules` — the precise, structured reference: what a decision category caps out at,
 * what elimination actually requires, what the real default numbers are. Deliberately
 * distinct in tone from `/how-to-play` (a narrative, screenshot-illustrated walkthrough
 * of a full game) and `/strategy` (advice on what to actually do with these rules) — this
 * page is the one to open mid-argument about what a rule technically says. Numbers below
 * are the real seeded defaults (`server/src/data/game_config.json`) — every one of them is
 * admin-editable per room's live `GameSettings`, so a specific game could differ; this page
 * documents the defaults new players will actually see. Carries its own manual `AdSlot`
 * (`VITE_ADSENSE_SLOT_RULES`) below the content, same convention as every other static
 * page — see CLAUDE.md's *Consent-gated Google Analytics/Ads* section.
 */
const Rules: React.FC = () => {
  usePageMeta(
    'Rules | Sue Them Chickens',
    'The precise rules reference for Sue Them Chickens: decision categories, per-turn caps, elimination conditions, and every real default number.',
  );
  return (
    <Container size="sm" py="xl">
      <Paper p="xl" style={rulesStyles.paper}>
        <Title order={1} style={rulesStyles.title} mb="xs">📋 Rules</Title>
        <Text size="sm" mb="xl" style={{ color: 'var(--ink-text-soft)' }}>
          The precise reference. For a friendlier walkthrough, see{' '}
          <a href="/how-to-play" style={{ color: 'var(--ink-text)' }}>How to Play</a>.
        </Text>

        <Stack gap="xl">
          <Stack gap="xs">
            <Title order={3} style={rulesStyles.title}>Setup &amp; Round Structure</Title>
            <List size="sm" spacing={4}>
              <List.Item>2 to 4 players per game. A solo player in a public room is automatically matched against a server-controlled AI opponent after a short wait.</List.Item>
              <List.Item>Every player starts with $100,000 cash and an identical company.</List.Item>
              <List.Item>Rounds run live — 120 seconds each. Everyone acts simultaneously; there is no turn order within a round.</List.Item>
              <List.Item>A round resolves once everyone has readied up, or the timer runs out, whichever comes first.</List.Item>
              <List.Item>You're eliminated the instant your cash goes negative, or the moment another player crosses majority ownership of your company. Last player standing wins.</List.Item>
            </List>
          </Stack>

          <Divider color="#cbb888" />

          <Stack gap="xs">
            <Title order={3} style={rulesStyles.title}>Decision Categories &amp; Per-Turn Caps</Title>
            <Text size="sm">Every decision falls into one of three categories, each with its own cap on how many you can deploy in a single round:</Text>
            <div style={{ overflowX: 'auto' }}>
              <Table striped withTableBorder withColumnBorders fz="sm">
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Category</Table.Th>
                    <Table.Th>Per-Turn Cap</Table.Th>
                    <Table.Th>What it covers</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  <Table.Tr>
                    <Table.Td>Strategic</Table.Td>
                    <Table.Td>1</Table.Td>
                    <Table.Td>Big, slow-moving moves — factories, market plays, long-term positioning.</Table.Td>
                  </Table.Tr>
                  <Table.Tr>
                    <Table.Td>Operational</Table.Td>
                    <Table.Td>2</Table.Td>
                    <Table.Td>Day-to-day running of the business — staffing, logistics, processes.</Table.Td>
                  </Table.Tr>
                  <Table.Tr>
                    <Table.Td>Financial</Table.Td>
                    <Table.Td>2</Table.Td>
                    <Table.Td>Buy Shares / Sell Shares only — the hostile-takeover mechanic.</Table.Td>
                  </Table.Tr>
                </Table.Tbody>
              </Table>
            </div>
            <Text size="sm">
              Every decision also has a nature: <b>Traditional</b> (no legal risk),{' '}
              <b>Grey Area</b> (mild legal risk), or <b>Dirty</b> (real legal risk, and the
              only nature that can carry a lasting redeploy cooldown — see below).
            </Text>
          </Stack>

          <Divider color="#cbb888" />

          <Stack gap="xs">
            <Title order={3} style={rulesStyles.title}>Lawsuits</Title>
            <List size="sm" spacing={4}>
              <List.Item><b>Filing a lawsuit costs $15,000</b>, charged the instant you file — win or lose, this is never refunded.</List.Item>
              <List.Item><b>Dig Deeper costs $10,000</b> and reveals more about a specific case or incoming-attack hint's real odds before you commit to filing.</List.Item>
              <List.Item>You can sue over any decision in the entire library, on a hunch, whether or not you have real evidence — a wrong guess still creates a real case, just a hopeless one (0% odds).</List.Item>
              <List.Item>A specific decision instance can only ever be sued once, successfully, in its whole lifetime. A voided (successfully sued) instance can be freely redeployed as a brand-new, un-sued instance.</List.Item>
              <List.Item><b>Statute of limitations: 10 years.</b> Past that age, an instance can no longer be sued at all, and its effects on a targeted rival stop re-applying.</List.Item>
              <List.Item>A filed case starts in negotiation: the defendant moves first, and each side can counter, accept, or force a trial ("Go to Court") at any time. If nobody meaningfully engages within 2 turns, it's automatically forced to a verdict.</List.Item>
              <List.Item>A trial verdict is a probability draw against the case's real odds — full stakes on a win, nothing on a loss, capped to whatever cash the defendant actually has left.</List.Item>
            </List>
          </Stack>

          <Divider color="#cbb888" />

          <Stack gap="xs">
            <Title order={3} style={rulesStyles.title}>Hostile Takeover</Title>
            <List size="sm" spacing={4}>
              <List.Item>Buy Shares purchases a slice of any company (including your own) directly from its cap table at the current stock price — no consent from the target required.</List.Item>
              <List.Item>A purchase dilutes every existing shareholder proportionally, including the public float.</List.Item>
              <List.Item>The instant one player's stake in a company crosses <b>50% ownership</b>, that company is acquired outright — its owner is eliminated, and the acquirer inherits its cash and assets (not its debt or decisions).</List.Item>
              <List.Item>Sell Shares lets you cash out a stake in any company (including your own) back to the public market at the current price.</List.Item>
            </List>
          </Stack>

          <Divider color="#cbb888" />

          <Stack gap="xs">
            <Title order={3} style={rulesStyles.title}>Winning</Title>
            <Text size="sm">
              The game ends the moment only one player remains active — through bankruptcy,
              hostile takeover, or voluntary forfeit of everyone else. That player wins.
              Want the deeper strategic reasoning behind these rules?{' '}
              <a href="/strategy" style={{ color: 'var(--ink-text)' }}>Read the Strategy Guide</a>.
            </Text>
          </Stack>
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

      <Box mt="xl">
        <AdSlot slot={import.meta.env.VITE_ADSENSE_SLOT_RULES} />
      </Box>
    </Container>
  );
};

export default Rules;
