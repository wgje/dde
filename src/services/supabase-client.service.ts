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
import {
  SupabaseCredentialRequestSessionBindingController,
  type SignupSessionPublicationFence,
} from './supabase-credential-request-session-binding.controller';
import type { AuthCredentialStateCommitPredicate } from './auth-credential-flow.controller';
import {
  getCanonicalAuthStorageAuthority,
  SupabaseAuthClientLifecycleController,
  type SupabaseAuthClientCandidate,
} from './supabase-auth-client-lifecycle.controller';
import { SupabaseAuthScopedRequestCacheController } from './supabase-auth-scoped-request-cache.controller';

export interface CredentialRequestSessionBinding {
  requestId: string;
  previousPersistedSession: string | null;
}

export type CredentialSignInFetchContext = {
  requestId: string;
};

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
  private readonly authClientLifecycle = new SupabaseAuthClientLifecycleController();
  private readonly authScopedRequestCache = new SupabaseAuthScopedRequestCacheController({
    anonymousBearerToken: () => this.supabaseAnonKey,
    authority: getCanonicalAuthStorageAuthority,
    isCandidateCurrent: candidate => this.authClientLifecycle.isCurrent(candidate),
    onCacheHit: signature => this.logger.debug('请求去重命中，复用缓存结果', { signature }),
  });
  private supabase: SupabaseClient<Database> | null = null;
  private initPromise: Promise<SupabaseClient<Database> | null> | null = null;
  // Fetch 401 retry counts are bounded per request signature.
  private readonly fetch401RetryCount = new Map<string, number>();
  private readonly MAX_FETCH_401_RETRIES = 1; // 最多重试一次（总共 2 次请求）
  // Transient gateway retries stay limited to idempotent requests.
  private readonly MAX_FETCH_GATEWAY_RETRIES = 2; // 最多额外重试 2 次（总共 3 次请求）
  private readonly FETCH_GATEWAY_RETRY_BASE_MS = 300; // 指数退避基数：300ms → 600ms
  private readonly FETCH_GATEWAY_RETRY_JITTER_MS = 150; // 抖动上限，避免雷鸣群效应

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
  private readonly credentialRequestSessionBinding =
    new SupabaseCredentialRequestSessionBindingController({
      getStorageKey: () => this.getStorageKey(),
      getSupabaseUrl: () => this.supabaseUrl,
      getSupabaseAnonKey: () => this.supabaseAnonKey,
      buildSignupClientOptions: (storageKey, storage, fetchHandler) =>
        this.clientOptionsFactory.buildSignupClientOptions(storageKey, storage, fetchHandler),
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
  getStorageKey(): string | null {
    if (!this.canInitialize || !this.supabaseUrl) return null;
    return resolveSupabaseStorageKey(this.supabaseUrl);
  }
  consumeCredentialRequestIdForAccessToken(
    accessToken: string,
  ): CredentialRequestSessionBinding | null {
    return this.credentialRequestSessionBinding.consume(accessToken);
  }
  async clientAsync(): Promise<SupabaseClient<Database> | null> {
    if (!this.canInitialize) return null;
    if (this.supabase) return this.supabase;
    if (this.initPromise) return this.initPromise;
    const storageKey = this.getStorageKey();
    if (!storageKey) return null;
    const promise = this.authClientLifecycle.beginCandidate(storageKey)
      .then(async candidate => {
        const { createClient } = await import('@supabase/supabase-js');
        const client = createClient<Database>(
          this.supabaseUrl,
          this.supabaseAnonKey,
          this.buildClientOptions(candidate)
        );
        try {
          await client.auth.getSession();
          const promoted = await this.authClientLifecycle.promote(candidate);
          if (!promoted || !this.authClientLifecycle.isCurrent(candidate) || this.initPromise !== promise) {
            return this.authClientLifecycle.disposeClient(client);
          }
        } catch (error) {
          this.authClientLifecycle.disposeClient(client);
          throw error;
        }
        this.supabase = client;
        this.ensureAuthAutoRefreshLifecycle();
        void this.syncAuthAutoRefresh('client-init');
        return this.supabase;
      })
      .catch((error) => {
        if (this.initPromise !== promise) return null;
        if (error instanceof Error && error.message.startsWith('AUTH_')) return null;
        this.logger.error('Supabase 客户端初始化失败', error);
        this.configurationError.set('Supabase 客户端初始化失败');
        this.supabase = null;
        return null;
      })
      .finally(() => {
        if (this.initPromise === promise) this.initPromise = null;
      });
    this.initPromise = promise;
    return promise;
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
    this.authScopedRequestCache.reset();
    this.authClientLifecycle.reset();
    this.authAutoRefresh.reset(client);
    if (client) this.authClientLifecycle.disposeClient(client);
    this.supabase = null;
    this.initPromise = null;
    this.credentialRequestSessionBinding.clearCompletedBindings();
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

  async signInWithPassword(
    email: string,
    password: string,
    credentialRequestId?: string,
  ): Promise<AuthResponse> {
    const client = await this.clientAsync();
    if (!client) {
      throw new Error('Supabase 未配置，无法登录');
    }
    if (!credentialRequestId) {
      return client.auth.signInWithPassword({ email, password });
    }
    return await this.credentialRequestSessionBinding.runSignIn(
      credentialRequestId,
      () => client.auth.signInWithPassword({ email, password }),
    );
  }

  async signUpIsolated(
    email: string,
    password: string,
    emailRedirectTo: string,
    canCommit: AuthCredentialStateCommitPredicate,
    afterSessionCommit: SignupSessionPublicationFence,
  ): Promise<AuthResponse> {
    if (!this.canInitialize) throw new Error('AUTH_SIGNUP_CONFIGURATION_UNAVAILABLE');
    return await this.credentialRequestSessionBinding.runSignUp(
      email, password, emailRedirectTo, canCommit, afterSessionCommit,
    );
  }

  async authorizeSignupAdoption(
    expected: { access_token: string; user: { id: string; email?: string | null } },
    authorize: () => boolean,
  ): Promise<boolean> {
    const storageKey = this.getStorageKey();
    if (!this.canInitialize || !storageKey) return false;
    const lifecycle = new SupabaseAuthClientLifecycleController();
    const candidate = await lifecycle.beginCandidate(storageKey);
    try {
      const { createClient } = await import('@supabase/supabase-js');
      const client = createClient<Database>(this.supabaseUrl, this.supabaseAnonKey,
        this.clientOptionsFactory.buildSignupAdoptionClientOptions(
          candidate.storageKey, candidate.storage,
        ));
      try {
        const { data, error } = await client.auth.getSession();
        const session = data.session;
        return !error && !!session
          && session.access_token === expected.access_token
          && session.user.id === expected.user.id
          && (session.user.email ?? null) === (expected.user.email ?? null)
          && authorize();
      } finally {
        const cleanups: Array<Promise<unknown>> = [];
        try {
          cleanups.push(Promise.resolve(client.auth.dispose()));
        } catch (error) {
          cleanups.push(Promise.reject(error));
        }
        try {
          cleanups.push(Promise.resolve(client.removeAllChannels()));
        } catch (error) {
          cleanups.push(Promise.reject(error));
        }
        await Promise.allSettled(cleanups);
      }
    } finally {
      lifecycle.reset();
    }
  }

  signOut(): Promise<void> {
    return this.clientAsync().then(client => {
      if (!client) return;
      const operation = client.auth.signOut().then(result => {
        if (result?.error) throw result.error;
      });
      this.authClientLifecycle.holdPublicationUntil(operation, SUPABASE_CLIENT_FETCH_MAX_MS);
      return operation;
    });
  }
  private async supabaseFetch(
    url: RequestInfo | URL,
    options: RequestInit = {},
    authGeneration?: SupabaseAuthClientCandidate,
  ): Promise<Response> {
    const credentialSignInContext = this.credentialRequestSessionBinding.currentFetchContext();
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
      const dedupResponse = await this.authScopedRequestCache.execute({
        candidate: authGeneration,
        signature,
        options,
        request: url,
        fetch: () => this.fetchWithGatewayRetry(url, options),
      });
      return await this.handle401Retry(url, options, dedupResponse);
    }

    const directResponse = await this.fetchWithTimeout(url, options);
    const response = await this.handle401Retry(url, options, directResponse);
    await this.credentialRequestSessionBinding.bindResponse(credentialSignInContext, url, options, response);
    return response;
  }

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
      // 忽略 cancel 异常，继续重试。
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

  private buildClientOptions(authGeneration?: SupabaseAuthClientCandidate) {
    return this.clientOptionsFactory.buildClientOptions(
      this.supabaseUrl,
      (url: RequestInfo | URL, options: RequestInit = {}) =>
        this.supabaseFetch(url, options, authGeneration),
      authGeneration,
    );
  }
}
