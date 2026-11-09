import { expect, test, type BrowserContext, type Page, type Route } from '@playwright/test';

import { environment } from '../src/environments/environment';
import { resolveSupabaseStorageKey } from '../src/services/supabase-client-configuration';

type Session = ReturnType<typeof createSession>;

interface AuthTransportProbe {
  releaseExchange: () => void;
  tokenBodies: Array<Record<string, unknown>>;
  tokenCalls: number;
}

interface BrowserProbe {
  closedChannels: string[];
  consoleMessages: string[];
  openedChannels: string[];
  postedChannels: Array<{ name: string; payload: unknown }>;
  storageEvents: Array<{ key: string | null; newValue: string | null }>;
  timeline: Array<{
    kind: 'channel-open' | 'channel-post' | 'storage-remove' | 'storage-set';
    name?: string;
    key?: string;
    payload?: unknown;
    value?: string;
  }>;
}

interface CanonicalBundle {
  session: string | null;
  codeVerifier: string | null;
  user: string | null;
}

const PRIMARY_STORAGE_KEY = resolveSupabaseStorageKey(environment.supabaseUrl);
const AUTH_CONFIGURED = Boolean(PRIMARY_STORAGE_KEY)
  && environment.supabaseUrl !== 'YOUR_SUPABASE_URL'
  && environment.supabaseAnonKey !== 'YOUR_SUPABASE_ANON_KEY';
const SUPABASE_ORIGIN = new URL(environment.supabaseUrl).origin;
const CALLBACK_CLAIM_PREFIX = 'nanoflow:auth-callback:v1:claim:';

