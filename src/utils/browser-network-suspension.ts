const NETWORK_VISIBLE_RESUME_GRACE_MS = 1500;
const NETWORK_ONLINE_RESUME_GRACE_MS = 5000;
const NETWORK_ERROR_RESUME_GRACE_MS = 5000;
const BROWSER_NETWORK_SUSPENDED_ERROR_NAME = 'BrowserNetworkSuspendedError';
const BROWSER_NETWORK_SUSPENDED_ERROR_MESSAGE = 'Browser network IO suspended';

let trackingInitialized = false;
let networkBlockedUntil = 0;
let visibilityChangeHandler: (() => void) | null = null;
let pageShowHandler: ((event: PageTransitionEvent) => void) | null = null;
let onlineHandler: (() => void) | null = null;

function armNetworkResumeGrace(graceMs = NETWORK_VISIBLE_RESUME_GRACE_MS): void {
  networkBlockedUntil = Math.max(networkBlockedUntil, Date.now() + graceMs);
}

function runListenerCleanupBestEffort(cleanup: () => void): void {
  try {
    cleanup();
  } catch {
    // Listener cleanup must not mask the primary lifecycle operation.
  }
}

export function ensureBrowserNetworkSuspensionTracking(): void {
  if (trackingInitialized || typeof window === 'undefined' || typeof document === 'undefined') {
    return;
  }

  const currentDocument = document;
  const currentWindow = window;
  const registeredCleanups: Array<() => void> = [];

  const nextVisibilityChangeHandler = () => {
    if (document.visibilityState === 'visible') {
      armNetworkResumeGrace();
    }
  };

  const nextPageShowHandler = (event: PageTransitionEvent) => {
    if (event.persisted) {
      armNetworkResumeGrace(NETWORK_ONLINE_RESUME_GRACE_MS);
    }
  };

  const nextOnlineHandler = () => {
    armNetworkResumeGrace(NETWORK_ONLINE_RESUME_GRACE_MS);
  };

  visibilityChangeHandler = nextVisibilityChangeHandler;
  pageShowHandler = nextPageShowHandler;
  onlineHandler = nextOnlineHandler;

  try {
    currentDocument.addEventListener('visibilitychange', nextVisibilityChangeHandler);
    registeredCleanups.push(() => {
      currentDocument.removeEventListener('visibilitychange', nextVisibilityChangeHandler);
    });

    currentWindow.addEventListener('pageshow', nextPageShowHandler as EventListener);
    registeredCleanups.push(() => {
      currentWindow.removeEventListener('pageshow', nextPageShowHandler as EventListener);
    });

    currentWindow.addEventListener('online', nextOnlineHandler);
    registeredCleanups.push(() => {
      currentWindow.removeEventListener('online', nextOnlineHandler);
    });
    trackingInitialized = true;
  } catch (error) {
    for (const cleanup of registeredCleanups.reverse()) {
      runListenerCleanupBestEffort(cleanup);
    }

    visibilityChangeHandler = null;
    pageShowHandler = null;
    onlineHandler = null;
    trackingInitialized = false;
    throw error;
  }
}

export function isBrowserNetworkSuspendedWindow(): boolean {
  ensureBrowserNetworkSuspensionTracking();

  if (typeof document !== 'undefined' && document.visibilityState !== 'visible') {
    return true;
  }

  return Date.now() < networkBlockedUntil;
}

export function getRemainingBrowserNetworkResumeDelayMs(): number {
  ensureBrowserNetworkSuspensionTracking();
  return Math.max(0, networkBlockedUntil - Date.now());
}

export function createBrowserNetworkSuspendedError(): Error {
  const error = new Error(BROWSER_NETWORK_SUSPENDED_ERROR_MESSAGE);
  error.name = BROWSER_NETWORK_SUSPENDED_ERROR_NAME;
  return error;
}

export function resetBrowserNetworkSuspensionTrackingForTests(): void {
  if (typeof document !== 'undefined' && visibilityChangeHandler) {
    const handler = visibilityChangeHandler;
    runListenerCleanupBestEffort(() => {
      document.removeEventListener('visibilitychange', handler);
    });
  }

  if (typeof window !== 'undefined' && pageShowHandler) {
    const handler = pageShowHandler;
    runListenerCleanupBestEffort(() => {
      window.removeEventListener('pageshow', handler as EventListener);
    });
  }

  if (typeof window !== 'undefined' && onlineHandler) {
    const handler = onlineHandler;
    runListenerCleanupBestEffort(() => {
      window.removeEventListener('online', handler);
    });
  }

  visibilityChangeHandler = null;
  pageShowHandler = null;
  onlineHandler = null;
  networkBlockedUntil = 0;
  trackingInitialized = false;
}

export function isBrowserNetworkSuspendedError(error: unknown): boolean {
  if ((error as { name?: string } | null)?.name === BROWSER_NETWORK_SUSPENDED_ERROR_NAME) {
    armNetworkResumeGrace(NETWORK_ERROR_RESUME_GRACE_MS);
    return true;
  }

  const message = String((error as { message?: string })?.message ?? error ?? '').toLowerCase();
  const suspended = message.includes('network_io_suspended') || message.includes('network io suspended');
  if (suspended) {
    armNetworkResumeGrace(NETWORK_ERROR_RESUME_GRACE_MS);
  }
  return suspended;
}
