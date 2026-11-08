/**
 * TaskOperationAdapterService - 任务操作适配器
 *
 * 桥接 TaskOperationService 与 SyncCoordinatorService，
 * 处理撤销/重做、乐观更新、Toast 反馈。
 *
 * @see TaskRecordTrackingService - 记录/追踪/撤销/重做实现
 */
import { Injectable, inject } from '@angular/core';
import { TaskOperationService } from './task-operation.service';
import { TaskRecordTrackingService } from './task-record-tracking.service';
import { SyncCoordinatorService } from './sync-coordinator.service';
import { ChangeTrackerService } from './change-tracker.service';
import { UndoService } from './undo.service';
import { UiStateService } from './ui-state.service';
import { ProjectStateService } from './project-state.service';
import { OptimisticStateService } from './optimistic-state.service';
import { LoggerService } from './logger.service';
import { ToastService } from './toast.service';
import { UserSessionService } from './user-session.service';
import { ConnectionAdapterService } from './connection-adapter.service';
import { WriteGuardService } from './write-guard.service';
import { ActionQueueService } from './action-queue.service';
import { AuthService } from './auth.service';
import { AUTH_CONFIG } from '../config/auth.config';
import { localBackupUiRestoreWriterQuiescence } from './local-backup-ui-restore-writer-quiescence.service';
import { Task, Attachment, TaskAttentionDraftItem } from '../models';
import { ErrorCodes, failure, Result, OperationError } from '../utils/result';
import { blockTaskMutation, type TaskMutationBlockOptions } from './task-operation-mutation-guard.helpers';
import { runTaskDurableFieldMutation } from './task-operation-durable-field.helpers';
import {
  type PermanentDeleteOutcome,
  TaskOperationTrashAdapterController,
  type TaskOperationUiOwner,
} from './task-operation-trash-adapter.controller';
import {
  addTaskAttachmentToProjectState,
  enqueueTaskAttachmentProjectUpdateIfNeeded,
  type TaskProjectAttachmentOwnerFence,
} from './task-operation-attachment-project.helpers';
import {
  recordTaskPositionBatchDurably,
  type TaskPositionPatch,
} from './task-operation-position-batch.helpers';
import { TaskOperationAdapterWarmupController } from './task-operation-adapter-warmup.controller';
import {
  runTaskCognitiveLoadMutation,
  runTaskDueDateMutation,
  runTaskExpectedMinutesMutation,
  runTaskPlannerFieldsMutation,
  runTaskPriorityMutation,
  runTaskWaitMinutesMutation,
  type TaskCognitiveLoadValue,
  type TaskPlannerFieldsPatch,
  type TaskPriorityValue,
} from './task-operation-adapter-planner.helpers';
import { TaskOperationAdapterMoveController } from './task-operation-adapter-move.controller';
import { TaskOperationAdapterInsertController } from './task-operation-adapter-insert.controller';
import { TaskOperationAdapterStructureController } from './task-operation-adapter-structure.controller';

@Injectable({
  providedIn: 'root'
})
export class TaskOperationAdapterService {
  /** 底层任务操作服务 - 直接访问纯 CRUD 方法（不触发撤销/乐观更新/Toast） */
  readonly core = inject(TaskOperationService);
  /** 连接操作适配器 */
  readonly connectionAdapter = inject(ConnectionAdapterService);
  /** 记录/追踪/撤销/重做服务 */
  readonly recorder = inject(TaskRecordTrackingService);

