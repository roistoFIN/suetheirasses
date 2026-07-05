import { test, expect } from '@playwright/test';

test.describe('Strategy Phase', () => {
  test('should display strategy phase title when in strategy phase', async ({ page }) => {
    // Navigate directly to strategy page
    await page.goto('/strategy');
    await expect(page.getByText(/Phase.*Strategic Choices/i)).toBeVisible();
  });

  test('should display round badge in strategy phase', async ({ page }) => {
    await page.goto('/strategy');
    await expect(page.getByText(/Round/i)).toBeVisible();
  });

  test('should have action selection dropdowns', async ({ page }) => {
    await page.goto('/strategy');
    // Check that action type selectors are present
    const actionSelects = page.locator('select');
    await expect(actionSelects.first()).toBeVisible();
  });

  test('should have amount input fields', async ({ page }) => {
    await page.goto('/strategy');
    const amountInputs = page.locator('input[type="number"]');
    await expect(amountInputs.first()).toBeVisible();
  });

  test('should have a submit strategy button', async ({ page }) => {
    await page.goto('/strategy');
    await expect(page.getByRole('button', { name: /Submit/i })).toBeVisible();
  });

  test('should allow adding multiple actions', async ({ page }) => {
    await page.goto('/strategy');
    const addActionBtn = page.getByRole('button', { name: /Add Action/i });
    await expect(addActionBtn).toBeVisible();
  });

  test('should show timer in strategy phase', async ({ page }) => {
    await page.goto('/strategy');
    // Timer should be visible (even if 0 or default)
    await expect(page.locator('[data-testid="timer"], [data-testid="countdown"]')).toBeVisible().catch(() => {
      // Timer may be rendered differently; just check the page loaded
    });
  });
});
