/** TaskRecordTrackingService - 任务操作记录、撤销重做、变更追踪与同步结果处理。 */
import { DestroyRef, Injectable, inject } from '@angular/core';
import { ProjectStateService, type ActiveProjectOwner } from './project-state.service';
import { SessionRuntimeResetRegistry } from './session-runtime-reset.service';
import { UndoService } from './undo.service';
import { SyncCoordinatorService } from './sync-coordinator.service';
import { ChangeTrackerService } from './change-tracker.service';
import { LayoutService } from './layout.service';
import { OptimisticStateService } from './optimistic-state.service';
import { ToastService } from './toast.service';
import { UiStateService } from './ui-state.service';
import { LoggerService } from './logger.service';
import { ActionQueueService } from './action-queue.service';
import { AuthService } from './auth.service';
import { Project, Task, Connection } from '../models';
import { AUTH_CONFIG } from '../config/auth.config';
import type { EnqueueParams } from './action-queue.types';
import { localBackupUiRestoreWriterQuiescence } from './local-backup-ui-restore-writer-quiescence.service';
import {
  collectTaskRecordTrackingOutboxActions,
  getTaskRecordChangedFields,
  hasMissingRecoverableTaskRecordTrackingOutboxIntent,
  type TaskRecordTrackingOutboxContext,
} from './task-record-tracking-outbox.helpers';
import {
  buildTaskDeleteBaseUpdatedAtMap,
  buildTaskTombstoneTimestamps,
  collectJustDeletedTaskIds,
} from './task-record-tracking-delete.helpers';
import { buildTaskRecordTrackingConnectionMap } from './task-record-tracking-connection-map.helpers';
import {
  trackTaskRecordConnectionChanges,
} from './task-record-tracking-connection-changes.helpers';
import { normalizeTaskRecordProjectConnections } from './task-record-tracking-normalize-project.helpers';
import {
  buildImmediateOfflineSnapshotProjects,
  persistImmediateOfflineSnapshot,
} from './task-record-tracking-offline-snapshot.helpers';
import { TaskRecordSyncResultController } from './task-record-sync-result.controller';
import { createProjectTaskDeleteBatchOperationId } from './project-operation-child-operation-id';

type RecordAndUpdateDurablyOptions = {
  updateType?: 'content' | 'structure' | 'position';
  debouncedUndo?: boolean;
  recordUndo?: boolean;
};

type RecordUpdateContext = {
  projectId: string;
  uiOwner: ActiveProjectOwner;
  requireCurrentUiOwner: boolean;
  ownerUserId: string | null;
  generation: number;
};

@Injectable({
  providedIn: 'root'
})
export class TaskRecordTrackingService {
  private readonly projectState = inject(ProjectStateService);
  private readonly undoService = inject(UndoService);
  private readonly syncCoordinator = inject(SyncCoordinatorService);
  private readonly changeTracker = inject(ChangeTrackerService);
  private readonly layoutService = inject(LayoutService);
  private readonly optimisticState = inject(OptimisticStateService);
  private readonly toastService = inject(ToastService);
  private readonly uiState = inject(UiStateService);
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('TaskRecord');
  private readonly actionQueue = inject(ActionQueueService);
  private readonly authService = inject(AuthService);
  private readonly sessionRuntimeReset = inject(SessionRuntimeResetRegistry);
  private readonly destroyRef = inject(DestroyRef);
  private readonly syncResultController = new TaskRecordSyncResultController({
    currentOwnerUserId: () => this.authService.currentUserId(),
    getSnapshotCreatedAt: snapshotId => this.optimisticState.getSnapshotCreatedAt(snapshotId),
    commitSnapshot: snapshotId => this.optimisticState.commitSnapshot(snapshotId),
    discardSnapshot: snapshotId => this.optimisticState.discardSnapshot(snapshotId),
    syncError: () => this.syncCoordinator.syncError(),
    hasPendingLocalChanges: () => this.syncCoordinator.hasPendingLocalChanges(),
    logger: this.logger,
  });

  /** 更新锁：防止快照和更新之间的竞态条件 */
  private isUpdating = false;
  private recordUpdateTail: Promise<unknown> | null = null;
  private recordUpdateGeneration = 0;

