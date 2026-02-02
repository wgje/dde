/**
 * Store 持久化服务
 * 
 * 职责：
 * - 将 Store 数据持久化到 IndexedDB
 * - 首屏加载时从本地恢复数据
 * - 后台静默同步，不阻塞 UI
 * 
 * 策略：
 * - 按项目分别持久化，避免全量读写
 * - 使用防抖减少写入频率
 * - 出错时静默降级，不影响运行时
 * 
 * Sprint 8 技术债务修复：提取 IndexedDBService 和 DataIntegrityService
 * 
 * @see .github/copilot-instructions.md 极简架构原则
 */

import { Injectable, inject, DestroyRef } from '@angular/core';
import { TaskStore, ProjectStore, ConnectionStore } from './stores';
import { LoggerService } from '../../../services/logger.service';
import { Project, Task, Connection } from '../../../models';
import { validateProject } from '../../../utils/validation';
// Sprint 8 技术债务修复：提取的子服务
import { IndexedDBService, DataIntegrityService, DB_CONFIG, BackupService, DeltaSyncPersistenceService } from './persistence';
import { SentryLazyLoaderService } from '../../../services/sentry-lazy-loader.service';

/** 存储版本号（用于数据迁移） */
const STORAGE_VERSION = 1;

/** 防抖延迟（毫秒） */
const DEBOUNCE_DELAY = 1000;

/**
 * 元数据结构
 */
interface StoreMeta {
  version: number;
  lastSyncTime: string;
  activeProjectId: string | null;
}

@Injectable({
  providedIn: 'root'
})
export class StorePersistenceService {
  private readonly taskStore = inject(TaskStore);
  private readonly projectStore = inject(ProjectStore);
  private readonly connectionStore = inject(ConnectionStore);
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('StorePersistence');
  private readonly destroyRef = inject(DestroyRef);
  
  // Sprint 8 技术债务修复：注入子服务
  private readonly indexedDBService = inject(IndexedDBService);
  private readonly dataIntegrity = inject(DataIntegrityService);
  private readonly backupService = inject(BackupService);
  private readonly deltaSyncPersistence = inject(DeltaSyncPersistenceService);
  private readonly sentryLazyLoader = inject(SentryLazyLoaderService);
  
  /** 防抖计时器 */
  private saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
  
  /** IndexedDB 数据库实例（委托给 IndexedDBService） */
  private get db(): IDBDatabase | null {
    return this.indexedDBService.getDatabase();
  }
  
  /** 是否正在恢复数据（避免循环保存） */
  private isRestoring = false;
  
  constructor() {
    // 初始化 IndexedDB（委托给子服务）
    this.initDatabase().catch(err => {
      this.logger.warn('IndexedDB 初始化失败，将使用内存存储', err);
    });
  }
  
  /**
   * 初始化 IndexedDB（委托给 IndexedDBService）
   */
  private async initDatabase(): Promise<IDBDatabase> {
    return this.indexedDBService.initDatabase();
  }
  
  /**
   * 保存项目数据到 IndexedDB（带防抖）
   */
  async saveProject(projectId: string): Promise<void> {
    // 恢复期间不保存
    if (this.isRestoring) return;
    
    // 防抖：取消之前的计时器
    const existingTimer = this.saveTimers.get(projectId);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }
    
    // 设置新计时器
    const timer = setTimeout(async () => {
      this.saveTimers.delete(projectId);
      await this.doSaveProject(projectId);
    }, DEBOUNCE_DELAY);
    
