import { Injectable, Injector, inject } from '@angular/core';
import {
  FocusConsoleSyncService,
  RetryQueueService,
  TaskSyncOperationsService,
  UserPreferencesSyncService,
} from '../core-bridge';
import { AUTH_CONFIG } from '../config/auth.config';
import {
  FocusSessionRecord,
  RoutineCompletionMutation,
} from '../models/parking-dock';
import type { Project, Task } from '../models';
import {
  buildAuthPendingRetryError,
  buildOperationError,
  buildTaskProcessorRetryError,
  buildTaskSyncRetryError,
  isDeferredQueueError,
  resolveActionSourceUserId,
} from './action-queue-retry-errors';
import {
  resolveDeferredEntityId,
  type TaskRetryItem,
  wasTaskDeleteTransferredToRetryQueue as wasTaskDeleteTransferredToRetryQueuePure,
} from './action-queue-task-focus-processors.helpers';
import { resolveRemoteVersionConflictEvidence } from './action-queue-operation-conflict.helpers';
import { buildActionQueuePayloadSignature } from './action-queue-identity.helpers';
import type { QueueProcessorContext } from './action-queue-processing.types';
import { ActionQueueService, type ActionQueueProcessorResult } from './action-queue.service';
import {
  FocusSessionPayload,
  PreferencePayload,
  QueuedAction,
  RoutineCompletionPayload,
  RoutineTaskPayload,
  TaskDeletePayload,
  TaskPayload,
} from './action-queue.types';
import { AuthService } from './auth.service';
import { ConflictStorageService } from './conflict-storage.service';
import type { OperationConflictActionType } from './conflict-storage.helpers';
import { LoggerService } from './logger.service';
import { ProjectStateService } from './project-state.service';
import { ToastService } from './toast.service';
import { UserSessionService } from './user-session.service';
type FocusSessionActionType = 'focus-session:create' | 'focus-session:update';
type RoutineTaskActionType = 'routine-task:create' | 'routine-task:update';
type RoutineCompletionActionType = 'routine-completion:create' | 'routine-completion:update';

@Injectable({
  providedIn: 'root'
})
export class ActionQueueTaskFocusProcessorsService {
  private readonly loggerService = inject(LoggerService);
  private readonly logger = this.loggerService.category('ActionQueueTaskFocusProcessors');
  private readonly actionQueue = inject(ActionQueueService);
  private readonly taskSyncOps = inject(TaskSyncOperationsService);
  private readonly userPrefsSync = inject(UserPreferencesSyncService);
  private readonly focusConsoleSync = inject(FocusConsoleSyncService);
  private readonly retryQueue = inject(RetryQueueService);
  private readonly projectState = inject(ProjectStateService);
  private readonly authService = inject(AuthService);
  private readonly conflictStorage = inject(ConflictStorageService);
  private readonly toast = inject(ToastService);
  private readonly injector = inject(Injector);
  private legacyQueueWarningShown = false;

  setupProcessors(): void {
    this.setupTaskProcessors();
    this.setupPreferenceProcessors();
    this.setupFocusConsoleProcessors();
  }

  private deferAuthPending(
    action: QueuedAction,
    actionType: string,
    ...entityIdCandidates: unknown[]
  ): ActionQueueProcessorResult {
    return this.actionQueue.deferRetry(
      buildAuthPendingRetryError(
        actionType,
        resolveDeferredEntityId(action, ...entityIdCandidates),
      ),
    );
  }

  private logProcessorFailure(actionType: string, error: unknown, context?: Record<string, unknown>): void {
    if (isDeferredQueueError(error)) {
      this.logger.debug(`${actionType} 延后重试（浏览器恢复中）`, { error, ...context });
      return;
    }

    this.logger.error(`${actionType} 异常`, { error, ...context });
  }

  private markRemoteActionSuccess(actionId: string): true {
    this.actionQueue.markActionSyncedRemotely(actionId);
    return true;
  }

  private resolveQueueOwnerUserId(sourceUserId?: string | null): string {
    return resolveActionSourceUserId(sourceUserId, this.authService.currentUserId())
      ?? AUTH_CONFIG.LOCAL_MODE_USER_ID;
  }

