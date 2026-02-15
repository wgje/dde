import { Injectable, inject, signal } from '@angular/core';
import type { AuthResponse, Session, SupabaseClient } from '@supabase/supabase-js';
import { LoggerService } from './logger.service';
import { environment } from '../environments/environment';
import type { Database } from '../types/supabase';
import { FEATURE_FLAGS } from '../config/feature-flags.config';

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
    this.supabase = null;
    this.initPromise = null;
  }

  async getSession(): Promise<{ data: { session: Session | null }; error: null | { message: string; status?: number; name?: string } }> {
    const client = await this.clientAsync();
    if (!client) {
      return { data: { session: null }, error: null };
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
        fetch: (url: RequestInfo | URL, options: RequestInit = {}) => {
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
