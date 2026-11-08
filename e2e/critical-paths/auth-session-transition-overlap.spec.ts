import { expect, test, type BrowserContext, type Page, type Route } from '@playwright/test';

import { environment } from '../../src/environments/environment';
import { resolveSupabaseStorageKey } from '../../src/services/supabase-client-configuration';

interface CanonicalBundle {
  session: string | null;
  codeVerifier: string | null;
  user: string | null;
}

interface TransitionProbe {
  activeBlockers: string[];
  completedBlockers: string[];
  launchWrites: Array<{ key: string; userId: string | null }>;
  openedChannels: string[];
  snapshotTransactions: Array<{ mode: IDBTransactionMode; sequence: number }>;
  storageEvents: Array<{ key: string | null; newValue: string | null }>;
}

type TestSession = ReturnType<typeof createSession>;

const STORAGE_KEY = resolveSupabaseStorageKey(environment.supabaseUrl);
const OFFLINE_SNAPSHOT_DB = 'nanoflow-offline-snapshots';
const OFFLINE_SNAPSHOT_STORE = 'snapshots';
const LAUNCH_SNAPSHOT_KEYS = new Set([
  'nanoflow.launch-snapshot.v1',
  'nanoflow.launch-snapshot.v2',
]);

function base64Url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function createSession(userId: string, tokenId: string) {
  const now = new Date().toISOString();
  const issuedAt = Math.floor(Date.now() / 1000);
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

async function installSupabaseTransport(
  context: BrowserContext,
  sessions: readonly TestSession[],
): Promise<void> {
  await context.route(`${environment.supabaseUrl}/**`, async route => {
    const request = route.request();
    const url = new URL(request.url());
    const authorization = request.headers()['authorization'] ?? '';
    const session = sessions.find(candidate => authorization.includes(candidate.access_token));
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
}

async function installTransitionProbe(context: BrowserContext): Promise<void> {
  await context.addInitScript(({ dbName, launchKeys, storeName }) => {
    const probe: TransitionProbe = {
      activeBlockers: [],
      completedBlockers: [],
      launchWrites: [],
      openedChannels: [],
      snapshotTransactions: [],
      storageEvents: [],
    };
    const blockerStates = new Map<string, { released: boolean }>();
    let blockerDb: IDBDatabase | null = null;
    let transactionSequence = 0;
    Object.defineProperty(globalThis, '__authTransitionProbe', { value: probe });
    Object.defineProperty(globalThis, '__resetAuthTransitionProbe', {
      value: () => {
        probe.launchWrites.length = 0;
        probe.storageEvents.length = 0;
      },
    });

    const nativeSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key: string, value: string): void {
      if (this === localStorage && launchKeys.includes(key)) {
        let userId: string | null = null;
        try {
          const parsed = JSON.parse(value) as { userId?: unknown };
          userId = typeof parsed.userId === 'string' ? parsed.userId : null;
        } catch {
          userId = null;
        }
        probe.launchWrites.push({ key, userId });
      }
      nativeSetItem.call(this, key, value);
    };

    globalThis.addEventListener('storage', event => {
      probe.storageEvents.push({ key: event.key, newValue: event.newValue });
    });

    const nativeTransaction = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function(
      storeNames: string | string[],
      mode?: IDBTransactionMode,
      options?: IDBTransactionOptions,
    ): IDBTransaction {
      const transaction = options === undefined
        ? nativeTransaction.call(this, storeNames, mode)
        : nativeTransaction.call(this, storeNames, mode, options);
      const names = typeof storeNames === 'string' ? [storeNames] : Array.from(storeNames);
      if (this.name === dbName && names.includes(storeName)) {
        probe.snapshotTransactions.push({
          mode: mode ?? 'readonly',
          sequence: ++transactionSequence,
        });
      }
      return transaction;
    };

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

    const openBlockerDb = async (): Promise<IDBDatabase> => {
      if (blockerDb) return blockerDb;
      blockerDb = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(dbName);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      if (!blockerDb.objectStoreNames.contains(storeName)) {
        throw new Error(`Missing ${dbName}/${storeName}`);
      }
      return blockerDb;
    };

    Object.defineProperty(globalThis, '__queueAuthTransitionBlocker', {
      value: async (label: string) => {
        const db = await openBlockerDb();
        const state = { released: false };
        blockerStates.set(label, state);
        const transaction = db.transaction(storeName, 'readwrite');
        const store = transaction.objectStore(storeName);
        const keepAlive = () => {
          const request = store.get(`e2e-auth-transition-${label}`);
          request.onsuccess = () => {
            if (state.released) return;
            if (!probe.activeBlockers.includes(label)) probe.activeBlockers.push(label);
            keepAlive();
          };
        };
        transaction.oncomplete = () => {
          probe.completedBlockers.push(label);
          probe.activeBlockers = probe.activeBlockers.filter(value => value !== label);
        };
        keepAlive();
      },
    });
    Object.defineProperty(globalThis, '__releaseAuthTransitionBlocker', {
      value: (label: string) => {
        const state = blockerStates.get(label);
        if (!state) throw new Error(`Unknown transition blocker: ${label}`);
        state.released = true;
      },
    });
  }, {
    dbName: OFFLINE_SNAPSHOT_DB,
    launchKeys: [...LAUNCH_SNAPSHOT_KEYS],
    storeName: OFFLINE_SNAPSHOT_STORE,
  });
}

async function readProbe(page: Page): Promise<TransitionProbe> {
  return page.evaluate(() => (globalThis as typeof globalThis & {
    __authTransitionProbe: TransitionProbe;
  }).__authTransitionProbe);
}

async function seedCanonical(page: Page, next: CanonicalBundle): Promise<void> {
  if (!STORAGE_KEY) throw new Error('Canonical storage key is unavailable');
  await page.evaluate(async ({ nextBundle, storageKey }) => {
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
      next: nextBundle,
    });
    if (result !== 'committed' && result !== 'noop') {
      throw new Error(`Canonical CAS failed: ${result}`);
    }
  }, { nextBundle: next, storageKey: STORAGE_KEY });
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

async function awaitStableAuthStartup(page: Page): Promise<void> {
  await expect(page).toHaveURL(/\/#\/projects(?:[/?#]|$)/);
  await expect(page.locator('[data-testid="project-selector"]')).toBeVisible({ timeout: 15_000 });
}

async function queueBlocker(page: Page, label: string): Promise<void> {
  await page.evaluate(async blockerLabel => {
    await (globalThis as typeof globalThis & {
      __queueAuthTransitionBlocker(label: string): Promise<void>;
    }).__queueAuthTransitionBlocker(blockerLabel);
  }, label);
}

async function releaseBlocker(page: Page, label: string): Promise<void> {
  await page.evaluate(blockerLabel => {
    (globalThis as typeof globalThis & {
      __releaseAuthTransitionBlocker(label: string): void;
    }).__releaseAuthTransitionBlocker(blockerLabel);
  }, label);
}

test('only the newest cross-tab transition resumes sync and unblocks launch writes', async ({ context }) => {
  test.skip(!STORAGE_KEY, 'Supabase storage key is unavailable');
  const sessionA = createSession('transition-owner-a', 'transition-token-a');
  const sessionB = createSession('transition-owner-b', 'transition-token-b');
  await installTransitionProbe(context);
  await installSupabaseTransport(context, [sessionA, sessionB]);
  const page = await context.newPage();
  const mutator = await context.newPage();
  await Promise.all([page.goto('/#/projects'), mutator.goto('/#/projects')]);
  await Promise.all([awaitStableAuthStartup(page), awaitStableAuthStartup(mutator)]);

  await seedCanonical(page, bundleFor(sessionA));
  await page.reload();
  await awaitStableAuthStartup(page);
  await expect.poll(async () => (await readProbe(page)).launchWrites
    .some(write => write.userId === sessionA.user.id)).toBe(true);
  await page.evaluate(() => (globalThis as typeof globalThis & {
    __resetAuthTransitionProbe(): void;
  }).__resetAuthTransitionProbe());

  await queueBlocker(page, 'older-invalidation');
  await expect.poll(async () => (await readProbe(page)).activeBlockers)
    .toContain('older-invalidation');
  const invalidationBaseline = (await readProbe(page)).snapshotTransactions.length;
  await seedCanonical(mutator, bundleFor(null));
  await expect.poll(async () => (await readProbe(page)).storageEvents
    .some(event => event.key === STORAGE_KEY && event.newValue === null)).toBe(true);
  await expect.poll(async () => (await readProbe(page)).snapshotTransactions.length)
    .toBeGreaterThanOrEqual(invalidationBaseline);

  await queueBlocker(page, 'newer-restore');
  const restoreBaseline = (await readProbe(page)).snapshotTransactions.length;
  await seedCanonical(mutator, bundleFor(sessionB));
  await expect.poll(async () => (await readProbe(page)).storageEvents
    .some(event => event.key === STORAGE_KEY && event.newValue === JSON.stringify(sessionB)))
    .toBe(true);
  await expect.poll(async () => (await readProbe(page)).snapshotTransactions.length)
    .toBeGreaterThanOrEqual(restoreBaseline);

  await releaseBlocker(page, 'older-invalidation');
  await expect.poll(async () => (await readProbe(page)).activeBlockers)
    .toContain('newer-restore');
  await expect.poll(async () => (await readProbe(page)).completedBlockers)
    .toContain('older-invalidation');
  expect((await readProbe(page)).launchWrites).toEqual([]);

  await releaseBlocker(page, 'newer-restore');
  await expect.poll(async () => (await readProbe(page)).completedBlockers)
    .toContain('newer-restore');

  const probe = await readProbe(page);
  expect(probe.openedChannels.filter(name => name.startsWith(`${STORAGE_KEY}-nanoflow-g-`))).toHaveLength(2);
  expect(probe.snapshotTransactions.length).toBeGreaterThan(restoreBaseline);
  expect(await readCanonical(page)).toEqual(bundleFor(sessionB));
  await expect(page.locator('[data-testid="sync-status"]')).toBeVisible();
});
