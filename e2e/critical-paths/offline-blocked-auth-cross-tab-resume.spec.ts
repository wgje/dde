import { expect, test, type BrowserContext, type Page, type Route } from '@playwright/test';

import { environment } from '../../src/environments/environment';
import { resolveSupabaseStorageKey } from '../../src/services/supabase-client-configuration';

const STORAGE_KEY = resolveSupabaseStorageKey(environment.supabaseUrl);
const ACTION_QUEUE_STORAGE_KEY = 'nanoflow.action-queue';
const QUEUE_BACKUP_DB_NAME = 'nanoflow-queue-backup';
const QUEUE_BACKUP_STORE_NAME = 'queue-backup';
const TEST_USER_ID = '11111111-2222-4333-8444-555555555555';
const TEST_USER_EMAIL = 'blocked-auth-cross-tab@example.com';

interface CanonicalBundle {
  session: string | null;
  codeVerifier: string | null;
  user: string | null;
}

interface CrossTabResumeProbe {
  storageEvents: Array<{ key: string | null; newValue: string | null }>;
  recoveryTraces: string[];
  actionQueueTraces: string[];
  traceResetAt: number;
}

type TestSession = ReturnType<typeof createSession>;

function base64Url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function createSession(userId: string, tokenId: string): {
  access_token: string;
  token_type: string;
  expires_in: number;
  expires_at: number;
  refresh_token: string;
  user: { id: string; aud: string; role: string; email: string };
} {
  const issuedAt = Math.floor(Date.now() / 1000);
  const user = {
    id: userId,
    aud: 'authenticated',
    role: 'authenticated',
    email: TEST_USER_EMAIL,
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
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
}

async function fulfillJsonStatus(route: Route, status: number, body: unknown): Promise<void> {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

/** PostgREST maybeSingle 零行语义：406 + PGRST116（supabase-js 转换为 data:null）。 */
async function fulfillNoRows(route: Route): Promise<void> {
  await fulfillJsonStatus(route, 406, {
    code: 'PGRST116',
    message: 'JSON object requested, multiple (or no) rows returned',
    details: 'Results contain 0 rows',
    hint: null,
  });
}

function readSyncRpcPayload(route: Route): Record<string, unknown> {
  try {
    const body = route.request().postDataJSON() as { payload?: Record<string, unknown> } | null;
    return body?.payload ?? {};
  } catch {
    return {};
  }
}

async function fulfillAppliedTaskWrite(route: Route): Promise<void> {
  const payload = readSyncRpcPayload(route);
  const task = (payload['task'] ?? {}) as { id?: string };
  await fulfillJson(route, {
    status: 'applied',
    task_id: typeof task.id === 'string' ? task.id : null,
    operation_id: typeof payload['operation_id'] === 'string' ? payload['operation_id'] : null,
    updated_at: new Date().toISOString(),
  });
}

async function installSupabaseTransport(
  context: BrowserContext,
  sessions: readonly TestSession[],
): Promise<void> {
  await context.route(`${environment.supabaseUrl}/**`, async route => {
    const url = new URL(route.request().url());
    const authorization = route.request().headers()['authorization'] ?? '';
  const session = sessions.find(candidate => authorization.includes(candidate.access_token));
  if (url.pathname.endsWith('/auth/v1/token')) {
    await fulfillJson(route, session ?? sessions.at(-1) ?? {});
    return;
  }
    if (url.pathname.endsWith('/auth/v1/user')) {
      await fulfillJson(route, session?.user ?? {});
      return;
    }
    if (url.pathname.includes('/rest/v1/rpc/sync_check_protocol')) {
      await fulfillJson(route, { minProtocolVersion: 1, deploymentEpoch: 0 });
      return;
    }
    if (url.pathname.includes('/rest/v1/rpc/sync_upsert_task')) {
      await fulfillAppliedTaskWrite(route);
      return;
    }
    if (url.pathname.includes('/rest/v1/task_tombstones')) {
      const accept = route.request().headers()['accept'] ?? '';
      if (accept.includes('vnd.pgrst.object+json')) {
        await fulfillNoRows(route);
      } else {
        await fulfillJson(route, []);
      }
      return;
    }
    if (url.pathname.startsWith('/rest/v1/')) {
      await fulfillJson(route, []);
      return;
    }
    await fulfillJson(route, {});
  });
}

async function awaitStableAuthStartup(page: Page): Promise<void> {
  await expect(page).toHaveURL(/\/#\/projects(?:[/?#]|$)/);
  await expect(page.locator('[data-testid="project-selector"]')).toBeVisible({ timeout: 15_000 });
}

async function awaitCanonicalAuthority(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => Boolean(
    (globalThis as typeof globalThis & {
      __NANOFLOW_AUTH_CANONICAL_STORAGE__?: unknown;
    }).__NANOFLOW_AUTH_CANONICAL_STORAGE__,
  ))).toBe(true);
}

async function seedCanonical(page: Page, next: CanonicalBundle): Promise<boolean> {
  if (!STORAGE_KEY) throw new Error('Canonical storage key is unavailable');
  return page.evaluate(async ({ nextBundle, storageKey }) => {
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
    return result === 'committed';
  }, { nextBundle: next, storageKey: STORAGE_KEY });
}


async function seedBlockedActionQueue(page: Page): Promise<void> {
  await page.evaluate(async ({ actionKey, userId, dbName, storeName }) => {
    const scopedKey = `${actionKey}.${userId}`;
    const action = {
      id: 'cross-tab-blocked-auth-action',
      operationId: '11111111-2222-4333-8444-555555555556',
      type: 'update',
      entityType: 'task',
      entityId: 'cross-tab-task',
      payload: {
        task: {
          id: 'cross-tab-task',
          title: 'Cross-tab auth pending task',
          content: '',
          stage: null,
          parentId: null,
          order: 0,
          rank: 0,
          status: 'active',
          x: 0,
          y: 0,
          createdDate: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          displayId: 'cross-tab-task',
          shortId: 'cross-tab-task',
        },
        projectId: 'cross-tab-project',
        sourceUserId: userId,
        writeIntent: 'task_text_update',
      },
      timestamp: Date.now(),
      retryCount: 0,
      syncState: 'blocked_by_auth',
      errorType: 'deferred',
      lastError: 'auth-pending',
    };
    localStorage.setItem(scopedKey, JSON.stringify([action]));
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open(dbName, 1);
      request.onerror = () => reject(request.error ?? new Error('queue backup open failed'));
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(storeName)) {
          db.createObjectStore(storeName, { keyPath: 'id' });
        }
      };
      request.onsuccess = () => {
        const db = request.result;
        try {
          const transaction = db.transaction(storeName, 'readwrite');
          const store = transaction.objectStore(storeName);
          store.put({
            id: `queue-backup:${userId}`,
            ownerUserId: userId,
            actions: [action],
            savedAt: new Date().toISOString(),
          });
          transaction.oncomplete = () => {
            db.close();
            resolve();
          };
          transaction.onerror = () => {
            db.close();
            reject(transaction.error ?? new Error('queue backup write failed'));
          };
          transaction.onabort = () => {
            db.close();
            reject(transaction.error ?? new Error('queue backup write aborted'));
          };
        } catch (error) {
          db.close();
          reject(error);
        }
      };
    });
  }, {
    actionKey: ACTION_QUEUE_STORAGE_KEY,
    dbName: QUEUE_BACKUP_DB_NAME,
    storeName: QUEUE_BACKUP_STORE_NAME,
    userId: TEST_USER_ID,
  });
}

