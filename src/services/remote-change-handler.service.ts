/**
 * RemoteChangeHandlerService - 远程变更处理服务
 * 
 * 【职责边界】
 * ✓ 处理实时订阅推送的远程项目变更
 * ✓ 处理实时订阅推送的远程任务变更
 * ✓ 增量更新与智能合并
 * ✓ 版本冲突检测
 * ✓ 权限拒绝处理（v5.8）
 * ✗ 实时订阅建立/断开 → SyncCoordinatorService
 * ✗ 数据持久化 → SyncCoordinatorService
 * ✗ 用户会话管理 → UserSessionService
 */
import { Injectable, inject, DestroyRef } from '@angular/core';
import { SyncCoordinatorService } from './sync-coordinator.service';
import { UndoService } from './undo.service';
import { UiStateService } from './ui-state.service';
import { ProjectStateService } from './project-state.service';
import { ToastService } from './toast.service';
import { AuthService } from './auth.service';
import { LoggerService } from './logger.service';
import { ChangeTrackerService } from './change-tracker.service';
import { PermissionDeniedHandlerService } from './permission-denied-handler.service';
import { Project, Task } from '../models';
import { SupabaseError, supabaseErrorToError } from '../utils/supabase-error';
import { reloadViaForceClearCache } from '../utils/force-clear-cache';
import { SYNC_CONFIG } from '../config/sync.config';

/**
 * 远程项目变更载荷
 */
export interface RemoteProjectChangePayload {
  eventType: 'INSERT' | 'UPDATE' | 'DELETE';
  projectId: string;
}

/**
 * 远程任务变更载荷
 * 
 * 注：移除了未使用的 data 字段。
 * 增量更新的复杂度（JSON Patch、数组乱序等）远超其带来的带宽节省。
 * Simple is better than complex.
 */
export interface RemoteTaskChangePayload {
  eventType: 'INSERT' | 'UPDATE' | 'DELETE';
  taskId: string;
  projectId: string;
}

export interface RemoteChangeCallbacks {
  onLoadProjects?: () => Promise<void>;
  onRefreshActiveProject?: (reason: string) => Promise<void>;
}

@Injectable({
  providedIn: 'root'
})
export class RemoteChangeHandlerService {
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('RemoteChangeHandler');
  private syncCoordinator = inject(SyncCoordinatorService);
  private undoService = inject(UndoService);
  private uiState = inject(UiStateService);
  private projectState = inject(ProjectStateService);
  private toastService = inject(ToastService);
  private authService = inject(AuthService);
  private changeTracker = inject(ChangeTrackerService);
  private permissionDeniedHandler = inject(PermissionDeniedHandlerService);
  private destroyRef = inject(DestroyRef);

  /** 
   * 用于防止在编辑期间处理远程变更的时间阈值（毫秒）
   * 【修复】从 300ms 增加到 2000ms，给弱网环境更多保护时间
   */
  private static readonly EDIT_GUARD_THRESHOLD_MS = 2000;
  
  /** 回调是否已设置（防止重复调用） */
  private callbacksInitialized = false;
  
  /** 服务是否已销毁（用于取消进行中的异步操作） */
  private isDestroyed = false;
  
  /** 
   * 当前任务更新请求 ID
   * 使用单调递增的 ID 替代 AbortController，确保只处理最新请求结果
   * 注：Supabase JS 客户端不原生支持 AbortSignal，此设计更可靠
   */
  private taskUpdateRequestId = 0;
  
  constructor() {
    // 注册 HMR/测试清理
    this.destroyRef.onDestroy(() => {
      this.isDestroyed = true;
      this.callbacksInitialized = false;
      // 递增请求 ID，使所有进行中的请求结果被忽略
      this.taskUpdateRequestId++;
    });
  }

