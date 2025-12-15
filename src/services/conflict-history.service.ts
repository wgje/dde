/**
 * ConflictHistoryService - 冲突历史服务
 * 
 * 借鉴思源笔记的冲突历史保留机制，扩展现有的冲突存储功能。
 * 
 * 【核心概念】
 * - 冲突历史：保存每次冲突时的完整本地和远程数据
 * - 版本回溯：支持查看和恢复历史版本
 * - 差异对比：提供字段级别的差异分析
 * 
 * 【与 ConflictStorageService 的关系】
 * - ConflictStorageService：处理当前未解决的冲突
 * - ConflictHistoryService：保存所有冲突的历史记录，支持回溯
 * 
 * 【设计理念】
 * "删除是一种暴力，历史记录是一种尊重"
 * 用户的每一次冲突都值得被记录，因为它代表了用户的思考和决策
 */
import { Injectable, inject, signal, computed } from '@angular/core';
import { LoggerService } from './logger.service';
import { Project, Task, Connection } from '../models';

/**
 * 冲突历史记录
 */
export interface ConflictHistoryRecord {
  /** 记录ID */
  id: string;
  /** 项目ID */
  projectId: string;
  /** 用户ID */
  userId: string;
  /** 设备ID */
  deviceId: string;
  /** 设备名称 */
  deviceName: string;
  /** 冲突发生时间 */
  conflictedAt: number;
  /** 解决时间（如果已解决） */
  resolvedAt?: number;
  /** 冲突原因 */
  reason: ConflictReason;
  /** 本地版本号 */
  localVersion: number;
  /** 远程版本号 */
  remoteVersion: number;
  /** 本地项目数据 */
  localProject: Project;
  /** 远程项目数据 */
  remoteProject: Project;
  /** 解决后的项目数据（如果已解决） */
  resolvedProject?: Project;
  /** 解决策略 */
  resolutionStrategy?: ResolutionStrategy;
  /** 冲突的任务ID列表 */
  conflictedTaskIds: string[];
  /** 冲突的字段列表 */
  conflictedFields: ConflictedField[];
  /** 是否已归档 */
  archived: boolean;
  /** 备注 */
  notes?: string;
}

/**
 * 冲突原因
 */
export type ConflictReason = 
  | 'version_mismatch'      // 版本号不匹配
  | 'concurrent_edit'       // 并发编辑
  | 'network_recovery'      // 网络恢复后发现差异
  | 'status_conflict'       // 任务状态冲突
  | 'field_conflict'        // 字段级冲突
  | 'merge_conflict';       // 合并冲突

/**
 * 解决策略
 */
export type ResolutionStrategy = 
  | 'use_local'            // 使用本地版本
  | 'use_remote'           // 使用远程版本
  | 'merge'                // 合并
  | 'manual'               // 手动解决
  | 'auto_rebase';         // 自动变基

/**
 * 冲突字段信息
 */
export interface ConflictedField {
  /** 任务ID */
  taskId: string;
  /** 字段名 */
  field: string;
  /** 本地值 */
  localValue: unknown;
  /** 远程值 */
  remoteValue: unknown;
  /** 基准值（如果有） */
  baseValue?: unknown;
  /** 解决后的值 */
  resolvedValue?: unknown;
}

/**
 * 冲突统计
 */
export interface ConflictStats {
  /** 总冲突数 */
  total: number;
  /** 已解决 */
  resolved: number;
  /** 未解决 */
  unresolved: number;
  /** 按原因分类 */
  byReason: Record<ConflictReason, number>;
  /** 按策略分类 */
  byStrategy: Record<ResolutionStrategy, number>;
}

/** IndexedDB 配置 */
const DB_NAME = 'nanoflow-conflict-history';
const DB_VERSION = 1;
const STORE_NAME = 'history';

/** 最大保留历史数量 */
const MAX_HISTORY_RECORDS = 500;

/** 自动归档天数 */
const AUTO_ARCHIVE_DAYS = 30;

/** 生成设备ID */
const DEVICE_ID = typeof crypto !== 'undefined' 
  ? crypto.randomUUID()
  : Math.random().toString(36).substring(2) + Date.now().toString(36);

@Injectable({
  providedIn: 'root'
})
export class ConflictHistoryService {
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('ConflictHistory');
  
  /** IndexedDB 实例 */
  private db: IDBDatabase | null = null;
  private dbPromise: Promise<IDBDatabase> | null = null;
  
  /** 历史记录数量 */
  private readonly _historyCount = signal(0);
  
