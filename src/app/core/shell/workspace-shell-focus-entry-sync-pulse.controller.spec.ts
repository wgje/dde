import { signal } from '@angular/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceShellFocusEntrySyncPulseController } from './workspace-shell-focus-entry-sync-pulse.controller';

const flushMicrotasks = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

describe('WorkspaceShellFocusEntrySyncPulseController', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('隔离 sync pulse reject 并释放 pending，允许后续重新触发', async () => {
    const focusModeIntentActivated = signal(true);
    const triggerSyncPulse = vi.fn()
      .mockRejectedValueOnce(new Error('sync pulse failed'))
      .mockResolvedValueOnce({ status: 'success' as const });
    const controller = new WorkspaceShellFocusEntrySyncPulseController({
      focusModeIntentActivated,
      isReady: () => true,
      isThrottledFocusStartup: () => false,
      triggerSyncPulse,
      setupFocusMountIntentListener: vi.fn(),
      teardownFocusMountIntentListener: vi.fn(),
      cooldownDelayMs: 1000,
      postHeavyCooldownDelayMs: 2000,
    });

    controller.dispatchIfReady();
    await flushMicrotasks();

    controller.dispatchIfReady();
    await flushMicrotasks();

    expect(triggerSyncPulse).toHaveBeenCalledTimes(2);
  });

  it('sync pulse engine 暂不可用返回 null 时按 cooldown 自动重试', async () => {
    vi.useFakeTimers();
    const focusModeIntentActivated = signal(true);
    const triggerSyncPulse = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ status: 'success' as const });
    const controller = new WorkspaceShellFocusEntrySyncPulseController({
      focusModeIntentActivated,
      isReady: () => true,
      isThrottledFocusStartup: () => false,
      triggerSyncPulse,
      setupFocusMountIntentListener: vi.fn(),
      teardownFocusMountIntentListener: vi.fn(),
      cooldownDelayMs: 1000,
      postHeavyCooldownDelayMs: 2000,
    });

    controller.dispatchIfReady();
    await flushMicrotasks();

    expect(triggerSyncPulse).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(999);
    expect(triggerSyncPulse).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    await flushMicrotasks();

    expect(triggerSyncPulse).toHaveBeenCalledTimes(2);
  });

  it('sync pulse 返回 failed 时按 cooldown 自动重试', async () => {
    vi.useFakeTimers();
    const focusModeIntentActivated = signal(true);
    const triggerSyncPulse = vi.fn()
      .mockResolvedValueOnce({ status: 'failed' as const })
      .mockResolvedValueOnce({ status: 'success' as const });
    const controller = new WorkspaceShellFocusEntrySyncPulseController({
      focusModeIntentActivated,
      isReady: () => true,
      isThrottledFocusStartup: () => false,
      triggerSyncPulse,
      setupFocusMountIntentListener: vi.fn(),
      teardownFocusMountIntentListener: vi.fn(),
      cooldownDelayMs: 1000,
      postHeavyCooldownDelayMs: 2000,
    });

    controller.dispatchIfReady();
    await flushMicrotasks();

    expect(triggerSyncPulse).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(999);
    expect(triggerSyncPulse).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    await flushMicrotasks();

    expect(triggerSyncPulse).toHaveBeenCalledTimes(2);
  });

  it('sync pulse 返回非正 retryAfterMs 时不应在 0ms timer 中立即重入', async () => {
    vi.useFakeTimers();
    const focusModeIntentActivated = signal(true);
    const triggerSyncPulse = vi.fn()
      .mockResolvedValueOnce({ status: 'skipped' as const, skipReason: 'cooldown' as const, retryAfterMs: 0 })
      .mockResolvedValueOnce({ status: 'success' as const });
    const controller = new WorkspaceShellFocusEntrySyncPulseController({
      focusModeIntentActivated,
      isReady: () => true,
      isThrottledFocusStartup: () => false,
      triggerSyncPulse,
      setupFocusMountIntentListener: vi.fn(),
      teardownFocusMountIntentListener: vi.fn(),
      cooldownDelayMs: 1000,
      postHeavyCooldownDelayMs: 2000,
    });

    controller.dispatchIfReady();
    await flushMicrotasks();

    await vi.advanceTimersByTimeAsync(0);
    await flushMicrotasks();

    expect(triggerSyncPulse).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1000);
    await flushMicrotasks();

    expect(triggerSyncPulse).toHaveBeenCalledTimes(2);
  });

  it('sync pulse 返回非有限 retryAfterMs 时回退到 cooldown 避免 timer 溢出重入', async () => {
    const retryTimer = 1 as unknown as ReturnType<typeof setTimeout>;
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(() => retryTimer);
    const focusModeIntentActivated = signal(true);
    const triggerSyncPulse = vi.fn()
      .mockResolvedValueOnce({
        status: 'skipped' as const,
        skipReason: 'cooldown' as const,
        retryAfterMs: Number.POSITIVE_INFINITY,
      });
    const controller = new WorkspaceShellFocusEntrySyncPulseController({
      focusModeIntentActivated,
      isReady: () => true,
      isThrottledFocusStartup: () => false,
      triggerSyncPulse,
      setupFocusMountIntentListener: vi.fn(),
      teardownFocusMountIntentListener: vi.fn(),
      cooldownDelayMs: 1000,
      postHeavyCooldownDelayMs: 2000,
    });

    controller.dispatchIfReady();
    await flushMicrotasks();

    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 1000);
  });

  it('sync pulse 返回超过运行时安全上限的 retryAfterMs 时限制到最大安全 timer delay', async () => {
    const maxSafeTimerDelayMs = 2_147_483_647;
    const retryTimer = 1 as unknown as ReturnType<typeof setTimeout>;
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(() => retryTimer);
    const focusModeIntentActivated = signal(true);
    const triggerSyncPulse = vi.fn()
      .mockResolvedValueOnce({
        status: 'skipped' as const,
        skipReason: 'cooldown' as const,
        retryAfterMs: maxSafeTimerDelayMs + 1,
      });
    const controller = new WorkspaceShellFocusEntrySyncPulseController({
      focusModeIntentActivated,
      isReady: () => true,
      isThrottledFocusStartup: () => false,
      triggerSyncPulse,
      setupFocusMountIntentListener: vi.fn(),
      teardownFocusMountIntentListener: vi.fn(),
      cooldownDelayMs: 1000,
      postHeavyCooldownDelayMs: 2000,
    });

    controller.dispatchIfReady();
    await flushMicrotasks();

    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), maxSafeTimerDelayMs);
  });

  it('隔离 sync pulse 同步异常并按 cooldown 自动重试', async () => {
    vi.useFakeTimers();
    const focusModeIntentActivated = signal(true);
    const triggerSyncPulse = vi.fn()
      .mockImplementationOnce(() => {
        throw new Error('sync pulse sync failure');
      })
      .mockResolvedValueOnce({ status: 'success' as const });
    const controller = new WorkspaceShellFocusEntrySyncPulseController({
      focusModeIntentActivated,
      isReady: () => true,
      isThrottledFocusStartup: () => false,
      triggerSyncPulse,
      setupFocusMountIntentListener: vi.fn(),
      teardownFocusMountIntentListener: vi.fn(),
      cooldownDelayMs: 1000,
      postHeavyCooldownDelayMs: 2000,
    });

    expect(() => controller.dispatchIfReady()).not.toThrow();
    await flushMicrotasks();

    expect(triggerSyncPulse).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1000);
    await flushMicrotasks();

    expect(triggerSyncPulse).toHaveBeenCalledTimes(2);
  });

  it('sync pulse 非 Promise null 结果不应抛出并按 cooldown 自动重试', async () => {
    vi.useFakeTimers();
    const focusModeIntentActivated = signal(true);
    const triggerSyncPulse = vi.fn()
      .mockReturnValueOnce(null)
      .mockResolvedValueOnce({ status: 'success' as const });
    const controller = new WorkspaceShellFocusEntrySyncPulseController({
      focusModeIntentActivated,
      isReady: () => true,
      isThrottledFocusStartup: () => false,
      triggerSyncPulse,
      setupFocusMountIntentListener: vi.fn(),
      teardownFocusMountIntentListener: vi.fn(),
      cooldownDelayMs: 1000,
      postHeavyCooldownDelayMs: 2000,
    });

    expect(() => controller.dispatchIfReady()).not.toThrow();
    await flushMicrotasks();

    expect(triggerSyncPulse).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1000);
    await flushMicrotasks();

    expect(triggerSyncPulse).toHaveBeenCalledTimes(2);
  });

  it('reset clears a pending retry even when the browser timer handle is 0', async () => {
    const retryTimer = 0 as unknown as ReturnType<typeof setTimeout>;
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(() => retryTimer);
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout').mockImplementation(() => undefined);
    const focusModeIntentActivated = signal(true);
    const triggerSyncPulse = vi.fn().mockResolvedValue(null);
    const controller = new WorkspaceShellFocusEntrySyncPulseController({
      focusModeIntentActivated,
      isReady: () => true,
      isThrottledFocusStartup: () => false,
      triggerSyncPulse,
      setupFocusMountIntentListener: vi.fn(),
      teardownFocusMountIntentListener: vi.fn(),
      cooldownDelayMs: 1000,
      postHeavyCooldownDelayMs: 2000,
    });

    controller.dispatchIfReady();
    await flushMicrotasks();
    controller.reset();

    expect(setTimeoutSpy).toHaveBeenCalledOnce();
    expect(clearTimeoutSpy).toHaveBeenCalledWith(0);
  });

  it('reset continues when clearing a pending retry timer throws', async () => {
    const retryTimer = 1 as unknown as ReturnType<typeof setTimeout>;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(() => retryTimer);
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout').mockImplementation(() => {
      throw new Error('clear timeout failed');
    });
    const focusModeIntentActivated = signal(true);
    const setupFocusMountIntentListener = vi.fn();
    const teardownFocusMountIntentListener = vi.fn();
    const triggerSyncPulse = vi.fn().mockResolvedValue(null);
    const controller = new WorkspaceShellFocusEntrySyncPulseController({
      focusModeIntentActivated,
      isReady: () => true,
      isThrottledFocusStartup: () => false,
      triggerSyncPulse,
      setupFocusMountIntentListener,
      teardownFocusMountIntentListener,
      cooldownDelayMs: 1000,
      postHeavyCooldownDelayMs: 2000,
    });

    controller.dispatchIfReady();
    await flushMicrotasks();
    focusModeIntentActivated.set(false);

    expect(() => controller.reset()).not.toThrow();

    expect(clearTimeoutSpy).toHaveBeenCalledWith(retryTimer);
    expect(focusModeIntentActivated()).toBe(true);
    expect(teardownFocusMountIntentListener).toHaveBeenCalledTimes(1);
    expect(setupFocusMountIntentListener).toHaveBeenCalledTimes(1);
  });

  it('reset continues rearming the focus mount listener when teardown throws', () => {
    const focusModeIntentActivated = signal(false);
    const teardownError = new Error('focus mount listener teardown failed');
    const setupFocusMountIntentListener = vi.fn();
    const teardownFocusMountIntentListener = vi.fn(() => {
      throw teardownError;
    });
    const controller = new WorkspaceShellFocusEntrySyncPulseController({
      focusModeIntentActivated,
      isReady: () => true,
      isThrottledFocusStartup: () => false,
      triggerSyncPulse: vi.fn().mockResolvedValue({ status: 'success' as const }),
      setupFocusMountIntentListener,
      teardownFocusMountIntentListener,
      cooldownDelayMs: 1000,
      postHeavyCooldownDelayMs: 2000,
    });

    expect(() => controller.reset()).not.toThrow();

    expect(focusModeIntentActivated()).toBe(true);
    expect(teardownFocusMountIntentListener).toHaveBeenCalledTimes(1);
    expect(setupFocusMountIntentListener).toHaveBeenCalledTimes(1);
  });

  it('reset isolates focus mount listener setup failures', () => {
    const focusModeIntentActivated = signal(false);
    const setupError = new Error('focus mount listener setup failed');
    const setupFocusMountIntentListener = vi.fn(() => {
      throw setupError;
    });
    const teardownFocusMountIntentListener = vi.fn();
    const controller = new WorkspaceShellFocusEntrySyncPulseController({
      focusModeIntentActivated,
      isReady: () => true,
      isThrottledFocusStartup: () => false,
      triggerSyncPulse: vi.fn().mockResolvedValue({ status: 'success' as const }),
      setupFocusMountIntentListener,
      teardownFocusMountIntentListener,
      cooldownDelayMs: 1000,
      postHeavyCooldownDelayMs: 2000,
    });

    expect(() => controller.reset()).not.toThrow();

    expect(focusModeIntentActivated()).toBe(true);
    expect(teardownFocusMountIntentListener).toHaveBeenCalledTimes(1);
    expect(setupFocusMountIntentListener).toHaveBeenCalledTimes(1);
  });

  it('ignores a stale retry timer after a newer retry is scheduled', async () => {
    const queuedTimeouts = new Map<number, () => void>();
    let nextTimerId = 1;
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
      .mockImplementation((callback: TimerHandler) => {
        const timerId = nextTimerId++;
        queuedTimeouts.set(timerId, callback as () => void);
        return timerId as unknown as ReturnType<typeof setTimeout>;
      });
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout').mockImplementation(() => undefined);
    const focusModeIntentActivated = signal(true);
    const triggerSyncPulse = vi.fn()
      .mockResolvedValueOnce({ status: 'failed' as const })
      .mockResolvedValueOnce({ status: 'failed' as const })
      .mockResolvedValueOnce({ status: 'success' as const });
    const controller = new WorkspaceShellFocusEntrySyncPulseController({
      focusModeIntentActivated,
      isReady: () => true,
      isThrottledFocusStartup: () => false,
      triggerSyncPulse,
      setupFocusMountIntentListener: vi.fn(),
      teardownFocusMountIntentListener: vi.fn(),
      cooldownDelayMs: 1000,
      postHeavyCooldownDelayMs: 2000,
    });

    controller.dispatchIfReady();
    await flushMicrotasks();
    controller.dispatchIfReady();
    await flushMicrotasks();
    queuedTimeouts.get(1)?.();
    controller.reset();

    expect(setTimeoutSpy).toHaveBeenCalledTimes(2);
    expect(triggerSyncPulse).toHaveBeenCalledTimes(2);
    expect(clearTimeoutSpy).toHaveBeenCalledWith(1);
    expect(clearTimeoutSpy).toHaveBeenCalledWith(2);
  });
});
