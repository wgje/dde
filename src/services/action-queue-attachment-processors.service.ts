import { Injectable, Injector, OnDestroy, inject } from '@angular/core';
import { AUTH_CONFIG } from '../config/auth.config';
import type { Attachment, Project, Task } from '../models';
import { ActionQueueService } from './action-queue.service';
import type {
  AttachmentUploadPayload,
  QueuedAction,
  TaskPayload,
} from './action-queue.types';
import type { ActionQueueProcessorResult } from './action-queue-processor-result.helpers';
import type { QueueProcessorContext } from './action-queue-processing.types';
import { createDerivedSyncOperationId } from '../utils/sync-operation-id';
import { buildAttachmentReplayPayloadSignature } from './action-queue-durable-removal.controller';
import {
  AttachmentUploadOutboxService,
  type PendingAttachmentUploadIdentity,
  type PendingAttachmentUploadRecord,
  type PendingAttachmentUploadRecovery,
} from './attachment-upload-outbox.service';
import { AttachmentCleanupOutboxService } from './attachment-cleanup-outbox.service';
import { AttachmentService } from './attachment.service';
import { AuthService } from './auth.service';
import { buildAttachmentStoragePath } from './attachment-storage-path.helpers';
import { LoggerService } from './logger.service';
import { ProjectStateService } from './project-state.service';
import { UserSessionService } from './user-session.service';
import {
  SessionRuntimeResetRegistry,
  type SessionRuntimeResetReason,
} from './session-runtime-reset.service';
import { ProjectDataService, TombstoneService } from '../core-bridge';
import { localBackupUiRestoreWriterQuiescence } from './local-backup-ui-restore-writer-quiescence.service';

const LOCAL_ATTACHMENT_URL_PREFIX = 'nanoflow-local-attachment://';

type AttachmentCreateReplayState = {
  task: Task;
  currentAttachment: Attachment;
  pendingUpload: PendingAttachmentUploadRecord | null;
};
type AttachmentReplayFence = { signal: AbortSignal; isCurrent: () => boolean };
type AttachmentTaskUpdateHandoff = {
  actionId: string;
  operationId: string;
  payload: TaskPayload;
};
@Injectable({ providedIn: 'root' })
export class ActionQueueAttachmentProcessorsService implements OnDestroy {
  private readonly actionQueue = inject(ActionQueueService);
  private readonly uploadOutbox = inject(AttachmentUploadOutboxService);
  private readonly cleanupOutbox = inject(AttachmentCleanupOutboxService);
  private readonly attachmentService = inject(AttachmentService);
  private readonly projectData = inject(ProjectDataService);
  private readonly logger = inject(LoggerService, { optional: true })
    ?.category('ActionQueueAttachmentProcessors');
  private readonly projectState = inject(ProjectStateService);
  private readonly tombstones = inject(TombstoneService);
  private readonly authService = inject(AuthService);
  private readonly injector = inject(Injector);
  private readonly unregisterSessionRuntimeReset = inject(SessionRuntimeResetRegistry).register(
    'ActionQueueAttachmentProcessorsService',
    reason => this.resetSessionRuntime(reason),
  );
  private initialized = false;
  private destroyed = false;
  private reconcileGeneration = 0;

  ngOnDestroy(): void {
    this.destroyed = true;
    this.reconcileGeneration += 1;
    this.unregisterSessionRuntimeReset();
  }

  setupProcessors(): void {
    if (this.initialized) return;
    this.actionQueue.registerProcessor('attachment:create', (action, context) =>
      this.processAttachmentCreate(action as QueuedAction<AttachmentUploadPayload>, context));
    this.initialized = true;
    void this.reconcilePendingUploads('processor-setup');
  }