  /**
   * 设置远程变更回调
   * 应在应用启动时调用一次
   * @throws 如果重复调用会记录警告
   */
  setupCallbacks(callbacks: RemoteChangeCallbacks | (() => Promise<void>)): void {
    if (this.callbacksInitialized) {
      this.logger.warn('setupCallbacks 已被调用过，跳过重复初始化');
      return;
    }

    const normalizedCallbacks: RemoteChangeCallbacks = typeof callbacks === 'function'
      ? { onLoadProjects: callbacks }
      : callbacks;
    
    this.callbacksInitialized = true;
    this.logger.info('远程变更回调已初始化');
    
    this.syncCoordinator.setupRemoteChangeCallbacks(
      async (payload) => {
        // 项目级更新：如果用户正在编辑，跳过以防止冲突
        if (this.shouldSkipRemoteUpdate()) {
          this.logger.debug('跳过项目级远程更新');
          return;
        }

        try {
          // 【修复 2026-01-31】正确处理 polling 事件类型
          // polling 事件应调用 onLoadProjects 执行全量同步，而非 handleIncrementalUpdate
          const eventType = payload?.eventType;
          const isRealtimeEvent = eventType === 'INSERT' || eventType === 'UPDATE' || eventType === 'DELETE';
          
          if (isRealtimeEvent && payload?.projectId) {
            await this.handleIncrementalUpdate(payload as RemoteProjectChangePayload);
          } else if (normalizedCallbacks.onRefreshActiveProject) {
            await normalizedCallbacks.onRefreshActiveProject(`remote:${eventType ?? 'unknown'}`);
          } else if (normalizedCallbacks.onLoadProjects) {
            await normalizedCallbacks.onLoadProjects();
          }
        } catch (e) {
          this.logger.error('处理远程变更失败', e);
        }
      },
      (payload) => {
        const taskPayload = payload as RemoteTaskChangePayload;

        // 任务级更新：默认更宽松（允许不同任务并发编辑），但仍需避免在本机有未同步修改时被远程覆盖。
        // - 用户正在编辑/有待同步本地变更：跳过 UPDATE/INSERT，避免覆盖本地状态
        // - 刚刚持久化：短暂跳过，避免“自己的回声”覆盖
        if (this.shouldSkipTaskUpdate(taskPayload)) {
          this.logger.debug('跳过任务级远程更新', { eventType: taskPayload.eventType, taskId: taskPayload.taskId });
          return;
        }
        this.handleTaskLevelUpdate(taskPayload);
      }
    );
  }

  // ========== 私有方法 ==========

  /**
   * 检查是否应跳过远程项目级更新
   * 当用户正在编辑或有待同步的本地变更时，跳过项目级更新
   */
  private shouldSkipRemoteUpdate(): boolean {
    const isEditing = this.uiState.isEditing;
    const hasPending = this.syncCoordinator.hasPendingLocalChanges();
    const timeSinceLastPersist = Date.now() - this.syncCoordinator.getLastPersistAt();
    const inEditGuard = timeSinceLastPersist < RemoteChangeHandlerService.EDIT_GUARD_THRESHOLD_MS;
    
    const shouldSkip = isEditing || hasPending || inEditGuard;
    
    // 添加调试日志
    if (shouldSkip) {
      this.logger.debug('跳过远程项目更新', {
        isEditing,
        hasPendingLocalChanges: hasPending,
        timeSinceLastPersist,
        inEditGuard,
        threshold: RemoteChangeHandlerService.EDIT_GUARD_THRESHOLD_MS
      });
    }
    
    return shouldSkip;
  }
  
  /**
   * 检查是否应跳过远程任务级更新
   * 更宽松的策略：只在刚刚有持久化操作时跳过，允许不同任务的并发更新
   * 【修复】增加回声保护时间到 3000ms，匹配同步防抖时间 (SYNC_CONFIG.DEBOUNCE_DELAY)
   * 防止本机操作的"回声"覆盖本地状态
   */
  private shouldSkipTaskUpdate(payload: RemoteTaskChangePayload): boolean {
    const timeSinceLastPersist = Date.now() - this.syncCoordinator.getLastPersistAt();
    // 【关键修复】回声保护时间增加到 3 秒，匹配同步防抖延迟
    const ECHO_PROTECTION_WINDOW = 3000;
    const inEchoGuard = timeSinceLastPersist < ECHO_PROTECTION_WINDOW;

    // DELETE 事件不需要加载远程项目，且对一致性很关键；仅应用回声保护。
    if (payload.eventType === 'DELETE') {
      return inEchoGuard;
    }

    // UPDATE/INSERT 需要尽量及时处理（尤其是软删除 tombstone 通过 UPDATE 传播）。
    // 这里不再因“编辑中/有待同步变更”而整体跳过；改由后续合并逻辑按字段保护本地脏数据。
    return inEchoGuard;
  }

