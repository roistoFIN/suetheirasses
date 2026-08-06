/**
 * Google Consent Mode v2 — the signal-passing mechanism Google requires (regardless of
 * which cookie-banner UI a site uses) before any Google ad/analytics script may request
 * personalized ads or set non-essential cookies. See CLAUDE.md's *Consent-gated Google
 * Analytics/Ads* section. `adsbygoogle.js` and `gtag.js` both read consent state off the
 * same `window.dataLayer`/`gtag` queue this file sets up.
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
 * ever loaded are simply queued rather than lost. Idempotent — safe to call repeatedly.
 *
 * **A real, reported bug, found only by bisecting against Google's own servers**: this
 * used to be written with a rest parameter — `function gtag(...args: unknown[])
 * { window.dataLayer!.push(args); }` — which pushes a genuine `Array` onto `dataLayer`.
 * Google's own official snippet instead writes `function gtag(){dataLayer.push(arguments)}`
 * — pushing the array-*like* `arguments` object, which is NOT a real `Array`
 * (`Array.isArray(arguments)` is `false`). This looks like a purely stylistic difference
 * (both support indexing/`.length`/iteration identically for every normal purpose) but
 * isn't: `gtag.js`'s own internal command processing apparently distinguishes real
 * `gtag()` calls from its own internal bookkeeping entries by this exact shape check, and
 * silently drops anything that doesn't match — with zero console errors, a fully-
 * initialized `google_tag_manager` container, and a completely correct-looking
 * `dataLayer` (visually identical either way once logged). The symptom was "the tag test
 * passes, DebugView/Realtime show nothing, and not one single `/g/collect` network
 * request is ever attempted" — confirmed to reproduce identically across three separate
 * GA4 properties, two separate Google accounts, two real devices/browsers/networks, and
 * even a completely unrelated real-world GA4 property borrowed as a control — every one
 * of which stopped failing the instant this one line changed to use `arguments` again.
 * `arguments` is unavailable inside arrow functions, so this must stay a plain `function`
 * expression, not `() => {}`. */
