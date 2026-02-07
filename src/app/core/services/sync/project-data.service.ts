/**
 * ProjectDataService - 项目数据加载服务
 * 
 * 职责：
 * - 完整项目加载 (loadFullProject, loadFullProjectOptimized)
 * - 项目列表加载 (loadProjectsFromCloud)
 * - 单个项目加载 (loadSingleProject)
 * - 离线快照管理 (saveOfflineSnapshot, loadOfflineSnapshot)
 * 
 * 从 SimpleSyncService 提取，Sprint 9 技术债务修复
 */

import { Injectable, inject, signal } from '@angular/core';
import { SupabaseClientService } from '../../../../services/supabase-client.service';
import { LoggerService } from '../../../../services/logger.service';
import { RequestThrottleService } from '../../../../services/request-throttle.service';
import { SyncStateService } from './sync-state.service';
import { TombstoneService } from './tombstone.service';
import { Task, Project, Connection } from '../../../../models';
import { TaskRow, ProjectRow, ConnectionRow } from '../../../../models/supabase-types';
import { supabaseErrorToError, classifySupabaseClientFailure } from '../../../../utils/supabase-error';
import { REQUEST_THROTTLE_CONFIG, FIELD_SELECT_CONFIG, CACHE_CONFIG, AUTH_CONFIG } from '../../../../config';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SentryLazyLoaderService } from '../../../../services/sentry-lazy-loader.service';
@Injectable({
  providedIn: 'root'
})
export class ProjectDataService {
  private readonly sentryLazyLoader = inject(SentryLazyLoaderService);
  private readonly supabase = inject(SupabaseClientService);
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('ProjectData');
  private readonly throttle = inject(RequestThrottleService);
  private readonly syncState = inject(SyncStateService);
  private readonly tombstoneService = inject(TombstoneService);
  
  /** 是否正在从远程加载 */
  readonly isLoadingRemote = signal(false);
  
  /** 离线缓存配置 */
  private readonly OFFLINE_CACHE_KEY = CACHE_CONFIG.OFFLINE_CACHE_KEY;
  private readonly CACHE_VERSION = CACHE_CONFIG.CACHE_VERSION;
  
  /**
   * 获取 Supabase 客户端
   */
  private getSupabaseClient(): SupabaseClient | null {
    if (!this.supabase.isConfigured) {
      const failure = classifySupabaseClientFailure(false);
      this.logger.warn('无法获取 Supabase 客户端', failure);
      this.syncState.setSyncError(failure.message);
      return null;
    }
    try {
      return this.supabase.client();
    } catch (error) {
      const failure = classifySupabaseClientFailure(true, error);
      this.logger.warn('无法获取 Supabase 客户端', {
        category: failure.category,
        message: failure.message
      });
      this.syncState.setSyncError(failure.message);
      // eslint-disable-next-line no-restricted-syntax -- 按既有契约返回 null，调用方据此切换到本地快照分支
      return null;
    }
  }
  
  /**
   * 使用 RPC 批量加载完整项目数据
   * 
   * 优化效果：
   * - 将 4+ 个 API 请求合并为 1 个 RPC 调用
   * - 减少 ~70% 的网络往返时间
   */
  async loadFullProjectOptimized(projectId: string): Promise<Project | null> {
    const client = this.getSupabaseClient();
    if (!client) return null;

    try {
      this.logger.debug('使用 RPC 批量加载项目', { projectId });
      
      const { data, error } = await client.rpc('get_full_project_data', {
        p_project_id: projectId
      });

      if (error) {
        this.logger.warn('RPC 调用失败，回退到顺序加载', { error: error.message });
        return this.loadFullProject(projectId);
      }
      
      if (!data?.project) {
        this.logger.warn('RPC 返回空数据', { projectId });
        return null;
      }

      // 转换 RPC 返回的数据格式
      const project = this.rowToProject(data.project);
      
      // 过滤 tombstones 中的已删除项
      const taskTombstoneSet = new Set<string>(data.task_tombstones || []);
      const connectionTombstoneSet = new Set<string>(data.connection_tombstones || []);
      
      project.tasks = (data.tasks || [])
        .filter((t: TaskRow) => !taskTombstoneSet.has(t.id))
        .map((t: TaskRow) => this.rowToTask(t));
      
      project.connections = (data.connections || [])
        .filter((c: ConnectionRow) => !connectionTombstoneSet.has(c.id))
        .map((c: ConnectionRow) => this.rowToConnection(c));

      this.logger.info('RPC 批量加载成功', { 
        projectId, 
        tasksCount: project.tasks.length,
        connectionsCount: project.connections.length
      });

      return project;
    } catch (e) {
      this.logger.error('批量加载项目失败', e);
      this.sentryLazyLoader.captureException(e, {
        tags: { operation: 'loadFullProjectOptimized' },
        extra: { projectId }
      });
      return this.loadFullProject(projectId);
    }
  }
  
