import { Injectable, inject, signal } from '@angular/core';
import type { RealtimeChannel, RealtimePostgresChangesPayload } from '@supabase/supabase-js';
import { SupabaseClientService } from './supabase-client.service';
import { TaskRepositoryService } from './task-repository.service';
import { Project, ProjectRow, SyncState, UserPreferences, ThemeType, Task, Connection } from '../models';
import { SYNC_CONFIG, CACHE_CONFIG } from '../config/constants';

/**
 * 数据库版本标识
 * v1: JSONB 存储 (data 列)
 * v2: 独立表存储 (tasks, connections 表)
 */
type DataVersion = 'v1' | 'v2';

/**
 * 数据同步服务
 * 负责与 Supabase 的数据同步、离线缓存、实时订阅
 * 支持 v1 (JSONB) 和 v2 (独立表) 两种数据存储格式
 */
@Injectable({
  providedIn: 'root'
})
export class SyncService {
  private supabase = inject(SupabaseClientService);
  private taskRepo = inject(TaskRepositoryService);
  
  /** 同步状态 */
  readonly syncState = signal<SyncState>({
    isSyncing: false,
    isOnline: typeof window !== 'undefined' ? navigator.onLine : true,
    offlineMode: false,
    sessionExpired: false,
    syncError: null,
    hasConflict: false,
    conflictData: null
  });
  
  /** 是否正在加载远程数据 */
  readonly isLoadingRemote = signal(false);
  
  /** 实时订阅通道 */
  private realtimeChannel: RealtimeChannel | null = null;
  
  /** 任务表订阅通道 */
  private tasksChannel: RealtimeChannel | null = null;
  
  /** 远程变更处理定时器 */
  private remoteChangeTimer: ReturnType<typeof setTimeout> | null = null;
  
  /** 远程变更回调 - 支持增量更新 */
  private onRemoteChangeCallback: ((payload?: { eventType: string; projectId: string; data?: any }) => Promise<void>) | null = null;
  
  /** 任务级别的变更回调 - 用于细粒度更新 */
  private onTaskChangeCallback: ((payload: { eventType: string; taskId: string; projectId: string; data?: any }) => void) | null = null;

  constructor() {
    this.setupNetworkListeners();
  }

  /**
   * 设置网络状态监听
   */
  private setupNetworkListeners() {
    if (typeof window === 'undefined') return;
    
    window.addEventListener('online', () => {
      this.syncState.update(s => ({ ...s, isOnline: true }));
    });
    
    window.addEventListener('offline', () => {
      this.syncState.update(s => ({ ...s, isOnline: false }));
    });
  }

  /**
   * 设置远程变更回调
   */
  setRemoteChangeCallback(callback: (payload?: { eventType: string; projectId: string; data?: any }) => Promise<void>) {
    this.onRemoteChangeCallback = callback;
  }
  
  /**
   * 设置任务级变更回调（用于细粒度更新）
   */
  setTaskChangeCallback(callback: (payload: { eventType: string; taskId: string; projectId: string; data?: any }) => void) {
    this.onTaskChangeCallback = callback;
  }

  /**
   * 初始化实时订阅
   * 订阅项目级别和任务级别的变更
   */
  async initRealtimeSubscription(userId: string) {
    if (!this.supabase.isConfigured || !userId) return;
    
    this.teardownRealtimeSubscription();

    // 项目级别订阅
    const channel = this.supabase.client()
      .channel(`user-${userId}-changes`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'projects',
          filter: `owner_id=eq.${userId}`
        },
        payload => {
          console.log('收到项目变更:', payload.eventType);
          void this.handleRemoteChange(payload);
        }
      );

    this.realtimeChannel = channel;
    
    channel.subscribe((status, err) => {
      if (status === 'SUBSCRIBED') {
        console.info('✅ Realtime channel ready');
        // 更新同步状态
        this.syncState.update(s => ({
          ...s,
          isOnline: true,
          offlineMode: false
        }));
      } else if (status === 'CLOSED' || status === 'CHANNEL_ERROR') {
        console.warn('⚠️ Realtime channel error:', err);
        this.syncState.update(s => ({
          ...s,
          offlineMode: true
        }));
      }
    });
    