  private getTaskRetryItem(taskId: string, sourceUserId?: string | null): TaskRetryItem | undefined {
    return this.retryQueue.findItemForOwner(
      'task',
      taskId,
      this.resolveQueueOwnerUserId(sourceUserId),
    ) as TaskRetryItem | undefined;
  }

  private wasTaskDeleteTransferredToRetryQueue(payload: TaskDeletePayload, operationId?: string): boolean {
    return wasTaskDeleteTransferredToRetryQueuePure(
      this.getTaskRetryItem(payload.taskId, payload.sourceUserId),
      payload,
      operationId,
    );
  }

  private hasConflictingOwnerHints(
    action: QueuedAction,
    actionType: string,
    ...candidates: Array<string | null | undefined>
  ): boolean {
    const ownerHints = [...new Set(candidates.filter((candidate): candidate is string =>
      typeof candidate === 'string' && candidate.length > 0
    ))];
    if (ownerHints.length <= 1) {
      return false;
    }

    this.quarantineLegacyQueueAction(
      action,
      `${actionType} 队列 owner 元数据冲突 (${ownerHints.join(' vs ')})，已转入失败记录`
    );
    return true;
  }

  private shouldStopUserScopedQueueAction(
    action: QueuedAction,
    currentUserId: string,
    actionType: string,
    sourceUserId: string | null,
  ): boolean {
    if (currentUserId === AUTH_CONFIG.LOCAL_MODE_USER_ID) {
      this.logger.warn(`${actionType} 跳过：本地模式不进入云端队列`);
      return true;
    }

    if (sourceUserId === AUTH_CONFIG.LOCAL_MODE_USER_ID) {
      this.quarantineLegacyQueueAction(
        action,
        `${actionType} legacy local-user 队列项禁止自动上云，请人工确认后重试`
      );
      return true;
    }

    if (!sourceUserId) {
      this.quarantineLegacyQueueAction(
        action,
        `${actionType} legacy 队列项缺少来源元数据，无法安全判断归属，已转入失败记录`
      );
      return true;
    }

    if (sourceUserId !== currentUserId) {
      this.quarantineLegacyQueueAction(
        action,
        `${actionType} 队列来源用户 ${sourceUserId} 与当前账号 ${currentUserId} 不匹配，已转入失败记录`
      );
      return true;
    }

    return false;
  }

  private setupTaskProcessors(): void {
    this.actionQueue.registerProcessor('task:create', async (action, context) => {
      return this.processTaskUpsert(action, 'task:create', context);
    });

    this.actionQueue.registerProcessor('task:update', async (action, context) => {
      return this.processTaskUpsert(action, 'task:update', context);
    });

    this.actionQueue.registerProcessor('task:delete', async (action) => {
      return this.processTaskDelete(action);
    });
  }

  private async processTaskUpsert(
    action: QueuedAction,
    actionType: 'task:create' | 'task:update',
    context?: QueueProcessorContext,
  ): Promise<ActionQueueProcessorResult> {
    const payload = action.payload as TaskPayload;
    const userId = this.authService.currentUserId();
    if (!userId) {
      this.logger.warn(`${actionType} 延后：用户认证状态尚未就绪`);
      return this.actionQueue.deferRetry(buildAuthPendingRetryError(actionType, payload.task.id));
    }

    const leaseSignal = context?.leaseSignal;
    if ((!leaseSignal || leaseSignal.aborted) && typeof payload.sourceUserId === 'string') return this.deferTaskReplay(actionType, payload);
    const mutationType = actionType === 'task:create' ? 'create' : 'update';
    if (this.shouldStopTaskMutation(action, userId, payload, mutationType)) return true;
    if (!leaseSignal || leaseSignal.aborted) return this.deferTaskReplay(actionType, payload);
    const isFenceCurrent = this.createTaskReplayFence(action, payload, userId, context!);
    if (!isFenceCurrent()) return this.deferTaskReplay(actionType, payload);
    try {
      return await this.flushTaskUpsert(action, payload, actionType, leaseSignal, isFenceCurrent);
    } catch (error) {
      if (!isFenceCurrent()) return this.deferTaskReplay(actionType, payload);
      this.logProcessorFailure(actionType, error, { taskId: payload.task.id, projectId: payload.projectId });
      throw error;
    }
  }

