import { DestroyRef, Inject, Injectable, Optional, computed, signal } from '@angular/core';
import { environment } from '../environments/environment';
import { IDLE_SCHEDULE_CONFIG } from '../config/timeout.config';
import {
  getRemainingBrowserNetworkResumeDelayMs,
  isBrowserNetworkSuspendedWindow,
} from '../utils/browser-network-suspension';
import * as sentryTelemetry from './sentry-lazy-loader-telemetry.helpers';

/**
 * Sentry 客户端类型定义
 * 用于类型安全的动态导入
 */
interface SentryModule {
  init: typeof import('@sentry/angular').init;
  browserTracingIntegration: typeof import('@sentry/angular').browserTracingIntegration;
  replayIntegration: typeof import('@sentry/angular').replayIntegration;
  captureException: typeof import('@sentry/angular').captureException;
  captureMessage: typeof import('@sentry/angular').captureMessage;
  withScope: typeof import('@sentry/angular').withScope;
  setTag: typeof import('@sentry/angular').setTag;
  setUser: typeof import('@sentry/angular').setUser;
  setContext: typeof import('@sentry/angular').setContext;
  setExtra: typeof import('@sentry/angular').setExtra;
  addBreadcrumb: typeof import('@sentry/angular').addBreadcrumb;
  setMeasurement: typeof import('@sentry/angular').setMeasurement;
}

type SentryInitOptions = Parameters<SentryModule['init']>[0];
type SentryBeforeSendEvent = Parameters<NonNullable<SentryInitOptions['beforeSend']>>[0];
type SentryBreadcrumb = Parameters<NonNullable<SentryInitOptions['beforeBreadcrumb']>>[0];

/**
 * 消息上报配置
 */
type SentryMessageLevel = 'fatal' | 'error' | 'warning' | 'log' | 'info' | 'debug';

interface CaptureMessageOptions {
  level?: SentryMessageLevel;
  tags?: Record<string, string>;
  extra?: Record<string, unknown>;
  fingerprint?: string[];
}

/**
 * 待发送事件：异常
 */
interface PendingExceptionEvent {
  type: 'exception';
  error: unknown;
  context?: Record<string, unknown>;
  timestamp: number;
}

/**
 * 待发送事件：消息
 */
interface PendingMessageEvent {
  type: 'message';
  message: string;
  options?: CaptureMessageOptions;
  timestamp: number;
}

type PendingSentryEvent = PendingExceptionEvent | PendingMessageEvent;

/**
 * Sentry 懒加载服务
 * 
 * 延迟加载 Sentry SDK 以避免阻塞首屏渲染
 * 
 * 优化策略：
 * 1. 首屏渲染完成后（requestIdleCallback 或 2s 后备）
 * 2. 动态导入 @sentry/angular
 * 3. 初始化配置
 * 4. 发送队列中的待处理错误
 * 
 * 预期收益：减少 Render Delay 200~300ms
 * 
 * @example
 * // 在服务中使用
 * private readonly sentryLoader = inject(SentryLazyLoaderService);
 * 
 * // 触发懒加载
 * this.sentryLoader.triggerLazyInit();
 * 
 * // 捕获错误（初始化前后均可）
 * this.sentryLoader.captureException(error, { component: 'MyComponent' });
 */
@Injectable({ providedIn: 'root' })
export class SentryLazyLoaderService {
  /** 迁移期 Sentry traceTargets：同时覆盖旧 Vercel 与新 Cloudflare canonical / preview。 */
  private static readonly TRACE_PROPAGATION_TARGETS: ReadonlyArray<string | RegExp> = [
    'localhost',
    /^https:\/\/dde[-\w]*\.vercel\.app/,
    /^https:\/\/(?:[a-z0-9-]+\.)?nanoflow\.pages\.dev/,
    /^https:\/\/(?:[a-z0-9-]+\.)?nanoflow\.app/,
  ];

