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
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