  private async flushTaskUpsert(
    action: QueuedAction,
    payload: TaskPayload,
    actionType: 'task:create' | 'task:update',
    leaseSignal: AbortSignal,
    isFenceCurrent: () => boolean,
  ): Promise<ActionQueueProcessorResult> {
    const result = await this.taskSyncOps.pushTaskFromActionQueue({
      actionId: action.id,
      actionOperationId: action.operationId ?? '',
      task: payload.task,
      projectId: payload.projectId,
      sourceUserId: payload.sourceUserId ?? '',
      writeIntent: payload.writeIntent,
      leaseSignal,
      isFenceCurrent,
    });
    if (!isFenceCurrent()) return this.deferTaskReplay(actionType, payload);
    if (result.outcome === 'applied') {
      return this.markRemoteActionSuccess(action.id);
    }
    if (result.outcome === 'handoff') return true;
    if (result.outcome === 'conflict'
      && await this.persistTaskOperationConflict(action, payload, actionType, result.error)
      && isFenceCurrent()) {
      this.actionQueue.markActionResolvedWithoutRemote(action.id);
      this.toast.warning('检测到任务同步冲突', '本地任务修改已转入冲突中心等待处理');
      return true;
    }
    return this.deferTaskReplay(actionType, payload);
  }

  private deferTaskReplay(
    actionType: 'task:create' | 'task:update',
    payload: TaskPayload,
  ): ActionQueueProcessorResult {
    return this.actionQueue.deferRetry(
      buildTaskSyncRetryError(actionType, payload.task.id, payload.projectId),
    );
  }

  private createTaskReplayFence(
    action: QueuedAction,
    payload: TaskPayload,
    ownerUserId: string,
    context: QueueProcessorContext,
  ): () => boolean {
    const { id: actionId, operationId, type: queuedActionType } = action;
    const payloadSignature = buildActionQueuePayloadSignature(action.payload);
    const queueGeneration = this.actionQueue.getCurrentQueueViewGeneration();
    const projectGeneration = this.actionQueue.getProjectMutationViewGeneration(
      payload.projectId,
      ownerUserId,
    );
    const userSession = this.injector.get(UserSessionService, null);
    const sessionGeneration = userSession?.getCurrentSessionGeneration() ?? -1;
    const authFence = this.authService.captureAuthIdentityFence();
    let stale = false;
    return () => {
      stale ||= context.leaseSignal?.aborted !== false
        || context.isCurrent?.() !== true
        || action.id !== actionId
        || typeof actionId !== 'string'
        || actionId.length === 0
        || action.operationId !== operationId
        || typeof operationId !== 'string'
        || operationId.length === 0
        || action.type !== queuedActionType
        || action.entityType !== 'task'
        || action.entityId !== payload.task.id
        || payload.sourceUserId !== ownerUserId
        || payloadSignature !== buildActionQueuePayloadSignature(action.payload)
        || this.authService.currentUserId() !== ownerUserId
        || this.authService.captureAuthIdentityFence() !== authFence
        || userSession?.isSessionContextCurrent(sessionGeneration, ownerUserId) !== true
        || !this.actionQueue.isQueueViewCurrent(queueGeneration, ownerUserId)
        || this.actionQueue.getProjectMutationViewGeneration(payload.projectId, ownerUserId)
          !== projectGeneration;
      return !stale;
    };
  }

  private async persistTaskOperationConflict(
    action: QueuedAction,
    payload: TaskPayload,
    actionType: 'task:create' | 'task:update',
    error: unknown,
  ): Promise<boolean> {
    const evidence = resolveRemoteVersionConflictEvidence(error, [
      'TASK_REMOTE_NEWER',
      'TASK_REMOTE_TOMBSTONE_NEWER',
    ]);
    if (!evidence) {
      return false;
    }

    const conflictedAt = new Date().toISOString();
    const localProject = this.buildTaskConflictProject(payload);
    const saved = await this.conflictStorage.saveConflict({
      projectId: payload.projectId,
      ownerUserId: payload.sourceUserId ?? this.authService.currentUserId() ?? AUTH_CONFIG.LOCAL_MODE_USER_ID,
      localProject,
      conflictedAt,
      localVersion: localProject.version ?? 0,
      reason: 'version_mismatch',
      acknowledged: false,
      operationConflicts: [{
        actionId: action.id,
        actionType: actionType as OperationConflictActionType,
        entityType: 'task',
        entityId: payload.task.id,
        projectId: payload.projectId,
        operationId: action.operationId,
        localEntity: payload.task,
        remoteEntity: evidence.remoteEntity,
        code: evidence.code,
        message: evidence.message,
        details: evidence.details,
        conflictedAt,
        reason: evidence.reason,
      }],
    }).catch((saveError) => {
      this.logger.error(`${actionType} 冲突证据保存失败，保留 ActionQueue 项等待恢复`, {
        error: saveError,
        taskId: payload.task.id,
        projectId: payload.projectId,
      });
      return false;
    });

    return saved;
  }

