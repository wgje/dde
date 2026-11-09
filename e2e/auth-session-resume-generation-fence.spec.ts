import { expect, test, type BrowserContext, type Page, type Route } from '@playwright/test';

import { environment } from '../src/environments/environment';
import { resolveSupabaseStorageKey } from '../src/services/supabase-client-configuration';

interface CanonicalBundle {
  session: string | null;
  codeVerifier: string | null;
  user: string | null;
}

interface BrowserProbe {
  posts: Array<{ name: string; payload: unknown }>;
  storageEvents: Array<{ key: string | null; newValue: string | null }>;
  timeline: Array<{ kind: 'post' | 'storage-set'; payload: unknown; canonical?: CanonicalBundle }>;
}

interface AuthTransport {
  armUnauthorizedRequest: () => void;
  refreshCalls: () => number;
  releaseRefresh: () => void;
  requestTokens: string[];
}

const STORAGE_KEY = resolveSupabaseStorageKey(environment.supabaseUrl);
const AUTH_CONFIGURED = Boolean(STORAGE_KEY)
  && environment.supabaseUrl !== 'YOUR_SUPABASE_URL'
  && environment.supabaseAnonKey !== 'YOUR_SUPABASE_ANON_KEY';

function base64Url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function createSession(userId: string, tokenId: string) {
  const issuedAt = Math.floor(Date.now() / 1000);
  const userTimestamp = '2026-01-01T00:00:00.000Z';
  const user = {
    id: userId,
    aud: 'authenticated',
    role: 'authenticated',
    email: `${userId}@example.com`,
    app_metadata: { provider: 'email', providers: ['email'] },
    user_metadata: {},
    identities: [],
    created_at: userTimestamp,
    updated_at: userTimestamp,
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

function bundleFor(session: ReturnType<typeof createSession> | null): CanonicalBundle {
  return {
    session: session ? JSON.stringify(session) : null,
    codeVerifier: null,
    user: session ? JSON.stringify(session.user) : null,
  };
}

async function fulfillJson(route: Route, status: number, body: unknown): Promise<void> {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

async function installAuthTransport(
  context: BrowserContext,
  refreshedSession: ReturnType<typeof createSession>,
): Promise<AuthTransport> {
  let armed = false;
  let calls = 0;
  let releaseRefresh: () => void = () => undefined;
  const refreshGate = new Promise<void>(resolve => { releaseRefresh = resolve; });
  const requestTokens: string[] = [];

  await context.route(`${environment.supabaseUrl}/**`, async route => {
    const request = route.request();
    const url = new URL(request.url());
    const authorization = request.headers()['authorization'];
    if (authorization) requestTokens.push(authorization);
    if (url.pathname.endsWith('/auth/v1/token')
      && url.searchParams.get('grant_type') === 'refresh_token') {
      calls += 1;
      await refreshGate;
      await fulfillJson(route, 200, refreshedSession);
      return;
    }
    if (url.pathname.endsWith('/auth/v1/user')) {
      await fulfillJson(route, 200, refreshedSession.user);
      return;
    }
    if (url.pathname.startsWith('/rest/v1/')) {
      if (armed) {
        armed = false;
        await fulfillJson(route, 401, { code: 'PGRST301', message: 'JWT expired' });
      } else {
        await fulfillJson(route, 200, []);
      }
      return;
    }
    await fulfillJson(route, 200, {});
  });

  return {
    armUnauthorizedRequest: () => { armed = true; },
    refreshCalls: () => calls,
    releaseRefresh,
    requestTokens,
  };
}

async function installBrowserProbe(context: BrowserContext): Promise<void> {
  await context.addInitScript(({ storageKey }) => {
    const probe: BrowserProbe = { posts: [], storageEvents: [], timeline: [] };
    Object.defineProperty(globalThis, '__authResumeProbe', { value: probe });
    const nativeSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key: string, value: string): void {
      if (this === localStorage) probe.timeline.push({ kind: 'storage-set', payload: { key, value } });
      nativeSetItem.call(this, key, value);
    };
    globalThis.addEventListener('storage', event => {
      probe.storageEvents.push({ key: event.key, newValue: event.newValue });
    });
    const NativeBroadcastChannel = globalThis.BroadcastChannel;
    if (!NativeBroadcastChannel) return;
    class ObservedBroadcastChannel extends NativeBroadcastChannel {
      override postMessage(payload: unknown): void {
        probe.posts.push({ name: this.name, payload });
        const authority = (globalThis as typeof globalThis & {
          __NANOFLOW_AUTH_CANONICAL_STORAGE__?: { peekBundle: (key: string) => CanonicalBundle };
        }).__NANOFLOW_AUTH_CANONICAL_STORAGE__;
        probe.timeline.push({
          kind: 'post',
          payload: { name: this.name, payload },
          canonical: authority?.peekBundle(storageKey),
        });
        super.postMessage(payload);
      }
    }
    Object.defineProperty(globalThis, 'BroadcastChannel', { value: ObservedBroadcastChannel });
  }, { storageKey: STORAGE_KEY });
}

async function seedCanonical(page: Page, bundle: CanonicalBundle): Promise<void> {
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

async function readCanonical(page: Page): Promise<CanonicalBundle> {
  if (!STORAGE_KEY) throw new Error('Canonical storage key is unavailable');
  return page.evaluate(storageKey => {
    const authority = (globalThis as typeof globalThis & {
      __NANOFLOW_AUTH_CANONICAL_STORAGE__: { peekBundle(key: string): CanonicalBundle };
    }).__NANOFLOW_AUTH_CANONICAL_STORAGE__;
    return authority.peekBundle(storageKey);
  }, STORAGE_KEY);
}

async function triggerRecovery(page: Page, transport: AuthTransport): Promise<void> {
  transport.armUnauthorizedRequest();
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    globalThis.dispatchEvent(new Event('online'));
    globalThis.dispatchEvent(new Event('focus'));
    document.dispatchEvent(new Event('visibilitychange'));
    globalThis.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
  });
  await expect.poll(transport.refreshCalls).toBe(1);
}

async function prepareRace(
  context: BrowserContext,
  refreshedSession: ReturnType<typeof createSession>,
) {
  const page = await context.newPage();
  const mutator = await context.newPage();
  const transport = await installAuthTransport(context, refreshedSession);
  const initial = createSession('user-a', 'token-a');
  await page.goto('/#/projects');
  await expect(page).toHaveURL(/\/#\/projects/);
  await seedCanonical(page, bundleFor(initial));
  await page.reload();
  await expect(page).toHaveURL(/\/#\/projects/);
  await mutator.goto('/#/projects');
  await expect(mutator).toHaveURL(/\/#\/projects/);
  await triggerRecovery(page, transport);
  return { initial, mutator, page, transport };
}

async function assertRejectedStaleA(
  page: Page,
  transport: AuthTransport,
  expected: CanonicalBundle,
  staleAccessToken: string,
): Promise<void> {
  await expect.poll(async () => {
    const probe = await page.evaluate(() => (globalThis as typeof globalThis & {
      __authResumeProbe: BrowserProbe;
    }).__authResumeProbe);
    return probe.storageEvents.some(event => (
      event.key === STORAGE_KEY && event.newValue === expected.session
    ));
  }).toBe(true);
  const expiredNoticeCount = await page.getByText('登录已过期').count();
  const probeStart = await page.evaluate(() => (globalThis as typeof globalThis & {
    __authResumeProbe: BrowserProbe;
  }).__authResumeProbe.posts.length);
  transport.releaseRefresh();
  await expect.poll(async () => readCanonical(page)).toEqual(expected);
  const probe = await page.evaluate(() => (globalThis as typeof globalThis & {
    __authResumeProbe: BrowserProbe;
  }).__authResumeProbe);
  expect(JSON.stringify(probe.posts.slice(probeStart))).not.toContain(staleAccessToken);
  await expect(page.getByText('登录已过期')).toHaveCount(expiredNoticeCount);
}

test.describe('SessionManager generation fence', () => {
  test.beforeEach(() => {
    test.skip(!AUTH_CONFIGURED, 'Supabase browser credentials are unavailable');
  });

  test.beforeEach(async ({ context }) => installBrowserProbe(context));

  test('different-owner B survives delayed A refresh', async ({ context }) => {
    const staleResponse = createSession('user-a', 'token-a-late');
    const { mutator, page, transport } = await prepareRace(context, staleResponse);
    const currentB = bundleFor(createSession('user-b', 'token-b'));
    await seedCanonical(mutator, currentB);
    await expect.poll(async () => (await page.evaluate(() => (globalThis as typeof globalThis & {
      __authResumeProbe: BrowserProbe;
    }).__authResumeProbe.storageEvents.length))).toBeGreaterThan(0);
    await assertRejectedStaleA(page, transport, currentB, staleResponse.access_token);
  });

  test('same-owner newer B token survives delayed A refresh', async ({ context }) => {
    const staleResponse = createSession('user-a', 'token-a-late');
    const { mutator, page, transport } = await prepareRace(context, staleResponse);
    const currentB = bundleFor(createSession('user-a', 'token-b'));
    await seedCanonical(mutator, currentB);
    await assertRejectedStaleA(page, transport, currentB, staleResponse.access_token);
  });

  test('sign-out during delayed A refresh remains signed out', async ({ context }) => {
    const staleResponse = createSession('user-a', 'token-a-late');
    const { mutator, page, transport } = await prepareRace(context, staleResponse);
    const signedOut = bundleFor(null);
    await seedCanonical(mutator, signedOut);
    await assertRejectedStaleA(page, transport, signedOut, staleResponse.access_token);
  });

  test('client replacement with restored exact storage rejects the old client continuation', async ({ context }) => {
    const staleResponse = createSession('user-a', 'token-a-late');
    const { initial, mutator, page, transport } = await prepareRace(context, staleResponse);
    await seedCanonical(mutator, bundleFor(null));
    const restored = bundleFor(initial);
    await seedCanonical(mutator, restored);
    await assertRejectedStaleA(page, transport, restored, staleResponse.access_token);
  });

  test('current refresh publishes only after the exact canonical response is persisted', async ({ context }) => {
    const accepted = createSession('user-a', 'token-a-current');
    const { page, transport } = await prepareRace(context, accepted);
    const timelineStart = await page.evaluate(() => (globalThis as typeof globalThis & {
      __authResumeProbe: BrowserProbe;
    }).__authResumeProbe.timeline.length);
    transport.releaseRefresh();
    await expect.poll(async () => readCanonical(page)).toEqual(bundleFor(accepted));
    const probe = await page.evaluate(() => (globalThis as typeof globalThis & {
      __authResumeProbe: BrowserProbe;
    }).__authResumeProbe);
    const timeline = probe.timeline.slice(timelineStart);
    const acceptedPost = timeline.find(event => event.kind === 'post'
      && JSON.stringify(event.payload).includes(accepted.access_token));
    expect(acceptedPost?.canonical?.session).toContain(accepted.access_token);
    await expect(page.getByText('登录已过期')).toHaveCount(0);
  });
});
