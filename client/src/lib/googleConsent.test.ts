import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  categoriesToSignals,
  ensureDataLayer,
  loadAdSenseScript,
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
}

interface FakeWindow {
  dataLayer?: unknown[];
  gtag?: (...args: unknown[]) => void;
}

function createFakeDocument() {
  const created: Record<string, FakeScriptElement> = {};
  return {
    getElementById: vi.fn((id: string) => created[id] ?? null),
    createElement: vi.fn((): FakeScriptElement => ({ id: '', async: false, crossOrigin: '', src: '' })),
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
    vi.stubGlobal('window', {});
    const fakeDocument = createFakeDocument();
    vi.stubGlobal('document', fakeDocument);

    pushConsentUpdate({ analytics: true, advertising: false });
    expect(fakeDocument.head.appendChild).not.toHaveBeenCalled();

    pushConsentUpdate({ analytics: true, advertising: true });
    expect(fakeDocument.head.appendChild).toHaveBeenCalledTimes(1);
  });
});
