import { expect, test, type BrowserContext, type Page, type Route } from '@playwright/test';

import { environment } from '../src/environments/environment';
import { resolveSupabaseStorageKey } from '../src/services/supabase-client-configuration';

interface CanonicalBundle {
  session: string | null;
  codeVerifier: string | null;
  user: string | null;
}

interface RequestCacheProbe {
  openedChannels: string[];
  storageEvents: Array<{ key: string | null; newValue: string | null }>;
}

interface SupabaseTransportProbe {
  release: () => void;
  restCalls: Array<{ authorization: string; url: string }>;
  routeFulfillments: Array<{ authorization: string; url: string }>;
}

type TestSession = ReturnType<typeof createSession>;

const STORAGE_KEY = resolveSupabaseStorageKey(environment.supabaseUrl);
const SESSION_A_BACKUP_PROOF = '2025-01-02T00:00:00.000Z';
const SESSION_B_BACKUP_PROOF = '2025-01-01T00:00:00.000Z';
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
    codeVerifier: null,
    user: JSON.stringify(session.user),
  };
}

async function fulfillJson(route: Route, body: unknown): Promise<void> {
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

async function installBrowserProbe(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    const probe: RequestCacheProbe = {
      openedChannels: [],
      storageEvents: [],
    };
    Object.defineProperty(globalThis, '__authRequestCacheProbe', { value: probe });
    globalThis.addEventListener('storage', event => {
      probe.storageEvents.push({ key: event.key, newValue: event.newValue });
    });
    const NativeBroadcastChannel = globalThis.BroadcastChannel;
    if (!NativeBroadcastChannel) return;
    class ObservedBroadcastChannel extends NativeBroadcastChannel {
      constructor(name: string) {
        super(name);
        probe.openedChannels.push(name);
      }
    }
    Object.defineProperty(globalThis, 'BroadcastChannel', { value: ObservedBroadcastChannel });
  });
}

async function readProbe(page: Page): Promise<RequestCacheProbe> {
  return page.evaluate(() => (globalThis as typeof globalThis & {
    __authRequestCacheProbe: RequestCacheProbe;
  }).__authRequestCacheProbe);
}

async function installSupabaseTransport(
  context: BrowserContext,
  sessions: readonly TestSession[],
  delayedToken?: string,
): Promise<SupabaseTransportProbe> {
  let release: () => void = () => undefined;
  const delayed = delayedToken
    ? new Promise<void>(resolve => { release = resolve; })
    : Promise.resolve();
  const probe: SupabaseTransportProbe = { release, restCalls: [], routeFulfillments: [] };
  await context.route(`${environment.supabaseUrl}/**`, async route => {
    const request = route.request();
    const url = new URL(request.url());
    const authorization = request.headers()['authorization'] ?? '';
    const session = sessions.find(candidate => authorization.includes(candidate.access_token));
    if (url.pathname.endsWith('/auth/v1/user')) {
      await fulfillJson(route, session?.user ?? {});
      return;
    }
    if (url.pathname.startsWith('/rest/v1/') && request.method() === 'GET') {
      probe.restCalls.push({ authorization, url: request.url() });
      if (delayedToken && authorization.includes(delayedToken)) await delayed;
      const isFirstSession = session?.access_token === sessions[0]?.access_token;
      const responseBody = url.pathname.endsWith('/user_preferences') && session
        ? {
          user_id: session.user.id,
          theme: 'default',
          layout_direction: 'ltr',
          floating_window_pref: 'auto',
          color_mode: 'system',
          auto_resolve_conflicts: true,
          local_backup_enabled: false,
          local_backup_interval_ms: 3_600_000,
          last_backup_proof_at: isFirstSession ? SESSION_A_BACKUP_PROOF : SESSION_B_BACKUP_PROOF,
          focus_preferences: null,
          updated_at: '2026-11-07T00:00:00.000Z',
        }
        : [];
      await fulfillJson(route, responseBody);
      probe.routeFulfillments.push({ authorization, url: request.url() });
      return;
    }
    await fulfillJson(route, {});
  });
  return probe;
}

async function seedCanonical(page: Page, session: TestSession): Promise<void> {
  if (!STORAGE_KEY) throw new Error('Canonical storage key is unavailable');
  await page.evaluate(async ({ next, storageKey }) => {
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
    if (result !== 'committed' && result !== 'noop') {
      throw new Error(`Canonical CAS failed: ${result}`);
    }
  }, { next: bundleFor(session), storageKey: STORAGE_KEY });
}

