/**
 * Google Consent Mode v2 — the signal-passing mechanism Google requires (regardless of
 * which cookie-banner UI a site uses) before any Google ad/analytics script may request
 * personalized ads or set non-essential cookies. See CLAUDE.md's Google Ads planning
 * notes: this project uses AdSense only (no GA/Ads conversion tracking yet), so the
 * standalone "gtag stub + consent commands" pattern below is sufficient — the full
 * googletagmanager.com/gtag/js library is only needed once a GA measurement ID or Ads
 * conversion ID is added, since `adsbygoogle.js` itself already reads consent state off
 * the same `window.dataLayer`/`gtag` queue this file sets up.
 *
 * Everything here is a no-op in a non-browser context (`typeof window === 'undefined'`)
 * so this module is safe to import from a test file without a DOM.
 */

export interface ConsentCategories {
  analytics: boolean;
  advertising: boolean;
}

export const ALL_DENIED: ConsentCategories = { analytics: false, advertising: false };
export const ALL_GRANTED: ConsentCategories = { analytics: true, advertising: true };

type ConsentSignalState = 'granted' | 'denied';

declare global {
  interface Window {
    dataLayer?: unknown[];
    gtag?: (...args: unknown[]) => void;
    adsbygoogle?: unknown[];
  }
}

/** Pure — no DOM access — so it's trivially unit-testable. Mirrors Google's documented
 * Consent Mode v2 parameter names exactly; `security_storage` is intentionally always
 * `granted` (it's not gated by these categories — Google treats it as strictly necessary). */
export function categoriesToSignals(categories: ConsentCategories): Record<string, ConsentSignalState> {
  const adState: ConsentSignalState = categories.advertising ? 'granted' : 'denied';
  return {
    ad_storage: adState,
    ad_user_data: adState,
    ad_personalization: adState,
    analytics_storage: categories.analytics ? 'granted' : 'denied',
  };
}

/** Sets up `window.dataLayer`/`window.gtag` if they don't already exist — the same queue-
 * based stub Google's own snippet uses, so calls made before the real script (if any) is
 * ever loaded are simply queued rather than lost. Idempotent — safe to call repeatedly. */
export function ensureDataLayer(): void {
  if (typeof window === 'undefined') return;
  window.dataLayer = window.dataLayer || [];
  if (!window.gtag) {
    window.gtag = function gtag(...args: unknown[]) {
      window.dataLayer!.push(args);
    };
  }
}

const ADSENSE_SCRIPT_ID = 'stita-adsense-script';

/** Injects the AdSense loader script once, only if a real publisher ID is configured
 * (`VITE_ADSENSE_CLIENT_ID`) — unset by default until the AdSense account is approved,
 * so this is a safe no-op in every environment until that's filled in. Idempotent via a
 * DOM id check, not just a module-level flag, so it's also safe across HMR reloads. */
export function loadAdSenseScript(): void {
  if (typeof document === 'undefined') return;
  const clientId = import.meta.env.VITE_ADSENSE_CLIENT_ID;
  if (!clientId) return;
  if (document.getElementById(ADSENSE_SCRIPT_ID)) return;

  const script = document.createElement('script');
  script.id = ADSENSE_SCRIPT_ID;
  script.async = true;
  script.crossOrigin = 'anonymous';
  script.src = `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${clientId}`;
  document.head.appendChild(script);
}

/** Called once, as early as possible in `main.tsx` — before React even mounts, so no
 * component can race ahead of it. Always establishes the deny-by-default baseline Google
 * requires, then immediately layers a returning visitor's already-stored choice on top
 * (both calls happen synchronously in the same tick, before any ad script has been
 * requested, so there's no window where a denied-by-default state is ever actually acted
 * on for a visitor who'd already consented). */
export function initConsentDefaults(stored: ConsentCategories | null): void {
  ensureDataLayer();
  window.gtag?.('consent', 'default', categoriesToSignals(ALL_DENIED));
  if (stored) {
    pushConsentUpdate(stored);
  }
}

/** Called whenever the player accepts/rejects/customizes cookie categories — updates the
 * live consent signals and, if advertising was just granted, loads the AdSense script
 * (a no-op until `VITE_ADSENSE_CLIENT_ID` is configured — see `loadAdSenseScript`). */
export function pushConsentUpdate(categories: ConsentCategories): void {
  ensureDataLayer();
  window.gtag?.('consent', 'update', categoriesToSignals(categories));
  if (categories.advertising) {
    loadAdSenseScript();
  }
}