    // 任务级别订阅（v2 表结构）
    const tasksChannel = this.supabase.client()
      .channel(`user-${userId}-tasks`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'tasks'
        },
        payload => {
          console.log('收到任务变更:', payload.eventType);
          void this.handleTaskChange(payload);
        }
      );
    
    this.tasksChannel = tasksChannel;
    tasksChannel.subscribe();
  }

  /**
   * 处理远程变更
   */
  private async handleRemoteChange(payload: RealtimePostgresChangesPayload<Record<string, unknown>>) {
    if (!this.onRemoteChangeCallback) return;
    
    // 防抖处理
    if (this.remoteChangeTimer) {
      clearTimeout(this.remoteChangeTimer);
    }
    
    this.remoteChangeTimer = setTimeout(async () => {
      try {
        // 提取变更信息用于增量更新
        const eventType = payload.eventType;
        const newRecord = payload.new as Record<string, unknown>;
        const oldRecord = payload.old as Record<string, unknown>;
        const projectId = (newRecord?.id || oldRecord?.id) as string;
        
        await this.onRemoteChangeCallback!({
          eventType,
          projectId,
          data: newRecord
        });
      } catch (e) {
        console.error('处理实时更新失败', e);
      } finally {
        this.remoteChangeTimer = null;
      }
    }, SYNC_CONFIG.REMOTE_CHANGE_DELAY);
  }

  /**
   * 处理任务级别变更（v2 表结构）
   */
  private async handleTaskChange(payload: RealtimePostgresChangesPayload<Record<string, unknown>>) {
    if (!this.onTaskChangeCallback) return;
    
    const eventType = payload.eventType;
    const newRecord = payload.new as Record<string, unknown>;
    const oldRecord = payload.old as Record<string, unknown>;
    const taskId = (newRecord?.id || oldRecord?.id) as string;
    const projectId = (newRecord?.project_id || oldRecord?.project_id) as string;
    
    this.onTaskChangeCallback({
      eventType,
      taskId,
      projectId,
      data: newRecord
    });
  }

  /**
   * 卸载实时订阅
   */
  teardownRealtimeSubscription() {
    if (this.realtimeChannel && this.supabase.isConfigured) {
      void this.supabase.client().removeChannel(this.realtimeChannel);
    }
    if (this.tasksChannel && this.supabase.isConfigured) {
      void this.supabase.client().removeChannel(this.tasksChannel);
    }
    this.realtimeChannel = null;
    this.tasksChannel = null;
  }

  /**
   * 从云端加载项目列表
   * 自动检测数据版本并适配加载
   */
  async loadProjectsFromCloud(userId: string): Promise<Project[]> {
    if (!userId || !this.supabase.isConfigured) {
      return [];
    }
    
    this.isLoadingRemote.set(true);
    
    try {
      const { data, error } = await this.supabase.client()
        .from('projects')
        .select('*')
        .eq('owner_id', userId)
        .order('created_date', { ascending: true });
      
      if (error) throw error;
      
      // 并行加载所有项目的任务和连接
      const projects = await Promise.all((data || []).map(async row => {
        const projectRow = row as ProjectRow & { data?: any; migrated_to_v2?: boolean };
        
        // 检查是否使用 v2 表结构
        if (projectRow.migrated_to_v2) {
          // v2: 从独立表加载
          const [tasks, connections] = await Promise.all([
            this.taskRepo.loadTasks(projectRow.id),
            this.taskRepo.loadConnections(projectRow.id)
          ]);
          return this.mapRowToProjectV2(projectRow, tasks, connections);
        } else {
          // v1: 从 JSONB 加载（向后兼容）
          return this.mapRowToProject(row as ProjectRow & { data: any });
        }
      }));
      
      this.syncState.update(s => ({
        ...s,
        syncError: null,
        offlineMode: false
      }));
      
      return projects;
    } catch (e: any) {
      console.error('Loading from Supabase failed', e);
      this.syncState.update(s => ({
        ...s,
        syncError: e?.message ?? String(e),
        offlineMode: true
      }));
      return [];
    } finally {
      this.isLoadingRemote.set(false);
    }
  }

  /**
   * 加载单个项目（用于增量更新）
   */
  async loadSingleProject(projectId: string, userId: string): Promise<Project | null> {
    if (!userId || !this.supabase.isConfigured || !projectId) {
      return null;
    }
    
    try {
      const { data, error } = await this.supabase.client()
        .from('projects')
        .select('*')
        .eq('id', projectId)
        .eq('owner_id', userId)
        .single();
      
      if (error) {
        if (error.code === 'PGRST116') {
          // 项目不存在
          return null;
        }
        throw error;
      }
      
      const projectRow = data as ProjectRow & { data?: any; migrated_to_v2?: boolean };
      
      // 检查数据版本
      if (projectRow.migrated_to_v2) {
        const [tasks, connections] = await Promise.all([
          this.taskRepo.loadTasks(projectRow.id),
          this.taskRepo.loadConnections(projectRow.id)
        ]);
        return this.mapRowToProjectV2(projectRow, tasks, connections);
      } else {
        return this.mapRowToProject(data as ProjectRow & { data: any });
      }
    } catch (e: any) {
      console.error('Loading single project failed', e);
      return null;
    }
  }

  /**
   * 保存项目到云端（带冲突检测）
   * 使用版本号 + 服务端时间戳双重检测机制
   * Token 过期时自动保存本地数据防止丢失
   * 支持 v1 (JSONB) 和 v2 (独立表) 两种存储格式
   */
  async saveProjectToCloud(project: Project, userId: string): Promise<{ success: boolean; conflict?: boolean; remoteData?: Project }> {
    if (!userId || !this.supabase.isConfigured) {
      return { success: true }; // 离线模式视为成功
    }
    
    this.syncState.update(s => ({ ...s, isSyncing: true }));
    
    try {
      // 先检查云端版本进行冲突检测
      const { data: remoteData, error: fetchError } = await this.supabase.client()
        .from('projects')
        .select('*')
        .eq('id', project.id)
        .single();
      
      // 冲突检测：使用版本号（优先）或时间戳
      if (!fetchError && remoteData) {
        const localVersion = project.version ?? 0;
        const remoteVersion = remoteData.version ?? (remoteData.data as { tasks?: unknown[]; connections?: unknown[]; version?: number })?.version ?? 0;
        
        // 版本号冲突检测
        if (remoteVersion > localVersion) {
          const remoteProject = await this.loadSingleProject(project.id, userId);
          if (remoteProject) {
            this.syncState.update(s => ({
              ...s,
              hasConflict: true,
              conflictData: { 
                local: project, 
                remote: remoteProject,
                projectId: project.id,
                remoteData: remoteProject
              }
            }));
            return { success: false, conflict: true, remoteData: remoteProject };
          }
        }
        
        // 如果版本号相同但远端有更新（可能是其他设备在同一版本上做了修改）
        // 使用服务端时间戳作为回退检测
        if (remoteVersion === localVersion && remoteData.updated_at && project.updatedAt) {
          const remoteTime = new Date(remoteData.updated_at).getTime();
          const localTime = new Date(project.updatedAt).getTime();
          
          // 如果远端时间比本地新超过 2 秒（允许一些时钟偏差），视为冲突
          if (remoteTime - localTime > 2000) {
            const remoteProject = await this.loadSingleProject(project.id, userId);
            if (remoteProject) {
              this.syncState.update(s => ({
                ...s,
                hasConflict: true,
                conflictData: { 
                  local: project, 
                  remote: remoteProject,
                  projectId: project.id,
                  remoteData: remoteProject
                }
              }));
              return { success: false, conflict: true, remoteData: remoteProject };
            }
          }
        }
      }
      
      // 递增版本号
      const newVersion = (project.version ?? 0) + 1;
      
      // 检查是否已迁移到 v2
      const isMigratedToV2 = remoteData?.migrated_to_v2 ?? false;
      
      if (isMigratedToV2) {
        // v2: 保存到独立表
        await this.saveProjectV2(project, userId, newVersion);
      } else {
        // v1: 保存到 JSONB（向后兼容）
        // 注意：新项目也使用 v1 格式，直到运行迁移脚本
        const { error } = await this.supabase.client().from('projects').upsert({
          id: project.id,
          owner_id: userId,
          title: project.name,
          description: project.description,
          created_date: project.createdDate || new Date().toISOString(),
          updated_at: new Date().toISOString(),
          version: newVersion,
          data: {
            tasks: project.tasks,
            connections: project.connections,
            version: newVersion
          }
        });
        
        if (error) {
          // 处理认证错误 - 先保存本地数据再报错
          if (error.code === 'PGRST301' || error.message?.includes('JWT') || error.code === '401') {
            this.saveOfflineSnapshot([project]);
            console.warn('Token 过期，数据已保存到本地');
            
            this.syncState.update(s => ({ 
              ...s, 
              sessionExpired: true,
              offlineMode: true,
              syncError: '登录已过期，数据已保存在本地，请重新登录后同步'
            }));
            throw new Error('登录已过期，数据已保存在本地，请重新登录');
          }
          throw error;
        }
      }
      
      // 更新本地版本号
      project.version = newVersion;
      
      this.syncState.update(s => ({
        ...s,
        syncError: null,
        offlineMode: false,
        sessionExpired: false,
        hasConflict: false,
        conflictData: null
      }));
      
      return { success: true };
    } catch (e: any) {
      console.error('Sync project failed', e);
      
      // 任何同步失败都保存到本地缓存
      this.saveOfflineSnapshot([project]);
      
      this.syncState.update(s => ({
        ...s,
        syncError: e?.message ?? String(e),
        offlineMode: true
      }));
      return { success: false };
    } finally {
      this.syncState.update(s => ({ ...s, isSyncing: false }));
    }
  }

  /**
   * 保存项目到 v2 表结构
   */
  private async saveProjectV2(project: Project, userId: string, newVersion: number): Promise<void> {
    // 更新项目元数据
    const { error: projectError } = await this.supabase.client()
      .from('projects')
      .update({
        title: project.name,
        description: project.description,
        version: newVersion
        // updated_at 由触发器自动更新
      })
      .eq('id', project.id);
    
    if (projectError) throw projectError;
    
    // 批量保存任务
    const tasksResult = await this.taskRepo.saveTasks(project.id, project.tasks);
    if (!tasksResult.success) {
      throw new Error(tasksResult.error);
    }
    
    // 同步连接
    const connectionsResult = await this.taskRepo.syncConnections(project.id, project.connections);
    if (!connectionsResult.success) {
      throw new Error(connectionsResult.error);
    }
  }

  /**
   * 删除云端项目
   */
  async deleteProjectFromCloud(projectId: string, userId: string): Promise<boolean> {
    if (!userId || !this.supabase.isConfigured) {
      return true;
    }
    
    try {
      const { error } = await this.supabase.client()
        .from('projects')
        .delete()
        .eq('id', projectId)
        .eq('owner_id', userId);
      
      if (error) throw error;
      return true;
    } catch (e: any) {
      console.error('Delete project from cloud failed', e);
      this.syncState.update(s => ({
        ...s,
        syncError: e?.message ?? String(e)
      }));
      return false;
    }
  }

  /**
   * 解决冲突（选择保留哪个版本）
   */
  resolveConflict(projectId: string, project: Project, choice: 'local' | 'remote'): void {
    // 清除冲突状态
    this.syncState.update(s => ({
      ...s,
      hasConflict: false,
      conflictData: null
    }));
    
    console.log(`冲突已解决：${choice === 'local' ? '使用本地版本' : '使用远程版本'}`);
  }

  /**
   * 加载用户偏好设置
   */
  async loadUserPreferences(userId: string): Promise<UserPreferences | null> {
    if (!userId || !this.supabase.isConfigured) return null;
    
    try {
      const { data, error } = await this.supabase.client()
        .from('user_preferences')
        .select('*')
        .eq('user_id', userId)
        .single();
      
      if (error && error.code !== 'PGRST116') throw error;
      
      if (data?.theme) {
        return {
          theme: data.theme as ThemeType,
          layoutDirection: 'ltr',
          floatingWindowPref: 'auto'
        };
      }
      return null;
    } catch (e) {
      console.warn('加载用户偏好设置失败', e);
      return null;
    }
  }

  /**
   * 保存用户偏好设置
   */
  async saveUserPreferences(userId: string, prefs: Partial<UserPreferences>): Promise<boolean> {
    // 始终保存到本地
    if (prefs.theme) {
      localStorage.setItem(CACHE_CONFIG.THEME_CACHE_KEY, prefs.theme);
    }
    
    if (!userId || !this.supabase.isConfigured) return true;
    
    try {
      const { error } = await this.supabase.client()
        .from('user_preferences')
        .upsert({
          user_id: userId,
          theme: prefs.theme,
          updated_at: new Date().toISOString()
        }, { onConflict: 'user_id' });
      
      if (error) throw error;
      return true;
    } catch (e) {
      console.warn('保存用户偏好设置到云端失败', e);
      return false;
    }
  }

  /**
   * 保存离线快照
   */
  saveOfflineSnapshot(projects: Project[]) {
    if (typeof localStorage === 'undefined') return;
    try {
      localStorage.setItem(CACHE_CONFIG.OFFLINE_CACHE_KEY, JSON.stringify({
        projects,
        version: CACHE_CONFIG.CACHE_VERSION
      }));
    } catch (e) {
      console.warn('Offline cache write failed', e);
    }
  }

  /**
   * 加载离线快照
   * 包含版本检查和数据迁移逻辑
   */
  loadOfflineSnapshot(): Project[] | null {
    try {
      const cached = typeof localStorage !== 'undefined'
        ? localStorage.getItem(CACHE_CONFIG.OFFLINE_CACHE_KEY)
        : null;
      if (cached) {
        const parsed = JSON.parse(cached);
        if (Array.isArray(parsed?.projects)) {
          const cachedVersion = parsed.version ?? 1;
          const currentVersion = CACHE_CONFIG.CACHE_VERSION;
          
          // 版本检查和数据迁移
          if (cachedVersion < currentVersion) {
            console.log(`缓存版本升级: ${cachedVersion} -> ${currentVersion}`);
            const migratedProjects = this.migrateOfflineData(parsed.projects, cachedVersion);
            // 保存迁移后的数据
            this.saveOfflineSnapshot(migratedProjects);
            return migratedProjects;
          }
          
          return parsed.projects;
        }
      }
    } catch (e) {
      console.warn('Offline cache read failed', e);
    }
    return null;
  }

  /**
   * 迁移离线数据到最新版本
   * @param projects 旧版本项目数据
   * @param fromVersion 来源版本号
   * @returns 迁移后的项目数据
   */
  private migrateOfflineData(projects: Project[], fromVersion: number): Project[] {
    let migrated = projects;
    
    // 版本 1 -> 2: 添加 version 字段、status 默认值、shortId 等
    if (fromVersion < 2) {
      migrated = migrated.map(project => ({
        ...project,
        version: project.version ?? 0,
        updatedAt: project.updatedAt || new Date().toISOString(),
        tasks: project.tasks.map(task => ({
          ...task,
          status: task.status || 'active',
          rank: task.rank ?? 10000,
          displayId: task.displayId || '?',
          hasIncompleteTask: task.hasIncompleteTask ?? false,
          deletedAt: task.deletedAt ?? null
        })),
        connections: project.connections || []
      }));
      console.log('数据迁移: v1 -> v2 完成');
    }
    
    // 未来版本迁移示例:
    // if (fromVersion < 3) {
    //   migrated = migrated.map(project => ({ ...project, newField: defaultValue }));
    // }
    
    return migrated;
  }

  /**
   * 清除离线缓存
   */
  clearOfflineCache() {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(CACHE_CONFIG.OFFLINE_CACHE_KEY);
    }
  }

  /**
   * 映射数据库行到项目对象 (v1 JSONB 格式)
   */
  private mapRowToProject(row: ProjectRow & { data?: any }): Project {
    const data = row.data as { tasks?: Task[]; connections?: Connection[]; version?: number } | null;
    return {
      id: row.id,
      name: row.title ?? 'Untitled project',
      description: row.description ?? '',
      createdDate: row.created_date ?? new Date().toISOString(),
      tasks: data?.tasks ?? [],
      connections: data?.connections ?? [],
      updatedAt: row.updated_at ?? undefined,
      version: row.version ?? data?.version ?? 0
    };
  }

  /**
   * 映射数据库行到项目对象 (v2 独立表格式)
   */
  private mapRowToProjectV2(row: ProjectRow & { migrated_to_v2?: boolean }, tasks: Task[], connections: Connection[]): Project {
    return {
      id: row.id,
      name: row.title ?? 'Untitled project',
      description: row.description ?? '',
      createdDate: row.created_date ?? new Date().toISOString(),
      tasks,
      connections,
      updatedAt: row.updated_at ?? undefined,
      version: row.version ?? 0
    };
  }

  /**
   * 清理资源
   */
  destroy() {
    this.teardownRealtimeSubscription();
    if (this.remoteChangeTimer) {
      clearTimeout(this.remoteChangeTimer);
    }
  }
}