async function awaitStableStartup(page: Page): Promise<void> {
  await expect(page).toHaveURL(/\/#\/projects(?:[/?#]|$)/);
  const prefix = `${STORAGE_KEY}-nanoflow-g-`;
  await expect.poll(async () => (await readProbe(page)).openedChannels
    .some(name => name.startsWith(prefix))).toBe(true);
}

function callsFor(probe: SupabaseTransportProbe, session: TestSession) {
  return probe.restCalls.filter(call => call.authorization.includes(session.access_token));
}

function ownerNeutralRequestUrl(value: string): string {
  const url = new URL(value);
  for (const key of ['owner_id', 'user_id']) {
    const current = url.searchParams.get(key);
    if (current?.startsWith('eq.')) url.searchParams.set(key, 'eq.<owner>');
  }
  return url.toString();
}

async function awaitCrossTabAdoption(
  page: Page,
  session: TestSession,
  channelBaseline: number,
): Promise<void> {
  const expectedSession = JSON.stringify(session);
  await expect.poll(async () => (await readProbe(page)).storageEvents
    .some(event => event.key === STORAGE_KEY && event.newValue === expectedSession)).toBe(true);
  const prefix = `${STORAGE_KEY}-nanoflow-g-`;
  await expect.poll(async () => (await readProbe(page)).openedChannels
    .filter(name => name.startsWith(prefix)).length).toBeGreaterThan(channelBaseline);
}

async function setupPages(
  context: BrowserContext,
  sessions: readonly TestSession[],
  delayedToken?: string,
): Promise<{ page: Page; mutator: Page; transport: SupabaseTransportProbe }> {
  await installBrowserProbe(context);
  const transport = await installSupabaseTransport(context, sessions, delayedToken);
  const page = await context.newPage();
  const mutator = await context.newPage();
  await Promise.all([page.goto('/#/projects'), mutator.goto('/#/projects')]);
  await Promise.all([awaitStableStartup(page), awaitStableStartup(mutator)]);
  return { page, mutator, transport };
}

async function expectCompletedResponseIsolation(
  context: BrowserContext,
  sessionA: TestSession,
  sessionB: TestSession,
  requireRepeatedRequestUrl = true,
): Promise<void> {
  const { page, mutator, transport } = await setupPages(context, [sessionA, sessionB]);
  await seedCanonical(mutator, sessionA);
  await expect.poll(() => callsFor(transport, sessionA).length)
    .toBeGreaterThan(0);
  const aUrls = new Set(callsFor(transport, sessionA).map(call => call.url));
  const prefix = `${STORAGE_KEY}-nanoflow-g-`;
  const channelBaseline = (await readProbe(page)).openedChannels
    .filter(name => name.startsWith(prefix)).length;

  await seedCanonical(mutator, sessionB);
  await awaitCrossTabAdoption(page, sessionB, channelBaseline);
  await expect.poll(() => callsFor(transport, sessionB).length).toBeGreaterThan(0);
  if (!requireRepeatedRequestUrl) return;
  expect(callsFor(transport, sessionB).some(call => [...aUrls]
    .some(url => ownerNeutralRequestUrl(url) === ownerNeutralRequestUrl(call.url))),
  `same owner newer token did not repeat an A request. A=${JSON.stringify([...aUrls])} B=${JSON.stringify(callsFor(transport, sessionB).map(call => call.url))}`)
    .toBe(true);
}

test('completed authenticated A response cannot satisfy different-owner B', async ({ context }) => {
  test.skip(!AUTH_CONFIGURED, 'Supabase browser credentials are unavailable');
  await expectCompletedResponseIsolation(
    context,
    createSession('request-cache-owner-a', 'request-cache-token-a'),
    createSession('request-cache-owner-b', 'request-cache-token-b'),
  );
});

test('pending A cannot satisfy B and late A cannot populate B after client replacement', async ({ context }) => {
  test.skip(!AUTH_CONFIGURED, 'Supabase browser credentials are unavailable');
  const sessionA = createSession('request-cache-owner-a', 'request-cache-pending-a');
  const sessionB = createSession('request-cache-owner-b', 'request-cache-current-b');
  const { page, mutator, transport } = await setupPages(
    context,
    [sessionA, sessionB],
    sessionA.access_token,
  );

  await seedCanonical(mutator, sessionA);
  await expect.poll(() => callsFor(transport, sessionA).length)
    .toBeGreaterThan(0);
  const aPreferenceCall = callsFor(transport, sessionA).find(call =>
    new URL(call.url).pathname.endsWith('/user_preferences'));
  expect(aPreferenceCall).toBeDefined();
  if (!aPreferenceCall) throw new Error('Session A preference request was not issued');
  expect(transport.routeFulfillments.some(response => response.url === aPreferenceCall.url
    && response.authorization === `Bearer ${sessionA.access_token}`)).toBe(false);
  const prefix = `${STORAGE_KEY}-nanoflow-g-`;
  const channelBaseline = (await readProbe(page)).openedChannels
    .filter(name => name.startsWith(prefix)).length;

  await seedCanonical(mutator, sessionB);
  await awaitCrossTabAdoption(page, sessionB, channelBaseline);
  await expect.poll(() => callsFor(transport, sessionB).length).toBeGreaterThan(0);
  const bPreferenceCall = callsFor(transport, sessionB).find(call =>
    new URL(call.url).pathname.endsWith('/user_preferences'));
  expect(bPreferenceCall).toBeDefined();
  if (!bPreferenceCall) throw new Error('Session B preference request was not issued');
  expect(ownerNeutralRequestUrl(aPreferenceCall.url)).toBe(ownerNeutralRequestUrl(bPreferenceCall.url));
  await expect.poll(() => transport.routeFulfillments.some(response => (
    response.authorization === `Bearer ${sessionB.access_token}`
      && response.url === bPreferenceCall.url
  ))).toBe(true);
  const bProofKey = `nanoflow.preference.${sessionB.user.id}.lastBackupProofAt`;
  await expect.poll(() => page.evaluate(key => localStorage.getItem(key), bProofKey))
    .toBe(SESSION_B_BACKUP_PROOF);

  transport.release();
  await expect.poll(() => transport.routeFulfillments.some(response => (
    response.authorization === `Bearer ${sessionA.access_token}`
      && response.url === aPreferenceCall.url
  ))).toBe(true);
  await expect.poll(() => page.evaluate(key => localStorage.getItem(key), bProofKey))
    .toBe(SESSION_B_BACKUP_PROOF);
  await expect(page.evaluate(key => localStorage.getItem(key), bProofKey))
    .not.toBe(SESSION_A_BACKUP_PROOF);
});

test('same-owner token rotation issues reads with the newer access token', async ({ context }) => {
  test.skip(!AUTH_CONFIGURED, 'Supabase browser credentials are unavailable');
  await expectCompletedResponseIsolation(
    context,
    createSession('request-cache-same-owner', 'request-cache-old-token'),
    createSession('request-cache-same-owner', 'request-cache-new-token'),
    false,
  );
});
