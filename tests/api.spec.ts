import { test, expect } from '@playwright/test';
import { registerViaApi, uniqueEmail } from './helpers';

test.describe('Public API', () => {
  test('GET /health returns ok', async ({ request }) => {
    const res = await request.get('/health');
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.status).toBe('ok');
  });

  test('GET /api/cta/train/lines returns 8 CTA lines', async ({ request }) => {
    const res = await request.get('/api/cta/train/lines');
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(Array.isArray(body.lines)).toBeTruthy();
    expect(body.lines.length).toBe(8);
    const names = body.lines.map((l: any) => l.name);
    for (const line of ['Red Line', 'Blue Line', 'Brown Line', 'Green Line', 'Orange Line', 'Pink Line', 'Purple Line', 'Yellow Line']) {
      expect(names).toContain(line);
    }
  });

  test('GET /api/cta/bus/routes returns a list', async ({ request }) => {
    const res = await request.get('/api/cta/bus/routes');
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(Array.isArray(body.routes)).toBeTruthy();
    expect(body.routes.length).toBeGreaterThan(50);
    expect(body.routes[0]).toHaveProperty('rt');
    expect(body.routes[0]).toHaveProperty('rtnm');
  });

  test('GET /api/cta/train/Red/stations returns stations', async ({ request }) => {
    const res = await request.get('/api/cta/train/Red/stations');
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.line).toBe('Red');
    expect(Array.isArray(body.stations)).toBeTruthy();
    expect(body.stations.length).toBeGreaterThan(10);
    expect(body.stations[0]).toHaveProperty('station_name');
  });

  test('GET /api/cta/bus/22/directions returns directions', async ({ request }) => {
    const res = await request.get('/api/cta/bus/22/directions');
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(Array.isArray(body.directions)).toBeTruthy();
    expect(body.directions.length).toBeGreaterThan(0);
    expect(body.directions).toContain('Northbound');
  });
});

test.describe('Auth-gated API', () => {
  test('unauthenticated /api/favorites → 401', async ({ request }) => {
    const res = await request.get('/api/favorites');
    expect(res.status()).toBe(401);
  });

  test('unauthenticated /api/users/me → 401', async ({ request }) => {
    const res = await request.get('/api/users/me');
    expect(res.status()).toBe(401);
  });

  test('register → login → /api/users/me round-trip', async ({ request }) => {
    const email = uniqueEmail('api');
    const pass = 'TestPass123!';
    const token = await registerViaApi(request, email, pass, 'API Tester');
    expect(token).toBeTruthy();

    const me = await request.get('/api/users/me', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(me.ok()).toBeTruthy();
    const body = await me.json();
    expect(body.user.email).toBe(email);

    const login = await request.post('/api/auth/login', {
      data: { email, password: pass },
    });
    expect(login.ok()).toBeTruthy();
    const loginBody = await login.json();
    expect(loginBody.token).toBeTruthy();
  });

  test('register with duplicate email → 400', async ({ request }) => {
    const email = uniqueEmail('dup');
    await registerViaApi(request, email, 'TestPass123!');
    const res = await request.post('/api/auth/register', {
      data: { email, password: 'TestPass123!', name: 'Dup' },
    });
    expect(res.status()).toBeGreaterThanOrEqual(400);
  });

  test('login with wrong password → 401', async ({ request }) => {
    const email = uniqueEmail('wrong');
    await registerViaApi(request, email, 'TestPass123!');
    const res = await request.post('/api/auth/login', {
      data: { email, password: 'nope' },
    });
    expect(res.status()).toBe(401);
  });
});

test.describe('Favorites API (authenticated)', () => {
  test('create → list → delete favorite', async ({ request }) => {
    const email = uniqueEmail('fav');
    const token = await registerViaApi(request, email, 'TestPass123!');
    const auth = { Authorization: `Bearer ${token}` };

    const create = await request.post('/api/favorites', {
      headers: auth,
      data: {
        name: 'Red Line — Belmont to Jackson',
        routeType: 'TRAIN',
        routeId: 'Red',
        stationId: '40260',
        boardingStopName: 'Belmont',
        alightingStopName: 'Jackson',
        direction: 'Service toward 95th/Dan Ryan',
      },
    });
    expect(create.ok()).toBeTruthy();
    const { favorite } = await create.json();
    expect(favorite.id).toBeTruthy();
    expect(favorite.routeId).toBe('Red');

    const list = await request.get('/api/favorites', { headers: auth });
    const { favorites } = await list.json();
    expect(favorites.length).toBe(1);
    expect(favorites[0].routeId).toBe('Red');

    const del = await request.delete(`/api/favorites/${favorite.id}`, { headers: auth });
    expect(del.ok()).toBeTruthy();

    const empty = await request.get('/api/favorites', { headers: auth });
    const emptyBody = await empty.json();
    expect(emptyBody.favorites.length).toBe(0);
  });

  test('create favorite → create schedule → delete schedule', async ({ request }) => {
    const email = uniqueEmail('sched-api');
    const token = await registerViaApi(request, email, 'TestPass123!');
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
    expect(favRes.ok()).toBeTruthy();
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
    const { schedule } = await schedRes.json();
    expect(schedule.time).toBe('17:30');

    const list = await request.get('/api/schedules', { headers: auth });
    const listBody = await list.json();
    expect(listBody.schedules.length).toBe(1);

    const del = await request.delete(`/api/schedules/${schedule.id}`, { headers: auth });
    expect(del.ok()).toBeTruthy();
  });
});
