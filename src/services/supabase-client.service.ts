import { Injectable, inject, signal } from '@angular/core';
import type { AuthResponse, Session, SupabaseClient } from '@supabase/supabase-js';
import { LoggerService } from './logger.service';
import { environment } from '../environments/environment';
import type { Database } from '../types/supabase';
import { FEATURE_FLAGS } from '../config/feature-flags.config';
import {
  createBrowserNetworkSuspendedError,
  ensureBrowserNetworkSuspensionTracking,
  getRemainingBrowserNetworkResumeDelayMs,
  isBrowserNetworkSuspendedError,
  isBrowserNetworkSuspendedWindow,
} from '../utils/browser-network-suspension';

export interface SupabaseConnectivityChange {
  offline: boolean;
  source: 'probe' | 'request' | 'manual';
}

type SupabaseConnectivityListener = (change: SupabaseConnectivityChange) => void;

/**
 * 敏感密钥检测模式
 * 用于防止 SERVICE_ROLE_KEY 意外泄露到前端
 */
const SENSITIVE_KEY_PATTERNS = ['service_role', 'secret', 'private', 'admin'];

@Injectable({
  providedIn: 'root'
})
export class SupabaseClientService {
  private readonly logger = inject(LoggerService).category('SupabaseClient');
  private supabase: SupabaseClient<Database> | null = null;
  private initPromise: Promise<SupabaseClient<Database> | null> | null = null;
  private reachabilityProbePromise: Promise<boolean> | null = null;
  private readonly connectivityListeners = new Set<SupabaseConnectivityListener>();
  private lastReachabilityProbeAt = 0;
  private lastReachabilityProbeResult = true;
  private authAutoRefreshTakenOver = false;
  private authAutoRefreshRunning = false;
  private authAutoRefreshResumeTimer: ReturnType<typeof setTimeout> | null = null;
  private authAutoRefreshSyncChain: Promise<void> = Promise.resolve();
  private authAutoRefreshLifecycleBound = false;
  private authVisibilityChangeHandler: (() => void) | null = null;
  private authPageShowHandler: ((event: PageTransitionEvent) => void) | null = null;
  private authOnlineHandler: (() => void) | null = null;
  private authOfflineHandler: (() => void) | null = null;

  private readonly canInitialize: boolean;
  private readonly supabaseUrl: string;
  private readonly supabaseAnonKey: string;

  // 配置状态信号，UI 可以响应式订阅
  readonly configurationError = signal<string | null>(null);
  readonly isOfflineMode = signal(false);

