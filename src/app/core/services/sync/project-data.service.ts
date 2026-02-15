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
import { REQUEST_THROTTLE_CONFIG, FIELD_SELECT_CONFIG, CACHE_CONFIG } from '../../../../config/sync.config';
import { AUTH_CONFIG } from '../../../../config/auth.config';
import { FEATURE_FLAGS } from '../../../../config/feature-flags.config';
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
  private async getSupabaseClient(): Promise<SupabaseClient | null> {
    if (!this.supabase.isConfigured) {
      const failure = classifySupabaseClientFailure(false);
      this.logger.warn('无法获取 Supabase 客户端', failure);
      this.syncState.setSyncError(failure.message);
      return null;
    }
    try {
      return await this.supabase.clientAsync();
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
    const client = await this.getSupabaseClient();
    if (!client) return null;

    try {
      this.logger.debug('使用 RPC 批量加载项目', { projectId });
      
      const { data, error } = await client.rpc('get_full_project_data', {
        p_project_id: projectId
      });

      if (error) {
        // 【性能优化 2026-02-14】区分 Access Denied 与其他错误
        // Access Denied（P0001）说明 projectId 无效或无权限，无需 fallback
        const isAccessDenied = error.code === 'P0001' || error.message?.includes('Access denied');
        if (isAccessDenied) {
          this.logger.warn('项目访问被拒绝，跳过该项目（不走 fallback）', { projectId, errorCode: error.code });
          // 【监控 2026-02-14】上报 RPC 400 Access Denied，用于 Sentry 告警
          this.sentryLazyLoader.addBreadcrumb({
            category: 'sync.rpc',
            message: `RPC Access Denied: projectId=${projectId}`,
            level: 'warning',
            data: { projectId, errorCode: error.code },
          });
          this.sentryLazyLoader.captureMessage('RPC Access Denied (P0001, no fallback)', {
            level: 'warning',
            tags: {
              operation: 'loadFullProjectOptimized',
              classification: 'access_denied'
            },
            extra: {
              projectId,
              errorCode: error.code ?? 'P0001'
            }
          });
          return null;
        }
        // 其他错误（网络、超时等）仍走 fallback 顺序加载
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
      const err = supabaseErrorToError(e);
      this.logger.error('批量加载项目失败', err);
      this.sentryLazyLoader.captureException(err, {
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
    const client = await this.getSupabaseClient();
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
            .maybeSingle();
          if (error) throw supabaseErrorToError(error);
          return data;
        },
        { 
          deduplicate: true, 
          priority: 'normal',
          timeout: REQUEST_THROTTLE_CONFIG.BATCH_SYNC_TIMEOUT
        }
      );
      
      if (!projectData) {
        this.logger.warn('项目不存在或无权访问', { projectId });
        return null;
      }

      // 2. 顺序加载任务和连接
      const tasks = await this.pullTasksThrottled(projectId, client);
      const connectionsData = await this.throttle.execute(
        `connections:${projectId}`,
        async () => {
          const { data, error } = await client
            .from('connections')
            .select(FIELD_SELECT_CONFIG.CONNECTION_FIELDS)
            .eq('project_id', projectId);
          if (error) {
            this.logger.error('连接查询失败', { projectId, error: error.message });
            return [];
          }
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
      const err = supabaseErrorToError(e);
      this.logger.error('加载项目失败', err);
      this.sentryLazyLoader.captureException(err, {
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

    const client = await this.getSupabaseClient();
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
   * 获取项目同步水位（远端聚合最大更新时间）
   *
   * 用于恢复链路先判变更再决定是否拉取完整项目。
   */
  async getProjectSyncWatermark(projectId: string): Promise<string | null> {
    const client = await this.getSupabaseClient();
    if (!client) return null;

    try {
      const { data, error } = await client.rpc('get_project_sync_watermark', {
        p_project_id: projectId
      });

      if (error) {
        throw supabaseErrorToError(error);
      }

      if (typeof data === 'string') {
        return data;
      }

      if (Array.isArray(data) && data.length > 0 && typeof data[0] === 'string') {
        return data[0];
      }

      return null;
    } catch (e) {
      this.logger.warn('获取项目同步水位失败', {
        projectId,
        error: supabaseErrorToError(e).message
      });
      // eslint-disable-next-line no-restricted-syntax -- 水位 RPC 失败时降级为慢路拉取，由调用方决定后续策略
      return null;
    }
  }

  /**
   * 获取当前用户项目域聚合同步水位
   */
  async getUserProjectsWatermark(): Promise<string | null> {
    const client = await this.getSupabaseClient();
    if (!client) return null;

    try {
      const { data, error } = await client.rpc('get_user_projects_watermark');
      if (error) {
        throw supabaseErrorToError(error);
      }

      if (typeof data === 'string') {
        return data;
      }
      if (Array.isArray(data) && data.length > 0 && typeof data[0] === 'string') {
        return data[0];
      }
      return null;
    } catch (e) {
      this.logger.warn('获取用户项目域同步水位失败', {
        error: supabaseErrorToError(e).message
      });
      // eslint-disable-next-line no-restricted-syntax -- RPC 失败时降级为全量拉取（null 触发 fallback）
      return null;
    }
  }

  /**
   * 拉取给定水位之后发生变化的项目头信息
   */
  async listProjectHeadsSince(
    watermark: string | null
  ): Promise<Array<{ id: string; updatedAt: string; version: number }>> {
    const client = await this.getSupabaseClient();
    if (!client) return [];

    try {
      const { data, error } = await client.rpc('list_project_heads_since', {
        p_since: watermark
      });
      if (error) {
        throw supabaseErrorToError(error);
      }

      const rows = Array.isArray(data) ? data : [];
      return rows
        .map((row) => ({
          id: String((row as Record<string, unknown>)['project_id'] ?? ''),
          updatedAt: String((row as Record<string, unknown>)['updated_at'] ?? ''),
          version: Number((row as Record<string, unknown>)['version'] ?? 1),
        }))
        .filter((row) => !!row.id && !!row.updatedAt);
    } catch (e) {
      this.logger.warn('拉取项目头信息失败', {
        watermark,
        error: supabaseErrorToError(e).message
      });
      return [];
    }
  }

  /**
   * 获取当前 activeProject 的访问性与聚合水位
   *
   * 单次 RPC 完成“可访问性 + 是否有更新”探测，避免恢复链路多步串行请求。
   */
  async getAccessibleProjectProbe(projectId: string): Promise<{
    projectId: string;
    accessible: boolean;
    watermark: string | null;
  } | null> {
    const client = await this.getSupabaseClient();
    if (!client) return null;

    try {
      const { data, error } = await client.rpc('get_accessible_project_probe', {
        p_project_id: projectId
      });
      if (error) {
        throw supabaseErrorToError(error);
      }

      const row = Array.isArray(data) ? data[0] : data;
      if (!row || typeof row !== 'object') {
        return null;
      }
      const record = row as Record<string, unknown>;
      return {
        projectId: String(record['project_id'] ?? projectId),
        accessible: Boolean(record['accessible']),
        watermark: record['watermark'] ? String(record['watermark']) : null,
      };
    } catch (e) {
      this.logger.warn('获取项目访问探测失败', {
        projectId,
        error: supabaseErrorToError(e).message
      });
      // eslint-disable-next-line no-restricted-syntax -- RPC 失败时返回 null 触发调用方降级逻辑
      return null;
    }
  }

  /**
   * 获取黑匣子域聚合同步水位（当前用户）
   */
  async getBlackBoxSyncWatermark(): Promise<string | null> {
    const client = await this.getSupabaseClient();
    if (!client) return null;

    try {
      const { data, error } = await client.rpc('get_black_box_sync_watermark');
      if (error) {
        throw supabaseErrorToError(error);
      }

      if (typeof data === 'string') {
        return data;
      }
      if (Array.isArray(data) && data.length > 0 && typeof data[0] === 'string') {
        return data[0];
      }
      return null;
    } catch (e) {
      this.logger.warn('获取黑匣子同步水位失败', {
        error: supabaseErrorToError(e).message
      });
      // eslint-disable-next-line no-restricted-syntax -- RPC 失败时降级为明细拉取（null 触发 fallback）
      return null;
    }
  }

  /**
   * 恢复链路聚合探测：一次 RPC 返回 activeProject + 项目域 + 黑匣子域水位
   */
  async getResumeRecoveryProbe(projectId?: string): Promise<{
    activeProjectId: string | null;
    activeAccessible: boolean;
    activeWatermark: string | null;
    projectsWatermark: string | null;
    blackboxWatermark: string | null;
    serverNow: string | null;
  } | null> {
    const client = await this.getSupabaseClient();
    if (!client) return null;

    try {
      const { data, error } = await client.rpc('get_resume_recovery_probe', {
        p_project_id: projectId ?? null,
      });
      if (error) {
        throw supabaseErrorToError(error);
      }

      const row = Array.isArray(data) ? data[0] : data;
      if (!row || typeof row !== 'object') {
        return null;
      }
      const record = row as Record<string, unknown>;
      return {
        activeProjectId: record['active_project_id'] ? String(record['active_project_id']) : null,
        activeAccessible: Boolean(record['active_accessible']),
        activeWatermark: record['active_watermark'] ? String(record['active_watermark']) : null,
        projectsWatermark: record['projects_watermark'] ? String(record['projects_watermark']) : null,
        blackboxWatermark: record['blackbox_watermark'] ? String(record['blackbox_watermark']) : null,
        serverNow: record['server_now'] ? String(record['server_now']) : null,
      };
    } catch (e) {
      this.logger.warn('恢复链路聚合探测失败，降级为分步探测', {
        projectId,
        error: supabaseErrorToError(e).message
      });
      // eslint-disable-next-line no-restricted-syntax -- 聚合 RPC 失败时降级为分步探测（null 触发调用方 fallback）
      return null;
    }
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
   * 
   * 优先使用 IndexedDB（当 OFFLINE_SNAPSHOT_IDB_ENABLED 开启时），
   * 降级回 localStorage。记录快照大小用于监控。
   */
  saveOfflineSnapshot(projects: Project[]): void {
    // 过滤已删除的任务
    const cleanedProjects = projects.map(p => ({
      ...p,
      tasks: (p.tasks || []).filter(t => !t.deletedAt)
    }));
    
    const payload = JSON.stringify({
      projects: cleanedProjects,
      version: this.CACHE_VERSION
    });
    
    const sizeKB = Math.round(payload.length / 1024);
    this.logger.debug('离线快照大小', { sizeKB, projectCount: projects.length });
    
    // 快照超过 4MB 时发出 Sentry 警告（接近 localStorage 5MB 上限）
    if (sizeKB > 4096) {
      this.sentryLazyLoader.captureMessage('Offline snapshot exceeds 4MB', {
        level: 'warning',
        tags: { sizeKB: String(sizeKB), projectCount: String(projects.length) }
      });
    }
    
    // IDB 路径：特性开关开启时尝试 IndexedDB
    if (FEATURE_FLAGS.OFFLINE_SNAPSHOT_IDB_ENABLED) {
      void this.saveSnapshotToIDB(payload).catch(() => {
        // IDB 失败时降级到 localStorage
        this.saveSnapshotToLocalStorage(payload);
      });
      return;
    }
    
    this.saveSnapshotToLocalStorage(payload);
  }
  
  /** localStorage 保存快照 */
  private saveSnapshotToLocalStorage(payload: string): void {
    if (typeof localStorage === 'undefined') return;
    try {
      localStorage.setItem(this.OFFLINE_CACHE_KEY, payload);
    } catch (e) {
      this.logger.warn('离线快照保存失败（localStorage）', e);
    }
  }
  
  /** IndexedDB 保存快照 */
  private async saveSnapshotToIDB(payload: string): Promise<void> {
    const db = await this.openSnapshotDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('snapshots', 'readwrite');
      tx.objectStore('snapshots').put({ id: 'offline-snapshot', data: payload });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
  
  /** IndexedDB 加载快照 */
  private async loadSnapshotFromIDB(): Promise<string | null> {
    const db = await this.openSnapshotDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('snapshots', 'readonly');
      const req = tx.objectStore('snapshots').get('offline-snapshot');
      req.onsuccess = () => resolve(req.result?.data ?? null);
      req.onerror = () => reject(req.error);
    });
  }
  
  /** 打开快照 IndexedDB */
  private openSnapshotDB(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('nanoflow-offline-snapshots', 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('snapshots')) {
          db.createObjectStore('snapshots', { keyPath: 'id' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  
  /**
   * 加载离线快照
   * 当 IDB 开关开启时优先从 IDB 读取，降级回 localStorage
   */
  loadOfflineSnapshot(): Project[] | null {
    // IDB 路径不能同步返回，但这个方法签名是同步的
    // 保留 localStorage 作为同步路径，IDB 路径需要在外部 async 调用
    return this.loadOfflineSnapshotFromLocalStorage();
  }
  
  /**
   * 异步加载离线快照（支持 IDB）
   */
  async loadOfflineSnapshotAsync(): Promise<Project[] | null> {
    if (FEATURE_FLAGS.OFFLINE_SNAPSHOT_IDB_ENABLED) {
      try {
        const data = await this.loadSnapshotFromIDB();
        if (data) {
          return this.parseSnapshotData(data);
        }
      } catch {
        this.logger.warn('IDB 离线快照加载失败，降级到 localStorage');
      }
    }
    return this.loadOfflineSnapshotFromLocalStorage();
  }
  
  /** 从 localStorage 加载快照 */
  private loadOfflineSnapshotFromLocalStorage(): Project[] | null {
    if (typeof localStorage === 'undefined') return null;
    try {
      const cached = localStorage.getItem(this.OFFLINE_CACHE_KEY);
      if (cached) {
        return this.parseSnapshotData(cached);
      }
    } catch (e) {
      this.logger.warn('离线快照加载失败', e);
    }
    return null;
  }
  
  /** 解析快照 JSON 数据 */
  private parseSnapshotData(raw: string): Project[] | null {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed?.projects)) {
        return parsed.projects.map((p: Project) => ({
          ...p,
          tasks: (p.tasks || []).filter((t: Task) => !t.deletedAt)
        }));
      }
    } catch (e) {
      this.logger.warn('快照数据解析失败', e);
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