  private syncCoordinator = inject(SyncCoordinatorService);
  private changeTracker = inject(ChangeTrackerService);
  private undoService = inject(UndoService);
  private uiState = inject(UiStateService);
  private projectState = inject(ProjectStateService);
  private optimisticState = inject(OptimisticStateService);
  private toastService = inject(ToastService);
  private userSession = inject(UserSessionService);
  private writeGuard = inject(WriteGuardService);
  private actionQueue = inject(ActionQueueService);
  private authService = inject(AuthService);
  private readonly mutationGuardRuntime = {
    isExportOnly: () => this.writeGuard.isExportOnly(),
    isHintOnlyStartupReadOnly: () => this.userSession.isHintOnlyStartupPlaceholderVisible?.() ?? false,
    toastInfo: (title: string, message: string) => this.toastService.info(title, message),
  };
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('TaskOpsAdapter');
  private readonly durableFieldRuntime = {
    blockLocalMutation: (actionLabel: string) => this.blockLocalMutation(actionLabel),
    markContentEditing: () => { this.markLocalEditing(); this.recorder.lastUpdateType = 'content'; },
    warn: (message: string, data: Record<string, unknown>) => this.logger.warn(message, data),
  };
  private readonly trashAdapter = new TaskOperationTrashAdapterController({
    blockLocalMutation: (actionLabel) => this.blockLocalMutation(actionLabel),
    core: this.core,
    logger: this.logger,
    markEditing: () => this.markLocalEditing(),
    optimisticState: this.optimisticState,
    projectState: this.projectState,
    recorder: this.recorder,
    rollbackSnapshotAfterDurableFailure: (snapshotId, message, data, canPublishUi) =>
      this.rollbackSnapshotAfterDurableFailure(snapshotId, message, data, canPublishUi),
  });
  private readonly warmupController = new TaskOperationAdapterWarmupController({
    activeProjectId: () => this.projectState.activeProjectId(),
    isEditing: () => this.uiState.isEditing,
    hasPendingLocalChanges: () => this.syncCoordinator.hasPendingLocalChanges(),
    clearHistory: () => this.undoService.clearHistory(),
  });
  private readonly moveAdapter = new TaskOperationAdapterMoveController({
    blockLocalMutationResult: <T>(actionLabel: string) =>
      this.blockLocalMutationResult<T>(actionLabel),
    core: this.core,
    markStructureEditing: () => {
      this.markLocalEditing();
      this.recorder.lastUpdateType = 'structure';
    },
    optimisticState: this.optimisticState,
    projectState: this.projectState,
    recorder: this.recorder,
    warn: (message, data) => this.logger.warn(message, data),
  });
  private readonly insertAdapter = new TaskOperationAdapterInsertController({
    blockLocalMutationResult: <T>(actionLabel: string) =>
      this.blockLocalMutationResult<T>(actionLabel),
    core: this.core,
    markStructureEditing: () => {
      this.markLocalEditing();
      this.recorder.lastUpdateType = 'structure';
    },
    optimisticState: this.optimisticState,
    recorder: this.recorder,
  });
  private readonly structureAdapter = new TaskOperationAdapterStructureController({
    blockLocalMutation: (actionLabel: string) => this.blockLocalMutation(actionLabel),
    blockLocalMutationResult: <T>(actionLabel: string) =>
      this.blockLocalMutationResult<T>(actionLabel),
    core: this.core,
    markStructureEditing: () => {
      this.markLocalEditing();
      this.recorder.lastUpdateType = 'structure';
    },
    optimisticState: this.optimisticState,
    recorder: this.recorder,
  });

  /**
   * 交互层预热（P1）
   * 仅触发轻量依赖访问，不阻断业务操作。
   */
  warmup(): Promise<void> {
    return this.warmupController.warmup();
  }

  // ========== 公共方法 ==========

  getLastUpdateType(): 'content' | 'structure' | 'position' {
    return this.recorder.lastUpdateType;
  }

  isHintOnlyStartupReadOnly(): boolean { return this.mutationGuardRuntime.isHintOnlyStartupReadOnly(); }

  private blockLocalMutation(actionLabel: string, options?: TaskMutationBlockOptions): boolean {
    return blockTaskMutation(actionLabel, this.mutationGuardRuntime, options) !== null;
  }

  private blockLocalMutationResult<T>(actionLabel: string): Result<T, OperationError> | null {
    const blocked = blockTaskMutation(actionLabel, this.mutationGuardRuntime);
    if (!blocked) {
      return null;
    }

    return failure(ErrorCodes.PERMISSION_DENIED, blocked.errorMessage);
  }

  private rollbackSnapshotAfterDurableFailure(
    snapshotId: string,
    message: string,
    data: Record<string, unknown>,
    canPublishUi: TaskOperationUiOwner = () => true,
  ): void {
    if (canPublishUi()) this.optimisticState.rollbackSnapshot(snapshotId);
    else this.optimisticState.discardSnapshot(snapshotId);
    this.logger.warn(message, data);
  }

  markEditing(): void {
    this.uiState.markEditing();
    this.syncCoordinator.markLocalChanges(this.recorder.lastUpdateType);
  }