  /** undo/redo 事务锁：prepare 与 commit 之间只允许一个重放事务，连按快捷键直接忽略 */
  private undoRedoTransactionInFlight = false;

  /** 上次更新类型（由 adapter 在调用 core 方法前设置） */
  lastUpdateType: 'content' | 'structure' | 'position' = 'structure';

  constructor() {
    const unregisterRuntimeReset = this.sessionRuntimeReset.register(
      'TaskRecordTrackingService',
      () => { this.recordUpdateGeneration += 1; },
    );
    this.destroyRef.onDestroy(() => {
      this.recordUpdateGeneration += 1;
      unregisterRuntimeReset();
      this.syncResultController.destroy();
    });
  }

  private normalizeProjectConnections(project: Project): Project {
    return normalizeTaskRecordProjectConnections(project, this.logger);
  }

  /** 显示带撤销按钮的 Toast（移动端带按钮，桌面端纯文字提示） */
  showUndoToast(message: string): void {
    const isMobile = this.uiState.isMobile();
    this.toastService.success(
      message,
      undefined,
      isMobile ? {
        duration: 5000,
        action: {
          label: '撤销',
          pendingLabel: '撤销中...',
          onClick: async () => { await this.performUndo(); },
        }
      } : { duration: 3000 }
    );
  }

  /** 执行撤销操作（并发第二次调用被忽略并返回 false，不排队） */
  async performUndo(): Promise<boolean> {
    if (this.undoRedoTransactionInFlight) {
      this.logger.debug('撤销/重做事务进行中，忽略本次撤销请求');
      return false;
    }

    this.undoRedoTransactionInFlight = true;
    try {
      return await this.runPerformUndo();
    } finally {
      this.undoRedoTransactionInFlight = false;
    }
  }

  private async runPerformUndo(): Promise<boolean> {
    const activeProject = this.projectState.activeProject();
    const currentVersion = activeProject?.version;
    const result = this.undoService.prepareUndo(currentVersion);

    if (!result) {
      this.logger.warn('没有可撤销的操作');
      return false;
    }

    if (result === 'version-mismatch') {
      this.toastService.warning('撤销失败', '远程数据已更新过多，无法撤销。');
      if (activeProject) {
        this.undoService.clearOutdatedHistory(activeProject.id, currentVersion ?? 0);
      }
      return false;
    }

    if (typeof result === 'object' && 'type' in result && result.type === 'version-mismatch-forceable') {
      this.toastService.warning(
        '撤销注意',
        `当前内容已被新修改改变 (${result.versionDiff} 个版本)，撤销可能会覆盖最新内容。`
      );
      const action = result.action;
      const applied = await this.applyProjectSnapshotDurably(action.projectId, action.data.before, {
        kind: 'undo',
        previousSnapshot: action.data.after,
      });
      if (!applied) return false;

      this.undoService.commitPreparedUndo(action);
      this.logger.info('撤销操作成功', { projectId: action.projectId, type: action.type });
      return true;
    }

    const action = result;
    const applied = await this.applyProjectSnapshotDurably(action.projectId, action.data.before, {
      kind: 'undo',
      previousSnapshot: action.data.after,
    });
    if (!applied) return false;

    this.undoService.commitPreparedUndo(action);
    this.logger.info('撤销操作成功', { projectId: action.projectId, type: action.type });
    return true;
  }

  /** 执行重做操作（并发第二次调用被忽略并返回 false，不排队） */
  async performRedo(): Promise<boolean> {
    if (this.undoRedoTransactionInFlight) {
      this.logger.debug('撤销/重做事务进行中，忽略本次重做请求');
      return false;
    }

    this.undoRedoTransactionInFlight = true;
    try {
      return await this.runPerformRedo();
    } finally {
      this.undoRedoTransactionInFlight = false;
    }
  }

