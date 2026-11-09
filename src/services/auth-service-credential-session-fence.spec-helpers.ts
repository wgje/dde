import { Injector } from '@angular/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AUTH_CONFIG } from '../config/auth.config';
import { mockSentryLazyLoaderService } from '../test-setup.mocks';
import { resetBrowserNetworkSuspensionTrackingForTests } from '../utils/browser-network-suspension';
import type { AuthService } from './auth.service';
import { AUTHORITY_KEY, installCanonicalAuthority } from './auth-service-signed-out-pending-bridge.spec-helpers';
import { LoggerService } from './logger.service';
import { SentryLazyLoaderService } from './sentry-lazy-loader.service';
import { SupabaseClientOptionsFactoryService } from './supabase-client-options-factory.service';
import { SupabaseClientService } from './supabase-client.service';

interface AuthServiceCredentialSessionFenceSpecContext {
  service: AuthService;
  mockLogger: unknown;
  realAuthClientCleanup: Array<() => Promise<void>>;
  mockSupabaseClient: {
    client: ReturnType<typeof vi.fn>;
    clientAsync: ReturnType<typeof vi.fn>;
    getSession: ReturnType<typeof vi.fn>;
    signInWithPassword: ReturnType<typeof vi.fn>;
    consumeCredentialRequestIdForAccessToken: ReturnType<typeof vi.fn>;
    reset: ReturnType<typeof vi.fn>;
    signOut: ReturnType<typeof vi.fn>;
  };
  mockEventBus: {
    publishSessionRestored: ReturnType<typeof vi.fn>;
  };
  ensureRuntimeAuthReady: () => Promise<void>;
  dispatchStorageEvent: (newValue: string | null) => void;
  dispatchAuthStateChange: (event: string, session: unknown) => void;
  createPersistedSessionPayload: (
    userId: string,
    email: string | null,
    sessionExpired?: boolean,
    accessToken?: string,
  ) => string;
}

