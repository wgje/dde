import { describe, expect, it, vi } from 'vitest';

import { AuthStorageBridgeController } from './auth-storage-bridge.controller';

describe('AuthStorageBridgeController', () => {
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
});

function createContext(overrides: Partial<ConstructorParameters<typeof AuthStorageBridgeController>[0]> = {}) {
  return {
    storageKey: () => 'auth-key',
    authRuntimeReady: () => true,
    isLocalModeEnabled: () => false,
    currentUserId: () => null,
    localModeUserId: 'local-user',
    sessionExpired: () => false,
    pendingStorageBridgeSessionIdentity: () => null,
    setPendingStorageBridgeSessionIdentity: vi.fn(),
    setPersistedOwnerHint: vi.fn(),
    syncPersistedOwnerHintFromStorage: vi.fn(),
    syncPersistedSessionUserIdFromStorage: vi.fn(),
    resolvePersistedSessionIdentityFromAuthData: vi.fn(() => ({ userId: 'user-1', email: null })),
    applyConfirmedSessionIdentity: vi.fn(),
    publishSessionRestored: vi.fn(),
    teardownInvalidatedSession: vi.fn(),
    debug: vi.fn(),
    ...overrides,
  };
}

function storageEvent(input: { key: string; newValue: string | null }): StorageEvent {
  return input as StorageEvent;
}
