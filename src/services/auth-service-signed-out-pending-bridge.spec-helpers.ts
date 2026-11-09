import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuthService } from './auth.service';

interface AuthServiceSignedOutPendingBridgeSpecContext {
  service: AuthService;
  ensureRuntimeAuthReady: () => Promise<void>;
  dispatchAuthStateChange: (event: string, session: unknown) => void;
  dispatchStorageEvent: (newValue: string | null) => void;
  createPersistedSessionPayload: (
    userId: string,
    email: string | null,
    wrapped?: boolean,
    accessToken?: string,
  ) => string;
  mockEventBus: {
    publishSessionRestored: ReturnType<typeof vi.fn>;
    publishSessionInvalidated: ReturnType<typeof vi.fn>;
    publishSessionSignedOut: ReturnType<typeof vi.fn>;
  };
  mockSupabaseClient: {
    clientAsync: ReturnType<typeof vi.fn>;
    signOut: ReturnType<typeof vi.fn>;
  };
  mockToastService: {
    warning: ReturnType<typeof vi.fn>;
  };
}

export const AUTHORITY_KEY = '__NANOFLOW_AUTH_CANONICAL_STORAGE__';

export function installCanonicalAuthority(): void {
  const keys = ['sb-test-auth-token', 'sb-test-auth-token-code-verifier', 'sb-test-auth-token-user'];
  const read = () => ({
    session: localStorage.getItem(keys[0]),
    codeVerifier: localStorage.getItem(keys[1]),
    user: localStorage.getItem(keys[2]),
  });
  const write = (bundle: ReturnType<typeof read>) => {
    keys.forEach((key, index) => {
      const value = [bundle.session, bundle.codeVerifier, bundle.user][index];
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    });
  };
  Object.defineProperty(globalThis, AUTHORITY_KEY, {
    configurable: true,
    value: {
      createGeneration: vi.fn(),
      peekBundle: read,
      readBundle: async () => read(),
      compareAndSwap: async ({ expected, next }: { expected: ReturnType<typeof read>; next: ReturnType<typeof read> }) => {
        if (JSON.stringify(read()) !== JSON.stringify(expected)) throw new Error('AUTH_CANONICAL_STORAGE_MISMATCH');
        write(next);
        return JSON.stringify(expected) === JSON.stringify(next) ? 'noop' : 'committed';
      },
      startSessionPrewarm: vi.fn(),
    },
  });
}

function syncPersistedHints(service: AuthService): void {
  (
    service as unknown as {
      syncPersistedOwnerHintFromStorage: () => void;
      syncPersistedSessionUserIdFromStorage: () => void;
    }
  ).syncPersistedOwnerHintFromStorage();
  (
    service as unknown as {
      syncPersistedOwnerHintFromStorage: () => void;
      syncPersistedSessionUserIdFromStorage: () => void;
    }
  ).syncPersistedSessionUserIdFromStorage();
}

function seedConfirmedSessionIdentity(
  context: AuthServiceSignedOutPendingBridgeSpecContext,
  userId: string,
  email: string | null,
  accessToken = 'seed-access-token',
): void {
  localStorage.setItem(
    'sb-test-auth-token',
    context.createPersistedSessionPayload(userId, email, false, accessToken),
  );
  context.service.currentUserId.set(userId);
  context.service.sessionEmail.set(email);
  context.service.authState.update(state => ({
    ...state,
    userId,
    email,
  }));
  syncPersistedHints(context.service);
}

function writeCanonicalArtifacts(session: string, owner: string): void {
  localStorage.setItem('sb-test-auth-token', session);
  localStorage.setItem('sb-test-auth-token-code-verifier', `verifier-${owner}`);
  localStorage.setItem('sb-test-auth-token-user', JSON.stringify({ id: owner }));
}

function setPendingStorageBridgeIdentity(
  service: AuthService,
  identity: { userId: string; email: string | null } | null,
): void {
  (
    service as unknown as {
      pendingStorageBridgeSessionIdentity: { userId: string; email: string | null } | null;
    }
  ).pendingStorageBridgeSessionIdentity = identity;
}

function getPendingStorageBridgeIdentity(service: AuthService): {
  userId: string;
  email: string | null;
} | null {
  return (
    service as unknown as {
      pendingStorageBridgeSessionIdentity: { userId: string; email: string | null } | null;
    }
  ).pendingStorageBridgeSessionIdentity;
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, reject, resolve };
}

