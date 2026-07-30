import React, { useState } from 'react';
import { Button } from '@mantine/core';
import { IconCheck, IconShare } from '@tabler/icons-react';

interface ShareButtonProps {
  /** Message body — the invite pitch or brag text. `url` is appended on its own line so
   * every share target (native sheet, or the clipboard fallback) always carries a link
   * back to the game, not just flavor text. */
  text: string;
  url: string;
  title?: string;
  label?: string;
  fullWidth?: boolean;
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl';
  style?: React.CSSProperties;
}

/** Pure — extracted so it's unit-testable without mounting a component or stubbing
 * `navigator` (this workspace runs Vitest without jsdom, see googleConsent.test.ts's own
 * note on why — no test here needs a real DOM). */
export function formatShareMessage(text: string, url: string): string {
  return `${text}\n${url}`;
}

/**
 * One button, two behaviors depending on the device: the Web Share API
 * (`navigator.share`) opens the OS-native share sheet — on mobile this is the single
 * biggest lever for free distribution, since it surfaces every messaging/social app the
 * player already has installed (WhatsApp, SMS, Discord, X, etc.) in one tap, with zero
 * per-platform integration work on our side. Desktop browsers mostly don't implement
 * `navigator.share` at all, so there `copyToClipboard` is the fallback — same UX pattern
 * as Matchmaking.tsx's existing `CopyButton` (icon flips to a checkmark for ~1.5s).
 *
 * Both paths are best-effort: a user dismissing the native share sheet rejects the
 * returned promise (`AbortError`), which must NOT surface as a broken button — swallowed
 * silently, same "must degrade invisibly" convention this codebase uses for llmService/
 * eventLogService.
 */
const ShareButton: React.FC<ShareButtonProps> = ({ text, url, title, label = 'Share', fullWidth, size = 'sm', style }) => {
  const [copied, setCopied] = useState(false);

  const handleClick = async () => {
    if (navigator.share) {
      try {
        await navigator.share({ title, text, url });
      } catch {
        // User dismissed the share sheet, or the platform rejected it — not an error.
      }
      return;
    }
    try {
      await navigator.clipboard.writeText(formatShareMessage(text, url));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API unavailable (very old browser, insecure context) — nothing more we can do.
    }
  };

  return (
    <Button
      onClick={handleClick}
      fullWidth={fullWidth}
      size={size}
      leftSection={copied ? <IconCheck size={16} /> : <IconShare size={16} />}
      style={style}
    >
      {copied ? 'Copied to clipboard!' : label}
    </Button>
  );
};

export default ShareButton;
