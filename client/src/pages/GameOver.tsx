import React from 'react';
import {
  Container,
  Paper,
  Title,
  Text,
  Button,
  Stack,
  Flex,
  Badge,
  Table,
  Center,
} from '@mantine/core';
import { useGameStore } from '../stores/gameStore';

const GameOver: React.FC = () => {
  const { gameOver } = useGameStore();

  if (!gameOver) return null;

  return (
    <Container size="lg" py="xl">
      <Paper withBorder p="xl" shadow="lg">
        <Center>
          <Title order={2} mb="xl">
            🏆 Game Over!
          </Title>
        </Center>

        {gameOver.winner && (
          <Flex justify="center" mb="xl">
            <Badge color="gold" size="xl" px="xl" py="md">
              🎉 {gameOver.winner.name} Wins!
            </Badge>
          </Flex>
        )}

        <Stack>
          <Title order={4} mb="md">
            Final Standings
          </Title>
          <Table>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Rank</Table.Th>
                <Table.Th>Player</Table.Th>
                <Table.Th>Company Cash</Table.Th>
                <Table.Th>Status</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {gameOver.finalStandings.map((standing) => (
                <Table.Tr key={standing.player.id}>
                  <Table.Td>
                    <Badge color={standing.rank === 1 ? 'gold' : 'gray'}>
                      #{standing.rank}
                    </Badge>
                  </Table.Td>
                  <Table.Td>{standing.player.name}</Table.Td>
                  <Table.Td>
                    ${Math.round(standing.company?.cash || 0)}
                  </Table.Td>
                  <Table.Td>
                    {standing.player.bankrupt ? (
                      <Badge color="red">Bankrupt</Badge>
                    ) : (
                      <Badge color="green">Active</Badge>
                    )}
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Stack>

        <Center mt="xl">
          <Button size="lg" onClick={() => window.location.reload()}>
            Play Again
          </Button>
        </Center>
      </Paper>
    </Container>
  );
};

export default GameOver;
