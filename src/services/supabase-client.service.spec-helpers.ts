import { expect, it, vi, type Mock } from 'vitest';
import { SupabaseClientService } from './supabase-client.service';
import { SupabaseAuthScopedRequestCacheController } from './supabase-auth-scoped-request-cache.controller';
import type {
  CanonicalAuthBundle,
  SupabaseAuthClientCandidate,
  CanonicalAuthGeneration,
  CanonicalAuthStorageAuthority,
} from './supabase-auth-client-lifecycle.controller';

export type ClientFetch = (url: RequestInfo | URL, options?: RequestInit) => Promise<Response>;

export type SignupBundle = {
  session: string | null;
  codeVerifier: string | null;
  user: string | null;
};

export type SignupSession = {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  user: { id: string; email: string };
};

export type SignupClientOptions = {
  auth: {
    storageKey: string;
    storage: {
      getItem(key: string): Promise<string | null> | string | null;
      setItem(key: string, value: string): Promise<void> | void;
      removeItem(key: string): Promise<void> | void;
    };
  };
  global: { fetch: ClientFetch };
};

export function signupResponse(session: SignupSession): Response {
  return new Response(JSON.stringify(session), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

interface SupabaseClientLifecycleSpecContext {
  authClientMock: {
    auth: { dispose: Mock; getSession: Mock; signOut: Mock };
    removeAllChannels: Mock;
  };
  authGeneration: CanonicalAuthGeneration;
  canonicalAuthority: CanonicalAuthStorageAuthority;
  createClientMock: Mock;
  service: SupabaseClientService;
}
interface RequestCacheBucketRaceSpecContext {
  authOptions(accessToken: string): RequestInit;
  createAuthority(read: () => CanonicalAuthBundle): CanonicalAuthStorageAuthority;
  createBundle(accessToken: string, userId: string): CanonicalAuthBundle;
  createCandidate(epoch: number): SupabaseAuthClientCandidate;
  deferred<T>(): { promise: Promise<T>; resolve(value: T): void };
  response(owner: string): Response;
  retainedEntries(controller: SupabaseAuthScopedRequestCacheController): Array<Record<string, unknown>>;
}
export function registerRequestCacheBucketRaceSpecs(context: RequestCacheBucketRaceSpecContext): void {
  const signature = 'GET:https://example.supabase.co/rest/v1/projects:';
  it.each(['delete', 'replace'] as const)(
    'keeps newer bucket registered when old lookup resumes through %s path', async path => {
      const candidateA = context.createCandidate(21);
      const bundleA = context.createBundle('bucket-access-a', 'bucket-user-a');
      let currentCandidate = candidateA;
      let currentBundle = bundleA;
      const controller = new SupabaseAuthScopedRequestCacheController({
        anonymousBearerToken: () => 'anon-bearer',
        authority: () => context.createAuthority(() => currentBundle),
        isCandidateCurrent: candidate => candidate === currentCandidate,
      });
      const inputA = { candidate: candidateA, signature, options: context.authOptions('bucket-access-a'),
        fetch: async () => context.response('old-a') };
      await controller.execute(inputA);
      const oldBucket = context.retainedEntries(controller);
      const nativeDigest = globalThis.crypto.subtle.digest.bind(globalThis.crypto.subtle);
      const digestHeld = context.deferred<void>();
      const releaseDigest = context.deferred<void>();
      let digestOrdinal = 0;
      const digest = vi.spyOn(globalThis.crypto.subtle, 'digest')
        .mockImplementation(async (algorithm, data) => {
          if (++digestOrdinal === 3) {
            digestHeld.resolve();
            await releaseDigest.promise;
            if (path === 'delete') return new Uint8Array(32).buffer;
          }
          return nativeDigest(algorithm, data);
        });
      try {
        const oldLookup = controller.execute({ ...inputA,
          fetch: vi.fn(async () => context.response('old-lookup')) });
        await digestHeld.promise;
        controller.reset();
        currentCandidate = context.createCandidate(22);
        currentBundle = context.createBundle('bucket-access-a2', 'bucket-user-a');
        const pendingA2 = context.deferred<Response>();
        const fetchA2 = vi.fn(() => pendingA2.promise);
        const requestA2 = controller.execute({ candidate: currentCandidate, signature,
          options: context.authOptions('bucket-access-a2'), fetch: fetchA2 });
        await vi.waitFor(() => expect(context.retainedEntries(controller)[0]?.['kind']).toBe('pending'));
        const bucketA2 = context.retainedEntries(controller);
        const entryA2 = bucketA2[0];
        expect(bucketA2 === oldBucket).toBe(false);
        releaseDigest.resolve();
        await oldLookup;
        expect(context.retainedEntries(controller)[0] === entryA2).toBe(true);
        pendingA2.resolve(context.response('new-a2'));
        await requestA2;
        await controller.execute({ candidate: currentCandidate, signature,
          options: context.authOptions('bucket-access-a2'), fetch: fetchA2 });
        expect(fetchA2).toHaveBeenCalledTimes(1);
      } finally {
        releaseDigest.resolve();
        digest.mockRestore();
      }
    },
  );
}
export function registerSupabaseClientLifecycleSpecs(
  getContext: () => SupabaseClientLifecycleSpecContext,
): void {
  it('authorizeSignupAdoption still removes channels and preserves decision when auth.dispose throws synchronously', async () => {
    const { authClientMock, canonicalAuthority, service } = getContext();
    const mutable = service as unknown as {
      canInitialize: boolean;
      supabaseUrl: string;
      supabaseAnonKey: string;
    };
    mutable.canInitialize = true;
    mutable.supabaseUrl = 'https://example.supabase.co';
    mutable.supabaseAnonKey = 'anon-key';
    const dispose = vi.fn(() => {
      throw new Error('auth dispose failed');
    });
    const removeAllChannels = vi.fn().mockResolvedValue([]);
    vi.mocked(authClientMock.auth.dispose).mockImplementation(dispose);
    vi.mocked(authClientMock.removeAllChannels).mockImplementation(removeAllChannels);
    authClientMock.auth.getSession.mockResolvedValueOnce({
      data: { session: { access_token: 'expected-token', user: { id: 'user-1', email: 'user@example.com' } } },
      error: null,
    });

    await expect(service.authorizeSignupAdoption(
      { access_token: 'expected-token', user: { id: 'user-1', email: 'user@example.com' } },
      () => true,
    )).resolves.toBe(true);
    expect(removeAllChannels).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('authorizeSignupAdoption still disposes auth and preserves decision when removeAllChannels throws synchronously', async () => {
    const { authClientMock, canonicalAuthority, service } = getContext();
    const mutable = service as unknown as {
      canInitialize: boolean;
      supabaseUrl: string;
      supabaseAnonKey: string;
    };
    mutable.canInitialize = true;
    mutable.supabaseUrl = 'https://example.supabase.co';
    mutable.supabaseAnonKey = 'anon-key';
    const dispose = vi.fn().mockResolvedValue(undefined);
    const removeAllChannels = vi.fn(() => {
      throw new Error('removeAllChannels failed');
    });
    vi.mocked(authClientMock.auth.dispose).mockImplementation(dispose);
    vi.mocked(authClientMock.removeAllChannels).mockImplementation(removeAllChannels);
    authClientMock.auth.getSession.mockResolvedValueOnce({
      data: { session: { access_token: 'expected-token', user: { id: 'user-1', email: 'user@example.com' } } },
      error: null,
    });

    await expect(service.authorizeSignupAdoption(
      { access_token: 'expected-token', user: { id: 'user-1', email: 'user@example.com' } },
      () => true,
    )).resolves.toBe(true);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(removeAllChannels).toHaveBeenCalledTimes(1);
  });

  it('authorizeSignupAdoption absorbs async cleanup rejection and preserves decision', async () => {
    const { authClientMock, canonicalAuthority, service } = getContext();
    const mutable = service as unknown as {
      canInitialize: boolean;
      supabaseUrl: string;
      supabaseAnonKey: string;
    };
    mutable.canInitialize = true;
    mutable.supabaseUrl = 'https://example.supabase.co';
    mutable.supabaseAnonKey = 'anon-key';
    authClientMock.auth.dispose.mockRejectedValueOnce(new Error('async auth dispose failed'));
    authClientMock.removeAllChannels.mockRejectedValueOnce(new Error('async channels failed'));
    authClientMock.auth.getSession.mockResolvedValueOnce({
      data: { session: { access_token: 'expected-token', user: { id: 'user-1', email: 'user@example.com' } } },
      error: null,
    });

    await expect(service.authorizeSignupAdoption(
      { access_token: 'expected-token', user: { id: 'user-1', email: 'user@example.com' } },
      () => true,
    )).resolves.toBe(true);
    expect(authClientMock.auth.dispose).toHaveBeenCalledTimes(1);
    expect(authClientMock.removeAllChannels).toHaveBeenCalledTimes(1);
  });

  it('hydrates and promotes a unique auth generation before publishing the client', async () => {
    const { authClientMock, authGeneration, canonicalAuthority, createClientMock, service } = getContext();
    const mutable = service as unknown as {
      canInitialize: boolean;
      supabaseUrl: string;
      supabaseAnonKey: string;
    };
    mutable.canInitialize = true;
    mutable.supabaseUrl = 'https://example.supabase.co';
    mutable.supabaseAnonKey = 'anon-key';

    const client = await service.clientAsync();
    const options = createClientMock.mock.calls.at(-1)?.[2] as {
      auth: { storageKey: string; storage: unknown };
    };

    expect(client).toBe(authClientMock);
    expect(canonicalAuthority.createGeneration).toHaveBeenCalledWith('sb-example-auth-token');
    expect(options.auth.storageKey).toBe(authGeneration.storageKey);
    expect(options.auth.storage).toBe(authGeneration.storage);
    expect(authClientMock.auth.getSession).toHaveBeenCalled();
    expect(authGeneration.promote).toHaveBeenCalledTimes(1);
  });

  it('retires pending A on reset and old settlement cannot clear or replace promoted B', async () => {
    const { authClientMock, authGeneration, canonicalAuthority, service } = getContext();
    let resolveA!: (generation: CanonicalAuthGeneration) => void;
    const generationA = {
      ...authGeneration,
      retire: vi.fn(),
      promote: vi.fn().mockResolvedValue('noop'),
    };
    const generationB = {
      ...authGeneration,
      storageKey: 'sb-example-auth-token-nanoflow-g-b',
      retire: vi.fn(),
      promote: vi.fn().mockResolvedValue('noop'),
    };
    vi.mocked(canonicalAuthority.createGeneration)
      .mockImplementationOnce(() => new Promise(resolve => { resolveA = resolve; }))
      .mockResolvedValueOnce(generationB);
    const mutable = service as unknown as {
      canInitialize: boolean;
      supabaseUrl: string;
      supabaseAnonKey: string;
    };
    mutable.canInitialize = true;
    mutable.supabaseUrl = 'https://example.supabase.co';
    mutable.supabaseAnonKey = 'anon-key';

    const pendingA = service.clientAsync();
    service.reset();
    const pendingB = service.clientAsync();
    resolveA(generationA);

    await expect(pendingA).resolves.toBeNull();
    await expect(pendingB).resolves.toBe(authClientMock);
    expect(generationA.retire).toHaveBeenCalledTimes(1);
    expect(generationB.promote).toHaveBeenCalledTimes(1);
    expect(service.client()).toBe(authClientMock);
  });

  it('keeps promoted B when stale A initialization rejects after reset', async () => {
    const { authClientMock, authGeneration, canonicalAuthority, createClientMock, service } = getContext();
    let rejectA!: (error: Error) => void;
    const generationA = { ...authGeneration, retire: vi.fn() };
    const generationB = {
      ...authGeneration,
      storageKey: 'sb-example-auth-token-nanoflow-g-b',
      retire: vi.fn(),
    };
    const clientA = {
      auth: {
        ...authClientMock.auth,
        dispose: vi.fn().mockResolvedValue(undefined),
        getSession: vi.fn().mockReturnValue(new Promise((_resolve, reject) => { rejectA = reject; })),
      },
      removeAllChannels: vi.fn().mockResolvedValue([]),
    };
    vi.mocked(canonicalAuthority.createGeneration)
      .mockResolvedValueOnce(generationA)
      .mockResolvedValueOnce(generationB);
    createClientMock.mockReturnValueOnce(clientA).mockReturnValueOnce(authClientMock);
    const mutable = service as unknown as {
      canInitialize: boolean;
      supabaseUrl: string;
      supabaseAnonKey: string;
    };
    mutable.canInitialize = true;
    mutable.supabaseUrl = 'https://example.supabase.co';
    mutable.supabaseAnonKey = 'anon-key';

    const pendingA = service.clientAsync();
    await vi.waitFor(() => expect(clientA.auth.getSession).toHaveBeenCalledTimes(1));
    service.reset();
    const pendingB = service.clientAsync();
    await expect(pendingB).resolves.toBe(authClientMock);
    rejectA(new Error('stale A failed'));

    await expect(pendingA).resolves.toBeNull();
    expect(service.client()).toBe(authClientMock);
    expect(clientA.auth.dispose).toHaveBeenCalledTimes(1);
    expect(clientA.removeAllChannels).toHaveBeenCalledTimes(1);
  });

  it('does not publish A when its promotion settles after reset and promoted B', async () => {
    const { authClientMock, authGeneration, canonicalAuthority, createClientMock, service } = getContext();
    let resolvePromotionA!: (promoted: boolean) => void;
    const promotionA = new Promise<boolean>(resolve => { resolvePromotionA = resolve; });
    const generationA = { ...authGeneration, retire: vi.fn() };
    const generationB = {
      ...authGeneration,
      storageKey: 'sb-example-auth-token-nanoflow-g-b',
      retire: vi.fn(),
    };
    const clientA = {
      auth: {
        ...authClientMock.auth,
        dispose: vi.fn().mockRejectedValue(new Error('stale A auth dispose failed')),
        getSession: vi.fn().mockResolvedValue({ data: { session: null }, error: null }),
      },
      removeAllChannels: vi.fn().mockRejectedValue(new Error('stale A realtime dispose failed')),
    };
    const clientB = {
      auth: { ...authClientMock.auth },
      removeAllChannels: vi.fn().mockResolvedValue([]),
    };
    vi.mocked(canonicalAuthority.createGeneration)
      .mockResolvedValueOnce(generationA)
      .mockResolvedValueOnce(generationB);
    createClientMock.mockReturnValueOnce(clientA).mockReturnValueOnce(clientB);
    const lifecycle = (service as unknown as {
      authClientLifecycle: {
        promote(candidate: SupabaseAuthClientCandidate): Promise<boolean>;
      };
    }).authClientLifecycle;
    const promote = lifecycle.promote.bind(lifecycle);
    vi.spyOn(lifecycle, 'promote')
      .mockImplementationOnce(() => promotionA)
      .mockImplementation(candidate => promote(candidate));
    const mutable = service as unknown as {
      canInitialize: boolean;
      supabaseUrl: string;
      supabaseAnonKey: string;
    };
    mutable.canInitialize = true;
    mutable.supabaseUrl = 'https://example.supabase.co';
    mutable.supabaseAnonKey = 'anon-key';

    const pendingA = service.clientAsync();
    await vi.waitFor(() => expect(clientA.auth.getSession).toHaveBeenCalledTimes(1));
    service.reset();
    const pendingB = service.clientAsync();
    await expect(pendingB).resolves.toBe(clientB);
    resolvePromotionA(true);

    await expect(pendingA).resolves.toBeNull();
    expect(service.client()).toBe(clientB);
    expect(clientA.auth.dispose).toHaveBeenCalledTimes(1);
    expect(clientA.removeAllChannels).toHaveBeenCalledTimes(1);
    expect(clientB.auth.dispose).not.toHaveBeenCalled();
    expect(clientB.removeAllChannels).not.toHaveBeenCalled();
  });

  it('disposes the current auth subscriber, BroadcastChannel, and realtime channels on reset', async () => {
    const { authClientMock, service } = getContext();
    const mutable = service as unknown as {
      canInitialize: boolean;
      supabaseUrl: string;
      supabaseAnonKey: string;
    };
    mutable.canInitialize = true;
    mutable.supabaseUrl = 'https://example.supabase.co';
    mutable.supabaseAnonKey = 'anon-key';
    await service.clientAsync();

    service.reset();

    expect(authClientMock.auth.dispose).toHaveBeenCalledTimes(1);
    expect(authClientMock.removeAllChannels).toHaveBeenCalledTimes(1);
  });

  it('does not construct an authenticated client when the canonical authority is missing', async () => {
    const { createClientMock, service } = getContext();
    delete (globalThis as Record<string, unknown>)['__NANOFLOW_AUTH_CANONICAL_STORAGE__'];
    const mutable = service as unknown as {
      canInitialize: boolean;
      supabaseUrl: string;
      supabaseAnonKey: string;
    };
    mutable.canInitialize = true;
    mutable.supabaseUrl = 'https://example.supabase.co';
    mutable.supabaseAnonKey = 'anon-key';

    await expect(service.clientAsync()).resolves.toBeNull();
    expect(createClientMock).not.toHaveBeenCalled();
  });

  it('holds replacement client publication while the retired client signOut is pending', async () => {
    const { authClientMock, authGeneration, canonicalAuthority, service } = getContext();
    const replacement = {
      ...authGeneration,
      storageKey: 'sb-example-auth-token-nanoflow-g-replacement',
      retire: vi.fn(),
      promote: vi.fn().mockResolvedValue('noop'),
    };
    vi.mocked(canonicalAuthority.createGeneration)
      .mockResolvedValueOnce(authGeneration)
      .mockResolvedValueOnce(replacement);
    const mutable = service as unknown as {
      canInitialize: boolean;
      supabaseUrl: string;
      supabaseAnonKey: string;
    };
    mutable.canInitialize = true;
    mutable.supabaseUrl = 'https://example.supabase.co';
    mutable.supabaseAnonKey = 'anon-key';
    await service.clientAsync();
    let resolveSignOut!: () => void;
    authClientMock.auth.signOut.mockReturnValueOnce(new Promise<void>(resolve => {
      resolveSignOut = resolve;
    }));

    const signOut = service.signOut();
    await vi.waitFor(() => expect(authClientMock.auth.signOut).toHaveBeenCalledTimes(1));
    service.reset();
    const replacementClient = service.clientAsync();
    await vi.waitFor(() => expect(canonicalAuthority.createGeneration).toHaveBeenCalledTimes(2));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(replacement.promote).not.toHaveBeenCalled();

    resolveSignOut();
    await signOut;
    await expect(replacementClient).resolves.toBe(authClientMock);
    expect(replacement.promote).toHaveBeenCalledTimes(1);
  });

  it('does not reuse a completed A response after reset promotes different-owner B', async () => {
    const { authClientMock, authGeneration, canonicalAuthority, createClientMock, service } = getContext();
    const generationA = { ...authGeneration, storageKey: 'sb-example-auth-token-nanoflow-g-a' };
    const generationB = { ...authGeneration, storageKey: 'sb-example-auth-token-nanoflow-g-b' };
    const bundleA = {
      session: JSON.stringify({ access_token: 'access-a', user: { id: 'user-a' } }),
      codeVerifier: null,
      user: JSON.stringify({ id: 'user-a' }),
    };
    const bundleB = {
      session: JSON.stringify({ access_token: 'access-b', user: { id: 'user-b' } }),
      codeVerifier: null,
      user: JSON.stringify({ id: 'user-b' }),
    };
    let currentBundle = bundleA;
    vi.mocked(canonicalAuthority.createGeneration)
      .mockResolvedValueOnce(generationA)
      .mockResolvedValueOnce(generationB);
    vi.mocked(canonicalAuthority.peekBundle).mockImplementation(() => currentBundle);
    const mutable = service as unknown as {
      canInitialize: boolean;
      supabaseUrl: string;
      supabaseAnonKey: string;
    };
    mutable.canInitialize = true;
    mutable.supabaseUrl = 'https://example.supabase.co';
    mutable.supabaseAnonKey = 'anon-key';
    const networkFetch = vi.mocked(globalThis.fetch);
    networkFetch
      .mockResolvedValueOnce(new Response(JSON.stringify({ owner: 'user-a' })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ owner: 'user-b' })));

    await service.clientAsync();
    const fetchA = (createClientMock.mock.calls[0]?.[2] as {
      global: { fetch: (url: string, options: RequestInit) => Promise<Response> };
    }).global.fetch;
    await expect(fetchA('https://example.supabase.co/rest/v1/projects', {
      headers: { Authorization: 'Bearer access-a' },
    }).then(value => value.json())).resolves.toEqual({ owner: 'user-a' });

    service.reset();
    currentBundle = bundleB;
    await service.clientAsync();
    const fetchB = (createClientMock.mock.calls[1]?.[2] as {
      global: { fetch: (url: string, options: RequestInit) => Promise<Response> };
    }).global.fetch;
    await expect(fetchB('https://example.supabase.co/rest/v1/projects', {
      headers: { Authorization: 'Bearer access-b' },
    }).then(value => value.json())).resolves.toEqual({ owner: 'user-b' });
    expect(networkFetch).toHaveBeenCalledTimes(2);
    expect(authClientMock.auth.dispose).toHaveBeenCalledTimes(1);
  });
}

interface SupabaseAuthAutoRefreshSpecContext {
  authClientMock: {
    auth: {
      startAutoRefresh: Mock;
      stopAutoRefresh: Mock;
    };
  };
  flushAuthAutoRefresh(service: SupabaseClientService): Promise<void>;
  service(): SupabaseClientService;
  setNavigatorOnLine(online: boolean): void;
  setVisibilityState(state: DocumentVisibilityState): void;
}

export function registerSupabaseAuthAutoRefreshSpecs(
  context: SupabaseAuthAutoRefreshSpecContext,
): void {
  const {
    authClientMock,
    flushAuthAutoRefresh,
    setNavigatorOnLine,
    setVisibilityState,
  } = context;
  const service = () => context.service();

  it('client 初始化后应接管 Auth 自动刷新，并在可见状态下启动', async () => {
    const mutable = service() as unknown as {
      canInitialize: boolean;
      supabaseUrl: string;
      supabaseAnonKey: string;
    };
    mutable.canInitialize = true;
    mutable.supabaseUrl = 'https://example.supabase.co';
    mutable.supabaseAnonKey = 'anon-key';

    await service().clientAsync();
    await flushAuthAutoRefresh(service());

    expect(authClientMock.auth.startAutoRefresh).toHaveBeenCalledTimes(1);
    expect(authClientMock.auth.stopAutoRefresh).not.toHaveBeenCalled();
  });

  it('页面恢复时应等待浏览器网络恢复宽限期结束后再启动 Auth 自动刷新', async () => {
    vi.useFakeTimers();
    const mutable = service() as unknown as {
      canInitialize: boolean;
      supabaseUrl: string;
      supabaseAnonKey: string;
    };
    mutable.canInitialize = true;
    mutable.supabaseUrl = 'https://example.supabase.co';
    mutable.supabaseAnonKey = 'anon-key';

    await service().clientAsync();
    await Promise.resolve();

    expect(authClientMock.auth.startAutoRefresh).toHaveBeenCalledTimes(1);

    authClientMock.auth.startAutoRefresh.mockClear();
    setVisibilityState('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    await flushAuthAutoRefresh(service());

    expect(authClientMock.auth.stopAutoRefresh).toHaveBeenCalledTimes(1);

    authClientMock.auth.stopAutoRefresh.mockClear();
    setVisibilityState('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    await flushAuthAutoRefresh(service());

    expect(authClientMock.auth.stopAutoRefresh).not.toHaveBeenCalled();
    expect(authClientMock.auth.startAutoRefresh).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1499);
    expect(authClientMock.auth.startAutoRefresh).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2);
    await flushAuthAutoRefresh(service());

    expect(authClientMock.auth.startAutoRefresh).toHaveBeenCalledTimes(1);
  });

  it('网络恢复时应等待浏览器网络恢复宽限期结束后再启动 Auth 自动刷新', async () => {
    vi.useFakeTimers();
    const mutable = service() as unknown as {
      canInitialize: boolean;
      supabaseUrl: string;
      supabaseAnonKey: string;
    };
    mutable.canInitialize = true;
    mutable.supabaseUrl = 'https://example.supabase.co';
    mutable.supabaseAnonKey = 'anon-key';

    await service().clientAsync();
    await flushAuthAutoRefresh(service());

    expect(authClientMock.auth.startAutoRefresh).toHaveBeenCalledTimes(1);

    authClientMock.auth.startAutoRefresh.mockClear();
    setNavigatorOnLine(false);
    window.dispatchEvent(new Event('offline'));
    await flushAuthAutoRefresh(service());

    expect(authClientMock.auth.stopAutoRefresh).toHaveBeenCalledTimes(1);

    authClientMock.auth.stopAutoRefresh.mockClear();
    setNavigatorOnLine(true);
    window.dispatchEvent(new Event('online'));
    await flushAuthAutoRefresh(service());

    expect(authClientMock.auth.startAutoRefresh).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(4999);
    expect(authClientMock.auth.startAutoRefresh).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2);
    await flushAuthAutoRefresh(service());

    expect(authClientMock.auth.startAutoRefresh).toHaveBeenCalledTimes(1);
  });

  it('连接中断模式内初始化客户端不应启动 Auth 自动刷新', async () => {
    const mutable = service() as unknown as {
      canInitialize: boolean;
      supabaseUrl: string;
      supabaseAnonKey: string;
    };
    mutable.canInitialize = true;
    mutable.supabaseUrl = 'https://example.supabase.co';
    mutable.supabaseAnonKey = 'anon-key';
    service().isOfflineMode.set(true);

    await service().clientAsync();
    await flushAuthAutoRefresh(service());

    expect(authClientMock.auth.stopAutoRefresh).toHaveBeenCalledTimes(1);
    expect(authClientMock.auth.startAutoRefresh).not.toHaveBeenCalled();
  });
}
