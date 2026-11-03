import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ActionQueueStorageService } from '../../../../services/action-queue-storage.service';
import { AttachmentUploadOutboxService } from '../../../../services/attachment-upload-outbox.service';
import { AuthService } from '../../../../services/auth.service';
import { ConflictStorageService } from '../../../../services/conflict-storage.service';
import type { ExportData } from '../../../../services/export.service';
import { ImportService } from '../../../../services/import.service';
import { LocalBackupService } from '../../../../services/local-backup.service';
import { LoggerService } from '../../../../services/logger.service';
import { QueueBackupService } from '../../../../services/queue-backup.service';
import { RetryQueueService } from '../../../core/services/sync/retry-queue.service';
import { BackupDataSafetyMetadataRestoreService } from '../../../../services/backup-data-safety-metadata-restore.service';
import { DisasterBackupService } from '../../../../services/disaster-backup.service';
import {
  createLocalBackupUiRestoreStageOperations,
  LocalBackupUiRestoreStageService,
} from '../../../../services/local-backup-ui-restore-stage.service';
import { LocalBackupUiRestoreTransactionService } from '../../../../services/local-backup-ui-restore-transaction.service';
import type {
  LocalBackupUiRestoreProtocolRuntime,
  LocalBackupUiRestoreStageOperationContext,
  LocalBackupUiRestoreStageOperations,
  LocalBackupUiRestoreStageProtocolResult,
} from '../../../../services/local-backup-ui-restore-stage-protocol';
import { runLocalBackupUiRestoreStageProtocol } from '../../../../services/local-backup-ui-restore-stage-protocol';
import type { LocalBackupUiRestoreMarker } from '../../../../services/local-backup-ui-restore-types';
import type { BackupData } from '../../../../../supabase/functions/_shared/backup-utils';
import { LocalBackupUIService } from './local-backup-ui.service';

