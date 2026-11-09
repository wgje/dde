import { AUTH_CONFIG, FEATURE_FLAGS } from '../../../config';
import { isLocalModeEnabled } from '../../../services/guards/auth.guard';

export const DEMO_BANNER_DISMISS_STORAGE_KEY = 'nanoflow.demo-banner-dismissed';
export const DEMO_BANNER_DISMISS_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

export interface DemoBannerDismissStorage {
  getItem: (key: string) => string | null;
  removeItem: (key: string) => void;
}

export interface DemoBannerVisibilityState {
  isMobile?: boolean;
  dismissed: boolean;
  currentUserId: string | null;
  localModeEnabled?: boolean;
  demoModeEnabled?: boolean;
}

export function readDemoBannerDismissed(
  storage: DemoBannerDismissStorage | undefined,
  nowMs: number = Date.now(),
): boolean {
  if (!storage) {
    return false;
  }

  try {
    const stored = storage.getItem(DEMO_BANNER_DISMISS_STORAGE_KEY);
    if (!stored) {
      return false;
    }

    const data = JSON.parse(stored) as { timestamp?: unknown } | null;
    if (!data || typeof data.timestamp !== 'number') {
      storage.removeItem(DEMO_BANNER_DISMISS_STORAGE_KEY);
      return false;
    }

    if (nowMs - data.timestamp < DEMO_BANNER_DISMISS_EXPIRY_MS) {
      return true;
    }

    storage.removeItem(DEMO_BANNER_DISMISS_STORAGE_KEY);
    return false;
  } catch {
    return false;
  }
}

export function resolveDemoBannerVisible(state: DemoBannerVisibilityState): boolean {
  if (state.isMobile === false || state.dismissed) {
    return false;
  }

  return Boolean(state.localModeEnabled)
    || state.currentUserId === AUTH_CONFIG.LOCAL_MODE_USER_ID
    || Boolean(state.demoModeEnabled);
}

export function resolveRuntimeDemoBannerVisible(
  state: Omit<DemoBannerVisibilityState, 'localModeEnabled' | 'demoModeEnabled'>,
): boolean {
  return resolveDemoBannerVisible({
    ...state,
    localModeEnabled: isLocalModeEnabled(),
    demoModeEnabled: FEATURE_FLAGS.DEMO_MODE_ENABLED ?? false,
  });
}
