import { describe, expect, it, vi } from 'vitest';

import { AuthBackgroundSessionRefreshController } from './auth-background-session-refresh.controller';

describe('AuthBackgroundSessionRefreshController', () => {
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
    currentUserId: () => 'user-1',
    runtimeState: () => 'ready',
    applySessionUser: vi.fn(),
    invalidateSession: vi.fn(),
    isAuthenticationError: () => true,
    trace: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    ...overrides,
  };
}
