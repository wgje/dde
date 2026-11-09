/**
 * NetworkAwarenessService - 网络状态感知服务
 * 
 * 【Stingy Hoarder Protocol】核心服务
 * 
 * 职责：
 * - 检测当前网络类型（WiFi/4G/3G/2G/离线）
 * - 检测 Chrome Data Saver / Lite Mode
 * - 提供网络质量信号供同步策略使用
 * - 检测电池状态
 * 
 * @see docs/plan_save.md Phase 4.5
 */

import { Injectable, signal, computed, DestroyRef, inject } from '@angular/core';
import { MOBILE_SYNC_CONFIG } from '../config/sync.config';
import { LoggerService } from './logger.service';
import { SentryLazyLoaderService } from './sentry-lazy-loader.service';
/**
 * 网络质量等级
 */
export type NetworkQuality = 'high' | 'medium' | 'low' | 'offline';

/**
 * Data Saver 模式状态
 */
export type DataSaverMode = 'off' | 'on' | 'unknown';

/**
 * 网络信息 API 类型扩展
 */
interface NetworkInformation {
  effectiveType?: '4g' | '3g' | '2g' | 'slow-2g';
  saveData?: boolean;
  downlink?: number;
  rtt?: number;
  type?: 'bluetooth' | 'cellular' | 'ethernet' | 'none' | 'wifi' | 'wimax' | 'other' | 'unknown';
  addEventListener?: (type: string, listener: EventListener) => void;
  removeEventListener?: (type: string, listener: EventListener) => void;
}

interface NavigatorWithConnection extends Navigator {
  connection?: NetworkInformation;
  mozConnection?: NetworkInformation;
  webkitConnection?: NetworkInformation;
}

/**
 * 电池状态 API 类型
 */
interface BatteryManager {
  charging: boolean;
  level: number;
  addEventListener: (type: string, listener: EventListener) => void;
  removeEventListener: (type: string, listener: EventListener) => void;
}

interface NavigatorWithBattery extends Navigator {
  getBattery?: () => Promise<BatteryManager>;
}

@Injectable({ providedIn: 'root' })
export class NetworkAwarenessService {
  private readonly sentryLazyLoader = inject(SentryLazyLoaderService);
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('NetworkAwareness');
  private readonly destroyRef = inject(DestroyRef);
  
  // ==================== 状态信号 ====================
  
  /** 当前网络质量 */
  readonly networkQuality = signal<NetworkQuality>('high');
  
  /** Data Saver 模式 */
  readonly dataSaverMode = signal<DataSaverMode>('unknown');
  
  /** 是否在线 */
  readonly isOnline = signal<boolean>(typeof navigator !== 'undefined' ? navigator.onLine : true);
  
  /** 电池电量百分比（0-100），-1 表示无法获取 */
  readonly batteryLevel = signal<number>(-1);
  
  /** 是否正在充电 */
  readonly isCharging = signal<boolean>(true);
  
  /** 网络有效类型（4g/3g/2g/slow-2g） */
  readonly effectiveType = signal<string>('unknown');
  
  /** 网络连接类型（wifi/cellular/ethernet/等） */
  readonly connectionType = signal<string>('unknown');
  /** 存储压力状态（用于离线队列冻结提醒） */
  readonly storagePressure = signal(false);
  readonly storagePressureReason = signal<string | null>(null);
  
  // ==================== 计算属性 ====================
  
  /** 是否应启用流量节省模式 */
  readonly shouldSaveData = computed(() => 
    this.dataSaverMode() === 'on' || 
    this.networkQuality() === 'low' ||
    this.networkQuality() === 'offline'
  );
  
  /** 是否是移动网络 */
  readonly isCellular = computed(() => 
    this.connectionType() === 'cellular'
  );
  
  /** 是否低电量 */
  readonly isLowBattery = computed(() => {
    const level = this.batteryLevel();
    return level >= 0 && level < MOBILE_SYNC_CONFIG.LOW_BATTERY_THRESHOLD;
  });
  
  /** 是否应限制同步（低电量 + 非充电 或 弱网） */
  readonly shouldThrottleSync = computed(() => 
    (this.isLowBattery() && !this.isCharging()) ||
    this.networkQuality() === 'low' ||
    this.networkQuality() === 'offline'
  );
  