  /**
   * 加载完整项目（包含任务和连接）
   * 使用请求限流避免连接池耗尽
   */
  async loadFullProject(projectId: string): Promise<Project | null> {
    const client = this.getSupabaseClient();
    if (!client) return null;
    
    try {
      // 1. 加载项目元数据
      const projectData = await this.throttle.execute(
        `project-meta:${projectId}`,
        async () => {
          const { data, error } = await client
            .from('projects')
            .select(FIELD_SELECT_CONFIG.PROJECT_LIST_FIELDS)
            .eq('id', projectId)
            .single();
          if (error) throw error;
          return data;
        },
        { 
          deduplicate: true, 
          priority: 'normal',
          timeout: REQUEST_THROTTLE_CONFIG.BATCH_SYNC_TIMEOUT
        }
      );
      
      // 2. 顺序加载任务和连接
      const tasks = await this.pullTasksThrottled(projectId, client);
      const connectionsData = await this.throttle.execute(
        `connections:${projectId}`,
        async () => {
          const { data } = await client
            .from('connections')
            .select(FIELD_SELECT_CONFIG.CONNECTION_FIELDS)
            .eq('project_id', projectId);
          return data || [];
        },
        { 
          deduplicate: true, 
          priority: 'normal',
          timeout: REQUEST_THROTTLE_CONFIG.BATCH_SYNC_TIMEOUT
        }
      );
      
      // 3. 转换连接数据
      const connections: Connection[] = connectionsData.map((row: Record<string, unknown>) => ({
        id: String(row.id),
        source: String(row.source_id),
        target: String(row.target_id),
        title: row.title ? String(row.title) : undefined,
        description: String(row.description || ''),
        deletedAt: row.deleted_at ? String(row.deleted_at) : null,
        updatedAt: row.updated_at ? String(row.updated_at) : undefined
      }));
      
      const project = this.rowToProject(projectData);
      project.tasks = tasks;
      project.connections = connections;
      
      return project;
    } catch (e) {
      this.logger.error('加载项目失败', e);
      this.sentryLazyLoader.captureException(e, {
        tags: { operation: 'loadFullProject' },
        extra: { projectId }
      });
      // eslint-disable-next-line no-restricted-syntax -- 保持 API 契约：异常时返回 null 交由调用方进行回退处理
      return null;
    }
  }
  