  /**
   * 处理项目级别的增量更新
   */
  private async handleIncrementalUpdate(payload: RemoteProjectChangePayload): Promise<void> {
    const { eventType, projectId } = payload;

    if (eventType === 'DELETE') {
      this.undoService.clearOutdatedHistory(projectId, Number.MAX_SAFE_INTEGER);

      this.projectState.updateProjects(ps => ps.filter(p => p.id !== projectId));
      if (this.projectState.activeProjectId() === projectId) {
        const remaining = this.projectState.projects();
        this.projectState.setActiveProjectId(remaining[0]?.id ?? null);
      }
      return;
    }

    if (eventType === 'INSERT' || eventType === 'UPDATE') {
      const userId = this.authService.currentUserId();
      if (!userId) return;

      const remoteProject = await this.syncCoordinator.core.loadSingleProject(projectId, userId);
      if (!remoteProject) return;

      // 【关键修复】处理远程返回的已删除记录
      // 同步查询现在返回所有记录（包括已删除的），需要在客户端处理
      const deletedTaskIds = new Set(
        (remoteProject.tasks || []).filter(t => t.deletedAt).map(t => t.id)
      );
      const deletedConnectionIds = new Set(
        (remoteProject.connections || []).filter(c => c.deletedAt).map(c => c.id)
      );
      
      // 从远程项目中移除已删除的记录（用于后续合并）
      const cleanedRemoteProject = {
        ...remoteProject,
        tasks: (remoteProject.tasks || []).filter(t => !t.deletedAt),
        connections: (remoteProject.connections || []).filter(c => !c.deletedAt)
      };

      const localProject = this.projectState.getProject(projectId);

      if (!localProject) {
        const validated = this.syncCoordinator.validateAndRebalance(cleanedRemoteProject);
        this.projectState.updateProjects(ps => [...ps, validated]);
      } else {
        const localVersion = localProject.version ?? 0;
        const remoteVersion = remoteProject.version ?? 0;

        // 【关键修复】即使版本号相同或更低，也要处理删除操作
        // 删除操作是幂等的，处理多次不会有问题
        if (deletedTaskIds.size > 0 || deletedConnectionIds.size > 0) {
          this.logger.info('处理远程删除操作', {
            projectId,
            deletedTaskCount: deletedTaskIds.size,
            deletedConnectionCount: deletedConnectionIds.size
          });
          
          // 从本地项目中删除远程已删除的任务和连接
          this.projectState.updateProjects(ps => ps.map(p => {
            if (p.id !== projectId) return p;
            const updatedTasks = p.tasks.filter(t => !deletedTaskIds.has(t.id));
            const updatedConnections = p.connections.filter(c => !deletedConnectionIds.has(c.id));
            
            if (updatedTasks.length !== p.tasks.length || updatedConnections.length !== p.connections.length) {
              return this.syncCoordinator.validateAndRebalance({
                ...p,
                tasks: updatedTasks,
                connections: updatedConnections
              });
            }
            return p;
          }));
        }

        if (remoteVersion > localVersion) {
          const versionDiff = remoteVersion - localVersion;

          const clearedCount = this.undoService.clearOutdatedHistory(projectId, remoteVersion);
          if (clearedCount > 0) {
            this.logger.debug(`清理了 ${clearedCount} 条过时的撤销历史`, { projectId });
          }

          if (this.uiState.isEditing && versionDiff > 1) {
            this.toastService.info('数据已更新', '其他设备的更改已同步，当前编辑内容将与远程合并');
          }

          // 【关键修复】获取 tombstoneIds，防止已删除任务在合并时复活
          const tombstoneIds = await this.syncCoordinator.getTombstoneIds(projectId);
          
          // 获取最新的本地项目状态（可能已被上面的删除操作更新）
          const currentLocalProject = this.projectState.getProject(projectId);
          if (!currentLocalProject) return;
          
          const mergeResult = this.syncCoordinator.smartMerge(currentLocalProject, cleanedRemoteProject, tombstoneIds);

          if (mergeResult.conflictCount > 0 && this.uiState.isEditing) {
            this.toastService.warning('合并提示', '检测到与远程更改的冲突，已自动合并');
          }

          const validated = this.syncCoordinator.validateAndRebalance(mergeResult.project);
          this.projectState.updateProjects(ps => ps.map(p => p.id === projectId ? validated : p));
        }
      }
    }
  }

