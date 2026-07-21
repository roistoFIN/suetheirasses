import React, { useState, useEffect, useCallback } from 'react';
import {
  Container,
  Paper,
  Title,
  Text,
  PasswordInput,
  TextInput,
  Button,
  Stack,
  Table,
  Badge,
  Group,
  Alert,
  ActionIcon,
  Code,
  Textarea,
  Tabs,
} from '@mantine/core';
import { IconLogout, IconTrash, IconPlus } from '@tabler/icons-react';
import type { AdminRoomSnapshot, DecisionDefinition, GameConfig, FormulaInfo } from '@suetheirasses/shared';

/**
 * Admin Portal — a real, independent URL (`/admin`), not driven by game phase state
 * at all (see `App.tsx`'s `isAdminRoute` exemptions). Gated by a single shared-secret
 * token (`ADMIN_TOKEN` on the server, see `middleware/adminAuth.ts`) — there's no
 * broader auth system in this app, so this is deliberately minimal.
 *
 * Room monitoring polls every 5s (genuinely live data). The decision library and
 * game config are edit targets, not just observed data, so they're fetched once on
 * auth (and re-fetched after a successful save) rather than polled — polling them
 * would risk silently overwriting an admin's in-progress edit out from under them.
 * Editing is raw-JSON-textarea + server-side Zod validation, not a structured form —
 * proportionate given DecisionDefinition.impacts is an open-ended nested record and
 * there are 45 decisions plus a multi-section config object.
 */
const SERVER_URL = import.meta.env.VITE_SERVER_URL || 'http://localhost:3001';
const TOKEN_KEY = 'stita_admin_token';
const ROOMS_POLL_INTERVAL_MS = 5000;

async function adminFetch(
  path: string,
  token: string,
  options?: { method?: string; body?: unknown },
): Promise<Response> {
  return fetch(`${SERVER_URL}${path}`, {
    method: options?.method ?? 'GET',
    headers: { 'x-admin-token': token, 'Content-Type': 'application/json' },
    body: options?.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
}

const AdminPortal: React.FC = () => {
  const [token, setToken] = useState<string>(() => sessionStorage.getItem(TOKEN_KEY) || '');
  const [tokenInput, setTokenInput] = useState('');
  const [authed, setAuthed] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [authLoading, setAuthLoading] = useState(false);
  const [rooms, setRooms] = useState<AdminRoomSnapshot[]>([]);
  const [config, setConfig] = useState<GameConfig | null>(null);
  const [decisions, setDecisions] = useState<DecisionDefinition[]>([]);
  const [formulas, setFormulas] = useState<FormulaInfo[]>([]);

  const loadEditableData = useCallback(async (authToken: string) => {
    const [configRes, decisionsRes, formulasRes] = await Promise.all([
      adminFetch('/api/admin/config', authToken),
      adminFetch('/api/admin/decisions', authToken),
      adminFetch('/api/admin/formulas', authToken),
    ]);
    if (configRes.ok) setConfig(await configRes.json());
    if (decisionsRes.ok) setDecisions((await decisionsRes.json()).decisions);
    if (formulasRes.ok) setFormulas((await formulasRes.json()).formulas);
  }, []);

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
      await loadEditableData(candidate);
    } catch {
      setAuthError('Could not reach the server');
      setAuthed(false);
    } finally {
      setAuthLoading(false);
    }
  }, [loadEditableData]);

  // Try any saved token once on mount, so a refresh doesn't require re-entering it.
  useEffect(() => {
    if (token) tryAuth(token);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Poll rooms only — genuinely live data. A 401/503 mid-session (token revoked,
  // ADMIN_TOKEN unset on the server) drops back to the login form.
  useEffect(() => {
    if (!authed) return;
    let cancelled = false;

    const refresh = async () => {
      try {
        const roomsRes = await adminFetch('/api/admin/rooms', token);
        if (cancelled) return;
        if (roomsRes.status === 401 || roomsRes.status === 503) {
          setAuthed(false);
          sessionStorage.removeItem(TOKEN_KEY);
          setAuthError('Session expired or token revoked — please re-enter it.');
          return;
        }
        const roomsData = await roomsRes.json();
        if (!cancelled) setRooms(roomsData.rooms);
      } catch {
        // Transient network hiccup — the next poll retries, no need to drop the session.
      }
    };

    refresh();
    const interval = setInterval(refresh, ROOMS_POLL_INTERVAL_MS);
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
    setDecisions([]);
    setFormulas([]);
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
        <Tabs defaultValue="config">
          <Tabs.List mb="md">
            <Tabs.Tab value="config">Game Config</Tabs.Tab>
            <Tabs.Tab value="decisions">Decisions ({decisions.length})</Tabs.Tab>
            <Tabs.Tab value="formulas">Formulas ({formulas.length})</Tabs.Tab>
          </Tabs.List>

          <Tabs.Panel value="config">
            <GameConfigEditor
              config={config}
              token={token}
              onSaved={() => loadEditableData(token)}
            />
          </Tabs.Panel>

          <Tabs.Panel value="decisions">
            <DecisionsEditor
              decisions={decisions}
              token={token}
              onChanged={() => loadEditableData(token)}
            />
          </Tabs.Panel>

          <Tabs.Panel value="formulas">
            <FormulasEditor
              formulas={formulas}
              token={token}
              onChanged={() => loadEditableData(token)}
            />
          </Tabs.Panel>
        </Tabs>
      </Paper>
    </Container>
  );
};

// ============================================================
// Game Config editor
// ============================================================

function GameConfigEditor({ config, token, onSaved }: { config: GameConfig | null; token: string; onSaved: () => void }) {
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Seed the textarea once per successful load — deliberately not re-synced on
  // every render, so an in-progress edit never gets silently clobbered.
  useEffect(() => {
    if (config) setText(JSON.stringify(config, null, 2));
  }, [config]);

  const save = async () => {
    setError(null);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      setError('Not valid JSON — check for a trailing comma or unmatched bracket.');
      return;
    }
    setSaving(true);
    try {
      const res = await adminFetch('/api/admin/config', token, { method: 'PUT', body: parsed });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.message || body.error || `Save failed (${res.status})`);
        return;
      }
      onSaved();
    } catch {
      setError('Could not reach the server.');
    } finally {
      setSaving(false);
    }
  };

  if (!config) return <Text size="sm" c="dimmed">Loading…</Text>;

  return (
    <Stack gap="sm">
      {error && <Alert color="red" title="Save failed">{error}</Alert>}
      <Textarea
        value={text}
        onChange={(e) => setText(e.currentTarget.value)}
        autosize
        minRows={16}
        maxRows={32}
        styles={{ input: { fontFamily: 'monospace', fontSize: '0.75rem' } }}
      />
      <Group justify="flex-end">
        <Button size="sm" loading={saving} onClick={save}>Save Config</Button>
      </Group>
    </Stack>
  );
}

