/** UserSessionService - 用户会话管理：登录/登出清理、项目切换、数据加载 */
import { Injectable, inject, DestroyRef, Injector } from '@angular/core';
import { AuthService } from './auth.service';
import { SyncCoordinatorService } from './sync-coordinator.service';
import { UndoService } from './undo.service';
import { UiStateService } from './ui-state.service';
import { ProjectStateService } from './project-state.service';
import type { AttachmentService } from './attachment.service';
import { LayoutService } from './layout.service';
import { LoggerService } from './logger.service';
import { SupabaseClientService } from './supabase-client.service';
import { Project, Task, Connection } from '../models';
import { CACHE_CONFIG, SYNC_CONFIG } from '../config/sync.config';
import { AUTH_CONFIG } from '../config/auth.config';
import { FEATURE_FLAGS } from '../config/feature-flags.config';
import { isFailure } from '../utils/result';
import { ToastService } from './toast.service';

@Injectable({
  providedIn: 'root'
})
export class UserSessionService {
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('UserSession');
  private authService = inject(AuthService);
  private syncCoordinator = inject(SyncCoordinatorService);
  private undoService = inject(UndoService);
  private uiState = inject(UiStateService);
  private projectState = inject(ProjectStateService);
  private injector = inject(Injector);
  private layoutService = inject(LayoutService);
  private toastService = inject(ToastService);
  private supabase = inject(SupabaseClientService);
  private destroyRef = inject(DestroyRef);
  private attachmentServiceRef: AttachmentService | null = null;
  private attachmentServicePromise: Promise<AttachmentService | null> | null = null;

  /** 当前用户 ID (代理 AuthService) */
  readonly currentUserId = this.authService.currentUserId;

  constructor() {
    this.destroyRef.onDestroy(() => {
      // 仅在附件服务已初始化时清理，避免销毁阶段反向触发懒加载
      const loadedService = this.attachmentServiceRef;
      if (loadedService) {
        loadedService.clearUrlRefreshCallback();
        loadedService.clearMonitoredAttachments();
        return;
      }

      const pendingService = this.attachmentServicePromise;
      if (!pendingService) return;

      void pendingService
        .then((service) => {
          service?.clearUrlRefreshCallback();
          service?.clearMonitoredAttachments();
        })
        .catch(() => {
          // 销毁阶段静默忽略
        });
    });

    if (!FEATURE_FLAGS.USER_SESSION_ATTACHMENT_ON_DEMAND_V1) {
      void this.getAttachmentServiceLazy();
    }
  }

  async getAttachmentServiceLazy(): Promise<AttachmentService | null> {
    if (this.attachmentServiceRef) {
      return this.attachmentServiceRef;
    }

    if (this.attachmentServicePromise) {
      return this.attachmentServicePromise;
    }

    this.attachmentServicePromise = import('./attachment.service')
      .then((module) => {
        const service = this.injector.get(module.AttachmentService);
        this.attachmentServiceRef = service;
        return service;
      })
      .catch((error) => {
        this.logger.warn('AttachmentService 懒加载失败，降级为无附件监控', error);
        return null;
      })
      .finally(() => {
        this.attachmentServicePromise = null;
      });

    return this.attachmentServicePromise;
  }

  /**
   * 设置当前用户（登录/登出时调用，总是会加载项目数据）
   * @param userId 用户 ID，null 表示登出
   * @param opts.forceLoad 强制加载数据，跳过 isUserChange 检查（登录时必须为 true）
   */
  async setCurrentUser(userId: string | null, opts?: { forceLoad?: boolean }): Promise<void> {
    const previousUserId = this.currentUserId();
    const isUserChange = previousUserId !== userId;
    const forceLoad = opts?.forceLoad ?? false;
    
    this.logger.debug('setCurrentUser', {
      previousUserId: previousUserId?.substring(0, 8),
      newUserId: userId?.substring(0, 8),
      isUserChange,
      forceLoad
    });
    
    // 清理旧用户的附件监控和回调，防止内存泄漏
    if (isUserChange || forceLoad) {
      try {
        this.attachmentServiceRef?.clearMonitoredAttachments();
        this.projectState.setActiveProjectId(null);
        // 【P0 修复 2026-02-08】不再先清空再加载，避免双重 setProjects 触发信号风暴
        // 旧行为：setProjects([]) → loadData → setProjects(data) — 两次信号通知
        // 新行为：直接 loadData → setProjects(data) — 一次信号通知
        if (isUserChange) {
          this.projectState.setProjects([]);
        }
        this.undoService.clearHistory();
        this.syncCoordinator.core.teardownRealtimeSubscription();
      } catch (cleanupError) {
        this.logger.warn('清理旧用户数据失败', cleanupError);
        // 继续执行，不阻断流程
      }
    }

    this.authService.currentUserId.set(userId);

    if (userId) {
      // 【P0 修复 2026-02-08】forceLoad=true 时强制加载数据
      // 修复竞态 bug：signIn() 提前设置 currentUserId 导致 isUserChange=false，
      // 加上种子数据 hasProjects=true，loadUserData 被错误跳过。
      const hasProjects = this.projectState.projects().length > 0;
      if (forceLoad || !hasProjects || isUserChange) {
        try {
          await this.loadUserData(userId);
        } catch (error) {
          // loadUserData 内部已有错误处理，这里是最后的防线
          this.logger.warn('loadUserData 失败', error);
          // 降级处理：至少加载种子数据
          try {
            this.loadFromCacheOrSeed();
          } catch (fallbackError) {
            this.logger.warn('降级加载种子数据也失败', fallbackError);
            // 即使种子数据加载失败，也不阻断应用启动
          }
          // 不重新抛出异常，避免阻断应用启动
        }
      }
    } else {
      try {
        this.loadFromCacheOrSeed();
      } catch (error) {
        this.logger.warn('loadFromCacheOrSeed 失败', error);
        // 不重新抛出异常
      }
    }
  }