  private markLocalEditing(): void {
    this.uiState.markEditing();
  }

  get isUserEditing(): boolean {
    return this.uiState.isEditing || this.syncCoordinator.hasPendingLocalChanges();
  }

  /** 执行撤销操作 */
  performUndo(): Promise<boolean> {
    if (this.blockLocalMutation('撤销操作')) {
      return Promise.resolve(false);
    }

    return this.recorder.performUndo();
  }
  /** 执行重做操作 */
  performRedo(): Promise<boolean> {
    if (this.blockLocalMutation('重做操作')) {
      return Promise.resolve(false);
    }

    return this.recorder.performRedo();
  }

  // ========== 任务内容操作 ==========

  updateTaskContent(taskId: string, newContent: string): Promise<boolean> {
    return runTaskDurableFieldMutation({
      actionLabel: '编辑任务',
      failureMessage: '任务内容本地持久化失败，未提交 UI 更新',
      failureData: { taskId },
      mutate: () => this.core.updateTaskContentDurably(taskId, newContent),
    }, this.durableFieldRuntime);
  }

  updateTaskTitle(taskId: string, title: string): Promise<boolean> {
    return runTaskDurableFieldMutation({
      actionLabel: '编辑任务',
      failureMessage: '任务标题本地持久化失败，未提交 UI 更新',
      failureData: { taskId },
      mutate: () => this.core.updateTaskTitleDurably(taskId, title),
    }, this.durableFieldRuntime);
  }

  updateTaskDraft(
    taskId: string,
    draft: Partial<Pick<Task, 'title' | 'content'>>,
  ): Promise<boolean> {
    return runTaskDurableFieldMutation({
      actionLabel: '编辑任务',
      failureMessage: '任务草稿本地持久化失败，未提交 UI 更新',
      failureData: { taskId },
      mutate: () => this.core.updateTaskDraftDurably(taskId, draft),
    }, this.durableFieldRuntime);
  }

  addTodoItem(taskId: string, itemText: string): Promise<boolean> {
    return runTaskDurableFieldMutation({
      actionLabel: '编辑任务',
      failureMessage: '任务待办本地持久化失败，未提交 UI 更新',
      failureData: { taskId },
      mutate: () => this.core.addTodoItemDurably(taskId, itemText),
    }, this.durableFieldRuntime);
  }

  // ========== 任务位置操作 ==========

  async updateTaskPosition(taskId: string, x: number, y: number): Promise<boolean> {
    if (this.blockLocalMutation('移动任务', { toast: false })) {
      return false;
    }

    this.recorder.lastUpdateType = 'position';
    const saved = await this.core.updateTaskPositionDurably(taskId, x, y);
    if (!saved) {
      this.logger.warn('任务位置本地持久化失败，未提交 UI 更新', { taskId, x, y });
    }
    return saved;
  }

  beginPositionBatch(): void {
    if (this.blockLocalMutation('移动任务')) {
      return;
    }

    const project = this.projectState.activeProject();
    if (project) this.undoService.beginBatch(project);
  }

  endPositionBatch(): void {
    if (this.writeGuard.isExportOnly() || this.isHintOnlyStartupReadOnly()) {
      return;
    }

    const project = this.projectState.activeProject();
    if (project) {
      this.undoService.endBatch(project);
      this.syncCoordinator.markLocalChanges('position');
      this.syncCoordinator.schedulePersist();
    }
  }

  cancelPositionBatch(): void {
    this.undoService.cancelBatch();
  }

  async updateTaskPositionWithUndo(taskId: string, x: number, y: number): Promise<boolean> {
    if (this.blockLocalMutation('移动任务')) {
      return false;
    }

    this.recorder.lastUpdateType = 'position';
    const task = this.projectState.getTask(taskId);
    if (!task) return false;
    if (Math.abs(task.x - x) < 1 && Math.abs(task.y - y) < 1) return true;

    const now = new Date().toISOString();
    const saved = await this.recorder.recordAndUpdateDurably(p => ({
      ...p,
      tasks: p.tasks.map(t =>
        t.id === taskId ? { ...t, x, y, updatedAt: now } : t
      )
    }), { updateType: 'position' });
    if (!saved) {
      this.logger.warn('任务位置本地持久化失败，未提交 UI 更新', { taskId, x, y });
    }
    return saved;
  }