  private buildTaskConflictProject(payload: TaskPayload): Project {
    const currentProject = this.projectState.getProjectWithCurrentData(payload.projectId);
    if (currentProject) {
      return {
        ...currentProject,
        tasks: this.upsertTaskConflictSnapshot(currentProject.tasks ?? [], payload.task),
        connections: currentProject.connections ?? [],
      };
    }

    const now = new Date().toISOString();
    return {
      id: payload.projectId,
      name: '',
      description: '',
      createdDate: payload.task.createdDate ?? now,
      updatedAt: payload.task.updatedAt ?? now,
      version: 0,
      tasks: [payload.task],
      connections: [],
    };
  }

  private upsertTaskConflictSnapshot(tasks: Task[], localTask: Task): Task[] {
    const existingIndex = tasks.findIndex(task => task.id === localTask.id);
    if (existingIndex < 0) {
      return [...tasks, localTask];
    }

    return tasks.map(task => task.id === localTask.id ? localTask : task);
  }

  private async processTaskDelete(action: QueuedAction): Promise<ActionQueueProcessorResult> {
    const payload = action.payload as TaskDeletePayload;
    const userId = this.authService.currentUserId();
    if (!userId) {
      this.logger.warn('task:delete 延后：用户认证状态尚未就绪');
      return this.actionQueue.deferRetry(buildAuthPendingRetryError('task:delete', payload.taskId));
    }
    if (this.shouldStopTaskDelete(action, userId, payload)) {
      return true;
    }

    try {
      const success = await this.taskSyncOps.deleteTask(
        payload.taskId,
        payload.projectId,
        payload.sourceUserId,
        false,
        payload.baseUpdatedAt,
        action.operationId,
      );
      if (success) {
        return this.markRemoteActionSuccess(action.id);
      }
      if (this.wasTaskDeleteTransferredToRetryQueue(payload, action.operationId)) {
        this.logger.info('task:delete 已转交 RetryQueue，当前 ActionQueue 项视为完成', {
          taskId: payload.taskId,
          projectId: payload.projectId,
        });
        return true;
      }
      return this.actionQueue.failRetry(
        buildTaskSyncRetryError('task:delete', payload.taskId, payload.projectId),
      );
    } catch (error) {
      this.logProcessorFailure('task:delete', error, { taskId: payload.taskId, projectId: payload.projectId });
      return this.actionQueue.failRetry(
        buildTaskProcessorRetryError(error, 'task:delete', payload.taskId, payload.projectId),
      );
    }
  }

  private shouldStopTaskMutation(
    action: QueuedAction,
    userId: string,
    payload: TaskPayload,
    actionType: 'create' | 'update'
  ): boolean {
    if (userId === AUTH_CONFIG.LOCAL_MODE_USER_ID) {
      this.logger.warn(`task:${actionType} 跳过：本地模式不进入云端队列`, {
        taskId: payload.task.id,
        projectId: payload.projectId,
      });
      return true;
    }

    if (payload.sourceUserId === AUTH_CONFIG.LOCAL_MODE_USER_ID) {
      this.quarantineLegacyQueueAction(
        action,
        `task:${actionType} legacy local-user 队列项禁止自动上云，请人工确认后重试`
      );
      return true;
    }

    if (payload.sourceUserId && payload.sourceUserId !== userId) {
      this.quarantineLegacyQueueAction(
        action,
        `task:${actionType} 队列来源用户 ${payload.sourceUserId} 与当前账号 ${userId} 不匹配，已转入失败记录`
      );
      return true;
    }

    const currentProject = this.projectState.getProject(payload.projectId);
    if (currentProject?.syncSource === 'local-only') {
      this.logger.warn(`task:${actionType} 跳过：local-only 项目不进入云端队列`, {
        taskId: payload.task.id,
        projectId: payload.projectId,
      });
      return true;
    }

    if (typeof payload.sourceUserId !== 'string') {
      this.quarantineLegacyQueueAction(
        action,
        `task:${actionType} legacy 队列项缺少来源元数据，无法安全判断归属，已转入失败记录`
      );
      return true;
    }

    return this.shouldQuarantineMissingTaskWriteIntent(action, actionType, payload);
  }

