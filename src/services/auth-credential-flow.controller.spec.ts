import { signal } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';

import type { AuthState } from './auth.service';
import {
  AuthCredentialFlowController,
  type AuthCredentialStateIdentity,
} from './auth-credential-flow.controller';

describe('AuthCredentialFlowController', () => {
  it('sets loading state and applies credential identities on success', async () => {
    const ctx = createContext();
    const controller = new AuthCredentialFlowController(ctx);

    const result = await controller.run(async () => ({
      ok: true,
      value: { userId: 'user-1', email: 'user@example.com' },
    }));

    expect(result.ok).toBe(true);
    expect(ctx.applyCredentialIdentity).toHaveBeenCalledWith({ userId: 'user-1', email: 'user@example.com' });
    expect(ctx.authState()).toMatchObject({
      isLoading: false,
      error: null,
    });
  });

  it('passes the resolved identity to the commit predicate before identity and finalize writes', async () => {
    const ctx = createContext();
    const controller = new AuthCredentialFlowController(ctx);
    const canCommitCredentialState = vi.fn((identity?: AuthCredentialStateIdentity) =>
      identity?.userId === 'dev-user' && identity.email === 'dev@example.com');

    const result = await controller.run(async () => ({
      ok: true,
      value: { userId: 'dev-user', email: 'dev@example.com' },
    }), canCommitCredentialState);

    expect(result.ok).toBe(true);
    expect(canCommitCredentialState).toHaveBeenCalledWith({
      userId: 'dev-user',
      email: 'dev@example.com',
    });
    expect(ctx.applyCredentialIdentity).toHaveBeenCalledWith({
      userId: 'dev-user',
      email: 'dev@example.com',
    });
    expect(ctx.authState().isLoading).toBe(false);
  });

  it('stores operation errors without applying identity', async () => {
    const ctx = createContext();
    const controller = new AuthCredentialFlowController(ctx);

    const result = await controller.run(async () => ({
      ok: false,
      error: { code: 'UNKNOWN', message: 'bad credentials' },
    }));

    expect(result.ok).toBe(false);
    expect(ctx.authState()).toMatchObject({
      isLoading: false,
      error: 'bad credentials',
    });
    expect(ctx.applyCredentialIdentity).not.toHaveBeenCalled();
  });

  it('does not apply credential identity for successful flows without a user id', async () => {
    const ctx = createContext();
    const controller = new AuthCredentialFlowController(ctx);

    const result = await controller.run(async () => ({
      ok: true,
      value: { needsConfirmation: true },
    }));

    expect(result.ok).toBe(true);
    expect(ctx.applyCredentialIdentity).not.toHaveBeenCalled();
    expect(ctx.authState()).toMatchObject({
      isLoading: false,
      error: null,
    });
  });

  it('converts thrown errors into unknown failures', async () => {
    const ctx = createContext();
    const controller = new AuthCredentialFlowController(ctx);

    const result = await controller.run(async () => {
      throw new Error('raw failure');
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain('raw failure');
    }
    expect(ctx.authState().isLoading).toBe(false);
  });

  it('preserves newer auth state when a stale successful request resolves', async () => {
    const ctx = createContext();
    const controller = new AuthCredentialFlowController(ctx);
    const deferred = createDeferred<void>();
    let canCommitCredentialState = true;
    const resultPromise = controller.run(async () => {
      await deferred.promise;
      return {
        ok: true as const,
        value: { userId: 'stale-user', email: 'stale@example.com' },
      };
    }, () => canCommitCredentialState);

    canCommitCredentialState = false;
    const authoritativeState = createAuthoritativeState();
    ctx.authState.set(authoritativeState);
    deferred.resolve();

    await expect(resultPromise).resolves.toMatchObject({ ok: true });
    expect(ctx.applyCredentialIdentity).not.toHaveBeenCalled();
    expect(ctx.authState()).toEqual({ ...authoritativeState, isLoading: false });
  });

  it('clears loading when identity invalidation makes the request stale', async () => {
    const ctx = createContext();
    const controller = new AuthCredentialFlowController(ctx);
    const deferred = createDeferred<void>();
    let canCommit = true;
    const resultPromise = controller.run(async () => {
      await deferred.promise;
      return { ok: true as const, value: { userId: 'stale-user' } };
    }, () => canCommit);

    canCommit = false;
    ctx.authState.set(createAuthoritativeState());
    deferred.resolve();

    await expect(resultPromise).resolves.toMatchObject({ ok: true });
    expect(ctx.authState().isLoading).toBe(false);
    expect(ctx.applyCredentialIdentity).not.toHaveBeenCalled();
  });

  it('preserves newer auth state when a stale operation error resolves', async () => {
    const ctx = createContext();
    const controller = new AuthCredentialFlowController(ctx);
    const deferred = createDeferred<void>();
    let canCommitCredentialState = true;
    const resultPromise = controller.run(async () => {
      await deferred.promise;
      return {
        ok: false as const,
        error: { code: 'UNKNOWN' as const, message: 'stale credentials' },
      };
    }, () => canCommitCredentialState);

    canCommitCredentialState = false;
    const authoritativeState = createAuthoritativeState();
    ctx.authState.set(authoritativeState);
    deferred.resolve();

    await expect(resultPromise).resolves.toMatchObject({ ok: false });
    expect(ctx.authState()).toEqual({ ...authoritativeState, isLoading: false });
  });

  it('preserves newer auth state when a stale request throws', async () => {
    const ctx = createContext();
    const controller = new AuthCredentialFlowController(ctx);
    const deferred = createDeferred<void>();
    let canCommitCredentialState = true;
    const resultPromise = controller.run(async () => {
      await deferred.promise;
      throw new Error('stale failure');
    }, () => canCommitCredentialState);

    canCommitCredentialState = false;
    const authoritativeState = createAuthoritativeState();
    ctx.authState.set(authoritativeState);
    deferred.resolve();

    await expect(resultPromise).resolves.toMatchObject({ ok: false });
    expect(ctx.authState()).toEqual({ ...authoritativeState, isLoading: false });
  });

  it('fails closed when the credential commit predicate throws', async () => {
    const ctx = createContext();
    const controller = new AuthCredentialFlowController(ctx);
    const deferred = createDeferred<void>();
    const resultPromise = controller.run(
      async () => {
        await deferred.promise;
        return {
          ok: true as const,
          value: { userId: 'stale-user', email: 'stale@example.com' },
        };
      },
      () => {
        throw new Error('stale fence');
      },
    );
    const authoritativeState = createAuthoritativeState();
    ctx.authState.set(authoritativeState);
    deferred.resolve();

    await expect(resultPromise).resolves.toMatchObject({ ok: true });

    expect(ctx.applyCredentialIdentity).not.toHaveBeenCalled();
    expect(ctx.authState()).toEqual({ ...authoritativeState, isLoading: false });
  });
});

function createAuthoritativeState(): AuthState {
  return {
    isCheckingSession: true,
    isLoading: true,
    userId: 'new-user',
    email: 'new@example.com',
    error: 'new-owner-error',
  };
}

function createContext() {
  return {
    authState: signal<AuthState>({
      isCheckingSession: false,
      isLoading: false,
      userId: null,
      email: null,
      error: 'old',
    }),
    applyCredentialIdentity: vi.fn(),
  };
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(res => {
    resolve = res;
  });
  return { promise, resolve };
}
