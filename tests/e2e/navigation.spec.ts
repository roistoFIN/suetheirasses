import { test, expect } from '@playwright/test';

test.describe('Navigation & Routing', () => {
  test('should redirect to matchmaking on unknown route', async ({ page }) => {
    await page.goto('/unknown-route');
    // Should redirect to matchmaking page
    await expect(page.getByText('Sue Their Asses')).toBeVisible();
  });

  test('should navigate to strategy page directly', async ({ page }) => {
    await page.goto('/strategy');
    await expect(page.getByText(/Phase.*Strategic Choices/i)).toBeVisible();
  });

  test('should navigate to results page directly', async ({ page }) => {
    await page.goto('/results');
    await expect(page.getByText(/Phase.*Results/i)).toBeVisible();
  });

  test('should navigate to lawsuits page directly', async ({ page }) => {
    await page.goto('/lawsuits');
    await expect(page.getByText(/Phase.*Legal Suits/i)).toBeVisible();
  });

  test('should navigate to resolution page directly', async ({ page }) => {
    await page.goto('/resolution');
    await expect(page.getByText(/Phase.*Legal Resolution/i)).toBeVisible();
  });

  test('should navigate to game over page directly', async ({ page }) => {
    await page.goto('/gameover');
    await expect(page.getByText(/Game Over/i)).toBeVisible();
  });

  test('should have all phase routes accessible', async ({ page }) => {
    const routes = ['/strategy', '/results', '/lawsuits', '/resolution', '/gameover'];
    for (const route of routes) {
      await page.goto(route);
      // Each page should load without errors
      await expect(page.locator('body')).toBeVisible();
    }
  });
});