  constructor() {
    const supabaseUrl = environment.supabaseUrl;
    const supabaseAnonKey = environment.supabaseAnonKey;

    // 检查是否为模板占位符
    const isPlaceholder = (val: string) =>
      !val || val === 'YOUR_SUPABASE_URL' || val === 'YOUR_SUPABASE_ANON_KEY';

    if (isPlaceholder(supabaseUrl) || isPlaceholder(supabaseAnonKey)) {
      const errorMsg = 'Supabase 环境变量未配置。请运行 npm run config 或手动配置 .env.local 文件。';

      if (environment.production) {
        // 生产环境：记录严重错误
        this.logger.error('[CRITICAL] 环境变量未配置', errorMsg);
        this.configurationError.set(errorMsg);
      } else {
        // 开发环境：信息提示并进入离线模式（这是预期行为，不是警告）
        this.logger.info('开发环境离线模式已启用', errorMsg);
        this.isOfflineMode.set(true);
      }
      this.canInitialize = false;
      this.supabaseUrl = '';
      this.supabaseAnonKey = '';
      return;
    }

    // 🔒 安全检查：确保不会意外使用 SERVICE_ROLE_KEY
    if (this.isSensitiveKey(supabaseAnonKey)) {
      const securityError = '[SECURITY] 检测到敏感密钥！前端不应使用 SERVICE_ROLE_KEY，请使用 ANON_KEY。';
      this.logger.error(securityError);
      this.configurationError.set('安全配置错误：请使用公开的 ANON_KEY 而非 SERVICE_ROLE_KEY');
      this.isOfflineMode.set(true);
      this.canInitialize = false;
      this.supabaseUrl = '';
      this.supabaseAnonKey = '';
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

  /**
   * 检测是否为敏感密钥
   * 通过 JWT payload 分析或密钥命名模式检测
   */
  private isSensitiveKey(key: string): boolean {
    if (!key) return false;

    try {
      // JWT 格式：header.payload.signature
      const parts = key.split('.');
      if (parts.length === 3) {
        // 解码 payload（不需要验证签名，只检查内容）
        const payload = JSON.parse(atob(parts[1]));

        // 检查 role 字段
        if (payload.role && payload.role !== 'anon') {
          this.logger.error('检测到非匿名角色密钥，已阻止使用', { role: payload.role });
          return true;
        }
      }
    } catch (_e) {
      // 解析失败，不是有效的 JWT，检查字符串模式
    }

    // 字符串模式检测（备用）
    const lowerKey = key.toLowerCase();
    return SENSITIVE_KEY_PATTERNS.some(pattern => lowerKey.includes(pattern));
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
    try {
      return `sb-${new URL(this.supabaseUrl).hostname.split('.')[0]}-auth-token`;
    } catch {
      return null;
    }
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
      this.setOfflineModeState(true, 'probe');
      this.lastReachabilityProbeResult = false;
      this.lastReachabilityProbeAt = Date.now();
      return false;
    }

    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      this.setOfflineModeState(true, 'probe');
      this.lastReachabilityProbeResult = false;
      this.lastReachabilityProbeAt = Date.now();
      return false;
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
      this.setOfflineModeState(false, 'probe');
      this.lastReachabilityProbeResult = true;
      this.lastReachabilityProbeAt = now;
      return true;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    const authProbeUrl = new URL('/auth/v1/health', this.supabaseUrl).toString();

    // 可达性探测：只用 Auth health 端点判断（公开，不需要认证）
    // REST /rest/v1/ 端点可能因 anon key 权限不足返回 401，这不代表服务不可达
    this.reachabilityProbePromise = fetch(authProbeUrl, {
        method: 'GET',
        cache: 'no-store',
        credentials: 'omit',
        redirect: 'follow',
        signal: controller.signal,
        headers: {
          apikey: this.supabaseAnonKey,
        },
      })
      .then((authResponse) => {
        // 收到 HTTP 响应即表示网络可达
        // 仅 502-504 网关错误可能表示 Supabase 后端不可用
        const isGatewayError = authResponse.status >= 502 && authResponse.status <= 504;
        const reachable = !isGatewayError;
        this.setOfflineModeState(!reachable, 'probe');
        this.lastReachabilityProbeResult = reachable;
        this.lastReachabilityProbeAt = Date.now();

        if (!reachable) {
          this.logger.info('Supabase 连通性探测返回网关错误', {
            authStatus: authResponse.status,
          });
        }

        return reachable;
      })
      .catch((error: unknown) => {
        this.setOfflineModeState(true, 'probe');
        this.lastReachabilityProbeResult = false;
        this.lastReachabilityProbeAt = Date.now();
        this.logger.info('Supabase 连通性探测失败，进入连接中断模式', {
          message: error instanceof Error ? error.message : String(error),
        });
        return false;
      })
      .finally(() => {
        clearTimeout(timeoutId);
        this.reachabilityProbePromise = null;
      });

    return this.reachabilityProbePromise;
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
    this.clearAuthAutoRefreshResumeTimer();
    this.teardownAuthAutoRefreshLifecycle();
    this.authAutoRefreshTakenOver = false;
    this.authAutoRefreshRunning = false;
    this.authAutoRefreshSyncChain = Promise.resolve();
    if (client) {
      void client.auth.stopAutoRefresh().catch((error: unknown) => {
        this.logger.debug('重置时停止 Supabase Auth 自动刷新失败', { error });
      });
    }
    this.supabase = null;
    this.initPromise = null;
  }

  private ensureAuthAutoRefreshLifecycle(): void {
    if (this.authAutoRefreshLifecycleBound || typeof window === 'undefined' || typeof document === 'undefined') {
      return;
    }

    ensureBrowserNetworkSuspensionTracking();

    this.authVisibilityChangeHandler = () => {
      void this.syncAuthAutoRefresh('visibilitychange');
    };
    this.authPageShowHandler = () => {
      void this.syncAuthAutoRefresh('pageshow');
    };
    this.authOnlineHandler = () => {
      void this.syncAuthAutoRefresh('online');
    };
    this.authOfflineHandler = () => {
      void this.syncAuthAutoRefresh('offline');
    };

    document.addEventListener('visibilitychange', this.authVisibilityChangeHandler);
    window.addEventListener('pageshow', this.authPageShowHandler as EventListener);
    window.addEventListener('online', this.authOnlineHandler);
    window.addEventListener('offline', this.authOfflineHandler);
    this.authAutoRefreshLifecycleBound = true;
  }

  private teardownAuthAutoRefreshLifecycle(): void {
    if (typeof document !== 'undefined' && this.authVisibilityChangeHandler) {
      document.removeEventListener('visibilitychange', this.authVisibilityChangeHandler);
    }

    if (typeof window !== 'undefined' && this.authPageShowHandler) {
      window.removeEventListener('pageshow', this.authPageShowHandler as EventListener);
    }

    if (typeof window !== 'undefined' && this.authOnlineHandler) {
      window.removeEventListener('online', this.authOnlineHandler);
    }

    if (typeof window !== 'undefined' && this.authOfflineHandler) {
      window.removeEventListener('offline', this.authOfflineHandler);
    }

    this.authVisibilityChangeHandler = null;
    this.authPageShowHandler = null;
    this.authOnlineHandler = null;
    this.authOfflineHandler = null;
    this.authAutoRefreshLifecycleBound = false;
  }

  private clearAuthAutoRefreshResumeTimer(): void {
    if (!this.authAutoRefreshResumeTimer) {
      return;
    }

    clearTimeout(this.authAutoRefreshResumeTimer);
    this.authAutoRefreshResumeTimer = null;
  }

  private shouldPauseAuthAutoRefresh(): boolean {
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') {
      return true;
    }

    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      return true;
    }

