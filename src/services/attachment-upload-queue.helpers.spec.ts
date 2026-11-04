import { describe, expect, it, vi } from 'vitest';

import { SCAN_STATUS } from '../config/virus-scan.config';
import {
  createAttachmentUploadContext,
  createAttachmentUploadContextForPayload,
  createPendingAttachmentScanMetadata,
  isRecoverableAttachmentScanFailure,
  prepareAttachmentFileUpload,
  queuePendingLocalAttachmentUpload,
  type AttachmentUploadContext,
} from './attachment-upload-queue.helpers';

describe('attachment-upload-queue.helpers', () => {
  it('creates pending scan metadata for locally deferred uploads', () => {
    const metadata = createPendingAttachmentScanMetadata('2026-06-13T00:00:00.000Z');

    expect(metadata).toEqual({
      lastScannedAt: '2026-06-13T00:00:00.000Z',
      scanStatus: SCAN_STATUS.PENDING,
      scanHistory: [{
        scannedAt: '2026-06-13T00:00:00.000Z',
        status: SCAN_STATUS.PENDING,
        scanner: 'local-offline',
      }],
    });
  });

  it('only treats unavailable or timed-out scan errors as recoverable', () => {
    expect(isRecoverableAttachmentScanFailure('SERVICE_UNAVAILABLE')).toBe(true);
    expect(isRecoverableAttachmentScanFailure('SCAN_TIMEOUT')).toBe(true);
    expect(isRecoverableAttachmentScanFailure('NETWORK_ERROR')).toBe(true);
    expect(isRecoverableAttachmentScanFailure('THREAT_DETECTED')).toBe(false);
    expect(isRecoverableAttachmentScanFailure(undefined)).toBe(false);
  });

  it('prepares a locally deferred upload when scan service is temporarily unavailable', async () => {
    const file = new File(['offline'], 'offline.txt', { type: 'text/plain' });
    const result = await prepareAttachmentFileUpload({
      createScanMetadata: vi.fn(),
      file,
      projectId: 'project-1',
      scanBeforeUpload: vi.fn().mockResolvedValue({
        success: false,
        error: 'offline',
        errorCode: 'SERVICE_UNAVAILABLE',
      }),
      supabaseConfigured: true,
      taskId: 'task-1',
      userId: 'user-1',
      validateFile: vi.fn().mockResolvedValue({ valid: true }),
    });

    expect(result).toEqual(expect.objectContaining({
      success: true,
      remoteUploadDeferred: true,
      scanMetadata: expect.objectContaining({ scanStatus: SCAN_STATUS.PENDING }),
    }));
  });

  it('prepares a locally deferred upload when Supabase is not configured', async () => {
    const file = new File(['offline'], 'offline.txt', { type: 'text/plain' });
    const scanBeforeUpload = vi.fn();

    const result = await prepareAttachmentFileUpload({
      createScanMetadata: vi.fn(),
      file,
      projectId: 'project-1',
      scanBeforeUpload,
      supabaseConfigured: false,
      taskId: 'task-1',
      userId: 'user-1',
      validateFile: vi.fn().mockResolvedValue({ valid: true }),
    });

    expect(result).toEqual(expect.objectContaining({
      success: true,
      remoteUploadDeferred: true,
      scanMetadata: expect.objectContaining({ scanStatus: SCAN_STATUS.PENDING }),
    }));
    expect(scanBeforeUpload).not.toHaveBeenCalled();
  });

  it('builds upload contexts from new files and queued payloads', () => {
    const file = new File(['upload'], 'report.pdf', { type: 'application/pdf' });
    const context = createAttachmentUploadContext({
      attachmentId: 'attachment-1',
      file,
      projectId: 'project-1',
      taskId: 'task-1',
      userId: 'user-1',
    });

    expect(context).toEqual(expect.objectContaining({
      attachmentId: 'attachment-1',
      filePath: 'user-1/project-1/task-1/attachment-1.pdf',
      remoteUploadDeferred: false,
    }));
    expect(context.abortController).toBeInstanceOf(AbortController);
    expect(createAttachmentUploadContextForPayload({
      attachment: {
        id: 'attachment-2',
        type: 'document',
        name: 'queued.pdf',
        url: 'nanoflow-local-attachment://attachment-2',
        createdAt: '2026-06-13T00:00:00.000Z',
      },
      blobKey: 'attachment-2',
      fileName: 'queued.pdf',
      mimeType: 'application/pdf',
      projectId: 'project-1',
      taskId: 'task-1',
      userId: 'user-1',
    })).toEqual(expect.objectContaining({
      attachmentId: 'attachment-2',
      filePath: 'user-1/project-1/task-1/attachment-2.pdf',
    }));
  });

  it('persists the blob and queues an attachment create action for local pending uploads', async () => {
    const file = new File(['offline'], 'offline.txt', { type: 'text/plain' });
    const scanMetadata = createPendingAttachmentScanMetadata('2026-06-13T00:00:00.000Z');
    const context: AttachmentUploadContext = {
      attachmentId: 'attachment-1',
      abortController: new AbortController(),
      filePath: 'user-1/project-1/task-1/attachment-1.txt',
      remoteUploadDeferred: true,
      scanMetadata,
    };
    const savePendingUpload = vi.fn().mockResolvedValue(undefined);
    const removePendingUpload = vi.fn().mockResolvedValue(undefined);
    const enqueueDurably = vi.fn().mockResolvedValue('queued');
    const updateProgress = vi.fn();

    const result = await queuePendingLocalAttachmentUpload({
      actionQueue: { enqueueDurably },
      context,
      file,
      projectId: 'project-1',
      taskId: 'task-1',
      updateProgress,
      uploadOutbox: { savePendingUpload, removePendingUpload },
      userId: 'user-1',
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.attachment).toEqual(expect.objectContaining({
      id: 'attachment-1',
      mimeType: 'text/plain',
      name: 'offline.txt',
      scanMetadata,
      type: 'document',
      url: 'nanoflow-local-attachment://attachment-1',
    }));
    expect(result.queuedUpload).toEqual({
      actionId: 'queued',
      ownerUserId: 'user-1',
      blobKey: 'attachment-1',
      operationId: 'attachment:create:attachment-1',
    });
    expect(savePendingUpload).toHaveBeenCalledWith(expect.objectContaining({
      attachmentId: 'attachment-1',
      blob: file,
      blobKey: 'attachment-1',
      fileName: 'offline.txt',
      mimeType: 'text/plain',
      operationId: 'attachment:create:attachment-1',
      ownerUserId: 'user-1',
      recovery: expect.objectContaining({
        operationId: 'attachment:create:attachment-1',
        payload: expect.objectContaining({
          attachment: result.attachment,
          blobKey: 'attachment-1',
          fileName: 'offline.txt',
          mimeType: 'text/plain',
          projectId: 'project-1',
          sourceUserId: 'user-1',
          taskId: 'task-1',
          userId: 'user-1',
        }),
      }),
      size: file.size,
    }));
    expect(enqueueDurably).toHaveBeenCalledWith(expect.objectContaining({
      entityId: 'attachment-1',
      entityType: 'attachment',
      operationId: 'attachment:create:attachment-1',
      payload: expect.objectContaining({
        attachment: result.attachment,
        blobKey: 'attachment-1',
        fileName: 'offline.txt',
        projectId: 'project-1',
        sourceUserId: 'user-1',
        taskId: 'task-1',
      }),
      priority: 'normal',
      type: 'create',
    }));
    expect(updateProgress).toHaveBeenCalledWith('offline.txt', 0, 'pending');
  });

  it('removes the pending blob and returns failure when attachment create is not durably queued', async () => {
    const file = new File(['offline'], 'offline.txt', { type: 'text/plain' });
    const context: AttachmentUploadContext = {
      attachmentId: 'attachment-1',
      abortController: new AbortController(),
      filePath: 'user-1/project-1/task-1/attachment-1.txt',
      remoteUploadDeferred: true,
      scanMetadata: createPendingAttachmentScanMetadata('2026-06-13T00:00:00.000Z'),
    };
    const savePendingUpload = vi.fn().mockResolvedValue(undefined);
    const removePendingUpload = vi.fn().mockResolvedValue(undefined);
    const enqueueDurably = vi.fn().mockResolvedValue('');
    const updateProgress = vi.fn();

    const result = await queuePendingLocalAttachmentUpload({
      actionQueue: { enqueueDurably },
      context,
      file,
      projectId: 'project-1',
      taskId: 'task-1',
      updateProgress,
      uploadOutbox: { savePendingUpload, removePendingUpload },
      userId: 'user-1',
    });

    expect(result).toEqual({
      success: false,
      error: '附件上传队列持久化失败',
    });
    expect(removePendingUpload).toHaveBeenCalledWith({
      ownerUserId: 'user-1',
      blobKey: 'attachment-1',
      operationId: 'attachment:create:attachment-1',
    });
    expect(updateProgress).not.toHaveBeenCalled();
  });

  it('returns controlled failure and skips action enqueue when pending blob persistence fails', async () => {
    const file = new File(['offline'], 'offline.txt', { type: 'text/plain' });
    const context: AttachmentUploadContext = {
      attachmentId: 'attachment-1',
      abortController: new AbortController(),
      filePath: 'user-1/project-1/task-1/attachment-1.txt',
      remoteUploadDeferred: true,
      scanMetadata: createPendingAttachmentScanMetadata('2026-06-13T00:00:00.000Z'),
    };
    const savePendingUpload = vi.fn().mockRejectedValue(new Error('blob quota exceeded'));
    const removePendingUpload = vi.fn().mockResolvedValue(undefined);
    const enqueueDurably = vi.fn().mockResolvedValue('queued');
    const updateProgress = vi.fn();

    const result = await queuePendingLocalAttachmentUpload({
      actionQueue: { enqueueDurably },
      context,
      file,
      projectId: 'project-1',
      taskId: 'task-1',
      updateProgress,
      uploadOutbox: { savePendingUpload, removePendingUpload },
      userId: 'user-1',
    });

    expect(result).toEqual({
      success: false,
      error: '附件上传队列持久化失败',
    });
    expect(enqueueDurably).not.toHaveBeenCalled();
    expect(removePendingUpload).not.toHaveBeenCalled();
    expect(updateProgress).not.toHaveBeenCalled();
  });

  it('retains the pending blob when durable queue enqueue throws because commit state is unknown', async () => {
    const file = new File(['offline'], 'offline.txt', { type: 'text/plain' });
    const context: AttachmentUploadContext = {
      attachmentId: 'attachment-1',
      abortController: new AbortController(),
      filePath: 'user-1/project-1/task-1/attachment-1.txt',
      remoteUploadDeferred: true,
      scanMetadata: createPendingAttachmentScanMetadata('2026-06-13T00:00:00.000Z'),
    };
    const savePendingUpload = vi.fn().mockResolvedValue(undefined);
    const removePendingUpload = vi.fn().mockResolvedValue(undefined);
    const enqueueDurably = vi.fn().mockRejectedValue(new Error('post-commit side effect failed'));
    const updateProgress = vi.fn();

    const result = await queuePendingLocalAttachmentUpload({
      actionQueue: { enqueueDurably },
      context,
      file,
      projectId: 'project-1',
      taskId: 'task-1',
      updateProgress,
      uploadOutbox: { savePendingUpload, removePendingUpload },
      userId: 'user-1',
    });

    expect(result).toEqual({
      success: false,
      error: '附件上传队列持久化失败',
    });
    expect(removePendingUpload).not.toHaveBeenCalled();
    expect(updateProgress).not.toHaveBeenCalled();
  });

  it('returns failure without deleting the pending blob when durable queue enqueue throws', async () => {
    const file = new File(['offline'], 'offline.txt', { type: 'text/plain' });
    const context: AttachmentUploadContext = {
      attachmentId: 'attachment-1',
      abortController: new AbortController(),
      filePath: 'user-1/project-1/task-1/attachment-1.txt',
      remoteUploadDeferred: true,
      scanMetadata: createPendingAttachmentScanMetadata('2026-06-13T00:00:00.000Z'),
    };
    const savePendingUpload = vi.fn().mockResolvedValue(undefined);
    const removePendingUpload = vi.fn().mockResolvedValue(undefined);
    const enqueueDurably = vi.fn().mockRejectedValue(new Error('indexeddb quota exceeded'));
    const updateProgress = vi.fn();

    const result = await queuePendingLocalAttachmentUpload({
      actionQueue: { enqueueDurably },
      context,
      file,
      projectId: 'project-1',
      taskId: 'task-1',
      updateProgress,
      uploadOutbox: { savePendingUpload, removePendingUpload },
      userId: 'user-1',
    });

    expect(result).toEqual({
      success: false,
      error: '附件上传队列持久化失败',
    });
    expect(removePendingUpload).not.toHaveBeenCalled();
    expect(updateProgress).not.toHaveBeenCalled();
  });
});
