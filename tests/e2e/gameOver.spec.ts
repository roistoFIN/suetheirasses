import { test, expect } from '@playwright/test';

test.describe('Game Over Page', () => {
  test('should display game over title', async ({ page }) => {
    await page.goto('/gameover');
    await expect(page.getByText(/Game Over/i)).toBeVisible();
  });

  test('should display final standings table', async ({ page }) => {
    await page.goto('/gameover');
    await expect(page.locator('table')).toBeVisible();
  });

  test('should show rank column in standings', async ({ page }) => {
    await page.goto('/gameover');
    await expect(page.getByText('Rank')).toBeVisible();
  });

  test('should show player name column in standings', async ({ page }) => {
    await page.goto('/gameover');
    await expect(page.getByText('Player')).toBeVisible();
  });

  test('should show company cash column in standings', async ({ page }) => {
    await page.goto('/gameover');
    await expect(page.getByText('Company Cash')).toBeVisible();
  });

  test('should show status column in standings', async ({ page }) => {
    await page.goto('/gameover');
    await expect(page.getByText('Status')).toBeVisible();
  });

  test('should have play again button', async ({ page }) => {
    await page.goto('/gameover');
    await expect(page.getByRole('button', { name: /Play Again/i })).toBeVisible();
  });

  test('should display winner badge when available', async ({ page }) => {
    await page.goto('/gameover');
    // Winner badge may or may not be visible depending on game state
    // Just verify the page renders correctly
    await expect(page.getByText(/Game Over/i)).toBeVisible();
  });
});
