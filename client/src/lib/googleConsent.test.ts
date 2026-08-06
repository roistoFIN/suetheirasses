import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  categoriesToSignals,
  ensureDataLayer,
  loadAdSenseScript,
  loadAnalyticsScript,
  initConsentDefaults,
  pushConsentUpdate,
  ALL_GRANTED,
  ALL_DENIED,
} from './googleConsent';

// No jsdom in this workspace (see CLAUDE.md's "Test layers" — client tests run against
// plain Node) — window/document are stubbed by hand per test via vi.stubGlobal rather
// than pulling in a jsdom dependency, matching this module's own "no-op outside a
// browser" design (typeof window/document === 'undefined' guards).
interface FakeScriptElement {
  id: string;
  async: boolean;
  crossOrigin: string;
  src: string;
  onload?: () => void;
}

interface FakeWindow {
  dataLayer?: unknown[];
  gtag?: (...args: unknown[]) => void;
}

function createFakeDocument() {
  const created: Record<string, FakeScriptElement> = {};
  return {
    getElementById: vi.fn((id: string) => created[id] ?? null),
    createElement: vi.fn(
      (): FakeScriptElement => ({ id: '', async: false, crossOrigin: '', src: '' }),
    ),
    head: {
      appendChild: vi.fn((el: FakeScriptElement) => {
        created[el.id] = el;
      }),
    },
  };
}

describe('categoriesToSignals', () => {
  it('grants both ad and analytics signals when both categories are true', () => {
    expect(categoriesToSignals({ analytics: true, advertising: true })).toEqual({
      ad_storage: 'granted',
      ad_user_data: 'granted',
      ad_personalization: 'granted',
      analytics_storage: 'granted',
    });
  });

  it('denies everything when both categories are false', () => {
    expect(categoriesToSignals(ALL_DENIED)).toEqual({
      ad_storage: 'denied',
      ad_user_data: 'denied',
      ad_personalization: 'denied',
      analytics_storage: 'denied',
    });
  });

  it('keeps analytics and advertising independent of each other', () => {
    expect(categoriesToSignals({ analytics: true, advertising: false })).toEqual({
      ad_storage: 'denied',
      ad_user_data: 'denied',
      ad_personalization: 'denied',
      analytics_storage: 'granted',
    });
    expect(categoriesToSignals({ analytics: false, advertising: true })).toEqual({
      ad_storage: 'granted',
      ad_user_data: 'granted',
      ad_personalization: 'granted',
      analytics_storage: 'denied',
    });
  });
});

describe('ensureDataLayer', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('creates dataLayer and a gtag stub that pushes its arguments onto it', () => {
    const fakeWindow: FakeWindow = {};
    vi.stubGlobal('window', fakeWindow);

    ensureDataLayer();
    expect(Array.isArray(fakeWindow.dataLayer)).toBe(true);
    expect(typeof fakeWindow.gtag).toBe('function');

    fakeWindow.gtag?.('consent', 'default', { ad_storage: 'denied' });
    expect(fakeWindow.dataLayer).toEqual([['consent', 'default', { ad_storage: 'denied' }]]);
  });

  it('is idempotent — never replaces an already-installed dataLayer/gtag', () => {
    const existingGtag = vi.fn();
    const fakeWindow: FakeWindow = { dataLayer: ['already-here'], gtag: existingGtag };
    vi.stubGlobal('window', fakeWindow);

    ensureDataLayer();

    expect(fakeWindow.dataLayer).toEqual(['already-here']);
    expect(fakeWindow.gtag).toBe(existingGtag);
  });
});

describe('loadAdSenseScript', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('does nothing when no publisher ID is configured (the default, pre-approval state)', () => {
    // Explicitly stubbed empty rather than relying on ambient absence — a developer's own
    // local client/.env may have a real value set for actual dev testing.
    vi.stubEnv('VITE_ADSENSE_CLIENT_ID', '');
    const fakeDocument = createFakeDocument();
    vi.stubGlobal('document', fakeDocument);

    loadAdSenseScript();

    expect(fakeDocument.head.appendChild).not.toHaveBeenCalled();
  });

  it('injects the adsbygoogle script once a publisher ID is configured', () => {
    vi.stubEnv('VITE_ADSENSE_CLIENT_ID', 'ca-pub-12345');
    const fakeDocument = createFakeDocument();
    vi.stubGlobal('document', fakeDocument);

    loadAdSenseScript();

    expect(fakeDocument.head.appendChild).toHaveBeenCalledTimes(1);
    const injected = fakeDocument.head.appendChild.mock.calls[0][0];
    expect(injected.src).toBe(
      'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-12345',
    );
    expect(injected.async).toBe(true);
    expect(injected.crossOrigin).toBe('anonymous');
  });

  it('is idempotent — a repeat call never injects a second script tag', () => {
    vi.stubEnv('VITE_ADSENSE_CLIENT_ID', 'ca-pub-12345');
    const fakeDocument = createFakeDocument();
    vi.stubGlobal('document', fakeDocument);

    loadAdSenseScript();
    loadAdSenseScript();

    expect(fakeDocument.head.appendChild).toHaveBeenCalledTimes(1);
  });
});