// ============================================================
// Decisions editor
// ============================================================

function DecisionsEditor({
  decisions,
  token,
  onChanged,
}: {
  decisions: DecisionDefinition[];
  token: string;
  onChanged: () => void;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  return (
    <Stack gap="xs">
      {decisions.map((d) => (
        <DecisionRow
          key={d.decision}
          decision={d}
          expanded={expanded === d.decision}
          onToggle={() => setExpanded(expanded === d.decision ? null : d.decision)}
          token={token}
          onChanged={onChanged}
        />
      ))}

      {adding ? (
        <NewDecisionForm token={token} onCancel={() => setAdding(false)} onCreated={() => { setAdding(false); onChanged(); }} />
      ) : (
        <Button variant="outline" size="sm" leftSection={<IconPlus size={14} />} onClick={() => setAdding(true)}>
          Add Decision
        </Button>
      )}
    </Stack>
  );
}

function DecisionRow({
  decision,
  expanded,
  onToggle,
  token,
  onChanged,
}: {
  decision: DecisionDefinition;
  expanded: boolean;
  onToggle: () => void;
  token: string;
  onChanged: () => void;
}) {
  const [text, setText] = useState(JSON.stringify(decision, null, 2));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  useEffect(() => {
    if (!expanded) return;
    setText(JSON.stringify(decision, null, 2));
    setError(null);
    setConfirmingDelete(false);
  }, [expanded, decision]);

  const save = async () => {
    setError(null);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      setError('Not valid JSON — check for a trailing comma or unmatched bracket.');
      return;
    }
    setSaving(true);
    try {
      const res = await adminFetch(`/api/admin/decisions/${encodeURIComponent(decision.decision)}`, token, {
        method: 'PUT',
        body: parsed,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.message || body.error || `Save failed (${res.status})`);
        return;
      }
      onChanged();
    } catch {
      setError('Could not reach the server.');
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    setDeleting(true);
    setError(null);
    try {
      const res = await adminFetch(`/api/admin/decisions/${encodeURIComponent(decision.decision)}`, token, {
        method: 'DELETE',
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error || `Delete failed (${res.status})`);
        setConfirmingDelete(false);
        return;
      }
      onChanged();
    } catch {
      setError('Could not reach the server.');
    } finally {
      setDeleting(false);
    }
  };

  return (
    <Paper withBorder p="sm" radius="sm">
      <Group justify="space-between" onClick={onToggle} style={{ cursor: 'pointer' }}>
        <Group gap="xs">
          <Text size="sm" fw={600}>{decision.decision}</Text>
          <Badge size="xs" variant="light">{decision.level}</Badge>
          <Badge size="xs" variant="light" color={decision.nature === 'Dirty' ? 'red' : decision.nature === 'Grey Area' ? 'yellow' : 'gray'}>
            {decision.nature}
          </Badge>
        </Group>
      </Group>

      {expanded && (
        <Stack gap="sm" mt="sm">
          {error && <Alert color="red" title="Error">{error}</Alert>}
          <Textarea
            value={text}
            onChange={(e) => setText(e.currentTarget.value)}
            autosize
            minRows={10}
            maxRows={28}
            styles={{ input: { fontFamily: 'monospace', fontSize: '0.75rem' } }}
          />
          <Group justify="space-between">
            {confirmingDelete ? (
              <Group gap="xs">
                <Text size="xs" c="red">Delete permanently?</Text>
                <Button size="xs" color="red" loading={deleting} onClick={remove}>Confirm Delete</Button>
                <Button size="xs" variant="subtle" onClick={() => setConfirmingDelete(false)}>Cancel</Button>
              </Group>
            ) : (
              <Button size="xs" color="red" variant="outline" leftSection={<IconTrash size={12} />} onClick={() => setConfirmingDelete(true)}>
                Delete
              </Button>
            )}
            <Button size="xs" loading={saving} onClick={save}>Save</Button>
          </Group>
        </Stack>
      )}
    </Paper>
  );
}

function NewDecisionForm({ token, onCancel, onCreated }: { token: string; onCancel: () => void; onCreated: () => void }) {
  const blank = {
    decision: 'New Decision Name',
    level: 'Operational',
    description: '',
    nature: 'Traditional',
    offensiveAction: false,
    excludes: [],
    impacts: {},
  };
  const [text, setText] = useState(JSON.stringify(blank, null, 2));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const create = async () => {
    setError(null);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      setError('Not valid JSON — check for a trailing comma or unmatched bracket.');
      return;
    }
    setSaving(true);
    try {
      const res = await adminFetch('/api/admin/decisions', token, { method: 'POST', body: parsed });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.message || body.error || `Create failed (${res.status})`);
        return;
      }
      onCreated();
    } catch {
      setError('Could not reach the server.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Paper withBorder p="sm" radius="sm">
      <Stack gap="sm">
        <Text size="sm" fw={600}>New Decision</Text>
        {error && <Alert color="red" title="Error">{error}</Alert>}
        <Textarea
          value={text}
          onChange={(e) => setText(e.currentTarget.value)}
          autosize
          minRows={10}
          maxRows={28}
          styles={{ input: { fontFamily: 'monospace', fontSize: '0.75rem' } }}
        />
        <Group justify="flex-end">
          <Button size="xs" variant="subtle" onClick={onCancel}>Cancel</Button>
          <Button size="xs" loading={saving} onClick={create}>Create</Button>
        </Group>
      </Stack>
    </Paper>
  );
}