  async reconcilePendingUploads(reason = 'manual'): Promise<number> {
    if (this.destroyed) return 0;
    const ownerUserId = this.resolveCurrentOwnerUserId();
    const generation = this.reconcileGeneration;
    const pendingUploads = await this.loadPendingUploads(ownerUserId, reason);

    if (!this.isOwnerSessionCurrent(generation, ownerUserId)) {
      return 0;
    }

    let recoveredCount = 0;
    for (const pendingUpload of pendingUploads) {
      if (!this.isOwnerSessionCurrent(generation, ownerUserId)) break;
      const recovery = pendingUpload.recovery;
      if (
        pendingUpload.ownerUserId !== ownerUserId
        || pendingUpload.operationId !== recovery?.operationId
        || !this.isValidRecoveryMetadata(recovery, ownerUserId)
      ) {
        continue;
      }

      try {
        const actionId = await this.actionQueue.enqueueDurablyForOwner(ownerUserId, {
          operationId: recovery.operationId,
          type: 'create',
          entityType: 'attachment',
          entityId: recovery.payload.attachment.id,
          payload: recovery.payload,
          priority: 'normal',
        });
        if (actionId) {
          recoveredCount += 1;
        }
      } catch (error) {
        this.logger?.warn('附件上传 Outbox 恢复补队列失败，保留本地 Blob 等待下次恢复', {
          reason,
          operationId: recovery.operationId,
          attachmentId: recovery.payload.attachment.id,
          blobKey: recovery.payload.blobKey,
          error,
        });
      }
    }

    return recoveredCount;
  }

  private async loadPendingUploads(
    ownerUserId: string,
    reason: string,
  ): Promise<PendingAttachmentUploadRecord[]> {
    try {
      return await this.uploadOutbox.listPendingUploads(ownerUserId);
    } catch (error) {
      this.logger?.warn('附件上传 Outbox 恢复扫描失败，保留本地 Blob 等待下次恢复', {
        reason,
        error,
      });
      return [];
    }
  }

  private resetSessionRuntime(reason: SessionRuntimeResetReason): void {
    const generation = ++this.reconcileGeneration;
    if (reason !== 'owner-change' || !this.initialized || this.destroyed) return;

    queueMicrotask(() => {
      if (!this.isReconcileGenerationCurrent(generation)) return;
      void this.reconcilePendingUploads('owner-transition');
    });
  }

  private async processAttachmentCreate(
    action: QueuedAction<AttachmentUploadPayload>,
    processorContext?: QueueProcessorContext,
  ): Promise<ActionQueueProcessorResult> {
    const payload = action.payload;
    const leaseSignal = processorContext?.leaseSignal;
    if (!leaseSignal || leaseSignal.aborted) return this.deferAttachmentReplayFence(action, payload);
    const ownerUserId = this.resolvePayloadOwnerUserId(payload);
    const fence = this.createAttachmentReplayFence(action, ownerUserId, leaseSignal);
    if (!fence.isCurrent()) return this.deferAttachmentReplayFence(action, payload);
    const uploadIdentity = this.getUploadIdentity(action.operationId, payload);
    const task = this.projectState.getTask(payload.taskId);
    if (!task) {
      return await this.handleMissingTaskForAttachmentCreate(action, payload, fence);
    }

    const replayState = await this.prepareAttachmentCreateReplayState(
      action,
      task,
      uploadIdentity,
      fence,
    );
    if ('result' in replayState) {
      return replayState.result;
    }
    const { currentAttachment, pendingUpload, task: replayTask } = replayState.state;

    if (this.isDeletedLocalAttachment(currentAttachment)) {
      const expected = pendingUpload ?? await this.readPendingUploadForCurrentOwner(uploadIdentity, fence);
      if (!expected) return this.deferAttachmentReplayFence(action, payload);
      return await this.removeBlobAndSettleAttachmentReplay(action, expected, fence);
    }

    if (this.isUploadedAttachment(currentAttachment)) {
      return await this.finalizeUploadedAttachment(
        action,
        payload,
        currentAttachment,
        pendingUpload,
        fence,
      );
    }

    return await this.continuePendingAttachmentCreateUpload({
      action,
      payload,
      replayTask,
      ownerUserId,
      pendingUpload,
      uploadIdentity,
      fence,
    });
  }

