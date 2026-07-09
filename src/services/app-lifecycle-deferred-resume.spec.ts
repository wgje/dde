import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppLifecycleDeferredResumeController } from './app-lifecycle-deferred-resume.controller';

describe('AppLifecycleDeferredResumeController', () => {
  let originalVisibilityStateDescriptor: PropertyDescriptor | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    originalVisibilityStateDescriptor = Object.getOwnPropertyDescriptor(document, 'visibilityState');
    setVisibilityState('visible');
  });

  afterEach(() => {
    if (originalVisibilityStateDescriptor) {
      Object.defineProperty(document, 'visibilityState', originalVisibilityStateDescriptor);
    }
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('schedules a visible-page deferred retry and triggers the supplied resume callback', async () => {
    const triggerResume = vi.fn();
    const controller = new AppLifecycleDeferredResumeController({
      logger: { info: vi.fn() },
      triggerResume,
    });

    const delay = controller.schedule('visibility-quick');

    expect(delay).toBeGreaterThan(0);
    expect(triggerResume).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(delay);

    expect(triggerResume).toHaveBeenCalledTimes(1);
    expect(triggerResume).toHaveBeenCalledWith('visibility-quick');
  });

  it('does not schedule a deferred retry while the page is hidden', () => {
    const logger = {
      info: vi.fn(),
    };
    const triggerResume = vi.fn();
    setVisibilityState('hidden');
    const controller = new AppLifecycleDeferredResumeController({
      logger,
      triggerResume,
    });

    const delay = controller.schedule('visibility-quick');

    expect(delay).toBe(0);
    expect(triggerResume).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      '页面仍处于后台，跳过 deferred resume 定时器，等待下一次可见恢复事件',
      { reason: 'visibility-quick' },
    );
  });

  it('updates a pending deferred retry to the higher priority reason without adding another timer', async () => {
    const triggerResume = vi.fn();
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const controller = new AppLifecycleDeferredResumeController({
      logger: { info: vi.fn() },
      triggerResume,
    });

    const firstDelay = controller.schedule('visibility-quick');
    const secondDelay = controller.schedule('online');

    expect(secondDelay).toBe(firstDelay);
    expect(setTimeoutSpy).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(firstDelay);

    expect(triggerResume).toHaveBeenCalledTimes(1);
    expect(triggerResume).toHaveBeenCalledWith('online');
  });

  it('isolates synchronous triggerResume failures and allows a later retry', async () => {
    const error = new Error('resume failed');
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
    };
    const triggerResume = vi.fn()
      .mockImplementationOnce(() => {
        throw error;
      })
      .mockImplementationOnce(() => undefined);
    const controller = new AppLifecycleDeferredResumeController({
      logger,
      triggerResume,
    });

    const firstDelay = controller.schedule('visibility-quick');
    await vi.advanceTimersByTimeAsync(firstDelay);

    const retryDelay = controller.schedule('online');
    await vi.advanceTimersByTimeAsync(retryDelay);

    expect(triggerResume).toHaveBeenCalledTimes(2);
    expect(triggerResume).toHaveBeenNthCalledWith(1, 'visibility-quick');
    expect(triggerResume).toHaveBeenNthCalledWith(2, 'online');
    expect(logger.warn).toHaveBeenCalledWith('Deferred resume trigger failed', {
      reason: 'visibility-quick',
      error,
    });
  });

  it('isolates asynchronous triggerResume rejections and allows a later retry', async () => {
    const error = new Error('resume rejected');
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
    };
    const triggerResume = vi.fn()
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce(undefined);
    const controller = new AppLifecycleDeferredResumeController({
      logger,
      triggerResume,
    });

    const firstDelay = controller.schedule('visibility-quick');
    await vi.advanceTimersByTimeAsync(firstDelay);
    await Promise.resolve();

    const retryDelay = controller.schedule('online');
    await vi.advanceTimersByTimeAsync(retryDelay);
    await Promise.resolve();

    expect(triggerResume).toHaveBeenCalledTimes(2);
    expect(triggerResume).toHaveBeenNthCalledWith(1, 'visibility-quick');
    expect(triggerResume).toHaveBeenNthCalledWith(2, 'online');
    expect(logger.warn).toHaveBeenCalledWith('Deferred resume trigger failed', {
      reason: 'visibility-quick',
      error,
    });
  });

  it('cancels timer handle 0 and ignores a stale deferred retry callback', async () => {
    let queuedDeferredRetry: (() => void) | null = null;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback: TimerHandler) => {
      queuedDeferredRetry = callback as () => void;
      return 0 as unknown as ReturnType<typeof setTimeout>;
    });
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout').mockImplementation(() => undefined);
    const triggerResume = vi.fn();
    const controller = new AppLifecycleDeferredResumeController({
      logger: { info: vi.fn() },
      triggerResume,
    });

    const delay = controller.schedule('visibility-quick');

    expect(delay).toBeGreaterThan(0);
    expect(queuedDeferredRetry).toBeTypeOf('function');
    const retry = queuedDeferredRetry as (() => void) | null;
    if (!retry) {
      throw new Error('Expected deferred retry callback');
    }

    controller.clear();
    expect(clearTimeoutSpy).toHaveBeenCalledWith(0);

    retry();
    await Promise.resolve();

    expect(triggerResume).not.toHaveBeenCalled();
  });
});

function setVisibilityState(state: DocumentVisibilityState): void {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    value: state,
  });
}
