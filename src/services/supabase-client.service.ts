import { Injectable, inject, signal } from '@angular/core';
import type { AuthResponse, Session, SupabaseClient } from '@supabase/supabase-js';
import { LoggerService } from './logger.service';
import { environment } from '../environments/environment';
import type { Database } from '../types/supabase';
import { FEATURE_FLAGS } from '../config/feature-flags.config';
import { SUPABASE_CLIENT_FETCH_MAX_MS, NETWORK_OFFLINE_DEBOUNCE_MS } from '../config/timeout.config';
import { SupabaseClientOptionsFactoryService } from './supabase-client-options-factory.service';
import {
  isSensitiveSupabaseAnonKey,
  resolveSupabaseStorageKey,
  validateSupabaseConfiguration,
} from './supabase-client-configuration';
import {
  buildSupabaseFetch401RetryKey,
  buildSupabaseRequestSignature,
  getSupabaseRequestMethod,
  isGatewayRetrySafeSupabaseRequest,
  redactSupabaseRequestUrl,
} from './supabase-fetch-request.helpers';
import {
  createBrowserNetworkSuspendedError,
  isBrowserNetworkSuspendedError,
  isBrowserNetworkSuspendedWindow,
} from '../utils/browser-network-suspension';
import {
  SupabaseAuthAutoRefreshController,
  type SupabaseAuthAutoRefreshReason,
} from './supabase-auth-auto-refresh.controller';

export interface SupabaseConnectivityChange {
  offline: boolean;
  source: 'probe' | 'request' | 'manual';
}

type SupabaseConnectivityListener = (change: SupabaseConnectivityChange) => void;

@Injectable({
  providedIn: 'root'
})
export class SupabaseClientService {
  private readonly logger = inject(LoggerService).category('SupabaseClient');
  private readonly clientOptionsFactory = inject(SupabaseClientOptionsFactoryService);
  private supabase: SupabaseClient<Database> | null = null;
  private initPromise: Promise<SupabaseClient<Database> | null> | null = null;

  // 【鲁棒性 3】fetch 层 401 重试计数，防止无限重试
  // key: 请求 URL + method，value: 已重试次数
  private readonly fetch401RetryCount = new Map<string, number>();
  private readonly MAX_FETCH_401_RETRIES = 1; // 最多重试一次（总共 2 次请求）

  // 【根因修复 2026-04-20】Supabase 网关瞬时 5xx（502/503/504）静默重试。
  // 背景：用户控制台频繁出现 "Access-Control-Allow-Origin ... blocked by CORS"，
  // 实为 Supabase edge 返回 502 时未携带 CORS 头，被浏览器错报为 CORS 错误。
  // 这类 5xx 几乎都是上游 PostgREST 瞬时波动，重试一次即可恢复。
  // 仅对幂等方法（GET/HEAD）启用，写操作由上层 RetryQueue 负责。
  private readonly MAX_FETCH_GATEWAY_RETRIES = 2; // 最多额外重试 2 次（总共 3 次请求）
  private readonly FETCH_GATEWAY_RETRY_BASE_MS = 300; // 指数退避基数：300ms → 600ms
  private readonly FETCH_GATEWAY_RETRY_JITTER_MS = 150; // 抖动上限，避免雷鸣群效应

  // 【鲁棒性 8】请求去重缓存 - 防止网络不稳定时同一请求重复发送
  // key: 请求签名（method+url+body hash），value: { promise, createdAt, response }
  private readonly requestDeduplicationCache = new Map<string, {
    promise: Promise<Response>;
    createdAt: number;
    response?: Response;
  }>();
  private readonly REQUEST_DEDUP_TTL_MS = 5000; // 5s 内去重
  
  private reachabilityProbePromise: Promise<boolean> | null = null;
  private readonly connectivityListeners = new Set<SupabaseConnectivityListener>();
  private lastReachabilityProbeAt = 0;
  private lastReachabilityProbeResult = true;
  private readonly canInitialize: boolean;
  private readonly supabaseUrl: string;
  private readonly supabaseAnonKey: string;

  // 配置状态信号，UI 可以响应式订阅
  readonly configurationError = signal<string | null>(null);
  readonly isOfflineMode = signal(false);
  private readonly authAutoRefresh = new SupabaseAuthAutoRefreshController({
    isOfflineMode: () => this.isOfflineMode(),
    logger: this.logger,
  });

