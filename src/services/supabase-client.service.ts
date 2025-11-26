import { Injectable } from '@angular/core';
import { createClient, type AuthResponse, type Session, type SupabaseClient } from '@supabase/supabase-js';
import { environment } from '../environments/environment'; // 引入环境文件

@Injectable({
  providedIn: 'root'
})
export class SupabaseClientService {
  private supabase: SupabaseClient | null = null;

  constructor() {
    const supabaseUrl = environment.supabaseUrl;
    const supabaseAnonKey = environment.supabaseAnonKey;

    if (!supabaseUrl || !supabaseAnonKey) {
      console.warn('Supabase keys missing. Check src/environments/environment.ts. App will run in offline mode.');
      // 不创建客户端，使用 null
      return;
    }

    try {
      this.supabase = createClient(supabaseUrl, supabaseAnonKey);
    } catch (e) {
      console.error('Failed to initialize Supabase client:', e);
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
