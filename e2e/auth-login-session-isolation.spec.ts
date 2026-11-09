import { expect, test, type BrowserContext, type Page, type Route } from '@playwright/test';

import { environment } from '../src/environments/environment';
import { resolveSupabaseStorageKey } from '../src/services/supabase-client-configuration';
import { ensureLoginModalVisible } from './shared/auth-helpers';

type LoginSession = ReturnType<typeof createSession>;

interface CanonicalBundle {
  session: string | null;
  codeVerifier: string | null;
  user: string | null;
}

interface LoginTransport {
  calls: number;
  completed: number;
  release: () => void;
}

interface StorageEventProbe {
  key: string | null;
  newValue: string | null;
}

const PRIMARY_STORAGE_KEY = resolveSupabaseStorageKey(environment.supabaseUrl);
const AUTH_CONFIGURED = Boolean(PRIMARY_STORAGE_KEY)
  && environment.supabaseUrl !== 'YOUR_SUPABASE_URL'
  && environment.supabaseAnonKey !== 'YOUR_SUPABASE_ANON_KEY';

function base64Url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function createSession(ownerId: string, tokenId: string) {
  const now = new Date().toISOString();
  const issuedAt = Math.floor(Date.now() / 1000);
  const user = {
    id: ownerId,
    aud: 'authenticated',
    role: 'authenticated',
    email: `${ownerId}@example.com`,
    email_confirmed_at: now,
    phone: '',
    app_metadata: { provider: 'email', providers: ['email'] },
    user_metadata: {},
    identities: [],
    created_at: now,
    updated_at: now,
  };
  return {
    access_token: [
      base64Url({ alg: 'HS256', typ: 'JWT' }),
      base64Url({
        aud: 'authenticated',
        exp: issuedAt + 3600,
        iat: issuedAt,
        role: 'authenticated',
        session_id: tokenId,
        sub: ownerId,
      }),
      Buffer.from('test-signature').toString('base64url'),
    ].join('.'),
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: issuedAt + 3600,
    refresh_token: `refresh-${tokenId}`,
    user,
  };
}

async function fulfillJson(route: Route, body: unknown): Promise<void> {
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

async function installDelayedLoginTransport(
  context: BrowserContext,
  response: LoginSession,
): Promise<LoginTransport> {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const transport: LoginTransport = { calls: 0, completed: 0, release };
  await context.route(`${environment.supabaseUrl}/**`, async route => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/auth/v1/token')
      && url.searchParams.get('grant_type') === 'password') {
      transport.calls += 1;
      await gate;
      await fulfillJson(route, response);
      transport.completed += 1;
      return;
    }
    if (url.pathname.endsWith('/auth/v1/user')) {
      await fulfillJson(route, response.user);
      return;
    }
    await fulfillJson(route, url.pathname.startsWith('/rest/v1/') ? [] : {});
  });
  return transport;
}

async function installStorageEventProbe(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    const events: StorageEventProbe[] = [];
    Object.defineProperty(globalThis, '__authLoginStorageEvents', { value: events });
    globalThis.addEventListener('storage', event => {
      events.push({ key: event.key, newValue: event.newValue });
    });
  });
}

async function storageEvents(page: Page): Promise<StorageEventProbe[]> {
  return await page.evaluate(() => (globalThis as typeof globalThis & {
    __authLoginStorageEvents: StorageEventProbe[];
  }).__authLoginStorageEvents);
}

async function writeCanonicalSession(page: Page, session: LoginSession): Promise<void> {
  if (!PRIMARY_STORAGE_KEY) throw new Error('Supabase storage key is unavailable');
  await page.evaluate(({ storageKey, nextSession }) => {
    localStorage.setItem(storageKey, JSON.stringify(nextSession));
    localStorage.removeItem(`${storageKey}-code-verifier`);
    localStorage.setItem(`${storageKey}-user`, JSON.stringify(nextSession.user));
  }, { storageKey: PRIMARY_STORAGE_KEY, nextSession: session });
}

async function clearCanonicalSession(page: Page): Promise<void> {
  if (!PRIMARY_STORAGE_KEY) throw new Error('Supabase storage key is unavailable');
  await page.evaluate(storageKey => {
    localStorage.removeItem(storageKey);
    localStorage.removeItem(`${storageKey}-code-verifier`);
    localStorage.removeItem(`${storageKey}-user`);
  }, PRIMARY_STORAGE_KEY);
}

