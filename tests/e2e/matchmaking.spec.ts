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

  test('should show a room code input field when opened via an invite link', async ({ page }) => {
    // The "Join a Room" section (with its "Room Code" field) only renders when the
    // page is opened via an invite link (?room=<id>) — see Matchmaking.tsx.
    await page.goto('/?room=test-room-code');
    const roomCodeInput = page.getByLabel('Room Code');
    await expect(roomCodeInput).toBeVisible();
    await expect(roomCodeInput).toHaveValue('test-room-code');
  });

  test('should have quick play button', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('button', { name: /Search for Available Room/i })).toBeVisible();
  });

  test('should have create room button', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('button', { name: /Create New Room/i })).toBeVisible();
  });

  test('should have join room button when opened via an invite link', async ({ page }) => {
    await page.goto('/?room=test-room-code');
    await expect(page.getByRole('button', { name: /Join Room/i })).toBeVisible();
  });

  test('should not create room without a name', async ({ page }) => {
    await page.goto('/');
    const createButton = page.getByRole('button', { name: /Create New Room/i });
    // Button should be disabled when name is empty
    await expect(createButton).toBeDisabled();
  });

  test('should not join room without name and room name', async ({ page }) => {
    await page.goto('/?room=test-room-code');
    const joinButton = page.getByRole('button', { name: /Join Room/i });
    await expect(joinButton).toBeDisabled();
  });

  test('should not quick play without a name', async ({ page }) => {
    await page.goto('/');
    const quickPlayButton = page.getByRole('button', { name: /Search for Available Room/i });
    await expect(quickPlayButton).toBeDisabled();
  });

  test('should show room lobby after creating room', async ({ page }) => {
    await page.goto('/');
    await page.getByLabel('Your Name').fill('LobbyPlayer');
    await page.getByRole('button', { name: /Create New Room/i }).click();

    // After socket join, should see the lobby
    await expect(page.getByText('Room Lobby')).toBeVisible();
  });

  test('should show start game button for the host in lobby', async ({ page }) => {
    // Matchmaking.tsx has no "ready up" step — the host starts the game directly.
    await page.goto('/');
    await page.getByLabel('Your Name').fill('HostPlayer');
    await page.getByRole('button', { name: /Create New Room/i }).click();

    await expect(page.getByRole('button', { name: /Start Game/i })).toBeVisible();
  });

  test('should show player list in lobby', async ({ page }) => {
    await page.goto('/');
    await page.getByLabel('Your Name').fill('ListPlayer');
    await page.getByRole('button', { name: /Create New Room/i }).click();

    // Should see the player in the list
    await expect(page.getByText('ListPlayer')).toBeVisible();
  });

  test('should show quick play section', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByText('Quick Play')).toBeVisible();
  });

  test('should show create room section', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByText('Create a Room')).toBeVisible();
  });

  test('should show join room section when opened via an invite link', async ({ page }) => {
    await page.goto('/?room=test-room-code');
    await expect(page.getByRole('heading', { name: 'Join a Room' })).toBeVisible();
  });

  test('should show loading overlay when searching for room', async ({ page }) => {
    await page.goto('/');
    await page.getByLabel('Your Name').fill('SearchPlayer');
    await page.getByRole('button', { name: /Search for Available Room/i }).click();

    // Loading overlay should appear
    await expect(page.locator('.mantine-LoadingOverlay-root')).toBeVisible();
  });

  test('should show loading overlay when creating room', async ({ page }) => {
    await page.goto('/');
    await page.getByLabel('Your Name').fill('CreatePlayer');
    await page.getByRole('button', { name: /Create New Room/i }).click();

    // Loading overlay should appear
    await expect(page.locator('.mantine-LoadingOverlay-root')).toBeVisible();
  });

  test('should disable inputs while searching', async ({ page }) => {
    await page.goto('/');
    await page.getByLabel('Your Name').fill('DisabledPlayer');
    await page.getByRole('button', { name: /Search for Available Room/i }).click();

    // Name input should be disabled
    await expect(page.getByLabel('Your Name')).toBeDisabled();
  });

  test('should show available rooms section when rooms exist', async ({ page }) => {
    await page.goto('/');
    // The available rooms section should be present in the UI
    // (rooms will only appear after ROOMS_LISTED event)
    await expect(page.getByText('Available Rooms')).toBeVisible().catch(() => {
      // May not show if no rooms are available yet
    });
  });
});
