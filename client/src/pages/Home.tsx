import React, { useState } from 'react';
import { Container, Paper, Title, Text, Stack, Group, Button, Image, SimpleGrid, Box, Modal } from '@mantine/core';
import {
  IconPlayerPlay,
  IconBook,
  IconClipboardList,
  IconBrain,
  IconGavel,
  IconTools,
  IconNews,
  IconShieldLock,
  IconMessageStar,
  IconCookie,
} from '@tabler/icons-react';
import { useConsentStore } from '../stores/consentStore';
import FeedbackForm from '../components/FeedbackForm';
import PrivacyPolicyModal from '../components/PrivacyPolicyModal';
import AdSlot from '../components/AdSlot';
import ConsentBanner from '../components/ConsentBanner';

// "Courtroom Ink" tokens — see CLAUDE.md's *Client-side duplicated pure logic* section
// for why every page defines its own local copy instead of importing a shared one.
const homeStyles = {
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
  card: {
    background: '#f6efd9',
    backgroundImage: 'var(--paper-texture)',
    border: '1px solid #cbb888',
    borderRadius: 3,
  } as React.CSSProperties,
  primaryBtn: {
    fontFamily: "'Rye', Georgia, serif",
    letterSpacing: '0.02em',
    background: 'var(--ink-text)',
    color: 'var(--ink-parchment)',
    border: '2px solid var(--ink-gold)',
  } as React.CSSProperties,
};

interface GuideLink {
  href: string;
  icon: React.ReactNode;
  label: string;
  description: string;
}

const GUIDE_LINKS: GuideLink[] = [
  { href: '/how-to-play', icon: <IconBook size={20} />, label: 'How to Play', description: 'A screenshot walkthrough of a full game, lobby to Game Over.' },
  { href: '/rules', icon: <IconClipboardList size={20} />, label: 'Rules', description: 'The precise reference — categories, caps, and every default number.' },
  { href: '/strategy', icon: <IconBrain size={20} />, label: 'Strategy Guide', description: "Seven things that separate a survivor from someone who isn't." },
  { href: '/glossary', icon: <IconGavel size={20} />, label: 'Glossary', description: "Plain-language definitions for the game's legal and business jargon." },
  { href: '/devlog', icon: <IconTools size={20} />, label: 'Devlog', description: 'Real bugs we found and fixed, told as engineering war stories.' },
  { href: '/whats-new', icon: <IconNews size={20} />, label: "What's New", description: 'A running changelog of what shipped, version by version.' },
];

/**
 * `/` — the site's real homepage and directory, replacing what used to be a direct
 * render of `Matchmaking.tsx` at root. The game itself now lives at `/play`
 * (`Matchmaking.tsx`'s own doc comment); this page's job is purely to welcome a new
 * visitor, pitch the game, and fan out to every static content page plus "Play Now".
 *
 * Exists specifically because of an AdSense "low-value content" rejection — see
 * CLAUDE.md's *AdSense "low-value content" rejection* section for the full history. This
 * page, not `/play`, now hosts the landing `AdSlot`: it's the page with real, substantial,
 * always-visible content (this pitch plus six real guide descriptions), while `/play`
 * stays lean and conversion-focused with no ad competing for a returning player's
 * attention right next to the Join/Create buttons.
 *
 * Also the only page that mounts `ConsentBanner` — moved here from a sitewide App.tsx
 * mount, since a fixed bottom overlay asking for a cookie decision has no good place to
 * sit over a live GamePhase round. The cookie decision now happens once, here, before a
 * player ever reaches `/play`. Reserves the same bottom-padding-while-visible space
 * App.tsx's old mount used to, so the banner can't silently cover the Privacy/Feedback/
 * Cookie Settings row or the AdSlot beneath it.
 */
