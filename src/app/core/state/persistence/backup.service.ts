/**
 * 数据库备份服务
 *
 * 职责：
 * - 创建 IndexedDB 数据库备份
 * - 从备份恢复数据
 * - 管理备份生命周期（自动清理过期备份）
 *
 * @see docs/plan_save.md Phase 2.5 - 迁移回滚支持
 */

import { Injectable, inject } from '@angular/core';
import { LoggerService } from '../../../../services/logger.service';
import { Project, Task, Connection } from '../../../../models';
import { IndexedDBService, DB_CONFIG } from './indexeddb.service';
import { SentryLazyLoaderService } from '../../../../services/sentry-lazy-loader.service';
/** 存储元数据结构 */
interface StoreMeta {
  version: number;
  lastSyncTime: string;
  activeProjectId: string | null;
  backupTime?: string;
}

/** 备份配置 */
const BACKUP_CONFIG = {
  /** 备份数据库名称前缀 */
  DB_PREFIX: 'nanoflow-db-backup-',
  /** 备份保留天数 */
  RETENTION_DAYS: 7
} as const;

@Injectable({
  providedIn: 'root'
})
export class BackupService {
  private readonly sentryLazyLoader = inject(SentryLazyLoaderService);
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('Backup');
  private readonly indexedDB = inject(IndexedDBService);

  /**
   * 创建当前数据库的备份
   *
   * 用于 Delta Sync 启用前的数据保护
   * 备份以日期为后缀存储在单独的 IndexedDB 中
   *
   * @returns 备份数据库名称，失败返回 null
   */
  async createBackup(): Promise<string | null> {
    let backupDb: IDBDatabase | null = null;

    try {
      await this.indexedDB.initDatabase();
      const dateStr = new Date().toISOString().split('T')[0].replace(/-/g, '');
      const backupDbName = `${BACKUP_CONFIG.DB_PREFIX}${dateStr}`;

      // 检查是否已存在今天的备份
      const databases = await indexedDB.databases?.() || [];
      const existingBackup = databases.find(d => d.name === backupDbName);
      if (existingBackup) {
        this.logger.debug('今天的备份已存在', { backupDbName });
        return backupDbName;
      }

      // 读取所有数据
      const db = await this.indexedDB.initDatabase();
      const allProjects = await this.indexedDB.getAllFromStore<Project>(db, DB_CONFIG.stores.projects);
      const allTasks = await this.indexedDB.getAllFromStore<Task>(db, DB_CONFIG.stores.tasks);
      const allConnections = await this.indexedDB.getAllFromStore<Connection>(db, DB_CONFIG.stores.connections);
      const meta = await this.indexedDB.getFromStore<StoreMeta>(db, DB_CONFIG.stores.meta, 'meta');

      // 创建备份数据库
      backupDb = await this.createBackupDatabase(backupDbName);

      // 写入备份
      const tx = backupDb.transaction(
        [DB_CONFIG.stores.projects, DB_CONFIG.stores.tasks, DB_CONFIG.stores.connections, DB_CONFIG.stores.meta],
        'readwrite'
      );

      const projectStore = tx.objectStore(DB_CONFIG.stores.projects);
      const taskStore = tx.objectStore(DB_CONFIG.stores.tasks);
      const connStore = tx.objectStore(DB_CONFIG.stores.connections);
      const metaStore = tx.objectStore(DB_CONFIG.stores.meta);

      for (const project of allProjects) {
        projectStore.put(project);
      }
      for (const task of allTasks) {
        taskStore.put(task);
      }
      for (const conn of allConnections) {
        connStore.put(conn);
      }
      if (meta) {
        metaStore.put({ ...meta, backupTime: new Date().toISOString() }, 'meta');
      }

      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });

      this.logger.info('数据库备份创建成功', {
        backupDbName,
        projectCount: allProjects.length,
        taskCount: allTasks.length,
        connectionCount: allConnections.length
      });

      // 清理过期备份
      await this.cleanupOldBackups();

