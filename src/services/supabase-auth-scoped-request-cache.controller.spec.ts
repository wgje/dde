import { describe, expect, it, vi } from 'vitest';

import type {
  CanonicalAuthBundle,
  CanonicalAuthGeneration,
  CanonicalAuthStorageAuthority,
  SupabaseAuthClientCandidate,
} from './supabase-auth-client-lifecycle.controller';
import { SupabaseAuthScopedRequestCacheController } from './supabase-auth-scoped-request-cache.controller';
import { registerRequestCacheBucketRaceSpecs } from './supabase-client.service.spec-helpers';
const STORAGE_KEY = 'sb-example-auth-token';
const SIGNATURE = 'GET:https://example.supabase.co/rest/v1/projects:';
const ANON_BEARER = 'anon-bearer';
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(next => { resolve = next; });
  return { promise, resolve };
}
function createCandidate(epoch: number): SupabaseAuthClientCandidate {
  const generation: CanonicalAuthGeneration = {
    storageKey: `${STORAGE_KEY}-g-${epoch}`,
    storage: {
      getItem: vi.fn(),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    },
    promote: vi.fn(),
    retire: vi.fn(),
  };
  return Object.freeze({
    epoch,
    generation,
    storage: generation.storage,
    storageKey: generation.storageKey,
  });
}

function createBundle(accessToken: string, userId: string, verifier: string | null = null): CanonicalAuthBundle {
  return {
    session: JSON.stringify({ access_token: accessToken, user: { id: userId } }),
    codeVerifier: verifier,
    user: JSON.stringify({ id: userId }),
  };
}

function createAuthority(readBundle: () => CanonicalAuthBundle): CanonicalAuthStorageAuthority {
  return {
    createGeneration: vi.fn(),
    peekBundle: vi.fn(readBundle),
    readBundle: vi.fn(),
    compareAndSwap: vi.fn(),
    startSessionPrewarm: vi.fn(),
  };
}

function authOptions(accessToken: string): RequestInit {
  return { headers: { Authorization: `Bearer ${accessToken}` } };
}

