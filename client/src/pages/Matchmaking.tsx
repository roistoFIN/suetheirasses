import React, { useState, useEffect } from 'react';
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
  Alert,
  LoadingOverlay,
} from '@mantine/core';
import { useSocketStore } from '../stores/socketStore';
import { useGameStore } from '../stores/gameStore';
import { ClientEvents, ServerEvents, type RoomInfo } from '@suetheirasses/shared';

const Matchmaking: React.FC = () => {
  const [playerName, setPlayerName] = useState('');
  const [roomName, setRoomName] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [isSearching, setIsSearching] = useState(false);
  const [availableRooms, setAvailableRooms] = useState<RoomInfo[]>([]);
  const { send, on } = useSocketStore();
  const { room, player } = useGameStore();

  useEffect(() => {
    const unsubscribe = on(ServerEvents.ROOMS_LISTED, (data: { rooms: RoomInfo[] }) => {
      setAvailableRooms(data.rooms);
      setIsSearching(false);
    });
    return unsubscribe;
  }, [on]);

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

  const handleSearchForRoom = () => {
    if (!playerName.trim()) return;
    setIsSearching(true);
    send(ClientEvents.ROOM_JOIN, { playerName: playerName.trim(), searchForRoom: true });
  };

  const handleJoinListedRoom = (roomId: string) => {
    if (!playerName.trim()) return;
    send(ClientEvents.ROOM_JOIN, {
      playerName: playerName.trim(),
      roomName: roomId,
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
      <Paper withBorder p="xl" shadow="lg" pos="relative">
        <LoadingOverlay visible={isCreating || isSearching} />
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
            disabled={isCreating || isSearching}
          />

          <Divider my="sm" />

          <Title order={3}>Quick Play</Title>
          <Button
            fullWidth
            onClick={handleSearchForRoom}
            disabled={!playerName.trim() || isSearching}
            variant="gradient"
            gradient={{ from: 'blue', to: 'cyan' }}
          >
            {isSearching ? 'Searching for a room...' : 'Search for Available Room'}
          </Button>

          <Divider my="sm" />

          <Title order={3}>Create a Room</Title>
          <Button
            fullWidth
            onClick={handleCreateRoom}
            disabled={!playerName.trim() || isCreating}
          >
            {isCreating ? 'Creating...' : 'Create New Room'}
          </Button>

          <Divider my="sm" />

          <Title order={3}>Join a Room</Title>
          <TextInput
            label="Room Name (host's name)"
            placeholder="Enter host name"
            value={roomName}
            onChange={(e) => setRoomName(e.target.value)}
            disabled={isCreating || isSearching}
          />
          <Button
            fullWidth
            variant="outline"
            onClick={handleJoinRoom}
            disabled={!playerName.trim() || !roomName.trim() || isCreating || isSearching}
          >
            Join Room
          </Button>

          {availableRooms.length > 0 && (
            <>
              <Divider my="sm" />
              <Title order={3}>Available Rooms</Title>
              <Stack>
                {availableRooms.map((roomInfo) => (
                  <Flex
                    key={roomInfo.id}
                    justify="space-between"
                    align="center"
                    p="sm"
                    withBorder
                    radius="md"
                  >
                    <Text>
                      Room {roomInfo.id.slice(0, 8)}... ({roomInfo.playerCount}/4 players)
                    </Text>
                    <Button
                      size="sm"
                      onClick={() => handleJoinListedRoom(roomInfo.id)}
                      disabled={!playerName.trim()}
                    >
                      Join
                    </Button>
                  </Flex>
                ))}
              </Stack>
            </>
          )}
        </Stack>
      </Paper>
    </Container>
  );
};

export default Matchmaking;
