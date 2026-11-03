import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const BOOTSTRAP_PATH = path.join(
  process.cwd(),
  'public',
  'assets',
  'auth-canonical-storage-bootstrap-v1.js',
);
const AUTHORITY_KEY = '__NANOFLOW_AUTH_CANONICAL_STORAGE__';
const AUTH_STORAGE_KEY = 'sb-project-auth-token';

interface CanonicalBundle {
  session: string | null;
  codeVerifier: string | null;
  user: string | null;
}

interface CanonicalAuthority {
  captureAndScrubAuthCallback(): {
    version: 1;
    blocked: boolean;
    capturedAt: number;
    hasAuthError: boolean;
    claimCode(): string | null;
  };
  createGeneration(storageKey: string): Promise<CanonicalGeneration>;
  peekBundle(storageKey: string): CanonicalBundle;
  readBundle(storageKey: string): Promise<CanonicalBundle>;
  compareAndSwap(input: {
    storageKey: string;
    expected: CanonicalBundle;
    next: CanonicalBundle;
  }): Promise<'committed' | 'noop'>;
  claimCallbackVerifier(input: {
    storageKey: string;
    expected: CanonicalBundle;
    marker: string;
    claimantKey: string;
    envelope: Record<string, unknown>;
  }): Promise<'claimed'>;
  startSessionPrewarm(input: {
    supabaseUrl: string;
    supabaseAnonKey: string;
    bootFlags: Record<string, boolean>;
  }): Promise<void>;
}

interface CanonicalGeneration {
  storageKey: string;
  storage: {
    getItem(key: string): Promise<string | null>;
    setItem(key: string, value: string): Promise<void>;
    removeItem(key: string): Promise<void>;
  };
  promote(): Promise<'committed' | 'noop'>;
  retire(): void;
}

interface VmWindow {
  [AUTHORITY_KEY]?: CanonicalAuthority;
  __NANOFLOW_SESSION_PREWARM__?: {
    status: string;
    session?: unknown;
  };
  __NANOFLOW_PUSH_STARTUP_TRACE__?: (event: string, detail?: unknown) => void;
}

class MemoryStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, String(value));
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

function bundleKeys(storageKey = AUTH_STORAGE_KEY) {
  return {
    session: storageKey,
    codeVerifier: `${storageKey}-code-verifier`,
    user: `${storageKey}-user`,
  };
}

function writeBundle(storage: MemoryStorage, bundle: CanonicalBundle): void {
  const keys = bundleKeys();
  for (const [field, key] of Object.entries(keys) as Array<[keyof CanonicalBundle, string]>) {
    const value = bundle[field];
    if (value === null) storage.removeItem(key);
    else storage.setItem(key, value);
  }
}

function readBundle(storage: MemoryStorage): CanonicalBundle {
  const keys = bundleKeys();
  return {
    session: storage.getItem(keys.session),
    codeVerifier: storage.getItem(keys.codeVerifier),
    user: storage.getItem(keys.user),
  };
}

function bootstrapSource(): string {
  return fs.existsSync(BOOTSTRAP_PATH) ? fs.readFileSync(BOOTSTRAP_PATH, 'utf8') : '';
}

