import React, { useState } from 'react';
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
  Select,
  Badge,
  Flex,
  Alert,
  Table,
} from '@mantine/core';
import { useSocketStore } from '../stores/socketStore';
import { useGameStore } from '../stores/gameStore';
import { ClientEvents } from '@suetheirasses/shared';

const Lawsuits: React.FC = () => {
  const [selectedDefendant, setSelectedDefendant] = useState('');
  const [claimAmount, setClaimAmount] = useState(10000);
  const [grounds, setGrounds] = useState('');
  const { send } = useSocketStore();
  const { room, player } = useGameStore();

  const activePlayers = room?.players.filter((p) => !p.bankrupt && p.id !== player?.id) || [];

  const handleSubmit = () => {
    if (!selectedDefendant || !grounds) return;
    send(ClientEvents.LAWSUIT_FILE, {
      defendantId: selectedDefendant,
      claimAmount,
      grounds,
    });
    setSelectedDefendant('');
    setClaimAmount(10000);
    setGrounds('');
  };

  if (!room || !player) return null;

  return (
    <Container size="lg" py="xl">
      <Paper withBorder p="xl" shadow="lg">
        <Flex justify="space-between" align="center" mb="xl">
          <Title order={2}>⚖️ Phase 4: Legal Suits</Title>
          <Badge color="orange" size="lg">
            Round {room.currentPhaseRound}
          </Badge>
        </Flex>

        <Alert variant="filled" color="blue" mb="xl">
          File lawsuits against other players. Each filing costs $1,000. Choose your targets wisely!
        </Alert>

        <Stack>
          <Paper withBorder p="md">
            <Title order={4} mb="md">
              File a New Lawsuit
            </Title>
            <Stack>
              <Select
                label="Defendant"
                placeholder="Select a player"
                value={selectedDefendant}
                onChange={setSelectedDefendant}
                options={activePlayers.map((p) => ({
                  value: p.id,
                  label: p.name,
                }))}
              />
              <NumberInput
                label="Claim Amount ($)"
                value={claimAmount}
                onChange={(value) => setClaimAmount(Number(value))}
                min={1000}
                max={1000000}
                step={1000}
              />
              <TextInput
                label="Grounds for Lawsuit"
                placeholder="Describe the legal grounds..."
                value={grounds}
                onChange={(e) => setGrounds(e.target.value)}
                minRows={3}
              />
              <Button onClick={handleSubmit} disabled={!selectedDefendant || grounds.length < 10}>
                File Lawsuit ($1,000 fee)
              </Button>
            </Stack>
          </Paper>

          <Paper withBorder p="md">
            <Title order={4} mb="md">
              Active Lawsuits
            </Title>
            <Table>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Plaintiff</Table.Th>
                  <Table.Th>Defendant</Table.Th>
                  <Table.Th>Claim</Table.Th>
                  <Table.Th>Status</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                <Table.Tr>
                  <Table.Td colSpan={4} c="dimmed">
                    No active lawsuits yet
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

export default Lawsuits;
