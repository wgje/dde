import { describe, expect, it, vi } from 'vitest';
import { AUTH_CONFIG } from '../../../config';
import {
  DEMO_BANNER_DISMISS_EXPIRY_MS,
  DEMO_BANNER_DISMISS_STORAGE_KEY,
  readDemoBannerDismissed,
  resolveDemoBannerVisible,
} from './demo-banner.helpers';

function makeStorage(initialValue: string | null) {
  return {
    getItem: vi.fn(() => initialValue),
    removeItem: vi.fn(),
  };
}

describe('demo-banner.helpers', () => {
  it('reads active dismissed state and clears expired or malformed records', () => {
    const now = 1_000_000;
    const activeStorage = makeStorage(JSON.stringify({ timestamp: now - 1000 }));
    expect(readDemoBannerDismissed(activeStorage, now)).toBe(true);
    expect(activeStorage.removeItem).not.toHaveBeenCalled();

    const expiredStorage = makeStorage(JSON.stringify({ timestamp: now - DEMO_BANNER_DISMISS_EXPIRY_MS - 1 }));
    expect(readDemoBannerDismissed(expiredStorage, now)).toBe(false);
    expect(expiredStorage.removeItem).toHaveBeenCalledWith(DEMO_BANNER_DISMISS_STORAGE_KEY);

    const malformedStorage = makeStorage(JSON.stringify({ timestamp: 'bad' }));
    expect(readDemoBannerDismissed(malformedStorage, now)).toBe(false);
    expect(malformedStorage.removeItem).toHaveBeenCalledWith(DEMO_BANNER_DISMISS_STORAGE_KEY);
  });

  it('resolves demo banner visibility from runtime state', () => {
    expect(resolveDemoBannerVisible({
      isMobile: false,
      dismissed: false,
      currentUserId: AUTH_CONFIG.LOCAL_MODE_USER_ID,
    })).toBe(false);
    expect(resolveDemoBannerVisible({
      isMobile: true,
      dismissed: true,
      currentUserId: AUTH_CONFIG.LOCAL_MODE_USER_ID,
    })).toBe(false);
    expect(resolveDemoBannerVisible({
      isMobile: true,
      dismissed: false,
      currentUserId: AUTH_CONFIG.LOCAL_MODE_USER_ID,
    })).toBe(true);
    expect(resolveDemoBannerVisible({
      isMobile: true,
      dismissed: false,
      currentUserId: null,
      localModeEnabled: true,
    })).toBe(true);
    expect(resolveDemoBannerVisible({
      isMobile: true,
      dismissed: false,
      currentUserId: null,
      demoModeEnabled: true,
    })).toBe(true);
  });
});
