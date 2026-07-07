/**
 * Matchmaking page — Phase 1 of the game flow.
 *
 * Handles three entry paths:
 * - **Normal**: Player sees Quick Play, Create Room, Join Room, and Available Rooms sections.
 * - **Invite Link**: When accessed via `?room=<roomId>` query param, only "Join a Room" is shown
 *   with the room code auto-filled. "Create a Room" and "Quick Play" are hidden.
 * - **Lobby**: After joining, displays the room lobby with player list, host controls,
 *   and an invite-link copy button for hosts.
 *
 * @remarks State is managed via Zustand stores (`gameStore`, `socketStore`).
 *          Socket.IO events: `rooms:list` → populates available rooms.
 */
const Matchmaking: React.FC = () => {
  const [searchParams] = useSearchParams();
  const [playerName, setPlayerName] = useState('');
  const [roomName, setRoomName] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [isSearching, setIsSearching] = useState(false);
  const [availableRooms, setAvailableRooms] = useState<RoomInfo[]>([]);
  const { send, on } = useSocketStore();
  const { room, player } = useGameStore();

  /** Auto-detect invite link from URL query params and pre-fill the room name field. */
  useEffect(() => {
    const invitedRoom = searchParams.get('room');
    if (invitedRoom) {
      setRoomName(invitedRoom.trim());
    }
  }, [searchParams]);

  useEffect(() => {
    const unsubscribe = on(ServerEvents.ROOMS_LISTED, (data: unknown) => {
      const typedData = data as { rooms: RoomInfo[] };
      setAvailableRooms(typedData.rooms);
      setIsSearching(false);
    });
    return unsubscribe;
  }, [on]);

  /**
   * Create a new room for this player.
   *
   * Emits `room:join` with only `playerName` — server creates a fresh room
   * and assigns the player as host.
   */
  const handleCreateRoom = () => {
    if (!playerName.trim()) return;
    setIsCreating(true);
    send(ClientEvents.ROOM_JOIN, { playerName: playerName.trim() });
  };

  /**
   * Join an existing room by its ID (room name/code).
   *
   * Used both when manually entering a room code and when joining via invite link
   * (`?room=<roomId>`). The room code is passed as `roomName` in the payload.
   *
   * @param roomId - Optional override; uses local state's `roomName` by default.
   */
  const handleJoinRoom = () => {
    if (!playerName.trim() || !roomName.trim()) return;
    send(ClientEvents.ROOM_JOIN, {
      playerName: playerName.trim(),
      roomName: roomName.trim(),
    });
  };

  /**
   * Quick Play — find any available room with fewer than max players.
   *
   * Emits `room:join` with `searchForRoom: true`. Server selects the room
   * with the fewest players (or creates a new one if none are available).
   */
  const handleSearchForRoom = () => {
    if (!playerName.trim()) return;
    setIsSearching(true);
    send(ClientEvents.ROOM_JOIN, { playerName: playerName.trim(), searchForRoom: true });
  };

  /**
   * Join a specific room from the "Available Rooms" list.
   *
   * @param roomId - The unique ID of the target room.
   */
  const handleJoinListedRoom = (roomId: string) => {
    if (!playerName.trim()) return;
    send(ClientEvents.ROOM_JOIN, {
      playerName: playerName.trim(),
      roomName: roomId,
    });
  };

  if (room && player) {
    const isHost = player.isHost;

    return (
      <Container size="sm" py="xl">
        <Paper withBorder p="xl" shadow="lg">
          <Title order={2} mb="md">
            🏢 Room Lobby
          </Title>
          {isHost && (
            <Badge size="lg" color="orange" mb="md">
              🎮 You are the Host
            </Badge>
          )}
          <Divider my="md" />
          <Stack>
            <Text fw={500}>Players ({room.players.length}/{room.maxPlayers}):</Text>
            {room.players.map((p) => (
              <Flex key={p.id} justify="space-between" align="center">
                <Text>
                  {p.name} {p.id === player.id && '(You)'} {p.isHost && '👑'}
                </Text>
                {isHost && p.id !== player.id ? (
                  <Button
                    size="xs"
                    color="red"
                    variant="outline"
                    onClick={() => send(ClientEvents.ROOM_KICK, { playerId: p.id })}
                  >
                    Kick
                  </Button>
                ) : (
                  <Badge color={isHost ? 'orange' : 'gray'} size="sm">
                    {isHost ? 'Host' : 'Player'}
                  </Badge>
                )}
              </Flex>
            ))}
          </Stack>
          <Divider my="md" />
          {isHost && (
            <Stack gap="sm">
              <Group justify="space-between">
                <Text fw={500}>Room Invite Link:</Text>
                <CopyButton value={window.location.origin + `?room=${room.id}`}>
                  {({ copied, copy }) => (
                    <ActionIcon
                      color={copied ? 'teal' : 'blue'}
                      variant="filled"
                      size="md"
                      onClick={copy}
                      title={copied ? 'Link copied!' : 'Copy invite link'}
                    >
                      {copied ? <IconCheck size={16} /> : <IconCopy size={16} />}
                    </ActionIcon>
                  )}
                </CopyButton>
              </Group>
              <Group justify="center">
                <Button
                  size="lg"
                  color="green"
                  onClick={() => send(ClientEvents.ROOM_START_GAME, null)}
                  disabled={room.players.length < 1}
                >
                  🚀 Start Game
                </Button>
              </Group>
            </Stack>
          )}
          {!isHost && (
            <Alert variant="filled" color="blue">
              Waiting for the host to start the game...
            </Alert>
          )}
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

          {/* Show Quick Play + Create Room when NOT invited via link */}
          {!searchParams.has('room') && (
            <>
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
            </>
          )}

          {/* Show Join a Room ONLY when invited via direct link */}
          {searchParams.has('room') && (
            <>
              <Alert variant="filled" color="blue" mb="sm">
                You were invited to join a room. Enter your name below and click Join.
              </Alert>

              <Title order={3}>Join a Room</Title>
              <TextInput
                label="Room Code"
                placeholder="Enter room code"
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
            </>
          )}

          {/* Always show available rooms for quick play discovery */}
          {!searchParams.has('room') && availableRooms.length > 0 && (
            <>
              <Divider my="sm" />
              <Title order={3}>Available Rooms</Title>
              <Stack>
                {availableRooms.map((roomInfo) => (
                  <Paper key={roomInfo.id} p="sm" withBorder radius="md">
                    <Flex justify="space-between" align="center">
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
                  </Paper>
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
