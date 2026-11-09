import { expect, test, type BrowserContext, type Page, type Route } from '@playwright/test';

import { environment } from '../src/environments/environment';
import { resolveSupabaseStorageKey } from '../src/services/supabase-client-configuration';
import { ensureLoginModalVisible } from './shared/auth-helpers';

type SignupSession = ReturnType<typeof createSession>;

interface CanonicalBundle {
  session: string | null;
  codeVerifier: string | null;
  user: string | null;
}

interface SignupTransport {
  calls: number;
  completed: number;
  release: () => void;
}

interface BrowserProbe {
  closedChannels: string[];
  consoleMessages: string[];
  openedChannels: string[];
  postCasModalReplacementTriggered: boolean;
  postedChannels: Array<{ name: string; payload: unknown }>;
  storageEvents: Array<{ key: string | null; newValue: string | null }>;
  timeline: Array<{
    kind: 'channel-open' | 'channel-post' | 'storage-remove' | 'storage-set';
    key?: string;
    name?: string;
    payload?: unknown;
    value?: string;
  }>;
}

const PRIMARY_STORAGE_KEY = resolveSupabaseStorageKey(environment.supabaseUrl);
const AUTH_CONFIGURED = Boolean(PRIMARY_STORAGE_KEY)
  && environment.supabaseUrl !== 'YOUR_SUPABASE_URL'
  && environment.supabaseAnonKey !== 'YOUR_SUPABASE_ANON_KEY';
const SIGNUP_STORAGE_PREFIX = 'nanoflow-auth-signup-';

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

async function installSignupTransport(
  context: BrowserContext,
  response: SignupSession | { user: SignupSession['user'] },
  delayed = false,
): Promise<SignupTransport> {
  let release: () => void = () => undefined;
  let gate = Promise.resolve();
  if (delayed) gate = new Promise<void>(resolve => { release = resolve; });
  const transport: SignupTransport = { calls: 0, completed: 0, release };
  await context.route(`${environment.supabaseUrl}/**`, async route => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/auth/v1/signup')) {
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
    if (url.pathname.startsWith('/rest/v1/')) {
      await fulfillJson(route, []);
      return;
    }
    await fulfillJson(route, {});
  });
  return transport;
}

async function installBrowserProbe(context: BrowserContext): Promise<void> {
  await context.addInitScript(({ primaryPrefix }) => {
    let postCasModalReplacementArmed = false;
    const probe: BrowserProbe = {
      closedChannels: [],
      consoleMessages: [],
      openedChannels: [],
      postCasModalReplacementTriggered: false,
      postedChannels: [],
      storageEvents: [],
      timeline: [],
    };
    Object.defineProperty(globalThis, '__authSignupProbe', { value: probe });
    Object.defineProperty(globalThis, '__armAuthSignupPostCasModalReplacement', {
      value: () => { postCasModalReplacementArmed = true; },
    });
    const nativeSetItem = Storage.prototype.setItem;
    const nativeRemoveItem = Storage.prototype.removeItem;
    Storage.prototype.setItem = function(key: string, value: string): void {
      probe.timeline.push({ kind: 'storage-set', key, value });
      nativeSetItem.call(this, key, value);
    };
    Storage.prototype.removeItem = function(key: string): void {
      probe.timeline.push({ kind: 'storage-remove', key });
      nativeRemoveItem.call(this, key);
    };
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
    const NativeBroadcastChannel = globalThis.BroadcastChannel;
    if (!NativeBroadcastChannel) return;
    class ObservedBroadcastChannel extends NativeBroadcastChannel {
      constructor(name: string) {
        super(name);
        probe.openedChannels.push(name);
        probe.timeline.push({ kind: 'channel-open', name });
        if (postCasModalReplacementArmed && name.startsWith(primaryPrefix)) {
          postCasModalReplacementArmed = false;
          probe.postCasModalReplacementTriggered = true;
          (document.elementFromPoint(4, 4) as HTMLElement | null)?.click();
        }
      }

      override close(): void {
        probe.closedChannels.push(this.name);
        super.close();
      }

      override postMessage(payload: unknown): void {
        probe.postedChannels.push({ name: this.name, payload });
        probe.timeline.push({ kind: 'channel-post', name: this.name, payload });
        super.postMessage(payload);
      }
    }
    Object.defineProperty(globalThis, 'BroadcastChannel', { value: ObservedBroadcastChannel });
  }, { primaryPrefix: `${PRIMARY_STORAGE_KEY}-nanoflow-g-` });
}

