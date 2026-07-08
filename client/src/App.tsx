import React, { useEffect } from 'react';
import { Routes, Route, Navigate, useNavigate } from 'react-router-dom';
import { useSocketStore } from './stores/socketStore';
import { useGameStore } from './stores/gameStore';
import Matchmaking from './pages/Matchmaking';
import Strategy from './pages/Strategy';
import Results from './pages/Results';
import Lawsuits from './pages/Lawsuits';
import Resolution from './pages/Resolution';
import GameOver from './pages/GameOver';

const App: React.FC = () => {
  const { connect, disconnect } = useSocketStore();
  const { room } = useGameStore();
  const navigate = useNavigate();

  useEffect(() => {
    connect();
    return () => disconnect();
  }, [connect, disconnect]);

  useEffect(() => {
    if (!room) return;

    let target: string;
    switch (room.status) {
      case 'WAITING':
        target = '/';
        break;
      case 'STRATEGY':
        target = '/strategy';
        break;
      case 'RESULTS':
        target = '/results';
        break;
      case 'LAWSUITS':
        target = '/lawsuits';
        break;
      case 'RESOLVING':
        target = '/resolution';
        break;
      default:
        target = '/';
    }

    if (window.location.pathname !== target) {
      navigate(target, { replace: true });
    }
  }, [room?.status, navigate]);

  const getPhaseRoute = () => {
    if (!room) return '/';

    switch (room.status) {
      case 'WAITING':
        return '/';
      case 'STRATEGY':
        return '/strategy';
      case 'RESULTS':
        return '/results';
      case 'LAWSUITS':
        return '/lawsuits';
      case 'RESOLVING':
        return '/resolution';
      default:
        return '/';
    }
  };

  return (
    <Routes>
      <Route path="/" element={<Matchmaking />} />
      <Route path="/strategy" element={<Strategy />} />
      <Route path="/results" element={<Results />} />
      <Route path="/lawsuits" element={<Lawsuits />} />
      <Route path="/resolution" element={<Resolution />} />
      <Route path="/gameover" element={<GameOver />} />
      <Route path="*" element={<Navigate to={getPhaseRoute()} replace />} />
    </Routes>
  );
};

export default App;
