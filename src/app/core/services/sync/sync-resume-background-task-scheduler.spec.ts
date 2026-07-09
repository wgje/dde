import { afterEach, describe, expect, it, vi } from 'vitest';

import { SyncResumeBackgroundTaskScheduler } from './sync-resume-background-task-scheduler';

describe('SyncResumeBackgroundTaskScheduler', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('keeps retry continuation backoff as a minimum delay even when idle callback fires immediately', () => {
    vi.useFakeTimers();
    const runSlice = vi.fn();
    const scheduler = new SyncResumeBackgroundTaskScheduler();
    const requestIdleCallback = vi.fn((callback: IdleRequestCallback) => {
      callback({
        didTimeout: false,
        timeRemaining: () => 50,
      });
      return 1;
    });

    vi.stubGlobal('requestIdleCallback', requestIdleCallback);
    vi.stubGlobal('cancelIdleCallback', vi.fn());

    scheduler.scheduleRetryContinuation(runSlice, 200);

    expect(requestIdleCallback).not.toHaveBeenCalled();
    expect(runSlice).not.toHaveBeenCalled();

    vi.advanceTimersByTime(199);
    expect(runSlice).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(requestIdleCallback).toHaveBeenCalledOnce();
    expect(runSlice).toHaveBeenCalledOnce();
  });

  it('does not run a queued idle retry continuation after cancelAll', () => {
    vi.useFakeTimers();
    const runSlice = vi.fn();
    const scheduler = new SyncResumeBackgroundTaskScheduler();
    let queuedIdleCallback: IdleRequestCallback | null = null;
    const requestIdleCallback = vi.fn((callback: IdleRequestCallback) => {
      queuedIdleCallback = callback;
      return 1;
    });

    vi.stubGlobal('requestIdleCallback', requestIdleCallback);
    vi.stubGlobal('cancelIdleCallback', vi.fn());

    scheduler.scheduleRetryContinuation(runSlice, 200);
    vi.advanceTimersByTime(200);

    expect(queuedIdleCallback).toBeTypeOf('function');

    scheduler.cancelAll();
    queuedIdleCallback!({
      didTimeout: false,
      timeRemaining: () => 50,
    });

    expect(runSlice).not.toHaveBeenCalled();
  });

  it('runs a queued idle retry continuation at most once if the idle callback is replayed', () => {
    vi.useFakeTimers();
    const runSlice = vi.fn();
    const scheduler = new SyncResumeBackgroundTaskScheduler();
    let queuedIdleCallback: IdleRequestCallback | null = null;
    const requestIdleCallback = vi.fn((callback: IdleRequestCallback) => {
      queuedIdleCallback = callback;
      return 1;
    });

    vi.stubGlobal('requestIdleCallback', requestIdleCallback);
    vi.stubGlobal('cancelIdleCallback', vi.fn());

    scheduler.scheduleRetryContinuation(runSlice, 200);
    vi.advanceTimersByTime(200);

    expect(queuedIdleCallback).toBeTypeOf('function');

    queuedIdleCallback!({
      didTimeout: false,
      timeRemaining: () => 50,
    });
    queuedIdleCallback!({
      didTimeout: false,
      timeRemaining: () => 50,
    });

    expect(runSlice).toHaveBeenCalledOnce();
  });

  it('isolates retry continuation callback failures from the background scheduler', () => {
    vi.useFakeTimers();
    const callbackError = new Error('retry continuation failed');
    const runSlice = vi.fn(() => {
      throw callbackError;
    });
    const onTaskError = vi.fn();
    const scheduler = new SyncResumeBackgroundTaskScheduler({ onTaskError });
    let queuedIdleCallback: IdleRequestCallback | null = null;
    const requestIdleCallback = vi.fn((callback: IdleRequestCallback) => {
      queuedIdleCallback = callback;
      return 1;
    });

    vi.stubGlobal('requestIdleCallback', requestIdleCallback);
    vi.stubGlobal('cancelIdleCallback', vi.fn());

    scheduler.scheduleRetryContinuation(runSlice, 200);
    vi.advanceTimersByTime(200);

    expect(queuedIdleCallback).toBeTypeOf('function');
    expect(() => queuedIdleCallback!({
      didTimeout: false,
      timeRemaining: () => 50,
    })).not.toThrow();
    expect(runSlice).toHaveBeenCalledOnce();
    expect(onTaskError).toHaveBeenCalledWith('retry-continuation', callbackError);
  });

  it('falls back to running retry continuation when requestIdleCallback scheduling fails', () => {
    vi.useFakeTimers();
    const runSlice = vi.fn();
    const scheduler = new SyncResumeBackgroundTaskScheduler();
    const requestIdleCallback = vi.fn(() => {
      throw new Error('idle callback unavailable');
    });

    vi.stubGlobal('requestIdleCallback', requestIdleCallback);
    vi.stubGlobal('cancelIdleCallback', vi.fn());

    scheduler.scheduleRetryContinuation(runSlice, 200);

    expect(() => vi.advanceTimersByTime(200)).not.toThrow();
    expect(requestIdleCallback).toHaveBeenCalledOnce();
    expect(runSlice).toHaveBeenCalledOnce();
  });

  it('cancelAll cancels the queued idle retry continuation callback', () => {
    vi.useFakeTimers();
    const runSlice = vi.fn();
    const scheduler = new SyncResumeBackgroundTaskScheduler();
    const requestIdleCallback = vi.fn(() => 0);
    const cancelIdleCallback = vi.fn();

    vi.stubGlobal('requestIdleCallback', requestIdleCallback);
    vi.stubGlobal('cancelIdleCallback', cancelIdleCallback);

    scheduler.scheduleRetryContinuation(runSlice, 200);
    vi.advanceTimersByTime(200);
    scheduler.cancelAll();

    expect(cancelIdleCallback).toHaveBeenCalledWith(0);
    expect(runSlice).not.toHaveBeenCalled();
  });

  it('clears the queued idle retry handle when cancelAll runs without window', () => {
    vi.useFakeTimers();
    const runSlice = vi.fn();
    const scheduler = new SyncResumeBackgroundTaskScheduler();
    const windowRef = window;
    const requestIdleCallback = vi.fn(() => 0);
    const cancelIdleCallback = vi.fn();

    vi.stubGlobal('requestIdleCallback', requestIdleCallback);
    vi.stubGlobal('cancelIdleCallback', cancelIdleCallback);

    scheduler.scheduleRetryContinuation(runSlice, 200);
    vi.advanceTimersByTime(200);

    expect(requestIdleCallback).toHaveBeenCalledOnce();

    vi.stubGlobal('window', undefined);
    scheduler.cancelAll();

    vi.stubGlobal('window', windowRef);
    scheduler.scheduleRetryContinuation(runSlice, 200);

    expect(cancelIdleCallback).not.toHaveBeenCalled();
    expect(runSlice).not.toHaveBeenCalled();
  });

  it('cancelAll continues clearing remote probe fallback when idle cancellation fails', () => {
    vi.useFakeTimers();
    const runSlice = vi.fn();
    const runProbe = vi.fn();
    const scheduler = new SyncResumeBackgroundTaskScheduler();
    const cancelIdleError = new Error('cancel idle failed');
    const requestIdleCallback = vi.fn(() => 0);
    const cancelIdleCallback = vi.fn(() => {
      throw cancelIdleError;
    });

    vi.stubGlobal('requestIdleCallback', requestIdleCallback);
    vi.stubGlobal('cancelIdleCallback', cancelIdleCallback);

    scheduler.scheduleRetryContinuation(runSlice, 200);
    vi.advanceTimersByTime(200);
    scheduler.scheduleRemoteProbeFallback(runProbe, 200);

    expect(() => scheduler.cancelAll()).not.toThrow();
    vi.advanceTimersByTime(200);

    expect(cancelIdleCallback).toHaveBeenCalledWith(0);
    expect(runSlice).not.toHaveBeenCalled();
    expect(runProbe).not.toHaveBeenCalled();
  });

  it('cancelRemoteProbeFallback preserves queued retry continuation callbacks', () => {
    vi.useFakeTimers();
    const runSlice = vi.fn();
    const runProbe = vi.fn();
    const scheduler = new SyncResumeBackgroundTaskScheduler();

    scheduler.scheduleRetryContinuation(runSlice, 200);
    scheduler.scheduleRemoteProbeFallback(runProbe, 200);

    scheduler.cancelRemoteProbeFallback();
    vi.advanceTimersByTime(200);

    expect(runSlice).toHaveBeenCalledOnce();
    expect(runProbe).not.toHaveBeenCalled();
  });

  it('ignores a stale retry backoff callback after a newer continuation is scheduled', () => {
    const runSlice = vi.fn();
    const scheduler = new SyncResumeBackgroundTaskScheduler();
    const queuedTimeouts = new Map<number, () => void>();
    let nextTimerId = 1;
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
      .mockImplementation((callback: TimerHandler) => {
        const timerId = nextTimerId++;
        queuedTimeouts.set(timerId, callback as () => void);
        return timerId as unknown as ReturnType<typeof setTimeout>;
      });
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout').mockImplementation(() => undefined);
    const requestIdleCallback = vi.fn(() => 10);

    vi.stubGlobal('requestIdleCallback', requestIdleCallback);
    vi.stubGlobal('cancelIdleCallback', vi.fn());

    scheduler.scheduleRetryContinuation(runSlice, 200);
    scheduler.scheduleRetryContinuation(runSlice, 200);
    queuedTimeouts.get(1)?.();
    scheduler.cancelAll();

    expect(setTimeoutSpy).toHaveBeenCalledTimes(2);
    expect(clearTimeoutSpy).toHaveBeenCalledWith(1);
    expect(clearTimeoutSpy).toHaveBeenCalledWith(2);
    expect(requestIdleCallback).not.toHaveBeenCalled();
    expect(runSlice).not.toHaveBeenCalled();
  });

  it('does not run a queued remote probe fallback after cancelAll', () => {
    const runProbe = vi.fn();
    const scheduler = new SyncResumeBackgroundTaskScheduler();
    let queuedTimeout: (() => void) | null = null;
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback: TimerHandler) => {
      queuedTimeout = callback as () => void;
      return 1 as unknown as ReturnType<typeof setTimeout>;
    });
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout').mockImplementation(() => undefined);

    scheduler.scheduleRemoteProbeFallback(runProbe, 200);
    expect(setTimeoutSpy).toHaveBeenCalledOnce();
    expect(queuedTimeout).toBeTypeOf('function');

    scheduler.cancelAll();
    queuedTimeout!();

    expect(clearTimeoutSpy).toHaveBeenCalledWith(1);
    expect(runProbe).not.toHaveBeenCalled();
  });

  it('runs a queued remote probe fallback at most once if the timeout callback is replayed', () => {
    const runProbe = vi.fn();
    const scheduler = new SyncResumeBackgroundTaskScheduler();
    let queuedTimeout: (() => void) | null = null;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback: TimerHandler) => {
      queuedTimeout = callback as () => void;
      return 1 as unknown as ReturnType<typeof setTimeout>;
    });

    scheduler.scheduleRemoteProbeFallback(runProbe, 200);
    expect(queuedTimeout).toBeTypeOf('function');

    queuedTimeout!();
    queuedTimeout!();

    expect(runProbe).toHaveBeenCalledOnce();
  });

  it('isolates remote probe fallback callback failures from the background scheduler', () => {
    const callbackError = new Error('remote probe failed');
    const runProbe = vi.fn(() => {
      throw callbackError;
    });
    const onTaskError = vi.fn();
    const scheduler = new SyncResumeBackgroundTaskScheduler({ onTaskError });
    let queuedTimeout: (() => void) | null = null;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback: TimerHandler) => {
      queuedTimeout = callback as () => void;
      return 1 as unknown as ReturnType<typeof setTimeout>;
    });

    scheduler.scheduleRemoteProbeFallback(runProbe, 200);
    expect(queuedTimeout).toBeTypeOf('function');

    expect(() => queuedTimeout!()).not.toThrow();

    expect(runProbe).toHaveBeenCalledOnce();
    expect(onTaskError).toHaveBeenCalledWith('remote-probe-fallback', callbackError);
  });

  it('clears a remote probe fallback timeout when the handle is 0', () => {
    const runProbe = vi.fn();
    const scheduler = new SyncResumeBackgroundTaskScheduler();
    const remoteProbeTimer = 0 as unknown as ReturnType<typeof setTimeout>;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(() => remoteProbeTimer);
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout').mockImplementation(() => undefined);

    scheduler.scheduleRemoteProbeFallback(runProbe, 200);
    scheduler.cancelAll();

    expect(clearTimeoutSpy).toHaveBeenCalledWith(0);
    expect(runProbe).not.toHaveBeenCalled();
  });
});