  private async continuePendingAttachmentCreateUpload(input: {
    action: QueuedAction<AttachmentUploadPayload>;
    payload: AttachmentUploadPayload;
    replayTask: Task;
    ownerUserId: string;
    pendingUpload: PendingAttachmentUploadRecord | null;
    uploadIdentity: PendingAttachmentUploadIdentity;
    fence: AttachmentReplayFence;
  }): Promise<ActionQueueProcessorResult> {
    const durablePendingUpload = input.pendingUpload
      ?? await this.readPendingUploadForCurrentOwner(
        input.uploadIdentity,
        input.fence,
      );
    if (!durablePendingUpload) return this.deferAttachmentReplayFence(input.action, input.payload);

    let uploadedAttachment: Attachment;
    try {
      uploadedAttachment = await this.attachmentService.uploadQueuedAttachment(
        input.payload,
        durablePendingUpload.blob,
        input.fence,
      );
    } catch (error) {
      if (!input.fence.isCurrent()) return this.deferAttachmentReplayFence(input.action, input.payload);
      throw error;
    }
    if (!input.fence.isCurrent()) return this.deferAttachmentReplayFence(input.action, input.payload);
    return await this.finalizeUploadedAttachment(
      input.action,
      input.payload,
      uploadedAttachment,
      durablePendingUpload,
      input.fence,
    );
  }

  private async prepareAttachmentCreateReplayState(
    action: QueuedAction<AttachmentUploadPayload>,
    task: Task,
    uploadIdentity: PendingAttachmentUploadIdentity,
    fence: AttachmentReplayFence,
  ): Promise<{ state: AttachmentCreateReplayState } | { result: ActionQueueProcessorResult }> {
    const payload = action.payload;
    const currentAttachment = this.findTaskAttachment(task, payload.attachment.id);
    if (currentAttachment) {
      return { state: { task, currentAttachment, pendingUpload: null } };
    }

    const pendingUpload = await this.readPendingUploadForCurrentOwner(uploadIdentity, fence);
    if (pendingUpload === false) {
      return { result: this.deferAttachmentReplayFence(action, payload) };
    }
    if (!pendingUpload) {
      return { result: this.deferTaskMetadataPending(action.operationId, payload) };
    }
    if (!this.uploadOutbox.matchesPendingUploadForReplay(pendingUpload, action.operationId, payload)
      || !payload.attachment.url.startsWith(LOCAL_ATTACHMENT_URL_PREFIX)) {
      return { result: this.deferTaskMetadataPending(action.operationId, payload) };
    }

    const restoredTask = await this.restoreMissingTaskAttachmentMetadata(
      action.operationId,
      task,
      payload,
      fence,
    );
    const restoredAttachment = restoredTask
      ? this.findTaskAttachment(restoredTask, payload.attachment.id)
      : undefined;
    if (!restoredTask || !restoredAttachment) {
      return { result: this.deferTaskMetadataPending(action.operationId, payload) };
    }

    return {
      state: {
        task: restoredTask,
        currentAttachment: restoredAttachment,
        pendingUpload,
      },
    };
  }