  private readonly sentryDsn = environment.SENTRY_DSN?.trim() ?? '';
  private readonly isConfiguredFlag = this.sentryDsn.length > 0;

  /** Sentry 模块实例（懒加载后可用） */
  private sentryModule = signal<SentryModule | null>(null);
  
  /** Sentry 是否已初始化 */
  readonly isInitialized = computed(() => this.sentryModule() !== null);
  
  /** 是否正在初始化中（同步设置，防止 requestIdleCallback 窗口期内重复调度）*/
  private isInitializing = false;
  
  /** 待发送事件队列（初始化前捕获的消息/异常） */
  private pendingEvents: PendingSentryEvent[] = [];
  
  /** 待发送事件队列最大长度（防止内存泄漏） */
  private readonly MAX_PENDING_EVENTS = 50;
  
  /** 初始化 Promise（防止重复初始化） */
  private initPromise: Promise<void> | null = null;
  private pendingFlushTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingFlushResumeListener: EventListener | null = null;
  private pendingFlushListenersBound = false;
  private hasLoggedMissingDsn = false;

  constructor(@Optional() @Inject(DestroyRef) destroyRef: DestroyRef | null = null) {
    this.bindPendingFlushResumeListeners();
    destroyRef?.onDestroy(() => this.cleanupPendingFlushResume());
  }

  isConfigured(): boolean {
    return this.isConfiguredFlag;
  }

  private bindPendingFlushResumeListeners(): void {
    if (this.pendingFlushListenersBound || typeof window === 'undefined' || typeof document === 'undefined') {
      return;
    }

    const tryFlush: EventListener = () => {
      if (document.visibilityState === 'visible') {
        this.schedulePendingFlush();
      }
    };

    document.addEventListener('visibilitychange', tryFlush);
    window.addEventListener('online', tryFlush);
    window.addEventListener('pageshow', tryFlush);
    this.pendingFlushResumeListener = tryFlush;
    this.pendingFlushListenersBound = true;
  }

  private cleanupPendingFlushResume(): void {
    if (this.pendingFlushTimer !== null) {
      clearTimeout(this.pendingFlushTimer);
      this.pendingFlushTimer = null;
    }

    const listener = this.pendingFlushResumeListener;
    if (!listener || typeof window === 'undefined' || typeof document === 'undefined') {
      this.pendingFlushListenersBound = false;
      this.pendingFlushResumeListener = null;
      return;
    }

    document.removeEventListener('visibilitychange', listener);
    window.removeEventListener('online', listener);
    window.removeEventListener('pageshow', listener);
    this.pendingFlushResumeListener = null;
    this.pendingFlushListenersBound = false;
  }

  private schedulePendingFlush(): void {
    if (this.pendingFlushTimer !== null || this.pendingEvents.length === 0 || !this.sentryModule()) {
      return;
    }

    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') {
      return;
    }