  private async runPerformRedo(): Promise<boolean> {
    const activeProject = this.projectState.activeProject();
    const currentVersion = activeProject?.version;
    const result = this.undoService.prepareRedo(currentVersion);

    if (!result) {
      this.logger.debug('没有可重做的操作');
      return false;
    }

    if (result === 'version-mismatch') {
      this.toastService.warning('重做失败', '远程数据已更新，无法重做');
      return false;
    }

    if (typeof result === 'object' && 'type' in result && result.type === 'version-mismatch-forceable') {
      this.toastService.warning('重做失败', '远程数据已更新，无法重做');
      return false;
    }

    const action = result;
    const applied = await this.applyProjectSnapshotDurably(action.projectId, action.data.after, {
      kind: 'redo',
      previousSnapshot: action.data.before,
    });
    if (!applied) return false;

    this.undoService.commitPreparedRedo(action);
    this.logger.info('重做操作成功', { projectId: action.projectId, type: action.type });
    return true;
  }

  private async applyProjectSnapshotDurably(
    projectId: string,
    snapshot: Partial<Project>,
    replay: { kind: 'undo' | 'redo'; previousSnapshot?: Partial<Project> },
  ): Promise<boolean> {
    const saved = await this.recordAndUpdateDurably(project => {
      if (project.id !== projectId) return project;
      return this.layoutService.rebalance(this.normalizeProjectConnections({
        ...project,
        tasks: snapshot.tasks ?? project.tasks,
        connections: snapshot.connections ?? project.connections,
      }));
    }, { updateType: 'structure', recordUndo: false });

    if (!saved) return false;

    this.undoService.notifyReplayApplied(replay.kind, projectId, snapshot, replay.previousSnapshot);
    return true;
  }

  /**
   * 记录操作并更新项目（立即记录撤销历史）
   * 竞态条件保护：通过 isUpdating 锁确保快照和更新的原子性
   */
  recordAndUpdate(mutator: (project: Project) => Project): Promise<boolean> {
    this.lastUpdateType = 'structure';
    return this.enqueueRecordUpdate(mutator, { updateType: 'structure' });
  }

  /**
   * 记录操作并更新项目（防抖记录撤销历史）
   * 竞态条件保护：与 recordAndUpdate 相同的锁机制
   */
  recordAndUpdateDebounced(mutator: (project: Project) => Project): Promise<boolean> {
    this.lastUpdateType = 'content';
    return this.enqueueRecordUpdate(mutator, { updateType: 'content', debouncedUndo: true });
  }

  private enqueueRecordUpdate(
    mutator: (project: Project) => Project,
    options: RecordAndUpdateDurablyOptions,
    explicitProjectId?: string,
  ): Promise<boolean> {
    const project = explicitProjectId
      ? this.projectState.getProjectWithCurrentData(explicitProjectId)
      : this.projectState.activeProject();
    if (!project) return Promise.resolve(false);

    const context: RecordUpdateContext = {
      projectId: project.id,
      uiOwner: this.projectState.captureActiveProjectOwner(),
      requireCurrentUiOwner: explicitProjectId !== undefined,
      ownerUserId: this.resolveRecoverableOutboxOwnerUserId(),
      generation: this.recordUpdateGeneration,
    };
    const ownerUserId = context.ownerUserId ?? AUTH_CONFIG.LOCAL_MODE_USER_ID;
    try {
      this.projectState.assertWriteOwner(ownerUserId);
    } catch (error) {
      this.logger.warn('项目状态 owner 尚未对齐，未提交任务记录更新', { projectId: project.id, error });
      return Promise.resolve(false);
    }
    const run = () => localBackupUiRestoreWriterQuiescence.runAsync(
      ownerUserId,
      'project-state',
      () => this.runRecordAndUpdateDurably(mutator, options, context),
    );
    const currentTail = this.recordUpdateTail;
    const result = currentTail ? currentTail.then(run, run) : run();
    this.recordUpdateTail = result.finally(() => {
      if (this.recordUpdateTail === result) {
        this.recordUpdateTail = null;
      }
    }).catch(() => undefined);
    return result;
  }

  recordAndUpdateDurably(
    mutator: (project: Project) => Project, options: RecordAndUpdateDurablyOptions = {},
  ): Promise<boolean> {
    return this.enqueueRecordUpdate(mutator, options);
  }