  private async finalizeUploadedAttachment(
    action: QueuedAction<AttachmentUploadPayload>,
    payload: AttachmentUploadPayload,
    uploadedAttachment: Attachment,
    pendingUpload: PendingAttachmentUploadRecord | null,
    fence: AttachmentReplayFence,
  ): Promise<ActionQueueProcessorResult> {
    if (!fence.isCurrent()) return this.deferAttachmentReplayFence(action, payload);
    const latestTask = this.projectState.getTask(payload.taskId);
    const latestAttachment = latestTask && this.findTaskAttachment(latestTask, payload.attachment.id);
    if (!latestTask || !latestAttachment) {
      return this.deferAttachmentReplayFence(action, payload);
    }
    if (this.isDeletedLocalAttachment(latestAttachment)) {
      const expected = pendingUpload
        ?? await this.readPendingUploadForCurrentOwner(
          this.getUploadIdentity(action.operationId, payload),
          fence,
        );
      if (!expected || !fence.isCurrent()) return this.deferAttachmentReplayFence(action, payload);
      return await this.reclaimUploadForDeletedTask(action, expected, fence);
    }
    const attachmentMatches = this.isUploadedAttachment(latestAttachment)
      || buildAttachmentReplayPayloadSignature(latestAttachment)
        === buildAttachmentReplayPayloadSignature(payload.attachment);
    if (!attachmentMatches) return this.deferAttachmentReplayFence(action, payload);
    const updatedTask = this.isUploadedAttachment(latestAttachment)
      ? latestTask
      : this.replaceTaskAttachment(latestTask, payload.attachment.id, uploadedAttachment);
    if (!fence.isCurrent()) return this.deferAttachmentReplayFence(action, payload);
    if (updatedTask !== latestTask) this.projectState.updateTask(updatedTask, payload.projectId);
    const handoff = await this.enqueueFollowUpTaskUpdate(
      action.operationId,
      updatedTask,
      payload,
      this.resolvePayloadOwnerUserId(payload),
    );
    if (!fence.isCurrent()) return this.deferAttachmentReplayFence(action, payload);
    if (!handoff) return this.deferFollowUpTaskUpdate(action.operationId, payload);
    const verified = await this.actionQueue.settleAttachmentReplayActionForOwner(
      this.resolvePayloadOwnerUserId(payload),
      {
        mode: 'verify-task-update',
        actionId: handoff.actionId,
        operationId: handoff.operationId,
        entityType: 'task',
        type: 'update',
        entityId: updatedTask.id,
        payload: handoff.payload,
        ...fence,
      },
    );
    if (!fence.isCurrent()) return this.deferAttachmentReplayFence(action, payload);
    if (verified.status !== 'current') return this.deferFollowUpTaskUpdate(action.operationId, payload);
    let expectedPendingUpload = pendingUpload;
    if (!expectedPendingUpload) {
      const readback = await this.uploadOutbox.readPendingUploadStrictly(
        this.getUploadIdentity(action.operationId, payload),
      );
      if (!fence.isCurrent()) return this.deferAttachmentReplayFence(action, payload);
      if (readback.status === 'storage-failed' || readback.status === 'mismatch') {
        return this.deferFollowUpTaskUpdate(action.operationId, payload);
      }
      if (readback.status === 'found') expectedPendingUpload = readback.record;
    }
    if (expectedPendingUpload) {
      if (!this.uploadOutbox.matchesPendingUploadForReplay(expectedPendingUpload, action.operationId, payload)) {
        return this.deferFollowUpTaskUpdate(action.operationId, payload);
      }
      const removed = await this.uploadOutbox.removePendingUploadIfCurrent(expectedPendingUpload, fence);
      if (!fence.isCurrent()) return this.deferAttachmentReplayFence(action, payload);
      if (removed.status !== 'removed') return this.deferFollowUpTaskUpdate(action.operationId, payload);
    }
    return await this.settleExactAttachmentReplay(action, fence);
  }

  private async removeBlobAndSettleAttachmentReplay(
    action: QueuedAction<AttachmentUploadPayload>,
    pendingUpload: PendingAttachmentUploadRecord,
    fence: AttachmentReplayFence,
  ): Promise<ActionQueueProcessorResult> {
    const removed = await this.uploadOutbox.removePendingUploadIfCurrent(pendingUpload, fence);
    if (!fence.isCurrent()) return this.deferAttachmentReplayFence(action, action.payload);
    if (removed.status !== 'removed') return this.deferFollowUpTaskUpdate(action.operationId, action.payload);
    return await this.settleExactAttachmentReplay(action, fence);
  }

