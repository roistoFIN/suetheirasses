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
  Table,
} from '@mantine/core';
import { IconCheck, IconCopy, IconInfoCircle, IconShieldLock, IconMessageStar } from '@tabler/icons-react';
import { useSocketStore } from '../stores/socketStore';
import { useGameStore } from '../stores/gameStore';
import { useChatStore } from '../stores/chatStore';
import FeedbackForm from '../components/FeedbackForm';
import { ClientEvents, ServerEvents, type RoomInfo } from '@suetheirasses/shared';

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
  const [chatInput, setChatInput] = useState('');
  const [aboutOpen, setAboutOpen] = useState(false);
  const [privacyOpen, setPrivacyOpen] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const chatViewportRef = useRef<HTMLDivElement>(null);
  const { send, on } = useSocketStore();
  const { room, player, error, setError } = useGameStore();
  const { messages: chatMessages, show: showChat, hide: hideChat } = useChatStore();

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

  /** Chat messages/history now live in chatStore (shared with GamePhase/GameTimelineView's
   * floating ChatWidget, so the same conversation carries through from the lobby into the
   * game and game-over screens — see chatStore.ts's own doc comment) rather than local
   * state here. This lobby view still renders it as an always-visible inline box, unlike
   * the floating popup those other screens use — so it marks the chat "visible" for as
   * long as the lobby itself is showing, meaning a message that arrives while a player is
   * sitting in the lobby is treated as already read, not queued up as unread for when they
   * later land on the in-game floating widget. */
  useEffect(() => {
    if (!room) return;
    showChat();
    return () => hideChat();
  }, [room, showChat, hideChat]);

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
          <Button
            variant="subtle"
            color="dark"
            leftSection={<IconShieldLock size={16} />}
            onClick={() => setPrivacyOpen(true)}
          >
            Privacy Policy
          </Button>
          <Button
            variant="subtle"
            color="dark"
            leftSection={<IconMessageStar size={16} />}
            onClick={() => setFeedbackOpen(true)}
          >
            Feedback
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

      <Modal
        opened={privacyOpen}
        onClose={() => setPrivacyOpen(false)}
        title={<Text component="span" style={{ ...mmStyles.title, fontSize: '1.3rem' }}>⚖️ Privacy Policy</Text>}
        centered
        size="lg"
      >
        <Stack gap="md">
          <Text size="sm" fs="italic" style={{ color: 'var(--ink-text-soft)' }}>Last Updated: July 23, 2026</Text>

          <Text size="sm">
            This Privacy Policy describes how Sue Their Asses ("we", "us", or "our")
            collects, uses, and protects your personal data when you play our web game at
            suetheirasses.org. We are committed to respecting your privacy and complying
            with applicable data protection laws, including the EU General Data Protection
            Regulation (GDPR) and Finnish data protection laws.
          </Text>

          <Title order={4} style={mmStyles.title}>1. Data Controller</Title>
          <Text size="sm">The data controller responsible for your personal data is:</Text>
          <List size="sm" spacing={2}>
            <List.Item><b>Name / Data Controller:</b> Risto Paavola</List.Item>
            <List.Item><b>Location:</b> Finland</List.Item>
            <List.Item><b>Contact Email:</b> risto.paavola@gmail.com</List.Item>
          </List>

          <Title order={4} style={mmStyles.title}>2. Information We Collect</Title>
          <Text size="sm">
            We only collect the minimal amount of data necessary to provide and secure the
            game, as well as to run analytics and advertisements.
          </Text>
          <Text size="sm" fw={700}>Player Identification &amp; Gameplay Data:</Text>
          <List size="sm" spacing={2}>
            <List.Item>A uniquely generated Player ID assigned to your browser session.</List.Item>
            <List.Item>Optional username chosen by you.</List.Item>
            <List.Item>In-game action logs and gameplay progress associated with your Player ID.</List.Item>
          </List>
          <Text size="sm" fw={700}>Technical &amp; Network Data:</Text>
          <List size="sm" spacing={2}>
            <List.Item>IP address.</List.Item>
            <List.Item>Technical logs (server access logs, request timestamps, error logs).</List.Item>
          </List>
          <Text size="sm" fw={700}>Cookies and Tracking Technologies:</Text>
          <List size="sm" spacing={2}>
            <List.Item>Essential cookies or local storage keys required to maintain your game session.</List.Item>
            <List.Item>Third-party cookies and tracking scripts provided by Google (see Section 5).</List.Item>
          </List>

          <Title order={4} style={mmStyles.title}>3. Legal Grounds and Purposes of Processing</Title>
          <Text size="sm">We process your data for the following purposes and legal bases:</Text>
          <Table striped withTableBorder withColumnBorders fz="sm">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Purpose</Table.Th>
                <Table.Th>Collected Data</Table.Th>
                <Table.Th>Legal Basis (GDPR)</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              <Table.Tr>
                <Table.Td>Game Operation</Table.Td>
                <Table.Td>Player ID, optional username, gameplay logs, essential cookies</Table.Td>
                <Table.Td><b>Contract:</b> Necessary to provide the web game service to you.</Table.Td>
              </Table.Tr>
              <Table.Tr>
                <Table.Td>Security &amp; Stability</Table.Td>
                <Table.Td>IP addresses, server logs, action logs</Table.Td>
                <Table.Td><b>Legitimate Interest:</b> To ensure network security, prevent abuse/cheating, and fix technical bugs.</Table.Td>
              </Table.Tr>
              <Table.Tr>
                <Table.Td>Analytics &amp; Advertising</Table.Td>
                <Table.Td>Device/browser data, cookie identifiers, interaction data</Table.Td>
                <Table.Td><b>Consent:</b> Required before loading Google Analytics and Google Ads scripts via our Consent Banner.</Table.Td>
              </Table.Tr>
            </Table.Tbody>
          </Table>

          <Title order={4} style={mmStyles.title}>4. Data Storage, Location, and Retention</Title>
          <List size="sm" spacing={2}>
            <List.Item><b>Server Location:</b> Our game servers are hosted on a Hetzner Cloud VPS located in Finland (EU/EEA).</List.Item>
            <List.Item><b>Retention Period:</b> All IP addresses, server logs, player IDs, usernames, and in-game action logs are automatically and permanently deleted after 90 days.</List.Item>
          </List>

          <Title order={4} style={mmStyles.title}>5. Third-Party Services and Analytics</Title>
          <Text size="sm">
            We use third-party services provided by Google LLC / Google Ireland Limited to
            analyze website traffic and display advertisements:
          </Text>
          <List size="sm" spacing={2}>
            <List.Item><b>Google Analytics:</b> Used to collect aggregated statistical information about how players interact with the game.</List.Item>
            <List.Item><b>Google Advertising (Ads / AdSense):</b> Used to display advertisements to users.</List.Item>
          </List>
          <Text size="sm" fw={700}>Consent Management</Text>
          <Text size="sm">
            Non-essential third-party scripts (Google Analytics and Advertising) are
            blocked by default and will only load if you explicitly grant permission
            through our Consent Management Banner on your first visit. You may update or
            revoke your cookie consent at any time using the cookie settings link
            available on our website.
          </Text>
          <Text size="sm" fw={700}>International Data Transfers</Text>
          <Text size="sm">
            Google may process data outside the European Economic Area (EEA), including in
            the United States. Data transfers to Google LLC in the US are based on the
            EU-U.S. Data Privacy Framework.
          </Text>

          <Title order={4} style={mmStyles.title}>6. Your Data Rights Under GDPR</Title>
          <Text size="sm">Under the GDPR, you have the following rights regarding your personal data:</Text>
          <List size="sm" spacing={2}>
            <List.Item><b>Right of Access:</b> You can request a copy of the personal data we hold about you.</List.Item>
            <List.Item><b>Right to Erasure ("Right to be Forgotten"):</b> You can request that we delete your personal data.</List.Item>
            <List.Item><b>Right to Object / Restrict Processing:</b> You can object to or request restrictions on processing under certain conditions.</List.Item>
            <List.Item><b>Right to Withdraw Consent:</b> Where processing is based on consent (analytics/advertising), you can withdraw your consent at any time.</List.Item>
          </List>
          <Text size="sm">
            <b>Note on Data Identification:</b> Because we do not require account
            registration or email addresses, your data is linked only to your Player ID or
            IP Address. To exercise your rights regarding specific gameplay data, you must
            provide us with your assigned Player ID.
          </Text>
          <Text size="sm">
            To exercise any of these rights, please contact us at{' '}
            <a href="mailto:risto.paavola@gmail.com" style={{ color: 'var(--ink-text)' }}>risto.paavola@gmail.com</a>.
          </Text>
          <Text size="sm" fw={700}>Right to Lodge a Complaint</Text>
          <Text size="sm">
            If you believe that our processing of your personal data violates data
            protection laws, you have the right to lodge a complaint with a supervisory
            authority. In Finland, the competent authority is the Office of the Data
            Protection Ombudsman (Tietosuojavaltuutetun toimisto, tietosuoja.fi).
          </Text>

          <Title order={4} style={mmStyles.title}>7. Changes to This Privacy Policy</Title>
          <Text size="sm">
            We may update this Privacy Policy from time to time to reflect changes in
            legal requirements or operational practices. The updated version will be
            indicated by the "Last Updated" date at the top of this document.
          </Text>

          <Button onClick={() => setPrivacyOpen(false)} style={mmStyles.primaryBtn}>Got it</Button>
        </Stack>
      </Modal>

      <Modal
        opened={feedbackOpen}
        onClose={() => setFeedbackOpen(false)}
        title={<Text component="span" style={{ ...mmStyles.title, fontSize: '1.3rem' }}>💬 Feedback</Text>}
        centered
        size="sm"
      >
        <FeedbackForm source="landing" onClose={() => setFeedbackOpen(false)} />
      </Modal>
    </Container>
  );
};

export default Matchmaking;