async function readCanonicalBundle(page: Page): Promise<CanonicalBundle> {
  if (!PRIMARY_STORAGE_KEY) throw new Error('Supabase storage key is unavailable');
  return await page.evaluate(storageKey => ({
    session: localStorage.getItem(storageKey),
    codeVerifier: localStorage.getItem(`${storageKey}-code-verifier`),
    user: localStorage.getItem(`${storageKey}-user`),
  }), PRIMARY_STORAGE_KEY);
}

async function awaitProjects(page: Page): Promise<void> {
  await expect(page).toHaveURL(/\/#\/projects(?:[/?#]|$)/);
}

async function submitLogin(page: Page, email: string): Promise<void> {
  await ensureLoginModalVisible(page);
  await page.locator('#login-email').fill(email);
  await page.locator('#login-password').fill('password-123');
  await page.locator('[data-testid="login-modal"] form button[type="submit"]').click();
}

async function expectRejectedLoginModal(page: Page, email: string): Promise<void> {
  await expect(page.locator('[data-testid="login-modal"]')).toBeVisible();
  await expect(page.locator('#login-email')).toHaveValue(email);
  await expect(page.locator('[data-testid="login-modal"] form button[type="submit"]')).toBeEnabled();
  await expect(page).toHaveURL(/\/#\/projects(?:[/?#]|$)/);
}

test('different-owner cross-tab B prevents delayed login A from closing the modal', async ({ context }) => {
  test.skip(!AUTH_CONFIGURED, 'Supabase browser credentials are unavailable');
  const sessionA = createSession('login-owner-a', 'login-a');
  const sessionB = createSession('login-owner-b', 'login-b');
  await installStorageEventProbe(context);
  const transport = await installDelayedLoginTransport(context, sessionA);
  const pageA = await context.newPage();
  const pageB = await context.newPage();
  await Promise.all([pageA.goto('/'), pageB.goto('/')]);
  await Promise.all([awaitProjects(pageA), awaitProjects(pageB)]);

  await submitLogin(pageA, sessionA.user.email);
  await expect.poll(() => transport.calls).toBe(1);
  const storageEventBaseline = (await storageEvents(pageA)).length;
  await writeCanonicalSession(pageB, sessionB);
  await expect.poll(async () => (await storageEvents(pageA))
    .slice(storageEventBaseline)
    .some(event => event.key === PRIMARY_STORAGE_KEY
      && event.newValue === JSON.stringify(sessionB))).toBe(true);
  transport.release();

  await expect.poll(() => transport.completed).toBe(1);
  await expectRejectedLoginModal(pageA, sessionA.user.email);
  expect(await readCanonicalBundle(pageA)).toEqual({
    session: JSON.stringify(sessionB),
    codeVerifier: null,
    user: JSON.stringify(sessionB.user),
  });
  expect((await storageEvents(pageA)).some(event =>
    event.key === PRIMARY_STORAGE_KEY && event.newValue === JSON.stringify(sessionB))).toBe(true);
});

test('cross-tab logout prevents delayed login A from closing or navigating', async ({ context }) => {
  test.skip(!AUTH_CONFIGURED, 'Supabase browser credentials are unavailable');
  const sessionA = createSession('login-owner-a', 'login-a');
  const sessionB = createSession('login-owner-b', 'login-b');
  await installStorageEventProbe(context);
  const transport = await installDelayedLoginTransport(context, sessionA);
  const pageA = await context.newPage();
  const pageB = await context.newPage();
  await Promise.all([pageA.goto('/'), pageB.goto('/')]);
  await Promise.all([awaitProjects(pageA), awaitProjects(pageB)]);

  await submitLogin(pageA, sessionA.user.email);
  await expect.poll(() => transport.calls).toBe(1);
  const sessionEventBaseline = (await storageEvents(pageA)).length;
  await writeCanonicalSession(pageB, sessionB);
  await expect.poll(async () => (await storageEvents(pageA))
    .slice(sessionEventBaseline)
    .some(event => event.key === PRIMARY_STORAGE_KEY
      && event.newValue === JSON.stringify(sessionB))).toBe(true);
  const logoutEventBaseline = (await storageEvents(pageA)).length;
  await clearCanonicalSession(pageB);
  await expect.poll(async () => (await storageEvents(pageA))
    .slice(logoutEventBaseline)
    .some(event => event.key === PRIMARY_STORAGE_KEY && event.newValue === null)).toBe(true);
  transport.release();

  await expect.poll(() => transport.completed).toBe(1);
  await expectRejectedLoginModal(pageA, sessionA.user.email);
  expect(await readCanonicalBundle(pageA)).toEqual({
    session: null, codeVerifier: null, user: null,
  });
  expect((await storageEvents(pageA)).some(event =>
    event.key === PRIMARY_STORAGE_KEY && event.newValue === null)).toBe(true);
});