  private async settleExactAttachmentReplay(
    action: QueuedAction<AttachmentUploadPayload>,
    fence: AttachmentReplayFence,
  ): Promise<ActionQueueProcessorResult> {
    if (!fence.isCurrent()) return this.deferAttachmentReplayFence(action, action.payload);
    const settled = await this.actionQueue.settleAttachmentReplayActionForOwner(
      this.resolvePayloadOwnerUserId(action.payload),
      {
        mode: 'remove-attachment-create',
        actionId: action.id,
        operationId: action.operationId,
        entityType: 'attachment',
        type: 'create',
        entityId: action.entityId,
        payload: action.payload,
        ...fence,
      },
    );
    if (!fence.isCurrent()) return this.deferAttachmentReplayFence(action, action.payload);
    return settled.status === 'committed'
      ? true
      : this.deferAttachmentReplayFence(action, action.payload);
  }

  private deferFollowUpTaskUpdate(
    operationId: string,
    payload: AttachmentUploadPayload,
  ): ActionQueueProcessorResult {
    return this.actionQueue.deferRetry({
      code: 'SYNC_RETRY_HANDOFF_PENDING',
      message: '附件已本地完成上传，等待补写任务更新入队',
      details: {
        reason: 'partial-retry-handoff',
        operationId,
        followUpOperationId: this.buildFollowUpTaskUpdateOperationId(operationId),
        attachmentId: payload.attachment.id,
        blobKey: payload.blobKey,
        taskId: payload.taskId,
        projectId: payload.projectId,
      },
    });
  }

  private deferAttachmentReplayFence(
    action: QueuedAction<AttachmentUploadPayload>,
    payload: AttachmentUploadPayload,
  ): ActionQueueProcessorResult {
    return this.actionQueue.deferRetry({
      code: 'SYNC_RETRY_HANDOFF_PENDING',
      message: '附件上传等待当前 owner 与队列写入围栏恢复',
      details: {
        reason: 'attachment-replay-fence-stale',
        actionId: action.id,
        operationId: action.operationId,
        attachmentId: payload.attachment.id,
        projectId: payload.projectId,
        taskId: payload.taskId,
      },
    });
  }

  private async handleMissingTaskForAttachmentCreate(
    action: QueuedAction<AttachmentUploadPayload>,
    payload: AttachmentUploadPayload,
    fence: AttachmentReplayFence,
  ): Promise<ActionQueueProcessorResult> {
    const pendingUpload = await this.readPendingUploadForCurrentOwner(
      this.getUploadIdentity(action.operationId, payload),
      fence,
    );
    if (!pendingUpload || !fence.isCurrent()) return this.deferTaskMetadataPending(action.operationId, payload);
    if (this.tombstones.getLocalTombstoneTimestamp(payload.projectId, payload.taskId) === undefined) {
      return this.deferTaskMetadataPending(action.operationId, payload);
    }
    return await this.reclaimUploadForDeletedTask(action, pendingUpload, fence);
  }

  private async reclaimUploadForDeletedTask(
    action: QueuedAction<AttachmentUploadPayload>,
    pendingUpload: PendingAttachmentUploadRecord,
    fence: AttachmentReplayFence,
  ): Promise<ActionQueueProcessorResult> {
    const payload = action.payload;
    const storagePath = buildAttachmentStoragePath({
      userId: payload.userId,
      projectId: payload.projectId,
      taskId: payload.taskId,
      attachmentId: payload.attachment.id,
      fileName: payload.fileName,
    });
    try {
      await this.cleanupOutbox.enqueuePaths([storagePath], {
        ownerUserId: this.resolvePayloadOwnerUserId(payload),
        operationId: action.operationId,
      });
    } catch (error) {
      this.logger?.warn('附件目标任务已删除，远端清理入队失败，保留 pending Blob 等待重试', {
        operationId: action.operationId,
        attachmentId: payload.attachment.id,
        blobKey: payload.blobKey,
        taskId: payload.taskId,
        storagePath,
        error,
      });
      return this.deferTaskMetadataPending(action.operationId, payload);
    }
    if (!fence.isCurrent()) return this.deferAttachmentReplayFence(action, payload);
    this.logger?.info('附件目标任务已删除，已回收 pending 上传并入队远端清理', {
      operationId: action.operationId,
      attachmentId: payload.attachment.id,
      blobKey: payload.blobKey,
      taskId: payload.taskId,
      storagePath,
    });
    return await this.removeBlobAndSettleAttachmentReplay(action, pendingUpload, fence);
  }

