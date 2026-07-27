import { describe, it, expect } from 'vitest';
import { shouldShowAd } from './AdSlot';

describe('shouldShowAd', () => {
  it('shows only when consent is granted, a client id is configured, and a slot id is provided', () => {
    expect(shouldShowAd(true, 'ca-pub-123', 'slot-1')).toBe(true);
  });

  it('hides when advertising consent has not been granted', () => {
    expect(shouldShowAd(false, 'ca-pub-123', 'slot-1')).toBe(false);
  });

  it('hides when no publisher ID is configured', () => {
    expect(shouldShowAd(true, undefined, 'slot-1')).toBe(false);
  });

  it('hides when no slot id was passed for this placement', () => {
    expect(shouldShowAd(true, 'ca-pub-123', undefined)).toBe(false);
  });

  it('hides when neither a client id nor a slot id is configured', () => {
    expect(shouldShowAd(true, undefined, undefined)).toBe(false);
  });
});
