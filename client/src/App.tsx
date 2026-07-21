import React, { useEffect } from 'react';
import { Box, Stack, Text, Title, Loader, Alert, Button, Container, Paper, Image } from '@mantine/core';
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
  const { currentPhase, isRejoining, selfElimination } = useGameStore();
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
    </>
  );
};

export default App;
