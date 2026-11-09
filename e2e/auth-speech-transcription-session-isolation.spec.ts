import { expect, test, type BrowserContext, type Page, type Route } from '@playwright/test';

import { FOCUS_CONFIG } from '../src/config/focus.config';
import { environment } from '../src/environments/environment';
import { resolveSupabaseStorageKey } from '../src/services/supabase-client-configuration';
import { testHelpers } from './critical-paths/helpers';

interface CanonicalBundle {
  session: string | null;
  codeVerifier: string | null;
  user: string | null;
}

interface BrowserProbe {
  openedChannels: string[];
  storageEvents: Array<{ key: string | null; newValue: string | null }>;
}

interface TranscribeTransport {
  calls: Array<{ authorization: string }>;
  release(): void;
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

function bundleFor(session: TestSession | null): CanonicalBundle {
  return {
    session: session ? JSON.stringify(session) : null,
    codeVerifier: null,
    user: session ? JSON.stringify(session.user) : null,
  };
}

async function fulfillJson(route: Route, body: unknown): Promise<void> {
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

async function installBrowserRuntime(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    const probe: BrowserProbe = { openedChannels: [], storageEvents: [] };
    Object.defineProperty(globalThis, '__authSpeechProbe', { value: probe });
    globalThis.addEventListener('storage', event => {
      probe.storageEvents.push({ key: event.key, newValue: event.newValue });
    });
    const NativeBroadcastChannel = globalThis.BroadcastChannel;
    if (NativeBroadcastChannel) {
      class ObservedBroadcastChannel extends NativeBroadcastChannel {
        constructor(name: string) {
          super(name);
          probe.openedChannels.push(name);
        }
      }
      Object.defineProperty(globalThis, 'BroadcastChannel', { value: ObservedBroadcastChannel });
    }
    const track = { stop: () => undefined };
    const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
    Object.defineProperty(Navigator.prototype, 'mediaDevices', {
      configurable: true,
      get: () => ({
        enumerateDevices: async () => [{ deviceId: 'auth-speech-mic', kind: 'audioinput', label: 'Test mic' }],
        getUserMedia: async () => stream,
      }),
    });
    class TestMediaRecorder {
      static isTypeSupported(): boolean { return true; }
      mimeType = 'audio/webm';
      ondataavailable: ((event: BlobEvent) => void) | null = null;
      onstop: (() => void) | null = null;
      state = 'inactive';
      stream = stream;
      start(): void { this.state = 'recording'; }
      stop(): void {
        this.state = 'inactive';
        const data = new Blob([new Uint8Array(1800)], { type: this.mimeType });
        this.ondataavailable?.(new BlobEvent('dataavailable', { data }));
        queueMicrotask(() => this.onstop?.());
      }
    }
    Object.defineProperty(globalThis, 'MediaRecorder', { configurable: true, value: TestMediaRecorder });
  });
}