function base64Url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function createSession(ownerId: string, tokenId: string) {
  const now = new Date().toISOString();
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
  const issuedAt = Math.floor(Date.now() / 1000);
  const accessToken = [
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
  ].join('.');
  return {
    access_token: accessToken,
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

async function installAuthTransport(
  context: BrowserContext,
  callbackSession: Session,
  delayed = false,
): Promise<AuthTransportProbe> {
  let releaseExchange: () => void = () => undefined;
  let exchangeGate = Promise.resolve();
  if (delayed) {
    exchangeGate = new Promise<void>(resolve => { releaseExchange = resolve; });
  }
  const probe: AuthTransportProbe = { releaseExchange, tokenBodies: [], tokenCalls: 0 };

  await context.route(`${SUPABASE_ORIGIN}/**`, async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (!url.pathname.startsWith('/auth/v1/')) {
      await route.fulfill({ status: 503, body: 'Unmocked Supabase request blocked by test' });
      return;
    }
    if (url.pathname.endsWith('/token') && url.searchParams.get('grant_type') === 'pkce') {
      probe.tokenCalls += 1;
      probe.tokenBodies.push(request.postDataJSON() as Record<string, unknown>);
      await exchangeGate;
      await fulfillJson(route, callbackSession);
      return;
    }
    if (url.pathname.endsWith('/user')) {
      await fulfillJson(route, callbackSession.user);
      return;
    }
    if (url.pathname.endsWith('/logout')) {
      await route.fulfill({ status: 204, body: '' });
      return;
    }
    await fulfillJson(route, {});
  });
  return probe;
}

async function installBrowserProbe(
  context: BrowserContext,
  options: { failFirstCallbackScrub?: boolean } = {},
): Promise<void> {
  await context.addInitScript(({ failFirstCallbackScrub }) => {
    const probe: BrowserProbe = {
      closedChannels: [],
      consoleMessages: [],
      openedChannels: [],
      postedChannels: [],
      storageEvents: [],
      timeline: [],
    };
    Object.defineProperty(globalThis, '__authCallbackProbe', { value: probe });
    const nativeSetItem = Storage.prototype.setItem;
    const nativeRemoveItem = Storage.prototype.removeItem;
    Storage.prototype.setItem = function(key: string, value: string): void {
      if (this === localStorage) probe.timeline.push({ kind: 'storage-set', key, value });
      nativeSetItem.call(this, key, value);
    };
    Storage.prototype.removeItem = function(key: string): void {
      if (this === localStorage) probe.timeline.push({ kind: 'storage-remove', key });
      nativeRemoveItem.call(this, key);
    };
    localStorage.setItem('nanoflow.verbose', 'true');

    for (const level of ['debug', 'error', 'info', 'log', 'warn'] as const) {
      const original = console[level].bind(console);
      console[level] = (...args: unknown[]) => {
        probe.consoleMessages.push(args.map(value =>
          typeof value === 'string' ? value : JSON.stringify(value)).join(' '));
        original(...args);
      };
    }

    globalThis.addEventListener('storage', event => {
      probe.storageEvents.push({ key: event.key, newValue: event.newValue });
    });

    if (failFirstCallbackScrub) {
      const nativeReplaceState = history.replaceState.bind(history);
      let failed = false;
      Object.defineProperty(history, 'replaceState', {
        configurable: true,
        value: (...args: Parameters<History['replaceState']>) => {
          const callbackRoute = location.pathname.replace(/\/+$/, '') === '/auth/callback'
            || location.hash.startsWith('#/auth/callback');
          if (!failed && callbackRoute) {
            failed = true;
            throw new Error('callback scrub unavailable');
          }
          return nativeReplaceState(...args);
        },
      });
    }

    const NativeBroadcastChannel = globalThis.BroadcastChannel;
    if (!NativeBroadcastChannel) return;
    class ObservedBroadcastChannel extends NativeBroadcastChannel {
      constructor(name: string) {
        super(name);
        probe.openedChannels.push(name);
        probe.timeline.push({ kind: 'channel-open', name });
      }

      override close(): void {
        probe.closedChannels.push(this.name);
        super.close();
      }

      override postMessage(message: unknown): void {
        probe.postedChannels.push({ name: this.name, payload: message });
        probe.timeline.push({ kind: 'channel-post', name: this.name, payload: message });
        super.postMessage(message);
      }
    }
    Object.defineProperty(globalThis, 'BroadcastChannel', { value: ObservedBroadcastChannel });
  }, options);
}

async function seedCanonicalBundle(page: Page, next: CanonicalBundle): Promise<void> {
  if (!PRIMARY_STORAGE_KEY) throw new Error('Supabase storage key is unavailable');
  await page.evaluate(async ({ storageKey, nextBundle }) => {
    const authority = (globalThis as typeof globalThis & {
      __NANOFLOW_AUTH_CANONICAL_STORAGE__?: {
        compareAndSwap(input: unknown): Promise<string>;
        peekBundle(key: string): CanonicalBundle;
      };
    }).__NANOFLOW_AUTH_CANONICAL_STORAGE__;
    if (!authority) throw new Error('Canonical auth authority is unavailable');
    await authority.compareAndSwap({
      storageKey,
      expected: authority.peekBundle(storageKey),
      next: nextBundle,
    });
  }, { storageKey: PRIMARY_STORAGE_KEY, nextBundle: next });
}

async function readCanonicalState(page: Page) {
  if (!PRIMARY_STORAGE_KEY) throw new Error('Supabase storage key is unavailable');
  return await page.evaluate(({ storageKey, claimPrefix }) => {
    const callbackSessionKeys: string[] = [];
    for (let index = 0; index < sessionStorage.length; index += 1) {
      const key = sessionStorage.key(index);
      if (key && (key.startsWith(claimPrefix) || key.startsWith('nanoflow-auth-callback-'))) {
        callbackSessionKeys.push(key);
      }
    }
    return {
      bundle: {
        session: localStorage.getItem(storageKey),
        codeVerifier: localStorage.getItem(`${storageKey}-code-verifier`),
        user: localStorage.getItem(`${storageKey}-user`),
      },
      callbackSessionKeys,
    };
  }, { storageKey: PRIMARY_STORAGE_KEY, claimPrefix: CALLBACK_CLAIM_PREFIX });
}

async function replaceCanonicalDuringExchange(page: Page, next: CanonicalBundle): Promise<void> {
  await seedCanonicalBundle(page, next);
}

async function readBrowserProbe(page: Page): Promise<BrowserProbe> {
  return await page.evaluate(() => (globalThis as typeof globalThis & {
    __authCallbackProbe: BrowserProbe;
  }).__authCallbackProbe);
}

async function callbackOutcome(page: Page): Promise<'authenticated' | 'conflict' | 'invalid' | 'loading'> {
  if (await page.getByText('登录已确认', { exact: true }).isVisible().catch(() => false)) {
    return 'authenticated';
  }
  if (await page.getByText('当前登录会话已保留', { exact: true }).isVisible().catch(() => false)) {
    return 'conflict';
  }
  if (await page.getByText('登录链接无效或已过期', { exact: true }).isVisible().catch(() => false)) {
    return 'invalid';
  }
  return 'loading';
}

function expectChannelPublication(
  probe: BrowserProbe,
  options: { acceptedSession?: Session; rejectedSecrets?: string[]; verifierSecrets?: string[] } = {},
): void {
  const callbackChannels = probe.openedChannels.filter(name =>
    name.startsWith('nanoflow-auth-callback-'));
  expect(callbackChannels).toEqual([]);
  const callbackPosts = probe.postedChannels.filter(entry =>
    entry.name.startsWith('nanoflow-auth-callback-'));
  expect(callbackPosts).toEqual([]);
  const primaryPrefix = `${PRIMARY_STORAGE_KEY}-nanoflow-g-`;
  const primaryPosts = probe.postedChannels.filter(entry => entry.name.startsWith(primaryPrefix));
  const allPosted = JSON.stringify(probe.postedChannels);
  for (const forbidden of ['code_verifier', 'verifier', ...(options.verifierSecrets ?? [])]) {
    expect(allPosted).not.toContain(forbidden);
  }
  for (const forbidden of options.rejectedSecrets ?? []) {
    expect(JSON.stringify(primaryPosts)).not.toContain(forbidden);
  }
  const acceptedSession = options.acceptedSession;
  if (!acceptedSession) {
    expect(primaryPosts).toEqual([]);
    return;
  }
  const canonicalWriteIndex = probe.timeline.findIndex(event =>
    event.kind === 'storage-set'
    && event.key === PRIMARY_STORAGE_KEY
    && event.value?.includes(acceptedSession.access_token));
  expect(canonicalWriteIndex).toBeGreaterThanOrEqual(0);
  const acceptedPosts = probe.timeline
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => event.kind === 'channel-post'
      && event.name?.startsWith(primaryPrefix)
      && JSON.stringify(event.payload).includes(acceptedSession.access_token));
  for (const post of acceptedPosts) expect(post.index).toBeGreaterThan(canonicalWriteIndex);
}

