import { test, expect } from '@playwright/test';

// GameOver.tsx renders `null` until the client receives a real `game:over` socket
// event (`if (!gameOver) return null;`) — there is no placeholder/demo state. Visiting
// `/gameover` directly, with no game ever played, is therefore expected to render an
// empty page rather than a "Game Over" screen with fabricated standings.
//
// Exercising the real winner/standings UI requires actually finishing a game, which —
// per FORMULAS.md (turns resolve every `turnDurationSeconds`, 120s by default) — is too
// slow for this suite. That path is covered at the unit/integration level instead:
// GameOver.tsx's rendering logic, and the `game:over` payload contract, are verified in
// tests/api/socket.test.ts ("game:over" describe block).
test.describe('Game Over Page', () => {
  test('should render nothing when there is no game-over data (no game has been played)', async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(String(err)));

    await page.goto('/gameover');

    await expect(page.locator('body')).toHaveText('');
    expect(pageErrors).toEqual([]);
  });
});