  /**
   * 处理任务级别的实时更新
   * 
   * 🔧 关键修复点：
   * 1. 任务删除需要正确处理 projectId 缺失的情况
   * 2. 任务更新需要智能合并本地编辑和远程变更
   * 3. 需要正确处理位置、状态、stage 等所有字段的同步
   */
  private handleTaskLevelUpdate(payload: RemoteTaskChangePayload): void {
    const { eventType, taskId, projectId } = payload;
    this.changeTracker.pruneExpiredChanges(SYNC_CONFIG.DIRTY_PROTECTION_WINDOW_MS);
    
    // 添加调试日志
    this.logger.info('[TaskSync] 收到任务变更事件', { eventType, taskId, projectId });

    // 🔧 修复：如果缺少 projectId（REPLICA IDENTITY 未配置），尝试从所有项目中查找
    let targetProjectId = projectId;
    
    if (!targetProjectId && eventType === 'DELETE') {
      this.logger.warn('DELETE 事件缺少 projectId，在所有项目中查找任务', { taskId });
      
      // 在所有项目中查找该任务
      for (const project of this.projectState.projects()) {
        if (project.tasks.some(t => t.id === taskId)) {
          targetProjectId = project.id;
          this.logger.info('在项目中找到待删除任务', { taskId, projectId: targetProjectId });
          break;
        }
      }
      
      if (!targetProjectId) {
        this.logger.error('无法找到待删除任务所属项目', { taskId });
        return;
      }
    }
    
    if (!targetProjectId) {
      this.logger.warn('跳过任务更新（无 projectId）', { eventType, taskId });
      return;
    }

    // 只处理当前活动项目的任务（对于非活动项目，等待切换项目时重新加载）
    if (targetProjectId !== this.projectState.activeProjectId()) {
      this.logger.debug('跳过非当前项目的任务更新', { eventType, taskId, projectId: targetProjectId, activeProjectId: this.projectState.activeProjectId() });
      return;
    }

    switch (eventType) {
      case 'DELETE':
        this.logger.info('处理远程任务删除', { taskId, projectId: targetProjectId });
        
        // 清理被删除任务相关的撤销历史，防止撤销操作引用已删除任务
        this.undoService.clearTaskHistory(taskId, targetProjectId);
        
        this.projectState.updateProjects(projects =>
          projects.map(p => {
            if (p.id !== targetProjectId) return p;
            
            const taskExists = p.tasks.some(t => t.id === taskId);
            if (!taskExists) {
              this.logger.debug('任务已不存在，跳过删除', { taskId });
              return p;
            }
            
            const updatedProject = {
              ...p,
              tasks: p.tasks.filter(t => t.id !== taskId)
            };
            
            this.logger.debug('任务已从本地删除', { taskId, remainingTasks: updatedProject.tasks.length });
            
            // 删除任务后需要重新计算 displayId，因为其他任务的编号可能会变化
            return this.syncCoordinator.validateAndRebalance(updatedProject);
          })
        );
        break;

      case 'INSERT':
      case 'UPDATE':
        const userId = this.authService.currentUserId();
        if (!userId) return;

        // 捕获当前状态，用于异步完成后检查
        const currentProjectId = this.projectState.activeProjectId();
        
        // 使用递增的请求 ID 机制确保只处理最新请求
        // 每次新请求都会使之前的请求结果被忽略
        const requestId = ++this.taskUpdateRequestId;
        
        this.logger.info('开始加载远程任务更新', { eventType, taskId, projectId: targetProjectId, requestId });
        
        this.syncCoordinator.core.loadSingleProject(targetProjectId, userId)
          .then(async remoteProject => {
            // 检查是否已有更新的请求（当前请求已过时）
            if (requestId !== this.taskUpdateRequestId) {
              this.logger.debug('远程任务更新已被更新请求取代', { requestId, currentId: this.taskUpdateRequestId });
              return;
            }
            // 检查服务是否已销毁或项目已切换
            if (this.isDestroyed) {
              this.logger.debug('服务已销毁，忽略远程任务更新');
              return;
            }
            if (this.projectState.activeProjectId() !== currentProjectId) {
              this.logger.debug('项目已切换，忽略远程任务更新');
              return;
            }
            
            if (!remoteProject) {
              const loadAccessibleProbe = this.syncCoordinator.core.getAccessibleProjectProbe?.bind(this.syncCoordinator.core);
              const accessibleProbe = loadAccessibleProbe
                ? await loadAccessibleProbe(targetProjectId).catch(() => null)
                : null;

              if (accessibleProbe && !accessibleProbe.accessible) {
                this.logger.info('远程任务更新命中已不可访问项目，跳过本次项目拉取', {
                  projectId: targetProjectId,
                  taskId,
                });
                return;
              }

              this.logger.debug('远程项目暂不可用，跳过本次任务级更新', {
                projectId: targetProjectId,
                taskId,
                probeAccessible: accessibleProbe?.accessible ?? null,
              });
              return;
            }

            const remoteTask = remoteProject.tasks.find(t => t.id === taskId);
            if (!remoteTask) {
              // 【根因修复 2026-04-23】
              // 远程 INSERT/UPDATE 事件抵达后，任务在拉取完整项目前已被删除/迁移。
              // 此前仅 warn 不收敛，会导致本地保留"幽灵任务"直到下次全量刷新。
              //
              // 三类情形分别处理：
              // 1) 任务已进入 tombstone（硬删除）：权威 DELETE，立即清理本地。
              // 2) 本地存在新近的待同步变更（如刚创建未推送）：保留本地，避免把
              //    本地领先的写入误删，仅以 debug 级别记录竞态。
              // 3) 其他情况（任务在远端项目中已不复存在）：按 DELETE 收敛本地状态。
              const tombstoneIds = await this.syncCoordinator.getTombstoneIds(targetProjectId);
              const isTombstoned = tombstoneIds.has(taskId);
              const pendingLocal = this.changeTracker.getPendingChange(
                targetProjectId,
                'task',
                taskId,
                SYNC_CONFIG.DIRTY_PROTECTION_WINDOW_MS
              );

              if (!isTombstoned && pendingLocal && pendingLocal.changeType !== 'delete') {
                this.logger.debug('远程项目中暂未见任务，但本地存在待同步变更，保留本地状态', {
                  taskId,
                  projectId: targetProjectId,
                  pendingType: pendingLocal.changeType,
                  totalTasks: remoteProject.tasks.length
                });
                return;
              }

              this.logger.info('远程任务已不在项目中，按删除收敛本地状态', {
                taskId,
                projectId: targetProjectId,
                reason: isTombstoned ? 'tombstoned' : 'missing',
                totalTasks: remoteProject.tasks.length
              });

              this.undoService.clearTaskHistory(taskId, targetProjectId);
              this.projectState.updateProjects(projects =>
                projects.map(p => {
                  if (p.id !== targetProjectId) return p;
                  if (!p.tasks.some(t => t.id === taskId)) return p;
                  const updatedProject = {
                    ...p,
                    tasks: p.tasks.filter(t => t.id !== taskId)
                  };
                  return this.syncCoordinator.validateAndRebalance(updatedProject);
                })
              );
              return;
            }
            
            // 调试：记录远程任务的关键字段
            this.logger.info('[TaskSync] 成功加载远程任务完整数据', {
              taskId,
              title: remoteTask.title,
              status: remoteTask.status,
              stage: remoteTask.stage,
              parentId: remoteTask.parentId,
              rank: remoteTask.rank,
              x: remoteTask.x,
              y: remoteTask.y,
              updatedAt: remoteTask.updatedAt,
              deletedAt: remoteTask.deletedAt
            });

            // 【关键修复】在更新 projects 前获取 tombstoneIds
            // 用于检查任务是否已被永久删除，防止复活
            // 直接查询 Supabase，不使用内存缓存，遵循 Single Source of Truth 原则
            const tombstoneIds = await this.syncCoordinator.getTombstoneIds(targetProjectId);

            // 【关键优化】幂等检查 - 来自高级顾问建议
            // 避免 REST 同步和 Realtime 事件的竞态问题
            // 如果本地已有更新或同版本的数据，跳过处理
            const localProject = this.projectState.getProject(targetProjectId);
            const existingLocalTask = localProject?.tasks.find(t => t.id === taskId);
            
            if (existingLocalTask && remoteTask.updatedAt && existingLocalTask.updatedAt) {
              const localTime = new Date(existingLocalTask.updatedAt).getTime();
              const remoteTime = new Date(remoteTask.updatedAt).getTime();
              
              if (remoteTime <= localTime) {
                this.logger.debug('幂等检查：跳过过时或相同版本的远程更新', {
                  taskId,
                  localUpdatedAt: existingLocalTask.updatedAt,
                  remoteUpdatedAt: remoteTask.updatedAt
                });
                return; // 提前退出，不执行后续的 updateProjects
              }
            }

            this.projectState.updateProjects(projects =>
              projects.map(p => {
                if (p.id !== targetProjectId) return p;

                const existingTaskIndex = p.tasks.findIndex(t => t.id === taskId);
                const pending = this.changeTracker.getPendingChange(
                  targetProjectId,
                  'task',
                  taskId,
                  SYNC_CONFIG.DIRTY_PROTECTION_WINDOW_MS
                );

                let updatedProject: Project;
                if (existingTaskIndex >= 0) {
                  // 调试：对比本地和远程数据
                  const localTask = p.tasks[existingTaskIndex];
                  this.logger.debug('任务更新对比', {
                    taskId,
                    local: { 
                      status: localTask.status, 
                      stage: localTask.stage, 
                      x: localTask.x, 
                      y: localTask.y,
                      updatedAt: localTask.updatedAt 
                    },
                    remote: { 
                      status: remoteTask.status, 
                      stage: remoteTask.stage, 
                      x: remoteTask.x, 
                      y: remoteTask.y,
                      updatedAt: remoteTask.updatedAt 
                    }
                  });
                  
                  // 更精细的合并：
                  // - 默认采用远程任务（避免丢失另一端的结构/状态更新）
                  // - 若本机对该任务存在待同步脏字段，则对这些字段采用本地值（避免“回滚”）
                  // - 软删除 tombstone（deletedAt 非空）优先，避免任务复活
                  // - 【新增】如果本地 updatedAt >= 远程 updatedAt，保护关键本地字段
                  let mergedTask = remoteTask;

                  if (pending?.changeType === 'delete') {
                    // 本机认为该任务已删除：保持本机状态，避免被远程"复活"。
                    mergedTask = localTask;
                  } else if (localTask.deletedAt && !remoteTask.deletedAt) {
                    // 【关键修复】来自高级顾问建议：
                    // 如果本地已删除但远程未删除，检查时间戳
                    // 若本地 deletedAt 比远程 updated_at 新，保留本地删除状态（防止复活）
                    const localDeleteTime = new Date(localTask.deletedAt).getTime();
                    const remoteUpdateTime = remoteTask.updatedAt ? new Date(remoteTask.updatedAt).getTime() : 0;
                    if (localDeleteTime > remoteUpdateTime) {
                      this.logger.info('保护本地删除状态（本地删除时间 > 远程更新时间）', {
                        taskId,
                        localDeletedAt: localTask.deletedAt,
                        remoteUpdatedAt: remoteTask.updatedAt
                      });
                      mergedTask = localTask; // 保留本地删除状态
                    }
                  } else {
                    const dirtyFields = new Set(pending?.changedFields ?? []);
                    
                    // 【关键改进】检查字段级操作锁
                    // 如果用户正在操作某个字段（如刚点击了状态复选框），保护该字段不被远程覆盖
                    const lockedFields = this.changeTracker.getLockedFields(taskId, targetProjectId);
                    for (const field of lockedFields) {
                      dirtyFields.add(field);
                      this.logger.debug('字段被操作锁保护', { taskId, field });
                    }
                    
                    // 【关键修复】LWW 时间戳保护
                    // 如果本地任务的 updatedAt >= 远程任务的 updatedAt，说明本地更新更晚（或同时），
                    // 应该保护本地的关键字段（status, stage, parentId, rank）避免被旧数据覆盖
                    const localTime = localTask.updatedAt ? new Date(localTask.updatedAt).getTime() : 0;
                    const remoteTime = remoteTask.updatedAt ? new Date(remoteTask.updatedAt).getTime() : 0;
                    
                    if (localTime >= remoteTime) {
                      // 本地更新不早于远程，保护关键字段
                      // 【关键修复】将 deletedAt 加入保护列表，防止删除状态被旧数据覆盖
                      const lwwProtectedFields = ['status', 'stage', 'parentId', 'rank', 'order', 'title', 'content', 'deletedAt'];
                      for (const field of lwwProtectedFields) {
                        dirtyFields.add(field);
                      }
                      this.logger.info('LWW 保护本地字段（本地时间 >= 远程时间）', { 
                        taskId, 
                        localTime: localTask.updatedAt, 
                        remoteTime: remoteTask.updatedAt 
                      });
                    }

                    // 若用户正处于编辑态（全局），依旧保护内容字段。
                    if (this.uiState.isEditing) {
                      dirtyFields.add('title');
                      dirtyFields.add('content');
                    }

                    if (dirtyFields.size > 0) {
                      const merged: Record<string, unknown> = { ...remoteTask };
                      for (const field of dirtyFields) {
                        if (field in localTask) {
                          merged[field] = localTask[field as keyof Task];
                          this.logger.debug('保护本地字段值', { taskId, field, localValue: localTask[field as keyof Task] });
                        }
                      }
                      // 【关键修复】deletedAt 优先级：任一方删除则删除
                      // 这确保删除操作不会被意外覆盖
                      if (remoteTask.deletedAt || localTask.deletedAt) {
                        merged.deletedAt = remoteTask.deletedAt || localTask.deletedAt;
                        this.logger.info('保护删除状态', { 
                          taskId, 
                          localDeletedAt: localTask.deletedAt, 
                          remoteDeletedAt: remoteTask.deletedAt 
                        });
                      }
                      mergedTask = merged as unknown as Task;
                    }
                  }
                  
                  const updatedTasks = [...p.tasks];
                  updatedTasks[existingTaskIndex] = mergedTask;
                  updatedProject = { ...p, tasks: updatedTasks };
                } else {
                  // 本地不存在该任务：
                  // - 若本机对该任务存在 pending delete，说明用户刚删掉（或离线删除待同步），不要被远端实时更新“复活”。
                  if (pending?.changeType === 'delete') {
                    this.logger.debug('忽略远端任务更新（本机 pending delete）', { taskId });
                    return p;
                  }
                  // 【关键修复】检查 tombstone，防止已永久删除的任务复活
                  // 直接查询 Supabase（通过 syncCoordinator.getTombstoneIds），不使用内存缓存
                  // 遵循 Single Source of Truth 原则
                  if (tombstoneIds.has(taskId)) {
                    this.logger.info('忽略远端任务更新（tombstone 保护）', { taskId });
                    return p;
                  }
                  // 新任务，直接添加
                  this.logger.info('添加新任务', { taskId });
                  updatedProject = { ...p, tasks: [...p.tasks, remoteTask] };
                }
                
                // 重新计算 displayId 等派生属性
                // 单任务更新时也需要 rebalance，因为 displayId 依赖树结构
                return this.syncCoordinator.validateAndRebalance(updatedProject);
              })
            );
            
            this.logger.info('远程任务更新已应用', { taskId, eventType });
          })
          .catch(async error => {
            // 如果请求已过时或服务已销毁，静默忽略错误
            if (requestId !== this.taskUpdateRequestId || this.isDestroyed) return;
            
            this.logger.error('处理远程任务更新失败', error);

            // 【v5.8】处理权限拒绝错误 (401/403)
            const supabaseError = supabaseErrorToError(error);
            if (supabaseError.code === '403' || supabaseError.code === '401') {
              this.logger.warn('权限拒绝，触发数据保全机制', {
                taskId,
                projectId: targetProjectId,
                errorCode: supabaseError.code
              });
              
              // 通知权限拒绝处理器
              const localProject = this.projectState.getProject(targetProjectId);
              if (localProject) {
                const affectedTasks = [
                  localProject.tasks.find(t => t.id === taskId)
                ].filter((t): t is Task => t !== undefined);
                
                if (affectedTasks.length > 0) {
                  await this.permissionDeniedHandler.handlePermissionDenied(
                    supabaseError as SupabaseError,
                    affectedTasks,
                    targetProjectId
                  );
                }
              }
              return; // 权限拒绝已处理，不再显示通用错误提示
            }
            
            // 通知用户远程任务同步失败，提供刷新 action
            this.toastService.warning('同步提示', '远程任务更新失败，点击刷新页面', {
              duration: 8000,
              action: {
                label: '刷新页面',
                onClick: () => reloadViaForceClearCache()
              }
            });
          });
        break;

      default:
        // 未知事件类型，记录警告但不中断处理
        this.logger.warn(`未处理的任务事件类型: ${eventType}`, { taskId, projectId });
        break;
    }
  }
  
  // ========== 测试/HMR 支持 ==========
  
  /**
   * 重置服务状态（用于测试和 HMR）
   */
  reset(): void {
    // 重置请求 ID，使所有进行中的请求结果被忽略
    this.taskUpdateRequestId++;
    
    this.callbacksInitialized = false;
    this.isDestroyed = false;
  }
}