  /** 切换活动项目 */
  switchActiveProject(projectId: string | null): void {
    const previousProjectId = this.projectState.activeProjectId();

    if (previousProjectId === projectId) return;

    // 清理搜索状态
    this.uiState.clearSearch();

    // 先 flush 待处理的防抖操作
    this.undoService.flushPendingAction();

    // 清空之前项目的撤销历史
    if (previousProjectId) {
      this.undoService.onProjectSwitch(previousProjectId);
    }

    // 设置新的活动项目
    this.projectState.setActiveProjectId(projectId);

    // 更新附件 URL 监控
    if (projectId) {
      const newProject = this.projectState.getProject(projectId);
      if (newProject) {
        void this.monitorProjectAttachments(newProject);
      }
    } else {
      this.attachmentServiceRef?.clearMonitoredAttachments();
    }
  }

  /** 清空本地数据（内存状态），完整登出用 clearAllLocalData() */
  clearLocalData(): void {
    this.projectState.clearData();
    this.uiState.clearAllState();
    this.undoService.clearHistory();
    this.syncCoordinator.core.clearOfflineCache();
  }

  /** 完整本地数据清理（登出时必须调用，防止数据泄露） */
  async clearAllLocalData(userId?: string): Promise<void> {
    this.logger.info('执行完整的本地数据清理', { userId });
    
    // 1. 清理内存状态（原有逻辑）
    this.clearLocalData();
    
    // 1.5 【P0 安全修复】兜底清理 sessionStorage，防止撤销历史等敏感数据残留
    try {
      sessionStorage.clear();
    } catch (e) {
      this.logger.warn('sessionStorage.clear() 失败', e);
    }
    
    // 2. 清理 localStorage 中的 NanoFlow 相关数据
    const localStorageKeysToRemove = [
      CACHE_CONFIG.OFFLINE_CACHE_KEY,
      'nanoflow.offline-cache',
      'nanoflow.retry-queue',
      'nanoflow.local-tombstones',
      'nanoflow.auth-cache',
      'nanoflow.escape-pod',
      'nanoflow.safari-warning-time',
      'nanoflow.guest-data',
    ];
    
    localStorageKeysToRemove.forEach(key => {
      try {
        localStorage.removeItem(key);
      } catch (e) {
        this.logger.warn(`清理 localStorage 键失败: ${key}`, e);
      }
    });
    
    // 3. 清理用户偏好键（带 userId 前缀的）
    if (userId) {
      const prefixToRemove = `nanoflow.preference.${userId}`;
      try {
        this.listLocalStorageKeys()
          .filter(key => key.startsWith(prefixToRemove))
          .forEach(key => localStorage.removeItem(key));
      } catch (e) {
        this.logger.warn('清理用户偏好键失败', e);
      }
    }
    
    // 清理旧偏好键（兼容迁移）
    try {
      this.listLocalStorageKeys()
        .filter(key => key.startsWith('nanoflow.preference.') && !key.includes('.user-'))
        .forEach(key => localStorage.removeItem(key));
    } catch (e) {
      this.logger.warn('清理旧偏好键失败', e);
    }
    // 4. 清理 IndexedDB
    await this.clearIndexedDB('nanoflow-db');
    await this.clearIndexedDB('nanoflow-queue-backup');
    
    // 5. 【P3-12 修复】清理 Supabase auth token
    try {
      if (this.supabase.isConfigured) {
        await this.supabase.signOut();
      }
    } catch (e) {
      this.logger.warn('Supabase signOut 失败', e);
    }
    
    this.logger.info('本地数据清理完成');
  }
  private async clearIndexedDB(dbName: string): Promise<void> {
    if (typeof indexedDB === 'undefined') return;

    // 设置超时上限：blocked 场景最多等 3 秒后放弃等待
    const CLEAR_TIMEOUT_MS = 3000;

    return new Promise<void>((resolve) => {
      try {
        const timeoutId = setTimeout(() => {
          this.logger.warn(`IndexedDB ${dbName} 删除超时 (${CLEAR_TIMEOUT_MS}ms)，继续流程`);
          resolve();
        }, CLEAR_TIMEOUT_MS);

        const request = indexedDB.deleteDatabase(dbName);

        request.onsuccess = () => {
          clearTimeout(timeoutId);
          this.logger.debug(`IndexedDB ${dbName} 已删除`);
          resolve();
        };

        request.onerror = () => {
          clearTimeout(timeoutId);
          this.logger.warn(`删除 IndexedDB ${dbName} 失败`, request.error);
          resolve(); // 不阻塞流程
        };

        request.onblocked = () => {
          // 数据库被其他连接占用，不立即 resolve，等待 onsuccess/onerror 或超时
          this.logger.warn(`IndexedDB ${dbName} 删除被阻塞，等待其他连接关闭或超时`);
        };
      } catch (e) {
        this.logger.warn(`清理 IndexedDB ${dbName} 异常`, e);
        resolve();
      }
    });
  }

