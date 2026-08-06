import { create } from 'zustand';
import { pushConsentUpdate, ALL_GRANTED, ALL_DENIED, type ConsentCategories } from '../lib/googleConsent';

const CONSENT_STORAGE_KEY = 'stita_consent';

/** Same try/catch-around-localStorage shape as Matchmaking.tsx's loadSavedName/saveName
 * (private browsing, storage disabled, etc. must never crash the app over a cookie
 * preference). Exported so main.tsx can read the stored choice synchronously, before
 * React mounts, to seed initConsentDefaults (see googleConsent.ts). */
export function getStoredConsentCategories(): ConsentCategories | null {
  try {
    const raw = localStorage.getItem(CONSENT_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (typeof parsed?.analytics !== 'boolean' || typeof parsed?.advertising !== 'boolean') return null;
    return { analytics: parsed.analytics, advertising: parsed.advertising };
  } catch {
    return null;
  }
}

function saveConsentCategories(categories: ConsentCategories): void {
  try {
    localStorage.setItem(CONSENT_STORAGE_KEY, JSON.stringify(categories));
  } catch {
    // localStorage unavailable — the choice just won't be remembered across visits;
    // it still takes effect for the current session via pushConsentUpdate.
  }
}

interface ConsentState {
  /** Whether the player has ever made an explicit choice — drives whether the banner
   * shows unprompted on first visit. `null` categories means "no choice yet." */
  hasDecided: boolean;
  categories: ConsentCategories;
  /** True while the "Cookie Settings" reopened panel is showing — independent of
   * `hasDecided`, since a returning visitor can reopen and change their mind. */
  settingsOpen: boolean;
  acceptAll: () => void;
  rejectAll: () => void;
  saveCustom: (categories: ConsentCategories) => void;
  openSettings: () => void;
  closeSettings: () => void;
}

const stored = getStoredConsentCategories();

export const useConsentStore = create<ConsentState>((set) => ({
  hasDecided: stored !== null,
  categories: stored ?? ALL_DENIED,
  settingsOpen: false,

  // All three pass backfillPageView: true — each is a live, in-session consent decision,
  // arriving after the page's own automatic (pre-consent, necessarily denied) page_view
  // already fired. See pushConsentUpdate's own doc comment for why that backfill matters:
  // without it, a first-time visitor who accepts analytics still never has a single real,
  // non-cookieless hit recorded for that visit.
  acceptAll: () => {
    saveConsentCategories(ALL_GRANTED);
    pushConsentUpdate(ALL_GRANTED, true);
    set({ hasDecided: true, categories: ALL_GRANTED, settingsOpen: false });
  },

  rejectAll: () => {
    saveConsentCategories(ALL_DENIED);
    pushConsentUpdate(ALL_DENIED, true);
    set({ hasDecided: true, categories: ALL_DENIED, settingsOpen: false });
  },

  saveCustom: (categories) => {
    saveConsentCategories(categories);
    pushConsentUpdate(categories, true);
    set({ hasDecided: true, categories, settingsOpen: false });
  },

  openSettings: () => set({ settingsOpen: true }),
  closeSettings: () => set({ settingsOpen: false }),
}));
