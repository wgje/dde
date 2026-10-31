import { afterEach, describe, expect, it, vi } from 'vitest';

import { AuthSessionRestoreController } from './auth-session-restore.controller';

const controllers: AuthSessionRestoreController[] = [];
afterEach(() => { while (controllers.length) controllers.pop()?.destroy(); });

function createHarness() {
  let recoveryRequiredListener: (() => void) | null = null, recoveryRequiredSubscribed = false;
  const unsubscribe = vi.fn(() => { recoveryRequiredSubscribed = false; });
  const sessionRecoveryRequired$ = {
    subscribe(listener: () => void) {
      recoveryRequiredListener = listener;
      recoveryRequiredSubscribed = true;
      return { unsubscribe };
    },
  };
  let currentUserId: string | null = 'user-1';
  let authIdentityFence = 'fence-1';
  let sessionExpired = false;
  let pendingSessionRestoredNotification = false;
  let onAuthIdentityFenceRead: (() => void) | null = null, onCurrentUserIdRead: (() => void) | null = null, onPersistedIdentityRead: (() => void) | null = null;
  let onSetSessionExpired: ((value: boolean) => void) | null = null;
  let onSetPendingSessionRestoredNotification: ((value: boolean) => void) | null = null;
  let persistedIdentity: { userId: string; email: string | null } | null = { userId: 'user-1', email: 'user-1@example.com' };
  const applyAuthenticatedIdentity = vi.fn((userId: string) => { currentUserId = userId; });
  const advanceAuthIdentityGeneration = vi.fn();
  const clearPendingStorageBridgeSessionIdentity = vi.fn();
  const publishSessionRestored = vi.fn();
  const writePendingSessionRestoredNotification = vi.fn((value: boolean) => {
    pendingSessionRestoredNotification = value;
    onSetPendingSessionRestoredNotification?.(value);
  });
  const writeSessionExpired = vi.fn((value: boolean) => {
    sessionExpired = value;
    onSetSessionExpired?.(value);
  });
  const controller = new AuthSessionRestoreController({
    advanceAuthIdentityGeneration,
    applyAuthenticatedIdentity,
    captureAuthIdentityFence: () => { onAuthIdentityFenceRead?.(); return authIdentityFence; },
    clearPendingStorageBridgeSessionIdentity,
    currentUserId: () => { onCurrentUserIdRead?.(); return currentUserId; },
    localModeUserId: 'local-mode-user',
    pendingSessionRestoredNotification: () => pendingSessionRestoredNotification,
    peekPersistedSessionIdentity: () => { onPersistedIdentityRead?.(); return persistedIdentity; },
    publishSessionRestored,
    sessionExpired: () => sessionExpired,
    sessionRecoveryRequired$,
    setPendingSessionRestoredNotification: writePendingSessionRestoredNotification,
    setSessionExpired: writeSessionExpired,
  });
  controllers.push(controller);

  return {
    advanceAuthIdentityGeneration,
    applyAuthenticatedIdentity,
    clearPendingStorageBridgeSessionIdentity,
    controller,
    currentUserId: () => currentUserId,
    emitRecoveryRequired: () => {
      if (recoveryRequiredSubscribed) recoveryRequiredListener?.();
    },
    emitRecoveryRequiredAfterUnsubscribe: () => recoveryRequiredListener?.(),
    publishSessionRestored,
    onAuthIdentityFenceRead: (callback: typeof onAuthIdentityFenceRead) => { onAuthIdentityFenceRead = callback; },
    onSetPendingSessionRestoredNotification: (callback: typeof onSetPendingSessionRestoredNotification) => { onSetPendingSessionRestoredNotification = callback; },
    onCurrentUserIdRead: (callback: typeof onCurrentUserIdRead) => { onCurrentUserIdRead = callback; },
    onPersistedIdentityRead: (callback: typeof onPersistedIdentityRead) => { onPersistedIdentityRead = callback; },
    onSetSessionExpired: (callback: typeof onSetSessionExpired) => { onSetSessionExpired = callback; },
    setAuthIdentityFence: (value: string) => { authIdentityFence = value; },
    setCurrentUserId: (value: string | null) => { currentUserId = value; },
    setPendingSessionRestoredNotification: (value: boolean) => { pendingSessionRestoredNotification = value; },
    setPersistedIdentity: (value: typeof persistedIdentity) => { persistedIdentity = value; },
    setSessionExpired: (value: boolean) => { sessionExpired = value; },
    unsubscribe,
    writePendingSessionRestoredNotification,
    writeSessionExpired,
  };
}

