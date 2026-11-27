import { DestroyRef, Injectable, inject, signal } from '@angular/core';
import { STARTUP_PERF_CONFIG } from '../config/startup-performance.config';
import { FEATURE_FLAGS } from '../config/feature-flags.config';
import { LoggerService } from './logger.service';

type FontLoadTrigger = 'interaction' | 'timeout' | 'force' | 'immediate';
type BootFlags = {
  FONT_EXTREME_FIRSTPAINT_V1?: boolean;
  FONT_AGGRESSIVE_DEFER_V2?: boolean;
};
type FontLoadOptions = { respectConstrainedNetwork?: boolean };
type NetworkInfo = {
  effectiveType?: string;
  downlink?: number;
  rtt?: number;
  saveData?: boolean;
};

@Injectable({ providedIn: 'root' })
export class StartupFontSchedulerService {
  private readonly logger = inject(LoggerService).category('StartupFontScheduler');
  private readonly destroyRef = inject(DestroyRef);

  private readonly enhancedFontLoadedSignal = signal(false);
  private readonly fontStylesheetName = 'lxgw-wenkai-screen.css';
  /**
   * 同源补充字体 CSS：只包含 14 个基础子集之外的 83 个子集，避免覆盖已有字体声明。
   * 浏览器根据 unicode-range 按需下载，不会加载未使用的子集。
   * Service Worker 的 local-fonts lazy 组按需缓存；从未缓存的字形离线使用系统回退。
   */
  private readonly supplementFontStylesheetUrl =
    '/fonts/lxgw-wenkai-screen-supplement.css';

  private initialized = false;
  private loading = false;
  private fallbackTimer: ReturnType<typeof setTimeout> | null = null;
  private forceFallbackTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly pendingStylesheetLinks = new Set<HTMLLinkElement>();
  private destroyed = false;
  /** 【修复 2026-02-19】加载失败重试次数 */
  private retryCount = 0;
  private static readonly MAX_RETRY = 2;
  private static readonly RETRY_DELAY_MS = 5000;

  private readonly firstInteractionHandler = () => {
    this.loadEnhancedFontStyles('interaction');
  };

  constructor() {
    this.destroyRef.onDestroy(() => {
      this.destroyed = true;
      this.clearTimers();
      this.unbindInteractionListeners();
      this.clearPendingStylesheetLinkCallbacks();
    });
  }

  initialize(): void {
    if (this.destroyed || this.initialized || typeof window === 'undefined' || typeof document === 'undefined') {
      return;
    }

    if (this.isFontStylesheetPresent()) {
      this.initialized = true;
      this.enhancedFontLoadedSignal.set(true);
      // 本地字体 CSS 已存在（SW 缓存命中等），仍需注入同源补充字体
      this.injectSupplementStylesheet();
      return;
    }

    if (!this.isExtremeFirstpaintEnabled()) {
      this.initialized = true;
      this.loadEnhancedFontStyles('immediate');
      return;
    }

    try {
      this.bindFirstInteractionListeners();

      if (!this.isAggressiveDeferEnabled()) {
        this.scheduleTimeoutFallback(false);
        this.initialized = true;
        return;
      }

      if (!STARTUP_PERF_CONFIG.FONT_ENHANCED_INTERACTION_ONLY_V2) {
        this.scheduleTimeoutFallback(false);
        this.initialized = true;
        return;
      }

      this.scheduleTimeoutFallback(true);
      this.forceFallbackTimer = setTimeout(() => {
        this.loadEnhancedFontStyles('force');
      }, STARTUP_PERF_CONFIG.FONT_ENHANCED_FORCE_LOAD_MAX_DELAY_MS);
      this.initialized = true;
    } catch (error) {
      this.rollbackDeferredFontSetup(error);
    }
  }

  isEnhancedFontLoaded(): boolean {
    return this.enhancedFontLoadedSignal();
  }

  private bindFirstInteractionListeners(): void {
    window.addEventListener('pointerdown', this.firstInteractionHandler, { once: true, passive: true });
    window.addEventListener('keydown', this.firstInteractionHandler, { once: true });
    window.addEventListener('touchstart', this.firstInteractionHandler, { once: true, passive: true });
  }

  private unbindInteractionListeners(): void {
    this.removeInteractionListener('pointerdown');
    this.removeInteractionListener('keydown');
    this.removeInteractionListener('touchstart');
  }

  private removeInteractionListener(eventName: 'pointerdown' | 'keydown' | 'touchstart'): void {
    const remove = () => window.removeEventListener(eventName, this.firstInteractionHandler);
    try {
      remove();
      return;
    } catch (error) {
      this.warnInteractionListenerCleanupFailure(eventName, error);
    }

    try {
      remove();
    } catch (error) {
      this.warnInteractionListenerCleanupFailure(eventName, error);
    }
  }

