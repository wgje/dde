import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import { FEATURE_FLAGS } from '../config/feature-flags.config';
import { LoggerService } from './logger.service';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{
    outcome: 'accepted' | 'dismissed';
    platform: string;
  }>;
}

interface NavigatorIOSStandalone extends Navigator {
  standalone?: boolean;
}

@Injectable({ providedIn: 'root' })
export class PwaInstallPromptService {
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('PwaInstallPrompt');
  private readonly destroyRef = inject(DestroyRef);

  private deferredPrompt: BeforeInstallPromptEvent | null = null;
  private initialized = false;

  private readonly dismissedSignal = signal<boolean>(this.readDismissedFlag());
  readonly canInstall = signal<boolean>(false);
  readonly isStandaloneMode = signal<boolean>(this.detectStandaloneMode());
  readonly isIos = signal<boolean>(false);
  readonly isAndroid = signal<boolean>(false);

  readonly canShowInstallPrompt = computed(() => {
    if (!FEATURE_FLAGS.PWA_INSTALL_PROMPT_V1) {
      return false;
    }

    if (this.isStandaloneMode() || this.dismissedSignal()) {
      return false;
    }

    return this.canInstall() || this.isIos() || this.isAndroid();
  });

  readonly installHint = computed(() => {
    if (this.canInstall()) {
      return '可一键安装，获得更接近原生应用的体验';
    }

    if (this.isIos()) {
      return 'iOS: 在浏览器分享菜单中选择“添加到主屏幕”';
    }

    if (this.isAndroid()) {
      return 'Android: 在浏览器菜单中选择“安装应用”或“添加到主屏幕”';
    }

    return '可安装为桌面/主屏应用，支持独立窗口运行';
  });

  private beforeInstallPromptHandler: ((event: Event) => void) | null = null;
  private appInstalledHandler: (() => void) | null = null;
  private displayModeHandler: (() => void) | null = null;

  private static readonly DISMISSED_KEY = 'nanoflow.pwa-install.dismissed';

  constructor() {
    this.destroyRef.onDestroy(() => this.cleanup());
  }

  initialize(): void {
    if (this.initialized || typeof window === 'undefined') {
      return;
    }

    this.updatePlatformSignals();
    this.refreshDisplayMode();

    this.beforeInstallPromptHandler = (event: Event) => {
      const installEvent = event as BeforeInstallPromptEvent;
      if (!installEvent.prompt || !installEvent.userChoice) {
        return;
      }

      event.preventDefault();
      this.deferredPrompt = installEvent;
      this.canInstall.set(true);
      this.logger.info('捕获 beforeinstallprompt 事件');
    };

    this.appInstalledHandler = () => {
      this.logger.info('PWA 安装完成');
      this.deferredPrompt = null;
      this.canInstall.set(false);
      this.isStandaloneMode.set(true);
      this.dismissedSignal.set(true);
      this.writeDismissedFlag(true);
    };

    this.displayModeHandler = () => this.refreshDisplayMode();

    window.addEventListener('beforeinstallprompt', this.beforeInstallPromptHandler as EventListener);
    window.addEventListener('appinstalled', this.appInstalledHandler);

    const media = window.matchMedia('(display-mode: standalone)');
    media.addEventListener('change', this.displayModeHandler);

    this.initialized = true;
    this.logger.debug('PWA 安装提示服务已初始化', {
      standalone: this.isStandaloneMode(),
      ios: this.isIos(),
      android: this.isAndroid(),
    });
  }

  async promptInstall(): Promise<boolean> {
    if (!this.deferredPrompt) {
      return false;
    }

    try {
      await this.deferredPrompt.prompt();
      const result = await this.deferredPrompt.userChoice;
      const accepted = result.outcome === 'accepted';

      this.logger.info('安装提示结果', { outcome: result.outcome, platform: result.platform });

      if (accepted) {
        this.deferredPrompt = null;
        this.canInstall.set(false);
      }

      return accepted;
    } catch (error) {
      this.logger.warn('安装提示调用失败', error);
      return false;
    }
  }

  dismissPrompt(): void {
    this.dismissedSignal.set(true);
    this.writeDismissedFlag(true);
  }

  resetDismissedPrompt(): void {
    this.dismissedSignal.set(false);
    this.writeDismissedFlag(false);
  }

  private refreshDisplayMode(): void {
    this.isStandaloneMode.set(this.detectStandaloneMode());
  }

  private detectStandaloneMode(): boolean {
    if (typeof window === 'undefined') {
      return false;
    }

    const nav = navigator as NavigatorIOSStandalone;
    return window.matchMedia('(display-mode: standalone)').matches || nav.standalone === true;
  }

  private updatePlatformSignals(): void {
    if (typeof navigator === 'undefined') {
      return;
    }

    const ua = navigator.userAgent;
    // iPadOS 13+ 报告 Macintosh UA，需要通过触控点检测
    const isIos = /iPhone|iPad|iPod/i.test(ua) ||
      (ua.includes('Macintosh') && navigator.maxTouchPoints > 1);
    const isAndroid = /Android/i.test(ua);

    this.isIos.set(isIos);
    this.isAndroid.set(isAndroid);
  }

  private readDismissedFlag(): boolean {
    try {
      if (typeof localStorage === 'undefined') {
        return false;
      }
      return localStorage.getItem(PwaInstallPromptService.DISMISSED_KEY) === 'true';
    } catch {
      return false;
    }
  }

  private writeDismissedFlag(value: boolean): void {
    try {
      if (typeof localStorage === 'undefined') {
        return;
      }
      localStorage.setItem(PwaInstallPromptService.DISMISSED_KEY, String(value));
    } catch {
      // 忽略写入失败
    }
  }

  private cleanup(): void {
    if (typeof window === 'undefined') {
      return;
    }

    if (this.beforeInstallPromptHandler) {
      window.removeEventListener('beforeinstallprompt', this.beforeInstallPromptHandler as EventListener);
      this.beforeInstallPromptHandler = null;
    }

    if (this.appInstalledHandler) {
      window.removeEventListener('appinstalled', this.appInstalledHandler);
      this.appInstalledHandler = null;
    }

    if (this.displayModeHandler) {
      const media = window.matchMedia('(display-mode: standalone)');
      media.removeEventListener('change', this.displayModeHandler);
      this.displayModeHandler = null;
    }

    this.initialized = false;
  }
}