function createVmHarness(options: {
  withLocks?: boolean;
  fetch?: typeof fetch;
  href?: string;
} = {}) {
  const storage = new MemoryStorage();
  const claimantStorage = new MemoryStorage();
  const lockNames: string[] = [];
  const trace = vi.fn();
  const postMessage = vi.fn();
  const dispatchEvent = vi.fn();
  const replaceState = vi.fn();
  const consoleCalls = {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    log: vi.fn(),
    warn: vi.fn(),
  };
  const windowState: VmWindow = {
    __NANOFLOW_PUSH_STARTUP_TRACE__: trace,
  };
  const context = vm.createContext({
    console: consoleCalls,
    Date,
    Error,
    JSON,
    Object,
    Promise,
    String,
    URL,
    URLSearchParams,
    fetch: options.fetch ?? vi.fn(),
    localStorage: storage,
    location: new URL(options.href ?? 'https://nanoflow.pages.dev/'),
    history: { replaceState },
    sessionStorage: claimantStorage,
    postMessage,
    replaceState,
    dispatchEvent,
    navigator: options.withLocks === false
      ? {}
      : {
          locks: {
            request: async (
              name: string,
              _options: unknown,
              callback: () => unknown,
            ) => {
              lockNames.push(name);
              return await callback();
            },
          },
        },
    setTimeout,
    clearTimeout,
    window: windowState,
  });
  Object.assign(windowState, context);
  vm.runInContext(bootstrapSource(), context, { filename: BOOTSTRAP_PATH });
  return {
    claimantStorage,
    consoleCalls,
    context,
    dispatchEvent,
    lockNames,
    postMessage,
    replaceState,
    storage,
    trace,
    windowState,
  };
}

function authorityFrom(harness: ReturnType<typeof createVmHarness>): CanonicalAuthority {
  const authority = harness.context[AUTHORITY_KEY] as CanonicalAuthority | undefined;
  expect(authority).toBeDefined();
  return authority as CanonicalAuthority;
}

