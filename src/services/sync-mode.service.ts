/**
 * SyncModeService - 同步模式服务
 * 
 * 借鉴思源笔记的多模式同步设计，提供灵活的同步控制选项。
 * 
 * 【同步模式】
 * - automatic: 自动模式 - 按间隔自动同步，适合桌面端稳定网络
 * - manual: 手动模式 - 仅在用户手动触发或应用启动/退出时同步，适合移动端
 * - completely-manual: 完全手动模式 - 用户必须明确选择"上传"或"下载"，适合敏感数据场景
 * 
 * 【设计理念】
 * 不同场景需要不同的同步策略：
 * - 桌面端 WiFi 环境：自动同步，最大化便利性
 * - 移动端流量环境：手动同步，节省流量
 * - 敏感数据场景：完全手动，用户完全控制
 */
import { Injectable, inject, signal, computed, DestroyRef } from '@angular/core';
import { LoggerService } from './logger.service';

/**
 * 同步模式枚举
 */
export type SyncMode = 'automatic' | 'manual' | 'completely-manual';

/**
 * 同步方向（完全手动模式下使用）
 */
export type SyncDirection = 'upload' | 'download' | 'both';

/**
 * 同步模式配置
 */
export interface SyncModeConfig {
  /** 当前同步模式 */
  mode: SyncMode;
  /** 自动同步间隔（秒），仅 automatic 模式有效 */
  interval: number;
  /** 是否启用同步感知 */
  perceptionEnabled: boolean;
  /** 启动时是否自动同步 */
  syncOnBoot: boolean;
  /** 退出时是否自动同步 */
  syncOnExit: boolean;
  /** 是否自动生成冲突文档 */
  generateConflictDoc: boolean;
}

/** 默认同步间隔（秒） */
const DEFAULT_SYNC_INTERVAL = 30;

/** 最小同步间隔（秒） */
const MIN_SYNC_INTERVAL = 10;

/** 最大同步间隔（秒）- 12小时 */
const MAX_SYNC_INTERVAL = 43200;

/** 配置存储 key */
const CONFIG_STORAGE_KEY = 'nanoflow.sync-mode-config';

@Injectable({
  providedIn: 'root'
})
export class SyncModeService {
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('SyncMode');
  private readonly destroyRef = inject(DestroyRef);
  
  /** 同步配置 */
  private readonly config = signal<SyncModeConfig>(this.loadConfig());
  
  /** 自动同步定时器 */
  private autoSyncTimer: ReturnType<typeof setInterval> | null = null;
  
  /** 同步回调 */
  private syncCallback: ((direction: SyncDirection) => Promise<void>) | null = null;
  
  // ========== 公开的响应式属性 ==========
  
  /** 当前同步模式 */
  readonly mode = computed(() => this.config().mode);
  
  /** 自动同步间隔 */
  readonly interval = computed(() => this.config().interval);
  
  /** 是否启用感知 */
  readonly perceptionEnabled = computed(() => this.config().perceptionEnabled);
  
  /** 是否为自动模式 */
  readonly isAutomatic = computed(() => this.config().mode === 'automatic');
  
  /** 是否为手动模式 */
  readonly isManual = computed(() => this.config().mode === 'manual');
  
  /** 是否为完全手动模式 */
  readonly isCompletelyManual = computed(() => this.config().mode === 'completely-manual');
  
  /** 完整配置（只读） */
  readonly currentConfig = computed(() => this.config());
  
  constructor() {
    this.destroyRef.onDestroy(() => {
      this.stopAutoSync();
    });
    
    // 如果是自动模式，启动定时器
    if (this.config().mode === 'automatic') {
      this.startAutoSync();
    }
  }
  
  // ========== 公开方法 ==========
  
  /**
   * 设置同步回调
   * 当需要执行同步时，会调用此回调
   */
  setSyncCallback(callback: (direction: SyncDirection) => Promise<void>): void {
    this.syncCallback = callback;
  }
  
  /**
   * 设置同步模式
   */
  setMode(mode: SyncMode): void {
    const current = this.config();
    if (current.mode === mode) return;
    
    this.config.update(c => ({ ...c, mode }));
    this.saveConfig();
    
    // 根据模式调整定时器
    if (mode === 'automatic') {
      this.startAutoSync();
    } else {
      this.stopAutoSync();
    }
    
    this.logger.info('同步模式已更改', { mode });
  }
  
  /**
   * 设置自动同步间隔（秒）
   */
  setInterval(seconds: number): void {
    const interval = Math.max(MIN_SYNC_INTERVAL, Math.min(MAX_SYNC_INTERVAL, seconds));
    
    this.config.update(c => ({ ...c, interval }));
    this.saveConfig();
    
    // 如果是自动模式，重启定时器
    if (this.config().mode === 'automatic') {
      this.startAutoSync();
    }
    
    this.logger.info('同步间隔已更改', { interval });
  }
  
