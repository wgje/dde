/**
 * IndexedDBHealthService - IndexedDB 健康检查与损坏恢复服务
 * 
 * 【v5.10 数据保护】
 * 职责：
 * - 启动时检测 IndexedDB 数据库健康状态
 * - 抽样校验数据完整性（JSON 解析、必填字段）
 * - 检测打开错误、版本错误、事务中止、配额错误
 * - 根据损坏类型提供恢复策略
 * - 定期检查，持续监控数据库健康
 * 
 * 设计理念：
 * - 轻量级检测，不阻塞启动
 * - 发现问题后根据策略 (prompt-recovery / cloud-recovery / export-remaining) 处理
 * - 严重问题上报 Sentry
 */
import { Injectable, inject, signal, computed, OnDestroy } from '@angular/core';
import { LoggerService } from './logger.service';
import { ToastService } from './toast.service';
import { SentryLazyLoaderService } from './sentry-lazy-loader.service';
import { INDEXEDDB_HEALTH_CONFIG } from '../config/sync.config';
import { IndexedDBService, DB_CONFIG } from '../core-bridge';

/**
 * 损坏类型
 */
export type CorruptionType =
  | 'open-error'           // 数据库无法打开
  | 'version-error'        // 版本不匹配
  | 'transaction-abort'    // 事务中止
  | 'quota-error'          // 配额溢出
  | 'json-parse-error'     // JSON 解析失败
  | 'schema-mismatch'      // 缺少必填字段
  | 'store-missing';       // ObjectStore 不存在

/**
 * 健康检查结果
 */
export interface HealthCheckResult {
  /** 数据库是否健康 */
  healthy: boolean;
  /** 发现的问题列表 */
  issues: HealthIssue[];
  /** 检查时间戳 */
  checkedAt: string;
  /** 抽样校验通过的记录数 */
  samplesChecked: number;
  /** 抽样校验失败的记录数 */
  samplesFailed: number;
}

/**
 * 健康问题
 */
export interface HealthIssue {
  /** 损坏类型 */
  type: CorruptionType;
  /** 严重级别 */
  severity: 'warning' | 'error' | 'critical';
  /** 问题描述 */
  message: string;
  /** 受影响的 ObjectStore */
  store?: string;
  /** 受影响的记录 ID */
  recordId?: string;
  /** 建议的恢复策略 */
  recovery: 'prompt-recovery' | 'cloud-recovery' | 'export-remaining';
}

@Injectable({
  providedIn: 'root'
})
export class IndexedDBHealthService implements OnDestroy {
  private readonly logger = inject(LoggerService).category('IndexedDBHealth');
  private readonly toast = inject(ToastService);
  private readonly sentryLazyLoader = inject(SentryLazyLoaderService);
  private readonly indexedDBService = inject(IndexedDBService);

  /** 最新的健康检查结果 */
  private readonly _lastResult = signal<HealthCheckResult | null>(null);
  readonly lastResult = computed(() => this._lastResult());

  /** 数据库是否健康 */
  readonly isHealthy = computed(() => {
    const result = this._lastResult();
    return result === null || result.healthy;
  });

  /** 严重问题数 */
  readonly criticalIssueCount = computed(() => {
    const result = this._lastResult();
    if (!result) return 0;
    return result.issues.filter(i => i.severity === 'critical').length;
  });

  /** 定期检查定时器 */
  private periodicTimer: ReturnType<typeof setInterval> | null = null;

  /** 是否已初始化 */
  private initialized = false;

  /**
   * 初始化健康检查
   * 应在应用启动时调用（在 IndexedDB 初始化之后）
   */
  async initialize(): Promise<HealthCheckResult> {
    if (this.initialized) {
      return this._lastResult() ?? this.createEmptyResult();
    }
    this.initialized = true;

    this.logger.info('IndexedDB 健康检查服务初始化');

    // 启动时检查
    let result: HealthCheckResult;
    if (INDEXEDDB_HEALTH_CONFIG.CHECK_ON_INIT) {
      result = await this.performHealthCheck();
    } else {
      result = this.createEmptyResult();
    }

    // 启动定期检查
    this.periodicTimer = setInterval(() => {
      void this.performHealthCheck();
    }, INDEXEDDB_HEALTH_CONFIG.PERIODIC_CHECK_INTERVAL);

    return result;
  }

  ngOnDestroy(): void {
    if (this.periodicTimer) {
      clearInterval(this.periodicTimer);
      this.periodicTimer = null;
    }
  }

