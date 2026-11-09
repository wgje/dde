type VisibilityReason = 'visible';
type OnlineReason = 'online';

export interface ParkingStartupLifecycleHandles {
  visibilityChangeHandler: (() => void) | null;
  parkedSyncOnlineListener: (() => void) | null;
}

export interface ParkingStartupLifecycleOptions {
  beforeUnloadPriority: number;
  registerBeforeUnload: (
    key: string,
    callback: () => void,
    priority: number,
  ) => void;
  saveSnapshotToLocalStorage: () => void;
  saveSnapshotToIndexedDB: () => void | Promise<void>;
  scheduleParkedDeltaRefresh: (reason: VisibilityReason | OnlineReason) => void;
  initEviction: () => void;
  initParkedLightweightSync: () => Promise<void>;
  addDocumentListener?: (
    eventName: 'visibilitychange',
    listener: () => void,
  ) => void;
  addWindowListener?: (
    eventName: 'online',
    listener: () => void,
  ) => void;
  readVisibilityState?: () => DocumentVisibilityState;
}

export function initializeParkingStartupLifecycle(
  options: ParkingStartupLifecycleOptions,
): ParkingStartupLifecycleHandles {
  containFireAndForget(() =>
    options.registerBeforeUnload(
      'parking-snapshot',
      options.saveSnapshotToLocalStorage,
      options.beforeUnloadPriority,
    ),
  );

  const visibilityChangeHandler = createVisibilityChangeHandler(options);
  if (visibilityChangeHandler) {
    containFireAndForget(() => {
      getDocumentListener(options)?.('visibilitychange', visibilityChangeHandler);
    });
  }

  const parkedSyncOnlineListener = createOnlineListener(options);
  if (parkedSyncOnlineListener) {
    containFireAndForget(() => {
      getWindowListener(options)?.('online', parkedSyncOnlineListener);
    });
  }

  containFireAndForget(() => options.initEviction());
  containFireAndForget(() => options.initParkedLightweightSync());

  return { visibilityChangeHandler, parkedSyncOnlineListener };
}

function createVisibilityChangeHandler(
  options: ParkingStartupLifecycleOptions,
): (() => void) | null {
  if (!getDocumentListener(options)) return null;

  return () => {
    const visibilityState = options.readVisibilityState?.()
      ?? document.visibilityState;
    if (visibilityState === 'hidden') {
      containFireAndForget(() => options.saveSnapshotToIndexedDB());
      return;
    }

    containFireAndForget(() => options.scheduleParkedDeltaRefresh('visible'));
  };
}

function createOnlineListener(
  options: ParkingStartupLifecycleOptions,
): (() => void) | null {
  if (!getWindowListener(options)) return null;

  return () => {
    containFireAndForget(() => options.scheduleParkedDeltaRefresh('online'));
  };
}

function getDocumentListener(
  options: ParkingStartupLifecycleOptions,
): ParkingStartupLifecycleOptions['addDocumentListener'] | null {
  if (options.addDocumentListener) return options.addDocumentListener;
  if (typeof document === 'undefined') return null;

  return (eventName, listener) => document.addEventListener(eventName, listener);
}

function getWindowListener(
  options: ParkingStartupLifecycleOptions,
): ParkingStartupLifecycleOptions['addWindowListener'] | null {
  if (options.addWindowListener) return options.addWindowListener;
  if (typeof window === 'undefined') return null;

  return (eventName, listener) => window.addEventListener(eventName, listener);
}

function containFireAndForget(run: () => void | Promise<void>): void {
  try {
    const result = run();
    if (result && typeof result.catch === 'function') {
      void result.catch(() => undefined);
    }
  } catch {
    // fire-and-forget lifecycle work must not break startup or visibility dispatch
  }
}