describe('LocalBackupUIService restore race boundaries', () => {
  const localBackup = {
    listBackupFiles: vi.fn(),
    readBackupFile: vi.fn(),
  };
  const importService = {
    validateFile: vi.fn(),
    generatePreview: vi.fn(),
    executeImport: vi.fn(),
  };
  const attachmentOutbox = { savePendingUpload: vi.fn() };
  const queueBackup = { updateQueue: vi.fn() };
  const auth = { currentUserId: vi.fn(), captureAuthIdentityFence: vi.fn() };
  const retryQueue = { restoreFromBackupItems: vi.fn() };
  const actionQueueStorage = { restoreDeadLettersFromBackupItems: vi.fn() };
  const conflictStorage = { saveConflict: vi.fn() };
  const metadataRestore = { preview: vi.fn(), restore: vi.fn() };
  const disasterBackup = { buildLocalBlob: vi.fn() };
  const preparedRestoreRun = vi.fn();
  const actionQueueRestore = {
    confirmPrepared: vi.fn(),
    rollback: vi.fn(),
  };
  const restoreTransaction = { prepare: vi.fn() };
  const restoreStages = { createOperations: vi.fn() };
  const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    auth.currentUserId.mockReturnValue('user-1');
    auth.captureAuthIdentityFence.mockReturnValue('auth-fence-a');
    importService.executeImport.mockResolvedValue({ success: true, importedCount: 1 });
    queueBackup.updateQueue.mockImplementation(async (_ownerUserId, updater) =>
      updater([], { recordFound: false })
    );
    retryQueue.restoreFromBackupItems.mockResolvedValue(0);
    actionQueueStorage.restoreDeadLettersFromBackupItems.mockReturnValue(0);
    conflictStorage.saveConflict.mockResolvedValue(true);
    metadataRestore.preview.mockResolvedValue({
      ownerUserId: 'user-1',
      target: {},
      counts: {
        projectCursors: 0,
        lastSyncTime: 0,
        replayLog: 0,
        lastWriteExplain: 0,
        taskTombstones: 0,
        connectionTombstones: 0,
      },
    });
    metadataRestore.restore.mockResolvedValue({
      projectCursors: 0,
      lastSyncTime: 0,
      replayLog: 0,
      lastWriteExplain: 0,
      taskTombstones: 0,
      connectionTombstones: 0,
    });
    preparedRestoreRun.mockResolvedValue({ status: 'completed', stageResults: { projects: 1 } });
    restoreTransaction.prepare.mockResolvedValue({
      verifyOwnership: vi.fn().mockResolvedValue(true),
      run: preparedRestoreRun,
      abortBeforeMutation: vi.fn().mockResolvedValue(undefined),
      actionQueueRestore,
    });
    restoreStages.createOperations.mockReturnValue({});
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        LocalBackupUIService,
        { provide: LocalBackupService, useValue: localBackup },
        { provide: ImportService, useValue: importService },
        { provide: AttachmentUploadOutboxService, useValue: attachmentOutbox },
        { provide: QueueBackupService, useValue: queueBackup },
        { provide: AuthService, useValue: auth },
        { provide: RetryQueueService, useValue: retryQueue },
        { provide: ActionQueueStorageService, useValue: actionQueueStorage },
        { provide: ConflictStorageService, useValue: conflictStorage },
        { provide: BackupDataSafetyMetadataRestoreService, useValue: metadataRestore },
        { provide: DisasterBackupService, useValue: disasterBackup },
        { provide: LocalBackupUiRestoreTransactionService, useValue: restoreTransaction },
        { provide: LocalBackupUiRestoreStageService, useValue: restoreStages },
        { provide: LoggerService, useValue: logger },
      ],
    });
  });

  it('captures one immutable byte snapshot for hashing, validation, parsing, and restore identity', async () => {
    const backup = createBackupData({
      dataSafety: { ownerUserId: 'user-1' },
      actionQueue: [makeQueuedAction()],
    } as BackupData['localState']);
    const file = createBackupFile(backup);
    const bytes = await file.arrayBuffer();
    const expectedDigest = await sha256Digest(bytes);
    const arrayBuffer = vi.spyOn(file, 'arrayBuffer');
    const text = vi.spyOn(file, 'text');
    importService.validateFile.mockImplementation(async snapshot => {
      expect(snapshot).not.toBe(file);
      expect(await snapshot.text()).toBe(new TextDecoder().decode(bytes));
      return { valid: true, data: createExportData() };
    });
    importService.generatePreview.mockResolvedValue({
      projects: [{ taskCount: 0, connectionCount: 0 }],
    });
    const service = TestBed.inject(LocalBackupUIService);

    await service.loadRestorePreviewFromFile(file, []);
    await service.confirmRestore([]);

    expect(arrayBuffer).toHaveBeenCalledTimes(1);
    expect(text).not.toHaveBeenCalled();
    expect(restoreTransaction.prepare).toHaveBeenCalledWith(expect.objectContaining({
      source: expect.objectContaining({ checksum: expectedDigest }),
      restoredActionQueueItems: [expect.objectContaining({
        operationId: makeQueuedAction().operationId,
      })],
    }));
    expect(restoreStages.createOperations).toHaveBeenCalledWith(expect.objectContaining({
      actionQueueRestore,
    }));
  });
  it('preview 后 owner 切换时不得开始导入', async () => {
    const service = TestBed.inject(LocalBackupUIService);
    await preparePreview(service);

    auth.currentUserId.mockReturnValue('user-2');
    await service.confirmRestore([]);

    expect(restoreTransaction.prepare).not.toHaveBeenCalled();
    expect(importService.executeImport).not.toHaveBeenCalled();
  });

  it('preview 后 A-B-A auth rotation 不得复用旧恢复上下文', async () => {
    const service = TestBed.inject(LocalBackupUIService);
    await preparePreview(service);

    auth.currentUserId.mockReturnValue('user-2');
    auth.captureAuthIdentityFence.mockReturnValue('auth-fence-b');
    auth.currentUserId.mockReturnValue('user-1');
    auth.captureAuthIdentityFence.mockReturnValue('auth-fence-c');
    await service.confirmRestore([]);

    expect(restoreTransaction.prepare).not.toHaveBeenCalled();
    expect(preparedRestoreRun).not.toHaveBeenCalled();
    expect(service.restoreStep()).toBe('error');
  });

  it('A-B-A auth rotation suppresses a late prepare rejection from stale UI and logs', async () => {
    const service = TestBed.inject(LocalBackupUIService);
    await preparePreview(service);
    let rejectPrepare!: (error: Error) => void;
    restoreTransaction.prepare.mockReturnValueOnce(new Promise((_, reject) => {
      rejectPrepare = reject;
    }));

    const pending = service.confirmRestore([]);
    await vi.waitFor(() => expect(restoreTransaction.prepare).toHaveBeenCalledTimes(1));
    auth.currentUserId.mockReturnValue('user-2');
    auth.captureAuthIdentityFence.mockReturnValue('auth-fence-b');
    auth.currentUserId.mockReturnValue('user-1');
    auth.captureAuthIdentityFence.mockReturnValue('auth-fence-c');
    rejectPrepare(new Error('late prepare failure'));
    await pending;

    expect(logger.error).not.toHaveBeenCalled();
    expect(service.restoreError()).toBe('');
    expect(service.restoreStep()).not.toBe('error');
  });

  it.each(['owner-switch', 'A-B-A-auth'] as const)(
    'real stage mutation gate blocks %s before the durable callback and stale UI publication',
    async scenario => {
    const service = TestBed.inject(LocalBackupUIService);
    await preparePreview(service, createAttachmentBackup(), createExportData(2));
    const stageEntered = deferred<void>();
    const continueStage = deferred<void>();
    const durableMutation = vi.fn(async () => 2);
    const rollbackMutation = vi.fn(async () => undefined);
    const stageApply = vi.fn(async (context: LocalBackupUiRestoreStageOperationContext) => {
      stageEntered.resolve(undefined);
      await continueStage.promise;
      return await context.runWriterMutationAsync('external-source', durableMutation);
    });
    restoreStages.createOperations.mockImplementation(input => (
      createLocalBackupUiRestoreStageOperations(input, {
        decodePreImage: () => ({} as never),
        effects: { projects: {
          apply: stageApply,
          read: vi.fn(async () => ({})),
          restore: vi.fn(async (_snapshot, context) => {
            await context.runWriterMutationAsync('external-source', rollbackMutation);
          }),
        } } as never,
      })
    ));
    let marker = makeStageMarker();
    const runtime: LocalBackupUiRestoreProtocolRuntime = {
      marker: () => marker,
      verifyOwnership: vi.fn(async () => true),
      transition: vi.fn(async update => (marker = update(marker))),
      runWriterMutation: (_source, write) => write(),
      runWriterMutationAsync: (_source, write) => write(),
      drainWriters: vi.fn(async () => undefined),
      abortBeforeMutation: vi.fn(async () => undefined),
      finalize: vi.fn(async () => undefined),
    };
    restoreTransaction.prepare.mockResolvedValueOnce({
      actionQueueRestore,
      abortBeforeMutation: vi.fn(async () => undefined),
      run: async (operations: LocalBackupUiRestoreStageOperations) => {
        return await runLocalBackupUiRestoreStageProtocol(runtime, operations);
      },
    });

    const pending = service.confirmRestore([]);
    await stageEntered.promise;
    if (scenario === 'owner-switch') auth.currentUserId.mockReturnValue('user-2');
    else auth.captureAuthIdentityFence.mockReturnValue('auth-fence-c');
    continueStage.resolve(undefined);
    await pending;

    expect(stageApply).toHaveBeenCalledTimes(1);
    expect(durableMutation).not.toHaveBeenCalled();
    expect(rollbackMutation).not.toHaveBeenCalled();
    expect(importService.executeImport).not.toHaveBeenCalled();
    expect(attachmentOutbox.savePendingUpload).not.toHaveBeenCalled();
    expect(metadataRestore.restore).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
    expect(service.restoreError()).toBe('');
    expect(service.restoreStep()).not.toBe('error');
    },
  );

  it('并发 confirm 应合流且保留首轮 stage backup 上下文', async () => {
    const service = TestBed.inject(LocalBackupUIService);
    const backup = createAttachmentBackup();
    await preparePreview(service, backup);
    const protocolResult = deferred<LocalBackupUiRestoreStageProtocolResult>();
    preparedRestoreRun.mockReturnValueOnce(protocolResult.promise);

    const first = service.confirmRestore([]);
    await vi.waitFor(() => expect(preparedRestoreRun).toHaveBeenCalledTimes(1));
    const second = service.confirmRestore([]);
    protocolResult.resolve({
      status: 'completed',
      stageResults: { projects: 1, 'attachment-outbox': 1 },
    });
    await Promise.all([first, second]);

    expect(restoreTransaction.prepare).toHaveBeenCalledTimes(1);
    expect(restoreStages.createOperations).toHaveBeenCalledWith(expect.objectContaining({
      backup,
    }));
    expect(importService.executeImport).not.toHaveBeenCalled();
    expect(service.restoreResultMsg()).toContain('已恢复 1 个待上传附件');
  });

  it('取消文件列表后迟到结果不得离开 idle', async () => {
    const files = deferred<{ name: string; timestamp: number; size: number }[]>();
    localBackup.listBackupFiles.mockReturnValueOnce(files.promise);
    const service = TestBed.inject(LocalBackupUIService);

    const pending = service.handleRestoreFromLocalBackup();
    await vi.waitFor(() => expect(localBackup.listBackupFiles).toHaveBeenCalledTimes(1));
    service.cancelRestore();
    files.resolve([{ name: 'backup.json', timestamp: 1, size: 1 }]);
    await pending;

    expect(service.restoreStep()).toBe('idle');
    expect(service.restoreBackupFiles()).toEqual([]);
  });

  it('取消 preview 后迟到文件读取不得回填 preview 或 pending context', async () => {
    const fileRead = deferred<File | null>();
    localBackup.listBackupFiles.mockResolvedValue([{ name: 'backup.json', timestamp: 1, size: 1 }]);
    localBackup.readBackupFile.mockReturnValueOnce(fileRead.promise);
    importService.validateFile.mockResolvedValue({ valid: true, data: createExportData() });
    importService.generatePreview.mockResolvedValue({ projects: [{ taskCount: 0, connectionCount: 0 }] });
    const service = TestBed.inject(LocalBackupUIService);
    await service.handleRestoreFromLocalBackup();
    service.selectRestoreFile(0);

    const pending = service.loadRestorePreview([]);
    await vi.waitFor(() => expect(localBackup.readBackupFile).toHaveBeenCalledTimes(1));
    service.cancelRestore();
    fileRead.resolve(createBackupFile(createAttachmentBackup()));
    await pending;
    await service.confirmRestore([]);

    expect(service.restoreStep()).toBe('idle');
    expect(service.restorePreview()).toBeNull();
    expect(importService.executeImport).not.toHaveBeenCalled();
  });

  async function preparePreview(
    service: LocalBackupUIService,
    backupData = createBackupData(),
    exportData = createExportData(),
  ): Promise<void> {
    localBackup.listBackupFiles.mockResolvedValue([{ name: 'backup.json', timestamp: 1, size: 1 }]);
    localBackup.readBackupFile.mockResolvedValue(createBackupFile(backupData));
    importService.validateFile.mockResolvedValue({ valid: true, data: exportData });
    importService.generatePreview.mockResolvedValue({
      projects: exportData.projects.map(() => ({ taskCount: 0, connectionCount: 0 })),
    });
    await service.handleRestoreFromLocalBackup();
    service.selectRestoreFile(0);
    await service.loadRestorePreview([]);
  }
});

