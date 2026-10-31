import { signal } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';

import type { AuthState } from './auth.service';
import {
  AuthCredentialFlowController,
  type AuthCredentialStateCommitPredicate,
} from './auth-credential-flow.controller';
import { AuthDevAutoLoginController } from './auth-dev-auto-login.controller';
import {
  AuthSessionCheckController,
  type AuthSessionCheckContext,
} from './auth-session-check.controller';

describe('AuthSessionCheckController', () => {
  it('returns no session when Supabase is not configured', async () => {
    const ctx = createContext({ isSupabaseConfigured: () => false });
    const controller = new AuthSessionCheckController(ctx);

    await expect(controller.checkSession()).resolves.toEqual({ userId: null, email: null });

    expect(ctx.sessionInitialized()).toBe(true);
    expect(ctx.authState().isCheckingSession).toBe(false);
  });

  it('uses local fast path and schedules background/runtime refresh', async () => {
    const ctx = createContext({
      readLocalSessionFastPath: () => ({ userId: 'user-1', email: 'user@example.com' }),
    });
    const controller = new AuthSessionCheckController(ctx);

    await expect(controller.checkSession()).resolves.toEqual({ userId: 'user-1', email: 'user@example.com' });

    expect(ctx.applyAuthenticatedIdentity).toHaveBeenCalledWith('user-1', 'user@example.com', {
      isCheckingSession: false,
      syncSentryUser: true,
    });
    expect(ctx.setProvisionalAuthState).toHaveBeenCalledWith('ready');
    expect(ctx.scheduleBackgroundSessionRefresh).toHaveBeenCalled();
    expect(ctx.scheduleRuntimeAuthReadyInitialization).toHaveBeenCalled();
  });

  it('applies network sessions and clears owner hints for anonymous sessions', async () => {
    const network = createContext({
      getSession: vi.fn(async () => ({
        data: { session: { user: { id: 'user-1', email: 'user@example.com' } } },
        error: null,
      })),
    });

    await expect(new AuthSessionCheckController(network).checkSession())
      .resolves.toEqual({ userId: 'user-1', email: 'user@example.com' });
    expect(network.applyAuthenticatedIdentity).toHaveBeenCalledWith('user-1', 'user@example.com', {
      syncSentryUser: true,
    });

    const anonymous = createContext();
    await expect(new AuthSessionCheckController(anonymous).checkSession())
      .resolves.toEqual({ userId: null, email: null });
    expect(anonymous.setPersistedOwnerHint).toHaveBeenCalledWith(null);
    expect(anonymous.setPersistedSessionUserId).toHaveBeenCalledWith(null);
  });

  it('defers checks during browser network suspension', async () => {
    const ctx = createContext({
      isBrowserNetworkSuspendedWindow: () => true,
      currentUserId: () => 'cached-user',
      sessionEmail: () => 'cached@example.com',
    });

    await expect(new AuthSessionCheckController(ctx).checkSession())
      .resolves.toEqual({ userId: 'cached-user', email: 'cached@example.com' });

    expect(ctx.authState()).toMatchObject({
      userId: 'cached-user',
      email: 'cached@example.com',
      error: null,
      isCheckingSession: false,
    });
    expect(ctx.sessionInitialized()).toBe(true);
    expect(ctx.scheduleBackgroundSessionRefresh).toHaveBeenCalled();
    expect(ctx.scheduleRuntimeAuthReadyInitialization).toHaveBeenCalled();
  });

  it('drops a delayed network session after the current identity changes', async () => {
    const deferred = createDeferred<Awaited<ReturnType<AuthSessionCheckContext['getSession']>>>();
    let currentUserId: string | null = 'old-user';
    let sessionEmail: string | null = 'old@example.com';
    let authIdentityGeneration = 0;
    const ctx = createContext({ getSession: vi.fn(() => deferred.promise) });
    ctx.currentUserId = () => currentUserId;
    ctx.sessionEmail = () => sessionEmail;
    ctx.authIdentityGeneration = () => authIdentityGeneration;
    const resultPromise = new AuthSessionCheckController(ctx).checkSession();
    await vi.waitFor(() => expect(ctx.getSession).toHaveBeenCalled());

    currentUserId = null;
    sessionEmail = null;
    authIdentityGeneration += 1;
    deferred.resolve({
      data: { session: { user: { id: 'old-user', email: 'old@example.com' } } },
      error: null,
    });

    await expect(resultPromise).resolves.toEqual({ userId: null, email: null });
    expect(ctx.applyAuthenticatedIdentity).not.toHaveBeenCalled();
  });

  it('drops a delayed dev auto-login success after the current identity changes', async () => {
    const deferred = createDeferred<{ userId: string | null; email: string | null } | null>();
    let currentUserId: string | null = null;
    let sessionEmail: string | null = null;
    let authIdentityGeneration = 0;
    const ctx = createContext();
    ctx.currentUserId = () => currentUserId;
    ctx.sessionEmail = () => sessionEmail;
    ctx.authIdentityGeneration = () => authIdentityGeneration;
    ctx.tryDevAutoLogin = vi.fn(async (
      canCommitCredentialState?: AuthCredentialStateCommitPredicate,
    ) => {
      const result = await deferred.promise;
      if (result?.userId && (canCommitCredentialState?.(result) ?? true)) {
        sessionEmail = result.email;
        ctx.authState.update(state => ({
          ...state,
          userId: result.userId,
          email: result.email,
          error: null,
        }));
      }
      return result;
    });
    const resultPromise = new AuthSessionCheckController(ctx).checkSession();
    await vi.waitFor(() => expect(ctx.tryDevAutoLogin).toHaveBeenCalled());

    currentUserId = 'new-user';
    sessionEmail = 'new@example.com';
    authIdentityGeneration += 1;
    ctx.authState.set({
      ...ctx.authState(),
      userId: currentUserId,
      email: sessionEmail,
      isCheckingSession: true,
    });
    ctx.sessionInitialized.set(false);
    deferred.resolve({ userId: 'stale-user', email: 'stale@example.com' });

    const result = await resultPromise;

    expect(ctx.tryDevAutoLogin).toHaveBeenCalledWith(expect.any(Function));
    expect.soft(result).toEqual({
      userId: 'new-user',
      email: 'new@example.com',
    });
    expect.soft(sessionEmail).toBe('new@example.com');
    expect(ctx.authState()).toMatchObject({
      userId: 'new-user',
      email: 'new@example.com',
      isCheckingSession: true,
    });
    expect(ctx.sessionInitialized()).toBe(false);
  });

  it('finalizes dev auto-login when its SIGNED_IN callback advances the identity generation', async () => {
    const harness = createRealOrderDevAutoLoginHarness();
    const resultPromise = new AuthSessionCheckController(harness.ctx).checkSession();
    await vi.waitFor(() => expect(harness.signIn).toHaveBeenCalled());

    harness.applySignedIn('dev-user', 'dev@example.com');
    harness.signInResult.resolve({
      ok: true,
      value: { userId: 'dev-user', email: 'dev@example.com' },
    });

    await expect(resultPromise).resolves.toEqual({
      userId: 'dev-user',
      email: 'dev@example.com',
    });
    expect.soft(harness.applyCredentialIdentity).toHaveBeenCalledWith({
      userId: 'dev-user',
      email: 'dev@example.com',
    });
    expect.soft(harness.ctx.authState()).toMatchObject({
      userId: 'dev-user',
      email: 'dev@example.com',
      isLoading: false,
      isCheckingSession: false,
    });
    expect.soft(harness.ctx.sessionInitialized()).toBe(true);
  });

  it('keeps an external logout authoritative after the same dev sign-in callback sequence', async () => {
    const harness = createRealOrderDevAutoLoginHarness();
    const resultPromise = new AuthSessionCheckController(harness.ctx).checkSession();
    await vi.waitFor(() => expect(harness.signIn).toHaveBeenCalled());

    harness.applySignedIn('dev-user', 'dev@example.com');
    harness.applySignedOut();
    harness.signInResult.resolve({
      ok: true,
      value: { userId: 'dev-user', email: 'dev@example.com' },
    });

    await expect(resultPromise).resolves.toEqual({ userId: null, email: null });
    expect(harness.applyCredentialIdentity).not.toHaveBeenCalled();
    expect(harness.ctx.authState()).toMatchObject({
      userId: null,
      email: null,
      isLoading: false,
      isCheckingSession: false,
    });
    expect(harness.ctx.sessionInitialized()).toBe(true);
  });

  it('adopts a delayed dev auto-login success while the check fence remains current', async () => {
    const deferred = createDeferred<{ userId: string | null; email: string | null } | null>();
    const ctx = createContext({ tryDevAutoLogin: vi.fn(() => deferred.promise) });
    const resultPromise = new AuthSessionCheckController(ctx).checkSession();
    await vi.waitFor(() => expect(ctx.tryDevAutoLogin).toHaveBeenCalled());

    deferred.resolve({ userId: 'dev-user', email: 'dev@example.com' });

    await expect(resultPromise).resolves.toEqual({
      userId: 'dev-user',
      email: 'dev@example.com',
    });
    expect(ctx.authState().isCheckingSession).toBe(false);
    expect(ctx.sessionInitialized()).toBe(true);
  });

  it('preserves newer pending owner hints when an earlier network check resolves anonymous', async () => {
    const deferred = createDeferred<Awaited<ReturnType<AuthSessionCheckContext['getSession']>>>();
    let pendingOwnerUserId: string | null = null;
    const ctx = createContext({ getSession: vi.fn(() => deferred.promise) });
    ctx.pendingOwnerUserId = () => pendingOwnerUserId;
    const resultPromise = new AuthSessionCheckController(ctx).checkSession();
    await vi.waitFor(() => expect(ctx.getSession).toHaveBeenCalled());

    pendingOwnerUserId = 'owner-b';
    deferred.resolve({ data: { session: null }, error: null });

    await expect(resultPromise).resolves.toEqual({ userId: null, email: null });
    expect(ctx.tryDevAutoLogin).not.toHaveBeenCalled();
    expect(ctx.setPersistedOwnerHint).not.toHaveBeenCalled();
    expect(ctx.setPersistedSessionUserId).not.toHaveBeenCalled();
  });

  it('clears the completed session-check timeout handle', async () => {
    const timeoutHandle = 7 as unknown as ReturnType<typeof setTimeout>;
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockReturnValue(timeoutHandle);
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout').mockImplementation(() => undefined);
    try {
      const ctx = createContext({
        getSession: vi.fn(async () => ({ data: { session: null }, error: null })),
      });

      await expect(new AuthSessionCheckController(ctx).checkSession())
        .resolves.toEqual({ userId: null, email: null });
      expect(setTimeoutSpy).toHaveBeenCalledOnce();
      expect(clearTimeoutSpy).toHaveBeenCalledWith(timeoutHandle);
    } finally {
      setTimeoutSpy.mockRestore();
      clearTimeoutSpy.mockRestore();
    }
  });
});

