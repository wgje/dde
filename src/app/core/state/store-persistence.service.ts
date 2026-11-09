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
import { IndexedDBService, DataIntegrityService, DB_CONFIG, BackupService, DeltaSyncPersistenceService } from './persistence';
import { SentryLazyLoaderService } from '../../../services/sentry-lazy-loader.service';
import { StoreMetadataPersistenceController, type StoreMeta } from './store-metadata-persistence.controller';
import { StoreCacheCleanupController } from './store-cache-cleanup.controller';
import {
  recoverInterruptedDataSafetyRestoreFromIndexedDb,
  type IndexedDbDataSafetyRestoreRecoveryResult,
} from '../../../services/data-safety-indexeddb-adapter';
import {
  readStorePersistenceFallback,
  removeStorePersistenceFallback,
  shouldPreferStorePersistenceFallback,
  writeStorePersistenceFallback,
  type ProjectPersistenceSnapshot,
} from './store-persistence-fallback';

/** 防抖延迟（毫秒） */
const DEBOUNCE_DELAY = 1000;

interface ProjectPersistenceStores {
  projectStore: IDBObjectStore;
  taskStore: IDBObjectStore;
  connectionStore: IDBObjectStore;
}

interface WriteVerifyResult {
  valid: boolean;
  actual: { tasks: number; connections: number };
  errors: string[];
}

interface LoadedProjectRecords {
  project: Project;
  tasks: Array<Task & { projectId: string }>;
  connections: Array<Connection & { projectId: string }>;
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
  private readonly metadataPersistence = new StoreMetadataPersistenceController({
    initDatabase: () => this.initDatabase(),
    isRestoring: () => this.isRestoring,
    activeProjectId: () => this.projectStore.activeProjectId(),
    logger: this.logger,
    sentryLazyLoader: this.sentryLazyLoader,
  });
  private readonly cacheCleanup = new StoreCacheCleanupController({
    initDatabase: () => this.initDatabase(),
    logger: this.logger,
  });
  
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
    