  /** 是否应禁用附件同步 */
  readonly shouldDisableAttachmentSync = computed(() =>
    MOBILE_SYNC_CONFIG.DISABLE_ATTACHMENT_SYNC_ON_CELLULAR && this.isCellular()
  );
  
  // ==================== 私有状态 ====================
  
  private networkConnection: NetworkInformation | null = null;
  private batteryManager: BatteryManager | null = null;
  private connectionChangeHandler: EventListener | null = null;
  private batteryLevelChangeHandler: EventListener | null = null;
  private batteryChargingChangeHandler: EventListener | null = null;
  private destroyed = false;
  
  // 【修复】保存事件处理器引用，确保 cleanup 时能正确移除
  private readonly onlineHandler = () => this.handleOnlineChange(true);
  private readonly offlineHandler = () => this.handleOnlineChange(false);
  
  constructor() {
    this.destroyRef.onDestroy(() => {
      this.cleanup();
    });

    try {
      this.initialize();
    } catch (error) {
      this.cleanup();
      throw error;
    }
  }
  
  /**
   * 初始化网络感知
   */
  private initialize(): void {
    // 1. 监听在线/离线状态（使用保存的引用以便 cleanup 时正确移除）
    if (typeof window !== 'undefined') {
      window.addEventListener('online', this.onlineHandler);
      window.addEventListener('offline', this.offlineHandler);
    }
    
    // 2. 检测 Data Saver 模式
    this.detectDataSaver();
    
    // 3. 初始化 Network Information API
    this.initNetworkInformation();
    
    // 4. 初始化 Battery Status API
    this.initBatteryStatus();
    
    this.logger.info('网络感知服务已初始化', {
      networkQuality: this.networkQuality(),
      dataSaverMode: this.dataSaverMode(),
      isOnline: this.isOnline(),
      effectiveType: this.effectiveType()
    });
  }
  
  /**
   * 检测 Chrome Data Saver / Lite Mode
   */
  detectDataSaver(): void {
    if (this.destroyed) {
      return;
    }

    const nav = navigator as NavigatorWithConnection;
    const connection = nav.connection || nav.mozConnection || nav.webkitConnection;
    
    // 方法 1: Network Information API (Chrome 61+)
    if (connection?.saveData) {
      this.dataSaverMode.set('on');
      this.logger.info('检测到 Data Saver 模式已启用');
      return;
    }
    
    // 方法 2: 根据 effectiveType 推断
    if (connection?.effectiveType) {
      const quality = this.mapEffectiveType(connection.effectiveType);
      this.networkQuality.set(quality);
      
      if (quality === 'low') {
        this.dataSaverMode.set('on');
        this.logger.info('网络质量低，自动启用流量节省模式');
        return;
      }
    }
    
    this.dataSaverMode.set('off');
  }
  
  /**
   * 初始化 Network Information API
   */
  private initNetworkInformation(): void {
    const nav = navigator as NavigatorWithConnection;
    const connection = nav.connection || nav.mozConnection || nav.webkitConnection;
    
    if (!connection) {
      this.logger.debug('Network Information API 不可用');
      return;
    }
    
    this.networkConnection = connection;
    
    // 更新初始状态
    this.updateNetworkState(connection);
    
    // 监听变化
    if (connection.addEventListener) {
      this.connectionChangeHandler = () => {
        if (this.destroyed) {
          return;
        }

        this.updateNetworkState(connection);
      };
      connection.addEventListener('change', this.connectionChangeHandler);
    }
  }
  
