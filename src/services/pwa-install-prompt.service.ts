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
  private listenerGeneration = 0;

  private readonly dismissedSignal = signal<boolean>(this.readDismissedFlag());
  readonly canInstall = signal<boolean>(false);
  readonly nativeInstallHintAvailable = signal<boolean>(false);
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

    if (FEATURE_FLAGS.PWA_NATIVE_INSTALL_PROMPT_V1) {
      return this.isIos() || this.nativeInstallHintAvailable();
    }

    return this.canInstall() || this.isIos() || this.isAndroid();
  });

  readonly installHint = computed(() => {
    if (FEATURE_FLAGS.PWA_NATIVE_INSTALL_PROMPT_V1) {
      if (this.isIos()) {
        return 'iOS: 在浏览器分享菜单中选择“添加到主屏幕”';
      }

      if (this.nativeInstallHintAvailable()) {
        return '请使用浏览器地址栏或菜单中的“安装应用/添加到主屏幕”入口';
      }
    }

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
  private displayModeMedia: MediaQueryList | null = null;
  private pendingWindowListenerCleanup: Array<{
    type: string;
    listener: EventListener;
  }> = [];
  private pendingDisplayModeListenerCleanup: Array<{
    media: MediaQueryList;
    listener: () => void;
  }> = [];

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
    const listenerGeneration = ++this.listenerGeneration;

    this.beforeInstallPromptHandler = this.createBeforeInstallPromptHandler(listenerGeneration);
    this.appInstalledHandler = this.createAppInstalledHandler(listenerGeneration);
    this.displayModeHandler = this.createDisplayModeHandler(listenerGeneration);

    window.addEventListener('beforeinstallprompt', this.beforeInstallPromptHandler as EventListener);
    window.addEventListener('appinstalled', this.appInstalledHandler);

    this.displayModeMedia = window.matchMedia('(display-mode: standalone)');
    this.displayModeMedia.addEventListener('change', this.displayModeHandler);

    this.initialized = true;
    this.debugSafely('PWA 安装提示服务已初始化', {
      standalone: this.isStandaloneMode(),
      ios: this.isIos(),
      android: this.isAndroid(),
    });
  }

  private createBeforeInstallPromptHandler(listenerGeneration: number): (event: Event) => void {
    return (event: Event) => {
      if (!this.isCurrentListenerGeneration(listenerGeneration)) {
        return;
      }

      const installEvent = event as BeforeInstallPromptEvent;
      if (!installEvent.prompt || !installEvent.userChoice) {
        return;
      }

      if (FEATURE_FLAGS.PWA_NATIVE_INSTALL_PROMPT_V1) {
        this.deferredPrompt = null;
        this.canInstall.set(false);
        this.nativeInstallHintAvailable.set(true);
        this.infoSafely('检测到 beforeinstallprompt 事件，交由浏览器原生安装 UX 处理');
        return;
      }

      event.preventDefault();
      this.deferredPrompt = installEvent;
      this.canInstall.set(true);
      this.nativeInstallHintAvailable.set(false);
      this.infoSafely('捕获 beforeinstallprompt 事件');
    };
  }

  private createAppInstalledHandler(listenerGeneration: number): () => void {
    return () => {
      if (!this.isCurrentListenerGeneration(listenerGeneration)) {
        return;
      }

      this.infoSafely('PWA 安装完成');
      this.deferredPrompt = null;
      this.canInstall.set(false);
      this.nativeInstallHintAvailable.set(false);
      this.isStandaloneMode.set(true);
      this.dismissedSignal.set(true);
      this.writeDismissedFlag(true);
    };
  }

  private createDisplayModeHandler(listenerGeneration: number): () => void {
    return () => {
      if (!this.isCurrentListenerGeneration(listenerGeneration)) {
        return;
      }

      this.refreshDisplayMode();
    };
  }

  private isCurrentListenerGeneration(listenerGeneration: number): boolean {
    return this.listenerGeneration === listenerGeneration && this.initialized;
  }

  async promptInstall(): Promise<boolean> {
    const promptEvent = this.deferredPrompt;
    if (!promptEvent) {
      return false;
    }

    try {
      await promptEvent.prompt();
      const result = await promptEvent.userChoice;
      const accepted = result.outcome === 'accepted';

      this.infoSafely('安装提示结果', { outcome: result.outcome, platform: result.platform });

      if (accepted && this.deferredPrompt === promptEvent) {
        this.deferredPrompt = null;
        this.canInstall.set(false);
      }

      return accepted;
    } catch (error) {
      this.warnSafely('安装提示调用失败', error);
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
    this.listenerGeneration += 1;
    if (typeof window === 'undefined') {
      this.initialized = false;
      return;
    }

    this.retryPendingListenerCleanup();

    const beforeInstallPromptHandler = this.beforeInstallPromptHandler;
    this.beforeInstallPromptHandler = null;
    if (beforeInstallPromptHandler) {
      this.removeWindowListenerWithRetry('beforeinstallprompt', beforeInstallPromptHandler as EventListener);
    }

    const appInstalledHandler = this.appInstalledHandler;
    this.appInstalledHandler = null;
    if (appInstalledHandler) {
      this.removeWindowListenerWithRetry('appinstalled', appInstalledHandler);
    }

    const displayModeHandler = this.displayModeHandler;
    const displayModeMedia = this.displayModeMedia;
    this.displayModeHandler = null;
    this.displayModeMedia = null;
    if (displayModeHandler && displayModeMedia) {
      this.removeDisplayModeListenerWithRetry(displayModeMedia, displayModeHandler);
    }

    this.initialized = false;
  }

  private retryPendingListenerCleanup(): void {
    this.pendingWindowListenerCleanup = this.pendingWindowListenerCleanup.filter(({ type, listener }) => {
      return !this.removeWindowListenerSafely(type, listener);
    });
    this.pendingDisplayModeListenerCleanup = this.pendingDisplayModeListenerCleanup.filter(({ media, listener }) => {
      return !this.removeDisplayModeListenerSafely(media, listener);
    });
  }

  private removeWindowListenerWithRetry(type: string, listener: EventListener): void {
    if (!this.removeWindowListenerSafely(type, listener)) {
      this.pendingWindowListenerCleanup.push({ type, listener });
    }
  }

  private removeDisplayModeListenerWithRetry(
    media: MediaQueryList,
    listener: () => void,
  ): void {
    if (!this.removeDisplayModeListenerSafely(media, listener)) {
      this.pendingDisplayModeListenerCleanup.push({ media, listener });
    }
  }

  private removeWindowListenerSafely(type: string, listener: EventListener): boolean {
    try {
      window.removeEventListener(type, listener);
      return true;
    } catch {
      // Listener cleanup is best-effort; listenerGeneration invalidates stale callbacks.
      return false;
    }
  }

  private removeDisplayModeListenerSafely(
    media: MediaQueryList,
    listener: () => void,
  ): boolean {
    try {
      media.removeEventListener('change', listener);
      return true;
    } catch {
      // Listener cleanup is best-effort; listenerGeneration invalidates stale callbacks.
      return false;
    }
  }

  private infoSafely(message: string, data?: unknown): void {
    try {
      if (data === undefined) {
        this.logger.info(message);
      } else {
        this.logger.info(message, data);
      }
    } catch {
      // Logging must not affect install prompt state.
    }
  }

  private warnSafely(message: string, data?: unknown): void {
    try {
      if (data === undefined) {
        this.logger.warn(message);
      } else {
        this.logger.warn(message, data);
      }
    } catch {
      // Logging must not affect install prompt state.
    }
  }

  private debugSafely(message: string, data?: unknown): void {
    try {
      if (data === undefined) {
        this.logger.debug(message);
      } else {
        this.logger.debug(message, data);
      }
    } catch {
      // Logging must not affect install prompt initialization.
    }
  }
}