  constructor() {
    const supabaseUrl = environment.supabaseUrl;
    const supabaseAnonKey = environment.supabaseAnonKey;

    const validation = validateSupabaseConfiguration(
      supabaseUrl,
      supabaseAnonKey,
      environment.production,
      this.logger,
    );
    if (validation.blocked) {
      this.canInitialize = false;
      this.supabaseUrl = '';
      this.supabaseAnonKey = '';
      if (validation.configurationError) {
        this.configurationError.set(validation.configurationError);
      }
      if (validation.offlineMode) {
        this.isOfflineMode.set(true);
      }
      return;
    }

    this.canInitialize = true;
    this.supabaseUrl = supabaseUrl;
    this.supabaseAnonKey = supabaseAnonKey;

    // 兼容开关：关闭延迟装载时维持启动期初始化
    if (!FEATURE_FLAGS.SUPABASE_DEFERRED_SDK_V1) {
      void this.ensureClientReady().catch((error) => {
        this.logger.warn('启动期 Supabase 初始化失败，降级为离线模式', error);
      });
    }
  }

  private isSensitiveKey(key: string): boolean {
    return isSensitiveSupabaseAnonKey(key, this.logger);
  }

  get isConfigured(): boolean {
    return this.canInitialize;
  }

  /**
   * 返回 Supabase auth token 在 localStorage 中的存储键名。
   * 供本地会话快速路径读取（避免重复硬编码 key 格式）。
   */
  getStorageKey(): string | null {
    if (!this.canInitialize || !this.supabaseUrl) return null;
    return resolveSupabaseStorageKey(this.supabaseUrl);
  }

  async clientAsync(): Promise<SupabaseClient<Database> | null> {
    if (!this.canInitialize) return null;
    if (this.supabase) return this.supabase;
    if (this.initPromise) return this.initPromise;

    this.initPromise = import('@supabase/supabase-js')
      .then(({ createClient }) => {
        this.supabase = createClient<Database>(
          this.supabaseUrl,
          this.supabaseAnonKey,
          this.buildClientOptions()
        );
        this.ensureAuthAutoRefreshLifecycle();
        void this.syncAuthAutoRefresh('client-init');
        return this.supabase;
      })
      .catch((error) => {
        this.logger.error('Supabase 客户端初始化失败', error);
        this.configurationError.set('Supabase 客户端初始化失败');
        this.supabase = null;
        return null;
      })
      .finally(() => {
        this.initPromise = null;
      });

    return this.initPromise;
  }

  async ensureClientReady(): Promise<void> {
    const client = await this.clientAsync();
    if (!client) {
      throw new Error('Supabase 客户端未就绪（可能是配置缺失或初始化失败）');
    }
  }

  onConnectivityChange(listener: SupabaseConnectivityListener): () => void {
    this.connectivityListeners.add(listener);
    return () => {
      this.connectivityListeners.delete(listener);
    };
  }

  private setOfflineModeState(
    offline: boolean,
    source: SupabaseConnectivityChange['source']
  ): void {
    const changed = this.isOfflineMode() !== offline;
    this.isOfflineMode.set(offline);

    if (!changed) {
      return;
    }

    void this.syncAuthAutoRefresh(offline ? 'offline' : 'resume-timer');

    for (const listener of this.connectivityListeners) {
      try {
        listener({ offline, source });
      } catch (error) {
        this.logger.debug('Supabase 连通性监听器执行失败', { source, error });
      }
    }
  }

  async probeReachability(options?: { timeoutMs?: number; force?: boolean }): Promise<boolean> {
    if (!this.canInitialize) {
      return this.setReachabilityProbeResult(false);
    }

    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      return this.setReachabilityProbeResult(false);
    }

    if (isBrowserNetworkSuspendedWindow()) {
      this.logger.debug('浏览器网络挂起窗口内跳过 Supabase 连通性探测');
      return false;
    }

    const now = Date.now();
    const force = options?.force === true;
    const timeoutMs = Math.max(250, options?.timeoutMs ?? 5000);
    const cacheTtlMs = 15_000;