  /**
   * 加载项目列表
   */
  async loadProjectsFromCloud(userId: string): Promise<Project[]> {
    // 本地模式不查询 Supabase
    if (userId === AUTH_CONFIG.LOCAL_MODE_USER_ID) {
      this.logger.debug('本地模式，跳过云端加载');
      return [];
    }

    const client = this.getSupabaseClient();
    if (!client) return [];
    
    this.isLoadingRemote.set(true);
    
    try {
      // 1. 加载项目列表
      const projectList = await this.throttle.execute(
        `project-list:${userId}`,
        async () => {
          const { data, error } = await client
            .from('projects')
            .select(FIELD_SELECT_CONFIG.PROJECT_LIST_FIELDS)
            .eq('owner_id', userId)
            .order('updated_at', { ascending: false });
          
          if (error) throw supabaseErrorToError(error);
          return data || [];
        },
        { 
          deduplicate: true, 
          priority: 'high',
          timeout: REQUEST_THROTTLE_CONFIG.BATCH_SYNC_TIMEOUT, 
          retries: 5 
        }
      );
      
      // 2. 批量加载完整项目数据
      this.logger.debug('开始批量加载项目', { count: projectList.length });
      
      const loadPromises = projectList.map(row => 
        this.loadFullProjectOptimized(row.id)
      );
      
      const results = await Promise.allSettled(loadPromises);
      
      const projects: Project[] = [];
      let failedCount = 0;
      
      for (let i = 0; i < results.length; i++) {
        const result = results[i];
        if (result.status === 'fulfilled' && result.value) {
          projects.push(result.value);
        } else if (result.status === 'rejected') {
          failedCount++;
          this.logger.warn('加载项目失败', { 
            projectId: projectList[i]?.id,
            error: result.reason 
          });
        }
      }
      
      if (failedCount > 0) {
        this.logger.warn('部分项目加载失败', { 
          total: projectList.length, 
          failed: failedCount,
          success: projects.length 
        });
      }
      
      return projects;
    } catch (e) {
      this.logger.error('加载项目列表失败', e);
      this.sentryLazyLoader.captureException(e, {
        tags: { operation: 'loadProjectsFromCloud' }
      });
      return [];
    } finally {
      this.isLoadingRemote.set(false);
    }
  }
  
  /**
   * 加载单个项目
   */
  async loadSingleProject(projectId: string): Promise<Project | null> {
    return this.loadFullProjectOptimized(projectId);
  }
  
  /**
   * 拉取任务（带限流和 tombstone 处理）
   */
  private async pullTasksThrottled(projectId: string, client: SupabaseClient): Promise<Task[]> {
    this.sentryLazyLoader.addBreadcrumb({
      category: 'sync',
      message: 'Loading tasks with tombstones',
      level: 'info',
      data: { projectId }
    });
    
    const tasksResult = await this.throttle.execute(
      `tasks-data:${projectId}`,
      async () => {
        return await client
          .from('tasks')
          .select(FIELD_SELECT_CONFIG.TASK_LIST_FIELDS)
          .eq('project_id', projectId);
      },
      { 
        deduplicate: true,
        timeout: REQUEST_THROTTLE_CONFIG.BATCH_SYNC_TIMEOUT 
      }
    );
    
    const tombstonesResult = await this.tombstoneService.getTombstonesWithCache(projectId, client);
    
    if (tasksResult.error) throw supabaseErrorToError(tasksResult.error);
    
    // 构建 tombstone ID 集合
    const tombstoneIds = new Set<string>();
    
    if (!tombstonesResult.error) {
      for (const t of (tombstonesResult.data || [])) {
        tombstoneIds.add(t.task_id);
      }
    }
    
    // 合并本地 tombstones
    const localTombstones = this.tombstoneService.getLocalTombstones(projectId);
    for (const id of localTombstones) {
      tombstoneIds.add(id);
    }
    
    // 转换任务并标记 tombstone
    const allTasks = (tasksResult.data as TaskRow[] || []).map(row => this.rowToTask(row));
    
    return allTasks.map(task => {
      if (tombstoneIds.has(task.id)) {
        return { ...task, deletedAt: task.deletedAt || new Date().toISOString() };
      }
      return task;
    });
  }
  
  addLocalTombstones(projectId: string, taskIds: string[]): void {
    this.tombstoneService.addLocalTombstones(projectId, taskIds);
  }
  
  /**
   * 清除 tombstone 缓存
   */
  invalidateTombstoneCache(projectId: string): void {
    this.tombstoneService.invalidateTombstoneCache(projectId);
  }
  
  // ==================== 离线快照 ====================
  