      return backupDbName;
    } catch (err) {
      this.logger.error('创建数据库备份失败', err);
      this.sentryLazyLoader.captureException(err, { tags: { operation: 'createBackup' } });
      // eslint-disable-next-line no-restricted-syntax -- 返回 null 语义正确：备份失败不阻断主流程
      return null;
    } finally {
      // 确保备份数据库连接被关闭，防止资源泄漏
      backupDb?.close();
    }
  }

  /**
   * 创建备份数据库结构
   */
  private createBackupDatabase(dbName: string): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(dbName, 1);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;

        // 复制主数据库的结构
        if (!db.objectStoreNames.contains(DB_CONFIG.stores.projects)) {
          db.createObjectStore(DB_CONFIG.stores.projects, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(DB_CONFIG.stores.tasks)) {
          const taskStore = db.createObjectStore(DB_CONFIG.stores.tasks, { keyPath: 'id' });
          taskStore.createIndex('projectId', 'projectId', { unique: false });
        }
        if (!db.objectStoreNames.contains(DB_CONFIG.stores.connections)) {
          const connStore = db.createObjectStore(DB_CONFIG.stores.connections, { keyPath: 'id' });
          connStore.createIndex('projectId', 'projectId', { unique: false });
        }
        if (!db.objectStoreNames.contains(DB_CONFIG.stores.meta)) {
          db.createObjectStore(DB_CONFIG.stores.meta);
        }
      };
    });
  }

  /**
   * 从备份恢复数据
   *
   * @param backupDbName 备份数据库名称
   * @returns 是否恢复成功
   */
  async restoreFromBackup(backupDbName: string): Promise<boolean> {
    try {
      // 打开备份数据库
      const backupDb = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(backupDbName);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
      });

      // 读取备份数据
      const allProjects = await this.getAllFromBackupStore<Project>(backupDb, DB_CONFIG.stores.projects);
      const allTasks = await this.getAllFromBackupStore<Task>(backupDb, DB_CONFIG.stores.tasks);
      const allConnections = await this.getAllFromBackupStore<Connection>(backupDb, DB_CONFIG.stores.connections);
      const meta = await this.getFromBackupStore<StoreMeta>(backupDb, DB_CONFIG.stores.meta, 'meta');

      backupDb.close();

      // 【P3-29 修复】清空 + 恢复放在同一个事务中，保证原子性
      const db = await this.indexedDB.initDatabase();
      const storeNames = [DB_CONFIG.stores.projects, DB_CONFIG.stores.tasks, DB_CONFIG.stores.connections, DB_CONFIG.stores.meta];
      const tx = db.transaction(storeNames, 'readwrite');

      const projectStore = tx.objectStore(DB_CONFIG.stores.projects);
      const taskStore = tx.objectStore(DB_CONFIG.stores.tasks);
      const connStore = tx.objectStore(DB_CONFIG.stores.connections);
      const metaStore = tx.objectStore(DB_CONFIG.stores.meta);

      // 先清空所有 store
      projectStore.clear();
      taskStore.clear();
      connStore.clear();
      metaStore.clear();

      // 再写入备份数据（同一事务内，要么全部成功，要么全部回滚）
      for (const project of allProjects) {
        projectStore.put(project);
      }
      for (const task of allTasks) {
        taskStore.put(task);
      }
      for (const conn of allConnections) {
        connStore.put(conn);
      }
      if (meta) {
        metaStore.put(meta, 'meta');
      }

      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });

      this.logger.info('数据库已从备份恢复', {
        backupDbName,
        projectCount: allProjects.length,
        taskCount: allTasks.length,
        connectionCount: allConnections.length
      });

      return true;
    } catch (err) {
      this.logger.error('从备份恢复失败', err);
      this.sentryLazyLoader.captureException(err, { tags: { operation: 'restoreFromBackup', backupDbName } });
      return false;
    }
  }

  /**
   * 获取所有备份列表
   */
  async listBackups(): Promise<Array<{ name: string; date: string }>> {
    try {
      const databases = await indexedDB.databases?.() || [];
      return databases
        .filter(d => d.name?.startsWith(BACKUP_CONFIG.DB_PREFIX))
        .map(d => ({
          name: d.name!,
          date: d.name!.replace(BACKUP_CONFIG.DB_PREFIX, '')
        }))
        .sort((a, b) => b.date.localeCompare(a.date));
    } catch (err) {
      this.logger.error('获取备份列表失败', err);
      return [];
    }
  }

  /**
   * 清理过期备份（保留 7 天）
   */
  private async cleanupOldBackups(): Promise<void> {
    try {
      const backups = await this.listBackups();
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - BACKUP_CONFIG.RETENTION_DAYS);
      const cutoffStr = cutoffDate.toISOString().split('T')[0].replace(/-/g, '');

      for (const backup of backups) {
        if (backup.date < cutoffStr) {
          await this.deleteBackup(backup.name);
        }
      }
    } catch (err) {
      this.logger.warn('清理过期备份失败', err);
    }
  }

  /**
   * 删除指定备份
   */
  async deleteBackup(backupDbName: string): Promise<boolean> {
    try {
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.deleteDatabase(backupDbName);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      });

      this.logger.info('备份已删除', { backupDbName });
      return true;
    } catch (err) {
      this.logger.error('删除备份失败', { backupDbName, error: err });
      return false;
    }
  }

  // ========== 辅助方法（用于读取备份数据库） ==========

  private async getAllFromBackupStore<T>(db: IDBDatabase, storeName: string): Promise<T[]> {
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, 'readonly');
      const store = transaction.objectStore(storeName);
      const request = store.getAll();

      request.onsuccess = () => resolve(request.result ?? []);
      request.onerror = () => reject(request.error);
    });
  }

  private async getFromBackupStore<T>(db: IDBDatabase, storeName: string, key: IDBValidKey): Promise<T | null> {
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, 'readonly');
      const store = transaction.objectStore(storeName);
      const request = store.get(key);

      request.onsuccess = () => resolve(request.result ?? null);
      request.onerror = () => reject(request.error);
    });
  }
}
