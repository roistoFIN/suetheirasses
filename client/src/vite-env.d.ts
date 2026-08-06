/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SERVER_URL: string;
  /** Google AdSense publisher ID (e.g. "ca-pub-XXXXXXXXXXXXXXXX") — unset until the
   * AdSense account is approved. See googleConsent.ts's loadAdSenseScript: with this
   * unset, the ad script is never injected regardless of consent, so it's safe to leave
   * blank indefinitely. */
  readonly VITE_ADSENSE_CLIENT_ID?: string;
  /** Google Analytics 4 measurement ID (e.g. "G-XXXXXXXXXX") — unset until a GA4
   * property exists. See googleConsent.ts's loadAnalyticsScript: with this unset, the
   * gtag.js script is never injected regardless of consent, so it's safe to leave blank
   * indefinitely. */
  readonly VITE_GA_MEASUREMENT_ID?: string;
  /** AdSense ad-unit slot id for the landing page's manual ad placement (see
   * components/AdSlot.tsx) — unset until an ad unit exists for this placement in the
   * AdSense dashboard (requires an approved account first). Unset means this placement
   * never renders, regardless of consent. */
  readonly VITE_ADSENSE_SLOT_LANDING?: string;
  /** AdSense ad-unit slot id for the Game Over/spectating screen's manual ad placement
   * (see components/AdSlot.tsx and pages/GameTimelineView.tsx) — same unset-is-safe rule
   * as VITE_ADSENSE_SLOT_LANDING, but its own distinct ad unit/slot id, since AdSense
   * ad units are per-placement. */
  readonly VITE_ADSENSE_SLOT_GAMEOVER?: string;
  /** AdSense ad-unit slot ids for the six static guide pages' manual ad placements (see
   * components/AdSlot.tsx and each page's own doc comment) — same unset-is-safe rule as
   * VITE_ADSENSE_SLOT_LANDING, each its own distinct ad unit/slot id. */
  readonly VITE_ADSENSE_SLOT_RULES?: string;
  readonly VITE_ADSENSE_SLOT_STRATEGY?: string;
  readonly VITE_ADSENSE_SLOT_GLOSSARY?: string;
  readonly VITE_ADSENSE_SLOT_DEVLOG?: string;
  readonly VITE_ADSENSE_SLOT_HOWTOPLAY?: string;
  readonly VITE_ADSENSE_SLOT_WHATSNEW?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
