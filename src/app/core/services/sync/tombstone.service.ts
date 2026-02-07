/**
 * TombstoneService - 墓碑（软删除标记）管理
 * 
 * 职责：
 * - 管理本地 tombstone 缓存（用于防止已删除任务复活）
 * - 云端 tombstone 缓存管理（流量优化）
 * - 附件删除时的存储清理
 * 
 * 从 SimpleSyncService 提取，作为 Sprint 3 技术债务修复的一部分
 */

import { Injectable, inject } from '@angular/core';
import { LoggerService } from '../../../../services/logger.service';
import { RequestThrottleService } from '../../../../services/request-throttle.service';
import { REQUEST_THROTTLE_CONFIG, SYNC_CONFIG, FIELD_SELECT_CONFIG } from '../../../../config';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Tombstone 缓存项
 */
interface TombstoneCache {
  /** 已删除的任务 ID 集合 */
  ids: Set<string>;
  /** 缓存时间戳 */
  timestamp: number;
}

/**
 * 墓碑管理服务
 * 
 * 用于追踪已删除的任务，防止同步时复活
 */
@Injectable({
  providedIn: 'root'
})
export class TombstoneService {
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('Tombstone');
  private readonly throttle = inject(RequestThrottleService);
  
  /** 
   * 本地 tombstone 缓存 
   * 用于在云端 RPC 不可用时防止已删除任务复活
   * 格式：Map<projectId, Map<taskId, timestamp>>
   */
  private localTombstones: Map<string, Map<string, number>> = new Map();
  
  /** 本地 tombstone 持久化 key */
  private readonly LOCAL_TOMBSTONES_KEY = 'nanoflow.local-tombstones';
  
  /** 云端 Tombstone 缓存（用于流量优化） */
  private tombstoneCache = new Map<string, TombstoneCache>();
  
  /** 连接 Tombstone 缓存 */
  private connectionTombstoneCache = new Map<string, TombstoneCache>();
  
  constructor() {
    this.loadLocalTombstones();
  }
  
  // ==================== 本地 Tombstone 管理 ====================
  
  /**
   * 从 localStorage 加载本地 tombstone 缓存
   */
  private loadLocalTombstones(): void {
    if (typeof localStorage === 'undefined') return;
    
    try {
      const data = localStorage.getItem(this.LOCAL_TOMBSTONES_KEY);
      if (data) {
        const parsed = JSON.parse(data) as Record<string, unknown>;
        this.localTombstones = new Map();

        for (const [projectId, value] of Object.entries(parsed)) {
          const map = new Map<string, number>();
          if (Array.isArray(value)) {
            // 向后兼容旧格式：string[]
            for (const taskId of value) {
              if (typeof taskId === 'string') {
                map.set(taskId, Date.now());
              }
            }
          } else if (value && typeof value === 'object') {
            // 新格式：Record<taskId, timestamp>
            for (const [taskId, timestamp] of Object.entries(value as Record<string, unknown>)) {
              const ts = typeof timestamp === 'number' ? timestamp : Date.now();
              map.set(taskId, ts);
            }
          }
          if (map.size > 0) {
            this.localTombstones.set(projectId, map);
          }
        }

        // 启动时清理过期 tombstone，避免长期膨胀
        this.cleanupExpiredLocalTombstones();
        this.logger.debug('已恢复本地 tombstone 缓存', { 
          projectCount: this.localTombstones.size 
        });
      }
    } catch (e) {
      this.logger.warn('加载本地 tombstone 缓存失败', e);
      this.localTombstones = new Map();
    }
  }
  
  /**
   * 保存本地 tombstone 缓存到 localStorage
   */
  private saveLocalTombstones(): void {
    if (typeof localStorage === 'undefined') return;
    
    try {
      const data: Record<string, Record<string, number>> = {};
      for (const [projectId, taskIds] of this.localTombstones.entries()) {
        data[projectId] = Object.fromEntries(taskIds.entries());
      }
      localStorage.setItem(this.LOCAL_TOMBSTONES_KEY, JSON.stringify(data));
    } catch (e) {
      this.logger.warn('保存本地 tombstone 缓存失败', e);
    }
  }
  
  /**
   * 添加本地 tombstone
   * 
   * 用于在 RPC 不可用时防止任务复活
   * 
   * @param projectId 项目 ID
   * @param taskIds 任务 ID 列表
   */
  addLocalTombstones(projectId: string, taskIds: string[]): void {
    if (!this.localTombstones.has(projectId)) {
      this.localTombstones.set(projectId, new Map());
    }
    const set = this.localTombstones.get(projectId)!;
    const now = Date.now();
    for (const id of taskIds) {
      set.set(id, now);
    }
    this.saveLocalTombstones();
    this.logger.debug('添加本地 tombstone', { projectId, count: taskIds.length });
  }
  
  /**
   * 获取本地 tombstone（合并云端 tombstone）
   */
  getLocalTombstones(projectId: string): Set<string> {
    this.cleanupExpiredLocalTombstones(projectId);
    const records = this.localTombstones.get(projectId);
    return records ? new Set(records.keys()) : new Set();
  }
  