describe('loadAnalyticsScript', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('does nothing when no measurement ID is configured (the default, no-GA4-property state)', () => {
    // Explicitly stubbed empty rather than relying on ambient absence — a developer's own
    // local client/.env may have a real value set for actual dev testing.
    vi.stubEnv('VITE_GA_MEASUREMENT_ID', '');
    const fakeDocument = createFakeDocument();
    vi.stubGlobal('document', fakeDocument);

    loadAnalyticsScript();

    expect(fakeDocument.head.appendChild).not.toHaveBeenCalled();
  });

  it('injects the gtag.js script once a measurement ID is configured', () => {
    vi.stubEnv('VITE_GA_MEASUREMENT_ID', 'G-ABC123');
    const fakeWindow: FakeWindow = {};
    vi.stubGlobal('window', fakeWindow);
    const fakeDocument = createFakeDocument();
    vi.stubGlobal('document', fakeDocument);

    loadAnalyticsScript();

    expect(fakeDocument.head.appendChild).toHaveBeenCalledTimes(1);
    const injected = fakeDocument.head.appendChild.mock.calls[0][0];
    expect(injected.src).toBe('https://www.googletagmanager.com/gtag/js?id=G-ABC123');
    expect(injected.async).toBe(true);
  });

  it('fires the js/config gtag calls once the script loads', () => {
    vi.stubEnv('VITE_GA_MEASUREMENT_ID', 'G-ABC123');
    const fakeWindow: FakeWindow = {};
    vi.stubGlobal('window', fakeWindow);
    const fakeDocument = createFakeDocument();
    vi.stubGlobal('document', fakeDocument);

    loadAnalyticsScript();
    const injected = fakeDocument.head.appendChild.mock.calls[0][0];
    injected.onload?.();

    expect(fakeWindow.dataLayer).toEqual([
      ['js', expect.any(Date)],
      ['config', 'G-ABC123'],
    ]);
  });

  it('is idempotent — a repeat call never injects a second script tag', () => {
    vi.stubEnv('VITE_GA_MEASUREMENT_ID', 'G-ABC123');
    vi.stubGlobal('window', {});
    const fakeDocument = createFakeDocument();
    vi.stubGlobal('document', fakeDocument);

    loadAnalyticsScript();
    loadAnalyticsScript();

    expect(fakeDocument.head.appendChild).toHaveBeenCalledTimes(1);
  });
});

