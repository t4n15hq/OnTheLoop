import { test, expect } from '@playwright/test';
import { seedAuthedSession, registerViaApi, uniqueEmail } from './helpers';

test.describe('Profile modal', () => {
  test('user menu dropdown opens and is not clipped by header', async ({ page, request }) => {
    await seedAuthedSession(page, request);
    await page.reload();
    await expect(page.locator('#dashboard-view')).toBeVisible({ timeout: 10_000 });

    const dropdown = page.locator('#user-menu-dropdown');
    await expect(dropdown).toBeHidden();
    await page.click('#user-menu-btn');
    await expect(dropdown).toBeVisible();

    // Both menu items must be in the viewport (not clipped)
    const profile = page.locator('#profile-btn');
    const logout = page.locator('#logout-btn');
    await expect(profile).toBeVisible();
    await expect(logout).toBeVisible();

    // Ensure the dropdown itself is positioned below the trigger (not hidden behind header overflow)
    const box = await dropdown.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.height).toBeGreaterThan(40);

    // Confirm the logout button is actually clickable (would fail if overlapped)
    await logout.click({ trial: true });
  });

  test('opens profile modal, tabs switch, telegram status renders', async ({ page, request }) => {
    await seedAuthedSession(page, request);
    await page.reload();
    await expect(page.locator('#dashboard-view')).toBeVisible({ timeout: 10_000 });

    await page.click('#user-menu-btn');
    await expect(page.locator('#user-menu-dropdown')).toBeVisible();
    await page.click('#profile-btn');
    await expect(page.locator('#profile-modal')).toBeVisible();
    await expect(page.locator('#profile-email-display')).not.toHaveText('Loading…');

    // Tabs
    await expect(page.locator('#tab-general')).toBeVisible();
    await expect(page.locator('#tab-security')).toBeHidden();
    await page.click('.tab-btn[data-tab="security"]');
    await expect(page.locator('#tab-security')).toBeVisible();
    await expect(page.locator('#tab-general')).toBeHidden();
    await page.click('.tab-btn[data-tab="general"]');
    await expect(page.locator('#tab-general')).toBeVisible();

    // Telegram status populates
    await expect(page.locator('#telegram-status')).not.toHaveText('Checking…', {
      timeout: 6_000,
    });

    await page.locator('#profile-modal .modal-close').click();
    await expect(page.locator('#profile-modal')).toBeHidden();
  });

  test('updates display name via profile form', async ({ page, request }) => {
    const email = uniqueEmail('profile');
    const password = 'TestPass123!';
    const token = await registerViaApi(request, email, password, 'Original Name');
    await page.goto('/');
    await page.evaluate((t) => localStorage.setItem('authToken', t), token);
    await page.reload();
    await expect(page.locator('#dashboard-view')).toBeVisible({ timeout: 10_000 });

    await page.click('#user-menu-btn');
    await page.click('#profile-btn');
    await expect(page.locator('#profile-modal')).toBeVisible();

    const newName = 'Updated PW Name';
    await page.fill('#profile-name', newName);
    await page.click('#profile-update-form button[type="submit"]');
    await expect(page.locator('#profile-msg')).toBeVisible({ timeout: 6_000 });

    const me = await request.get('/api/users/me', {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = await me.json();
    expect(body.user.name).toBe(newName);
  });
});

test.describe('Theme toggle', () => {
  test('clicking theme button flips data-theme and persists', async ({ page, request }) => {
    await seedAuthedSession(page, request);
    await page.reload();
    await expect(page.locator('#dashboard-view')).toBeVisible({ timeout: 10_000 });

    const before = await page.evaluate(() =>
      document.documentElement.getAttribute('data-theme')
    );
    await page.click('#theme-toggle');
    const after = await page.evaluate(() =>
      document.documentElement.getAttribute('data-theme')
    );
    expect(after).not.toBe(before);

    const stored = await page.evaluate(() => localStorage.getItem('theme'));
    expect(stored).toBe(after);
  });
});

test.describe('Transit assistant (chat)', () => {
  test('chat echoes user input and shows bot reply', async ({ page, request }) => {
    await seedAuthedSession(page, request);
    await page.reload();
    await expect(page.locator('#dashboard-view')).toBeVisible({ timeout: 10_000 });

    const initialCount = await page.locator('#chat-messages .chat-bubble').count();
    await page.fill('#chat-input', 'Next Red Line from Belmont');
    await page.press('#chat-input', 'Enter');

    // User bubble should appear quickly
    await expect(
      page.locator('#chat-messages .chat-bubble.user')
    ).toContainText('Red Line', { timeout: 6_000 });

    // Eventually a new bot bubble (loading or answer). Allow time for Gemini.
    await expect
      .poll(
        async () =>
          await page.locator('#chat-messages .chat-bubble').count(),
        { timeout: 25_000 }
      )
      .toBeGreaterThan(initialCount + 1);
  });

  test('clear conversation button resets the transcript', async ({ page, request }) => {
    await seedAuthedSession(page, request);
    await page.reload();
    await expect(page.locator('#dashboard-view')).toBeVisible({ timeout: 10_000 });

    await page.fill('#chat-input', 'hello');
    await page.press('#chat-input', 'Enter');
    await expect(page.locator('#chat-messages .chat-bubble.user')).toBeVisible();

    await page.click('#clear-terminal-btn');
    await expect(page.locator('#chat-messages')).toContainText(/System ready/i);
    await expect(page.locator('#chat-messages .chat-bubble.user')).toHaveCount(0);
  });
});

test.describe('Branding & layout', () => {
  test('page title and branding present', async ({ page }) => {
    await page.goto('/#login');
    await expect(page).toHaveTitle(/On the Loop/i);
    await expect(page.locator('.logo-pulse')).toHaveText('L');
    await expect(page.locator('.auth-card h1')).toContainText('LOOP');
  });

  test('CTA line options appear in train select', async ({ page, request }) => {
    await seedAuthedSession(page, request);
    await page.reload();
    await expect(page.locator('#dashboard-view')).toBeVisible({ timeout: 10_000 });
    await page.click('#add-favorite-btn');
    await page.click('input[name="route-type"][value="TRAIN"]');
    const options = await page.locator('#train-line option').allTextContents();
    for (const line of ['Red Line', 'Blue Line', 'Brown Line', 'Green Line', 'Orange Line', 'Pink Line', 'Purple Line', 'Yellow Line']) {
      expect(options).toContain(line);
    }
  });
});
