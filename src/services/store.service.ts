/**
 * StoreService - 应用初始化协调器
 *
 * 【重要】此服务已完成精简，仅保留必要的协调逻辑。
 *
 * ============================================================================
 * 【架构说明】
 * ============================================================================
 *
 * ✅ 新代码应直接注入所需子服务：
 *
 * ```typescript
 * private readonly taskOps = inject(TaskOperationAdapterService);
 * private readonly projectState = inject(ProjectStateService);
 * private readonly ui = inject(UiStateService);
 * private readonly sync = inject(SyncCoordinatorService);
 * ```
 *
 * 可用子服务及职责：
 * - UiStateService: UI 状态（视图切换、过滤器、侧边栏）
 * - ProjectStateService: 项目/任务状态读取、项目元数据修改
 * - SyncCoordinatorService: 同步调度、在线状态、冲突检测
 * - UserSessionService: 用户登录/登出、项目切换
 * - PreferenceService: 主题、用户偏好
 * - TaskOperationAdapterService: 任务 CRUD、撤销/重做
 * - ProjectOperationService: 项目 CRUD
 * ============================================================================
 */
import { Injectable, inject, DestroyRef } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { LoggerService } from './logger.service';
import { UndoService } from './undo.service';
import { ToastService } from './toast.service';
import { ActionQueueService } from './action-queue.service';
import { ProjectStateService } from './project-state.service';
import { SyncCoordinatorService } from './sync-coordinator.service';
import { UserSessionService } from './user-session.service';
import { PreferenceService } from './preference.service';
import { TaskOperationAdapterService } from './task-operation-adapter.service';
import { RemoteChangeHandlerService } from './remote-change-handler.service';
import { AttachmentService } from './attachment.service';
import { LayoutService } from './layout.service';
import { EventBusService } from './event-bus.service';
import { Project } from '../models';
import { isFailure } from '../utils/result';
import { TRASH_CONFIG } from '../config';

@Injectable({
  providedIn: 'root'
})
export class StoreService {
  // ========== 注入子服务 ==========
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('Store');
  private readonly undoService = inject(UndoService);
  private readonly toastService = inject(ToastService);
  private readonly actionQueue = inject(ActionQueueService);
  private readonly project = inject(ProjectStateService);
  private readonly sync = inject(SyncCoordinatorService);
  private readonly session = inject(UserSessionService);
  private readonly pref = inject(PreferenceService);
  private readonly taskOps = inject(TaskOperationAdapterService);
  private readonly remoteChangeHandler = inject(RemoteChangeHandlerService);
  private readonly attachmentService = inject(AttachmentService);
  private readonly layoutService = inject(LayoutService);
  private readonly eventBus = inject(EventBusService);
  private readonly destroyRef = inject(DestroyRef);

  /** 回收站清理定时器 */
  private trashCleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    // 订阅事件总线的撤销/重做请求（解决循环依赖）
    this.eventBus.onUndoRequest$.pipe(
      takeUntilDestroyed(this.destroyRef)
    ).subscribe(() => this.undo());

    this.eventBus.onRedoRequest$.pipe(
      takeUntilDestroyed(this.destroyRef)
    ).subscribe(() => this.redo());

    // 初始化远程变更处理
    this.remoteChangeHandler.setupCallbacks(() => this.session.loadProjects());

    // 设置附件 URL 刷新回调
    this.setupAttachmentUrlRefresh();

    // 启动回收站清理定时器
    this.startTrashCleanupTimer();