describe('initConsentDefaults / pushConsentUpdate', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('always pushes a fully-denied default first, regardless of any stored choice', () => {
    const fakeWindow: FakeWindow = {};
    vi.stubGlobal('window', fakeWindow);

    initConsentDefaults(null);

    expect(fakeWindow.dataLayer).toEqual([['consent', 'default', categoriesToSignals(ALL_DENIED)]]);
  });

  it('layers a stored choice on top of the default, in the same synchronous call', () => {
    const fakeWindow: FakeWindow = {};
    vi.stubGlobal('window', fakeWindow);

    initConsentDefaults(ALL_GRANTED);

    expect(fakeWindow.dataLayer).toEqual([
      ['consent', 'default', categoriesToSignals(ALL_DENIED)],
      ['consent', 'update', categoriesToSignals(ALL_GRANTED)],
    ]);
  });

  it('pushConsentUpdate loads the AdSense script only when advertising is granted', () => {
    vi.stubEnv('VITE_ADSENSE_CLIENT_ID', 'ca-pub-12345');
    // Stubbed empty (not just left ambient) so this test can't accidentally pass/fail
    // depending on a developer's own local client/.env GA measurement ID.
    vi.stubEnv('VITE_GA_MEASUREMENT_ID', '');
    vi.stubGlobal('window', {});
    const fakeDocument = createFakeDocument();
    vi.stubGlobal('document', fakeDocument);

    pushConsentUpdate({ analytics: true, advertising: false });
    expect(fakeDocument.head.appendChild).not.toHaveBeenCalled();

    pushConsentUpdate({ analytics: true, advertising: true });
    expect(fakeDocument.head.appendChild).toHaveBeenCalledTimes(1);
  });

  it('pushConsentUpdate loads the GA4 script regardless of the analytics category — a real, reported bug where Google\'s own tag-detection never saw a not-yet-consented tag', () => {
    vi.stubEnv('VITE_GA_MEASUREMENT_ID', 'G-ABC123');
    // Stubbed empty (not just left ambient) so this test can't accidentally pass/fail
    // depending on a developer's own local client/.env AdSense publisher ID.
    vi.stubEnv('VITE_ADSENSE_CLIENT_ID', '');
    vi.stubGlobal('window', {});
    const fakeDocument = createFakeDocument();
    vi.stubGlobal('document', fakeDocument);

    pushConsentUpdate({ analytics: false, advertising: false });
    expect(fakeDocument.head.appendChild).toHaveBeenCalledTimes(1);

    pushConsentUpdate({ analytics: true, advertising: false });
    // Idempotent — a second call, even with analytics now granted, never injects twice.
    expect(fakeDocument.head.appendChild).toHaveBeenCalledTimes(1);
  });

  it('initConsentDefaults loads the GA4 script unconditionally, even for a first-time (fully denied) visitor', () => {
    vi.stubEnv('VITE_GA_MEASUREMENT_ID', 'G-ABC123');
    vi.stubEnv('VITE_ADSENSE_CLIENT_ID', '');
    vi.stubGlobal('window', {});
    const fakeDocument = createFakeDocument();
    vi.stubGlobal('document', fakeDocument);

    initConsentDefaults(null);

    expect(fakeDocument.head.appendChild).toHaveBeenCalledTimes(1);
    const injected = fakeDocument.head.appendChild.mock.calls[0][0];
    expect(injected.src).toBe('https://www.googletagmanager.com/gtag/js?id=G-ABC123');
  });

  it('pushConsentUpdate never loads the AdSense script merely from the unconditional GA load', () => {
    vi.stubEnv('VITE_GA_MEASUREMENT_ID', 'G-ABC123');
    vi.stubEnv('VITE_ADSENSE_CLIENT_ID', 'ca-pub-12345');
    vi.stubGlobal('window', {});
    const fakeDocument = createFakeDocument();
    vi.stubGlobal('document', fakeDocument);

    pushConsentUpdate({ analytics: true, advertising: false });

    expect(fakeDocument.head.appendChild).toHaveBeenCalledTimes(1);
    const injected = fakeDocument.head.appendChild.mock.calls[0][0];
    expect(injected.id).toBe('stita-ga-script');
  });

  it('pushConsentUpdate(categories, true) backfills a real page_view when analytics is granted — a live consent decision arrives after the pre-consent automatic page_view already fired denied, so without this a first-time visitor who accepts never has a single non-cookieless hit recorded for that visit', () => {
    const fakeWindow: FakeWindow = {};
    vi.stubGlobal('window', fakeWindow);

    pushConsentUpdate({ analytics: true, advertising: false }, true);

    expect(fakeWindow.dataLayer).toEqual([
      ['consent', 'update', categoriesToSignals({ analytics: true, advertising: false })],
      ['event', 'page_view'],
    ]);
  });

  it('pushConsentUpdate(categories, true) does not backfill a page_view when analytics is still denied', () => {
    const fakeWindow: FakeWindow = {};
    vi.stubGlobal('window', fakeWindow);

    pushConsentUpdate(ALL_DENIED, true);

    expect(fakeWindow.dataLayer).toEqual([['consent', 'update', categoriesToSignals(ALL_DENIED)]]);
  });

  it('pushConsentUpdate never backfills when the caller omits the flag (initConsentDefaults replaying a stored decision on a fresh load)', () => {
    const fakeWindow: FakeWindow = {};
    vi.stubGlobal('window', fakeWindow);

    pushConsentUpdate(ALL_GRANTED);

    expect(fakeWindow.dataLayer).toEqual([['consent', 'update', categoriesToSignals(ALL_GRANTED)]]);
  });
});
