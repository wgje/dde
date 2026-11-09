import { expect, test, type BrowserContext, type Page, type Route } from '@playwright/test';

import { environment } from '../src/environments/environment';
import { resolveSupabaseStorageKey } from '../src/services/supabase-client-configuration';

type Session = ReturnType<typeof createSession>;

interface AuthTransportProbe {
  releaseExchange: () => void;
  setPrimarySession: (session: Session) => void;
  tokenBodies: Array<Record<string, unknown>>;
  tokenCalls: number;
  updateCalls: number;
}

const RECOVERY_PREFIX = 'nanoflow:auth-recovery:v1:';
const PRIMARY_STORAGE_KEY = resolveSupabaseStorageKey(environment.supabaseUrl);
const AUTH_CONFIGURED = Boolean(PRIMARY_STORAGE_KEY)
  && environment.supabaseUrl !== 'YOUR_SUPABASE_URL'
  && environment.supabaseAnonKey !== 'YOUR_SUPABASE_ANON_KEY';
const SUPABASE_ORIGIN = new URL(environment.supabaseUrl).origin;
const OWNER_ID = '10000000-0000-4000-8000-000000000001';

function base64Url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function createJwt(subject: string, tokenId: string): string {
  const now = Math.floor(Date.now() / 1000);
  return [
    base64Url({ alg: 'HS256', typ: 'JWT' }),
    base64Url({
      aud: 'authenticated',
      exp: now + 3600,
      iat: now,
      role: 'authenticated',
      session_id: tokenId,
      sub: subject,
    }),
    'test-signature',
  ].join('.');
}

function createSession(tokenId: string) {
  const now = new Date().toISOString();
  const user = {
    id: OWNER_ID,
    aud: 'authenticated',
    role: 'authenticated',
    email: 'recovery@example.com',
    email_confirmed_at: now,
    phone: '',
    app_metadata: { provider: 'email', providers: ['email'] },
    user_metadata: {},
    identities: [],
    created_at: now,
    updated_at: now,
  };
  return {
    access_token: createJwt(OWNER_ID, tokenId),
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    refresh_token: `refresh-${tokenId}`,
    user,
  };
}

async function fulfillJson(route: Route, body: unknown): Promise<void> {
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
}

