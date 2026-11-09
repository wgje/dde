import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TimerHandle, IntervalHandle } from './timer-handle';

describe('TimerHandle', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('should not be active initially', () => {
    const handle = new TimerHandle();
    expect(handle.active).toBe(false);
  });

  it('should become active after schedule', () => {
    const handle = new TimerHandle();
    handle.schedule(() => {}, 100);
    expect(handle.active).toBe(true);
  });

  it('should execute callback after delay', () => {
    const handle = new TimerHandle();
    const fn = vi.fn();
    handle.schedule(fn, 50);
    vi.advanceTimersByTime(50);
    expect(fn).toHaveBeenCalledOnce();
    expect(handle.active).toBe(false);
  });

  it('should cancel previous timer on re-schedule', () => {
    const handle = new TimerHandle();
    const fn1 = vi.fn();
    const fn2 = vi.fn();
    handle.schedule(fn1, 100);
    handle.schedule(fn2, 100);
    vi.advanceTimersByTime(100);
    expect(fn1).not.toHaveBeenCalled();
    expect(fn2).toHaveBeenCalledOnce();
  });

  it('ignores a stale callback after re-schedule keeps a newer timer active', () => {
    const handle = new TimerHandle();
    const fn1 = vi.fn();
    const fn2 = vi.fn();
    const queuedTimeouts = new Map<number, () => void>();
    let nextTimerId = 1;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback: TimerHandler) => {
      const timerId = nextTimerId++;
      queuedTimeouts.set(timerId, callback as () => void);
      return timerId as unknown as ReturnType<typeof setTimeout>;
    });
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout').mockImplementation(() => undefined);

    handle.schedule(fn1, 100);
    handle.schedule(fn2, 100);
    queuedTimeouts.get(1)?.();

    expect(fn1).not.toHaveBeenCalled();
    expect(fn2).not.toHaveBeenCalled();
    expect(handle.active).toBe(true);

    handle.cancel();

    expect(clearTimeoutSpy).toHaveBeenCalledWith(2);
  });

  it('should cancel timer', () => {
    const handle = new TimerHandle();
    const fn = vi.fn();
    handle.schedule(fn, 100);
    handle.cancel();
    expect(handle.active).toBe(false);
    vi.advanceTimersByTime(200);
    expect(fn).not.toHaveBeenCalled();
  });

  it('should clamp negative delay to 0', () => {
    const handle = new TimerHandle();
    const fn = vi.fn();
    handle.schedule(fn, -100);
    vi.advanceTimersByTime(0);
    expect(fn).toHaveBeenCalledOnce();
  });

  it('should clamp NaN delay to 0', () => {
    const handle = new TimerHandle();
    const fn = vi.fn();
    handle.schedule(fn, NaN);
    vi.advanceTimersByTime(0);
    expect(fn).toHaveBeenCalledOnce();
  });

  it('should clamp Infinity delay to 0', () => {
    const handle = new TimerHandle();
    const fn = vi.fn();
    handle.schedule(fn, Infinity);
    vi.advanceTimersByTime(0);
    expect(fn).toHaveBeenCalledOnce();
  });

  it('cancel on inactive handle is a no-op', () => {
    const handle = new TimerHandle();
    expect(() => handle.cancel()).not.toThrow();
  });

  it('should clear internal state even when clearTimeout throws', () => {
    const handle = new TimerHandle();
    handle.schedule(() => {}, 100);
    vi.spyOn(globalThis, 'clearTimeout').mockImplementation(() => {
      throw new Error('timer cleanup unavailable');
    });

    expect(() => handle.cancel()).not.toThrow();
    expect(handle.active).toBe(false);
  });
});

describe('IntervalHandle', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('should not be active initially', () => {
    const handle = new IntervalHandle();
    expect(handle.active).toBe(false);
  });

  it('should become active after start', () => {
    const handle = new IntervalHandle();
    handle.start(() => {}, 100);
    expect(handle.active).toBe(true);
  });

  it('should fire repeatedly', () => {
    const handle = new IntervalHandle();
    const fn = vi.fn();
    handle.start(fn, 50);
    vi.advanceTimersByTime(150);
    expect(fn).toHaveBeenCalledTimes(3);
    handle.stop();
  });

  it('should stop interval', () => {
    const handle = new IntervalHandle();
    const fn = vi.fn();
    handle.start(fn, 50);
    vi.advanceTimersByTime(50);
    handle.stop();
    expect(handle.active).toBe(false);
    vi.advanceTimersByTime(200);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('should stop previous interval on re-start', () => {
    const handle = new IntervalHandle();
    const fn1 = vi.fn();
    const fn2 = vi.fn();
    handle.start(fn1, 50);
    vi.advanceTimersByTime(50);
    handle.start(fn2, 50);
    vi.advanceTimersByTime(100);
    expect(fn1).toHaveBeenCalledTimes(1);
    expect(fn2).toHaveBeenCalledTimes(2);
    handle.stop();
  });

  it('ignores stale interval ticks after re-start keeps a newer interval active', () => {
    const handle = new IntervalHandle();
    const fn1 = vi.fn();
    const fn2 = vi.fn();
    const queuedIntervals = new Map<number, () => void>();
    let nextIntervalId = 1;
    vi.spyOn(globalThis, 'setInterval').mockImplementation((callback: TimerHandler) => {
      const intervalId = nextIntervalId++;
      queuedIntervals.set(intervalId, callback as () => void);
      return intervalId as unknown as ReturnType<typeof setInterval>;
    });
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval').mockImplementation(() => undefined);

    handle.start(fn1, 50);
    handle.start(fn2, 50);
    queuedIntervals.get(1)?.();

    expect(fn1).not.toHaveBeenCalled();
    expect(fn2).not.toHaveBeenCalled();
    expect(handle.active).toBe(true);

    handle.stop();

    expect(clearIntervalSpy).toHaveBeenCalledWith(2);
  });

  it('should clamp non-positive interval to 1ms', () => {
    const handle = new IntervalHandle();
    const fn = vi.fn();
    handle.start(fn, 0);
    vi.advanceTimersByTime(5);
    expect(fn.mock.calls.length).toBeGreaterThanOrEqual(1);
    handle.stop();
  });

  it('stop on inactive handle is a no-op', () => {
    const handle = new IntervalHandle();
    expect(() => handle.stop()).not.toThrow();
  });

  it('should clear internal state even when clearInterval throws', () => {
    const handle = new IntervalHandle();
    handle.start(() => {}, 100);
    vi.spyOn(globalThis, 'clearInterval').mockImplementation(() => {
      throw new Error('interval cleanup unavailable');
    });

    expect(() => handle.stop()).not.toThrow();
    expect(handle.active).toBe(false);
  });
});