    // 清理
    this.destroyRef.onDestroy(() => {
      this.undoService.flushPendingAction();
      if (this.trashCleanupTimer) clearInterval(this.trashCleanupTimer);
      this.attachmentService.clearUrlRefreshCallback();
      this.attachmentService.clearMonitoredAttachments();
      this.sync.destroy();
    });
  }

  // ========== 撤销/重做：包装 UndoService ==========

  undo() {
    const activeProject = this.project.activeProject();
    const currentVersion = activeProject?.version;
    const result = this.undoService.undo(currentVersion);

    if (!result) return;

    if (result === 'version-mismatch') {
      this.toastService.warning('撤销失败', '远程数据已更新过多，无法撤销。请查看历史版本或刷新页面。');
      if (activeProject) {
        this.undoService.clearOutdatedHistory(activeProject.id, currentVersion ?? 0);
      }
      return;
    }

    if (typeof result === 'object' && 'type' in result && result.type === 'version-mismatch-forceable') {
      this.toastService.warning(
        '撤销注意',
        \`当前内容已被新修改改变 (\${result.versionDiff} 个版本)，撤销可能会覆盖最新内容。\`
      );
      const action = this.undoService.forceUndo();
      if (action) {
        this.applyProjectSnapshot(action.projectId, action.data.before);
      }
      return;
    }

    const action = result;
    const projectInList = this.project.projects().find(p => p.id === action.projectId);
    if (projectInList) {
      const localVersion = projectInList.version ?? 0;
      const snapshotVersion = (action.data.before as { version?: number })?.version ?? 0;

      if (localVersion > snapshotVersion + 1) {
        this.toastService.warning('注意', '撤销可能会覆盖其他设备的更新');
      }
    }

    this.applyProjectSnapshot(action.projectId, action.data.before);
  }

  redo() {
    const activeProject = this.project.activeProject();
    const currentVersion = activeProject?.version;
    const result = this.undoService.redo(currentVersion);

    if (!result) return;

    if (result === 'version-mismatch') {
      this.toastService.warning('重做失败', '远程数据已更新，无法重做');
      return;
    }

    if (typeof result === 'object' && 'type' in result && result.type === 'version-mismatch-forceable') {
      this.toastService.warning('重做失败', '远程数据已更新，无法重做');
      return;
    }

    const action = result;
    this.applyProjectSnapshot(action.projectId, action.data.after);
  }

  // ========== 冲突解决：委托给 SyncCoordinatorService ==========

  async resolveConflict(projectId: string, choice: 'local' | 'remote' | 'merge') {
    const conflictData = this.sync.conflictData();
    if (!conflictData || conflictData.projectId !== projectId) return;

    const localProject = this.project.projects().find(p => p.id === projectId);
    if (!localProject) return;

    const remoteProject = conflictData.remoteData as Project | undefined;

    const result = await this.sync.resolveConflict(
      projectId,
      choice,
      localProject,
      remoteProject
    );

    if (isFailure(result)) {
      this.toastService.error('冲突解决失败', result.error.message);
      return;
    }

    const resolvedProject = this.sync.validateAndRebalance(result.value);

    this.project.updateProjects(ps => ps.map(p =>
      p.id === projectId ? resolvedProject : p
    ));

    if (this.project.activeProjectId() === projectId) {
      this.undoService.clearHistory(projectId);
    }

    if (choice !== 'remote') {
      const userId = this.session.currentUserId();
      if (userId) {
        try {
          const syncResult = await this.sync.core.saveProjectSmart(resolvedProject, userId);
          if (!syncResult.success && !syncResult.conflict) {
            this.actionQueue.enqueue({
              type: 'update',
              entityType: 'project',
              entityId: projectId,
              payload: { project: resolvedProject }
            });
            this.toastService.warning('同步待重试', '冲突已解决，但同步失败，稍后将自动重试');
          } else if (syncResult.conflict) {
            this.toastService.error('同步冲突', '解决冲突后又发生新冲突，请稍后重试');
          }
        } catch (_e) {
          this.actionQueue.enqueue({
            type: 'update',
            entityType: 'project',
            entityId: projectId,
            payload: { project: resolvedProject }
          });
        }
      }
    }

    this.sync.core.saveOfflineSnapshot(this.project.projects());
  }

  // ========== 私有辅助方法 ==========

  private applyProjectSnapshot(projectId: string, snapshot: Partial<Project>) {
    this.project.updateProjects(projects => projects.map(p => {
      if (p.id === projectId) {
        return this.layoutService.rebalance({
          ...p,
          tasks: snapshot.tasks ?? p.tasks,
          connections: snapshot.connections ?? p.connections
        });
      }
      return p;
    }));
    this.sync.markLocalChanges('structure');
    this.sync.schedulePersist();
  }

  private startTrashCleanupTimer() {
    const cleanedCount = this.taskOps.cleanupOldTrashItems();
    if (cleanedCount > 0) {
      this.logger.info(\`启动时清理了 \${cleanedCount} 个超期回收站任务\`);
    }

    this.trashCleanupTimer = setInterval(() => {
      const count = this.taskOps.cleanupOldTrashItems();
      if (count > 0) {
        this.logger.info(\`定期清理了 \${count} 个超期回收站任务\`);
        this.sync.schedulePersist();
      }
    }, TRASH_CONFIG.CLEANUP_INTERVAL);
  }

  private setupAttachmentUrlRefresh() {
    this.attachmentService.setUrlRefreshCallback((refreshedUrls) => {
      if (refreshedUrls.size === 0) return;

      this.project.updateProjects(projects => projects.map(project => {
        let hasChanges = false;
        const updatedTasks = project.tasks.map(task => {
          if (!task.attachments || task.attachments.length === 0) return task;

          const updatedAttachments = task.attachments.map(attachment => {
            const refreshed = refreshedUrls.get(attachment.id);
            if (refreshed) {
              hasChanges = true;
              return {
                ...attachment,
                url: refreshed.url,
                thumbnailUrl: refreshed.thumbnailUrl ?? attachment.thumbnailUrl
              };
            }
            return attachment;
          });

          return hasChanges ? { ...task, attachments: updatedAttachments } : task;
        });

        return hasChanges ? { ...project, tasks: updatedTasks } : project;
      }));
    });
  }
}
