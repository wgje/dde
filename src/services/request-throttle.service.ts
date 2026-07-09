/**
 * RequestThrottleService - 请求限流服务
 * 
 * 解决问题：
 * - 并发 Supabase API 调用耗尽连接池
 * - 浏览器 HTTP 连接数限制（Chrome 对同一域名最多 6 个并发）
 * - "Failed to fetch" NetworkError
 * 
 * 功能：
 * 1. 限制同时进行的请求数量（默认 4 个）
 * 2. 请求去重（相同 key 的请求复用结果）
 * 3. 指数退避重试（网络错误时）
 * 4. 请求超时保护
 * 
 * 使用示例：
 * ```typescript
 * const result = await throttle.execute(
 *   'fetch-tasks-' + projectId,
 *   () => supabase.from('tasks').select('*').eq('project_id', projectId),
 *   { deduplicate: true }
 * );
 * ```
 */
import { Injectable, inject, signal, DestroyRef } from '@angular/core';
import { LoggerService } from './logger.service';
import { REQUEST_THROTTLE_CONFIG } from '../config';
import {
  createBrowserNetworkSuspendedError,
  isBrowserNetworkSuspendedError,
  isBrowserNetworkSuspendedWindow,
} from '../utils/browser-network-suspension';

/** 请求配置选项 */
export interface ThrottleOptions {
  /** 是否启用去重（相同 key 的请求复用结果）*/
  deduplicate?: boolean;
  /** 请求超时时间（毫秒），默认 30000 */
  timeout?: number;
  /** 请求优先级：high=插队，normal=普通，low=队尾 */
  priority?: 'high' | 'normal' | 'low';
  /** 重试次数，默认 3 */
  retries?: number;
  /** 是否为后台请求（失败时静默处理）*/
  silent?: boolean;
}

/**
 * 请求执行器：可选接收 AbortSignal。
 * throttle 超时/取消时会 abort 该信号——超时只拒绝 promise 而不杀底层 fetch 的话，
 * 幽灵请求会继续跑到全局 120s 上限，30s 后在服务端 applied 的写入会把用户
 * 随后的编辑打成假版本冲突（ghost-write CAS conflict）。
 */
export type ThrottleExecutor<T> = (signal?: AbortSignal) => Promise<T>;

/** 队列中的请求项 */
interface QueuedRequest<T> {
  id: string;
  key: string;
  executor: ThrottleExecutor<T>;
  options: Required<ThrottleOptions>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  retryCount: number;
  createdAt: number;
}

// P0001 = PostgreSQL RAISE EXCEPTION（如版本回归拒绝）：确定性业务拒绝，
// 传输层重试只会用完全相同的参数再被拒一次，白耗弱网带宽并推迟真实冲突处理
const NON_RETRYABLE_ERROR_CODES = new Set(['PGRST116', '42501', '23503', '42P01', 'P0001']);
const RETRYABLE_MESSAGE_PATTERNS = ['failed to fetch', 'network', 'timeout', '429', '503', '504'];
const NON_RETRYABLE_MESSAGE_PATTERNS = [
  'not found',
  'not acceptable',
  '406',
  'permission denied',
  'unauthorized',
  'forbidden',
  'row level security',
  'unique constraint',
  'foreign key',
  '23503',
];
const REQUEST_THROTTLE_TIMEOUT = Symbol('request-throttle-timeout');

type RequestThrottleTimeoutError = Error & {
  [REQUEST_THROTTLE_TIMEOUT]?: true;
};

/** 请求限流配置 - 使用全局常量 */
const THROTTLE_CONFIG = REQUEST_THROTTLE_CONFIG;

@Injectable({
  providedIn: 'root'
})
export class RequestThrottleService {
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('RequestThrottle');
  private readonly destroyRef = inject(DestroyRef);
  
  /** 请求队列 */
  private queue: QueuedRequest<unknown>[] = [];
  
  /** 当前正在执行的请求数 */
  private activeCount = 0;

  private activeExecutorKeys = new Map<string, number>();

  private retryTimers = new Map<string, {
    timer: ReturnType<typeof setTimeout>;
    request: QueuedRequest<unknown>;
  }>();

  private activeRequestCancellations = new Map<string, () => void>();

  private clearGeneration = 0;
  
  /** 去重缓存：key -> { promise, expiresAt } */
  private dedupeCache = new Map<string, { 
    promise: Promise<unknown>; 
    expiresAt: number 
  }>();

