import { Injectable, signal, inject, effect, computed, PLATFORM_ID, DestroyRef } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { Meta } from '@angular/platform-browser';
import { ThemeType, ColorMode, UserPreferences } from '../models';
import { CACHE_CONFIG } from '../config';
import { UserPreferencesSyncService } from '../core-bridge';
import { AuthService } from './auth.service';
import { ToastService } from './toast.service';
import { LoggerService } from './logger.service';
import { ActionQueueService } from './action-queue.service';
import { PendingPreferenceOutboxService } from './pending-preference-outbox.service';
import { createSyncOperationId } from '../utils/sync-operation-id';

/** 本地颜色模式覆盖的存储键 */
const LOCAL_COLOR_MODE_KEY = 'nanoflow.colorMode.local';

/**
 * 主题服务
 * 从 StoreService 拆分出来，专门管理主题相关逻辑
 * 职责：
 * - 主题状态管理（色调 + 明暗）
 * - 主题持久化（本地 + 云端）
 * - DOM 主题应用
 * - 系统偏好监听
 * - PWA theme-color 动态更新
 */
@Injectable({
  providedIn: 'root'
})
export class ThemeService {
  private userPrefsSync = inject(UserPreferencesSyncService);
  private actionQueue = inject(ActionQueueService);
  private authService = inject(AuthService);
  private toast = inject(ToastService);
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('Theme');
  private readonly pendingPreferenceOutbox = inject(PendingPreferenceOutboxService);
  private meta = inject(Meta);
  private platformId = inject(PLATFORM_ID);
  private readonly destroyRef = inject(DestroyRef);
  
  /** 当前色调主题 */
  readonly theme = signal<ThemeType>('default');
  
  /** 当前颜色模式（用户选择，可能是 'system'） */
  readonly colorMode = signal<ColorMode>('system');
  
  /** 系统偏好的颜色模式 */
  readonly systemColorMode = signal<'light' | 'dark'>('light');
  
  /** 实际生效的颜色模式（解析 system 后的结果） */
  readonly effectiveColorMode = computed<'light' | 'dark'>(() => {
    const mode = this.colorMode();
    if (mode === 'system') {
      return this.systemColorMode();
    }
    return mode;
  });
  
  /** 是否为深色模式（便捷 getter） */
  readonly isDark = computed(() => this.effectiveColorMode() === 'dark');
  
  /** 主题保存状态 */
  readonly isSaving = signal(false);
  
  /** 系统偏好媒体查询 */
  private systemPreferenceQuery: MediaQueryList | null = null;
  private systemPreferenceHandler: ((event: MediaQueryListEvent) => void) | null = null;
  
  constructor() {
    if (isPlatformBrowser(this.platformId)) {
      this.initializeFromDOM();
      this.setupSystemPreferenceListener();
      this.setupEffects();
    }
    this.destroyRef.onDestroy(() => {
      if (this.systemPreferenceQuery && this.systemPreferenceHandler) {
        this.systemPreferenceQuery.removeEventListener('change', this.systemPreferenceHandler);
        this.systemPreferenceQuery = null;
        this.systemPreferenceHandler = null;
      }
    });
  }
  
  // ========== 公共方法 ==========
  
  /**
   * 设置色调主题
   */
  async setTheme(theme: ThemeType): Promise<boolean> {
    const previousTheme = this.theme();
    this.theme.set(theme);
    this.applyThemeToDOM(theme);
    try {
      localStorage.setItem(CACHE_CONFIG.THEME_CACHE_KEY, theme);
    } catch (error) {
      this.theme.set(previousTheme);
      this.applyThemeToDOM(previousTheme);
      this.logger.warn('主题本地缓存写入失败，已回滚本地主题状态', { theme, error });
      return false;
    }
    
    // 更新 PWA theme-color（读取主题实际背景色）
    this.updateThemeColorMeta();
    
    return await this.enqueuePreferenceSync();
  }
  
  /**
   * 设置颜色模式
   */
  async setColorMode(mode: ColorMode): Promise<boolean> {
    const previousMode = this.colorMode();
    const previousDomMode = typeof document !== 'undefined'
      ? document.documentElement.getAttribute('data-color-mode')
      : null;
    this.colorMode.set(mode);
    
    // 保存到本地（设备级覆盖）
    try {
      localStorage.setItem(LOCAL_COLOR_MODE_KEY, JSON.stringify(mode));
    } catch (error) {
      this.colorMode.set(previousMode);
      this.restoreColorModeDOM(previousDomMode);
      this.logger.warn('颜色模式本地缓存写入失败，已回滚本地颜色模式状态', { mode, error });
      return false;
    }
    
    // 应用到 DOM
    this.applyColorModeToDOM(this.effectiveColorMode());
    
    // 更新 PWA theme-color
    this.updateThemeColorMeta();
    
    return await this.enqueuePreferenceSync();
  }
  
