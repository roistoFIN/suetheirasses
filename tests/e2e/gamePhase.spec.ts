import { test, expect } from '@playwright/test';

test.describe('Game Phase', () => {
  test('should take players straight into the game room with real starting numbers when the game starts', async ({ page }) => {
    await page.goto('/');
    await page.getByLabel('Your Name').fill('GamePhasePlayer');
    await page.getByRole('button', { name: /Create New Room/i }).click();

    await expect(page.getByText('Room Lobby')).toBeVisible();

    await page.getByRole('button', { name: /Start Game/i }).click();

    // Server broadcasts phase:changed → GAME_PHASE, then immediately broadcasts an
    // initial snapshot (starting position, no decisions applied) via turn:resolved —
    // no blank "waiting for game data" screen for the whole first round's timer.
    await expect(page.getByText('GamePhasePlayer')).toBeVisible();
    await expect(page.getByText('CASH', { exact: true })).toBeVisible();
    await expect(page.getByText('EQUITY', { exact: true })).toBeVisible();
    await expect(page.getByText('No active decisions')).toBeVisible();
    await expect(page.getByText('No open lawsuits')).toBeVisible();

    // The Decision Deck lives inside its own modal (MAKE IMPORTANT DECISIONS), not a
    // standalone panel — open it and confirm it renders real, deployable decisions
    // instead of a placeholder.
    await page.getByRole('button', { name: /MAKE IMPORTANT DECISIONS/i }).click();
    await expect(page.getByRole('button', { name: 'DEPLOY' }).first()).toBeVisible();
    await page.keyboard.press('Escape');

    // SUE THEIR ASSES lives in the Open Lawsuits box, not the Decision Deck — its label
    // shows the flat filing fee (gameSettings.lawsuitFilingCost), charged instantly the
    // moment a lawsuit is actually filed, not just for opening this button's modal.
    await expect(page.getByText('Open Lawsuits (0)')).toBeVisible();
    await expect(page.getByText(/SUE THEIR ASSES \(\$[\d,]+\)/)).toBeVisible();
  });

  test('should not throw a client-side error when the game room loads', async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(String(err)));

    await page.goto('/');
    await page.getByLabel('Your Name').fill('NoErrorPlayer');
    await page.getByRole('button', { name: /Create New Room/i }).click();
    await expect(page.getByText('Room Lobby')).toBeVisible();

    await page.getByRole('button', { name: /Start Game/i }).click();
    await expect(page.getByText('CASH', { exact: true })).toBeVisible();

    expect(pageErrors).toEqual([]);
  });
});
