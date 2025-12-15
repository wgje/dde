/**
 * SyncCheckpointService - 同步检查点服务
 * 
 * 借鉴思源笔记的快照/索引机制，实现基于检查点的增量同步。
 * 
 * 【核心概念】
 * - 检查点（Checkpoint）：记录某个时刻的数据状态摘要
 * - 增量同步：只同步检查点之后的变更，而非全量数据
 * - 版本追踪：记录每次同步的版本号，支持回溯
 * 
 * 【数据结构】
 * - checkpointId: 检查点唯一标识（基于时间戳和设备ID）
 * - projectSnapshots: 每个项目的版本和任务数量摘要
 * - syncedAt: 同步时间
 * 
 * 【使用场景】
 * 1. 同步前：创建本地检查点
 * 2. 同步时：比较本地和远程检查点，计算差异
 * 3. 同步后：更新检查点
 */
import { Injectable, inject, signal, computed } from '@angular/core';
import { LoggerService } from './logger.service';
import { Project, Task } from '../models';

/**
 * 项目快照摘要
 */
export interface ProjectSnapshot {
  /** 项目ID */
  projectId: string;
  /** 项目版本号 */
  version: number;
  /** 任务数量 */
  taskCount: number;
  /** 连接数量 */
  connectionCount: number;
  /** 最后修改时间 */
  lastModified: string;
  /** 任务ID列表的哈希（用于快速比较） */
  taskIdsHash: string;
}

/**
 * 同步检查点
 */
export interface SyncCheckpoint {
  /** 检查点ID */
  id: string;
  /** 用户ID */
  userId: string;
  /** 设备ID */
  deviceId: string;
  /** 设备名称 */
  deviceName: string;
  /** 创建时间 */
  createdAt: number;
  /** 项目快照列表 */
  projectSnapshots: ProjectSnapshot[];
  /** 检查点类型 */
  type: 'local' | 'remote' | 'merged';
  /** 同步方向 */
  syncDirection?: 'upload' | 'download' | 'both';
  /** 备注 */
  memo?: string;
}

/**
 * 检查点比较结果
 */
export interface CheckpointDiff {
  /** 新增的项目ID */
  addedProjectIds: string[];
  /** 删除的项目ID */
  removedProjectIds: string[];
  /** 有变更的项目ID */
  modifiedProjectIds: string[];
  /** 无变化的项目ID */
  unchangedProjectIds: string[];
  /** 是否有任何变更 */
  hasChanges: boolean;
}

/** IndexedDB 配置 */
const DB_NAME = 'nanoflow-checkpoints';
const DB_VERSION = 1;
const STORE_NAME = 'checkpoints';

/** 最大保留检查点数量 */
const MAX_CHECKPOINTS = 100;

/** 生成设备ID */
const DEVICE_ID = typeof crypto !== 'undefined' 
  ? crypto.randomUUID()
  : Math.random().toString(36).substring(2) + Date.now().toString(36);

@Injectable({
  providedIn: 'root'
})
export class SyncCheckpointService {
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('SyncCheckpoint');
  
  /** IndexedDB 实例 */
  private db: IDBDatabase | null = null;
  private dbPromise: Promise<IDBDatabase> | null = null;
  
  /** 最新的本地检查点 */
  private readonly _latestCheckpoint = signal<SyncCheckpoint | null>(null);
  
  /** 检查点数量 */
  private readonly _checkpointCount = signal(0);
  
  // ========== 公开的响应式属性 ==========
  
  /** 最新的本地检查点 */
  readonly latestCheckpoint = this._latestCheckpoint.asReadonly();
  
  /** 检查点数量 */
  readonly checkpointCount = this._checkpointCount.asReadonly();
  
  /** 是否有检查点 */
  readonly hasCheckpoints = computed(() => this._checkpointCount() > 0);
  
  constructor() {
    // 初始化时加载最新检查点
    this.loadLatestCheckpoint();
  }
  
  // ========== 公开方法 ==========
  
  /**
   * 创建检查点
   * @param userId 用户ID
   * @param projects 项目列表（包含任务）
   * @param type 检查点类型
   * @param memo 备注
   */
  async createCheckpoint(
    userId: string,
    projects: Project[],
    type: 'local' | 'remote' | 'merged' = 'local',
    memo?: string
  ): Promise<SyncCheckpoint> {
    const checkpoint: SyncCheckpoint = {
      id: this.generateCheckpointId(),
      userId,
      deviceId: DEVICE_ID,
      deviceName: this.getDeviceName(),
      createdAt: Date.now(),
      projectSnapshots: projects.map(p => this.createProjectSnapshot(p)),
      type,
      memo
    };
    
    await this.saveCheckpoint(checkpoint);
    this._latestCheckpoint.set(checkpoint);
    await this.refreshCheckpointCount();
    
    this.logger.info('检查点已创建', { 
      checkpointId: checkpoint.id, 
      projectCount: projects.length,
      type 
    });
    
    // 清理旧检查点
    await this.cleanupOldCheckpoints();
    
    return checkpoint;
  }
  
