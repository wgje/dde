import { afterEach, describe, expect, it, vi } from 'vitest';

import { AuthStorageBridgeController } from './auth-storage-bridge.controller';

describe('AuthStorageBridgeController', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('tears down immediately when the storage token is removed', () => {
    const ctx = createContext();
    const controller = new AuthStorageBridgeController(ctx);

    controller.handleStorageEvent(storageEvent({ key: 'auth-key', newValue: null }));

    expect(ctx.teardownInvalidatedSession).toHaveBeenCalledWith('AuthService.storageBridge');
  });

  it('ignores unrelated, runtime-pending, and local-mode events', () => {
    const ctx = createContext({
      authRuntimeReady: () => false,
      isLocalModeEnabled: () => false,
    });
    const controller = new AuthStorageBridgeController(ctx);

    controller.handleStorageEvent(storageEvent({ key: 'other-key', newValue: '{}' }));
    controller.handleStorageEvent(storageEvent({ key: 'auth-key', newValue: '{}' }));

    expect(ctx.resolvePersistedSessionIdentityFromAuthData).not.toHaveBeenCalled();

    const localCtx = createContext({ isLocalModeEnabled: () => true });
    new AuthStorageBridgeController(localCtx)
      .handleStorageEvent(storageEvent({ key: 'auth-key', newValue: '{}' }));

    expect(localCtx.resolvePersistedSessionIdentityFromAuthData).not.toHaveBeenCalled();
  });

  it('does not re-confirm or publish a healthy same-user INITIAL_SESSION', () => {
    const ctx = createContext({
      currentUserId: () => 'user-1',
      resolvePersistedSessionIdentityFromAuthData: () => ({ userId: 'user-1', email: 'user@example.com' }),
      sessionExpired: () => false,
    });
    const controller = new AuthStorageBridgeController(ctx);

    controller.handleInitialSession({
      access_token: 'token-1',
      user: { id: 'user-1', email: 'user@example.com' },
    });

    expect(ctx.captureAcceptedSession).toHaveBeenCalledWith({
      access_token: 'token-1',
      user: { id: 'user-1', email: 'user@example.com' },
    });
    expect(ctx.setPendingStorageBridgeSessionIdentity).toHaveBeenCalledWith(null);
    expect(ctx.applyConfirmedSessionIdentity).not.toHaveBeenCalled();
    expect(ctx.publishSessionRestored).not.toHaveBeenCalled();
  });
  it('confirms same-user sessions and publishes new-user restore events', () => {
    const sameUserCtx = createContext({
      currentUserId: () => 'user-1',
      resolvePersistedSessionIdentityFromAuthData: () => ({ userId: 'user-1', email: 'user@example.com' }),
    });
    const sameUserController = new AuthStorageBridgeController(sameUserCtx);

    sameUserController.handleStorageEvent(storageEvent({ key: 'auth-key', newValue: '{"ok":true}' }));

    expect(sameUserCtx.setPendingStorageBridgeSessionIdentity).toHaveBeenCalledWith(null);
    expect(sameUserCtx.applyConfirmedSessionIdentity).toHaveBeenCalledWith('user-1', 'user@example.com', {
      publishSessionRestored: false,
      source: 'AuthService.storageBridge',
    });

    const newUserCtx = createContext({
      currentUserId: () => 'user-old',
      resolvePersistedSessionIdentityFromAuthData: () => ({ userId: 'user-new', email: null }),
    });
    const newUserController = new AuthStorageBridgeController(newUserCtx);

    newUserController.handleStorageEvent(storageEvent({ key: 'auth-key', newValue: '{"ok":true}' }));

    expect(newUserCtx.setPendingStorageBridgeSessionIdentity).toHaveBeenCalledWith({ userId: 'user-new', email: null });
    expect(newUserCtx.setPersistedOwnerHint).toHaveBeenCalledWith('user-new');
    expect(newUserCtx.publishSessionRestored).toHaveBeenCalledWith('user-new', 'AuthService.storageBridge');
  });

  it('publishes one same-user recovery for a valid storage bridge signal without healthy refresh duplication', () => {
    const recoveryCtx = createContext({
      currentUserId: () => 'user-1',
      resolvePersistedSessionIdentityFromAuthData: () => ({ userId: 'user-1', email: 'user@example.com' }),
      sessionExpired: () => true,
    });
    const teardownInvalidatedSession = vi.fn();
    recoveryCtx.teardownInvalidatedSession = teardownInvalidatedSession;
    const applyConfirmedSessionIdentity = vi.fn((
      userId: string,
      email: string | null,
      options?: { publishSessionRestored?: boolean; source?: string },
    ) => {
      if (options?.publishSessionRestored) {
        recoveryCtx.publishSessionRestored(userId, options.source ?? 'AuthService');
      }
    });
    recoveryCtx.applyConfirmedSessionIdentity = applyConfirmedSessionIdentity;
    const recoveryController = new AuthStorageBridgeController(recoveryCtx);

    recoveryController.handleStorageEvent(storageEvent({ key: 'auth-key', newValue: null }));
    teardownInvalidatedSession.mockClear();
    recoveryController.handleStorageEvent(storageEvent({ key: 'auth-key', newValue: '{"ok":true}' }));
    recoveryController.handleStorageEvent(storageEvent({ key: 'auth-key', newValue: '{"ok":true}' }));

    expect(recoveryCtx.setPendingStorageBridgeSessionIdentity).toHaveBeenCalledWith(null);
    expect(applyConfirmedSessionIdentity).toHaveBeenCalledTimes(2);
    expect(applyConfirmedSessionIdentity).toHaveBeenNthCalledWith(1, 'user-1', 'user@example.com', {
      publishSessionRestored: true,
      source: 'AuthService.storageBridge',
    });
    expect(applyConfirmedSessionIdentity).toHaveBeenNthCalledWith(2, 'user-1', 'user@example.com', {
      publishSessionRestored: false,
      source: 'AuthService.storageBridge',
    });
    expect(recoveryCtx.publishSessionRestored).toHaveBeenCalledTimes(1);
    expect(recoveryCtx.publishSessionRestored).toHaveBeenCalledWith('user-1', 'AuthService.storageBridge');

    const healthyCtx = createContext({
      currentUserId: () => 'user-1',
      resolvePersistedSessionIdentityFromAuthData: () => ({ userId: 'user-1', email: 'user@example.com' }),
      sessionExpired: () => false,
    });
    new AuthStorageBridgeController(healthyCtx)
      .handleStorageEvent(storageEvent({ key: 'auth-key', newValue: '{"ok":true}' }));

    expect(healthyCtx.publishSessionRestored).not.toHaveBeenCalled();
  });

  it('syncs persisted hints when parsing fails or no user id is resolved', () => {
    const noUserCtx = createContext({
      resolvePersistedSessionIdentityFromAuthData: () => null,
    });
    new AuthStorageBridgeController(noUserCtx)
      .handleStorageEvent(storageEvent({ key: 'auth-key', newValue: '{"ok":true}' }));

    expect(noUserCtx.syncPersistedOwnerHintFromStorage).toHaveBeenCalled();
    expect(noUserCtx.syncPersistedSessionUserIdFromStorage).toHaveBeenCalled();

    const parseCtx = createContext();
    new AuthStorageBridgeController(parseCtx)
      .handleStorageEvent(storageEvent({ key: 'auth-key', newValue: 'not-json' }));

    expect(parseCtx.syncPersistedOwnerHintFromStorage).toHaveBeenCalled();
    expect(parseCtx.syncPersistedSessionUserIdFromStorage).toHaveBeenCalled();
  });

  it('uses the current storage value instead of tearing down for a stale removal event', async () => {
    const ctx = createContext({
      currentUserId: () => 'user-a',
      resolvePersistedSessionIdentityFromAuthData: () => ({ userId: 'user-b', email: 'b@example.com' }),
    });
    const controller = new AuthStorageBridgeController(ctx);

    controller.handleStorageEvent(storageEvent({
      key: 'auth-key',
      newValue: null,
      storageArea: storageArea(() => authRaw('user-b', 'b@example.com')),
    }));
    await vi.waitFor(() => expect(ctx.restartAuthRuntimeForStorageAdoption).toHaveBeenCalled());
    controller.handleInitialSession({
      access_token: 'token-user-b',
      user: { id: 'user-b', email: 'b@example.com' },
    });
    await vi.waitFor(() => expect(ctx.publishSessionRestored).toHaveBeenCalled());

    expect(ctx.teardownInvalidatedSession).not.toHaveBeenCalled();
    expect(ctx.setPendingStorageBridgeSessionIdentity).toHaveBeenCalledWith({
      userId: 'user-b',
      email: 'b@example.com',
    });
    expect(ctx.publishSessionRestored).toHaveBeenCalledWith('user-b', 'AuthService.storageBridge');
  });

  it('ignores same-key events from non-authoritative storage areas', () => {
    const localStorageGetItem = vi.spyOn(localStorage, 'getItem')
      .mockReturnValue('{"owner":"user-b"}');
    const sessionStorageGetItem = vi.spyOn(sessionStorage, 'getItem')
      .mockReturnValue(null);
    const ctx = createContext();

    new AuthStorageBridgeController(ctx).handleStorageEvent(storageEvent({
      key: 'auth-key',
      newValue: null,
      storageArea: sessionStorage,
    }));

    expect(localStorageGetItem).not.toHaveBeenCalled();
    expect(sessionStorageGetItem).not.toHaveBeenCalled();
    expect(ctx.resolvePersistedSessionIdentityFromAuthData).not.toHaveBeenCalled();
    expect(ctx.setPendingStorageBridgeSessionIdentity).not.toHaveBeenCalled();
    expect(ctx.setPersistedOwnerHint).not.toHaveBeenCalled();
    expect(ctx.applyConfirmedSessionIdentity).not.toHaveBeenCalled();
    expect(ctx.publishSessionRestored).not.toHaveBeenCalled();
    expect(ctx.teardownInvalidatedSession).not.toHaveBeenCalled();
  });

  it('uses current storage B instead of applying a stale event payload A', async () => {
    const resolvePersistedSessionIdentityFromAuthData = vi.fn((authData: unknown) => {
      const owner = (authData as { owner?: string }).owner;
      return owner === 'user-b'
        ? { userId: 'user-b', email: 'b@example.com' }
        : { userId: 'user-a', email: 'a@example.com' };
    });
    const ctx = createContext({
      currentUserId: () => 'user-current',
      resolvePersistedSessionIdentityFromAuthData,
    });
    const controller = new AuthStorageBridgeController(ctx);

    controller.handleStorageEvent(storageEvent({
      key: 'auth-key',
      newValue: authRaw('user-a', 'a@example.com'),
      storageArea: storageArea(() => authRaw('user-b', 'b@example.com')),
    }));
    await vi.waitFor(() => expect(ctx.restartAuthRuntimeForStorageAdoption).toHaveBeenCalled());
    controller.handleInitialSession({
      access_token: 'token-user-b',
      user: { id: 'user-b', email: 'b@example.com' },
    });
    await vi.waitFor(() => expect(ctx.setPendingStorageBridgeSessionIdentity).toHaveBeenCalled());

    expect(resolvePersistedSessionIdentityFromAuthData).toHaveBeenCalledWith(expect.objectContaining({ owner: 'user-b' }));
    expect(ctx.setPendingStorageBridgeSessionIdentity).toHaveBeenCalledWith({
      userId: 'user-b',
      email: 'b@example.com',
    });
    expect(ctx.setPendingStorageBridgeSessionIdentity).not.toHaveBeenCalledWith({
      userId: 'user-a',
      email: 'a@example.com',
    });
  });

  it('preserves matching current storage and genuine current removal behavior', async () => {
    const currentCtx = createContext({
      resolvePersistedSessionIdentityFromAuthData: () => ({ userId: 'user-b', email: null }),
    });
    new AuthStorageBridgeController(currentCtx).handleStorageEvent(storageEvent({
      key: 'auth-key',
      newValue: authRaw('user-b'),
      storageArea: storageArea(() => authRaw('user-b')),
    }));
    await vi.waitFor(() => expect(currentCtx.restartAuthRuntimeForStorageAdoption).toHaveBeenCalled());
    currentCtx.currentUserId = () => 'user-a';
    const currentController = new AuthStorageBridgeController(currentCtx);
    currentController.handleStorageEvent(storageEvent({
      key: 'auth-key',
      newValue: authRaw('user-b'),
      storageArea: storageArea(() => authRaw('user-b')),
    }));
    await vi.waitFor(() => expect(currentCtx.restartAuthRuntimeForStorageAdoption).toHaveBeenCalledTimes(2));
    currentController.handleInitialSession({ access_token: 'token-user-b', user: { id: 'user-b' } });
    await vi.waitFor(() => expect(currentCtx.setPendingStorageBridgeSessionIdentity).toHaveBeenCalled());

    expect(currentCtx.setPendingStorageBridgeSessionIdentity).toHaveBeenCalledWith({
      userId: 'user-b',
      email: null,
    });

    const staleLoginCtx = createContext();
    new AuthStorageBridgeController(staleLoginCtx).handleStorageEvent(storageEvent({
      key: 'auth-key',
      newValue: authRaw('user-b'),
      storageArea: storageArea(() => null),
    }));
    await vi.waitFor(() => expect(staleLoginCtx.teardownInvalidatedSession).toHaveBeenCalled());

    expect(staleLoginCtx.teardownInvalidatedSession).toHaveBeenCalledWith('AuthService.storageBridge');

    const removedCtx = createContext();
    new AuthStorageBridgeController(removedCtx).handleStorageEvent(storageEvent({
      key: 'auth-key',
      newValue: null,
      storageArea: storageArea(() => null),
    }));
    await vi.waitFor(() => expect(removedCtx.teardownInvalidatedSession).toHaveBeenCalled());

    expect(removedCtx.teardownInvalidatedSession).toHaveBeenCalledWith('AuthService.storageBridge');
  });

  it('fails closed on current-storage read errors without suppressing removal invalidation', async () => {
    const loginCtx = createContext();
    new AuthStorageBridgeController(loginCtx).handleStorageEvent(storageEvent({
      key: 'auth-key',
      newValue: authRaw('user-b'),
      storageArea: storageArea(() => {
        throw new Error('storage unavailable');
      }),
    }));
    await Promise.resolve();
    await Promise.resolve();

    expect(loginCtx.resolvePersistedSessionIdentityFromAuthData).not.toHaveBeenCalled();
    expect(loginCtx.setPendingStorageBridgeSessionIdentity).not.toHaveBeenCalled();
    expect(loginCtx.setPersistedOwnerHint).not.toHaveBeenCalled();
    expect(loginCtx.applyConfirmedSessionIdentity).not.toHaveBeenCalled();
    expect(loginCtx.publishSessionRestored).not.toHaveBeenCalled();
    expect(loginCtx.teardownInvalidatedSession).not.toHaveBeenCalled();

    const removalCtx = createContext();
    new AuthStorageBridgeController(removalCtx).handleStorageEvent(storageEvent({
      key: 'auth-key',
      newValue: null,
      storageArea: storageArea(() => {
        throw new Error('storage unavailable');
      }),
    }));
    await vi.waitFor(() => expect(removalCtx.teardownInvalidatedSession).toHaveBeenCalled());

    expect(removalCtx.teardownInvalidatedSession).toHaveBeenCalledWith('AuthService.storageBridge');
  });

  it('preserves synthetic storage event behavior when storageArea is absent', () => {
    const ctx = createContext({
      resolvePersistedSessionIdentityFromAuthData: () => ({ userId: 'user-b', email: null }),
    });

    new AuthStorageBridgeController(ctx)
      .handleStorageEvent(storageEvent({ key: 'auth-key', newValue: '{"owner":"user-b"}' }));

    expect(ctx.setPendingStorageBridgeSessionIdentity).toHaveBeenCalledWith({
      userId: 'user-b',
      email: null,
    });
  });

  it('hydrates a fresh generation from any canonical bundle key before publishing restore', async () => {
    const bundle = {
      session: JSON.stringify({ access_token: 'token-b', user: { id: 'user-b', email: 'b@example.com' } }),
      codeVerifier: 'verifier-b',
      user: 'user-b',
    };
    const restartAuthRuntimeForStorageAdoption = vi.fn().mockResolvedValue(undefined);
    const ctx = {
      ...createContext({ currentUserId: () => 'user-a' }),
      readCanonicalBundle: vi.fn().mockResolvedValue(bundle),
      restartAuthRuntimeForStorageAdoption,
    };
    const controller = new AuthStorageBridgeController(ctx);

    controller.handleStorageEvent(storageEvent({
      key: 'auth-key-user',
      newValue: 'user-b',
      storageArea: localStorage,
    }));
    await vi.waitFor(() => expect(restartAuthRuntimeForStorageAdoption).toHaveBeenCalledTimes(1));
    expect(ctx.publishSessionRestored).not.toHaveBeenCalled();

    controller.handleInitialSession({
      access_token: 'token-b',
      user: { id: 'user-b', email: 'b@example.com' },
    });
    await vi.waitFor(() => expect(ctx.publishSessionRestored).toHaveBeenCalledTimes(1));
    expect(ctx.setPendingStorageBridgeSessionIdentity).toHaveBeenCalledWith({
      userId: 'user-b',
      email: 'b@example.com',
    });
  });

  it('does not settle an adoption superseded by a newer complete bundle', async () => {
    const bundleB = {
      session: JSON.stringify({ access_token: 'token-b', user: { id: 'user-b' } }),
      codeVerifier: null,
      user: null,
    };
    const bundleC = {
      session: JSON.stringify({ access_token: 'token-c', user: { id: 'user-c' } }),
      codeVerifier: null,
      user: null,
    };
    const readCanonicalBundle = vi.fn().mockResolvedValueOnce(bundleB).mockResolvedValue(bundleC);
    const ctx = {
      ...createContext({ currentUserId: () => 'user-a' }),
      readCanonicalBundle,
      restartAuthRuntimeForStorageAdoption: vi.fn().mockResolvedValue(undefined),
    };
    const controller = new AuthStorageBridgeController(ctx);
    controller.handleStorageEvent(storageEvent({ key: 'auth-key', newValue: bundleB.session, storageArea: localStorage }));
    controller.handleStorageEvent(storageEvent({ key: 'auth-key', newValue: bundleC.session, storageArea: localStorage }));
    await vi.waitFor(() => expect(ctx.restartAuthRuntimeForStorageAdoption).toHaveBeenCalledTimes(1));

    controller.handleInitialSession({ access_token: 'token-b', user: { id: 'user-b' } });
    await Promise.resolve();
    expect(ctx.applyConfirmedSessionIdentity).not.toHaveBeenCalled();
    controller.handleInitialSession({ access_token: 'token-c', user: { id: 'user-c' } });
    await vi.waitFor(() => expect(ctx.setPendingStorageBridgeSessionIdentity).toHaveBeenCalledWith({
      userId: 'user-c',
      email: null,
    }));
  });

  it('does not restart or publish when reset supersedes a pending canonical read', async () => {
    let resolveRead!: (bundle: {
      session: string; codeVerifier: null; user: null;
    }) => void;
    const readCanonicalBundle = vi.fn(() => new Promise<{
      session: string; codeVerifier: null; user: null;
    }>(resolve => { resolveRead = resolve; }));
    const ctx = {
      ...createContext({ currentUserId: () => 'user-a' }),
      readCanonicalBundle,
      restartAuthRuntimeForStorageAdoption: vi.fn().mockResolvedValue(undefined),
    };
    const controller = new AuthStorageBridgeController(ctx);
    const bundleB = {
      session: JSON.stringify({ access_token: 'token-b', user: { id: 'user-b' } }),
      codeVerifier: null,
      user: null,
    };

    controller.handleStorageEvent(storageEvent({ key: 'auth-key', newValue: bundleB.session, storageArea: localStorage }));
    await vi.waitFor(() => expect(readCanonicalBundle).toHaveBeenCalledTimes(1));
    controller.reset();
    resolveRead(bundleB);
    await Promise.resolve();

    expect(ctx.restartAuthRuntimeForStorageAdoption).not.toHaveBeenCalled();
    expect(ctx.publishSessionRestored).not.toHaveBeenCalled();
  });

  it('publishes canonical adoption after a null bundle teardown even when current identity is cleared', async () => {
    const nullBundle = { session: null, codeVerifier: null, user: null };
    const restoredBundle = {
      session: JSON.stringify({ access_token: 'token-1', user: { id: 'user-1', email: 'user@example.com' } }),
      codeVerifier: null,
      user: 'user-1',
    };
    let currentUserId: string | null = 'user-1';
    const publishSessionRestored = vi.fn();
    const ctx = {
      ...createContext({
        currentUserId: () => currentUserId,
        sessionExpired: () => false,
        applyConfirmedSessionIdentity: vi.fn((
          userId: string,
          email: string | null,
          options?: { publishSessionRestored?: boolean; source?: string },
        ) => {
          currentUserId = userId;
          if (options?.publishSessionRestored) {
            publishSessionRestored(userId, options.source ?? 'AuthService');
          }
        }),
        teardownInvalidatedSession: vi.fn(() => { currentUserId = null; }),
      }),
      readCanonicalBundle: vi.fn().mockResolvedValueOnce(nullBundle).mockResolvedValue(restoredBundle),
      restartAuthRuntimeForStorageAdoption: vi.fn().mockResolvedValue(undefined),
    };
    const controller = new AuthStorageBridgeController(ctx);

    controller.handleStorageEvent(storageEvent({
      key: 'auth-key',
      newValue: null,
      storageArea: localStorage,
    }));
    await vi.waitFor(() => expect(ctx.teardownInvalidatedSession).toHaveBeenCalled());

    controller.handleStorageEvent(storageEvent({
      key: 'auth-key',
      newValue: restoredBundle.session,
      storageArea: localStorage,
    }));
    await vi.waitFor(() => expect(ctx.restartAuthRuntimeForStorageAdoption).toHaveBeenCalledTimes(1));

    controller.handleInitialSession({
      access_token: 'token-1',
      user: { id: 'user-1', email: 'user@example.com' },
    });
    await vi.waitFor(() => expect(publishSessionRestored).toHaveBeenCalledTimes(1));

    expect(ctx.applyConfirmedSessionIdentity).toHaveBeenCalledWith('user-1', 'user@example.com', {
      publishSessionRestored: true,
      source: 'AuthService.storageBridge',
    });
  });

  it('publishes one same-user recovery through the canonical bundle path after a null bundle transition', async () => {
    const restoredBundle = {
      session: JSON.stringify({ access_token: 'token-1', user: { id: 'user-1', email: 'user@example.com' } }),
      codeVerifier: null,
      user: 'user-1',
    };
    let currentUserId = 'user-1';
    let sessionExpired = true;
    const publishSessionRestored = vi.fn();
    const ctx = {
      ...createContext({
        currentUserId: () => currentUserId,
        sessionExpired: () => sessionExpired,
        applyConfirmedSessionIdentity: vi.fn((
          userId: string,
          email: string | null,
          options?: { publishSessionRestored?: boolean; source?: string },
        ) => {
          currentUserId = userId;
          sessionExpired = false;
          if (options?.publishSessionRestored) {
            publishSessionRestored(userId, options.source ?? 'AuthService');
          }
        }),
      }),
      readCanonicalBundle: vi.fn().mockResolvedValue(restoredBundle),
      restartAuthRuntimeForStorageAdoption: vi.fn().mockResolvedValue(undefined),
    };
    const controller = new AuthStorageBridgeController(ctx);

    controller.handleStorageEvent(storageEvent({
      key: 'auth-key',
      newValue: JSON.stringify({ access_token: 'token-1', user: { id: 'user-1', email: 'user@example.com' } }),
      storageArea: localStorage,
    }));
    await vi.waitFor(() => expect(ctx.restartAuthRuntimeForStorageAdoption).toHaveBeenCalledTimes(1));

    controller.handleInitialSession({
      access_token: 'token-1',
      user: { id: 'user-1', email: 'user@example.com' },
    });
    await vi.waitFor(() => expect(publishSessionRestored).toHaveBeenCalledTimes(1));

    expect(publishSessionRestored).toHaveBeenCalledTimes(1);
    expect(publishSessionRestored).toHaveBeenCalledWith('user-1', 'AuthService.storageBridge');
    expect(ctx.applyConfirmedSessionIdentity).toHaveBeenCalledWith('user-1', 'user@example.com', {
      publishSessionRestored: true,
      source: 'AuthService.storageBridge',
    });
  });
});

