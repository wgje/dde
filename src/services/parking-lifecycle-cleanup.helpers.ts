type Timer = ReturnType<typeof setTimeout>;
type Listener = (() => void) | null;
type FirstInteractionEventName = 'keydown' | 'click' | 'scroll';

export interface ParkingLifecycleHandles {
  evictionIntervalTimer: Timer | null;
  parkedDeltaTimer: Timer | null;
  startupEvictionTimer: Timer | null;
  parkedDeltaRecoveryTimer: Timer | null;
  evictionReadyCheckTimer: Timer | null;
  onlineListener: Listener;
  parkedSyncOnlineListener: Listener;
  visibilityChangeHandler: Listener;
  firstInteractionHandler: Listener;
  clearIntervalFn?: (timer: Timer) => void;
  clearTimeoutFn?: (timer: Timer) => void;
  removeWindowListener?: (eventName: 'online', listener: () => void) => void;
  removeDocumentListener?: (
    eventName: 'visibilitychange' | 'keydown' | 'click' | 'scroll',
    listener: () => void
  ) => void;
}

export type CleanedParkingLifecycleHandles = Pick<
  ParkingLifecycleHandles,
  | 'evictionIntervalTimer'
  | 'parkedDeltaTimer'
  | 'startupEvictionTimer'
  | 'parkedDeltaRecoveryTimer'
  | 'evictionReadyCheckTimer'
  | 'onlineListener'
  | 'parkedSyncOnlineListener'
  | 'visibilityChangeHandler'
  | 'firstInteractionHandler'
>;

export interface ParkingFirstInteractionCleanupOptions {
  removeDocumentListener?: (
    eventName: FirstInteractionEventName,
    listener: () => void,
  ) => void;
  warn?: (message: string, error: unknown) => void;
}

export interface ParkingFirstInteractionSetupOptions extends ParkingFirstInteractionCleanupOptions {
  addDocumentListener?: (
    eventName: FirstInteractionEventName,
    listener: () => void,
  ) => void;
}

export function setupParkingFirstInteractionListeners(
  listener: () => void,
  options: ParkingFirstInteractionSetupOptions = {},
): boolean {
  const addDocumentListener = options.addDocumentListener
    ?? ((eventName, handler) => document.addEventListener(eventName, handler));

  try {
    addDocumentListener('keydown', listener);
    addDocumentListener('click', listener);
    addDocumentListener('scroll', listener);
    return true;
  } catch (error: unknown) {
    cleanupParkingFirstInteractionListeners(listener, options);
    warnCleanupFailure(options, 'first interaction listener registration failed', error);
    return false;
  }
}

export function cleanupParkingFirstInteractionListeners(
  listener: () => void,
  options: ParkingFirstInteractionCleanupOptions = {},
): boolean {
  const keydownRemoved = removeFirstInteractionListener('keydown', listener, options);
  const clickRemoved = removeFirstInteractionListener('click', listener, options);
  const scrollRemoved = removeFirstInteractionListener('scroll', listener, options);
  return keydownRemoved && clickRemoved && scrollRemoved;
}

export function cleanupParkingLifecycleHandles(
  handles: ParkingLifecycleHandles
): CleanedParkingLifecycleHandles {
  const clearIntervalFn = handles.clearIntervalFn ?? clearInterval;
  const clearTimeoutFn = handles.clearTimeoutFn ?? clearTimeout;
  const removeWindowListener = handles.removeWindowListener
    ?? ((eventName, listener) => window.removeEventListener(eventName, listener));
  const removeDocumentListener = handles.removeDocumentListener
    ?? ((eventName, listener) => document.removeEventListener(eventName, listener));

  if (handles.evictionIntervalTimer !== null) safeCleanup(() => clearIntervalFn(handles.evictionIntervalTimer!));
  if (handles.parkedDeltaTimer !== null) safeCleanup(() => clearIntervalFn(handles.parkedDeltaTimer!));
  if (handles.startupEvictionTimer !== null) safeCleanup(() => clearTimeoutFn(handles.startupEvictionTimer!));
  if (handles.parkedDeltaRecoveryTimer !== null) safeCleanup(() => clearTimeoutFn(handles.parkedDeltaRecoveryTimer!));
  if (handles.evictionReadyCheckTimer !== null) safeCleanup(() => clearTimeoutFn(handles.evictionReadyCheckTimer!));

  if (handles.onlineListener) safeCleanup(() => removeWindowListener('online', handles.onlineListener!));
  if (handles.parkedSyncOnlineListener) safeCleanup(() => removeWindowListener('online', handles.parkedSyncOnlineListener!));
  if (handles.visibilityChangeHandler) {
    safeCleanup(() => removeDocumentListener('visibilitychange', handles.visibilityChangeHandler!));
  }
  if (handles.firstInteractionHandler) {
    safeCleanup(() => removeDocumentListener('keydown', handles.firstInteractionHandler!));
    safeCleanup(() => removeDocumentListener('click', handles.firstInteractionHandler!));
    safeCleanup(() => removeDocumentListener('scroll', handles.firstInteractionHandler!));
  }

  return {
    evictionIntervalTimer: null,
    parkedDeltaTimer: null,
    startupEvictionTimer: null,
    parkedDeltaRecoveryTimer: null,
    evictionReadyCheckTimer: null,
    onlineListener: null,
    parkedSyncOnlineListener: null,
    visibilityChangeHandler: null,
    firstInteractionHandler: null,
  };
}

function safeCleanup(cleanup: () => void): void {
  try {
    cleanup();
  } catch {
    // Cleanup must be best-effort so one stale browser listener cannot block the rest.
  }
}

function removeFirstInteractionListener(
  eventName: FirstInteractionEventName,
  listener: () => void,
  options: ParkingFirstInteractionCleanupOptions,
): boolean {
  const removeDocumentListener = options.removeDocumentListener
    ?? ((name, handler) => document.removeEventListener(name, handler));

  try {
    removeDocumentListener(eventName, listener);
    return true;
  } catch (error: unknown) {
    warnCleanupFailure(options, 'first interaction listener cleanup failed', error);
    return false;
  }
}

function warnCleanupFailure(
  options: ParkingFirstInteractionCleanupOptions,
  message: string,
  error: unknown,
): void {
  try {
    options.warn?.(message, error);
  } catch {
    // Warning sinks must not interrupt best-effort listener cleanup.
  }
}
