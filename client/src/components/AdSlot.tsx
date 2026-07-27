import React, { useEffect, useRef } from 'react';
import { useConsentStore } from '../stores/consentStore';

declare global {
  interface Window {
    adsbygoogle?: unknown[];
  }
}

interface AdSlotProps {
  slot?: string;
  style?: React.CSSProperties;
}

/** Pure gate for whether a manual ad unit should render at all — extracted so it's
 * testable without mounting a component or stubbing the DOM (see AdSlot.test.ts). Mirrors
 * googleConsent.ts's "the script/markup simply doesn't exist without consent" posture: no
 * publisher ID, no per-placement slot id, or no granted advertising consent all mean no
 * `<ins>` element at all, not just an inert one. */
export function shouldShowAd(
  advertisingGranted: boolean,
  clientId: string | undefined,
  slot: string | undefined,
): boolean {
  return advertisingGranted && !!clientId && !!slot;
}

/**
 * A single manual AdSense display-ad unit — used on the landing page and the Game
 * Over/spectating screen (`GameTimelineView.tsx`), both passive/scroll-only areas rather
 * than the live 120s-round `GamePhase` screen. Auto ads were deliberately rejected for
 * this game: Google's ML placement can't know which parts of the page are time-sensitive
 * click targets (Ready button, decision cards), risking both misclicks and "invalid click
 * activity" account penalties. See CLAUDE.md's *Consent-gated Google Analytics/Ads*
 * section.
 *
 * Renders nothing at all — not even an empty `<ins>` — unless `shouldShowAd` passes: a
 * publisher ID is configured (`VITE_ADSENSE_CLIENT_ID`), a real per-placement slot id was
 * passed in (one `VITE_ADSENSE_SLOT_*` env var per call site, since each placement needs
 * its own AdSense ad unit), and the visitor has granted advertising consent. Reactively
 * appears the instant a visitor accepts via the Consent Banner — reads live off
 * `useConsentStore`, no reload needed.
 *
 * `adsbygoogle.push({})` must fire exactly once per real `<ins>` mount — guarded by a ref
 * rather than relying on DOM inspection, since React StrictMode double-invokes effects in
 * dev and a second push against the same element throws "already have ads in this slot."
 */
const AdSlot: React.FC<AdSlotProps> = ({ slot, style }) => {
  const advertisingGranted = useConsentStore((s) => s.categories.advertising);
  const clientId = import.meta.env.VITE_ADSENSE_CLIENT_ID;
  const visible = shouldShowAd(advertisingGranted, clientId, slot);
  const pushedRef = useRef(false);

  useEffect(() => {
    if (!visible || pushedRef.current) return;
    pushedRef.current = true;
    try {
      (window.adsbygoogle = window.adsbygoogle || []).push({});
    } catch {
      // AdSense script not finished loading yet, or blocked by an ad/tracker blocker —
      // must never crash the page it's embedded in over an ad failing to render.
    }
  }, [visible]);

  if (!visible) return null;

  return (
    <ins
      className="adsbygoogle"
      style={{ display: 'block', ...style }}
      data-ad-client={clientId}
      data-ad-slot={slot}
      data-ad-format="auto"
      data-full-width-responsive="true"
    />
  );
};

export default AdSlot;
