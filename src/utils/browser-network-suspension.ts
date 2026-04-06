const NETWORK_RESUME_GRACE_MS = 1500;
const BROWSER_NETWORK_SUSPENDED_ERROR_NAME = 'BrowserNetworkSuspendedError';
const BROWSER_NETWORK_SUSPENDED_ERROR_MESSAGE = 'Browser network IO suspended';

let trackingInitialized = false;
let networkBlockedUntil = 0;
let visibilityChangeHandler: (() => void) | null = null;
let pageShowHandler: ((event: PageTransitionEvent) => void) | null = null;
let onlineHandler: (() => void) | null = null;

function armNetworkResumeGrace(): void {
  networkBlockedUntil = Math.max(networkBlockedUntil, Date.now() + NETWORK_RESUME_GRACE_MS);
}

export function ensureBrowserNetworkSuspensionTracking(): void {
  if (trackingInitialized || typeof window === 'undefined' || typeof document === 'undefined') {
    return;
  }

  visibilityChangeHandler = () => {
    if (document.visibilityState === 'visible') {
      armNetworkResumeGrace();
    }
  };

  pageShowHandler = (event: PageTransitionEvent) => {
    if (event.persisted) {
      armNetworkResumeGrace();
    }
  };

  onlineHandler = () => {
    armNetworkResumeGrace();
  };

  document.addEventListener('visibilitychange', visibilityChangeHandler);
  window.addEventListener('pageshow', pageShowHandler as EventListener);
  window.addEventListener('online', onlineHandler);
  trackingInitialized = true;
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
    document.removeEventListener('visibilitychange', visibilityChangeHandler);
  }

  if (typeof window !== 'undefined' && pageShowHandler) {
    window.removeEventListener('pageshow', pageShowHandler as EventListener);
  }

  if (typeof window !== 'undefined' && onlineHandler) {
    window.removeEventListener('online', onlineHandler);
  }

  visibilityChangeHandler = null;
  pageShowHandler = null;
  onlineHandler = null;
  networkBlockedUntil = 0;
  trackingInitialized = false;
}

export function isBrowserNetworkSuspendedError(error: unknown): boolean {
  if ((error as { name?: string } | null)?.name === BROWSER_NETWORK_SUSPENDED_ERROR_NAME) {
    return true;
  }

  const message = String((error as { message?: string })?.message ?? error ?? '').toLowerCase();
  return message.includes('network_io_suspended') || message.includes('network io suspended');
}