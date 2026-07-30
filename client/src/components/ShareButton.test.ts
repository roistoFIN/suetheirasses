import { describe, it, expect } from 'vitest';
import { formatShareMessage } from './ShareButton';

describe('formatShareMessage', () => {
  it('appends the url on its own line after the pitch/brag text', () => {
    expect(formatShareMessage('Come play with me', 'https://suethemchickens.online?room=abc')).toBe(
      'Come play with me\nhttps://suethemchickens.online?room=abc',
    );
  });

  it('still includes the url even when text is empty', () => {
    expect(formatShareMessage('', 'https://suethemchickens.online')).toBe('\nhttps://suethemchickens.online');
  });
});
