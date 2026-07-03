import React from 'react';
import {
  Container,
  Paper,
  Title,
  Text,
  Button,
  Group,
  Stack,
  TextInput,
  NumberInput,
  Badge,
  Flex,
  Alert,
  Table,
} from '@mantine/core';
import { useSocketStore } from '../stores/socketStore';
import { useGameStore } from '../stores/gameStore';
import { ClientEvents } from '@suetheirasses/shared';

const Resolution: React.FC = () => {
  const [responses, setResponses] = useState<Record<string, { defense: string; settlement?: number }>>({});
  const { send } = useSocketStore();
  const { room, player } = useGameStore();

  const handleRespond = (lawsuitId: string) => {
    const response = responses[lawsuitId];
    if (!response?.defense) return;
    send(ClientEvents.LAWSUIT_RESPOND, {
      lawsuitId,
      defense: response.defense,
      settlementOffer: response.settlement,
    });
  };

  if (!room || !player) return null;

  return (
    <Container size="lg" py="xl">
      <Paper withBorder p="xl" shadow="lg">
        <Flex justify="space-between" align="center" mb="xl">
          <Title order={2}>🔨 Phase 5: Legal Resolution</Title>
          <Badge color="red" size="lg">
            Round {room.currentPhaseRound}
          </Badge>
        </Flex>

        <Alert variant="filled" color="red" mb="xl">
          Respond to lawsuits filed against you. You can offer a settlement to reduce penalties.
        </Alert>

        <Stack>
          <Paper withBorder p="md">
            <Title order={4} mb="md">
              Lawsuits to Respond To
            </Title>
            <Table>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Plaintiff</Table.Th>
                  <Table.Th>Claim</Table.Th>
                  <Table.Th>Grounds</Table.Th>
                  <Table.Th>Action</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                <Table.Tr>
                  <Table.Td colSpan={4} c="dimmed">
                    No pending lawsuits to respond to
                  </Table.Td>
                </Table.Tr>
              </Table.Tbody>
            </Table>
          </Paper>
        </Stack>
      </Paper>
    </Container>
  );
};

export default Resolution;