  async updateTaskPositionsDurably(positions: TaskPositionPatch[]): Promise<boolean> {
    if (positions.length === 0) {
      return true;
    }

    if (this.blockLocalMutation('移动任务', { toast: false })) {
      return false;
    }

    return recordTaskPositionBatchDurably(positions, this.recorder, this.logger);
  }

  async updateTaskPositionWithRankSync(taskId: string, x: number, y: number, options?: { toast?: boolean }): Promise<boolean> {
    if (this.blockLocalMutation('移动任务', options)) {
      return false;
    }

    this.recorder.lastUpdateType = 'position';
    const saved = await this.core.updateTaskPositionWithRankSyncDurably(taskId, x, y);
    if (!saved) {
      this.logger.warn('任务位置排序本地持久化失败，未提交 UI 更新', { taskId, x, y });
    }
    return saved;
  }

  // ========== 任务状态操作 ==========

  async updateTaskStatus(
    taskId: string,
    status: Task['status'],
    projectId: string | null = this.projectState.activeProjectId(),
  ): Promise<boolean> {
    if (this.blockLocalMutation('更新任务状态')) {
      return false;
    }

    this.markLocalEditing();
    this.recorder.lastUpdateType = 'content';
    const saved = await this.core.updateTaskStatusDurably(taskId, status);
    if (!saved) {
      this.logger.warn('任务状态本地持久化失败，未提交 UI 更新', { taskId, status });
      return false;
    }

    const project = projectId ? this.projectState.getProjectWithCurrentData(projectId) : undefined;
    if (projectId && project?.tasks.some(task => task.id === taskId)) {
      this.changeTracker.lockTaskField(taskId, projectId, 'status');
    }
    return true;
  }

  // ========== 任务扩展属性 ==========

  updateTaskAttachments(taskId: string, attachments: Attachment[]): Promise<boolean> {
    return runTaskDurableFieldMutation({
      actionLabel: '更新任务附件',
      failureMessage: '任务附件本地持久化失败，未提交 UI 更新',
      failureData: { taskId },
      mutate: () => this.core.updateTaskAttachmentsDurably(taskId, attachments),
    }, this.durableFieldRuntime);
  }

  updateTaskParkingMeta(taskId: string, parkingMeta: Task['parkingMeta'] | undefined): Promise<boolean>;
  updateTaskParkingMeta(
    projectId: string, taskId: string, parkingMeta: Task['parkingMeta'] | undefined,
  ): Promise<boolean>;
  updateTaskParkingMeta(
    projectOrTaskId: string,
    taskIdOrMeta: string | Task['parkingMeta'] | undefined,
    explicitMeta?: Task['parkingMeta'],
  ): Promise<boolean> {
    const explicitProjectId = typeof taskIdOrMeta === 'string' ? projectOrTaskId : null;
    const taskId = typeof taskIdOrMeta === 'string' ? taskIdOrMeta : projectOrTaskId;
    return runTaskDurableFieldMutation({
      actionLabel: '更新任务停泊状态',
      failureMessage: '任务停泊状态本地持久化失败，未提交 UI 更新',
      failureData: { ...(explicitProjectId ? { projectId: explicitProjectId } : {}), taskId },
      mutate: () => typeof taskIdOrMeta === 'string'
        ? this.core.updateTaskParkingMetaDurably(projectOrTaskId, taskIdOrMeta, explicitMeta)
        : this.core.updateTaskParkingMetaDurably(projectOrTaskId, taskIdOrMeta),
    }, this.durableFieldRuntime);
  }

