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
  Progress,
  Select,
} from '@mantine/core';
import { IconLogout, IconTrash, IconPlus, IconMoodCry, IconMoodSad, IconMoodNeutral, IconMoodSmile, IconMoodHappy, IconRefresh } from '@tabler/icons-react';
import type {
  AdminRoomSnapshot,
  DecisionDefinition,
  GameConfig,
  FormulaInfo,
  FeedbackEntry,
  EventLogEntry,
  DecisionAnalyticsEntry,
  LawsuitAnalyticsEntry,
  PerformanceAnalyticsResponse,
} from '@suetheirasses/shared';

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
 * the decision library is a growing, admin-editable list plus a multi-section config object.
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
  const [feedback, setFeedback] = useState<FeedbackEntry[]>([]);

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
     
  }, []);

  // Poll rooms + feedback — both genuinely live data (rooms change as players play;
  // feedback keeps arriving from the two public forms), unlike config/decisions/
  // formulas, which are edit targets fetched once so a poll can never clobber an
  // admin's in-progress edit (see this component's own top-of-file doc comment).
  // A 401/503 mid-session (token revoked, ADMIN_TOKEN unset on the server) drops back
  // to the login form.
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

        const feedbackRes = await adminFetch('/api/admin/feedback', token);
        if (cancelled) return;
        if (feedbackRes.ok) {
          const feedbackData = await feedbackRes.json();
          if (!cancelled) setFeedback(feedbackData.feedback);
        }
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
    setFeedback([]);
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
            <Tabs.Tab value="feedback">Feedback ({feedback.length})</Tabs.Tab>
            <Tabs.Tab value="analytics">Analytics</Tabs.Tab>
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

          <Tabs.Panel value="feedback">
            <FeedbackTab feedback={feedback} />
          </Tabs.Panel>

          <Tabs.Panel value="analytics">
            <AnalyticsTab token={token} />
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
  const [draftText, setDraftText] = useState<string | undefined>(undefined);
  const [genOpen, setGenOpen] = useState(false);

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
        <NewDecisionForm
          token={token}
          initialText={draftText}
          onCancel={() => { setAdding(false); setDraftText(undefined); }}
          onCreated={() => { setAdding(false); setDraftText(undefined); onChanged(); }}
        />
      ) : (
        <Group gap="xs">
          <Button variant="outline" size="sm" leftSection={<IconPlus size={14} />} onClick={() => setAdding(true)}>
            Add Decision
          </Button>
          <Button variant="outline" size="sm" color="grape" onClick={() => setGenOpen((v) => !v)}>
            ✨ Generate with AI (experimental)
          </Button>
        </Group>
      )}

      {genOpen && !adding && (
        <AiGeneratePanel
          token={token}
          onClose={() => setGenOpen(false)}
          onGenerated={(text) => { setDraftText(text); setGenOpen(false); setAdding(true); }}
        />
      )}
    </Stack>
  );
}

// ============================================================
// EXPERIMENTAL — AI decision generation. Asks the local llama.cpp/Qwen3-1.7B server
// (see server/src/services/decisionGenService.ts) to invent a new decision + its legal
// risks, gated behind decisionDefinitionSchema + a second, semantic clamp pass
// (server/src/services/decisionGenGuardrails.ts) before ever reaching this component.
// Deliberately never auto-saves: a successful generation only pre-fills the same
// raw-JSON NewDecisionForm a hand-written decision goes through — the admin reviews/
// edits it and hits the same "Create" button either way. See CLAUDE.md.
// ============================================================

