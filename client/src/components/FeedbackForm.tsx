import React, { useState } from 'react';
import { Stack, Text, Textarea, Button, ActionIcon, Group, Alert } from '@mantine/core';
import { IconMoodCry, IconMoodSad, IconMoodNeutral, IconMoodSmile, IconMoodHappy, IconCheck, IconAlertCircle } from '@tabler/icons-react';
import type { FeedbackSource } from '@suetheirasses/shared';

const SERVER_URL = import.meta.env.VITE_SERVER_URL || 'http://localhost:3001';

/** 1-5 Likert scale, rendered as mood-icon faces rather than a raw number picker.
 * Colors are a small local ramp within this app's "Courtroom Ink" muted palette
 * (red → amber → green, the same family GamePhase.tsx's semColors semaphore uses) —
 * kept local rather than added to theme.css since nothing else needs a 5-point ramp. */
const MOOD_RATINGS: { value: number; Icon: React.ComponentType<{ size?: number }>; label: string; color: string }[] = [
  { value: 1, Icon: IconMoodCry, label: 'Very Unhappy', color: '#9c2b22' },
  { value: 2, Icon: IconMoodSad, label: 'Unhappy', color: '#b5562c' },
  { value: 3, Icon: IconMoodNeutral, label: 'Neutral', color: '#c68a2e' },
  { value: 4, Icon: IconMoodSmile, label: 'Happy', color: '#7a8f3f' },
  { value: 5, Icon: IconMoodHappy, label: 'Very Happy', color: '#4c5f3f' },
];

interface FeedbackFormProps {
  /** Which of the two feedback entry points this is — sent to the server purely for
   * admin-side triage (see FeedbackEntry's doc comment); never anything identifying
   * the player. */
  source: FeedbackSource;
  onClose: () => void;
}

/**
 * Shared 1-5 Likert (mood-face) + optional free-text feedback form — the same inner
 * view embedded in two different shells: an inline Modal on the landing page
 * (Matchmaking.tsx) and a floating widget on the game-over/replay screen
 * (FeedbackWidget.tsx). Deliberately fully anonymous — no player/room id is ever read
 * or sent (see the server's `Feedback` Prisma model doc comment) — so this component
 * needs nothing from gameStore/socketStore, just a plain `POST /api/feedback`.
 */
const FeedbackForm: React.FC<FeedbackFormProps> = ({ source, onClose }) => {
  const [rating, setRating] = useState<number | null>(null);
  const [message, setMessage] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async () => {
    if (!rating || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`${SERVER_URL}/api/feedback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rating, message: message.trim() || undefined, source }),
      });
      if (!res.ok) throw new Error(`Request failed (${res.status})`);
      setSubmitted(true);
    } catch {
      setError('Could not send feedback right now — please try again in a moment.');
    } finally {
      setSubmitting(false);
    }
  };

  if (submitted) {
    return (
      <Stack gap="md" align="center" py="md">
        <ActionIcon size={48} radius="xl" variant="filled" style={{ background: '#4c5f3f', pointerEvents: 'none' }}>
          <IconCheck size={26} />
        </ActionIcon>
        <Text ta="center" fw={700} style={{ color: 'var(--ink-text)' }}>Thanks for your feedback!</Text>
        <Button variant="outline" color="dark" onClick={onClose}>Close</Button>
      </Stack>
    );
  }

  return (
    <Stack gap="md">
      <Text size="sm" style={{ color: 'var(--ink-text)' }}>How's your experience been?</Text>
      <Group justify="center" gap="xs">
        {MOOD_RATINGS.map(({ value, Icon, label, color }) => (
          <ActionIcon
            key={value}
            size={44}
            radius="xl"
            onClick={() => setRating(value)}
            aria-label={label}
            aria-pressed={rating === value}
            title={label}
            style={{
              background: rating === value ? color : 'transparent',
              color: rating === value ? '#f4e9d0' : color,
              border: `2px solid ${color}`,
              transition: 'background 0.1s ease',
            }}
          >
            <Icon size={26} />
          </ActionIcon>
        ))}
      </Group>
      <Textarea
        placeholder="Anything you'd like to tell us? (optional)"
        value={message}
        onChange={(e) => setMessage(e.currentTarget.value)}
        maxLength={2000}
        autosize
        minRows={3}
        maxRows={6}
      />
      {error && (
        <Alert color="red" icon={<IconAlertCircle size={16} />}>
          {error}
        </Alert>
      )}
      <Button
        onClick={handleSubmit}
        loading={submitting}
        disabled={!rating}
        style={{ background: 'var(--ink-text)', color: 'var(--ink-parchment)', border: '2px solid var(--ink-gold)' }}
      >
        Send Feedback
      </Button>
    </Stack>
  );
};

export default FeedbackForm;
