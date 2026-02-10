import { Injectable, inject, signal } from '@angular/core';
import { createClient, type AuthResponse, type Session, type SupabaseClient } from '@supabase/supabase-js';
import { LoggerService } from './logger.service';
import { environment } from '../environments/environment'; // 引入环境文件
import type { Database } from '../types/supabase';

/**
 * 敏感密钥检测模式
 * 用于防止 SERVICE_ROLE_KEY 意外泄露到前端
 */
const SENSITIVE_KEY_PATTERNS = [
  'service_role',
  'secret',
  'private',
  'admin'
];

@Injectable({
  providedIn: 'root'
})
export class SupabaseClientService {
  private readonly logger = inject(LoggerService).category('SupabaseClient');
  private supabase: SupabaseClient<Database> | null = null;
  
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
      return;
    }
    
    // 🔒 安全检查：确保不会意外使用 SERVICE_ROLE_KEY
    if (this.isSensitiveKey(supabaseAnonKey)) {
      const securityError = '[SECURITY] 检测到敏感密钥！前端不应使用 SERVICE_ROLE_KEY，请使用 ANON_KEY。';
      this.logger.error(securityError);
      this.configurationError.set('安全配置错误：请使用公开的 ANON_KEY 而非 SERVICE_ROLE_KEY');
      // 阻止创建客户端，强制进入离线模式
      this.isOfflineMode.set(true);
      return;
    }

    try {
      this.supabase = createClient<Database>(supabaseUrl, supabaseAnonKey, {
        auth: {
          // 使用 localStorage 存储 session（更稳定，减少锁竞争）
          storage: typeof window !== 'undefined' ? window.localStorage : undefined,
          // Navigator Lock: 在支持的浏览器中使用原生锁，防止多标签页 token 刷新竞争
          // 不支持的浏览器优雅降级为直接执行
          storageKey: `sb-${new URL(supabaseUrl).hostname.split('.')[0]}-auth-token`,
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
          // 自动刷新 token
          autoRefreshToken: true,
          // 持久化 session
          persistSession: true,
          // 检测会话过期
          detectSessionInUrl: true,
          // 流式会话（减少并发问题）
          flowType: 'pkce'
        },
        global: {
          // 添加全局请求配置，设置超时和更好的错误处理
          // ⚠️ 重要：此超时必须大于 RequestThrottleService 的最大超时 + 实际请求执行缓冲
          // 否则请求在队列中等待时 AbortController 会提前触发，导致 "signal is aborted without reason" 错误
          // 参考：REQUEST_THROTTLE_CONFIG.BATCH_SYNC_TIMEOUT = 90000ms
          // 当前配置：120s = 90s队列等待 + 30s执行缓冲
          // 【P2-09 修复】保留调用方的 signal，仅当未提供时添加超时控制
          fetch: (url, options = {}) => {
            // 如果调用方已提供 signal，合并超时信号
            const callerSignal = options.signal;
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 120000);
            
            // 使用 AbortSignal.any 合并（如果可用），否则优先使用调用方 signal
            let mergedSignal: AbortSignal;
            if (callerSignal && typeof AbortSignal !== 'undefined' && 'any' in AbortSignal) {
              mergedSignal = (AbortSignal as unknown as { any: (signals: AbortSignal[]) => AbortSignal }).any([callerSignal, controller.signal]);
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
          schema: 'public',
        },
        // Realtime 配置优化
        realtime: {
          params: {
            eventsPerSecond: 10, // 限制事件频率，避免过载
          },
          // 心跳和超时配置
          heartbeatIntervalMs: 30000, // 30秒心跳
          timeout: 10000, // 10秒连接超时
        },
      });
    } catch (e) {
      this.logger.error('Supabase 客户端初始化失败', e);
      this.configurationError.set('Supabase 客户端初始化失败');
      this.supabase = null;
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
          // 检测到非匿名角色密钥，直接返回 true 阻止使用
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

  get isConfigured() {
    return this.supabase !== null;
  }

  client(): SupabaseClient<Database> {
    if (!this.supabase) {
      throw new Error('Supabase 未配置，请提供 NG_APP_SUPABASE_URL 与 NG_APP_SUPABASE_ANON_KEY');
    }
    return this.supabase;
  }

  reset() {
    this.supabase = null;
  }

  async getSession() {
    if (!this.supabase) {
      return { data: { session: null as Session | null }, error: null };
    }
    return this.supabase.auth.getSession();
  }

  async signInWithPassword(email: string, password: string): Promise<AuthResponse> {
    if (!this.supabase) {
      throw new Error('Supabase 未配置，无法登录');
    }
    return this.supabase.auth.signInWithPassword({ email, password });
  }

  async signOut() {
    if (!this.supabase) return;
    await this.supabase.auth.signOut();
  }
}
