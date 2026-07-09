import { Injectable, inject } from '@angular/core';
import type { Attachment, Task } from '../models';
import { ActionQueueService } from './action-queue.service';
import type {
  AttachmentUploadPayload,
  QueuedAction,
  TaskPayload,
} from './action-queue.types';
import type { ActionQueueProcessorResult } from './action-queue-processor-result.helpers';
import { createDerivedSyncOperationId } from '../utils/sync-operation-id';
import {
  AttachmentUploadOutboxService,
  type PendingAttachmentUploadRecovery,
} from './attachment-upload-outbox.service';
import { AttachmentCleanupOutboxService } from './attachment-cleanup-outbox.service';
import { AttachmentService } from './attachment.service';
import { buildAttachmentStoragePath } from './attachment-storage-path.helpers';
import { LoggerService } from './logger.service';
import { ProjectStateService } from './project-state.service';
import { TombstoneService } from '../core-bridge';

const LOCAL_ATTACHMENT_URL_PREFIX = 'nanoflow-local-attachment://';

@Injectable({ providedIn: 'root' })
export class ActionQueueAttachmentProcessorsService {
  private readonly actionQueue = inject(ActionQueueService);
  private readonly uploadOutbox = inject(AttachmentUploadOutboxService);
  private readonly cleanupOutbox = inject(AttachmentCleanupOutboxService);
  private readonly attachmentService = inject(AttachmentService);
  private readonly logger = inject(LoggerService, { optional: true })
    ?.category('ActionQueueAttachmentProcessors');
  private readonly projectState = inject(ProjectStateService);
  private readonly tombstones = inject(TombstoneService);
  private initialized = false;

  setupProcessors(): void {
    if (this.initialized) return;
    this.actionQueue.registerProcessor('attachment:create', (action) =>
      this.processAttachmentCreate(action as QueuedAction<AttachmentUploadPayload>));
    this.initialized = true;
    void this.reconcilePendingUploads('processor-setup');
  }