describe('canonical auth bootstrap', () => {
  it('installs one immutable frozen global authority from the actual public script', () => {
    const harness = createVmHarness();
    const authority = authorityFrom(harness);
    const descriptor = Object.getOwnPropertyDescriptor(harness.context, AUTHORITY_KEY);

    expect(Object.isFrozen(authority)).toBe(true);
    expect(descriptor).toMatchObject({ configurable: false, writable: false });
    expect(bootstrapSource()).not.toContain('YOUR_SUPABASE_ANON_KEY');
    expect(bootstrapSource()).not.toContain('your-project.supabase.co');
  });

  it('captures one callback code opaquely and scrubs before later startup observers', () => {
    const harness = createVmHarness({
      href: 'https://nanoflow.pages.dev/auth/callback?code=secret-code&error_description=hidden#access_token=hidden',
    });
    const capture = authorityFrom(harness).captureAndScrubAuthCallback();

    expect(Object.isFrozen(capture)).toBe(true);
    expect(capture).not.toHaveProperty('code');
    expect(capture.hasAuthError).toBe(true);
    expect(capture.claimCode()).toBe('secret-code');
    expect(capture.claimCode()).toBeNull();
    expect(harness.replaceState).toHaveBeenCalledWith(null, '', '/#/auth/callback');
  });

  it('blocks callback consumption when URL scrubbing fails without exposing the callback payload', () => {
    const harness = createVmHarness({
      href: 'https://nanoflow.pages.dev/auth/callback?code=secret-code#error_description=hidden',
    });
    harness.replaceState.mockImplementationOnce(() => {
      throw new Error('history unavailable');
    });

    const capture = authorityFrom(harness).captureAndScrubAuthCallback();

    expect(capture.blocked).toBe(true);
    expect(capture.claimCode()).toBeNull();
    expect(capture).not.toHaveProperty('code');
    expect(harness.trace).not.toHaveBeenCalled();
    expect(harness.postMessage).not.toHaveBeenCalled();
    expect(harness.dispatchEvent).not.toHaveBeenCalled();
    expect(Object.values(harness.consoleCalls).every(spy => spy.mock.calls.length === 0)).toBe(true);
    const publicSignals = JSON.stringify({
      console: Object.values(harness.consoleCalls).flatMap(spy => spy.mock.calls),
      events: harness.dispatchEvent.mock.calls,
      messages: harness.postMessage.mock.calls,
      traces: harness.trace.mock.calls,
    });
    for (const forbidden of [
      'secret-verifier-a',
      'callback-code-a',
      'access_token',
      'refresh_token',
      'code_verifier',
      'session',
    ]) {
      expect(publicSignals).not.toContain(forbidden);
    }
  });

  it('commits all three canonical keys under one lock and rejects a complete-bundle collision', async () => {
    const harness = createVmHarness();
    const authority = authorityFrom(harness);
    const ownerA = {
      session: '{"access_token":"token-a"}',
      codeVerifier: 'verifier-a',
      user: '{"id":"owner-a"}',
    };
    const ownerB = {
      session: '{"access_token":"token-b"}',
      codeVerifier: 'verifier-b',
      user: '{"id":"owner-b"}',
    };
    writeBundle(harness.storage, ownerA);

    await expect(authority.compareAndSwap({
      storageKey: AUTH_STORAGE_KEY,
      expected: ownerA,
      next: ownerB,
    })).resolves.toBe('committed');
    expect(readBundle(harness.storage)).toEqual(ownerB);
    expect(new Set(harness.lockNames).size).toBe(1);

    const foreignBundle = { ...ownerB, codeVerifier: 'foreign-verifier' };
    writeBundle(harness.storage, foreignBundle);
    await expect(authority.compareAndSwap({
      storageKey: AUTH_STORAGE_KEY,
      expected: ownerB,
      next: ownerA,
    })).rejects.toThrow('AUTH_CANONICAL_STORAGE_MISMATCH');
    expect(readBundle(harness.storage)).toEqual(foreignBundle);
  });

  it('exposes a detached synchronous bundle snapshot for cache readers', () => {
    const harness = createVmHarness();
    const authority = authorityFrom(harness);
    const ownerA = { session: 'a', codeVerifier: 'va', user: 'ua' };
    writeBundle(harness.storage, ownerA);

    const snapshot = authority.peekBundle(AUTH_STORAGE_KEY);
    snapshot.session = 'mutated-copy';

    expect(readBundle(harness.storage)).toEqual(ownerA);
  });

  it('fails closed without Web Locks and performs no canonical mutation', async () => {
    const harness = createVmHarness({ withLocks: false });
    const authority = authorityFrom(harness);
    const ownerA = { session: 'a', codeVerifier: 'va', user: 'ua' };
    const ownerB = { session: 'b', codeVerifier: 'vb', user: 'ub' };
    writeBundle(harness.storage, ownerA);

    await expect(authority.compareAndSwap({
      storageKey: AUTH_STORAGE_KEY,
      expected: ownerA,
      next: ownerB,
    })).rejects.toThrow('AUTH_CANONICAL_LOCK_UNAVAILABLE');
    expect(readBundle(harness.storage)).toEqual(ownerA);
  });

  it('claims a callback verifier marker-first under one lock without exposing the verifier', async () => {
    const harness = createVmHarness();
    const authority = authorityFrom(harness);
    const expected = { session: null, codeVerifier: 'secret-verifier-a', user: null };
    const marker = '{"kind":"nanoflow-auth-callback","attempt":"attempt-a"}';
    writeBundle(harness.storage, expected);

    await expect(authority.claimCallbackVerifier({
      storageKey: AUTH_STORAGE_KEY,
      expected,
      marker,
      claimantKey: 'nanoflow:auth-callback:v1:claim:attempt-a',
      envelope: { version: 1, attemptId: 'attempt-a', code: 'callback-code-a' },
    })).resolves.toBe('claimed');

    expect(readBundle(harness.storage)).toEqual({ ...expected, codeVerifier: marker });
    expect(JSON.parse(harness.claimantStorage.getItem(
      'nanoflow:auth-callback:v1:claim:attempt-a',
    ) ?? '{}')).toMatchObject({
      attemptId: 'attempt-a',
      code: 'callback-code-a',
      verifier: 'secret-verifier-a',
    });
    expect(harness.lockNames).toEqual(['nanoflow-auth-canonical-storage-v1']);
    expect(harness.trace).not.toHaveBeenCalled();
    expect(harness.postMessage).not.toHaveBeenCalled();
    expect(harness.dispatchEvent).not.toHaveBeenCalled();
    expect(Object.values(harness.consoleCalls).every(spy => spy.mock.calls.length === 0)).toBe(true);
  });

  it('allows exactly one tab to claim one verifier under the canonical lock', async () => {
    const harness = createVmHarness();
    const authority = authorityFrom(harness);
    const expected = { session: null, codeVerifier: 'secret-verifier-a', user: null };
    writeBundle(harness.storage, expected);

    const results = await Promise.allSettled([
      authority.claimCallbackVerifier({
        storageKey: AUTH_STORAGE_KEY,
        expected,
        marker: 'marker-a',
        claimantKey: 'nanoflow:auth-callback:v1:claim:attempt-a',
        envelope: { version: 1, attemptId: 'attempt-a', code: 'code-a' },
      }),
      authority.claimCallbackVerifier({
        storageKey: AUTH_STORAGE_KEY,
        expected,
        marker: 'marker-b',
        claimantKey: 'nanoflow:auth-callback:v1:claim:attempt-b',
        envelope: { version: 1, attemptId: 'attempt-b', code: 'code-b' },
      }),
    ]);

    expect(results.map(result => result.status).sort()).toEqual(['fulfilled', 'rejected']);
    const claimantKeys = [
      'nanoflow:auth-callback:v1:claim:attempt-a',
      'nanoflow:auth-callback:v1:claim:attempt-b',
    ].filter(key => harness.claimantStorage.getItem(key) !== null);
    expect(claimantKeys).toHaveLength(1);
    expect(['marker-a', 'marker-b']).toContain(readBundle(harness.storage).codeVerifier);
  });

  it('treats an existing callback marker as terminal instead of re-claiming it as a verifier', async () => {
    const harness = createVmHarness();
    const authority = authorityFrom(harness);
    const original = { session: null, codeVerifier: 'secret-verifier-a', user: null };
    const marker = JSON.stringify({ kind: 'nanoflow-auth-callback', version: 1, attemptId: 'attempt-a' });
    writeBundle(harness.storage, original);
    await authority.claimCallbackVerifier({
      storageKey: AUTH_STORAGE_KEY,
      expected: original,
      marker,
      claimantKey: 'nanoflow:auth-callback:v1:claim:attempt-a',
      envelope: { version: 1, attemptId: 'attempt-a', code: 'code-a' },
    });
    const claimed = readBundle(harness.storage);

    await expect(authority.claimCallbackVerifier({
      storageKey: AUTH_STORAGE_KEY,
      expected: claimed,
      marker: JSON.stringify({ kind: 'nanoflow-auth-callback', version: 1, attemptId: 'attempt-b' }),
      claimantKey: 'nanoflow:auth-callback:v1:claim:attempt-b',
      envelope: { version: 1, attemptId: 'attempt-b', code: 'code-b' },
    })).rejects.toThrow('AUTH_CALLBACK_VERIFIER_ALREADY_CLAIMED');
    expect(readBundle(harness.storage)).toEqual(claimed);
    expect(harness.claimantStorage.getItem(
      'nanoflow:auth-callback:v1:claim:attempt-b',
    )).toBeNull();
  });

  it('fails closed before moving a verifier when claimant storage is unavailable', async () => {
    const harness = createVmHarness();
    const authority = authorityFrom(harness);
    const expected = { session: null, codeVerifier: 'secret-verifier-a', user: null };
    writeBundle(harness.storage, expected);
    delete harness.context.sessionStorage;

    await expect(authority.claimCallbackVerifier({
      storageKey: AUTH_STORAGE_KEY,
      expected,
      marker: 'marker-a',
      claimantKey: 'nanoflow:auth-callback:v1:claim:attempt-a',
      envelope: { version: 1, attemptId: 'attempt-a', code: 'code-a' },
    })).rejects.toThrow('AUTH_CALLBACK_CLAIMANT_STORAGE_UNAVAILABLE');
    expect(readBundle(harness.storage)).toEqual(expected);
  });

  it('never restores a verifier when claimant storage fails after the marker commit', async () => {
    const harness = createVmHarness();
    const authority = authorityFrom(harness);
    const expected = { session: null, codeVerifier: 'secret-verifier-a', user: null };
    const marker = '{"kind":"nanoflow-auth-callback","attempt":"attempt-a"}';
    writeBundle(harness.storage, expected);
    vi.spyOn(harness.claimantStorage, 'setItem').mockImplementationOnce(() => {
      throw new Error('quota');
    });

    await expect(authority.claimCallbackVerifier({
      storageKey: AUTH_STORAGE_KEY,
      expected,
      marker,
      claimantKey: 'nanoflow:auth-callback:v1:claim:attempt-a',
      envelope: { version: 1, attemptId: 'attempt-a', code: 'callback-code-a' },
    })).rejects.toThrow('AUTH_CALLBACK_CLAIMANT_STORAGE_FAILED');

    expect(readBundle(harness.storage)).toEqual({ ...expected, codeVerifier: marker });
    await expect(authority.claimCallbackVerifier({
      storageKey: AUTH_STORAGE_KEY,
      expected,
      marker: 'second-marker',
      claimantKey: 'nanoflow:auth-callback:v1:claim:attempt-b',
      envelope: { version: 1, attemptId: 'attempt-b', code: 'callback-code-a' },
    })).rejects.toThrow('AUTH_CANONICAL_STORAGE_MISMATCH');
  });

  it('stages a unique generation until promotion and fences retired SDK writes', async () => {
    const harness = createVmHarness();
    const authority = authorityFrom(harness);
    const ownerA = { session: 'a', codeVerifier: 'va', user: 'ua' };
    writeBundle(harness.storage, ownerA);
    const generation = await authority.createGeneration(AUTH_STORAGE_KEY);

    expect(generation.storageKey).not.toBe(AUTH_STORAGE_KEY);
    expect(await generation.storage.getItem(generation.storageKey)).toBe('a');
    await generation.storage.setItem(generation.storageKey, 'b');
    await generation.storage.setItem(`${generation.storageKey}-code-verifier`, 'vb');
    await generation.storage.setItem(`${generation.storageKey}-user`, 'ub');
    expect(readBundle(harness.storage)).toEqual(ownerA);

    await expect(generation.promote()).resolves.toBe('committed');
    expect(readBundle(harness.storage)).toEqual({ session: 'b', codeVerifier: 'vb', user: 'ub' });
    generation.retire();
    await expect(generation.storage.setItem(generation.storageKey, 'late-a'))
      .rejects.toThrow('AUTH_CANONICAL_GENERATION_RETIRED');
    await expect(generation.storage.removeItem(generation.storageKey)).resolves.toBeUndefined();
    expect(readBundle(harness.storage)).toEqual({ session: null, codeVerifier: 'vb', user: 'ub' });
  });

  it('turns a retired removal into a no-op when another owner replaced its bundle', async () => {
    const harness = createVmHarness();
    const authority = authorityFrom(harness);
    const ownerA = { session: 'a', codeVerifier: 'va', user: 'ua' };
    const ownerB = { session: 'b', codeVerifier: 'vb', user: 'ub' };
    writeBundle(harness.storage, ownerA);
    const generation = await authority.createGeneration(AUTH_STORAGE_KEY);
    await generation.promote();
    generation.retire();
    writeBundle(harness.storage, ownerB);

    await expect(generation.storage.removeItem(generation.storageKey)).resolves.toBeUndefined();
    expect(readBundle(harness.storage)).toEqual(ownerB);
  });

  it('revalidates generation retirement after waiting for the canonical promotion lock', async () => {
    const harness = createVmHarness();
    const generation = await authorityFrom(harness).createGeneration(AUTH_STORAGE_KEY);
    await generation.storage.setItem(generation.storageKey, 'late-a');
    let releaseLock!: () => void;
    const lockHeld = new Promise<void>(resolve => { releaseLock = resolve; });
    const navigator = harness.context.navigator as {
      locks: { request: (name: string, options: unknown, callback: () => unknown) => Promise<unknown> };
    };
    navigator.locks.request = async (_name, _options, callback) => {
      await lockHeld;
      return callback();
    };

    const promotion = generation.promote();
    generation.retire();
    releaseLock();

    await expect(promotion).rejects.toThrow('AUTH_CANONICAL_GENERATION_RETIRED');
    expect(readBundle(harness.storage)).toEqual({ session: null, codeVerifier: null, user: null });
  });

  it('rejects a current generation set retired while waiting for the canonical lock', async () => {
    const harness = createVmHarness();
    const ownerA = { session: 'a', codeVerifier: 'va', user: 'ua' };
    writeBundle(harness.storage, ownerA);
    const generation = await authorityFrom(harness).createGeneration(AUTH_STORAGE_KEY);
    await generation.promote();
    let releaseLock!: () => void;
    const lockHeld = new Promise<void>(resolve => { releaseLock = resolve; });
    const navigator = harness.context.navigator as {
      locks: { request: (name: string, options: unknown, callback: () => unknown) => Promise<unknown> };
    };
    navigator.locks.request = async (_name, _options, callback) => {
      await lockHeld;
      return callback();
    };

    const write = generation.storage.setItem(generation.storageKey, 'late-a');
    generation.retire();
    releaseLock();

    await expect(write).rejects.toThrow('AUTH_CANONICAL_GENERATION_RETIRED');
    expect(readBundle(harness.storage)).toEqual(ownerA);
  });

  it.each([
    ['removes its exact owned value', null],
    ['becomes a successful no-op after B replaces the bundle', { session: 'b', codeVerifier: 'vb', user: 'ub' }],
  ])('lets a queued retired removal notify after it %s', async (_label, replacement) => {
    const harness = createVmHarness();
    const ownerA = { session: 'a', codeVerifier: 'va', user: 'ua' };
    writeBundle(harness.storage, ownerA);
    const generation = await authorityFrom(harness).createGeneration(AUTH_STORAGE_KEY);
    await generation.promote();
    let releaseLock!: () => void;
    const lockHeld = new Promise<void>(resolve => { releaseLock = resolve; });
    const navigator = harness.context.navigator as {
      locks: { request: (name: string, options: unknown, callback: () => unknown) => Promise<unknown> };
    };
    navigator.locks.request = async (_name, _options, callback) => {
      await lockHeld;
      return callback();
    };

    const removal = generation.storage.removeItem(generation.storageKey);
    generation.retire();
    if (replacement) writeBundle(harness.storage, replacement);
    releaseLock();

    await expect(removal).resolves.toBeUndefined();
    expect(readBundle(harness.storage)).toEqual(replacement ?? {
      session: null, codeVerifier: 'va', user: 'ua',
    });
  });

  it('does not publish or overwrite B when a late prewarm response was based on A', async () => {
    let resolveResponse!: (response: Response) => void;
    const fetchPromise = new Promise<Response>(resolve => {
      resolveResponse = resolve;
    });
    const harness = createVmHarness({ fetch: vi.fn(() => fetchPromise) as typeof fetch });
    const ownerA = {
      session: JSON.stringify({ refresh_token: 'refresh-a', expires_at: 1, user: { id: 'owner-a' } }),
      codeVerifier: 'verifier-a',
      user: '{"id":"owner-a"}',
    };
    const ownerB = {
      session: JSON.stringify({ access_token: 'token-b', refresh_token: 'refresh-b', user: { id: 'owner-b' } }),
      codeVerifier: 'verifier-b',
      user: '{"id":"owner-b"}',
    };
    writeBundle(harness.storage, ownerA);

    const prewarm = authorityFrom(harness).startSessionPrewarm({
      supabaseUrl: 'https://project.supabase.co',
      supabaseAnonKey: 'anon-key',
      bootFlags: { AUTH_RUNTIME_GATE_V1: false },
    });
    writeBundle(harness.storage, ownerB);
    resolveResponse(new Response(JSON.stringify({
      access_token: 'late-token-a',
      refresh_token: 'late-refresh-a',
      expires_in: 3600,
      user: { id: 'owner-a' },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    await prewarm;

    expect(readBundle(harness.storage)).toEqual(ownerB);
    expect(harness.windowState.__NANOFLOW_SESSION_PREWARM__).toEqual({ status: 'superseded' });
    expect(harness.trace).not.toHaveBeenCalledWith('auth.prewarm_refreshed', expect.anything());
  });

  it('preserves the PKCE verifier when the current prewarm credential is rejected', async () => {
    const harness = createVmHarness({
      fetch: vi.fn().mockResolvedValue(new Response(
        JSON.stringify({ error: 'invalid_grant' }),
        { status: 401, headers: { 'content-type': 'application/json' } },
      )) as typeof fetch,
    });
    writeBundle(harness.storage, {
      session: JSON.stringify({
        refresh_token: 'refresh-a',
        expires_at: 1,
        user: { id: 'owner-a' },
      }),
      codeVerifier: 'verifier-a',
      user: '{"id":"owner-a"}',
    });

    await authorityFrom(harness).startSessionPrewarm({
      supabaseUrl: 'https://project.supabase.co',
      supabaseAnonKey: 'anon-key',
      bootFlags: { AUTH_RUNTIME_GATE_V1: false },
    });

    expect(readBundle(harness.storage)).toEqual({
      session: null,
      codeVerifier: 'verifier-a',
      user: null,
    });
    expect(harness.windowState.__NANOFLOW_SESSION_PREWARM__).toEqual({ status: 'failed' });
  });

  it('runs the origin gate before the blocking authority and keeps prewarm in the index handoff', () => {
    const indexHtml = fs.readFileSync(path.join(process.cwd(), 'index.html'), 'utf8');
    const reference = '<script src="/assets/auth-canonical-storage-bootstrap-v1.js"></script>';
    const referenceIndex = indexHtml.indexOf(reference);
    const originGateIndex = indexHtml.indexOf('id="canonical-origin-gate"');
    const originGateEnd = indexHtml.indexOf('</script>', originGateIndex);

    expect(referenceIndex).toBeGreaterThan(-1);
    expect(originGateIndex).toBeGreaterThan(-1);
    expect(originGateEnd).toBeGreaterThan(originGateIndex);
    expect(referenceIndex).toBeGreaterThan(originGateEnd);
    expect(indexHtml).not.toContain(`${reference.slice(0, -10)} defer`);
    expect(indexHtml).toContain("var SUPABASE_URL = 'https://your-project.supabase.co';");
    expect(indexHtml).toContain("var SUPABASE_ANON_KEY = 'YOUR_SUPABASE_ANON_KEY';");
    expect(indexHtml).toContain('.startSessionPrewarm({');
  });

  it('copies only the shared authority reference into launch and precaches the actual asset in app-core', () => {
    const require = createRequire(import.meta.url);
    const { buildLaunchHtml } = require('../../scripts/generate-launch-html.cjs') as {
      buildLaunchHtml: (indexHtml: string, templateHtml: string) => string;
    };
    const sourceIndex = fs.readFileSync(path.join(process.cwd(), 'index.html'), 'utf8');
    const builtIndex = sourceIndex.replace(
      '</body>',
      '<script src="polyfills-test.js" type="module"></script>\n<script src="main-test.js" type="module"></script>\n</body>',
    );
    const launchHtml = buildLaunchHtml(
      builtIndex,
      fs.readFileSync(path.join(process.cwd(), 'public', 'launch.html'), 'utf8'),
    );
    const ngswConfig = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), 'ngsw-config.json'), 'utf8'),
    ) as { assetGroups: Array<{ name: string; resources: { files: string[] } }> };
    const appCore = ngswConfig.assetGroups.find(group => group.name === 'app-core');

    expect(launchHtml).toContain('/assets/auth-canonical-storage-bootstrap-v1.js');
    expect(launchHtml).not.toContain('.startSessionPrewarm({');
    expect(appCore?.resources.files).toContain('/assets/auth-canonical-storage-bootstrap-v1.js');
  });
});