  /**
   * 清除本地 tombstone（当云端 tombstone 同步成功后）
   */
  clearLocalTombstones(projectId: string, taskIds: string[]): void {
    const set = this.localTombstones.get(projectId);
    if (set) {
      for (const id of taskIds) {
        set.delete(id);
      }
      if (set.size === 0) {
        this.localTombstones.delete(projectId);
      }
      this.saveLocalTombstones();
    }
  }
  
  /**
   * 清除项目的所有本地 tombstone
   */
  clearAllLocalTombstones(projectId: string): void {
    this.localTombstones.delete(projectId);
    this.saveLocalTombstones();
  }
  
  // ==================== 云端 Tombstone 缓存（流量优化）====================
  
  /**
   * 获取 Tombstones（带缓存）
   * 
   * 【流量优化】缓存 tombstone 结果，避免每次同步都查询
   * 缓存有效期：5 分钟（SYNC_CONFIG.TOMBSTONE_CACHE_TTL）
   */
  async getTombstonesWithCache(
    projectId: string, 
    client: SupabaseClient
  ): Promise<{ data: { task_id: string }[] | null; error: Error | null }> {
    const now = Date.now();
    const cached = this.tombstoneCache.get(projectId);
    
    // 检查缓存是否有效
    if (cached && (now - cached.timestamp) < SYNC_CONFIG.TOMBSTONE_CACHE_TTL) {
      this.logger.debug('使用 Tombstone 缓存', { 
        projectId, 
        count: cached.ids.size,
        age: Math.round((now - cached.timestamp) / 1000) + 's'
      });
      return { 
        data: Array.from(cached.ids).map(id => ({ task_id: id })), 
        error: null 
      };
    }
    
    // 缓存过期或不存在，查询云端
    try {
      const result = await this.throttle.execute(
        `task-tombstones:${projectId}`,
        async () => {
          return await client
            .from('task_tombstones')
            .select(FIELD_SELECT_CONFIG.TOMBSTONE_FIELDS)
            .eq('project_id', projectId);
        },
        { 
          deduplicate: true,
          timeout: REQUEST_THROTTLE_CONFIG.BATCH_SYNC_TIMEOUT 
        }
      );
      
      // 更新缓存
      if (!result.error && result.data) {
        const ids = new Set<string>();
        for (const row of result.data) {
          ids.add(row.task_id);
        }
        this.tombstoneCache.set(projectId, { ids, timestamp: now });
        this.logger.debug('更新 Tombstone 缓存', { projectId, count: ids.size });
      }
      
      return result;
    } catch (e) {
      return { data: null, error: e as Error };
    }
  }
  
  /**
   * 清除 Tombstone 缓存（当有新的删除操作时）
   */
  invalidateTombstoneCache(projectId: string): void {
    this.tombstoneCache.delete(projectId);
    this.connectionTombstoneCache.delete(projectId);
  }
  
  /**
   * 获取缓存的 tombstone ID 集合
   */
  getCachedTombstoneIds(projectId: string): Set<string> | null {
    const cached = this.tombstoneCache.get(projectId);
    if (cached && (Date.now() - cached.timestamp) < SYNC_CONFIG.TOMBSTONE_CACHE_TTL) {
      return cached.ids;
    }
    return null;
  }
  
  /**
   * 更新 tombstone 缓存
   */
  updateTombstoneCache(projectId: string, ids: Set<string>): void {
    this.tombstoneCache.set(projectId, { ids, timestamp: Date.now() });
  }
  
  /**
   * 获取连接 tombstone 缓存
   */
  getConnectionTombstoneCache(projectId: string): Set<string> | null {
    const cached = this.connectionTombstoneCache.get(projectId);
    if (cached && (Date.now() - cached.timestamp) < SYNC_CONFIG.TOMBSTONE_CACHE_TTL) {
      return cached.ids;
    }
    return null;
  }
  
  /**
   * 更新连接 tombstone 缓存
   */
  updateConnectionTombstoneCache(projectId: string, ids: Set<string>): void {
    this.connectionTombstoneCache.set(projectId, { ids, timestamp: Date.now() });
  }

  /**
   * 判断任务 upsert 是否应被 tombstone 拦截（防复活）
   */
  shouldRejectTaskUpsert(projectId: string, taskId: string, candidateUpdatedAt?: string | null): boolean {
    // 本地 tombstone 始终优先拒绝（用户主动删除，尚未同步到云端）
    const localIds = this.getLocalTombstones(projectId);
    if (localIds.has(taskId)) {
      return true;
    }

    const cachedIds = this.getCachedTombstoneIds(projectId);
    if (!cachedIds) {
      return false;
    }

    if (!cachedIds.has(taskId)) {
      return false;
    }

    // 候选更新时间未知时，默认拒绝（删除优先）
    if (!candidateUpdatedAt) {
      return true;
    }

    // 云端 tombstone 存在，但候选更新时间已知：
    // 如果候选的 updatedAt 比 tombstone 缓存时间更新，说明可能是合法恢复
    const cacheEntry = this.tombstoneCache.get(projectId);
    if (cacheEntry && new Date(candidateUpdatedAt).getTime() > cacheEntry.timestamp) {
      this.logger.info('任务 upsert 的 updatedAt 晚于 tombstone 缓存，允许恢复', {
        projectId, taskId, candidateUpdatedAt, cacheTimestamp: cacheEntry.timestamp
      });
      return false;
    }

    return true;
  }

