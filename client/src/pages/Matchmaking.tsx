import React, { useState, useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Container,
  Paper,
  Title,
  Text,
  TextInput,
  Button,
  Stack,
  Divider,
  Flex,
  Alert,
  Badge,
  Group,
  CopyButton,
  ActionIcon,
  LoadingOverlay,
  ScrollArea,
  Image,
  Modal,
  List,
} from '@mantine/core';
import { IconCheck, IconCopy, IconInfoCircle } from '@tabler/icons-react';
import { useSocketStore } from '../stores/socketStore';
import { useGameStore } from '../stores/gameStore';
import { ClientEvents, ServerEvents, type RoomInfo, type ChatMessageBroadcast } from '@suetheirasses/shared';

/** localStorage key for remembering the player's name across visits — see `Matchmaking`'s name-entry section. */
const NAME_STORAGE_KEY = 'stita_player_name';

// "Courtroom Ink" tokens — same tokens as GamePhase.tsx's gpStyles, defined locally
// since this is a separate file; the underlying CSS custom properties live once in
// theme.css. Kept small (this page has far less surface than the in-game dashboard).
const mmStyles = {
  paper: {
    background: 'var(--ink-parchment)',
    backgroundImage: 'var(--paper-texture)',
    border: '1px solid #cbb888',
    borderRadius: 4,
    boxShadow: '6px 8px 0 rgba(0,0,0,0.45)',
  } as React.CSSProperties,
  title: {
    fontFamily: "'Rye', Georgia, serif",
    fontWeight: 400,
    color: 'var(--ink-text)',
  } as React.CSSProperties,
  label: {
    fontFamily: "'Courier Prime', 'Courier New', monospace",
    fontWeight: 700,
    letterSpacing: '0.02em',
    color: 'var(--ink-text)',
  } as React.CSSProperties,
  listedRoom: {
    background: '#f6efd9',
    backgroundImage: 'var(--paper-texture)',
    border: '1px solid #cbb888',
    borderRadius: 3,
  } as React.CSSProperties,
  primaryBtn: {
    fontFamily: "'Rye', Georgia, serif",
    letterSpacing: '0.02em',
    background: 'var(--ink-text)',
    color: 'var(--ink-parchment)',
    border: '2px solid var(--ink-gold)',
  } as React.CSSProperties,
};

function loadSavedName(): string {
  try {
    return localStorage.getItem(NAME_STORAGE_KEY) || '';
  } catch {
    return '';
  }
}

