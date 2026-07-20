import React, { useEffect } from 'react';
import { Routes, Route, Navigate, useNavigate } from 'react-router-dom';
import { useSocketStore } from './stores/socketStore';
import { useGameStore } from './stores/gameStore';
import Matchmaking from './pages/Matchmaking';
import GamePhase from './pages/GamePhase';
import GameOver from './pages/GameOver';

const App: React.FC = () => {
  const { connect, disconnect } = useSocketStore();
  const { currentPhase } = useGameStore();
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
