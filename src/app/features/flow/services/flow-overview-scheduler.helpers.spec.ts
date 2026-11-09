import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  OverviewBindingsScheduler,
  OverviewViewportUpdateScheduler,
} from './flow-overview-scheduler.helpers';

interface OverviewUpdateTarget {
  requestUpdate: () => void;
  updateAllTargetBindings: () => void;
}

function createOverviewTarget(): OverviewUpdateTarget {
  return {
    requestUpdate: vi.fn(),
    updateAllTargetBindings: vi.fn(),
  };
}

describe('OverviewBindingsScheduler', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  function stubTimeoutHandles(...handles: Array<ReturnType<typeof setTimeout>>) {
    const pendingHandles = [...handles];
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(() => {
      const nextHandle = pendingHandles.shift();
      if (nextHandle === undefined) {
        throw new Error('Unexpected setTimeout call');
      }
      return nextHandle;
    });
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout').mockImplementation(() => undefined);

    return { clearTimeoutSpy, setTimeoutSpy };
  }

  it('runs immediate binding updates once per drag throttle window', () => {
    vi.useFakeTimers();
    const scheduler = new OverviewBindingsScheduler({
      dragThrottleMs: 16,
      idleThrottleMs: 96,
    });
    const overview = createOverviewTarget();

    scheduler.schedule('immediate', () => overview);
    scheduler.schedule('immediate', () => overview);

    expect(overview.updateAllTargetBindings).toHaveBeenCalledOnce();
    expect(overview.requestUpdate).toHaveBeenCalledOnce();

    vi.advanceTimersByTime(16);
    scheduler.schedule('immediate', () => overview);

    expect(overview.updateAllTargetBindings).toHaveBeenCalledTimes(2);
    expect(overview.requestUpdate).toHaveBeenCalledTimes(2);
  });

  it('coalesces deferred binding updates and re-reads the overview at flush time', () => {
    vi.useFakeTimers();
    const scheduler = new OverviewBindingsScheduler({
      dragThrottleMs: 16,
      idleThrottleMs: 96,
    });
    const overview = createOverviewTarget();
    let currentOverview: OverviewUpdateTarget | null = overview;

    scheduler.schedule('deferred', () => currentOverview);
    scheduler.schedule('deferred', () => currentOverview);

    expect(overview.updateAllTargetBindings).not.toHaveBeenCalled();

    vi.advanceTimersByTime(95);
    expect(overview.updateAllTargetBindings).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(overview.updateAllTargetBindings).toHaveBeenCalledOnce();
    expect(overview.requestUpdate).toHaveBeenCalledOnce();

    scheduler.schedule('deferred', () => currentOverview);
    currentOverview = null;
    vi.advanceTimersByTime(96);

    expect(overview.updateAllTargetBindings).toHaveBeenCalledOnce();
    expect(overview.requestUpdate).toHaveBeenCalledOnce();
  });

  it('cancels pending deferred binding updates', () => {
    vi.useFakeTimers();
    const scheduler = new OverviewBindingsScheduler({
      dragThrottleMs: 16,
      idleThrottleMs: 96,
    });
    const overview = createOverviewTarget();

    scheduler.schedule('deferred', () => overview);
    scheduler.cancelPendingRefresh();
    vi.advanceTimersByTime(96);

    expect(overview.updateAllTargetBindings).not.toHaveBeenCalled();

    scheduler.schedule('immediate', () => overview);

    expect(overview.updateAllTargetBindings).toHaveBeenCalledOnce();
    expect(overview.requestUpdate).toHaveBeenCalledOnce();
  });

  it('clears pending deferred binding timer even when the browser timer handle is 0', () => {
    const { clearTimeoutSpy, setTimeoutSpy } = stubTimeoutHandles(
      0 as unknown as ReturnType<typeof setTimeout>,
    );
    const scheduler = new OverviewBindingsScheduler({
      dragThrottleMs: 16,
      idleThrottleMs: 96,
    });
    const overview = createOverviewTarget();

    scheduler.schedule('deferred', () => overview);
    scheduler.cancelPendingRefresh();

    expect(setTimeoutSpy).toHaveBeenCalledOnce();
    expect(clearTimeoutSpy).toHaveBeenCalledWith(0);
  });

  it('replaces a pending deferred binding timer before immediate refresh when its handle is 0', () => {
    const { clearTimeoutSpy } = stubTimeoutHandles(
      0 as unknown as ReturnType<typeof setTimeout>,
      7 as unknown as ReturnType<typeof setTimeout>,
    );
    const scheduler = new OverviewBindingsScheduler({
      dragThrottleMs: 16,
      idleThrottleMs: 96,
    });
    const overview = createOverviewTarget();

    scheduler.schedule('deferred', () => overview);
    scheduler.schedule('immediate', () => overview);

    expect(clearTimeoutSpy).toHaveBeenCalledWith(0);
    expect(overview.updateAllTargetBindings).toHaveBeenCalledOnce();
    expect(overview.requestUpdate).toHaveBeenCalledOnce();
  });

  it('resets immediate pending state when binding update throws', () => {
    vi.useFakeTimers();
    const scheduler = new OverviewBindingsScheduler({
      dragThrottleMs: 16,
      idleThrottleMs: 96,
    });
    const failingOverview = createOverviewTarget();
    failingOverview.updateAllTargetBindings = vi.fn(() => {
      throw new Error('binding update failed');
    });
    const recoveredOverview = createOverviewTarget();

    expect(() => scheduler.schedule('immediate', () => failingOverview)).toThrow(
      'binding update failed',
    );

    scheduler.schedule('immediate', () => recoveredOverview);

    expect(recoveredOverview.updateAllTargetBindings).toHaveBeenCalledOnce();
    expect(recoveredOverview.requestUpdate).toHaveBeenCalledOnce();
  });

  it('contains immediate binding update errors through the optional error handler and recovers', () => {
    vi.useFakeTimers();
    const errors: unknown[] = [];
    const scheduler = new OverviewBindingsScheduler({
      dragThrottleMs: 16,
      idleThrottleMs: 96,
      onUpdateError: error => errors.push(error),
    });
    const failingOverview = createOverviewTarget();
    failingOverview.updateAllTargetBindings = vi.fn(() => {
      throw new Error('immediate binding update failed');
    });
    const recoveredOverview = createOverviewTarget();

    expect(() => scheduler.schedule('immediate', () => failingOverview)).not.toThrow();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(Error);

    scheduler.schedule('immediate', () => recoveredOverview);

    expect(recoveredOverview.updateAllTargetBindings).toHaveBeenCalledOnce();
    expect(recoveredOverview.requestUpdate).toHaveBeenCalledOnce();
  });

  it('resets deferred pending state when binding update throws', () => {
    vi.useFakeTimers();
    const scheduler = new OverviewBindingsScheduler({
      dragThrottleMs: 16,
      idleThrottleMs: 96,
    });
    const failingOverview = createOverviewTarget();
    failingOverview.updateAllTargetBindings = vi.fn(() => {
      throw new Error('deferred binding update failed');
    });
    const recoveredOverview = createOverviewTarget();

    scheduler.schedule('deferred', () => failingOverview);

    expect(() => vi.advanceTimersByTime(96)).toThrow('deferred binding update failed');

    scheduler.schedule('deferred', () => recoveredOverview);
    vi.advanceTimersByTime(96);

    expect(recoveredOverview.updateAllTargetBindings).toHaveBeenCalledOnce();
    expect(recoveredOverview.requestUpdate).toHaveBeenCalledOnce();
  });

  it('contains deferred binding update errors through the optional error handler and recovers', () => {
    vi.useFakeTimers();
    const errors: unknown[] = [];
    const scheduler = new OverviewBindingsScheduler({
      dragThrottleMs: 16,
      idleThrottleMs: 96,
      onUpdateError: error => errors.push(error),
    });
    const failingOverview = createOverviewTarget();
    failingOverview.updateAllTargetBindings = vi.fn(() => {
      throw new Error('deferred binding update failed');
    });
    const recoveredOverview = createOverviewTarget();

    scheduler.schedule('deferred', () => failingOverview);

    expect(() => vi.advanceTimersByTime(96)).not.toThrow();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(Error);

    scheduler.schedule('deferred', () => recoveredOverview);
    vi.advanceTimersByTime(96);

    expect(recoveredOverview.updateAllTargetBindings).toHaveBeenCalledOnce();
    expect(recoveredOverview.requestUpdate).toHaveBeenCalledOnce();
  });
});

