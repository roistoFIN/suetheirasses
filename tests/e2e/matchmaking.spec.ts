import { test, expect } from '@playwright/test';

test.describe('Matchmaking Page', () => {
  test('should load the matchmaking page', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveTitle(/.*Sue Their Asses.*/i);
  });

  test('should display the game title', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByText('Sue Their Asses')).toBeVisible();
  });

  test('should display the game subtitle', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByText('Multiplayer Business Strategy Game')).toBeVisible();
  });

  test('should have a name input field', async ({ page }) => {
    await page.goto('/');
    const nameInput = page.getByLabel('Your Name');
    await expect(nameInput).toBeVisible();
  });

  test('should allow entering a player name', async ({ page }) => {
    await page.goto('/');
    const nameInput = page.getByLabel('Your Name');
    await nameInput.fill('TestPlayer');
    await expect(nameInput).toHaveValue('TestPlayer');
  });

  test('should have a room name input field', async ({ page }) => {
    await page.goto('/');
    const roomNameInput = page.getByLabel('Room Name');
    await expect(roomNameInput).toBeVisible();
  });

  test('should have create room button', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('button', { name: /Create Room/i })).toBeVisible();
  });

  test('should have join room button', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('button', { name: /Join Room/i })).toBeVisible();
  });

  test('should not create room without a name', async ({ page }) => {
    await page.goto('/');
    const createButton = page.getByRole('button', { name: /Create Room/i });
    // Button should be disabled or not trigger when name is empty
    await createButton.click();
    // Should still be on matchmaking page
    await expect(page.getByLabel('Your Name')).toBeVisible();
  });

  test('should not join room without name and room name', async ({ page }) => {
    await page.goto('/');
    const joinButton = page.getByRole('button', { name: /Join Room/i });
    await joinButton.click();
    // Should still be on matchmaking page
    await expect(page.getByLabel('Your Name')).toBeVisible();
  });

  test('should show room lobby after joining', async ({ page }) => {
    await page.goto('/');
    await page.getByLabel('Your Name').fill('LobbyPlayer');
    await page.getByRole('button', { name: /Create Room/i }).click();

    // After socket join, should see the lobby
    await expect(page.getByText('Room Lobby')).toBeVisible();
  });

  test('should show ready button in lobby', async ({ page }) => {
    await page.goto('/');
    await page.getByLabel('Your Name').fill('ReadyPlayer');
    await page.getByRole('button', { name: /Create Room/i }).click();

    await expect(page.getByRole('button', { name: /Ready Up/i })).toBeVisible();
  });

  test('should show player list in lobby', async ({ page }) => {
    await page.goto('/');
    await page.getByLabel('Your Name').fill('ListPlayer');
    await page.getByRole('button', { name: /Create Room/i }).click();

    // Should see the player in the list
    await expect(page.getByText('ListPlayer')).toBeVisible();
  });
});