  private shouldQuarantineMissingTaskWriteIntent(
    action: QueuedAction,
    actionType: 'create' | 'update',
    payload: TaskPayload,
  ): boolean {
    if (actionType !== 'update' || payload.writeIntent) return false;
    this.quarantineLegacyQueueAction(
      action,
      'task:update legacy 队列项缺少 writeIntent，禁止猜测为 full upsert，已转入失败记录',
    );
    return true;
  }

  private shouldStopTaskDelete(action: QueuedAction, userId: string, payload: TaskDeletePayload): boolean {
    if (userId === AUTH_CONFIG.LOCAL_MODE_USER_ID) {
      this.logger.warn('task:delete 跳过：本地模式不进入云端队列', {
        taskId: payload.taskId,
        projectId: payload.projectId,
      });
      return true;
    }

    if (payload.sourceUserId === AUTH_CONFIG.LOCAL_MODE_USER_ID) {
      this.quarantineLegacyQueueAction(
        action,
        'task:delete legacy local-user 队列项禁止自动上云，请人工确认后重试'
      );
      return true;
    }

    if (payload.sourceUserId && payload.sourceUserId !== userId) {
      this.quarantineLegacyQueueAction(
        action,
        `task:delete 队列来源用户 ${payload.sourceUserId} 与当前账号 ${userId} 不匹配，已转入失败记录`
      );
      return true;
    }

    const currentProject = this.projectState.getProject(payload.projectId);
    if (currentProject?.syncSource === 'local-only') {
      this.logger.warn('task:delete 跳过：local-only 项目不进入云端队列', {
        taskId: payload.taskId,
        projectId: payload.projectId,
      });
      return true;
    }

    if (typeof payload.sourceUserId !== 'string') {
      this.quarantineLegacyQueueAction(
        action,
        'task:delete legacy 队列项缺少来源元数据，无法安全判断归属，已转入失败记录'
      );
      return true;
    }

    return false;
  }

  private setupPreferenceProcessors(): void {
    this.actionQueue.registerProcessor('preference:update', async (action, context?: QueueProcessorContext) => {
      const leaseSignal = context?.leaseSignal;
      const isCurrent = context?.isCurrent;
      if (!leaseSignal || leaseSignal.aborted || !isCurrent?.()) return false;
      const payload = action.payload as PreferencePayload;
      const userId = this.authService.currentUserId();
      if (!userId) {
        this.logger.warn('preference:update 延后：用户认证状态尚未就绪');
        return this.deferAuthPending(action, 'preference:update', payload.sourceUserId, payload.userId);
      }
      if (userId === AUTH_CONFIG.LOCAL_MODE_USER_ID) {
        this.logger.warn('preference:update 跳过：本地模式不进入云端队列');
        return true;
      }

      if (this.hasConflictingOwnerHints(action, 'preference:update', payload.sourceUserId, payload.userId)) {
        return true;
      }

      const sourceUserId = resolveActionSourceUserId(payload.sourceUserId, payload.userId);
      if (this.shouldStopUserScopedQueueAction(action, userId, 'preference:update', sourceUserId)) {
        return true;
      }
      if (!sourceUserId) {
        return false;
      }
      try {
        const success = await this.userPrefsSync.saveUserPreferences(
          sourceUserId,
          payload.preferences,
          action.operationId,
          payload.baseUpdatedAt,
          context,
        );
        if (!isCurrent()) return false;
        if (success && isCurrent()) {
          this.actionQueue.markActionSyncedRemotely(action.id);
        }
        return success;
      } catch (error) {
        if (!isCurrent()) return false;
        this.logger.error('preference:update 异常', { error });
        return false;
      }
    });
  }