  updateTaskParkingMetaBatch(
    updates: Array<{ taskId: string; parkingMeta: Task['parkingMeta'] | undefined }>,
  ): Promise<boolean>;
  updateTaskParkingMetaBatch(
    projectId: string,
    updates: Array<{ taskId: string; parkingMeta: Task['parkingMeta'] | undefined }>,
  ): Promise<boolean>;
  updateTaskParkingMetaBatch(
    projectOrUpdates: string | Array<{ taskId: string; parkingMeta: Task['parkingMeta'] | undefined }>,
    explicitUpdates?: Array<{ taskId: string; parkingMeta: Task['parkingMeta'] | undefined }>,
  ): Promise<boolean> {
    const explicitProjectId = typeof projectOrUpdates === 'string' ? projectOrUpdates : null;
    const updates = typeof projectOrUpdates === 'string' ? explicitUpdates ?? [] : projectOrUpdates;
    return runTaskDurableFieldMutation({
      actionLabel: '批量更新任务停泊状态',
      failureMessage: '任务停泊状态本地批量持久化失败，未提交 UI 更新',
      failureData: {
        ...(explicitProjectId ? { projectId: explicitProjectId } : {}),
        taskIds: updates.map(update => update.taskId),
      },
      mutate: () => explicitProjectId
        ? this.core.updateTaskParkingMetaBatchDurably(explicitProjectId, updates)
        : this.core.updateTaskParkingMetaBatchDurably(updates),
    }, this.durableFieldRuntime);
  }

  addTaskAttachment(taskId: string, attachment: Attachment): Promise<boolean> {
    return runTaskDurableFieldMutation({
      actionLabel: '添加任务附件',
      failureMessage: '任务附件添加本地持久化失败，未提交 UI 更新',
      failureData: { taskId, attachmentId: attachment.id },
      mutate: () => this.core.addTaskAttachmentDurably(taskId, attachment),
    }, this.durableFieldRuntime);
  }

  async addTaskAttachmentToProject(
    projectId: string,
    taskId: string,
    attachment: Attachment,
    options: { operationId?: string } = {},
  ): Promise<boolean> {
    if (this.blockLocalMutation('添加任务附件')) {
      return false;
    }

    const ownerUserId = this.authService.currentUserId() ?? AUTH_CONFIG.LOCAL_MODE_USER_ID;
    const projectOwner = Object.freeze({ ...this.projectState.captureActiveProjectOwner() });
    const ownerFence: TaskProjectAttachmentOwnerFence = Object.freeze({
      ownerUserId,
      projectOwner,
      operationId: options.operationId ?? crypto.randomUUID(),
      isCurrent: () => (
        (this.authService.currentUserId() ?? AUTH_CONFIG.LOCAL_MODE_USER_ID) === ownerUserId
        && this.projectState.isActiveProjectOwnerCurrent(projectOwner)
      ),
    });
    if (!ownerFence.isCurrent()) return false;

    const result = await localBackupUiRestoreWriterQuiescence.runAsync(
      ownerUserId,
      'project-state',
      () => {
        if (!ownerFence.isCurrent()) return Promise.resolve(false);
        return this.addTaskAttachmentToProjectUnderWriter(projectId, taskId, attachment, ownerFence);
      },
    );
    return ownerFence.isCurrent() ? result : false;
  }

  private async addTaskAttachmentToProjectUnderWriter(
    projectId: string,
    taskId: string,
    attachment: Attachment,
    ownerFence: TaskProjectAttachmentOwnerFence,
  ): Promise<boolean> {
    if (!ownerFence.isCurrent()) return false;
    const ownerUserId = ownerFence.ownerUserId;
    const currentProject = this.projectState.projects().find(project => project.id === projectId);
    const currentTask = currentProject?.tasks.find(task => task.id === taskId);
    if (!currentProject || !currentTask) {
      this.logger.warn('添加附件失败：目标任务不存在', { projectId, taskId, attachmentId: attachment.id });
      return false;
    }

    const outboxReady = await enqueueTaskAttachmentProjectUpdateIfNeeded({
      project: currentProject,
      projectId,
      task: currentTask,
      taskId,
      attachment,
      operationId: ownerFence.operationId,
    }, {
      ownerFence,
      currentUserId: () => ownerFence.isCurrent() ? ownerUserId : null,
      enqueueDurably: action => {
        const enqueueForOwner = this.actionQueue.enqueueDurablyForOwner;
        return typeof enqueueForOwner === 'function'
          ? enqueueForOwner.call(this.actionQueue, ownerUserId, action)
          : this.actionQueue.enqueueDurably(action);
      },
      warn: (message, data) => this.logger.warn(message, data),
    });
    if (!outboxReady || !ownerFence.isCurrent()) {
      return false;
    }

    return addTaskAttachmentToProjectState({
      projectId,
      taskId,
      attachment,
      operationId: ownerFence.operationId,
    }, {
      ownerFence,
      blockLocalMutation: () => false,
      currentUserId: () => ownerFence.isCurrent() ? ownerUserId : null,
      getProjectsWithCurrentData: () => this.projectState.getProjectsWithCurrentData(),
      persistOfflineSnapshot: (projects, ownerUserId) =>
        this.syncCoordinator.saveOfflineSnapshotAndWait(projects, ownerUserId),
      updateProjects: mutator => this.projectState.updateProjects(mutator, ownerUserId),
      markEditing: () => this.markLocalEditing(),
      setLastUpdateType: updateType => { this.recorder.lastUpdateType = updateType; },
      trackTaskUpdate: (id, task, fields) => this.changeTracker.trackTaskUpdate(id, task, fields),
      markLocalChanges: updateType => this.syncCoordinator.markLocalChanges(updateType),
      schedulePersist: () => this.syncCoordinator.schedulePersist(),
      warn: (message, data) => this.logger.warn(message, data),
    });
  }