test('publishes one empty-canonical PKCE callback and rejects its reload replay', async ({ context, page }) => {
  test.skip(!AUTH_CONFIGURED, 'Supabase browser credentials are unavailable');
  const sessionA = createSession('owner-a', 'callback-a');
  await installBrowserProbe(context);
  const transport = await installAuthTransport(context, sessionA);
  await page.goto('/');
  await seedCanonicalBundle(page, { session: null, codeVerifier: 'browser-verifier-a', user: null });

  await page.goto('/auth/callback?code=browser-code-a');
  await expect(page.getByText('登录已确认', { exact: true })).toBeVisible();

  expect(transport.tokenCalls).toBe(1);
  expect(transport.tokenBodies).toEqual([expect.objectContaining({
    auth_code: 'browser-code-a',
    code_verifier: 'browser-verifier-a',
  })]);
  const state = await readCanonicalState(page);
  expect(state.bundle.session).toBe(JSON.stringify(sessionA));
  expect(state.bundle.codeVerifier).toBeNull();
  expect(JSON.parse(state.bundle.user ?? '{}')).toMatchObject({ id: 'owner-a' });
  expect(state.callbackSessionKeys).toEqual([]);
  const probe = await readBrowserProbe(page);
  expectChannelPublication(probe, {
    acceptedSession: sessionA,
    verifierSecrets: ['browser-verifier-a'],
  });
  expect(probe.consoleMessages.join('\n')).not.toContain('browser-code-a');
  expect(probe.consoleMessages.join('\n')).not.toContain('browser-verifier-a');

  await page.reload();
  await expect(page.getByText('登录链接无效或已过期', { exact: true })).toBeVisible();
  expect(transport.tokenCalls).toBe(1);
  expect((await readCanonicalState(page)).bundle.session).toBe(JSON.stringify(sessionA));
});

