import { Injectable, inject } from '@angular/core';
import { SupabaseClient } from '@supabase/supabase-js';
import { LoggerService } from '../../../services/logger.service';
import { RequestThrottleService } from '../../../services/request-throttle.service';
import { SYNC_CONFIG, REQUEST_THROTTLE_CONFIG } from '../../../config';

// 字段选择配置（与 SimpleSyncService 保持一致）
const FIELD_SELECT_CONFIG = {
  TOMBSTONE_FIELDS: 'task_id'
} as const;

interface TombstoneCache {
  ids: Set<string>;
  timestamp: number;
}

/**
 * Tombstone 管理服务
 * 处理软删除标记的本地缓存和云端同步
 * 用于防止已删除任务在同步时复活
 */
@Injectable({ providedIn: 'root' })
export class SyncTombstoneService {
  private readonly logger = inject(LoggerService).category('Tombstone');
  private readonly throttle = inject(RequestThrottleService);

  /** 本地 Tombstone 缓存（用于 RPC 不可用时防止任务复活） */
  private localTombstones = new Map<string, Set<string>>();

  /** Tombstone 云端缓存（流量优化） */
  private tombstoneCache = new Map<string, TombstoneCache>();

  /** localStorage 键名 */
  private readonly LOCAL_TOMBSTONES_KEY = 'nanoflow.local_tombstones';

  constructor() {
    this.loadLocalTombstones();
  }

  /**
   * 加载本地 tombstone 缓存
   */
  private loadLocalTombstones(): void {
    if (typeof localStorage === 'undefined') return;

    try {
      const data = localStorage.getItem(this.LOCAL_TOMBSTONES_KEY);
      if (data) {
        const parsed = JSON.parse(data);
        this.localTombstones = new Map(
          Object.entries(parsed).map(([k, v]) => [k, new Set(v as string[])])
        );
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
   * 保存本地 tombstone 缓存
   */
  private saveLocalTombstones(): void {
    if (typeof localStorage === 'undefined') return;

    try {
      const data: Record<string, string[]> = {};
      for (const [projectId, taskIds] of this.localTombstones.entries()) {
        data[projectId] = Array.from(taskIds);
      }
      localStorage.setItem(this.LOCAL_TOMBSTONES_KEY, JSON.stringify(data));
    } catch (e) {
      this.logger.warn('保存本地 tombstone 缓存失败', e);
    }
  }

  /**
   * 添加本地 tombstone（用于在 RPC 不可用时防止任务复活）
   */
  addLocalTombstones(projectId: string, taskIds: string[]): void {
    if (!this.localTombstones.has(projectId)) {
      this.localTombstones.set(projectId, new Set());
    }
    const set = this.localTombstones.get(projectId)!;
    for (const id of taskIds) {
      set.add(id);
    }
    this.saveLocalTombstones();
    this.logger.debug('添加本地 tombstone', { projectId, taskIds });
  }

  /**
   * 获取本地 tombstone
   */
  getLocalTombstones(projectId: string): Set<string> {
    return this.localTombstones.get(projectId) || new Set();
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
  }

  /**
   * 清除所有缓存（用于注销或切换用户时）
   */
  clearAllCaches(): void {
    this.tombstoneCache.clear();
    this.localTombstones.clear();
    this.saveLocalTombstones();
    this.logger.debug('已清除所有 tombstone 缓存');
  }
}
