import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TimerHandle, IntervalHandle } from './timer-handle';

describe('TimerHandle', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

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
});

describe('IntervalHandle', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

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
});
