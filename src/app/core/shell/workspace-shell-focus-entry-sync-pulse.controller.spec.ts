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

  it('delegates skipped pulse retries and retry cleanup', async () => {
    const clearRetry = vi.fn();
    const scheduleRetry = vi.fn();
    const retryController = {
      clear: clearRetry,
      schedule: scheduleRetry,
    };
    const controller = new WorkspaceShellFocusEntrySyncPulseController({
      focusModeIntentActivated: signal(true),
      isReady: () => true,
      isThrottledFocusStartup: () => false,
      triggerSyncPulse: vi.fn().mockResolvedValue({
        status: 'skipped' as const,
        skipReason: 'offline' as const,
      }),
      setupFocusMountIntentListener: vi.fn(),
      teardownFocusMountIntentListener: vi.fn(),
      cooldownDelayMs: 1000,
      postHeavyCooldownDelayMs: 2000,
      retryController,
    });

    controller.dispatchIfReady();
    await flushMicrotasks();

    expect(scheduleRetry).toHaveBeenCalledWith('offline', undefined);

    clearRetry.mockClear();
    controller.clearRetry();

    expect(clearRetry).toHaveBeenCalledTimes(1);
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

});
