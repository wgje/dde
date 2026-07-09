import { describe, expect, it } from 'vitest';

import { AUTH_CONFIG } from '../../../config';
import { DEMO_BANNER_DISMISS_STORAGE_KEY } from '../../shared/components/demo-banner.helpers';
import { WorkspaceShellFloatingNoticeChromeController } from './workspace-shell-floating-notice-chrome.controller';

function createController({
  isMobile = true,
  isOnline = true,
  offlineMode = false,
  queueFrozen = false,
  demoBannerDismissed = false,
  currentUserId = null,
  installPromptVisible = false,
  hintOnlyStartupPlaceholderVisible = false,
}: {
  isMobile?: boolean;
  isOnline?: boolean;
  offlineMode?: boolean;
  queueFrozen?: boolean;
  demoBannerDismissed?: boolean;
  currentUserId?: string | null;
  installPromptVisible?: boolean;
  hintOnlyStartupPlaceholderVisible?: boolean;
} = {}): WorkspaceShellFloatingNoticeChromeController {
  return new WorkspaceShellFloatingNoticeChromeController({
    isMobile: () => isMobile,
    isOnline: () => isOnline,
    offlineMode: () => offlineMode,
    queueFrozen: () => queueFrozen,
    isDemoBannerDismissed: () => demoBannerDismissed,
    currentUserId: () => currentUserId,
    installPromptVisible: () => installPromptVisible,
    hintOnlyStartupPlaceholderVisible: () => hintOnlyStartupPlaceholderVisible,
  });
}

describe('WorkspaceShellFloatingNoticeChromeController', () => {
  it('resolves startup hint visibility for desktop overlay and mobile banner', () => {
    expect(createController({ hintOnlyStartupPlaceholderVisible: true, isMobile: false })
      .blockingStartupHintOverlayVisible()).toBe(true);
    expect(createController({ hintOnlyStartupPlaceholderVisible: true, isMobile: true })
      .blockingStartupHintOverlayVisible()).toBe(false);
    expect(createController({ hintOnlyStartupPlaceholderVisible: true, isMobile: true })
      .compactStartupHintBannerVisible()).toBe(true);
    expect(createController({ hintOnlyStartupPlaceholderVisible: false, isMobile: true })
      .compactStartupHintBannerVisible()).toBe(false);
  });

  it('resolves mobile floating notice offsets from demo and offline state', () => {
    expect(createController({ currentUserId: AUTH_CONFIG.LOCAL_MODE_USER_ID }).mobileFloatingNoticeBaseTopOffsetPx())
      .toBe(104);
    expect(createController({
      currentUserId: AUTH_CONFIG.LOCAL_MODE_USER_ID,
      isOnline: false,
    }).mobileFloatingNoticeBaseTopOffsetPx()).toBe(146);
    expect(createController({
      currentUserId: AUTH_CONFIG.LOCAL_MODE_USER_ID,
      demoBannerDismissed: true,
    }).mobileFloatingNoticeBaseTopOffsetPx()).toBe(0);
    expect(createController({
      currentUserId: AUTH_CONFIG.LOCAL_MODE_USER_ID,
      demoBannerDismissed: true,
      queueFrozen: true,
    }).mobileFloatingNoticeBaseTopOffsetPx())
      .toBe(84);
  });

  it('resolves install prompt and compact startup hint top offsets', () => {
    expect(createController({
      currentUserId: AUTH_CONFIG.LOCAL_MODE_USER_ID,
      isOnline: false,
    }).installPromptTop())
      .toBe('calc(env(safe-area-inset-top, 0px) + 146px)');
    expect(createController({ demoBannerDismissed: true, isOnline: false }).compactStartupHintBannerTop())
      .toBe('calc(env(safe-area-inset-top, 0px) + 84px)');
    expect(createController({
      currentUserId: AUTH_CONFIG.LOCAL_MODE_USER_ID,
      isOnline: false,
      installPromptVisible: true,
    }).compactStartupHintBannerTop()).toBe('calc(env(safe-area-inset-top, 0px) + 190px)');
  });

  it('owns install prompt visibility and can read demo banner dismissal from storage', () => {
    const storage = new Map<string, string>();
    storage.set(
      DEMO_BANNER_DISMISS_STORAGE_KEY,
      JSON.stringify({ timestamp: Date.now() }),
    );
    const controller = new WorkspaceShellFloatingNoticeChromeController({
      isMobile: () => true,
      isOnline: () => false,
      offlineMode: () => false,
      queueFrozen: () => false,
      currentUserId: () => AUTH_CONFIG.LOCAL_MODE_USER_ID,
      hintOnlyStartupPlaceholderVisible: () => false,
      getLocalStorage: () => ({
        getItem: (key) => storage.get(key) ?? null,
        removeItem: (key) => {
          storage.delete(key);
        },
      }),
    });

    expect(controller.mobileDemoBannerVisible()).toBe(false);
    expect(controller.pwaPromptVisible()).toBe(false);

    controller.pwaPromptVisible.set(true);

    expect(controller.compactStartupHintBannerTop())
      .toBe('calc(env(safe-area-inset-top, 0px) + 128px)');
  });
});