async function installTransport(
  context: BrowserContext,
  sessions: readonly TestSession[],
): Promise<TranscribeTransport> {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const transport: TranscribeTransport = { calls: [], release };
  await context.route(`${environment.supabaseUrl}/**`, async route => {
    const request = route.request();
    const url = new URL(request.url());
    const authorization = request.headers()['authorization'] ?? '';
    const session = sessions.find(candidate => authorization.includes(candidate.access_token));
    if (url.pathname.endsWith('/functions/v1/transcribe')) {
      transport.calls.push({ authorization });
      await gate;
      await fulfillJson(route, { ok: true, text: 'stale transcription A', duration: 1 });
      return;
    }
    if (url.pathname.endsWith('/auth/v1/user')) {
      await fulfillJson(route, session?.user ?? {});
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

async function readProbe(page: Page): Promise<BrowserProbe> {
  return page.evaluate(() => (globalThis as typeof globalThis & {
    __authSpeechProbe: BrowserProbe;
  }).__authSpeechProbe);
}

async function seedCanonical(page: Page, session: TestSession | null): Promise<void> {
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
    if (result !== 'committed' && result !== 'noop') throw new Error(`Canonical CAS failed: ${result}`);
  }, { next: bundleFor(session), storageKey: STORAGE_KEY });
}

async function awaitAdoption(page: Page, session: TestSession | null): Promise<void> {
  const expected = session ? JSON.stringify(session) : null;
  await expect.poll(async () => (await readProbe(page)).storageEvents
    .some(event => event.key === STORAGE_KEY && event.newValue === expected)).toBe(true);
}

async function openRecorder(page: Page): Promise<void> {
  await expect(page.locator('[data-testid="project-selector"]').first()).toBeVisible({ timeout: 15_000 });
  const projectName = `Auth speech ${testHelpers.uniqueId()}`;
  await testHelpers.createTestProject(page, projectName);
  await page.locator('[data-testid="project-item"]').filter({ hasText: projectName }).first().click();
  const enter = page.getByRole('button', { name: /enter/i }).first();
  if (await testHelpers.isElementVisible(enter, 1500)) await enter.click({ force: true });
  await expect(page.locator('[data-testid="project-shell-main-content"]').first()).toBeVisible({ timeout: 10_000 });
  const recorder = page.locator('[data-testid="black-box-recorder"]').first();
  if (!await recorder.isVisible().catch(() => false)) {
    await page.getByTestId('recorder-tool-fallback').click({ force: true });
  }
  await expect(recorder).toBeVisible({ timeout: 10_000 });
}

async function startTranscription(page: Page): Promise<void> {
  const recorder = page.locator('[data-testid="black-box-recorder"]').first();
  const box = await recorder.boundingBox();
  if (!box) throw new Error('Recorder bounds are unavailable');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await expect(recorder).toHaveAttribute('aria-pressed', 'true');
  await page.mouse.up();
}

async function readWriteAhead(page: Page): Promise<Array<{ ownerUserId?: string }>> {
  return page.evaluate(({ dbName, storeName }) => new Promise((resolve, reject) => {
    const request = indexedDB.open(dbName);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction(storeName, 'readonly');
      const read = tx.objectStore(storeName).getAll();
      read.onerror = () => reject(read.error);
      read.onsuccess = () => resolve(read.result as Array<{ ownerUserId?: string }>);
    };
  }), {
    dbName: FOCUS_CONFIG.SYNC.IDB_NAME,
    storeName: FOCUS_CONFIG.IDB_STORES.OFFLINE_AUDIO_CACHE,
  });
}

async function runIsolationCase(
  context: BrowserContext,
  transition: (mutator: Page, sessions: readonly TestSession[]) => Promise<TestSession | null>,
  replayExpected: boolean,
): Promise<void> {
  test.skip(!AUTH_CONFIGURED, 'Supabase browser credentials are unavailable');
  const sessionA = createSession('speech-owner-a', `speech-a-${testHelpers.uniqueId()}`);
  const sessionB = createSession('speech-owner-b', `speech-b-${testHelpers.uniqueId()}`);
  const sessionA2 = createSession('speech-owner-a', `speech-a2-${testHelpers.uniqueId()}`);
  const sessions = [sessionA, sessionB, sessionA2] as const;
  await installBrowserRuntime(context);
  const transport = await installTransport(context, sessions);
  const page = await context.newPage();
  const mutator = await context.newPage();
  await Promise.all([page.goto('/#/projects'), mutator.goto('/#/projects')]);
  await seedCanonical(mutator, sessionA);
  await awaitAdoption(page, sessionA);
  await openRecorder(page);
  await startTranscription(page);
  await expect.poll(() => transport.calls.filter(call =>
    call.authorization.includes(sessionA.access_token)).length).toBe(1);
  await expect(page.getByText('转写中...', { exact: true })).toBeVisible();

  const current = await transition(mutator, sessions);
  await awaitAdoption(page, current);
  transport.release();
  await expect(page.locator('[data-testid="transcription-editor"]')).not.toBeVisible();
  await expect(page.getByText('stale transcription A')).not.toBeVisible();
  await expect(page.getByText('转写中...', { exact: true })).not.toBeVisible();
  if (replayExpected && current) {
    await page.evaluate(() => globalThis.dispatchEvent(new Event('online')));
    await expect.poll(() => transport.calls.some(call =>
      call.authorization.includes(current.access_token))).toBe(true);
  }
  await expect.poll(async () => (await readWriteAhead(page))
    .some(record => record.ownerUserId === sessionA.user.id)).toBe(!replayExpected);
}

test('logout while A transcription is pending retains A audio with zero stale UI', async ({ context }) => {
  await runIsolationCase(context, async mutator => {
    await seedCanonical(mutator, null);
    return null;
  }, false);
});

test('different-owner B cannot receive or clear late A transcription', async ({ context }) => {
  await runIsolationCase(context, async (mutator, [, sessionB]) => {
    await seedCanonical(mutator, sessionB);
    return sessionB;
  }, false);
});

test('same-owner newer token rejects A and later replays the durable audio as current', async ({ context }) => {
  await runIsolationCase(context, async (mutator, [, , sessionA2]) => {
    await seedCanonical(mutator, sessionA2);
    return sessionA2;
  }, true);
});

test('A to B to newer A client replacement cannot publish the original A completion', async ({ context }) => {
  await runIsolationCase(context, async (mutator, [, sessionB, sessionA2]) => {
    await seedCanonical(mutator, sessionB);
    await seedCanonical(mutator, sessionA2);
    return sessionA2;
  }, true);
});
