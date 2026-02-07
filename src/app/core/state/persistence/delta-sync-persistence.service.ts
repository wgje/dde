/**
 * Delta Sync Persistence Service
 * 
 * 职责：
 * - 增量同步（Delta Sync）支持
 * - 单任务保存/删除/合并
 * - 时间戳比较和增量更新查询
 * 
 * @see docs/plan_save.md Phase 2
 */
import { inject, Injectable } from '@angular/core';
import { SentryLazyLoaderService } from '../../../../services/sentry-lazy-loader.service';
import type { Task } from '../../../../models';
import { LoggerService } from '../../../../services/logger.service';
import { IndexedDBService, DB_CONFIG } from './indexeddb.service';

@Injectable({ providedIn: 'root' })
export class DeltaSyncPersistenceService {
  private readonly sentryLazyLoader = inject(SentryLazyLoaderService);
  private readonly indexedDBService = inject(IndexedDBService);
  private readonly logger = inject(LoggerService).category('DeltaSyncPersistence');

  /**
   * 从本地 IndexedDB 加载项目的所有任务
   * 
   * @param projectId 项目 ID
   * @returns 该项目的所有任务（包含已删除的）
   */
  async loadTasksFromLocal(projectId: string): Promise<Task[]> {
    try {
      const db = await this.indexedDBService.initDatabase();
      const tasks = await this.getByIndex<Task & { projectId: string }>(
        db, 
        DB_CONFIG.stores.tasks, 
        'projectId', 
        projectId
      );
      
      // 移除 projectId 属性（仅用于索引）
      return tasks.map(t => {
        const { projectId: _, ...task } = t;
        return task as Task;
      });
    } catch (err) {
      this.logger.error('加载本地任务失败', { projectId, error: err });
      this.sentryLazyLoader.captureException(err, { tags: { operation: 'loadTasksFromLocal', projectId } });
      return [];
    }
  }

  /**
   * 获取指定时间后更新的任务（Delta Sync）
   * 
   * 用于增量同步：只返回 updated_at > sinceTime 的任务
   * 
   * @param projectId 项目 ID
   * @param sinceTime ISO 时间字符串（例如 "2025-12-31T12:00:00Z"）
   * @returns 在 sinceTime 之后更新的活跃任务（排除软删除）
   * 
   * @see docs/plan_save.md Layer 2.2
   */
  async getTasksUpdatedSince(projectId: string, sinceTime: string): Promise<Task[]> {
    try {
      const allTasks = await this.loadTasksFromLocal(projectId);
      const sinceDate = new Date(sinceTime);  // 🔒 使用 Date 对象比较，避免时区问题
      
      return allTasks.filter(t => 
        t.updatedAt && new Date(t.updatedAt) > sinceDate && !t.deletedAt  // 🔒 过滤软删除
      );
    } catch (err) {
      this.logger.error('获取增量更新任务失败', { projectId, sinceTime, error: err });
      this.sentryLazyLoader.captureException(err, { tags: { operation: 'getTasksUpdatedSince', projectId } });
      return [];
    }
  }

  /**
   * 获取本地最新的 updated_at 时间戳
   * 
   * 用于 Delta Sync：确定从服务端拉取的起始时间点
   * 
   * @param projectId 项目 ID
   * @returns 最新时间戳，若无数据则返回 null（确保类型安全）
   * 
   * @see docs/plan_save.md Layer 2.2
   */
  async getLatestLocalTimestamp(projectId: string): Promise<string | null> {
    try {
      const tasks = await this.loadTasksFromLocal(projectId);
      if (tasks.length === 0) return null;
      
      // 🔒 过滤掉无 updatedAt 的任务，确保类型安全
      const tasksWithTimestamp = tasks.filter((t): t is Task & { updatedAt: string } => 
        typeof t.updatedAt === 'string' && t.updatedAt.length > 0
      );
      
      if (tasksWithTimestamp.length === 0) return null;
      
      // 按 updatedAt 降序排列，取最新
      tasksWithTimestamp.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      return tasksWithTimestamp[0].updatedAt;
    } catch (err) {
      this.logger.error('获取本地最新时间戳失败', { projectId, error: err });
      this.sentryLazyLoader.captureException(err, { tags: { operation: 'getLatestLocalTimestamp', projectId } });
      // eslint-disable-next-line no-restricted-syntax -- 返回 null 语义正确：时间戳获取失败使用全量同步
      return null;
    }
  }

