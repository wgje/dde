import { afterEach, describe, expect, it, vi } from 'vitest';

import { createPwaInstallPromptInitializationScheduler } from './pwa-install-prompt-initialization.scheduler';

describe('createPwaInstallPromptInitializationScheduler', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('teardown cancels fallback initialization after duplicate schedule calls', () => {
    const initialize = vi.fn();
    const pendingTimers = new Map<number, () => void>();
    let nextTimerId = 1;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback: TimerHandler) => {
      const timerId = nextTimerId++;
      pendingTimers.set(timerId, callback as () => void);
      return timerId as unknown as ReturnType<typeof setTimeout>;
    });
    vi.spyOn(globalThis, 'clearTimeout').mockImplementation((handle) => {
      pendingTimers.delete(handle as unknown as number);
    });
    const windowRef = {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as Window;
    let idleCallbackHandle: number | null = null;
    const scheduler = createPwaInstallPromptInitializationScheduler({
      initialize,
      isDestroyed: () => false,
      getIdleCallbackHandle: () => idleCallbackHandle,
      setIdleCallbackHandle: (handle) => {
        idleCallbackHandle = handle;
      },
      windowRef,
    });

    scheduler.schedule();
    scheduler.schedule();
    scheduler.teardown();
    for (const runTimer of pendingTimers.values()) {
      runTimer();
    }

    expect(initialize).not.toHaveBeenCalled();
  });

  it('rolls back already registered intent listeners when scheduling fails midway', () => {
    const pointerdownListener = vi.fn();
    const windowRef = {
      addEventListener: vi.fn((eventName: string, listener: EventListener) => {
        if (eventName === 'pointerdown') {
          pointerdownListener.mockImplementation(listener);
          return;
        }
        if (eventName === 'keydown') {
          throw new Error('keydown listener registration failed');
        }
      }),
      removeEventListener: vi.fn(),
    } as unknown as Window;
    const scheduler = createPwaInstallPromptInitializationScheduler({
      initialize: vi.fn(),
      isDestroyed: () => false,
      getIdleCallbackHandle: () => null,
      setIdleCallbackHandle: vi.fn(),
      windowRef,
    });

    expect(() => scheduler.schedule()).toThrow('keydown listener registration failed');
    expect(windowRef.removeEventListener).toHaveBeenCalledWith('pointerdown', expect.any(Function));
  });

  it('allows scheduling again after a midway listener registration failure', () => {
    const initialize = vi.fn();
    let shouldThrow = true;
    let idleCallback: IdleRequestCallback | undefined;
    const windowRef = {
      addEventListener: vi.fn((eventName: string) => {
        if (shouldThrow && eventName === 'keydown') {
          shouldThrow = false;
          throw new Error('keydown listener registration failed');
        }
      }),
      removeEventListener: vi.fn(),
      requestIdleCallback: vi.fn((callback: IdleRequestCallback) => {
        idleCallback = callback;
        return 11;
      }),
    } as unknown as Window;
    let idleCallbackHandle: number | null = null;
    const scheduler = createPwaInstallPromptInitializationScheduler({
      initialize,
      isDestroyed: () => false,
      getIdleCallbackHandle: () => idleCallbackHandle,
      setIdleCallbackHandle: (handle) => {
        idleCallbackHandle = handle;
      },
      windowRef,
    });

    expect(() => scheduler.schedule()).toThrow('keydown listener registration failed');
    scheduler.schedule();
    idleCallback?.({ didTimeout: false, timeRemaining: () => 10 });

    expect(initialize).toHaveBeenCalledOnce();
  });

  it('teardown continues cleanup when one intent listener removal fails', () => {
    const initialize = vi.fn();
    let idleCallback: IdleRequestCallback | undefined;
    let idleCallbackHandle: number | null = 9;
    const cancelIdleCallback = vi.fn(() => {
      throw new Error('cancel idle failed');
    });
    const windowRef = {
      addEventListener: vi.fn(),
      cancelIdleCallback,
      removeEventListener: vi.fn((eventName: string) => {
        if (eventName === 'pointerdown') {
          throw new Error('pointerdown removal failed');
        }
      }),
      requestIdleCallback: vi.fn((callback: IdleRequestCallback) => {
        idleCallback = callback;
        return 9;
      }),
    } as unknown as Window;
    const scheduler = createPwaInstallPromptInitializationScheduler({
      initialize,
      isDestroyed: () => false,
      getIdleCallbackHandle: () => idleCallbackHandle,
      setIdleCallbackHandle: (handle) => {
        idleCallbackHandle = handle;
      },
      windowRef,
    });

    scheduler.schedule();

    expect(() => scheduler.teardown()).not.toThrow();
    expect(windowRef.removeEventListener).toHaveBeenCalledWith('keydown', expect.any(Function));
    expect(windowRef.removeEventListener).toHaveBeenCalledWith('touchstart', expect.any(Function));
    expect(cancelIdleCallback).toHaveBeenCalledWith(9);
    expect(idleCallbackHandle).toBeNull();
    idleCallback?.({ didTimeout: false, timeRemaining: () => 10 });
    expect(initialize).not.toHaveBeenCalled();
  });
});
