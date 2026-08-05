import { describe, it, expect } from 'vitest';
import { WHATS_NEW_ENTRIES } from './WhatsNew';

describe('WHATS_NEW_ENTRIES', () => {
  it('is non-empty', () => {
    expect(WHATS_NEW_ENTRIES.length).toBeGreaterThan(0);
  });

  it('every entry has a version, a date, a tagline, and at least one highlight', () => {
    for (const entry of WHATS_NEW_ENTRIES) {
      expect(entry.version.trim()).not.toBe('');
      expect(entry.date.trim()).not.toBe('');
      expect(entry.tagline.trim()).not.toBe('');
      expect(entry.highlights.length).toBeGreaterThan(0);
      for (const line of entry.highlights) {
        expect(line.trim()).not.toBe('');
      }
    }
  });

  it('lists versions newest-first', () => {
    const versions = WHATS_NEW_ENTRIES.map((e) => e.version.split('.').map(Number));
    for (let i = 1; i < versions.length; i++) {
      const [prevMajor, prevMinor] = versions[i - 1];
      const [major, minor] = versions[i];
      const prevIsNewer = prevMajor > major || (prevMajor === major && prevMinor > minor);
      expect(prevIsNewer).toBe(true);
    }
  });

  it('has no duplicate version numbers', () => {
    const versions = WHATS_NEW_ENTRIES.map((e) => e.version);
    expect(new Set(versions).size).toBe(versions.length);
  });
});