  private deferTaskMetadataPending(
    operationId: string,
    payload: AttachmentUploadPayload,
  ): ActionQueueProcessorResult {
    return this.actionQueue.deferRetry({
      code: 'SYNC_RETRY_HANDOFF_PENDING',
      message: '附件上传等待本地任务元数据恢复',
      details: {
        reason: 'attachment-task-metadata-pending',
        operationId,
        attachmentId: payload.attachment.id,
        blobKey: payload.blobKey,
        taskId: payload.taskId,
        projectId: payload.projectId,
      },
    });
  }

  private async restoreMissingTaskAttachmentMetadata(
    operationId: string,
    task: Task,
    payload: AttachmentUploadPayload,
    fence: AttachmentReplayFence,
  ): Promise<Task | null> {
    const ownerUserId = this.resolvePayloadOwnerUserId(payload);
    return localBackupUiRestoreWriterQuiescence.runAsync(
      ownerUserId,
      'project-state',
      () => this.restoreMissingTaskAttachmentMetadataUnderWriter(
        operationId,
        task,
        payload,
        fence,
        ownerUserId,
      ),
    );
  }

  private async restoreMissingTaskAttachmentMetadataUnderWriter(
    operationId: string,
    task: Task,
    payload: AttachmentUploadPayload,
    fence: AttachmentReplayFence,
    ownerUserId: string,
  ): Promise<Task | null> {
    const restoredProjects = this.buildRestoredAttachmentProjects(operationId, task, payload);
    if (!restoredProjects) return null;
    const persisted = await this.persistRestoredAttachmentProjects(
      restoredProjects,
      payload,
      ownerUserId,
    );
    if (!persisted) return null;
    if (!fence.isCurrent()) return null;

    this.projectState.updateProjects(() => restoredProjects, ownerUserId);
    return this.readBackRestoredTaskAttachment(payload);
  }

  private replaceTaskAttachment(task: Task, attachmentId: string, attachment: Attachment): Task {
    const now = new Date().toISOString();
    return {
      ...task,
      updatedAt: now,
      attachments: (task.attachments ?? []).map(item =>
        item.id === attachmentId ? attachment : item,
      ),
    };
  }

  private buildProjectWithRestoredAttachment(
    project: Project,
    task: Task,
    attachment: Attachment,
  ): Project | null {
    let foundTask = false;
    const restoredTask = this.upsertTaskAttachment(task, attachment);
    const tasks = project.tasks.map(currentTask => {
      if (currentTask.id !== task.id) return currentTask;
      foundTask = true;
      return restoredTask;
    });
    if (!foundTask) return null;

    return {
      ...project,
      tasks,
      updatedAt: restoredTask.updatedAt,
    };
  }

  private buildRestoredAttachmentProjects(
    operationId: string,
    task: Task,
    payload: AttachmentUploadPayload,
  ): Project[] | null {
    const currentProject = this.projectState.getProjectWithCurrentData(payload.projectId);
    if (!currentProject) {
      return this.reportMetadataRestoreFailure(
        '附件上传本地元数据恢复失败：目标项目不存在',
        payload,
        { operationId },
      );
    }

    const restoredProject = this.buildProjectWithRestoredAttachment(currentProject, task, payload.attachment);
    if (!restoredProject) {
      return this.reportMetadataRestoreFailure(
        '附件上传本地元数据恢复失败：目标任务不存在',
        payload,
        { operationId },
      );
    }

    return this.projectState.getProjectsWithCurrentData().map(project =>
      project.id === restoredProject.id ? restoredProject : project,
    );
  }

