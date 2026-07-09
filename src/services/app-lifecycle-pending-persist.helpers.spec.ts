import { describe, expect, it, vi } from 'vitest';
import { schedulePendingPersistRecovery } from './app-lifecycle-pending-persist.helpers';

const flushMicrotasks = async (): Promise<void> => {
  for (let index = 0; index < 3; index += 1) {
    await Promise.resolve();
  }
};

describe('schedulePendingPersistRecovery', () => {
  it('does not schedule recovery when there are no pending local changes', async () => {
    const deps = createDeps({ hasPendingLocalChanges: () => false });

    schedulePendingPersistRecovery('visibility-quick', deps);
    await flushMicrotasks();

    expect(deps.addBreadcrumb).not.toHaveBeenCalled();
    expect(deps.flushPendingPersistToCloud).not.toHaveBeenCalled();
  });

  it('isolates breadcrumb and queue scheduling failures while preserving pending persist flush', async () => {
    const breadcrumbError = new Error('breadcrumb failed');
    const scheduleError = new Error('queueMicrotask failed');
    const originalQueueMicrotask = globalThis.queueMicrotask;
    const deps = createDeps({
      addBreadcrumb: vi.fn(() => {
        throw breadcrumbError;
      }),
    });
    globalThis.queueMicrotask = vi.fn(() => {
      throw scheduleError;
    }) as unknown as typeof queueMicrotask;

    try {
      schedulePendingPersistRecovery('visibility-quick', deps);
      await flushMicrotasks();

      expect(deps.logger.warn).toHaveBeenCalledWith(
        'Resume pending persist recovery breadcrumb failed',
        { reason: 'visibility-quick', error: breadcrumbError },
      );
      expect(deps.logger.warn).toHaveBeenCalledWith(
        'Resume pending persist recovery scheduling failed',
        { reason: 'visibility-quick', error: scheduleError },
      );
      expect(deps.flushPendingPersistToCloud).toHaveBeenCalledWith('resume:visibility-quick');
    } finally {
      globalThis.queueMicrotask = originalQueueMicrotask;
    }
  });

  it('isolates telemetry failure after pending persist flush rejection', async () => {
    const persistError = new Error('persist failed');
    const captureError = new Error('capture failed');
    const deps = createDeps({
      flushPendingPersistToCloud: vi.fn().mockRejectedValue(persistError),
      captureException: vi.fn(() => {
        throw captureError;
      }),
    });

    schedulePendingPersistRecovery('online', deps);
    await flushMicrotasks();

    expect(deps.logger.warn).toHaveBeenCalledWith(
      'Resume pending persist recovery failed',
      { reason: 'online', error: persistError },
    );
    expect(deps.logger.warn).toHaveBeenCalledWith(
      'Resume pending persist recovery telemetry failed',
      { reason: 'online', error: captureError },
    );
  });

  it('deduplicates repeated recovery scheduling while a pending persist flush is already queued', async () => {
    const hasPendingLocalChanges = vi.fn()
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(true)
      .mockReturnValue(false);
    const deps = createDeps({ hasPendingLocalChanges });

    schedulePendingPersistRecovery('visibility-quick', deps);
    schedulePendingPersistRecovery('online', deps);
    await flushMicrotasks();

    expect(deps.flushPendingPersistToCloud).toHaveBeenCalledTimes(1);
    expect(deps.flushPendingPersistToCloud).toHaveBeenCalledWith('resume:visibility-quick');
  });

  it('reruns recovery with the later reason when pending changes remain during an active flush', async () => {
    const firstFlush = createDeferred<unknown>();
    const deps = createDeps({
      flushPendingPersistToCloud: vi.fn()
        .mockReturnValueOnce(firstFlush.promise)
        .mockResolvedValueOnce(true),
    });

    schedulePendingPersistRecovery('visibility-quick', deps);
    await flushMicrotasks();

    expect(deps.flushPendingPersistToCloud).toHaveBeenCalledTimes(1);
    expect(deps.flushPendingPersistToCloud).toHaveBeenCalledWith('resume:visibility-quick');

    schedulePendingPersistRecovery('online', deps);
    await flushMicrotasks();

    expect(deps.flushPendingPersistToCloud).toHaveBeenCalledTimes(1);

    firstFlush.resolve(false);
    await flushMicrotasks();

    expect(deps.flushPendingPersistToCloud).toHaveBeenCalledTimes(2);
    expect(deps.flushPendingPersistToCloud).toHaveBeenLastCalledWith('resume:online');
  });

  it('reschedules recovery after a false flush result while pending changes remain', async () => {
    const originalQueueMicrotask = globalThis.queueMicrotask;
    globalThis.queueMicrotask = ((callback: VoidFunction) => {
      void Promise.resolve().then(callback);
    }) as typeof queueMicrotask;
    vi.useFakeTimers();
    const deps = createDeps({
      flushPendingPersistToCloud: vi.fn()
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true),
    });

    try {
      schedulePendingPersistRecovery('online', deps);
      await flushMicrotasks();

      expect(deps.flushPendingPersistToCloud).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1500);
      await flushMicrotasks();

      expect(deps.flushPendingPersistToCloud).toHaveBeenCalledTimes(2);
      expect(deps.flushPendingPersistToCloud).toHaveBeenLastCalledWith('resume:online');
    } finally {
      vi.useRealTimers();
      globalThis.queueMicrotask = originalQueueMicrotask;
    }
  });
});

function createDeps(overrides: Partial<Parameters<typeof schedulePendingPersistRecovery>[1]> = {}) {
  return {
    hasPendingLocalChanges: vi.fn().mockReturnValue(true),
    addBreadcrumb: vi.fn(),
    flushPendingPersistToCloud: vi.fn().mockResolvedValue(false),
    captureException: vi.fn(),
    logger: {
      warn: vi.fn(),
    },
    ...overrides,
  };
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