function response(owner: string): Response {
  return new Response(JSON.stringify({ owner }), {
    headers: { 'content-type': 'application/json' },
  });
}
function graphContainsMarker(root: unknown, markers: readonly string[]): boolean {
  const seen = new Set<unknown>();
  const visit = (value: unknown): boolean => {
    if (typeof value === 'string') return markers.some(marker => value.includes(marker));
    if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return false;
    if (seen.has(value)) return false;
    seen.add(value);
    return Reflect.ownKeys(value).some(key => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return !!descriptor && 'value' in descriptor && visit(descriptor.value);
    });
  };
  return visit(root);
}
function retainedEntries(controller: SupabaseAuthScopedRequestCacheController) {
  return (controller as unknown as {
    entries: Map<string, Array<Record<string, unknown>>>;
  }).entries.get(SIGNATURE) ?? [];
}
describe('SupabaseAuthScopedRequestCacheController', () => {
  registerRequestCacheBucketRaceSpecs({ authOptions, createAuthority, createBundle,
    createCandidate, deferred, response, retainedEntries });
  it('retains no raw authority markers in pending or settled cache-entry graphs', async () => {
    const candidate = createCandidate(1);
    const markers = Array.from({ length: 4 }, () => `marker-${crypto.randomUUID()}`);
    const [bearerMarker, sessionMarker, verifierMarker, userMarker] = markers;
    const bundle: CanonicalAuthBundle = {
      session: JSON.stringify({
        access_token: bearerMarker,
        session_marker: sessionMarker,
        user: { id: userMarker },
      }),
      codeVerifier: verifierMarker,
      user: JSON.stringify({ id: userMarker }),
    };
    const pendingResponse = deferred<Response>();
    const fetch = vi.fn(() => pendingResponse.promise);
    const controller = new SupabaseAuthScopedRequestCacheController({
      anonymousBearerToken: () => ANON_BEARER,
      authority: () => createAuthority(() => bundle),
      isCandidateCurrent: value => value === candidate,
    });
    const request = controller.execute({
      candidate,
      signature: SIGNATURE,
      options: authOptions(bearerMarker),
      fetch,
    });
    await vi.waitFor(() => expect(retainedEntries(controller).length).toBe(1));
    const pending = retainedEntries(controller)[0];
    const pendingDescriptors = Object.getOwnPropertyDescriptors(pending);
    expect('promise' in pendingDescriptors).toBe(true);
    expect('response' in pendingDescriptors).toBe(false);
    expect(Object.values(pendingDescriptors).every(descriptor => 'value' in descriptor)).toBe(true);
    expect(graphContainsMarker(pending, markers)).toBe(false);
    pendingResponse.resolve(response('safe-owner'));
    await request;
    const settled = retainedEntries(controller)[0];
    const settledDescriptors = Object.getOwnPropertyDescriptors(settled);
    expect(settled === pending).toBe(false);
    expect(Object.keys(settledDescriptors).sort()).toEqual(['createdAt', 'fence', 'kind', 'response']);
    expect(Object.values(settledDescriptors).every(descriptor => 'value' in descriptor)).toBe(true);
    expect(graphContainsMarker(settled, markers)).toBe(false);
    const cachedBody = await (settled['response'] as Response).clone().text();
    expect(markers.some(marker => cachedBody.includes(marker))).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('does not let a completed authenticated A response satisfy different-owner B', async () => {
    const candidateA = createCandidate(1);
    const candidateB = createCandidate(2);
    const bundleA = createBundle('access-a', 'user-a');
    const bundleB = createBundle('access-b', 'user-b');
    let currentCandidate = candidateA;
    let currentBundle = bundleA;
    const fetchA = vi.fn(async () => response('user-a'));
    const fetchB = vi.fn(async () => response('user-b'));
    const controller = new SupabaseAuthScopedRequestCacheController({
      anonymousBearerToken: () => ANON_BEARER,
      authority: () => createAuthority(() => currentBundle),
      isCandidateCurrent: candidate => candidate === currentCandidate,
    });
    await expect(controller.execute({
      candidate: candidateA, signature: SIGNATURE, options: authOptions('access-a'), fetch: fetchA,
    }).then(value => value.json())).resolves.toEqual({ owner: 'user-a' });
    currentCandidate = candidateB;
    currentBundle = bundleB;
    await expect(controller.execute({
      candidate: candidateB, signature: SIGNATURE, options: authOptions('access-b'), fetch: fetchB,
    }).then(value => value.json())).resolves.toEqual({ owner: 'user-b' });
    expect(fetchA).toHaveBeenCalledTimes(1);
    expect(fetchB).toHaveBeenCalledTimes(1);
  });
  it('preserves newer A after reset and owner-generation A to B to A drift', async () => {
    const candidateA = createCandidate(1);
    const candidateB = createCandidate(2);
    const candidateA2 = createCandidate(3);
    let currentCandidate = candidateA;
    let currentBundle = createBundle('access-a', 'user-a');
    const pendingA = deferred<Response>();
    const pendingA2 = deferred<Response>();
    const fetchA = vi.fn(() => pendingA.promise);
    const fetchA2 = vi.fn(() => pendingA2.promise);
    const controller = new SupabaseAuthScopedRequestCacheController({
      anonymousBearerToken: () => ANON_BEARER,
      authority: () => createAuthority(() => currentBundle),
      isCandidateCurrent: candidate => candidate === currentCandidate,
    });
    const requestA = controller.execute({
      candidate: candidateA, signature: SIGNATURE, options: authOptions('access-a'), fetch: fetchA,
    });
    await vi.waitFor(() => expect(retainedEntries(controller).length).toBe(1));
    const oldA = retainedEntries(controller)[0];
    expect(oldA['kind']).toBe('pending');
    controller.reset();
    currentCandidate = candidateB;
    currentBundle = createBundle('access-b', 'user-b');
    await controller.execute({
      candidate: candidateB, signature: SIGNATURE, options: authOptions('access-b'),
      fetch: async () => response('user-b'),
    });
    currentCandidate = candidateA2;
    currentBundle = createBundle('access-a-new', 'user-a');
    const requestA2 = controller.execute({
      candidate: candidateA2, signature: SIGNATURE, options: authOptions('access-a-new'), fetch: fetchA2,
    });
    await vi.waitFor(() => expect(retainedEntries(controller)[0]?.['kind']).toBe('pending'));
    const currentA2 = retainedEntries(controller)[0];
    expect(currentA2 === oldA).toBe(false);
    expect(currentA2['kind']).toBe('pending');
    pendingA.resolve(response('user-a'));
    await expect(requestA.then(value => value.json())).resolves.toEqual({ owner: 'user-a' });
    expect(retainedEntries(controller)[0] === currentA2).toBe(true);
    expect(retainedEntries(controller)[0]?.['kind']).toBe('pending');
    pendingA2.resolve(response('user-a-new'));
    await requestA2;
    expect(retainedEntries(controller)[0] === currentA2).toBe(false);
    expect(retainedEntries(controller)[0]?.['kind']).toBe('settled');
    await expect(controller.execute({
      candidate: candidateA2, signature: SIGNATURE, options: authOptions('access-a-new'), fetch: fetchA2,
    }).then(value => value.json())).resolves.toEqual({ owner: 'user-a-new' });
    expect(fetchA2).toHaveBeenCalledTimes(1);
  });
  it('removes resolved pending A immediately after same-owner token rotates to B', async () => {
    const candidate = createCandidate(1);
    let currentBundle = createBundle('access-a', 'user-a');
    const pendingA = deferred<Response>();
    const fetchA = vi.fn(() => pendingA.promise);
    const fetchB = vi.fn(async () => response('session-b'));
    const controller = new SupabaseAuthScopedRequestCacheController({
      anonymousBearerToken: () => ANON_BEARER,
      authority: () => createAuthority(() => currentBundle),
      isCandidateCurrent: value => value === candidate,
    });
    const requestA = controller.execute({
      candidate, signature: SIGNATURE, options: authOptions('access-a'), fetch: fetchA,
    });
    await vi.waitFor(() => expect(retainedEntries(controller).length).toBe(1));
    currentBundle = createBundle('access-b', 'user-a');
    pendingA.resolve(response('session-a'));
    await requestA;
    expect(retainedEntries(controller).length).toBe(0);
    await expect(controller.execute({
      candidate, signature: SIGNATURE, options: authOptions('access-b'), fetch: fetchB,
    }).then(value => value.json())).resolves.toEqual({ owner: 'session-b' });
    await controller.execute({
      candidate, signature: SIGNATURE, options: authOptions('access-b'), fetch: fetchB,
    });
    expect(fetchA).toHaveBeenCalledTimes(1);
    expect(fetchB).toHaveBeenCalledTimes(1);
  });
  it('deduplicates exact current A and returns independent response clones', async () => {
    const candidate = createCandidate(1);
    const bundle = createBundle('access-a', 'user-a');
    const pending = deferred<Response>();
    const fetch = vi.fn(() => pending.promise);
    const controller = new SupabaseAuthScopedRequestCacheController({
      anonymousBearerToken: () => ANON_BEARER,
      authority: () => createAuthority(() => bundle),
      isCandidateCurrent: value => value === candidate,
    });
    const first = controller.execute({
      candidate, signature: SIGNATURE, options: authOptions('access-a'), fetch,
    });
    const second = controller.execute({
      candidate, signature: SIGNATURE, options: authOptions('access-a'), fetch,
    });
    pending.resolve(response('user-a'));
    const [firstResponse, secondResponse] = await Promise.all([first, second]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(firstResponse).not.toBe(secondResponse);
    await expect(firstResponse.json()).resolves.toEqual({ owner: 'user-a' });
    await expect(secondResponse.json()).resolves.toEqual({ owner: 'user-a' });
  });
  it('preserves anonymous dedup only while its exact candidate and bundle remain current', async () => {
    const candidate = createCandidate(1);
    let currentBundle: CanonicalAuthBundle = { session: null, codeVerifier: null, user: null };
    const fetch = vi.fn(async () => response('anonymous'));
    const controller = new SupabaseAuthScopedRequestCacheController({
      anonymousBearerToken: () => ANON_BEARER,
      authority: () => createAuthority(() => currentBundle),
      isCandidateCurrent: value => value === candidate,
    });
    const input = {
      candidate, signature: SIGNATURE, options: authOptions(ANON_BEARER), fetch,
    };
    await controller.execute(input);
    await controller.execute(input);
    expect(fetch).toHaveBeenCalledTimes(1);
    currentBundle = { session: null, codeVerifier: 'verifier-b', user: null };
    await controller.execute(input);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('bypasses caching when a non-secret fingerprint cannot be produced', async () => {
    const digest = vi.spyOn(globalThis.crypto.subtle, 'digest')
      .mockRejectedValue(new Error('fingerprint unavailable'));
    try {
      const candidate = createCandidate(1);
      const bundle = createBundle('access-a', 'user-a');
      const fetch = vi.fn(async () => response('uncached'));
      const controller = new SupabaseAuthScopedRequestCacheController({
        anonymousBearerToken: () => ANON_BEARER,
        authority: () => createAuthority(() => bundle),
        isCandidateCurrent: value => value === candidate,
      });
      const input = { candidate, signature: SIGNATURE, options: authOptions('access-a'), fetch };
      await controller.execute(input);
      await controller.execute(input);
      expect(fetch).toHaveBeenCalledTimes(2);
    } finally {
      digest.mockRestore();
    }
  });
  it.each(['missing', 'malformed', 'mismatched'] as const)(
    'bypasses dedup when canonical authority is %s',
    async mode => {
      const candidate = createCandidate(1);
      const authority = mode === 'missing'
        ? null
        : createAuthority(() => mode === 'malformed'
          ? { session: '{', codeVerifier: null, user: null }
          : createBundle('access-b', 'user-b'));
      const fetch = vi.fn(async () => response('uncached'));
      const controller = new SupabaseAuthScopedRequestCacheController({
        anonymousBearerToken: () => ANON_BEARER,
        authority: () => authority,
        isCandidateCurrent: value => value === candidate,
      });
      const input = {
        candidate, signature: SIGNATURE, options: authOptions('access-a'), fetch,
      };
      await controller.execute(input);
      await controller.execute(input);
      expect(fetch).toHaveBeenCalledTimes(2);
    },
  );
});
