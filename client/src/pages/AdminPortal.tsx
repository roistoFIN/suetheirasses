import React, { useState, useEffect, useCallback } from 'react';
import {
  Container,
  Paper,
  Title,
  Text,
  PasswordInput,
  Button,
  Stack,
  Table,
  Badge,
  Group,
  Alert,
  Divider,
  ActionIcon,
  Code,
} from '@mantine/core';
import { IconLogout } from '@tabler/icons-react';
import type { AdminRoomSnapshot } from '@suetheirasses/shared';

/**
 * Admin Portal — a real, independent URL (`/admin`), not driven by game phase state
 * at all (see `App.tsx`'s `isAdminRoute` exemptions). Read-only for now: room
 * monitoring + the game config the server loaded at startup. Gated by a single
 * shared-secret token (`ADMIN_TOKEN` on the server, see `middleware/adminAuth.ts`) —
 * there's no broader auth system in this app, so this is deliberately minimal.
 */
const SERVER_URL = import.meta.env.VITE_SERVER_URL || 'http://localhost:3001';
const TOKEN_KEY = 'stita_admin_token';
const POLL_INTERVAL_MS = 5000;

async function adminFetch(path: string, token: string): Promise<Response> {
  return fetch(`${SERVER_URL}${path}`, { headers: { 'x-admin-token': token } });
}

const AdminPortal: React.FC = () => {
  const [token, setToken] = useState<string>(() => sessionStorage.getItem(TOKEN_KEY) || '');
  const [tokenInput, setTokenInput] = useState('');
  const [authed, setAuthed] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [authLoading, setAuthLoading] = useState(false);
  const [rooms, setRooms] = useState<AdminRoomSnapshot[]>([]);
  const [config, setConfig] = useState<unknown>(null);

  const tryAuth = useCallback(async (candidate: string) => {
    setAuthLoading(true);
    setAuthError(null);
    try {
      const res = await adminFetch('/api/admin/rooms', candidate);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setAuthError(body.error || `Request failed (${res.status})`);
        setAuthed(false);
        sessionStorage.removeItem(TOKEN_KEY);
        return;
      }
      const data = await res.json();
      setRooms(data.rooms);
      setAuthed(true);
      sessionStorage.setItem(TOKEN_KEY, candidate);
      setToken(candidate);
    } catch {
      setAuthError('Could not reach the server');
      setAuthed(false);
    } finally {
      setAuthLoading(false);
    }
  }, []);

  // Try any saved token once on mount, so a refresh doesn't require re-entering it.
  useEffect(() => {
    if (token) tryAuth(token);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Poll rooms + config while authenticated. A 401/503 mid-session (token revoked,
  // ADMIN_TOKEN unset on the server) drops back to the login form.
  useEffect(() => {
    if (!authed) return;
    let cancelled = false;

    const refresh = async () => {
      try {
        const [roomsRes, configRes] = await Promise.all([
          adminFetch('/api/admin/rooms', token),
          adminFetch('/api/admin/config', token),
        ]);
        if (cancelled) return;
        if (roomsRes.status === 401 || roomsRes.status === 503) {
          setAuthed(false);
          sessionStorage.removeItem(TOKEN_KEY);
          setAuthError('Session expired or token revoked — please re-enter it.');
          return;
        }
        const roomsData = await roomsRes.json();
        const configData = await configRes.json();
        if (!cancelled) {
          setRooms(roomsData.rooms);
          setConfig(configData);
        }
      } catch {
        // Transient network hiccup — the next poll retries, no need to drop the session.
      }
    };

    refresh();
    const interval = setInterval(refresh, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [authed, token]);

  const logout = () => {
    sessionStorage.removeItem(TOKEN_KEY);
    setToken('');
    setAuthed(false);
    setRooms([]);
    setConfig(null);
  };

  if (!authed) {
    return (
      <Container size="xs" style={{ paddingTop: '15vh' }}>
        <Paper withBorder shadow="sm" p="xl" radius="md">
          <Stack gap="md">
            <Title order={3}>Admin Portal</Title>
            <Text size="sm" c="dimmed">Enter the admin token to continue.</Text>
            {authError && <Alert color="red" title="Access denied">{authError}</Alert>}
            <PasswordInput
              placeholder="Admin token"
              value={tokenInput}
              onChange={(e) => setTokenInput(e.currentTarget.value)}
              onKeyDown={(e) => e.key === 'Enter' && tokenInput && tryAuth(tokenInput)}
              data-autofocus
            />
            <Button loading={authLoading} disabled={!tokenInput} onClick={() => tryAuth(tokenInput)}>
              Enter
            </Button>
          </Stack>
        </Paper>
      </Container>
    );
  }

  return (
    <Container size="lg" py="xl">
      <Group justify="space-between" mb="md">
        <Title order={2}>Admin Portal</Title>
        <ActionIcon variant="subtle" onClick={logout} title="Log out">
          <IconLogout size={18} />
        </ActionIcon>
      </Group>

      <Paper withBorder p="md" radius="md" mb="lg">
        <Title order={4} mb="sm">Active Rooms ({rooms.length})</Title>
        {rooms.length === 0 ? (
          <Text size="sm" c="dimmed">No rooms in memory right now.</Text>
        ) : (
          <Table striped highlightOnHover verticalSpacing="sm">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Room</Table.Th>
                <Table.Th>Status</Table.Th>
                <Table.Th>Round</Table.Th>
                <Table.Th>Players</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {rooms.map((room) => (
                <React.Fragment key={room.id}>
                  <Table.Tr>
                    <Table.Td><Code>{room.id.slice(0, 8)}</Code></Table.Td>
                    <Table.Td><Badge>{room.status}</Badge></Table.Td>
                    <Table.Td>{room.round}</Table.Td>
                    <Table.Td>{room.players.length} / {room.maxPlayers}</Table.Td>
                  </Table.Tr>
                  <Table.Tr>
                    <Table.Td colSpan={4} style={{ paddingTop: 0, borderTop: 'none' }}>
                      <Group gap="xs">
                        {room.players.map((p) => (
                          <Badge
                            key={p.id}
                            variant="light"
                            color={p.bankrupt ? 'red' : p.connected ? 'green' : 'yellow'}
                          >
                            {p.name}
                            {p.isHost ? ' (host)' : ''}
                            {p.bankrupt ? ' — bankrupt' : !p.connected ? ' — disconnected' : ''}
                          </Badge>
                        ))}
                      </Group>
                    </Table.Td>
                  </Table.Tr>
                </React.Fragment>
              ))}
            </Table.Tbody>
          </Table>
        )}
      </Paper>

      <Paper withBorder p="md" radius="md">
        <Title order={4} mb="sm">Game Config</Title>
        <Divider mb="sm" />
        <pre style={{ fontSize: '0.75rem', overflowX: 'auto', margin: 0 }}>
          {config ? JSON.stringify(config, null, 2) : 'Loading…'}
        </pre>
      </Paper>
    </Container>
  );
};

export default AdminPortal;