  private quarantineLegacyQueueAction(action: QueuedAction, reason: string): void {
    this.logger.warn('检测到需人工确认的离线队列项，已转入失败记录', {
      actionId: action.id,
      entityType: action.entityType,
      entityId: action.entityId,
      reason,
    });
    this.actionQueue.moveToDeadLetter(action, reason);
    if (!this.legacyQueueWarningShown) {
      this.legacyQueueWarningShown = true;
      this.toast.warning('检测到待确认的离线变更', '旧版或跨账号的队列项已转入失败记录，请确认后再重试');
    }
  }

  private setupFocusConsoleProcessors(): void {
    this.actionQueue.registerProcessor('focus-session:create', (action, context) =>
      this.processFocusSessionMutation(action, 'focus-session:create', context)
    );
    this.actionQueue.registerProcessor('focus-session:update', (action, context) =>
      this.processFocusSessionMutation(action, 'focus-session:update', context)
    );
    this.actionQueue.registerProcessor('routine-task:create', (action, context) =>
      this.processRoutineTaskMutation(action, 'routine-task:create', context)
    );
    this.actionQueue.registerProcessor('routine-task:update', (action, context) =>
      this.processRoutineTaskMutation(action, 'routine-task:update', context)
    );
    this.actionQueue.registerProcessor('routine-completion:create', (action, context) =>
      this.processRoutineCompletionMutation(action, 'routine-completion:create', context)
    );
    this.actionQueue.registerProcessor('routine-completion:update', (action, context) =>
      this.processRoutineCompletionMutation(action, 'routine-completion:update', context)
    );
  }

  private async processFocusSessionMutation(
    action: QueuedAction,
    actionType: FocusSessionActionType,
    context?: QueueProcessorContext,
  ): Promise<ActionQueueProcessorResult> {
    if (!this.isFocusConsoleReplayCurrent(action, context)) return false;
    const payload = action.payload as FocusSessionPayload;
    const userId = this.authService.currentUserId();
    if (!userId) {
      this.logger.warn(`${actionType} 延后：用户认证状态尚未就绪`);
      const record = payload.record as (FocusSessionRecord & { sessionId?: unknown }) | undefined;
      return this.deferAuthPending(action, actionType, record?.id, record?.sessionId, payload.sourceUserId);
    }

    if (!payload.record) {
      this.logger.warn(`${actionType} 失败：缺少 record`);
      return false;
    }

    const sourceUserId = resolveActionSourceUserId(payload.sourceUserId, payload.record.userId);
    if (this.shouldStopFocusConsoleAction(action, userId, actionType, sourceUserId, payload.record.userId)) {
      return true;
    }
    if (!sourceUserId) {
      return false;
    }

    try {
      const record: FocusSessionRecord = payload.record.userId
        ? payload.record
        : { ...payload.record, userId: sourceUserId };
      const result = context
        ? await this.focusConsoleSync.saveFocusSession(record, action.operationId, context)
        : await this.focusConsoleSync.saveFocusSession(record, action.operationId);
      return this.resolveFocusConsoleResult(action, result, context);
    } catch (error) {
      return this.handleFocusConsoleReplayError(action, context, actionType, error);
    }
  }

  private async processRoutineTaskMutation(
    action: QueuedAction,
    actionType: RoutineTaskActionType,
    context?: QueueProcessorContext,
  ): Promise<ActionQueueProcessorResult> {
    if (!this.isFocusConsoleReplayCurrent(action, context)) return false;
    const payload = action.payload as RoutineTaskPayload;
    const userId = this.authService.currentUserId();
    if (!userId) {
      this.logger.warn(`${actionType} 延后：用户认证状态尚未就绪`);
      const routineTask = payload.routineTask as { id?: unknown; routineId?: unknown } | undefined;
      return this.deferAuthPending(
        action,
        actionType,
        routineTask?.id,
        routineTask?.routineId,
        payload.sourceUserId,
        payload.userId,
      );
    }

    const sourceUserId = resolveActionSourceUserId(payload.sourceUserId, payload.userId);
    if (this.shouldStopFocusConsoleAction(action, userId, actionType, sourceUserId, payload.userId)) {
      return true;
    }
    if (!sourceUserId) {
      return false;
    }

    try {
      const result = context
        ? await this.focusConsoleSync.upsertRoutineTask(sourceUserId, payload.routineTask, action.operationId, context)
        : await this.focusConsoleSync.upsertRoutineTask(sourceUserId, payload.routineTask, action.operationId);
      return this.resolveFocusConsoleResult(action, result, context);
    } catch (error) {
      return this.handleFocusConsoleReplayError(action, context, actionType, error);
    }
  }

