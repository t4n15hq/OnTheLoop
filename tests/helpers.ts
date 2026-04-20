import { APIRequestContext, Page, expect } from '@playwright/test';

export const uniqueEmail = (prefix = 'pw') =>
  `${prefix}+${Date.now()}${Math.floor(Math.random() * 1000)}@test.local`;

export async function registerViaApi(
  request: APIRequestContext,
  email: string,
  password: string,
  name = 'PW Tester'
) {
  const res = await request.post('/api/auth/register', {
    data: { email, password, name },
  });
  expect(res.ok()).toBeTruthy();
  const body = await res.json();
  return body.token as string;
}

export async function loginViaApi(
  request: APIRequestContext,
  email: string,
  password: string
) {
  const res = await request.post('/api/auth/login', {
    data: { email, password },
  });
  expect(res.ok()).toBeTruthy();
  const body = await res.json();
  return body.token as string;
}

export async function loginViaUi(page: Page, email: string, password: string) {
  await page.goto('/');
  await page.fill('#auth-email', email);
  await page.fill('#auth-password', password);
  await page.click('#auth-submit-btn');
  await expect(page.locator('#dashboard-view')).toBeVisible({ timeout: 10_000 });
}

export async function seedAuthedSession(
  page: Page,
  request: APIRequestContext
): Promise<{ email: string; password: string; token: string }> {
  const email = uniqueEmail();
  const password = 'TestPass123!';
  const token = await registerViaApi(request, email, password);
  await page.goto('/');
  await page.evaluate((t) => localStorage.setItem('authToken', t), token);
  return { email, password, token };
}