function createExportData(projectCount = 1): ExportData {
  return {
    metadata: {
      exportedAt: '2026-07-14T00:00:00.000Z',
      version: '2.0.0',
      appVersion: 'race-test',
      projectCount,
      taskCount: 0,
      connectionCount: 0,
      attachmentCount: 0,
      checksum: '',
      exportType: 'full',
    },
    projects: Array.from({ length: projectCount }, (_, index) => ({
      id: `project-${index + 1}`,
      name: `Project ${index + 1}`,
      description: '',
      tasks: [],
      connections: [],
    })),
  };
}

function createBackupData(localState: BackupData['localState'] = {}): BackupData {
  return {
    payloadVersion: '2.0.0',
    projects: [],
    tasks: [],
    connections: [],
    localState: {
      dataSafety: { ownerUserId: 'user-1' },
      ...localState,
    },
  } as unknown as BackupData;
}

function createAttachmentBackup(): BackupData {
  return createBackupData({
    dataSafety: { ownerUserId: 'user-1' },
    attachmentUploadOutbox: [{
      ownerUserId: 'user-1',
      operationId: 'attachment:create:attachment-1',
      attachmentId: 'attachment-1',
      blobKey: 'attachment-1',
      fileName: 'offline.txt',
      mimeType: 'text/plain',
      size: 2,
      createdAt: '2026-07-14T00:00:00.000Z',
      encoding: 'base64',
      blobBase64: 'TkY=',
    }],
  } as BackupData['localState']);
}