test('preserves a preexisting different-owner primary session without an exchange', async ({ context, page }) => {
  test.skip(!AUTH_CONFIGURED, 'Supabase browser credentials are unavailable');
  const sessionA = createSession('owner-a', 'callback-a');
  const sessionB = createSession('owner-b', 'primary-b');
  await installBrowserProbe(context);
  const transport = await installAuthTransport(context, sessionA);
  await page.goto('/');
  await seedCanonicalBundle(page, {
    session: JSON.stringify(sessionB),
    codeVerifier: 'browser-verifier-a',
    user: JSON.stringify(sessionB.user),
  });

  await page.goto('/auth/callback?code=browser-code-a');
  await expect(page.getByText('当前登录会话已保留', { exact: true })).toBeVisible();

  expect(transport.tokenCalls).toBe(0);
  const state = await readCanonicalState(page);
  expect(state.bundle).toEqual({
    session: JSON.stringify(sessionB),
    codeVerifier: null,
    user: JSON.stringify(sessionB.user),
  });
  expect(state.callbackSessionKeys).toEqual([]);
  expectChannelPublication(await readBrowserProbe(page), {
    rejectedSecrets: [sessionA.access_token, sessionA.refresh_token],
    verifierSecrets: ['browser-verifier-a'],
  });
});

test('preserves a delayed same-owner newer token and its cross-tab storage event', async ({ context }) => {
  test.skip(!AUTH_CONFIGURED, 'Supabase browser credentials are unavailable');
  const sessionA = createSession('owner-a', 'callback-a');
  const sessionB = createSession('owner-a', 'primary-b-new');
  await installBrowserProbe(context);
  const transport = await installAuthTransport(context, sessionA, true);
  const pageA = await context.newPage();
  const pageB = await context.newPage();
  await Promise.all([pageA.goto('/'), pageB.goto('/')]);
  await seedCanonicalBundle(pageA, { session: null, codeVerifier: 'browser-verifier-a', user: null });

  await pageA.goto('/auth/callback?code=browser-code-a');
  await expect.poll(() => transport.tokenCalls).toBe(1);
  await replaceCanonicalDuringExchange(pageB, {
    session: JSON.stringify(sessionB),
    codeVerifier: 'browser-verifier-b',
    user: JSON.stringify(sessionB.user),
  });
  transport.releaseExchange();

  await expect(pageA.getByText('当前登录会话已保留', { exact: true })).toBeVisible();
  const state = await readCanonicalState(pageA);
  expect(state.bundle).toEqual({
    session: JSON.stringify(sessionB),
    codeVerifier: 'browser-verifier-b',
    user: JSON.stringify(sessionB.user),
  });
  expect(state.callbackSessionKeys).toEqual([]);
  const probe = await readBrowserProbe(pageA);
  expect(probe.storageEvents.some(event => event.key === PRIMARY_STORAGE_KEY
    && event.newValue === JSON.stringify(sessionB))).toBe(true);
  expectChannelPublication(probe, {
    rejectedSecrets: [sessionA.access_token, sessionA.refresh_token],
    verifierSecrets: ['browser-verifier-a'],
  });
});

test('allows exactly one of two callback tabs to claim and exchange one verifier', async ({ context }) => {
  test.skip(!AUTH_CONFIGURED, 'Supabase browser credentials are unavailable');
  const sessionA = createSession('owner-a', 'callback-a');
  await installBrowserProbe(context);
  const transport = await installAuthTransport(context, sessionA);
  const pageA = await context.newPage();
  const pageB = await context.newPage();
  await Promise.all([pageA.goto('/'), pageB.goto('/')]);
  await seedCanonicalBundle(pageA, { session: null, codeVerifier: 'browser-verifier-a', user: null });

  await Promise.all([
    pageA.goto('/auth/callback?code=browser-code-a'),
    pageB.goto('/auth/callback?code=browser-code-a'),
  ]);
  await expect.poll(async () => [await callbackOutcome(pageA), await callbackOutcome(pageB)].sort())
    .toEqual(['authenticated', 'invalid']);
  const outcomes = await Promise.all([callbackOutcome(pageA), callbackOutcome(pageB)]);

  expect(transport.tokenCalls).toBe(1);
  expect((await readCanonicalState(pageA)).bundle.session).toBe(JSON.stringify(sessionA));
  expect((await readCanonicalState(pageA)).callbackSessionKeys).toEqual([]);
  expect((await readCanonicalState(pageB)).callbackSessionKeys).toEqual([]);
  const probes = [await readBrowserProbe(pageA), await readBrowserProbe(pageB)];
  const winnerIndex = outcomes.indexOf('authenticated');
  expectChannelPublication(probes[winnerIndex], {
    acceptedSession: sessionA,
    verifierSecrets: ['browser-verifier-a'],
  });
  expectChannelPublication(probes[1 - winnerIndex], {
    rejectedSecrets: [sessionA.access_token, sessionA.refresh_token],
    verifierSecrets: ['browser-verifier-a'],
  });
});