const Home: React.FC = () => {
  const [privacyOpen, setPrivacyOpen] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const openCookieSettings = useConsentStore((s) => s.openSettings);
  const hasDecidedConsent = useConsentStore((s) => s.hasDecided);
  const consentSettingsOpen = useConsentStore((s) => s.settingsOpen);
  const consentBannerVisible = !hasDecidedConsent || consentSettingsOpen;

  return (
    <Box pb={consentBannerVisible ? 140 : 0}>
    <Container size="sm" py="xl">
      <Paper p="xl" style={homeStyles.paper}>
        <Image
          src="/images/hero.png"
          alt="Sue Them Chickens — rival poultry tycoons face off in court"
          radius="md"
          mb="md"
        />

        <Stack gap="sm" mb="xl">
          <Title order={1} ta="center" style={homeStyles.title}>Sue Them Chickens</Title>
          <Text size="sm" ta="center" style={{ color: 'var(--ink-text-soft)' }}>
            A free, real-time multiplayer business sim. Run a chicken empire, deploy dirty
            (or wholesome) business decisions, sue your rivals into bankruptcy, or quietly
            buy up their company out from under them. Last tycoon standing wins.
          </Text>
        </Stack>

        <Group justify="center" mb="xl">
          <Button
            component="a"
            href="/play"
            size="lg"
            leftSection={<IconPlayerPlay size={20} />}
            style={homeStyles.primaryBtn}
          >
            Play Now
          </Button>
        </Group>

        <Title order={3} style={homeStyles.title} mb="sm">Guides &amp; Devlog</Title>
        <SimpleGrid cols={{ base: 1, xs: 2 }} spacing="sm" mb="xl">
          {GUIDE_LINKS.map((g) => (
            <Paper key={g.href} component="a" href={g.href} p="md" style={{ ...homeStyles.card, textDecoration: 'none', display: 'block' }}>
              <Group gap="xs" mb={4}>
                <Box style={{ color: 'var(--ink-text)' }}>{g.icon}</Box>
                <Text fw={700} size="sm" style={{ color: 'var(--ink-text)' }}>{g.label}</Text>
              </Group>
              <Text size="xs" style={{ color: 'var(--ink-text-soft)' }}>{g.description}</Text>
            </Paper>
          ))}
        </SimpleGrid>

        <Group justify="center">
          <Button
            variant="subtle"
            color="dark"
            leftSection={<IconShieldLock size={16} />}
            onClick={() => setPrivacyOpen(true)}
          >
            Privacy Policy
          </Button>
          <Button
            variant="subtle"
            color="dark"
            leftSection={<IconMessageStar size={16} />}
            onClick={() => setFeedbackOpen(true)}
          >
            Feedback
          </Button>
          <Button
            variant="subtle"
            color="dark"
            leftSection={<IconCookie size={16} />}
            onClick={openCookieSettings}
          >
            Cookie Settings
          </Button>
        </Group>
      </Paper>

      {/* Below the interactive Paper, not inside it — a manual ad placement here can't
          be mistaken for/overlap the Play Now button or a guide card. See AdSlot.tsx and
          CLAUDE.md's *Consent-gated Google Analytics/Ads* section for why Auto ads were
          rejected in favor of fixed, passive placements like this one. This is the same
          `VITE_ADSENSE_SLOT_LANDING` placement that used to live on Matchmaking.tsx —
          moved here along with the "landing page" role itself. */}
      <Box mt="xl">
        <AdSlot slot={import.meta.env.VITE_ADSENSE_SLOT_LANDING} />
      </Box>

      <PrivacyPolicyModal
        opened={privacyOpen}
        onClose={() => setPrivacyOpen(false)}
        titleStyle={homeStyles.title}
        primaryBtnStyle={homeStyles.primaryBtn}
      />

      <Modal
        opened={feedbackOpen}
        onClose={() => setFeedbackOpen(false)}
        title={<Text component="span" style={{ ...homeStyles.title, fontSize: '1.3rem' }}>💬 Feedback</Text>}
        centered
        size="sm"
      >
        <FeedbackForm source="landing" onClose={() => setFeedbackOpen(false)} />
      </Modal>
    </Container>
    <ConsentBanner />
    </Box>
  );
};

export default Home;