    if (!force && this.reachabilityProbePromise) {
      return this.reachabilityProbePromise;
    }

    if (!force && now - this.lastReachabilityProbeAt < cacheTtlMs) {
      return this.lastReachabilityProbeResult;
    }

    if (typeof fetch !== 'function') {
      return this.setReachabilityProbeResult(true, now);
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    const authProbeUrl = new URL('/auth/v1/health', this.supabaseUrl).toString();

    // 可达性探测：只用 Auth health 端点判断（公开，不需要认证）
    // REST /rest/v1/ 端点可能因 anon key 权限不足返回 401，这不代表服务不可达
    this.reachabilityProbePromise = fetch(authProbeUrl, this.buildReachabilityProbeRequest(controller))
      .then(authResponse => this.handleReachabilityProbeResponse(authResponse))
      .catch((error: unknown) => this.handleReachabilityProbeError(error))
      .finally(() => this.finishReachabilityProbe(timeoutId));

    return this.reachabilityProbePromise;
  }

  private setReachabilityProbeResult(reachable: boolean, timestamp = Date.now()): boolean {
    this.setOfflineModeState(!reachable, 'probe');
    this.lastReachabilityProbeResult = reachable;
    this.lastReachabilityProbeAt = timestamp;
    return reachable;
  }

  private buildReachabilityProbeRequest(controller: AbortController): RequestInit {
    return {
      method: 'GET',
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        apikey: this.supabaseAnonKey,
      },
    };
  }

  private handleReachabilityProbeResponse(authResponse: Response): boolean {
    const isGatewayError = authResponse.status >= 502 && authResponse.status <= 504;
    // Captive portal（酒店/地铁 WiFi 登录页）会把公开 health 端点劫持成
    // text/html 登录页（常见 200 或 302→200）；真实 Supabase auth health
    // 响应不会是 HTML。放行 portal 会触发整条恢复扇出（drain + 双 pull +
    // outbox flush）打向登录页，每 15s 一轮假恢复
    const contentType = authResponse.headers.get('content-type') ?? '';
    const isPortalStyleHtml = contentType.toLowerCase().includes('text/html');
    const reachable = this.setReachabilityProbeResult(!isGatewayError && !isPortalStyleHtml);
    if (!reachable) {
      this.logger.info('Supabase 连通性探测判定不可达', {
        authStatus: authResponse.status,
        contentType: contentType || null,
        portalSuspected: isPortalStyleHtml,
      });
    }
    return reachable;
  }

  private handleReachabilityProbeError(error: unknown): boolean {
    this.setReachabilityProbeResult(false);
    this.logger.info('Supabase 连通性探测失败，进入连接中断模式', {
      message: error instanceof Error ? error.message : String(error),
    });
    return false;
  }

  private finishReachabilityProbe(timeoutId: ReturnType<typeof setTimeout>): void {
    clearTimeout(timeoutId);
    this.reachabilityProbePromise = null;
  }

  clearOfflineMode(): void {
    this.setOfflineModeState(false, 'manual');
    this.lastReachabilityProbeResult = true;
    this.lastReachabilityProbeAt = Date.now();
  }

  private shouldMarkOfflineFromFetchFailure(error: unknown): boolean {
    if (isBrowserNetworkSuspendedError(error)) {
      return false;
    }

    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      return true;
    }

    if (error instanceof DOMException) {
      return error.name === 'NetworkError';
    }

    if (error instanceof TypeError) {
      const message = error.message.toLowerCase();
      return message.includes('failed to fetch') || message.includes('network');
    }

    return false;
  }

  /**
   * 同步客户端获取仅用于“已就绪路径”。
   * 未就绪时抛出可诊断错误，调用方应改用 clientAsync/ensureClientReady。
   */
  client(): SupabaseClient<Database> {
    if (!this.canInitialize) {
      throw new Error('Supabase 未配置，请提供 NG_APP_SUPABASE_URL 与 NG_APP_SUPABASE_ANON_KEY');
    }
    if (!this.supabase) {
      throw new Error('Supabase 客户端尚未就绪，请先调用 ensureClientReady() 或 clientAsync()');
    }
    return this.supabase;
  }

  reset(): void {
    const client = this.supabase;
    this.authAutoRefresh.reset(client);
    this.supabase = null;
    this.initPromise = null;
  }

  private ensureAuthAutoRefreshLifecycle(): void {
    this.authAutoRefresh.bindLifecycle(reason => {
      void this.syncAuthAutoRefresh(reason);
    });
  }

  private syncAuthAutoRefresh(
    reason: SupabaseAuthAutoRefreshReason
  ): Promise<void> {
    return this.authAutoRefresh.sync(this.supabase, reason, () => {
      void this.syncAuthAutoRefresh('resume-timer');
    });
  }

  /**
   * 【鲁棒性 5】获取 token 续签指标（供调试/监控使用）
   */
  getProactiveRefreshMetrics() {
    return this.authAutoRefresh.getMetrics();
  }

  async getSession(): Promise<{ data: { session: Session | null }; error: null | { message: string; status?: number; name?: string } }> {
    const client = await this.clientAsync();
    if (!client) {
      // 客户端不可用时返回 error，而非 { session: null, error: null }。
      // 后者会被误判为"用户确实未登录"，导致 FastPath 乐观状态被清除。
      return { data: { session: null }, error: { message: 'Supabase 客户端不可用', name: 'ClientUnavailable' } };
    }
    return client.auth.getSession();
  }

  async signInWithPassword(email: string, password: string): Promise<AuthResponse> {
    const client = await this.clientAsync();
    if (!client) {
      throw new Error('Supabase 未配置，无法登录');
    }
    return client.auth.signInWithPassword({ email, password });
  }

  async signOut(): Promise<void> {
    const client = await this.clientAsync();
    if (!client) return;
    const result = await client.auth.signOut();
    if (result?.error) {
      throw result.error;
    }
  }

  /**
   * 【根本修复】Supabase 客户端 fetch 层 401 自愈拦截器。
   *
   * 问题：REST/Functions/Storage 端点收到 401（JWT expired）后，Supabase JS 自身不会
   * 自动刷新+重试，而是把错误抛回调用方；各调用点必须自行实现 withAuthRetry。这种
   * 分散式自愈容易遗漏路径（如未经测试的冷门端点），造成控制台刷 401。
   *
   * 方案：把自愈逻辑下沉到 fetch 层——所有经 Supabase 客户端发出的请求都透明地获得
   *   "401 → refreshSession → retry once" 能力。Refresh token 自身请求（/auth/v1/token）
   *   绕过本逻辑以避免递归。每个请求最多重试一次，避免风暴。
   *
   * 这是三层防御的最内层：预防（proactivelyRefreshIfNearingExpiry）+ 拦截（本方法）
   * + 兜底（上层的 withAuthRetry 仍保留）。任何一层单独都能解决大部分问题，三层叠加
   *   逼近零可见 401 错误。
   */
  private async supabaseFetch(url: RequestInfo | URL, options: RequestInit = {}): Promise<Response> {
    if (isBrowserNetworkSuspendedWindow()) {
      throw createBrowserNetworkSuspendedError();
    }

    // 离线时直接拒绝，避免等待超时产生 AbortError
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      this.setOfflineModeState(true, 'request');
      throw new DOMException('Device is offline', 'NetworkError');
    }

    if (this.isOfflineMode()) {
      throw createBrowserNetworkSuspendedError();
    }

    // 【鲁棒性 8】请求去重：5s 内的重复读取请求复用前一个结果（GET/HEAD + 只读 RPC，写操作不去重）
    const httpMethod = getSupabaseRequestMethod(url, options);
    const isGatewayRetrySafeRequest = isGatewayRetrySafeSupabaseRequest(url, options, httpMethod);

    if (isGatewayRetrySafeRequest) {
      const signature = buildSupabaseRequestSignature(url, options);
      const cached = this.requestDeduplicationCache.get(signature);

      if (cached && Date.now() - cached.createdAt < this.REQUEST_DEDUP_TTL_MS) {
        this.logger.debug('请求去重命中，复用缓存结果', { signature });
        if (cached.response) {
          return cached.response.clone();
        }
        // 【根因修复】cached.response 未就绪时，多个并发 awaiter 会拿到同一个原始
        // Response 实例；一旦下游（如 Supabase JS）消费 body，其他 awaiter 再读就会
        // 抛 "Failed to execute 'text' on 'Response': body stream already read"。
        // 必须 clone 后再返回，保证每个 awaiter 独占 body 流。
        const sharedResponse = await cached.promise;
        return sharedResponse.clone();
      }

      // 清理过期缓存
      this.cleanupDeduplicationCache();

      // 缓存本次请求的 promise，后续请求会 await 它而不是重新发送
      const fetchPromise = (async () => {
        try {
          // 【根因修复 2026-04-20】读取请求启用网关 5xx 静默重试，吸收 Supabase edge
          // 瞬时 502/503/504（浏览器常误报为 CORS 错误），避免上抛到 UI。
          const response = await this.fetchWithGatewayRetry(url, options);
          const cacheEntry = this.requestDeduplicationCache.get(signature);
          if (cacheEntry) {
            cacheEntry.response = response.clone();
          }
          return response;
        } catch (err) {
          // 请求失败时主动清除缓存，允许后续请求立即重试而非复用失败的 promise
          this.requestDeduplicationCache.delete(signature);
          throw err;
        }
      })();

      this.requestDeduplicationCache.set(signature, {
        promise: fetchPromise,
        createdAt: Date.now()
      });

      // 【根因修复】首个调用方也必须 clone：若并发 awaiter 同时存在，双方拿到的都是
      // 同一个原始 Response；这里 clone 后再交给 handle401Retry 与下游消费。
      const dedupResponse = (await fetchPromise).clone();
      return await this.handle401Retry(url, options, dedupResponse);
    }

    // 非幂等请求（POST/PATCH/PUT/DELETE 等）：直接发送，不去重
    const directResponse = await this.fetchWithTimeout(url, options);
    return await this.handle401Retry(url, options, directResponse);
  }

  /**
   * 【精准自愈策略】处理 401 响应的重试逻辑：
   * 1. 401 + JWT 问题特征 + 未超过重试上限 → 刷新重试
   * 2. 5xx 网关错误 → 不刷新（与认证无关）
   * 3. 其他 4xx / 3xx / 2xx → 直接返回（非自愈场景）
   */
  private async handle401Retry(
    url: RequestInfo | URL,
    options: RequestInit,
    response: Response
  ): Promise<Response> {
    const retryKey = this.buildFetch401RetryKey(url, options);
    const currentRetryCount = this.fetch401RetryCount.get(retryKey) ?? 0;

    if (!this.shouldAttempt401SelfHealing(url, response, currentRetryCount)) {
      return response;
    }

    try {
      const accessToken = await this.refreshSessionForFetchRetry();
      if (!accessToken) return response;

      this.logger.debug('fetch 层捕获 401，已主动刷新 session，重试一次', {
        url: redactSupabaseRequestUrl(url),
      });
      this.fetch401RetryCount.set(retryKey, currentRetryCount + 1);
      return await this.retryFetchWithRefreshedToken(url, options, retryKey, accessToken);
    } catch (refreshError) {
      this.logger.debug('fetch 层 401 自愈刷新异常，沿用原 401 响应', { error: refreshError });
    }

    return response;
  }

  private shouldAttempt401SelfHealing(
    url: RequestInfo | URL,
    response: Response,
    currentRetryCount: number,
  ): boolean {
    return response.status === 401 &&
      this.shouldAttemptJwtRefreshForFetch(url) &&
      this.looksLikeJwtAuthFailure(response) &&
      currentRetryCount < this.MAX_FETCH_401_RETRIES;
  }

  private async refreshSessionForFetchRetry(): Promise<string | null> {
    const client = this.supabase;
    if (!client) return null;

    const { data, error } = await client.auth.refreshSession();
    return !error && data.session ? data.session.access_token : null;
  }

  private async retryFetchWithRefreshedToken(
    url: RequestInfo | URL,
    options: RequestInit,
    retryKey: string,
    accessToken: string,
  ): Promise<Response> {
    const retryOptions = this.replaceAuthorizationHeader(options, accessToken);
    try {
      const retryMethod = getSupabaseRequestMethod(url, retryOptions);
      const retryResponse = isGatewayRetrySafeSupabaseRequest(url, retryOptions, retryMethod)
        ? await this.fetchWithGatewayRetry(url, retryOptions)
        : await this.fetchWithTimeout(url, retryOptions);
      this.fetch401RetryCount.delete(retryKey);
      return retryResponse;
    } catch (retryError) {
      this.fetch401RetryCount.delete(retryKey);
      throw retryError;
    }
  }

  /**
   * 通过 response headers 判断 401 是否由 JWT 问题引起（而非 RLS 权限）。
   * 优势：不消费 body（下游 Supabase JS 仍能正常解析），且精准识别——避免对真正的
   * 权限错误做无意义的 refresh 浪费网络 / 触发 Supabase 速率限制。
   *
   * PostgREST/GoTrue 的约定：
   *   - JWT 相关 401 返回 WWW-Authenticate: Bearer error="invalid_token"
   *   - 某些 Edge Function / Storage 实现直接返回 401 无 header → 为保守起见放行
   */
  private looksLikeJwtAuthFailure(response: Response): boolean {
    const wwwAuth = response.headers.get('www-authenticate') ?? '';
    if (wwwAuth.toLowerCase().includes('invalid_token') || wwwAuth.toLowerCase().includes('expired_token')) {
      return true;
    }
    // 没有 WWW-Authenticate 头时保守视为可能的 JWT 问题；若刷新后仍 401 也只多一次请求，成本可控
    if (!wwwAuth) {
      return true;
    }
    // 有 WWW-Authenticate 但不含 JWT 相关字眼（如 "Bearer realm=..." 无 error）→ 疑似权限问题，跳过刷新
    return false;
  }

  /**
   * 判断一个请求是否应该参与 401 自愈拦截。
   * 排除 /auth/v1/ 自身的请求（refresh token、signIn 等）以防递归。
   */
  private shouldAttemptJwtRefreshForFetch(url: RequestInfo | URL): boolean {
    const urlStr = typeof url === 'string'
      ? url
      : url instanceof URL
        ? url.href
        : (url as Request).url;
    if (!urlStr) return false;
    // 排除 auth 端点避免递归
    if (urlStr.includes('/auth/v1/')) return false;
    return true;
  }

  private replaceAuthorizationHeader(options: RequestInit, accessToken: string): RequestInit {
    const headers = new Headers(options.headers ?? {});
    headers.set('Authorization', `Bearer ${accessToken}`);
    return { ...options, headers };
  }

  private buildFetch401RetryKey(url: RequestInfo | URL, options: RequestInit): string {
    return buildSupabaseFetch401RetryKey(url, options);
  }

  /**
   * 【鲁棒性 8】清理过期的去重缓存
   */
  private cleanupDeduplicationCache(): void {
    const now = Date.now();
    for (const [key, entry] of this.requestDeduplicationCache) {
      if (now - entry.createdAt > this.REQUEST_DEDUP_TTL_MS) {
        this.requestDeduplicationCache.delete(key);
      }
    }
  }

  /**
   * 【根因修复 2026-04-20】读取请求的网关 5xx 瞬时错误静默重试。
   *
   * 问题链条：
   *  1. Supabase edge 偶发返回 502/503/504（上游 PostgREST 扩缩容 / 连接池抖动）。
   *  2. 这些 5xx 响应经常缺失 `Access-Control-Allow-Origin`，被浏览器升级为
   *     刺眼的 CORS 错误刷屏。
   *  3. 单次失败直接上抛会破坏本地同步流水（batch-sync / canonical-match 等）。
   *    目前 401 与 5xx 互斥（401 不会被 5xx 判定捕获），层级清晰。
   */
  private async fetchWithGatewayRetry(url: RequestInfo | URL, options: RequestInit): Promise<Response> {
    let attempt = 0;
    while (true) {
      try {
        const response = await this.fetchWithTimeout(url, options);
        const isGatewayError = response.status === 502 || response.status === 503 || response.status === 504;
        if (!isGatewayError || attempt >= this.MAX_FETCH_GATEWAY_RETRIES) {
          return response;
        }

        // 离线 / 网络挂起时放弃重试，保持原响应
        if (isBrowserNetworkSuspendedWindow()) {
          return response;
        }
        if (typeof navigator !== 'undefined' && !navigator.onLine) {
          return response;
        }

        attempt++;
        await this.cancelGatewayRetryResponse(response);
        const delayMs = this.getGatewayRetryDelayMs(attempt);
        this.logger.debug('Supabase 网关 5xx 瞬时错误，延迟后重试', {
          url: redactSupabaseRequestUrl(url),
          status: response.status,
          attempt,
          delayMs,
        });
        await this.delayGatewayRetry(delayMs);
      } catch (error: unknown) {
        if (!this.shouldRetryGatewayFetchRejection(error) || attempt >= this.MAX_FETCH_GATEWAY_RETRIES) {
          throw error;
        }

        attempt++;
        const delayMs = this.getGatewayRetryDelayMs(attempt);
        this.logger.debug('Supabase 请求被浏览器按网络错误拒绝，按网关瞬时故障路径重试', {
          url: redactSupabaseRequestUrl(url),
          attempt,
          delayMs,
          message: error instanceof Error ? error.message : String(error),
        });
        await this.delayGatewayRetry(delayMs);
      }
    }
  }

  private async cancelGatewayRetryResponse(response: Response): Promise<void> {
    try {
      await response.body?.cancel();
    } catch {
      // 忽略 cancel 异常，继续重试 // eslint-disable-line no-restricted-syntax
    }
  }

  private getGatewayRetryDelayMs(attempt: number): number {
    const backoff = this.FETCH_GATEWAY_RETRY_BASE_MS * Math.pow(2, attempt - 1);
    const jitter = Math.floor(Math.random() * this.FETCH_GATEWAY_RETRY_JITTER_MS);
    return backoff + jitter;
  }

  private delayGatewayRetry(delayMs: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, delayMs));
  }

  private shouldRetryGatewayFetchRejection(error: unknown): boolean {
    if (isBrowserNetworkSuspendedError(error) || isBrowserNetworkSuspendedWindow()) {
      return false;
    }

    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      return false;
    }

    if (error instanceof DOMException) {
      return error.name === 'NetworkError';
    }

    if (error instanceof TypeError) {
      const message = error.message.toLowerCase();
      return message.includes('failed to fetch')
        || message.includes('networkerror')
        || message.includes('load failed');
    }

    return false;
  }

  /**
   * 从原 fetch 包装中抽出：承担「超时 + 离线探测 + 错误分级」等副作用。
   */
  private async fetchWithTimeout(url: RequestInfo | URL, options: RequestInit): Promise<Response> {
    const callerSignal = options.signal;
    const controller = new AbortController();
    // 【超时治理 2026-04-16】原先写死 120_000 魔数；改用 SUPABASE_CLIENT_FETCH_MAX_MS
    // 语义保持不变：整个客户端 fetch 的「最后防线」超时
    const timeoutId = setTimeout(() => controller.abort(), SUPABASE_CLIENT_FETCH_MAX_MS);

    let mergedSignal: AbortSignal;
    if (callerSignal && typeof AbortSignal !== 'undefined' && 'any' in AbortSignal) {
      mergedSignal = (AbortSignal as unknown as { any: (signals: AbortSignal[]) => AbortSignal }).any([
        callerSignal,
        controller.signal
      ]);
    } else {
      mergedSignal = callerSignal ?? controller.signal;
    }

    try {
      const response = await fetch(url, {
        ...options,
        signal: mergedSignal,
      });
      // 收到 HTTP 响应表示网络可达，但 502-504 网关错误不清除离线模式
      const isGatewayError = response.status >= 502 && response.status <= 504;
      if (this.isOfflineMode() && !isGatewayError) {
        this.setOfflineModeState(false, 'request');
      }
      return response;
    } catch (error: unknown) {
      // 【鲁棒性增强】在标记离线前，再次检查当前网络状态，避免瞬时波动误报
      if (this.shouldMarkOfflineFromFetchFailure(error)) {
        // 延迟 100ms 再次确认，过滤一次性网络波动
        await new Promise(r => setTimeout(r, NETWORK_OFFLINE_DEBOUNCE_MS));
        if (!isBrowserNetworkSuspendedWindow()) {
          this.setOfflineModeState(true, 'request');
        }
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private buildClientOptions() {
    return this.clientOptionsFactory.buildClientOptions(
      this.supabaseUrl,
      (url: RequestInfo | URL, options: RequestInit = {}) => this.supabaseFetch(url, options),
    );
  }
}