async function installAuthTransport(
  context: BrowserContext,
  recoverySession: Session,
  initialPrimarySession: Session,
): Promise<AuthTransportProbe> {
  let releaseExchange!: () => void;
  const exchangeGate = new Promise<void>(resolve => {
    releaseExchange = resolve;
  });
  let primarySession = initialPrimarySession;
  const probe: AuthTransportProbe = {
    releaseExchange,
    setPrimarySession: session => { primarySession = session; },
    tokenBodies: [],
    tokenCalls: 0,
    updateCalls: 0,
  };

  await context.route(`${SUPABASE_ORIGIN}/**`, async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (!url.pathname.startsWith('/auth/v1/')) {
      await route.fulfill({ status: 503, body: 'Unmocked Supabase request blocked by test' });
      return;
    }
    if (url.pathname.endsWith('/token')) {
      const body = request.postDataJSON() as Record<string, unknown>;
      if (url.searchParams.get('grant_type') === 'pkce') {
        probe.tokenCalls += 1;
        probe.tokenBodies.push(body);
        await exchangeGate;
        await fulfillJson(route, recoverySession);
        return;
      }
      await fulfillJson(route, primarySession);
      return;
    }
    if (url.pathname.endsWith('/user')) {
      if (request.method() === 'PUT') probe.updateCalls += 1;
      await fulfillJson(route, recoverySession.user);
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

async function installBrowserProbe(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    const state = {
      openedChannels: [] as string[],
      closedChannels: [] as string[],
      postedChannels: [] as string[],
      storageEvents: [] as Array<{ key: string | null; newValue: string | null }>,
    };
    Object.defineProperty(globalThis, '__authRecoveryProbe', { value: state });
    globalThis.addEventListener('storage', event => {
      state.storageEvents.push({ key: event.key, newValue: event.newValue });
    });

    const NativeBroadcastChannel = globalThis.BroadcastChannel;
    if (!NativeBroadcastChannel) return;
    class ObservedBroadcastChannel extends NativeBroadcastChannel {
      constructor(name: string) {
        super(name);
        state.openedChannels.push(name);
      }

      override close(): void {
        state.closedChannels.push(this.name);
        super.close();
      }

      override postMessage(message: unknown): void {
        state.postedChannels.push(this.name);
        super.postMessage(message);
      }
    }
    Object.defineProperty(globalThis, 'BroadcastChannel', { value: ObservedBroadcastChannel });
  });
}

async function seedCanonicalSession(page: Page, session: Session): Promise<void> {
  if (!PRIMARY_STORAGE_KEY) throw new Error('Supabase storage key is unavailable');
  await page.evaluate(async ({ storageKey, serializedSession }) => {
    const authority = (globalThis as typeof globalThis & {
      __NANOFLOW_AUTH_CANONICAL_STORAGE__?: {
        compareAndSwap: (input: unknown) => Promise<string>;
        peekBundle: (key: string) => { session: string | null; codeVerifier: string | null; user: string | null };
      };
    }).__NANOFLOW_AUTH_CANONICAL_STORAGE__;
    if (!authority) throw new Error('Canonical auth authority is unavailable');
    const expected = authority.peekBundle(storageKey);
    await authority.compareAndSwap({
      storageKey,
      expected,
      next: { ...expected, session: serializedSession },
    });
  }, { storageKey: PRIMARY_STORAGE_KEY, serializedSession: JSON.stringify(session) });
}

async function seedIssuedRecovery(page: Page, nonce: string, requestStorageKey: string): Promise<void> {
  await page.evaluate(({ recoveryNonce, storageKey, prefix }) => {
    const now = Date.now();
    localStorage.setItem(`${prefix}ledger:${recoveryNonce}`, JSON.stringify({
      version: 1,
      nonce: recoveryNonce,
      requestStorageKey: storageKey,
      state: 'issued',
      issuedAt: now,
      expiresAt: now + 60 * 60 * 1000,
    }));
    localStorage.setItem(`${storageKey}-code-verifier`, JSON.stringify('browser-verifier/recovery'));
  }, { recoveryNonce: nonce, storageKey: requestStorageKey, prefix: RECOVERY_PREFIX });
}

async function readProbe(page: Page) {
  return await page.evaluate(() => (globalThis as typeof globalThis & {
    __authRecoveryProbe: {
      openedChannels: string[];
      closedChannels: string[];
      postedChannels: string[];
      storageEvents: Array<{ key: string | null; newValue: string | null }>;
    };
  }).__authRecoveryProbe);
}

async function awaitStableStartup(page: Page): Promise<void> {
  if (!PRIMARY_STORAGE_KEY) throw new Error('Supabase storage key is unavailable');
  const prefix = `${PRIMARY_STORAGE_KEY}-nanoflow-g-`;
  await expect.poll(async () => (await readProbe(page)).openedChannels
    .some(name => name.startsWith(prefix))).toBe(true);
}

async function callbackState(page: Page): Promise<'loading' | 'valid' | 'invalid'> {
  return page.locator('h2').evaluateAll(headings => {
    const labels = headings.map(heading => heading.textContent?.trim());
    if (labels.includes('设置新密码')) return 'valid';
    if (labels.includes('链接无效')) return 'invalid';
    return 'loading';
  });
}

test('isolates a two-tab PKCE recovery from a newer same-owner primary session', async ({ context }) => {
  test.skip(!AUTH_CONFIGURED, 'Supabase browser credentials are unavailable');
  const primaryB = createSession('primary-b');
  const primaryB2 = createSession('primary-b2');
  const recoveryA = createSession('recovery-a');
  const nonce = 'browser-recovery-nonce-a';
  const requestStorageKey = `${RECOVERY_PREFIX}request:${nonce}`;
  const callback = `/#/reset-password?recovery_nonce=${nonce}&code=browser-code-a`;
  await installBrowserProbe(context);
  const transport = await installAuthTransport(context, recoveryA, primaryB);
  const pageA = await context.newPage();
  const pageB = await context.newPage();
  await Promise.all([pageA.goto('/#/projects'), pageB.goto('/#/projects')]);
  await Promise.all([awaitStableStartup(pageA), awaitStableStartup(pageB)]);
  await seedCanonicalSession(pageA, primaryB);
  await expect.poll(async () => (await readProbe(pageB)).storageEvents
    .some(event => event.key === PRIMARY_STORAGE_KEY
      && event.newValue?.includes(primaryB.access_token))).toBe(true);
  await seedIssuedRecovery(pageA, nonce, requestStorageKey);

  await Promise.all([pageA.goto(callback), pageB.goto(callback)]);
  await expect.poll(() => transport.tokenCalls).toBe(1);
  transport.setPrimarySession(primaryB2);
  await seedCanonicalSession(pageA, primaryB2);
  await expect.poll(async () => (await readProbe(pageB)).storageEvents.some(event => (
    event.key === PRIMARY_STORAGE_KEY && event.newValue?.includes(primaryB2.access_token)
  ))).toBe(true);
  transport.releaseExchange();

  await expect.poll(async () => [await callbackState(pageA), await callbackState(pageB)].sort(), {
    timeout: 45_000,
  })
    .toEqual(['invalid', 'valid']);
  expect(transport.tokenBodies).toEqual([expect.objectContaining({
    auth_code: 'browser-code-a',
    code_verifier: 'browser-verifier',
  })]);
  const winner = await callbackState(pageA) === 'valid' ? pageA : pageB;
  await expect(winner.getByRole('heading', { name: '设置新密码' })).toBeVisible();
  await winner.locator('#password').fill('new-password');
  await winner.locator('#confirmPassword').fill('new-password');
  await winner.getByRole('button', { name: '重置密码' }).click();
  await expect(winner.getByText('密码重置成功！')).toBeVisible();
  expect(transport.updateCalls).toBe(1);

  const storage = await winner.evaluate(({ primaryKey, prefix }) => ({
    canonical: localStorage.getItem(primaryKey),
    recoveryLocalKeys: Object.keys(localStorage).filter(key => key.startsWith(prefix)),
    recoverySessionKeys: Object.keys(sessionStorage).filter(key => key.startsWith(prefix)),
  }), { primaryKey: PRIMARY_STORAGE_KEY!, prefix: RECOVERY_PREFIX });
  expect(storage.canonical).toBe(JSON.stringify(primaryB2));
  expect(storage.recoverySessionKeys).toEqual([]);
  expect(storage.recoveryLocalKeys).toContain(`${RECOVERY_PREFIX}ledger:${nonce}`);
  const probe = await readProbe(winner);
  const recoveryChannels = probe.openedChannels.filter(name => name.includes(`attempt:${nonce}:`));
  expect(recoveryChannels.length).toBeGreaterThan(0);
  expect(recoveryChannels.every(name => probe.closedChannels.includes(name))).toBe(true);
  const canonicalEvents = [await readProbe(pageA), await readProbe(pageB)]
    .flatMap(value => value.storageEvents)
    .filter(event => event.key === PRIMARY_STORAGE_KEY);
  expect(canonicalEvents.every(event => !event.newValue?.includes(recoveryA.access_token))).toBe(true);
});
