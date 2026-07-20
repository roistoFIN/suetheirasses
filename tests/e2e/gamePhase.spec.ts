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
    await expect(page).toHaveURL(/\/game$/);
    await expect(page.getByText('GamePhasePlayer')).toBeVisible();
    await expect(page.getByText('CASH', { exact: true })).toBeVisible();
    await expect(page.getByText('EQUITY', { exact: true })).toBeVisible();
    await expect(page.getByText('No active strategies')).toBeVisible();
    await expect(page.getByText('No open lawsuits')).toBeVisible();

    // The Decision Deck now renders real, deployable decisions instead of a placeholder
    await expect(page.getByRole('button', { name: 'DEPLOY' }).first()).toBeVisible();

    // SUE THEIR ASSES lives in the Open Lawsuits box, not the Decision Deck
    await expect(page.getByText('Open Lawsuits (0)')).toBeVisible();
    await expect(page.getByText('📋 SUE THEIR ASSES')).toBeVisible();
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