export function ensureDataLayer(): void {
  if (typeof window === 'undefined') return;
  window.dataLayer = window.dataLayer || [];
  if (!window.gtag) {
    window.gtag = function gtag() {
      // Must push the array-LIKE `arguments` object here, not a real Array (via rest
      // params) — see this function's own doc comment for why that distinction is
      // load-bearing, not stylistic.
      // eslint-disable-next-line prefer-rest-params
      window.dataLayer!.push(arguments);
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

const GA_SCRIPT_ID = 'stita-ga-script';

/** Injects the GA4 loader script once, only if a real measurement ID is configured
 * (`VITE_GA_MEASUREMENT_ID`) — unset by default until a GA4 property exists, so this is a
 * safe no-op in every environment until that's filled in. Mirrors `loadAdSenseScript`'s
 * shape exactly, including the DOM-id idempotency check (safe across HMR reloads).
 *
 * Deliberately called UNCONDITIONALLY from `initConsentDefaults` regardless of consent —
 * this used to be gated on `categories.analytics` the same way `loadAdSenseScript` is
 * gated on `advertising`, but that was a real, reported bug: Google's own GA4 tag-
 * detection/"Realtime" checks never saw the tag at all for a visitor who hadn't yet
 * accepted (i.e. everyone, on first load), so the property never registered as
 * "receiving data." This matches Google's own documented Consent Mode v2 pattern: the
 * tag is meant to be installed unconditionally on every page load; the `consent`
 * `default`/`update` signals (already pushed via `categoriesToSignals`) are what govern
 * cookie/personalization behavior, not whether the script exists. With
 * `analytics_storage` denied, gtag.js sends cookieless, non-identifying pings instead of
 * setting `_ga` cookies — still enough for Google's tooling to detect the tag and for
 * aggregate/modeled reporting, without tracking a denied visitor. `loadAdSenseScript`
 * keeps its stricter "doesn't exist pre-consent" gate unchanged — showing actual ads is a
 * different, real UX/policy event, not a tag-detection heartbeat. The `config` call fires
 * after the script's own `onload`, since `gtag.js` ignores queued commands pushed before
 * it finishes initializing. */
export function loadAnalyticsScript(): void {
  if (typeof document === 'undefined') return;
  const measurementId = import.meta.env.VITE_GA_MEASUREMENT_ID;
  if (!measurementId) return;
  if (document.getElementById(GA_SCRIPT_ID)) return;

  ensureDataLayer();
  const script = document.createElement('script');
  script.id = GA_SCRIPT_ID;
  script.async = true;
  script.src = `https://www.googletagmanager.com/gtag/js?id=${measurementId}`;
  script.onload = () => {
    window.gtag?.('js', new Date());
    window.gtag?.('config', measurementId);
  };
  document.head.appendChild(script);
}

/** Called once, as early as possible in `main.tsx` — before React even mounts, so no
 * component can race ahead of it. Always establishes the deny-by-default baseline Google
 * requires, then immediately layers a returning visitor's already-stored choice on top
 * (both calls happen synchronously in the same tick, before any ad script has been
 * requested, so there's no window where a denied-by-default state is ever actually acted
 * on for a visitor who'd already consented). Deliberately calls `pushConsentUpdate`
 * without `backfillPageView` — see that function's own doc comment: this replay's
 * `consent update` lands in `dataLayer` ahead of the `config` call that's about to fire
 * once the script below finishes loading, so *this* load's own automatic page_view
 * already reflects the stored consent correctly with no extra event needed. */
export function initConsentDefaults(stored: ConsentCategories | null): void {
  ensureDataLayer();
  window.gtag?.('consent', 'default', categoriesToSignals(ALL_DENIED));
  // Unconditional — see loadAnalyticsScript's own doc comment for why GA4 must install
  // regardless of consent, unlike AdSense below.
  loadAnalyticsScript();
  if (stored) {
    pushConsentUpdate(stored);
  }
}

/** Called whenever the player accepts/rejects/customizes cookie categories — updates the
 * live consent signals and, if advertising was just granted, loads the AdSense script (a
 * no-op until `VITE_ADSENSE_CLIENT_ID` is configured — see `loadAdSenseScript`). Also
 * re-attempts `loadAnalyticsScript` unconditionally — a harmless idempotent no-op in the
 * normal case where `initConsentDefaults` already loaded it, but a safety net against any
 * future call-order change.
 *
 * `backfillPageView` (default `false`) — see `initConsentDefaults`'s own doc comment for
 * the underlying gap this covers: `gtag('config', ...)`'s automatic page_view fires the
 * instant the async gtag.js script finishes loading, almost always before a human has had
 * time to even see the consent banner — so for a first-time visitor, that one automatic
 * hit is *always* sent under denied consent (a limited, cookieless "modeled" ping that
 * needs real traffic volume before Google will surface it in reports at all — a genuinely
 * reported "the tag test passes but the property shows zero data" symptom on a new/
 * low-traffic site). `ConsentBanner`'s Accept/Reject/Save actions pass `true` here so a
 * live, in-session consent decision immediately backfills one real `event: page_view`
 * hit reflecting the just-granted state, rather than only ever recording the earlier
 * denied one. `initConsentDefaults`'s own replay of an *already-stored* decision on a
 * fresh page load passes `false` (the default) — that replay's `consent update` is queued
 * ahead of the upcoming `config` call in `dataLayer`, so that load's own automatic
 * page_view already correctly reflects the stored consent once gtag.js processes the
 * queue; backfilling there too would just double-count every returning visitor's
 * pageviews for no benefit. */
export function pushConsentUpdate(categories: ConsentCategories, backfillPageView = false): void {
  ensureDataLayer();
  window.gtag?.('consent', 'update', categoriesToSignals(categories));
  if (categories.advertising) {
    loadAdSenseScript();
  }
  loadAnalyticsScript();
  if (backfillPageView && categories.analytics) {
    window.gtag?.('event', 'page_view');
  }
}
