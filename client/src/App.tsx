import React, { useEffect } from 'react';
import { Box, Stack, Text, Title, Loader, Alert, Button, Container, Paper, Image, Modal } from '@mantine/core';
import { useSocketStore } from './stores/socketStore';
import { useGameStore } from './stores/gameStore';
import Matchmaking from './pages/Matchmaking';
import GamePhase from './pages/GamePhase';
import GameOver from './pages/GameOver';
import AdminPortal from './pages/AdminPortal';

const LOST_COPY: Record<'bankrupt' | 'forfeit', { title: string; body: string }> = {
  bankrupt: {
    title: "YOU'VE GONE BANKRUPT",
    body: "Your cash ran out and the bank came knocking. You're out of the game — the rest of the table plays on without you.",
  },
  forfeit: {
    title: 'YOU FORFEITED',
    body: "You left the game, which means an instant loss — you're marked bankrupt and the rest of the table plays on without you.",
  },
};

/**
 * Full-screen takeover shown the moment this player's own bankruptcy is detected —
 * natural cash<0 elimination or a voluntary `game:leave` forfeit (see socketStore.ts's
 * player:bankrupt/game:left handlers, which set `gameStore.selfElimination`). Checked
 * in App.tsx ahead of the currentPhase switch so it wins even if that same elimination
 * also ended the game and flipped the room to AFTERMATH — a player who lost this way
 * sees this, not the winner's GameOver screen.
 */
const LostOverlay: React.FC<{ reason: 'bankrupt' | 'forfeit' }> = ({ reason }) => {
  const { returnToLanding } = useSocketStore();
  const copy = LOST_COPY[reason];

  return (
    <Container size="xs" py="xl">
      <Paper withBorder p="xl" shadow="lg">
        <Image src="/images/lost.png" alt="Eliminated" radius="md" mb="md" />
        <Title order={2} ta="center" mb="xs" c="red">
          {copy.title}
        </Title>
        <Text ta="center" c="dimmed" mb="lg">
          {copy.body}
        </Text>
        <Button fullWidth color="red" onClick={returnToLanding}>
          Return to Start
        </Button>
      </Paper>
    </Container>
  );
};

/**
 * Info-window modal shown to every still-in-the-game player when *someone else* goes
 * bankrupt — see `gameStore.bankruptcyEvents` (queued, not a single value, since more than
 * one player can be eliminated the same turn) and `socketStore.ts`'s `player:bankrupt`
 * handler, which enqueues one of these for everyone except the eliminated player (they get
 * `LostOverlay` instead, never both). Rendered as an overlay *on top of* whatever `page`
 * App.tsx is currently showing (GamePhase, GameOver, etc.) rather than replacing it — the
 * game keeps running and stays visible underneath; only this modal needs dismissing. It
 * used to be a full-page takeover that blanked out the entire game behind it (a real,
 * reported issue: the game looked like it had stopped/gone blank), fixed by switching the
 * container from a page-level `<Container>` to a `Modal`, same "info window" shape every
 * other post-turn notification in this app already uses (see GamePhase.tsx's News item
 * modal). This still has to be independent of the `currentPhase` switch below (not folded
 * into GamePhase's own local News feed) for the same reason as before: if this same
 * elimination also ends the game, `player:bankrupt` and `game:over`/`phase:changed` (which
 * flips `currentPhase` to AFTERMATH, unmounting GamePhase) arrive back-to-back in the same
 * turn resolution — a GamePhase-local queue would vanish right along with it unseen.
 * Rendering this modal from top-level `gameStore` state instead means it keeps showing
 * over the GameOver screen that phase change swaps in underneath, exactly like it did
 * before, just without blocking the view of whichever screen is actually current.
 */