  private warnInteractionListenerCleanupFailure(
    eventName: 'pointerdown' | 'keydown' | 'touchstart',
    error: unknown,
  ): void {
    this.logger.warn('增强字体交互监听解绑失败，继续清理其他监听', {
      eventName,
      message: error instanceof Error ? error.message : 'unknown',
    });
  }

  private rollbackDeferredFontSetup(error: unknown): void {
    this.initialized = false;
    this.clearTimers();
    this.unbindInteractionListeners();
    try {
      this.logger.warn('增强字体延迟加载初始化失败，已回滚并允许重试', {
        message: error instanceof Error ? error.message : 'unknown',
      });
    } catch {
      // Warning sinks must not interrupt startup font retryability.
    }
  }

  private scheduleTimeoutFallback(respectConstrainedNetwork: boolean): void {
    this.fallbackTimer = setTimeout(() => {
      this.loadEnhancedFontStyles('timeout', { respectConstrainedNetwork });
    }, STARTUP_PERF_CONFIG.FONT_ENHANCED_LOAD_DELAY_MS);
  }

  private clearTimers(): void {
    if (this.fallbackTimer !== null) {
      clearTimeout(this.fallbackTimer);
      this.fallbackTimer = null;
    }
    if (this.forceFallbackTimer !== null) {
      clearTimeout(this.forceFallbackTimer);
      this.forceFallbackTimer = null;
    }
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  private clearPendingStylesheetLinkCallbacks(): void {
    for (const link of this.pendingStylesheetLinks) {
      this.clearStylesheetLinkCallbacks(link);
    }
    this.pendingStylesheetLinks.clear();
  }

  private clearStylesheetLinkCallbacks(link: HTMLLinkElement): void {
    link.onload = null;
    link.onerror = null;
  }

  private loadEnhancedFontStyles(trigger: FontLoadTrigger, options: FontLoadOptions = {}): void {
    if (this.destroyed || this.enhancedFontLoadedSignal() || this.loading || typeof document === 'undefined') {
      return;
    }

    if (options.respectConstrainedNetwork && this.shouldSkipTimeoutOnConstrainedNetwork()) {
      this.logger.debug('弱网下跳过 timeout 增强字体加载', { trigger });
      return;
    }

    this.clearTimers();
    this.unbindInteractionListeners();

    const existingLink = this.getExistingStylesheetLink();
    if (existingLink) {
      this.enhancedFontLoadedSignal.set(true);
      // 本地字体已通过其他路径加载，仍需补充 同源 子集
      this.injectSupplementStylesheet();
      return;
    }

    this.loading = true;
    const candidates = this.resolveFontStylesheetCandidates();
    this.injectStylesheetWithFallback(candidates, 0, trigger);
  }

  private isFontStylesheetPresent(): boolean {
    return !!this.getExistingStylesheetLink();
  }

  private getExistingStylesheetLink(): HTMLLinkElement | null {
    const links = Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]'));
    return links.find((link) => link.href.includes(this.fontStylesheetName)) ?? null;
  }

  private shouldSkipTimeoutOnConstrainedNetwork(): boolean {
    if (!STARTUP_PERF_CONFIG.FONT_ENHANCED_SKIP_ON_CONSTRAINED_NETWORK) {
      return false;
    }
    return this.isConstrainedNetwork();
  }

  private isConstrainedNetwork(): boolean {
    if (typeof navigator === 'undefined') {
      return false;
    }

    const nav = navigator as Navigator & {
      connection?: NetworkInfo;
      mozConnection?: NetworkInfo;
      webkitConnection?: NetworkInfo;
    };
    const connection = nav.connection || nav.mozConnection || nav.webkitConnection;
    if (!connection) return false;

    const effectiveType = String(connection.effectiveType || '');
    const downlink = typeof connection.downlink === 'number' ? connection.downlink : 0;
    const rtt = typeof connection.rtt === 'number' ? connection.rtt : 0;
    const saveData = !!connection.saveData;

    return (
      saveData ||
      effectiveType === '2g' ||
      effectiveType === 'slow-2g' ||
      (downlink > 0 && downlink < 1.5) ||
      rtt > 280
    );
  }

  private resolveFontStylesheetCandidates(): string[] {
    if (typeof document === 'undefined') {
      return [`/fonts/${this.fontStylesheetName}`];
    }

    const fallback = `/fonts/${this.fontStylesheetName}`;
    try {
      const preferred = new URL(`fonts/${this.fontStylesheetName}`, document.baseURI).toString();
      return preferred === fallback ? [preferred] : [preferred, fallback];
    } catch {
      return [fallback];
    }
  }

