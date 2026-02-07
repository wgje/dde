/**
 * StorageQuotaService - 存储配额监控与保护服务
 * 
 * 【v5.9 数据保护】
 * 职责：
 * - 监控 localStorage 和 IndexedDB 的使用量
 * - 达到警告/危险阈值时通知用户
 * - 提供可清理项目列表
 * - 紧急情况触发自动清理
 * - 上报配额接近上限的事件到 Sentry
 * 
 * 设计理念：
 * - 定期检查，不打扰用户（冷却期 1 小时）
 * - 危险阈值时主动提醒，提供清理选项
 * - 配额溢出时自动清理过期缓存
 */
import { Injectable, inject, signal, computed, OnDestroy } from '@angular/core';
import { LoggerService } from './logger.service';
import { ToastService } from './toast.service';
import { SentryLazyLoaderService } from './sentry-lazy-loader.service';
import { STORAGE_QUOTA_CONFIG } from '../config';

/**
 * 存储配额级别
 */
export type QuotaLevel = 'normal' | 'warning' | 'critical';

/**
 * 存储使用报告
 */
export interface StorageUsageReport {
  /** localStorage 已用字节 */
  localStorageUsed: number;
  /** localStorage 配额级别 */
  localStorageLevel: QuotaLevel;
  /** IndexedDB 已用字节 */
  indexedDBUsed: number;
  /** IndexedDB 配额级别 */
  indexedDBLevel: QuotaLevel;
  /** IndexedDB 配额总量（来自 StorageManager API） */
  indexedDBQuota: number;
  /** 检查时间戳 */
  checkedAt: string;
}

/**
 * 可清理项目
 */
export interface CleanableItem {
  /** 项目类型 */
  type: 'localStorage' | 'indexedDB';
  /** 存储键名 */
  key: string;
  /** 描述 */
  description: string;
  /** 预估可释放大小（字节） */
  estimatedSize: number;
  /** 是否安全清理（不影响核心数据） */
  safe: boolean;
}

@Injectable({
  providedIn: 'root'
})
export class StorageQuotaService implements OnDestroy {
  private readonly logger = inject(LoggerService).category('StorageQuota');
  private readonly toast = inject(ToastService);
  private readonly sentryLazyLoader = inject(SentryLazyLoaderService);

  /** 最新的存储使用报告 */
  private readonly _report = signal<StorageUsageReport | null>(null);
  readonly report = computed(() => this._report());

  /** 当前配额级别（取两者中更严重的） */
  readonly overallLevel = computed<QuotaLevel>(() => {
    const r = this._report();
    if (!r) return 'normal';
    if (r.localStorageLevel === 'critical' || r.indexedDBLevel === 'critical') return 'critical';
    if (r.localStorageLevel === 'warning' || r.indexedDBLevel === 'warning') return 'warning';
    return 'normal';
  });

  /** 是否处于危险状态 */
  readonly isCritical = computed(() => this.overallLevel() === 'critical');

  /** 定期检查定时器 */
  private checkTimer: ReturnType<typeof setInterval> | null = null;

  /** 上次警告 Toast 时间（冷却控制） */
  private lastWarningTime = 0;

  /** 是否已初始化 */
  private initialized = false;

  /**
   * 初始化配额监控
   * 应在应用启动时调用
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;

    this.logger.info('存储配额监控服务初始化');

    // 启动时立即检查一次
    if (STORAGE_QUOTA_CONFIG.CHECK_ON_STARTUP) {
      await this.checkQuota();
    }

    // 启动定期检查
    this.checkTimer = setInterval(() => {
      void this.checkQuota();
    }, STORAGE_QUOTA_CONFIG.CHECK_INTERVAL);
  }

  ngOnDestroy(): void {
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = null;
    }
  }

  /**
   * 执行一次配额检查
   */
  async checkQuota(): Promise<StorageUsageReport> {
    try {
      const localStorageUsed = this.measureLocalStorageUsage();
      const { used: indexedDBUsed, quota: indexedDBQuota } = await this.measureIndexedDBUsage();

      const localStorageLevel = this.getLevel(
        localStorageUsed,
        STORAGE_QUOTA_CONFIG.LOCALSTORAGE_WARNING_THRESHOLD,
        STORAGE_QUOTA_CONFIG.LOCALSTORAGE_CRITICAL_THRESHOLD
      );

      const indexedDBLevel = this.getLevel(
        indexedDBUsed,
        STORAGE_QUOTA_CONFIG.INDEXEDDB_WARNING_THRESHOLD,
        STORAGE_QUOTA_CONFIG.INDEXEDDB_CRITICAL_THRESHOLD
      );

      const report: StorageUsageReport = {
        localStorageUsed,
        localStorageLevel,
        indexedDBUsed,
        indexedDBLevel,
        indexedDBQuota,
        checkedAt: new Date().toISOString(),
      };

      this._report.set(report);

      // 根据级别执行响应
      this.handleQuotaLevel(report);

      this.logger.debug('配额检查完成', {
        localStorage: `${(localStorageUsed / 1024 / 1024).toFixed(2)}MB (${localStorageLevel})`,
        indexedDB: `${(indexedDBUsed / 1024 / 1024).toFixed(2)}MB (${indexedDBLevel})`,
      });

      return report;
    } catch (error) {
      this.logger.error('配额检查失败', error);
      // 不抛出，返回空报告
      const fallback: StorageUsageReport = {
        localStorageUsed: 0,
        localStorageLevel: 'normal',
        indexedDBUsed: 0,
        indexedDBLevel: 'normal',
        indexedDBQuota: 0,
        checkedAt: new Date().toISOString(),
      };
      this._report.set(fallback);
      return fallback;
    }
  }