  /**
   * 执行完整的健康检查
   */
  async performHealthCheck(): Promise<HealthCheckResult> {
    const issues: HealthIssue[] = [];
    let samplesChecked = 0;
    let samplesFailed = 0;

    try {
      // 1. 检查数据库是否可以打开
      const db = await this.checkDatabaseOpen();
      if (!db) {
        issues.push({
          type: 'open-error',
          severity: 'critical',
          message: 'IndexedDB 无法打开，数据库可能已损坏',
          recovery: 'cloud-recovery',
        });
        return this.finalizeResult(false, issues, samplesChecked, samplesFailed);
      }

      // 2. 检查 ObjectStore 是否完整
      const storeIssues = this.checkObjectStores(db);
      issues.push(...storeIssues);

      // 3. 抽样校验数据完整性
      if (INDEXEDDB_HEALTH_CONFIG.STARTUP_INTEGRITY_CHECK.ENABLED) {
        const sampleResult = await this.sampleIntegrityCheck(db);
        samplesChecked = sampleResult.checked;
        samplesFailed = sampleResult.failed;
        issues.push(...sampleResult.issues);
      }

    } catch (error) {
      this.logger.error('健康检查过程中发生异常', error);
      issues.push({
        type: 'open-error',
        severity: 'error',
        message: `健康检查异常: ${error instanceof Error ? error.message : '未知错误'}`,
        recovery: 'prompt-recovery',
      });
    }

    const healthy = issues.every(i => i.severity === 'warning');
    return this.finalizeResult(healthy, issues, samplesChecked, samplesFailed);
  }

  // ==================== 私有方法 ====================

  /**
   * 检查数据库是否可以成功打开
   */
  private async checkDatabaseOpen(): Promise<IDBDatabase | null> {
    try {
      const db = await this.indexedDBService.initDatabase();
      return db;
    } catch (error) {
      this.logger.error('IndexedDB 打开失败', error);

      // 区分错误类型
      if (error instanceof DOMException) {
        if (error.name === 'VersionError') {
          return null;
        }
        if (error.name === 'QuotaExceededError') {
          return null;
        }
      }

      // eslint-disable-next-line no-restricted-syntax -- 返回 null 语义正确：数据库打开失败表示不可用
      return null;
    }
  }

  /**
   * 检查 ObjectStore 是否存在且完整
   */
  private checkObjectStores(db: IDBDatabase): HealthIssue[] {
    const issues: HealthIssue[] = [];
    const expectedStores = Object.values(DB_CONFIG.stores);

    for (const storeName of expectedStores) {
      if (!db.objectStoreNames.contains(storeName)) {
        issues.push({
          type: 'store-missing',
          severity: 'critical',
          message: `ObjectStore "${storeName}" 不存在`,
          store: storeName,
          recovery: 'cloud-recovery',
        });
      }
    }

    return issues;
  }

  /**
   * 抽样校验数据完整性
   * 从每个 store 中随机抽取 SAMPLE_SIZE 条记录进行校验
   */
  private async sampleIntegrityCheck(db: IDBDatabase): Promise<{
    checked: number;
    failed: number;
    issues: HealthIssue[];
  }> {
    const issues: HealthIssue[] = [];
    let checked = 0;
    let failed = 0;

    const sampleSize = INDEXEDDB_HEALTH_CONFIG.STARTUP_INTEGRITY_CHECK.SAMPLE_SIZE;

    // 校验任务记录
    if (db.objectStoreNames.contains(DB_CONFIG.stores.tasks)) {
      const taskResult = await this.checkStoreRecords(
        db,
        DB_CONFIG.stores.tasks,
        INDEXEDDB_HEALTH_CONFIG.REQUIRED_TASK_FIELDS as readonly string[],
        sampleSize
      );
      checked += taskResult.checked;
      failed += taskResult.failed;
      issues.push(...taskResult.issues);
    }

    // 校验项目记录
    if (db.objectStoreNames.contains(DB_CONFIG.stores.projects)) {
      const projectResult = await this.checkStoreRecords(
        db,
        DB_CONFIG.stores.projects,
        INDEXEDDB_HEALTH_CONFIG.REQUIRED_PROJECT_FIELDS as readonly string[],
        sampleSize
      );
      checked += projectResult.checked;
      failed += projectResult.failed;
      issues.push(...projectResult.issues);
    }

    // 校验连接记录
    if (db.objectStoreNames.contains(DB_CONFIG.stores.connections)) {
      const connResult = await this.checkStoreRecords(
        db,
        DB_CONFIG.stores.connections,
        INDEXEDDB_HEALTH_CONFIG.REQUIRED_CONNECTION_FIELDS as readonly string[],
        sampleSize
      );
      checked += connResult.checked;
      failed += connResult.failed;
      issues.push(...connResult.issues);
    }

    return { checked, failed, issues };
  }

