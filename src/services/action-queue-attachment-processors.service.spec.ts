import { Injector } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';
import { SCAN_STATUS } from '../config/virus-scan.config';
import type { Attachment, Task } from '../models';
import { createDerivedSyncOperationId } from '../utils/sync-operation-id';
import { ActionQueueAttachmentProcessorsService } from './action-queue-attachment-processors.service';
import { ActionQueueService } from './action-queue.service';
import type { AttachmentUploadPayload, QueuedAction } from './action-queue.types';
import {
  AttachmentUploadOutboxService,
  type PendingAttachmentUploadRecord,
} from './attachment-upload-outbox.service';
import { AttachmentCleanupOutboxService } from './attachment-cleanup-outbox.service';
import { AttachmentService } from './attachment.service';
import { ProjectStateService } from './project-state.service';
import { TombstoneService } from '../core-bridge';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('ActionQueueAttachmentProcessorsService', () => {
  function createAttachmentProcessorHarness(options: {
    enqueueDurablyResult?: string;
    pendingUpload?: PendingAttachmentUploadRecord | null;
    pendingUploads?: Array<PendingAttachmentUploadRecord & { recovery?: unknown }>;
    taskAttachments?: Attachment[];
    taskMissing?: boolean;
    localTombstoneTimestamp?: number;
  } = {}) {
    const pendingAttachment: Attachment = {
      id: 'attachment-1',
      type: 'file',
      name: 'note.txt',
      url: 'nanoflow-local-attachment://attachment-1',
      mimeType: 'text/plain',
      size: 7,
      createdAt: '2026-06-13T00:00:00.000Z',
      scanMetadata: { scanStatus: SCAN_STATUS.PENDING },
    };
    const uploadedAttachment: Attachment = {
      ...pendingAttachment,
      url: 'https://storage.test/signed-note.txt',
      signedAt: '2026-06-13T00:01:00.000Z',
      scanMetadata: { scanStatus: SCAN_STATUS.CLEAN, fileId: 'scan-1' },
    };
    const task: Task = {
      id: 'task-1',
      title: 'Task',
      content: '',
      stage: 1,
      parentId: null,
      order: 0,
      rank: 1000,
      status: 'active',
      x: 0,
      y: 0,
      createdDate: '2026-06-13T00:00:00.000Z',
      updatedAt: '2026-06-13T00:00:00.000Z',
      displayId: '1',
      attachments: options.taskAttachments ?? [pendingAttachment],
    };
    const payload: AttachmentUploadPayload = {
      attachment: pendingAttachment,
      blobKey: 'attachment-1',
      fileName: 'note.txt',
      mimeType: 'text/plain',
      projectId: 'project-1',
      taskId: 'task-1',
      userId: 'user-1',
      sourceUserId: 'user-1',
    };
    const action: QueuedAction<AttachmentUploadPayload> = {
      id: 'action-1',
      operationId: 'operation-1',
      type: 'create',
      entityType: 'attachment',
      entityId: 'attachment-1',
      payload,
      timestamp: Date.now(),
      localCommittedAt: Date.now(),
      syncState: 'pending_sync',
      retryCount: 0,
    };
    const registerProcessor = vi.fn();
    const enqueueDurably = vi.fn().mockResolvedValue(options.enqueueDurablyResult ?? 'task-update-action');
    const deferRetry = vi.fn(error => ({ outcome: 'defer-retry' as const, error }));
    const pendingUploadRecord: PendingAttachmentUploadRecord = {
      attachmentId: 'attachment-1',
      blobKey: 'attachment-1',
      fileName: 'note.txt',
      mimeType: 'text/plain',
      size: 7,
      blob: new Blob(['pending'], { type: 'text/plain' }),
      createdAt: '2026-06-13T00:00:00.000Z',
    };
    const readPendingUpload = vi.fn().mockResolvedValue(
      'pendingUpload' in options ? options.pendingUpload : pendingUploadRecord,
    );
    const listPendingUploads = vi.fn().mockResolvedValue(options.pendingUploads ?? []);
    const removePendingUpload = vi.fn().mockResolvedValue(undefined);
    const uploadQueuedAttachment = vi.fn().mockResolvedValue(uploadedAttachment);
    const updateTask = vi.fn();
    const enqueueCleanupPaths = vi.fn().mockResolvedValue(undefined);
    const getLocalTombstoneTimestamp = vi.fn(() => options.localTombstoneTimestamp);

    const injector = Injector.create({
      providers: [
        { provide: ActionQueueAttachmentProcessorsService, useClass: ActionQueueAttachmentProcessorsService },
        { provide: ActionQueueService, useValue: { registerProcessor, enqueueDurably, deferRetry } },
        { provide: AttachmentUploadOutboxService, useValue: { listPendingUploads, readPendingUpload, removePendingUpload } },
        { provide: AttachmentCleanupOutboxService, useValue: { enqueuePaths: enqueueCleanupPaths } },
        { provide: AttachmentService, useValue: { uploadQueuedAttachment } },
        { provide: ProjectStateService, useValue: { getTask: vi.fn(() => options.taskMissing ? undefined : task), updateTask } },
        { provide: TombstoneService, useValue: { getLocalTombstoneTimestamp } },
      ],
    });
    const service = injector.get(ActionQueueAttachmentProcessorsService);

    service.setupProcessors();

    return {
      action,
      payload,
      readPendingUpload,
      uploadedAttachment,
      enqueueDurably,
      deferRetry,
      listPendingUploads,
      removePendingUpload,
      uploadQueuedAttachment,
      updateTask,
      enqueueCleanupPaths,
      getLocalTombstoneTimestamp,
      processor: registerProcessor.mock.calls[0]?.[1] as (queued: QueuedAction) => Promise<unknown>,
    };
  }

  it('uploads a pending Blob, replaces the local attachment, queues a task update, and removes the Blob', async () => {
    const {
      action,
      payload,
      uploadedAttachment,
      enqueueDurably,
      removePendingUpload,
      uploadQueuedAttachment,
      updateTask,
      processor,
    } = createAttachmentProcessorHarness();
    const result = await processor(action);

    expect(result).toBe(true);
    const expectedOperationId = createDerivedSyncOperationId(action.operationId, 'attachment-task-update');
    expect(uploadQueuedAttachment).toHaveBeenCalledWith(payload, expect.any(Blob));
    expect(updateTask).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'task-1',
        attachments: [uploadedAttachment],
      }),
      'project-1',
    );
    expect(enqueueDurably).toHaveBeenCalledWith(expect.objectContaining({
      operationId: expectedOperationId,
      type: 'update',
      entityType: 'task',
      entityId: 'task-1',
      payload: expect.objectContaining({
        projectId: 'project-1',
        sourceUserId: 'user-1',
        task: expect.objectContaining({
          attachments: [uploadedAttachment],
        }),
      }),
    }));
    expect(enqueueDurably.mock.calls[0]?.[0]?.operationId)
      .not.toBe('attachment-upload:operation-1:task-update');
    expect(enqueueDurably.mock.calls[0]?.[0]?.operationId).toMatch(UUID_PATTERN);
    expect(removePendingUpload).toHaveBeenCalledWith('attachment-1');
  });

  it('defers without consuming retry budget when the follow-up task update is not durably queued', async () => {
    const {
      action,
      uploadedAttachment,
      enqueueDurably,
      removePendingUpload,
      uploadQueuedAttachment,
      updateTask,
      processor,
    } = createAttachmentProcessorHarness({ enqueueDurablyResult: '' });

    const result = await processor(action);

    expect(result).toEqual({
      outcome: 'defer-retry',
      error: expect.objectContaining({
        code: 'SYNC_RETRY_HANDOFF_PENDING',
        details: expect.objectContaining({
          reason: 'partial-retry-handoff',
          attachmentId: 'attachment-1',
          blobKey: 'attachment-1',
          taskId: 'task-1',
        }),
      }),
    });
    expect(uploadQueuedAttachment).toHaveBeenCalledTimes(1);
    expect(enqueueDurably).toHaveBeenCalled();
    expect(updateTask).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'task-1',
        attachments: [uploadedAttachment],
      }),
      'project-1',
    );
    expect(removePendingUpload).not.toHaveBeenCalled();
  });

  it('recreates missing attachment create actions from pending upload recovery metadata on setup', async () => {
    const pendingAttachment: Attachment = {
      id: 'attachment-1',
      type: 'file',
      name: 'note.txt',
      url: 'nanoflow-local-attachment://attachment-1',
      mimeType: 'text/plain',
      size: 7,
      createdAt: '2026-06-13T00:00:00.000Z',
      scanMetadata: { scanStatus: SCAN_STATUS.PENDING },
    };
    const recovery = {
      operationId: 'attachment:create:attachment-1',
      payload: {
        attachment: pendingAttachment,
        blobKey: 'attachment-1',
        fileName: 'note.txt',
        mimeType: 'text/plain',
        projectId: 'project-1',
        taskId: 'task-1',
        userId: 'user-1',
        sourceUserId: 'user-1',
      },
    };
    const pendingUpload: PendingAttachmentUploadRecord & { recovery: typeof recovery } = {
      attachmentId: 'attachment-1',
      blobKey: 'attachment-1',
      fileName: 'note.txt',
      mimeType: 'text/plain',
      size: 7,
      blob: new Blob(['pending'], { type: 'text/plain' }),
      createdAt: '2026-06-13T00:00:00.000Z',
      recovery,
    };
    const { enqueueDurably, listPendingUploads, removePendingUpload } = createAttachmentProcessorHarness({
      pendingUploads: [pendingUpload],
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(listPendingUploads).toHaveBeenCalled();
    expect(enqueueDurably).toHaveBeenCalledWith({
      operationId: 'attachment:create:attachment-1',
      type: 'create',
      entityType: 'attachment',
      entityId: 'attachment-1',
      payload: recovery.payload,
      priority: 'normal',
    });
    expect(removePendingUpload).not.toHaveBeenCalled();
  });

  it('retries only the task update when the uploaded attachment is already materialized locally', async () => {
    const { action, uploadedAttachment } = createAttachmentProcessorHarness();
    const taskWithUploadedAttachment = {
      ...action.payload.attachment,
      ...uploadedAttachment,
    };
    const retryHarness = createAttachmentProcessorHarness({
      pendingUpload: null,
      taskAttachments: [taskWithUploadedAttachment],
    });

    const result = await retryHarness.processor(retryHarness.action);

    expect(result).toBe(true);
    const expectedOperationId = createDerivedSyncOperationId(
      retryHarness.action.operationId,
      'attachment-task-update',
    );
    expect(retryHarness.readPendingUpload).not.toHaveBeenCalled();
    expect(retryHarness.uploadQueuedAttachment).not.toHaveBeenCalled();
    expect(retryHarness.enqueueDurably).toHaveBeenCalledWith(expect.objectContaining({
      operationId: expectedOperationId,
      payload: expect.objectContaining({
        task: expect.objectContaining({
          attachments: [taskWithUploadedAttachment],
        }),
      }),
    }));
    expect(retryHarness.enqueueDurably.mock.calls[0]?.[0]?.operationId).toMatch(UUID_PATTERN);
    expect(retryHarness.removePendingUpload).toHaveBeenCalledWith('attachment-1');
  });

  it('defers when task metadata has not exposed the local attachment yet so the pending Blob survives', async () => {
    const {
      action,
      deferRetry,
      enqueueDurably,
      readPendingUpload,
      removePendingUpload,
      uploadQueuedAttachment,
      processor,
    } = createAttachmentProcessorHarness({ taskAttachments: [] });

    const result = await processor(action);

    expect(result).toEqual({
      outcome: 'defer-retry',
      error: expect.objectContaining({
        code: 'SYNC_RETRY_HANDOFF_PENDING',
        details: expect.objectContaining({
          reason: 'attachment-task-metadata-pending',
          attachmentId: 'attachment-1',
          blobKey: 'attachment-1',
          taskId: 'task-1',
        }),
      }),
    });
    expect(readPendingUpload).toHaveBeenCalledWith('attachment-1');
    expect(deferRetry).toHaveBeenCalled();
    expect(uploadQueuedAttachment).not.toHaveBeenCalled();
    expect(enqueueDurably).not.toHaveBeenCalled();
    expect(removePendingUpload).not.toHaveBeenCalled();
  });

  it('defers follow-up handoff when task update enqueue throws after upload', async () => {
    const {
      action,
      enqueueDurably,
      deferRetry,
      removePendingUpload,
      uploadQueuedAttachment,
      updateTask,
      processor,
    } = createAttachmentProcessorHarness();
    enqueueDurably.mockRejectedValueOnce(new Error('idb commit lost'));

    const result = await processor(action);

    expect(result).toEqual({
      outcome: 'defer-retry',
      error: expect.objectContaining({
        code: 'SYNC_RETRY_HANDOFF_PENDING',
        details: expect.objectContaining({
          reason: 'partial-retry-handoff',
          attachmentId: 'attachment-1',
          blobKey: 'attachment-1',
          taskId: 'task-1',
        }),
      }),
    });
    expect(uploadQueuedAttachment).toHaveBeenCalledTimes(1);
    expect(updateTask).toHaveBeenCalled();
    expect(deferRetry).toHaveBeenCalled();
    expect(removePendingUpload).not.toHaveBeenCalled();
  });

  it('drops the pending Blob without uploading when the local attachment was deleted before upload', async () => {
    const { action } = createAttachmentProcessorHarness();
    const deletedAttachment: Attachment = {
      ...action.payload.attachment,
      deletedAt: '2026-06-13T00:02:00.000Z',
    };
    const {
      enqueueDurably,
      removePendingUpload,
      uploadQueuedAttachment,
      updateTask,
      processor,
    } = createAttachmentProcessorHarness({
      taskAttachments: [deletedAttachment],
    });

    const result = await processor(action);

    expect(result).toBe(true);
    expect(uploadQueuedAttachment).not.toHaveBeenCalled();
    expect(updateTask).not.toHaveBeenCalled();
    expect(enqueueDurably).not.toHaveBeenCalled();
    expect(removePendingUpload).toHaveBeenCalledWith('attachment-1');
  });

  it('reclaims the pending Blob and queues remote cleanup when the target task is locally tombstoned', async () => {
    const {
      action,
      deferRetry,
      enqueueCleanupPaths,
      removePendingUpload,
      uploadQueuedAttachment,
      processor,
    } = createAttachmentProcessorHarness({
      taskMissing: true,
      localTombstoneTimestamp: 1_750_000_000_000,
    });

    const result = await processor(action);

    expect(result).toBe(true);
    // 早前尝试可能已把 Blob 推到远端存储：任务已删除时必须入队远端清理回收孤儿对象
    expect(enqueueCleanupPaths).toHaveBeenCalledWith(['user-1/project-1/task-1/attachment-1.txt']);
    expect(removePendingUpload).toHaveBeenCalledWith('attachment-1');
    expect(uploadQueuedAttachment).not.toHaveBeenCalled();
    expect(deferRetry).not.toHaveBeenCalled();
  });

  it('keeps the pending Blob when remote-cleanup enqueue fails for a tombstoned task so evidence survives', async () => {
    const {
      action,
      enqueueCleanupPaths,
      removePendingUpload,
      processor,
    } = createAttachmentProcessorHarness({
      taskMissing: true,
      localTombstoneTimestamp: 1_750_000_000_000,
    });
    enqueueCleanupPaths.mockRejectedValueOnce(new Error('idb write lost'));

    const result = await processor(action);

    expect(result).toBe(false);
    expect(removePendingUpload).not.toHaveBeenCalled();
  });

  it('still defers while the task is missing without a tombstone so backup-restore races keep the Blob', async () => {
    const {
      action,
      deferRetry,
      enqueueCleanupPaths,
      removePendingUpload,
      processor,
    } = createAttachmentProcessorHarness({ taskMissing: true });

    const result = await processor(action);

    expect(result).toEqual({
      outcome: 'defer-retry',
      error: expect.objectContaining({
        code: 'SYNC_RETRY_HANDOFF_PENDING',
        details: expect.objectContaining({
          reason: 'attachment-task-metadata-pending',
        }),
      }),
    });
    expect(deferRetry).toHaveBeenCalled();
    expect(enqueueCleanupPaths).not.toHaveBeenCalled();
    expect(removePendingUpload).not.toHaveBeenCalled();
  });
});