async function preparePendingForeignBridge(
  context: AuthServiceSignedOutPendingBridgeSpecContext,
): Promise<string> {
  await context.ensureRuntimeAuthReady();
  seedConfirmedSessionIdentity(context, 'user-a', 'a@example.com', 'token-a');

  const payloadB = context.createPersistedSessionPayload(
    'user-b',
    'b@example.com',
    false,
    'token-b',
  );
  localStorage.setItem('sb-test-auth-token', payloadB);
  context.dispatchStorageEvent(payloadB);
  return payloadB;
}

export function registerAuthServiceSignedOutPendingBridgeSpecs(
  getContext: () => AuthServiceSignedOutPendingBridgeSpecContext,
): void {
  let context: AuthServiceSignedOutPendingBridgeSpecContext;

  beforeEach(() => {
    context = getContext();
    installCanonicalAuthority();
  });

  afterEach(() => { delete (globalThis as Record<string, unknown>)[AUTHORITY_KEY]; });

  describe('SIGNED_OUT pending storage bridge preservation', () => {
    it('A + pending B + late SIGNED_OUT 应保留当前 owner 与 handoff 证据', async () => {
      const payloadB = await preparePendingForeignBridge(context);

      context.mockEventBus.publishSessionInvalidated.mockClear();
      context.mockToastService.warning.mockClear();

      context.dispatchAuthStateChange('SIGNED_OUT', null);

      expect(context.service.currentUserId()).toBe('user-a');
      expect(context.service.authState().userId).toBe('user-a');
      expect(context.service.sessionEmail()).toBe('a@example.com');
      expect(context.service.persistedOwnerHint()).toBe('user-b');
      expect(context.service.persistedSessionUserId()).toBe('user-a');
      expect(context.service.sessionExpired()).toBe(false);
      expect(getPendingStorageBridgeIdentity(context.service)).toEqual({
        userId: 'user-b',
        email: 'b@example.com',
      });
      expect(localStorage.getItem('sb-test-auth-token')).toBe(payloadB);
      expect(context.mockEventBus.publishSessionInvalidated).not.toHaveBeenCalled();
      expect(context.mockToastService.warning).not.toHaveBeenCalled();
    });

    it('deferred SIGNED_OUT 之后既有 B handoff 仍应通过 INITIAL_SESSION + completeCrossTabSessionRestore 完成', async () => {
      await preparePendingForeignBridge(context);
      context.mockEventBus.publishSessionInvalidated.mockClear();

      context.dispatchAuthStateChange('SIGNED_OUT', null);
      context.dispatchAuthStateChange('INITIAL_SESSION', {
        access_token: 'token-b',
        user: { id: 'user-b', email: 'b@example.com' },
      });

      context.service.currentUserId.set('user-b');
      context.service.completeCrossTabSessionRestore('user-b');

      expect(context.service.currentUserId()).toBe('user-b');
      expect(context.service.authState().userId).toBe('user-b');
      expect(context.service.authState().email).toBe('b@example.com');
      expect(context.service.sessionEmail()).toBe('b@example.com');
      expect(context.service.persistedOwnerHint()).toBe('user-b');
      expect(context.service.persistedSessionUserId()).toBe('user-b');
      expect(getPendingStorageBridgeIdentity(context.service)).toBeNull();
      expect(context.mockEventBus.publishSessionInvalidated).not.toHaveBeenCalled();
      expect(context.mockEventBus.publishSessionRestored).toHaveBeenCalledTimes(1);
    });

    it('没有 foreign pending evidence 时，SIGNED_OUT 仍应保持既有失效清理语义', async () => {
      await context.ensureRuntimeAuthReady();
      seedConfirmedSessionIdentity(context, 'user-a', 'a@example.com', 'token-a');
      context.mockEventBus.publishSessionInvalidated.mockClear();
      context.mockToastService.warning.mockClear();

      context.dispatchAuthStateChange('SIGNED_OUT', null);

      expect(context.service.currentUserId()).toBeNull();
      expect(context.service.authState().userId).toBeNull();
      expect(context.service.sessionEmail()).toBeNull();
      expect(context.service.persistedOwnerHint()).toBeNull();
      expect(context.service.persistedSessionUserId()).toBeNull();
      expect(context.service.sessionExpired()).toBe(true);
      expect(getPendingStorageBridgeIdentity(context.service)).toBeNull();
      expect(localStorage.getItem('sb-test-auth-token')).toBeNull();
      expect(context.mockEventBus.publishSessionInvalidated).toHaveBeenCalledWith(
        'AuthService.signedOut',
        'user-a',
      );
      expect(context.mockToastService.warning).toHaveBeenCalledWith(
        '登录已过期',
        '请重新登录以继续同步数据',
        { duration: 0 },
      );
    });

    it.each([
      {
        label: 'same-owner pending',
        setup: async () => {
          await context.ensureRuntimeAuthReady();
          seedConfirmedSessionIdentity(context, 'user-a', 'a@example.com', 'token-a');
          setPendingStorageBridgeIdentity(context.service, {
            userId: 'user-a',
            email: 'a@example.com',
          });
        },
      },
      {
        label: 'foreign pending without persisted evidence',
        setup: async () => {
          await preparePendingForeignBridge(context);
          localStorage.removeItem('sb-test-auth-token');
        },
      },
      {
        label: 'foreign pending with malformed persisted evidence',
        setup: async () => {
          await preparePendingForeignBridge(context);
          localStorage.setItem('sb-test-auth-token', '{invalid-json');
        },
      },
    ])('stale/malformed pending case: $label 不应吞掉真实 SIGNED_OUT', async ({ setup }) => {
      await setup();
      context.mockEventBus.publishSessionInvalidated.mockClear();

      context.dispatchAuthStateChange('SIGNED_OUT', null);

      expect(context.service.currentUserId()).toBeNull();
      expect(context.service.persistedOwnerHint()).toBeNull();
      expect(context.service.persistedSessionUserId()).toBeNull();
      expect(context.service.sessionExpired()).toBe(true);
      expect(context.mockEventBus.publishSessionInvalidated).toHaveBeenCalledWith(
        'AuthService.signedOut',
        'user-a',
      );
    });

    it('explicit signOut 在 pending foreign bridge 存在时仍应保持权威清理', async () => {
      await preparePendingForeignBridge(context);
      context.mockEventBus.publishSessionInvalidated.mockClear();

      await expect(context.service.signOut()).resolves.toBe(true);

      expect(context.mockSupabaseClient.signOut).toHaveBeenCalledTimes(1);
      expect(context.service.currentUserId()).toBeNull();
      expect(context.service.authState().userId).toBeNull();
      expect(context.service.sessionEmail()).toBeNull();
      expect(context.service.persistedOwnerHint()).toBeNull();
      expect(context.service.persistedSessionUserId()).toBeNull();
      expect(context.service.sessionExpired()).toBe(false);
      expect(getPendingStorageBridgeIdentity(context.service)).toBeNull();
      expect(localStorage.getItem('sb-test-auth-token')).toBeNull();
      expect(context.mockEventBus.publishSessionInvalidated).not.toHaveBeenCalled();
      expect(context.mockEventBus.publishSessionSignedOut).toHaveBeenCalledWith(
        'AuthService.signOut',
        'user-a',
      );
    });

    it('overlapping explicit signOut callers share one literal promise and finalize once', async () => {
      await context.ensureRuntimeAuthReady();
      seedConfirmedSessionIdentity(context, 'user-a', 'a@example.com', 'token-a');
      const remote = createDeferred<void>();
      context.mockSupabaseClient.signOut.mockReturnValueOnce(remote.promise);

      const first = context.service.signOut();
      const second = context.service.signOut();

      expect(second).toBe(first);
      await Promise.resolve();
      expect(context.mockSupabaseClient.signOut).toHaveBeenCalledTimes(1);
      context.dispatchAuthStateChange('SIGNED_OUT', null);
      remote.resolve();
      await expect(first).resolves.toBe(true);
      expect(context.mockEventBus.publishSessionSignedOut).toHaveBeenCalledTimes(1);
      expect(context.mockEventBus.publishSessionInvalidated).not.toHaveBeenCalled();
      expect(context.service.sessionExpired()).toBe(false);
    });

    it('keeps observed SIGNED_OUT separate from a failed remote sign-out', async () => {
      await context.ensureRuntimeAuthReady();
      seedConfirmedSessionIdentity(context, 'user-a', 'a@example.com', 'token-a');
      writeCanonicalArtifacts(localStorage.getItem('sb-test-auth-token')!, 'user-a');
      const remote = createDeferred<void>();
      context.mockSupabaseClient.signOut.mockReturnValueOnce(remote.promise);

      const signOut = context.service.signOut();
      await Promise.resolve();
      context.dispatchAuthStateChange('SIGNED_OUT', null);
      const error = new Error('unexpected remote sign-out error');
      remote.reject(error);

      await expect(signOut).rejects.toBe(error);
      expect(context.service.currentUserId()).toBe('user-a');
      expect(context.mockEventBus.publishSessionSignedOut).not.toHaveBeenCalled();
      expect(context.mockEventBus.publishSessionInvalidated).not.toHaveBeenCalled();
      expect(context.mockToastService.warning).not.toHaveBeenCalled();
      expect(localStorage.getItem('sb-test-auth-token-code-verifier')).not.toBeNull();
      expect(localStorage.getItem('sb-test-auth-token-user')).not.toBeNull();
    });

    it('revokes an accepted INITIAL_SESSION snapshot after storage disappears before event-error signOut', async () => {
      await context.ensureRuntimeAuthReady();
      const payloadA = context.createPersistedSessionPayload(
        'user-a', 'a@example.com', false, 'token-a',
      );
      writeCanonicalArtifacts(payloadA, 'user-a');
      context.dispatchAuthStateChange('INITIAL_SESSION', {
        access_token: 'token-a',
        user: { id: 'user-a', email: 'a@example.com' },
      });
      localStorage.removeItem('sb-test-auth-token');
      localStorage.removeItem('sb-test-auth-token-code-verifier');
      localStorage.removeItem('sb-test-auth-token-user');
      const remote = createDeferred<void>();
      context.mockSupabaseClient.signOut.mockReturnValueOnce(remote.promise);

      const signOut = context.service.signOut();
      await Promise.resolve();
      context.dispatchAuthStateChange('SIGNED_OUT', null);
      const error = new Error('unexpected remote sign-out error');
      remote.reject(error);

      await expect(signOut).rejects.toBe(error);
      expect(context.service.currentUserId()).toBe('user-a');
      expect(context.mockEventBus.publishSessionSignedOut).not.toHaveBeenCalled();
      expect(context.mockEventBus.publishSessionInvalidated).not.toHaveBeenCalled();
      context.dispatchAuthStateChange('SIGNED_IN', {
        access_token: 'token-a',
        user: { id: 'user-a', email: 'a@example.com' },
      });
      expect(context.service.currentUserId()).toBe('user-a');
    });

    it('prefers current canonical B over a stale refreshed prewarm for A', () => {
      const payloadB = context.createPersistedSessionPayload(
        'user-b', 'b@example.com', false, 'token-b',
      );
      writeCanonicalArtifacts(payloadB, 'user-b');
      (window as Window & { __NANOFLOW_SESSION_PREWARM__?: unknown }).__NANOFLOW_SESSION_PREWARM__ = {
        status: 'refreshed',
        session: {
          access_token: 'token-a',
          refresh_token: 'refresh-a',
          expires_in: 3600,
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          token_type: 'bearer',
          user: { id: 'user-a', email: 'a@example.com' },
        },
      };
      const cache = (
        context.service as unknown as {
          authSessionCache: { peekPersistedSessionIdentity(): { userId: string } | null };
        }
      ).authSessionCache;

      expect(cache.peekPersistedSessionIdentity()?.userId).toBe('user-b');
    });

    it('removes the complete current canonical bundle in one captured cleanup', async () => {
      const payloadA = context.createPersistedSessionPayload(
        'user-a', 'a@example.com', false, 'token-a',
      );
      writeCanonicalArtifacts(payloadA, 'user-a');
      const cache = (
        context.service as unknown as {
          authSessionCache: { captureCanonicalSessionRemoval(): () => Promise<void> };
        }
      ).authSessionCache;

      await cache.captureCanonicalSessionRemoval()();

      expect(localStorage.getItem('sb-test-auth-token')).toBeNull();
      expect(localStorage.getItem('sb-test-auth-token-code-verifier')).toBeNull();
      expect(localStorage.getItem('sb-test-auth-token-user')).toBeNull();
    });

    it('preserves a newer complete bundle when captured cleanup loses its CAS', async () => {
      const payloadA = context.createPersistedSessionPayload(
        'user-a', 'a@example.com', false, 'token-a',
      );
      const payloadB = context.createPersistedSessionPayload(
        'user-b', 'b@example.com', false, 'token-b',
      );
      writeCanonicalArtifacts(payloadA, 'user-a');
      const cache = (
        context.service as unknown as {
          authSessionCache: { captureCanonicalSessionRemoval(): () => Promise<void> };
        }
      ).authSessionCache;
      const cleanup = cache.captureCanonicalSessionRemoval();
      writeCanonicalArtifacts(payloadB, 'user-b');

      await cleanup();

      expect(localStorage.getItem('sb-test-auth-token')).toBe(payloadB);
      expect(localStorage.getItem('sb-test-auth-token-code-verifier')).toBe('verifier-user-b');
      expect(localStorage.getItem('sb-test-auth-token-user')).toBe(JSON.stringify({ id: 'user-b' }));
    });

    it('rejects before SDK signOut when readiness has no active auth listener', async () => {
      context.mockSupabaseClient.clientAsync.mockResolvedValueOnce(null);

      await expect(context.service.signOut()).rejects.toThrow('AUTH_SIGN_OUT_LISTENER_UNAVAILABLE');
      expect(context.mockSupabaseClient.signOut).not.toHaveBeenCalled();
      expect(context.mockEventBus.publishSessionSignedOut).not.toHaveBeenCalled();
    });

    it('reset invalidates an old SDK flight without letting its settlement clear a new flight', async () => {
      await context.ensureRuntimeAuthReady();
      seedConfirmedSessionIdentity(context, 'user-a', 'a@example.com', 'token-a');
      const oldRemote = createDeferred<void>();
      const newRemote = createDeferred<void>();
      context.mockSupabaseClient.signOut
        .mockReturnValueOnce(oldRemote.promise)
        .mockReturnValueOnce(newRemote.promise);
      const oldFlight = context.service.signOut();
      await Promise.resolve();

      context.service.reset();
      await context.ensureRuntimeAuthReady();
      seedConfirmedSessionIdentity(context, 'user-b', 'b@example.com', 'token-b');
      const newFlight = context.service.signOut();
      expect(newFlight).not.toBe(oldFlight);
      oldRemote.resolve();
      await expect(oldFlight).resolves.toBe(false);

      expect(context.service.currentUserId()).toBe('user-b');
      expect(context.service.signOut()).toBe(newFlight);
      newRemote.resolve();
      await expect(newFlight).resolves.toBe(true);
    });

    it.each(['resolve', 'reject'] as const)(
      'same-owner token replacement makes a stale remote %s inert',
      async settlement => {
        await context.ensureRuntimeAuthReady();
        const payloadA = context.createPersistedSessionPayload(
          'user-a', 'a@example.com', false, 'token-a',
        );
        const payloadB = context.createPersistedSessionPayload(
          'user-a', 'a@example.com', false, 'token-b',
        );
        writeCanonicalArtifacts(payloadA, 'user-a');
        seedConfirmedSessionIdentity(context, 'user-a', 'a@example.com', 'token-a');
        const remote = createDeferred<void>();
        context.mockSupabaseClient.signOut.mockReturnValueOnce(remote.promise);

        const signOut = context.service.signOut();
        await vi.waitFor(() => expect(context.mockSupabaseClient.signOut).toHaveBeenCalledOnce());
        writeCanonicalArtifacts(payloadB, 'user-a');
        if (settlement === 'resolve') remote.resolve();
        else remote.reject(new Error('stale remote failure'));

        await expect(signOut).resolves.toBe(false);
        expect(context.service.currentUserId()).toBe('user-a');
        expect(localStorage.getItem('sb-test-auth-token')).toBe(payloadB);
        expect(context.mockEventBus.publishSessionSignedOut).not.toHaveBeenCalled();
        expect(context.mockToastService.warning).not.toHaveBeenCalled();
      },
    );

    it.each(['resolve', 'reject'] as const)(
      'different-owner canonical replacement makes a stale remote %s inert',
      async settlement => {
        await context.ensureRuntimeAuthReady();
        const payloadA = context.createPersistedSessionPayload(
          'user-a', 'a@example.com', false, 'token-a',
        );
        const payloadB = context.createPersistedSessionPayload(
          'user-b', 'b@example.com', false, 'token-b',
        );
        writeCanonicalArtifacts(payloadA, 'user-a');
        context.dispatchAuthStateChange('INITIAL_SESSION', {
          access_token: 'token-a',
          user: { id: 'user-a', email: 'a@example.com' },
        });
        context.mockEventBus.publishSessionSignedOut.mockClear();
        context.mockEventBus.publishSessionInvalidated.mockClear();
        context.mockToastService.warning.mockClear();
        const remote = createDeferred<void>();
        context.mockSupabaseClient.signOut.mockReturnValueOnce(remote.promise);

        const signOut = context.service.signOut();
        await vi.waitFor(() => expect(context.mockSupabaseClient.signOut).toHaveBeenCalledOnce());
        writeCanonicalArtifacts(payloadB, 'user-b');
        if (settlement === 'resolve') remote.resolve();
        else remote.reject(new Error('stale remote failure'));

        await expect(signOut).resolves.toBe(false);
        expect(context.service.currentUserId()).toBe('user-a');
        expect(context.service.authState().userId).toBe('user-a');
        expect(context.service.sessionEmail()).toBe('a@example.com');
        expect(localStorage.getItem('sb-test-auth-token')).toBe(payloadB);
        expect(localStorage.getItem('sb-test-auth-token-code-verifier')).toBe('verifier-user-b');
        expect(localStorage.getItem('sb-test-auth-token-user')).toBe(JSON.stringify({ id: 'user-b' }));
        expect(context.mockEventBus.publishSessionSignedOut).not.toHaveBeenCalled();
        expect(context.mockEventBus.publishSessionInvalidated).not.toHaveBeenCalled();
        expect(context.mockToastService.warning).not.toHaveBeenCalled();
      },
    );

    it('does not publish A when B arrives after revocation commit', async () => {
      await context.ensureRuntimeAuthReady();
      const payloadA = context.createPersistedSessionPayload(
        'user-a', 'a@example.com', false, 'token-a',
      );
      const payloadB = context.createPersistedSessionPayload(
        'user-b', 'b@example.com', false, 'token-b',
      );
      writeCanonicalArtifacts(payloadA, 'user-a');
      seedConfirmedSessionIdentity(context, 'user-a', 'a@example.com', 'token-a');
      const authority = (globalThis as Record<string, unknown>)[AUTHORITY_KEY] as {
        compareAndSwap: (input: unknown) => Promise<string>;
      };
      const originalCompareAndSwap = authority.compareAndSwap;
      const commitStarted = createDeferred<void>();
      const releaseCommit = createDeferred<void>();
      authority.compareAndSwap = vi.fn(async input => {
        const result = await originalCompareAndSwap(input);
        commitStarted.resolve();
        await releaseCommit.promise;
        return result;
      });

      const signOut = context.service.signOut();
      await commitStarted.promise;
      writeCanonicalArtifacts(payloadB, 'user-b');
      releaseCommit.resolve();

      await expect(signOut).resolves.toBe(false);
      expect(context.service.currentUserId()).toBe('user-a');
      expect(localStorage.getItem('sb-test-auth-token')).toBe(payloadB);
      expect(context.mockEventBus.publishSessionSignedOut).not.toHaveBeenCalled();
    });

    it('fails closed when the canonical authority is unavailable', () => {
      delete (globalThis as Record<string, unknown>)[AUTHORITY_KEY];
      seedConfirmedSessionIdentity(context, 'user-a', 'a@example.com', 'token-a');

      syncPersistedHints(context.service);

      expect(context.service.persistedOwnerHint()).toBeNull();
      expect(context.service.persistedSessionUserId()).toBeNull();
    });

    it('clears only hints while preserving a newer canonical credential bundle', () => {
      const payloadB = context.createPersistedSessionPayload('user-b', 'b@example.com', false, 'token-b');
      localStorage.setItem('sb-test-auth-token', payloadB);
      (window as Window & { __NANOFLOW_SESSION_PREWARM__?: unknown }).__NANOFLOW_SESSION_PREWARM__ = {
        status: 'refreshed',
      };

      (context.service as unknown as { clearCachedSessionArtifacts(): void }).clearCachedSessionArtifacts();

      expect(localStorage.getItem('sb-test-auth-token')).toBe(payloadB);
      expect((window as Window & { __NANOFLOW_SESSION_PREWARM__?: unknown }).__NANOFLOW_SESSION_PREWARM__).toBeUndefined();
    });
  });
}