  /** 未解决的冲突数量 */
  private readonly _unresolvedCount = signal(0);
  
  // ========== 公开的响应式属性 ==========
  
  /** 历史记录数量 */
  readonly historyCount = this._historyCount.asReadonly();
  
  /** 未解决的冲突数量 */
  readonly unresolvedCount = this._unresolvedCount.asReadonly();
  
  /** 是否有未解决的冲突 */
  readonly hasUnresolvedConflicts = computed(() => this._unresolvedCount() > 0);
  
  constructor() {
    this.initializeAndCleanup();
  }
  
  // ========== 公开方法 ==========
  
  /**
   * 记录冲突
   * 当发生冲突时调用，保存完整的冲突上下文
   */
  async recordConflict(
    userId: string,
    projectId: string,
    localProject: Project,
    remoteProject: Project,
    reason: ConflictReason,
    conflictedFields: ConflictedField[] = []
  ): Promise<ConflictHistoryRecord> {
    const record: ConflictHistoryRecord = {
      id: this.generateRecordId(),
      projectId,
      userId,
      deviceId: DEVICE_ID,
      deviceName: this.getDeviceName(),
      conflictedAt: Date.now(),
      reason,
      localVersion: localProject.version ?? 0,
      remoteVersion: remoteProject.version ?? 0,
      localProject: this.cloneProject(localProject),
      remoteProject: this.cloneProject(remoteProject),
      conflictedTaskIds: this.findConflictedTaskIds(localProject, remoteProject),
      conflictedFields,
      archived: false
    };
    
    await this.saveRecord(record);
    await this.refreshCounts();
    
    this.logger.info('冲突已记录', { 
      recordId: record.id, 
      projectId,
      reason,
      conflictedTaskCount: record.conflictedTaskIds.length 
    });
    
    return record;
  }
  
  /**
   * 标记冲突已解决
   */
  async markResolved(
    recordId: string,
    resolvedProject: Project,
    strategy: ResolutionStrategy,
    resolvedFields?: ConflictedField[]
  ): Promise<void> {
    const record = await this.getRecordById(recordId);
    if (!record) {
      this.logger.warn('冲突记录不存在', { recordId });
      return;
    }
    
    record.resolvedAt = Date.now();
    record.resolvedProject = this.cloneProject(resolvedProject);
    record.resolutionStrategy = strategy;
    
    if (resolvedFields) {
      record.conflictedFields = resolvedFields;
    }
    
    await this.saveRecord(record);
    await this.refreshCounts();
    
    this.logger.info('冲突已标记解决', { recordId, strategy });
  }
  
  /**
   * 获取项目的冲突历史
   */
  async getProjectHistory(projectId: string, limit = 50): Promise<ConflictHistoryRecord[]> {
    try {
      const db = await this.getDb();
      return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_NAME], 'readonly');
        const store = transaction.objectStore(STORE_NAME);
        const index = store.index('projectId');
        const request = index.getAll(projectId);
        