    // 【P2-04 修复】服务销毁时清理所有防抖计时器
    this.destroyRef.onDestroy(() => {
      for (const timer of this.saveTimers.values()) {
        clearTimeout(timer);
      }
      this.saveTimers.clear();
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
    if (this.saveTimers.has(projectId)) {
      const existingTimer = this.saveTimers.get(projectId)!;
      clearTimeout(existingTimer);
    }
    
    // 设置新计时器
    const timer = setTimeout(async () => {
      if (this.saveTimers.get(projectId) !== timer) {
        return;
      }

      this.saveTimers.delete(projectId);
      try {
        await this.doSaveProject(projectId);
      } catch (error) {
        this.logger.error('防抖保存项目失败', { projectId, error });
      }
    }, DEBOUNCE_DELAY);
    
    this.saveTimers.set(projectId, timer);
  }
  
  /**
   * 实际执行保存
   */
  private async doSaveProject(projectId: string): Promise<void> {
    try {
      const db = await this.initDatabase();
      const snapshot = this.getProjectPersistenceSnapshot(projectId);
      if (!snapshot) return;

      await this.writeProjectSnapshot(db, projectId, snapshot, true);
      const verifyResult = await this.verifyWriteIntegrity(
        db,
        projectId,
        snapshot.tasks.length,
        snapshot.connections.length
      );
      if (!verifyResult.valid) {
        await this.handleWriteIntegrityFailure(db, projectId, snapshot, verifyResult);
        return;
      }

      removeStorePersistenceFallback(projectId);
      this.logger.debug('项目数据已保存', { 
        projectId, 
        tasksCount: snapshot.tasks.length,
        connectionsCount: snapshot.connections.length,
        verified: verifyResult.valid
      });
    } catch (err) {
      this.handleSaveProjectError(projectId, err);
    }
  }

  private getProjectPersistenceSnapshot(projectId: string): ProjectPersistenceSnapshot | null {
    const project = this.projectStore.getProject(projectId);
    if (!project) {
      this.logger.warn('项目不存在，跳过保存', { projectId });
      return null;
    }

    return {
      project,
      tasks: this.taskStore.getTasksByProject(projectId),
      connections: this.connectionStore.getConnectionsByProject(projectId),
    };
  }

  private async writeProjectSnapshot(
    db: IDBDatabase,
    projectId: string,
    snapshot: ProjectPersistenceSnapshot,
    pruneStaleRecords: boolean,
  ): Promise<void> {
    const transaction = db.transaction(
      [DB_CONFIG.stores.projects, DB_CONFIG.stores.tasks, DB_CONFIG.stores.connections],
      'readwrite'
    );
    const stores = this.getProjectPersistenceStores(transaction);

    stores.projectStore.put(snapshot.project);
    if (pruneStaleRecords) {
      this.pruneStaleProjectRecords(projectId, snapshot, stores);
    }
    this.putProjectChildRecords(projectId, snapshot, stores);
    await this.waitForTransaction(transaction);
  }

  private getProjectPersistenceStores(transaction: IDBTransaction): ProjectPersistenceStores {
    return {
      projectStore: transaction.objectStore(DB_CONFIG.stores.projects),
      taskStore: transaction.objectStore(DB_CONFIG.stores.tasks),
      connectionStore: transaction.objectStore(DB_CONFIG.stores.connections),
    };
  }

  private pruneStaleProjectRecords(
    projectId: string,
    snapshot: ProjectPersistenceSnapshot,
    stores: ProjectPersistenceStores,
  ): void {
    const taskIds = new Set(snapshot.tasks.map(t => t.id));
    const connIds = new Set(snapshot.connections.map(c => c.id));
    this.deleteRecordsMissingFromSnapshot(stores.taskStore, projectId, taskIds);
    this.deleteRecordsMissingFromSnapshot(stores.connectionStore, projectId, connIds);
  }

  private deleteRecordsMissingFromSnapshot(
    store: IDBObjectStore,
    projectId: string,
    retainedIds: Set<string>,
  ): void {
    const cursorRequest = store.index('projectId').openCursor(IDBKeyRange.only(projectId));
    cursorRequest.onsuccess = (event) => {
      const cursor = (event.target as IDBRequest<IDBCursorWithValue | null>).result;
      if (!cursor) return;
      if (!retainedIds.has(cursor.value.id)) {
        cursor.delete();
      }
      cursor.continue();
    };
  }

  private putProjectChildRecords(
    projectId: string,
    snapshot: ProjectPersistenceSnapshot,
    stores: ProjectPersistenceStores,
  ): void {
    for (const task of snapshot.tasks) {
      stores.taskStore.put({ ...task, projectId });
    }
    for (const connection of snapshot.connections) {
      stores.connectionStore.put({ ...connection, projectId });
    }
  }

  private waitForTransaction(transaction: IDBTransaction): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  }

  private async handleWriteIntegrityFailure(
    db: IDBDatabase,
    projectId: string,
    snapshot: ProjectPersistenceSnapshot,
    verifyResult: WriteVerifyResult,
  ): Promise<void> {
    const expected = { tasks: snapshot.tasks.length, connections: snapshot.connections.length };
    this.logger.error('IndexedDB 写入校验失败', { projectId, expected, actual: verifyResult.actual, errors: verifyResult.errors });
    this.logger.info('IndexedDB 写入校验失败，尝试重试...', { projectId });
    const retrySuccess = await this.retryWriteOnce(projectId, snapshot.project, snapshot.tasks, snapshot.connections);

    if (!retrySuccess) {
      this.logger.warn('IndexedDB 重试失败，降级到 localStorage 备份', { projectId });
      this.fallbackToLocalStorage(projectId, snapshot.project, snapshot.tasks, snapshot.connections);
    }

    this.sentryLazyLoader.captureMessage('IndexedDB 写入校验失败', {
      level: 'error',
      tags: { operation: 'writeIntegrityCheck', projectId, retried: String(retrySuccess) },
      extra: { expected, actual: verifyResult.actual, errors: verifyResult.errors }
    });
  }