  /**
   * 校验指定 store 中的记录
   */
  private async checkStoreRecords(
    db: IDBDatabase,
    storeName: string,
    requiredFields: readonly string[],
    sampleSize: number
  ): Promise<{
    checked: number;
    failed: number;
    issues: HealthIssue[];
  }> {
    const issues: HealthIssue[] = [];
    let checked = 0;
    let failed = 0;

    try {
      const records = await this.getRandomSample(db, storeName, sampleSize);

      for (const record of records) {
        checked++;

        // JSON 解析校验（记录已经被 IndexedDB 反序列化，检查是否为有效对象）
        if (INDEXEDDB_HEALTH_CONFIG.STARTUP_INTEGRITY_CHECK.CHECK_JSON_PARSE) {
          if (!record || typeof record !== 'object') {
            failed++;
            issues.push({
              type: 'json-parse-error',
              severity: 'error',
              message: `[${storeName}] 记录不是有效的对象`,
              store: storeName,
              recovery: 'prompt-recovery',
            });
            continue;
          }
        }

        // 必填字段校验
        if (INDEXEDDB_HEALTH_CONFIG.STARTUP_INTEGRITY_CHECK.CHECK_REQUIRED_FIELDS) {
          const obj = record as Record<string, unknown>;
          for (const field of requiredFields) {
            if (obj[field] === undefined || obj[field] === null) {
              failed++;
              issues.push({
                type: 'schema-mismatch',
                severity: 'warning',
                message: `[${storeName}] 记录缺少必填字段 "${field}"`,
                store: storeName,
                recordId: typeof obj['id'] === 'string' ? obj['id'] : undefined,
                recovery: 'prompt-recovery',
              });
              break; // 一条记录只报告一次
            }
          }
        }
      }
    } catch (error) {
      this.logger.warn(`校验 ${storeName} 失败`, error);

      // 判断是否为事务中止
      if (error instanceof DOMException && error.name === 'AbortError') {
        issues.push({
          type: 'transaction-abort',
          severity: 'error',
          message: `[${storeName}] 事务中止，数据可能损坏`,
          store: storeName,
          recovery: 'cloud-recovery',
        });
      }
    }

    return { checked, failed, issues };
  }

  /**
   * 从 ObjectStore 中随机抽取记录
   * 使用 cursor 遍历提取
   */
  private async getRandomSample(
    db: IDBDatabase,
    storeName: string,
    sampleSize: number
  ): Promise<unknown[]> {
    return new Promise((resolve, reject) => {
      try {
        const transaction = db.transaction(storeName, 'readonly');
        const store = transaction.objectStore(storeName);
        const countRequest = store.count();

        countRequest.onsuccess = () => {
          const total = countRequest.result;
          if (total === 0) {
            resolve([]);
            return;
          }

          // 如果总数小于抽样数，取全部
          if (total <= sampleSize) {
            const allRequest = store.getAll();
            allRequest.onsuccess = () => resolve(allRequest.result || []);
            allRequest.onerror = () => reject(allRequest.error);
            return;
          }

          // 随机抽样：取前 N 条 + 随机跳跃
          const results: unknown[] = [];
          const step = Math.floor(total / sampleSize);
          let currentIndex = 0;
          let collected = 0;

          const cursorRequest = store.openCursor();
          cursorRequest.onsuccess = () => {
            const cursor = cursorRequest.result;
            if (!cursor || collected >= sampleSize) {
              resolve(results);
              return;
            }

            if (currentIndex % step === 0) {
              results.push(cursor.value);
              collected++;
            }
            currentIndex++;
            cursor.continue();
          };
          cursorRequest.onerror = () => reject(cursorRequest.error);
        };

        countRequest.onerror = () => reject(countRequest.error);
      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * 完成检查结果并执行响应
   */
  private finalizeResult(
    healthy: boolean,
    issues: HealthIssue[],
    samplesChecked: number,
    samplesFailed: number
  ): HealthCheckResult {
    const result: HealthCheckResult = {
      healthy,
      issues,
      checkedAt: new Date().toISOString(),
      samplesChecked,
      samplesFailed,
    };

    this._lastResult.set(result);

    // 处理问题
    if (!healthy) {
      this.handleHealthIssues(result);
    }

    return result;
  }

  /**
   * 处理发现的健康问题
   */
  private handleHealthIssues(result: HealthCheckResult): void {
    const criticalIssues = result.issues.filter(i => i.severity === 'critical');
    const errorIssues = result.issues.filter(i => i.severity === 'error');

    if (criticalIssues.length > 0) {
      this.logger.error('IndexedDB 存在严重问题', { issues: criticalIssues });

      this.toast.error(
        '数据库异常',
        '检测到本地数据库损坏，建议从云端恢复数据或导出备份。'
      );

      this.sentryLazyLoader.captureException(
        new Error('IndexedDB 严重损坏'),
        {
          issues: criticalIssues.map(i => ({ type: i.type, message: i.message })),
          samplesChecked: result.samplesChecked,
          samplesFailed: result.samplesFailed,
        }
      );
    } else if (errorIssues.length > 0) {
      this.logger.warn('IndexedDB 存在数据问题', { issues: errorIssues });

      this.toast.warning(
        '数据完整性警告',
        '检测到部分数据异常，建议导出备份。'
      );

      this.sentryLazyLoader.captureException(
        new Error('IndexedDB 数据完整性问题'),
        {
          issues: errorIssues.map(i => ({ type: i.type, message: i.message })),
        }
      );
    }
  }

  /**
   * 创建空的健康检查结果
   */
  private createEmptyResult(): HealthCheckResult {
    return {
      healthy: true,
      issues: [],
      checkedAt: new Date().toISOString(),
      samplesChecked: 0,
      samplesFailed: 0,
    };
  }
}