export function registerAuthServiceCredentialSessionFenceSpecs(
  getContext: () => AuthServiceCredentialSessionFenceSpecContext,
): void {
  let context: AuthServiceCredentialSessionFenceSpecContext;

  beforeEach(() => {
    context = getContext();
  });

  describe('canonical storage adoption wiring', () => {
    it('retires A and accepts B only after the replacement listener reports B', async () => {
      installCanonicalAuthority();
      try {
        await context.ensureRuntimeAuthReady();
        context.service.currentUserId.set('user-a');
        const raw = context.createPersistedSessionPayload('user-b', 'b@example.com', false, 'token-b');
        localStorage.setItem('sb-test-auth-token', raw);
        const event = new Event('storage') as StorageEvent;
        Object.defineProperties(event, {
          key: { value: 'sb-test-auth-token' }, newValue: { value: raw }, storageArea: { value: localStorage },
        });
        window.dispatchEvent(event);

        await vi.waitFor(() => expect(context.mockSupabaseClient.reset).toHaveBeenCalledTimes(1));
        await vi.waitFor(() => expect(context.mockSupabaseClient.clientAsync).toHaveBeenCalledTimes(2));
        context.dispatchAuthStateChange('INITIAL_SESSION', {
          access_token: 'token-b', user: { id: 'user-b', email: 'b@example.com' },
        });
        await vi.waitFor(() => expect(context.mockEventBus.publishSessionRestored)
          .toHaveBeenCalledWith('user-b', 'AuthService.storageBridge'));
        expect(context.service.currentUserId()).toBe('user-a');
      } finally {
        delete (globalThis as Record<string, unknown>)[AUTHORITY_KEY];
      }
    });
  });

  describe('credential sign-in commit fence', () => {
    function createDeferred<T>() {
      let resolve!: (value: T) => void;
      const promise = new Promise<T>(promiseResolve => {
        resolve = promiseResolve;
      });
      return { promise, resolve };
    }

    function createAuthTokenResponse(userId: string, email: string, tokenNonce = userId): Response {
      const expiresAt = Math.floor(Date.now() / 1000) + 3600;
      const encodeJwtPart = (value: object): string => btoa(JSON.stringify(value))
        .replace(/=/g, '')
        .replace(/\+/g, '-')
        .replace(/\//g, '_');
      const accessToken = [
        encodeJwtPart({ alg: 'HS256', typ: 'JWT' }),
        encodeJwtPart({ aud: 'authenticated', exp: expiresAt, jti: tokenNonce, sub: userId }),
        'signature',
      ].join('.');
      const now = new Date().toISOString();

      return new Response(JSON.stringify({
        access_token: accessToken,
        token_type: 'bearer',
        expires_in: 3600,
        expires_at: expiresAt,
        refresh_token: `refresh-${tokenNonce}`,
        user: {
          id: userId,
          aud: 'authenticated',
          role: 'authenticated',
          email,
          email_confirmed_at: now,
          phone: '',
          confirmed_at: now,
          last_sign_in_at: now,
          app_metadata: { provider: 'email', providers: ['email'] },
          user_metadata: {},
          identities: [],
          created_at: now,
          updated_at: now,
          is_anonymous: false,
        },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    type ListenerSession = {
      access_token: string;
      user: { id: string; email: string | null };
    };

    function createListenerSession(userId: string, accessToken: string): ListenerSession {
      return {
        access_token: accessToken,
        user: { id: userId, email: `${userId}@example.com` },
      };
    }

    function persistListenerSession(session: ListenerSession): string {
      const raw = context.createPersistedSessionPayload(
        session.user.id,
        session.user.email,
        false,
        session.access_token,
      );
      localStorage.setItem('sb-test-auth-token', raw);
      return raw;
    }

    function dispatchListenerSession(event: 'SIGNED_IN' | 'TOKEN_REFRESHED', session: ListenerSession): void {
      persistListenerSession(session);
      context.dispatchAuthStateChange(event, session);
    }

    async function acceptListenerSession(userId: string, accessToken: string): Promise<ListenerSession> {
      await context.ensureRuntimeAuthReady();
      const session = createListenerSession(userId, accessToken);
      dispatchListenerSession('SIGNED_IN', session);
      return session;
    }

    function pendingStorageBridgeUserId(): string | null {
      return (context.service as unknown as {
        pendingStorageBridgeSessionIdentity: { userId: string } | null;
      }).pendingStorageBridgeSessionIdentity?.userId ?? null;
    }

    function expectLoggedOutWithNoPersistedSession(): void {
      expect.soft(context.service.currentUserId()).toBeNull();
      expect.soft(context.service.authState().userId).toBeNull();
      expect.soft(context.service.authState().email).toBeNull();
      expect.soft(context.service.sessionEmail()).toBeNull();
      expect.soft(context.service.persistedOwnerHint()).toBeNull();
      expect.soft(context.service.persistedSessionUserId()).toBeNull();
      expect.soft(localStorage.getItem('sb-test-auth-token')).toBeNull();
      expect.soft(context.mockEventBus.publishSessionRestored).not.toHaveBeenCalled();
    }

    async function startRealClientSignIn(canCommit: () => boolean) {
      const { GoTrueClient } = await vi.importActual<typeof import('@supabase/auth-js')>(
        '@supabase/auth-js',
      );
      const response = createDeferred<Response>();
      const credentialResponseBound = createDeferred<void>();
      const credentialBindingConsumed = createDeferred<{
        accessToken: string;
        binding: NonNullable<ReturnType<SupabaseClientService['consumeCredentialRequestIdForAccessToken']>>;
      }>();
      const guardedCredentialRequestSettled = createDeferred<void>();
      const guardedCredentialRequestCompletion = createDeferred<void>();
      const concurrentResponses: Response[] = [];
      let holdGuardedCredentialRequestCompletion = false;
      const productionSupabaseInjector = Injector.create({
        providers: [
          { provide: SupabaseClientService, useClass: SupabaseClientService },
          SupabaseClientOptionsFactoryService,
          { provide: LoggerService, useValue: context.mockLogger },
          { provide: SentryLazyLoaderService, useValue: mockSentryLazyLoaderService },
        ],
      });
      const productionSupabaseClient = productionSupabaseInjector.get(SupabaseClientService);
      const mutableProductionSupabaseClient = productionSupabaseClient as unknown as {
        canInitialize: boolean;
        supabaseUrl: string;
        supabaseAnonKey: string;
        supabase: unknown;
        buildClientOptions: () => {
          global: { fetch: (url: RequestInfo | URL, options?: RequestInit) => Promise<Response> };
        };
      };
      mutableProductionSupabaseClient.canInitialize = true;
      mutableProductionSupabaseClient.supabaseUrl = 'https://test.supabase.co';
      mutableProductionSupabaseClient.supabaseAnonKey = 'test-anon-key';
      const productionFetch = mutableProductionSupabaseClient.buildClientOptions().global.fetch;
      const networkFetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
        const concurrentResponse = concurrentResponses.shift();
        return concurrentResponse ?? await response.promise;
      });
      let replacementSession: string | null = null;
      const storage = {
        getItem: (_key: string) => localStorage.getItem('sb-test-auth-token'),
        setItem: (_key: string, value: string) => {
          localStorage.setItem('sb-test-auth-token', value);
          if (replacementSession !== null) {
            localStorage.setItem('sb-test-auth-token', replacementSession);
            replacementSession = null;
          }
        },
        removeItem: (_key: string) => localStorage.removeItem('sb-test-auth-token'),
      };
      const broadcastChannelDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'BroadcastChannel');
      Object.defineProperty(globalThis, 'BroadcastChannel', {
        configurable: true,
        value: undefined,
      });
      let authClient!: InstanceType<typeof GoTrueClient>;
      try {
        authClient = new GoTrueClient({
          autoRefreshToken: false,
          detectSessionInUrl: false,
          fetch: productionFetch,
          headers: { apikey: 'test-anon-key' },
          persistSession: true,
          storage,
          storageKey: `auth-service-real-${crypto.randomUUID()}`,
          url: 'https://test.supabase.co/auth/v1',
        });
      } finally {
        if (broadcastChannelDescriptor) {
          Object.defineProperty(globalThis, 'BroadcastChannel', broadcastChannelDescriptor);
        } else {
          delete (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel;
        }
      }
      await authClient.getSession();
      const client = {
        auth: {
          getSession: authClient.getSession.bind(authClient),
          onAuthStateChange: authClient.onAuthStateChange.bind(authClient),
          refreshSession: authClient.refreshSession.bind(authClient),
          signInWithPassword: async (
            credentials: Parameters<typeof authClient.signInWithPassword>[0],
          ) => {
            const result = await authClient.signInWithPassword(credentials);
            if (holdGuardedCredentialRequestCompletion) {
              guardedCredentialRequestSettled.resolve();
              await guardedCredentialRequestCompletion.promise;
            }
            return result;
          },
          signOut: authClient.signOut.bind(authClient),
          startAutoRefresh: authClient.startAutoRefresh.bind(authClient),
          stopAutoRefresh: authClient.stopAutoRefresh.bind(authClient),
          dispose: authClient.dispose.bind(authClient),
        },
        removeAllChannels: vi.fn().mockResolvedValue([]),
      };
      mutableProductionSupabaseClient.supabase = client;
      context.realAuthClientCleanup.push(async () => {
        guardedCredentialRequestCompletion.resolve();
        productionSupabaseClient.reset();
        networkFetchSpy.mockRestore();
        await authClient.dispose();
      });
      context.mockSupabaseClient.client.mockImplementation(() => productionSupabaseClient.client());
      context.mockSupabaseClient.clientAsync.mockImplementation(() => productionSupabaseClient.clientAsync());
      context.mockSupabaseClient.getSession.mockImplementation(() => productionSupabaseClient.getSession());
      context.mockSupabaseClient.consumeCredentialRequestIdForAccessToken.mockImplementation(
        (accessToken: string) => {
          const binding = productionSupabaseClient
            .consumeCredentialRequestIdForAccessToken(accessToken);
          if (binding) credentialBindingConsumed.resolve({ accessToken, binding });
          return binding;
        },
      );
      context.mockSupabaseClient.signInWithPassword.mockImplementation(
        (email: string, password: string, credentialRequestId?: string) => productionSupabaseClient
          .signInWithPassword(email, password, credentialRequestId),
      );
      context.mockSupabaseClient.signOut.mockImplementation(() => productionSupabaseClient.signOut());
      await context.ensureRuntimeAuthReady();
      context.mockEventBus.publishSessionRestored.mockClear();

      const signIn = context.service.signIn as unknown as (
        email: string,
        password: string,
        canCommitCredentialState: (identity?: { userId?: string | null }) => boolean,
      ) => ReturnType<AuthService['signIn']>;
      const loginPromise = signIn.call(
        context.service,
        'owner-a@example.com',
        'password123',
        canCommit,
      );
      await vi.waitFor(() => expect(context.mockSupabaseClient.signInWithPassword).toHaveBeenCalledTimes(1));
      await vi.waitFor(() => expect(networkFetchSpy).toHaveBeenCalledTimes(1));

      return {
        finish: async () => {
          guardedCredentialRequestCompletion.resolve();
          const snapshot = {
            authStateUserId: context.service.authState().userId,
            currentUserId: context.service.currentUserId(),
            persistedOwnerHint: context.service.persistedOwnerHint(),
            persistedSession: localStorage.getItem('sb-test-auth-token'),
            pendingStorageBridgeUserId: (context.service as unknown as {
              pendingStorageBridgeSessionIdentity: { userId: string } | null;
            }).pendingStorageBridgeSessionIdentity?.userId ?? null,
          };
          await authClient.dispose();
          context.service.reset();
          resetBrowserNetworkSuspensionTrackingForTests();
          return snapshot;
        },
        loginPromise,
        consumeCredentialBinding: (accessToken: string) => productionSupabaseClient
          .consumeCredentialRequestIdForAccessToken(accessToken),
        releaseCredentialRequestCompletion: () => guardedCredentialRequestCompletion.resolve(),
        signInConcurrentSession: async (userId: string, email: string, tokenNonce: string) => {
          concurrentResponses.push(createAuthTokenResponse(userId, email, tokenNonce));
          const { data, error } = await authClient.signInWithPassword({
            email,
            password: 'password123',
          });
          if (error || !data.session) {
            throw error ?? new Error('Concurrent sign-in did not return a session');
          }
          return data.session;
        },
        signInPendingCrossTabSession: async (
          userId: string,
          email: string,
          tokenNonce: string,
        ) => {
          const authResponse = createAuthTokenResponse(userId, email, tokenNonce);
          const persistedSession = JSON.stringify(await authResponse.clone().json());
          localStorage.setItem('sb-test-auth-token', persistedSession);
          context.dispatchStorageEvent(persistedSession);
          concurrentResponses.push(authResponse);
          const { data, error } = await authClient.signInWithPassword({
            email,
            password: 'password123',
          });
          if (error || !data.session) {
            throw error ?? new Error('Pending cross-tab sign-in did not return a session');
          }
          return data.session;
        },
        replaceNextStorageWrite: (value: string) => {
          replacementSession = value;
        },
        resolve: () => response.resolve(createAuthTokenResponse('owner-a', 'owner-a@example.com')),
        resolveWithSettlementGate: async () => {
          holdGuardedCredentialRequestCompletion = true;
          const settlementGate = createDeferred<void>();
          const authResponse = createAuthTokenResponse('owner-a', 'owner-a@example.com');
          const payload = await authResponse.clone().json() as { access_token: string };
          const cloneResponse = authResponse.clone.bind(authResponse);
          authResponse.clone = () => {
            const clonedResponse = cloneResponse();
            const readClonedJson = clonedResponse.json.bind(clonedResponse);
            clonedResponse.json = async () => {
              const clonedPayload = await readClonedJson();
              credentialResponseBound.resolve();
              return clonedPayload;
            };
            return clonedResponse;
          };
          const readJson = authResponse.json.bind(authResponse);
          authResponse.json = async () => {
            await settlementGate.promise;
            return await readJson();
          };
          response.resolve(authResponse);
          return {
            release: () => settlementGate.resolve(),
            staleAccessToken: payload.access_token,
            waitForBinding: credentialResponseBound.promise,
            waitForConsumption: credentialBindingConsumed.promise,
            waitForRequestSettlement: guardedCredentialRequestSettled.promise,
          };
        },
      };
    }

    it('进入 local mode 后应拒绝迟到 SIGNED_IN 的身份、持久化与 restored 副作用', async () => {
      let current = true;
      const pending = await startRealClientSignIn(() => current);

      current = false;
      localStorage.setItem(AUTH_CONFIG.LOCAL_MODE_CACHE_KEY, 'true');
      context.service.currentUserId.set(AUTH_CONFIG.LOCAL_MODE_USER_ID);
      context.service.authState.update(state => ({
        ...state,
        userId: AUTH_CONFIG.LOCAL_MODE_USER_ID,
        email: null,
      }));
      pending.resolve();
      await pending.loginPromise;
      const snapshot = await pending.finish();

      expect.soft(snapshot.currentUserId).toBe(AUTH_CONFIG.LOCAL_MODE_USER_ID);
      expect.soft(snapshot.authStateUserId).toBe(AUTH_CONFIG.LOCAL_MODE_USER_ID);
      expect.soft(snapshot.persistedOwnerHint).not.toBe('owner-a');
      expect.soft(snapshot.persistedSession).toBeNull();
      expect.soft(context.mockEventBus.publishSessionRestored).not.toHaveBeenCalled();
    });

    it('signOut 后应拒绝迟到 SIGNED_IN 的身份、持久化与 restored 副作用', async () => {
      let current = true;
      const pending = await startRealClientSignIn(() => current);

      current = false;
      await context.service.signOut();
      pending.resolve();
      await pending.loginPromise;
      const snapshot = await pending.finish();

      expect.soft(snapshot.currentUserId).toBeNull();
      expect.soft(snapshot.authStateUserId).toBeNull();
      expect.soft(snapshot.persistedOwnerHint).toBeNull();
      expect.soft(snapshot.persistedSession).toBeNull();
      expect.soft(context.mockEventBus.publishSessionRestored).not.toHaveBeenCalled();
    });

    it('当前提交的正常登录仍应提交身份并保留 Supabase session', async () => {
      const pending = await startRealClientSignIn(() => true);

      pending.resolve();
      const result = await pending.loginPromise;
      const snapshot = await pending.finish();

      expect(result).toMatchObject({ ok: true, value: { userId: 'owner-a' } });
      expect(snapshot.currentUserId).toBe('owner-a');
      expect(snapshot.authStateUserId).toBe('owner-a');
      expect(snapshot.persistedOwnerHint).toBe('owner-a');
      expect(snapshot.persistedSession).not.toBeNull();
    });

    it('拒绝迟到 SIGNED_IN 时不得删除 token 不同的较新 session', async () => {
      let current = true;
      const pending = await startRealClientSignIn(() => current);
      const newerSession = context.createPersistedSessionPayload('owner-b', 'owner-b@example.com');

      current = false;
      pending.replaceNextStorageWrite(newerSession);
      pending.resolve();
      await pending.loginPromise;
      const snapshot = await pending.finish();

      expect.soft(snapshot.currentUserId).toBeNull();
      expect.soft(snapshot.authStateUserId).toBeNull();
      expect.soft(snapshot.persistedOwnerHint).toBeNull();
      expect.soft(snapshot.persistedSession).toBe(newerSession);
      expect.soft(context.mockEventBus.publishSessionRestored).not.toHaveBeenCalled();
    });

    it('A 已失效但请求仍 pending 时应接受独立用户 B 的真实 SIGNED_IN 并保留 B token', async () => {
      let current = true;
      const pending = await startRealClientSignIn(() => current);

      current = false;
      const sessionB = await pending.signInConcurrentSession(
        'owner-b',
        'owner-b@example.com',
        'owner-b-newer-session',
      );

      expect.soft(context.service.currentUserId()).toBe('owner-b');
      expect.soft(context.service.authState().userId).toBe('owner-b');
      expect.soft(context.service.persistedOwnerHint()).toBe('owner-b');
      expect.soft(JSON.parse(localStorage.getItem('sb-test-auth-token') ?? '{}')).toMatchObject({
        access_token: sessionB.access_token,
        user: { id: 'owner-b' },
      });

      pending.resolve();
      await pending.loginPromise;
      const snapshot = await pending.finish();

      expect.soft(snapshot.currentUserId).toBe('owner-b');
      expect.soft(snapshot.authStateUserId).toBe('owner-b');
      expect.soft(JSON.parse(snapshot.persistedSession ?? '{}')).toMatchObject({
        access_token: sessionB.access_token,
        user: { id: 'owner-b' },
      });
    });

    it('A 已失效但请求仍 pending 时应接受同用户较新 token 的真实 SIGNED_IN', async () => {
      let current = true;
      const pending = await startRealClientSignIn(() => current);

      current = false;
      const newerSession = await pending.signInConcurrentSession(
        'owner-a',
        'owner-a@example.com',
        'owner-a-newer-session',
      );

      expect.soft(context.service.currentUserId()).toBe('owner-a');
      expect.soft(context.service.authState().userId).toBe('owner-a');
      expect.soft(context.service.persistedOwnerHint()).toBe('owner-a');
      expect.soft(JSON.parse(localStorage.getItem('sb-test-auth-token') ?? '{}')).toMatchObject({
        access_token: newerSession.access_token,
        user: { id: 'owner-a' },
      });

      pending.resolve();
      await pending.loginPromise;
      const snapshot = await pending.finish();

      expect.soft(snapshot.currentUserId).toBe('owner-a');
      expect.soft(snapshot.authStateUserId).toBe('owner-a');
      expect.soft(JSON.parse(snapshot.persistedSession ?? '{}')).toMatchObject({
        access_token: newerSession.access_token,
        user: { id: 'owner-a' },
      });
    });

    it('A 绑定 B 后、更晚 C 已接受时不得把 stale A 恢复回旧 B', async () => {
      let current = true;
      const pending = await startRealClientSignIn(() => current);
      await pending.signInConcurrentSession(
        'owner-b',
        'owner-b@example.com',
        'owner-b-binding-snapshot',
      );
      const sessionBBindingSnapshot = localStorage.getItem('sb-test-auth-token');

      const settlement = await pending.resolveWithSettlementGate();
      await settlement.waitForBinding;
      current = false;
      const sessionC = await pending.signInConcurrentSession(
        'owner-c',
        'owner-c@example.com',
        'owner-c-latest-session',
      );

      expect.soft(context.service.currentUserId()).toBe('owner-c');
      expect.soft(context.service.persistedOwnerHint()).toBe('owner-c');
      settlement.release();
      const [{ accessToken, binding }] = await Promise.all([
        settlement.waitForConsumption,
        settlement.waitForRequestSettlement,
      ]);
      expect.soft(accessToken).toBe(settlement.staleAccessToken);
      expect.soft(binding.previousPersistedSession).toBe(sessionBBindingSnapshot);
      expect.soft(pending.consumeCredentialBinding(settlement.staleAccessToken)).toBeNull();
      pending.releaseCredentialRequestCompletion();
      await pending.loginPromise;
      const snapshot = await pending.finish();

      expect.soft(snapshot.currentUserId).toBe('owner-c');
      expect.soft(snapshot.authStateUserId).toBe('owner-c');
      expect.soft(snapshot.persistedOwnerHint).toBe('owner-c');
      expect.soft(JSON.parse(snapshot.persistedSession ?? '{}')).toMatchObject({
        access_token: sessionC.access_token,
        user: { id: 'owner-c' },
      });
      expect.soft(pending.consumeCredentialBinding(settlement.staleAccessToken)).toBeNull();
    });

    it('A 绑定 B 后 pending cross-tab C 应保留 C session 与 bridge identity', async () => {
      let current = true;
      const pending = await startRealClientSignIn(() => current);
      await pending.signInConcurrentSession(
        'owner-b',
        'owner-b@example.com',
        'owner-b-pending-cross-tab-snapshot',
      );
      const sessionBBindingSnapshot = localStorage.getItem('sb-test-auth-token');

      const settlement = await pending.resolveWithSettlementGate();
      await settlement.waitForBinding;
      current = false;
      const sessionC = await pending.signInPendingCrossTabSession(
        'owner-c',
        'owner-c@example.com',
        'owner-c-pending-cross-tab-session',
      );

      expect.soft(context.service.currentUserId()).toBe('owner-b');
      expect.soft(context.service.persistedOwnerHint()).toBe('owner-c');
      settlement.release();
      const [{ binding }] = await Promise.all([
        settlement.waitForConsumption,
        settlement.waitForRequestSettlement,
      ]);
      expect.soft(binding.previousPersistedSession).toBe(sessionBBindingSnapshot);
      pending.releaseCredentialRequestCompletion();
      await pending.loginPromise;
      const snapshot = await pending.finish();

      expect.soft(snapshot.currentUserId).toBe('owner-b');
      expect.soft(snapshot.authStateUserId).toBe('owner-b');
      expect.soft(snapshot.pendingStorageBridgeUserId).toBe('owner-c');
      expect.soft(snapshot.persistedOwnerHint).toBe('owner-c');
      expect.soft(JSON.parse(snapshot.persistedSession ?? '{}')).toMatchObject({
        access_token: sessionC.access_token,
        user: { id: 'owner-c' },
      });
    });

    it('persisted credential 缺失时应撤销 accepted snapshot 的 exact SIGNED_IN', async () => {
      const oldSession = await acceptListenerSession('owner-a', 'token-a-1');
      localStorage.removeItem('sb-test-auth-token');
      await context.service.signOut();
      context.mockEventBus.publishSessionRestored.mockClear();

      dispatchListenerSession('SIGNED_IN', oldSession);

      expectLoggedOutWithNoPersistedSession();
    });

    it('revoked exact session 应非消费式拒绝，reset 后 listener 可重新接受', async () => {
      const oldSession = await acceptListenerSession('owner-a', 'token-a-repeat');
      await context.service.signOut();

      for (let attempt = 0; attempt < 2; attempt += 1) {
        context.mockEventBus.publishSessionRestored.mockClear();
        dispatchListenerSession('SIGNED_IN', oldSession);
        expectLoggedOutWithNoPersistedSession();
        if (context.service.currentUserId()) await context.service.signOut();
      }

      context.service.reset();
      await context.ensureRuntimeAuthReady();
      dispatchListenerSession('SIGNED_IN', oldSession);
      expect.soft(context.service.currentUserId()).toBe('owner-a');
      expect.soft(localStorage.getItem('sb-test-auth-token')).not.toBeNull();
    });

    it('同一 owner 的两代 successful signOut token 均应保留在 revocation set', async () => {
      const firstSession = await acceptListenerSession('owner-a', 'token-a-old');
      await context.service.signOut();
      const secondSession = await acceptListenerSession('owner-a', 'token-a-newer');
      await context.service.signOut();

      for (const revokedSession of [firstSession, secondSession]) {
        context.mockEventBus.publishSessionRestored.mockClear();
        dispatchListenerSession('SIGNED_IN', revokedSession);
        expectLoggedOutWithNoPersistedSession();
        if (context.service.currentUserId()) await context.service.signOut();
      }
    });

    it('signOut 应优先撤销当前 persisted token 而不是 stale accepted snapshot', async () => {
      await acceptListenerSession('owner-a', 'token-a-accepted-old');
      const persistedSession = createListenerSession('owner-a', 'token-a-persisted-current');
      persistListenerSession(persistedSession);

      await context.service.signOut();
      context.mockEventBus.publishSessionRestored.mockClear();
      dispatchListenerSession('SIGNED_IN', persistedSession);

      expectLoggedOutWithNoPersistedSession();
    });

    it('revoked TOKEN_REFRESHED 不得借 sessionExpired fast path 恢复旧 owner', async () => {
      const oldSession = await acceptListenerSession('owner-a', 'token-a-expired');
      await context.service.signOut();
      context.service.sessionExpired.set(true);
      context.mockEventBus.publishSessionRestored.mockClear();

      dispatchListenerSession('TOKEN_REFRESHED', oldSession);

      expectLoggedOutWithNoPersistedSession();
    });

    it('revoked TOKEN_REFRESHED 不得借 pending-owner fast path 保留旧 persisted session', async () => {
      const oldSession = await acceptListenerSession('owner-a', 'token-a-pending');
      await context.service.signOut();
      const raw = persistListenerSession(oldSession);
      context.dispatchStorageEvent(raw);
      context.mockEventBus.publishSessionRestored.mockClear();

      context.dispatchAuthStateChange('TOKEN_REFRESHED', oldSession);
      await vi.waitFor(() => expect(localStorage.getItem('sb-test-auth-token')).toBeNull());

      expect.soft(context.service.currentUserId()).toBeNull();
      expect.soft(pendingStorageBridgeUserId()).toBe('owner-a');
      expect.soft(context.service.persistedOwnerHint()).toBeNull();
      expect.soft(localStorage.getItem('sb-test-auth-token')).toBeNull();
      expect.soft(context.mockEventBus.publishSessionRestored).not.toHaveBeenCalled();
    });

    it('pending signOut 在成功 settlement 前不得激活 revocation', async () => {
      const oldSession = await acceptListenerSession('owner-a', 'token-a-pending-signout');
      const signOutGate = createDeferred<void>();
      context.mockSupabaseClient.signOut.mockReturnValueOnce(signOutGate.promise);

      const signOutPromise = context.service.signOut();
      await vi.waitFor(() => expect(context.mockSupabaseClient.signOut).toHaveBeenCalled());
      dispatchListenerSession('SIGNED_IN', oldSession);
      expect.soft(context.service.currentUserId()).toBe('owner-a');
      expect.soft(localStorage.getItem('sb-test-auth-token')).not.toBeNull();

      signOutGate.resolve();
      await signOutPromise;
      context.mockEventBus.publishSessionRestored.mockClear();
      dispatchListenerSession('SIGNED_IN', oldSession);
      expectLoggedOutWithNoPersistedSession();
    });

    it('failed signOut 不得激活 revocation', async () => {
      const oldSession = await acceptListenerSession('owner-a', 'token-a-failed-signout');
      context.mockSupabaseClient.signOut.mockRejectedValueOnce(new Error('signout failed'));

      await expect(context.service.signOut()).rejects.toThrow('signout failed');
      dispatchListenerSession('SIGNED_IN', oldSession);

      expect.soft(context.service.currentUserId()).toBe('owner-a');
      expect.soft(localStorage.getItem('sb-test-auth-token')).not.toBeNull();
    });

    it('new token、different owner 与 newer same-owner pending bridge 应保持可接受', async () => {
      const revokedSession = await acceptListenerSession('owner-a', 'token-a-revoked');
      await context.service.signOut();
      const newSession = createListenerSession('owner-a', 'token-a-current');
      dispatchListenerSession('SIGNED_IN', newSession);
      expect.soft(context.service.currentUserId()).toBe('owner-a');

      await context.service.signOut();
      const differentOwnerSession = createListenerSession('owner-b', 'token-b-current');
      dispatchListenerSession('SIGNED_IN', differentOwnerSession);
      expect.soft(context.service.currentUserId()).toBe('owner-b');

      await context.service.signOut();
      const pendingSession = createListenerSession('owner-a', 'token-a-pending-new');
      const raw = persistListenerSession(pendingSession);
      context.dispatchStorageEvent(raw);
      context.dispatchAuthStateChange('TOKEN_REFRESHED', pendingSession);
      expect.soft(context.service.currentUserId()).toBeNull();
      expect.soft(pendingStorageBridgeUserId()).toBe('owner-a');
      expect.soft(localStorage.getItem('sb-test-auth-token')).toBe(raw);
      expect.soft(revokedSession.access_token).not.toBe(pendingSession.access_token);

      context.dispatchAuthStateChange('TOKEN_REFRESHED', revokedSession);
      expect.soft(context.service.currentUserId()).toBeNull();
      expect.soft(pendingStorageBridgeUserId()).toBe('owner-a');
      expect.soft(context.service.persistedOwnerHint()).toBe('owner-a');
      expect.soft(context.service.persistedSessionUserId()).toBeNull();
      expect.soft(localStorage.getItem('sb-test-auth-token')).toBe(raw);
    });

    it('非 explicit invalidation 后 sessionExpired recovery 应保持可用', async () => {
      const session = await acceptListenerSession('owner-a', 'token-a-recovery');
      context.dispatchAuthStateChange('SIGNED_OUT', null);
      expect.soft(context.service.sessionExpired()).toBe(true);

      dispatchListenerSession('TOKEN_REFRESHED', session);

      expect.soft(context.service.currentUserId()).toBe('owner-a');
      expect.soft(context.service.sessionExpired()).toBe(false);
      expect.soft(localStorage.getItem('sb-test-auth-token')).not.toBeNull();
    });

    it('sessionExpired fast path rejects a foreign owner token', async () => {
      await acceptListenerSession('owner-a', 'token-a-recovery-foreign');
      context.dispatchAuthStateChange('SIGNED_OUT', null);
      expect(context.service.sessionExpired()).toBe(true);

      context.dispatchAuthStateChange('TOKEN_REFRESHED', createListenerSession('owner-b', 'token-b-foreign'));

      expect(context.service.currentUserId()).toBeNull();
      expect(context.service.sessionExpired()).toBe(true);
      expect(localStorage.getItem('sb-test-auth-token')).toBeNull();
    });
  });
}
