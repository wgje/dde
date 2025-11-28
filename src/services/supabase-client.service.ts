import { Injectable, signal } from '@angular/core';
import { createClient, type AuthResponse, type Session, type SupabaseClient } from '@supabase/supabase-js';
import { environment } from '../environments/environment'; // 引入环境文件

@Injectable({
  providedIn: 'root'
})
export class SupabaseClientService {
  private supabase: SupabaseClient | null = null;
  
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
        console.error('🚨 [CRITICAL]', errorMsg);
        this.configurationError.set(errorMsg);
      } else {
        // 开发环境：警告并进入离线模式
        console.warn('⚠️', errorMsg, '应用将以离线模式运行。');
        this.isOfflineMode.set(true);
      }
      return;
    }

    try {
      this.supabase = createClient(supabaseUrl, supabaseAnonKey);
    } catch (e) {
      console.error('Failed to initialize Supabase client:', e);
      this.configurationError.set('Supabase 客户端初始化失败');
      this.supabase = null;
    }
  }

  get isConfigured() {
    return this.supabase !== null;
  }

  client(): SupabaseClient {
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