function createBackupFile(backupData: BackupData): File {
  return new File([JSON.stringify(backupData)], 'backup.json', { type: 'application/json' });
}

function makeStageMarker(): LocalBackupUiRestoreMarker {
  return {
    schemaVersion: 2,
    ownerUserId: 'user-1',
    runId: '11111111-1111-4111-8111-111111111111',
    restoreRunId: '22222222-2222-4222-8222-222222222222',
    actionQueueRestoreIdentity: {} as never,
    createdAt: '2026-08-03T00:00:00.000Z',
    leaseExpiresAt: '2026-08-03T00:01:00.000Z',
    state: 'prepared',
    phase: 'pre-image-captured',
    completedStages: [],
    rollbackCompletedStages: [],
    source: { kind: 'local-file', reference: 'backup.json', checksum: `sha256:${'a'.repeat(64)}` },
    touchedProjectIds: ['project-1'],
    preImage: {} as never,
    rollbackErrors: [],
  };
}

function makeQueuedAction() {
  return {
    id: '77777777-7777-4777-8777-777777777777',
    operationId: '88888888-8888-4888-8888-888888888888',
    type: 'upsert-task',
    entityType: 'task',
    entityId: 'task-1',
    payload: { id: 'task-1' },
    timestamp: 1,
    retryCount: 0,
  };
}

async function sha256Digest(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return `sha256:${Array.from(new Uint8Array(digest), byte => (
    byte.toString(16).padStart(2, '0')
  )).join('')}`;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(resolvePromise => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
