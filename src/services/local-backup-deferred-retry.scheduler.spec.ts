import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LocalBackupDeferredRetryScheduler } from './local-backup-deferred-retry.scheduler';

describe('LocalBackupDeferredRetryScheduler', () => {
  let isEnabled: ReturnType<typeof vi.fn<() => boolean>>;
  let hasProjectsProvider: ReturnType<typeof vi.fn<() => boolean>>;
  let runRetry: ReturnType<typeof vi.fn<() => void>>;
  let scheduler: LocalBackupDeferredRetryScheduler;

  beforeEach(() => {
    vi.useFakeTimers();
    isEnabled = vi.fn<() => boolean>(() => true);
    hasProjectsProvider = vi.fn<() => boolean>(() => true);
    runRetry = vi.fn<() => void>();
    scheduler = new LocalBackupDeferredRetryScheduler({
      isEnabled,
      hasProjectsProvider,
      runRetry,
      getRemainingResumeDelayMs: () => 150,
    });
  });

  afterEach(() => {
    scheduler.clear();
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  });

  it('arms a single retry timer while visible', () => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });

    scheduler.schedule();
    scheduler.schedule();
    vi.advanceTimersByTime(199);

    expect(runRetry).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);

    expect(runRetry).toHaveBeenCalledTimes(1);
  });

  it('waits for visibility before arming the retry timer', () => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });

    scheduler.schedule();
    vi.advanceTimersByTime(1000);

    expect(runRetry).not.toHaveBeenCalled();

    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
    vi.advanceTimersByTime(200);

    expect(runRetry).toHaveBeenCalledTimes(1);
  });

  it('defers an armed retry if the page becomes hidden before the timer fires', () => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });

    scheduler.schedule();
    vi.advanceTimersByTime(199);
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    vi.advanceTimersByTime(1);

    expect(runRetry).not.toHaveBeenCalled();

    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
    vi.advanceTimersByTime(200);

    expect(runRetry).toHaveBeenCalledTimes(1);
  });

  it('does not schedule when auto backup is disabled or projects provider is missing', () => {
    isEnabled.mockReturnValue(false);
    scheduler.schedule();
    vi.advanceTimersByTime(1000);
    expect(runRetry).not.toHaveBeenCalled();

    isEnabled.mockReturnValue(true);
    hasProjectsProvider.mockReturnValue(false);
    scheduler.schedule();
    vi.advanceTimersByTime(1000);
    expect(runRetry).not.toHaveBeenCalled();
  });

  it('clear cancels pending timers and visibility listeners', () => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });

    scheduler.schedule();
    scheduler.clear();
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
    vi.advanceTimersByTime(1000);

    expect(runRetry).not.toHaveBeenCalled();
  });

  it('treats retry timer handle 0 as an active pending retry', () => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    const retryTimer = 0 as unknown as ReturnType<typeof setTimeout>;
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(() => retryTimer);
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout').mockImplementation(() => undefined);

    try {
      scheduler.schedule();
      scheduler.schedule();
      scheduler.clear();

      expect(setTimeoutSpy).toHaveBeenCalledOnce();
      expect(clearTimeoutSpy).toHaveBeenCalledWith(0);
    } finally {
      setTimeoutSpy.mockRestore();
      clearTimeoutSpy.mockRestore();
    }
  });

  it('clear invalidates a captured visibility retry callback before it can arm a timer', () => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    let capturedVisibilityHandler: EventListener | null = null;
    const addEventListenerSpy = vi
      .spyOn(document, 'addEventListener')
      .mockImplementation((type, listener, options) => {
        if (type === 'visibilitychange') {
          capturedVisibilityHandler = listener as EventListener;
        }
        return Document.prototype.addEventListener.call(document, type, listener, options);
      });

    try {
      scheduler.schedule();

      expect(capturedVisibilityHandler).toBeTypeOf('function');

      scheduler.clear();
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
      capturedVisibilityHandler!(new Event('visibilitychange'));
      vi.advanceTimersByTime(1000);

      expect(runRetry).not.toHaveBeenCalled();
    } finally {
      addEventListenerSpy.mockRestore();
    }
  });

  it('does not run a deferred retry when auto backup is disabled before the timer fires', () => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });

    scheduler.schedule();
    isEnabled.mockReturnValue(false);
    vi.advanceTimersByTime(200);

    expect(runRetry).not.toHaveBeenCalled();
  });
});