  private async processRoutineCompletionMutation(
    action: QueuedAction,
    actionType: RoutineCompletionActionType,
    context?: QueueProcessorContext,
  ): Promise<ActionQueueProcessorResult> {
    if (!this.isFocusConsoleReplayCurrent(action, context)) return false;
    const payload = action.payload as RoutineCompletionPayload;
    const userId = this.authService.currentUserId();
    if (!userId) {
      this.logger.warn(`${actionType} 延后：用户认证状态尚未就绪`);
      const completion = payload.completion as {
        completionId?: unknown;
        id?: unknown;
        routineTaskId?: unknown;
        routineId?: unknown;
      } | undefined;
      return this.deferAuthPending(
        action,
        actionType,
        completion?.completionId,
        completion?.id,
        completion?.routineTaskId,
        completion?.routineId,
        payload.sourceUserId,
      );
    }

    if (!payload.completion) {
      this.logger.warn(`${actionType} 失败：缺少 completion`);
      return false;
    }

    const sourceUserId = resolveActionSourceUserId(payload.sourceUserId, payload.completion.userId);
    if (this.shouldStopFocusConsoleAction(action, userId, actionType, sourceUserId, payload.completion.userId)) {
      return true;
    }
    if (!sourceUserId) {
      return false;
    }

    try {
      const completion: RoutineCompletionMutation = payload.completion.userId
        ? payload.completion
        : { ...payload.completion, userId: sourceUserId };
      const result = context
        ? await this.focusConsoleSync.incrementRoutineCompletion(completion, action.operationId, context)
        : await this.focusConsoleSync.incrementRoutineCompletion(completion, action.operationId);
      return this.resolveFocusConsoleResult(action, result, context);
    } catch (error) {
      return this.handleFocusConsoleReplayError(action, context, actionType, error);
    }
  }

  private shouldStopFocusConsoleAction(
    action: QueuedAction,
    userId: string,
    actionType: string,
    sourceUserId: string | null,
    payloadUserId?: string,
  ): boolean {
    return this.hasConflictingOwnerHints(action, actionType, sourceUserId, payloadUserId)
      || this.shouldStopUserScopedQueueAction(action, userId, actionType, sourceUserId);
  }

  private resolveFocusConsoleResult(
    action: QueuedAction,
    result: { ok: true } | { ok: false; error: { code: string; message: string; details?: Record<string, unknown> } },
    context?: QueueProcessorContext,
  ): ActionQueueProcessorResult {
    if (!this.isFocusConsoleReplayCurrent(action, context)) return false;
    if (!result.ok) {
      throw buildOperationError(result.error);
    }

    return this.markRemoteActionSuccess(action.id);
  }

  private isFocusConsoleReplayCurrent(action: QueuedAction, context?: QueueProcessorContext): boolean {
    const isDurableReplay = typeof action.id === 'string'
      && typeof action.operationId === 'string'
      && typeof action.entityId === 'string'
      && (action.type === 'create' || action.type === 'update')
      && ['focus-session', 'routine-task', 'routine-completion'].includes(action.entityType);
    if (!isDurableReplay && !context) return true;
    return !!context?.leaseSignal
      && !context.leaseSignal.aborted
      && context.isCurrent?.() === true;
  }

  private handleFocusConsoleReplayError(
    action: QueuedAction,
    context: QueueProcessorContext | undefined,
    actionType: string,
    error: unknown,
  ): false {
    if (!this.isFocusConsoleReplayCurrent(action, context)) return false;
    this.logProcessorFailure(actionType, error);
    throw error;
  }
}