  /**
   * 从云端加载主题偏好
   */
  async loadUserTheme() {
    const userId = this.authService.currentUserId();
    if (!userId) return;

    const recoveredPreferences = await this.flushPendingPreferenceSync(userId);
    
    const prefs = await this.userPrefsSync.loadUserPreferences(userId);
    const theme = recoveredPreferences?.theme ?? prefs?.theme;
    if (theme) {
      this.theme.set(theme);
      this.applyThemeToDOM(theme);
      localStorage.setItem(CACHE_CONFIG.THEME_CACHE_KEY, theme);
    }
    
    // 如果没有本地覆盖，使用云端的 colorMode 作为默认值
    const localOverride = localStorage.getItem(LOCAL_COLOR_MODE_KEY);
    const colorMode = recoveredPreferences?.colorMode ?? (!localOverride ? prefs?.colorMode : undefined);
    if (colorMode) {
      this.colorMode.set(colorMode);
      this.applyColorModeToDOM(this.effectiveColorMode());
      this.updateThemeColorMeta();
    }
  }
  
  /**
   * 应用色调主题到 DOM
   */
  applyThemeToDOM(theme: string) {
    if (typeof document === 'undefined') return;
    
    if (theme === 'default') {
      document.documentElement.removeAttribute('data-theme');
    } else {
      document.documentElement.setAttribute('data-theme', theme);
    }
  }
  
  /**
   * 应用颜色模式到 DOM
   */
  applyColorModeToDOM(mode: 'light' | 'dark') {
    if (typeof document === 'undefined') return;
    document.documentElement.setAttribute('data-color-mode', mode);
  }

  private restoreColorModeDOM(previousMode: string | null): void {
    if (typeof document === 'undefined') return;
    if (previousMode === 'light' || previousMode === 'dark') {
      document.documentElement.setAttribute('data-color-mode', previousMode);
      return;
    }
    document.documentElement.removeAttribute('data-color-mode');
  }
  
  // ========== 私有方法 ==========
  
  /**
   * 从 DOM 初始化状态（读取防闪屏脚本设置的值）
   */
  private initializeFromDOM() {
    // 读取防闪屏脚本设置的初始值
    const initialMode = (window as unknown as { __NANOFLOW_INITIAL_COLOR_MODE__?: string }).__NANOFLOW_INITIAL_COLOR_MODE__;
    const systemMode = (window as unknown as { __NANOFLOW_SYSTEM_COLOR_MODE__?: string }).__NANOFLOW_SYSTEM_COLOR_MODE__;
    
    if (systemMode === 'dark' || systemMode === 'light') {
      this.systemColorMode.set(systemMode);
    }
    
    // 读取本地存储的用户选择
    const localPref = localStorage.getItem(LOCAL_COLOR_MODE_KEY);
    if (localPref) {
      try {
        const parsed = JSON.parse(localPref) as ColorMode;
        if (parsed === 'light' || parsed === 'dark' || parsed === 'system') {
          this.colorMode.set(parsed);
        }
      } catch (e) { this.logger.debug('解析本地主题设置失败', { error: e }); }
    } else if (initialMode === 'dark' || initialMode === 'light') {
      // 如果没有明确选择，保持 'system'
      // 但确保 DOM 状态一致
    }
    
    // 加载色调主题
    this.loadLocalTheme();
  }
  
  /**
   * 设置系统偏好监听
   */
  private setupSystemPreferenceListener() {
    if (typeof window === 'undefined') return;
    
    this.systemPreferenceQuery = window.matchMedia('(prefers-color-scheme: dark)');
    
    this.systemPreferenceHandler = (e: MediaQueryListEvent) => {
      this.systemColorMode.set(e.matches ? 'dark' : 'light');
      
      // 如果用户选择了 'system'，需要更新 DOM
      if (this.colorMode() === 'system') {
        this.applyColorModeToDOM(this.effectiveColorMode());
        this.updateThemeColorMeta();
      }
    };
    
    // 使用 addEventListener（现代浏览器）
    this.systemPreferenceQuery.addEventListener('change', this.systemPreferenceHandler);
  }
  
  /**
   * 设置响应式效果
   */
  private setupEffects() {
    // 当 effectiveColorMode 变化时触发外部通知（用于 GoJS 等）
    effect(() => {
      const _mode = this.effectiveColorMode();
      // 这个 effect 主要用于触发依赖 isDark 的组件重新渲染
      // GoJS 服务会监听 isDark signal 来重绘图表
    });
  }
  
