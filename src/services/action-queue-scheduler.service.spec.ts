import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ActionQueueSchedulerService } from './action-queue-scheduler.service';
import { LoggerService } from './logger.service';
import type { ActionQueueSchedulerRuntime } from './action-queue-scheduler.service';
import {
  createBrowserNetworkSuspendedError,
  isBrowserNetworkSuspendedError,
  resetBrowserNetworkSuspensionTrackingForTests,
} from '../utils/browser-network-suspension';

function createRuntime(overrides: Partial<ActionQueueSchedulerRuntime> = {}): ActionQueueSchedulerRuntime {
  let online = true;

  return {
    isOnline: () => online,
    setOnline: (nextOnline) => {
      online = nextOnline;
    },
    processQueue: vi.fn().mockResolvedValue(undefined),
    scheduleRetry: vi.fn(),
    clearRetryTimer: vi.fn(),
    ...overrides,
  };
}

describe('ActionQueueSchedulerService', () => {
  let service: ActionQueueSchedulerService;
  let logger: {
    debug: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    resetBrowserNetworkSuspensionTrackingForTests();
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    });
    logger = {
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    TestBed.configureTestingModule({
      providers: [
        ActionQueueSchedulerService,
        {
          provide: LoggerService,
          useValue: {
            category: () => logger,
          },
        },
      ],
    });

    service = TestBed.inject(ActionQueueSchedulerService);
  });

  afterEach(() => {
    service.removeNetworkListeners();
    resetBrowserNetworkSuspensionTrackingForTests();
    vi.restoreAllMocks();
    TestBed.resetTestingModule();
  });

  it('keeps the earlier retry when its timer handle is 0', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1000);
    const timer = 0 as unknown as ReturnType<typeof setTimeout>;
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(() => timer);
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout').mockImplementation(() => undefined);

    service.scheduleRetry(500, vi.fn());
    service.scheduleRetry(1000, vi.fn());

    expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
    expect(clearTimeoutSpy).not.toHaveBeenCalled();
  });

  it('clears retry timer handle 0 explicitly', () => {
    const timer = 0 as unknown as ReturnType<typeof setTimeout>;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(() => timer);
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout').mockImplementation(() => undefined);

    service.scheduleRetry(500, vi.fn());
    service.clearRetryTimer();

    expect(clearTimeoutSpy).toHaveBeenCalledWith(0);
  });

  it('clears pending retry timer when network listeners are removed', () => {
    vi.useFakeTimers();
    const onTimer = vi.fn();

    service.setupNetworkListeners(createRuntime());
    service.scheduleRetry(1000, onTimer);
    service.removeNetworkListeners();
    vi.advanceTimersByTime(1000);

    expect(onTimer).not.toHaveBeenCalled();
  });

  it('leaves no pending retry timer after scheduler teardown', () => {
    vi.useFakeTimers();

    service.scheduleRetry(1000, vi.fn());
    service.removeNetworkListeners();

    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears retry timer when teardown runs without a window object', () => {
    vi.useFakeTimers();
    const onTimer = vi.fn();

    service.scheduleRetry(1000, onTimer);

    vi.stubGlobal('window', undefined);
    try {
      service.removeNetworkListeners();
    } finally {
      vi.unstubAllGlobals();
    }

    vi.advanceTimersByTime(1000);

    expect(onTimer).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ignores a stale retry timer callback after a newer retry replaces it', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1000);
    const queuedTimeouts = new Map<number, () => void>();
    let nextTimerId = 1;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback: TimerHandler) => {
      const timerId = nextTimerId++;
      queuedTimeouts.set(timerId, callback as () => void);
      return timerId as unknown as ReturnType<typeof setTimeout>;
    });
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout').mockImplementation(() => undefined);
    const staleTimer = vi.fn();
    const currentTimer = vi.fn();

    service.scheduleRetry(1000, staleTimer);
    service.scheduleRetry(500, currentTimer);
    queuedTimeouts.get(1)?.();
    service.clearRetryTimer();

    expect(staleTimer).not.toHaveBeenCalled();
    expect(currentTimer).not.toHaveBeenCalled();
    expect(clearTimeoutSpy).toHaveBeenCalledWith(1);
    expect(clearTimeoutSpy).toHaveBeenCalledWith(2);
  });

  it('replaces network listeners on repeated setup and removes the active listeners', async () => {
    const runtime = createRuntime();

    service.setupNetworkListeners(runtime);
    service.setupNetworkListeners(runtime);

    window.dispatchEvent(new Event('online'));
    await Promise.resolve();

    expect(runtime.processQueue).toHaveBeenCalledTimes(1);

    service.removeNetworkListeners();
    window.dispatchEvent(new Event('online'));
    await Promise.resolve();

    expect(runtime.processQueue).toHaveBeenCalledTimes(1);
  });

  it('rolls back already registered network listeners when setup fails midway', async () => {
    const setupError = new Error('initial online sync unavailable');
    let shouldFailInitialSync = true;
    const setOnline = vi.fn((online: boolean) => {
      if (online === navigator.onLine && shouldFailInitialSync) {
        shouldFailInitialSync = false;
        throw setupError;
      }
    });
    const runtime = createRuntime({ setOnline });

    try {
      let thrown: unknown;
      try {
        service.setupNetworkListeners(runtime);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBe(setupError);
      window.dispatchEvent(new Event('online'));
      await Promise.resolve();

      expect(runtime.processQueue).not.toHaveBeenCalled();

      const nextRuntime = createRuntime();
      service.setupNetworkListeners(nextRuntime);
      window.dispatchEvent(new Event('online'));
      await Promise.resolve();

      expect(nextRuntime.processQueue).toHaveBeenCalledTimes(1);
    } finally {
      service.removeNetworkListeners();
    }
  });

  it('restores retry intent when event-triggered queue processing rejects', async () => {
    vi.useFakeTimers();
    const processError = new Error('lease failed');
    const processQueue = vi.fn().mockRejectedValue(processError);
    const runtime = createRuntime({ processQueue });

    service.scheduleRetry(1000, () => service.requestQueueProcessing('retry-timer', runtime));
    service.requestQueueProcessing('online', runtime);
    await Promise.resolve();

    expect(runtime.clearRetryTimer).toHaveBeenCalledOnce();
    expect(runtime.scheduleRetry).toHaveBeenCalledWith(0);
    expect(logger.debug).toHaveBeenCalledWith(
      'ActionQueue scheduler runtime processQueue rejected',
      expect.objectContaining({ reason: 'online' }),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      '队列处理触发失败，保留重试调度',
      expect.objectContaining({ reason: 'online', error: processError }),
    );
  });

  it('does not immediately replay coalesced triggers after queue processing rejects', async () => {
    const processError = new Error('lease failed');
    const flushMicrotasks = async () => {
      for (let i = 0; i < 4; i += 1) {
        await Promise.resolve();
      }
    };
    const processQueue = vi.fn()
      .mockRejectedValueOnce(processError)
      .mockResolvedValueOnce(undefined);
    const runtime = createRuntime({ processQueue });

    service.requestQueueProcessing('online', runtime);
    service.requestQueueProcessing('pageshow', runtime);
    await flushMicrotasks();

    expect(processQueue).toHaveBeenCalledTimes(1);
    expect(runtime.scheduleRetry).toHaveBeenCalledWith(0);
    expect(logger.warn).toHaveBeenCalledWith(
      '队列处理触发失败，保留重试调度',
      expect.objectContaining({ reason: 'online', error: processError }),
    );
  });

  it('isolates retry reschedule failures after event-triggered queue processing rejects', async () => {
    const processError = new Error('lease failed');
    const scheduleError = new Error('retry scheduler failed');
    const flushMicrotasks = async () => {
      for (let i = 0; i < 4; i += 1) {
        await Promise.resolve();
      }
    };
    const processQueue = vi.fn()
      .mockRejectedValueOnce(processError)
      .mockResolvedValueOnce(undefined);
    const scheduleRetry = vi.fn(() => {
      throw scheduleError;
    });
    const runtime = createRuntime({ processQueue, scheduleRetry });

    expect(() => service.requestQueueProcessing('online', runtime)).not.toThrow();
    await flushMicrotasks();

    expect(scheduleRetry).toHaveBeenCalledWith(0);
    expect(logger.warn).toHaveBeenCalledWith(
      '队列处理失败后的重试调度失败，已跳过',
      expect.objectContaining({ reason: 'online', error: scheduleError }),
    );

    service.requestQueueProcessing('visibilitychange', runtime);
    await flushMicrotasks();

    expect(processQueue).toHaveBeenCalledTimes(2);
  });

  it('reschedules retry when queue processing rejection warning logging fails', async () => {
    const processError = new Error('lease failed');
    const loggerError = new Error('logger failed');
    const flushMicrotasks = async () => {
      for (let i = 0; i < 4; i += 1) {
        await Promise.resolve();
      }
    };
    const processQueue = vi.fn().mockRejectedValueOnce(processError);
    const scheduleRetry = vi.fn();
    const runtime = createRuntime({ processQueue, scheduleRetry });
    logger.warn.mockImplementationOnce(() => {
      throw loggerError;
    });

    expect(() => service.requestQueueProcessing('online', runtime)).not.toThrow();
    await flushMicrotasks();

    expect(scheduleRetry).toHaveBeenCalledWith(0);
  });

  it('defers queue processing beyond the browser network suspension window', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1000);
    isBrowserNetworkSuspendedError(createBrowserNetworkSuspendedError());
    const runtime = createRuntime();

    service.requestQueueProcessing('online', runtime);

    expect(runtime.processQueue).not.toHaveBeenCalled();
    expect(runtime.scheduleRetry).toHaveBeenCalledWith(expect.any(Number));
    expect((runtime.scheduleRetry as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toBeGreaterThan(0);
  });

  it('keeps background queue processing deferred when debug logging fails', () => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'hidden',
    });
    const runtime = createRuntime();
    logger.debug.mockImplementationOnce(() => {
      throw new Error('debug failed');
    });

    expect(() => service.requestQueueProcessing('visibilitychange', runtime)).not.toThrow();

    expect(runtime.processQueue).not.toHaveBeenCalled();
    expect(runtime.scheduleRetry).not.toHaveBeenCalled();
  });

  it('keeps deferred retry scheduling when debug logging fails during browser suspension', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1000);
    isBrowserNetworkSuspendedError(createBrowserNetworkSuspendedError());
    const runtime = createRuntime();
    logger.debug.mockImplementationOnce(() => {
      throw new Error('debug failed');
    });

    expect(() => service.requestQueueProcessing('online', runtime)).not.toThrow();

    expect(runtime.processQueue).not.toHaveBeenCalled();
    expect(runtime.scheduleRetry).toHaveBeenCalledWith(expect.any(Number));
  });

  it('restores retry intent and scheduler state when queue processing throws synchronously', async () => {
    const processError = new Error('ctx missing');
    const flushMicrotasks = async () => {
      for (let i = 0; i < 4; i += 1) {
        await Promise.resolve();
      }
    };
    const processQueue = vi.fn()
      .mockImplementationOnce(() => {
        throw processError;
      })
      .mockResolvedValueOnce(undefined);
    const runtime = createRuntime({ processQueue });

    expect(() => service.requestQueueProcessing('online', runtime)).not.toThrow();
    await flushMicrotasks();

    expect(runtime.clearRetryTimer).toHaveBeenCalledOnce();
    expect(runtime.scheduleRetry).toHaveBeenCalledWith(0);
    expect(logger.warn).toHaveBeenCalledWith(
      '队列处理触发失败，保留重试调度',
      expect.objectContaining({ reason: 'online', error: processError }),
    );

    service.requestQueueProcessing('visibilitychange', runtime);
    await flushMicrotasks();

    expect(processQueue).toHaveBeenCalledTimes(2);
  });

  it('keeps queue processing recoverable when retry timer cleanup fails before processing starts', async () => {
    const cleanupError = new Error('retry timer cleanup failed');
    const flushMicrotasks = async () => {
      for (let i = 0; i < 4; i += 1) {
        await Promise.resolve();
      }
    };
    const processQueue = vi.fn().mockResolvedValue(undefined);
    const clearRetryTimer = vi.fn()
      .mockImplementationOnce(() => {
        throw cleanupError;
      })
      .mockImplementation(() => undefined);
    const runtime = createRuntime({ clearRetryTimer, processQueue });

    expect(() => service.requestQueueProcessing('online', runtime)).not.toThrow();
    await flushMicrotasks();

    expect(processQueue).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      '队列处理前清理重试定时器失败，继续处理队列',
      expect.objectContaining({ reason: 'online', error: cleanupError }),
    );

    service.requestQueueProcessing('visibilitychange', runtime);
    await flushMicrotasks();

    expect(processQueue).toHaveBeenCalledTimes(2);
  });

  it('keeps queue processing recoverable when cleanup warning logging also fails', async () => {
    const cleanupError = new Error('retry timer cleanup failed');
    const loggerError = new Error('logger failed');
    const flushMicrotasks = async () => {
      for (let i = 0; i < 4; i += 1) {
        await Promise.resolve();
      }
    };
    const processQueue = vi.fn().mockResolvedValue(undefined);
    const clearRetryTimer = vi.fn()
      .mockImplementationOnce(() => {
        throw cleanupError;
      })
      .mockImplementation(() => undefined);
    const runtime = createRuntime({ clearRetryTimer, processQueue });
    logger.warn.mockImplementationOnce(() => {
      throw loggerError;
    });

    expect(() => service.requestQueueProcessing('online', runtime)).not.toThrow();
    await flushMicrotasks();

    expect(processQueue).toHaveBeenCalledTimes(1);

    service.requestQueueProcessing('visibilitychange', runtime);
    await flushMicrotasks();

    expect(processQueue).toHaveBeenCalledTimes(2);
  });

  it('emits distinguishable scheduler diagnostics for offline, hidden, suspended, coalesced, and accepted requests', async () => {
    const hiddenRuntime = createRuntime();
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    service.requestQueueProcessing('visibilitychange', hiddenRuntime);
    expect(window.__NANOFLOW_STARTUP_TRACE__).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: 'action_queue.scheduler_decision', data: { reason: 'visibilitychange', decision: 'hidden' } }),
    ]));
    expect(logger.debug).toHaveBeenCalledWith(
      'ActionQueue scheduler request',
      expect.objectContaining({ reason: 'visibilitychange', decision: 'hidden' }),
    );

    const suspendedRuntime = createRuntime();
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    vi.spyOn(Date, 'now').mockReturnValue(1000);
    isBrowserNetworkSuspendedError(createBrowserNetworkSuspendedError());
    service.requestQueueProcessing('online', suspendedRuntime);
    expect(window.__NANOFLOW_STARTUP_TRACE__).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: 'action_queue.scheduler_decision', data: { reason: 'online', decision: 'suspended' } }),
    ]));
    expect(logger.debug).toHaveBeenCalledWith(
      'ActionQueue scheduler request',
      expect.objectContaining({ reason: 'online', decision: 'suspended' }),
    );
    expect(suspendedRuntime.processQueue).not.toHaveBeenCalled();
    resetBrowserNetworkSuspensionTrackingForTests();

    const offlineRuntime = createRuntime({ isOnline: () => false });
    service.requestQueueProcessing('online', offlineRuntime);
    expect(window.__NANOFLOW_STARTUP_TRACE__).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: 'action_queue.scheduler_decision', data: { reason: 'online', decision: 'offline' } }),
    ]));
    expect(logger.debug).toHaveBeenCalledWith(
      'ActionQueue scheduler request',
      expect.objectContaining({ reason: 'online', decision: 'offline' }),
    );

    const acceptedRuntime = createRuntime();
    service.requestQueueProcessing('storage-event', acceptedRuntime);
    expect(window.__NANOFLOW_STARTUP_TRACE__).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: 'action_queue.scheduler_decision', data: { reason: 'storage-event', decision: 'accepted' } }),
      expect.objectContaining({ event: 'action_queue.scheduler_process_invoked', data: { reason: 'storage-event' } }),
    ]));
    expect(logger.debug).toHaveBeenCalledWith(
      'ActionQueue scheduler request',
      expect.objectContaining({ reason: 'storage-event', decision: 'accepted' }),
    );
    expect(logger.debug).toHaveBeenCalledWith(
      'ActionQueue scheduler runtime processQueue invoked',
      expect.objectContaining({ reason: 'storage-event', decision: 'accepted' }),
    );
    expect(acceptedRuntime.processQueue).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    expect(window.__NANOFLOW_STARTUP_TRACE__).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: 'action_queue.scheduler_process_finished', data: { reason: 'storage-event' } }),
    ]));
    expect(logger.debug).toHaveBeenCalledWith(
      'ActionQueue scheduler runtime processQueue resolved',
      expect.objectContaining({ reason: 'storage-event' }),
    );

    const activeRuntime = createRuntime({
      processQueue: vi.fn().mockImplementation(() => new Promise<void>(() => {})),
    });
    service.requestQueueProcessing('online', activeRuntime);
    service.requestQueueProcessing('pageshow', activeRuntime);
    expect(window.__NANOFLOW_STARTUP_TRACE__).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: 'action_queue.scheduler_decision', data: { reason: 'pageshow', decision: 'coalesced' } }),
    ]));
    expect(logger.debug).toHaveBeenCalledWith(
      'ActionQueue scheduler request',
      expect.objectContaining({ reason: 'pageshow', decision: 'coalesced' }),
    );
  });

  it('coalesces event-triggered queue processing while a previous run is still active', async () => {
    const processingResolvers: Array<() => void> = [];
    const flushMicrotasks = async () => {
      for (let i = 0; i < 4; i += 1) {
        await Promise.resolve();
      }
    };
    const processQueue = vi.fn().mockImplementation(() => new Promise<void>(resolve => {
      processingResolvers.push(resolve);
    }));
    const runtime = createRuntime({ processQueue });

    service.requestQueueProcessing('online', runtime);
    service.requestQueueProcessing('pageshow', runtime);
    await Promise.resolve();

    expect(processQueue).toHaveBeenCalledTimes(1);
    expect(logger.debug).toHaveBeenCalledWith(
      '队列处理已在进行，合并重复触发',
      expect.objectContaining({ reason: 'pageshow' }),
    );

    expect(processingResolvers).toHaveLength(1);
    processingResolvers.shift()?.();
    await flushMicrotasks();

    expect(processQueue).toHaveBeenCalledTimes(2);

    service.requestQueueProcessing('visibilitychange', runtime);
    await Promise.resolve();

    expect(processQueue).toHaveBeenCalledTimes(2);
    processingResolvers.shift()?.();
    await flushMicrotasks();

    expect(processQueue).toHaveBeenCalledTimes(3);
    processingResolvers.shift()?.();
    await flushMicrotasks();
  });

  it('keeps coalesced queue processing pending when duplicate-trigger debug logging fails', async () => {
    const processingResolvers: Array<() => void> = [];
    const flushMicrotasks = async () => {
      for (let i = 0; i < 4; i += 1) {
        await Promise.resolve();
      }
    };
    const processQueue = vi.fn().mockImplementation(() => new Promise<void>(resolve => {
      processingResolvers.push(resolve);
    }));
    const runtime = createRuntime({ processQueue });

    service.requestQueueProcessing('online', runtime);
    await Promise.resolve();
    logger.debug.mockImplementationOnce(() => {
      throw new Error('debug failed');
    });

    expect(() => service.requestQueueProcessing('pageshow', runtime)).not.toThrow();

    expect(processQueue).toHaveBeenCalledTimes(1);
    processingResolvers.shift()?.();
    await flushMicrotasks();

    expect(processQueue).toHaveBeenCalledTimes(2);
  });

  it('drops coalesced queue processing after network listeners are removed', async () => {
    const processingResolvers: Array<() => void> = [];
    const flushMicrotasks = async () => {
      for (let i = 0; i < 4; i += 1) {
        await Promise.resolve();
      }
    };
    const processQueue = vi.fn().mockImplementation(() => new Promise<void>(resolve => {
      processingResolvers.push(resolve);
    }));
    const runtime = createRuntime({ processQueue });

    service.requestQueueProcessing('online', runtime);
    service.requestQueueProcessing('pageshow', runtime);
    await Promise.resolve();

    service.removeNetworkListeners();
    processingResolvers.shift()?.();
    await flushMicrotasks();

    expect(processQueue).toHaveBeenCalledTimes(1);
  });

  it('isolates retry timer callback failures and allows later retry scheduling', () => {
    vi.useFakeTimers();
    const timerError = new Error('timer failed');
    const failingTimer = vi.fn(() => {
      throw timerError;
    });
    const nextTimer = vi.fn();

    service.scheduleRetry(1000, failingTimer);
    expect(() => vi.advanceTimersByTime(1000)).not.toThrow();
    service.scheduleRetry(1000, nextTimer);

    expect(failingTimer).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalledWith(
      '队列重试定时器执行失败',
      expect.objectContaining({ error: timerError }),
    );
    expect(nextTimer).not.toHaveBeenCalled();
  });
});