describe('OverviewViewportUpdateScheduler', () => {
  function createRafHarness() {
    let nextId = 1;
    const callbacks = new Map<number, FrameRequestCallback>();
    return {
      requestAnimationFrame: vi.fn((callback: FrameRequestCallback) => {
        const id = nextId;
        nextId += 1;
        callbacks.set(id, callback);
        return id;
      }),
      cancelAnimationFrame: vi.fn((id: number) => {
        callbacks.delete(id);
      }),
      flushAll: () => {
        const pending = [...callbacks.entries()];
        callbacks.clear();
        for (const [, callback] of pending) {
          callback(0);
        }
      },
    };
  }

  it('coalesces queued viewport updates and lets document updates win priority', () => {
    const raf = createRafHarness();
    const applied: string[] = [];
    const scheduler = new OverviewViewportUpdateScheduler({
      throttleMs: 32,
      requestAnimationFrameFn: raf.requestAnimationFrame,
      cancelAnimationFrameFn: raf.cancelAnimationFrame,
      nowFn: () => 100,
    });
    const runtime = {
      applyUpdate: (source: 'document' | 'viewport') => applied.push(source),
      hasOverview: () => true,
      isDestroyed: () => false,
      isNodeDragging: () => false,
    };

    scheduler.schedule('viewport', runtime);
    scheduler.schedule('document', runtime);

    expect(raf.requestAnimationFrame).toHaveBeenCalledOnce();

    raf.flushAll();

    expect(applied).toEqual(['document']);
  });

  it('cancels a queued viewport update when applying immediately', () => {
    const raf = createRafHarness();
    const applied: string[] = [];
    const scheduler = new OverviewViewportUpdateScheduler({
      throttleMs: 32,
      requestAnimationFrameFn: raf.requestAnimationFrame,
      cancelAnimationFrameFn: raf.cancelAnimationFrame,
      nowFn: () => 100,
    });
    const runtime = {
      applyUpdate: (source: 'document' | 'viewport') => applied.push(source),
      hasOverview: () => true,
      isDestroyed: () => false,
      isNodeDragging: () => false,
    };

    scheduler.schedule('viewport', runtime);
    scheduler.applyNow('viewport', runtime);
    raf.flushAll();

    expect(raf.cancelAnimationFrame).toHaveBeenCalledWith(1);
    expect(applied).toEqual(['viewport']);
  });

  it('drops queued viewport updates if the overview is destroyed before the frame flushes', () => {
    const raf = createRafHarness();
    const applied: string[] = [];
    let destroyed = false;
    const scheduler = new OverviewViewportUpdateScheduler({
      throttleMs: 32,
      requestAnimationFrameFn: raf.requestAnimationFrame,
      cancelAnimationFrameFn: raf.cancelAnimationFrame,
      nowFn: () => 100,
    });
    const runtime = {
      applyUpdate: (source: 'document' | 'viewport') => applied.push(source),
      hasOverview: () => true,
      isDestroyed: () => destroyed,
      isNodeDragging: () => false,
    };

    scheduler.schedule('viewport', runtime);
    destroyed = true;
    raf.flushAll();

    expect(applied).toEqual([]);
  });

  it('throttles viewport updates while nodes are dragging', () => {
    const raf = createRafHarness();
    const applied: string[] = [];
    let now = 100;
    const scheduler = new OverviewViewportUpdateScheduler({
      throttleMs: 32,
      requestAnimationFrameFn: raf.requestAnimationFrame,
      cancelAnimationFrameFn: raf.cancelAnimationFrame,
      nowFn: () => now,
    });
    const runtime = {
      applyUpdate: (source: 'document' | 'viewport') => applied.push(source),
      hasOverview: () => true,
      isDestroyed: () => false,
      isNodeDragging: () => true,
    };

    scheduler.schedule('viewport', runtime);
    raf.flushAll();

    now = 110;
    scheduler.schedule('viewport', runtime);

    now = 133;
    scheduler.schedule('viewport', runtime);
    raf.flushAll();

    expect(raf.requestAnimationFrame).toHaveBeenCalledTimes(2);
    expect(applied).toEqual(['viewport', 'viewport']);
  });

  it('preserves document update priority while dragging even inside the throttle window', () => {
    const raf = createRafHarness();
    const applied: string[] = [];
    let now = 100;
    const scheduler = new OverviewViewportUpdateScheduler({
      throttleMs: 32,
      requestAnimationFrameFn: raf.requestAnimationFrame,
      cancelAnimationFrameFn: raf.cancelAnimationFrame,
      nowFn: () => now,
    });
    const runtime = {
      applyUpdate: (source: 'document' | 'viewport') => applied.push(source),
      hasOverview: () => true,
      isDestroyed: () => false,
      isNodeDragging: () => true,
    };

    scheduler.schedule('viewport', runtime);
    now = 110;
    scheduler.schedule('document', runtime);
    raf.flushAll();

    expect(applied).toEqual(['document']);
  });

  it('schedules document updates while dragging even inside the throttle window', () => {
    const raf = createRafHarness();
    const applied: string[] = [];
    let now = 100;
    const scheduler = new OverviewViewportUpdateScheduler({
      throttleMs: 32,
      requestAnimationFrameFn: raf.requestAnimationFrame,
      cancelAnimationFrameFn: raf.cancelAnimationFrame,
      nowFn: () => now,
    });
    const runtime = {
      applyUpdate: (source: 'document' | 'viewport') => applied.push(source),
      hasOverview: () => true,
      isDestroyed: () => false,
      isNodeDragging: () => true,
    };

    scheduler.schedule('viewport', runtime);
    raf.flushAll();

    now = 110;
    scheduler.schedule('document', runtime);
    raf.flushAll();

    expect(raf.requestAnimationFrame).toHaveBeenCalledTimes(2);
    expect(applied).toEqual(['viewport', 'document']);
  });

  it('contains scheduled applyUpdate errors through the optional error handler and recovers next frame', () => {
    const raf = createRafHarness();
    const errors: unknown[] = [];
    const scheduler = new OverviewViewportUpdateScheduler({
      throttleMs: 32,
      requestAnimationFrameFn: raf.requestAnimationFrame,
      cancelAnimationFrameFn: raf.cancelAnimationFrame,
      nowFn: () => 100,
      onApplyError: error => errors.push(error),
    });
    const failingRuntime = {
      applyUpdate: vi.fn(() => {
        throw new Error('viewport update failed');
      }),
      hasOverview: () => true,
      isDestroyed: () => false,
      isNodeDragging: () => false,
    };
    const recoveredRuntime = {
      applyUpdate: vi.fn(),
      hasOverview: () => true,
      isDestroyed: () => false,
      isNodeDragging: () => false,
    };

    scheduler.schedule('viewport', failingRuntime);

    expect(() => raf.flushAll()).not.toThrow();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(Error);

    scheduler.schedule('document', recoveredRuntime);
    raf.flushAll();

    expect(recoveredRuntime.applyUpdate).toHaveBeenCalledWith('document');
  });

  it('contains immediate applyUpdate errors through the optional error handler and recovers next frame', () => {
    const raf = createRafHarness();
    const errors: unknown[] = [];
    const scheduler = new OverviewViewportUpdateScheduler({
      throttleMs: 32,
      requestAnimationFrameFn: raf.requestAnimationFrame,
      cancelAnimationFrameFn: raf.cancelAnimationFrame,
      nowFn: () => 100,
      onApplyError: error => errors.push(error),
    });
    const failingRuntime = {
      applyUpdate: vi.fn(() => {
        throw new Error('immediate viewport update failed');
      }),
      hasOverview: () => true,
      isDestroyed: () => false,
      isNodeDragging: () => false,
    };
    const recoveredRuntime = {
      applyUpdate: vi.fn(),
      hasOverview: () => true,
      isDestroyed: () => false,
      isNodeDragging: () => false,
    };

    scheduler.schedule('viewport', recoveredRuntime);

    expect(() => scheduler.applyNow('viewport', failingRuntime)).not.toThrow();
    expect(raf.cancelAnimationFrame).toHaveBeenCalledWith(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(Error);

    scheduler.schedule('document', recoveredRuntime);
    raf.flushAll();

    expect(recoveredRuntime.applyUpdate).toHaveBeenCalledWith('document');
  });
});
