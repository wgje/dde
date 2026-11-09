import { afterEach, describe, expect, it, vi } from 'vitest';

import { AuthBackgroundSessionRefreshController } from './auth-background-session-refresh.controller';

afterEach(() => {
  vi.useRealTimers();
});

describe('AuthBackgroundSessionRefreshController', () => {
  it('schedules an SDK session refresh and applies the current result', async () => {
    vi.useFakeTimers();
    const ctx = createContext();
    const controller = new AuthBackgroundSessionRefreshController(ctx);

    controller.schedule();
    await vi.runAllTimersAsync();
    await flushMicrotasks();

    expect(ctx.getSession).toHaveBeenCalledOnce();
    expect(ctx.applySessionUser).toHaveBeenCalledWith({
      id: 'user-1',
      email: 'user@example.com',
    });
  });

  it('cancels a pending idle refresh before it dispatches', () => {
    let idleCallback: (() => void) | null = null;
    const idleOwner = window as Window & {
      requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
      cancelIdleCallback?: (handle: number) => void;
    };
    const originalRequestIdleCallback = idleOwner.requestIdleCallback;
    const originalCancelIdleCallback = idleOwner.cancelIdleCallback;
    const requestIdleCallback = vi.fn((callback: () => void) => {
      idleCallback = callback;
      return 23;
    });
    const cancelIdleCallback = vi.fn();
    Object.defineProperty(idleOwner, 'requestIdleCallback', {
      configurable: true,
      value: requestIdleCallback,
    });
    Object.defineProperty(idleOwner, 'cancelIdleCallback', {
      configurable: true,
      value: cancelIdleCallback,
    });
    const ctx = createContext();
    const controller = new AuthBackgroundSessionRefreshController(ctx);

    try {
      controller.schedule();
      controller.cancelPending();
      (idleCallback as (() => void) | null)?.();

      expect(cancelIdleCallback).toHaveBeenCalledWith(23);
      expect(ctx.getSession).not.toHaveBeenCalled();
    } finally {
      if (originalRequestIdleCallback) {
        idleOwner.requestIdleCallback = originalRequestIdleCallback;
      } else {
        Reflect.deleteProperty(idleOwner, 'requestIdleCallback');
      }
      if (originalCancelIdleCallback) {
        idleOwner.cancelIdleCallback = originalCancelIdleCallback;
      } else {
        Reflect.deleteProperty(idleOwner, 'cancelIdleCallback');
      }
    }
  });

  it('falls back to a timer without throwing when requestIdleCallback throws', async () => {
    vi.useFakeTimers();
    const idleOwner = window as Window & {
      requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
      cancelIdleCallback?: (handle: number) => void;
    };
    const originalRequestIdleCallback = idleOwner.requestIdleCallback;
    const originalCancelIdleCallback = idleOwner.cancelIdleCallback;
    Object.defineProperty(idleOwner, 'requestIdleCallback', {
      configurable: true,
      value: vi.fn(() => {
        throw new Error('idle scheduling failed');
      }),
    });
    Object.defineProperty(idleOwner, 'cancelIdleCallback', {
      configurable: true,
      value: vi.fn(),
    });
    const ctx = createContext();
    const controller = new AuthBackgroundSessionRefreshController(ctx);

    try {
      expect(() => controller.schedule()).not.toThrow();
      await vi.runAllTimersAsync();
      await flushMicrotasks();

      expect(ctx.getSession).toHaveBeenCalledOnce();
      expect(ctx.applySessionUser).toHaveBeenCalledOnce();
      expect(ctx.warn).toHaveBeenCalledWith(
        '[BackgroundRefresh] requestIdleCallback scheduling failed; using timer fallback',
        undefined,
      );
    } finally {
      restoreIdleCallbacks(idleOwner, originalRequestIdleCallback, originalCancelIdleCallback);
    }
  });

  it('does not throw on cancelIdleCallback failure and keeps stale idle callbacks inert', async () => {
    vi.useFakeTimers();
    const idleOwner = window as Window & {
      requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
      cancelIdleCallback?: (handle: number) => void;
    };
    const originalRequestIdleCallback = idleOwner.requestIdleCallback;
    const originalCancelIdleCallback = idleOwner.cancelIdleCallback;
    const idleCallbacks: Array<() => void> = [];
    const requestIdleCallback = vi.fn((callback: () => void) => {
      idleCallbacks.push(callback);
      return idleCallbacks.length;
    });
    const cancelIdleCallback = vi.fn(() => {
      throw new Error('cancel idle failed');
    });
    Object.defineProperty(idleOwner, 'requestIdleCallback', {
      configurable: true,
      value: requestIdleCallback,
    });
    Object.defineProperty(idleOwner, 'cancelIdleCallback', {
      configurable: true,
      value: cancelIdleCallback,
    });
    const ctx = createContext();
    const controller = new AuthBackgroundSessionRefreshController(ctx);

    try {
      controller.schedule();
      expect(() => controller.schedule()).not.toThrow();
      expect(cancelIdleCallback).toHaveBeenCalledTimes(1);

      idleCallbacks[0]?.();
      idleCallbacks[1]?.();
      await flushMicrotasks();

      expect(ctx.getSession).toHaveBeenCalledOnce();
      expect(ctx.applySessionUser).toHaveBeenCalledOnce();
    } finally {
      restoreIdleCallbacks(idleOwner, originalRequestIdleCallback, originalCancelIdleCallback);
    }
  });

  it('drops a delayed refresh result after the auth identity changes', async () => {
    vi.useFakeTimers();
    let generation = 1;
    let userId: string | null = 'user-1';
    const deferred = createDeferred<{
      data: { session: { user: { id: string; email: string } } };
      error: null;
    }>();
    const ctx = createContext({
      authIdentityGeneration: () => generation,
      currentUserId: () => userId,
      getSession: vi.fn(() => deferred.promise),
    });
    const controller = new AuthBackgroundSessionRefreshController(ctx);

    controller.schedule();
    await vi.runAllTimersAsync();
    generation = 2;
    userId = 'user-2';
    deferred.resolve({
      data: { session: { user: { id: 'user-1', email: 'user@example.com' } } },
      error: null,
    });
    await flushMicrotasks();

    expect(ctx.applySessionUser).not.toHaveBeenCalled();
    expect(ctx.invalidateSession).not.toHaveBeenCalled();
  });

  it('drops a delayed result after canonical authority changes without an auth event', async () => {
    vi.useFakeTimers();
    let canonicalBundle = createCanonicalBundle('token-a', 'user-1');
    const deferred = createDeferred<BackgroundResult>();
    const ctx = {
      ...createContext({ getSession: vi.fn(() => deferred.promise) }),
      canonicalBundle: () => canonicalBundle,
    };
    const controller = new AuthBackgroundSessionRefreshController(ctx);

    controller.schedule();
    await vi.runAllTimersAsync();
    canonicalBundle = createCanonicalBundle('token-b', 'user-2');
    deferred.resolve(sessionResult('user-2', 'other@example.com'));
    await flushMicrotasks();

    expectNoScheduledEffects(ctx);
  });

  it('drops a delayed result after same-owner canonical token rotation', async () => {
    vi.useFakeTimers();
    let canonicalBundle = createCanonicalBundle('token-a', 'user-1');
    const deferred = createDeferred<BackgroundResult>();
    const ctx = {
      ...createContext({ getSession: vi.fn(() => deferred.promise) }),
      canonicalBundle: () => canonicalBundle,
    };
    const controller = new AuthBackgroundSessionRefreshController(ctx);

    controller.schedule();
    await vi.runAllTimersAsync();
    canonicalBundle = createCanonicalBundle('token-a-new', 'user-1');
    deferred.resolve(sessionResult('user-1', 'user@example.com'));
    await flushMicrotasks();

    expectNoScheduledEffects(ctx);
  });

  it.each([
    ['empty session', (deferred: Deferred<BackgroundResult>) =>
      deferred.resolve({ data: { session: null }, error: null })],
    ['authentication error', (deferred: Deferred<BackgroundResult>) => deferred.resolve({
      data: { session: null },
      error: { message: 'Invalid Refresh Token', status: 401 },
    })],
    ['authentication rejection', (deferred: Deferred<BackgroundResult>) =>
      deferred.reject(new Error('Invalid Refresh Token'))],
  ])('drops stale %s after canonical replacement', async (_label, settle) => {
    vi.useFakeTimers();
    let canonicalBundle = createCanonicalBundle('token-a', 'user-1');
    const deferred = createDeferred<BackgroundResult>();
    const ctx = {
      ...createContext({ getSession: vi.fn(() => deferred.promise) }),
      canonicalBundle: () => canonicalBundle,
    };
    const controller = new AuthBackgroundSessionRefreshController(ctx);

    controller.schedule();
    await vi.runAllTimersAsync();
    canonicalBundle = createCanonicalBundle('token-b', 'user-2');
    settle(deferred);
    await flushMicrotasks();

    expectNoScheduledEffects(ctx);
  });

  it('retires an in-flight generation when a newer refresh is scheduled', async () => {
    vi.useFakeTimers();
    const first = createDeferred<BackgroundResult>();
    const second = createDeferred<BackgroundResult>();
    const ctx = createContext({
      getSession: vi.fn()
        .mockImplementationOnce(() => first.promise)
        .mockImplementationOnce(() => second.promise),
    });
    const controller = new AuthBackgroundSessionRefreshController(ctx);

    controller.schedule();
    await vi.runAllTimersAsync();
    controller.schedule();
    await vi.runAllTimersAsync();
    second.resolve(sessionResult('user-1', 'user@example.com'));
    await flushMicrotasks();
    first.resolve(sessionResult('user-1', 'user@example.com'));
    await flushMicrotasks();

    expect(ctx.applySessionUser).toHaveBeenCalledOnce();
    expect(ctx.invalidateSession).not.toHaveBeenCalled();
  });

  it('drops a result when the exact pending owner changes during the request', async () => {
    vi.useFakeTimers();
    let pendingOwner: string | null = null;
    const deferred = createDeferred<BackgroundResult>();
    const ctx = createContext({
      pendingOwnerUserId: () => pendingOwner,
      getSession: vi.fn(() => deferred.promise),
    });
    const controller = new AuthBackgroundSessionRefreshController(ctx);

    controller.schedule();
    await vi.runAllTimersAsync();
    pendingOwner = 'user-1';
    deferred.resolve(sessionResult('user-1', 'user@example.com'));
    await flushMicrotasks();

    expectNoScheduledEffects(ctx);
  });

  it('treats a returned different-owner session as inert', async () => {
    vi.useFakeTimers();
    const ctx = createContext({
      getSession: vi.fn().mockResolvedValue({
        data: { session: { user: { id: 'user-2', email: 'other@example.com' } } },
        error: null,
      }),
    });
    const controller = new AuthBackgroundSessionRefreshController(ctx);

    controller.schedule();
    await vi.runAllTimersAsync();
    await flushMicrotasks();

    expect(ctx.applySessionUser).not.toHaveBeenCalled();
    expect(ctx.invalidateSession).not.toHaveBeenCalled();
    expect(ctx.warn).not.toHaveBeenCalled();
    expect(ctx.trace).not.toHaveBeenCalled();
  });

  it('still invalidates an exact-current empty scheduled session once', async () => {
    vi.useFakeTimers();
    const ctx = createContext({
      getSession: vi.fn().mockResolvedValue({ data: { session: null }, error: null }),
    });
    const controller = new AuthBackgroundSessionRefreshController(ctx);

    controller.schedule();
    await vi.runAllTimersAsync();
    await flushMicrotasks();

    expect(ctx.invalidateSession).toHaveBeenCalledOnce();
  });

  it.each([
    ['authority is unavailable', { canonicalBundle: () => null }],
    ['authority is malformed', { canonicalBundle: () => ({ session: 42, codeVerifier: null, user: null }) }],
    ['storage key is unavailable', { storageKey: () => null }],
  ])('fails closed when %s', async (_label, override) => {
    vi.useFakeTimers();
    const ctx = { ...createContext(), ...override } as unknown as ReturnType<typeof createContext>;
    const controller = new AuthBackgroundSessionRefreshController(ctx);

    controller.schedule();
    await vi.runAllTimersAsync();

    expect(ctx.getSession).not.toHaveBeenCalled();
    expectNoScheduledEffects(ctx);
  });

  it('applies returned session users', () => {
    const ctx = createContext();
    const controller = new AuthBackgroundSessionRefreshController(ctx);

    controller.handleResult({
      data: { session: { user: { id: 'user-1', email: 'user@example.com' } } },
      error: null,
    });

    expect(ctx.applySessionUser).toHaveBeenCalledWith({ id: 'user-1', email: 'user@example.com' });
    expect(ctx.trace).toHaveBeenCalledWith('auth.background_refresh_synced', { userId: 'user-1' });
  });

  it('invalidates local session on empty session or auth errors', () => {
    const ctx = createContext();
    const controller = new AuthBackgroundSessionRefreshController(ctx);

    controller.handleResult({ data: { session: null }, error: null });
    controller.handleError(new Error('auth failed'));

    expect(ctx.invalidateSession).toHaveBeenCalledTimes(2);
    expect(ctx.trace).toHaveBeenCalledWith('auth.background_refresh_invalid_session', {
      runtimeState: 'ready',
      currentUserId: 'user-1',
    });
    expect(ctx.trace).toHaveBeenCalledWith('auth.background_refresh_auth_error', {
      currentUserId: 'user-1',
    });
  });

  it('still invalidates an empty background session when warning fails', () => {
    const ctx = createContext({
      warn: vi.fn(() => {
        throw new Error('warn failed');
      }),
    });
    const controller = new AuthBackgroundSessionRefreshController(ctx);

    expect(() => controller.handleResult({ data: { session: null }, error: null })).not.toThrow();

    expect(ctx.invalidateSession).toHaveBeenCalledTimes(1);
    expect(ctx.trace).toHaveBeenCalledWith('auth.background_refresh_invalid_session', {
      runtimeState: 'ready',
      currentUserId: 'user-1',
    });
  });

  it('still invalidates an auth error result when trace fails', () => {
    const ctx = createContext({
      isAuthenticationError: () => true,
      trace: vi.fn(() => {
        throw new Error('trace failed');
      }),
    });
    const controller = new AuthBackgroundSessionRefreshController(ctx);

    expect(() => controller.handleResult({
      data: { session: null },
      error: { message: 'Invalid Refresh Token', status: 401 },
    })).not.toThrow();

    expect(ctx.invalidateSession).toHaveBeenCalledTimes(1);
    expect(ctx.warn).toHaveBeenCalledWith(
      '[BackgroundRefresh] SDK getSession 返回错误，清除本地会话',
      { message: 'Invalid Refresh Token', status: 401 }
    );
  });

  it('does not turn a successful background refresh into an error when observers fail', () => {
    const ctx = createContext({
      debug: vi.fn(() => {
        throw new Error('debug failed');
      }),
      trace: vi.fn(() => {
        throw new Error('trace failed');
      }),
      isAuthenticationError: vi.fn(),
    });
    const controller = new AuthBackgroundSessionRefreshController(ctx);

    expect(() => controller.handleResult({
      data: { session: { user: { id: 'user-1', email: 'user@example.com' } } },
      error: null,
    })).not.toThrow();

    expect(ctx.applySessionUser).toHaveBeenCalledWith({ id: 'user-1', email: 'user@example.com' });
    expect(ctx.invalidateSession).not.toHaveBeenCalled();
    expect(ctx.isAuthenticationError).not.toHaveBeenCalled();
  });

  it('preserves local state for retryable background errors when observers fail', () => {
    const ctx = createContext({
      isAuthenticationError: () => false,
      debug: vi.fn(() => {
        throw new Error('debug failed');
      }),
      trace: vi.fn(() => {
        throw new Error('trace failed');
      }),
    });
    const controller = new AuthBackgroundSessionRefreshController(ctx);

    expect(() => controller.handleError(new Error('network'))).not.toThrow();

    expect(ctx.invalidateSession).not.toHaveBeenCalled();
  });

  it('preserves local state for client-unavailable or network errors', () => {
    const ctx = createContext({ isAuthenticationError: () => false });
    const controller = new AuthBackgroundSessionRefreshController(ctx);

    controller.handleResult({
      data: null,
      error: { message: 'Client unavailable', name: 'ClientUnavailable' },
    });
    controller.handleError(new Error('network'));

    expect(ctx.invalidateSession).not.toHaveBeenCalled();
    expect(ctx.trace).toHaveBeenCalledWith('auth.background_refresh_client_unavailable', {
      runtimeState: 'ready',
      currentUserId: 'user-1',
    });
    expect(ctx.trace).toHaveBeenCalledWith('auth.background_refresh_network_preserved', {
      currentUserId: 'user-1',
    });
  });

  it('preserves local state when getSession returns a retryable refresh error', () => {
    const ctx = createContext({ isAuthenticationError: () => false });
    const controller = new AuthBackgroundSessionRefreshController(ctx);

    controller.handleResult({
      data: { session: null },
      error: { message: 'Failed to fetch', name: 'AuthRetryableFetchError' },
    });

    expect(ctx.invalidateSession).not.toHaveBeenCalled();
    expect(ctx.trace).toHaveBeenCalledWith('auth.background_refresh_network_preserved', {
      currentUserId: 'user-1',
    });
  });

  it('invalidates local state when getSession returns an authentication error', () => {
    const ctx = createContext({ isAuthenticationError: () => true });
    const controller = new AuthBackgroundSessionRefreshController(ctx);

    controller.handleResult({
      data: { session: null },
      error: { message: 'Invalid Refresh Token', status: 401 },
    });

    expect(ctx.invalidateSession).toHaveBeenCalledTimes(1);
    expect(ctx.trace).toHaveBeenCalledWith('auth.background_refresh_auth_error', {
      currentUserId: 'user-1',
    });
  });
});

