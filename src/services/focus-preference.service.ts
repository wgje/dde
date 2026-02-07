/**
 * 专注模式偏好服务
 *
 * 管理专注模式的用户偏好设置
 * 与现有 PreferenceService 集成，支持跨设备同步
 *
 * 【存储策略】
 * - 本地存储：localStorage（即时加载，离线可用）
 * - 云端同步：通过 PreferenceService.saveUserPreferences（跨设备同步）
 */

import { Injectable, inject } from '@angular/core';
import { FocusPreferences, DEFAULT_FOCUS_PREFERENCES } from '../models/focus';
import { PreferenceService } from './preference.service';
import { AuthService } from './auth.service';
import { LoggerService } from './logger.service';
import { focusPreferences } from '../state/focus-stores';

/** LocalStorage 键：专注模式偏好 */
const FOCUS_PREFERENCES_KEY = 'focus_preferences';

@Injectable({
  providedIn: 'root'
})
export class FocusPreferenceService {
  private preferenceService = inject(PreferenceService);
  private authService = inject(AuthService);
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
   * 保存偏好设置（本地 + 云端）
   */
  private savePreferences(prefs: FocusPreferences): void {
    // 1. 立即保存到本地（同步、即时响应）
    try {
      localStorage.setItem(FOCUS_PREFERENCES_KEY, JSON.stringify(prefs));
      focusPreferences.set(prefs);
      this.logger.debug('FocusPreferences', 'saved locally', prefs);
    } catch (e) {
      this.logger.error('FocusPreferences', 'Failed to save locally', e instanceof Error ? e.message : String(e));
    }

    // 2. 同步到云端（异步、不阻塞 UI）
    this.syncToCloud(prefs);
  }

  /**
   * 同步偏好到云端
   */
  private async syncToCloud(prefs: FocusPreferences): Promise<void> {
    try {
      const userId = this.authService.currentUserId?.();
      if (!userId) {
        this.logger.debug('FocusPreferences', 'No user logged in, skip cloud sync');
        return;
      }

      await this.preferenceService.saveUserPreferences(userId, {
        focusPreferences: prefs
      });
      this.logger.debug('FocusPreferences', 'synced to cloud');
    } catch (e) {
      // 云端同步失败时不影响本地使用（离线优先）
      this.logger.warn('FocusPreferences', 'Cloud sync failed (non-blocking)',
        e instanceof Error ? e.message : String(e));
    }
  }

  /**
   * 应用从云端接收到的偏好（由偏好同步回调触发）
   */
  applyCloudPreferences(cloudPrefs: Partial<FocusPreferences>): void {
    const current = focusPreferences();
    const merged = { ...current, ...cloudPrefs };

    // 更新本地存储和信号（不再触发云端同步，避免循环）
    try {
      localStorage.setItem(FOCUS_PREFERENCES_KEY, JSON.stringify(merged));
    } catch (e) {
      // 静默处理
    }
    focusPreferences.set(merged);
    this.logger.debug('FocusPreferences', 'applied cloud preferences', merged);
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