    this.saveTimers.set(projectId, timer);
  }
  
  /**
   * 实际执行保存
   */
  private async doSaveProject(projectId: string): Promise<void> {
    try {
      const db = await this.initDatabase();
      const project = this.projectStore.getProject(projectId);
      
      if (!project) {
        this.logger.warn('项目不存在，跳过保存', { projectId });
        return;
      }
      
      const tasks = this.taskStore.getTasksByProject(projectId);
      const connections = this.connectionStore.getConnectionsByProject(projectId);
      
      // 使用事务批量写入
      const transaction = db.transaction(
        [DB_CONFIG.stores.projects, DB_CONFIG.stores.tasks, DB_CONFIG.stores.connections],
        'readwrite'
      );
      
      const projectStore = transaction.objectStore(DB_CONFIG.stores.projects);
      const taskStore = transaction.objectStore(DB_CONFIG.stores.tasks);
      const connectionStore = transaction.objectStore(DB_CONFIG.stores.connections);
      
      // 保存项目
      projectStore.put(project);
      
      // 保存任务（带 projectId 索引）
      for (const task of tasks) {
        taskStore.put({ ...task, projectId });
      }
      
      // 保存连接（带 projectId 索引）
      for (const connection of connections) {
        connectionStore.put({ ...connection, projectId });
      }
      
      await new Promise<void>((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
      });
      
      // 【v5.8 新增】写入后完整性校验
      const verifyResult = await this.verifyWriteIntegrity(db, projectId, tasks.length, connections.length);
      if (!verifyResult.valid) {
        this.logger.error('IndexedDB 写入校验失败', { 
          projectId, 
          expected: { tasks: tasks.length, connections: connections.length },
          actual: verifyResult.actual,
          errors: verifyResult.errors
        });
        
        // 【Senior Consultant P1】自动重试一次
        this.logger.info('IndexedDB 写入校验失败，尝试重试...', { projectId });
        const retrySuccess = await this.retryWriteOnce(projectId, project, tasks, connections);
        
        if (!retrySuccess) {
          // 【降级策略】写入 localStorage 作为备份
          this.logger.warn('IndexedDB 重试失败，降级到 localStorage 备份', { projectId });
          this.fallbackToLocalStorage(projectId, project, tasks, connections);
        }
        
        this.sentryLazyLoader.captureMessage('IndexedDB 写入校验失败', {
          level: 'error',
          tags: { operation: 'writeIntegrityCheck', projectId, retried: String(retrySuccess) },
          extra: { 
            expected: { tasks: tasks.length, connections: connections.length },
            actual: verifyResult.actual,
            errors: verifyResult.errors
          }
        });
        return;
      }
      
      this.logger.debug('项目数据已保存', { 
        projectId, 
        tasksCount: tasks.length, 
        connectionsCount: connections.length,
        verified: verifyResult.valid
      });
    } catch (err) {
      this.logger.error('保存项目数据失败', { projectId, error: err });
      this.sentryLazyLoader.captureException(err, { tags: { operation: 'saveProjectData', projectId } });
      // 【Senior Consultant P1】降级到 localStorage
      const project = this.projectStore.getProject(projectId);
      const tasks = this.taskStore.getTasksByProject(projectId);
      const connections = this.connectionStore.getConnectionsByProject(projectId);
      if (project) {
        this.fallbackToLocalStorage(projectId, project, tasks, connections);
      }
    }
  }
  
  /**
   * 【Senior Consultant P1】重试写入一次
   */
  private async retryWriteOnce(
    projectId: string,
    project: Project,
    tasks: Task[],
    connections: Connection[]
  ): Promise<boolean> {
    try {
      const db = await this.initDatabase();
      
      const transaction = db.transaction(
        [DB_CONFIG.stores.projects, DB_CONFIG.stores.tasks, DB_CONFIG.stores.connections],
        'readwrite'
      );
      
      const projectStore = transaction.objectStore(DB_CONFIG.stores.projects);
      const taskStore = transaction.objectStore(DB_CONFIG.stores.tasks);
      const connectionStore = transaction.objectStore(DB_CONFIG.stores.connections);
      
      // 清除旧数据后重写
      projectStore.put(project);
      for (const task of tasks) {
        taskStore.put({ ...task, projectId });
      }
      for (const connection of connections) {
        connectionStore.put({ ...connection, projectId });
      }
      
      await new Promise<void>((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
      });
      
      // 再次验证
      const verifyResult = await this.verifyWriteIntegrity(db, projectId, tasks.length, connections.length);
      if (verifyResult.valid) {
        this.logger.info('IndexedDB 重试写入成功', { projectId });
        return true;
      }
      
      return false;
    } catch (err) {
      this.logger.error('IndexedDB 重试写入失败', { projectId, error: err });
      return false;
    }
  }
  
  /**
   * 【Senior Consultant P1】降级到 localStorage 备份
   */
  private fallbackToLocalStorage(
    projectId: string,
    project: Project,
    tasks: Task[],
    connections: Connection[]
  ): void {
    if (typeof localStorage === 'undefined') return;
    
    const FALLBACK_KEY = `nanoflow.idb-fallback.${projectId}`;
    
    try {
      const fallbackData = {
        version: 1,
        timestamp: new Date().toISOString(),
        project,
        tasks,
        connections
      };
      
      localStorage.setItem(FALLBACK_KEY, JSON.stringify(fallbackData));
      this.logger.info('已降级保存到 localStorage', { 
        projectId, 
        tasksCount: tasks.length,
        connectionsCount: connections.length
      });
    } catch (e) {
      this.logger.error('localStorage 降级保存也失败', { projectId, error: e });
      this.sentryLazyLoader.captureException(e, { 
        tags: { operation: 'fallbackToLocalStorage', projectId },
        level: 'fatal'
      });
    }
  }
  
  /**
   * 【v5.8 新增】验证 IndexedDB 写入完整性
   * 回读数据确保写入成功
   */
  private async verifyWriteIntegrity(
    db: IDBDatabase, 
    projectId: string, 
    expectedTaskCount: number, 
    expectedConnectionCount: number
  ): Promise<{ valid: boolean; actual: { tasks: number; connections: number }; errors: string[] }> {
    const errors: string[] = [];
    
    try {
      const transaction = db.transaction(
        [DB_CONFIG.stores.projects, DB_CONFIG.stores.tasks, DB_CONFIG.stores.connections],
        'readonly'
      );
      
      const projectStore = transaction.objectStore(DB_CONFIG.stores.projects);
      const taskStore = transaction.objectStore(DB_CONFIG.stores.tasks);
      const connectionStore = transaction.objectStore(DB_CONFIG.stores.connections);
      
      // 1. 验证项目存在
      const savedProject = await new Promise<Project | undefined>((resolve, reject) => {
        const request = projectStore.get(projectId);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      
      if (!savedProject) {
        errors.push('项目未成功写入');
      } else if (!savedProject.id || !savedProject.name) {
        errors.push('项目关键字段丢失');
      }
      
      // 2. 验证任务数量（使用索引计数）
      const taskIndex = taskStore.index('projectId');
      const savedTaskCount = await new Promise<number>((resolve, reject) => {
        const request = taskIndex.count(IDBKeyRange.only(projectId));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      
      if (savedTaskCount !== expectedTaskCount) {
        errors.push(`任务数量不匹配：期望 ${expectedTaskCount}，实际 ${savedTaskCount}`);
      }
      
      // 3. 验证连接数量（使用索引计数）
      const connectionIndex = connectionStore.index('projectId');
      const savedConnectionCount = await new Promise<number>((resolve, reject) => {
        const request = connectionIndex.count(IDBKeyRange.only(projectId));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      
      if (savedConnectionCount !== expectedConnectionCount) {
        errors.push(`连接数量不匹配：期望 ${expectedConnectionCount}，实际 ${savedConnectionCount}`);
      }
      
      return {
        valid: errors.length === 0,
        actual: { tasks: savedTaskCount, connections: savedConnectionCount },
        errors
      };
    } catch (err) {
      errors.push(`读取验证失败: ${err instanceof Error ? err.message : String(err)}`);
      return {
        valid: false,
        actual: { tasks: -1, connections: -1 },
        errors
      };
    }
  }
  
  /**
   * 保存所有项目数据
   */
  async saveAllProjects(): Promise<void> {
    const projects = this.projectStore.projects();
    for (const project of projects) {
      await this.doSaveProject(project.id);
    }
  }
  
  /**
   * 保存元数据
   */
  async saveMeta(): Promise<void> {
    if (this.isRestoring) return;
    
    try {
      const db = await this.initDatabase();
      const meta: StoreMeta = {
        version: STORAGE_VERSION,
        lastSyncTime: new Date().toISOString(),
        activeProjectId: this.projectStore.activeProjectId()
      };
      
      const transaction = db.transaction(DB_CONFIG.stores.meta, 'readwrite');
      const store = transaction.objectStore(DB_CONFIG.stores.meta);
      store.put(meta, 'meta');
      
      await new Promise<void>((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
      });
    } catch (err) {
      this.logger.error('保存元数据失败', err);
      this.sentryLazyLoader.captureException(err, { tags: { operation: 'saveMeta' } });
    }
  }
  
  /**
   * 从 IndexedDB 恢复项目数据
   * 
   * 【Week 2 增强】添加 schema 验证，防止损坏的缓存导致运行时异常
   * 验证失败时：
   * - Critical 错误：返回 false，让调用者从云端拉取新数据
   * - 警告：尝试修复并继续加载
   */
  async loadProject(projectId: string): Promise<boolean> {
    try {
      const db = await this.initDatabase();
      this.isRestoring = true;
      
      // 读取项目
      const project = await this.getFromStore<Project>(db, DB_CONFIG.stores.projects, projectId);
      if (!project) {
        this.logger.debug('本地无缓存项目', { projectId });
        return false;
      }
      
      // 读取任务
      const tasks = await this.getByIndex<Task & { projectId: string }>(
        db, 
        DB_CONFIG.stores.tasks, 
        'projectId', 
        projectId
      );
      
      // 读取连接
      const connections = await this.getByIndex<Connection & { projectId: string }>(
        db, 
        DB_CONFIG.stores.connections, 
        'projectId', 
        projectId
      );
      
      // 【Week 2 - Schema 验证】验证恢复的数据完整性
      // 组装完整项目用于验证
      const fullProject: Partial<Project> = {
        ...project,
        tasks: tasks.map(t => {
          const { projectId: _, ...task } = t;
          return task as Task;
        }),
        connections: connections.map(c => {
          const { projectId: _, ...conn } = c;
          return conn as Connection;
        })
      };
      
      const validation = validateProject(fullProject);
      
      // 记录验证结果
      if (validation.warnings.length > 0) {
        this.logger.warn('项目数据验证警告', { 
          projectId, 
          warnings: validation.warnings.slice(0, 10) // 只记录前 10 个警告
        });
      }
      
      if (!validation.valid) {
        // Critical 验证失败 - 返回 false，让调用者从云端重新获取
        this.logger.error('项目数据验证失败，缓存可能已损坏', { 
          projectId, 
          errors: validation.errors.slice(0, 10)
        });
        this.sentryLazyLoader.captureMessage('IndexedDB 缓存数据验证失败', {
          level: 'error',
          tags: { operation: 'loadProject', projectId },
          extra: { errors: validation.errors }
        });
        // 清理损坏的缓存
        await this.deleteProject(projectId);
        return false;
      }
      
      // 恢复到 Store
      this.projectStore.setProject(project);
      
      // 【关键修复】过滤已删除的任务，防止从 IndexedDB 恢复时复活已删除任务
      // 只恢复 deletedAt 为空的任务
      const activeTasks = tasks.filter(t => !t.deletedAt);
      const filteredCount = tasks.length - activeTasks.length;
      if (filteredCount > 0) {
        this.logger.debug('已过滤已删除任务', { projectId, filteredCount });
      }
      
      this.taskStore.setTasks(activeTasks.map(t => {
        const { projectId: _, ...task } = t;
        return task as Task;
      }), projectId);
      this.connectionStore.setConnections(connections.map(c => {
        const { projectId: _, ...conn } = c;
        return conn as Connection;
      }), projectId);
      
      this.logger.info('项目数据已从本地恢复', { 
        projectId, 
        tasksCount: activeTasks.length, 
        connectionsCount: connections.length 
      });
      
      return true;
    } catch (err) {
      this.logger.error('恢复项目数据失败', { projectId, error: err });
      this.sentryLazyLoader.captureException(err, { tags: { operation: 'loadProject', projectId } });
      return false;
    } finally {
      this.isRestoring = false;
    }
  }
  
  /**
   * 恢复所有项目列表（仅项目元数据）
   */
  async loadAllProjects(): Promise<Project[]> {
    try {
      const db = await this.initDatabase();
      const projects = await this.getAllFromStore<Project>(db, DB_CONFIG.stores.projects);
      
      this.logger.debug('已加载项目列表', { count: projects.length });
      return projects;
    } catch (err) {
      this.logger.error('加载项目列表失败', err);
      return [];
    }
  }
  
  /**
   * 恢复元数据
   */
  async loadMeta(): Promise<StoreMeta | null> {
    try {
      const db = await this.initDatabase();
      const meta = await this.getFromStore<StoreMeta>(db, DB_CONFIG.stores.meta, 'meta');
      return meta;
    } catch (err) {
      this.logger.error('加载元数据失败', err);
      return null;
    }
  }
  
  /**
   * 【新增】获取上次活动的项目 ID
   * 
   * 来自高级顾问建议：
   * - 恢复用户上次打开的项目，提升体验
   * - 如果该项目已被删除，自动回退到第一个可用项目
   * 
   * @param availableProjectIds 当前可用的项目 ID 列表
   * @returns 有效的 activeProjectId 或 null
   */
  async getLastActiveProjectId(availableProjectIds: string[]): Promise<string | null> {
    try {
      const meta = await this.loadMeta();
      const lastActiveId = meta?.activeProjectId;
      
      if (!lastActiveId) {
        this.logger.debug('没有保存的 lastActiveProjectId');
        return availableProjectIds[0] ?? null;
      }
      
      // 检查该项目是否仍然存在
      if (availableProjectIds.includes(lastActiveId)) {
        this.logger.debug('恢复上次活动项目', { projectId: lastActiveId });
        return lastActiveId;
      }
      
      // 项目已被删除（可能在其他设备上）
      this.logger.info('上次活动的项目已不存在，回退到第一个可用项目', { 
        lastActiveId, 
        availableCount: availableProjectIds.length 
      });
      return availableProjectIds[0] ?? null;
    } catch (err) {
      this.logger.error('获取 lastActiveProjectId 失败', err);
      return availableProjectIds[0] ?? null;
    }
  }
  
  /**
   * 【新增】保存当前活动项目 ID（立即保存，不防抖）
   */
  async saveActiveProjectId(projectId: string | null): Promise<void> {
    if (this.isRestoring) return;
    
    try {
      const db = await this.initDatabase();
      const existingMeta = await this.getFromStore<StoreMeta>(db, DB_CONFIG.stores.meta, 'meta');
      
      const meta: StoreMeta = {
        version: existingMeta?.version ?? STORAGE_VERSION,
        lastSyncTime: existingMeta?.lastSyncTime ?? new Date().toISOString(),
        activeProjectId: projectId
      };
      
      const transaction = db.transaction(DB_CONFIG.stores.meta, 'readwrite');
      const store = transaction.objectStore(DB_CONFIG.stores.meta);
      store.put(meta, 'meta');
      
      await new Promise<void>((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
      });
      
      this.logger.debug('activeProjectId 已保存', { projectId });
    } catch (err) {
      this.logger.error('保存 activeProjectId 失败', err);
    }
  }
  
  /**
   * 删除项目的本地缓存
   */
  async deleteProject(projectId: string): Promise<void> {
    try {
      const db = await this.initDatabase();
      
      const transaction = db.transaction(
        [DB_CONFIG.stores.projects, DB_CONFIG.stores.tasks, DB_CONFIG.stores.connections],
        'readwrite'
      );
      
      // 删除项目
      transaction.objectStore(DB_CONFIG.stores.projects).delete(projectId);
      
      // 删除相关任务
      const taskStore = transaction.objectStore(DB_CONFIG.stores.tasks);
      const taskIndex = taskStore.index('projectId');
      const taskKeys = await new Promise<IDBValidKey[]>((resolve, reject) => {
        const request = taskIndex.getAllKeys(projectId);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      for (const key of taskKeys) {
        taskStore.delete(key);
      }
      
      // 删除相关连接
      const connStore = transaction.objectStore(DB_CONFIG.stores.connections);
      const connIndex = connStore.index('projectId');
      const connKeys = await new Promise<IDBValidKey[]>((resolve, reject) => {
        const request = connIndex.getAllKeys(projectId);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      for (const key of connKeys) {
        connStore.delete(key);
      }
      
      await new Promise<void>((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
      });
      
      this.logger.info('项目本地缓存已删除', { projectId });
    } catch (err) {
      this.logger.error('删除项目缓存失败', { projectId, error: err });
    }
  }
  
  /**
   * 清除所有本地缓存
   */
  async clearAll(): Promise<void> {
    try {
      const db = await this.initDatabase();
      
      const transaction = db.transaction(
        [DB_CONFIG.stores.projects, DB_CONFIG.stores.tasks, DB_CONFIG.stores.connections, DB_CONFIG.stores.meta],
        'readwrite'
      );
      
      transaction.objectStore(DB_CONFIG.stores.projects).clear();
      transaction.objectStore(DB_CONFIG.stores.tasks).clear();
      transaction.objectStore(DB_CONFIG.stores.connections).clear();
      transaction.objectStore(DB_CONFIG.stores.meta).clear();
      
      await new Promise<void>((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
      });
      
      this.logger.info('所有本地缓存已清除');
    } catch (err) {
      this.logger.error('清除缓存失败', err);
    }
  }
  
  // ========== 辅助方法 ==========
  
  private async getFromStore<T>(db: IDBDatabase, storeName: string, key: IDBValidKey): Promise<T | null> {
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, 'readonly');
      const store = transaction.objectStore(storeName);
      const request = store.get(key);
      
      request.onsuccess = () => resolve(request.result ?? null);
      request.onerror = () => reject(request.error);
    });
  }
  
  private async getAllFromStore<T>(db: IDBDatabase, storeName: string): Promise<T[]> {
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, 'readonly');
      const store = transaction.objectStore(storeName);
      const request = store.getAll();
      
      request.onsuccess = () => resolve(request.result ?? []);
      request.onerror = () => reject(request.error);
    });
  }
  
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

  // ==================== Delta Sync 支持 ====================

  /** 从本地加载任务 */
  async loadTasksFromLocal(projectId: string): Promise<Task[]> {
    return this.deltaSyncPersistence.loadTasksFromLocal(projectId);
  }

  /** 获取指定时间后更新的任务 */
  async getTasksUpdatedSince(projectId: string, sinceTime: string): Promise<Task[]> {
    return this.deltaSyncPersistence.getTasksUpdatedSince(projectId, sinceTime);
  }

  /** 获取本地最新时间戳 */
  async getLatestLocalTimestamp(projectId: string): Promise<string | null> {
    return this.deltaSyncPersistence.getLatestLocalTimestamp(projectId);
  }

  /** 保存单个任务到本地 */
  async saveTaskToLocal(task: Task, projectId: string): Promise<void> {
    return this.deltaSyncPersistence.saveTaskToLocal(task, projectId);
  }

  /** 从本地删除单个任务 */
  async deleteTaskFromLocal(taskId: string): Promise<void> {
    return this.deltaSyncPersistence.deleteTaskFromLocal(taskId);
  }

  /** 批量更新本地任务 */
  async bulkMergeTasksToLocal(tasks: Task[], projectId: string): Promise<void> {
    return this.deltaSyncPersistence.bulkMergeTasksToLocal(tasks, projectId);
  }

  // ==================== 离线数据完整性校验 ====================

  /** 验证离线数据完整性 */
  async validateOfflineDataIntegrity(): Promise<{
    valid: boolean;
    issues: Array<{ type: string; entityId: string; projectId?: string; message: string; severity: 'error' | 'warning'; }>;
    stats: { projectCount: number; taskCount: number; connectionCount: number; orphanedTasks: number; brokenConnections: number; };
  }> {
    return this.dataIntegrity.validateOfflineDataIntegrity();
  }
  
  /** 清理孤立数据 */
  async cleanupOrphanedData(): Promise<{ removedTasks: number; removedConnections: number }> {
    return this.dataIntegrity.cleanupOrphanedData();
  }

  // ==================== 备份服务 ====================

  /** 创建数据库备份 */
  async createBackup(): Promise<string | null> { return this.backupService.createBackup(); }
  /** 从备份恢复 */
  async restoreFromBackup(backupDbName: string): Promise<boolean> { return this.backupService.restoreFromBackup(backupDbName); }
  /** 列出所有备份 */
  async listBackups(): Promise<Array<{ name: string; date: string }>> { return this.backupService.listBackups(); }
  /** 删除备份 */
  async deleteBackup(backupDbName: string): Promise<boolean> { return this.backupService.deleteBackup(backupDbName); }
}

// 类型定义导出从 persistence/types.ts
export type { OfflineIntegrityResult, OfflineIntegrityIssue } from './persistence/types';