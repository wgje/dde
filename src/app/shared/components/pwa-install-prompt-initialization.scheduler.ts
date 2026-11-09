import { IDLE_SCHEDULE_CONFIG } from '../../../config/timeout.config';

type WindowWithPromptIdleCallback = Window & {
  requestIdleCallback?: (callback: IdleRequestCallback, options?: IdleRequestOptions) => number;
  cancelIdleCallback?: (handle: number) => void;
};

type PromptIntentEventName = 'pointerdown' | 'keydown' | 'touchstart';

export interface PwaInstallPromptInitializationScheduler {
  schedule(): void;
  teardown(): void;
}

export interface PwaInstallPromptInitializationSchedulerOptions {
  initialize: () => void;
  isDestroyed: () => boolean;
  setIdleCallbackHandle: (handle: number | null) => void;
  getIdleCallbackHandle: () => number | null;
  windowRef?: Window;
}

function clearPromptInitialization(
  windowRef: Window | undefined,
  onFirstIntent: () => void,
  options: PwaInstallPromptInitializationSchedulerOptions,
  idleTimer: ReturnType<typeof setTimeout> | null,
): ReturnType<typeof setTimeout> | null {
  if (windowRef) {
    removePromptIntentListener(windowRef, 'pointerdown', onFirstIntent);
    removePromptIntentListener(windowRef, 'keydown', onFirstIntent);
    removePromptIntentListener(windowRef, 'touchstart', onFirstIntent);
    clearPromptIdleCallback(windowRef, options);
  }

  if (idleTimer !== null) {
    try {
      clearTimeout(idleTimer);
    } catch {
      // Timer cleanup must not interrupt intent listener or idle callback cleanup.
    }
  }
  return null;
}

function removePromptIntentListener(
  windowRef: Window,
  eventName: PromptIntentEventName,
  onFirstIntent: () => void,
): void {
  try {
    windowRef.removeEventListener(eventName, onFirstIntent);
  } catch {
    // Best-effort cleanup: one broken listener must not leave other lifecycle resources alive.
  }
}

function clearPromptIdleCallback(
  windowRef: Window,
  options: PwaInstallPromptInitializationSchedulerOptions,
): void {
  const idleHandle = options.getIdleCallbackHandle();
  if (idleHandle === null) return;

  options.setIdleCallbackHandle(null);
  try {
    (windowRef as WindowWithPromptIdleCallback)
      .cancelIdleCallback?.(idleHandle);
  } catch {
    // A cancel failure should not leave scheduler state pointing at a stale handle.
  }
}

function schedulePromptInitialization(
  windowRef: Window,
  onFirstIntent: () => void,
  options: PwaInstallPromptInitializationSchedulerOptions,
): ReturnType<typeof setTimeout> | null {
  const registeredListeners: PromptIntentEventName[] = [];
  try {
    windowRef.addEventListener('pointerdown', onFirstIntent, { once: true, passive: true });
    registeredListeners.push('pointerdown');
    windowRef.addEventListener('keydown', onFirstIntent, { once: true });
    registeredListeners.push('keydown');
    windowRef.addEventListener('touchstart', onFirstIntent, { once: true, passive: true });
    registeredListeners.push('touchstart');

    if ('requestIdleCallback' in windowRef) {
      const idleHandle = (windowRef as WindowWithPromptIdleCallback)
        .requestIdleCallback?.(onFirstIntent, { timeout: 2500 });
      options.setIdleCallbackHandle(idleHandle ?? null);
      return null;
    }

    return setTimeout(onFirstIntent, IDLE_SCHEDULE_CONFIG.SHORT_MS);
  } catch (error) {
    for (const eventName of registeredListeners) {
      removePromptIntentListener(windowRef, eventName, onFirstIntent);
    }
    clearPromptIdleCallback(windowRef, options);
    throw error;
  }
}

export function createPwaInstallPromptInitializationScheduler(
  options: PwaInstallPromptInitializationSchedulerOptions,
): PwaInstallPromptInitializationScheduler {
  const windowRef = options.windowRef ?? (
    typeof window === 'undefined' ? undefined : window
  );
  let initialized = false;
  let initializing = false;
  let scheduled = false;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const cleanup = () => {
    idleTimer = clearPromptInitialization(windowRef, onFirstIntent, options, idleTimer);
    scheduled = false;
  };

  const initOnce = () => {
    if (!scheduled || initialized || initializing || options.isDestroyed()) return;

    cleanup();
    initializing = true;
    try {
      options.initialize();
      initialized = true;
    } finally {
      initializing = false;
    }
  };

  const onFirstIntent = () => initOnce();

  return {
    schedule: () => {
      if (initialized || initializing || scheduled || options.isDestroyed()) {
        return;
      }

      scheduled = true;
      if (!windowRef) {
        initOnce();
        return;
      }

      try {
        idleTimer = schedulePromptInitialization(windowRef, onFirstIntent, options);
      } catch (error) {
        cleanup();
        throw error;
      }
    },
    teardown: cleanup,
  };
}