  removeTaskAttachment(taskId: string, attachmentId: string): Promise<boolean> {
    return runTaskDurableFieldMutation({
      actionLabel: '移除任务附件',
      failureMessage: '任务附件移除本地持久化失败，未提交 UI 更新',
      failureData: { taskId, attachmentId },
      mutate: () => this.core.removeTaskAttachmentDurably(taskId, attachmentId),
    }, this.durableFieldRuntime);
  }

  updateTaskPriority(taskId: string, priority: TaskPriorityValue): Promise<boolean> {
    return runTaskPriorityMutation(this.core, this.durableFieldRuntime, taskId, priority);
  }

  updateTaskDueDate(taskId: string, dueDate: string | null): Promise<boolean> {
    return runTaskDueDateMutation(this.core, this.durableFieldRuntime, taskId, dueDate);
  }

  updateTaskExpectedMinutes(taskId: string, expectedMinutes: number | null): Promise<boolean> {
    return runTaskExpectedMinutesMutation(this.core, this.durableFieldRuntime, taskId, expectedMinutes);
  }

  updateTaskPlannerFields(
    taskId: string,
    patch: TaskPlannerFieldsPatch,
  ): Promise<boolean> {
    return runTaskPlannerFieldsMutation(this.core, this.durableFieldRuntime, taskId, patch);
  }

  updateTaskCognitiveLoad(taskId: string, load: TaskCognitiveLoadValue): Promise<boolean> {
    return runTaskCognitiveLoadMutation(this.core, this.durableFieldRuntime, taskId, load);
  }

  updateTaskWaitMinutes(taskId: string, waitMinutes: number | null): Promise<boolean> {
    return runTaskWaitMinutesMutation(this.core, this.durableFieldRuntime, taskId, waitMinutes);
  }

  updateTaskTags(taskId: string, tags: string[]): Promise<boolean> {
    return runTaskDurableFieldMutation({
      actionLabel: '更新任务标签',
      failureMessage: '任务标签本地持久化失败，未提交 UI 更新',
      failureData: { taskId },
      mutate: () => this.core.updateTaskTagsDurably(taskId, tags),
    }, this.durableFieldRuntime);
  }

  addTaskTag(taskId: string, tag: string): Promise<boolean> {
    return runTaskDurableFieldMutation({
      actionLabel: '添加任务标签',
      failureMessage: '任务标签添加本地持久化失败，未提交 UI 更新',
      failureData: { taskId, tag },
      mutate: () => this.core.addTaskTagDurably(taskId, tag),
    }, this.durableFieldRuntime);
  }

  removeTaskTag(taskId: string, tag: string): Promise<boolean> {
    return runTaskDurableFieldMutation({
      actionLabel: '移除任务标签',
      failureMessage: '任务标签移除本地持久化失败，未提交 UI 更新',
      failureData: { taskId, tag },
      mutate: () => this.core.removeTaskTagDurably(taskId, tag),
    }, this.durableFieldRuntime);
  }

  updateTaskAttentionItems(taskId: string, items: TaskAttentionDraftItem[]): Promise<boolean> {
    return runTaskDurableFieldMutation({
      actionLabel: '更新任务僚机',
      failureMessage: '任务僚机注意事项本地持久化失败，未提交 UI 更新',
      failureData: { taskId },
      mutate: () => this.core.updateTaskAttentionItemsDurably(taskId, items),
    }, this.durableFieldRuntime);
  }