  /**
   * 获取最新的检查点
   */
  async getLatestCheckpoint(userId: string): Promise<SyncCheckpoint | null> {
    try {
      const checkpoints = await this.getCheckpointsByUser(userId);
      if (checkpoints.length === 0) return null;
      
      // 按时间降序排序
      checkpoints.sort((a, b) => b.createdAt - a.createdAt);
      return checkpoints[0];
    } catch (e) {
      this.logger.error('获取最新检查点失败', e);
      return null;
    }
  }
  
  /**
   * 比较两个检查点
   */
  diffCheckpoints(local: SyncCheckpoint, remote: SyncCheckpoint): CheckpointDiff {
    const localProjectMap = new Map(local.projectSnapshots.map(s => [s.projectId, s]));
    const remoteProjectMap = new Map(remote.projectSnapshots.map(s => [s.projectId, s]));
    
    const addedProjectIds: string[] = [];
    const removedProjectIds: string[] = [];
    const modifiedProjectIds: string[] = [];
    const unchangedProjectIds: string[] = [];
    
    // 检查本地有但远程没有的（本地新增）
    for (const [projectId, localSnapshot] of localProjectMap) {
      if (!remoteProjectMap.has(projectId)) {
        addedProjectIds.push(projectId);
      } else {
        const remoteSnapshot = remoteProjectMap.get(projectId)!;
        if (this.isSnapshotDifferent(localSnapshot, remoteSnapshot)) {
          modifiedProjectIds.push(projectId);
        } else {
          unchangedProjectIds.push(projectId);
        }
      }
    }
    
    // 检查远程有但本地没有的（远程新增/本地删除）
    for (const projectId of remoteProjectMap.keys()) {
      if (!localProjectMap.has(projectId)) {
        removedProjectIds.push(projectId);
      }
    }
    
    return {
      addedProjectIds,
      removedProjectIds,
      modifiedProjectIds,
      unchangedProjectIds,
      hasChanges: addedProjectIds.length > 0 || 
                  removedProjectIds.length > 0 || 
                  modifiedProjectIds.length > 0
    };
  }
  
  /**
   * 获取检查点历史
   * @param userId 用户ID
   * @param limit 限制数量
   */
  async getCheckpointHistory(userId: string, limit = 20): Promise<SyncCheckpoint[]> {
    try {
      const checkpoints = await this.getCheckpointsByUser(userId);
      checkpoints.sort((a, b) => b.createdAt - a.createdAt);
      return checkpoints.slice(0, limit);
    } catch (e) {
      this.logger.error('获取检查点历史失败', e);
      return [];
    }
  }
  
