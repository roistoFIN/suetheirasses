import React, { useEffect, useState } from 'react';
import { Box, Button, Flex, Group, Stack, Switch, Text } from '@mantine/core';
import { useConsentStore } from '../stores/consentStore';

// "Courtroom Ink" tokens, mirrored locally the same way Matchmaking.tsx's own mmStyles
// and ChatWidget/FeedbackWidget's *Styles objects are — small enough per-file surface
// that a shared style module isn't worth it (see those components' own doc comments).
const consentStyles = {
  bar: {
    position: 'fixed',
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 500,
    background: 'var(--ink-parchment)',
    backgroundImage: 'var(--paper-texture)',
    borderTop: '2px solid var(--ink-gold)',
    boxShadow: '0 -6px 12px rgba(0,0,0,0.35)',
    padding: '16px 20px',
  } as React.CSSProperties,
  title: {
    fontFamily: "'Rye', Georgia, serif",
    fontWeight: 400,
    color: 'var(--ink-text)',
  } as React.CSSProperties,
  primaryBtn: {
    fontFamily: "'Rye', Georgia, serif",
    letterSpacing: '0.02em',
    background: 'var(--ink-text)',
    color: 'var(--ink-parchment)',
    border: '2px solid var(--ink-gold)',
  } as React.CSSProperties,
};

/**
 * Sitewide cookie-consent bar — see CLAUDE.md's Google Ads planning notes. Mounted
 * unconditionally in App.tsx's final return (alongside BankruptcyModal), visible
 * whenever the player hasn't yet made a choice OR has reopened it via Matchmaking's
 * "Cookie Settings" button (`useConsentStore`'s `settingsOpen`). In practice this only
 * ever shows on the pre-room landing page, since every player passes through it before a
 * room/game exists — but it's mounted sitewide (not landing-page-local) so a decision is
 * never skippable regardless of entry path.
 *
 * A first-time visitor (`!hasDecided`) gets no dismiss/close control — Accept All,
 * Reject All, and Customize→Save are the only ways to make this go away, since an
 * unrecorded "closed without choosing" would be ambiguous consent. A returning visitor
 * who reopened via Cookie Settings already has a valid stored choice, so they get a
 * close (✕) button that just cancels the reopened editing session — `closeSettings()`
 * only ever touches `settingsOpen`, never `categories`/`hasDecided` (see consentStore.ts).
 */
const ConsentBanner: React.FC = () => {
  const { hasDecided, categories, settingsOpen, acceptAll, rejectAll, saveCustom, closeSettings } = useConsentStore();
  const [expanded, setExpanded] = useState(false);
  const [draftAnalytics, setDraftAnalytics] = useState(categories.analytics);
  const [draftAdvertising, setDraftAdvertising] = useState(categories.advertising);

  const visible = !hasDecided || settingsOpen;

  // Re-seed the customize toggles from whatever's currently stored every time the banner
  // becomes visible again (e.g. reopened via Cookie Settings) — this component never
  // unmounts between opens (App.tsx always renders it; it just returns null while
  // hidden), so without this the toggles would keep showing a stale draft from the last
  // time it was open instead of the player's actual current choice.
  useEffect(() => {
    if (!visible) return;
    setExpanded(false);
    setDraftAnalytics(categories.analytics);
    setDraftAdvertising(categories.advertising);
  }, [visible, categories.analytics, categories.advertising]);

  if (!visible) return null;

  return (
    <Box style={consentStyles.bar}>
      <Stack gap="sm" maw={900} mx="auto">
        <Flex justify="space-between" align="flex-start" gap="md">
          <Text size="sm" style={{ color: 'var(--ink-text)' }}>
            We use essential cookies to run the game, and — only with your permission —
            analytics and advertising cookies. See our{' '}
            <Text component="span" fw={700}>Privacy Policy</Text> for details. You can
            change this choice any time via Cookie Settings.
          </Text>
          {hasDecided && (
            <Button variant="subtle" color="dark" size="compact-sm" onClick={closeSettings} aria-label="Close cookie settings">
              ✕
            </Button>
          )}
        </Flex>

        {expanded && (
          <Stack gap="xs" py="xs" style={{ borderTop: '1px solid var(--ink-hairline-light)', borderBottom: '1px solid var(--ink-hairline-light)' }}>
            <Group justify="space-between">
              <Stack gap={0}>
                <Text size="sm" fw={700} style={{ color: 'var(--ink-text)' }}>Necessary</Text>
                <Text size="xs" c="dimmed">Required to run the game session — always on.</Text>
              </Stack>
              <Switch checked disabled aria-label="Necessary cookies (always active)" />
            </Group>
            <Group justify="space-between">
              <Stack gap={0}>
                <Text size="sm" fw={700} style={{ color: 'var(--ink-text)' }}>Analytics</Text>
                <Text size="xs" c="dimmed">Helps us understand how the game is played.</Text>
              </Stack>
              <Switch
                checked={draftAnalytics}
                onChange={(e) => setDraftAnalytics(e.currentTarget.checked)}
                aria-label="Analytics cookies"
              />
            </Group>
            <Group justify="space-between">
              <Stack gap={0}>
                <Text size="sm" fw={700} style={{ color: 'var(--ink-text)' }}>Advertising</Text>
                <Text size="xs" c="dimmed">Lets us show ads (Google AdSense) to keep the game free.</Text>
              </Stack>
              <Switch
                checked={draftAdvertising}
                onChange={(e) => setDraftAdvertising(e.currentTarget.checked)}
                aria-label="Advertising cookies"
              />
            </Group>
          </Stack>
        )}

        <Group justify="flex-end" gap="xs">
          {!expanded && (
            <Button variant="outline" color="dark" onClick={() => setExpanded(true)}>
              Customize
            </Button>
          )}
          {expanded ? (
            <Button style={consentStyles.primaryBtn} onClick={() => saveCustom({ analytics: draftAnalytics, advertising: draftAdvertising })}>
              Save Preferences
            </Button>
          ) : (
            <>
              <Button variant="outline" color="red" onClick={rejectAll}>
                Reject All
              </Button>
              <Button style={consentStyles.primaryBtn} onClick={acceptAll}>
                Accept All
              </Button>
            </>
          )}
        </Group>
      </Stack>
    </Box>
  );
};

export default ConsentBanner;