function createRealOrderDevAutoLoginHarness() {
  const signInResult = createDeferred<{
    ok: true;
    value: { userId: string; email: string };
  }>();
  let currentUserId: string | null = null;
  let sessionEmail: string | null = null;
  let authIdentityGeneration = 0;
  const ctx = createContext();
  ctx.currentUserId = () => currentUserId;
  ctx.sessionEmail = () => sessionEmail;
  ctx.authIdentityGeneration = () => authIdentityGeneration;
  const applyCredentialIdentity = vi.fn((identity: { userId?: string; email?: string }) => {
    if (!identity.userId) return;
    sessionEmail = identity.email ?? null;
    ctx.authState.update(state => ({
      ...state,
      userId: identity.userId ?? null,
      email: sessionEmail,
      error: null,
    }));
  });
  const credentialFlow = new AuthCredentialFlowController({
    authState: ctx.authState,
    applyCredentialIdentity,
  });
  const signIn = vi.fn((
    _email: string,
    _password: string,
    canCommitCredentialState?: AuthCredentialStateCommitPredicate,
  ) => credentialFlow.run(() => signInResult.promise, canCommitCredentialState));
  const devAutoLogin = new AuthDevAutoLoginController({
    devAutoLogin: { email: 'dev@example.com', password: 'secret' },
    production: false,
    signIn,
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  });
  ctx.tryDevAutoLogin = canCommitCredentialState =>
    devAutoLogin.tryDevAutoLogin(canCommitCredentialState);

  return {
    ctx,
    signIn,
    signInResult,
    applyCredentialIdentity,
    applySignedIn(userId: string, email: string) {
      currentUserId = userId;
      sessionEmail = email;
      authIdentityGeneration += 1;
      ctx.authState.update(state => ({
        ...state,
        userId,
        email,
        error: null,
        isCheckingSession: false,
      }));
    },
    applySignedOut() {
      currentUserId = null;
      sessionEmail = null;
      authIdentityGeneration += 1;
      ctx.authState.set({
        ...ctx.authState(),
        userId: null,
        email: null,
        error: null,
        isLoading: false,
        isCheckingSession: false,
      });
      ctx.sessionInitialized.set(true);
    },
  };
}