  /** 去重缓存最大容量，防止长时间运行后内存持续增长 */
  private readonly MAX_DEDUPE_CACHE_SIZE = 500;
  
  /** 当前活跃请求数（可观察） */
  readonly activeRequests = signal(0);
  
  /** 队列长度（可观察） */
  readonly queueLength = signal(0);
  
  constructor() {
    // 定期清理过期的去重缓存
    const cleanupInterval = setInterval(() => this.cleanupDedupeCache(), 10000);
    
    this.destroyRef.onDestroy(() => {
      clearInterval(cleanupInterval);
      this.clearAll();
    });
  }
  
  /**
   * 执行受限流保护的请求
   * 
   * @param key 请求标识（用于去重和日志）
   * @param executor 实际执行请求的函数
   * @param options 配置选项
   * @returns Promise 请求结果
   */
  async execute<T>(
    key: string,
    executor: ThrottleExecutor<T>,
    options: ThrottleOptions = {}
  ): Promise<T> {
    const opts = this.normalizeOptions(options);
    const cached = this.getCachedRequest<T>(key, opts);
    if (cached) return cached;

    this.ensureQueueCapacity(key, opts);
    const promise = this.enqueueRequest(key, executor, opts);
    const cacheablePromise = this.wrapDedupeFailureEviction(key, promise, opts);
    this.cacheDedupePromise(key, cacheablePromise, opts);
    return cacheablePromise;
  }

  private normalizeOptions(options: ThrottleOptions): Required<ThrottleOptions> {
    return {
      deduplicate: options.deduplicate ?? false,
      timeout: options.timeout ?? THROTTLE_CONFIG.DEFAULT_TIMEOUT,
      priority: options.priority ?? 'normal',
      retries: options.retries ?? THROTTLE_CONFIG.DEFAULT_RETRIES,
      silent: options.silent ?? false,
    };
  }

  private getCachedRequest<T>(
    key: string,
    options: Required<ThrottleOptions>,
  ): Promise<T> | null {
    if (!options.deduplicate) return null;
    const cached = this.dedupeCache.get(key);
    if (!cached || cached.expiresAt <= Date.now()) return null;
    this.logger.debug('请求去重命中', { key });
    return cached.promise as Promise<T>;
  }

  private ensureQueueCapacity(key: string, options: Required<ThrottleOptions>): void {
    if (this.queue.length < THROTTLE_CONFIG.MAX_QUEUE_SIZE) return;
    if (options.priority === 'low') {
      throw new Error(`请求队列已满 (${THROTTLE_CONFIG.MAX_QUEUE_SIZE})，低优先级请求被丢弃`);
    }
    this.evictLowPriorityRequest(key);
  }

  private evictLowPriorityRequest(key: string): void {
    const lowPriorityIndex = this.queue.findIndex(request => request.options.priority === 'low');
    if (lowPriorityIndex < 0) return;
    const removed = this.queue.splice(lowPriorityIndex, 1)[0];
    removed.reject(new Error('被更高优先级请求抢占'));
    this.logger.debug('移除低优先级请求', { key: removed.key, requestedKey: key });
  }