test('fences a late exchange after route cancellation and preserves newer owner C', async ({ context }) => {
  test.skip(!AUTH_CONFIGURED, 'Supabase browser credentials are unavailable');
  const sessionA = createSession('owner-a', 'callback-a');
  const sessionC = createSession('owner-c', 'primary-c');
  await installBrowserProbe(context);
  const transport = await installAuthTransport(context, sessionA, true);
  const pageA = await context.newPage();
  const pageC = await context.newPage();
  await Promise.all([pageA.goto('/'), pageC.goto('/')]);
  await seedCanonicalBundle(pageA, { session: null, codeVerifier: 'browser-verifier-a', user: null });

  await pageA.goto('/auth/callback?code=browser-code-a');
  await expect.poll(() => transport.tokenCalls).toBe(1);
  await pageA.goto('/#/projects');
  await replaceCanonicalDuringExchange(pageC, {
    session: JSON.stringify(sessionC),
    codeVerifier: 'browser-verifier-c',
    user: JSON.stringify(sessionC.user),
  });
  transport.releaseExchange();

  await expect.poll(async () => (await readCanonicalState(pageA)).callbackSessionKeys).toEqual([]);
  const state = await readCanonicalState(pageA);
  expect(state.bundle).toEqual({
    session: JSON.stringify(sessionC),
    codeVerifier: 'browser-verifier-c',
    user: JSON.stringify(sessionC.user),
  });
  expect(state.bundle.session).not.toContain(sessionA.access_token);
  expect(await pageA.getByText('登录已确认', { exact: true }).isVisible().catch(() => false)).toBe(false);
  expectChannelPublication(await readBrowserProbe(pageA), {
    rejectedSecrets: [sessionA.access_token, sessionA.refresh_token],
    verifierSecrets: ['browser-verifier-a'],
  });
});

test('blocks scrub failure without exchange, canonical mutation, or callback secret telemetry', async ({ context, page }) => {
  test.skip(!AUTH_CONFIGURED, 'Supabase browser credentials are unavailable');
  const sessionA = createSession('owner-a', 'callback-a');
  await installBrowserProbe(context, { failFirstCallbackScrub: true });
  const transport = await installAuthTransport(context, sessionA);
  await page.goto('/');
  const initial = { session: null, codeVerifier: 'browser-verifier-a', user: null };
  await seedCanonicalBundle(page, initial);

  await page.goto('/auth/callback?code=browser-code-a');
  await expect.poll(async () => page.evaluate(() => {
    const capture = Object.getOwnPropertyDescriptor(
      globalThis,
      '__NANOFLOW_AUTH_CALLBACK_CAPTURE__',
    )?.value as { blocked?: boolean } | undefined;
    return capture?.blocked === true;
  })).toBe(true);

  expect(transport.tokenCalls).toBe(0);
  expect((await readCanonicalState(page)).bundle).toEqual(initial);
  const capture = await page.evaluate(() => {
    const value = Object.getOwnPropertyDescriptor(
      globalThis,
      '__NANOFLOW_AUTH_CALLBACK_CAPTURE__',
    )?.value as { blocked: boolean; claimCode(): string | null } | undefined;
    return value ? { blocked: value.blocked, code: value.claimCode() } : null;
  });
  expect(capture).toEqual({ blocked: true, code: null });
  const probe = await readBrowserProbe(page);
  expect(probe.consoleMessages.join('\n')).not.toContain('browser-code-a');
  expect(probe.consoleMessages.join('\n')).not.toContain('browser-verifier-a');
  expectChannelPublication(probe, {
    rejectedSecrets: [sessionA.access_token, sessionA.refresh_token],
    verifierSecrets: ['browser-verifier-a'],
  });
});
