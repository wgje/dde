import { Injectable, inject, signal } from '@angular/core';
import type { RealtimeChannel, RealtimePostgresChangesPayload } from '@supabase/supabase-js';
import { SupabaseClientService } from './supabase-client.service';
import { Project, ProjectRow, SyncState, UserPreferences, ThemeType, Task, Connection } from '../models';
import { SYNC_CONFIG, CACHE_CONFIG } from '../config/constants';

/**
 * 数据同步服务
 * 负责与 Supabase 的数据同步、离线缓存、实时订阅
 */
@Injectable({
  providedIn: 'root'
})
export class SyncService {
  private supabase = inject(SupabaseClientService);
  
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
  
  /** 远程变更处理定时器 */
  private remoteChangeTimer: ReturnType<typeof setTimeout> | null = null;
  
  /** 远程变更回调 */
  private onRemoteChangeCallback: (() => Promise<void>) | null = null;

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
  setRemoteChangeCallback(callback: () => Promise<void>) {
    this.onRemoteChangeCallback = callback;
  }

  /**
   * 初始化实时订阅
   */
  async initRealtimeSubscription(userId: string) {
    if (!this.supabase.isConfigured || !userId) return;
    
    this.teardownRealtimeSubscription();

    const channel = this.supabase.client()
      .channel('public:projects')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'projects',
          filter: `owner_id=eq.${userId}`
        },
        payload => {
          console.log('收到云端变更:', payload);
          void this.handleRemoteChange(payload);
        }
      );

    this.realtimeChannel = channel;
    channel.subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        console.info('Realtime channel ready');
      }
    });
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
        await this.onRemoteChangeCallback!();
      } catch (e) {
        console.error('处理实时更新失败', e);
      } finally {
        this.remoteChangeTimer = null;
      }
    }, SYNC_CONFIG.REMOTE_CHANGE_DELAY);
  }

  /**
   * 卸载实时订阅
   */
  teardownRealtimeSubscription() {
    if (this.realtimeChannel && this.supabase.isConfigured) {
      void this.supabase.client().removeChannel(this.realtimeChannel);
    }
    this.realtimeChannel = null;
  }

  /**
   * 从云端加载项目列表
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
      
      const projects = (data || []).map(row => this.mapRowToProject(row as ProjectRow));
      
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
   * 保存项目到云端（带冲突检测）
   * 使用版本号 + 服务端时间戳双重检测机制
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
        const remoteVersion = (remoteData.data as { tasks?: unknown[]; connections?: unknown[]; version?: number })?.version ?? 0;
        
        // 版本号冲突检测
        if (remoteVersion > localVersion) {
          const remoteProject = this.mapRowToProject(remoteData as ProjectRow);
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
        
        // 如果版本号相同但远端有更新（可能是其他设备在同一版本上做了修改）
        // 使用服务端时间戳作为回退检测
        if (remoteVersion === localVersion && remoteData.updated_at && project.updatedAt) {
          const remoteTime = new Date(remoteData.updated_at).getTime();
          const localTime = new Date(project.updatedAt).getTime();
          
          // 如果远端时间比本地新超过 2 秒（允许一些时钟偏差），视为冲突
          if (remoteTime - localTime > 2000) {
            const remoteProject = this.mapRowToProject(remoteData as ProjectRow);
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
      
      // 递增版本号
      const newVersion = (project.version ?? 0) + 1;
      
      // 执行保存 - 使用服务端 NOW() 函数获取时间戳确保一致性
      const { error } = await this.supabase.client().from('projects').upsert({
        id: project.id,
        owner_id: userId,
        title: project.name,
        description: project.description,
        created_date: project.createdDate || new Date().toISOString(),
        updated_at: new Date().toISOString(), // 注意：理想情况下应使用服务端时间
        data: {
          tasks: project.tasks,
          connections: project.connections,
          version: newVersion
        }
      });
      
      if (error) {
        // 处理认证错误
        if (error.code === 'PGRST301' || error.message?.includes('JWT') || error.code === '401') {
          this.syncState.update(s => ({ ...s, sessionExpired: true }));
          throw new Error('登录已过期，请重新登录');
        }
        throw error;
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
   */
  loadOfflineSnapshot(): Project[] | null {
    try {
      const cached = typeof localStorage !== 'undefined'
        ? localStorage.getItem(CACHE_CONFIG.OFFLINE_CACHE_KEY)
        : null;
      if (cached) {
        const parsed = JSON.parse(cached);
        if (Array.isArray(parsed?.projects)) {
          return parsed.projects;
        }
      }
    } catch (e) {
      console.warn('Offline cache read failed', e);
    }
    return null;
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
   * 映射数据库行到项目对象
   */
  private mapRowToProject(row: ProjectRow): Project {
    const data = row.data as { tasks?: Task[]; connections?: Connection[]; version?: number } | null;
    return {
      id: row.id,
      name: row.title ?? 'Untitled project',
      description: row.description ?? '',
      createdDate: row.created_date ?? new Date().toISOString(),
      tasks: data?.tasks ?? [],
      connections: data?.connections ?? [],
      updatedAt: row.updated_at ?? undefined,
      version: data?.version ?? 0
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