  /**
   * 获取可清理项目列表
   * 识别可以安全清理的本地存储数据
   */
  getCleanableItems(): CleanableItem[] {
    const items: CleanableItem[] = [];

    // 扫描 localStorage 中可清理的键
    const safeCleanableKeys = [
      'nanoflow.flowchart-cache',
      'nanoflow.temp-',
      'nanoflow.debug-',
    ];

    const preserveKeys = [
      'nanoflow.auth',
      'nanoflow.preferences',
      'nanoflow.last-project',
      'nanoflow.theme',
      'nanoflow.undo-session',
    ];

    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key) continue;

      // 仅扫描 nanoflow 相关的键
      if (!key.startsWith('nanoflow.')) continue;

      const value = localStorage.getItem(key);
      if (!value) continue;

      const size = new Blob([value]).size;
      const isSafe = safeCleanableKeys.some(prefix => key.startsWith(prefix));
      const isProtected = preserveKeys.some(pk => key === pk);

      if (!isProtected && size > 1024) { // 只列出 > 1KB 的项
        items.push({
          type: 'localStorage',
          key,
          description: isSafe ? `缓存数据 (${key})` : `应用数据 (${key})`,
          estimatedSize: size,
          safe: isSafe,
        });
      }
    }

    return items;
  }

  /**
   * 清理指定的可清理项目
   */
  cleanItems(items: CleanableItem[]): { cleaned: number; freedBytes: number } {
    let cleaned = 0;
    let freedBytes = 0;

    for (const item of items) {
      try {
        if (item.type === 'localStorage') {
          localStorage.removeItem(item.key);
          freedBytes += item.estimatedSize;
          cleaned++;
        }
        // IndexedDB 清理由 data-integrity 服务处理
      } catch (error) {
        this.logger.warn(`清理失败: ${item.key}`, error);
      }
    }

    if (cleaned > 0) {
      this.logger.info(`已清理 ${cleaned} 项，释放约 ${(freedBytes / 1024).toFixed(1)}KB`);
      // 重新检查配额
      void this.checkQuota();
    }

    return { cleaned, freedBytes };
  }

  /**
   * 紧急清理：仅清理安全的缓存项
   * 在配额接近溢出时自动执行
   */
  emergencyCleanup(): { cleaned: number; freedBytes: number } {
    this.logger.warn('执行紧急存储清理');

    const items = this.getCleanableItems().filter(item => item.safe);
    const result = this.cleanItems(items);

    this.sentryLazyLoader.captureException(
      new Error('存储配额紧急清理已执行'),
      {
        emergencyCleanup: true,
        cleaned: result.cleaned,
        freedBytes: result.freedBytes,
      }
    );

    return result;
  }

  // ==================== 私有方法 ====================

  /**
   * 测量 localStorage 使用量
   */
  private measureLocalStorageUsage(): number {
    try {
      let totalSize = 0;
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key) continue;
        const value = localStorage.getItem(key);
        if (value) {
          // UTF-16 编码，每个字符 2 字节
          totalSize += (key.length + value.length) * 2;
        }
      }
      return totalSize;
    } catch {
      return 0;
    }
  }

  /**
   * 测量 IndexedDB 使用量
   * 使用 StorageManager API 获取精确数据
   */
  private async measureIndexedDBUsage(): Promise<{ used: number; quota: number }> {
    try {
      if (navigator.storage && navigator.storage.estimate) {
        const estimate = await navigator.storage.estimate();
        return {
          used: estimate.usage ?? 0,
          quota: estimate.quota ?? 0,
        };
      }
    } catch {
      // StorageManager API 不可用，返回 0
    }
    return { used: 0, quota: 0 };
  }

  /**
   * 判断配额级别
   */
  private getLevel(used: number, warningThreshold: number, criticalThreshold: number): QuotaLevel {
    if (used >= criticalThreshold) return 'critical';
    if (used >= warningThreshold) return 'warning';
    return 'normal';
  }

  /**
   * 根据配额级别执行响应操作
   */
  private handleQuotaLevel(report: StorageUsageReport): void {
    const now = Date.now();
    const cooldownElapsed = now - this.lastWarningTime > STORAGE_QUOTA_CONFIG.WARNING_COOLDOWN;

    if (report.localStorageLevel === 'critical' || report.indexedDBLevel === 'critical') {
      // 危险级别：紧急清理 + 强制告警
      this.emergencyCleanup();

      if (cooldownElapsed) {
        this.lastWarningTime = now;
        this.toast.warning(
          '存储空间即将耗尽',
          '请前往设置导出数据备份，或手动清理不需要的项目。'
        );
      }

      this.sentryLazyLoader.captureException(
        new Error('存储配额达到危险阈值'),
        {
          localStorageUsed: report.localStorageUsed,
          localStorageLevel: report.localStorageLevel,
          indexedDBUsed: report.indexedDBUsed,
          indexedDBLevel: report.indexedDBLevel,
        }
      );
    } else if (report.localStorageLevel === 'warning' || report.indexedDBLevel === 'warning') {
      // 警告级别：仅提示
      if (cooldownElapsed) {
        this.lastWarningTime = now;
        this.toast.warning(
          '存储空间不足',
          '建议导出数据备份或清理过期缓存。'
        );
      }
    }
  }
}