  /**
   * 保存单个任务到本地 IndexedDB
   * 
   * 用于 Realtime 推送：收到服务端变更后立即持久化
   * 
   * @param task 要保存的任务
   * @param projectId 项目 ID（用于索引）
   */
  async saveTaskToLocal(task: Task, projectId: string): Promise<void> {
    try {
      const db = await this.indexedDBService.initDatabase();
      const transaction = db.transaction(DB_CONFIG.stores.tasks, 'readwrite');
      const store = transaction.objectStore(DB_CONFIG.stores.tasks);
      
      // 添加 projectId 用于索引
      store.put({ ...task, projectId });
      
      await new Promise<void>((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
      });
      
      this.logger.debug('任务已保存到本地', { taskId: task.id, projectId });
    } catch (err) {
      this.logger.error('保存任务到本地失败', { taskId: task.id, projectId, error: err });
      this.sentryLazyLoader.captureException(err, { tags: { operation: 'saveTaskToLocal', taskId: task.id, projectId } });
    }
  }

  /**
   * 从本地 IndexedDB 删除单个任务
   * 
   * 用于 Realtime 推送：收到 DELETE 事件后删除本地数据
   * 
   * @param taskId 任务 ID
   */
  async deleteTaskFromLocal(taskId: string): Promise<void> {
    try {
      const db = await this.indexedDBService.initDatabase();
      const transaction = db.transaction(DB_CONFIG.stores.tasks, 'readwrite');
      const store = transaction.objectStore(DB_CONFIG.stores.tasks);
      
      store.delete(taskId);
      
      await new Promise<void>((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
      });
      
      this.logger.debug('任务已从本地删除', { taskId });
    } catch (err) {
      this.logger.error('从本地删除任务失败', { taskId, error: err });
      this.sentryLazyLoader.captureException(err, { tags: { operation: 'deleteTaskFromLocal', taskId } });
    }
  }

  /**
   * 批量更新本地任务（Delta Sync 增量合并）
   * 
   * 用于 Delta Sync：将服务端增量数据合并到本地
   * 
   * @param tasks 要合并的任务列表
   * @param projectId 项目 ID
   */
  async bulkMergeTasksToLocal(tasks: Task[], projectId: string): Promise<void> {
    if (tasks.length === 0) return;
    
    try {
      const db = await this.indexedDBService.initDatabase();
      const transaction = db.transaction(DB_CONFIG.stores.tasks, 'readwrite');
      const store = transaction.objectStore(DB_CONFIG.stores.tasks);
      
      for (const task of tasks) {
        // 如果是软删除的任务，从本地删除
        if (task.deletedAt) {
          store.delete(task.id);
        } else {
          store.put({ ...task, projectId });
        }
      }
      
      await new Promise<void>((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
      });
      
      this.logger.debug('批量合并任务完成', { count: tasks.length, projectId });
    } catch (err) {
      this.logger.error('批量合并任务失败', { count: tasks.length, projectId, error: err });
      this.sentryLazyLoader.captureException(err, { tags: { operation: 'bulkMergeTasksToLocal', projectId } });
    }
  }

  // ========== 辅助方法 ==========
  
  private async getByIndex<T>(
    db: IDBDatabase, 
    storeName: string, 
    indexName: string, 
    key: IDBValidKey
  ): Promise<T[]> {
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, 'readonly');
      const store = transaction.objectStore(storeName);
      const index = store.index(indexName);
      const request = index.getAll(key);
      
      request.onsuccess = () => resolve(request.result ?? []);
      request.onerror = () => reject(request.error);
    });
  }
}