// ============================================================
// Formulas editor — the pure, scalar, named-input math from FORMULAS.md §2-§7
// (see CLAUDE.md's "Decisions/config are DB-backed, not static JSON" for the
// formula-vs-procedural split). Fixed key set — no create/delete, only
// expression/description are ever written. Single-line text inputs, not JSON
// textareas — every formula here is one arithmetic expression, not a nested
// object. The server validates syntax (a real parser) and a per-key variable
// whitelist before anything is saved; a rejection surfaces inline below.
// ============================================================

function FormulasEditor({
  formulas,
  token,
  onChanged,
}: {
  formulas: FormulaInfo[];
  token: string;
  onChanged: () => void;
}) {
  return (
    <Stack gap="xs">
      {formulas.map((f) => (
        <FormulaRow key={f.key} formula={f} token={token} onChanged={onChanged} />
      ))}
    </Stack>
  );
}

function FormulaRow({
  formula,
  token,
  onChanged,
}: {
  formula: FormulaInfo;
  token: string;
  onChanged: () => void;
}) {
  const [expression, setExpression] = useState(formula.expression);
  const [description, setDescription] = useState(formula.description);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setError(null);
    setSaving(true);
    try {
      const res = await adminFetch(`/api/admin/formulas/${encodeURIComponent(formula.key)}`, token, {
        method: 'PUT',
        body: { expression, description },
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.message || body.error || `Save failed (${res.status})`);
        return;
      }
      onChanged();
    } catch {
      setError('Could not reach the server.');
    } finally {
      setSaving(false);
    }
  };

  const dirty = expression !== formula.expression || description !== formula.description;

  return (
    <Paper withBorder p="sm" radius="sm">
      <Stack gap={6}>
        <Text size="sm" fw={600}>{formula.key}</Text>
        {error && <Alert color="red" title="Save failed">{error}</Alert>}
        <TextInput
          value={expression}
          onChange={(e) => setExpression(e.currentTarget.value)}
          styles={{ input: { fontFamily: 'monospace', fontSize: '0.8rem' } }}
        />
        <Textarea
          value={description}
          onChange={(e) => setDescription(e.currentTarget.value)}
          autosize
          minRows={1}
          maxRows={4}
          styles={{ input: { fontSize: '0.75rem' } }}
        />
        <Group justify="flex-end">
          <Button size="xs" loading={saving} disabled={!dirty} onClick={save}>Save</Button>
        </Group>
      </Stack>
    </Paper>
  );
}

export default AdminPortal;
