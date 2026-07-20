import React, { useEffect } from 'react';
import { Routes, Route, Navigate, useNavigate } from 'react-router-dom';
import { Box, Stack, Text, Loader } from '@mantine/core';
import { useSocketStore } from './stores/socketStore';
import { useGameStore } from './stores/gameStore';
import Matchmaking from './pages/Matchmaking';
import GamePhase from './pages/GamePhase';
import GameOver from './pages/GameOver';

const App: React.FC = () => {
  const { connect, disconnect } = useSocketStore();
  const { currentPhase, isRejoining } = useGameStore();
  const navigate = useNavigate();

  useEffect(() => {
    connect();
    return () => disconnect();
  }, [connect, disconnect]);

  useEffect(() => {
    if (!currentPhase) return;

    let target: string;
    switch (currentPhase) {
      case 'WAITING':
        target = '/';
        break;
      case 'GAME_PHASE':
        target = '/game';
        break;
      case 'AFTERMATH':
        target = '/gameover';
        break;
      default:
        target = '/';
    }

    if (window.location.pathname !== target) {
      navigate(target, { replace: true });
    }
  }, [currentPhase, navigate]);

  const getPhaseRoute = (): string => {
    if (!currentPhase) return '/';

    switch (currentPhase) {
      case 'WAITING':
        return '/';
      case 'GAME_PHASE':
        return '/game';
      case 'AFTERMATH':
        return '/gameover';
      default:
        return '/';
    }
  };

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

  return (
    <Routes>
      <Route path="/" element={<Matchmaking />} />
      <Route path="/game" element={<GamePhase />} />
      <Route path="/gameover" element={<GameOver />} />
      <Route path="*" element={<Navigate to={getPhaseRoute()} replace />} />
    </Routes>
  );
};

export default App;
