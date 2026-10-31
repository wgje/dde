import { describe, expect, it, vi } from 'vitest';

import {
  AuthExplicitSignOutController,
  type AuthExplicitSignOutContext,
} from './auth-explicit-sign-out.controller';

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function createContext(
  overrides: Partial<AuthExplicitSignOutContext> = {},
): AuthExplicitSignOutContext {
  const revocation = Object.assign(vi.fn(async () => undefined), {
    isCurrent: vi.fn(() => true),
  });
  return {
    isConfigured: vi.fn(() => true),
    ensureRuntimeAuthReady: vi.fn(async () => undefined),
    hasActiveAuthListener: vi.fn(() => true),
    hasCurrentAuthClient: vi.fn(() => true),
    captureOwnerFence: vi.fn(() => '1:user-a:'),
    currentUserId: vi.fn(() => 'user-a'),
    captureRevocation: vi.fn(() => revocation),
    signOutRemote: vi.fn(async () => undefined),
    finalize: vi.fn(async () => true),
    warn: vi.fn(),
    ...overrides,
  };
}

describe('AuthExplicitSignOutController', () => {
  it('does not convert an observer SIGNED_OUT event into remote success', async () => {
    const remote = deferred<void>();
    const error = new Error('remote sign-out failed');
    const context = createContext({
      signOutRemote: vi.fn(() => remote.promise),
    });
    const controller = new AuthExplicitSignOutController(context);

    const result = controller.signOut();
    await vi.waitFor(() => expect(context.signOutRemote).toHaveBeenCalledOnce());
    expect(controller.observeSignedOut()).toBe(true);

    remote.reject(error);

    await expect(result).rejects.toBe(error);
    expect(context.finalize).not.toHaveBeenCalled();
  });

  it('rejects a remote result after the owner generation fence changes', async () => {
    const remote = deferred<void>();
    let fence = '1:user-a:';
    const context = createContext({
      captureOwnerFence: vi.fn(() => fence),
      signOutRemote: vi.fn(() => remote.promise),
    });
    const controller = new AuthExplicitSignOutController(context);

    const result = controller.signOut();
    await vi.waitFor(() => expect(context.signOutRemote).toHaveBeenCalledOnce());
    fence = '2:user-b:';
    remote.resolve();

    await expect(result).resolves.toBe(false);
    expect(context.finalize).not.toHaveBeenCalled();
  });
});
