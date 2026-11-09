import { DestroyRef, Injector } from '@angular/core';
import { expect, it, vi } from 'vitest';
import { SCAN_STATUS } from '../config/virus-scan.config';
import type { Attachment, Project, Task } from '../models';
import { ProjectDataService, TombstoneService } from '../core-bridge';
import { ActionQueueAttachmentProcessorsService } from './action-queue-attachment-processors.service';
import { ActionQueueService } from './action-queue.service';
import type { QueueProcessor, QueueProcessorContext } from './action-queue-processing.types';
import type { AttachmentUploadPayload, QueuedAction } from './action-queue.types';
import { AttachmentCleanupOutboxService } from './attachment-cleanup-outbox.service';
import { FileTypeValidatorService } from './file-type-validator.service';
import { LoggerService } from './logger.service';
import { AttachmentService } from './attachment.service';
import {
  AttachmentUploadOutboxService,
  type PendingAttachmentUploadIdentity,
  type PendingAttachmentUploadRecord,
} from './attachment-upload-outbox.service';
import { AuthService } from './auth.service';
import { ProjectStateService } from './project-state.service';
import { SessionRuntimeResetRegistry } from './session-runtime-reset.service';
import { SupabaseClientService } from './supabase-client.service';
import { UserSessionService } from './user-session.service';
import { VirusScanService } from './virus-scan.service';

export type QueuedAttachmentUploadBarrier = 'scan' | 'upload' | 'signed-url' | 'thumbnail-url';

export function expectAttachmentReplayDeferred(
  result: unknown,
  reason: string,
  details: Record<string, unknown> = {},
): void {
  expect(result).toEqual({
    outcome: 'defer-retry',
    error: expect.objectContaining({
      code: 'SYNC_RETRY_HANDOFF_PENDING',
      details: expect.objectContaining({ reason, ...details }),
    }),
  });
}

export function createQueuedAttachmentUploadBarrierHarness(barrier: QueuedAttachmentUploadBarrier) {
  let releaseBarrier: () => void = () => undefined;
  const barrierPromise = new Promise<void>(resolve => {
    releaseBarrier = resolve;
  });
  const reachedBarrier = vi.fn();
  const waitAtBarrier = async (stage: QueuedAttachmentUploadBarrier): Promise<void> => {
    if (stage !== barrier) return;
    reachedBarrier(stage);
    await barrierPromise;
  };
  const scanBeforeUpload = vi.fn(async () => {
    await waitAtBarrier('scan');
    return {
      success: true,
      result: {
        fileId: 'scan-1',
        fileHash: 'hash-1',
        status: SCAN_STATUS.CLEAN,
        scannedAt: '2026-06-13T00:00:00.000Z',
        scanner: 'test',
      },
    };
  });
  const upload = vi.fn(async () => {
    await waitAtBarrier('upload');
    return { data: { path: 'uploaded' }, error: null };
  });
  let signedUrlCall = 0;
  const createSignedUrl = vi.fn(async () => {
    signedUrlCall += 1;
    await waitAtBarrier(signedUrlCall === 1 ? 'signed-url' : 'thumbnail-url');
    return {
      data: { signedUrl: `https://storage.test/signed-${signedUrlCall}` },
      error: null,
    };
  });
  const remove = vi.fn().mockResolvedValue({ data: [], error: null });
  const bucket = { upload, createSignedUrl, remove };
  const client = vi.fn(() => ({ storage: { from: vi.fn(() => bucket) } }));
  const service = Injector.create({
    providers: [
      { provide: AttachmentService, useClass: AttachmentService },
      { provide: SupabaseClientService, useValue: { isConfigured: true, client } },
      {
        provide: LoggerService,
        useValue: {
          category: () => ({
            debug: vi.fn(),
            error: vi.fn(),
            info: vi.fn(),
            warn: vi.fn(),
          }),
        },
      },
      { provide: FileTypeValidatorService, useValue: { validateFile: vi.fn() } },
      {
        provide: VirusScanService,
        useValue: {
          scanBeforeUpload,
          createScanMetadata: vi.fn(() => ({ scanStatus: SCAN_STATUS.CLEAN })),
        },
      },
      { provide: ActionQueueService, useValue: { enqueueDurably: vi.fn() } },
      { provide: AttachmentUploadOutboxService, useValue: { savePendingUpload: vi.fn() } },
      {
        provide: AttachmentCleanupOutboxService,
        useValue: { enqueuePaths: vi.fn(), removePendingCleanups: vi.fn() },
      },
      { provide: DestroyRef, useValue: { onDestroy: vi.fn() } },
    ],
  }).get(AttachmentService);
  const payload: AttachmentUploadPayload = {
    attachment: {
      id: 'attachment-1',
      type: 'image',
      name: 'image.png',
      url: 'nanoflow-local-attachment://attachment-1',
      createdAt: '2026-06-13T00:00:00.000Z',
    },
    blobKey: 'attachment-1',
    fileName: 'image.png',
    mimeType: 'image/png',
    projectId: 'project-1',
    taskId: 'task-1',
    userId: 'user-1',
    sourceUserId: 'user-1',
  };
  return {
    payload,
    reachedBarrier,
    releaseBarrier,
    remove,
    service,
  };
}

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const UPLOAD_IDENTITY = {
  ownerUserId: 'user-1',
  blobKey: 'attachment-1',
  operationId: 'operation-1',
} as const;