  /**
   * 更新 PWA theme-color meta 标签
   * 优先读取当前主题的 CSS 变量 --theme-bg，回退到硬编码默认值
   */
  private updateThemeColorMeta() {
    let color: string;
    if (typeof document !== 'undefined') {
      const bg = getComputedStyle(document.documentElement).getPropertyValue('--theme-bg').trim();
      color = bg || (this.effectiveColorMode() === 'dark' ? '#1a1a1a' : '#F9F8F6');
    } else {
      color = this.effectiveColorMode() === 'dark' ? '#1a1a1a' : '#F9F8F6';
    }
    
    // 更新 meta 标签
    this.meta.updateTag({ name: 'theme-color', content: color });
  }
  
  private async enqueuePreferenceSync(): Promise<boolean> {
    const userId = this.authService.currentUserId();
    if (!userId) return true;

    const currentPreferences: Partial<UserPreferences> = {
      theme: this.theme(),
      colorMode: this.colorMode(),
    };
    const operationId = createSyncOperationId();
    const pending = await this.readPendingPreferenceForMerge(userId);
    const preferences = pending
      ? { ...pending.preferences, ...currentPreferences }
      : currentPreferences;

    this.isSaving.set(true);
    try {
      const actionId = await this.actionQueue.enqueueDurablyForOwner(userId, {
        operationId,
        type: 'update',
        entityType: 'preference',
        entityId: userId,
        payload: {
          userId,
          sourceUserId: userId,
          preferences,
        },
      });
      if (!actionId) {
        return await this.savePendingPreferenceSync(userId, preferences, operationId);
      }
      if (pending) {
        await this.removeMergedPendingPreference(userId, preferences, operationId);
      }
      return true;
    } catch {
      return await this.savePendingPreferenceSync(userId, preferences, operationId);
    } finally {
      this.isSaving.set(false);
    }
  }

  private async readPendingPreferenceForMerge(userId: string) {
    try {
      return await this.pendingPreferenceOutbox.readPendingPreference(userId);
    } catch (error) {
      this.logger.warn('主题 pending 偏好读取失败，本次仅写入当前主题变更', { userId, error });
      // eslint-disable-next-line no-restricted-syntax -- pending 读取失败时跳过合并，当前主题变更仍会写入 ActionQueue
      return null;
    }
  }

  private async removeMergedPendingPreference(
    userId: string,
    preferences: Partial<UserPreferences>,
    operationId: string,
  ): Promise<void> {
    try {
      await this.pendingPreferenceOutbox.removePendingPreference(userId);
    } catch (error) {
      this.logger.warn('主题 pending 偏好已并入 ActionQueue，但清理恢复记录失败，将保留幂等副本', { userId, error });
      await this.pendingPreferenceOutbox.savePendingPreference({
        userId,
        preferences,
        operationId,
      });
    }
  }

  private async savePendingPreferenceSync(
    userId: string,
    preferences: Partial<UserPreferences>,
    operationId: string,
  ): Promise<boolean> {
    try {
      await this.pendingPreferenceOutbox.savePendingPreference({
        userId,
        preferences,
        operationId,
      });
      this.toast.warning('主题保存失败', '已保留本地变更，将在恢复后自动同步');
      return true;
    } catch (error) {
      this.logger.error('主题偏好 pending Outbox 写入失败', { userId, error });
      this.toast.warning('主题保存失败', '本地同步队列不可用，请稍后重试');
      return false;
    }
  }

  private async flushPendingPreferenceSync(userId: string): Promise<{
    theme?: ThemeType;
    colorMode?: ColorMode;
  } | null> {
    const pending = await this.pendingPreferenceOutbox.readPendingPreference(userId);
    if (!pending) {
      return null;
    }

    try {
      const actionId = await this.actionQueue.enqueueDurablyForOwner(userId, {
        operationId: pending.operationId,
        type: 'update',
        entityType: 'preference',
        entityId: userId,
        payload: {
          userId,
          sourceUserId: userId,
          preferences: pending.preferences,
        },
      });

      if (actionId) {
        await this.pendingPreferenceOutbox.removePendingPreference(userId);
      }
    } catch (error) {
      this.logger.warn('主题 pending 偏好恢复入队失败，保留本地恢复记录', { userId, error });
    }

    return {
      theme: pending.preferences.theme,
      colorMode: pending.preferences.colorMode,
    };
  }
  
  /**
   * 从本地存储加载色调主题
   */
  private loadLocalTheme() {
    if (typeof localStorage === 'undefined') return;
    
    const savedTheme = localStorage.getItem(CACHE_CONFIG.THEME_CACHE_KEY) as ThemeType | null;
    if (savedTheme) {
      this.theme.set(savedTheme);
      this.applyThemeToDOM(savedTheme);
    }
  }
}
