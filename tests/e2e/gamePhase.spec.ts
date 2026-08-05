import { test, expect, type Browser, type Page } from '@playwright/test';

// The "Start Game" button stays disabled ("Waiting for at least one more player to
// join") until a second player is actually in the room — a real game requires >= 2
// players (see README's "Last player standing wins"). A second browser context here
// plays that second player, joining via the exact same invite-link flow a real second
// player would use (Matchmaking.tsx's "Room Invite Link" copy button, `?room=<id>`) —
// deliberately NOT Quick Play's "Search for Available Room", which matches whichever
// public WAITING room currently has the fewest players: against a real dev/CI database
// that can already hold other leftover WAITING rooms from earlier runs, Quick Play has
// no guarantee of landing in THIS test's own room specifically.
// Deliberately does NOT use real OS clipboard access (context.grantPermissions +
// navigator.clipboard.readText) — a real, reproduced cross-browser gap: Playwright's
// `grantPermissions` only recognizes 'clipboard-read'/'clipboard-write' for Chromium;
// Firefox and WebKit both reject them outright with "Unknown permission". Instead,
// this replaces `navigator.clipboard.writeText` in the page's own JS context with a
// capturing stub *before* clicking the copy button, so the invite link is captured
// directly from the call the button makes — no real clipboard, no permission grant,
// and identical behavior across all three engines.
async function copyInviteLink(page: Page): Promise<string> {
  await page.evaluate(() => {
    (window as unknown as { __capturedClipboardText: Promise<string> }).__capturedClipboardText =
      new Promise<string>((resolve) => {
        navigator.clipboard.writeText = async (text: string) => {
          resolve(text);
        };
      });
  });
  await page.getByTitle('Copy invite link').click();
  return page.evaluate(() => (window as unknown as { __capturedClipboardText: Promise<string> }).__capturedClipboardText);
}

async function joinAsSecondPlayer(browser: Browser, inviteLink: string, name: string): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(inviteLink);
  await page.getByLabel('Your Name').fill(name);
  await page.getByRole('button', { name: /Join Room/i }).click();
  await expect(page.getByText('Room Lobby')).toBeVisible();
  return page;
}

test.describe('Game Phase', () => {
  test('should take players straight into the game room with real starting numbers when the game starts', async ({ page, browser }) => {
    await page.goto('/play');
    await page.getByLabel('Your Name').fill('GamePhasePlayer');
    await page.getByRole('button', { name: /Create New Room/i }).click();

    await expect(page.getByText('Room Lobby')).toBeVisible();

    const inviteLink = await copyInviteLink(page);
    const secondPlayer = await joinAsSecondPlayer(browser, inviteLink, 'GamePhaseOpponent');
    await expect(page.getByRole('button', { name: /Start Game/i })).toBeEnabled();

    await page.getByRole('button', { name: /Start Game/i }).click();

    // Server broadcasts phase:changed → GAME_PHASE, then immediately broadcasts an
    // initial snapshot (starting position, no decisions applied) via turn:resolved —
    // no blank "waiting for game data" screen for the whole first round's timer.
    await expect(page.getByText('GamePhasePlayer')).toBeVisible();
    await expect(page.getByText('CASH', { exact: true })).toBeVisible();
    await expect(page.getByText('EQUITY', { exact: true })).toBeVisible();
    // "Active Decisions"/"Open Lawsuits" have no empty-state text of their own — the
    // section header's own count already says zero (see CLAUDE.md's own section on why
    // the old separate "No active decisions"/"No open lawsuits" lines were removed as
    // redundant), so this just confirms the header renders with a real zeroed count.
    await expect(page.getByText('Active Decisions (0 strategic, 0 operational, and 0 financial)')).toBeVisible();

    // The Decision Deck lives inside its own modal (MAKE IMPORTANT DECISIONS), not a
    // standalone panel — open it and confirm it renders real, deployable decisions
    // instead of a placeholder.
    await page.getByRole('button', { name: /MAKE IMPORTANT DECISIONS/i }).click();
    await expect(page.getByRole('button', { name: 'DEPLOY' }).first()).toBeVisible();
    await page.keyboard.press('Escape');

    // SUE THEM CHICKENS lives in the Open Lawsuits box, not the Decision Deck — its label
    // shows the flat filing fee (gameSettings.lawsuitFilingCost), charged instantly the
    // moment a lawsuit is actually filed, not just for opening this button's modal.
    await expect(page.getByText('Open Lawsuits (0)')).toBeVisible();
    await expect(page.getByText(/SUE THEM CHICKENS \(\$[\d,]+\)/)).toBeVisible();

    await secondPlayer.context().close();
  });

  test('should not throw a client-side error when the game room loads', async ({ page, browser }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(String(err)));

    await page.goto('/play');
    await page.getByLabel('Your Name').fill('NoErrorPlayer');
    await page.getByRole('button', { name: /Create New Room/i }).click();
    await expect(page.getByText('Room Lobby')).toBeVisible();

    const inviteLink = await copyInviteLink(page);
    const secondPlayer = await joinAsSecondPlayer(browser, inviteLink, 'NoErrorOpponent');
    await expect(page.getByRole('button', { name: /Start Game/i })).toBeEnabled();

    await page.getByRole('button', { name: /Start Game/i }).click();
    await expect(page.getByText('CASH', { exact: true })).toBeVisible();

    expect(pageErrors).toEqual([]);

    await secondPlayer.context().close();
  });
});
