import { describe, expect, it, vi } from 'vitest';

import { AuthCredentialSessionFenceController } from './auth-credential-session-fence.controller';

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(promiseResolve => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

describe('AuthCredentialSessionFenceController', () => {
  it('does not apply a duplicate SIGNED_IN event after its request binding was consumed', async () => {
    const request = deferred<{ ok: true; value: { userId: string } }>();
    let requestId: string | undefined;
    let canCommit: ((identity: { userId: string; email: string | null }) => boolean) | undefined;
    let consumeCount = 0;
    const applyConfirmedSessionIdentity = vi.fn();
    const controller = new AuthCredentialSessionFenceController({
      isConfigured: () => true,
      runSignInRequest: vi.fn((_email, _password, id, predicate) => {
        requestId = id;
        canCommit = predicate;
        return request.promise;
      }),
      runSignUpRequest: vi.fn(),
      captureAuthIdentityFence: () => '1:user-a:',
      authorizeSignupAdoption: vi.fn(),
      restartAuthRuntime: vi.fn(),
      storageKey: () => null,
      currentUserId: () => null,
      consumeCredentialRequestBinding: vi.fn(() => {
        consumeCount += 1;
        return consumeCount === 1
          ? { requestId: requestId!, previousPersistedSession: null }
          : null;
      }),
      pendingStorageBridgeUserId: () => null,
      deferStorageBridgeIdentity: vi.fn(),
      clearPendingStorageBridgeIdentity: vi.fn(),
      applyConfirmedSessionIdentity,
      clearCachedSessionArtifacts: vi.fn(),
      sessionExpired: () => false,
      syncPersistedOwnerHintFromStorage: vi.fn(),
      syncPersistedSessionUserIdFromStorage: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    });

    const signIn = controller.signIn('a@example.com', 'password', () => true);
    await vi.waitFor(() => expect(requestId).toBe('auth-sign-in-1'));
    expect(canCommit?.({ userId: 'user-a', email: null })).toBe(true);

    const session = { access_token: 'token-a', user: { id: 'user-a', email: null } };
    controller.handleSignedIn(session);
    controller.handleSignedIn(session);

    expect(applyConfirmedSessionIdentity).toHaveBeenCalledOnce();

    request.resolve({ ok: true, value: { userId: 'user-a' } });
    await expect(signIn).resolves.toEqual({ ok: true, value: { userId: 'user-a' } });
  });

  it('rejects a late signup adoption after the request attempt becomes inactive', async () => {
    const adoptionGate = deferred<boolean>();
    let active = true;
    let authorizeCallback: (() => boolean) | undefined;
    const session = { access_token: 'token-a', user: { id: 'user-a', email: null } };
    const rawSession = JSON.stringify(session);
    const authority = {
      createGeneration: vi.fn(),
      peekBundle: vi.fn(() => ({ session: rawSession, codeVerifier: null, user: JSON.stringify(session.user) })),
      readBundle: vi.fn(),
      compareAndSwap: vi.fn(),
      startSessionPrewarm: vi.fn(),
    };
    const previousAuthority = Object.getOwnPropertyDescriptor(globalThis, '__NANOFLOW_AUTH_CANONICAL_STORAGE__');
    Object.defineProperty(globalThis, '__NANOFLOW_AUTH_CANONICAL_STORAGE__', {
      configurable: true,
      value: authority,
    });

    try {
      const restartAuthRuntime = vi.fn(async () => undefined);
      const controller = new AuthCredentialSessionFenceController({
        isConfigured: () => true,
        runSignInRequest: vi.fn(),
        runSignUpRequest: vi.fn(async (_email, _password, _canCommit, afterSessionCommit) => {
          const publication = afterSessionCommit(session, () => active);
          await vi.waitFor(() => expect(authorizeCallback).toBeTypeOf('function'));
          active = false;
          adoptionGate.resolve(true);
          await expect(publication).resolves.toBe(false);
          return { ok: true as const, value: { userId: 'user-a' } };
        }),
        captureAuthIdentityFence: () => '1:user-a:',
        authorizeSignupAdoption: vi.fn(async (_session, authorize) => {
          authorizeCallback = authorize;
          await adoptionGate.promise;
          return authorize();
        }),
        restartAuthRuntime,
        storageKey: () => 'storage-key',
        currentUserId: () => null,
        consumeCredentialRequestBinding: vi.fn(() => null),
        pendingStorageBridgeUserId: () => null,
        deferStorageBridgeIdentity: vi.fn(),
        clearPendingStorageBridgeIdentity: vi.fn(),
        applyConfirmedSessionIdentity: vi.fn(),
        clearCachedSessionArtifacts: vi.fn(),
        sessionExpired: () => false,
        syncPersistedOwnerHintFromStorage: vi.fn(),
        syncPersistedSessionUserIdFromStorage: vi.fn(),
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
      });

      await expect(controller.signUp('a@example.com', 'password')).resolves.toEqual({
        ok: true,
        value: { userId: 'user-a' },
      });
      expect(restartAuthRuntime).not.toHaveBeenCalled();
    } finally {
      if (previousAuthority) Object.defineProperty(globalThis, '__NANOFLOW_AUTH_CANONICAL_STORAGE__', previousAuthority);
      else delete (globalThis as Record<string, unknown>)['__NANOFLOW_AUTH_CANONICAL_STORAGE__'];
    }
  });

  it('rejects a late runtime restart after the signup phase becomes stale', async () => {
    const restartGate = deferred<void>();
    let active = true;
    let restartStarted = false;
    const session = { access_token: 'token-a', user: { id: 'user-a', email: null } };
    const rawSession = JSON.stringify(session);
    const authority = {
      createGeneration: vi.fn(),
      peekBundle: vi.fn(() => ({ session: rawSession, codeVerifier: null, user: JSON.stringify(session.user) })),
      readBundle: vi.fn(),
      compareAndSwap: vi.fn(),
      startSessionPrewarm: vi.fn(),
    };
    const previousAuthority = Object.getOwnPropertyDescriptor(globalThis, '__NANOFLOW_AUTH_CANONICAL_STORAGE__');
    Object.defineProperty(globalThis, '__NANOFLOW_AUTH_CANONICAL_STORAGE__', {
      configurable: true,
      value: authority,
    });

    try {
      const restartAuthRuntime = vi.fn(async () => {
        restartStarted = true;
        await restartGate.promise;
      });
      const controller = new AuthCredentialSessionFenceController({
        isConfigured: () => true,
        runSignInRequest: vi.fn(),
        runSignUpRequest: vi.fn(async (_email, _password, _canCommit, afterSessionCommit) => {
          const publication = afterSessionCommit(session, () => active);
          await vi.waitFor(() => expect(restartStarted).toBe(true));
          active = false;
          restartGate.resolve();
          await expect(publication).resolves.toBe(false);
          return { ok: true as const, value: { userId: 'user-a' } };
        }),
        captureAuthIdentityFence: () => '1:user-a:',
        authorizeSignupAdoption: vi.fn(async (_session, authorize) => {
          authorize();
          return true;
        }),
        restartAuthRuntime,
        storageKey: () => 'storage-key',
        currentUserId: () => null,
        consumeCredentialRequestBinding: vi.fn(() => null),
        pendingStorageBridgeUserId: () => null,
        deferStorageBridgeIdentity: vi.fn(),
        clearPendingStorageBridgeIdentity: vi.fn(),
        applyConfirmedSessionIdentity: vi.fn(),
        clearCachedSessionArtifacts: vi.fn(),
        sessionExpired: () => false,
        syncPersistedOwnerHintFromStorage: vi.fn(),
        syncPersistedSessionUserIdFromStorage: vi.fn(),
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
      });

      await expect(controller.signUp('a@example.com', 'password')).resolves.toEqual({
        ok: true,
        value: { userId: 'user-a' },
      });
      expect(restartAuthRuntime).toHaveBeenCalledOnce();
    } finally {
      if (previousAuthority) Object.defineProperty(globalThis, '__NANOFLOW_AUTH_CANONICAL_STORAGE__', previousAuthority);
      else delete (globalThis as Record<string, unknown>)['__NANOFLOW_AUTH_CANONICAL_STORAGE__'];
    }
  });

  it('does not let stale A adoption re-revoke a newer A after A-B-A', () => {
    const controller = new AuthCredentialSessionFenceController({
      isConfigured: () => true,
      runSignInRequest: vi.fn(),
      runSignUpRequest: vi.fn(),
      captureAuthIdentityFence: () => '1:user-a:',
      authorizeSignupAdoption: vi.fn(),
      restartAuthRuntime: vi.fn(),
      storageKey: () => null,
      currentUserId: () => null,
      consumeCredentialRequestBinding: vi.fn(() => null),
      pendingStorageBridgeUserId: () => null,
      deferStorageBridgeIdentity: vi.fn(),
      clearPendingStorageBridgeIdentity: vi.fn(),
      applyConfirmedSessionIdentity: vi.fn(),
      clearCachedSessionArtifacts: vi.fn(),
      sessionExpired: () => false,
      syncPersistedOwnerHintFromStorage: vi.fn(),
      syncPersistedSessionUserIdFromStorage: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    });
    type Adoption = { outcome: boolean | null };
    type PrivateController = {
      beginSignupInitialSessionAdoption: (session: {
        access_token: string;
        user: { id: string; email: string | null };
      }) => Adoption;
      rejectSignupInitialSessionAdoption: (adoption: Adoption) => void;
      settleSignupInitialSessionAdoption: (adoption: Adoption, accepted: boolean) => boolean;
    };
    const privateController = controller as unknown as PrivateController;
    const sessionA = { access_token: 'token-a', user: { id: 'user-a', email: null } };
    const sessionB = { access_token: 'token-b', user: { id: 'user-b', email: null } };
    const staleA = privateController.beginSignupInitialSessionAdoption(sessionA);
    privateController.beginSignupInitialSessionAdoption(sessionB);
    const currentA = privateController.beginSignupInitialSessionAdoption(sessionA);

    privateController.rejectSignupInitialSessionAdoption(staleA);
    expect(privateController.settleSignupInitialSessionAdoption(currentA, true)).toBe(true);
    expect(controller.shouldApplyInitialSession(sessionA)).toBe(true);
  });
});