  /**
   * 根据ID获取检查点
   */
  async getCheckpointById(id: string): Promise<SyncCheckpoint | null> {
    try {
      const db = await this.getDb();
      return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_NAME], 'readonly');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.get(id);
        
        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => reject(request.error);
      });
    } catch (e) {
      this.logger.error('获取检查点失败', e);
      return null;
    }
  }
  
  /**
   * 删除检查点
   */
  async deleteCheckpoint(id: string): Promise<void> {
    try {
      const db = await this.getDb();
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction([STORE_NAME], 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.delete(id);
        
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      });
      
      await this.refreshCheckpointCount();
      this.logger.debug('检查点已删除', { id });
    } catch (e) {
      this.logger.error('删除检查点失败', e);
    }
  }
  
  /**
   * 清除所有检查点
   */
  async clearAllCheckpoints(): Promise<void> {
    try {
      const db = await this.getDb();
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction([STORE_NAME], 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.clear();
        
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      });
      
      this._checkpointCount.set(0);
      this._latestCheckpoint.set(null);
      this.logger.info('所有检查点已清除');
    } catch (e) {
      this.logger.error('清除检查点失败', e);
    }
  }
  
  // ========== 私有方法 ==========
  
  /**
   * 创建项目快照
   */
  private createProjectSnapshot(project: Project): ProjectSnapshot {
    const tasks = project.tasks || [];
    const connections = project.connections || [];
    
    return {
      projectId: project.id,
      version: project.version ?? 0,
      taskCount: tasks.length,
      connectionCount: connections.length,
      lastModified: project.updatedAt || project.createdDate || new Date().toISOString(),
      taskIdsHash: this.hashTaskIds(tasks)
    };
  }
  
  /**
   * 计算任务ID列表的哈希
   */
  private hashTaskIds(tasks: Task[]): string {
    const ids = tasks.map(t => t.id).sort().join(',');
    // 简单的哈希算法
    let hash = 0;
    for (let i = 0; i < ids.length; i++) {
      const char = ids.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return hash.toString(36);
  }
  
  /**
   * 比较两个快照是否不同
   */
  private isSnapshotDifferent(a: ProjectSnapshot, b: ProjectSnapshot): boolean {
    return a.version !== b.version ||
           a.taskCount !== b.taskCount ||
           a.connectionCount !== b.connectionCount ||
           a.taskIdsHash !== b.taskIdsHash;
  }
  
  /**
   * 生成检查点ID
   */
  private generateCheckpointId(): string {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).substring(2, 8);
    return `cp-${timestamp}-${random}`;
  }
  
  /**
   * 获取设备名称
   */
  private getDeviceName(): string {
    if (typeof navigator !== 'undefined') {
      const platform = navigator.platform || 'Unknown';
      if (/Mac/.test(platform)) return 'Mac';
      if (/Win/.test(platform)) return 'Windows';
      if (/Linux/.test(platform)) return 'Linux';
      if (/iPhone|iPad|iPod/.test(navigator.userAgent)) return 'iOS';
      if (/Android/.test(navigator.userAgent)) return 'Android';
    }
    return 'Unknown Device';
  }
  
  /**
   * 保存检查点
   */
  private async saveCheckpoint(checkpoint: SyncCheckpoint): Promise<void> {
    try {
      const db = await this.getDb();
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction([STORE_NAME], 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.put(checkpoint);
        
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      });
    } catch (e) {
      this.logger.error('保存检查点失败', e);
      throw e;
    }
  }
  
  /**
   * 获取用户的所有检查点
   */
  private async getCheckpointsByUser(userId: string): Promise<SyncCheckpoint[]> {
    try {
      const db = await this.getDb();
      return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_NAME], 'readonly');
        const store = transaction.objectStore(STORE_NAME);
        const index = store.index('userId');
        const request = index.getAll(userId);
        
        request.onsuccess = () => resolve(request.result || []);
        request.onerror = () => reject(request.error);
      });
    } catch (e) {
      this.logger.error('获取用户检查点失败', e);
      return [];
    }
  }
  
  /**
   * 清理旧检查点
   */
  private async cleanupOldCheckpoints(): Promise<void> {
    try {
      const db = await this.getDb();
      const allCheckpoints = await new Promise<SyncCheckpoint[]>((resolve, reject) => {
        const transaction = db.transaction([STORE_NAME], 'readonly');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.getAll();
        
        request.onsuccess = () => resolve(request.result || []);
        request.onerror = () => reject(request.error);
      });
      
      if (allCheckpoints.length <= MAX_CHECKPOINTS) return;
      
      // 按时间排序，删除最旧的
      allCheckpoints.sort((a, b) => a.createdAt - b.createdAt);
      const toDelete = allCheckpoints.slice(0, allCheckpoints.length - MAX_CHECKPOINTS);
      
      for (const checkpoint of toDelete) {
        await this.deleteCheckpoint(checkpoint.id);
      }
      
      this.logger.debug('清理旧检查点', { deleted: toDelete.length });
    } catch (e) {
      this.logger.warn('清理旧检查点失败', e);
    }
  }
  
  /**
   * 加载最新检查点
   */
  private async loadLatestCheckpoint(): Promise<void> {
    try {
      const db = await this.getDb();
      const checkpoints = await new Promise<SyncCheckpoint[]>((resolve, reject) => {
        const transaction = db.transaction([STORE_NAME], 'readonly');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.getAll();
        
        request.onsuccess = () => resolve(request.result || []);
        request.onerror = () => reject(request.error);
      });
      
      if (checkpoints.length > 0) {
        checkpoints.sort((a, b) => b.createdAt - a.createdAt);
        this._latestCheckpoint.set(checkpoints[0]);
        this._checkpointCount.set(checkpoints.length);
      }
    } catch (e) {
      this.logger.warn('加载最新检查点失败', e);
    }
  }
  
  /**
   * 刷新检查点数量
   */
  private async refreshCheckpointCount(): Promise<void> {
    try {
      const db = await this.getDb();
      const count = await new Promise<number>((resolve, reject) => {
        const transaction = db.transaction([STORE_NAME], 'readonly');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.count();
        
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      
      this._checkpointCount.set(count);
    } catch (e) {
      this.logger.warn('刷新检查点数量失败', e);
    }
  }
  
  /**
   * 获取数据库连接
   */
  private async getDb(): Promise<IDBDatabase> {
    if (this.db) return this.db;
    
    if (this.dbPromise) return this.dbPromise;
    
    this.dbPromise = new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') {
        reject(new Error('IndexedDB 不可用'));
        return;
      }
      
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      
      request.onerror = () => {
        this.logger.error('打开 IndexedDB 失败', request.error);
        reject(request.error);
      };
      
      request.onsuccess = () => {
        this.db = request.result;
        resolve(this.db);
      };
      
      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
          store.createIndex('userId', 'userId', { unique: false });
          store.createIndex('createdAt', 'createdAt', { unique: false });
          store.createIndex('type', 'type', { unique: false });
        }
      };
    });
    
    return this.dbPromise;
  }
}