function AiGeneratePanel({
  token,
  onClose,
  onGenerated,
}: {
  token: string;
  onClose: () => void;
  onGenerated: (draftText: string) => void;
}) {
  const [theme, setTheme] = useState('');
  const [level, setLevel] = useState('');
  const [nature, setNature] = useState('');
  const [offensive, setOffensive] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);

  const generate = async () => {
    setGenerating(true);
    setError(null);
    setWarnings([]);
    try {
      const res = await adminFetch('/api/admin/decisions/generate', token, {
        method: 'POST',
        body: { theme: theme || undefined, level: level || undefined, nature: nature || undefined, offensive },
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(`${body.message || body.error || `Generation failed (${res.status})`}${body.raw ? ` — last raw output: ${body.raw.slice(0, 200)}` : ''}`);
        return;
      }
      setWarnings((body.warnings || []).map((w: { path: string; message: string }) => `${w.path}: ${w.message}`));
      onGenerated(JSON.stringify(body.decision, null, 2));
    } catch {
      setError('Could not reach the server (is the LLM container running?).');
    } finally {
      setGenerating(false);
    }
  };

  return (
    <Paper withBorder p="sm" radius="sm">
      <Stack gap="sm">
        <Text size="sm" fw={600}>✨ Generate a decision with AI (experimental)</Text>
        <Text size="xs" c="dimmed">
          Best-effort — the local Qwen3-1.7B model invents a candidate, which is schema-validated
          and clamped to bounded KPI/lawsuit ranges before landing in the editable draft below.
          It never saves on its own; review it like any hand-written decision before hitting Create.
        </Text>
        {error && <Alert color="red" title="Generation failed">{error}</Alert>}
        {warnings.length > 0 && (
          <Alert color="yellow" title={`${warnings.length} guardrail adjustment(s) applied`}>
            <Stack gap={2}>
              {warnings.map((w, i) => <Text key={i} size="xs">{w}</Text>)}
            </Stack>
          </Alert>
        )}
        <TextInput
          placeholder="Theme (optional) — e.g. 'a supply chain attack' or 'a green PR stunt'"
          value={theme}
          onChange={(e) => setTheme(e.currentTarget.value)}
        />
        <Group gap="sm">
          <select value={level} onChange={(e) => setLevel(e.currentTarget.value)}>
            <option value="">Any level</option>
            <option value="Strategic">Strategic</option>
            <option value="Operational">Operational</option>
            <option value="Financial">Financial</option>
          </select>
          <select value={nature} onChange={(e) => setNature(e.currentTarget.value)}>
            <option value="">Any nature</option>
            <option value="Traditional">Traditional</option>
            <option value="Grey Area">Grey Area</option>
            <option value="Dirty">Dirty</option>
          </select>
          <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: '0.875rem' }}>
            <input type="checkbox" checked={offensive} onChange={(e) => setOffensive(e.currentTarget.checked)} />
            Direct attack on a chosen opponent
          </label>
        </Group>
        <Group justify="flex-end">
          <Button size="xs" variant="subtle" onClick={onClose}>Cancel</Button>
          <Button size="xs" color="grape" loading={generating} onClick={generate}>Generate</Button>
        </Group>
      </Stack>
    </Paper>
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