  /** 添加任务（带乐观更新） */
  async addTask(
    title: string,
    content: string,
    targetStage: number | null,
    parentId: string | null,
    isSibling: boolean
  ): Promise<Result<string, OperationError>> {
    return this.addTaskWithUiOwner(title, content, targetStage, parentId, isSibling, () => true);
  }

  addTaskForUiOwner(
    title: string,
    content: string,
    targetStage: number | null,
    parentId: string | null,
    isSibling: boolean,
    canPublishUi: TaskOperationUiOwner,
  ): Promise<Result<string, OperationError>> {
    return this.addTaskWithUiOwner(title, content, targetStage, parentId, isSibling, canPublishUi);
  }

  private async addTaskWithUiOwner(
    title: string,
    content: string,
    targetStage: number | null,
    parentId: string | null,
    isSibling: boolean,
    canPublishUi: TaskOperationUiOwner,
  ): Promise<Result<string, OperationError>> {
    const blocked = this.blockLocalMutationResult<string>('创建任务');
    if (blocked) return blocked;

    this.markLocalEditing();
    this.recorder.lastUpdateType = 'structure';
    const snapshot = this.optimisticState.createTaskSnapshot('', '创建');
    const result = await this.core.addTaskDurably({ title, content, targetStage, parentId, isSibling });

    if (result.ok) {
      if (canPublishUi()) this.recorder.showUndoToast(`已创建 "${title || '新任务'}"`);
      this.recorder.setupSyncResultHandler(snapshot.id);
    } else {
      if (canPublishUi()) this.optimisticState.rollbackSnapshot(snapshot.id);
      else this.optimisticState.discardSnapshot(snapshot.id);
    }
    return result;
  }

  /** 添加浮动任务（Flow 视图中双击创建） */
  async addFloatingTask(title: string, content: string, x: number, y: number): Promise<boolean> {
    if (this.blockLocalMutation('创建任务')) {
      return false;
    }

    this.markLocalEditing();
    this.recorder.lastUpdateType = 'structure';
    const snapshot = this.optimisticState.createTaskSnapshot('', '创建');
    const saved = await this.core.addFloatingTaskDurably(title, content, x, y);
    if (!saved) {
      this.optimisticState.rollbackSnapshot(snapshot.id);
      this.logger.warn('浮动任务本地持久化失败，未提交 UI 更新', { title, x, y });
      return false;
    }

    this.recorder.showUndoToast(`已创建 "${title || '新任务'}"`);
    this.recorder.setupSyncResultHandler(snapshot.id);
    return true;
  }

  /** 删除任务（带乐观更新） */
  async deleteTask(taskId: string): Promise<boolean> {
    return this.trashAdapter.deleteTask(taskId);
  }

  /** 永久删除任务（从回收站中删除） */
  async permanentlyDeleteTask(taskId: string, canPublishUi?: TaskOperationUiOwner): Promise<boolean> {
    return this.trashAdapter.permanentlyDeleteTask(taskId, canPublishUi);
  }

  permanentlyDeleteTaskWithOutcome(
    taskId: string, canPublishUi?: TaskOperationUiOwner,
  ): Promise<PermanentDeleteOutcome> {
    return this.trashAdapter.permanentlyDeleteTaskWithOutcome(taskId, canPublishUi);
  }

  /** 批量删除任务（原子操作，P0 熔断层） */
  async deleteTasksBatch(
    explicitIds: string[], canPublishUi?: TaskOperationUiOwner,
  ): Promise<number> {
    return this.trashAdapter.deleteTasksBatch(explicitIds, canPublishUi);
  }

  calculateBatchDeleteImpact(explicitIds: string[]): { total: number; explicit: number; cascaded: number } {
    return this.trashAdapter.calculateBatchDeleteImpact(explicitIds);
  }

  /** 恢复已删除的任务 */
  async restoreTask(taskId: string): Promise<boolean> {
    return this.trashAdapter.restoreTask(taskId);
  }

  /** 清空回收站 */
  async emptyTrash(canPublishUi?: TaskOperationUiOwner): Promise<boolean> {
    return this.trashAdapter.emptyTrash(canPublishUi);
  }

  // ========== 任务结构操作 ==========

