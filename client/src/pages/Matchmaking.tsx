import React, { useState } from 'react';
import {
  Container,
  Paper,
  Title,
  TextInput,
  Button,
  Text,
  Group,
  Stack,
  Badge,
  Divider,
  Flex,
} from '@mantine/core';
import { useSocketStore } from '../stores/socketStore';
import { useGameStore } from '../stores/gameStore';
import { ClientEvents } from '@suetheirasses/shared';

const Matchmaking: React.FC = () => {
  const [playerName, setPlayerName] = useState('');
  const [roomName, setRoomName] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const { send } = useSocketStore();
  const { room, player } = useGameStore();

  const handleCreateRoom = () => {
    if (!playerName.trim()) return;
    setIsCreating(true);
    send(ClientEvents.ROOM_JOIN, { playerName: playerName.trim() });
  };

  const handleJoinRoom = () => {
    if (!playerName.trim() || !roomName.trim()) return;
    send(ClientEvents.ROOM_JOIN, {
      playerName: playerName.trim(),
      roomName: roomName.trim(),
    });
  };

  if (room && player) {
    return (
      <Container size="sm" py="xl">
        <Paper withBorder p="xl" shadow="lg">
          <Title order={2} mb="md">
            🏢 Room Lobby
          </Title>
          <Badge size="lg" color="blue">
            Round {room.currentPhaseRound}
          </Badge>
          <Divider my="md" />
          <Stack>
            <Text fw={500}>Players:</Text>
            {room.players.map((p) => (
              <Flex key={p.id} justify="space-between" align="center">
                <Text>
                  {p.name} {p.id === player.id && '(You)'}
                </Text>
                <Badge color={p.isReady ? 'green' : 'yellow'}>
                  {p.isReady ? 'Ready' : 'Not Ready'}
                </Badge>
              </Flex>
            ))}
          </Stack>
          <Divider my="md" />
          <Group justify="center">
            <Button
              size="lg"
              color={player.isReady ? 'red' : 'green'}
              onClick={() => send(ClientEvents.ROOM_READY, null)}
            >
              {player.isReady ? 'Cancel Ready' : 'Ready Up!'}
            </Button>
          </Group>
        </Paper>
      </Container>
    );
  }

  return (
    <Container size="sm" py="xl">
      <Paper withBorder p="xl" shadow="lg">
        <Title order={2} mb="xs" ta="center">
          ⚖️ Sue Their Asses
        </Title>
        <Text c="dimmed" ta="center" mb="xl">
          Multiplayer Business Strategy Game
        </Text>

        <Stack>
          <TextInput
            label="Your Name"
            placeholder="Enter your name"
            value={playerName}
            onChange={(e) => setPlayerName(e.target.value)}
            required
          />

          <Divider my="sm" />

          <Title order={3}>Create a Room</Title>
          <Button fullWidth onClick={handleCreateRoom} disabled={!playerName.trim() || isCreating}>
            Create New Room
          </Button>

          <Divider my="sm" />

          <Title order={3}>Join a Room</Title>
          <TextInput
            label="Room Name (host's name)"
            placeholder="Enter host name"
            value={roomName}
            onChange={(e) => setRoomName(e.target.value)}
          />
          <Button
            fullWidth
            variant="outline"
            onClick={handleJoinRoom}
            disabled={!playerName.trim() || !roomName.trim()}
          >
            Join Room
          </Button>
        </Stack>
      </Paper>
    </Container>
  );
};

export default Matchmaking;