  recordAndUpdateProjectDurably(
    projectId: string,
    mutator: (project: Project) => Project,
    options: RecordAndUpdateDurablyOptions = {},
  ): Promise<boolean> {
    return this.enqueueRecordUpdate(mutator, options, projectId);
  }

  private async runRecordAndUpdateDurably(
    mutator: (project: Project) => Project,
    options: RecordAndUpdateDurablyOptions,
    context: RecordUpdateContext,
  ): Promise<boolean> {
    const project = this.beginRecordUpdate(context);
    if (!project) return false;
    try {
      const targetProjectId = project.id;
      const updateType = options.updateType ?? 'structure';
      this.lastUpdateType = updateType;
      const beforeSnapshot = this.undoService.createProjectSnapshot(project);
      const currentVersion = project.version ?? 0;
      const beforeTaskMap = new Map(project.tasks.map(t => [t.id, t] as const));
      const beforeConnectionMap = buildTaskRecordTrackingConnectionMap(project.connections, this.logger);
      const afterProject = this.normalizeProjectConnections(mutator(project));
      const outboxActions = this.collectOutboxActions(
        afterProject, beforeTaskMap, beforeConnectionMap,
        context.ownerUserId,
      );
      const preCommit = await this.prepareDurableCommit({
        afterProject,
        beforeConnectionMap,
        beforeTaskMap,
        outboxActions,
        ownerUserId: context.ownerUserId,
        canPublishUi: () => this.projectState.isActiveProjectOwnerCurrent(context.uiOwner),
        targetProjectId,
      });
      if (!preCommit) return false;
      if (!this.isRecordUpdateContextCurrent(context)) return false;

      this.commitProjectToState(targetProjectId, afterProject, context.ownerUserId);

      await this.finishDurableCommit({
        afterProject,
        beforeConnectionMap,
        beforeSnapshot,
        beforeTaskMap,
        currentVersion,
        options,
        ownerUserId: context.ownerUserId,
        preCommit,
        targetProjectId,
        updateType,
      });
      return !context.requireCurrentUiOwner
        || this.projectState.isActiveProjectOwnerCurrent(context.uiOwner);
    } finally {
      this.isUpdating = false;
    }
  }

  private beginRecordUpdate(context: RecordUpdateContext): Project | null {
    if (!this.isRecordUpdateContextCurrent(context)) return null;
    if (this.isUpdating) {
      this.logger.warn('[TaskRecord] 检测到并发更新，跳过本次操作');
      return null;
    }

    const project = this.projectState.getProjectWithCurrentData(context.projectId) ?? null;
    if (project) this.isUpdating = true;
    return project;
  }

  private commitProjectToState(
    targetProjectId: string,
    afterProject: Project,
    ownerUserId: string | null,
  ): void {
    this.projectState.updateProjects(projects => projects.map(current =>
      current.id === targetProjectId ? afterProject : current
    ), ownerUserId ?? AUTH_CONFIG.LOCAL_MODE_USER_ID);
  }

  private recordDurableUndoAction(
    projectId: string,
    currentVersion: number,
    beforeSnapshot: Partial<Project>,
    afterProject: Project,
    options: RecordAndUpdateDurablyOptions,
  ): void {
    const afterSnapshot = this.undoService.createProjectSnapshot(afterProject);
    if (options.debouncedUndo) {
      this.undoService.recordActionDebounced({
        type: 'task-update',
        projectId,
        projectVersion: currentVersion,
        data: { before: beforeSnapshot, after: afterSnapshot }
      });
      return;
    }

    this.undoService.recordAction({
      type: 'task-update',
      projectId,
      data: { before: beforeSnapshot, after: afterSnapshot }
    }, currentVersion);
  }