export type AttachmentProcessorHarnessOptions = {
  enqueueDurablyResult?: string;
  uploadOutbox?: AttachmentUploadOutboxService;
  pendingUpload?: PendingAttachmentUploadRecord | null;
  pendingUploads?: Array<PendingAttachmentUploadRecord & { recovery?: unknown }>;
  listPendingUploadsImpl?: (
    ownerUserId?: string,
  ) => Promise<Array<PendingAttachmentUploadRecord & { recovery?: unknown }>>;
  currentOwnerUserId?: () => string | null;
  saveOfflineSnapshotAndWaitImpl?: (
    projects: Project[],
    ownerUserId?: string | null,
  ) => Promise<void>;
  suppressProjectUpdateMutation?: boolean;
  taskAttachments?: Attachment[];
  taskMissing?: boolean;
  localTombstoneTimestamp?: number;
};

export function createAttachmentProcessorHarness(options: AttachmentProcessorHarnessOptions = {}) {
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
  let currentProjects: Project[] = [{
    id: 'project-1',
    name: 'Project',
    description: '',
    createdDate: '2026-06-13T00:00:00.000Z',
    tasks: options.taskMissing ? [] : [task],
    connections: [],
    updatedAt: '2026-06-13T00:00:00.000Z',
    syncSource: 'synced',
  }];
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
  const enqueueDurablyForOwner = vi.fn().mockResolvedValue(
    options.enqueueDurablyResult ?? 'recovered-attachment-action',
  );
  const deferRetry = vi.fn(error => ({ outcome: 'defer-retry' as const, error }));
  const settleAttachmentReplayActionForOwner = vi.fn().mockImplementation(
    async (_ownerUserId: string, input: { mode: string }) => input.mode === 'verify-task-update'
      ? { status: 'current' }
      : { status: 'committed' },
  );
  const pendingUploadRecord: PendingAttachmentUploadRecord = {
    ownerUserId: 'user-1',
    operationId: 'operation-1',
    attachmentId: 'attachment-1',
    blobKey: 'attachment-1',
    fileName: 'note.txt',
    mimeType: 'text/plain',
    size: 7,
    blob: new Blob(['pending'], { type: 'text/plain' }),
    createdAt: '2026-06-13T00:00:00.000Z',
    recovery: { operationId: action.operationId, payload: action.payload },
  };
  const readPendingUpload = vi.fn().mockResolvedValue(
    'pendingUpload' in options ? options.pendingUpload : pendingUploadRecord,
  );
  const readPendingUploadStrictly = vi.fn(async (identity: PendingAttachmentUploadIdentity) => {
    const record = await readPendingUpload(identity);
    return record ? { status: 'found' as const, record } : { status: 'missing' as const };
  });
  const listPendingUploads = options.listPendingUploadsImpl
    ? vi.fn(options.listPendingUploadsImpl)
    : vi.fn().mockResolvedValue(options.pendingUploads ?? []);
  const removePendingUpload = vi.fn().mockResolvedValue(undefined);
  const removePendingUploadIfCurrent = vi.fn().mockResolvedValue({ status: 'removed' });
  const matchesPendingUploadForReplay = vi.fn((
    record: PendingAttachmentUploadRecord,
    operationId: string,
    replayPayload: AttachmentUploadPayload,
  ) => new AttachmentUploadOutboxService()
    .matchesPendingUploadForReplay(record, operationId, replayPayload));
  const uploadQueuedAttachment = vi.fn().mockResolvedValue(uploadedAttachment);
  const updateTask = vi.fn((nextTask: Task, projectId?: string) => {
    currentProjects = currentProjects.map(project => project.id !== (projectId ?? 'project-1')
      ? project
      : { ...project, tasks: project.tasks.map(item => item.id === nextTask.id ? nextTask : item) });
  });
  const updateProjects = vi.fn((updater: (projects: Project[]) => Project[]) => {
    const nextProjects = updater(currentProjects);
    if (!options.suppressProjectUpdateMutation) currentProjects = nextProjects;
  });
  const getTask = vi.fn((taskId: string) =>
    currentProjects.flatMap(project => project.tasks).find(item => item.id === taskId));
  const getProjectWithCurrentData = vi.fn((projectId: string) =>
    currentProjects.find(project => project.id === projectId));
  const getProjectsWithCurrentData = vi.fn(() => currentProjects);
  const enqueueCleanupPaths = vi.fn().mockResolvedValue(undefined);
  const getLocalTombstoneTimestamp = vi.fn(() => options.localTombstoneTimestamp);
  const saveOfflineSnapshotAndWait = options.saveOfflineSnapshotAndWaitImpl
    ? vi.fn(options.saveOfflineSnapshotAndWaitImpl)
    : vi.fn().mockResolvedValue(undefined);
  const resetCallbacks = new Set<(reason: 'owner-change' | 'clear-local-data') => void>();
  const sessionRuntimeReset = {
    register: vi.fn((
      _owner: string,
      callback: (reason: 'owner-change' | 'clear-local-data') => void,
    ) => {
      resetCallbacks.add(callback);
      return () => resetCallbacks.delete(callback);
    }),
    resetAll: vi.fn((reason: 'owner-change' | 'clear-local-data') => {
      for (const callback of Array.from(resetCallbacks)) callback(reason);
    }),
  };
  const currentUserId = vi.fn(options.currentOwnerUserId ?? (() => 'user-1'));
  let authFence = 'auth-fence-1';
  let sessionGeneration = 1;
  let queueGeneration = 1;
  let projectGeneration = 1;
  const captureAuthIdentityFence = vi.fn(() => authFence);
  const getCurrentSessionGeneration = vi.fn(() => sessionGeneration);
  const isSessionContextCurrent = vi.fn((generation: number, ownerUserId: string) =>
    generation === sessionGeneration && currentUserId() === ownerUserId);
  const getCurrentQueueViewGeneration = vi.fn(() => queueGeneration);
  const isQueueViewCurrent = vi.fn((generation: number, ownerUserId: string) =>
    generation === queueGeneration && currentUserId() === ownerUserId);
  const getProjectMutationViewGeneration = vi.fn(() => projectGeneration);
  const leaseController = new AbortController();
  const injector = Injector.create({
    providers: [
      { provide: ActionQueueAttachmentProcessorsService, useClass: ActionQueueAttachmentProcessorsService },
      {
        provide: ActionQueueService,
        useValue: {
          registerProcessor,
          enqueueDurably,
          enqueueDurablyForOwner,
          deferRetry,
          settleAttachmentReplayActionForOwner,
          getCurrentQueueViewGeneration,
          isQueueViewCurrent,
          getProjectMutationViewGeneration,
        },
      },
      {
        provide: AttachmentUploadOutboxService,
        useValue: options.uploadOutbox ?? {
          listPendingUploads,
          readPendingUpload,
          readPendingUploadStrictly,
          removePendingUpload,
          removePendingUploadIfCurrent,
          matchesPendingUploadForReplay,
        },
      },
      { provide: ProjectDataService, useValue: { saveOfflineSnapshotAndWait } },
      { provide: AuthService, useValue: { currentUserId, captureAuthIdentityFence } },
      { provide: UserSessionService, useValue: { getCurrentSessionGeneration, isSessionContextCurrent } },
      { provide: SessionRuntimeResetRegistry, useValue: sessionRuntimeReset },
      { provide: AttachmentCleanupOutboxService, useValue: { enqueuePaths: enqueueCleanupPaths } },
      { provide: AttachmentService, useValue: { uploadQueuedAttachment } },
      {
        provide: ProjectStateService,
        useValue: {
          getTask,
          getProjectWithCurrentData,
          getProjectsWithCurrentData,
          updateProjects,
          updateTask,
        },
      },
      { provide: TombstoneService, useValue: { getLocalTombstoneTimestamp } },
    ],
  });
  const service = injector.get(ActionQueueAttachmentProcessorsService);
  service.setupProcessors();
  const registeredProcessor = registerProcessor.mock.calls[0]?.[1] as QueueProcessor;
  const processor = (
    queued: QueuedAction = action,
    context: QueueProcessorContext = { leaseSignal: leaseController.signal },
  ) => registeredProcessor(queued, context);
  return {
    action,
    payload,
    pendingUploadRecord,
    readPendingUpload,
    uploadedAttachment,
    enqueueDurably,
    enqueueDurablyForOwner,
    deferRetry,
    listPendingUploads,
    removePendingUpload,
    removePendingUploadIfCurrent,
    uploadQueuedAttachment,
    updateTask,
    enqueueCleanupPaths,
    getLocalTombstoneTimestamp,
    injector,
    getTask,
    updateProjects,
    saveOfflineSnapshotAndWait,
    sessionRuntimeReset,
    settleAttachmentReplayActionForOwner,
    leaseController,
    registeredProcessor,
    setAuthFence: (value: string) => { authFence = value; },
    advanceSessionGeneration: () => { sessionGeneration += 1; },
    advanceQueueGeneration: () => { queueGeneration += 1; },
    advanceProjectGeneration: () => { projectGeneration += 1; },
    currentTask: () => getTask('task-1') as Task | undefined,
    processor,
  };
}