function createContext(overrides: Partial<ConstructorParameters<typeof AuthSessionCheckController>[0]> = {}) {
  const authState = signal<AuthState>({
    isCheckingSession: false,
    isLoading: false,
    userId: null,
    email: null,
    error: null,
  });

  return {
    isSupabaseConfigured: () => true,
    authState,
    sessionInitialized: signal(false),
    currentUserId: () => null,
    pendingOwnerUserId: () => null,
    sessionEmail: () => null,
    authIdentityGeneration: () => 0,
    runtimeState: () => 'idle',
    readLocalSessionFastPath: () => null,
    isBrowserNetworkSuspendedWindow: () => false,
    isBrowserNetworkSuspendedError: () => false,
    ensureRuntimeAuthReady: vi.fn(async () => {}),
    getSession: vi.fn(async () => ({ data: { session: null }, error: null })),
    tryDevAutoLogin: vi.fn(async () => null),
    applyAuthenticatedIdentity: vi.fn(),
    setPersistedOwnerHint: vi.fn(),
    setPersistedSessionUserId: vi.fn(),
    setProvisionalAuthState: vi.fn(),
    scheduleBackgroundSessionRefresh: vi.fn(),
    scheduleRuntimeAuthReadyInitialization: vi.fn(),
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    ...overrides,
  };
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(res => {
    resolve = res;
  });
  return { promise, resolve };
}