const BankruptcyModal: React.FC<{ playerName: string; onDismiss: () => void }> = ({ playerName, onDismiss }) => (
  <Modal
    opened
    onClose={onDismiss}
    size="md"
    centered
    title={<Text fw={700} fz="0.9rem">💀 PLAYER ELIMINATED</Text>}
  >
    <Stack gap="md">
      <Image src="/images/lost.png" alt="Eliminated" radius="md" />
      <Text ta="center" fw={700} c="red">
        {playerName.toUpperCase()} HAS GONE BANKRUPT
      </Text>
      <Text ta="center" c="dimmed" size="sm">
        Their cash ran out and the bank came knocking — they're out of the game.
      </Text>
      <Button fullWidth color="red" onClick={onDismiss}>
        Got it
      </Button>
    </Stack>
  </Modal>
);

/** How long a top-of-screen notification (e.g. "you were kicked") stays up before auto-dismissing. */
const NOTIFICATION_AUTO_DISMISS_MS = 6000;

/** Global, phase-independent one-line notification banner — e.g. "removed from room", bankruptcy, game over. Fixed to the top so it survives whatever page is rendered underneath it. */
const NotificationBanner: React.FC = () => {
  const { notification, setNotification } = useGameStore();

  useEffect(() => {
    if (!notification) return;
    const timeout = setTimeout(() => setNotification(null), NOTIFICATION_AUTO_DISMISS_MS);
    return () => clearTimeout(timeout);
  }, [notification, setNotification]);

  if (!notification) return null;

  return (
    <Alert
      color="blue"
      variant="filled"
      withCloseButton
      onClose={() => setNotification(null)}
      style={{ position: 'fixed', top: 16, left: '50%', transform: 'translateX(-50%)', zIndex: 1000, maxWidth: 480 }}
    >
      {notification}
    </Alert>
  );
};

/**
 * No react-router `<Routes>` here on purpose. WAITING/GAME_PHASE/AFTERMATH aren't
 * independent URLs — they're server-authoritative `currentPhase` values with no
 * deep-link value (no room id in the path, nothing bookmarkable), so this renders
 * directly off that state instead of syncing it into a path only to read it back out.
 * `/admin` is the one genuine URL in this app (see AdminPortal.tsx) and is checked
 * first, ahead of any game-phase state.
 */
const App: React.FC = () => {
  const { connect, disconnect } = useSocketStore();
  const { currentPhase, isRejoining, selfElimination, bankruptcyEvents, dismissBankruptcyEvent } = useGameStore();
  const isAdminRoute = window.location.pathname.startsWith('/admin');

  useEffect(() => {
    connect();
    return () => disconnect();
  }, [connect, disconnect]);

  if (isAdminRoute) {
    return <AdminPortal />;
  }

  // Checked ahead of the phase switch below — see LostOverlay's doc comment for why.
  // No NotificationBanner here: if this same elimination also ended the game, the
  // generic "Game Over! X wins!" broadcast would otherwise stack on top of this
  // already-conclusive full-screen takeover and read as contradictory.
  if (selfElimination) {
    return <LostOverlay reason={selfElimination.reason} />;
  }

  // Attempting to resume a saved session (page reload, back button, brief network
  // drop) — hold off on rendering Matchmaking, which would otherwise flash for a
  // moment before the room:rejoin response arrives and currentPhase gets set.
  if (isRejoining) {
    return (
      <Box style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh' }}>
        <Stack align="center" gap="md">
          <Loader />
          <Text c="dimmed" fw={500}>Reconnecting…</Text>
        </Stack>
      </Box>
    );
  }

  let page: React.ReactNode;
  switch (currentPhase) {
    case 'GAME_PHASE':
      page = <GamePhase />;
      break;
    case 'AFTERMATH':
      page = <GameOver />;
      break;
    default:
      page = <Matchmaking />;
  }

  return (
    <>
      <NotificationBanner />
      {page}
      {bankruptcyEvents.length > 0 && (
        <BankruptcyModal playerName={bankruptcyEvents[0].playerName} onDismiss={dismissBankruptcyEvent} />
      )}
    </>
  );
};

export default App;