  private handleSaveProjectError(projectId: string, error: unknown): void {
    this.logger.error('保存项目数据失败', { projectId, error });
    this.sentryLazyLoader.captureException(error, { tags: { operation: 'saveProjectData', projectId } });
    const snapshot = this.getProjectPersistenceSnapshot(projectId);
    if (snapshot) {
      this.fallbackToLocalStorage(projectId, snapshot.project, snapshot.tasks, snapshot.connections);
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
      await this.writeProjectSnapshot(db, projectId, { project, tasks, connections }, false);
      const verifyResult = await this.verifyWriteIntegrity(db, projectId, tasks.length, connections.length);
      if (verifyResult.valid) {
        removeStorePersistenceFallback(projectId);
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
    try {
      writeStorePersistenceFallback(projectId, { project, tasks, connections });
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
  ): Promise<WriteVerifyResult> {
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
      await this.verifySavedProject(projectStore, projectId, errors);
      
      // 2. 验证任务数量（使用索引计数）
      const savedTaskCount = await this.countProjectIndexedRecords(taskStore, projectId);
      this.recordCountMismatch(errors, '任务', expectedTaskCount, savedTaskCount);
      
      // 3. 验证连接数量（使用索引计数）
      const savedConnectionCount = await this.countProjectIndexedRecords(connectionStore, projectId);
      this.recordCountMismatch(errors, '连接', expectedConnectionCount, savedConnectionCount);
      
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

  private async verifySavedProject(
    projectStore: IDBObjectStore,
    projectId: string,
    errors: string[],
  ): Promise<void> {
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
  }

  private countProjectIndexedRecords(store: IDBObjectStore, projectId: string): Promise<number> {
    const index = store.index('projectId');
    return new Promise<number>((resolve, reject) => {
      const request = index.count(IDBKeyRange.only(projectId));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  private recordCountMismatch(errors: string[], label: '任务' | '连接', expected: number, actual: number): void {
    if (actual !== expected) {
      errors.push(`${label}数量不匹配：期望 ${expected}，实际 ${actual}`);
    }
  }
  
  /**
   * 保存所有项目数据
   */
  private isSavingAll = false;
  async saveAllProjects(): Promise<void> {
    // 【P3-02 修复】防止并发调用（如关闭标签页时重复触发）
    if (this.isSavingAll) return;
    this.isSavingAll = true;
    try {
      const projects = this.projectStore.projects();
      for (const project of projects) {
        await this.doSaveProject(project.id);
      }
    } finally {
      this.isSavingAll = false;
    }
  }
  
  /**
   * 保存元数据
   */
  async saveMeta(): Promise<void> {
    return this.metadataPersistence.saveMeta();
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
    const fallbackSnapshot = readStorePersistenceFallback(projectId);
    try {
      const db = await this.initDatabase();
      this.isRestoring = true;

      const records = await this.loadProjectRecords(db, projectId);
      if (
        fallbackSnapshot
        && (!records || shouldPreferStorePersistenceFallback(fallbackSnapshot, records.project))
        && await this.restoreProjectFromFallback(projectId, fallbackSnapshot)
      ) {
        return true;
      }
      if (!records) {
        this.logger.debug('本地无缓存项目', { projectId });
        return false;
      }

      if (!await this.validateLoadedProject(projectId, records)) {
        if (fallbackSnapshot && await this.restoreProjectFromFallback(projectId, fallbackSnapshot)) {
          return true;
        }
        await this.deleteProject(projectId);
        return false;
      }

      this.restoreProjectRecordsToStores(projectId, records);
      removeStorePersistenceFallback(projectId);
      return true;
    } catch (err) {
      this.logger.error('恢复项目数据失败', { projectId, error: err });
      this.sentryLazyLoader.captureException(err, { tags: { operation: 'loadProject', projectId } });
      return fallbackSnapshot
        ? await this.restoreProjectFromFallback(projectId, fallbackSnapshot)
        : false;
    } finally {
      this.isRestoring = false;
    }
  }

  private async restoreProjectFromFallback(
    projectId: string,
    snapshot: ProjectPersistenceSnapshot,
  ): Promise<boolean> {
    const records: LoadedProjectRecords = {
      project: snapshot.project,
      tasks: snapshot.tasks.map(task => ({ ...task, projectId })),
      connections: snapshot.connections.map(connection => ({ ...connection, projectId })),
    };
    if (!await this.validateLoadedProject(projectId, records)) return false;

    this.restoreProjectRecordsToStores(projectId, records);
    this.logger.warn('IndexedDB 不可用或快照较旧，已从 localStorage fallback 恢复项目', {
      projectId,
      tasksCount: records.tasks.length,
      connectionsCount: records.connections.length,
    });
    return true;
  }

  private async loadProjectRecords(db: IDBDatabase, projectId: string): Promise<LoadedProjectRecords | null> {
    const project = await this.getFromStore<Project>(db, DB_CONFIG.stores.projects, projectId);
    if (!project) return null;

    const tasks = await this.getByIndex<Task & { projectId: string }>(
      db,
      DB_CONFIG.stores.tasks,
      'projectId',
      projectId
    );
    const connections = await this.getByIndex<Connection & { projectId: string }>(
      db,
      DB_CONFIG.stores.connections,
      'projectId',
      projectId
    );
    return { project, tasks, connections };
  }

  private async validateLoadedProject(projectId: string, records: LoadedProjectRecords): Promise<boolean> {
    const validation = validateProject({
      ...records.project,
      tasks: this.stripProjectIdFromTasks(records.tasks),
      connections: this.stripProjectIdFromConnections(records.connections)
    });

    if (validation.warnings.length > 0) {
      this.logger.warn('项目数据验证警告', {
        projectId,
        warnings: validation.warnings.slice(0, 10)
      });
    }

    if (validation.valid) return true;

    this.logger.error('项目数据验证失败，缓存可能已损坏', {
      projectId,
      errors: validation.errors.slice(0, 10)
    });
    this.sentryLazyLoader.captureMessage('IndexedDB 缓存数据验证失败', {
      level: 'error',
      tags: { operation: 'loadProject', projectId },
      extra: { errors: validation.errors }
    });
    return false;
  }

  private restoreProjectRecordsToStores(projectId: string, records: LoadedProjectRecords): void {
    this.projectStore.setProject(records.project);

    const restoredTasks = records.tasks;
    const deletedTaskCount = restoredTasks.filter(t => t.deletedAt).length;
    if (deletedTaskCount > 0) {
      this.logger.debug('本地恢复保留回收站任务', { projectId, deletedTaskCount });
    }

    const activeConnections = this.getActiveLoadedConnections(restoredTasks, records.connections);
    const filteredConnCount = records.connections.length - activeConnections.length;
    if (filteredConnCount > 0) {
      this.logger.debug('已过滤已删除连接', { projectId, filteredConnCount });
    }

    this.taskStore.setTasks(this.stripProjectIdFromTasks(restoredTasks), projectId);
    this.connectionStore.setConnections(this.stripProjectIdFromConnections(activeConnections), projectId);
    this.logger.info('项目数据已从本地恢复', {
      projectId,
      tasksCount: restoredTasks.length,
      connectionsCount: records.connections.length
    });
  }

  private getActiveLoadedConnections(
    tasks: Array<Task & { projectId: string }>,
    connections: Array<Connection & { projectId: string }>,
  ): Array<Connection & { projectId: string }> {
    const activeTaskIds = new Set(tasks.filter(t => !t.deletedAt).map(t => t.id));
    return connections.filter(c => !c.deletedAt && activeTaskIds.has(c.source) && activeTaskIds.has(c.target));
  }

  private stripProjectIdFromTasks(tasks: Array<Task & { projectId: string }>): Task[] {
    return tasks.map(t => {
      const { projectId: _, ...task } = t;
      return task as Task;
    });
  }

  private stripProjectIdFromConnections(connections: Array<Connection & { projectId: string }>): Connection[] {
    return connections.map(c => {
      const { projectId: _, ...conn } = c;
      return conn as Connection;
    });
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
    return this.metadataPersistence.loadMeta();
  }

  async getMetadata(): Promise<StoreMeta | null> {
    return this.loadMeta();
  }

  async setMetadata(metadata: Partial<StoreMeta>): Promise<void> {
    return this.metadataPersistence.setMetadata(metadata);
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
    return this.metadataPersistence.getLastActiveProjectId(availableProjectIds);
  }
  
  /**
   * 【新增】保存当前活动项目 ID（立即保存，不防抖）
   */
  async saveActiveProjectId(projectId: string | null): Promise<void> {
    return this.metadataPersistence.saveActiveProjectId(projectId);
  }
  
  /**
   * 删除项目的本地缓存
   */
  async deleteProject(projectId: string): Promise<void> {
    return this.cacheCleanup.deleteProject(projectId);
  }
  
  /**
   * 清除所有本地缓存
   */
  async clearAll(): Promise<void> {
    return this.cacheCleanup.clearAll();
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

  /** 恢复上次崩溃或刷新中断的数据安全还原，必须在读取本地项目数据前执行 */
  async recoverInterruptedDataSafetyRestore(
    ownerUserId: string,
  ): Promise<IndexedDbDataSafetyRestoreRecoveryResult> {
    const db = await this.initDatabase();
    return recoverInterruptedDataSafetyRestoreFromIndexedDb(db, ownerUserId);
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