  /**
   * 设置是否启用同步感知
   */
  setPerceptionEnabled(enabled: boolean): void {
    this.config.update(c => ({ ...c, perceptionEnabled: enabled }));
    this.saveConfig();
    this.logger.info('同步感知已更改', { enabled });
  }
  
  /**
   * 设置是否生成冲突文档
   */
  setGenerateConflictDoc(enabled: boolean): void {
    this.config.update(c => ({ ...c, generateConflictDoc: enabled }));
    this.saveConfig();
    this.logger.info('冲突文档生成已更改', { enabled });
  }
  
  /**
   * 更新完整配置
   */
  updateConfig(updates: Partial<SyncModeConfig>): void {
    const oldMode = this.config().mode;
    
    this.config.update(c => ({ ...c, ...updates }));
    this.saveConfig();
    
    // 检查模式变化
    const newMode = this.config().mode;
    if (oldMode !== newMode) {
      if (newMode === 'automatic') {
        this.startAutoSync();
      } else {
        this.stopAutoSync();
      }
    } else if (newMode === 'automatic' && updates.interval !== undefined) {
      // 间隔变化，重启定时器
      this.startAutoSync();
    }
    
    this.logger.info('同步配置已更新', updates);
  }
  
  /**
   * 手动触发同步
   * 所有模式下都可用
   */
  async triggerSync(direction: SyncDirection = 'both'): Promise<void> {
    if (!this.syncCallback) {
      this.logger.warn('未设置同步回调');
      return;
    }
    
    this.logger.info('手动触发同步', { direction, mode: this.config().mode });
    await this.syncCallback(direction);
  }
  
  /**
   * 仅上传（完全手动模式下使用）
   */
  async uploadOnly(): Promise<void> {
    return this.triggerSync('upload');
  }
  
  /**
   * 仅下载（完全手动模式下使用）
   */
  async downloadOnly(): Promise<void> {
    return this.triggerSync('download');
  }
  
  /**
   * 应用启动时调用
   */
  async onAppBoot(): Promise<void> {
    if (this.config().syncOnBoot && this.config().mode !== 'completely-manual') {
      this.logger.info('应用启动，执行同步');
      await this.triggerSync('both');
    }
  }
  
  /**
   * 应用退出时调用
   */
  async onAppExit(): Promise<void> {
    if (this.config().syncOnExit && this.config().mode !== 'completely-manual') {
      this.logger.info('应用退出，执行同步');
      await this.triggerSync('upload');
    }
  }
  
  /**
   * 重置为默认配置
   */
  resetToDefaults(): void {
    const defaults = this.getDefaultConfig();
    this.config.set(defaults);
    this.saveConfig();
    
    if (defaults.mode === 'automatic') {
      this.startAutoSync();
    } else {
      this.stopAutoSync();
    }
    
    this.logger.info('同步配置已重置为默认值');
  }
  
  // ========== 私有方法 ==========
  
  /**
   * 启动自动同步定时器
   */
  private startAutoSync(): void {
    this.stopAutoSync();
    
    const intervalMs = this.config().interval * 1000;
    
    this.autoSyncTimer = setInterval(async () => {
      if (this.syncCallback && this.config().mode === 'automatic') {
        this.logger.debug('自动同步触发');
        try {
          await this.syncCallback('both');
        } catch (e) {
          this.logger.error('自动同步失败', e);
        }
      }
    }, intervalMs);
    
    this.logger.info('自动同步已启动', { intervalMs });
  }
  
  /**
   * 停止自动同步定时器
   */
  private stopAutoSync(): void {
    if (this.autoSyncTimer) {
      clearInterval(this.autoSyncTimer);
      this.autoSyncTimer = null;
      this.logger.debug('自动同步已停止');
    }
  }
  
  /**
   * 加载配置
   */
  private loadConfig(): SyncModeConfig {
    try {
      const stored = localStorage.getItem(CONFIG_STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        return { ...this.getDefaultConfig(), ...parsed };
      }
    } catch (e) {
      this.logger.warn('加载同步配置失败，使用默认值', e);
    }
    return this.getDefaultConfig();
  }
  
  /**
   * 保存配置
   */
  private saveConfig(): void {
    try {
      localStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(this.config()));
    } catch (e) {
      this.logger.warn('保存同步配置失败', e);
    }
  }
  
  /**
   * 获取默认配置
   */
  private getDefaultConfig(): SyncModeConfig {
    return {
      mode: 'automatic',
      interval: DEFAULT_SYNC_INTERVAL,
      perceptionEnabled: true,
      syncOnBoot: true,
      syncOnExit: true,
      generateConflictDoc: true
    };
  }
}