async function readCrossTabResumeProbe(page: Page): Promise<CrossTabResumeProbe> {
  return page.evaluate(() => {
    const probe = (globalThis as typeof globalThis & {
      __blockedAuthCrossTabProbe?: CrossTabResumeProbe;
    }).__blockedAuthCrossTabProbe ?? {
      storageEvents: [],
      recoveryTraces: [],
      actionQueueTraces: [],
      traceResetAt: 0,
    };
    const liveTrace = (globalThis as typeof globalThis & {
      __NANOFLOW_STARTUP_TRACE__?: Array<{ event: string; at: string; data?: Record<string, unknown> | null }>;
    }).__NANOFLOW_STARTUP_TRACE__ ?? [];
    const liveRecoveryTraces = liveTrace
      .filter(item => item.event === 'user_session.set_current_user')
      .filter(item => Date.parse(item.at) >= probe.traceResetAt)
      .map(item => JSON.stringify({ event: item.event, detail: item.data ?? null, at: item.at }));
    const liveActionQueueTraces = liveTrace
      .filter(item => item.event.startsWith('action_queue.'))
      .filter(item => Date.parse(item.at) >= probe.traceResetAt)
      .map(item => JSON.stringify({ event: item.event, detail: item.data ?? null, at: item.at }));
    return {
      storageEvents: probe.storageEvents,
      recoveryTraces: [...probe.recoveryTraces, ...liveRecoveryTraces],
      actionQueueTraces: [...probe.actionQueueTraces, ...liveActionQueueTraces],
      traceResetAt: probe.traceResetAt,
    };
  });
}

async function resetCrossTabResumeProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    const probe = (globalThis as typeof globalThis & {
      __blockedAuthCrossTabProbe?: CrossTabResumeProbe;
    }).__blockedAuthCrossTabProbe;
    if (probe) {
      probe.storageEvents.length = 0;
      probe.recoveryTraces.length = 0;
      probe.actionQueueTraces.length = 0;
      probe.traceResetAt = Date.now();
    }
  });
}