function NewDecisionForm({
  token,
  initialText,
  onCancel,
  onCreated,
}: {
  token: string;
  /** Pre-fills the textarea, e.g. with an AI-generated draft from `AiGeneratePanel` — still
   * has to pass through the same Create button/validation as a hand-written decision. */
  initialText?: string;
  onCancel: () => void;
  onCreated: () => void;
}) {
  const blank = {
    decision: 'New Decision Name',
    level: 'Operational',
    description: '',
    nature: 'Traditional',
    offensiveAction: false,
    excludes: [],
    impacts: {},
  };
  const [text, setText] = useState(initialText ?? JSON.stringify(blank, null, 2));
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
// Formulas editor — the 23 pure, scalar, named-input math formulas (competitiveness,
// P&L, risk gauge, etc.)
// (see CLAUDE.md's "Decisions/config are DB-backed, not static JSON" for the
// formula-vs-procedural split). Fixed key set — no create/delete, only
// expression/description are ever written. Single-line text inputs, not JSON
// textareas — every formula here is one arithmetic expression, not a nested
// object. The server validates syntax (a real parser) and a per-key variable
// whitelist before anything is saved; a rejection surfaces inline below.
// ============================================================

// ============================================================
// Feedback — read-only. Collected anonymously via the public POST /api/feedback (the
// landing page's inline "Feedback" button, and the game-over screen's floating one —
// see FeedbackForm.tsx) and never written from here; there's nothing to edit, only to
// review. Polled alongside rooms (see this component's own polling effect) since new
// rows can arrive at any time.
// ============================================================
const MOOD_ICON_BY_RATING: Record<number, React.ComponentType<{ size?: number }>> = {
  1: IconMoodCry,
  2: IconMoodSad,
  3: IconMoodNeutral,
  4: IconMoodSmile,
  5: IconMoodHappy,
};

function FeedbackTab({ feedback }: { feedback: FeedbackEntry[] }) {
  if (feedback.length === 0) {
    return <Text size="sm" c="dimmed">No feedback submitted yet.</Text>;
  }

  return (
    <Table striped highlightOnHover verticalSpacing="sm">
      <Table.Thead>
        <Table.Tr>
          <Table.Th>When</Table.Th>
          <Table.Th>Rating</Table.Th>
          <Table.Th>Source</Table.Th>
          <Table.Th>Message</Table.Th>
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody>
        {feedback.map((entry) => {
          const MoodIcon = MOOD_ICON_BY_RATING[entry.rating];
          return (
            <Table.Tr key={entry.id}>
              <Table.Td style={{ whiteSpace: 'nowrap' }}>{new Date(entry.createdAt).toLocaleString()}</Table.Td>
              <Table.Td>
                <Group gap={4} wrap="nowrap">
                  {MoodIcon && <MoodIcon size={18} />}
                  <Text size="sm">{entry.rating} / 5</Text>
                </Group>
              </Table.Td>
              <Table.Td><Badge variant="light">{entry.source === 'gameover' ? 'Game Over' : 'Landing'}</Badge></Table.Td>
              <Table.Td>{entry.message || <Text size="sm" c="dimmed" fs="italic">(no message)</Text>}</Table.Td>
            </Table.Tr>
          );
        })}
      </Table.Tbody>
    </Table>
  );
}

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

// ============================================================
// Analytics — the EventLog-backed admin tab for game analysis/balance/bug-tracing (see
// CLAUDE.md's EventLog section and server/src/services/eventLogService.ts). Four
// sub-views, each fetching from its own endpoint independently rather than being routed
// through the parent's `loadEditableData`/room-polling effects — none of these are edit
// targets (nothing here is ever written back), so there's no clobber risk to guard
// against, just a cost-of-polling tradeoff. The raw Event Feed is genuinely live data
// (new rows arrive continuously while games are in progress), so it polls the same way
// Feedback/Rooms do; the three aggregate dashboards run real multi-thousand-row scans
// server-side (see index.ts's analytics routes), so they're fetched once on mount plus a
// manual Refresh button, not continuously polled.
// ============================================================

function winRateColor(rate: number | null): string {
  if (rate === null) return 'gray';
  if (rate >= 0.55) return 'green';
  if (rate >= 0.35) return 'yellow';
  return 'red';
}

const EVENT_FEED_POLL_INTERVAL_MS = 5000;
const EVENT_TYPE_OPTIONS = [
  'turn.resolved',
  'decision.deployed',
  'decision.rejected',
  'player.eliminated',
  'player.disconnected',
  'player.reconnected',
  'player.kicked',
  'room.stale_cleanup',
  'game.completed',
  'llm.call',
  'error.persistence',
];

function AnalyticsTab({ token }: { token: string }) {
  const [subTab, setSubTab] = useState<string | null>('feed');

  const [events, setEvents] = useState<EventLogEntry[]>([]);
  const [eventTypeFilter, setEventTypeFilter] = useState<string | null>(null);
  const [severityFilter, setSeverityFilter] = useState<string | null>(null);
  const [roomIdFilter, setRoomIdFilter] = useState('');

  const [decisions, setDecisions] = useState<DecisionAnalyticsEntry[] | null>(null);
  const [gamesConsidered, setGamesConsidered] = useState(0);
  const [decisionsLoading, setDecisionsLoading] = useState(false);

  const [lawsuits, setLawsuits] = useState<LawsuitAnalyticsEntry[] | null>(null);
  const [lawsuitsLoading, setLawsuitsLoading] = useState(false);

  const [performance, setPerformance] = useState<PerformanceAnalyticsResponse | null>(null);
  const [performanceLoading, setPerformanceLoading] = useState(false);

  const loadEvents = useCallback(async () => {
    const params = new URLSearchParams({ limit: '100' });
    if (eventTypeFilter) params.set('eventType', eventTypeFilter);
    if (severityFilter) params.set('severity', severityFilter);
    if (roomIdFilter.trim()) params.set('roomId', roomIdFilter.trim());
    const res = await adminFetch(`/api/admin/events?${params.toString()}`, token);
    if (res.ok) setEvents((await res.json()).events);
  }, [token, eventTypeFilter, severityFilter, roomIdFilter]);

  // Only the raw feed polls — see this section's own doc comment for why the three
  // aggregate dashboards below don't.
  useEffect(() => {
    if (subTab !== 'feed') return;
    loadEvents();
    const interval = setInterval(loadEvents, EVENT_FEED_POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [subTab, loadEvents]);

  const loadDecisions = useCallback(async () => {
    setDecisionsLoading(true);
    try {
      const res = await adminFetch('/api/admin/analytics/decisions', token);
      if (res.ok) {
        const body = await res.json();
        setDecisions(body.decisions);
        setGamesConsidered(body.gamesConsidered);
      }
    } finally {
      setDecisionsLoading(false);
    }
  }, [token]);

  const loadLawsuits = useCallback(async () => {
    setLawsuitsLoading(true);
    try {
      const res = await adminFetch('/api/admin/analytics/lawsuits', token);
      if (res.ok) setLawsuits((await res.json()).grounds);
    } finally {
      setLawsuitsLoading(false);
    }
  }, [token]);

  const loadPerformance = useCallback(async () => {
    setPerformanceLoading(true);
    try {
      const res = await adminFetch('/api/admin/analytics/performance', token);
      if (res.ok) setPerformance(await res.json());
    } finally {
      setPerformanceLoading(false);
    }
  }, [token]);

  // Fire all three once on mount, regardless of which sub-tab starts active, so
  // switching between Decision Balance / Lawsuits / Performance never shows a cold
  // "Loading…" the first time — only Refresh re-runs them after that.
  useEffect(() => {
    loadDecisions();
    loadLawsuits();
    loadPerformance();
  }, [loadDecisions, loadLawsuits, loadPerformance]);

  return (
    <Tabs value={subTab} onChange={setSubTab} orientation="vertical">
      <Tabs.List mb="md">
        <Tabs.Tab value="feed">Event Feed</Tabs.Tab>
        <Tabs.Tab value="decisions">Decision Balance</Tabs.Tab>
        <Tabs.Tab value="lawsuits">Lawsuit Win Rates</Tabs.Tab>
        <Tabs.Tab value="performance">Performance & Errors</Tabs.Tab>
      </Tabs.List>

      <Tabs.Panel value="feed" pl="md">
        <EventFeedView
          events={events}
          eventTypeFilter={eventTypeFilter}
          setEventTypeFilter={setEventTypeFilter}
          severityFilter={severityFilter}
          setSeverityFilter={setSeverityFilter}
          roomIdFilter={roomIdFilter}
          setRoomIdFilter={setRoomIdFilter}
          onRefresh={loadEvents}
        />
      </Tabs.Panel>

      <Tabs.Panel value="decisions" pl="md">
        <DecisionBalanceView
          decisions={decisions}
          gamesConsidered={gamesConsidered}
          loading={decisionsLoading}
          onRefresh={loadDecisions}
        />
      </Tabs.Panel>

      <Tabs.Panel value="lawsuits" pl="md">
        <LawsuitWinRatesView grounds={lawsuits} loading={lawsuitsLoading} onRefresh={loadLawsuits} />
      </Tabs.Panel>

      <Tabs.Panel value="performance" pl="md">
        <PerformanceView data={performance} loading={performanceLoading} onRefresh={loadPerformance} />
      </Tabs.Panel>
    </Tabs>
  );
}

function EventFeedView({
  events,
  eventTypeFilter,
  setEventTypeFilter,
  severityFilter,
  setSeverityFilter,
  roomIdFilter,
  setRoomIdFilter,
  onRefresh,
}: {
  events: EventLogEntry[];
  eventTypeFilter: string | null;
  setEventTypeFilter: (v: string | null) => void;
  severityFilter: string | null;
  setSeverityFilter: (v: string | null) => void;
  roomIdFilter: string;
  setRoomIdFilter: (v: string) => void;
  onRefresh: () => void;
}) {
  return (
    <Stack gap="sm">
      <Group gap="sm">
        <Select
          placeholder="Event type"
          data={EVENT_TYPE_OPTIONS}
          value={eventTypeFilter}
          onChange={setEventTypeFilter}
          clearable
          size="xs"
          w={200}
        />
        <Select
          placeholder="Severity"
          data={['info', 'warning', 'error']}
          value={severityFilter}
          onChange={setSeverityFilter}
          clearable
          size="xs"
          w={140}
        />
        <TextInput
          placeholder="Room id"
          value={roomIdFilter}
          onChange={(e) => setRoomIdFilter(e.currentTarget.value)}
          size="xs"
          w={160}
        />
        <ActionIcon variant="light" onClick={onRefresh} title="Refresh now">
          <IconRefresh size={16} />
        </ActionIcon>
      </Group>

      {events.length === 0 ? (
        <Text size="sm" c="dimmed">No events match this filter yet.</Text>
      ) : (
        <Table striped highlightOnHover verticalSpacing="xs" fz="xs">
          <Table.Thead>
            <Table.Tr>
              <Table.Th>When</Table.Th>
              <Table.Th>Type</Table.Th>
              <Table.Th>Severity</Table.Th>
              <Table.Th>Room</Table.Th>
              <Table.Th>Player</Table.Th>
              <Table.Th>Payload</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {events.map((e) => (
              <Table.Tr key={e.id}>
                <Table.Td style={{ whiteSpace: 'nowrap' }}>{new Date(e.createdAt).toLocaleTimeString()}</Table.Td>
                <Table.Td><Code>{e.eventType}</Code></Table.Td>
                <Table.Td>
                  <Badge size="xs" color={e.severity === 'error' ? 'red' : e.severity === 'warning' ? 'yellow' : 'gray'}>
                    {e.severity}
                  </Badge>
                </Table.Td>
                <Table.Td>{e.roomId ? <Code>{e.roomId.slice(0, 8)}</Code> : '—'}</Table.Td>
                <Table.Td>{e.playerId ? <Code>{e.playerId.slice(0, 8)}</Code> : '—'}</Table.Td>
                <Table.Td style={{ maxWidth: 420, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {JSON.stringify(e.payload)}
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}
    </Stack>
  );
}

function DecisionBalanceView({
  decisions,
  gamesConsidered,
  loading,
  onRefresh,
}: {
  decisions: DecisionAnalyticsEntry[] | null;
  gamesConsidered: number;
  loading: boolean;
  onRefresh: () => void;
}) {
  if (!decisions) return <Text size="sm" c="dimmed">Loading…</Text>;

  return (
    <Stack gap="sm">
      <Group justify="space-between">
        <Text size="xs" c="dimmed">
          Win rate is drawn from {gamesConsidered} completed game{gamesConsidered === 1 ? '' : 's'} — a decision with no
          bar yet was never deployed in a room whose game has since finished.
        </Text>
        <ActionIcon variant="light" loading={loading} onClick={onRefresh} title="Refresh"><IconRefresh size={16} /></ActionIcon>
      </Group>
      {decisions.length === 0 ? (
        <Text size="sm" c="dimmed">No decisions logged yet — play a game to populate this.</Text>
      ) : (
        <Table striped highlightOnHover verticalSpacing="xs" fz="xs">
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Decision</Table.Th>
              <Table.Th>Deployed</Table.Th>
              <Table.Th>Rejected</Table.Th>
              <Table.Th>Top rejection reason</Table.Th>
              <Table.Th>Win rate (eventual winner vs. loser)</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {decisions.map((d) => (
              <Table.Tr key={d.decisionName}>
                <Table.Td>{d.decisionName}</Table.Td>
                <Table.Td>{d.deployCount}</Table.Td>
                <Table.Td>{d.rejectCount}</Table.Td>
                <Table.Td>
                  {d.topRejectReasons[0]
                    ? <Text size="xs" c="dimmed">{d.topRejectReasons[0].reason} ({d.topRejectReasons[0].count})</Text>
                    : '—'}
                </Table.Td>
                <Table.Td style={{ minWidth: 180 }}>
                  {d.winRate === null ? (
                    <Text size="xs" c="dimmed">n/a</Text>
                  ) : (
                    <Group gap={6} wrap="nowrap">
                      <Progress value={d.winRate * 100} color={winRateColor(d.winRate)} size="sm" w={100} />
                      <Text size="xs">{Math.round(d.winRate * 100)}% ({d.winCount}/{d.winCount + d.lossCount})</Text>
                    </Group>
                  )}
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}
    </Stack>
  );
}

function LawsuitWinRatesView({
  grounds,
  loading,
  onRefresh,
}: {
  grounds: LawsuitAnalyticsEntry[] | null;
  loading: boolean;
  onRefresh: () => void;
}) {
  if (!grounds) return <Text size="sm" c="dimmed">Loading…</Text>;

  return (
    <Stack gap="sm">
      <Group justify="flex-end">
        <ActionIcon variant="light" loading={loading} onClick={onRefresh} title="Refresh"><IconRefresh size={16} /></ActionIcon>
      </Group>
      {grounds.length === 0 ? (
        <Text size="sm" c="dimmed">No lawsuits filed yet.</Text>
      ) : (
        <Table striped highlightOnHover verticalSpacing="xs" fz="xs">
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Decision</Table.Th>
              <Table.Th>Ground</Table.Th>
              <Table.Th>Filed</Table.Th>
              <Table.Th>Resolved</Table.Th>
              <Table.Th>Plaintiff win rate</Table.Th>
              <Table.Th>Avg stakes</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {grounds.map((g) => (
              <Table.Tr key={`${g.decisionName}::${g.groundName}`}>
                <Table.Td>{g.decisionName}</Table.Td>
                <Table.Td style={{ maxWidth: 320 }}>{g.groundName}</Table.Td>
                <Table.Td>{g.filedCount}</Table.Td>
                <Table.Td>{g.resolvedCount}</Table.Td>
                <Table.Td style={{ minWidth: 180 }}>
                  {g.winRate === null ? (
                    <Text size="xs" c="dimmed">n/a</Text>
                  ) : (
                    <Group gap={6} wrap="nowrap">
                      <Progress value={g.winRate * 100} color={winRateColor(g.winRate)} size="sm" w={100} />
                      <Text size="xs">{Math.round(g.winRate * 100)}% ({g.wonCount}/{g.resolvedCount})</Text>
                    </Group>
                  )}
                </Table.Td>
                <Table.Td>{g.avgStakes !== null ? `$${Math.round(g.avgStakes).toLocaleString()}` : '—'}</Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}
    </Stack>
  );
}

function PerformanceView({
  data,
  loading,
  onRefresh,
}: {
  data: PerformanceAnalyticsResponse | null;
  loading: boolean;
  onRefresh: () => void;
}) {
  if (!data) return <Text size="sm" c="dimmed">Loading…</Text>;

  return (
    <Stack gap="lg">
      <Group justify="flex-end">
        <ActionIcon variant="light" loading={loading} onClick={onRefresh} title="Refresh"><IconRefresh size={16} /></ActionIcon>
      </Group>

      <div>
        <Text size="sm" fw={600} mb={4}>Turn resolution ({data.turns.count} logged)</Text>
        {data.turns.count === 0 ? (
          <Text size="xs" c="dimmed">No turns logged yet.</Text>
        ) : (
          <Group gap="xl">
            <Text size="xs">Avg engine compute: <b>{data.turns.avgComputeMs}ms</b></Text>
            <Text size="xs">Avg total (incl. persistence): <b>{data.turns.avgTotalMs}ms</b></Text>
            <Text size="xs">Slowest total: <b>{data.turns.maxTotalMs}ms</b></Text>
          </Group>
        )}
      </div>

      <div>
        <Text size="sm" fw={600} mb={4}>Local LLM calls</Text>
        {data.llm.length === 0 ? (
          <Text size="xs" c="dimmed">No LLM calls logged yet.</Text>
        ) : (
          <Table verticalSpacing="xs" fz="xs" w={480}>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Kind</Table.Th>
                <Table.Th>Calls</Table.Th>
                <Table.Th>Avg latency</Table.Th>
                <Table.Th>Success rate</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {data.llm.map((l) => (
                <Table.Tr key={l.kind}>
                  <Table.Td>{l.kind}</Table.Td>
                  <Table.Td>{l.count}</Table.Td>
                  <Table.Td>{l.avgLatencyMs}ms</Table.Td>
                  <Table.Td>
                    <Badge size="xs" color={l.successRate >= 0.9 ? 'green' : l.successRate >= 0.6 ? 'yellow' : 'red'}>
                      {Math.round(l.successRate * 100)}%
                    </Badge>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        )}
      </div>

      <div>
        <Text size="sm" fw={600} mb={4}>Recent errors, by context</Text>
        {data.errorCounts.length === 0 ? (
          <Text size="xs" c="dimmed">No errors logged — good sign.</Text>
        ) : (
          <Stack gap={4}>
            {data.errorCounts.map((e) => (
              <Group key={e.context} gap="xs">
                <Badge size="xs" color="red">{e.count}</Badge>
                <Text size="xs">{e.context}</Text>
              </Group>
            ))}
          </Stack>
        )}
      </div>
    </Stack>
  );
}

export default AdminPortal;