  private buildFollowUpTaskUpdateOperationId(operationId: string): string {
    return createDerivedSyncOperationId(operationId, 'attachment-task-update');
  }

  private async enqueueFollowUpTaskUpdate(
    operationId: string,
    task: Task,
    payload: AttachmentUploadPayload,
    ownerUserId: string,
  ): Promise<AttachmentTaskUpdateHandoff | false | null> {
    const followUpOperationId = this.buildFollowUpTaskUpdateOperationId(operationId);
    const taskPayload = {
      task,
      projectId: payload.projectId,
      sourceUserId: payload.sourceUserId,
      writeIntent: 'task_attachment_update',
    } satisfies TaskPayload;
    try {
      const taskUpdateActionId = await this.actionQueue.enqueueDurablyForOwner(ownerUserId, {
        operationId: followUpOperationId,
        type: 'update',
        entityType: 'task',
        entityId: task.id,
        payload: taskPayload,
        priority: 'normal',
      });
      return taskUpdateActionId
        ? { actionId: taskUpdateActionId, operationId: followUpOperationId, payload: taskPayload }
        : null;
    } catch (error) {
      this.logger?.warn('附件上传 follow-up task:update 入队失败，保留 Blob 等待恢复重试', {
        operationId,
        followUpOperationId: this.buildFollowUpTaskUpdateOperationId(operationId),
        attachmentId: payload.attachment.id,
        blobKey: payload.blobKey,
        taskId: payload.taskId,
        projectId: payload.projectId,
        error,
      });
      return false;
    }
  }

  private isUploadedAttachment(attachment: Attachment): boolean {
    return !attachment.url.startsWith(LOCAL_ATTACHMENT_URL_PREFIX);
  }

  private isDeletedLocalAttachment(attachment: Attachment): boolean {
    return Boolean(attachment.deletedAt) && attachment.url.startsWith(LOCAL_ATTACHMENT_URL_PREFIX);
  }

  private findTaskAttachment(task: Task, attachmentId: string): Attachment | undefined {
    return (task.attachments ?? []).find(attachment => attachment.id === attachmentId);
  }

  private upsertTaskAttachment(task: Task, attachment: Attachment): Task {
    const now = new Date().toISOString();
    const attachments = task.attachments ?? [];
    const existingIndex = attachments.findIndex(currentAttachment => currentAttachment.id === attachment.id);
    return {
      ...task,
      attachments: existingIndex === -1
        ? [...attachments, attachment]
        : attachments.map((currentAttachment, index) => (
            index === existingIndex ? { ...currentAttachment, ...attachment } : currentAttachment
          )),
      updatedAt: now,
    };
  }

  private async readPendingUploadForCurrentOwner(
    uploadIdentity: PendingAttachmentUploadIdentity,
    fence: AttachmentReplayFence,
  ): Promise<PendingAttachmentUploadRecord | null | false> {
    const pendingUpload = await this.uploadOutbox.readPendingUpload(uploadIdentity);
    if (!fence.isCurrent()) return false;
    return pendingUpload;
  }

  private async persistRestoredAttachmentProjects(
    restoredProjects: Project[],
    payload: AttachmentUploadPayload,
    ownerUserId: string,
  ): Promise<boolean> {
    try {
      await this.projectData.saveOfflineSnapshotAndWait(restoredProjects, ownerUserId);
      return true;
    } catch (error) {
      this.reportMetadataRestoreFailure(
        '附件上传本地元数据恢复失败：快照持久化失败，保留 pending Blob 等待重试',
        payload,
        { error },
      );
      return false;
    }
  }

