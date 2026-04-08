import { Injectable, signal, computed } from '@angular/core';
import { environment } from '../environments/environment';
import {
  getRemainingBrowserNetworkResumeDelayMs,
  isBrowserNetworkSuspendedWindow,
} from '../utils/browser-network-suspension';

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
  private readonly sentryDsn = environment.SENTRY_DSN?.trim() ?? '';
  private readonly isConfiguredFlag = this.sentryDsn.length > 0;

  /** Sentry 模块实例（懒加载后可用） */
  private sentryModule = signal<SentryModule | null>(null);
  
  /** Sentry 是否已初始化 */
  readonly isInitialized = computed(() => this.sentryModule() !== null);
  
  /** 是否正在初始化中 */
  private isInitializing = false;
  
  /** 待发送事件队列（初始化前捕获的消息/异常） */
  private pendingEvents: PendingSentryEvent[] = [];
  
  /** 待发送事件队列最大长度（防止内存泄漏） */
  private readonly MAX_PENDING_EVENTS = 50;
  
  /** 初始化 Promise（防止重复初始化） */
  private initPromise: Promise<void> | null = null;
  private pendingFlushTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingFlushListenersBound = false;
  private hasLoggedMissingDsn = false;

  /** 初始化前缓存的用户信息，待 Sentry 就绪后设置 */
  private pendingUser: { id: string; email?: string } | null = null;

  constructor() {
    this.bindPendingFlushResumeListeners();
  }

  isConfigured(): boolean {
    return this.isConfiguredFlag;
  }

  private bindPendingFlushResumeListeners(): void {
    if (this.pendingFlushListenersBound || typeof window === 'undefined' || typeof document === 'undefined') {
      return;
    }

    const tryFlush = () => {
      if (document.visibilityState === 'visible') {
        this.schedulePendingFlush();
      }
    };

    document.addEventListener('visibilitychange', tryFlush);
    window.addEventListener('online', tryFlush);
    window.addEventListener('pageshow', tryFlush as EventListener);
    this.pendingFlushListenersBound = true;
  }

  private schedulePendingFlush(): void {
    if (this.pendingFlushTimer || this.pendingEvents.length === 0 || !this.sentryModule()) {
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

    const initCallback = () => {
      this.initPromise = this.initSentry();
    };

    // 使用 requestIdleCallback 在浏览器空闲时初始化
    // 超时 5s 确保 Sentry 不在关键渲染路径上
    // 【性能优化 2026-02-05】从 2s 增加到 5s，减少对 LCP 的影响
    if (typeof requestIdleCallback !== 'undefined') {
      requestIdleCallback(initCallback, { timeout: 5000 });
    } else {
      // Safari 等不支持 requestIdleCallback 的浏览器
      setTimeout(initCallback, 5000);
    }
  }

  /**
   * 异步初始化 Sentry
   */
  private async initSentry(): Promise<void> {
    if (this.isInitializing || this.sentryModule()) {
      return;
    }
    
    this.isInitializing = true;
    
    try {
      // 动态导入 Sentry SDK
      const Sentry = await import('@sentry/angular');
      
      // 使用与 main.ts 相同的配置（但不阻塞首屏）
      Sentry.init({
        dsn: this.sentryDsn,
        // 版本标识：用于 Sentry release 追踪和 source map 关联
        release: this.buildRelease(),
        integrations: [
          // 轻量级性能追踪
          Sentry.browserTracingIntegration(),
          // 错误发生时录制 Session Replay，辅助复现
          Sentry.replayIntegration({
            // 仅在错误发生前后录制，不录制整个会话
            maskAllText: true,
            blockAllMedia: true,
          }),
        ],
        // 只允许来自我们域名的请求被追踪
        tracePropagationTargets: ['localhost', /^https:\/\/dde[-\w]*\.vercel\.app/],
        // 性能采样率：5% 低采样率收集关键路径数据，不影响首屏性能
        tracesSampleRate: environment.production ? 0.05 : 0,
        // Session Replay：仅在错误发生时录制（100%），日常不录制（0%）
        replaysSessionSampleRate: 0,
        replaysOnErrorSampleRate: 1.0,
        // 环境标识
        environment: environment.production ? 'production' : 'development',
        // 【P3-09 优化】过滤浏览器噪音错误（使用正则精确匹配避免误吞）
        ignoreErrors: [
          /^ResizeObserver loop/,
          /^Failed to fetch$/,          // 精确匹配网络错误，不匹配含更多上下文的消息
          /^NetworkError$/,
          /^Load failed$/,
          /^duplicate key value violates unique constraint/,
          /^The operation was aborted/,  // AbortController 取消
          /^The user aborted a request/, // 用户取消
        ],
        // 【P3-15 修复】过滤 URL 中的 auth 参数，防止 Supabase PKCE 回调泄露到 Sentry
        beforeSend(event) {
          if (event.request?.url) {
            event.request.url = event.request.url.replace(/[#?].*$/, '');
          }
          return event;
        },
        beforeBreadcrumb(breadcrumb) {
          if (breadcrumb.category === 'navigation' && breadcrumb.data) {
            for (const key of ['from', 'to']) {
              if (typeof breadcrumb.data[key] === 'string') {
                breadcrumb.data[key] = (breadcrumb.data[key] as string).replace(/[#?].*$/, '');
              }
            }
          }
          return breadcrumb;
        },
      });
      
      this.sentryModule.set(Sentry as SentryModule);
      
      // 发送队列中的待处理事件
      this.flushPendingEvents();

      // 设置初始化前缓存的用户上下文
      if (this.pendingUser) {
        Sentry.setUser(this.pendingUser);
        this.pendingUser = null;
      }

      this.logDiagnostic('[SentryLazyLoader] Sentry 初始化完成');
    } catch (error) {
      console.error('[SentryLazyLoader] Sentry 初始化失败:', error);
    } finally {
      this.isInitializing = false;
    }
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
   */
  private flushPendingEvents(): void {
    const sentry = this.sentryModule();
    if (!sentry || this.pendingEvents.length === 0) {
      return;
    }

    if (isBrowserNetworkSuspendedWindow()) {
      this.schedulePendingFlush();
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
   * 如果 Sentry 未初始化，会缓存用户信息待初始化后设置
   */
  setUser(user: { id: string; email?: string } | null): void {
    const sentry = this.sentryModule();
    if (sentry) {
      sentry.setUser(user);
    } else if (user) {
      // 缓存用户信息，待 Sentry 初始化后设置
      this.pendingUser = user;
    } else {
      this.pendingUser = null;
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
    try {
      const currentScript = document.currentScript as HTMLScriptElement | null;
      const entryUrl = new URL(currentScript?.src ?? window.location.href, window.location.href);
      // 提取文件名中的 hash 部分作为构建指纹
      const pathHash = entryUrl.pathname.replace(/^.*\//, '').replace(/\.\w+$/, '');
      return `nanoflow@${pathHash}`;
    } catch {
      return 'nanoflow@unknown';
    }
  }
}
