import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  PendingPersistRecoveryController,
  type PendingPersistRecoveryDeps,
} from './app-lifecycle-pending-persist.helpers';

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(resolvePromise => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function createDeps(): PendingPersistRecoveryDeps {
  return {
    hasPendingLocalChanges: vi.fn().mockReturnValue(true),
    addBreadcrumb: vi.fn(),
    flushPendingPersistToCloud: vi.fn().mockResolvedValue(true),
    captureException: vi.fn(),
    logger: { warn: vi.fn() },
  };
}

describe('PendingPersistRecoveryController session reset', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reset 应作废旧微任务且允许新会话立即重新调度', async () => {
    const deps = createDeps();
    const controller = new PendingPersistRecoveryController(deps);

    controller.schedule('online');
    controller.reset();
    controller.schedule('pageshow');
    await flushMicrotasks();

    expect(deps.flushPendingPersistToCloud).toHaveBeenCalledTimes(1);
    expect(deps.flushPendingPersistToCloud).toHaveBeenCalledWith('resume:pageshow');
  });

  it('旧 in-flight finally 不得提前消费新代际 queued reason', async () => {
    const oldFlush = createDeferred<boolean>();
    const currentFlush = createDeferred<boolean>();
    const deps = createDeps();
    vi.mocked(deps.flushPendingPersistToCloud)
      .mockImplementationOnce(() => oldFlush.promise)
      .mockImplementationOnce(() => currentFlush.promise)
      .mockResolvedValueOnce(true);
    const controller = new PendingPersistRecoveryController(deps);

    controller.schedule('online');
    await flushMicrotasks();

    controller.reset();
    controller.schedule('visibility-threshold');
    await flushMicrotasks();
    controller.schedule('pageshow');

    oldFlush.resolve(false);
    await flushMicrotasks();
    expect(deps.flushPendingPersistToCloud).toHaveBeenCalledTimes(2);

    currentFlush.resolve(true);
    await flushMicrotasks();
    expect(deps.flushPendingPersistToCloud).toHaveBeenCalledTimes(3);
    expect(deps.flushPendingPersistToCloud).toHaveBeenLastCalledWith('resume:pageshow');
  });

  it('reset 应取消旧 retry timer 且不永久销毁控制器', async () => {
    const deps = createDeps();
    vi.mocked(deps.flushPendingPersistToCloud)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const controller = new PendingPersistRecoveryController(deps);

    controller.schedule('online');
    await flushMicrotasks();
    controller.reset();

    await vi.advanceTimersByTimeAsync(2_000);
    expect(deps.flushPendingPersistToCloud).toHaveBeenCalledTimes(1);

    controller.schedule('pageshow');
    await flushMicrotasks();
    expect(deps.flushPendingPersistToCloud).toHaveBeenCalledTimes(2);
    expect(deps.flushPendingPersistToCloud).toHaveBeenLastCalledWith('resume:pageshow');
  });

  it('flush rejection 后仍有本地变更时应安排重试', async () => {
    const error = new Error('temporary persist failure');
    const deps = createDeps();
    vi.mocked(deps.flushPendingPersistToCloud)
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce(true);
    const controller = new PendingPersistRecoveryController(deps);

    controller.schedule('online');
    await flushMicrotasks();

    expect(deps.flushPendingPersistToCloud).toHaveBeenCalledTimes(1);
    expect(deps.captureException).toHaveBeenCalledWith(error, {
      operation: 'lifecycle.resume.pending-persist',
      reason: 'online',
    });

    await vi.advanceTimersByTimeAsync(1_500);
    await flushMicrotasks();

    expect(deps.flushPendingPersistToCloud).toHaveBeenCalledTimes(2);
    expect(deps.flushPendingPersistToCloud).toHaveBeenLastCalledWith('resume:online');
  });
});