  private readBackRestoredTaskAttachment(payload: AttachmentUploadPayload): Task | null {
    const restoredTask = this.projectState.getTask(payload.taskId);
    if (restoredTask && this.findTaskAttachment(restoredTask, payload.attachment.id)) {
      return restoredTask;
    }
    return this.reportMetadataRestoreFailure(
      '附件上传本地元数据恢复失败：回读校验未命中',
      payload,
    );
  }

  private reportMetadataRestoreFailure(
    message: string,
    payload: AttachmentUploadPayload,
    data: Record<string, unknown> = {},
  ): null {
    this.logger?.warn(message, {
      projectId: payload.projectId,
      taskId: payload.taskId,
      attachmentId: payload.attachment.id,
      blobKey: payload.blobKey,
      ...data,
    });
    return null;
  }

  private getUploadIdentity(
    operationId: string,
    payload: AttachmentUploadPayload,
  ): PendingAttachmentUploadIdentity {
    return {
      ownerUserId: this.resolvePayloadOwnerUserId(payload),
      blobKey: payload.blobKey,
      operationId,
    };
  }

  private resolveCurrentOwnerUserId(): string {
    return this.authService.currentUserId() ?? AUTH_CONFIG.LOCAL_MODE_USER_ID;
  }

  private resolvePayloadOwnerUserId(payload: AttachmentUploadPayload): string {
    return payload.sourceUserId || payload.userId;
  }

  private createAttachmentReplayFence(
    action: QueuedAction<AttachmentUploadPayload>,
    ownerUserId: string,
    signal: AbortSignal,
  ): AttachmentReplayFence {
    const actionId = action.id;
    const operationId = action.operationId;
    const payloadSignature = buildAttachmentReplayPayloadSignature(action.payload);
    const queueGeneration = this.actionQueue.getCurrentQueueViewGeneration();
    const projectGeneration = this.actionQueue.getProjectMutationViewGeneration(
      action.payload.projectId,
      ownerUserId,
    );
    const reconcileGeneration = this.reconcileGeneration;
    const sessionGeneration = this.resolveUserSession()?.getCurrentSessionGeneration() ?? -1;
    const authFence = this.authService.captureAuthIdentityFence();
    return { signal, isCurrent: () => !signal.aborted
      && action.id === actionId
      && action.operationId === operationId
      && action.entityType === 'attachment'
      && action.type === 'create'
      && action.entityId === action.payload.attachment.id
      && payloadSignature === buildAttachmentReplayPayloadSignature(action.payload)
      && this.resolvePayloadOwnerUserId(action.payload) === ownerUserId
      && this.authService.currentUserId() === ownerUserId
      && this.authService.captureAuthIdentityFence() === authFence
      && this.resolveUserSession()?.isSessionContextCurrent(sessionGeneration, ownerUserId) === true
      && this.isReconcileGenerationCurrent(reconcileGeneration)
      && this.actionQueue.isQueueViewCurrent(queueGeneration, ownerUserId)
      && this.actionQueue.getProjectMutationViewGeneration(action.payload.projectId, ownerUserId)
        === projectGeneration };
  }

  private resolveUserSession(): UserSessionService | null {
    return this.injector.get(UserSessionService, null);
  }

  private isOwnerSessionCurrent(generation: number, ownerUserId: string): boolean {
    return this.isReconcileGenerationCurrent(generation)
      && this.resolveCurrentOwnerUserId() === ownerUserId;
  }

  private isReconcileGenerationCurrent(generation: number): boolean {
    return !this.destroyed && generation === this.reconcileGeneration;
  }

  private isValidRecoveryMetadata(
    recovery: PendingAttachmentUploadRecovery | undefined,
    ownerUserId: string,
  ): recovery is PendingAttachmentUploadRecovery {
    return Boolean(
      recovery?.operationId &&
      recovery.payload?.attachment?.id &&
      recovery.payload.blobKey &&
      recovery.payload.fileName &&
      recovery.payload.projectId &&
      recovery.payload.taskId &&
      recovery.payload.userId &&
      this.resolvePayloadOwnerUserId(recovery.payload) === ownerUserId,
    );
  }
}