function saveName(name: string): void {
  try {
    localStorage.setItem(NAME_STORAGE_KEY, name);
  } catch {
    // localStorage unavailable (private browsing, etc.) — the name just won't be remembered.
  }
}

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
  const [playerName, setPlayerName] = useState(loadSavedName);
  const [isNameLocked, setIsNameLocked] = useState(() => !!loadSavedName());
  const [roomName, setRoomName] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [isSearching, setIsSearching] = useState(false);
  const [availableRooms, setAvailableRooms] = useState<RoomInfo[]>([]);
  const [chatMessages, setChatMessages] = useState<ChatMessageBroadcast[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [aboutOpen, setAboutOpen] = useState(false);
  const chatViewportRef = useRef<HTMLDivElement>(null);
  const { send, on, socket } = useSocketStore();
  const { room, player, error, setError } = useGameStore();

  /** A failed join/create attempt (name taken, room full, kicked, etc.) shouldn't leave
   * the loading overlay stuck forever — there's nothing else that resets these on error. */
  useEffect(() => {
    if (!error) return;
    setIsCreating(false);
    setIsSearching(false);
  }, [error]);

  /** Neither flag was ever reset on a *successful* join either (only the room-lobby view
   * rendering instead of this landing view masked it) — reset on every transition across
   * the room/no-room boundary, so landing back here (Leave Room, being kicked) never shows
   * a stuck LoadingOverlay left over from however we originally got into a room. */
  useEffect(() => {
    setIsCreating(false);
    setIsSearching(false);
  }, [room]);

  /** Remember the player's name as soon as it's non-empty, so it doesn't need to be re-typed next visit. */
  useEffect(() => {
    const trimmed = playerName.trim();
    if (trimmed) {
      saveName(trimmed);
    }
  }, [playerName]);

  /** Chat history is per-room — Matchmaking never unmounts across a leave/kick/rejoin, so
   * without this, messages from a room you've since left would linger into the next one. */
  useEffect(() => {
    setChatMessages([]);
  }, [room?.id]);

  /** Lobby chat (WAITING phase only) — listens while a room is joined, resets on unmount. */
  useEffect(() => {
    if (!socket || !room) return;
    const handler = (data: ChatMessageBroadcast) => {
      setChatMessages((prev) => [...prev, data]);
    };
    socket.on(ServerEvents.CHAT_MESSAGE, handler);
    return () => {
      socket.off(ServerEvents.CHAT_MESSAGE, handler);
    };
  }, [socket, room]);

  useEffect(() => {
    chatViewportRef.current?.scrollTo({ top: chatViewportRef.current.scrollHeight });
  }, [chatMessages]);

  const handleSendChatMessage = () => {
    const trimmed = chatInput.trim();
    if (!trimmed) return;
    send(ClientEvents.CHAT_MESSAGE, { message: trimmed });
    setChatInput('');
  };

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
    setError(null);
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
    setError(null);
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
    setError(null);
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
    setError(null);
    send(ClientEvents.ROOM_JOIN, {
      playerName: playerName.trim(),
      roomName: roomId,
    });
  };

  if (room && player) {
    const isHost = player.isHost;

    return (
      <Container size="sm" py="xl">
        <Paper p="xl" style={mmStyles.paper}>
          <Flex justify="space-between" align="center" mb="md">
            <Title order={2} style={mmStyles.title}>🏢 Room Lobby</Title>
            <Badge color={room.inviteOnly ? 'orange' : 'gray'} size="sm">
              {room.inviteOnly ? '🔒 Invite Only' : '🔓 Public'}
            </Badge>
          </Flex>
          <Stack>
            <Text fw={700} style={{ color: 'var(--ink-text)' }}>Players ({room.players.length}/{room.maxPlayers}):</Text>
            {room.players.map((p) => (
              <Flex key={p.id} justify="space-between" align="center">
                <Text style={{ color: 'var(--ink-text)' }}>
                  {p.name} {p.id === player.id && '(You)'}
                </Text>
                {isHost && p.id !== player.id ? (
                  <Button
                    size="compact-xs"
                    color="red"
                    variant="outline"
                    onClick={() => send(ClientEvents.ROOM_KICK, { playerId: p.id })}
                  >
                    Kick
                  </Button>
                ) : (
                  <Badge color={p.isHost ? 'orange' : 'gray'} size="sm">
                    {p.isHost ? 'Host' : 'Player'}
                  </Badge>
                )}
              </Flex>
            ))}
          </Stack>
          <Divider my="md" color="#cbb888" />
          <Stack gap="xs" mb="md">
            <Text fw={700} style={{ color: 'var(--ink-text)' }}>Lobby Chat:</Text>
            <ScrollArea h={160} viewportRef={chatViewportRef} type="auto" style={{ background: '#f6efd9', border: '1px solid #cbb888', borderRadius: 3 }}>
              <Stack gap={4} p={4}>
                {chatMessages.length === 0 && (
                  <Text size="sm" style={{ color: 'var(--ink-text-soft)' }}>
                    No messages yet — say hi.
                  </Text>
                )}
                {chatMessages.map((m, i) => (
                  <Text key={i} size="sm" style={{ color: 'var(--ink-text)' }}>
                    <Text span fw={600}>
                      {m.playerId === player.id ? 'You' : m.playerName}:
                    </Text>{' '}
                    {m.message}
                  </Text>
                ))}
              </Stack>
            </ScrollArea>
            <Group gap="xs">
              <TextInput
                placeholder="Type a message..."
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleSendChatMessage();
                }}
                maxLength={500}
                style={{ flex: 1 }}
              />
              <Button onClick={handleSendChatMessage} disabled={!chatInput.trim()}>
                Send
              </Button>
            </Group>
          </Stack>
          <Divider my="md" color="#cbb888" />
          {isHost && (
            <Stack gap="sm">
              <Group justify="space-between">
                <Text fw={700} style={{ color: 'var(--ink-text)' }}>Room Invite Link:</Text>
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
              <Group justify="space-between">
                <Text fw={700} style={{ color: 'var(--ink-text)' }}>Room Visibility:</Text>
                <Button
                  size="xs"
                  variant={room.inviteOnly ? 'filled' : 'outline'}
                  color={room.inviteOnly ? 'orange' : 'gray'}
                  onClick={() => send(ClientEvents.ROOM_SET_INVITE_ONLY, { inviteOnly: !room.inviteOnly })}
                  title={room.inviteOnly ? 'Invisible to Quick Play and Available Rooms — code/link still works' : 'Discoverable via Quick Play and Available Rooms'}
                >
                  {room.inviteOnly ? '🔒 Invite Only' : '🔓 Public'}
                </Button>
              </Group>
              <Group justify="center">
                <Button
                  size="lg"
                  style={{ ...mmStyles.primaryBtn, background: 'var(--ink-forest)', borderColor: 'var(--ink-forest)' }}
                  onClick={() => send(ClientEvents.ROOM_START_GAME, null)}
                  disabled={room.players.length < 2}
                  title={room.players.length < 2 ? 'Waiting for at least one more player to join' : undefined}
                >
                  Start Game
                </Button>
              </Group>
            </Stack>
          )}
          {!isHost && (
            <Alert
              variant="filled"
              color="dark"
              styles={{ root: { background: 'var(--ink-text)', border: '2px solid var(--ink-gold)' } }}
            >
              Waiting for the host to start the game...
            </Alert>
          )}
          <Divider my="md" color="#cbb888" />
          <Button
            fullWidth
            variant="outline"
            color="red"
            onClick={() => send(ClientEvents.ROOM_LEAVE, null)}
          >
            Leave Room
          </Button>
        </Paper>
      </Container>
    );
  }

  return (
    <Container size="sm" py="xl">
      <Paper p="xl" pos="relative" style={mmStyles.paper}>
        <LoadingOverlay visible={isCreating || isSearching} />
        <Image
          src="/images/hero.png"
          alt="Sue Their Asses — rival poultry tycoons face off in court"
          radius="md"
          mb="md"
        />
        <Group justify="center" mb="xl">
          <Button
            variant="subtle"
            color="dark"
            leftSection={<IconInfoCircle size={16} />}
            onClick={() => setAboutOpen(true)}
          >
            About
          </Button>
        </Group>

        <Stack>
          <Group align="flex-end" gap="xs">
            <TextInput
              label={<span style={mmStyles.label}>Your Name</span>}
              placeholder="Enter your name"
              value={playerName}
              onChange={(e) => setPlayerName(e.target.value)}
              required
              disabled={isCreating || isSearching || isNameLocked}
              style={{ flex: 1 }}
            />
            <Button
              variant="outline"
              color="dark"
              disabled={isCreating || isSearching || !isNameLocked}
              onClick={() => setIsNameLocked(false)}
            >
              Change Name
            </Button>
          </Group>

          {error && (
            <Alert color="red" variant="light" withCloseButton onClose={() => setError(null)}>
              {error.message}
            </Alert>
          )}

          <Divider my="sm" color="#cbb888" />

          {/* Show Quick Play + Create Room when NOT invited via link */}
          {!searchParams.has('room') && (
            <>
              <Title order={3} style={mmStyles.title}>Quick Play</Title>
              <Button
                fullWidth
                onClick={handleSearchForRoom}
                disabled={!playerName.trim() || isSearching}
                style={mmStyles.primaryBtn}
              >
                {isSearching ? 'Searching for a room...' : 'Search for Available Room'}
              </Button>

              <Divider my="sm" color="#cbb888" />

              <Title order={3} style={mmStyles.title}>Create a Room</Title>
              <Button
                fullWidth
                onClick={handleCreateRoom}
                disabled={!playerName.trim() || isCreating}
                style={{ ...mmStyles.primaryBtn, background: 'var(--ink-blood)', borderColor: 'var(--ink-blood)', color: '#f4e9d0' }}
              >
                {isCreating ? 'Creating...' : 'Create New Room'}
              </Button>
            </>
          )}

          {/* Show Join a Room ONLY when invited via direct link */}
          {searchParams.has('room') && (
            <>
              <Alert
                variant="filled"
                color="dark"
                mb="sm"
                styles={{ root: { background: 'var(--ink-text)', border: '2px solid var(--ink-gold)' } }}
              >
                You were invited to join a room. Enter your name below and click Join.
              </Alert>

              <Title order={3} style={mmStyles.title}>Join a Room</Title>
              <TextInput
                label={<span style={mmStyles.label}>Room Code</span>}
                placeholder="Enter room code"
                value={roomName}
                onChange={(e) => setRoomName(e.target.value)}
                disabled={isCreating || isSearching}
              />
              <Button
                fullWidth
                variant="outline"
                color="dark"
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
              <Divider my="sm" color="#cbb888" />
              <Title order={3} style={mmStyles.title}>Available Rooms</Title>
              <Stack>
                {availableRooms.map((roomInfo) => (
                  <Paper key={roomInfo.id} p="sm" style={mmStyles.listedRoom}>
                    <Flex justify="space-between" align="center">
                      <Text style={{ color: 'var(--ink-text)' }}>
                        Room {roomInfo.id.slice(0, 8)}... ({roomInfo.playerCount}/4 players)
                      </Text>
                      <Button
                        size="sm"
                        color="dark"
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

      {/* Modal's own `title` prop already renders inside an <h2> — passing a Mantine
          <Title order={3}> (an <h3>) here nested an h3 inside an h2, an invalid-HTML
          hydration warning. Plain styled text avoids the nested heading entirely. */}
      <Modal opened={aboutOpen} onClose={() => setAboutOpen(false)} title={<Text component="span" style={{ ...mmStyles.title, fontSize: '1.3rem' }}>⚖️🐔 Sue Their Asses</Text>} centered size="md">
        <Stack gap="md">
          <Text size="sm">
            Welcome to the cutthroat, deep-fried underbelly of industrial poultry. You and
            up to 3 rival executives each run a chicken empire, competing for the exact same
            coop-to-table market — and the instant your cash goes negative, your henhouse
            folds and you're out. Last tycoon standing keeps the whole flock.
          </Text>
          <Text size="sm">Each round, every ruthless chicken executive simultaneously:</Text>
          <List size="sm" spacing={4}>
            <List.Item>
              Deploys strategic and operational decisions to grow the business — some are
              wholesome (build a factory, train the staff), some are merely Grey Area
              (creative accounting, a strongly-worded press release), and some are flat-out
              Dirty (releasing a fox into a rival's henhouse, quietly pumping your own birds
              full of water before they hit the scale, lacing a competitor's feed with
              laxatives — yes, that is a real move you can make)
            </List.Item>
            <List.Item>
              Watches every other coop for something suspiciously fowl going on, and files a
              lawsuit over it — sometimes with real evidence, sometimes on nothing but a
              hunch and a grudge, because SUE THEIR ASSES doesn't wait for proof
            </List.Item>
            <List.Item>Negotiates a settlement, or drags a rival to court and lets a judge decide who's really been up to no good in the coop</List.Item>
          </List>
          <Text size="sm">
            Decisions move price, market share, revenue, and legal exposure — a sufficiently
            dirty move can send your numbers soaring, right up until a rival's lawyer smells
            blood in the henhouse. Or skip the lawsuits entirely: quietly buy up more than
            half of a rival's shares and take their whole operation in a hostile takeover.
            Outlast, outlawyer, or out-acquire every other company to become the last chicken
            tycoon standing.
          </Text>
          <Button onClick={() => setAboutOpen(false)} style={mmStyles.primaryBtn}>Got it</Button>
        </Stack>
      </Modal>
    </Container>
  );
};

export default Matchmaking;
