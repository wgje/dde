import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalBackupUIService } from './local-backup-ui.service';
import { LocalBackupService } from '../../../../services/local-backup.service';
import { ImportService } from '../../../../services/import.service';
import { LoggerService } from '../../../../services/logger.service';
import { AttachmentUploadOutboxService } from '../../../../services/attachment-upload-outbox.service';
import { QueueBackupService } from '../../../../services/queue-backup.service';
import { AuthService } from '../../../../services/auth.service';
import { RetryQueueService } from '../../../core/services/sync/retry-queue.service';
import { ActionQueueStorageService } from '../../../../services/action-queue-storage.service';
import { ConflictStorageService } from '../../../../services/conflict-storage.service';
import type { BackupData } from '../../../../../supabase/functions/_shared/backup-utils';
import type { ExportData } from '../../../../services/export.service';

describe('LocalBackupUIService', () => {
  const autoBackupEnabled = signal(false);
  const isAuthorized = signal(false);
  const alertMock = vi.fn();

  const localBackupServiceMock = {
    autoBackupEnabled,
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
  };

  const authMock = {
    currentUserId: vi.fn(),
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

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('alert', alertMock);
    autoBackupEnabled.set(false);
    isAuthorized.set(false);
    authMock.currentUserId.mockReturnValue('user-1');
    retryQueueMock.restoreFromBackupItems.mockResolvedValue(0);
    actionQueueStorageMock.restoreDeadLettersFromBackupItems.mockReturnValue(0);
    conflictStorageMock.saveConflict.mockResolvedValue(true);
    queueBackupMock.updateQueue.mockImplementation(async (_ownerUserId, updater) =>
      updater([], { recordFound: false })
    );

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        LocalBackupUIService,
        { provide: LocalBackupService, useValue: localBackupServiceMock },
        { provide: ImportService, useValue: importServiceMock },
        { provide: AttachmentUploadOutboxService, useValue: attachmentUploadOutboxMock },
        { provide: QueueBackupService, useValue: queueBackupMock },
        { provide: AuthService, useValue: authMock },
        { provide: RetryQueueService, useValue: retryQueueMock },
        { provide: ActionQueueStorageService, useValue: actionQueueStorageMock },
        { provide: ConflictStorageService, useValue: conflictStorageMock },
        { provide: LoggerService, useValue: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } },
      ],
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('turns auto backup off even when permission has expired', async () => {
    autoBackupEnabled.set(true);
    isAuthorized.set(false);
    const service = TestBed.inject(LocalBackupUIService);

    await service.toggleAutoBackup(() => []);

    expect(localBackupServiceMock.stopAutoBackup).toHaveBeenCalledTimes(1);
    expect(localBackupServiceMock.resumePermission).not.toHaveBeenCalled();
    expect(localBackupServiceMock.startAutoBackup).not.toHaveBeenCalled();
  });

  it('shows a retry notice when manual backup is postponed', async () => {
    const service = TestBed.inject(LocalBackupUIService);
    localBackupServiceMock.performBackup.mockResolvedValue({
      success: false,
      deferred: true,
      error: '浏览器恢复连接中，自动备份稍后重试',
    });

    await service.handleManualBackup([{
      id: 'p1',
      name: 'Test',
      description: '',
      createdDate: new Date().toISOString(),
      tasks: [],
      connections: [],
    }]);

    expect(alertMock).toHaveBeenCalledWith('备份暂未完成：浏览器恢复连接中，自动备份稍后重试');
  });

  it('restores pending attachment upload outbox after local backup import succeeds', async () => {
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
    const backupData = {
      payloadVersion: '2.0.0',
      projects: [],
      tasks: [],
      connections: [],
      localState: {
        attachmentUploadOutbox: [{
          attachmentId: 'attachment-1',
          blobKey: 'attachment-1',
          fileName: 'offline.txt',
          mimeType: 'text/plain',
          size: 2,
          createdAt: '2026-06-18T00:00:00.000Z',
          encoding: 'base64',
          blobBase64: 'TkY=',
        }],
      },
    } as unknown as BackupData;
    localBackupServiceMock.listBackupFiles.mockResolvedValue([{ name: 'backup.json', timestamp: 1, size: 1024 }]);
    localBackupServiceMock.readBackupFile.mockResolvedValue(new File([JSON.stringify(backupData)], 'backup.json', { type: 'application/json' }));
    importServiceMock.validateFile.mockResolvedValue({ valid: true, data: exportData, rawBackupData: backupData });
    importServiceMock.generatePreview.mockResolvedValue({
      projects: [{ taskCount: 0, connectionCount: 0 }],
    });
    importServiceMock.executeImport.mockResolvedValue({ success: true, importedCount: 1 });
    const service = TestBed.inject(LocalBackupUIService);

    await service.handleRestoreFromLocalBackup();
    service.selectRestoreFile(0);
    await service.loadRestorePreview([]);
    await service.confirmRestore([], vi.fn());

    expect(attachmentUploadOutboxMock.savePendingUpload).toHaveBeenCalledTimes(1);
    const restoredUpload = attachmentUploadOutboxMock.savePendingUpload.mock.calls[0][0];
    expect(restoredUpload).toEqual(expect.objectContaining({
      attachmentId: 'attachment-1',
      blobKey: 'attachment-1',
      fileName: 'offline.txt',
      mimeType: 'text/plain',
      size: 2,
      createdAt: '2026-06-18T00:00:00.000Z',
    }));
    expect(Array.from(new Uint8Array(await restoredUpload.blob.arrayBuffer()))).toEqual([78, 70]);
    expect(service.restoreResultMsg()).toBe('恢复成功！已导入 1 个项目，已恢复 1 个待上传附件');
  });

  it('previews pending local queues before confirming local backup restore', async () => {
    const exportData: ExportData = {
      metadata: {
        exportedAt: '2026-06-18T00:00:00.000Z',
        version: '2.0.0',
        appVersion: 'backup-restore',
        projectCount: 1,
        taskCount: 2,
        connectionCount: 1,
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
    const backupData = {
      payloadVersion: '2.0.0',
      projects: [],
      tasks: [],
      connections: [],
      localState: {
        attachmentUploadOutbox: [
          {
            attachmentId: 'attachment-1',
            blobKey: 'attachment-1',
            fileName: 'offline.txt',
            mimeType: 'text/plain',
            size: 2,
            createdAt: '2026-06-18T00:00:00.000Z',
            encoding: 'base64',
            blobBase64: 'TkY=',
          },
        ],
        actionQueue: {
          actions: [
            {
              id: 'action-1',
              operationId: 'op-action-1',
              type: 'update',
              entityType: 'task',
              entityId: 'task-1',
              payload: { projectId: 'project-1' },
              timestamp: 1,
              retryCount: 0,
            },
          ],
        },
        retryQueue: [{ id: 'retry-1' }, { id: 'retry-2' }],
        deadLetters: [{ action: { id: 'dead-1' }, failedAt: '2026-06-18T00:00:00.000Z', reason: 'failed' }],
        conflicts: [{ id: 'conflict-1' }],
      },
    } as unknown as BackupData;
    localBackupServiceMock.listBackupFiles.mockResolvedValue([{ name: 'backup.json', timestamp: 1, size: 1024 }]);
    localBackupServiceMock.readBackupFile.mockResolvedValue(new File([JSON.stringify(backupData)], 'backup.json', { type: 'application/json' }));
    importServiceMock.validateFile.mockResolvedValue({ valid: true, data: exportData });
    importServiceMock.generatePreview.mockResolvedValue({
      projects: [{ taskCount: 2, connectionCount: 1 }],
    });
    const service = TestBed.inject(LocalBackupUIService);

    await service.handleRestoreFromLocalBackup();
    service.selectRestoreFile(0);
    await service.loadRestorePreview([]);

    expect(service.restorePreview()).toEqual({
      projects: 1,
      tasks: 2,
      connections: 1,
      attachmentUploads: 1,
      actionQueue: 1,
      retryQueue: 2,
      deadLetters: 1,
      conflicts: 1,
    });
  });

  it('blocks restore preview when backup explicitly belongs to a different owner', async () => {
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
        name: 'Other owner project',
        description: '',
        tasks: [],
        connections: [],
      }],
    };
    const backupData = {
      payloadVersion: '2.0.0',
      projects: [{ id: 'project-1', userId: 'other-user', name: 'Other owner project' }],
      tasks: [],
      connections: [],
      localState: {
        dataSafety: {
          schemaVersion: '1.0.0',
          exportedAt: '2026-06-18T00:00:00.000Z',
          ownerUserId: 'other-user',
          syncSnapshot: {
            syncState: { lastSyncTime: null, pendingCount: 0 },
            projectCursors: [],
            queueCounts: { retryQueue: 0, actionQueue: 0, deadLetters: 0 },
          },
          replayLog: [],
          replayPlan: {
            idempotencyKey: 'restore-plan-1',
            ownerUserId: 'other-user',
            exportedAt: '2026-06-18T00:00:00.000Z',
            steps: [],
            summary: {
              replayable: 0,
              inspectOnly: 0,
              retryQueue: 0,
              actionQueue: 0,
              auditLog: 0,
            },
          },
          lastWriteExplain: null,
        },
      },
    } as unknown as BackupData;
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

    expect(service.restoreStep()).toBe('error');
    expect(service.restoreError()).toContain('其他账号');
    expect(service.restorePreview()).toBeNull();
    expect(importServiceMock.generatePreview).not.toHaveBeenCalled();
  });

  it('merges pending action queue from local backup after import succeeds', async () => {
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
    const existingAction = {
      id: 'current-action',
      operationId: 'op-current',
      type: 'update',
      entityType: 'task',
      entityId: 'task-current',
      payload: { task: { id: 'task-current', title: 'Current' }, projectId: 'project-1' },
      timestamp: 1,
      retryCount: 0,
    };
    const backupData = {
      payloadVersion: '2.0.0',
      projects: [],
      tasks: [],
      connections: [],
      localState: {
        actionQueue: [{
          id: 'restored-action',
          operationId: 'op-restored',
          type: 'update',
          entityType: 'task',
          entityId: 'task-restored',
          payload: { task: { id: 'task-restored', title: 'Restored' }, projectId: 'project-1' },
          timestamp: 2,
          retryCount: 0,
        }],
      },
    } as unknown as BackupData;
    queueBackupMock.updateQueue.mockImplementation(async (_ownerUserId, updater) =>
      updater([existingAction], { recordFound: true })
    );
    localBackupServiceMock.listBackupFiles.mockResolvedValue([{ name: 'backup.json', timestamp: 1, size: 1024 }]);
    localBackupServiceMock.readBackupFile.mockResolvedValue(new File([JSON.stringify(backupData)], 'backup.json', { type: 'application/json' }));
    importServiceMock.validateFile.mockResolvedValue({ valid: true, data: exportData });
    importServiceMock.generatePreview.mockResolvedValue({
      projects: [{ taskCount: 0, connectionCount: 0 }],
    });
    importServiceMock.executeImport.mockResolvedValue({ success: true, importedCount: 1 });
    const service = TestBed.inject(LocalBackupUIService);

    await service.handleRestoreFromLocalBackup();
    service.selectRestoreFile(0);
    await service.loadRestorePreview([]);
    await service.confirmRestore([], vi.fn());

    expect(queueBackupMock.updateQueue).toHaveBeenCalledWith('user-1', expect.any(Function));
    expect(service.restoreResultMsg()).toBe('恢复成功！已导入 1 个项目，已恢复 1 个待同步操作');
  });

  it('merges retry queue from local backup through RetryQueueService after import succeeds', async () => {
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
        retryQueue: [retryQueueItem],
      },
    } as unknown as BackupData;
    retryQueueMock.restoreFromBackupItems.mockResolvedValue(1);
    localBackupServiceMock.listBackupFiles.mockResolvedValue([{ name: 'backup.json', timestamp: 1, size: 1024 }]);
    localBackupServiceMock.readBackupFile.mockResolvedValue(new File([JSON.stringify(backupData)], 'backup.json', { type: 'application/json' }));
    importServiceMock.validateFile.mockResolvedValue({ valid: true, data: exportData });
    importServiceMock.generatePreview.mockResolvedValue({
      projects: [{ taskCount: 0, connectionCount: 0 }],
    });
    importServiceMock.executeImport.mockResolvedValue({ success: true, importedCount: 1 });
    const service = TestBed.inject(LocalBackupUIService);

    await service.handleRestoreFromLocalBackup();
    service.selectRestoreFile(0);
    await service.loadRestorePreview([]);
    await service.confirmRestore([], vi.fn());

    expect(retryQueueMock.restoreFromBackupItems).toHaveBeenCalledWith([retryQueueItem], 'user-1');
    expect(service.restoreResultMsg()).toBe('恢复成功！已导入 1 个项目，已恢复 1 个待重试同步操作');
  });

  it('merges dead letters from local backup through ActionQueueStorageService after import succeeds', async () => {
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
    const deadLetter = {
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
    };
    const backupData = {
      payloadVersion: '2.0.0',
      projects: [],
      tasks: [],
      connections: [],
      localState: {
        deadLetters: [deadLetter],
      },
    } as unknown as BackupData;
    actionQueueStorageMock.restoreDeadLettersFromBackupItems.mockReturnValue(1);
    localBackupServiceMock.listBackupFiles.mockResolvedValue([{ name: 'backup.json', timestamp: 1, size: 1024 }]);
    localBackupServiceMock.readBackupFile.mockResolvedValue(new File([JSON.stringify(backupData)], 'backup.json', { type: 'application/json' }));
    importServiceMock.validateFile.mockResolvedValue({ valid: true, data: exportData });
    importServiceMock.generatePreview.mockResolvedValue({
      projects: [{ taskCount: 0, connectionCount: 0 }],
    });
    importServiceMock.executeImport.mockResolvedValue({ success: true, importedCount: 1 });
    const service = TestBed.inject(LocalBackupUIService);

    await service.handleRestoreFromLocalBackup();
    service.selectRestoreFile(0);
    await service.loadRestorePreview([]);
    await service.confirmRestore([], vi.fn());

    expect(actionQueueStorageMock.restoreDeadLettersFromBackupItems).toHaveBeenCalledWith([deadLetter], 'user-1');
    expect(service.restoreResultMsg()).toBe('恢复成功！已导入 1 个项目，已恢复 1 条同步失败记录');
  });

  it('restores conflict copies from local backup after import succeeds', async () => {
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
        conflicts: [conflict],
      },
    } as unknown as BackupData;
    localBackupServiceMock.listBackupFiles.mockResolvedValue([{ name: 'backup.json', timestamp: 1, size: 1024 }]);
    localBackupServiceMock.readBackupFile.mockResolvedValue(new File([JSON.stringify(backupData)], 'backup.json', { type: 'application/json' }));
    importServiceMock.validateFile.mockResolvedValue({ valid: true, data: exportData });
    importServiceMock.generatePreview.mockResolvedValue({
      projects: [{ taskCount: 0, connectionCount: 0 }],
    });
    importServiceMock.executeImport.mockResolvedValue({ success: true, importedCount: 1 });
    const service = TestBed.inject(LocalBackupUIService);

    await service.handleRestoreFromLocalBackup();
    service.selectRestoreFile(0);
    await service.loadRestorePreview([]);
    await service.confirmRestore([], vi.fn());

    expect(conflictStorageMock.saveConflict).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'project-conflict',
      ownerUserId: 'user-1',
      localProject: expect.objectContaining({ name: 'Local conflict copy' }),
    }));
    expect(service.restoreResultMsg()).toBe('恢复成功！已导入 1 个项目，已恢复 1 条冲突副本');
  });
});
