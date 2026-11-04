import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalBackupUIService } from './local-backup-ui.service';
import { LocalBackupService } from '../../../../services/local-backup.service';
import { ImportService } from '../../../../services/import.service';
import { LoggerService } from '../../../../services/logger.service';
import { AttachmentUploadOutboxService } from '../../../../services/attachment-upload-outbox.service';
import { ActionQueueService } from '../../../../services/action-queue.service';
import type { DeadLetterItem, QueuedAction } from '../../../../services/action-queue.types';
import { QueueBackupService } from '../../../../services/queue-backup.service';
import { AuthService } from '../../../../services/auth.service';
import { RetryQueueService } from '../../../core/services/sync/retry-queue.service';
import { ActionQueueStorageService } from '../../../../services/action-queue-storage.service';
import { LOCAL_QUEUE_CONFIG } from '../../../../services/action-queue-storage.helpers';
import { ConflictStorageService } from '../../../../services/conflict-storage.service';
import { BackupDataSafetyMetadataRestoreService } from '../../../../services/backup-data-safety-metadata-restore.service';
import { DisasterBackupService } from '../../../../services/disaster-backup.service';
import { LocalBackupUiRestoreStageService } from '../../../../services/local-backup-ui-restore-stage.service';
import { LocalBackupUiRestoreTransactionService } from '../../../../services/local-backup-ui-restore-transaction.service';
import type {
  LocalBackupUiRestoreStageOperations,
  LocalBackupUiRestoreStageProtocolResult,
} from '../../../../services/local-backup-ui-restore-stage-protocol';
import type { LocalBackupUiRestoreStage } from '../../../../services/local-backup-ui-restore-types';
import type { BackupData } from '../../../../../supabase/functions/_shared/backup-utils';
import type { ExportData } from '../../../../services/export.service';
import { LOCAL_BACKUP_CONFIG } from '../../../../config/local-backup.config';

