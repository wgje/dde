import { Injectable, signal, computed } from '@angular/core';
import { environment } from '../environments/environment';

/**
 * Sentry 客户端类型定义
 * 用于类型安全的动态导入
 */
interface SentryModule {
  init: typeof import('@sentry/angular').init;
  browserTracingIntegration: typeof import('@sentry/angular').browserTracingIntegration;
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
 * 待发送的错误信息
 */
interface PendingError {
  error: unknown;
  context?: Record<string, unknown>;
  timestamp: number;
}

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
  /** Sentry 模块实例（懒加载后可用） */
  private sentryModule = signal<SentryModule | null>(null);
  
  /** Sentry 是否已初始化 */
  readonly isInitialized = computed(() => this.sentryModule() !== null);
  
  /** 是否正在初始化中 */
  private isInitializing = false;
  
  /** 待发送的错误队列（初始化前捕获的错误） */
  private pendingErrors: PendingError[] = [];
  
  /** 错误队列最大长度（防止内存泄漏） */
  private readonly MAX_PENDING_ERRORS = 50;
  
  /** 初始化 Promise（防止重复初始化） */
  private initPromise: Promise<void> | null = null;

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
    
    // 开发环境跳过 Sentry 初始化（除非有 DSN）
    if (!environment.SENTRY_DSN) {
      console.log('[SentryLazyLoader] 无 SENTRY_DSN，跳过初始化');
      return;
    }

    const initCallback = () => {
      this.initPromise = this.initSentry();
    };

    // 使用 requestIdleCallback 在浏览器空闲时初始化
    // 超时 2s 确保不会无限等待
    if (typeof requestIdleCallback !== 'undefined') {
      requestIdleCallback(initCallback, { timeout: 2000 });
    } else {
      // Safari 等不支持 requestIdleCallback 的浏览器
      setTimeout(initCallback, 2000);
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
        dsn: environment.SENTRY_DSN,
        integrations: [
          // 仅保留轻量级性能追踪
          Sentry.browserTracingIntegration(),
        ],
        // 只允许来自我们域名的请求被追踪
        tracePropagationTargets: ['localhost', /^https:\/\/dde-psi\.vercel\.app/],
        // 采样率：生产环境禁用性能追踪
        tracesSampleRate: 0,
        // 环境标识
        environment: environment.production ? 'production' : 'development',
        // 过滤浏览器噪音错误
        ignoreErrors: [
          'ResizeObserver loop limit exceeded',
          'ResizeObserver loop completed with undelivered notifications.',
          'Failed to fetch',
          'NetworkError',
          'Load failed',
          'duplicate key value violates unique constraint',
        ],
      });
      
      this.sentryModule.set(Sentry as SentryModule);
      
      // 发送队列中的待处理错误
      this.flushPendingErrors();
      
      console.log('[SentryLazyLoader] Sentry 初始化完成');
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
    const sentry = this.sentryModule();
    
    if (sentry) {
      // Sentry 已初始化，直接发送
      this.sendToSentry(sentry, error, context);
    } else {
      // 加入待处理队列
      this.addToPendingQueue(error, context);
      
      // 触发初始化（如果尚未触发）
      this.triggerLazyInit();
    }
  }

  /**
   * 发送错误到 Sentry
   */
  private sendToSentry(
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
   * 添加到待处理队列
   */
  private addToPendingQueue(error: unknown, context?: Record<string, unknown>): void {
    // 队列大小限制（防止内存泄漏）
    if (this.pendingErrors.length >= this.MAX_PENDING_ERRORS) {
      // 移除最旧的错误
      this.pendingErrors.shift();
    }
    
    this.pendingErrors.push({
      error,
      context,
      timestamp: Date.now(),
    });
  }

  /**
   * 发送待处理错误队列
   */
  private flushPendingErrors(): void {
    const sentry = this.sentryModule();
    if (!sentry || this.pendingErrors.length === 0) {
      return;
    }
    
    console.log(`[SentryLazyLoader] 发送 ${this.pendingErrors.length} 个待处理错误`);
    
    // 添加延迟标记到上下文
    this.pendingErrors.forEach(({ error, context, timestamp }) => {
      const enrichedContext = {
        ...context,
        delayedCapture: true,
        captureDelay: Date.now() - timestamp,
      };
      this.sendToSentry(sentry, error, enrichedContext);
    });
    
    // 清空队列
    this.pendingErrors = [];
  }

  /**
   * 设置用户信息（登录后调用）
   */
  setUser(user: { id: string; email?: string } | null): void {
    const sentry = this.sentryModule();
    if (sentry) {
      sentry.setUser(user);
    }
    // 如果 Sentry 未初始化，用户信息将在下次初始化时通过 auth 事件设置
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
    level?: 'fatal' | 'error' | 'warning' | 'log' | 'info' | 'debug';
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
    options?: {
      level?: 'fatal' | 'error' | 'warning' | 'log' | 'info' | 'debug';
      tags?: Record<string, string>;
      extra?: Record<string, unknown>;
      fingerprint?: string[];
    }
  ): void {
    const sentry = this.sentryModule();
    if (sentry) {
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
    } else {
      // 加入待处理队列
      this.addToPendingQueue(new Error(message), { isMessage: true, ...options });
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
}
