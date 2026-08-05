import React from 'react';
import { Container, Paper, Title, Text, Stack, Group, Button, Divider } from '@mantine/core';
import { IconArrowLeft } from '@tabler/icons-react';

// "Courtroom Ink" tokens — see CLAUDE.md's *Client-side duplicated pure logic* section
// for why every page defines its own local copy instead of importing a shared one.
const glossaryStyles = {
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

export interface GlossaryTerm {
  term: string;
  definition: string;
}

/**
 * Legal/courtroom jargon a case's UI actually uses — see GamePhase.tsx's `CaseCard`/
 * `SueModal`/`NegotiationPanel`. Alphabetized within the group.
 */
export const LEGAL_TERMS: GlossaryTerm[] = [
  { term: 'Awaiting Trial', definition: "A case's status once negotiation has ended (by either side forcing it, or the negotiation period timing out) and it's queued for a verdict at the next round boundary." },
  { term: 'Burden of Proof', definition: 'Flavor only — this game never asks you to submit evidence. A case\'s real odds come from the decision\'s own legal-risk schedule and how much you\'ve investigated it, not from anything you argue.' },
  { term: 'Defendant', definition: 'The player being sued. Always moves first in negotiation on a freshly filed case.' },
  { term: 'Dig Deeper', definition: "A $10,000 one-time action that reveals more about a specific case or incoming-attack hint's real odds — either as the plaintiff investigating a rival before filing, or as the defendant investigating a case already filed against you." },
  { term: 'Filing Fee', definition: 'The flat $15,000 charged the instant you file a lawsuit, regardless of the outcome. Never refunded, even if the case turns out hopeless.' },
  { term: 'Grounds', definition: "The specific decision and legal-risk clause a lawsuit is filed over. One decision can carry several distinct grounds; a fully-investigated hint shows every viable one, not just the strongest." },
  { term: 'Negotiation', definition: 'The back-and-forth phase after a case is filed: either side can make an offer, counter, accept, or force a trial. Each new offer has to tighten its own side of the acceptable range.' },
  { term: 'Plaintiff', definition: 'The player who filed the lawsuit.' },
  { term: 'Settled', definition: 'A case resolved through a real, mutually agreed offer — someone made an offer and the other side genuinely accepted it (or let it stand through a full round of back-and-forth). Distinct from a case closed by a bankruptcy payout, which is never labeled "Settled".' },
  { term: 'Stakes', definition: "The dollar amount actually on the line — what the plaintiff receives if they win. Shown as a real number once you know it; otherwise the amount is simply unknown to you yet." },
  { term: 'Statute of Limitations', definition: 'The age (10 years by default) past which a decision can no longer be sued over at all, and stops re-applying its effects on whoever it was targeting.' },
  { term: 'Verdict', definition: "A trial's outcome — Won or Lost — decided by a probability draw weighted by the case's real odds once it reaches trial." },
];

/**
 * Business/financial and game-mechanic terms — see calcEngine.ts's formulas and
 * README's *Game Overview* for the underlying math.
 */
export const BUSINESS_TERMS: GlossaryTerm[] = [
  { term: 'Competitor Intel', definition: "A live readout of every rival's own visible numbers — use it alongside a hint card's annual-report quote to guess what they've actually deployed." },
  { term: 'Dilution', definition: "What happens to every existing shareholder's stake, proportionally, the instant anyone buys new shares in a company — including the buyer's own prior stake if they already held some." },
  { term: 'Equity', definition: "A company's net worth on paper — assets plus cash minus debt, roughly. One of the two fields a relative-type legal-risk ground can scale its stakes against." },
  { term: 'Hostile Takeover', definition: "Buying more than 50% of a rival's outstanding shares through the open market, without their consent, to take control of their company outright." },
  { term: 'Legal Exposure', definition: 'A rolling measure of how much lawsuit risk your own active decisions currently carry — feeds directly into your Risk Gauge.' },
  { term: 'Majority Ownership', definition: "Owning more than 50% of a company's outstanding shares — the exact line that triggers a hostile takeover the instant it's crossed." },
  { term: 'Market Share', definition: "Your slice of the total market, which genuinely affects how much of your production you can actually sell as revenue — not just a cosmetic percentage." },
  { term: 'Outrage', definition: 'Public/community backlash a decision generates — a Dirty decision typically raises it, while some carefully-framed decisions can lower it.' },
  { term: 'Risk Gauge / Threat Level', definition: 'The single "am I in danger" number blending legal exposure, scrutiny, outrage, ownership risk, and solvency risk into one 0-100 reading.' },
  { term: 'Scrutiny', definition: "How closely regulators and rivals are watching your company — climbs with risky moves, and a high reading makes a rival's Dig Deeper more likely to be worth their money." },
  { term: 'Stock Value', definition: 'The current price of one share of a company, computed from its real financials each round — the number Buy/Sell Shares actually trade against.' },
];

interface GlossaryGroup {
  heading: string;
  terms: GlossaryTerm[];
}

const GROUPS: GlossaryGroup[] = [
  { heading: '⚖️ Legal Terms', terms: LEGAL_TERMS },
  { heading: '💰 Business & Game Terms', terms: BUSINESS_TERMS },
];

/**
 * `/glossary` — plain-language definitions of the legal and business jargon the game's
 * own UI uses (case status labels, KPI names, mechanic names), grouped and alphabetized
 * within each group. Exported `LEGAL_TERMS`/`BUSINESS_TERMS` are covered by
 * Glossary.test.ts's shape/sort checks.
 */
const Glossary: React.FC = () => {
  return (
    <Container size="sm" py="xl">
      <Paper p="xl" style={glossaryStyles.paper}>
        <Title order={1} style={glossaryStyles.title} mb="xs">⚖️ Glossary</Title>
        <Text size="sm" mb="xl" style={{ color: 'var(--ink-text-soft)' }}>
          Plain-language definitions for every bit of legal and business jargon the game's own UI throws at you.
        </Text>

        <Stack gap="xl">
          {GROUPS.map((group, gi) => (
            <React.Fragment key={group.heading}>
              {gi > 0 && <Divider color="#cbb888" />}
              <Stack gap="md">
                <Title order={3} style={glossaryStyles.title}>{group.heading}</Title>
                {group.terms.map((t) => (
                  <Stack key={t.term} gap={2}>
                    <Text size="sm" fw={700} style={{ color: 'var(--ink-text)' }}>{t.term}</Text>
                    <Text size="sm" style={{ color: 'var(--ink-text-soft)' }}>{t.definition}</Text>
                  </Stack>
                ))}
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

export default Glossary;