  private enqueueRequest<T>(
    key: string,
    executor: ThrottleExecutor<T>,
    options: Required<ThrottleOptions>,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const request = this.createQueuedRequest(key, executor, options, resolve, reject);
      this.insertRequest(request);
      this.queueLength.set(this.queue.length);
      this.processQueue();
    });
  }

  private createQueuedRequest<T>(
    key: string,
    executor: ThrottleExecutor<T>,
    options: Required<ThrottleOptions>,
    resolve: (value: T) => void,
    reject: (error: Error) => void,
  ): QueuedRequest<T> {
    return {
      id: crypto.randomUUID(),
      key,
      executor,
      options,
      resolve,
      reject,
      retryCount: 0,
      createdAt: Date.now(),
    };
  }

  private insertRequest<T>(request: QueuedRequest<T>): void {
    if (request.options.priority === 'high') {
      this.queue.unshift(request as QueuedRequest<unknown>);
      return;
    }
    this.queue.push(request as QueuedRequest<unknown>);
  }

  private wrapDedupeFailureEviction<T>(
    key: string,
    promise: Promise<T>,
    options: Required<ThrottleOptions>,
  ): Promise<T> {
    if (!options.deduplicate) return promise;
    const cacheablePromise = promise.catch(error => {
      const cached = this.dedupeCache.get(key);
      if (cached?.promise === cacheablePromise) {
        this.dedupeCache.delete(key);
      }
      throw error;
    });
    return cacheablePromise;
  }

  private cacheDedupePromise<T>(
    key: string,
    promise: Promise<T>,
    options: Required<ThrottleOptions>,
  ): void {
    if (!options.deduplicate) return;
    this.dedupeCache.set(key, {
      promise,
      expiresAt: Date.now() + THROTTLE_CONFIG.DEDUPE_TTL,
    });
  }
  
  /**
   * 批量执行请求（自动限流）
   * 
   * @param requests 请求列表
   * @param concurrency 并发数（可覆盖默认值）
   * @returns Promise 所有请求结果
   */
  async executeAll<T>(
    requests: Array<{
      key: string;
      executor: ThrottleExecutor<T>;
      options?: ThrottleOptions;
    }>,
    concurrency: number = THROTTLE_CONFIG.MAX_CONCURRENT
  ): Promise<T[]> {
    const results: T[] = [];
    const executing: Promise<void>[] = [];
    const maxConcurrency = Math.max(1, concurrency);

    for (const req of requests) {
      const tracked = this.execute(req.key, req.executor, req.options)
        .then(result => {
          results.push(result);
        })
        .finally(() => {
          const index = executing.indexOf(tracked);
          if (index > -1) executing.splice(index, 1);
        });
      
      executing.push(tracked);

      if (executing.length >= maxConcurrency) {
        await Promise.race(executing);
      }
    }
    
    await Promise.all(executing);
    return results;
  }
  
  /**
   * 处理请求队列
   */
  private processQueue(): void {
    while (
      this.activeCount < THROTTLE_CONFIG.MAX_CONCURRENT &&
      this.queue.length > 0
    ) {
      const requestIndex = this.queue.findIndex(request => !this.isExecutorKeyActive(request.key));
      if (requestIndex < 0) return;

      const [request] = this.queue.splice(requestIndex, 1);
      this.queueLength.set(this.queue.length);
      this.executeRequest(request);
    }
  }
  
  /**
   * 执行单个请求（带超时和重试）
   */
  private async executeRequest<T>(request: QueuedRequest<T>): Promise<void> {
    const requestGeneration = this.clearGeneration;
    this.activeCount++;
    this.activeRequests.set(this.activeCount);
    let unregisterActiveRequest: (() => void) | undefined;
    
    try {
      if (isBrowserNetworkSuspendedWindow()) {
        request.reject(createBrowserNetworkSuspendedError());
        return;
      }

      const execution = this.runExecutor(request);
      const timedExecution = this.withTimeout(
        execution.promise,
        request.options.timeout,
        request.key,
        execution.release,
        execution.abort,
      );
      this.activeRequestCancellations.set(request.id, timedExecution.cancel);
      unregisterActiveRequest = () => {
        this.activeRequestCancellations.delete(request.id);
      };

      // 添加超时保护
      const result = await timedExecution.promise;
      if (requestGeneration !== this.clearGeneration) {
        request.reject(new Error('请求被取消'));
        return;
      }
      
      request.resolve(result);
    } catch (error) {
      this.handleRequestFailure(request, error, requestGeneration);
    } finally {
      unregisterActiveRequest?.();
      this.activeCount--;
      this.activeRequests.set(this.activeCount);
      
      // 继续处理队列
      this.processQueue();
    }
  }

  private handleRequestFailure<T>(
    request: QueuedRequest<T>,
    error: unknown,
    requestGeneration: number,
  ): void {
    if (requestGeneration !== this.clearGeneration) {
      request.reject(new Error('请求被取消'));
      return;
    }

    if (this.isRequestThrottleTimeout(error)) {
      request.reject(error);
      return;
    }

    if (this.shouldRetry(error) && request.retryCount < request.options.retries) {
      this.scheduleRetry(request, requestGeneration);
      return;
    }

    request.reject(error instanceof Error ? error : new Error(String(error)));
  }

  private scheduleRetry<T>(request: QueuedRequest<T>, requestGeneration: number): void {
    request.retryCount++;
    const delay = this.calculateRetryDelay(request.retryCount);

    if (!request.options.silent) {
      this.logger.debug('请求重试', {
        key: request.key,
        attempt: request.retryCount,
        delay
      });
    }

    const retryTimer = setTimeout(() => {
      this.retryTimers.delete(request.id);
      if (requestGeneration !== this.clearGeneration) {
        request.reject(new Error('请求被取消'));
        return;
      }

      this.queue.unshift(request as unknown as QueuedRequest<unknown>);
      this.queueLength.set(this.queue.length);
      this.processQueue();
    }, delay);
    this.retryTimers.set(request.id, {
      timer: retryTimer,
      request: request as unknown as QueuedRequest<unknown>,
    });
  }
  
  /**
   * 添加超时保护
   */
  private withTimeout<T>(
    promise: Promise<T>,
    timeout: number,
    key: string,
    releaseExecutorKey: () => void,
    abortExecutor: () => void = () => {},
  ): { promise: Promise<T>; cancel: () => void } {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let rejectTimedPromise: (error: Error) => void = () => {};
    const clearTimer = () => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    };

    const timedPromise = new Promise<T>((resolve, reject) => {
      rejectTimedPromise = reject;
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        releaseExecutorKey();
        // 超时判死必须同时 abort 底层执行器：只拒绝 promise 会留下幽灵请求
        // 继续跑到全局 fetch 上限，其晚到的服务端 applied 会制造假版本冲突
        abortExecutor();
        if (isBrowserNetworkSuspendedWindow()) {
          reject(createBrowserNetworkSuspendedError());
          return;
        }

        reject(this.createTimeoutError(timeout, key));
      }, timeout);
      
      const settleIfPending = () => {
        if (settled) return false;
        settled = true;
        clearTimer();
        return true;
      };
      this.settleTimedPromiseFromExecutor(promise, settleIfPending, resolve, reject);
    });

    return {
      promise: timedPromise,
      cancel: () => {
        if (settled) return;
        settled = true;
        clearTimer();
        releaseExecutorKey();
        abortExecutor();
        rejectTimedPromise(new Error('请求被取消'));
      },
    };
  }

  private settleTimedPromiseFromExecutor<T>(
    promise: Promise<T>,
    settleIfPending: () => boolean,
    resolve: (value: T) => void,
    reject: (error: unknown) => void,
  ): void {
    promise
      .then(result => {
        if (settleIfPending()) resolve(result);
      })
      .catch(error => {
        if (!settleIfPending()) return;
        reject(
          isBrowserNetworkSuspendedError(error) || isBrowserNetworkSuspendedWindow()
            ? createBrowserNetworkSuspendedError()
            : error,
        );
      });
  }

  private createTimeoutError(timeout: number, key: string): RequestThrottleTimeoutError {
    // Must set name='TimeoutError' so downstream retry classifiers do not
    // misclassify localized timeout messages as non-retryable fallback errors.
    const timeoutError: RequestThrottleTimeoutError =
      new Error(`请求超时 (${timeout}ms): ${key}`);
    timeoutError.name = 'TimeoutError';
    timeoutError[REQUEST_THROTTLE_TIMEOUT] = true;
    return timeoutError;
  }

  private runExecutor<T>(request: QueuedRequest<T>): {
    promise: Promise<T>;
    release: () => void;
    abort: () => void;
  } {
    this.markExecutorKeyActive(request.key);
    const abortController = new AbortController();
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.releaseExecutorKey(request.key);
    };
    const executorPromise = Promise.resolve().then(() => request.executor(abortController.signal));
    executorPromise.then(
      release,
      release,
    );
    return {
      promise: executorPromise,
      release,
      abort: () => abortController.abort(),
    };
  }

  private markExecutorKeyActive(key: string): void {
    this.activeExecutorKeys.set(key, (this.activeExecutorKeys.get(key) ?? 0) + 1);
  }

  private releaseExecutorKey(key: string): void {
    const count = this.activeExecutorKeys.get(key);
    if (!count) return;

    if (count <= 1) {
      this.activeExecutorKeys.delete(key);
    } else {
      this.activeExecutorKeys.set(key, count - 1);
    }

    this.processQueue();
  }

  private isExecutorKeyActive(key: string): boolean {
    return (this.activeExecutorKeys.get(key) ?? 0) > 0;
  }

  private isRequestThrottleTimeout(error: unknown): error is RequestThrottleTimeoutError {
    return error instanceof Error && (error as RequestThrottleTimeoutError)[REQUEST_THROTTLE_TIMEOUT] === true;
  }
  
  /**
   * 判断是否应该重试
   */
  private shouldRetry(error: unknown): boolean {
    if (this.isNonRetryableRuntimeState(error)) return false;
    // PostgrestError 常以 Error 实例携带 code 字段（如 P0001 业务拒绝）：
    // code 分类必须先于消息模式，否则确定性拒绝会按未知消息默认重试
    if (this.hasNonRetryableErrorCode(error)) return false;
    if (!(error instanceof Error)) return this.shouldRetryObjectError(error);
    return this.shouldRetryErrorMessage(error.message);
  }

  private hasNonRetryableErrorCode(error: unknown): boolean {
    const code = (error as { code?: string | number } | null)?.code;
    if (code === undefined || code === null) return false;
    return NON_RETRYABLE_ERROR_CODES.has(String(code));
  }

  private isNonRetryableRuntimeState(error: unknown): boolean {
    return this.isPermanentFailure(error) ||
      isBrowserNetworkSuspendedError(error) ||
      isBrowserNetworkSuspendedWindow();
  }

  private isPermanentFailure(error: unknown): boolean {
    return error instanceof Error &&
      'isPermanentFailure' in error &&
      (error as { isPermanentFailure?: boolean }).isPermanentFailure === true;
  }

  private shouldRetryObjectError(error: unknown): boolean {
    const code = (error as { code?: string } | null)?.code;
    return !code || !NON_RETRYABLE_ERROR_CODES.has(code);
  }

  private shouldRetryErrorMessage(message: string): boolean {
    const normalized = message.toLowerCase();
    if (RETRYABLE_MESSAGE_PATTERNS.some(pattern => normalized.includes(pattern))) {
      return true;
    }
    if (NON_RETRYABLE_MESSAGE_PATTERNS.some(pattern => normalized.includes(pattern))) {
      return false;
    }
    return true;
  }
  
  /**
   * 计算重试延迟（指数退避 + 抖动）
   */
  private calculateRetryDelay(retryCount: number): number {
    // 指数退避：1s, 2s, 4s, 8s...
    const exponentialDelay = THROTTLE_CONFIG.RETRY_BASE_DELAY * Math.pow(2, retryCount - 1);
    
    // 添加随机抖动（±20%）
    const jitter = exponentialDelay * 0.2 * (Math.random() * 2 - 1);
    
    // 限制最大延迟
    return Math.min(
      exponentialDelay + jitter,
      THROTTLE_CONFIG.RETRY_MAX_DELAY
    );
  }
  
  /**
   * 清理过期的去重缓存
   * 【2026-02-15 修复】增加容量上限保护，防止长时间运行后 Map 无限增长
   */
  private cleanupDedupeCache(): void {
    const now = Date.now();
    const expiredKeys: string[] = [];
    this.dedupeCache.forEach((value, key) => {
      if (value.expiresAt < now) {
        expiredKeys.push(key);
      }
    });
    expiredKeys.forEach(key => {
      this.dedupeCache.delete(key);
    });
    // 容量保护：超过上限时按过期时间排序淘汰最旧的条目
    if (this.dedupeCache.size > this.MAX_DEDUPE_CACHE_SIZE) {
      const entries = Array.from(this.dedupeCache.entries())
        .sort((a, b) => a[1].expiresAt - b[1].expiresAt);
      const toRemove = entries.length - this.MAX_DEDUPE_CACHE_SIZE;
      for (let i = 0; i < toRemove; i++) {
        this.dedupeCache.delete(entries[i][0]);
      }
    }
  }
  
  /**
   * 清除所有待处理请求
   */
  clearAll(): void {
    this.clearGeneration++;
    const activeCancellations = Array.from(this.activeRequestCancellations.values());
    this.activeRequestCancellations.clear();
    for (const cancel of activeCancellations) {
      cancel();
    }

    for (const { timer, request } of this.retryTimers.values()) {
      clearTimeout(timer);
      request.reject(new Error('请求被取消'));
    }
    this.retryTimers.clear();

    for (const request of this.queue) {
      request.reject(new Error('请求被取消'));
    }
    this.queue = [];
    this.queueLength.set(0);
    this.dedupeCache.clear();
  }
  
  /**
   * 获取当前状态（调试用）
   */
  getStatus(): {
    activeCount: number;
    queueLength: number;
    dedupeCacheSize: number;
  } {
    return {
      activeCount: this.activeCount,
      queueLength: this.queue.length,
      dedupeCacheSize: this.dedupeCache.size,
    };
  }
}
