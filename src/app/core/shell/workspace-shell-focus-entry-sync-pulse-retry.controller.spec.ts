import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  WorkspaceShellFocusEntrySyncPulseRetryController,
} from './workspace-shell-focus-entry-sync-pulse-retry.controller';

describe('WorkspaceShellFocusEntrySyncPulseRetryController', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('uses the cooldown fallback before retrying', () => {
    vi.useFakeTimers();
    const retry = vi.fn();
    const controller = new WorkspaceShellFocusEntrySyncPulseRetryController({
      cooldownDelayMs: 1000,
      postHeavyCooldownDelayMs: 2000,
      retry,
    });

    controller.schedule('cooldown');
    vi.advanceTimersByTime(999);

    expect(retry).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);

    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('uses post-heavy fallback and prefers a valid explicit retry delay', () => {
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
      .mockImplementation(() => 1 as unknown as ReturnType<typeof setTimeout>);
    vi.spyOn(globalThis, 'clearTimeout').mockImplementation(() => undefined);
    const controller = new WorkspaceShellFocusEntrySyncPulseRetryController({
      cooldownDelayMs: 1000,
      postHeavyCooldownDelayMs: 2000,
      retry: vi.fn(),
    });

    controller.schedule('post-heavy-cooldown');
    controller.schedule('offline', 250);

    expect(setTimeoutSpy).toHaveBeenNthCalledWith(1, expect.any(Function), 2000);
    expect(setTimeoutSpy).toHaveBeenNthCalledWith(2, expect.any(Function), 250);
  });

  it('falls back from invalid delays and clamps values to the safe timer maximum', () => {
    const maxSafeTimerDelayMs = 2_147_483_647;
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
      .mockImplementation(() => 1 as unknown as ReturnType<typeof setTimeout>);
    vi.spyOn(globalThis, 'clearTimeout').mockImplementation(() => undefined);
    const controller = new WorkspaceShellFocusEntrySyncPulseRetryController({
      cooldownDelayMs: 1000,
      postHeavyCooldownDelayMs: 2000,
      retry: vi.fn(),
    });

    controller.schedule('cooldown', 0);
    controller.schedule('cooldown', Number.POSITIVE_INFINITY);
    controller.schedule('cooldown', maxSafeTimerDelayMs + 1);

    expect(setTimeoutSpy).toHaveBeenNthCalledWith(1, expect.any(Function), 1000);
    expect(setTimeoutSpy).toHaveBeenNthCalledWith(2, expect.any(Function), 1000);
    expect(setTimeoutSpy).toHaveBeenNthCalledWith(
      3,
      expect.any(Function),
      maxSafeTimerDelayMs,
    );
  });

  it('does not schedule a retry without an explicit or reason fallback delay', () => {
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const controller = new WorkspaceShellFocusEntrySyncPulseRetryController({
      cooldownDelayMs: 1000,
      postHeavyCooldownDelayMs: 2000,
      retry: vi.fn(),
    });

    controller.schedule('offline');

    expect(setTimeoutSpy).not.toHaveBeenCalled();
  });

  it('invalidates a zero-valued retry handle when timer cleanup fails', () => {
    const retryState: { callback?: () => void } = {};
    vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback: TimerHandler) => {
      retryState.callback = callback as () => void;
      return 0 as unknown as ReturnType<typeof setTimeout>;
    });
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout').mockImplementation(() => {
      throw new Error('clear timeout failed');
    });
    const retry = vi.fn();
    const controller = new WorkspaceShellFocusEntrySyncPulseRetryController({
      cooldownDelayMs: 1000,
      postHeavyCooldownDelayMs: 2000,
      retry,
    });

    controller.schedule('cooldown');

    expect(() => controller.clear()).not.toThrow();
    retryState.callback?.();

    expect(clearTimeoutSpy).toHaveBeenCalledWith(0);
    expect(retry).not.toHaveBeenCalled();
  });

  it('ignores an older timer after a newer retry is scheduled', () => {
    const queuedCallbacks: Array<() => void> = [];
    vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback: TimerHandler) => {
      queuedCallbacks.push(callback as () => void);
      return queuedCallbacks.length as unknown as ReturnType<typeof setTimeout>;
    });
    vi.spyOn(globalThis, 'clearTimeout').mockImplementation(() => undefined);
    const retry = vi.fn();
    const controller = new WorkspaceShellFocusEntrySyncPulseRetryController({
      cooldownDelayMs: 1000,
      postHeavyCooldownDelayMs: 2000,
      retry,
    });

    controller.schedule('cooldown');
    controller.schedule('cooldown');
    queuedCallbacks[0]();
    queuedCallbacks[1]();

    expect(retry).toHaveBeenCalledTimes(1);
  });
});
