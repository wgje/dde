import { afterEach, describe, expect, it, vi } from 'vitest';

import { RetryQueueRunnerLifecycleController } from './retry-queue-runner-lifecycle.controller';

function createController(overrides: Partial<ConstructorParameters<
  typeof RetryQueueRunnerLifecycleController
>[0]> = {}) {
  let timer: ReturnType<typeof setInterval> | null = null;
  let processing = true;
  const options: ConstructorParameters<typeof RetryQueueRunnerLifecycleController>[0] = {
    isLifecycleClosed: vi.fn(() => false),
    isSessionExpired: vi.fn(() => false),
    isOnline: vi.fn(() => true),
    queueLength: vi.fn(() => 2),
    processQueue: vi.fn().mockResolvedValue(undefined),
    currentTimer: () => timer,
    setTimer: value => {
      timer = value;
    },
    isProcessing: () => processing,
    setProcessing: value => {
      processing = value;
    },
    lastProcessTime: vi.fn(() => 100),
    processTimeoutMs: 200,
    now: vi.fn(() => 400),
    checkCircuitBreaker: vi.fn(() => true),
    processQueueSlice: vi.fn().mockResolvedValue({
      completed: true,
      durationMs: 0,
      processed: 0,
      remaining: 0,
    }),
    isBrowserNetworkSuspendedWindow: vi.fn(() => false),
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    captureException: vi.fn(),
    warn: vi.fn(),
    ...overrides,
  };

  return {
    controller: new RetryQueueRunnerLifecycleController(options),
    get processing() {
      return processing;
    },
    get timer() {
      return timer;
    },
    options,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('RetryQueueRunnerLifecycleController', () => {
  it('runs the queue on the configured interval and clears the timer on stop', async () => {
    vi.useFakeTimers();
    const context = createController();

    context.controller.startLoop(1_000);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(context.options.processQueue).toHaveBeenCalledOnce();
    expect(context.timer).not.toBeNull();

    context.controller.stopLoop();

    expect(context.timer).toBeNull();
  });

  it('skips interval processing when the session is expired', async () => {
    vi.useFakeTimers();
    const context = createController({
      isSessionExpired: vi.fn(() => true),
    });

    context.controller.startLoop(1_000);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(context.options.processQueue).not.toHaveBeenCalled();
  });

  it('releases a stale processing lock and reports the elapsed time', () => {
    const context = createController();

    expect(context.controller.tryReleaseStaleProcessingLock()).toBe(true);

    expect(context.processing).toBe(false);
    expect(context.options.warn).toHaveBeenCalledWith(
      'processQueueSlice 处理锁超时，强制释放',
      { lastProcessTime: 100, elapsed: 300 },
    );
  });

  it('creates slice results with the current queue length', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const context = createController({
      queueLength: vi.fn(() => 3),
    });

    expect(context.controller.createSliceResult(900, true, 2)).toEqual({
      completed: true,
      durationMs: 100,
      processed: 2,
      remaining: 3,
    });
  });

  it('recovers a stale lock by retrying the slice once with forced recovery', async () => {
    const context = createController();

    await context.controller.recoverStaleProcessingLock({}, 350);

    expect(context.options.processQueueSlice).toHaveBeenCalledWith({
      _forcedRecovery: true,
    });
  });

  it('returns an incomplete result when forced stale-lock recovery times out again', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(400);
    const context = createController();

    await expect(context.controller.recoverStaleProcessingLock({
      _forcedRecovery: true,
    }, 350)).resolves.toEqual({
      completed: false,
      durationMs: 50,
      processed: 0,
      remaining: 2,
    });
    expect(context.options.error).toHaveBeenCalledTimes(1);
  });

  it('skips retry slices during the browser suspension window', () => {
    vi.useFakeTimers();
    vi.setSystemTime(400);
    const context = createController({
      isBrowserNetworkSuspendedWindow: vi.fn(() => true),
    });

    expect(context.controller.skipQueueSliceForSuspendedWindow({}, 350)).toEqual({
      completed: false,
      durationMs: 50,
      processed: 0,
      remaining: 2,
    });
    expect(context.options.debug).toHaveBeenCalledTimes(1);
  });

  it('captures unhandled slice errors and returns an incomplete result', () => {
    vi.useFakeTimers();
    vi.setSystemTime(400);
    const context = createController();
    const error = new Error('slice failed');

    expect(context.controller.handleQueueSliceError(error, 350)).toEqual({
      completed: false,
      durationMs: 50,
      processed: 0,
      remaining: 2,
    });
    expect(context.options.captureException).toHaveBeenCalledWith(error, {
      tags: { operation: 'retryQueue.processQueueSlice' },
      extra: { queueSize: 2 },
    });
  });

  it('isolates lease release failures', async () => {
    const context = createController();
    const error = new Error('release failed');

    await context.controller.releaseQueueSliceLease({
      release: vi.fn().mockRejectedValue(error),
    });

    expect(context.options.warn).toHaveBeenCalledWith('sync writer lease 释放失败', error);
  });
});