    const delayMs = Math.max(50, getRemainingBrowserNetworkResumeDelayMs() + 50);
    this.pendingFlushTimer = setTimeout(() => {
      this.pendingFlushTimer = null;
      this.flushPendingEvents();
    }, delayMs);
  }

  private deferPendingException(error: unknown, context?: Record<string, unknown>): void {
    this.addPendingEvent({
      type: 'exception',
      error,
      context,
      timestamp: Date.now(),
    });
    this.schedulePendingFlush();
  }

  private deferPendingMessage(message: string, options?: CaptureMessageOptions): void {
    this.addPendingEvent({
      type: 'message',
      message,
      options,
      timestamp: Date.now(),
    });
    this.schedulePendingFlush();
  }

  /**
   * 待应用的用户身份（Sentry 初始化前调用 setUser 时缓存）
   * undefined = 未曾调用过；null = 显式登出；object = 用户信息
   */
  private pendingUser: { id: string } | null | undefined = undefined;

  /**
   * 触发 Sentry 懒加载初始化
   * 使用 requestIdleCallback 确保不阻塞主线程
   * 
   * 调用时机：
   * 1. APP_INITIALIZER 中通过 queueMicrotask 调用
   * 2. 首次错误发生时自动触发
   */
  triggerLazyInit(): void {
    if (this.initPromise || this.isInitializing) {
      return;
    }
    
    if (!this.isConfigured()) {
      if (this.hasLoggedMissingDsn) {
        return;
      }
      this.hasLoggedMissingDsn = true;
      this.logDiagnostic('[SentryLazyLoader] 无 SENTRY_DSN，Sentry 已禁用');
      return;
    }

    // 同步设置 isInitializing，防止在 requestIdleCallback 调度窗口期（最长 5s）内重复调度
    this.isInitializing = true;

    const initCallback = () => {
      this.isInitializing = false;
      this.initPromise = this.initSentry();
    };

    // 使用 requestIdleCallback 在浏览器空闲时初始化
    // 超时 5s 确保 Sentry 不在关键渲染路径上
    // 【性能优化 2026-02-05】从 2s 增加到 5s，减少对 LCP 的影响
    // 【超时治理 2026-04-16】常量化为 IDLE_SCHEDULE_CONFIG.LONG_MS
    if (typeof requestIdleCallback !== 'undefined') {
      requestIdleCallback(initCallback, { timeout: IDLE_SCHEDULE_CONFIG.LONG_MS });
    } else {
      // Safari 等不支持 requestIdleCallback 的浏览器
      setTimeout(initCallback, IDLE_SCHEDULE_CONFIG.LONG_MS);
    }
  }

  /**
   * 异步初始化 Sentry
   */
  private async initSentry(): Promise<void> {
    if (this.sentryModule()) {
      return;
    }

    this.isInitializing = true;

    try {
      const Sentry = await import('@sentry/angular');
      Sentry.init(this.buildSentryInitOptions(Sentry));
      this.sentryModule.set(Sentry as SentryModule);
      this.flushPendingEvents();
      this.logDiagnostic('[SentryLazyLoader] Sentry 初始化完成');
    } catch (error) {
      console.error('[SentryLazyLoader] Sentry 初始化失败:', error);
    } finally {
      this.isInitializing = false;
    }
  }

  private buildSentryInitOptions(Sentry: SentryModule): SentryInitOptions {
    return {
      dsn: this.sentryDsn,
      release: this.buildRelease(),
      integrations: this.buildSentryIntegrations(Sentry),
      tracePropagationTargets: [...SentryLazyLoaderService.TRACE_PROPAGATION_TARGETS],
      tracesSampleRate: environment.production ? 0.05 : 0,
      replaysSessionSampleRate: 0,
      replaysOnErrorSampleRate: 1.0,
      environment: this.resolveSentryEnvironment(),
      sendDefaultPii: false,
      ignoreErrors: this.buildIgnoredSentryErrors(),
      beforeSend: event => SentryLazyLoaderService.sanitizeBeforeSendEvent(event),
      beforeBreadcrumb: breadcrumb => SentryLazyLoaderService.sanitizeBreadcrumb(breadcrumb),
    };
  }

  private buildSentryIntegrations(Sentry: SentryModule): SentryInitOptions['integrations'] {
    return [
      Sentry.browserTracingIntegration(),
      Sentry.replayIntegration({
        maskAllText: true,
        blockAllMedia: true,
      }),
    ];
  }

  private buildIgnoredSentryErrors(): NonNullable<SentryInitOptions['ignoreErrors']> {
    return [
      /^ResizeObserver loop/,
      /^Failed to fetch$/,
      /^NetworkError$/,
      /^Load failed$/,
      /^duplicate key value violates unique constraint/,
      /^The operation was aborted/,
      /^The user aborted a request/,
    ];
  }

  private static sanitizeBeforeSendEvent(event: SentryBeforeSendEvent): SentryBeforeSendEvent | null {
    return sentryTelemetry.sanitizeBeforeSendEvent(
      event as sentryTelemetry.SentryBeforeSendEventLike,
    ) as SentryBeforeSendEvent | null;
  }

  private static sanitizeEventExceptions(event: SentryBeforeSendEvent): void {
    sentryTelemetry.sanitizeEventExceptions(event as sentryTelemetry.SentryBeforeSendEventLike);
  }

  private static sanitizeBreadcrumb(breadcrumb: SentryBreadcrumb): SentryBreadcrumb {
    return sentryTelemetry.sanitizeBreadcrumb(
      breadcrumb as sentryTelemetry.SentryBreadcrumbLike,
    ) as SentryBreadcrumb;
  }

  private static sanitizeNavigationBreadcrumbData(breadcrumb: SentryBreadcrumb): void {
    sentryTelemetry.sanitizeNavigationBreadcrumbData(breadcrumb as sentryTelemetry.SentryBreadcrumbLike);
  }

  /**
   * 捕获错误（支持初始化前后）
   * 
   * 如果 Sentry 尚未初始化，错误会被加入队列，
   * 待初始化完成后自动发送
   * 
   * @param error 错误对象
   * @param context 额外上下文信息
   */
  captureException(error: unknown, context?: Record<string, unknown>): void {
    if (!this.isConfigured()) {
      return;
    }

    const sentry = this.sentryModule();
    
    if (sentry) {
      if (isBrowserNetworkSuspendedWindow()) {
        this.deferPendingException(error, context);
        return;
      }

      // Sentry 已初始化，直接发送
      this.sendExceptionToSentry(sentry, error, context);
    } else {
      // 加入待处理队列
      this.addPendingEvent({
        type: 'exception',
        error,
        context,
        timestamp: Date.now(),
      });
      
      // 触发初始化（如果尚未触发）
      this.triggerLazyInit();
    }
  }

  /**
   * 发送错误到 Sentry
   */
  private sendExceptionToSentry(
    sentry: SentryModule,
    error: unknown,
    context?: Record<string, unknown>
  ): void {
    try {
      if (context && Object.keys(context).length > 0) {
        sentry.withScope(scope => {
          Object.entries(context).forEach(([key, value]) => {
            scope.setExtra(key, value);
          });
          sentry.captureException(error);
        });
      } else {
        sentry.captureException(error);
      }
    } catch (e) {
      console.error('[SentryLazyLoader] 发送错误失败:', e);
    }
  }

  /**
   * 发送消息到 Sentry
   */
  private sendMessageToSentry(
    sentry: SentryModule,
    message: string,
    options?: CaptureMessageOptions
  ): void {
    try {
      if (options) {
        sentry.withScope(scope => {
          if (options.level) {
            scope.setLevel(options.level);
          }
          if (options.tags) {
            Object.entries(options.tags).forEach(([key, value]) => {
              scope.setTag(key, value);
            });
          }
          if (options.extra) {
            Object.entries(options.extra).forEach(([key, value]) => {
              scope.setExtra(key, value);
            });
          }
          if (options.fingerprint) {
            scope.setFingerprint(options.fingerprint);
          }
          sentry.captureMessage(message);
        });
      } else {
        sentry.captureMessage(message);
      }
    } catch (e) {
      console.error('[SentryLazyLoader] 发送消息失败:', e);
    }
  }

  /**
   * 添加到待处理队列
   */
  private addPendingEvent(event: PendingSentryEvent): void {
    // 队列大小限制（防止内存泄漏）
    if (this.pendingEvents.length >= this.MAX_PENDING_EVENTS) {
      // 移除最旧的事件
      this.pendingEvents.shift();
    }
    
    this.pendingEvents.push(event);
  }

  /**
   * 为延迟发送的消息补充上下文
   */
  private buildDelayedMessageOptions(
    options: CaptureMessageOptions | undefined,
    captureDelay: number
  ): CaptureMessageOptions {
    return {
      ...options,
      extra: {
        ...options?.extra,
        delayedCapture: true,
        captureDelay,
      },
    };
  }

  /**
   * 发送待处理事件队列
   * 同时应用初始化前缓存的用户身份信息
   */
  private flushPendingEvents(): void {
    const sentry = this.sentryModule();
    if (!sentry) {
      return;
    }

    if (isBrowserNetworkSuspendedWindow()) {
      this.schedulePendingFlush();
      return;
    }

    // 应用初始化前缓存的用户身份（undefined 表示未曾调用过 setUser，跳过）
    if (this.pendingUser !== undefined) {
      sentry.setUser(this.pendingUser);
    }

    if (this.pendingEvents.length === 0) {
      return;
    }

    this.logDiagnostic(`[SentryLazyLoader] 发送 ${this.pendingEvents.length} 个待处理事件`);
    
    const now = Date.now();

    for (const event of this.pendingEvents) {
      const captureDelay = now - event.timestamp;

      if (event.type === 'exception') {
        const enrichedContext = {
          ...event.context,
          delayedCapture: true,
          captureDelay,
        };
        this.sendExceptionToSentry(sentry, event.error, enrichedContext);
        continue;
      }

      const enrichedOptions = this.buildDelayedMessageOptions(event.options, captureDelay);
      this.sendMessageToSentry(sentry, event.message, enrichedOptions);
    }

    // 清空队列
    this.pendingEvents = [];
  }

  /**
   * 设置用户信息（登录后调用）
   *
   * 若 Sentry 尚未初始化，用户信息会被缓存，
   * 待初始化完成后在 flushPendingEvents 中一并应用。
   */
  setUser(user: { id: string; email?: string } | null): void {
    // 始终缓存脱敏后的用户标识，确保 Sentry 初始化后可以应用且不上传邮箱等 PII
    const sanitizedUser = sentryTelemetry.sanitizeSentryUser(user);
    this.pendingUser = sanitizedUser;
    const sentry = this.sentryModule();
    if (sentry) {
      sentry.setUser(sanitizedUser);
    }
  }

  /**
   * 设置标签
   */
  setTag(key: string, value: string): void {
    const sentry = this.sentryModule();
    if (sentry) {
      sentry.setTag(key, value);
    }
  }

  /**
   * 设置性能测量值（用于 Web Vitals）
   */
  setMeasurement(name: string, value: number, unit: string): void {
    const sentry = this.sentryModule();
    if (sentry) {
      sentry.setMeasurement(name, value, unit);
    }
  }

  /**
   * 设置上下文
   */
  setContext(name: string, context: Record<string, unknown> | null): void {
    const sentry = this.sentryModule();
    if (sentry) {
      sentry.setContext(name, context);
    }
  }

  /**
   * 设置额外信息
   */
  setExtra(key: string, extra: unknown): void {
    const sentry = this.sentryModule();
    if (sentry) {
      sentry.setExtra(key, extra);
    }
  }

  /**
   * 添加面包屑
   */
  addBreadcrumb(breadcrumb: {
    category?: string;
    message?: string;
    level?: SentryMessageLevel;
    data?: Record<string, unknown>;
  }): void {
    const sentry = this.sentryModule();
    if (sentry) {
      sentry.addBreadcrumb(breadcrumb);
    }
  }

  /**
   * 捕获消息
   */
  captureMessage(
    message: string,
    options?: CaptureMessageOptions
  ): void {
    if (!this.isConfigured()) {
      return;
    }

    const sentry = this.sentryModule();
    if (sentry) {
      if (isBrowserNetworkSuspendedWindow()) {
        this.deferPendingMessage(message, options);
        return;
      }

      this.sendMessageToSentry(sentry, message, options);
    } else {
      this.addPendingEvent({
        type: 'message',
        message,
        options,
        timestamp: Date.now(),
      });
      this.triggerLazyInit();
    }
  }

  /**
   * 使用作用域
   */
  withScope(callback: (scope: { setTag: (key: string, value: string) => void; setExtra: (key: string, value: unknown) => void }) => void): void {
    const sentry = this.sentryModule();
    if (sentry) {
      sentry.withScope(callback);
    }
  }

  private logDiagnostic(message: string): void {
    if (!this.isVerboseConsoleEnabled()) {
      return;
    }

    // eslint-disable-next-line no-console -- 仅在显式 verbose 时输出诊断信息，避免误判为 warning/error
    console.info(message);
  }

  private static sanitizeUrlForTelemetry(rawUrl: string): string {
    return sentryTelemetry.sanitizeUrlForTelemetry(rawUrl);
  }

  private static sanitizeTelemetryString(value: string): string {
    return sentryTelemetry.sanitizeTelemetryString(value);
  }

  private static shouldDropNonActionableSentryEvent(event: sentryTelemetry.SentryBeforeSendEventLike): boolean {
    return sentryTelemetry.shouldDropNonActionableSentryEvent(event);
  }

  private static redactTelemetryRecord<T extends Record<string, unknown> | undefined>(record: T): T {
    return sentryTelemetry.redactTelemetryRecord(record);
  }

  private static sanitizeSentryEventUser(user: unknown): unknown {
    return sentryTelemetry.sanitizeSentryEventUser(user);
  }

  private isVerboseConsoleEnabled(): boolean {
    if (typeof window === 'undefined') {
      return false;
    }

    try {
      return window.localStorage.getItem('nanoflow.verbose') === 'true';
    } catch {
      return false;
    }
  }

  /**
   * 构建 release 标识符
   * 使用入口 chunk URL 的 hash 作为部署指纹，确保每次构建唯一
   */
  private buildRelease(): string {
    // 优先使用显式注入的 sentryRelease（GitHub Actions 注入 git SHA）
    const explicitRelease = (environment as { sentryRelease?: string }).sentryRelease;
    if (explicitRelease) {
      return `nanoflow@${explicitRelease}`;
    }

    const runtimeFingerprint = this.resolveRuntimeScriptFingerprint();
    if (runtimeFingerprint) {
      return `nanoflow@${runtimeFingerprint}`;
    }

    const deploymentEpoch = (environment as { deploymentEpoch?: number | string }).deploymentEpoch;
    if (deploymentEpoch) {
      return `nanoflow@epoch-${deploymentEpoch}`;
    }

    return 'nanoflow@unknown';
  }

  private resolveRuntimeScriptFingerprint(): string | null {
    if (typeof document === 'undefined') {
      return null;
    }

    const currentScriptSrc = (document.currentScript as HTMLScriptElement | null)?.src;
    const scriptSources = [
      currentScriptSrc,
      ...Array.from(document.scripts).map(script => script.src),
    ].filter((src): src is string => typeof src === 'string' && src.length > 0);

    const fingerprints = scriptSources
      .map(src => SentryLazyLoaderService.extractScriptFingerprint(src))
      .filter((fingerprint): fingerprint is string => fingerprint !== null);

    return fingerprints.find(fingerprint => /^main[-.]/i.test(fingerprint)) ?? fingerprints[0] ?? null;
  }

  private static extractScriptFingerprint(scriptUrl: string): string | null {
    let scriptPath = '';
    try {
      const base = typeof window !== 'undefined' ? window.location.href : 'https://placeholder.invalid';
      scriptPath = new URL(scriptUrl, base).pathname;
    } catch {
      scriptPath = '';
    }

    const fileName = scriptPath.split('/').pop() ?? '';
    const fingerprint = fileName.replace(/\.(?:mjs|js)$/i, '');
    return fingerprint.length > 0 ? fingerprint : null;
  }

  /**
   * 解析 Sentry environment 标识符。
   * 优先使用 environment.sentryEnvironment（GitHub Actions 显式注入），否则
   * 降级到 production/development 推断（保持向后兼容）。
   */
  private resolveSentryEnvironment(): string {
    const explicit = (environment as { sentryEnvironment?: string }).sentryEnvironment;
    if (explicit && typeof explicit === 'string' && explicit.trim().length > 0) {
      return explicit.trim();
    }
    return environment.production ? 'production' : 'development';
  }
}