test('same-user storageBridge restore reloads persistent blocked_by_auth ActionQueue', async ({ context }) => {
  test.skip(!STORAGE_KEY, 'Supabase storage key is unavailable');
  const session = createSession(TEST_USER_ID, 'same-user-token');
  const restoredSession = createSession(TEST_USER_ID, 'same-user-token-2');
  await installSupabaseTransport(context, [session, restoredSession]);
  await context.addInitScript(() => {
    const probe: CrossTabResumeProbe = {
      storageEvents: [],
      recoveryTraces: [],
      actionQueueTraces: [],
      traceResetAt: 0,
    };
    Object.defineProperty(globalThis, '__blockedAuthCrossTabProbe', {
      value: probe,
      configurable: true,
    });

    globalThis.addEventListener('storage', event => {
      probe.storageEvents.push({ key: event.key, newValue: event.newValue });
    });

    const nativePushTrace = globalThis.__NANOFLOW_PUSH_STARTUP_TRACE__;
    if (typeof nativePushTrace === 'function') {
      Object.defineProperty(globalThis, '__NANOFLOW_PUSH_STARTUP_TRACE__', {
        value: (eventName: string, detail?: unknown) => {
          const event = String(eventName);
          if (event === 'user_session.set_current_user') {
            probe.recoveryTraces.push(JSON.stringify({ event, detail }));
          }
          if (event.startsWith('action_queue.')) {
            probe.actionQueueTraces.push(JSON.stringify({ event, detail }));
          }
          nativePushTrace(eventName, detail);
        },
        configurable: true,
      });
    }
    const pushTraceEvents = (eventName: string, detail?: unknown) => {
      const event = String(eventName);
      if (event === 'user_session.set_current_user') {
        probe.recoveryTraces.push(JSON.stringify({ event, detail }));
      }
      if (event.startsWith('action_queue.')) {
        probe.actionQueueTraces.push(JSON.stringify({ event, detail }));
      }
    };
    const observeTraceArray = () => {
      const trace = (globalThis as typeof globalThis & {
        __NANOFLOW_STARTUP_TRACE__?: Array<{ event: string; data?: Record<string, unknown> | null }>;
      }).__NANOFLOW_STARTUP_TRACE__;
      if (!trace) return;
      for (const item of trace) {
        if (item && item.event) pushTraceEvents(item.event, item.data ?? null);
      }
    };
    const nativeTraceArray = (globalThis as typeof globalThis & {
      __NANOFLOW_STARTUP_TRACE__?: unknown[];
    }).__NANOFLOW_STARTUP_TRACE__;
    if (Array.isArray(nativeTraceArray)) {
      observeTraceArray();
    }
    globalThis.addEventListener('nanoflow:boot-stage', observeTraceArray);
  });

  const page = await context.newPage();
  await page.goto('/#/projects');
  await awaitCanonicalAuthority(page);
  await seedCanonical(page, bundleFor(session));
  await page.reload();
  await awaitStableAuthStartup(page);
  await seedBlockedActionQueue(page);
  await resetCrossTabResumeProbe(page);

  const mutator = await context.newPage();
  await mutator.goto('/#/projects');
  await awaitCanonicalAuthority(mutator);
  await seedCanonical(mutator, bundleFor(null));
  await expect.poll(async () => (await readCrossTabResumeProbe(page)).storageEvents
    .some(event => event.key === STORAGE_KEY && event.newValue === null))
    .toBe(true);
  const committed = await seedCanonical(mutator, bundleFor(restoredSession));
  expect(committed).toBe(true);

  await expect.poll(async () => (await readCrossTabResumeProbe(page)).storageEvents
    .some(event => event.key === STORAGE_KEY
      && event.newValue === JSON.stringify(restoredSession)))
    .toBe(true);
  await expect.poll(async () => (await readCrossTabResumeProbe(page)).recoveryTraces
    .map(entry => JSON.parse(entry) as { event: string; detail?: { forceLoad?: boolean; userId?: string } })
    .some(trace => trace.event === 'user_session.set_current_user'
      && trace.detail?.forceLoad === true
      && trace.detail.userId === TEST_USER_ID))
    .toBe(true);
  await expect.poll(async () => (await readCrossTabResumeProbe(page)).actionQueueTraces
    .map(entry => JSON.parse(entry) as {
      event: string;
      detail?: { outcome?: string; processorKey?: string };
    })
    .some(trace => trace.event === 'action_queue.processing_processor_resolved'
      && trace.detail?.outcome === 'success'))
    .toBe(true);
  await expect.poll(async () => (await readCrossTabResumeProbe(page)).actionQueueTraces
    .map(entry => JSON.parse(entry) as {
      event: string;
      detail?: { outcome?: string; processorKey?: string };
    })
    .some(trace => trace.event === 'action_queue.processing_processor_finished'
      && trace.detail?.processorKey === 'task:update'))
    .toBe(true);
  await expect.poll(async () => page.evaluate(userId => {
    const scopedKey = 'nanoflow.action-queue.' + userId;
    return localStorage.getItem(scopedKey);
  }, TEST_USER_ID)).toBe('[]');
});
