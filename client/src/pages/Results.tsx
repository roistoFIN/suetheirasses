import React from 'react';
import { Container, Paper, Title, Text, Stack, Flex, Badge, Progress } from '@mantine/core';
import { useGameStore } from '../stores/gameStore';
import { motion } from 'framer-motion';

const Results: React.FC = () => {
  const { results, room } = useGameStore();

  if (!results || !room) return null;

  return (
    <Container size="lg" py="xl">
      <Paper withBorder p="xl" shadow="lg">
        <Flex justify="space-between" align="center" mb="xl">
          <Title order={2}>📊 Phase 3: Results</Title>
          <Badge color="green" size="lg">
            Round {room.currentPhaseRound}
          </Badge>
        </Flex>

        <Stack>
          {results.outcomes.map((outcome, index) => (
            <motion.div
              key={outcome.playerId}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: index * 0.2 }}
            >
              <Paper withBorder p="md">
                <Flex justify="space-between" align="center" mb="sm">
                  <Title order={4}>{outcome.playerName}</Title>
                  <Badge color="blue">
                    Cash: ${Math.round(outcome.changes.reduce((sum, c) => sum + c.cashDelta, 0))}
                  </Badge>
                </Flex>
                <Stack>
                  {outcome.changes.map((change, cIndex) => (
                    <Flex key={cIndex} justify="space-between">
                      <Text>{change.description}</Text>
                      <Text c={change.cashDelta >= 0 ? 'green' : 'red'} fw={500}>
                        {change.cashDelta >= 0 ? '+' : ''}${Math.round(change.cashDelta)}
                      </Text>
                    </Flex>
                  ))}
                </Stack>
              </Paper>
            </motion.div>
          ))}
        </Stack>
      </Paper>
    </Container>
  );
};

export default Results;
