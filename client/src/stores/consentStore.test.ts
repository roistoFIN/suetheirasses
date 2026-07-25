import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useConsentStore, getStoredConsentCategories } from './consentStore';
import * as googleConsent from '../lib/googleConsent';

// Only pushConsentUpdate is mocked — ALL_GRANTED/ALL_DENIED/categoriesToSignals stay
// real, since consentStore imports those directly too and the tests below rely on the
// real values.
vi.mock('../lib/googleConsent', async () => {
  const actual = await vi.importActual<typeof import('../lib/googleConsent')>('../lib/googleConsent');
  return { ...actual, pushConsentUpdate: vi.fn() };
});

function createFakeLocalStorage() {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
  };
}

describe('consentStore', () => {
  beforeEach(() => {
    useConsentStore.setState({
      hasDecided: false,
      categories: { analytics: false, advertising: false },
      settingsOpen: false,
    });
    vi.clearAllMocks();
  });

  describe('acceptAll', () => {
    it('grants both categories, marks the choice decided, and closes the reopened panel', () => {
      useConsentStore.getState().acceptAll();

      expect(useConsentStore.getState()).toMatchObject({
        hasDecided: true,
        categories: { analytics: true, advertising: true },
        settingsOpen: false,
      });
    });

    it('pushes the granted categories to Google Consent Mode', () => {
      useConsentStore.getState().acceptAll();

      expect(googleConsent.pushConsentUpdate).toHaveBeenCalledWith({ analytics: true, advertising: true });
    });
  });

  describe('rejectAll', () => {
    it('denies both categories but still marks the choice decided', () => {
      useConsentStore.getState().rejectAll();

      expect(useConsentStore.getState()).toMatchObject({
        hasDecided: true,
        categories: { analytics: false, advertising: false },
      });
      expect(googleConsent.pushConsentUpdate).toHaveBeenCalledWith({ analytics: false, advertising: false });
    });
  });

  describe('saveCustom', () => {
    it('stores exactly the categories passed in, independently of each other', () => {
      useConsentStore.getState().saveCustom({ analytics: true, advertising: false });

      expect(useConsentStore.getState().categories).toEqual({ analytics: true, advertising: false });
      expect(googleConsent.pushConsentUpdate).toHaveBeenCalledWith({ analytics: true, advertising: false });
    });
  });

  describe('openSettings / closeSettings', () => {
    it('openSettings reopens the banner without touching an already-recorded choice', () => {
      useConsentStore.getState().rejectAll();
      useConsentStore.getState().openSettings();

      expect(useConsentStore.getState()).toMatchObject({
        settingsOpen: true,
        hasDecided: true,
        categories: { analytics: false, advertising: false },
      });
    });

    it('closeSettings never overwrites categories/hasDecided — it only clears settingsOpen', () => {
      useConsentStore.getState().acceptAll();
      useConsentStore.getState().openSettings();
      useConsentStore.getState().closeSettings();

      expect(useConsentStore.getState()).toMatchObject({
        settingsOpen: false,
        hasDecided: true,
        categories: { analytics: true, advertising: true },
      });
      // closeSettings alone must never re-invoke Google's consent update — only an
      // actual accept/reject/save action should.
      expect(googleConsent.pushConsentUpdate).toHaveBeenCalledTimes(1);
    });

    it('a first-time visitor (never decided) stays undecided across an open/close cycle', () => {
      useConsentStore.getState().openSettings();
      useConsentStore.getState().closeSettings();

      expect(useConsentStore.getState().hasDecided).toBe(false);
    });
  });
});

describe('getStoredConsentCategories', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns null when nothing is stored', () => {
    vi.stubGlobal('localStorage', createFakeLocalStorage());
    expect(getStoredConsentCategories()).toBeNull();
  });

  it('returns the stored categories when valid JSON is present', () => {
    const fake = createFakeLocalStorage();
    fake.setItem('stita_consent', JSON.stringify({ analytics: true, advertising: false }));
    vi.stubGlobal('localStorage', fake);

    expect(getStoredConsentCategories()).toEqual({ analytics: true, advertising: false });
  });

  it('returns null for malformed JSON rather than throwing', () => {
    const fake = createFakeLocalStorage();
    fake.setItem('stita_consent', 'not json');
    vi.stubGlobal('localStorage', fake);

    expect(() => getStoredConsentCategories()).not.toThrow();
    expect(getStoredConsentCategories()).toBeNull();
  });

  it('returns null for a stored value missing the expected boolean fields', () => {
    const fake = createFakeLocalStorage();
    fake.setItem('stita_consent', JSON.stringify({ analytics: 'yes' }));
    vi.stubGlobal('localStorage', fake);

    expect(getStoredConsentCategories()).toBeNull();
  });

  it('returns null when localStorage access throws (private browsing, storage disabled)', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
    });

    expect(() => getStoredConsentCategories()).not.toThrow();
    expect(getStoredConsentCategories()).toBeNull();
  });
});
