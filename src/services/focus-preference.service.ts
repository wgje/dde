/**
 * 专注模式偏好服务
 * 
 * 管理专注模式的用户偏好设置
 * 与现有 PreferenceService 集成
 */

import { Injectable, inject } from '@angular/core';
import { FocusPreferences, DEFAULT_FOCUS_PREFERENCES } from '../models/focus';
import { PreferenceService } from './preference.service';
import { LoggerService } from './logger.service';
import { focusPreferences } from '../app/core/state/focus-stores';

/** LocalStorage 键：专注模式偏好 */
const FOCUS_PREFERENCES_KEY = 'focus_preferences';

@Injectable({
  providedIn: 'root'
})
export class FocusPreferenceService {
  private preferenceService = inject(PreferenceService);
  private logger = inject(LoggerService);
  
  // 暴露状态给组件
  readonly preferences = focusPreferences;
  
  constructor() {
    // 从本地存储加载偏好
    this.loadPreferences();
  }
  
  /**
   * 加载偏好设置
   */
  private loadPreferences(): void {
    try {
      const stored = localStorage.getItem(FOCUS_PREFERENCES_KEY);
      if (stored) {
        const parsed = JSON.parse(stored) as Partial<FocusPreferences>;
        const merged = { ...DEFAULT_FOCUS_PREFERENCES, ...parsed };
        focusPreferences.set(merged);
        this.logger.debug('FocusPreferences', 'loaded', merged);
      }
    } catch (e) {
      this.logger.error('FocusPreferences', 'Failed to load', e instanceof Error ? e.message : String(e));
    }
  }
  
  /**
   * 保存偏好设置
   */
  private savePreferences(prefs: FocusPreferences): void {
    try {
      localStorage.setItem(FOCUS_PREFERENCES_KEY, JSON.stringify(prefs));
      focusPreferences.set(prefs);
      this.logger.debug('FocusPreferences', 'saved', prefs);
    } catch (e) {
      this.logger.error('FocusPreferences', 'Failed to save', e instanceof Error ? e.message : String(e));
    }
  }
  
  /**
   * 更新偏好设置
   */
  update(updates: Partial<FocusPreferences>): void {
    const current = focusPreferences();
    const updated = { ...current, ...updates };
    this.savePreferences(updated);
  }
  
  /**
   * 启用/禁用大门
   */
  setGateEnabled(enabled: boolean): void {
    this.update({ gateEnabled: enabled });
  }
  
  /**
   * 启用/禁用聚光灯模式
   */
  setSpotlightEnabled(enabled: boolean): void {
    this.update({ spotlightEnabled: enabled });
  }
  
  /**
   * 启用/禁用黑匣子
   */
  setBlackBoxEnabled(enabled: boolean): void {
    this.update({ blackBoxEnabled: enabled });
  }
  
  /**
   * 设置每日最大跳过次数
   */
  setMaxSnoozePerDay(count: number): void {
    const max = Math.max(0, Math.min(10, count));
    this.update({ maxSnoozePerDay: max });
  }
  
  /**
   * 重置为默认偏好
   */
  reset(): void {
    this.savePreferences(DEFAULT_FOCUS_PREFERENCES);
    this.logger.info('FocusPreferences', 'reset to defaults');
  }
  
  /**
   * 获取当前偏好
   */
  getPreferences(): FocusPreferences {
    return focusPreferences();
  }
  
  /**
   * 检查大门是否启用
   */
  isGateEnabled(): boolean {
    return focusPreferences().gateEnabled;
  }
  
  /**
   * 检查聚光灯是否启用
   */
  isSpotlightEnabled(): boolean {
    return focusPreferences().spotlightEnabled;
  }
  
  /**
   * 检查黑匣子是否启用
   */
  isBlackBoxEnabled(): boolean {
    return focusPreferences().blackBoxEnabled;
  }
}
