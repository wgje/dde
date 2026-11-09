import { expect, test, type BrowserContext, type Page, type Route } from '@playwright/test';

import { environment } from '../src/environments/environment';
import { resolveSupabaseStorageKey } from '../src/services/supabase-client-configuration';

interface CanonicalBundle {
  session: string | null;
  codeVerifier: string | null;
  user: string | null;
}

interface IdleProbeSnapshot {
  canonicalMutations: number;
  held: number;
  storageEvents: Array<{ key: string | null; newValue: string | null }>;
}

type TestSession = ReturnType<typeof createSession>;

const STORAGE_KEY = resolveSupabaseStorageKey(environment.supabaseUrl);
const AUTH_CONFIGURED = Boolean(STORAGE_KEY)
  && environment.supabaseUrl !== 'YOUR_SUPABASE_URL'
  && environment.supabaseAnonKey !== 'YOUR_SUPABASE_ANON_KEY';
const HOLD_IDLE_KEY = 'nanoflow-e2e-hold-auth-background-idle';

function base64Url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function createSession(userId: string, tokenId: string) {
  const issuedAt = Math.floor(Date.now() / 1000);
  const now = new Date().toISOString();
  const user = {
    id: userId,
    aud: 'authenticated',
    role: 'authenticated',
    email: `${userId}@example.com`,
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
        sub: userId,
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

function bundleFor(session: TestSession): CanonicalBundle {
  return {
    session: JSON.stringify(session),
    codeVerifier: `verifier-${session.user.id}`,
    user: JSON.stringify(session.user),
  };
}

async function fulfillJson(route: Route, body: unknown): Promise<void> {
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
}

async function installTransport(
  context: BrowserContext,
  sessionA: TestSession,
  sessionB: TestSession,
) {
  const requests = { a: 0, b: 0 };
  await context.route(`${environment.supabaseUrl}/**`, async route => {
    const authorization = route.request().headers()['authorization'];
    if (authorization === `Bearer ${sessionA.access_token}`) requests.a += 1;
    if (authorization === `Bearer ${sessionB.access_token}`) requests.b += 1;
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/auth/v1/user')) {
      await fulfillJson(route, authorization === `Bearer ${sessionB.access_token}`
        ? sessionB.user : sessionA.user);
      return;
    }
    await fulfillJson(route, url.pathname.startsWith('/rest/v1/') ? [] : {});
  });
  return requests;
}

async function installIdleProbe(context: BrowserContext): Promise<void> {
  await context.addInitScript(({ storageKey, holdKey }) => {
    const probe = {
      canonicalMutations: 0,
      held: new Map<number, IdleRequestCallback>(),
      storageEvents: [] as Array<{ key: string | null; newValue: string | null }>,
    };
    Object.defineProperty(globalThis, '__authBackgroundIdleProbe', { value: probe });
    const nativeSetItem = Storage.prototype.setItem;
    const nativeRemoveItem = Storage.prototype.removeItem;
    Storage.prototype.setItem = function(key: string, value: string): void {
      if (this === localStorage && key.startsWith(storageKey)) probe.canonicalMutations += 1;
      nativeSetItem.call(this, key, value);
    };
    Storage.prototype.removeItem = function(key: string): void {
      if (this === localStorage && key.startsWith(storageKey)) probe.canonicalMutations += 1;
      nativeRemoveItem.call(this, key);
    };
    globalThis.addEventListener('storage', event => {
      probe.storageEvents.push({ key: event.key, newValue: event.newValue });
    });

    const nativeRequest = globalThis.requestIdleCallback?.bind(globalThis);
    const nativeCancel = globalThis.cancelIdleCallback?.bind(globalThis);
    let nextHeldId = 100_000;
    globalThis.requestIdleCallback = (callback, options): number => {
      if (sessionStorage.getItem(holdKey) === '1') {
        const id = nextHeldId++;
        probe.held.set(id, callback);
        return id;
      }
      return nativeRequest
        ? nativeRequest(callback, options)
        : window.setTimeout(() => callback({ didTimeout: false, timeRemaining: () => 50 }), 0);
    };
    globalThis.cancelIdleCallback = id => {
      if (!probe.held.delete(id)) nativeCancel?.(id);
    };
    Object.defineProperty(globalThis, '__releaseAuthBackgroundIdle', {
      value: () => {
        sessionStorage.removeItem(holdKey);
        const callbacks = [...probe.held.values()];
        probe.held.clear();
        callbacks.forEach(callback => callback({ didTimeout: false, timeRemaining: () => 50 }));
      },
    });
  }, { storageKey: STORAGE_KEY ?? '', holdKey: HOLD_IDLE_KEY });
}

async function replaceCanonical(page: Page, bundle: CanonicalBundle): Promise<void> {
  if (!STORAGE_KEY) throw new Error('Canonical storage key is unavailable');
  await page.evaluate(async ({ storageKey, next }) => {
    const authority = (globalThis as typeof globalThis & {
      __NANOFLOW_AUTH_CANONICAL_STORAGE__?: {
        compareAndSwap(input: unknown): Promise<string>;
        peekBundle(key: string): CanonicalBundle;
      };
    }).__NANOFLOW_AUTH_CANONICAL_STORAGE__;
    if (!authority) throw new Error('Canonical auth authority is unavailable');
    const result = await authority.compareAndSwap({
      storageKey,
      expected: authority.peekBundle(storageKey),
      next,
    });
    if (result !== 'committed') throw new Error(`Canonical CAS failed: ${result}`);
  }, { storageKey: STORAGE_KEY, next: bundle });
}

async function canonicalEquals(page: Page, expected: CanonicalBundle): Promise<boolean> {
  if (!STORAGE_KEY) return false;
  return page.evaluate(({ storageKey, next }) => {
    const authority = (globalThis as typeof globalThis & {
      __NANOFLOW_AUTH_CANONICAL_STORAGE__: { peekBundle(key: string): CanonicalBundle };
    }).__NANOFLOW_AUTH_CANONICAL_STORAGE__;
    const actual = authority.peekBundle(storageKey);
    return actual.session === next.session
      && actual.codeVerifier === next.codeVerifier
      && actual.user === next.user;
  }, { storageKey: STORAGE_KEY, next: expected });
}

async function readProbe(page: Page): Promise<IdleProbeSnapshot> {
  return page.evaluate(() => {
    const probe = (globalThis as typeof globalThis & {
      __authBackgroundIdleProbe: {
        canonicalMutations: number;
        held: Map<number, IdleRequestCallback>;
        storageEvents: Array<{ key: string | null; newValue: string | null }>;
      };
    }).__authBackgroundIdleProbe;
    return {
      canonicalMutations: probe.canonicalMutations,
      held: probe.held.size,
      storageEvents: probe.storageEvents,
    };
  });
}

async function backgroundTraceCount(page: Page): Promise<number> {
  return page.evaluate(() => (window.__NANOFLOW_STARTUP_TRACE__ ?? [])
    .filter(entry => entry.event.startsWith('auth.background_refresh_')).length);
}

async function prepareHeldFastPath(page: Page, sessionA: TestSession): Promise<void> {
  await page.goto('/#/projects');
  await expect(page).toHaveURL(/\/#\/projects/);
  await replaceCanonical(page, bundleFor(sessionA));
  await page.evaluate(holdKey => sessionStorage.setItem(holdKey, '1'), HOLD_IDLE_KEY);
  await page.reload();
  await expect(page).toHaveURL(/\/#\/projects/);
  await expect.poll(async () => (await readProbe(page)).held).toBeGreaterThan(0);
}

async function releaseHeldIdle(page: Page): Promise<void> {
  await page.evaluate(() => (globalThis as typeof globalThis & {
    __releaseAuthBackgroundIdle: () => void;
  }).__releaseAuthBackgroundIdle());
}

async function dispatchCanonicalStorageEvent(page: Page, bundle: CanonicalBundle): Promise<void> {
  if (!STORAGE_KEY) throw new Error('Canonical storage key is unavailable');
  await page.evaluate(({ storageKey, session }) => {
    globalThis.dispatchEvent(new StorageEvent('storage', {
      key: storageKey,
      newValue: session,
      oldValue: null,
      storageArea: localStorage,
      url: location.href,
    }));
    globalThis.dispatchEvent(new Event('online'));
    globalThis.dispatchEvent(new Event('focus'));
  }, { storageKey: STORAGE_KEY, session: bundle.session });
}

test.describe('background refresh session authority', () => {
  test.beforeEach(async ({ context }) => installIdleProbe(context));

  for (const scenario of [
    { name: 'different-owner B', nextUserId: 'background-owner-b', tokenId: 'token-b' },
    { name: 'same-owner newer token', nextUserId: 'background-owner-a', tokenId: 'token-a-new' },
  ]) {
    test(`${scenario.name} remains canonical until its storage event is adopted`, async ({ context }) => {
      test.skip(!AUTH_CONFIGURED, 'Supabase browser credentials are unavailable');
      const sessionA = createSession('background-owner-a', 'token-a');
      const sessionB = createSession(scenario.nextUserId, scenario.tokenId);
      const requests = await installTransport(context, sessionA, sessionB);
      const page = await context.newPage();
      await prepareHeldFastPath(page, sessionA);

      const eventBaseline = (await readProbe(page)).storageEvents.length;
      await replaceCanonical(page, bundleFor(sessionB));
      const mutationBaseline = (await readProbe(page)).canonicalMutations;
      const traceBaseline = await backgroundTraceCount(page);
      expect((await readProbe(page)).storageEvents.length).toBe(eventBaseline);
      await releaseHeldIdle(page);

      await expect.poll(() => canonicalEquals(page, bundleFor(sessionB))).toBe(true);
      expect((await readProbe(page)).canonicalMutations).toBe(mutationBaseline);
      await expect.poll(() => backgroundTraceCount(page)).toBe(traceBaseline);
      await expect(page.getByText('登录已过期')).toHaveCount(0);
      const requestBaseline = requests.b;
      await dispatchCanonicalStorageEvent(page, bundleFor(sessionB));
      await expect.poll(async () => (await readProbe(page)).storageEvents
        .slice(eventBaseline)
        .some(event => event.key === STORAGE_KEY && event.newValue === bundleFor(sessionB).session))
        .toBe(true);
      await expect.poll(() => requests.b).toBeGreaterThan(requestBaseline);
      expect(await canonicalEquals(page, bundleFor(sessionB))).toBe(true);
    });
  }
});
