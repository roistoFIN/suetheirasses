import { test, expect } from '@playwright/test';

test.describe('Lawsuits Phase', () => {
  test('should display lawsuits phase title when in lawsuits phase', async ({ page }) => {
    await page.goto('/lawsuits');
    await expect(page.getByText(/Phase.*Legal Suits/i)).toBeVisible();
  });

  test('should display round badge in lawsuits phase', async ({ page }) => {
    await page.goto('/lawsuits');
    await expect(page.getByText(/Round/i)).toBeVisible();
  });

  test('should have defendant selection dropdown', async ({ page }) => {
    await page.goto('/lawsuits');
    await expect(page.getByLabel('Defendant')).toBeVisible();
  });

  test('should have claim amount input', async ({ page }) => {
    await page.goto('/lawsuits');
    const claimInput = page.getByLabel('Claim Amount');
    await expect(claimInput).toBeVisible();
  });

  test('should have grounds text input', async ({ page }) => {
    await page.goto('/lawsuits');
    const groundsInput = page.getByLabel('Grounds for Lawsuit');
    await expect(groundsInput).toBeVisible();
  });

  test('should have file lawsuit button', async ({ page }) => {
    await page.goto('/lawsuits');
    await expect(page.getByRole('button', { name: /File Lawsuit/i })).toBeVisible();
  });

  test('should show active lawsuits section', async ({ page }) => {
    await page.goto('/lawsuits');
    await expect(page.getByText(/Active Lawsuits/i)).toBeVisible();
  });
});
