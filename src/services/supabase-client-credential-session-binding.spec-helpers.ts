import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SupabaseClientService } from './supabase-client.service';
import {
  confirmationResponse,
  createSignupSession,
  passwordResponse,
} from './auth-service-background-session-refresh-authority.spec-helpers';
import {
  signupResponse,
} from './supabase-client.service.spec-helpers';
import type {
  ClientFetch,
  SignupBundle,
  SignupClientOptions,
  SignupSession,
} from './supabase-client.service.spec-helpers';

interface SupabaseClientCredentialSessionBindingSpecContext {
  service: SupabaseClientService;
  fetchSpy: ReturnType<typeof vi.spyOn>;
  createClientMock: ReturnType<typeof vi.fn>;
  authClientMock: {
    auth: {
      signInWithPassword: ReturnType<typeof vi.fn>;
    };
  };
}

type CredentialBinding = {
  requestId: string;
  previousPersistedSession: string | null;
};

type CredentialAwareClient = {
  signInWithPassword(
    email: string,
    password: string,
    credentialRequestId?: string,
  ): ReturnType<SupabaseClientService['signInWithPassword']>;
  consumeCredentialRequestIdForAccessToken(accessToken: string): CredentialBinding | null;
};

export function registerSupabaseClientCredentialSessionBindingSpecs(
  getContext: () => SupabaseClientCredentialSessionBindingSpecContext,
): void {
  let context: SupabaseClientCredentialSessionBindingSpecContext;
  const locksDescriptor = Object.getOwnPropertyDescriptor(navigator, 'locks');
  const sessionStorageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');

  beforeEach(() => {
    context = getContext();
  });

  afterEach(() => {
    context.createClientMock.mockImplementation(() => context.authClientMock);
    if (locksDescriptor) Object.defineProperty(navigator, 'locks', locksDescriptor);
    else delete (navigator as { locks?: unknown }).locks;
    if (sessionStorageDescriptor) {
      Object.defineProperty(globalThis, 'sessionStorage', sessionStorageDescriptor);
    }
  });

  describe('credential request session causality', () => {
    async function initializeClient(): Promise<{
      credentialClient: CredentialAwareClient;
      clientFetch: ClientFetch;
    }> {
      const mutable = context.service as unknown as {
        canInitialize: boolean;
        supabaseUrl: string;
        supabaseAnonKey: string;
      };
      mutable.canInitialize = true;
      mutable.supabaseUrl = 'https://example.supabase.co';
      mutable.supabaseAnonKey = 'anon-key';
      await context.service.clientAsync();

      const createClientCalls = context.createClientMock.mock.calls as unknown as Array<[
        string,
        string,
        { global: { fetch: ClientFetch } },
      ]>;
      const options = createClientCalls[createClientCalls.length - 1]?.[2];
      if (!options) throw new Error('Supabase client options were not captured');

      return {
        credentialClient: context.service as unknown as CredentialAwareClient,
        clientFetch: options.global.fetch,
      };
    }

    function installSignupHarness(options: {
      casResult?: 'committed' | 'noop';
      disposeThrows?: boolean;
      initialBundle?: SignupBundle;
      listenerSession?: (session: SignupSession, index: number) => SignupSession;
    } = {}) {
      const mutable = context.service as unknown as {
        canInitialize: boolean;
        supabaseUrl: string;
        supabaseAnonKey: string;
        signUpIsolated(
          email: string,
          password: string,
          redirectTo: string,
          canCommit: (identity: { userId: string; email: string | null }) => boolean,
          afterCommit: (session: SignupSession) => Promise<boolean>,
        ): Promise<{ data: { session: SignupSession | null; user: SignupSession['user'] | null }; error: unknown }>;
      };
      mutable.canInitialize = true;
      mutable.supabaseUrl = 'https://example.supabase.co';
      mutable.supabaseAnonKey = 'anon-key';
      Object.defineProperty(navigator, 'locks', {
        configurable: true,
        value: { request: async (_name: string, _options: unknown, callback: () => unknown) => callback() },
      });
      const bundle: SignupBundle = { session: null, codeVerifier: null, user: null,
        ...options.initialBundle };
      const canonicalStorageKey = context.service.getStorageKey();
      const compareAndSwap = vi.fn(async (
        transaction: { storageKey: string; expected: SignupBundle; next: SignupBundle },
        authorize?: () => void,
      ) => {
        if (transaction.storageKey !== canonicalStorageKey) throw new Error('AUTH_CANONICAL_STORAGE_KEY_MISMATCH');
        authorize?.();
        if (JSON.stringify(bundle) !== JSON.stringify(transaction.expected)) {
          throw new Error('AUTH_CANONICAL_CAS_MISMATCH');
        }
        if (options.casResult === 'noop') return 'noop';
        Object.assign(bundle, transaction.next);
        return 'committed';
      });
      const readBundle = vi.fn(async () => ({ ...bundle }));
      Object.defineProperty(globalThis, '__NANOFLOW_AUTH_CANONICAL_STORAGE__', {
        configurable: true,
        value: {
          createGeneration: vi.fn(),
          peekBundle: vi.fn(() => ({ ...bundle })),
          readBundle,
          compareAndSwap,
          startSessionPrewarm: vi.fn(),
        },
      });
      const clients: Array<{
        options: SignupClientOptions;
        listener: ((event: string, session: SignupSession) => Promise<void> | void) | null;
        capturedListener: ((event: string, session: SignupSession) => Promise<void> | void) | null;
        subscribeCount: number;
        listenerCalls: number;
        sessionWrites: number;
        unsubscribe: ReturnType<typeof vi.fn>;
        dispose: ReturnType<typeof vi.fn>;
        removeAllChannels: ReturnType<typeof vi.fn>;
      }> = [];
      context.createClientMock.mockImplementation((_url, _key, clientOptions: SignupClientOptions) => {
        const index = clients.length;
        const client = {
          options: clientOptions,
          listener: null,
          capturedListener: null,
          subscribeCount: 0,
          listenerCalls: 0,
          sessionWrites: 0,
          unsubscribe: vi.fn(),
          dispose: options.disposeThrows
            ? vi.fn(() => { throw new Error('AUTH_SIGNUP_DISPOSE_FAILED'); })
            : vi.fn().mockResolvedValue(undefined),
          removeAllChannels: vi.fn().mockResolvedValue([]),
        } as (typeof clients)[number];
        client.unsubscribe.mockImplementation(() => { client.listener = null; });
        clients.push(client);
        return {
          auth: {
            onAuthStateChange: vi.fn(callback => {
              client.subscribeCount += 1;
              client.listener = callback;
              client.capturedListener = callback;
              return { data: { subscription: { unsubscribe: client.unsubscribe } } };
            }),
            signUp: vi.fn(async () => {
              await clientOptions.auth.storage.setItem(
                `${clientOptions.auth.storageKey}-code-verifier`,
                JSON.stringify(`signup-verifier-${index}/signup`),
              );
              const response = await clientOptions.global.fetch(
                'https://example.supabase.co/auth/v1/signup',
                { method: 'POST' },
              );
              const payload = await response.json() as Partial<SignupSession> & {
                user?: SignupSession['user'];
              };
              const user = payload.user ?? null;
              if (!payload.access_token || !payload.refresh_token || !user) {
                return { data: { session: null, user }, error: null };
              }
              const session = payload as SignupSession;
              client.sessionWrites += 1;
              await clientOptions.auth.storage.setItem(
                clientOptions.auth.storageKey,
                JSON.stringify(session),
              );
              client.listenerCalls += 1;
              await client.listener?.('SIGNED_IN', options.listenerSession?.(session, index) ?? session);
              return { data: { session, user }, error: null };
            }),
            dispose: client.dispose,
          },
          removeAllChannels: client.removeAllChannels,
        };
      });
      const signUp = (
        suffix: string,
        canCommit: (identity: { userId: string; email: string | null }) => boolean = () => true,
        afterCommit: (session: SignupSession) => Promise<boolean> = async () => true,
      ) => mutable.signUpIsolated(
        `${suffix}@example.com`,
        'password',
        'https://nanoflow.pages.dev/auth/callback',
        canCommit,
        afterCommit,
      );
      return { bundle, clients, compareAndSwap, readBundle, signUp };
    }

    it('binds the opaque request id to the exact response token before auth continuation', async () => {
      const { credentialClient, clientFetch } = await initializeClient();
      const previousPersistedSession = JSON.stringify({
        access_token: 'token-b',
        user: { id: 'same-user' },
      });
      const storageKey = context.service.getStorageKey();
      expect(storageKey).not.toBeNull();
      localStorage.setItem(storageKey!, previousPersistedSession);
      context.fetchSpy.mockResolvedValue(passwordResponse('token-a'));
      let bindingSeenByAuthEvent: CredentialBinding | null = null;
      context.authClientMock.auth.signInWithPassword.mockImplementation(async () => {
        const response = await clientFetch(
          'https://example.supabase.co/auth/v1/token?grant_type=password',
          { method: 'POST' },
        );
        const payload = await response.json() as { access_token: string };
        bindingSeenByAuthEvent = credentialClient.consumeCredentialRequestIdForAccessToken(
          payload.access_token,
        );
        return { data: {}, error: null };
      });
      await credentialClient.signInWithPassword(
        'same-user@example.com',
        'password',
        'credential-request-a',
      );
      expect(bindingSeenByAuthEvent).toEqual({
        requestId: 'credential-request-a',
        previousPersistedSession,
      });
      expect(credentialClient.consumeCredentialRequestIdForAccessToken('unrelated-token')).toBeNull();
    });
    it('keeps concurrent same-user responses bound to their own request ids when B resolves first', async () => {
      const { credentialClient, clientFetch } = await initializeClient();
      const responseA = createDeferred<Response>();
      const responseB = createDeferred<Response>();
      context.fetchSpy
        .mockImplementationOnce(() => responseA.promise)
        .mockImplementationOnce(() => responseB.promise);
      const observed = new Map<string, CredentialBinding | null>();
      context.authClientMock.auth.signInWithPassword.mockImplementation(async () => {
        const response = await clientFetch(
          'https://example.supabase.co/auth/v1/token?grant_type=password',
          { method: 'POST' },
        );
        const payload = await response.json() as { access_token: string };
        observed.set(
          payload.access_token,
          credentialClient.consumeCredentialRequestIdForAccessToken(payload.access_token),
        );
        return { data: {}, error: null };
      });
      const signInA = credentialClient.signInWithPassword(
        'same-user@example.com',
        'password-a',
        'credential-request-a',
      );
      const signInB = credentialClient.signInWithPassword(
        'same-user@example.com',
        'password-b',
        'credential-request-b',
      );
      await vi.waitFor(() => expect(context.fetchSpy).toHaveBeenCalledTimes(2));
      responseB.resolve(passwordResponse('token-b'));
      await vi.waitFor(() => {
        expect(observed.get('token-b')?.requestId).toBe('credential-request-b');
      });
      responseA.resolve(passwordResponse('token-a'));
      await Promise.all([signInA, signInB]);

      expect(observed.get('token-a')?.requestId).toBe('credential-request-a');
    });

    it('clears an unconsumed token binding when the credential request completes', async () => {
      const { credentialClient, clientFetch } = await initializeClient();
      context.fetchSpy.mockResolvedValue(passwordResponse('token-cleanup'));
      context.authClientMock.auth.signInWithPassword.mockImplementation(async () => {
        await clientFetch(
          'https://example.supabase.co/auth/v1/token?grant_type=password',
          { method: 'POST' },
        );
        return { data: {}, error: null };
      });
      await credentialClient.signInWithPassword(
        'same-user@example.com',
        'password',
        'credential-request-cleanup',
      );
      expect(credentialClient.consumeCredentialRequestIdForAccessToken('token-cleanup')).toBeNull();
    });

    it('rejects a duplicate token binding without overwriting the first request', async () => {
      const { credentialClient } = await initializeClient();
      const bindingController = (context.service as unknown as {
        credentialRequestSessionBinding: {
          bindResponse(
            context: { requestId: string }, url: string, options: RequestInit, response: Response,
          ): Promise<void>;
        };
      }).credentialRequestSessionBinding;
      const response = passwordResponse('token-collision');

      await bindingController.bindResponse(
        { requestId: 'credential-request-a' },
        'https://example.supabase.co/auth/v1/token?grant_type=password',
        { method: 'POST' },
        response,
      );
      await expect(bindingController.bindResponse(
        { requestId: 'credential-request-b' },
        'https://example.supabase.co/auth/v1/token?grant_type=password',
        { method: 'POST' },
        response,
      )).rejects.toThrow('AUTH_CREDENTIAL_TOKEN_BINDING_COLLISION');
      expect(credentialClient.consumeCredentialRequestIdForAccessToken('token-collision'))
        .toMatchObject({ requestId: 'credential-request-a' });
    });

    it('retains an in-flight binding across reset until a late auth event consumes it', async () => {
      const { credentialClient, clientFetch } = await initializeClient();
      const authContinuation = createDeferred<void>();
      const responseBound = createDeferred<void>();
      context.fetchSpy.mockResolvedValue(passwordResponse('token-reset'));
      context.authClientMock.auth.signInWithPassword.mockImplementation(async () => {
        await clientFetch(
          'https://example.supabase.co/auth/v1/token?grant_type=password',
          { method: 'POST' },
        );
        responseBound.resolve();
        await authContinuation.promise;
        return { data: {}, error: null };
      });

      const signIn = credentialClient.signInWithPassword(
        'same-user@example.com',
        'password',
        'credential-request-reset',
      );
      await responseBound.promise;

      context.service.reset();
      expect(credentialClient.consumeCredentialRequestIdForAccessToken('token-reset'))
        .toMatchObject({ requestId: 'credential-request-reset' });

      authContinuation.resolve();
      await signIn;
      expect(credentialClient.consumeCredentialRequestIdForAccessToken('token-reset')).toBeNull();
    });

    it('authorizes exact signup adoption before awaiting candidate disposal and primary restart', async () => {
      const session = createSignupSession('signup-owner-a');
      const order: string[] = [];
      const initialize = vi.fn();
      const setSession = vi.fn();
      const startAutoRefresh = vi.fn();
      const dispose = vi.fn(async () => { order.push('disposed'); });
      const removeAllChannels = vi.fn(async () => { order.push('channels-removed'); });
      context.createClientMock.mockReturnValueOnce({
        auth: {
          getSession: vi.fn().mockResolvedValue({ data: { session }, error: null }),
          initialize, setSession, startAutoRefresh, dispose,
        },
        removeAllChannels,
      });
      const mutable = context.service as unknown as {
        canInitialize: boolean;
        supabaseUrl: string;
        supabaseAnonKey: string;
        authorizeSignupAdoption(
          expected: SignupSession,
          authorize: () => boolean,
        ): Promise<boolean>;
      };
      mutable.canInitialize = true;
      mutable.supabaseUrl = 'https://example.supabase.co';
      mutable.supabaseAnonKey = 'anon-key';

      const accepted = await mutable.authorizeSignupAdoption(session, () => {
        order.push('authorized');
        return true;
      });
      order.push('returned');

      expect(accepted).toBe(true);
      expect(order).toEqual(['authorized', 'disposed', 'channels-removed', 'returned']);
      expect(initialize).not.toHaveBeenCalled();
      expect(setSession).not.toHaveBeenCalled();
      expect(startAutoRefresh).not.toHaveBeenCalled();
      expect(dispose).toHaveBeenCalledOnce();
      expect(removeAllChannels).toHaveBeenCalledOnce();
      const options = context.createClientMock.mock.calls[0]?.[2] as {
        auth: Record<string, unknown>;
      };
      expect(options.auth).toMatchObject({
        autoRefreshToken: false,
        detectSessionInUrl: false,
        persistSession: true,
        skipAutoInitialize: true,
      });
    });

    it('publishes an isolated signup session only after exact canonical CAS and listener match', async () => {
      const harness = installSignupHarness();
      const session = createSignupSession('signup-owner-a');
      context.fetchSpy.mockResolvedValue(signupResponse(session));
      const afterCommit = vi.fn().mockResolvedValue(true);

      const result = await harness.signUp('signup', () => true, afterCommit);

      expect(result.error).toBeNull();
      expect(harness.compareAndSwap).toHaveBeenCalledOnce();
      expect(JSON.parse(harness.bundle.session ?? '{}')).toMatchObject({
        access_token: session.access_token,
        user: { id: 'signup-owner-a' },
      });
      expect(afterCommit).toHaveBeenCalledOnce();
      expect(harness.clients[0]?.subscribeCount).toBe(1);
      expect(harness.clients[0]?.unsubscribe).toHaveBeenCalledOnce();
      expect(harness.clients[0]?.dispose).toHaveBeenCalledOnce();
      expect(harness.clients[0]?.removeAllChannels).toHaveBeenCalledOnce();
    });
    it('continues channel cleanup when client disposal throws synchronously', async () => {
      const harness = installSignupHarness({ disposeThrows: true });
      context.fetchSpy.mockResolvedValue(signupResponse(createSignupSession('dispose-owner')));

      await expect(harness.signUp('dispose-owner')).rejects.toThrow('AUTH_SIGNUP_CLEANUP_FAILED');
      expect(harness.clients[0]?.dispose).toHaveBeenCalledOnce();
      expect(harness.clients[0]?.removeAllChannels).toHaveBeenCalledOnce();
    });
    it('binds isolated CAS to its storage key and rejects noop publication', async () => {
      const harness = installSignupHarness({ casResult: 'noop' });
      context.fetchSpy.mockResolvedValue(signupResponse(createSignupSession('noop-owner')));

      await expect(harness.signUp('noop-owner')).rejects.toThrow('AUTH_SIGNUP_CANONICAL_CAS_NOT_COMMITTED');
      expect(harness.bundle).toEqual({ session: null, codeVerifier: null, user: null });
      await expect(harness.compareAndSwap({
        storageKey: 'foreign-storage-key',
        expected: harness.bundle,
        next: { ...harness.bundle, user: 'foreign' },
      })).rejects.toThrow('AUTH_CANONICAL_STORAGE_KEY_MISMATCH');
    });
    it('rejects a duplicate active isolated SIGNED_IN listener publication', async () => {
      const harness = installSignupHarness();
      const gate = createDeferred<boolean>();
      const session = createSignupSession('duplicate-listener-owner');
      context.fetchSpy.mockResolvedValue(signupResponse(session));
      const signUp = harness.signUp('duplicate-listener-owner', () => true, () => gate.promise);

      await vi.waitFor(() => expect(harness.clients[0]?.listenerCalls).toBe(1));
      const listener = harness.clients[0]!.capturedListener!;
      await expect(listener('SIGNED_IN', session)).rejects.toThrow('AUTH_SIGNUP_SIGNED_IN_DUPLICATE');
      gate.resolve(true);
      await expect(signUp).resolves.toMatchObject({ error: null });
    });

    it('settles reverse-order signup responses in request order and preserves the first commit', async () => {
      const harness = installSignupHarness();
      const responseA = createDeferred<Response>();
      const responseB = createDeferred<Response>();
      context.fetchSpy
        .mockImplementationOnce(() => responseA.promise)
        .mockImplementationOnce(() => responseB.promise);
      const signUpA = harness.signUp('owner-a');
      await vi.waitFor(() => expect(harness.clients).toHaveLength(1));
      const signUpB = harness.signUp('owner-b');
      await vi.waitFor(() => expect(context.fetchSpy).toHaveBeenCalledTimes(2));

      responseB.resolve(signupResponse(createSignupSession('owner-b')));
      await Promise.resolve();
      expect(harness.compareAndSwap).not.toHaveBeenCalled();
      responseA.resolve(signupResponse(createSignupSession('owner-a')));
      const settled = await Promise.allSettled([signUpA, signUpB]);

      expect(settled[0]?.status).toBe('fulfilled');
      expect(settled[1]).toMatchObject({ status: 'rejected' });
      expect(JSON.parse(harness.bundle.session ?? '{}')).toMatchObject({
        access_token: 'signup-token-owner-a',
      });
    });

    it('rejects a duplicate response token cohort before any session write or listener apply', async () => {
      const harness = installSignupHarness();
      const shared = createSignupSession('owner-a', 'shared-signup-token');
      const responseA = createDeferred<Response>();
      const responseB = createDeferred<Response>();
      context.fetchSpy
        .mockImplementationOnce(() => responseA.promise)
        .mockImplementationOnce(() => responseB.promise);
      const signUpA = harness.signUp('owner-a');
      await vi.waitFor(() => expect(harness.clients).toHaveLength(1));
      const signUpB = harness.signUp('owner-b');
      await vi.waitFor(() => expect(context.fetchSpy).toHaveBeenCalledTimes(2));
      expect(context.createClientMock).toHaveBeenCalledTimes(2);
      expect(harness.clients).toHaveLength(2);

      responseA.resolve(signupResponse(shared));
      responseB.resolve(signupResponse({ ...shared, user: { id: 'owner-b', email: 'owner-b@example.com' } }));
      const settled = await Promise.allSettled([signUpA, signUpB]);

      expect(settled).toEqual([
        expect.objectContaining({ status: 'rejected' }),
        expect.objectContaining({ status: 'rejected' }),
      ]);
      expect(harness.clients.map(client => client.sessionWrites)).toEqual([0, 0]);
      expect(harness.clients.map(client => client.listenerCalls)).toEqual([0, 0]);
      expect(harness.compareAndSwap).not.toHaveBeenCalled();
      expect(harness.bundle).toEqual({ session: null, codeVerifier: null, user: null });
    });
    it('times out a stalled response body and fences its late completion', async () => {
      vi.useFakeTimers();
      const harness = installSignupHarness();
      const body = createDeferred<ArrayBuffer>();
      const response = new Response(null, { status: 200 });
      vi.spyOn(response, 'arrayBuffer').mockReturnValue(body.promise);
      context.fetchSpy.mockResolvedValue(response);
      const signUp = harness.signUp('owner-a');
      const rejection = expect(signUp).rejects.toThrow('AUTH_SIGNUP_DEADLINE_EXCEEDED');
      await vi.advanceTimersByTimeAsync(15_000);
      await rejection;
      body.resolve(new TextEncoder().encode(JSON.stringify(createSignupSession('owner-a'))).buffer);
      await Promise.resolve();
      expect(harness.clients[0]?.sessionWrites).toBe(0);
      expect(harness.clients[0]?.listenerCalls).toBe(0);
      expect(harness.compareAndSwap).not.toHaveBeenCalled();
    });
    it.each(['CAS', 'readback', 'afterSessionCommit', 'cleanup'] as const)('bounds stalled %s and rolls back the candidate', async stage => {
      vi.useFakeTimers(); const harness = installSignupHarness();
      const gate = createDeferred<SignupBundle | boolean | void>();
      const original = harness.compareAndSwap.getMockImplementation()!;
      if (stage === 'CAS') harness.compareAndSwap.mockImplementation(async (...args) => { await gate.promise; return original(...args); });
      if (stage === 'readback') harness.readBundle.mockReturnValue(gate.promise as Promise<SignupBundle>);
      context.fetchSpy.mockResolvedValue(signupResponse(createSignupSession('owner-a')));
      const signUp = stage === 'afterSessionCommit'
        ? harness.signUp('owner-a', () => true, () => gate.promise as Promise<boolean>) : harness.signUp('owner-a');
      if (stage === 'cleanup') {
        await vi.waitFor(() => expect(harness.clients).toHaveLength(1));
        harness.clients[0]!.dispose.mockImplementation(() => gate.promise as Promise<void>);
      }
      await vi.waitFor(() => expect(harness.compareAndSwap).toHaveBeenCalledOnce());
      const rejection = stage === 'cleanup'
        ? expect(signUp).resolves.toMatchObject({ error: null })
        : expect(signUp).rejects.toThrow('AUTH_SIGNUP_DEADLINE_EXCEEDED');
      await vi.advanceTimersByTimeAsync(15_000); await rejection;
      if (stage === 'cleanup') expect(harness.bundle.session).toContain('signup-token-owner-a');
      else expect(harness.bundle).toEqual({ session: null, codeVerifier: null, user: null });
      gate.resolve(stage === 'readback' ? { ...harness.bundle } : stage === 'afterSessionCommit' ? true : undefined);
      await Promise.resolve();
    });
    it('rejects listener token mismatch without canonical mutation', async () => {
      const harness = installSignupHarness({
        listenerSession: session => ({ ...session, access_token: 'listener-token-b' }),
      });
      context.fetchSpy.mockResolvedValue(signupResponse(createSignupSession('owner-a')));

      await expect(harness.signUp('owner-a')).rejects.toThrow('AUTH_SIGNUP_LISTENER_TOKEN_MISMATCH');
      expect(harness.compareAndSwap).not.toHaveBeenCalled();
      expect(harness.bundle).toEqual({ session: null, codeVerifier: null, user: null });
    });

    it.each([
      ['different owner B', createSignupSession('owner-b')],
      ['same owner newer B', createSignupSession('owner-a', 'signup-token-owner-a-newer')],
    ])('preserves canonical %s against isolated A', async (_label, current) => {
      const raw = JSON.stringify(current);
      const initial = { session: raw, codeVerifier: 'verifier-b', user: JSON.stringify(current.user) };
      const harness = installSignupHarness({ initialBundle: initial });
      context.fetchSpy.mockResolvedValue(signupResponse(createSignupSession('owner-a')));

      await expect(harness.signUp('owner-a')).rejects.toThrow('AUTH_SIGNUP_CANONICAL_CONFLICT');

      expect(harness.bundle).toEqual(initial);
      expect(harness.compareAndSwap).not.toHaveBeenCalled();
    });

    it('transfers only the exact confirmation verifier while preserving the canonical session and user', async () => {
      const current = createSignupSession('owner-b');
      const initial = { session: JSON.stringify(current), codeVerifier: null,
        user: JSON.stringify(current.user) };
      const harness = installSignupHarness({ initialBundle: initial });
      context.fetchSpy.mockResolvedValue(confirmationResponse('owner-a', 'owner-a@example.com'));

      const result = await harness.signUp('owner-a');

      expect(result.data.session).toBeNull();
      expect(harness.bundle).toEqual({
        ...initial,
        codeVerifier: JSON.stringify('signup-verifier-0/signup'),
      });
      expect(harness.compareAndSwap).toHaveBeenCalledOnce();
    });

    it('rejects terminal adapter writes and stale listener callbacks after cleanup', async () => {
      const harness = installSignupHarness();
      const session = createSignupSession('owner-a');
      context.fetchSpy.mockResolvedValue(signupResponse(session));

      await harness.signUp('owner-a');
      const client = harness.clients[0]!;

      await expect(client.options.auth.storage.setItem(
        client.options.auth.storageKey,
        JSON.stringify(session),
      )).rejects.toThrow('AUTH_SIGNUP_ATTEMPT_TERMINAL');
      await expect(client.capturedListener?.('SIGNED_IN', session))
        .rejects.toThrow('AUTH_SIGNUP_ATTEMPT_TERMINAL');
      expect(client.listener).toBeNull();
      expect(client.unsubscribe).toHaveBeenCalledOnce();
      expect(client.dispose).toHaveBeenCalledOnce();
      expect(client.removeAllChannels).toHaveBeenCalledOnce();
    });

    it.each([
      ['authority', () => delete (globalThis as Record<string, unknown>)['__NANOFLOW_AUTH_CANONICAL_STORAGE__']],
      ['lock', () => Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined })],
      ['storage', () => Object.defineProperty(globalThis, 'sessionStorage', {
        configurable: true, value: undefined,
      })],
    ])('fails closed before client construction when %s is unavailable', async (_label, removePrerequisite) => {
      const mutable = context.service as unknown as {
        canInitialize: boolean;
        supabaseUrl: string;
        supabaseAnonKey: string;
        signUpIsolated: SupabaseClientService['signUpIsolated'];
      };
      mutable.canInitialize = true;
      mutable.supabaseUrl = 'https://example.supabase.co';
      mutable.supabaseAnonKey = 'anon-key';
      removePrerequisite();

      await expect(mutable.signUpIsolated(
        'owner-a@example.com', 'password', 'https://nanoflow.pages.dev/auth/callback',
        () => true, async () => true,
      )).rejects.toThrow(/AUTH_SIGNUP_(AUTHORITY|LOCK|STORAGE)_UNAVAILABLE/);

      expect(context.createClientMock).not.toHaveBeenCalled();
    });
  });
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
}