describe('LocalBackupUIService queue restore', () => {
  const autoBackupEnabled = signal(false);
  const autoBackupIntervalMs = signal(LOCAL_BACKUP_CONFIG.DEFAULT_INTERVAL_MS);
  const isAuthorized = signal(false);

  const localBackupServiceMock = {
    autoBackupEnabled,
    autoBackupIntervalMs,
    isAuthorized,
    setProjectsProvider: vi.fn(),
    stopAutoBackup: vi.fn(),
    performBackup: vi.fn(),
    resumePermission: vi.fn(),
    startAutoBackup: vi.fn(),
    listBackupFiles: vi.fn(),
    readBackupFile: vi.fn(),
  };

  const importServiceMock = {
    validateFile: vi.fn(),
    generatePreview: vi.fn(),
    executeImport: vi.fn(),
  };

  const attachmentUploadOutboxMock = {
    savePendingUpload: vi.fn(),
  };

  const queueBackupMock = {
    updateQueue: vi.fn(),
    restoreQueueSnapshot: vi.fn(),
    restoreDeadLetters: vi.fn(),
  };

  const pendingActions = signal<QueuedAction[]>([]);
  const deadLetterQueue = signal<DeadLetterItem[]>([]);
  let ownerStorageLoadState: 'loaded' | 'unknown' = 'loaded';
  const actionQueueMock = {
    pendingActions,
    deadLetterQueue,
    reloadFromStorageForCurrentOwner: vi.fn(),
    getCurrentOwnerStorageLoadState: vi.fn(() => ownerStorageLoadState),
    clearCurrentView: vi.fn(() => {
      ownerStorageLoadState = 'unknown';
      pendingActions.set([]);
      deadLetterQueue.set([]);
    }),
  };

  const authMock = {
    currentUserId: vi.fn(),
    captureAuthIdentityFence: vi.fn(),
  };

  const retryQueueMock = {
    restoreFromBackupItems: vi.fn(),
  };

  const actionQueueStorageMock = {
    restoreDeadLettersFromBackupItems: vi.fn(),
  };

  const conflictStorageMock = {
    saveConflict: vi.fn(),
  };

  const metadataRestoreMock = {
    preview: vi.fn(),
    restore: vi.fn(),
  };

  const disasterBackupMock = {
    buildLocalBlob: vi.fn(),
  };

  const preparedRestoreRun = vi.fn();
  const restoreTransactionMock = { prepare: vi.fn() };
  const restoreStageMock = { createOperations: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    autoBackupEnabled.set(false);
    isAuthorized.set(false);
    pendingActions.set([]);
    deadLetterQueue.set([]);
    ownerStorageLoadState = 'loaded';
    authMock.currentUserId.mockReturnValue('user-1');
    authMock.captureAuthIdentityFence.mockReturnValue('auth-fence-a');
    retryQueueMock.restoreFromBackupItems.mockResolvedValue(0);
    actionQueueStorageMock.restoreDeadLettersFromBackupItems.mockReturnValue(0);
    conflictStorageMock.saveConflict.mockResolvedValue(true);
    metadataRestoreMock.preview.mockResolvedValue({
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
    metadataRestoreMock.restore.mockResolvedValue({
      projectCursors: 0,
      lastSyncTime: 0,
      replayLog: 0,
      lastWriteExplain: 0,
      taskTombstones: 0,
      connectionTombstones: 0,
    });
    queueBackupMock.updateQueue.mockImplementation(async (_ownerUserId, updater) =>
      updater([], { recordFound: false })
    );
    queueBackupMock.restoreQueueSnapshot.mockResolvedValue({
      recordFound: true,
      actions: [],
      savedAt: null,
    });
    queueBackupMock.restoreDeadLetters.mockResolvedValue([]);
    actionQueueMock.reloadFromStorageForCurrentOwner.mockImplementation(async () => {
      ownerStorageLoadState = 'loaded';
    });
    preparedRestoreRun.mockResolvedValue({ status: 'completed', stageResults: { projects: 1 } });
    restoreTransactionMock.prepare.mockResolvedValue({
      verifyOwnership: vi.fn().mockResolvedValue(true),
      run: preparedRestoreRun,
      abortBeforeMutation: vi.fn().mockResolvedValue(undefined),
    });
    restoreStageMock.createOperations.mockReturnValue({});

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        LocalBackupUIService,
        { provide: LocalBackupService, useValue: localBackupServiceMock },
        { provide: ImportService, useValue: importServiceMock },
        { provide: AttachmentUploadOutboxService, useValue: attachmentUploadOutboxMock },
        { provide: QueueBackupService, useValue: queueBackupMock },
        { provide: ActionQueueService, useValue: actionQueueMock },
        { provide: AuthService, useValue: authMock },
        { provide: RetryQueueService, useValue: retryQueueMock },
        { provide: ActionQueueStorageService, useValue: actionQueueStorageMock },
        { provide: ConflictStorageService, useValue: conflictStorageMock },
        { provide: BackupDataSafetyMetadataRestoreService, useValue: metadataRestoreMock },
        { provide: DisasterBackupService, useValue: disasterBackupMock },
        { provide: LocalBackupUiRestoreTransactionService, useValue: restoreTransactionMock },
        { provide: LocalBackupUiRestoreStageService, useValue: restoreStageMock },
        { provide: LoggerService, useValue: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } },
      ],
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('routes pending action queue through the prepared restore stage', async () => {
    const exportData: ExportData = {
      metadata: {
        exportedAt: '2026-06-18T00:00:00.000Z',
        version: '2.0.0',
        appVersion: 'backup-restore',
        projectCount: 1,
        taskCount: 0,
        connectionCount: 0,
        attachmentCount: 0,
        checksum: '',
        exportType: 'full',
      },
      projects: [{
        id: 'project-1',
        name: 'Recovered',
        description: '',
        tasks: [],
        connections: [],
      }],
    };
    const existingAction: QueuedAction = {
      id: '66666666-6666-4666-8666-666666666666',
      operationId: '77777777-7777-4777-8777-777777777777',
      type: 'update',
      entityType: 'task',
      entityId: 'task-current',
      payload: {
        task: {
          id: 'task-current', title: 'Current', content: '', stage: 1, parentId: null,
          order: 0, rank: 500, status: 'active', x: 0, y: 0,
          createdDate: '2026-06-18T00:00:00.000Z', displayId: '1',
        },
        projectId: 'project-1',
      },
      timestamp: 1,
      retryCount: 0,
    };
    const restoredAction: QueuedAction = {
      id: '88888888-8888-4888-8888-888888888888',
      operationId: '99999999-9999-4999-8999-999999999999',
      type: 'update',
      entityType: 'task',
      entityId: 'task-restored',
      payload: {
        task: {
          id: 'task-restored', title: 'Restored', content: '', stage: 1, parentId: null,
          order: 0, rank: 500, status: 'active', x: 0, y: 0,
          createdDate: '2026-06-18T00:00:00.000Z', displayId: '2',
        },
        projectId: 'project-1',
      },
      timestamp: 2,
      retryCount: 0,
    };
    const backupData = {
      payloadVersion: '2.0.0',
      projects: [],
      tasks: [],
      connections: [],
      localState: {
        dataSafety: { ownerUserId: 'user-1' },
        actionQueue: [restoredAction],
      },
    } as unknown as BackupData;
    const restoredQueue = [existingAction, restoredAction];
    queueBackupMock.restoreQueueSnapshot.mockImplementationOnce(async () => {
      expect(actionQueueMock.clearCurrentView).toHaveBeenCalledOnce();
      expect(pendingActions()).toEqual([]);
      return {
        recordFound: true,
        actions: restoredQueue,
        savedAt: '2026-06-18T00:00:00.000Z',
      };
    });
    actionQueueMock.reloadFromStorageForCurrentOwner.mockImplementationOnce(async () => {
      pendingActions.set(restoredQueue);
      ownerStorageLoadState = 'loaded';
    });
    queueBackupMock.updateQueue.mockImplementation(async (_ownerUserId, updater) =>
      updater([existingAction], { recordFound: true })
    );
    localBackupServiceMock.listBackupFiles.mockResolvedValue([{ name: 'backup.json', timestamp: 1, size: 1024 }]);
    localBackupServiceMock.readBackupFile.mockResolvedValue(new File([JSON.stringify(backupData)], 'backup.json', { type: 'application/json' }));
    importServiceMock.validateFile.mockResolvedValue({ valid: true, data: exportData });
    importServiceMock.generatePreview.mockResolvedValue({
      projects: [{ taskCount: 0, connectionCount: 0 }],
    });
    preparedRestoreRun.mockImplementationOnce(async (operations: LocalBackupUiRestoreStageOperations) => {
      localStorage.setItem(
        `${LOCAL_QUEUE_CONFIG.QUEUE_STORAGE_KEY}.user-1`,
        JSON.stringify(restoredQueue),
      );
      return runPreparedRestoreWithFinalVerification(operations, {
        projects: 1,
        'action-queue': 1,
      });
    });
    localStorage.setItem(
      `${LOCAL_QUEUE_CONFIG.QUEUE_STORAGE_KEY}.user-1`,
      JSON.stringify([existingAction]),
    );
    const service = TestBed.inject(LocalBackupUIService);

    await service.handleRestoreFromLocalBackup();
    service.selectRestoreFile(0);
    await service.loadRestorePreview([]);
    await service.confirmRestore([]);

    expect(restoreStageMock.createOperations).toHaveBeenCalledWith(expect.objectContaining({
      ownerUserId: 'user-1',
      backup: backupData,
    }));
    expect(restoreTransactionMock.prepare).toHaveBeenCalledWith(expect.objectContaining({
      restoredActionQueueItems: [expect.objectContaining({
        id: '88888888-8888-4888-8888-888888888888',
        operationId: '99999999-9999-4999-8999-999999999999',
      })],
    }));
    expect(queueBackupMock.updateQueue).not.toHaveBeenCalled();
    expect(actionQueueMock.reloadFromStorageForCurrentOwner).toHaveBeenCalledOnce();
    expect(JSON.parse(localStorage.getItem(`${LOCAL_QUEUE_CONFIG.QUEUE_STORAGE_KEY}.user-1`) ?? 'null'))
      .toEqual(restoredQueue);
    expect(importServiceMock.executeImport).not.toHaveBeenCalled();
    expect(service.restoreResultMsg()).toBe('恢复成功！已导入 1 个项目，已恢复 1 个待同步操作');
  });

  it('does not report success when the reloaded in-memory queue differs from the durable V2 record', async () => {
    const exportData: ExportData = {
      metadata: {
        exportedAt: '2026-06-18T00:00:00.000Z',
        version: '2.0.0',
        appVersion: 'backup-restore',
        projectCount: 0,
        taskCount: 0,
        connectionCount: 0,
        attachmentCount: 0,
        checksum: '',
        exportType: 'full',
      },
      projects: [],
    };
    const action: QueuedAction = {
      id: '88888888-8888-4888-8888-888888888888',
      operationId: '99999999-9999-4999-8999-999999999999',
      type: 'update',
      entityType: 'task',
      entityId: 'task-restored',
      payload: {
        task: {
          id: 'task-restored', title: 'Restored', content: '', stage: 1, parentId: null,
          order: 0, rank: 500, status: 'active', x: 0, y: 0,
          createdDate: '2026-06-18T00:00:00.000Z', displayId: '1',
        },
        projectId: 'project-1',
      },
      timestamp: 2,
      retryCount: 0,
    };
    const backupData = {
      payloadVersion: '2.0.0',
      projects: [],
      tasks: [],
      connections: [],
      localState: { dataSafety: { ownerUserId: 'user-1' }, actionQueue: [action] },
    } as unknown as BackupData;
    queueBackupMock.restoreQueueSnapshot.mockResolvedValueOnce({
      recordFound: true,
      actions: [action],
      savedAt: '2026-06-18T00:00:00.000Z',
    });
    localStorage.setItem(
      `${LOCAL_QUEUE_CONFIG.QUEUE_STORAGE_KEY}.user-1`,
      JSON.stringify([action]),
    );
    actionQueueMock.reloadFromStorageForCurrentOwner.mockImplementationOnce(async () => {
      ownerStorageLoadState = 'loaded';
    });
    localBackupServiceMock.listBackupFiles.mockResolvedValue([{ name: 'backup.json', timestamp: 1, size: 1024 }]);
    localBackupServiceMock.readBackupFile.mockResolvedValue(new File([JSON.stringify(backupData)], 'backup.json', { type: 'application/json' }));
    importServiceMock.validateFile.mockResolvedValue({ valid: true, data: exportData });
    importServiceMock.generatePreview.mockResolvedValue({ projects: [] });
    preparedRestoreRun.mockImplementationOnce((operations: LocalBackupUiRestoreStageOperations) => (
      runPreparedRestoreWithFinalVerification(operations, { projects: 0, 'action-queue': 1 })
    ));
    const service = TestBed.inject(LocalBackupUIService);

    await service.handleRestoreFromLocalBackup();
    service.selectRestoreFile(0);
    await service.loadRestorePreview([]);
    await service.confirmRestore([]);

    expect(actionQueueMock.reloadFromStorageForCurrentOwner).toHaveBeenCalledOnce();
    expect(service.restoreStep()).toBe('error');
    expect(service.restoreResultMsg()).toBe('');
    expect(service.restoreError()).toContain('已恢复到写入前状态');
    expect(service.restoreError()).toContain('pending queue did not match its V2 record');
    expect(actionQueueMock.clearCurrentView).toHaveBeenCalledTimes(2);
    expect(actionQueueMock.getCurrentOwnerStorageLoadState()).toBe('unknown');
  });

  it('rejects an ActionQueue operationId that would be remapped before preparing the transaction', async () => {
    const exportData: ExportData = {
      metadata: {
        exportedAt: '2026-06-18T00:00:00.000Z',
        version: '2.0.0',
        appVersion: 'backup-restore',
        projectCount: 0,
        taskCount: 0,
        connectionCount: 0,
        attachmentCount: 0,
        checksum: '',
        exportType: 'full',
      },
      projects: [],
    };
    const backupData = {
      payloadVersion: '2.0.0',
      projects: [],
      tasks: [],
      connections: [],
      localState: {
        dataSafety: { ownerUserId: 'user-1' },
        actionQueue: [{
          id: '88888888-8888-4888-8888-888888888888',
          operationId: 'legacy-operation-id',
          type: 'update',
          entityType: 'task',
          entityId: 'task-restored',
          payload: { task: { id: 'task-restored' } },
          timestamp: 2,
          retryCount: 0,
        }],
      },
    } as unknown as BackupData;
    importServiceMock.validateFile.mockResolvedValue({ valid: true, data: exportData });
    importServiceMock.generatePreview.mockResolvedValue({ projects: [] });
    const service = TestBed.inject(LocalBackupUIService);

    await service.loadRestorePreviewFromFile(
      new File([JSON.stringify(backupData)], 'backup.json', { type: 'application/json' }),
      [],
    );
    await service.confirmRestore([]);

    expect(restoreTransactionMock.prepare).not.toHaveBeenCalled();
    expect(preparedRestoreRun).not.toHaveBeenCalled();
    expect(queueBackupMock.updateQueue).not.toHaveBeenCalled();
    expect(service.restoreStep()).toBe('error');
  });

  it('routes retry queue through the prepared restore stage', async () => {
    const exportData: ExportData = {
      metadata: {
        exportedAt: '2026-06-18T00:00:00.000Z',
        version: '2.0.0',
        appVersion: 'backup-restore',
        projectCount: 1,
        taskCount: 0,
        connectionCount: 0,
        attachmentCount: 0,
        checksum: '',
        exportType: 'full',
      },
      projects: [{
        id: 'project-1',
        name: 'Recovered',
        description: '',
        tasks: [],
        connections: [],
      }],
    };
    const retryQueueItem = {
      id: '11111111-1111-4111-8111-111111111111',
      type: 'task',
      operation: 'upsert',
      data: { id: '22222222-2222-4222-8222-222222222222', title: 'Restored retry' },
      projectId: 'project-1',
      retryCount: 0,
      createdAt: 1,
      sourceUserId: 'user-1',
      operationId: 'op-retry-restored',
    };
    const backupData = {
      payloadVersion: '2.0.0',
      projects: [],
      tasks: [],
      connections: [],
      localState: {
        dataSafety: { ownerUserId: 'user-1' },
        retryQueue: [retryQueueItem],
      },
    } as unknown as BackupData;
    preparedRestoreRun.mockResolvedValueOnce({
      status: 'completed',
      stageResults: { projects: 1, 'retry-queue': 1 },
    });
    localBackupServiceMock.listBackupFiles.mockResolvedValue([{ name: 'backup.json', timestamp: 1, size: 1024 }]);
    localBackupServiceMock.readBackupFile.mockResolvedValue(new File([JSON.stringify(backupData)], 'backup.json', { type: 'application/json' }));
    importServiceMock.validateFile.mockResolvedValue({ valid: true, data: exportData });
    importServiceMock.generatePreview.mockResolvedValue({
      projects: [{ taskCount: 0, connectionCount: 0 }],
    });
    const service = TestBed.inject(LocalBackupUIService);

    await service.handleRestoreFromLocalBackup();
    service.selectRestoreFile(0);
    await service.loadRestorePreview([]);
    await service.confirmRestore([]);

    expect(restoreStageMock.createOperations).toHaveBeenCalledWith(expect.objectContaining({
      ownerUserId: 'user-1',
      backup: backupData,
    }));
    expect(retryQueueMock.restoreFromBackupItems).not.toHaveBeenCalled();
    expect(service.restoreResultMsg()).toBe('恢复成功！已导入 1 个项目，已恢复 1 个待重试同步操作');
  });

  it('routes dead letters through the prepared restore stage', async () => {
    const exportData: ExportData = {
      metadata: {
        exportedAt: '2026-06-18T00:00:00.000Z',
        version: '2.0.0',
        appVersion: 'backup-restore',
        projectCount: 1,
        taskCount: 0,
        connectionCount: 0,
        attachmentCount: 0,
        checksum: '',
        exportType: 'full',
      },
      projects: [{
        id: 'project-1',
        name: 'Recovered',
        description: '',
        tasks: [],
        connections: [],
      }],
    };
    const deadLetter = createDeadLetterSnapshot();
    const backupData = {
      payloadVersion: '2.0.0',
      projects: [],
      tasks: [],
      connections: [],
      localState: {
        dataSafety: { ownerUserId: 'user-1' },
        deadLetters: [deadLetter],
      },
    } as unknown as BackupData;
    preparedRestoreRun.mockImplementationOnce((operations: LocalBackupUiRestoreStageOperations) => (
      runPreparedRestoreWithFinalVerification(operations, { projects: 1, 'dead-letters': 1 })
    ));
    queueBackupMock.restoreDeadLetters.mockResolvedValueOnce([deadLetter]);
    localStorage.setItem(
      `${LOCAL_QUEUE_CONFIG.DEAD_LETTER_STORAGE_KEY}.user-1`,
      JSON.stringify([deadLetter]),
    );
    actionQueueMock.reloadFromStorageForCurrentOwner.mockImplementationOnce(async () => {
      deadLetterQueue.set([deadLetter]);
      ownerStorageLoadState = 'loaded';
    });
    localBackupServiceMock.listBackupFiles.mockResolvedValue([{ name: 'backup.json', timestamp: 1, size: 1024 }]);
    localBackupServiceMock.readBackupFile.mockResolvedValue(new File([JSON.stringify(backupData)], 'backup.json', { type: 'application/json' }));
    importServiceMock.validateFile.mockResolvedValue({ valid: true, data: exportData });
    importServiceMock.generatePreview.mockResolvedValue({
      projects: [{ taskCount: 0, connectionCount: 0 }],
    });
    const service = TestBed.inject(LocalBackupUIService);

    await service.handleRestoreFromLocalBackup();
    service.selectRestoreFile(0);
    await service.loadRestorePreview([]);
    await service.confirmRestore([]);

    expect(restoreStageMock.createOperations).toHaveBeenCalledWith(expect.objectContaining({
      ownerUserId: 'user-1',
      backup: backupData,
    }));
    expect(actionQueueStorageMock.restoreDeadLettersFromBackupItems).not.toHaveBeenCalled();
    expect(queueBackupMock.restoreDeadLetters).toHaveBeenCalledWith('user-1');
    expect(service.restoreResultMsg()).toBe('恢复成功！已导入 1 个项目，已恢复 1 条同步失败记录');
  });

  it.each(['missing durable snapshot', 'in-memory snapshot mismatch'])(
    'rolls back when dead-letter read-back has a %s',
    async failureMode => {
      const exportData: ExportData = {
        metadata: {
          exportedAt: '2026-06-18T00:00:00.000Z',
          version: '2.0.0',
          appVersion: 'backup-restore',
          projectCount: 0,
          taskCount: 0,
          connectionCount: 0,
          attachmentCount: 0,
          checksum: '',
          exportType: 'full',
        },
        projects: [],
      };
      const deadLetter = createDeadLetterSnapshot();
      const backupData = {
        payloadVersion: '2.0.0',
        projects: [],
        tasks: [],
        connections: [],
        localState: {
          dataSafety: { ownerUserId: 'user-1' },
          deadLetters: [deadLetter],
        },
      } as unknown as BackupData;
      queueBackupMock.restoreDeadLetters.mockResolvedValueOnce(
        failureMode === 'missing durable snapshot' ? null : [deadLetter],
      );
      localStorage.setItem(
        `${LOCAL_QUEUE_CONFIG.DEAD_LETTER_STORAGE_KEY}.user-1`,
        JSON.stringify([deadLetter]),
      );
      actionQueueMock.reloadFromStorageForCurrentOwner.mockImplementationOnce(async () => {
        deadLetterQueue.set(failureMode === 'in-memory snapshot mismatch' ? [] : [deadLetter]);
        ownerStorageLoadState = 'loaded';
      });
      preparedRestoreRun.mockImplementationOnce((operations: LocalBackupUiRestoreStageOperations) => (
        runPreparedRestoreWithFinalVerification(operations, { projects: 0, 'dead-letters': 1 })
      ));
      localBackupServiceMock.listBackupFiles.mockResolvedValue([{ name: 'backup.json', timestamp: 1, size: 1024 }]);
      localBackupServiceMock.readBackupFile.mockResolvedValue(new File([JSON.stringify(backupData)], 'backup.json', { type: 'application/json' }));
      importServiceMock.validateFile.mockResolvedValue({ valid: true, data: exportData });
      importServiceMock.generatePreview.mockResolvedValue({ projects: [] });
      const service = TestBed.inject(LocalBackupUIService);

      await service.handleRestoreFromLocalBackup();
      service.selectRestoreFile(0);
      await service.loadRestorePreview([]);
      await service.confirmRestore([]);

      expect(service.restoreStep()).toBe('error');
      expect(service.restoreResultMsg()).toBe('');
      expect(service.restoreError()).toContain('已恢复到写入前状态');
      expect(queueBackupMock.restoreDeadLetters).toHaveBeenCalledWith('user-1');
    },
  );

  it('routes conflict copies through the prepared restore stage', async () => {
    const exportData: ExportData = {
      metadata: {
        exportedAt: '2026-06-18T00:00:00.000Z',
        version: '2.0.0',
        appVersion: 'backup-restore',
        projectCount: 1,
        taskCount: 0,
        connectionCount: 0,
        attachmentCount: 0,
        checksum: '',
        exportType: 'full',
      },
      projects: [{
        id: 'project-1',
        name: 'Recovered',
        description: '',
        tasks: [],
        connections: [],
      }],
    };
    const conflict = {
      projectId: 'project-conflict',
      ownerUserId: 'user-1',
      localProject: {
        id: 'project-conflict',
        name: 'Local conflict copy',
        description: '',
        createdDate: '2026-06-18T00:00:00.000Z',
        updatedAt: '2026-06-18T00:00:00.000Z',
        version: 2,
        tasks: [],
        connections: [],
      },
      conflictedAt: '2026-06-18T00:00:00.000Z',
      localVersion: 2,
      reason: 'version_mismatch',
      acknowledged: false,
    };
    const backupData = {
      payloadVersion: '2.0.0',
      projects: [],
      tasks: [],
      connections: [],
      localState: {
        dataSafety: { ownerUserId: 'user-1' },
        conflicts: [conflict],
      },
    } as unknown as BackupData;
    localBackupServiceMock.listBackupFiles.mockResolvedValue([{ name: 'backup.json', timestamp: 1, size: 1024 }]);
    localBackupServiceMock.readBackupFile.mockResolvedValue(new File([JSON.stringify(backupData)], 'backup.json', { type: 'application/json' }));
    importServiceMock.validateFile.mockResolvedValue({ valid: true, data: exportData });
    importServiceMock.generatePreview.mockResolvedValue({
      projects: [{ taskCount: 0, connectionCount: 0 }],
    });
    preparedRestoreRun.mockResolvedValueOnce({
      status: 'completed',
      stageResults: { projects: 1, conflicts: 1 },
    });
    const service = TestBed.inject(LocalBackupUIService);

    await service.handleRestoreFromLocalBackup();
    service.selectRestoreFile(0);
    await service.loadRestorePreview([]);
    await service.confirmRestore([]);

    expect(restoreStageMock.createOperations).toHaveBeenCalledWith(expect.objectContaining({
      ownerUserId: 'user-1',
      backup: backupData,
    }));
    expect(conflictStorageMock.saveConflict).not.toHaveBeenCalled();
    expect(service.restoreResultMsg()).toBe('恢复成功！已导入 1 个项目，已恢复 1 条冲突副本');
  });
});

function createDeadLetterSnapshot(): DeadLetterItem {
  return {
    action: {
      id: 'dead-letter-action',
      operationId: 'op-dead-letter-action',
      type: 'update',
      entityType: 'task',
      entityId: 'task-dead-letter',
      payload: {
        task: { id: 'task-dead-letter', title: 'Dead letter task' },
        projectId: 'project-1',
        sourceUserId: 'user-1',
      },
      timestamp: 1,
      retryCount: 5,
      syncState: 'dead_letter',
    },
    failedAt: '2026-06-18T00:00:00.000Z',
    reason: 'business failure',
  } as DeadLetterItem;
}

async function runPreparedRestoreWithFinalVerification(
  operations: LocalBackupUiRestoreStageOperations,
  stageResults: Partial<Record<LocalBackupUiRestoreStage, unknown>>,
): Promise<LocalBackupUiRestoreStageProtocolResult> {
  try {
    await operations.verifyBeforeFinalize?.();
    return { status: 'completed', stageResults };
  } catch (error) {
    return { status: 'rolled-back', error, stageResults: {} };
  }
}
