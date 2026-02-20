import { Injectable, inject, signal } from '@angular/core';
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

  private readonly enhancedFontLoadedSignal = signal(false);
  private readonly fontStylesheetName = 'lxgw-wenkai-screen.css';
  /**
   * CDN 补充字体 CSS：包含 97 个子集，覆盖自托管 14 个子集之外的所有 unicode 范围。
   * 浏览器根据 unicode-range 按需下载，不会加载未使用的子集。
   * ServiceWorker 已配置缓存此 CDN（365d, performance 策略），首次加载后离线可用。
   */
  private readonly cdnFontStylesheetUrl =
    'https://cdn.jsdelivr.net/npm/lxgw-wenkai-screen-webfont@1.7.0/lxgwwenkaiscreen.css';

  private initialized = false;
  private loading = false;
  private fallbackTimer: ReturnType<typeof setTimeout> | null = null;
  private forceFallbackTimer: ReturnType<typeof setTimeout> | null = null;
  /** 【修复 2026-02-19】加载失败重试次数 */
  private retryCount = 0;
  private static readonly MAX_RETRY = 2;
  private static readonly RETRY_DELAY_MS = 5000;

  private readonly firstInteractionHandler = () => {
    this.loadEnhancedFontStyles('interaction');
  };

  initialize(): void {
    if (this.initialized || typeof window === 'undefined' || typeof document === 'undefined') {
      return;
    }
    this.initialized = true;

    if (this.isFontStylesheetPresent()) {
      this.enhancedFontLoadedSignal.set(true);
      // 本地字体 CSS 已存在（SW 缓存命中等），仍需注入 CDN 补充字体
      this.injectCdnFallbackStylesheet();
      return;
    }

    if (!this.isExtremeFirstpaintEnabled()) {
      this.loadEnhancedFontStyles('immediate');
      return;
    }

    this.bindFirstInteractionListeners();

    if (!this.isAggressiveDeferEnabled()) {
      this.scheduleTimeoutFallback(false);
      return;
    }

    if (!STARTUP_PERF_CONFIG.FONT_ENHANCED_INTERACTION_ONLY_V2) {
      this.scheduleTimeoutFallback(false);
      return;
    }

    this.scheduleTimeoutFallback(true);
    this.forceFallbackTimer = setTimeout(() => {
      this.loadEnhancedFontStyles('force');
    }, STARTUP_PERF_CONFIG.FONT_ENHANCED_FORCE_LOAD_MAX_DELAY_MS);
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
    window.removeEventListener('pointerdown', this.firstInteractionHandler);
    window.removeEventListener('keydown', this.firstInteractionHandler);
    window.removeEventListener('touchstart', this.firstInteractionHandler);
  }

  private scheduleTimeoutFallback(respectConstrainedNetwork: boolean): void {
    this.fallbackTimer = setTimeout(() => {
      this.loadEnhancedFontStyles('timeout', { respectConstrainedNetwork });
    }, STARTUP_PERF_CONFIG.FONT_ENHANCED_LOAD_DELAY_MS);
  }

  private clearTimers(): void {
    if (this.fallbackTimer) {
      clearTimeout(this.fallbackTimer);
      this.fallbackTimer = null;
    }
    if (this.forceFallbackTimer) {
      clearTimeout(this.forceFallbackTimer);
      this.forceFallbackTimer = null;
    }
  }

  private loadEnhancedFontStyles(trigger: FontLoadTrigger, options: FontLoadOptions = {}): void {
    if (this.enhancedFontLoadedSignal() || this.loading || typeof document === 'undefined') {
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
      // 本地字体已通过其他路径加载，仍需补充 CDN 子集
      this.injectCdnFallbackStylesheet();
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
        setTimeout(() => {
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

    link.onload = () => {
      this.loading = false;
      this.enhancedFontLoadedSignal.set(true);
      this.logger.debug('增强字体已加载', { trigger, href });
      // 自托管字体加载成功后，注入 CDN 补充字体覆盖剩余 83 个子集（168 个缺失字符）
      this.injectCdnFallbackStylesheet();
    };

    link.onerror = () => {
      link.remove();
      this.logger.warn('增强字体加载失败，尝试备用路径', { trigger, href });
      this.injectStylesheetWithFallback(candidates, index + 1, trigger);
    };

    document.head.appendChild(link);
  }

  /**
   * 注入 CDN 补充字体样式表。
   * 自托管仅包含 14 个高频子集，CDN CSS 包含全部 97 个子集。
   * 浏览器根据 unicode-range 只下载页面实际用到的子集文件。
   * 插入顺序：CDN <link> 在本地 <link> 之后，确保本地子集优先匹配。
   * CDN 加载失败不影响核心体验，仅少数低频字符回退为系统字体。
   */
  private injectCdnFallbackStylesheet(): void {
    if (typeof document === 'undefined') return;

    // 避免重复注入
    const existing = document.querySelector('link[data-nanoflow-cdn-font]');
    if (existing) return;

    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = this.cdnFontStylesheetUrl;
    link.setAttribute('data-nanoflow-cdn-font', 'true');

    link.onload = () => {
      this.logger.debug('CDN 补充字体样式已加载（覆盖额外 83 个子集）');
    };

    link.onerror = () => {
      this.logger.warn('CDN 补充字体加载失败（不影响核心体验，仅低频字符使用系统回退字体）');
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