  private async prepareDurableCommit(input: {
    afterProject: Project;
    beforeConnectionMap: Map<string, Connection>;
    beforeTaskMap: Map<string, Task>;
    canPublishUi: () => boolean;
    outboxActions: EnqueueParams[];
    ownerUserId: string | null;
    targetProjectId: string;
  }): Promise<{ localOnlySnapshot: true | 'already-persisted' } | false> {
    if (hasMissingRecoverableTaskRecordTrackingOutboxIntent({
      project: input.afterProject,
      beforeTaskMap: input.beforeTaskMap,
      beforeConnectionMap: input.beforeConnectionMap,
      outboxActions: input.outboxActions,
      logger: this.logger,
    })) {
      this.reportMissingRecoverableOutboxIntent(input.targetProjectId, input.canPublishUi);
      return false;
    }

    const persisted = await this.persistOutboxActionsDurably(
      input.targetProjectId,
      input.outboxActions,
      input.canPublishUi,
    );
    if (!persisted) return false;

    const localOnlySnapshot = await this.persistLocalOnlyOfflineSnapshotBeforeCommit(
      input.targetProjectId,
      input.afterProject,
      input.outboxActions,
      input.ownerUserId,
      input.canPublishUi,
    );
    return localOnlySnapshot ? { localOnlySnapshot } : false;
  }

  private async finishDurableCommit(input: {
    afterProject: Project;
    beforeConnectionMap: Map<string, Connection>;
    beforeSnapshot: Partial<Project>;
    beforeTaskMap: Map<string, Task>;
    currentVersion: number;
    options: RecordAndUpdateDurablyOptions;
    ownerUserId: string | null;
    preCommit: { localOnlySnapshot: true | 'already-persisted' };
    targetProjectId: string;
    updateType: NonNullable<RecordAndUpdateDurablyOptions['updateType']>;
  }): Promise<void> {
    if (input.options.recordUndo !== false && !this.undoService.isProcessing) {
      this.recordDurableUndoAction(
        input.targetProjectId,
        input.currentVersion,
        input.beforeSnapshot,
        input.afterProject,
        input.options,
      );
    }

    if (!this.undoService.isProcessing) {
      this.trackChanges(
        input.beforeTaskMap,
        input.beforeConnectionMap,
        input.afterProject,
      );
    }

    this.syncCoordinator.markLocalChanges(input.updateType);
    this.syncCoordinator.schedulePersist();
    if (input.preCommit.localOnlySnapshot !== 'already-persisted') {
      await this.persistImmediateOfflineSnapshot(
        input.targetProjectId,
        input.afterProject,
        input.ownerUserId,
      );
    }
  }

  private async persistImmediateOfflineSnapshot(
    projectId: string,
    afterProject: Project,
    ownerUserId: string | null,
  ): Promise<void> {
    await persistImmediateOfflineSnapshot({
      projectId,
      afterProject,
      currentProjects: this.projectState.getProjectsWithCurrentData(),
      currentUserId: ownerUserId,
      logger: this.logger,
      saveOfflineSnapshotAndWait: (projects, userId) =>
        this.syncCoordinator.saveOfflineSnapshotAndWait(projects, userId),
    });
  }

  private async persistLocalOnlyOfflineSnapshotBeforeCommit(
    projectId: string,
    afterProject: Project,
    outboxActions: EnqueueParams[],
    ownerUserId: string | null,
    canPublishUi: () => boolean,
  ): Promise<true | 'already-persisted' | false> {
    if (afterProject.syncSource !== 'local-only' || outboxActions.length > 0) {
      return true;
    }

    try {
      await this.syncCoordinator.saveOfflineSnapshotAndWait(
        buildImmediateOfflineSnapshotProjects({
          currentProjects: this.projectState.getProjectsWithCurrentData(),
          targetProjectId: projectId,
          afterProject,
        }),
        ownerUserId,
      );
      return 'already-persisted';
    } catch (error) {
      this.logger.warn('本地项目快照持久化失败，取消本次 UI 提交', {
        projectId,
        error,
      });
      if (canPublishUi()) {
        this.toastService.error('本地保存失败', '本地快照未能写入，本次本地变更未提交');
      }
      return false;
    }
  }

  /** 监听持久化结果：远端失败不回滚本地已提交快照，等待后台同步收敛。 */
  setupSyncResultHandler(snapshotId: string): void {
    this.syncResultController.track(snapshotId);
  }

