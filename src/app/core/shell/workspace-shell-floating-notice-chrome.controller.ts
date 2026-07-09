import { signal } from '@angular/core';

import {
  resolveBlockingStartupHintOverlayVisible,
  resolveCompactStartupHintBannerVisible,
  resolveInstallPromptTop,
  resolveMobileFloatingNoticeBaseTopOffsetPx,
  resolveWorkspaceCompactStartupHintBannerTop,
} from './workspace-shell-chrome.helpers';
import {
  readDemoBannerDismissed,
  type DemoBannerDismissStorage,
  resolveRuntimeDemoBannerVisible,
} from '../../shared/components/demo-banner.helpers';

export interface WorkspaceShellFloatingNoticeChromeControllerOptions {
  isMobile: () => boolean;
  isOnline: () => boolean;
  offlineMode: () => boolean;
  queueFrozen: () => boolean;
  isDemoBannerDismissed?: () => boolean;
  getLocalStorage?: () => DemoBannerDismissStorage | undefined;
  currentUserId: () => string | null;
  installPromptVisible?: () => boolean;
  hintOnlyStartupPlaceholderVisible: () => boolean;
}

export class WorkspaceShellFloatingNoticeChromeController {
  readonly pwaPromptVisible = signal(false);

  constructor(private readonly options: WorkspaceShellFloatingNoticeChromeControllerOptions) {}

  blockingStartupHintOverlayVisible(): boolean {
    return resolveBlockingStartupHintOverlayVisible({
      hintOnlyStartupPlaceholderVisible: this.options.hintOnlyStartupPlaceholderVisible(),
      isMobile: this.options.isMobile(),
    });
  }

  compactStartupHintBannerVisible(): boolean {
    return resolveCompactStartupHintBannerVisible({
      hintOnlyStartupPlaceholderVisible: this.options.hintOnlyStartupPlaceholderVisible(),
      isMobile: this.options.isMobile(),
    });
  }

  mobileOfflineNoticeVisible(): boolean {
    return this.options.isMobile() && (
      !this.options.isOnline()
      || this.options.offlineMode()
      || this.options.queueFrozen()
    );
  }

  mobileDemoBannerVisible(): boolean {
    return resolveRuntimeDemoBannerVisible({
      isMobile: this.options.isMobile(),
      dismissed: this.isDemoBannerDismissed(),
      currentUserId: this.options.currentUserId(),
    });
  }

  mobileFloatingNoticeBaseTopOffsetPx(): number {
    return resolveMobileFloatingNoticeBaseTopOffsetPx({
      mobileDemoBannerVisible: this.mobileDemoBannerVisible(),
      mobileOfflineNoticeVisible: this.mobileOfflineNoticeVisible(),
    });
  }

  installPromptTop(): string {
    return resolveInstallPromptTop(
      this.options.isMobile(),
      this.mobileFloatingNoticeBaseTopOffsetPx(),
    );
  }

  compactStartupHintBannerTop(): string {
    return resolveWorkspaceCompactStartupHintBannerTop({
      isMobile: this.options.isMobile(),
      mobileOfflineNoticeVisible: this.mobileOfflineNoticeVisible(),
      mobileFloatingNoticeBaseTopOffsetPx: this.mobileFloatingNoticeBaseTopOffsetPx(),
      installPromptVisible: this.isInstallPromptVisible(),
    });
  }

  private isDemoBannerDismissed(): boolean {
    if (this.options.isDemoBannerDismissed) {
      return this.options.isDemoBannerDismissed();
    }

    return readDemoBannerDismissed(
      this.options.getLocalStorage?.() ?? getGlobalLocalStorage(),
    );
  }

  private isInstallPromptVisible(): boolean {
    return this.options.installPromptVisible?.() ?? this.pwaPromptVisible();
  }
}

function getGlobalLocalStorage(): DemoBannerDismissStorage | undefined {
  return typeof localStorage === 'undefined' ? undefined : localStorage;
}
