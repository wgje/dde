import { signal } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';

import type { AuthState } from './auth.service';
import { AuthSessionCheckController } from './auth-session-check.controller';

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
});

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
    sessionEmail: () => null,
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
