import fs from 'node:fs';
import { webcrypto } from 'node:crypto';
import path from 'node:path';
import { Injector } from '@angular/core';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthService } from './auth.service';
import { AuthCallbackSessionService } from './auth-callback-session.service';
import { SupabaseClientOptionsFactoryService } from './supabase-client-options-factory.service';
import type {
  CanonicalAuthBundle,
  CanonicalAuthCallbackStorageAuthority,
} from './supabase-auth-client-lifecycle.controller';

const { createClientMock } = vi.hoisted(() => ({ createClientMock: vi.fn() }));

vi.mock('@supabase/supabase-js', async importOriginal => ({
  ...await importOriginal<typeof import('@supabase/supabase-js')>(),
  createClient: createClientMock,
}));

vi.mock('../environments/environment', async importOriginal => {
  const original = await importOriginal<typeof import('../environments/environment')>();
  return {
    ...original,
    environment: {
      ...original.environment,
      supabaseUrl: 'https://auth-callback-test.supabase.co',
      supabaseAnonKey: 'test-anon-key',
    },
  };
});

afterAll(() => {
  vi.doUnmock('@supabase/supabase-js');
  vi.resetModules();
});

const AUTHORITY_KEY = '__NANOFLOW_AUTH_CANONICAL_STORAGE__';
const CAPTURE_KEY = '__NANOFLOW_AUTH_CALLBACK_CAPTURE__';
const CLAIM_PREFIX = 'nanoflow:auth-callback:v1:claim:';

async function sha256(value: string): Promise<string> {
  return Array.from(new Uint8Array(
    await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(value)),
  ), byte => byte.toString(16).padStart(2, '0')).join('');
}

