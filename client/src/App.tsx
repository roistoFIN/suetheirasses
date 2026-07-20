import React, { useEffect } from 'react';
import { Box, Stack, Text, Loader } from '@mantine/core';
import { useSocketStore } from './stores/socketStore';
import { useGameStore } from './stores/gameStore';
import Matchmaking from './pages/Matchmaking';
import GamePhase from './pages/GamePhase';
import GameOver from './pages/GameOver';
import AdminPortal from './pages/AdminPortal';

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
  const { currentPhase, isRejoining } = useGameStore();
  const isAdminRoute = window.location.pathname.startsWith('/admin');

  useEffect(() => {
    connect();
    return () => disconnect();
  }, [connect, disconnect]);

  if (isAdminRoute) {
    return <AdminPortal />;
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

  switch (currentPhase) {
    case 'GAME_PHASE':
      return <GamePhase />;
    case 'AFTERMATH':
      return <GameOver />;
    default:
      return <Matchmaking />;
  }
};

export default App;
