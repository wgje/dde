/**
 * UserPreferencesSyncService - 用户偏好同步服务
 * 
 * 职责：
 * - 加载用户偏好 (loadUserPreferences)
 * - 保存用户偏好 (saveUserPreferences)
 * 
 * 从 SimpleSyncService 提取，Sprint 9 技术债务修复
 */

import { Injectable, inject } from '@angular/core';
import { SupabaseClientService } from '../../../../services/supabase-client.service';
import { LoggerService } from '../../../../services/logger.service';
import { UserPreferences, ThemeType } from '../../../../models';
import { nowISO } from '../../../../utils/date';
import { supabaseErrorToError } from '../../../../utils/supabase-error';
import type { SupabaseClient } from '@supabase/supabase-js';

@Injectable({
  providedIn: 'root'
})
export class UserPreferencesSyncService {
  private readonly supabase = inject(SupabaseClientService);
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('UserPrefsSync');
  
  /**
   * 获取 Supabase 客户端
   */
  private getSupabaseClient(): SupabaseClient | null {
    if (!this.supabase.isConfigured) return null;
    try {
      return this.supabase.client();
    } catch {
      return null;
    }
  }
  
  /**
   * 加载用户偏好
   * 
   * 【流量优化】只查询必要字段
   */
  async loadUserPreferences(userId: string): Promise<UserPreferences | null> {
    const client = this.getSupabaseClient();
    if (!client) return null;
    
    try {
      const { data, error } = await client
        .from('user_preferences')
        .select('theme,layout_direction,floating_window_pref')
        .eq('user_id', userId)
        .single();
      
      if (error) {
        if (error.code === 'PGRST116') {
          // 没有找到记录，返回 null
          return null;
        }
        throw error;
      }
      
      return {
        theme: (data.theme as ThemeType) || 'default',
        layoutDirection: (data.layout_direction as 'ltr' | 'rtl') || 'ltr',
        floatingWindowPref: (data.floating_window_pref as 'auto' | 'fixed') || 'auto'
      };
    } catch (e) {
      this.logger.error('加载用户偏好失败', e);
      return null;
    }
  }
  
  /**
   * 保存用户偏好
   */
  async saveUserPreferences(userId: string, preferences: Partial<UserPreferences>): Promise<boolean> {
    const client = this.getSupabaseClient();
    if (!client) return false;
    
    try {
      const { error } = await client
        .from('user_preferences')
        .upsert({
          user_id: userId,
          theme: preferences.theme,
          layout_direction: preferences.layoutDirection,
          floating_window_pref: preferences.floatingWindowPref,
          updated_at: nowISO()
        });
      
      if (error) throw supabaseErrorToError(error);
      return true;
    } catch (e) {
      this.logger.error('保存用户偏好失败', e);
      return false;
    }
  }
}