export function createDeferredAttachmentProcessorHarness(
  options: AttachmentProcessorHarnessOptions = {},
) {
  let resolveUpload: (attachment: Attachment) => void = () => undefined;
  const harness = createAttachmentProcessorHarness(options);
  harness.uploadQueuedAttachment.mockReturnValueOnce(new Promise(resolve => {
    resolveUpload = resolve;
  }));
  return { harness, resolveUpload };
}

export function expectGuardedPendingUploadRemoval(
  removePendingUploadIfCurrent: ReturnType<typeof vi.fn>,
): void {
  expect(removePendingUploadIfCurrent).toHaveBeenCalledWith(
    expect.objectContaining(UPLOAD_IDENTITY),
    expect.any(Object),
  );
}

export function registerAttachmentReplaySettlementFenceSpecs(): void {
  it('removes the retained Blob when an existing-upload retry durably recovers B after restart', async () => {
    const outbox = Injector.create({
      providers: [{ provide: AttachmentUploadOutboxService, useClass: AttachmentUploadOutboxService }],
    }).get(AttachmentUploadOutboxService);
    await outbox.clearPendingUploadsForTests();

    try {
      const first = createAttachmentProcessorHarness({ uploadOutbox: outbox });
      await outbox.savePendingUpload({
        ...first.pendingUploadRecord,
        recovery: {
          operationId: first.action.operationId,
          payload: first.action.payload,
        },
      });
      first.enqueueDurablyForOwner.mockRejectedValueOnce(new Error('B commit failed'));

      const firstResult = await first.processor(first.action);

      expectAttachmentReplayDeferred(firstResult, 'partial-retry-handoff');
      await expect(outbox.readPendingUpload(UPLOAD_IDENTITY)).resolves.toEqual(
        expect.objectContaining(UPLOAD_IDENTITY),
      );
      const uploadedAttachment = first.currentTask()?.attachments?.[0];
      if (!uploadedAttachment) throw new Error('expected uploaded attachment after the first attempt');

      const failingReadOutbox = Injector.create({
        providers: [{ provide: AttachmentUploadOutboxService, useClass: AttachmentUploadOutboxService }],
      }).get(AttachmentUploadOutboxService);
      const getSpy = vi.spyOn(IDBObjectStore.prototype, 'get').mockImplementationOnce(() => {
        throw new DOMException('outbox read failed', 'UnknownError');
      });
      try {
        const failedRetry = createAttachmentProcessorHarness({
          uploadOutbox: failingReadOutbox,
          taskAttachments: [uploadedAttachment],
        });
        const failedResult = await failedRetry.processor(failedRetry.action);

        expectAttachmentReplayDeferred(failedResult, 'partial-retry-handoff');
        expect(failedRetry.settleAttachmentReplayActionForOwner).toHaveBeenCalledOnce();
      } finally {
        getSpy.mockRestore();
      }
      await expect(failingReadOutbox.readPendingUpload(UPLOAD_IDENTITY)).resolves.toEqual(
        expect.objectContaining(UPLOAD_IDENTITY),
      );

      const reopenedOutbox = Injector.create({
        providers: [{ provide: AttachmentUploadOutboxService, useClass: AttachmentUploadOutboxService }],
      }).get(AttachmentUploadOutboxService);
      const retry = createAttachmentProcessorHarness({
        uploadOutbox: reopenedOutbox,
        taskAttachments: [uploadedAttachment],
      });

      await expect(retry.processor(retry.action)).resolves.toBe(true);
      await expect(reopenedOutbox.readPendingUpload(UPLOAD_IDENTITY)).resolves.toBeNull();
      expect(retry.uploadQueuedAttachment).not.toHaveBeenCalled();
      expect(retry.settleAttachmentReplayActionForOwner).toHaveBeenCalledTimes(2);
    } finally {
      await outbox.clearPendingUploadsForTests();
    }
  });

  it('settles A after exact fallback-only Blob cleanup while IndexedDB remains unavailable', async () => {
    const outbox = Injector.create({
      providers: [{ provide: AttachmentUploadOutboxService, useClass: AttachmentUploadOutboxService }],
    }).get(AttachmentUploadOutboxService);
    await outbox.clearPendingUploadsForTests();

    try {
      const fixture = createAttachmentProcessorHarness();
      const storageKey = `v2:${JSON.stringify([
        UPLOAD_IDENTITY.ownerUserId,
        UPLOAD_IDENTITY.blobKey,
        UPLOAD_IDENTITY.operationId,
      ])}`;
      localStorage.setItem(
        `nanoflow.attachment-upload-outbox.v2.${encodeURIComponent(storageKey)}`,
        JSON.stringify({
          ...fixture.pendingUploadRecord,
          blob: undefined,
          blobBase64: btoa('pending'),
        }),
      );
      const openSpy = vi.spyOn(indexedDB, 'open').mockImplementation(() => {
        throw new DOMException('outbox IDB unavailable', 'UnknownError');
      });
      try {
        const retry = createAttachmentProcessorHarness({
          uploadOutbox: outbox,
          taskAttachments: [fixture.uploadedAttachment],
        });

        await expect(retry.processor(retry.action)).resolves.toBe(true);
        expect(retry.uploadQueuedAttachment).not.toHaveBeenCalled();
        expect(retry.settleAttachmentReplayActionForOwner).toHaveBeenCalledTimes(2);
      } finally {
        openSpy.mockRestore();
      }
      await expect(outbox.readPendingUpload(UPLOAD_IDENTITY)).resolves.toBeNull();
    } finally {
      await outbox.clearPendingUploadsForTests();
    }
  });

  it('retains A and Blob when the queue fence drifts during durable B enqueue', async () => {
    let resolveEnqueue: (actionId: string) => void = () => undefined;
    const harness = createAttachmentProcessorHarness();
    harness.enqueueDurablyForOwner.mockReturnValueOnce(new Promise(resolve => {
      resolveEnqueue = resolve;
    }));
    const processing = harness.processor(harness.action);
    await vi.waitFor(() => expect(harness.enqueueDurablyForOwner).toHaveBeenCalledOnce());
    harness.advanceQueueGeneration();
    resolveEnqueue('recovered-attachment-action');

    const result = await processing;

    expectAttachmentReplayDeferred(result, 'attachment-replay-fence-stale');
    expect(harness.settleAttachmentReplayActionForOwner).not.toHaveBeenCalled();
    expect(harness.removePendingUploadIfCurrent).not.toHaveBeenCalled();
  });

  it('retains A and Blob when the session drifts during strict B readback', async () => {
    let resolveReadback: (result: { status: 'current' }) => void = () => undefined;
    const harness = createAttachmentProcessorHarness();
    harness.settleAttachmentReplayActionForOwner.mockReturnValueOnce(new Promise(resolve => {
      resolveReadback = resolve;
    }));
    const processing = harness.processor(harness.action);
    await vi.waitFor(() => expect(harness.settleAttachmentReplayActionForOwner).toHaveBeenCalledOnce());
    harness.advanceSessionGeneration();
    resolveReadback({ status: 'current' });

    const result = await processing;

    expectAttachmentReplayDeferred(result, 'attachment-replay-fence-stale');
    expect(harness.removePendingUploadIfCurrent).not.toHaveBeenCalled();
    expect(harness.settleAttachmentReplayActionForOwner).toHaveBeenCalledOnce();
  });

  it('does not settle A when the project fence drifts during guarded Blob removal', async () => {
    let resolveRemoval: (result: { status: 'removed' }) => void = () => undefined;
    const harness = createAttachmentProcessorHarness();
    harness.removePendingUploadIfCurrent.mockReturnValueOnce(new Promise(resolve => {
      resolveRemoval = resolve;
    }));
    const processing = harness.processor(harness.action);
    await vi.waitFor(() => expect(harness.removePendingUploadIfCurrent).toHaveBeenCalledOnce());
    harness.advanceProjectGeneration();
    resolveRemoval({ status: 'removed' });

    const result = await processing;

    expectAttachmentReplayDeferred(result, 'attachment-replay-fence-stale');
    expect(harness.settleAttachmentReplayActionForOwner).toHaveBeenCalledOnce();
  });

  it('does not acknowledge A when its exact settlement loses the writer lease', async () => {
    let resolveSettlement: (result: { status: 'committed' }) => void = () => undefined;
    const harness = createAttachmentProcessorHarness();
    harness.settleAttachmentReplayActionForOwner
      .mockResolvedValueOnce({ status: 'current' })
      .mockReturnValueOnce(new Promise(resolve => {
        resolveSettlement = resolve;
      }));
    const processing = harness.processor(harness.action);
    await vi.waitFor(() => expect(harness.settleAttachmentReplayActionForOwner).toHaveBeenCalledTimes(2));
    harness.leaseController.abort();
    resolveSettlement({ status: 'committed' });

    const result = await processing;

    expectAttachmentReplayDeferred(result, 'attachment-replay-fence-stale');
  });
}
