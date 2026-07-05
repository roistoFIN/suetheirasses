import { test, expect } from '@playwright/test';

test.describe('Resolution Phase', () => {
  test('should display resolution phase title when in resolution phase', async ({ page }) => {
    await page.goto('/resolution');
    await expect(page.getByText(/Phase.*Legal Resolution/i)).toBeVisible();
  });

  test('should display round badge in resolution phase', async ({ page }) => {
    await page.goto('/resolution');
    await expect(page.getByText(/Round/i)).toBeVisible();
  });

  test('should have defense text input', async ({ page }) => {
    await page.goto('/resolution');
    await expect(page.getByLabel('Defense')).toBeVisible();
  });

  test('should have settlement offer input', async ({ page }) => {
    await page.goto('/resolution');
    await expect(page.getByLabel('Settlement Offer')).toBeVisible();
  });

  test('should have respond button', async ({ page }) => {
    await page.goto('/resolution');
    await expect(page.getByRole('button', { name: /Respond/i })).toBeVisible();
  });

  test('should show lawsuits table', async ({ page }) => {
    await page.goto('/resolution');
    await expect(page.locator('table')).toBeVisible();
  });
});