  private cleanupExpiredLocalTombstones(projectId?: string): void {
    const cutoff = Date.now() - SYNC_CONFIG.TOMBSTONE_RETENTION_MS;
    const targetProjects = projectId ? [projectId] : Array.from(this.localTombstones.keys());
    let cleaned = 0;

    for (const pid of targetProjects) {
      const records = this.localTombstones.get(pid);
      if (!records) {
        continue;
      }
      for (const [taskId, timestamp] of records.entries()) {
        if (timestamp < cutoff) {
          records.delete(taskId);
          cleaned++;
        }
      }
      if (records.size === 0) {
        this.localTombstones.delete(pid);
      }
    }

    if (cleaned > 0) {
      this.logger.info('已清理过期本地 tombstone', {
        projectId: projectId ?? 'all',
        cleaned,
        retentionMs: SYNC_CONFIG.TOMBSTONE_RETENTION_MS
      });
      this.saveLocalTombstones();
    }
  }
  
  // ==================== 附件存储清理 ====================
  
  /**
   * 删除 Storage 中的附件文件
   * 
   * 【v5.7 附件-任务删除联动】
   * 在任务永久删除时，清理关联的附件文件
   * 异步执行，不阻塞任务删除操作
   * 
   * @param client Supabase 客户端
   * @param paths 附件存储路径列表
   */
  async deleteAttachmentFilesFromStorage(
    client: SupabaseClient | null,
    paths: string[]
  ): Promise<void> {
    if (!client || paths.length === 0) return;
    
    try {
      // 批量删除，每次最多 100 个
      const batchSize = 100;
      for (let i = 0; i < paths.length; i += batchSize) {
        const batch = paths.slice(i, i + batchSize);
        const { error } = await client.storage
          .from('attachments')
          .remove(batch);
        
        if (error) {
          this.logger.warn('deleteAttachmentFilesFromStorage: 批量删除失败', {
            batch: batch.slice(0, 5),
            batchSize: batch.length,
            error: error.message
          });
          // 继续删除下一批，不抛出异常
        } else {
          this.logger.debug('deleteAttachmentFilesFromStorage: 批量删除成功', {
            batchIndex: i / batchSize,
            batchSize: batch.length
          });
        }
      }
      
      this.logger.info('deleteAttachmentFilesFromStorage: 完成', {
        totalPaths: paths.length
      });
    } catch (e) {
      this.logger.error('deleteAttachmentFilesFromStorage: 异常', e);
      // 不抛出，因为任务已经删除，附件清理失败只是资源浪费，不影响功能
    }
  }
  
  // ==================== 便捷 API ====================
  
  /**
   * 获取任务 tombstone ID 列表
   * 返回本地缓存的所有 tombstone IDs（不查询云端）
   */
  getTaskTombstones(projectId: string): string[] {
    return Array.from(this.getLocalTombstones(projectId));
  }

  /**
   * 导出本地 tombstones（兼容历史 API）
   */
  exportLocalTombstones(): Record<string, string[]> {
    const data: Record<string, string[]> = {};
    for (const [projectId, ids] of this.localTombstones.entries()) {
      data[projectId] = Array.from(ids.keys());
    }
    return data;
  }
  
  /**
   * 失效缓存（invalidateTombstoneCache 的别名）
   */
  invalidateCache(projectId: string): void {
    this.invalidateTombstoneCache(projectId);
  }
  
  // ==================== 连接 Tombstone 管理 ====================
  
  /** 本地连接 tombstone */
  private localConnectionTombstones = new Map<string, { id: string; timestamp: number }[]>();
  
  /**
   * 记录连接删除
   */
  recordConnectionDeletion(connectionId: string, timestamp: number): void {
    const key = 'global'; // 连接 tombstone 不按项目分组
    if (!this.localConnectionTombstones.has(key)) {
      this.localConnectionTombstones.set(key, []);
    }
    this.localConnectionTombstones.get(key)!.push({ id: connectionId, timestamp });
    
    // 清理过期的 tombstone
    const cutoff = Date.now() - SYNC_CONFIG.TOMBSTONE_RETENTION_MS;
    const filtered = this.localConnectionTombstones.get(key)!.filter(
      t => t.timestamp > cutoff
    );
    this.localConnectionTombstones.set(key, filtered);
  }
  
  /**
   * 获取连接 tombstone 列表
   */
  getConnectionTombstones(): { id: string; timestamp: number }[] {
    return this.localConnectionTombstones.get('global') || [];
  }
}