function createContext(overrides: Partial<ConstructorParameters<typeof AuthStorageBridgeController>[0]> = {}) {
  return {
    storageKey: () => 'auth-key',
    authRuntimeReady: () => true,
    isLocalModeEnabled: () => false,
    currentUserId: () => null,
    localModeUserId: 'local-user',
    peekPersistedSessionIdentity: () => null,
    sessionExpired: () => false,
    pendingStorageBridgeSessionIdentity: () => null,
    setPendingStorageBridgeSessionIdentity: vi.fn(),
    setPersistedOwnerHint: vi.fn(),
    syncPersistedOwnerHintFromStorage: vi.fn(),
    syncPersistedSessionUserIdFromStorage: vi.fn(),
    resolvePersistedSessionIdentityFromAuthData: vi.fn((authData: unknown) => {
      const record = authData as { owner?: string; user?: { id?: string; email?: string | null } };
      const userId = record.user?.id ?? record.owner ?? 'user-1';
      return { userId, email: record.user?.email ?? null };
    }),
    captureAcceptedSession: vi.fn(),
    applyConfirmedSessionIdentity: vi.fn(),
    publishSessionRestored: vi.fn(),
    teardownInvalidatedSession: vi.fn(),
    readCanonicalBundle: vi.fn(async () => ({
      session: localStorage.getItem('auth-key'),
      codeVerifier: localStorage.getItem('auth-key-code-verifier'),
      user: localStorage.getItem('auth-key-user'),
    })),
    restartAuthRuntimeForStorageAdoption: vi.fn().mockResolvedValue(undefined),
    debug: vi.fn(),
    ...overrides,
  };
}

function storageEvent(input: {
  key: string;
  newValue: string | null;
  storageArea?: Storage | null;
}): StorageEvent {
  return input as StorageEvent;
}

function storageArea(getItem: () => string | null): Storage {
  vi.spyOn(localStorage, 'getItem').mockImplementation(getItem);
  return localStorage;
}

function authRaw(userId: string, email: string | null = null): string {
  return JSON.stringify({
    access_token: `token-${userId}`,
    owner: userId,
    user: { id: userId, email },
  });
}