async function armPostCasModalReplacement(page: Page): Promise<void> {
  await page.evaluate(() => (globalThis as typeof globalThis & {
    __armAuthSignupPostCasModalReplacement: () => void;
  }).__armAuthSignupPostCasModalReplacement());
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

async function readAuthState(page: Page) {
  if (!PRIMARY_STORAGE_KEY) throw new Error('Supabase storage key is unavailable');
  return await page.evaluate(({ storageKey, signupPrefix }) => {
    const signupKeys: string[] = [];
    for (let index = 0; index < sessionStorage.length; index += 1) {
      const key = sessionStorage.key(index);
      if (key?.startsWith(signupPrefix)) signupKeys.push(key);
    }
    return {
      bundle: {
        session: localStorage.getItem(storageKey),
        codeVerifier: localStorage.getItem(`${storageKey}-code-verifier`),
        user: localStorage.getItem(`${storageKey}-user`),
      },
      signupKeys,
    };
  }, { storageKey: PRIMARY_STORAGE_KEY, signupPrefix: SIGNUP_STORAGE_PREFIX });
}

async function readProbe(page: Page): Promise<BrowserProbe> {
  return await page.evaluate(() => (globalThis as typeof globalThis & {
    __authSignupProbe: BrowserProbe;
  }).__authSignupProbe);
}

function primaryChannels(probe: BrowserProbe): string[] {
  const prefix = `${PRIMARY_STORAGE_KEY}-nanoflow-g-`;
  return probe.openedChannels.filter(name => name.startsWith(prefix));
}

async function awaitStableProjectsStartup(page: Page): Promise<void> {
  await expect(page).toHaveURL(/\/#\/projects(?:[/?#]|$)/);
  await expect.poll(async () => primaryChannels(await readProbe(page)).length, {
    message: 'startup primary auth channel was not established',
  }).toBeGreaterThan(0);
}

function primaryChannelsOpenedAfter(probe: BrowserProbe, baseline: readonly string[]): string[] {
  const existing = new Set(baseline);
  return primaryChannels(probe).filter(name => !existing.has(name));
}

function expectDisposedZeroPostAdoptionCandidate(
  probe: BrowserProbe,
  openedAfterBaseline: readonly string[],
): void {
  const candidates = openedAfterBaseline.filter(name =>
    probe.closedChannels.includes(name)
    && !probe.postedChannels.some(entry => entry.name === name));
  expect(candidates).toHaveLength(1);
}

async function submitSignup(page: Page, email: string): Promise<void> {
  await ensureLoginModalVisible(page);
  const switchButton = page.getByRole('button', { name: '没有账号？注册', exact: true });
  if (await switchButton.isVisible().catch(() => false)) await switchButton.click();
  await page.locator('#signup-email').fill(email);
  await page.locator('#signup-password').fill('password-123');
  await page.locator('#signup-confirm-password').fill('password-123');
  await page.locator('[data-testid="login-modal"] form button[type="submit"]').click();
}

function expectAttemptIsolation(
  probe: BrowserProbe,
  options: { accepted?: SignupSession; rejected?: SignupSession; verifier?: string | null } = {},
): void {
  const signupChannels = probe.openedChannels.filter(name => name.startsWith(SIGNUP_STORAGE_PREFIX));
  expect(signupChannels.length).toBeGreaterThanOrEqual(1);
  expect(new Set(signupChannels).size).toBe(signupChannels.length);
  for (const name of signupChannels) expect(probe.closedChannels).toContain(name);
  const primaryPrefix = `${PRIMARY_STORAGE_KEY}-nanoflow-g-`;
  const primaryPosts = probe.postedChannels.filter(entry => entry.name.startsWith(primaryPrefix));
  const rejected = options.rejected;
  if (rejected) {
    expect(JSON.stringify(primaryPosts)).not.toContain(rejected.access_token);
    expect(JSON.stringify(primaryPosts)).not.toContain(rejected.refresh_token);
  }
  if (options.verifier) {
    expect(JSON.stringify(probe.postedChannels)).not.toContain(options.verifier);
    expect(probe.consoleMessages.join('\n')).not.toContain(options.verifier);
  }
  const accepted = options.accepted;
  if (!accepted) return;
  const writeIndex = probe.timeline.findIndex(event => event.kind === 'storage-set'
    && event.key === PRIMARY_STORAGE_KEY && event.value?.includes(accepted.access_token));
  expect(writeIndex).toBeGreaterThanOrEqual(0);
  for (const [index, event] of probe.timeline.entries()) {
    if (event.kind === 'channel-post'
      && event.name?.startsWith(primaryPrefix)
      && JSON.stringify(event.payload).includes(accepted.access_token)) {
      expect(index).toBeGreaterThan(writeIndex);
    }
  }
}

test('publishes one isolated signup only after canonical CAS and cleans its attempt runtime', async ({ context, page }) => {
  test.skip(!AUTH_CONFIGURED, 'Supabase browser credentials are unavailable');
  const sessionA = createSession('signup-owner-a', 'signup-a');
  await installBrowserProbe(context);
  const transport = await installSignupTransport(context, sessionA);
  await page.goto('/');
  await awaitStableProjectsStartup(page);
  await seedCanonicalBundle(page, { session: null, codeVerifier: null, user: null });
  const primaryChannelBaseline = primaryChannels(await readProbe(page));

  await submitSignup(page, sessionA.user.email);
  await expect.poll(async () => (await readAuthState(page)).bundle.session)
    .toBe(JSON.stringify(sessionA));
  await expect(page.locator('[data-testid="login-modal"]')).toBeHidden();

  expect(transport.calls).toBe(1);
  const state = await readAuthState(page);
  expect(state.bundle).toEqual({
    session: JSON.stringify(sessionA),
    codeVerifier: null,
    user: JSON.stringify(sessionA.user),
  });
  expect(state.signupKeys).toEqual([]);
  const probe = await readProbe(page);
  const adoptionChannels = primaryChannelsOpenedAfter(probe, primaryChannelBaseline);
  expect(adoptionChannels.length).toBeGreaterThanOrEqual(2);
  expectDisposedZeroPostAdoptionCandidate(probe, adoptionChannels);
  expectAttemptIsolation(probe, { accepted: sessionA });
});

for (const [label, sessionB] of [
  ['different-owner', createSession('signup-owner-b', 'primary-b')],
  ['same-owner-newer-token', createSession('signup-owner-a', 'primary-a-newer')],
] as const) {
  test(`preserves delayed ${label} B and its cross-tab storage event`, async ({ context }) => {
    test.skip(!AUTH_CONFIGURED, 'Supabase browser credentials are unavailable');
    const sessionA = createSession('signup-owner-a', 'signup-a');
    await installBrowserProbe(context);
    const transport = await installSignupTransport(context, sessionA, true);
    const pageA = await context.newPage();
    const pageB = await context.newPage();
    await Promise.all([pageA.goto('/'), pageB.goto('/')]);
    await Promise.all([awaitStableProjectsStartup(pageA), awaitStableProjectsStartup(pageB)]);
    await seedCanonicalBundle(pageA, { session: null, codeVerifier: null, user: null });

    await submitSignup(pageA, sessionA.user.email);
    await expect.poll(() => transport.calls).toBe(1);
    const bundleB = {
      session: JSON.stringify(sessionB),
      codeVerifier: 'verifier-b',
      user: JSON.stringify(sessionB.user),
    };
    await seedCanonicalBundle(pageB, bundleB);
    transport.release();

    await expect.poll(async () => (await readAuthState(pageA)).signupKeys).toEqual([]);
    expect((await readAuthState(pageA)).bundle).toEqual(bundleB);
    await expect(pageA.locator('[data-testid="login-modal"]')).toBeVisible();
    await expect(pageA.locator('#signup-email')).toHaveValue(sessionA.user.email);
    const probe = await readProbe(pageA);
    expect(probe.storageEvents.some(event => event.key === PRIMARY_STORAGE_KEY
      && event.newValue === JSON.stringify(sessionB))).toBe(true);
    expectAttemptIsolation(probe, { rejected: sessionA });
  });
}

test('post-CAS primary restart revokes replaced signup before INITIAL_SESSION publication', async ({ context, page }) => {
  test.skip(!AUTH_CONFIGURED, 'Supabase browser credentials are unavailable');
  const sessionA = createSession('signup-owner-a', 'signup-a');
  await installBrowserProbe(context);
  const transport = await installSignupTransport(context, sessionA, true);
  await page.goto('/');
  await awaitStableProjectsStartup(page);
  await seedCanonicalBundle(page, { session: null, codeVerifier: null, user: null });
  const primaryChannelBaseline = primaryChannels(await readProbe(page));

  await submitSignup(page, sessionA.user.email);
  await expect.poll(() => transport.calls).toBe(1);
  await armPostCasModalReplacement(page);
  transport.release();
  await expect.poll(async () => (await readProbe(page)).postCasModalReplacementTriggered).toBe(true);
  await expect(page.locator('[data-testid="login-modal"]')).toBeHidden();
  await ensureLoginModalVisible(page);
  const switchButton = page.getByRole('button', { name: '没有账号？注册', exact: true });
  if (await switchButton.isVisible().catch(() => false)) await switchButton.click();
  await page.locator('#signup-email').fill('replacement@example.com');

  await expect.poll(async () => (await readAuthState(page)).signupKeys).toEqual([]);
  await expect(page.locator('#signup-email')).toHaveValue('replacement@example.com');
  expect((await readAuthState(page)).bundle).toEqual({
    session: null, codeVerifier: null, user: null,
  });
  const probe = await readProbe(page);
  const adoptionChannels = primaryChannelsOpenedAfter(probe, primaryChannelBaseline);
  expect(adoptionChannels).toHaveLength(1);
  expectDisposedZeroPostAdoptionCandidate(probe, adoptionChannels);
  expectAttemptIsolation(probe, { rejected: sessionA });
});

test('confirmation signup transfers only its exact verifier and keeps the modal open', async ({ context, page }) => {
  test.skip(!AUTH_CONFIGURED, 'Supabase browser credentials are unavailable');
  const sessionA = createSession('signup-owner-a', 'signup-confirmation-a');
  await installBrowserProbe(context);
  await installSignupTransport(context, { user: sessionA.user });
  await page.goto('/');
  await awaitStableProjectsStartup(page);
  await seedCanonicalBundle(page, { session: null, codeVerifier: null, user: null });

  await submitSignup(page, sessionA.user.email);
  await expect(page.getByText('注册成功！请查收邮件并点击验证链接完成注册。', { exact: true }))
    .toBeVisible();

  const state = await readAuthState(page);
  expect(state.bundle.session).toBeNull();
  expect(state.bundle.user).toBeNull();
  expect(state.bundle.codeVerifier).toBeTruthy();
  expect(state.signupKeys).toEqual([]);
  expectAttemptIsolation(await readProbe(page), { verifier: state.bundle.codeVerifier });
});

test('late response after the immutable deadline cannot publish or clear the replacement modal', async ({ context, page }) => {
  test.skip(!AUTH_CONFIGURED, 'Supabase browser credentials are unavailable');
  test.setTimeout(45_000);
  const sessionA = createSession('signup-owner-a', 'signup-timeout-a');
  await installBrowserProbe(context);
  const transport = await installSignupTransport(context, sessionA, true);
  await page.goto('/');
  await awaitStableProjectsStartup(page);
  await seedCanonicalBundle(page, { session: null, codeVerifier: null, user: null });

  await submitSignup(page, sessionA.user.email);
  await expect.poll(() => transport.calls).toBe(1);
  await expect(page.locator('[data-testid="login-modal"] form button[type="submit"]'))
    .toBeEnabled({ timeout: 20_000 });
  transport.release();

  await expect.poll(() => transport.completed).toBe(1);
  await expect.poll(async () => (await readAuthState(page)).signupKeys).toEqual([]);
  expect((await readAuthState(page)).bundle).toEqual({
    session: null, codeVerifier: null, user: null,
  });
  await expect(page.locator('[data-testid="login-modal"]')).toBeVisible();
  expectAttemptIsolation(await readProbe(page), { rejected: sessionA });
});