  /**
   * 保存离线快照
   */
  saveOfflineSnapshot(projects: Project[]): void {
    if (typeof localStorage === 'undefined') return;
    try {
      // 过滤已删除的任务
      const cleanedProjects = projects.map(p => ({
        ...p,
        tasks: (p.tasks || []).filter(t => !t.deletedAt)
      }));
      
      localStorage.setItem(this.OFFLINE_CACHE_KEY, JSON.stringify({
        projects: cleanedProjects,
        version: this.CACHE_VERSION
      }));
    } catch (e) {
      this.logger.warn('离线快照保存失败', e);
    }
  }
  
  /**
   * 加载离线快照
   */
  loadOfflineSnapshot(): Project[] | null {
    if (typeof localStorage === 'undefined') return null;
    try {
      const cached = localStorage.getItem(this.OFFLINE_CACHE_KEY);
      if (cached) {
        const parsed = JSON.parse(cached);
        if (Array.isArray(parsed?.projects)) {
          return parsed.projects.map((p: Project) => ({
            ...p,
            tasks: (p.tasks || []).filter((t: Task) => !t.deletedAt)
          }));
        }
      }
    } catch (e) {
      this.logger.warn('离线快照加载失败', e);
    }
    return null;
  }
  
  /**
   * 清除离线快照
   */
  clearOfflineSnapshot(): void {
    if (typeof localStorage === 'undefined') return;
    try {
      localStorage.removeItem(this.OFFLINE_CACHE_KEY);
      this.logger.info('离线快照已清除');
    } catch (e) {
      this.logger.warn('清除离线快照失败', e);
    }
  }
  
  // ==================== 数据转换（Public API）====================
  
  /**
   * 数据库行转换为 Project 模型
   */
  rowToProject(row: ProjectRow | Partial<ProjectRow>): Project {
    return {
      id: row.id || '',
      name: row.title || '',
      description: row.description || '',
      createdDate: row.created_date || '',
      updatedAt: row.updated_at || undefined,
      version: row.version || 1,
      syncSource: 'synced',
      pendingSync: false,
      tasks: [],
      connections: []
    };
  }
  
  /**
   * 数据库行转换为 Task 模型
   * 【P0 防护】检测 content 字段是否缺失
   */
  rowToTask(row: TaskRow | Partial<TaskRow>): Task {
    // 【P0 防护】检测 content 字段是否缺失
    if (!('content' in row)) {
      this.logger.warn('rowToTask: content 字段缺失，可能导致数据丢失！', { 
        taskId: row.id,
        hasTitle: 'title' in row,
        hasStage: 'stage' in row
      });
      
      // 【Sentry 监控】采样率 10% 上报
      const isDev = typeof window !== 'undefined' && window.location?.hostname === 'localhost';
      if (isDev || Math.random() < 0.1) {
        this.sentryLazyLoader.captureMessage('Sync Warning: Task content field missing', {
          level: 'warning',
          tags: { operation: 'rowToTask', taskId: row.id || 'unknown' },
          extra: { rowKeys: Object.keys(row) }
        });
      }
    }
    
    return {
      id: row.id || '',
      title: row.title || '',
      content: row.content ?? '',
      stage: row.stage ?? null,
      parentId: row.parent_id ?? null,
      order: row.order || 0,
      rank: row.rank || 0,
      status: (row.status as 'active' | 'completed' | 'archived') || 'active',
      x: row.x || 0,
      y: row.y || 0,
      createdDate: row.created_at || '',
      updatedAt: row.updated_at,
      displayId: '',
      shortId: row.short_id || undefined,
      deletedAt: row.deleted_at || undefined
    };
  }
  
  /**
   * 数据库行转换为 Connection 模型
   */
  rowToConnection(row: ConnectionRow | Partial<ConnectionRow>): Connection {
    return {
      id: row.id || '',
      source: row.source_id || '',
      target: row.target_id || '',
      title: row.title || undefined,
      description: row.description || undefined,
      deletedAt: row.deleted_at || undefined,
      updatedAt: row.updated_at || undefined
    };
  }
}