    return false;
  }

  private syncAuthAutoRefresh(
    reason: 'client-init' | 'visibilitychange' | 'pageshow' | 'online' | 'offline' | 'resume-timer'
  ): Promise<void> {
    if (!this.supabase) {
      return Promise.resolve();
    }

    this.authAutoRefreshSyncChain = this.authAutoRefreshSyncChain
      .catch(() => undefined)
      .then(async () => {
        const client = this.supabase;
        if (!client) {
          return;
        }

        if (this.shouldPauseAuthAutoRefresh()) {
          this.clearAuthAutoRefreshResumeTimer();
          await this.stopAuthAutoRefresh(client, reason);
          return;
        }

        if (isBrowserNetworkSuspendedWindow()) {
          const delayMs = Math.max(getRemainingBrowserNetworkResumeDelayMs(), 50);
          this.clearAuthAutoRefreshResumeTimer();
          await this.stopAuthAutoRefresh(client, reason);
          this.authAutoRefreshResumeTimer = setTimeout(() => {
            this.authAutoRefreshResumeTimer = null;
            void this.syncAuthAutoRefresh('resume-timer');
          }, delayMs);
          return;
        }

        this.clearAuthAutoRefreshResumeTimer();
        // 【根本修复】页面恢复/网络恢复瞬间主动检查 token 是否已过期 / 即将过期，
        // 是则立即 await refreshSession，确保之后发出的首批业务请求不会带过期 token。
        // 这从源头消除了"恢复后控制台刷 401 → 重试恢复"的可见错误窗口。
        if (reason === 'visibilitychange' || reason === 'pageshow' || reason === 'online' || reason === 'resume-timer') {
          await this.proactivelyRefreshIfNearingExpiry(client, reason);
        }
        await this.startAuthAutoRefresh(client, reason);
      });

    return this.authAutoRefreshSyncChain;
  }

  /**
   * 【根本修复】在页面/网络恢复时，若当前 session 已过期或 60s 内即将过期，
   * 主动 await refreshSession 强制刷新，避免业务请求带过期 token 后再触发 401 自愈。
   * autoRefreshToken 的 setTimeout 在浏览器挂起时会停摆，恢复后来不及触发——这里填补这个空档。
   */
  private async proactivelyRefreshIfNearingExpiry(
    client: SupabaseClient<Database>,
    reason: 'client-init' | 'visibilitychange' | 'pageshow' | 'online' | 'offline' | 'resume-timer'
  ): Promise<void> {
    try {
      const { data, error } = await client.auth.getSession();
      if (error || !data.session) {
        return;
      }
      const expiresAt = data.session.expires_at;
      if (!expiresAt) {
        return;
      }
      const expiresAtMs = expiresAt * 1000;
      const remainingMs = expiresAtMs - Date.now();
      // token 已过期或 60 秒内即将过期 → 主动刷新
      const REFRESH_THRESHOLD_MS = 60_000;
      if (remainingMs > REFRESH_THRESHOLD_MS) {
        return;
      }
      this.logger.info('浏览器恢复时 token 临近/已过期，主动刷新', {
        reason,
        remainingMs,
      });
      const { error: refreshError } = await client.auth.refreshSession();
      if (refreshError) {
        this.logger.warn('恢复时主动刷新 session 失败', { reason, error: refreshError.message });
      } else {
        this.logger.info('恢复时主动刷新 session 成功', { reason });
      }
    } catch (error) {
      // 任何错误都不阻塞后续流程，交给既有的自愈路径处理
      this.logger.debug('恢复时主动校验 session 异常', { reason, error });
    }
  }

  private async stopAuthAutoRefresh(
    client: SupabaseClient<Database>,
    reason: 'client-init' | 'visibilitychange' | 'pageshow' | 'online' | 'offline' | 'resume-timer'
  ): Promise<void> {
    if (this.authAutoRefreshTakenOver && !this.authAutoRefreshRunning) {
      return;
    }

    try {
      await client.auth.stopAutoRefresh();
      this.authAutoRefreshTakenOver = true;
      this.authAutoRefreshRunning = false;
      this.logger.debug('Supabase Auth 自动刷新已暂停', { reason });
    } catch (error) {
      this.logger.warn('暂停 Supabase Auth 自动刷新失败', { reason, error });
    }
  }

  private async startAuthAutoRefresh(
    client: SupabaseClient<Database>,
    reason: 'client-init' | 'visibilitychange' | 'pageshow' | 'online' | 'offline' | 'resume-timer'
  ): Promise<void> {
    if (this.authAutoRefreshTakenOver && this.authAutoRefreshRunning) {
      return;
    }

    try {
      await client.auth.startAutoRefresh();
      this.authAutoRefreshTakenOver = true;
      this.authAutoRefreshRunning = true;
      this.logger.debug('Supabase Auth 自动刷新已启动', { reason });
    } catch (error) {
      this.logger.warn('启动 Supabase Auth 自动刷新失败', { reason, error });
    }
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
    await client.auth.signOut();
  }

  private buildClientOptions() {
    return {
      auth: {
        // 使用 localStorage 存储 session（更稳定，减少锁竞争）
        storage: typeof window !== 'undefined' ? window.localStorage : undefined,
        // Navigator Lock: 在支持的浏览器中使用原生锁，防止多标签页 token 刷新竞争
        // 不支持的浏览器优雅降级为直接执行
        storageKey: `sb-${new URL(this.supabaseUrl).hostname.split('.')[0]}-auth-token`,
        lock: typeof navigator !== 'undefined' && navigator.locks
          ? async <T>(name: string, acquireTimeout: number, fn: () => Promise<T>): Promise<T> => {
              const abortController = new AbortController();
              const timeoutId = acquireTimeout > 0
                ? setTimeout(() => abortController.abort(), acquireTimeout)
                : undefined;
              try {
                return await navigator.locks.request(
                  name,
                  { mode: 'exclusive', signal: abortController.signal },
                  async () => fn()
                );
              } catch (err: unknown) {
                if (err instanceof DOMException && err.name === 'AbortError') {
                  throw new Error(`Lock acquisition timed out after ${acquireTimeout}ms`);
                }
                throw err;
              } finally {
                if (timeoutId !== undefined) clearTimeout(timeoutId);
              }
            }
          : async <T>(_name: string, _acquireTimeout: number, fn: () => Promise<T>): Promise<T> => {
              // Fallback: 不支持 Navigator Lock 的环境直接执行
              return await fn();
            },
        autoRefreshToken: true,
        persistSession: true,
        detectSessionInUrl: true,
        flowType: 'pkce' as const
      },
      global: {
        // 保留请求超时保护，并优先复用调用方 signal
        // 离线时快速失败，避免 120s 超时爆出 AbortError
        fetch: (url: RequestInfo | URL, options: RequestInit = {}) => {
          if (isBrowserNetworkSuspendedWindow()) {
            return Promise.reject(createBrowserNetworkSuspendedError());
          }

          // 离线时直接拒绝，避免等待超时产生 AbortError
          if (typeof navigator !== 'undefined' && !navigator.onLine) {
            return Promise.reject(new DOMException('Device is offline', 'NetworkError'));
          }

          const callerSignal = options.signal;
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 120000);

          let mergedSignal: AbortSignal;
          if (callerSignal && typeof AbortSignal !== 'undefined' && 'any' in AbortSignal) {
            mergedSignal = (AbortSignal as unknown as { any: (signals: AbortSignal[]) => AbortSignal }).any([
              callerSignal,
              controller.signal
            ]);
          } else {
            mergedSignal = callerSignal ?? controller.signal;
          }

          return fetch(url, {
            ...options,
            signal: mergedSignal,
          }).then((response) => {
            // 收到 HTTP 响应表示网络可达，但 502-504 网关错误不清除离线模式
            const isGatewayError = response.status >= 502 && response.status <= 504;
            if (this.isOfflineMode() && !isGatewayError) {
              this.setOfflineModeState(false, 'request');
            }
            return response;
          }).catch((error: unknown) => {
            if (this.shouldMarkOfflineFromFetchFailure(error)) {
              this.setOfflineModeState(true, 'request');
            }
            throw error;
          }).finally(() => clearTimeout(timeoutId));
        },
      },
      db: {
        schema: 'public' as const,
      },
      realtime: {
        params: {
          eventsPerSecond: 10,
        },
        heartbeatIntervalMs: 30000,
        timeout: 10000,
      },
    };
  }
}
