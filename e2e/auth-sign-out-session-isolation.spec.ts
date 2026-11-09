import { expect, test, type BrowserContext, type Page, type Route } from '@playwright/test';

import { environment } from '../src/environments/environment';
import { resolveSupabaseStorageKey } from '../src/services/supabase-client-configuration';

interface CanonicalBundle {
  session: string | null;
  codeVerifier: string | null;
  user: string | null;
}

interface StorageProbeSnapshot {
  canonicalMutations: number;
  storageEvents: Array<{ key: string | null; newValue: string | null }>;
}

interface TransportMilestones {
  sequence: number;
  releaseOrder: number;
  logoutResponseOrder: number;
}

type TestSession = ReturnType<typeof createSession>;

const STORAGE_KEY = resolveSupabaseStorageKey(environment.supabaseUrl);
const AUTH_CONFIGURED = Boolean(STORAGE_KEY)
  && environment.supabaseUrl !== 'YOUR_SUPABASE_URL'
  && environment.supabaseAnonKey !== 'YOUR_SUPABASE_ANON_KEY';

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

function createDeferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(accept => { resolve = accept; });
  return { promise, resolve };
}

async function fulfillJson(route: Route, body: unknown): Promise<void> {
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

async function installStorageProbe(context: BrowserContext): Promise<void> {
  await context.addInitScript(storageKey => {
    const probe: StorageProbeSnapshot = { canonicalMutations: 0, storageEvents: [] };
    Object.defineProperty(globalThis, '__authSignOutProbe', { value: probe });
    globalThis.addEventListener('storage', event => {
      if (storageKey && event.key?.startsWith(storageKey)) {
        probe.storageEvents.push({ key: event.key, newValue: event.newValue });
      }
    });
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
  }, STORAGE_KEY ?? '');
}

async function installTransport(
  context: BrowserContext,
  sessionA: TestSession,
  sessionB: TestSession,
) {
  const logoutStarted = createDeferred();
  const logoutRelease = createDeferred();
  const milestones: TransportMilestones = {
    sequence: 0,
    releaseOrder: 0,
    logoutResponseOrder: 0,
  };
  await context.route(`${environment.supabaseUrl}/**`, async route => {
    const url = new URL(route.request().url());
    const authorization = route.request().headers()['authorization'];
    if (url.pathname.endsWith('/auth/v1/logout')) {
      logoutStarted.resolve();
      await logoutRelease.promise;
      await fulfillJson(route, {});
      milestones.logoutResponseOrder = ++milestones.sequence;
      return;
    }
    if (url.pathname.endsWith('/auth/v1/user')) {
      await fulfillJson(route, authorization === `Bearer ${sessionB.access_token}`
        ? sessionB.user : sessionA.user);
      return;
    }
    await fulfillJson(route, url.pathname.startsWith('/rest/v1/') ? [] : {});
  });
  return {
    logoutStarted,
    milestones,
    releaseLogout: () => {
      milestones.releaseOrder = ++milestones.sequence;
      logoutRelease.resolve();
    },
  };
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

async function canonicalMutationCount(page: Page): Promise<number> {
  return page.evaluate(() => (globalThis as typeof globalThis & {
    __authSignOutProbe: StorageProbeSnapshot;
  }).__authSignOutProbe.canonicalMutations);
}

async function dispatchCanonicalStorageEvent(page: Page, bundle: CanonicalBundle): Promise<boolean> {
  if (!STORAGE_KEY) throw new Error('Canonical storage key is unavailable');
  return page.evaluate(({ storageKey, session }) => {
    const probe = (globalThis as typeof globalThis & {
      __authSignOutProbe: StorageProbeSnapshot;
    }).__authSignOutProbe;
    const baseline = probe.storageEvents.length;
    globalThis.dispatchEvent(new StorageEvent('storage', {
      key: storageKey,
      newValue: session,
      oldValue: null,
      storageArea: localStorage,
      url: location.href,
    }));
    globalThis.dispatchEvent(new Event('online'));
    globalThis.dispatchEvent(new Event('focus'));
    return probe.storageEvents.slice(baseline)
      .some(event => event.key === storageKey && event.newValue === session);
  }, { storageKey: STORAGE_KEY, session: bundle.session });
}

async function prepareAuthenticatedPage(page: Page, sessionA: TestSession): Promise<void> {
  await page.goto('/#/projects');
  await replaceCanonical(page, bundleFor(sessionA));
  await page.reload();
  await expect(page).toHaveURL(/\/#\/projects/);
  await expect(page.locator('[data-testid="workspace-settings-button"]').first())
    .toBeVisible({ timeout: 15_000 });
}

async function beginHeldSignOut(page: Page): Promise<void> {
  await page.locator('[data-testid="workspace-settings-button"]').first().click();
  const modal = page.locator('[data-testid="settings-modal"]').first();
  await expect(modal).toBeVisible({ timeout: 15_000 });
  await modal.getByRole('button', { name: '退出', exact: true }).click();
}

test.describe('explicit sign-out session authority', () => {
  test.beforeEach(async ({ context }) => installStorageProbe(context));

  for (const scenario of [
    { name: 'different-owner B', nextUserId: 'signout-owner-b', tokenId: 'token-b' },
    { name: 'same-owner newer token', nextUserId: 'signout-owner-a', tokenId: 'token-a-new' },
  ]) {
    test(`${scenario.name} survives delayed sign-out A`, async ({ context }) => {
      test.skip(!AUTH_CONFIGURED, 'Supabase browser credentials are unavailable');
      const sessionA = createSession('signout-owner-a', 'token-a');
      const sessionB = createSession(scenario.nextUserId, scenario.tokenId);
      const transport = await installTransport(context, sessionA, sessionB);
      const page = await context.newPage();
      await prepareAuthenticatedPage(page, sessionA);

      await beginHeldSignOut(page);
      await transport.logoutStarted.promise;
      await replaceCanonical(page, bundleFor(sessionB));
      expect(await dispatchCanonicalStorageEvent(page, bundleFor(sessionB))).toBe(true);
      const mutationBaseline = await canonicalMutationCount(page);
      expect(transport.milestones.logoutResponseOrder).toBe(0);
      transport.releaseLogout();

      await expect.poll(() => transport.milestones.logoutResponseOrder).toBeGreaterThan(0);
      expect(transport.milestones.releaseOrder).toBeGreaterThan(0);
      expect(transport.milestones.logoutResponseOrder)
        .toBeGreaterThan(transport.milestones.releaseOrder);

      await expect.poll(() => canonicalEquals(page, bundleFor(sessionB))).toBe(true);
      expect(await canonicalMutationCount(page)).toBe(mutationBaseline);
      await expect(page.locator('[data-testid="settings-modal"]').first()).toBeVisible();
      await expect(page.getByText('退出登录失败')).toHaveCount(0);
      await expect(page.getByText('本地清理未完成')).toHaveCount(0);
      await expect(page).toHaveURL(/\/#\/projects/);
    });
  }
});