describe('AuthCallbackSessionService', () => {
  let bundle: CanonicalAuthBundle;
  let authority: CanonicalAuthCallbackStorageAuthority;
  let restartRuntime: ReturnType<typeof vi.fn>;
  let dispose: ReturnType<typeof vi.fn>;
  let removeAllChannels: ReturnType<typeof vi.fn>;
  let exchangeFetch: ReturnType<typeof vi.fn>;
  let setSession: ReturnType<typeof vi.fn>;
  let publishedEnvelope: Record<string, unknown> | null;

  beforeEach(() => {
    sessionStorage.clear();
    bundle = { session: null, codeVerifier: 'verifier-a', user: null };
    authority = {
      captureAndScrubAuthCallback: vi.fn(() => Object.freeze({
        version: 1 as const,
        blocked: false,
        capturedAt: Date.now(),
        hasAuthError: false,
        claimCode: () => null,
      })),
      claimCallbackVerifier: vi.fn(async input => {
        if (JSON.stringify(bundle) !== JSON.stringify(input.expected)) {
          throw new Error('AUTH_CANONICAL_STORAGE_MISMATCH');
        }
        const verifier = bundle.codeVerifier;
        bundle = { ...bundle, codeVerifier: input.marker };
        sessionStorage.setItem(input.claimantKey, JSON.stringify({ ...input.envelope, verifier }));
        return 'claimed' as const;
      }),
      compareAndSwap: vi.fn(async input => {
        if (JSON.stringify(bundle) !== JSON.stringify(input.expected)) {
          throw new Error('AUTH_CANONICAL_STORAGE_MISMATCH');
        }
        if (input.next.session !== null && input.next.codeVerifier === null) {
          const claimantKey = Object.keys(sessionStorage)
            .find(key => key.startsWith(CLAIM_PREFIX));
          const raw = claimantKey ? sessionStorage.getItem(claimantKey) : null;
          publishedEnvelope = raw ? JSON.parse(raw) : null;
        }
        bundle = { ...input.next };
        return 'committed' as const;
      }),
      createGeneration: vi.fn(),
      peekBundle: vi.fn(() => ({ ...bundle })),
      readBundle: vi.fn(async () => ({ ...bundle })),
      startSessionPrewarm: vi.fn(),
    };
    Object.defineProperty(globalThis, AUTHORITY_KEY, {
      configurable: true,
      value: authority,
    });
    Object.defineProperty(globalThis, CAPTURE_KEY, {
      configurable: true,
      value: Object.freeze({
        version: 1,
        blocked: false,
        capturedAt: Date.now(),
        hasAuthError: false,
        claimCode: vi.fn().mockReturnValueOnce('callback-code-a').mockReturnValue(null),
      }),
    });
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: {
        request: async (
          _name: string,
          _options: unknown,
          callback: () => unknown,
        ) => await callback(),
      },
    });
    vi.stubGlobal('crypto', webcrypto);

    restartRuntime = vi.fn().mockResolvedValue(undefined);
    dispose = vi.fn().mockResolvedValue(undefined);
    removeAllChannels = vi.fn().mockResolvedValue(undefined);
    exchangeFetch = vi.fn();
    setSession = vi.fn();
    publishedEnvelope = null;
    createClientMock.mockReset();
  });

  afterEach(() => {
    delete (globalThis as Record<string, unknown>)[AUTHORITY_KEY];
    delete (globalThis as Record<string, unknown>)[CAPTURE_KEY];
    delete (navigator as unknown as Record<string, unknown>).locks;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function createService(): AuthCallbackSessionService {
    const optionsFactory = {
      buildAuthCallbackClientOptions: vi.fn((storageKey: string) => ({
        auth: {
          storageKey,
          detectSessionInUrl: false,
          autoRefreshToken: false,
          persistSession: false,
        },
      })),
    };
    return Injector.create({
      providers: [
        AuthCallbackSessionService,
        { provide: SupabaseClientOptionsFactoryService, useValue: optionsFactory },
        { provide: AuthService, useValue: { restartRuntimeAfterAuthCallback: restartRuntime } },
      ],
    }).get(AuthCallbackSessionService);
  }

  function installSuccessfulClient() {
    const session = {
      access_token: 'token-a',
      refresh_token: 'refresh-a',
      token_type: 'bearer',
      expires_in: 3600,
      expires_at: 2_000_000_000,
      user: { id: 'owner-a', email: 'a@example.com' },
    };
    exchangeFetch.mockResolvedValue(new Response(JSON.stringify(session), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', exchangeFetch);
    setSession.mockResolvedValue({ data: { session, user: session.user }, error: null });
    createClientMock.mockReturnValue({ auth: { setSession, dispose }, removeAllChannels });
    return session;
  }

  it('publishes one isolated callback session only from an empty canonical bundle', async () => {
    const session = installSuccessfulClient();
    const result = await createService().completeCapturedCallback();

    expect(result).toBe('authenticated');
    expect(bundle.session).toBe(JSON.stringify(session));
    expect(bundle.codeVerifier).toBeNull();
    expect(JSON.parse(bundle.user ?? '{}')).toMatchObject({ id: 'owner-a' });
    expect(publishedEnvelope).toMatchObject({
      verifier: 'verifier-a',
      exchangeState: 'succeeded',
      session: JSON.stringify(session),
    });
    expect(authority.claimCallbackVerifier).toHaveBeenCalledWith(expect.objectContaining({
      envelope: expect.objectContaining({ exchangeState: 'ready' }),
    }));
    expect(publishedEnvelope?.['sessionDigest']).toEqual(expect.any(String));
    expect(JSON.parse(String(exchangeFetch.mock.calls[0]?.[1]?.body))).toEqual({
      auth_code: 'callback-code-a',
      code_verifier: 'verifier-a',
    });
    expect(restartRuntime).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(removeAllChannels).toHaveBeenCalledTimes(1);
  });

  it('resumes one exact claimant session through public setSession without re-exchange', async () => {
    const attemptId = 'attempt-resume-a';
    const tabId = 'tab-resume-a';
    const code = 'callback-code-a';
    const verifier = 'verifier-a';
    const storageKey = `nanoflow-auth-callback-${attemptId}`;
    const capabilityDigest = await sha256(`${attemptId}:${tabId}:${code}:${verifier}`);
    const expiresAt = Date.now() + 60_000;
    const marker = JSON.stringify({
      kind: 'nanoflow-auth-callback',
      version: 1,
      attemptId,
      tabId,
      capabilityDigest,
      expiresAt,
    });
    const session = {
      access_token: 'token-a',
      refresh_token: 'refresh-a',
      token_type: 'bearer',
      expires_in: 3600,
      expires_at: 2_000_000_000,
      user: { id: 'owner-a', email: 'a@example.com' },
    };
    const sessionRaw = JSON.stringify(session);
    const sessionDigest = await sha256(`${capabilityDigest}:${sessionRaw}`);
    bundle = { session: null, codeVerifier: marker, user: null };
    sessionStorage.setItem(`${CLAIM_PREFIX}${attemptId}`, JSON.stringify({
      version: 1,
      attemptId,
      tabId,
      capabilityDigest,
      storageKey,
      code,
      verifier,
      expiresAt,
      exchangeState: 'succeeded',
      session: sessionRaw,
      sessionDigest,
    }));
    Object.defineProperty(globalThis, CAPTURE_KEY, {
      configurable: true,
      value: Object.freeze({
        version: 1,
        blocked: false,
        capturedAt: Date.now(),
        hasAuthError: false,
        claimCode: vi.fn().mockReturnValue(null),
      }),
    });
    setSession.mockResolvedValue({ data: { session, user: session.user }, error: null });
    createClientMock.mockReturnValue({ auth: { setSession, dispose }, removeAllChannels });

    await expect(createService().completeCapturedCallback()).resolves.toBe('authenticated');

    expect(authority.claimCallbackVerifier).not.toHaveBeenCalled();
    expect(exchangeFetch).not.toHaveBeenCalled();
    expect(setSession).toHaveBeenCalledWith({
      access_token: session.access_token,
      refresh_token: session.refresh_token,
    });
    expect(bundle.session).toBe(sessionRaw);
    expect(restartRuntime).toHaveBeenCalledTimes(1);
  });

  it('persists dispatched before the one exchange and succeeds only after claimant session persistence', async () => {
    const session = installSuccessfulClient();
    let resolveExchange!: (response: Response) => void;
    exchangeFetch.mockReset();
    exchangeFetch.mockReturnValue(new Promise<Response>(resolve => { resolveExchange = resolve; }));
    const operation = createService().completeCapturedCallback();

    await vi.waitFor(() => expect(exchangeFetch).toHaveBeenCalledTimes(1));
    const claimantKey = Array.from({ length: sessionStorage.length }, (_, index) =>
      sessionStorage.key(index)).find(key => key?.startsWith(CLAIM_PREFIX));
    expect(claimantKey).toBeTruthy();
    const dispatchedEnvelope = JSON.parse(sessionStorage.getItem(claimantKey!) ?? '{}');
    expect(dispatchedEnvelope).toMatchObject({ exchangeState: 'dispatched' });
    expect(dispatchedEnvelope).not.toHaveProperty('session');
    expect(authority.claimCallbackVerifier).toHaveBeenCalledWith(expect.objectContaining({
      envelope: expect.objectContaining({ exchangeState: 'ready' }),
    }));

    resolveExchange(new Response(JSON.stringify(session), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    await expect(operation).resolves.toBe('authenticated');
    expect(publishedEnvelope).toMatchObject({ exchangeState: 'succeeded' });
  });

  it('never redispatches a resumed claimant whose code reached dispatched', async () => {
    const attemptId = 'attempt-dispatched-a';
    const tabId = 'tab-dispatched-a';
    const code = 'callback-code-a';
    const verifier = 'verifier-a';
    const storageKey = `nanoflow-auth-callback-${attemptId}`;
    const capabilityDigest = await sha256(`${attemptId}:${tabId}:${code}:${verifier}`);
    const expiresAt = Date.now() + 60_000;
    const marker = JSON.stringify({
      kind: 'nanoflow-auth-callback', version: 1, attemptId, tabId, capabilityDigest, expiresAt,
    });
    bundle = { session: null, codeVerifier: marker, user: null };
    sessionStorage.setItem(`${CLAIM_PREFIX}${attemptId}`, JSON.stringify({
      version: 1,
      attemptId,
      tabId,
      capabilityDigest,
      storageKey,
      code,
      verifier,
      expiresAt,
      exchangeState: 'dispatched',
    }));
    Object.defineProperty(globalThis, CAPTURE_KEY, {
      configurable: true,
      value: Object.freeze({
        version: 1,
        blocked: false,
        capturedAt: Date.now(),
        hasAuthError: false,
        claimCode: vi.fn().mockReturnValue(null),
      }),
    });
    vi.stubGlobal('fetch', exchangeFetch);

    await expect(createService().completeCapturedCallback()).resolves.toBe('invalid');

    expect(exchangeFetch).not.toHaveBeenCalled();
    expect(createClientMock).not.toHaveBeenCalled();
    expect(restartRuntime).not.toHaveBeenCalled();
  });

  it('bounds expired marker cleanup across the claimant envelope and attempt namespace', async () => {
    const attemptId = 'attempt-expired-a';
    const marker = JSON.stringify({
      kind: 'nanoflow-auth-callback',
      version: 1,
      attemptId,
      tabId: 'tab-expired-a',
      capabilityDigest: 'expired-digest-a',
      expiresAt: Date.now() - 1,
    });
    bundle = { session: null, codeVerifier: marker, user: null };
    sessionStorage.setItem(`${CLAIM_PREFIX}${attemptId}`, 'expired-envelope');
    sessionStorage.setItem(`nanoflow-auth-callback-${attemptId}`, 'expired-session');

    await expect(createService().completeCapturedCallback()).resolves.toBe('invalid');

    expect(bundle.codeVerifier).toBeNull();
    expect(sessionStorage.getItem(`${CLAIM_PREFIX}${attemptId}`)).toBeNull();
    expect(sessionStorage.getItem(`nanoflow-auth-callback-${attemptId}`)).toBeNull();
    expect(createClientMock).not.toHaveBeenCalled();
  });

  it.each([
    ['different owner', { access_token: 'token-b', user: { id: 'owner-b' } }],
    ['same owner newer token', { access_token: 'token-b-new', user: { id: 'owner-a' } }],
  ])('preserves an existing %s session without creating a callback client', async (_label, session) => {
    bundle = { session: JSON.stringify(session), codeVerifier: 'verifier-a', user: JSON.stringify(session.user) };
    const before = bundle.session;

    await expect(createService().completeCapturedCallback()).resolves.toBe('conflict');

    expect(bundle.session).toBe(before);
    expect(bundle.codeVerifier).toBeNull();
    expect(createClientMock).not.toHaveBeenCalled();
    expect(restartRuntime).not.toHaveBeenCalled();
  });

  it.each([
    ['different-owner C', { access_token: 'token-c', user: { id: 'owner-c' } }, 'verifier-c'],
    ['same-owner newer B', { access_token: 'token-b-new', user: { id: 'owner-a' } }, 'verifier-b'],
  ])('preserves delayed %s when it arrives during the isolated exchange', async (
    _label,
    replacement,
    replacementVerifier,
  ) => {
    let release!: () => void;
    const delayed = new Promise<void>(resolve => { release = resolve; });
    const session = installSuccessfulClient();
    exchangeFetch.mockImplementationOnce(async () => {
      await delayed;
      return new Response(JSON.stringify(session), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    const service = createService();
    const completion = service.completeCapturedCallback();
    await vi.waitFor(() => expect(exchangeFetch).toHaveBeenCalled());
    bundle = {
      session: JSON.stringify(replacement),
      codeVerifier: replacementVerifier,
      user: JSON.stringify(replacement.user),
    };
    release();

    await expect(completion).resolves.toBe('conflict');
    expect(bundle.session).toContain(replacement.access_token);
    expect(bundle.codeVerifier).toBe(replacementVerifier);
    expect(restartRuntime).not.toHaveBeenCalled();
  });

  it('fails closed without Web Locks before claiming or creating an isolated client', async () => {
    delete (navigator as unknown as Record<string, unknown>).locks;

    await expect(createService().completeCapturedCallback()).resolves.toBe('invalid');

    expect(bundle).toEqual({ session: null, codeVerifier: 'verifier-a', user: null });
    expect(authority.claimCallbackVerifier).not.toHaveBeenCalled();
    expect(createClientMock).not.toHaveBeenCalled();
  });

  it('fences a late exchange after cancel and disposes public client resources', async () => {
    let release!: () => void;
    const delayed = new Promise<void>(resolve => { release = resolve; });
    const session = installSuccessfulClient();
    setSession.mockImplementationOnce(async () => {
      await delayed;
      return { data: { session, user: session.user }, error: null };
    });
    const service = createService();
    const completion = service.completeCapturedCallback();
    await vi.waitFor(() => expect(setSession).toHaveBeenCalled());
    const claimantKey = Array.from({ length: sessionStorage.length }, (_, index) =>
      sessionStorage.key(index)).find(key => key?.startsWith(CLAIM_PREFIX));
    service.cancel();
    release();

    await expect(completion).resolves.toBe('cancelled');
    expect(bundle.session).toBeNull();
    expect(restartRuntime).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalled();
    expect(removeAllChannels).toHaveBeenCalled();
    expect(claimantKey).toBeTruthy();
    expect(sessionStorage.getItem(claimantKey!)).toBeNull();
  });

  it('does not resurrect claimant storage when cancel wins during session digesting', async () => {
    let releaseDigest!: () => void;
    const digestGate = new Promise<void>(resolve => { releaseDigest = resolve; });
    const nativeDigest = webcrypto.subtle.digest.bind(webcrypto.subtle);
    const digest = vi.fn(async (algorithm: AlgorithmIdentifier, data: BufferSource) => {
      const value = new TextDecoder().decode(data);
      if (value.includes('"access_token"')) await digestGate;
      return await nativeDigest(algorithm, data);
    });
    vi.stubGlobal('crypto', {
      getRandomValues: webcrypto.getRandomValues.bind(webcrypto),
      subtle: { digest },
    });
    installSuccessfulClient();
    const service = createService();
    const completion = service.completeCapturedCallback();
    await vi.waitFor(() => expect(digest.mock.calls.some(([, data]) =>
      new TextDecoder().decode(data).includes('"access_token"'))).toBe(true));

    service.cancel();
    releaseDigest();

    await expect(completion).resolves.toBe('cancelled');
    expect(bundle.session).toBeNull();
    expect(bundle.codeVerifier).toBeNull();
    expect(createClientMock).not.toHaveBeenCalled();
    expect(Array.from({ length: sessionStorage.length }, (_, index) =>
      sessionStorage.key(index)).filter(key => key?.startsWith(CLAIM_PREFIX))).toEqual([]);
  });

  it('rejects public session validation that settles after the claimant TTL', async () => {
    let currentTime = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => currentTime);
    let release!: () => void;
    const delayed = new Promise<void>(resolve => { release = resolve; });
    const session = installSuccessfulClient();
    setSession.mockImplementationOnce(async () => {
      await delayed;
      return { data: { session, user: session.user }, error: null };
    });
    const completion = createService().completeCapturedCallback();
    await vi.waitFor(() => expect(setSession).toHaveBeenCalled());

    currentTime += 11 * 60 * 1_000;
    release();

    await expect(completion).resolves.toBe('invalid');
    expect(bundle).toEqual({ session: null, codeVerifier: null, user: null });
    expect(restartRuntime).not.toHaveBeenCalled();
  });

  it('rejects replay after one successful callback without a second client or publication', async () => {
    installSuccessfulClient();
    const service = createService();

    await expect(service.completeCapturedCallback()).resolves.toBe('authenticated');
    await expect(service.completeCapturedCallback()).resolves.toBe('invalid');

    expect(createClientMock).toHaveBeenCalledTimes(1);
    expect(restartRuntime).toHaveBeenCalledTimes(1);
  });

  it('pins the clean-install Supabase and Auth closure to 2.110.3', () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));
    const lock = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package-lock.json'), 'utf8'));

    expect(packageJson.dependencies['@supabase/supabase-js']).toBe('2.110.3');
    expect(lock.packages[''].dependencies['@supabase/supabase-js']).toBe('2.110.3');
    expect(lock.packages['node_modules/@supabase/supabase-js'].version).toBe('2.110.3');
    expect(lock.packages['node_modules/@supabase/auth-js'].version).toBe('2.110.3');
    expect(lock.packages['node_modules/@supabase/functions-js'].version).toBe('2.110.3');
    expect(lock.packages['node_modules/@supabase/postgrest-js'].version).toBe('2.110.3');
    expect(lock.packages['node_modules/@supabase/realtime-js'].version).toBe('2.110.3');
    expect(lock.packages['node_modules/@supabase/storage-js'].version).toBe('2.110.3');
    expect(packageJson.dependencies['@supabase/auth-js']).toBeUndefined();
  });
});