  /**
   * 更新网络状态
   */
  private updateNetworkState(connection: NetworkInformation): void {
    if (this.destroyed) {
      return;
    }

    // 更新有效类型
    if (connection.effectiveType) {
      this.effectiveType.set(connection.effectiveType);
      this.networkQuality.set(this.mapEffectiveType(connection.effectiveType));
    }
    
    // 更新连接类型
    if (connection.type) {
      this.connectionType.set(connection.type);
    }
    
    // 检测 Data Saver
    if (connection.saveData) {
      this.dataSaverMode.set('on');
    }

    if (!this.readNavigatorOnline()) {
      this.isOnline.set(false);
      this.networkQuality.set('offline');
    }
    
    this.logger.debug('网络状态更新', {
      effectiveType: connection.effectiveType,
      type: connection.type,
      saveData: connection.saveData,
      downlink: connection.downlink,
      rtt: connection.rtt
    });
    
    // 发送 Sentry 事件用于网络质量分布统计
    if (connection.effectiveType && connection.effectiveType !== '4g') {
      this.sentryLazyLoader.addBreadcrumb({
        category: 'network',
        message: `网络质量: ${connection.effectiveType}`,
        level: 'info',
        data: {
          effectiveType: connection.effectiveType,
          downlink: connection.downlink,
          rtt: connection.rtt
        }
      });
    }
  }
  
  /**
   * 初始化 Battery Status API
   */
  private async initBatteryStatus(): Promise<void> {
    const nav = navigator as NavigatorWithBattery;
    
    if (!nav.getBattery) {
      this.logger.debug('Battery Status API 不可用');
      return;
    }
    
    try {
      const battery = await nav.getBattery();
      if (this.destroyed) {
        return;
      }

      this.batteryManager = battery;
      
      // 更新初始状态
      this.batteryLevel.set(Math.round(this.batteryManager.level * 100));
      this.isCharging.set(this.batteryManager.charging);
      
      // 监听变化
      this.batteryLevelChangeHandler = () => {
        if (this.destroyed) {
          return;
        }

        if (this.batteryManager) {
          this.batteryLevel.set(Math.round(this.batteryManager.level * 100));
          this.checkLowBatteryWarning();
        }
      };
      this.batteryManager.addEventListener('levelchange', this.batteryLevelChangeHandler);

      this.batteryChargingChangeHandler = () => {
        if (this.destroyed) {
          return;
        }

        if (this.batteryManager) {
          this.isCharging.set(this.batteryManager.charging);
        }
      };
      this.batteryManager.addEventListener('chargingchange', this.batteryChargingChangeHandler);
      
      this.logger.debug('电池状态已初始化', {
        level: this.batteryLevel(),
        charging: this.isCharging()
      });
    } catch (err) {
      this.cleanupBatteryListeners();
      // 浏览器常会因权限策略、隐私设置或实现差异拒绝 Battery API；这不影响核心功能。
      this.logger.debug('Battery Status API 初始化失败，按不可用处理', err);
    }
  }
  
  /**
   * 检查低电量警告
   */
  private checkLowBatteryWarning(): void {
    if (this.isLowBattery() && !this.isCharging()) {
      this.logger.info('低电量模式，同步频率将降低', {
        batteryLevel: this.batteryLevel()
      });
    }
  }
  
  /**
   * 将 effectiveType 映射到网络质量等级
   */
  private mapEffectiveType(type: string): NetworkQuality {
    const thresholds = MOBILE_SYNC_CONFIG.NETWORK_QUALITY_THRESHOLDS;
    
    if (thresholds.HIGH.includes(type)) {
      return 'high';
    }
    if (thresholds.MEDIUM.includes(type)) {
      return 'medium';
    }
    if (thresholds.LOW.includes(type)) {
      return 'low';
    }
    
    // 默认返回 medium
    return 'medium';
  }
  
  /**
   * 处理在线状态变化
   */
  private handleOnlineChange(online: boolean): void {
    if (this.destroyed) {
      return;
    }

    this.isOnline.set(online);
    
    if (!online) {
      this.networkQuality.set('offline');
      this.logger.info('网络已断开');
    } else {
      // 重新检测网络质量
      if (this.networkConnection?.effectiveType) {
        this.networkQuality.set(this.mapEffectiveType(this.networkConnection.effectiveType));
      } else {
        this.networkQuality.set('high'); // 假设恢复后是好的网络
      }
      this.logger.info('网络已恢复', { quality: this.networkQuality() });
    }
  }
  
