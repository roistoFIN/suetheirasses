import React, { useEffect, useState } from 'react';
import { Text, Progress, Box } from '@mantine/core';
import { useGameStore } from '../stores/gameStore';

const Timer: React.FC = () => {
  const { timer, currentPhase } = useGameStore();
  const [timeLeft, setTimeLeft] = useState(timer);

  useEffect(() => {
    setTimeLeft(timer);
  }, [timer]);

  useEffect(() => {
    if (currentPhase === null || timeLeft <= 0) return;

    const interval = setInterval(() => {
      setTimeLeft((prev) => {
        if (prev <= 1) {
          clearInterval(interval);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(interval);
  }, [timeLeft]);

  if (currentPhase === null || currentPhase === 'WAITING') return null;

  const isUrgent = timeLeft <= 10;
  const percentage = (timeLeft / 120) * 100;

  return (
    <Box p="md" style={{ background: isUrgent ? 'var(--mantine-color-red-light)' : 'var(--mantine-color-dark-8)' }}>
      <Text size="sm" c={isUrgent ? 'red' : 'gray'} fw={500}>
        ⏱ {Math.floor(timeLeft / 60)}:{(timeLeft % 60).toString().padStart(2, '0')}
      </Text>
      <Progress value={percentage} size="sm" mt="xs" color={isUrgent ? 'red' : 'blue'} />
    </Box>
  );
};

export default Timer;
