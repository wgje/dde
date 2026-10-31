import { describe, expect, it, vi } from 'vitest';
import {
  SupabaseAuthClientLifecycleController,
  type CanonicalAuthGeneration,
  type CanonicalAuthStorageAuthority,
} from './supabase-auth-client-lifecycle.controller';

function createGeneration(name: string): CanonicalAuthGeneration {
  return {
    storageKey: name,
    storage: {
      getItem: vi.fn().mockResolvedValue(null),
      setItem: vi.fn().mockResolvedValue(undefined),
      removeItem: vi.fn().mockResolvedValue(undefined),
    },
    promote: vi.fn().mockResolvedValue('committed'),
    retire: vi.fn(),
  };
}

describe('SupabaseAuthClientLifecycleController', () => {
  it('creates and promotes one current candidate through the canonical authority', async () => {
    const generation = createGeneration('generation-a');
    const authority: CanonicalAuthStorageAuthority = {
      createGeneration: vi.fn().mockResolvedValue(generation),
      peekBundle: vi.fn(),
      readBundle: vi.fn(),
      compareAndSwap: vi.fn(),
      startSessionPrewarm: vi.fn(),
    };
    const controller = new SupabaseAuthClientLifecycleController(() => authority);

    const candidate = await controller.beginCandidate('canonical-key');

    expect(candidate.storageKey).toBe('generation-a');
    await expect(controller.promote(candidate)).resolves.toBe(true);
    expect(generation.promote).toHaveBeenCalledTimes(1);
    expect(controller.isCurrent(candidate)).toBe(true);
  });

  it('retires a stale A resolved after reset and cannot clear or promote B', async () => {
    let resolveA!: (generation: CanonicalAuthGeneration) => void;
    const generationA = createGeneration('generation-a');
    const generationB = createGeneration('generation-b');
    const authority: CanonicalAuthStorageAuthority = {
      createGeneration: vi.fn()
        .mockImplementationOnce(() => new Promise(resolve => { resolveA = resolve; }))
        .mockResolvedValueOnce(generationB),
      peekBundle: vi.fn(),
      readBundle: vi.fn(),
      compareAndSwap: vi.fn(),
      startSessionPrewarm: vi.fn(),
    };
    const controller = new SupabaseAuthClientLifecycleController(() => authority);

    const pendingA = controller.beginCandidate('canonical-key');
    controller.reset();
    const candidateB = await controller.beginCandidate('canonical-key');
    await controller.promote(candidateB);
    resolveA(generationA);

    await expect(pendingA).rejects.toThrow('AUTH_CLIENT_GENERATION_STALE');
    expect(generationA.retire).toHaveBeenCalledTimes(1);
    expect(generationB.retire).not.toHaveBeenCalled();
    expect(controller.isCurrent(candidateB)).toBe(true);
  });

  it('fails closed when the canonical authority is unavailable', async () => {
    const controller = new SupabaseAuthClientLifecycleController(() => null);

    await expect(controller.beginCandidate('canonical-key'))
      .rejects.toThrow('AUTH_CANONICAL_AUTHORITY_UNAVAILABLE');
  });

  it('holds promotion behind the active publication barrier and ignores an old barrier cleanup', async () => {
    let releaseA!: () => void;
    const operationA = new Promise<void>(resolve => { releaseA = resolve; });
    const generation = createGeneration('generation-b');
    const authority = {
      createGeneration: vi.fn().mockResolvedValue(generation),
      peekBundle: vi.fn(),
      readBundle: vi.fn(),
      compareAndSwap: vi.fn(),
      startSessionPrewarm: vi.fn(),
    } satisfies CanonicalAuthStorageAuthority;
    const controller = new SupabaseAuthClientLifecycleController(() => authority);
    controller.holdPublicationUntil(operationA, 5_000);
    const candidate = await controller.beginCandidate('canonical-key');
    let promoted = false;
    const promotion = controller.promote(candidate).then(result => { promoted = result; });

    await Promise.resolve();
    expect(promoted).toBe(false);
    releaseA();
    await promotion;
    expect(promoted).toBe(true);
  });

  it('returns null and still removes channels when auth.dispose throws synchronously', () => {
    const auth = {
      dispose: vi.fn(() => {
        throw new Error('dispose failed');
      }),
    };
    const removeAllChannels = vi.fn().mockResolvedValue(undefined);
    const controller = new SupabaseAuthClientLifecycleController();

    const result = controller.disposeClient({ auth, removeAllChannels });

    expect(result).toBeNull();
    expect(removeAllChannels).toHaveBeenCalledTimes(1);
  });

  it('returns null and still disposes auth when removeAllChannels throws synchronously', () => {
    const auth = {
      dispose: vi.fn().mockResolvedValue(undefined),
    };
    const removeAllChannels = vi.fn(() => {
      throw new Error('channels failed');
    });
    const controller = new SupabaseAuthClientLifecycleController();

    const result = controller.disposeClient({ auth, removeAllChannels });

    expect(result).toBeNull();
    expect(auth.dispose).toHaveBeenCalledTimes(1);
  });

  it('absorbs async rejections from both cleanup operations', async () => {
    const auth = {
      dispose: vi.fn().mockRejectedValue(new Error('async dispose failed')),
    };
    const removeAllChannels = vi.fn().mockRejectedValue(new Error('async channels failed'));
    const controller = new SupabaseAuthClientLifecycleController();

    const result = controller.disposeClient({ auth, removeAllChannels });

    expect(result).toBeNull();
    expect(auth.dispose).toHaveBeenCalledTimes(1);
    expect(removeAllChannels).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    await Promise.resolve();
  });

  it('calls both cleanup operations for a normal disposeClient', () => {
    const auth = {
      dispose: vi.fn().mockResolvedValue(undefined),
    };
    const removeAllChannels = vi.fn().mockResolvedValue(undefined);
    const controller = new SupabaseAuthClientLifecycleController();

    const result = controller.disposeClient({ auth, removeAllChannels });

    expect(result).toBeNull();
    expect(auth.dispose).toHaveBeenCalledTimes(1);
    expect(removeAllChannels).toHaveBeenCalledTimes(1);
  });
});