  /**
   * 获取当前网络状态摘要
   */
  getNetworkSummary(): {
    quality: NetworkQuality;
    isOnline: boolean;
    effectiveType: string;
    connectionType: string;
    dataSaverMode: DataSaverMode;
    batteryLevel: number;
    isCharging: boolean;
    shouldThrottle: boolean;
    storagePressure: boolean;
  } {
    return {
      quality: this.networkQuality(),
      isOnline: this.isOnline(),
      effectiveType: this.effectiveType(),
      connectionType: this.connectionType(),
      dataSaverMode: this.dataSaverMode(),
      batteryLevel: this.batteryLevel(),
      isCharging: this.isCharging(),
      shouldThrottle: this.shouldThrottleSync(),
      storagePressure: this.storagePressure()
    };
  }

  /**
   * 更新存储压力状态（由队列服务调用）
   */
  setStoragePressure(active: boolean, reason: string | null = null): void {
    if (this.destroyed) {
      return;
    }

    this.storagePressure.set(active);
    this.storagePressureReason.set(reason);
    this.logger.info('存储压力状态更新', { active, reason });
  }
  
  /**
   * 强制刷新网络状态
   */
  refresh(): void {
    if (this.destroyed) {
      return;
    }

    this.detectDataSaver();
    
    if (this.networkConnection) {
      this.updateNetworkState(this.networkConnection);
    }
    
    const online = this.readNavigatorOnline();
    this.isOnline.set(online);
    if (!online) {
      this.networkQuality.set('offline');
    } else if (this.networkQuality() === 'offline') {
      this.networkQuality.set(
        this.networkConnection?.effectiveType
          ? this.mapEffectiveType(this.networkConnection.effectiveType)
          : 'high',
      );
    }
    
    this.logger.debug('网络状态已刷新', this.getNetworkSummary());
  }

  private readNavigatorOnline(): boolean {
    return typeof navigator !== 'undefined' ? navigator.onLine : true;
  }
  
  /**
   * 清理资源
   */
  private cleanup(): void {
    this.destroyed = true;
    const networkConnection = this.networkConnection;
    const connectionChangeHandler = this.connectionChangeHandler;
    this.networkConnection = null;
    this.connectionChangeHandler = null;

    if (networkConnection?.removeEventListener && connectionChangeHandler) {
      this.removeLifecycleListener('network.change', () => {
        networkConnection.removeEventListener?.('change', connectionChangeHandler);
      });
    }

    this.cleanupBatteryListeners();

    // 【修复】使用保存的引用正确移除事件监听器
    if (typeof window !== 'undefined') {
      this.removeLifecycleListener('window.online', () => {
        window.removeEventListener('online', this.onlineHandler);
      });
      this.removeLifecycleListener('window.offline', () => {
        window.removeEventListener('offline', this.offlineHandler);
      });
    }
  }

  private cleanupBatteryListeners(): void {
    const batteryManager = this.batteryManager;
    const batteryLevelChangeHandler = this.batteryLevelChangeHandler;
    const batteryChargingChangeHandler = this.batteryChargingChangeHandler;
    this.batteryManager = null;
    this.batteryLevelChangeHandler = null;
    this.batteryChargingChangeHandler = null;

    if (batteryManager) {
      if (batteryLevelChangeHandler) {
        this.removeLifecycleListener('battery.levelchange', () => {
          batteryManager.removeEventListener('levelchange', batteryLevelChangeHandler);
        });
      }
      if (batteryChargingChangeHandler) {
        this.removeLifecycleListener('battery.chargingchange', () => {
          batteryManager.removeEventListener('chargingchange', batteryChargingChangeHandler);
        });
      }
    }
  }

  private removeLifecycleListener(label: string, remove: () => void): void {
    try {
      remove();
      return;
    } catch (error) {
      this.warnLifecycleListenerCleanupFailure(label, error);
    }

    try {
      remove();
    } catch (error) {
      this.warnLifecycleListenerCleanupFailure(label, error);
    }
  }

  private warnLifecycleListenerCleanupFailure(label: string, error: unknown): void {
    try {
      this.logger.warn('网络感知生命周期监听解绑失败，继续清理其他监听', {
        label,
        message: error instanceof Error ? error.message : 'unknown',
      });
    } catch {
      // Warning sinks must not interrupt lifecycle listener cleanup.
    }
  }
}
