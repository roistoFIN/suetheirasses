import { describe, it, expect } from 'vitest';

// Duplicated out of AdminPortal.tsx rather than imported — same "keep this test file
// lightweight, no Mantine/tabler-icons import chain" convention GamePhase.utils.test.ts
// already established (see CLAUDE.md). Keep this in sync with the real implementation
// by hand if the thresholds ever change.
function winRateColor(rate: number | null): string {
  if (rate === null) return 'gray';
  if (rate >= 0.55) return 'green';
  if (rate >= 0.35) return 'yellow';
  return 'red';
}

describe('winRateColor', () => {
  it('returns gray for an unknown (null) rate', () => {
    expect(winRateColor(null)).toBe('gray');
  });

  it('returns green at and above the 0.55 threshold', () => {
    expect(winRateColor(0.55)).toBe('green');
    expect(winRateColor(1)).toBe('green');
  });

  it('returns yellow between 0.35 and just under 0.55', () => {
    expect(winRateColor(0.35)).toBe('yellow');
    expect(winRateColor(0.5)).toBe('yellow');
  });

  it('returns red below 0.35', () => {
    expect(winRateColor(0.34)).toBe('red');
    expect(winRateColor(0)).toBe('red');
  });
});