  async reconcilePendingUploads(reason = 'manual'): Promise<number> {
    let pendingUploads: Array<{ recovery?: PendingAttachmentUploadRecovery }> = [];
    try {
      pendingUploads = await this.uploadOutbox.listPendingUploads();
    } catch (error) {
      this.logger?.warn('附件上传 Outbox 恢复扫描失败，保留本地 Blob 等待下次恢复', {
        reason,
        error,
      });
      return 0;
    }

    let recoveredCount = 0;
    for (const pendingUpload of pendingUploads) {
      const recovery = pendingUpload.recovery;
      if (!this.isValidRecoveryMetadata(recovery)) {
        continue;
      }

      try {
        const actionId = await this.actionQueue.enqueueDurably({
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

  private async processAttachmentCreate(
    action: QueuedAction<AttachmentUploadPayload>,
  ): Promise<ActionQueueProcessorResult> {
    const payload = action.payload;
    const task = this.projectState.getTask(payload.taskId);
    if (!task) {
      return await this.handleMissingTaskForAttachmentCreate(action.operationId, payload);
    }

    const currentAttachment = (task.attachments ?? [])
      .find(attachment => attachment.id === payload.attachment.id);
    if (!currentAttachment) {
      const pendingUpload = await this.uploadOutbox.readPendingUpload(payload.blobKey);
      if (pendingUpload) {
        return this.deferTaskMetadataPending(action.operationId, payload);
      }
      await this.uploadOutbox.removePendingUpload(payload.blobKey);
      return true;
    }

    if (this.isDeletedLocalAttachment(currentAttachment)) {
      await this.uploadOutbox.removePendingUpload(payload.blobKey);
      return true;
    }

    if (this.isUploadedAttachment(currentAttachment)) {
      return await this.finalizeAlreadyUploadedAttachment(action.operationId, task, payload);
    }

    const pendingUpload = await this.uploadOutbox.readPendingUpload(payload.blobKey);
    if (!pendingUpload) {
      return false;
    }

    const uploadedAttachment = await this.attachmentService.uploadQueuedAttachment(
      payload,
      pendingUpload.blob,
    );
    const updatedTask = this.replaceTaskAttachment(task, payload.attachment.id, uploadedAttachment);
    this.projectState.updateTask(updatedTask, payload.projectId);
    const taskUpdateQueued = await this.enqueueFollowUpTaskUpdate(
      action.operationId,
      updatedTask,
      payload,
    );
    if (!taskUpdateQueued) {
      return this.deferFollowUpTaskUpdate(action.operationId, payload);
    }
    await this.uploadOutbox.removePendingUpload(payload.blobKey);
    return taskUpdateQueued;
  }

  private async finalizeAlreadyUploadedAttachment(
    operationId: string,
    task: Task,
    payload: AttachmentUploadPayload,
  ): Promise<ActionQueueProcessorResult> {
    const taskUpdateQueued = await this.enqueueFollowUpTaskUpdate(operationId, task, payload);
    if (!taskUpdateQueued) {
      return this.deferFollowUpTaskUpdate(operationId, payload);
    }
    await this.uploadOutbox.removePendingUpload(payload.blobKey);
    return taskUpdateQueued;
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

  /**
   * 任务在本地 store 缺失时的分流：
   * 本地 tombstone 是"任务已删除"与"备份恢复元数据未就绪"的判别信号——
   * 已删除任务的附件上传永远无法收敛，必须回收而不是无限 defer。
   */
  private async handleMissingTaskForAttachmentCreate(
    operationId: string,
    payload: AttachmentUploadPayload,
  ): Promise<ActionQueueProcessorResult> {
    if (this.tombstones.getLocalTombstoneTimestamp(payload.projectId, payload.taskId) !== undefined) {
      return await this.reclaimUploadForDeletedTask(operationId, payload);
    }
    const pendingUpload = await this.uploadOutbox.readPendingUpload(payload.blobKey);
    if (pendingUpload) {
      return this.deferTaskMetadataPending(operationId, payload);
    }
    return false;
  }

  /**
   * 目标任务已被本地删除（tombstone 证据）时回收 pending 上传：
   * 早前尝试可能已把 Blob 推到远端存储（上传成功后 follow-up 失败被 defer），
   * 因此先入队远端清理回收潜在孤儿对象，再删除本地 Blob 记录并完成该动作。
   * 清理入队失败时保留 Blob 返回 false（消耗预算走 dead-letter，证据可导出）。
   */
  private async reclaimUploadForDeletedTask(
    operationId: string,
    payload: AttachmentUploadPayload,
  ): Promise<boolean> {
    const storagePath = buildAttachmentStoragePath({
      userId: payload.userId,
      projectId: payload.projectId,
      taskId: payload.taskId,
      attachmentId: payload.attachment.id,
      fileName: payload.fileName,
    });
    try {
      await this.cleanupOutbox.enqueuePaths([storagePath]);
    } catch (error) {
      this.logger?.warn('附件目标任务已删除，远端清理入队失败，保留 pending Blob 等待重试', {
        operationId,
        attachmentId: payload.attachment.id,
        blobKey: payload.blobKey,
        taskId: payload.taskId,
        storagePath,
        error,
      });
      return false;
    }
    await this.uploadOutbox.removePendingUpload(payload.blobKey);
    this.logger?.info('附件目标任务已删除，已回收 pending 上传并入队远端清理', {
      operationId,
      attachmentId: payload.attachment.id,
      blobKey: payload.blobKey,
      taskId: payload.taskId,
      storagePath,
    });
    return true;
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

  private buildFollowUpTaskUpdateOperationId(operationId: string): string {
    return createDerivedSyncOperationId(operationId, 'attachment-task-update');
  }

  private async enqueueFollowUpTaskUpdate(
    operationId: string,
    task: Task,
    payload: AttachmentUploadPayload,
  ): Promise<boolean> {
    try {
      const taskUpdateActionId = await this.actionQueue.enqueueDurably({
        operationId: this.buildFollowUpTaskUpdateOperationId(operationId),
        type: 'update',
        entityType: 'task',
        entityId: task.id,
        payload: {
          task,
          projectId: payload.projectId,
          sourceUserId: payload.sourceUserId,
        } satisfies TaskPayload,
        priority: 'normal',
      });
      return Boolean(taskUpdateActionId);
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

  private isValidRecoveryMetadata(
    recovery: PendingAttachmentUploadRecovery | undefined,
  ): recovery is PendingAttachmentUploadRecovery {
    return Boolean(
      recovery?.operationId &&
      recovery.payload?.attachment?.id &&
      recovery.payload.blobKey &&
      recovery.payload.fileName &&
      recovery.payload.projectId &&
      recovery.payload.taskId &&
      recovery.payload.userId,
    );
  }
}