        request.onsuccess = () => {
          const records = request.result || [];
          records.sort((a, b) => b.conflictedAt - a.conflictedAt);
          resolve(records.slice(0, limit));
        };
        request.onerror = () => reject(request.error);
      });
    } catch (e) {
      this.logger.error('获取项目冲突历史失败', e);
      return [];
    }
  }
  
  /**
   * 获取用户的所有冲突历史
   */
  async getUserHistory(userId: string, options?: {
    limit?: number;
    includeArchived?: boolean;
    onlyUnresolved?: boolean;
  }): Promise<ConflictHistoryRecord[]> {
    const { limit = 100, includeArchived = false, onlyUnresolved = false } = options || {};
    
    try {
      const db = await this.getDb();
      const records = await new Promise<ConflictHistoryRecord[]>((resolve, reject) => {
        const transaction = db.transaction([STORE_NAME], 'readonly');
        const store = transaction.objectStore(STORE_NAME);
        const index = store.index('userId');
        const request = index.getAll(userId);
        
        request.onsuccess = () => resolve(request.result || []);
        request.onerror = () => reject(request.error);
      });
      
      // 过滤和排序
      let filtered = records
        .filter(r => includeArchived || !r.archived)
        .filter(r => !onlyUnresolved || !r.resolvedAt);
      
      filtered.sort((a, b) => b.conflictedAt - a.conflictedAt);
      
      return filtered.slice(0, limit);
    } catch (e) {
      this.logger.error('获取用户冲突历史失败', e);
      return [];
    }
  }
  
  /**
   * 获取冲突统计
   */
  async getStats(userId: string): Promise<ConflictStats> {
    const records = await this.getUserHistory(userId, { limit: 1000, includeArchived: true });
    
    const stats: ConflictStats = {
      total: records.length,
      resolved: 0,
      unresolved: 0,
      byReason: {} as Record<ConflictReason, number>,
      byStrategy: {} as Record<ResolutionStrategy, number>
    };
    
    for (const record of records) {
      if (record.resolvedAt) {
        stats.resolved++;
        if (record.resolutionStrategy) {
          stats.byStrategy[record.resolutionStrategy] = 
            (stats.byStrategy[record.resolutionStrategy] || 0) + 1;
        }
      } else {
        stats.unresolved++;
      }
      
      stats.byReason[record.reason] = (stats.byReason[record.reason] || 0) + 1;
    }
    
    return stats;
  }
  
  /**
   * 根据ID获取记录
   */
  async getRecordById(id: string): Promise<ConflictHistoryRecord | null> {
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
      this.logger.error('获取冲突记录失败', e);
      return null;
    }
  }
  
  /**
   * 归档记录
   */
  async archiveRecord(id: string): Promise<void> {
    const record = await this.getRecordById(id);
    if (!record) return;
    
    record.archived = true;
    await this.saveRecord(record);
    
    this.logger.debug('冲突记录已归档', { id });
  }
  
  /**
   * 添加备注
   */
  async addNotes(id: string, notes: string): Promise<void> {
    const record = await this.getRecordById(id);
    if (!record) return;
    
    record.notes = notes;
    await this.saveRecord(record);
  }
  
  /**
   * 删除记录
   */
  async deleteRecord(id: string): Promise<void> {
    try {
      const db = await this.getDb();
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction([STORE_NAME], 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.delete(id);
        
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      });
      
      await this.refreshCounts();
      this.logger.debug('冲突记录已删除', { id });
    } catch (e) {
      this.logger.error('删除冲突记录失败', e);
    }
  }
  
  /**
   * 比较两个项目的差异
   * 返回字段级别的差异列表
   */
  compareProjects(local: Project, remote: Project): ConflictedField[] {
    const conflicts: ConflictedField[] = [];
    
    const localTaskMap = new Map((local.tasks || []).map(t => [t.id, t]));
    const remoteTaskMap = new Map((remote.tasks || []).map(t => [t.id, t]));
    
    // 比较共同存在的任务
    for (const [taskId, localTask] of localTaskMap) {
      const remoteTask = remoteTaskMap.get(taskId);
      if (!remoteTask) continue;
      
      // 比较关键字段
      const fieldsToCompare: (keyof Task)[] = [
        'title', 'content', 'status', 'stage', 'parentId', 'rank', 'x', 'y'
      ];
      
      for (const field of fieldsToCompare) {
        const localValue = localTask[field];
        const remoteValue = remoteTask[field];
        
        if (!this.isEqual(localValue, remoteValue)) {
          conflicts.push({
            taskId,
            field,
            localValue,
            remoteValue
          });
        }
      }
    }
    
    return conflicts;
  }
  
  /**
   * 清除所有历史记录
   */
  async clearAllHistory(): Promise<void> {
    try {
      const db = await this.getDb();
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction([STORE_NAME], 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.clear();
        
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      });
      
      this._historyCount.set(0);
      this._unresolvedCount.set(0);
      this.logger.info('所有冲突历史已清除');
    } catch (e) {
      this.logger.error('清除冲突历史失败', e);
    }
  }
  
  // ========== 私有方法 ==========
  
  /**
   * 初始化并清理旧数据
   */
  private async initializeAndCleanup(): Promise<void> {
    try {
      await this.refreshCounts();
      await this.autoArchiveOldRecords();
      await this.cleanupOldRecords();
    } catch (e) {
      this.logger.warn('初始化冲突历史服务失败', e);
    }
  }
  
  /**
   * 自动归档旧记录
   */
  private async autoArchiveOldRecords(): Promise<void> {
    try {
      const db = await this.getDb();
      const cutoff = Date.now() - (AUTO_ARCHIVE_DAYS * 24 * 60 * 60 * 1000);
      
      const records = await new Promise<ConflictHistoryRecord[]>((resolve, reject) => {
        const transaction = db.transaction([STORE_NAME], 'readonly');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.getAll();
        
        request.onsuccess = () => resolve(request.result || []);
        request.onerror = () => reject(request.error);
      });
      
      const toArchive = records.filter(r => 
        !r.archived && 
        r.resolvedAt && 
        r.conflictedAt < cutoff
      );
      
      for (const record of toArchive) {
        record.archived = true;
        await this.saveRecord(record);
      }
      
      if (toArchive.length > 0) {
        this.logger.debug('自动归档旧冲突记录', { count: toArchive.length });
      }
    } catch (e) {
      this.logger.warn('自动归档失败', e);
    }
  }
  
  /**
   * 清理超出限制的旧记录
   */
  private async cleanupOldRecords(): Promise<void> {
    try {
      const db = await this.getDb();
      const records = await new Promise<ConflictHistoryRecord[]>((resolve, reject) => {
        const transaction = db.transaction([STORE_NAME], 'readonly');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.getAll();
        
        request.onsuccess = () => resolve(request.result || []);
        request.onerror = () => reject(request.error);
      });
      
      if (records.length <= MAX_HISTORY_RECORDS) return;
      
      // 优先删除已归档的旧记录
      records.sort((a, b) => {
        if (a.archived !== b.archived) return a.archived ? -1 : 1;
        return a.conflictedAt - b.conflictedAt;
      });
      
      const toDelete = records.slice(0, records.length - MAX_HISTORY_RECORDS);
      
      for (const record of toDelete) {
        await this.deleteRecord(record.id);
      }
      
      this.logger.debug('清理旧冲突记录', { deleted: toDelete.length });
    } catch (e) {
      this.logger.warn('清理旧记录失败', e);
    }
  }
  
  /**
   * 查找冲突的任务ID
   */
  private findConflictedTaskIds(local: Project, remote: Project): string[] {
    const conflictedIds: string[] = [];
    const localTaskMap = new Map((local.tasks || []).map(t => [t.id, t]));
    const remoteTaskMap = new Map((remote.tasks || []).map(t => [t.id, t]));
    
    for (const [taskId, localTask] of localTaskMap) {
      const remoteTask = remoteTaskMap.get(taskId);
      if (remoteTask && !this.isTaskEqual(localTask, remoteTask)) {
        conflictedIds.push(taskId);
      }
    }
    
    return conflictedIds;
  }
  
  /**
   * 比较两个任务是否相等
   */
  private isTaskEqual(a: Task, b: Task): boolean {
    return a.title === b.title &&
           a.content === b.content &&
           a.status === b.status &&
           a.stage === b.stage &&
           a.parentId === b.parentId &&
           a.rank === b.rank;
  }
  
  /**
   * 深度比较两个值
   */
  private isEqual(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (a == null || b == null) return a === b;
    if (typeof a !== typeof b) return false;
    if (typeof a !== 'object') return a === b;
    
    return JSON.stringify(a) === JSON.stringify(b);
  }
  
  /**
   * 克隆项目（深拷贝）
   */
  private cloneProject(project: Project): Project {
    return JSON.parse(JSON.stringify(project));
  }
  
  /**
   * 生成记录ID
   */
  private generateRecordId(): string {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).substring(2, 8);
    return `ch-${timestamp}-${random}`;
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
   * 保存记录
   */
  private async saveRecord(record: ConflictHistoryRecord): Promise<void> {
    try {
      const db = await this.getDb();
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction([STORE_NAME], 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.put(record);
        
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      });
    } catch (e) {
      this.logger.error('保存冲突记录失败', e);
      throw e;
    }
  }
  
  /**
   * 刷新计数
   */
  private async refreshCounts(): Promise<void> {
    try {
      const db = await this.getDb();
      const records = await new Promise<ConflictHistoryRecord[]>((resolve, reject) => {
        const transaction = db.transaction([STORE_NAME], 'readonly');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.getAll();
        
        request.onsuccess = () => resolve(request.result || []);
        request.onerror = () => reject(request.error);
      });
      
      this._historyCount.set(records.length);
      this._unresolvedCount.set(records.filter(r => !r.resolvedAt && !r.archived).length);
    } catch (e) {
      this.logger.warn('刷新冲突计数失败', e);
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
          store.createIndex('projectId', 'projectId', { unique: false });
          store.createIndex('userId', 'userId', { unique: false });
          store.createIndex('conflictedAt', 'conflictedAt', { unique: false });
          store.createIndex('reason', 'reason', { unique: false });
          store.createIndex('archived', 'archived', { unique: false });
        }
      };
    });
    
    return this.dbPromise;
  }
}