function confirm(controller: AuthSessionRestoreController, userId = 'user-1'): void {
  controller.applyConfirmedSessionIdentity(userId, null, { publishSessionRestored: true });
}

function expectNoSessionEffects(h: ReturnType<typeof createHarness>): void {
  expect(h.clearPendingStorageBridgeSessionIdentity).not.toHaveBeenCalled();
  expect(h.applyAuthenticatedIdentity).not.toHaveBeenCalled();
  expect(h.advanceAuthIdentityGeneration).not.toHaveBeenCalled();
  expect(h.writeSessionExpired).not.toHaveBeenCalled();
  expect(h.writePendingSessionRestoredNotification).not.toHaveBeenCalled();
  expect(h.publishSessionRestored).not.toHaveBeenCalled();
}

function expectPublishedOwner(h: ReturnType<typeof createHarness>, userId: string): void {
  expect(h.currentUserId()).toBe(userId);
  expect(h.publishSessionRestored).toHaveBeenCalledWith(userId, 'AuthService');
}

describe('AuthSessionRestoreController', () => {
  it('publishes one same-owner restore after sync recovery is required', () => {
    const h = createHarness();
    h.emitRecoveryRequired();
    confirm(h.controller);
    confirm(h.controller);

    expect(h.applyAuthenticatedIdentity).toHaveBeenCalledTimes(2);
    expect(h.publishSessionRestored).toHaveBeenCalledTimes(1);
    expect(h.publishSessionRestored).toHaveBeenCalledWith('user-1', 'AuthService');
  });
  it('does not arm recovery for local mode or an anonymous session', () => {
    const h = createHarness();
    h.emitRecoveryRequired();
    h.setCurrentUserId('local-mode-user');
    h.emitRecoveryRequired();
    h.setCurrentUserId(null);
    h.emitRecoveryRequired();
    h.setCurrentUserId('user-1');
    confirm(h.controller);

    expect(h.publishSessionRestored).not.toHaveBeenCalled();
  });
  it('clears a mismatched pending recovery without publishing for the new owner', () => {
    const h = createHarness();
    h.emitRecoveryRequired();
    h.setCurrentUserId('user-2');
    confirm(h.controller, 'user-2');

    expect(h.publishSessionRestored).not.toHaveBeenCalled();
  });
  it('completes a matching persisted cross-tab identity', () => {
    const h = createHarness();
    h.controller.completeCrossTabSessionRestore('user-1');

    expect(h.clearPendingStorageBridgeSessionIdentity).toHaveBeenCalledTimes(1);
    expect(h.applyAuthenticatedIdentity).toHaveBeenCalledWith('user-1', 'user-1@example.com');
    expect(h.advanceAuthIdentityGeneration).toHaveBeenCalledTimes(1);
    expect(h.publishSessionRestored).not.toHaveBeenCalled();
  });
  it('ignores missing or mismatched persisted cross-tab identities', () => {
    const h = createHarness();
    h.setCurrentUserId('user-2');
    h.controller.completeCrossTabSessionRestore('user-1');
    h.setCurrentUserId('user-1');
    h.setPersistedIdentity({ userId: 'user-2', email: null });
    h.controller.completeCrossTabSessionRestore('user-1');
    h.setPersistedIdentity(null);
    h.controller.completeCrossTabSessionRestore('user-1');
    expect(h.applyAuthenticatedIdentity).not.toHaveBeenCalled();
  });
  it.each([['current', 'user-1'], ['current', 'user-2'], ['persisted', 'user-2']] as const)('lets %s getter-time %s settlement win cross-tab completion', (getter, winnerUserId) => {
    const h = createHarness();
    let reentered = false;
    h.setPendingSessionRestoredNotification(true);
    h[getter === 'current' ? 'onCurrentUserIdRead' : 'onPersistedIdentityRead'](() => {
      if (reentered) return;
      reentered = true;
      confirm(h.controller, winnerUserId);
    });
    h.controller.completeCrossTabSessionRestore('user-1');
    expect(h.clearPendingStorageBridgeSessionIdentity).not.toHaveBeenCalled();
    expect(h.applyAuthenticatedIdentity).toHaveBeenCalledTimes(1);
    expect(h.applyAuthenticatedIdentity).toHaveBeenCalledWith(winnerUserId, null);
    expect(h.advanceAuthIdentityGeneration).toHaveBeenCalledTimes(1);
    expect(h.writePendingSessionRestoredNotification).toHaveBeenCalledTimes(1);
    expectPublishedOwner(h, winnerUserId);
  });
  it.each(['apply', 'clear', 'destroy'] as const)('stops cross-tab after bridge clear performs %s', action => {
    const h = createHarness();
    h.clearPendingStorageBridgeSessionIdentity.mockImplementationOnce(() => {
      if (action === 'apply') {
        h.setPendingSessionRestoredNotification(true);
        confirm(h.controller, 'user-2');
      } else if (action === 'clear') h.controller.clearPendingSyncSessionRecovery();
      else h.controller.destroy();
    });
    h.controller.completeCrossTabSessionRestore('user-1');
    if (action === 'clear') { h.setPendingSessionRestoredNotification(true); confirm(h.controller, 'user-2'); }
    const expectedWinnerCalls = action === 'destroy' ? 0 : 1;
    expect(h.clearPendingStorageBridgeSessionIdentity).toHaveBeenCalledTimes(1);
    expect(h.applyAuthenticatedIdentity).toHaveBeenCalledTimes(expectedWinnerCalls);
    expect(h.advanceAuthIdentityGeneration).toHaveBeenCalledTimes(expectedWinnerCalls);
    expect(h.writePendingSessionRestoredNotification).toHaveBeenCalledTimes(expectedWinnerCalls);
    expect(h.publishSessionRestored).toHaveBeenCalledTimes(expectedWinnerCalls);
    if (action !== 'destroy') expectPublishedOwner(h, 'user-2');
  });
  it.each(['ordinary', 'cross-tab'] as const)('makes destroy terminal for %s apply', entry => {
    const h = createHarness();
    h.emitRecoveryRequired();
    h.controller.destroy();
    h.controller.destroy();
    h.emitRecoveryRequiredAfterUnsubscribe();
    if (entry === 'ordinary') confirm(h.controller);
    else h.controller.completeCrossTabSessionRestore('user-1');
    expect(h.unsubscribe).toHaveBeenCalledTimes(1);
    expectNoSessionEffects(h);
  });
  it('clears pending recovery without unsubscribing from future recovery requirements', () => {
    const {
      controller,
      emitRecoveryRequired,
      publishSessionRestored,
    } = createHarness();

    emitRecoveryRequired();
    controller.clearPendingSyncSessionRecovery();
    confirm(controller);
    expect(publishSessionRestored).not.toHaveBeenCalled();

    emitRecoveryRequired();
    confirm(controller);

    expect(publishSessionRestored).toHaveBeenCalledTimes(1);
  });

  it('rejects an A to B to A authority after the opaque fence advances', () => {
    const h = createHarness();
    h.emitRecoveryRequired();
    h.setCurrentUserId('user-2');
    h.setAuthIdentityFence('fence-2');
    h.setCurrentUserId('user-1');
    h.setAuthIdentityFence('fence-3');

    confirm(h.controller);

    expect(h.applyAuthenticatedIdentity).toHaveBeenCalledTimes(1);
    expect(h.publishSessionRestored).not.toHaveBeenCalled();
  });

  it('rejects same-owner authority after the opaque fence advances', () => {
    const h = createHarness();
    h.emitRecoveryRequired();
    h.setAuthIdentityFence('fence-2');

    confirm(h.controller);

    expect(h.applyAuthenticatedIdentity).toHaveBeenCalledTimes(1);
    expect(h.publishSessionRestored).not.toHaveBeenCalled();
  });

  it('terminally clears mismatched authority before a later owner return', () => {
    const h = createHarness();
    h.emitRecoveryRequired();
    h.setCurrentUserId('user-2');
    h.setAuthIdentityFence('fence-2');
    confirm(h.controller, 'user-2');
    h.setCurrentUserId('user-1');
    h.setAuthIdentityFence('fence-1');

    confirm(h.controller);

    expect(h.applyAuthenticatedIdentity).toHaveBeenCalledTimes(2);
    expect(h.publishSessionRestored).not.toHaveBeenCalled();
  });

  it('cannot rearm from a captured stream callback after destroy', () => {
    const h = createHarness();
    h.controller.destroy();
    h.emitRecoveryRequiredAfterUnsubscribe();

    confirm(h.controller);

    expect(h.publishSessionRestored).not.toHaveBeenCalled();
  });

  it.each([
    ['owner', 'clear/reset'], ['owner', 'destroy'],
    ['fence', 'clear/reset'], ['fence', 'destroy'],
  ] as const)('does not arm after %s capture reentrantly performs %s', (capture, invalidation) => {
    const h = createHarness();
    const setHook = capture === 'owner' ? h.onCurrentUserIdRead : h.onAuthIdentityFenceRead;
    setHook(() => {
      setHook(null);
      if (invalidation === 'destroy') h.controller.destroy();
      else h.controller.clearPendingSyncSessionRecovery();
    });
    h.emitRecoveryRequired();
    expect(Reflect.get(h.controller, 'pendingSyncSessionRecovery')).toBeNull();
    confirm(h.controller);
    expect(h.publishSessionRestored).not.toHaveBeenCalled();
    if (invalidation === 'destroy') expectNoSessionEffects(h);
  });

  it('keeps authority consumed when identity application throws', () => {
    const h = createHarness();
    const failure = new Error('identity apply failed');
    h.applyAuthenticatedIdentity.mockImplementationOnce(() => { throw failure; });
    h.emitRecoveryRequired();
    expect(() => confirm(h.controller)).toThrow(failure);
    confirm(h.controller);

    expect(h.publishSessionRestored).not.toHaveBeenCalled();
  });

  it('keeps authority consumed when publication throws', () => {
    const h = createHarness();
    const failure = new Error('publication failed');
    h.publishSessionRestored.mockImplementationOnce(() => { throw failure; });
    h.emitRecoveryRequired();
    expect(() => confirm(h.controller)).toThrow(failure);
    confirm(h.controller);

    expect(h.publishSessionRestored).toHaveBeenCalledTimes(1);
  });

  it('preserves independent notification precedence without recovery authority', () => {
    const expired = createHarness();
    expired.setSessionExpired(true);
    confirm(expired.controller);
    expect(expired.publishSessionRestored).toHaveBeenCalledTimes(1);

    const pending = createHarness();
    pending.setPendingSessionRestoredNotification(true);
    confirm(pending.controller);
    expect(pending.publishSessionRestored).toHaveBeenCalledTimes(1);
  });

  it('does not let stale authority suppress an independent notification', () => {
    const h = createHarness();
    h.emitRecoveryRequired();
    h.setAuthIdentityFence('fence-2');
    h.setSessionExpired(true);

    confirm(h.controller);

    expect(h.publishSessionRestored).toHaveBeenCalledTimes(1);
  });

  it('lets a nested identity apply win without outer generation or publication', () => {
    const h = createHarness();
    h.applyAuthenticatedIdentity
      .mockImplementationOnce(() => confirm(h.controller, 'user-2'))
      .mockImplementationOnce(userId => h.setCurrentUserId(userId));
    h.emitRecoveryRequired();

    h.controller.applyConfirmedSessionIdentity('user-1', null, { publishSessionRestored: true });

    expect(h.currentUserId()).toBe('user-2');
    expect(h.advanceAuthIdentityGeneration).toHaveBeenCalledTimes(1);
    expect(h.publishSessionRestored).not.toHaveBeenCalled();
  });

  it('stops after identity apply clears the active settlement', () => {
    const h = createHarness();
    h.applyAuthenticatedIdentity.mockImplementationOnce(() => h.controller.clearPendingSyncSessionRecovery());
    h.emitRecoveryRequired();
    h.controller.applyConfirmedSessionIdentity('user-1', null, { publishSessionRestored: true });
    expect(h.advanceAuthIdentityGeneration).not.toHaveBeenCalled();
    expect(h.publishSessionRestored).not.toHaveBeenCalled();
  });

  it.each([false, true])('stops after identity apply destroys the controller (already destroyed: %s)', alreadyDestroyed => {
    const h = createHarness();
    if (alreadyDestroyed) h.controller.destroy();
    h.applyAuthenticatedIdentity.mockImplementationOnce(() => h.controller.destroy());
    if (!alreadyDestroyed) h.emitRecoveryRequired();
    h.controller.applyConfirmedSessionIdentity('user-1', null, { publishSessionRestored: true });
    expect(h.advanceAuthIdentityGeneration).not.toHaveBeenCalled();
    h.emitRecoveryRequiredAfterUnsubscribe();
    h.controller.applyConfirmedSessionIdentity('user-1', null, { publishSessionRestored: true });
    expect(h.publishSessionRestored).not.toHaveBeenCalled();
  });

  it('lets a nested apply during generation advance publish only the newer identity', () => {
    const h = createHarness();
    h.applyAuthenticatedIdentity.mockImplementation(userId => h.setCurrentUserId(userId));
    h.advanceAuthIdentityGeneration.mockImplementationOnce(() =>
      confirm(h.controller, 'user-2'));
    h.setSessionExpired(true);
    h.emitRecoveryRequired();
    h.controller.applyConfirmedSessionIdentity('user-1', null, { publishSessionRestored: true });
    expect(h.publishSessionRestored).toHaveBeenCalledTimes(1);
    expectPublishedOwner(h, 'user-2');
  });

  it.each(['clear', 'destroy'] as const)('stops publication when generation advance %ss settlement', action => {
    const h = createHarness();
    h.advanceAuthIdentityGeneration.mockImplementationOnce(() => action === 'clear'
      ? h.controller.clearPendingSyncSessionRecovery()
      : h.controller.destroy());
    h.emitRecoveryRequired();
    h.controller.applyConfirmedSessionIdentity('user-1', null, { publishSessionRestored: true });
    expect(h.publishSessionRestored).not.toHaveBeenCalled();
  });
  it('lets B win when clearing session-expired state reenters', () => {
    const h = createHarness();
    h.setSessionExpired(true);
    h.onSetSessionExpired(value => {
      if (value) return;
      h.setPendingSessionRestoredNotification(true);
      confirm(h.controller, 'user-2');
    });
    confirm(h.controller);
    expect(h.publishSessionRestored).toHaveBeenCalledTimes(1);
    expectPublishedOwner(h, 'user-2');
  });

  it.each(['apply', 'clear', 'destroy'] as const)('stops A when pending notification clear performs %s', action => {
    const h = createHarness();
    let invoked = false;
    h.onSetPendingSessionRestoredNotification(value => {
      if (value || invoked) return;
      invoked = true;
      if (action === 'apply') {
        h.setSessionExpired(true);
        confirm(h.controller, 'user-2');
      } else if (action === 'clear') {
        h.controller.clearPendingSyncSessionRecovery();
      } else {
        h.controller.destroy();
      }
    });
    h.setPendingSessionRestoredNotification(true);
    confirm(h.controller);
    if (action === 'apply') {
      expectPublishedOwner(h, 'user-2');
    }
    expect(h.publishSessionRestored).toHaveBeenCalledTimes(action === 'apply' ? 1 : 0);
  });
});