  /** 追踪项目变更，记录到 ChangeTrackerService */
  private trackChanges(
    beforeTaskMap: Map<string, Task>,
    beforeConnectionMap: Map<string, Connection>,
    afterProject: Project,
  ): void {
    const afterTaskIds = new Set<string>();
    this.trackTaskChanges(afterProject, beforeTaskMap, afterProject.tasks, afterTaskIds);
    this.trackDeletedTasks(afterProject, beforeTaskMap, afterTaskIds);
    this.trackConnectionChanges(afterProject, beforeConnectionMap);
  }

  private trackTaskChanges(
    afterProject: Project,
    beforeTaskMap: Map<string, Task>,
    afterTasks: Task[],
    afterTaskIds: Set<string>,
  ): void {
    for (const task of afterTasks) {
      afterTaskIds.add(task.id);
      const beforeTask = beforeTaskMap.get(task.id);

      if (!beforeTask) {
        this.changeTracker.trackTaskCreate(afterProject.id, task);
        continue;
      }

      const changedFields = getTaskRecordChangedFields(beforeTask, task);
      if (changedFields.length === 0) {
        continue;
      }

      this.changeTracker.trackTaskUpdate(afterProject.id, task, changedFields);
    }
  }

  private trackDeletedTasks(
    afterProject: Project,
    beforeTaskMap: Map<string, Task>,
    afterTaskIds: Set<string>,
  ): void {
    for (const [taskId, beforeTask] of beforeTaskMap) {
      if (!afterTaskIds.has(taskId)) {
        this.changeTracker.trackTaskDelete(afterProject.id, taskId, beforeTask);
      }
    }
  }

  private collectOutboxActions(
    afterProject: Project,
    beforeTaskMap: Map<string, Task>,
    beforeConnectionMap: Map<string, Connection>,
    ownerUserId: string | null,
  ): EnqueueParams[] {
    return collectTaskRecordTrackingOutboxActions({
      project: afterProject,
      beforeTaskMap,
      beforeConnectionMap,
      ...this.createOutboxContext(ownerUserId),
    });
  }

  private reportMissingRecoverableOutboxIntent(projectId: string, canPublishUi: () => boolean): void {
    if (canPublishUi()) {
      this.toastService.error(
        '本地保存失败',
        '当前认证或归属信息尚未就绪，无法写入可恢复的离线队列，本次本地变更未提交',
      );
    }
    this.logger.error('云项目变更缺少可恢复的离线队列意图，本地变更未提交', { projectId });
  }

  private trackConnectionChanges(
    afterProject: Project,
    beforeConnectionMap: Map<string, Connection>,
  ): void {
    trackTaskRecordConnectionChanges({
      afterProject,
      beforeConnectionMap,
      changeTracker: this.changeTracker,
      logger: this.logger,
    });
  }

  private createOutboxContext(ownerUserId: string | null): TaskRecordTrackingOutboxContext {
    return {
      sourceUserId: ownerUserId,
      logger: this.logger,
    };
  }

  private isRecordUpdateContextCurrent(context: RecordUpdateContext): boolean {
    return context.generation === this.recordUpdateGeneration
      && context.ownerUserId === this.resolveRecoverableOutboxOwnerUserId();
  }

  private resolveRecoverableOutboxOwnerUserId(): string | null {
    return this.authService.currentUserId() ?? this.authService.peekPersistedOwnerHint();
  }

  private async persistOutboxActionsDurably(
    projectId: string, actions: EnqueueParams[],
    canPublishUi: () => boolean,
  ): Promise<boolean> {
    const ownerUserId = this.resolveOutboxQueueOwnerUserId(actions);
    if (actions.length > 1) {
      try {
        const actionIds = ownerUserId
          ? await this.actionQueue.enqueueManyDurablyForOwner(ownerUserId, actions)
          : await this.actionQueue.enqueueManyDurably(actions);
        if (
          actionIds.length !== actions.length ||
          actionIds.some(actionId => typeof actionId !== 'string' || actionId.length === 0)
        ) {
          this.reportDurableOutboxPreCommitFailure(projectId, actions[0], canPublishUi);
          return false;
        }
        return true;
      } catch (error) {
        this.logger.error('ActionQueue bulk durable enqueue 异常，本地变更未提交', {
          projectId,
          actionCount: actions.length,
          error,
        });
        this.reportDurableOutboxPreCommitFailure(projectId, actions[0], canPublishUi);
        return false;
      }
    }
    for (const action of actions) {
      try {
        const actionId = ownerUserId
          ? await this.actionQueue.enqueueDurablyForOwner(ownerUserId, action)
          : await this.actionQueue.enqueueDurably(action);
        if (!actionId) {
          this.reportDurableOutboxPreCommitFailure(projectId, action, canPublishUi);
          return false;
        }
      } catch (error) {
        this.logger.error('ActionQueue durable enqueue 异常，本地变更未提交', {
          projectId,
          entityType: action.entityType,
          entityId: action.entityId,
          error,
        });
        this.reportDurableOutboxPreCommitFailure(projectId, action, canPublishUi);
        return false;
      }
    }

    return true;
  }