function createContext(overrides: Partial<ConstructorParameters<typeof AuthBackgroundSessionRefreshController>[0]> = {}) {
  return {
    storageKey: () => 'sb-test-auth-token',
    canonicalBundle: () => createCanonicalBundle('token-a', 'user-1'),
    currentUserId: () => 'user-1',
    pendingOwnerUserId: () => null,
    runtimeState: () => 'ready',
    authIdentityGeneration: () => 1,
    destroyed: () => false,
    getSession: vi.fn().mockResolvedValue({
      data: { session: { user: { id: 'user-1', email: 'user@example.com' } } },
      error: null,
    }),
    applySessionUser: vi.fn(),
    invalidateSession: vi.fn(),
    isAuthenticationError: () => true,
    trace: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    ...overrides,
  };
}

type BackgroundResult = Awaited<ReturnType<
  ConstructorParameters<typeof AuthBackgroundSessionRefreshController>[0]['getSession']
>>;

function sessionResult(userId: string, email: string): BackgroundResult {
  return { data: { session: { user: { id: userId, email } } }, error: null };
}

function createCanonicalBundle(accessToken: string, userId: string) {
  return {
    session: JSON.stringify({ access_token: accessToken, user: { id: userId } }),
    codeVerifier: `verifier-${accessToken}`,
    user: JSON.stringify({ id: userId }),
  };
}

function expectNoScheduledEffects(ctx: ReturnType<typeof createContext>): void {
  expect(ctx.applySessionUser).not.toHaveBeenCalled();
  expect(ctx.invalidateSession).not.toHaveBeenCalled();
  expect(ctx.warn).not.toHaveBeenCalled();
  expect(ctx.debug).not.toHaveBeenCalled();
  expect(ctx.trace).not.toHaveBeenCalled();
}

type Deferred<T> = ReturnType<typeof createDeferred<T>>;

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
  }
}

function restoreIdleCallbacks(
  owner: Window & {
    requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
    cancelIdleCallback?: (handle: number) => void;
  },
  originalRequestIdleCallback: typeof owner.requestIdleCallback,
  originalCancelIdleCallback: typeof owner.cancelIdleCallback,
): void {
  if (originalRequestIdleCallback) {
    owner.requestIdleCallback = originalRequestIdleCallback;
  } else {
    Reflect.deleteProperty(owner, 'requestIdleCallback');
  }
  if (originalCancelIdleCallback) {
    owner.cancelIdleCallback = originalCancelIdleCallback;
  } else {
    Reflect.deleteProperty(owner, 'cancelIdleCallback');
  }
}
