import { test, expect } from '@playwright/test';
import { seedAuthedSession, registerViaApi, uniqueEmail } from './helpers';

test.describe('Favorites & Schedules UI', () => {
  test('opens and closes favorite modal', async ({ page, request }) => {
    await seedAuthedSession(page, request);
    await page.reload();
    await expect(page.locator('#dashboard-view')).toBeVisible({ timeout: 10_000 });

    await page.click('#add-favorite-btn');
    await expect(page.locator('#favorite-modal')).toBeVisible();
    await expect(page.locator('#favorite-modal h2')).toContainText('Add route');

    // Toggle BUS → TRAIN fields
    await expect(page.locator('#bus-fields')).toBeVisible();
    await expect(page.locator('#train-fields')).toBeHidden();
    await page.click('input[name="route-type"][value="TRAIN"]');
    await expect(page.locator('#train-fields')).toBeVisible();
    await expect(page.locator('#bus-fields')).toBeHidden();

    await page.locator('#favorite-modal .modal-close').click();
    await expect(page.locator('#favorite-modal')).toBeHidden();
  });

  test('add a train favorite via API, see it in the list', async ({ page, request }) => {
    const email = uniqueEmail('fav-ui');
    const password = 'TestPass123!';
    const token = await registerViaApi(request, email, password);

    // Seed a favorite directly so we don't depend on slow dropdown populate
    const create = await request.post('/api/favorites', {
      headers: { Authorization: `Bearer ${token}` },
      data: {
        name: 'Belmont → Loop',
        routeType: 'TRAIN',
        routeId: 'Red',
        stationId: '40260',
        boardingStopName: 'Belmont',
        alightingStopName: 'Jackson',
        direction: 'Service toward 95th/Dan Ryan',
      },
    });
    expect(create.ok()).toBeTruthy();

    await page.goto('/');
    await page.evaluate((t) => localStorage.setItem('authToken', t), token);
    await page.reload();
    await expect(page.locator('#dashboard-view')).toBeVisible({ timeout: 10_000 });

    const favList = page.locator('#favorites-list');
    await expect(favList).toContainText('Belmont → Loop', { timeout: 10_000 });
    await expect(favList.locator('.fav-chip')).toContainText(/Red/i);
  });

  test('empty state shows helpful copy when no favorites', async ({ page, request }) => {
    await seedAuthedSession(page, request);
    await page.reload();
    await expect(page.locator('#dashboard-view')).toBeVisible({ timeout: 10_000 });
    const favList = page.locator('#favorites-list');
    await expect(favList).toContainText(/No routes saved/i, { timeout: 10_000 });
  });

  test('schedule modal opens and populates favorite options', async ({ page, request }) => {
    const email = uniqueEmail('sched');
    const password = 'TestPass123!';
    const token = await registerViaApi(request, email, password);
    await request.post('/api/favorites', {
      headers: { Authorization: `Bearer ${token}` },
      data: {
        name: 'Morning commute',
        routeType: 'TRAIN',
        routeId: 'Blue',
        stationId: '40590',
        boardingStopName: 'Damen',
        alightingStopName: 'Clark/Lake',
        direction: 'Service toward Forest Park',
      },
    });

    await page.goto('/');
    await page.evaluate((t) => localStorage.setItem('authToken', t), token);
    await page.reload();
    await expect(page.locator('#dashboard-view')).toBeVisible({ timeout: 10_000 });

    await page.click('#add-schedule-btn');
    await expect(page.locator('#schedule-modal')).toBeVisible();
    await expect(page.locator('#schedule-modal h2')).toContainText('New alert');

    const select = page.locator('#schedule-favorite');
    await expect(select.locator('option')).toContainText(['Morning commute']);
    await page.locator('#schedule-modal .modal-close').click();
    await expect(page.locator('#schedule-modal')).toBeHidden();
  });

  test('create schedule via API, verify in UI list', async ({ page, request }) => {
    const email = uniqueEmail('sched2');
    const password = 'TestPass123!';
    const token = await registerViaApi(request, email, password);
    const auth = { Authorization: `Bearer ${token}` };
    const favRes = await request.post('/api/favorites', {
      headers: auth,
      data: {
        name: 'Evening ride',
        routeType: 'BUS',
        routeId: '22',
        stopId: '18095',
        boardingStopName: 'Clark & Belmont',
        alightingStopName: 'Clark & Lake',
        direction: 'Southbound',
      },
    });
    const { favorite } = await favRes.json();
    const schedRes = await request.post('/api/schedules', {
      headers: auth,
      data: {
        favoriteId: favorite.id,
        time: '17:30',
        daysOfWeek: [1, 2, 3, 4, 5],
      },
    });
    expect(schedRes.ok()).toBeTruthy();

    await page.goto('/');
    await page.evaluate((t) => localStorage.setItem('authToken', t), token);
    await page.reload();
    await expect(page.locator('#dashboard-view')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('#schedules-list')).toContainText('Evening ride', { timeout: 10_000 });
  });

  test('schedules empty state renders', async ({ page, request }) => {
    await seedAuthedSession(page, request);
    await page.reload();
    await expect(page.locator('#dashboard-view')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('#schedules-list')).toContainText(/No alerts scheduled/i, {
      timeout: 10_000,
    });
  });
});
