import { describe, it, expect } from 'vitest';
import { DEVLOG_ENTRIES } from './Devlog';

describe('DEVLOG_ENTRIES', () => {
  it('is non-empty', () => {
    expect(DEVLOG_ENTRIES.length).toBeGreaterThan(0);
  });

  it('every entry has a date, a title, a tag, and at least one paragraph', () => {
    for (const entry of DEVLOG_ENTRIES) {
      expect(entry.date.trim()).not.toBe('');
      expect(entry.title.trim()).not.toBe('');
      expect(entry.tag.trim()).not.toBe('');
      expect(entry.paragraphs.length).toBeGreaterThan(0);
      for (const p of entry.paragraphs) {
        expect(p.trim()).not.toBe('');
      }
    }
  });

  it('lists entries newest-first by date', () => {
    const dates = DEVLOG_ENTRIES.map((e) => new Date(e.date).getTime());
    for (let i = 1; i < dates.length; i++) {
      expect(dates[i - 1]).toBeGreaterThanOrEqual(dates[i]);
    }
  });
});
