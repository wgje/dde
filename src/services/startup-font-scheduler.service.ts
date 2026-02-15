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

  private initialized = false;
  private loading = false;
  private fallbackTimer: ReturnType<typeof setTimeout> | null = null;
  private forceFallbackTimer: ReturnType<typeof setTimeout> | null = null;

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
      this.logger.warn('增强字体加载失败（所有候选路径均不可用）', { trigger, candidates });
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
    };

    link.onerror = () => {
      link.remove();
      this.logger.warn('增强字体加载失败，尝试备用路径', { trigger, href });
      this.injectStylesheetWithFallback(candidates, index + 1, trigger);
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