  /** 移动任务到指定阶段 */
  async moveTaskToStage(
    taskId: string,
    newStage: number | null,
    beforeTaskId?: string | null,
    newParentId?: string | null
  ): Promise<Result<void, OperationError>> {
    return this.moveAdapter.moveTaskToStage(
      taskId,
      newStage,
      beforeTaskId,
      newParentId,
    );
  }

  async moveTaskToStageAtPosition(
    taskId: string,
    newStage: number | null,
    beforeTaskId: string | null | undefined,
    newParentId: string | null | undefined,
    x: number,
    y: number,
  ): Promise<Result<void, OperationError>> {
    return this.moveAdapter.moveTaskToStageAtPosition(
      taskId,
      newStage,
      beforeTaskId,
      newParentId,
      x,
      y,
    );
  }

  /** 将任务插入到两个任务之间 */
  async insertTaskBetween(taskId: string, sourceId: string, targetId: string): Promise<Result<void, OperationError>> {
    return this.insertAdapter.insertTaskBetween(taskId, sourceId, targetId);
  }

  async insertTaskBetweenAtPosition(
    taskId: string,
    sourceId: string,
    targetId: string,
    x: number,
    y: number,
  ): Promise<Result<void, OperationError>> {
    return this.insertAdapter.insertTaskBetweenAtPosition(
      taskId,
      sourceId,
      targetId,
      x,
      y,
    );
  }

  /** 将整个子任务树迁移到新的父任务下 */
  async moveSubtreeToNewParent(taskId: string, newParentId: string | null): Promise<Result<void, OperationError>> {
    return this.structureAdapter.moveSubtreeToNewParent(taskId, newParentId);
  }

  /** 重排阶段内任务顺序 */
  async reorderStage(stage: number, orderedIds: string[]): Promise<boolean> {
    return this.structureAdapter.reorderStage(stage, orderedIds);
  }

  /** 分离任务（移回待分配区） */
  async detachTask(taskId: string): Promise<boolean> {
    return this.structureAdapter.detachTask(taskId);
  }

  /** 分离任务及其整个子树（移回待分配区） */
  async detachTaskWithSubtree(taskId: string): Promise<Result<void, OperationError>> {
    return this.structureAdapter.detachTaskWithSubtree(taskId);
  }

  // ========== 子树替换操作（流程图逻辑链条功能） ==========

  /** 将任务块的子树替换为待分配块子树 */
  async replaceChildSubtreeWithUnassigned(
    sourceTaskId: string,
    targetUnassignedId: string,
    specificChildId?: string
  ): Promise<Result<{ detachedSubtreeRootId: string | null }, OperationError>> {
    return this.structureAdapter.replaceChildSubtreeWithUnassigned(
      sourceTaskId,
      targetUnassignedId,
      specificChildId,
    );
  }

  /** 将待分配块分配为任务块的子节点 */
  async assignUnassignedToTask(
    sourceTaskId: string,
    targetUnassignedId: string
  ): Promise<Result<void, OperationError>> {
    return this.structureAdapter.assignUnassignedToTask(sourceTaskId, targetUnassignedId);
  }

  /** 检查待分配块是否有父待分配块 */
  getUnassignedParent(taskId: string): string | null {
    return this.structureAdapter.getUnassignedParent(taskId);
  }

  /** 获取任务的直接子任务 */
  getDirectChildren(taskId: string): Task[] {
    return this.structureAdapter.getDirectChildren(taskId);
  }

  /** 删除任务但保留子任务 */
  async deleteTaskKeepChildren(taskId: string): Promise<boolean> {
    return this.trashAdapter.deleteTaskKeepChildren(taskId);
  }

  /** 修复阶段 1 缺失导致的阶段链漂移。 */
  async repairMissingStageOne(): Promise<boolean> {
    return this.structureAdapter.repairMissingStageOne(() => true);
  }

  repairMissingStageOneForUiOwner(canPublishUi: TaskOperationUiOwner): Promise<boolean> {
    return this.structureAdapter.repairMissingStageOne(canPublishUi);
  }

  // ========== 查询方法 ==========

  isStageRebalancing(stage: number): boolean {
    return this.core.isStageRebalancing(stage);
  }

  cleanupOldTrashItems(): Promise<number> {
    return this.core.cleanupOldTrashItems();
  }
}
