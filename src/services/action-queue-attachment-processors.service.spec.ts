import { Injector } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';
import { SCAN_STATUS } from '../config/virus-scan.config';
import type { Attachment, Project } from '../models';
import { createDerivedSyncOperationId } from '../utils/sync-operation-id';
import type { PendingAttachmentUploadRecord } from './attachment-upload-outbox.service';
import {
  createAttachmentProcessorHarness,
  createDeferredAttachmentProcessorHarness,
  expectAttachmentReplayDeferred,
  expectGuardedPendingUploadRemoval,
  registerAttachmentReplaySettlementFenceSpecs,
  UPLOAD_IDENTITY,
  UUID_PATTERN,
} from './action-queue-attachment-processors.spec-helpers';
describe('ActionQueueAttachmentProcessorsService', () => {
  registerAttachmentReplaySettlementFenceSpecs();
  it('uploads a pending Blob, replaces the local attachment, queues a task update, and removes the Blob', async () => {
    const {
      action,
      payload,
      uploadedAttachment,
      enqueueDurably,
      enqueueDurablyForOwner,
      removePendingUpload,
      removePendingUploadIfCurrent,
      settleAttachmentReplayActionForOwner,
      uploadQueuedAttachment,
      updateTask,
      processor,
    } = createAttachmentProcessorHarness();
    const result = await processor(action);
    expect(result).toBe(true);
    const expectedOperationId = createDerivedSyncOperationId(action.operationId, 'attachment-task-update');
    expect(uploadQueuedAttachment).toHaveBeenCalledWith(
      payload,
      expect.any(Blob),
      expect.objectContaining({
        signal: expect.any(AbortSignal),
        isCurrent: expect.any(Function),
      }),
    );
    expect(updateTask).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'task-1',
        attachments: [uploadedAttachment],
      }),
      'project-1',
    );
    expect(enqueueDurably).not.toHaveBeenCalled();
    expect(enqueueDurablyForOwner).toHaveBeenCalledWith('user-1', expect.objectContaining({
      operationId: expectedOperationId,
      type: 'update',
      entityType: 'task',
      entityId: 'task-1',
      payload: expect.objectContaining({
        projectId: 'project-1',
        sourceUserId: 'user-1',
        writeIntent: 'task_attachment_update',
        task: expect.objectContaining({
          attachments: [uploadedAttachment],
        }),
      }),
    }));
    expect(enqueueDurablyForOwner.mock.calls[0]?.[1]?.operationId)
      .not.toBe('attachment-upload:operation-1:task-update');
    expect(enqueueDurablyForOwner.mock.calls[0]?.[1]?.operationId).toMatch(UUID_PATTERN);
    expect(settleAttachmentReplayActionForOwner).toHaveBeenNthCalledWith(
      1,
      'user-1',
      expect.objectContaining({
        mode: 'verify-task-update',
        actionId: 'recovered-attachment-action',
        operationId: expectedOperationId,
        entityType: 'task',
        type: 'update',
        entityId: 'task-1',
      }),
    );
    expect(removePendingUploadIfCurrent).toHaveBeenCalledWith(
      expect.objectContaining(UPLOAD_IDENTITY),
      expect.objectContaining({
        signal: expect.any(AbortSignal),
        isCurrent: expect.any(Function),
      }),
    );
    expect(settleAttachmentReplayActionForOwner).toHaveBeenNthCalledWith(
      2,
      'user-1',
      expect.objectContaining({
        mode: 'remove-attachment-create',
        actionId: 'action-1',
        operationId: 'operation-1',
        entityType: 'attachment',
        type: 'create',
        entityId: 'attachment-1',
      }),
    );
    expect(removePendingUpload).not.toHaveBeenCalled();
  });
  it.each([
    ['missing', undefined],
    ['already aborted', new AbortController()],
  ])('defers with zero effects when the writer lease signal is %s', async (_label, controller) => {
    controller?.abort();
    const harness = createAttachmentProcessorHarness();
    const result = await harness.registeredProcessor(
      harness.action,
      controller ? { leaseSignal: controller.signal } : undefined,
    );
    expectAttachmentReplayDeferred(result, 'attachment-replay-fence-stale');
    expect(harness.readPendingUpload).not.toHaveBeenCalled();
    expect(harness.uploadQueuedAttachment).not.toHaveBeenCalled();
    expect(harness.updateTask).not.toHaveBeenCalled();
    expect(harness.enqueueDurablyForOwner).not.toHaveBeenCalled();
    expect(harness.removePendingUploadIfCurrent).not.toHaveBeenCalled();
    expect(harness.settleAttachmentReplayActionForOwner).not.toHaveBeenCalled();
  });

  it('publishes nothing when the writer lease is lost after the remote upload', async () => {
    const { harness, resolveUpload } = createDeferredAttachmentProcessorHarness();
    const processing = harness.processor(harness.action);
    await vi.waitFor(() => expect(harness.uploadQueuedAttachment).toHaveBeenCalledOnce());
    harness.leaseController.abort();
    resolveUpload(harness.uploadedAttachment);
    const result = await processing;
    expectAttachmentReplayDeferred(result, 'attachment-replay-fence-stale');
    expect(harness.updateTask).not.toHaveBeenCalled();
    expect(harness.enqueueDurablyForOwner).not.toHaveBeenCalled();
    expect(harness.removePendingUploadIfCurrent).not.toHaveBeenCalled();
    expect(harness.settleAttachmentReplayActionForOwner).not.toHaveBeenCalled();
  });

  it('patches the uploaded attachment into the latest task without overwriting concurrent edits', async () => {
    const { harness, resolveUpload } = createDeferredAttachmentProcessorHarness();
    const processing = harness.processor(harness.action);
    await vi.waitFor(() => expect(harness.uploadQueuedAttachment).toHaveBeenCalledOnce());
    const currentTask = harness.currentTask();
    if (!currentTask) throw new Error('expected task fixture');
    harness.updateTask({
      ...currentTask,
      title: 'Concurrent edit',
      content: 'Preserve me',
    }, 'project-1');
    resolveUpload(harness.uploadedAttachment);
    await expect(processing).resolves.toBe(true);
    expect(harness.currentTask()).toEqual(expect.objectContaining({
      title: 'Concurrent edit',
      content: 'Preserve me',
      attachments: [harness.uploadedAttachment],
    }));
  });

  it('queues deterministic remote cleanup when the attachment is deleted during upload', async () => {
    const { harness, resolveUpload } = createDeferredAttachmentProcessorHarness();
    const processing = harness.processor(harness.action);
    await vi.waitFor(() => expect(harness.uploadQueuedAttachment).toHaveBeenCalledOnce());
    const currentTask = harness.currentTask();
    const currentAttachment = currentTask?.attachments?.[0];
    if (!currentTask || !currentAttachment) throw new Error('expected attachment fixture');
    harness.updateTask({
      ...currentTask,
      attachments: [{
        ...currentAttachment,
        deletedAt: '2026-06-13T00:03:00.000Z',
      }],
    }, 'project-1');
    resolveUpload(harness.uploadedAttachment);

    await expect(processing).resolves.toBe(true);
    expect(harness.enqueueCleanupPaths).toHaveBeenCalledWith(
      ['user-1/project-1/task-1/attachment-1.txt'],
      { ownerUserId: 'user-1', operationId: 'operation-1' },
    );
    expect(harness.enqueueDurablyForOwner).not.toHaveBeenCalled();
    expectGuardedPendingUploadRemoval(harness.removePendingUploadIfCurrent);
    expect(harness.settleAttachmentReplayActionForOwner).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ mode: 'remove-attachment-create' }),
    );
  });

  it.each([
    ['Auth identity', (harness: ReturnType<typeof createAttachmentProcessorHarness>) => harness.setAuthFence('auth-fence-2')],
    ['session generation', (harness: ReturnType<typeof createAttachmentProcessorHarness>) => harness.advanceSessionGeneration()],
    ['queue generation', (harness: ReturnType<typeof createAttachmentProcessorHarness>) => harness.advanceQueueGeneration()],
    ['project generation', (harness: ReturnType<typeof createAttachmentProcessorHarness>) => harness.advanceProjectGeneration()],
  ])('defers after %s drift across upload without publishing state', async (_label, drift) => {
    const { harness, resolveUpload } = createDeferredAttachmentProcessorHarness();
    const processing = harness.processor(harness.action);
    await vi.waitFor(() => expect(harness.uploadQueuedAttachment).toHaveBeenCalledOnce());
    drift(harness);
    resolveUpload(harness.uploadedAttachment);
    const result = await processing;
    expectAttachmentReplayDeferred(result, 'attachment-replay-fence-stale');
    expect(harness.updateTask).not.toHaveBeenCalled();
    expect(harness.enqueueDurablyForOwner).not.toHaveBeenCalled();
    expect(harness.removePendingUploadIfCurrent).not.toHaveBeenCalled();
    expect(harness.settleAttachmentReplayActionForOwner).not.toHaveBeenCalled();
  });

  it('retains A, B, and Blob when strict B readback does not match the committed follow-up', async () => {
    const harness = createAttachmentProcessorHarness();
    harness.settleAttachmentReplayActionForOwner.mockResolvedValueOnce({
      status: 'identity-mismatch',
    });
    const result = await harness.processor(harness.action);
    expectAttachmentReplayDeferred(result, 'partial-retry-handoff');
    expect(harness.enqueueDurablyForOwner).toHaveBeenCalledOnce();
    expect(harness.removePendingUploadIfCurrent).not.toHaveBeenCalled();
    expect(harness.settleAttachmentReplayActionForOwner).toHaveBeenCalledOnce();
  });

  it('resumes from A plus durable B after Blob cleanup and settles exact A without another upload', async () => {
    const { action, uploadedAttachment } = createAttachmentProcessorHarness();
    const harness = createAttachmentProcessorHarness({
      pendingUpload: null,
      taskAttachments: [uploadedAttachment],
    });
    const result = await harness.processor(harness.action);
    expect(result).toBe(true);
    expect(harness.uploadQueuedAttachment).not.toHaveBeenCalled();
    expect(harness.removePendingUploadIfCurrent).not.toHaveBeenCalled();
    expect(harness.settleAttachmentReplayActionForOwner).toHaveBeenNthCalledWith(
      2,
      'user-1',
      expect.objectContaining({
        mode: 'remove-attachment-create',
        actionId: action.id,
        operationId: action.operationId,
      }),
    );
  });
  it('keeps owner A bytes untouched when the owner changes during upload', async () => {
    let currentOwnerUserId = 'user-1';
    let resolveUpload: (attachment: Attachment) => void = () => undefined;
    const deferredUpload = new Promise<Attachment>(resolve => {
      resolveUpload = resolve;
    });
    const harness = createAttachmentProcessorHarness({
      currentOwnerUserId: () => currentOwnerUserId,
    });
    harness.uploadQueuedAttachment.mockReturnValueOnce(deferredUpload);
    const processing = harness.processor(harness.action);
    await Promise.resolve();
    await Promise.resolve();
    expect(harness.uploadQueuedAttachment).toHaveBeenCalledTimes(1);
    currentOwnerUserId = 'user-2';
    harness.sessionRuntimeReset.resetAll('owner-change');
    resolveUpload(harness.uploadedAttachment);
    const result = await processing;
    expectAttachmentReplayDeferred(result, 'attachment-replay-fence-stale');
    expect(harness.updateTask).not.toHaveBeenCalled();
    expect(harness.enqueueDurably).not.toHaveBeenCalled();
    expect(harness.enqueueDurablyForOwner).not.toHaveBeenCalled();
    expect(harness.removePendingUpload).not.toHaveBeenCalled();
  });
  it('defers without consuming retry budget when the follow-up task update is not durably queued', async () => {
    const {
      action,
      uploadedAttachment,
      enqueueDurably,
      enqueueDurablyForOwner,
      removePendingUpload,
      uploadQueuedAttachment,
      updateTask,
      processor,
    } = createAttachmentProcessorHarness({ enqueueDurablyResult: '' });
    const result = await processor(action);
    expectAttachmentReplayDeferred(result, 'partial-retry-handoff', {
      attachmentId: 'attachment-1',
      blobKey: 'attachment-1',
      taskId: 'task-1',
    });
    expect(uploadQueuedAttachment).toHaveBeenCalledTimes(1);
    expect(enqueueDurably).not.toHaveBeenCalled();
    expect(enqueueDurablyForOwner).toHaveBeenCalled();
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
      ownerUserId: 'user-1',
      operationId: recovery.operationId,
      attachmentId: 'attachment-1',
      blobKey: 'attachment-1',
      fileName: 'note.txt',
      mimeType: 'text/plain',
      size: 7,
      blob: new Blob(['pending'], { type: 'text/plain' }),
      createdAt: '2026-06-13T00:00:00.000Z',
      recovery,
    } as PendingAttachmentUploadRecord & {
      ownerUserId: string;
      operationId: string;
      recovery: typeof recovery;
    };
    const {
      enqueueDurablyForOwner,
      listPendingUploads,
      removePendingUpload,
    } = createAttachmentProcessorHarness({
      pendingUploads: [pendingUpload],
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(listPendingUploads).toHaveBeenCalled();
    expect(listPendingUploads).toHaveBeenCalledWith('user-1');
    expect(enqueueDurablyForOwner).toHaveBeenCalledWith('user-1', {
      operationId: 'attachment:create:attachment-1',
      type: 'create',
      entityType: 'attachment',
      entityId: 'attachment-1',
      payload: recovery.payload,
      priority: 'normal',
    });
    expect(removePendingUpload).not.toHaveBeenCalled();
  });
  it('does not reconcile owner A uploads into owner B queue state', async () => {
    const ownerAPending = {
      ownerUserId: 'user-a',
      operationId: 'attachment:create:owner-a',
      attachmentId: 'owner-a-attachment',
      blobKey: 'owner-a-blob',
      fileName: 'owner-a.txt',
      mimeType: 'text/plain',
      size: 1,
      blob: new Blob(['a'], { type: 'text/plain' }),
      createdAt: '2026-06-13T00:00:00.000Z',
      recovery: {
        operationId: 'attachment:create:owner-a',
        payload: {
          attachment: { id: 'owner-a-attachment' },
          blobKey: 'owner-a-blob',
          fileName: 'owner-a.txt',
          mimeType: 'text/plain',
          projectId: 'project-a',
          taskId: 'task-a',
          userId: 'user-a',
          sourceUserId: 'user-a',
        },
      },
    } as unknown as PendingAttachmentUploadRecord & { recovery: unknown };
    const {
      enqueueDurably,
      enqueueDurablyForOwner,
      listPendingUploads,
    } = createAttachmentProcessorHarness({
      currentOwnerUserId: () => 'user-b',
      listPendingUploadsImpl: async ownerUserId => ownerUserId === 'user-b' ? [] : [ownerAPending],
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(listPendingUploads).toHaveBeenCalledWith('user-b');
    expect(enqueueDurably).not.toHaveBeenCalled();
    expect(enqueueDurablyForOwner).not.toHaveBeenCalled();
  });
  it('invalidates an in-flight reconcile on owner transition and starts a new owner-scoped scan', async () => {
    let currentOwner = 'user-a';
    let resolveOwnerA: (
      uploads: Array<PendingAttachmentUploadRecord & { recovery?: unknown }>,
    ) => void = () => undefined;
    const ownerAResult = new Promise<Array<PendingAttachmentUploadRecord & { recovery?: unknown }>>(
      resolve => { resolveOwnerA = resolve; },
    );
    const ownerBPending = {
      ownerUserId: 'user-b',
      operationId: 'attachment:create:owner-b',
      attachmentId: 'owner-b-attachment',
      blobKey: 'owner-b-blob',
      fileName: 'owner-b.txt',
      mimeType: 'text/plain',
      size: 1,
      blob: new Blob(['b'], { type: 'text/plain' }),
      createdAt: '2026-06-13T00:00:01.000Z',
      recovery: {
        operationId: 'attachment:create:owner-b',
        payload: {
          attachment: { id: 'owner-b-attachment' },
          blobKey: 'owner-b-blob',
          fileName: 'owner-b.txt',
          mimeType: 'text/plain',
          projectId: 'project-b',
          taskId: 'task-b',
          userId: 'user-b',
          sourceUserId: 'user-b',
        },
      },
    } as unknown as PendingAttachmentUploadRecord & { recovery: unknown };
    const harness = createAttachmentProcessorHarness({
      currentOwnerUserId: () => currentOwner,
      listPendingUploadsImpl: ownerUserId => ownerUserId === 'user-b'
        ? Promise.resolve([ownerBPending])
        : ownerAResult,
    });
    currentOwner = 'user-b';
    harness.sessionRuntimeReset.resetAll('owner-change');
    resolveOwnerA([]);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(harness.enqueueDurably).not.toHaveBeenCalled();
    expect(harness.enqueueDurablyForOwner).toHaveBeenCalledTimes(1);
    expect(harness.enqueueDurablyForOwner).toHaveBeenCalledWith(
      'user-b',
      expect.objectContaining({ operationId: 'attachment:create:owner-b' }),
    );
  });
  it('does not enqueue a late reconcile result after the processor service is disposed', async () => {
    let resolvePending: (
      uploads: Array<PendingAttachmentUploadRecord & { recovery?: unknown }>,
    ) => void = () => undefined;
    const pendingResult = new Promise<Array<PendingAttachmentUploadRecord & { recovery?: unknown }>>(
      resolve => { resolvePending = resolve; },
    );
    const harness = createAttachmentProcessorHarness({
      listPendingUploadsImpl: () => pendingResult,
    });
    (harness.injector as Injector & { destroy(): void }).destroy();
    resolvePending([{
      ownerUserId: 'user-1',
      operationId: 'attachment:create:late',
      attachmentId: 'late',
      blobKey: 'late',
      fileName: 'late.txt',
      mimeType: 'text/plain',
      size: 1,
      blob: new Blob(['x'], { type: 'text/plain' }),
      createdAt: '2026-06-13T00:00:00.000Z',
      recovery: {
        operationId: 'attachment:create:late',
        payload: {
          attachment: { id: 'late' },
          blobKey: 'late',
          fileName: 'late.txt',
          mimeType: 'text/plain',
          projectId: 'project-1',
          taskId: 'task-1',
          userId: 'user-1',
          sourceUserId: 'user-1',
        },
      },
    } as unknown as PendingAttachmentUploadRecord & { recovery: unknown }]);
    await Promise.resolve();
    await Promise.resolve();
    expect(harness.enqueueDurably).not.toHaveBeenCalled();
    expect(harness.enqueueDurablyForOwner).not.toHaveBeenCalled();
  });
  it('invalidates an in-flight reconcile without starting another scan during clear-local-data', async () => {
    let resolvePending: (
      uploads: Array<PendingAttachmentUploadRecord & { recovery?: unknown }>,
    ) => void = () => undefined;
    const pendingResult = new Promise<Array<PendingAttachmentUploadRecord & { recovery?: unknown }>>(
      resolve => { resolvePending = resolve; },
    );
    const harness = createAttachmentProcessorHarness({
      listPendingUploadsImpl: () => pendingResult,
    });
    harness.sessionRuntimeReset.resetAll('clear-local-data');
    resolvePending([]);
    await Promise.resolve();
    await Promise.resolve();
    expect(harness.listPendingUploads).toHaveBeenCalledTimes(1);
    expect(harness.enqueueDurably).not.toHaveBeenCalled();
    expect(harness.enqueueDurablyForOwner).not.toHaveBeenCalled();
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
    expect(retryHarness.readPendingUpload).toHaveBeenCalledWith(UPLOAD_IDENTITY);
    expect(retryHarness.uploadQueuedAttachment).not.toHaveBeenCalled();
    expect(retryHarness.enqueueDurably).not.toHaveBeenCalled();
    expect(retryHarness.enqueueDurablyForOwner).toHaveBeenCalledWith('user-1', expect.objectContaining({
      operationId: expectedOperationId,
      payload: expect.objectContaining({
        writeIntent: 'task_attachment_update',
        task: expect.objectContaining({
          attachments: [taskWithUploadedAttachment],
        }),
      }),
    }));
    expect(retryHarness.enqueueDurablyForOwner.mock.calls[0]?.[1]?.operationId).toMatch(UUID_PATTERN);
    expect(retryHarness.removePendingUpload).not.toHaveBeenCalled();
    expect(retryHarness.removePendingUploadIfCurrent).not.toHaveBeenCalled();
    expect(retryHarness.settleAttachmentReplayActionForOwner).toHaveBeenCalledTimes(2);
  });
  it('durably restores missing attachment metadata before replaying the upload', async () => {
    const {
      action,
      enqueueDurablyForOwner,
      readPendingUpload,
      removePendingUpload,
      removePendingUploadIfCurrent,
      saveOfflineSnapshotAndWait,
      updateProjects,
      uploadQueuedAttachment,
      updateTask,
      uploadedAttachment,
      currentTask,
      processor,
    } = createAttachmentProcessorHarness({ taskAttachments: [] });
    const result = await processor(action);
    expect(result).toBe(true);
    expect(readPendingUpload).toHaveBeenCalledOnce();
    expect(readPendingUpload).toHaveBeenCalledWith(UPLOAD_IDENTITY);
    expect(saveOfflineSnapshotAndWait).toHaveBeenCalledOnce();
    const persistedProjects = saveOfflineSnapshotAndWait.mock.calls[0]?.[0] as Project[];
    expect(
      persistedProjects
        .find(project => project.id === 'project-1')
        ?.tasks.find(task => task.id === 'task-1')
        ?.attachments,
    ).toEqual([action.payload.attachment]);
    expect(saveOfflineSnapshotAndWait.mock.invocationCallOrder[0]).toBeLessThan(
      updateProjects.mock.invocationCallOrder[0],
    );
    expect(updateProjects.mock.invocationCallOrder[0]).toBeLessThan(
      uploadQueuedAttachment.mock.invocationCallOrder[0],
    );
    expect(uploadQueuedAttachment).toHaveBeenCalledWith(
      action.payload,
      expect.any(Blob),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(updateTask).toHaveBeenCalledWith(
      expect.objectContaining({ attachments: [uploadedAttachment] }),
      'project-1',
    );
    expect(enqueueDurablyForOwner).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ entityType: 'task', entityId: 'task-1' }),
    );
    expect(currentTask()?.attachments).toEqual([uploadedAttachment]);
    expect(removePendingUpload).not.toHaveBeenCalled();
    expect(removePendingUploadIfCurrent).toHaveBeenCalled();
  });
  it('fails closed when durable metadata persistence rejects before replay continues', async () => {
    const {
      action,
      deferRetry,
      removePendingUpload,
      saveOfflineSnapshotAndWait,
      updateProjects,
      uploadQueuedAttachment,
      updateTask,
      currentTask,
      processor,
    } = createAttachmentProcessorHarness({
      taskAttachments: [],
      saveOfflineSnapshotAndWaitImpl: async () => {
        throw new Error('idb write lost');
      },
    });
    const result = await processor(action);
    expect(saveOfflineSnapshotAndWait).toHaveBeenCalledOnce();
    expectAttachmentReplayDeferred(result, 'attachment-task-metadata-pending', {
      attachmentId: 'attachment-1',
      blobKey: 'attachment-1',
      taskId: 'task-1',
    });
    expect(deferRetry).toHaveBeenCalled();
    expect(updateProjects).not.toHaveBeenCalled();
    expect(uploadQueuedAttachment).not.toHaveBeenCalled();
    expect(updateTask).not.toHaveBeenCalled();
    expect(removePendingUpload).not.toHaveBeenCalled();
    expect(currentTask()?.attachments ?? []).toEqual([]);
  });
  it('fails closed when restored metadata cannot be read back after durable persistence', async () => {
    const {
      action,
      deferRetry,
      removePendingUpload,
      saveOfflineSnapshotAndWait,
      updateProjects,
      uploadQueuedAttachment,
      updateTask,
      currentTask,
      processor,
    } = createAttachmentProcessorHarness({
      taskAttachments: [],
      suppressProjectUpdateMutation: true,
    });
    const result = await processor(action);
    expect(saveOfflineSnapshotAndWait).toHaveBeenCalledOnce();
    expect(updateProjects).toHaveBeenCalledOnce();
    expectAttachmentReplayDeferred(result, 'attachment-task-metadata-pending');
    expect(deferRetry).toHaveBeenCalled();
    expect(uploadQueuedAttachment).not.toHaveBeenCalled();
    expect(updateTask).not.toHaveBeenCalled();
    expect(removePendingUpload).not.toHaveBeenCalled();
    expect(currentTask()?.attachments ?? []).toEqual([]);
  });
  it('does not self-heal when the replay owner is no longer current', async () => {
    const {
      action,
      removePendingUpload,
      saveOfflineSnapshotAndWait,
      updateProjects,
      uploadQueuedAttachment,
      updateTask,
      processor,
    } = createAttachmentProcessorHarness({
      currentOwnerUserId: () => 'user-2',
      taskAttachments: [],
    });
    const result = await processor(action);
    expectAttachmentReplayDeferred(result, 'attachment-replay-fence-stale');
    expect(saveOfflineSnapshotAndWait).not.toHaveBeenCalled();
    expect(updateProjects).not.toHaveBeenCalled();
    expect(uploadQueuedAttachment).not.toHaveBeenCalled();
    expect(updateTask).not.toHaveBeenCalled();
    expect(removePendingUpload).not.toHaveBeenCalled();
  });
  it.each([
    ['payload attachment url is not local', 'payload', 'url', 'https://storage.test/not-local'],
    ['payload attachment id is missing', 'payload', 'id', ''],
    ['pending upload owner mismatches', 'pending', 'ownerUserId', 'user-2'],
    ['pending upload attachment id mismatches', 'pending', 'attachmentId', 'attachment-2'],
    ['pending upload blob key mismatches', 'pending', 'blobKey', 'blob-2'],
    ['pending upload file name mismatches', 'pending', 'fileName', 'other.txt'],
    ['pending upload mime type mismatches', 'pending', 'mimeType', 'image/png'],
  ])('defers self-heal without side effects when %s', async (_label, source, key, value) => {
    const harness = createAttachmentProcessorHarness({ taskAttachments: [] });
    if (source === 'payload') harness.action.payload.attachment = { ...harness.action.payload.attachment, [key]: value } as Attachment;
    else harness.readPendingUpload.mockResolvedValueOnce({ ...harness.pendingUploadRecord, [key]: value } as PendingAttachmentUploadRecord);
    const result = await harness.processor(harness.action);
    expectAttachmentReplayDeferred(
      result,
      source === 'payload' && key === 'id'
        ? 'attachment-replay-fence-stale'
        : 'attachment-task-metadata-pending',
    );
    expect(harness.saveOfflineSnapshotAndWait).not.toHaveBeenCalled();
    expect(harness.updateProjects).not.toHaveBeenCalled();
    expect(harness.uploadQueuedAttachment).not.toHaveBeenCalled();
    expect(harness.updateTask).not.toHaveBeenCalled();
    expect(harness.removePendingUpload).not.toHaveBeenCalled();
    expect(harness.currentTask()?.attachments ?? []).toEqual([]);
  });
  it('does not duplicate attachment metadata when replay runs again after self-heal', async () => {
    const harness = createAttachmentProcessorHarness({ taskAttachments: [] });
    const firstResult = await harness.processor(harness.action);
    const secondResult = await harness.processor(harness.action);
    expect(firstResult).toBe(true);
    expect(secondResult).toBe(true);
    expect(harness.saveOfflineSnapshotAndWait).toHaveBeenCalledTimes(1);
    expect(harness.currentTask()?.attachments).toEqual([harness.uploadedAttachment]);
  });
  it('defers follow-up handoff when task update enqueue throws after upload', async () => {
    const {
      action,
      enqueueDurably,
      enqueueDurablyForOwner,
      deferRetry,
      removePendingUpload,
      uploadQueuedAttachment,
      updateTask,
      processor,
    } = createAttachmentProcessorHarness();
    enqueueDurablyForOwner.mockRejectedValueOnce(new Error('idb commit lost'));
    const result = await processor(action);
    expectAttachmentReplayDeferred(result, 'partial-retry-handoff', {
      attachmentId: 'attachment-1',
      blobKey: 'attachment-1',
      taskId: 'task-1',
    });
    expect(uploadQueuedAttachment).toHaveBeenCalledTimes(1);
    expect(updateTask).toHaveBeenCalled();
    expect(enqueueDurably).not.toHaveBeenCalled();
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
      removePendingUploadIfCurrent,
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
    expect(removePendingUpload).not.toHaveBeenCalled();
    expectGuardedPendingUploadRemoval(removePendingUploadIfCurrent);
  });
  it('reclaims the pending Blob and queues remote cleanup when the target task is locally tombstoned', async () => {
    const {
      action,
      deferRetry,
      enqueueCleanupPaths,
      removePendingUpload,
      removePendingUploadIfCurrent,
      uploadQueuedAttachment,
      processor,
    } = createAttachmentProcessorHarness({
      taskMissing: true,
      localTombstoneTimestamp: 1_750_000_000_000,
    });
    const result = await processor(action);
    expect(result).toBe(true);
    // 早前尝试可能已把 Blob 推到远端存储：任务已删除时必须入队远端清理回收孤儿对象
    expect(enqueueCleanupPaths).toHaveBeenCalledWith(
      ['user-1/project-1/task-1/attachment-1.txt'],
      { ownerUserId: 'user-1', operationId: 'operation-1' },
    );
    expect(removePendingUpload).not.toHaveBeenCalled();
    expectGuardedPendingUploadRemoval(removePendingUploadIfCurrent);
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
    expectAttachmentReplayDeferred(result, 'attachment-task-metadata-pending');
    expect(removePendingUpload).not.toHaveBeenCalled();
  });
  it('still defers while the task is missing without a tombstone so backup-restore races keep the Blob', async () => {
    const {
      action,
      deferRetry,
      enqueueCleanupPaths,
      removePendingUpload,
      saveOfflineSnapshotAndWait,
      updateProjects,
      processor,
    } = createAttachmentProcessorHarness({ taskMissing: true });
    const result = await processor(action);
    expectAttachmentReplayDeferred(result, 'attachment-task-metadata-pending');
    expect(deferRetry).toHaveBeenCalled();
    expect(enqueueCleanupPaths).not.toHaveBeenCalled();
    expect(saveOfflineSnapshotAndWait).not.toHaveBeenCalled();
    expect(updateProjects).not.toHaveBeenCalled();
    expect(removePendingUpload).not.toHaveBeenCalled();
  });
});