  private injectStylesheetWithFallback(candidates: string[], index: number, trigger: FontLoadTrigger): void {
    if (typeof document === 'undefined') {
      this.loading = false;
      return;
    }

    if (index >= candidates.length) {
      this.loading = false;
      // 【修复 2026-02-19】加载失败时延迟重试，确保字体最终统一
      if (this.retryCount < StartupFontSchedulerService.MAX_RETRY) {
        this.retryCount++;
        this.logger.warn('增强字体加载失败，将在延迟后重试', {
          trigger, candidates, retry: this.retryCount
        });
        this.retryTimer = setTimeout(() => {
          this.retryTimer = null;
          this.loadEnhancedFontStyles('force');
        }, StartupFontSchedulerService.RETRY_DELAY_MS);
      } else {
        this.logger.warn('增强字体加载失败（所有候选路径及重试均不可用）', { trigger, candidates });
      }
      return;
    }

    const href = candidates[index];
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    link.setAttribute('data-nanoflow-enhanced-font', 'true');
    // 非阻塞加载：media="print" 让浏览器异步下载而不阻塞渲染
    link.media = 'print';
    this.pendingStylesheetLinks.add(link);

    link.onload = () => {
      if (this.destroyed) return;
      this.pendingStylesheetLinks.delete(link);
      this.clearStylesheetLinkCallbacks(link);
      link.media = 'all';
      this.loading = false;
      this.enhancedFontLoadedSignal.set(true);
      this.logger.debug('增强字体已加载', { trigger, href });
      // 自托管字体加载成功后，注入同源补充字体覆盖剩余 83 个子集（168 个缺失字符）
      this.injectSupplementStylesheet();
    };

    link.onerror = () => {
      if (this.destroyed) return;
      this.pendingStylesheetLinks.delete(link);
      this.clearStylesheetLinkCallbacks(link);
      link.remove();
      this.logger.warn('增强字体加载失败，尝试备用路径', { trigger, href });
      this.injectStylesheetWithFallback(candidates, index + 1, trigger);
    };

    document.head.appendChild(link);
  }

  /**
   * 注入同源补充字体样式表（非渲染阻塞）。
   * 基础 CSS 和内联首屏字形包含 14 个子集，补充 CSS 只包含其余 83 个子集。
   * 浏览器根据 unicode-range 只下载页面实际用到的子集文件。
   * 补充范围与基础子集互斥，不依赖同 family 的 @font-face 定义顺序。
   * 使用 media="print" → "all" 技巧避免阻塞渲染，字体异步加载。
   * 同源加载失败不影响核心体验，仅少数低频字符回退为系统字体。
   */
  private injectSupplementStylesheet(): void {
    if (typeof document === 'undefined') return;

    // 避免重复注入
    const existing = document.querySelector('link[data-nanoflow-supplement-font]');
    if (existing) return;

    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = this.supplementFontStylesheetUrl;
    link.setAttribute('data-nanoflow-supplement-font', 'true');
    // 非阻塞加载：media="print" 让浏览器异步下载 CSS，加载完成后切换到 "all"
    link.media = 'print';
    this.pendingStylesheetLinks.add(link);

    link.onload = () => {
      if (this.destroyed) return;
      this.pendingStylesheetLinks.delete(link);
      this.clearStylesheetLinkCallbacks(link);
      link.media = 'all';
      this.logger.debug('同源补充字体样式已加载（覆盖额外 83 个子集）');
    };

    link.onerror = () => {
      if (this.destroyed) return;
      this.pendingStylesheetLinks.delete(link);
      this.clearStylesheetLinkCallbacks(link);
      link.remove();
      this.logger.warn('同源补充字体加载失败（不影响核心体验，未缓存的字形使用系统回退字体）');
    };

    document.head.appendChild(link);
  }

  private isExtremeFirstpaintEnabled(): boolean {
    if (typeof window === 'undefined') {
      return FEATURE_FLAGS.FONT_EXTREME_FIRSTPAINT_V1;
    }

    const bootFlag = (window as Window & { __NANOFLOW_BOOT_FLAGS__?: BootFlags })
      .__NANOFLOW_BOOT_FLAGS__
      ?.FONT_EXTREME_FIRSTPAINT_V1;

    return typeof bootFlag === 'boolean'
      ? bootFlag
      : FEATURE_FLAGS.FONT_EXTREME_FIRSTPAINT_V1;
  }

  private isAggressiveDeferEnabled(): boolean {
    if (typeof window === 'undefined') {
      return FEATURE_FLAGS.FONT_AGGRESSIVE_DEFER_V2;
    }

    const bootFlag = (window as Window & { __NANOFLOW_BOOT_FLAGS__?: BootFlags })
      .__NANOFLOW_BOOT_FLAGS__
      ?.FONT_AGGRESSIVE_DEFER_V2;

    return typeof bootFlag === 'boolean'
      ? bootFlag
      : FEATURE_FLAGS.FONT_AGGRESSIVE_DEFER_V2;
  }
}