  private listLocalStorageKeys(): string[] {
    const keys: string[] = [];
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index);
      if (key) keys.push(key);
    }
    return keys;
  }

  /**
   * 本地优先加载项目列表
   * 1. 立即从本地缓存/种子数据渲染 UI
   * 2. 后台静默同步云端数据
   * 3. 智能合并云端数据
   */
  async loadProjects(): Promise<void> {
    const perfStart = performance.now();
    const userId = this.currentUserId();
    this.logger.debug('loadProjects 开始（本地优先模式）', { userId });
    
    // === 阶段 1: 立即渲染本地数据 ===
    
    if (!userId) {
      this.logger.debug('无 userId，从缓存或种子加载');
      this.loadFromCacheOrSeed();
      this.logger.debug(`⚡ 数据加载完成 (${(performance.now() - perfStart).toFixed(1)}ms)`);
      return;
    }
    
    // 【性能优化 2026-01-26】如果是本地模式用户，直接从缓存加载，不尝试云端同步
    // 立即返回，避免触发任何网络请求或会话检查
    if (userId === AUTH_CONFIG.LOCAL_MODE_USER_ID) {
      this.logger.debug('本地模式，从缓存或种子加载');
      this.loadFromCacheOrSeed();
      this.logger.debug(`⚡ 本地模式数据加载完成 (${(performance.now() - perfStart).toFixed(1)}ms)`);
      // 确保不启动后台同步任务
      return;
    }

    const previousActive = this.projectState.activeProjectId();
    const offlineProjects = this.syncCoordinator.core.loadOfflineSnapshot();
    this.logger.debug('离线缓存项目数量', { count: offlineProjects?.length ?? 0 });
    
    // 【关键改动】立即渲染本地缓存数据，不等待云端
    if (offlineProjects && offlineProjects.length > 0) {
      this.logger.debug('立即渲染本地缓存数据');
      
      // 验证并迁移本地数据
      const validProjects: Project[] = [];
      for (const p of offlineProjects) {
        try {
          const migrated = this.migrateProject(p);
          if (migrated.id && Array.isArray(migrated.tasks)) {
            validProjects.push(migrated);
          }
        } catch (error) {
          this.logger.warn('跳过无效的缓存项目', { projectId: p.id, error });
        }
      }
      
      if (validProjects.length > 0) {
        this.projectState.setProjects(validProjects);
        
        // 恢复之前的活动项目，或选择第一个
        if (previousActive && validProjects.some(p => p.id === previousActive)) {
          this.projectState.setActiveProjectId(previousActive);
        } else {
          this.projectState.setActiveProjectId(validProjects[0]?.id ?? null);
        }
        
        // 设置附件监控
        const activeProject = validProjects.find(p => p.id === this.projectState.activeProjectId());
        if (activeProject) {
          void this.monitorProjectAttachments(activeProject);
        }
        
        this.logger.debug('本地数据已渲染，用户可以操作');
      } else {
        // 缓存数据无效，使用种子数据
        this.loadFromCacheOrSeed();
      }
    } else {
      // 无本地缓存，立即生成种子数据让用户可以操作
      this.logger.debug('无本地缓存，生成种子数据');
      this.loadFromCacheOrSeed();
    }
    
    // === 阶段 2: 后台静默同步云端数据 ===
    // 【关键改动】不阻塞，使用 .then() 而非 await
    
    this.runIdleTask(() => {
      this.startBackgroundSync(userId, previousActive).catch(error => {
        this.logger.warn('后台同步失败', error);
        // 后台同步失败不影响用户操作，静默处理
      });
    });
  }

  private runIdleTask(task: () => void): void {
    if (typeof window !== 'undefined' && 'requestIdleCallback' in window) {
      (window as unknown as { requestIdleCallback: (cb: () => void) => void }).requestIdleCallback(() => task());
    } else {
      setTimeout(task, 0);
    }
  }
  
  /** 后台静默同步云端数据（不阻塞 UI，Delta Sync 优先） */
  private async startBackgroundSync(userId: string, _previousActive: string | null): Promise<void> {
    // 【修复】本地模式不启动后台同步，防止将 'local-user' 传递给 Supabase
    if (userId === AUTH_CONFIG.LOCAL_MODE_USER_ID) {
      this.logger.debug('本地模式，跳过后台同步');
      return;
    }

    this.logger.debug('开始后台同步');

    let activeProjectId = this.projectState.activeProjectId();
    let resumeProbe: {
      activeProjectId: string | null;
      activeAccessible: boolean;
      activeWatermark: string | null;
      projectsWatermark: string | null;
      blackboxWatermark: string | null;
      serverNow: string | null;
    } | null = null;

    if (FEATURE_FLAGS.RESUME_COMPOSITE_PROBE_RPC_V1) {
      try {
        resumeProbe = await this.syncCoordinator.core.getResumeRecoveryProbe(activeProjectId ?? undefined);
      } catch (error) {
        this.logger.warn('恢复聚合探测失败，降级为分步探测', error);
      }
    }

    if (FEATURE_FLAGS.ACTIVE_PROJECT_ACCESS_PREFLIGHT_V1 && activeProjectId) {
      try {
        const probe = resumeProbe && resumeProbe.activeProjectId === activeProjectId
          ? {
            projectId: activeProjectId,
            accessible: resumeProbe.activeAccessible,
            watermark: resumeProbe.activeWatermark,
          }
          : await this.syncCoordinator.core.getAccessibleProjectProbe(activeProjectId);
        if (probe && !probe.accessible) {
          this.logger.warn('activeProject 探测为不可访问，提前清理避免无效 RPC', { projectId: activeProjectId });
          this.projectState.setActiveProjectId(null);
          this.toastService.info('当前项目不可访问，已自动切换');
          activeProjectId = null;
        } else if (probe?.watermark) {
          this.syncCoordinator.core.setLastSyncTime(activeProjectId, probe.watermark);
        }
      } catch (error) {
        this.logger.warn('activeProject 可访问性探测失败，继续走常规路径', error);
      }
    }

    let skipProjectSyncSlowPath = false;
    if (FEATURE_FLAGS.USER_PROJECTS_WATERMARK_RPC_V1) {
      try {
        const manifestResult = resumeProbe
          ? await this.syncCoordinator.refreshProjectManifestIfNeeded('session-background-sync', {
            prefetchedRemoteWatermark: resumeProbe.projectsWatermark,
          })
          : await this.syncCoordinator.refreshProjectManifestIfNeeded('session-background-sync');
        if (manifestResult.skipped && manifestResult.watermark) {
          this.logger.debug('命中项目清单水位快路，跳过后台项目同步', {
            watermark: manifestResult.watermark
          });
          skipProjectSyncSlowPath = true;
        }
      } catch (error) {
        this.logger.warn('项目清单水位快路失败，降级为常规后台同步', error);
      }
    }

    if (FEATURE_FLAGS.BLACKBOX_WATERMARK_PROBE_V1) {
      try {
        if (resumeProbe) {
          await this.syncCoordinator.refreshBlackBoxWatermarkIfNeeded('session-background-sync', {
            prefetchedRemoteWatermark: resumeProbe.blackboxWatermark,
          });
        } else {
          await this.syncCoordinator.refreshBlackBoxWatermarkIfNeeded('session-background-sync');
        }
      } catch (error) {
        this.logger.warn('黑匣子水位快路失败，降级为常规流程', error);
      }
    }

    let accessibleProjectIds = new Set<string>();
    if (!skipProjectSyncSlowPath) {
      try {
        accessibleProjectIds = await this.syncProjectListMetadata(userId);
      } catch (e) {
        this.logger.warn('项目列表元数据同步失败', e);
      }

      activeProjectId = this.projectState.activeProjectId();

      if (
        FEATURE_FLAGS.ACTIVE_PROJECT_ACCESS_PREFLIGHT_V1 &&
        activeProjectId &&
        !accessibleProjectIds.has(activeProjectId)
      ) {
        this.logger.warn('activeProject 不可访问，清理并跳过项目同步', { projectId: activeProjectId });
        this.projectState.setActiveProjectId(null);
        this.toastService.info('当前项目不可访问，已自动切换');
        activeProjectId = null;
      }
    }
    
    // === 策略 1: 优先使用 Delta Sync（增量同步）===
    // 【Delta Sync 优化】尝试增量同步 - @see docs/plan_save.md Phase 3
    let currentProjectSynced = false;
    if (activeProjectId && SYNC_CONFIG.DELTA_SYNC_ENABLED) {
      try {
        const deltaResult = await this.syncCoordinator.performDeltaSync(activeProjectId);
        if (deltaResult.taskChanges > 0 || deltaResult.connectionChanges > 0) {
          this.logger.debug('Delta Sync 成功', deltaResult);
          currentProjectSynced = true;
        }
      } catch (deltaSyncError) {
        this.logger.warn('Delta Sync 失败，尝试全量同步当前项目', deltaSyncError);
      }
    }
    
    // === 策略 2: 如果 Delta Sync 失败，只加载当前项目（按需加载）===
    // 【优化 2026-01-27】不自动加载其他项目，节省带宽
    // 其他项目在用户切换项目时再加载
    if (!skipProjectSyncSlowPath && !currentProjectSynced && activeProjectId) {
      try {
        this.logger.debug('按需加载当前项目', { projectId: activeProjectId });
        const currentProject = await this.syncCoordinator.loadSingleProjectFromCloud(activeProjectId);
        if (currentProject) {
          await this.mergeSingleProject(currentProject, userId);
          currentProjectSynced = true;
        } else {
          // 【性能优化 2026-02-14】RPC 返回 null 说明项目不可访问（Access Denied 或已删除）
          // 清理不可访问的 activeProjectId，避免后续重复触发无效 RPC 请求链
          this.logger.warn('清理不可访问的 activeProjectId', { projectId: activeProjectId });
          this.projectState.setActiveProjectId(null);
          this.toastService.info('当前项目不可访问，已自动切换');
        }
      } catch (e) {
        this.logger.warn('当前项目同步失败', e);
      }
    }
    
    this.logger.debug('后台同步完成', { currentProjectSynced });
  }
  
  /** 同步项目列表元数据（不加载完整数据） */
  private async syncProjectListMetadata(userId: string): Promise<Set<string>> {
    const localProjects = this.projectState.projects();
    const fallbackIds = new Set(localProjects.map(p => p.id));

    const client = await this.supabase.clientAsync();
    if (!client) return fallbackIds;
    
    const { data, error } = await client
      .from('projects')
      .select('id,title,description,created_date,updated_at,version,owner_id')
      .eq('owner_id', userId)
      .order('updated_at', { ascending: false });
    
    if (error) {
      this.logger.warn('获取项目列表失败', { message: error.message });
      return fallbackIds;
    }

    const accessibleProjectIds = new Set<string>((data || []).map(row => String(row.id)));
    
    // 更新本地项目列表的元数据（不覆盖 tasks/connections）
    let updatedProjects = [...localProjects];
    let hasChanges = false;
    
    for (const remote of data || []) {
      const localIndex = updatedProjects.findIndex(p => p.id === remote.id);
      if (localIndex === -1) {
        // 新项目：创建空壳，完整数据在用户切换时加载
        updatedProjects.push({
          id: remote.id,
          name: remote.title || 'Untitled Project',
          description: remote.description || '',
          createdDate: remote.created_date || new Date().toISOString(),
          updatedAt: remote.updated_at || new Date().toISOString(),
          version: remote.version || 1,
          tasks: [],
          connections: []
        });
        hasChanges = true;
      } else {
        // 已有项目：只更新元数据，不覆盖 tasks
        const local = updatedProjects[localIndex];
        if (remote.updated_at && remote.updated_at > (local.updatedAt || '')) {
          updatedProjects[localIndex] = {
            ...local,
            name: remote.title || local.name,
            description: remote.description || local.description,
            version: remote.version || local.version
          };
          hasChanges = true;
        }
      }
    }

    // 深度优化：清理“远端不可访问且无本地待同步改动”的项目壳数据
    // 避免 UI 残留无权限项目，减少后续无效同步链路与错误日志噪声
    //
    // 【安全守卫 2026-02-14】防止服务端返回空/截断结果时误删全部本地项目：
    // 1. 服务端返回 0 条 → 跳过裁剪（极可能是网络/RLS 异常）
    // 2. 本地 ≥ 3 个项目且服务端 < 50% → 跳过裁剪（疑似响应截断）
    // 3. 不裁剪当前 activeProjectId 对应的项目（由调用方另行处理）
    const activeProjectId = this.projectState.activeProjectId();
    const beforePruneCount = updatedProjects.length;
    const shouldSkipPruning =
      accessibleProjectIds.size === 0 ||
      (beforePruneCount >= 3 && accessibleProjectIds.size < beforePruneCount * 0.5);

    if (shouldSkipPruning) {
      this.logger.warn('项目裁剪被安全守卫拦截，跳过裁剪', {
        localCount: beforePruneCount,
        remoteCount: accessibleProjectIds.size,
      });
    } else {
      updatedProjects = updatedProjects.filter(project => {
        if (accessibleProjectIds.has(project.id)) return true;
        // 不裁剪当前活跃项目，交由调用方处理
        if (project.id === activeProjectId) return true;
        const hasPendingLocalChanges = this.syncCoordinator.hasPendingChangesForProject(project.id);
        return hasPendingLocalChanges;
      });
      if (updatedProjects.length !== beforePruneCount) {
        hasChanges = true;
      }
    }
    
    if (hasChanges) {
      this.projectState.setProjects(updatedProjects);

      const activeProjectIdForPrune = this.projectState.activeProjectId();
      if (activeProjectIdForPrune && !updatedProjects.some(p => p.id === activeProjectIdForPrune)) {
        this.projectState.setActiveProjectId(null);
        this.toastService.info('当前项目不可访问，已自动切换');
      }
      this.logger.debug('项目列表元数据已更新');
    }

    return accessibleProjectIds;
  }
  
  /** 合并单个项目数据（LWW 竞态保护） */
  private async mergeSingleProject(cloudProject: Project, _userId: string): Promise<void> {
    const localProject = this.projectState.getProject(cloudProject.id);
    
    if (!localProject) {
      // 新项目，直接添加
      this.projectState.setProjects([...this.projectState.projects(), cloudProject]);
      return;
    }
    
    // 【LWW 竞态保护 2026-01-27】
    // 检查是否有本地未同步的修改（脏数据）
    const hasPendingChanges = this.syncCoordinator.hasPendingChangesForProject(cloudProject.id);
    
    if (hasPendingChanges) {
      this.logger.debug('检测到本地未同步修改，使用 LWW 合并');
      // 逐个任务比较 updatedAt，保留最新的
      const mergedTasks = this.mergeTasksWithLWW(localProject.tasks, cloudProject.tasks);
      const mergedConnections = this.mergeConnectionsWithLWW(
        localProject.connections, 
        cloudProject.connections
      );
      
      const mergedProject: Project = {
        ...cloudProject,
        tasks: mergedTasks,
        connections: mergedConnections
      };
      
      const updatedProjects = this.projectState.projects().map((p: Project) =>
        p.id === cloudProject.id ? mergedProject : p
      );
      this.projectState.setProjects(updatedProjects);
    } else {
      // 无本地修改，直接覆盖
      const updatedProjects = this.projectState.projects().map((p: Project) =>
        p.id === cloudProject.id ? cloudProject : p
      );
      this.projectState.setProjects(updatedProjects);
    }
  }
  
  /** LWW 合并任务列表 */
  private mergeTasksWithLWW(localTasks: Task[], cloudTasks: Task[]): Task[] {
    const taskMap = new Map<string, Task>();
    
    // 先添加云端任务
    for (const task of cloudTasks) {
      taskMap.set(task.id, task);
    }
    
    // 用本地更新的任务覆盖
    for (const task of localTasks) {
      const cloudTask = taskMap.get(task.id);
      if (!cloudTask) {
        // 本地新建的任务
        taskMap.set(task.id, task);
      } else if (task.updatedAt && cloudTask.updatedAt && task.updatedAt > cloudTask.updatedAt) {
        // 本地任务更新时间更晚，保留本地
        taskMap.set(task.id, task);
      }
      // 否则保留云端（已在 map 中）
    }
    
    return Array.from(taskMap.values());
  }
  
  /** LWW 合并连接列表 */
  private mergeConnectionsWithLWW(localConns: Connection[], cloudConns: Connection[]): Connection[] {
    const connMap = new Map<string, Connection>();
    
    for (const conn of cloudConns) {
      connMap.set(conn.id, conn);
    }
    
    // Connection 类型没有 updatedAt 字段，简化为优先使用本地连接
    // 这是保守策略，避免本地编辑丢失
    for (const conn of localConns) {
      connMap.set(conn.id, conn);
    }
    
    return Array.from(connMap.values());
  }
  
  /**
   * 智能合并云端数据
   * 幂等检查 + 无脏标记静默覆盖 + 有脏标记触发冲突处理
   */
  private async mergeCloudData(
    cloudProjects: Project[], 
    localProjects: Project[], 
    userId: string,
    previousActive: string | null
  ): Promise<void> {
    this.logger.debug('开始合并云端数据');
    
    const validatedProjects: Project[] = [];
    const failedProjects: string[] = [];

    for (const p of cloudProjects) {
      this.logger.debug('云端项目', { id: p.id, name: p.name, taskCount: p.tasks?.length ?? 0 });
      const result = this.syncCoordinator.validateAndRebalanceWithResult(p);
      if (result.ok) {
        validatedProjects.push(result.value);
      } else if (isFailure(result)) {
        failedProjects.push(p.name || p.id);
        this.logger.warn(`项目 "${p.name}" 验证失败，跳过加载`, { error: result.error.message });
      }
    }

    if (failedProjects.length > 0) {
      this.toastService.warning(
        '部分项目加载失败',
        `以下项目数据损坏已跳过: ${failedProjects.join(', ')}`
      );
    }

    // 合并云端数据
    const offlineProjects = localProjects;
    let mergedProjects = validatedProjects;

    if (offlineProjects && offlineProjects.length > 0) {
      const mergeResult = await this.syncCoordinator.mergeOfflineDataOnReconnect(
        mergedProjects,
        offlineProjects,
        userId
      );
      mergedProjects = mergeResult.projects;
      
      this.logger.debug('合并后项目数量', { count: mergedProjects.length });

      if (mergeResult.syncedCount > 0) {
        this.toastService.success(
          '数据已同步',
          `已将 ${mergeResult.syncedCount} 个项目的修改同步到云端`
        );
      }
    }

    // 更新 UI，使用智能合并避免“跳动”
    this.applyMergedProjects(mergedProjects, previousActive);
    
    // 保存合并后的快照
    this.syncCoordinator.core.saveOfflineSnapshot(mergedProjects);
  }
  
  /** 应用合并后的项目数据（避免 UI “跳动”） */
  private applyMergedProjects(mergedProjects: Project[], previousActive: string | null): void {
    const currentActive = this.projectState.activeProjectId();
    
    this.projectState.setProjects(mergedProjects);
    
    // 保持当前活动项目，除非它已被删除
    if (currentActive && mergedProjects.some(p => p.id === currentActive)) {
      // 保持不变
    } else if (previousActive && mergedProjects.some(p => p.id === previousActive)) {
      this.projectState.setActiveProjectId(previousActive);
    } else {
      this.projectState.setActiveProjectId(mergedProjects[0]?.id ?? null);
    }
    
    // 更新附件监控
    const activeProject = mergedProjects.find(p => p.id === this.projectState.activeProjectId());
    if (activeProject) {
      void this.monitorProjectAttachments(activeProject);
    }
  }
  
  /** 将本地数据迁移到云端（首次登录场景） */
  private async migrateLocalToCloud(localProjects: Project[], userId: string): Promise<void> {
    this.logger.info('首次登录，迁移本地离线数据到云端');
    
    let syncedCount = 0;
    const failedProjects: string[] = [];
    
    for (const project of localProjects) {
      this.logger.debug('迁移项目', { projectId: project.id, name: project.name });
      const rebalanced = this.layoutService.rebalance(project);
      const result = await this.syncCoordinator.core.saveProjectSmart(rebalanced, userId);
      if (result.success) {
        syncedCount++;
        this.logger.debug('项目迁移成功', { name: project.name });
      } else {
        failedProjects.push(project.name || project.id);
        this.logger.warn('项目迁移失败', { name: project.name, result });
      }
    }
    
    if (syncedCount > 0) {
      this.toastService.success(
        '本地数据已同步',
        `已将 ${syncedCount} 个项目同步到云端`
      );
    }
    
    if (failedProjects.length > 0) {
      this.toastService.warning(
        '部分项目同步失败',
        `以下项目无法同步: ${failedProjects.join(', ')}`
      );
    }
  }

  // ========== 私有方法 ==========

  /** 加载用户数据：加载项目 + 后台建立实时订阅 */
  private async loadUserData(userId: string): Promise<void> {
    // 先加载项目数据（这个需要等待）
    try {
      await this.loadProjects();
    } catch (error) {
      // loadProjects 内部已有错误处理，这里是最后的防线
      this.logger.warn('loadProjects 未捕获异常', error);
      // 确保至少有可用的数据
      try {
        this.loadFromCacheOrSeed();
      } catch (fallbackError) {
        this.logger.warn('种子数据加载失败', fallbackError);
      }
      
      // 向用户显示友好的错误提示
      this.toastService.error('数据加载失败', '已尝试加载本地数据，如问题持续请刷新页面');
      
      return;
    }
    
    // 实时订阅和冲突数据重载在后台执行，不阻塞 UI
    // 使用 Promise 而非 await，让它们在后台运行
    this.syncCoordinator.core.initRealtimeSubscription(userId).catch(e => {
      this.logger.warn('实时订阅初始化失败（后台）', e);
      // 实时订阅失败不影响核心功能，静默处理
    });

    this.syncCoordinator.tryReloadConflictData(userId, (id) =>
      this.projectState.getProject(id)
    ).catch(e => {
      this.logger.warn('冲突数据重载失败（后台）', e);
      // 冲突数据重载失败不影响核心功能，静默处理
    });
  }

  /** 从缓存或种子数据加载（含数据完整性检查） */
  private loadFromCacheOrSeed(): void {
    const cached = this.syncCoordinator.core.loadOfflineSnapshot();
    let projects: Project[] = [];

    if (cached && cached.length > 0) {
      // 验证并迁移每个缓存的项目
      const validProjects: Project[] = [];
      const corruptedProjects: string[] = [];
      
      for (const p of cached) {
        try {
          const migrated = this.migrateProject(p);
          // 基本完整性检查
          if (migrated.id && Array.isArray(migrated.tasks)) {
            validProjects.push(migrated);
          } else {
            corruptedProjects.push(p.name || p.id || '未知项目');
          }
        } catch (error) {
          this.logger.warn('项目迁移失败', { projectId: p.id, error });
          corruptedProjects.push(p.name || p.id || '未知项目');
        }
      }
      
      if (corruptedProjects.length > 0) {
        this.logger.warn('跳过损坏的项目', { corruptedProjects });
        this.toastService.warning(
          '部分数据已跳过',
          `以下项目数据损坏已跳过: ${corruptedProjects.join(', ')}`
        );
      }
      
      projects = validProjects.length > 0 ? validProjects : this.seedProjects();
    } else {
      projects = this.seedProjects();
    }

    this.projectState.setProjects(projects);
    this.projectState.setActiveProjectId(projects[0]?.id ?? null);
  }

  /** 迁移项目数据格式 */
  private migrateProject(project: Project): Project {
    const migrated = { ...project };

    migrated.updatedAt = migrated.updatedAt || new Date().toISOString();
    migrated.version = CACHE_CONFIG.CACHE_VERSION;

    const safeTasks = Array.isArray(migrated.tasks) ? migrated.tasks : [];
    migrated.tasks = safeTasks.map(t => ({
      ...t,
      status: t.status || 'active',
      rank: t.rank ?? 10000,
      displayId: t.displayId || '?',
      hasIncompleteTask: t.hasIncompleteTask ?? false
    }));

    migrated.connections = Array.isArray(migrated.connections) ? migrated.connections : [];

    return this.layoutService.rebalance(migrated);
  }

  /** 生成种子项目数据 */
  private seedProjects(): Project[] {
    const now = new Date().toISOString();
    // 使用有效的 UUID 格式（所有 ID 必须是 UUID，以便同步到 Supabase）
    const seedProjectId = crypto.randomUUID();
    const task1Id = crypto.randomUUID();
    const task2Id = crypto.randomUUID();
    const conn1Id = crypto.randomUUID();
    return [
      this.layoutService.rebalance({
        id: seedProjectId,
        name: 'Alpha Protocol',
        description: 'NanoFlow 核心引擎启动计划。',
        createdDate: now,
        tasks: [
          {
            id: task1Id,
            title: '阶段 1: 环境搭建',
            content: '初始化项目环境。\n- [ ] 初始化 git 仓库\n- [ ] 安装 Node.js 依赖',
            stage: 1,
            parentId: null,
            order: 1,
            rank: 10000,
            status: 'active',
            x: 100,
            y: 100,
            createdDate: now,
            displayId: '1'
          },
          {
            id: task2Id,
            title: '核心逻辑实现',
            content: '交付核心业务逻辑。\n- [ ] 编写单元测试',
            stage: 2,
            parentId: task1Id,
            order: 1,
            rank: 10500,
            status: 'active',
            x: 300,
            y: 100,
            createdDate: now,
            displayId: '1,a'
          }
        ],
        connections: [
          { id: conn1Id, source: task1Id, target: task2Id }
        ]
      })
    ];
  }

  /** 监控项目附件 URL */
  private async monitorProjectAttachments(project: Project): Promise<void> {
    const userId = this.currentUserId();
    if (!userId) return;

    const taskAttachmentPairs = project.tasks.flatMap(task =>
      (task.attachments ?? []).map(attachment => ({ taskId: task.id, attachment }))
    );

    // 无附件快速路径：不触发 AttachmentService 懒加载
    if (taskAttachmentPairs.length === 0) {
      this.attachmentServiceRef?.clearMonitoredAttachments();
      return;
    }

    const attachmentService = await this.getAttachmentServiceLazy();
    if (!attachmentService) return;

    attachmentService.clearMonitoredAttachments();
    for (const pair of taskAttachmentPairs) {
      attachmentService.monitorAttachment(userId, project.id, pair.taskId, pair.attachment);
    }
  }
}
