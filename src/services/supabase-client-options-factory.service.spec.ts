import { Injector } from '@angular/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LoggerService } from './logger.service';
import { SentryLazyLoaderService } from './sentry-lazy-loader.service';
import { SupabaseClientOptionsFactoryService } from './supabase-client-options-factory.service';

describe('SupabaseClientOptionsFactoryService auth storage', () => {
  const originalLocks = navigator.locks;
  const originalUrl = window.location.href;

  afterEach(() => {
    Object.defineProperty(navigator, 'locks', { configurable: true, value: originalLocks });
    window.history.replaceState(null, '', originalUrl);
    vi.unstubAllGlobals();
  });

  function createService(): SupabaseClientOptionsFactoryService {
    return Injector.create({
      providers: [
        SupabaseClientOptionsFactoryService,
        { provide: LoggerService, useValue: { category: () => ({ debug: vi.fn(), warn: vi.fn() }) } },
        { provide: SentryLazyLoaderService, useValue: { addBreadcrumb: vi.fn() } },
      ],
    }).get(SupabaseClientOptionsFactoryService);
  }

  it('uses the unique generation storage key and adapter for every auth-js write', () => {
    const storage = {
      getItem: vi.fn(),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    };
    const options = createService().buildClientOptions(
      'https://example.supabase.co',
      vi.fn(),
      { storageKey: 'generation-a', storage },
    );

    expect(options.auth.storageKey).toBe('generation-a');
    expect(options.auth.storage).toBe(storage);
    expect(options.auth).toMatchObject({
      autoRefreshToken: true,
      detectSessionInUrl: true,
      flowType: 'pkce',
      persistSession: true,
    });
  });

  it('rejects auth-js locking when Web Locks are unavailable instead of executing unlocked', async () => {
    Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined });
    const callback = vi.fn().mockResolvedValue('unsafe');
    const options = createService().buildClientOptions(
      'https://example.supabase.co',
      vi.fn(),
      { storageKey: 'generation-a', storage: localStorage },
    );

    await expect(options.auth.lock('generation-operation', 1_000, callback))
      .rejects.toThrow('AUTH_GENERATION_LOCK_UNAVAILABLE');
    expect(callback).not.toHaveBeenCalled();
  });

  it('disables primary auth URL detection on isolated recovery and callback routes only', () => {
    window.history.replaceState(null, '', '/reset-password?code=recovery-code');
    const recoveryRouteOptions = createService().buildClientOptions(
      'https://example.supabase.co',
      vi.fn(),
      { storageKey: 'generation-a', storage: localStorage },
    );

    window.history.replaceState(null, '', '/auth/callback?code=signup-code');
    const callbackRouteOptions = createService().buildClientOptions(
      'https://example.supabase.co',
      vi.fn(),
      { storageKey: 'generation-b', storage: localStorage },
    );

    window.history.replaceState(null, '', '/#/auth/callback');
    const scrubbedCallbackRouteOptions = createService().buildClientOptions(
      'https://example.supabase.co',
      vi.fn(),
      { storageKey: 'generation-b2', storage: localStorage },
    );

    window.history.replaceState(null, '', '/projects');
    const ordinaryRouteOptions = createService().buildClientOptions(
      'https://example.supabase.co',
      vi.fn(),
      { storageKey: 'generation-c', storage: localStorage },
    );

    expect(recoveryRouteOptions.auth.detectSessionInUrl).toBe(false);
    expect(callbackRouteOptions.auth.detectSessionInUrl).toBe(false);
    expect(scrubbedCallbackRouteOptions.auth.detectSessionInUrl).toBe(false);
    expect(ordinaryRouteOptions.auth.detectSessionInUrl).toBe(true);
  });

  it('builds an isolated PKCE client that never detects the recovery URL automatically', () => {
    const storage = {
      getItem: vi.fn(),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    };

    const options = createService().buildPasswordRecoveryClientOptions(
      'recovery-attempt-a',
      storage,
    );

    expect(options.auth).toMatchObject({
      autoRefreshToken: false,
      detectSessionInUrl: false,
      flowType: 'pkce',
      persistSession: true,
      storage,
      storageKey: 'recovery-attempt-a',
    });
  });

  it('builds an isolated callback client without primary URL detection or refresh', () => {
    const options = createService().buildAuthCallbackClientOptions('callback-attempt-a');

    expect(options.auth).toMatchObject({
      autoRefreshToken: false,
      detectSessionInUrl: false,
      flowType: 'pkce',
      persistSession: false,
      skipAutoInitialize: true,
      storageKey: 'callback-attempt-a',
    });
    expect('storage' in options.auth).toBe(false);
  });

  it('builds fully explicit isolated signup options around the guarded attempt storage', () => {
    const storage = {
      getItem: vi.fn(),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    };
    const requestFetch = vi.fn();
    const options = createService().buildSignupClientOptions(
      'signup-attempt-a',
      storage,
      requestFetch,
    );

    expect(options.auth).toMatchObject({
      autoRefreshToken: false,
      detectSessionInUrl: false,
      flowType: 'pkce',
      persistSession: true,
      skipAutoInitialize: true,
      storage,
      storageKey: 'signup-attempt-a',
    });
    expect(options.global.fetch).toBe(requestFetch);
  });

  it('reads a primary adoption candidate without initialization, refresh, writes, or token posts', async () => {
    const { createClient } = await vi.importActual<typeof import('@supabase/supabase-js')>(
      '@supabase/supabase-js',
    );
    const openedChannels: string[] = [];
    const closedChannels: string[] = [];
    const postedPayloads: unknown[] = [];
    class ObservedBroadcastChannel {
      constructor(readonly name: string) { openedChannels.push(name); }
      addEventListener(): void {}
      removeEventListener(): void {}
      close(): void { closedChannels.push(this.name); }
      postMessage(payload: unknown): void { postedPayloads.push(payload); }
    }
    vi.stubGlobal('BroadcastChannel', ObservedBroadcastChannel);
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: { request: async (_name: string, _options: unknown, callback: () => unknown) => callback() },
    });
    const encode = (value: object) => btoa(JSON.stringify(value))
      .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
    const accessToken = `${encode({ alg: 'none', typ: 'JWT' })}.${encode({
      sub: 'signup-owner-a', exp: Math.floor(Date.now() / 1_000) + 3_600,
    })}.c2ln`;
    const user = {
      id: 'signup-owner-a', aud: 'authenticated', role: 'authenticated',
      email: 'signup-owner-a@example.test', app_metadata: {}, user_metadata: {}, identities: [],
      created_at: new Date().toISOString(),
    };
    const storageKey = 'primary-adoption-candidate-a';
    const values = new Map([[storageKey, JSON.stringify({
      access_token: accessToken, refresh_token: 'signup-refresh-a',
      expires_at: Math.floor(Date.now() / 1_000) + 3_600, user,
    })]]);
    const storage = {
      getItem: vi.fn(async (key: string) => values.get(key) ?? null),
      setItem: vi.fn(async () => undefined),
      removeItem: vi.fn(async () => undefined),
    };
    const options = createService().buildSignupAdoptionClientOptions(storageKey, storage);
    const transport = vi.fn();
    const client = createClient('https://example.supabase.co', 'anon-key', {
      ...options, global: { fetch: transport },
    });

    const result = await client.auth.getSession();
    await client.auth.dispose();
    await client.removeAllChannels();

    expect(result.error).toBeNull();
    expect(result.data.session).toMatchObject({ access_token: accessToken, user: { id: user.id } });
    expect(options.auth).toMatchObject({
      autoRefreshToken: false, detectSessionInUrl: false, persistSession: true,
      skipAutoInitialize: true, storage, storageKey,
    });
    expect(openedChannels).toEqual([storageKey]);
    expect(closedChannels).toEqual([storageKey]);
    expect(postedPayloads).toEqual([]);
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(storage.removeItem).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
  });

  it('runs public signup on only the unique attempt storage and closes its auth channel', async () => {
    const { createClient } = await vi.importActual<typeof import('@supabase/supabase-js')>(
      '@supabase/supabase-js',
    );
    const openedChannels: string[] = [];
    const closedChannels: string[] = [];
    const postedPayloads: unknown[] = [];
    class ObservedBroadcastChannel {
      constructor(readonly name: string) {
        openedChannels.push(name);
      }

      addEventListener(): void {}
      removeEventListener(): void {}
      close(): void {
        closedChannels.push(this.name);
      }
      postMessage(payload: unknown): void {
        postedPayloads.push(payload);
      }
    }
    vi.stubGlobal('BroadcastChannel', ObservedBroadcastChannel);
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: {
        request: async (_name: string, _options: unknown, callback: () => unknown) => callback(),
      },
    });
    const attemptKey = 'signup-attempt-runtime-a';
    const primaryKey = 'sb-example-auth-token';
    const primaryRaw = JSON.stringify({
      access_token: 'primary-token-b',
      refresh_token: 'primary-refresh-b',
      user: { id: 'owner-b' },
    });
    localStorage.setItem(primaryKey, primaryRaw);
    const attemptValues = new Map<string, string>();
    const storage = {
      getItem: vi.fn((key: string) => attemptValues.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => {
        expect([attemptKey, `${attemptKey}-code-verifier`, `${attemptKey}-user`]).toContain(key);
        attemptValues.set(key, value);
      }),
      removeItem: vi.fn((key: string) => { attemptValues.delete(key); }),
    };
    const encode = (value: object) => btoa(JSON.stringify(value))
      .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
    const accessToken = `${encode({ alg: 'none', typ: 'JWT' })}.${encode({
      sub: 'signup-owner-a',
      exp: Math.floor(Date.now() / 1_000) + 3_600,
    })}.c2ln`;
    const user = {
      id: 'signup-owner-a',
      aud: 'authenticated',
      role: 'authenticated',
      email: 'signup-owner-a@example.test',
      app_metadata: {},
      user_metadata: {},
      identities: [],
      created_at: new Date().toISOString(),
    };
    const requestFetch = vi.fn(async () => new Response(JSON.stringify({
      access_token: accessToken,
      refresh_token: 'signup-refresh-a',
      expires_in: 3_600,
      token_type: 'bearer',
      user,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const options = createService().buildSignupClientOptions(attemptKey, storage, requestFetch);
    const client = createClient('https://example.supabase.co', 'anon-key', options);

    try {
      const result = await client.auth.signUp({
        email: 'signup-owner-a@example.test',
        password: 'password-123',
        options: { emailRedirectTo: 'https://nanoflow.pages.dev/auth/callback' },
      });

      expect(result.error).toBeNull();
      expect(result.data.session?.user.id).toBe('signup-owner-a');
      expect(requestFetch).toHaveBeenCalledOnce();
      expect(localStorage.getItem(primaryKey)).toBe(primaryRaw);
      expect(openedChannels).toEqual([attemptKey]);
      expect(postedPayloads).toHaveLength(1);
      expect(storage.setItem).toHaveBeenCalledWith(attemptKey, expect.stringContaining(accessToken));
    } finally {
      await client.auth.dispose();
      await client.removeAllChannels();
      localStorage.removeItem(primaryKey);
    }

    expect(closedChannels).toEqual([attemptKey]);
  });

  it('uses the public non-persistent callback client without broadcasting or adapter token writes', async () => {
    const { createClient } = await vi.importActual<typeof import('@supabase/supabase-js')>(
      '@supabase/supabase-js',
    );
    const openedChannels: string[] = [];
    const postedPayloads: unknown[] = [];
    class ObservedBroadcastChannel {
      constructor(readonly name: string) {
        openedChannels.push(name);
      }

      addEventListener(): void {}
      close(): void {}
      postMessage(payload: unknown): void {
        postedPayloads.push(payload);
      }
    }
    vi.stubGlobal('BroadcastChannel', ObservedBroadcastChannel);
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: {
        request: async (_name: string, _options: unknown, callback: () => unknown) => callback(),
      },
    });
    const storage = {
      getItem: vi.fn().mockReturnValue(null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    };
    const options = createService().buildAuthCallbackClientOptions('callback-attempt-runtime-a');
    const encode = (value: object) => btoa(JSON.stringify(value))
      .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
    const accessToken = `${encode({ alg: 'none', typ: 'JWT' })}.${encode({
      sub: 'owner-a',
      exp: Math.floor(Date.now() / 1_000) + 3_600,
    })}.c2ln`;
    const user = {
      id: 'owner-a',
      aud: 'authenticated',
      role: 'authenticated',
      email: 'owner-a@example.test',
      app_metadata: {},
      user_metadata: {},
      identities: [],
      created_at: new Date().toISOString(),
    };
    const client = createClient('https://example.supabase.co', 'anon-key', {
      ...options,
      global: {
        fetch: vi.fn(async () => new Response(JSON.stringify({ user }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })),
      },
    });

    const result = await client.auth.setSession({
      access_token: accessToken,
      refresh_token: 'runtime-refresh-token-a',
    });
    await client.auth.dispose();
    await client.removeAllChannels();

    expect(result.error).toBeNull();
    expect(result.data.session?.user.id).toBe('owner-a');
    expect(options.auth.persistSession).toBe(false);
    expect(openedChannels).toEqual([]);
    expect(postedPayloads).toEqual([]);
    expect(storage.getItem).not.toHaveBeenCalled();
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(storage.removeItem).not.toHaveBeenCalled();
  });

  it('characterizes public non-persistent PKCE exchange as unable to read custom verifier storage', async () => {
    const { createClient } = await vi.importActual<typeof import('@supabase/supabase-js')>(
      '@supabase/supabase-js',
    );
    const openedChannels: string[] = [];
    class ObservedBroadcastChannel {
      constructor(readonly name: string) {
        openedChannels.push(name);
      }

      addEventListener(): void {}
      close(): void {}
      postMessage(): void {}
    }
    vi.stubGlobal('BroadcastChannel', ObservedBroadcastChannel);
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: {
        request: async (_name: string, _options: unknown, callback: () => unknown) => callback(),
      },
    });
    const storage = {
      getItem: vi.fn().mockReturnValue(JSON.stringify('transferred-verifier-a')),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    };
    const options = createService().buildAuthCallbackClientOptions('callback-attempt-exchange-a');
    const transport = vi.fn();
    const client = createClient('https://example.supabase.co', 'anon-key', {
      ...options,
      auth: { ...options.auth, storage },
      global: { fetch: transport },
    });

    const result = await client.auth.exchangeCodeForSession('callback-code-a');
    await client.auth.dispose();
    await client.removeAllChannels();

    expect(result.error?.name).toBe('AuthPKCECodeVerifierMissingError');
    expect(storage.getItem).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
    expect(openedChannels).toEqual([]);
  });

  it('scopes password recovery storage to one exact SDK triplet', async () => {
    const storage = {
      getItem: vi.fn().mockReturnValue('stored'),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    };
    const adapter = createService().buildPasswordRecoveryStorage(
      'recovery-attempt-a',
      storage,
    );

    expect(await adapter.getItem('recovery-attempt-a-code-verifier')).toBe('stored');
    await adapter.setItem('recovery-attempt-a-user', 'user');
    await adapter.removeItem('recovery-attempt-a');
    expect(() => adapter.setItem('canonical-auth-key', 'forbidden'))
      .toThrow('AUTH_RECOVERY_STORAGE_KEY_REJECTED');
  });
});