  private resolveOutboxQueueOwnerUserId(actions: EnqueueParams[]): string | null {
    if (this.authService.currentUserId()) {
      return null;
    }

    for (const action of actions) {
      const sourceUserId = (action.payload as { sourceUserId?: string | null }).sourceUserId;
      if (sourceUserId) {
        return sourceUserId;
      }
    }

    return null;
  }

  private reportDurableOutboxPreCommitFailure(
    projectId: string, action: EnqueueParams, canPublishUi: () => boolean,
  ): void {
    if (canPublishUi()) {
      this.toastService.error(
        '本地保存失败',
        '离线同步队列未能写入，本次本地变更未提交，请释放浏览器存储空间后重试',
      );
    }
    this.logger.error('离线同步队列未能持久化，本地变更未提交', {
      projectId,
      entityType: action.entityType,
      entityId: action.entityId,
      operationType: action.type,
    });
  }

  /**
   * 触发服务端删除保护（异步）
   * 如果服务端拒绝，回滚本地状态
   */
  async triggerServerSideDelete(
    projectId: string,
    explicitIds: string[],
    snapshotId: string,
    canPublishUi: () => boolean = () => true,
  ): Promise<void> {
    try {
      const project = this.projectState.getProjectWithCurrentData(projectId);
      if (!project) return;

      const justDeletedTaskIds = collectJustDeletedTaskIds(project.tasks, explicitIds);
      if (justDeletedTaskIds.length === 0) return;

      const tombstoneTimestamps = buildTaskTombstoneTimestamps(project.tasks, justDeletedTaskIds);
      const baseUpdatedAtMap = buildTaskDeleteBaseUpdatedAtMap(
        justDeletedTaskIds,
        (taskId) => this.optimisticState.getTaskFromSnapshot(snapshotId, taskId),
      );
      const operationId = createProjectTaskDeleteBatchOperationId(
        snapshotId,
        projectId,
        justDeletedTaskIds,
        baseUpdatedAtMap,
      );
      const result = await this.syncCoordinator.softDeleteTasksBatch(
        projectId,
        justDeletedTaskIds,
        tombstoneTimestamps,
        baseUpdatedAtMap,
        operationId,
      );

      if (result === -1) {
        this.logger.warn('服务端拒绝批量删除，仅回滚被拒任务（保留其它回收站项）', { projectId, taskIds: justDeletedTaskIds });
        // 【根因修复 2026-05-15】不再调用 rollbackSnapshot 整库回滚 ——
        // 整库回滚会把所有"老的回收站项 / 期间新增的合法编辑"一起拖回快照状态，
        // 表象就是"短时间删除大量任务后回收站全部消失"。
        // 这里改为只把这次被服务端拒绝的任务还原回快照中的状态（deletedAt/stage/parking 等），
        // 其它任务保持现状，回收站中既有的旧条目不受影响。
        this.optimisticState.restoreTasksFromSnapshot(snapshotId, justDeletedTaskIds, {
          showToast: false,
        });
        if (canPublishUi()) {
          this.toastService.warning('删除被服务端阻止', '批量删除超过安全限制，本次涉及的任务已撤回，回收站中其他内容保持不变');
        }
      }
    } catch (e) {
      this.logger.error('服务端删除保护调用失败', e);
    }
  }

}
