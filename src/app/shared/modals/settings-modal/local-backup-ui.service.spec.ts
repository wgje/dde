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
import { BackupDataSafetyMetadataRestoreService } from '../../../../services/backup-data-safety-metadata-restore.service';
import { DisasterBackupService } from '../../../../services/disaster-backup.service';
import { LocalBackupUiRestoreStageService } from '../../../../services/local-backup-ui-restore-stage.service';
import { LocalBackupUiRestoreTransactionService } from '../../../../services/local-backup-ui-restore-transaction.service';
import { convertBackupDataToExportData } from '../../../../services/import-backup-conversion.helpers';
import type { BackupData } from '../../../../../supabase/functions/_shared/backup-utils';
import type { ExportData } from '../../../../services/export.service';
import { LOCAL_BACKUP_CONFIG } from '../../../../config/local-backup.config';

describe('LocalBackupUIService', () => {
  const autoBackupEnabled = signal(false);
  const autoBackupIntervalMs = signal(LOCAL_BACKUP_CONFIG.DEFAULT_INTERVAL_MS);
  const isAuthorized = signal(false);
  const alertMock = vi.fn();

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
  };

  const authMock = { currentUserId: vi.fn(), captureAuthIdentityFence: vi.fn() };

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
  const abortPreparedRestore = vi.fn();
  const restoreTransactionMock = {
    prepare: vi.fn(),
  };
  const restoreStageMock = {
    createOperations: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('alert', alertMock);
    autoBackupEnabled.set(false);
    isAuthorized.set(false);
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
    preparedRestoreRun.mockResolvedValue({
      status: 'completed',
      stageResults: { projects: 1 },
    });
    abortPreparedRestore.mockResolvedValue(undefined);
    restoreTransactionMock.prepare.mockResolvedValue({
      verifyOwnership: vi.fn().mockResolvedValue(true),
      run: preparedRestoreRun,
      abortBeforeMutation: abortPreparedRestore,
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

  it('downloads a portable data-safety package without directory authorization and marks incomplete cloud coverage', async () => {
    const blob = new Blob(['{"payloadVersion":"2.0.0"}'], { type: 'application/json' });
    const createObjectURL = vi.fn(() => 'blob:data-safety');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    disasterBackupMock.buildLocalBlob.mockResolvedValue({
      payload: {
        coverage: {
          includesProjectData: true,
          includesCloudUserState: false,
          includesLocalState: true,
        },
      },
      blob,
      deferredCloudUserState: true,
    });
    const service = TestBed.inject(LocalBackupUIService);
    const projects = [{
      id: 'project-1',
      name: 'Project 1',
      description: '',
      createdDate: '2026-06-18T00:00:00.000Z',
      tasks: [],
      connections: [],
    }];

    await service.handleDownloadDataSafetyPackage(projects);

    expect(disasterBackupMock.buildLocalBlob).toHaveBeenCalledWith(projects, {
      autoBackupEnabled: false,
      autoBackupIntervalMs: LOCAL_BACKUP_CONFIG.DEFAULT_INTERVAL_MS,
    });
    expect(createObjectURL).toHaveBeenCalledWith(blob);
    expect(click).toHaveBeenCalledTimes(1);
    expect(alertMock).toHaveBeenCalledWith(expect.stringContaining('includesCloudUserState=false'));
    expect(service.isExportingDataSafetyPackage()).toBe(false);
  });

  it('downloads local queues and sync metadata even when there are no projects', async () => {
    const blob = new Blob(['{"payloadVersion":"2.0.0"}'], { type: 'application/json' });
    const createObjectURL = vi.fn(() => 'blob:data-safety-empty-projects');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    disasterBackupMock.buildLocalBlob.mockResolvedValue({
      payload: {
        coverage: {
          includesProjectData: true,
          includesCloudUserState: false,
          includesLocalState: true,
        },
      },
      blob,
      deferredCloudUserState: false,
    });
    const service = TestBed.inject(LocalBackupUIService);

    await service.handleDownloadDataSafetyPackage([]);

    expect(disasterBackupMock.buildLocalBlob).toHaveBeenCalledWith([], {
      autoBackupEnabled: false,
      autoBackupIntervalMs: LOCAL_BACKUP_CONFIG.DEFAULT_INTERVAL_MS,
    });
    expect(createObjectURL).toHaveBeenCalledWith(blob);
    expect(click).toHaveBeenCalledTimes(1);
    expect(alertMock).not.toHaveBeenCalledWith('没有可导出的项目');
  });

  it('loads restore preview directly from a selected data-safety package file', async () => {
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
      projects: [{ id: 'project-1', userId: 'user-1' }],
      tasks: [],
      connections: [],
      localState: {},
    } as unknown as BackupData;
    const file = new File([JSON.stringify(backupData)], 'portable-backup.json', {
      type: 'application/json',
    });
    importServiceMock.validateFile.mockResolvedValue({ valid: true, data: exportData });
    importServiceMock.generatePreview.mockResolvedValue({
      projects: [{ taskCount: 0, connectionCount: 0 }],
    });
    const service = TestBed.inject(LocalBackupUIService);

    await service.loadRestorePreviewFromFile(file, []);

    expect(importServiceMock.validateFile).toHaveBeenCalledWith(file);
    expect(service.restoreStep()).toBe('preview');
    expect(service.restorePreview()).toEqual(expect.objectContaining({ projects: 1 }));

    service.backFromRestorePreview();

    expect(service.restoreStep()).toBe('idle');
  });

  it('rejects malformed attachment outbox data before creating a pending restore', async () => {
    const backupData = {
      payloadVersion: '2.0.0',
      projects: [],
      tasks: [],
      connections: [],
      localState: {
        dataSafety: { ownerUserId: 'user-1' },
        attachmentUploadOutbox: [{
          operationId: 'attachment:create:attachment-1',
          attachmentId: 'attachment-1',
          blobKey: 'attachment-1',
          fileName: 'offline.txt',
          mimeType: 'text/plain',
          size: 2,
          createdAt: '2026-07-28T00:00:00.000Z',
          encoding: 'base64',
          blobBase64: 'TkY=',
        }],
      },
    } as unknown as BackupData;
    const file = new File([JSON.stringify(backupData)], 'unsafe-backup.json', {
      type: 'application/json',
    });
    importServiceMock.validateFile.mockImplementation(async candidate => {
      const parsed = JSON.parse(await candidate.text()) as BackupData;
      const data = convertBackupDataToExportData(parsed);
      return data
        ? { valid: true, data }
        : { valid: false, error: '本地备份数据转换失败' };
    });
    importServiceMock.generatePreview.mockResolvedValue({ projects: [] });
    const service = TestBed.inject(LocalBackupUIService);

    await service.loadRestorePreviewFromFile(file, []);
    await service.confirmRestore([]);

    expect(service.restoreStep()).toBe('error');
    expect(service.restorePreview()).toBeNull();
    expect(restoreTransactionMock.prepare).not.toHaveBeenCalled();
    expect(preparedRestoreRun).not.toHaveBeenCalled();
    expect(service.restoreResultMsg()).toBe('');
  });

  it('rejects malformed conflicts before preview or transaction preparation', async () => {
    const backupData = {
      payloadVersion: '2.0.0', projects: [], tasks: [], connections: [],
      localState: {
        dataSafety: { ownerUserId: 'user-1' },
        conflicts: [{ projectId: 'broken', ownerUserId: 'user-1' }],
      },
    } as unknown as BackupData;
    importServiceMock.validateFile.mockImplementation(async candidate => {
      const data = convertBackupDataToExportData(JSON.parse(await candidate.text()) as BackupData);
      return data ? { valid: true, data } : { valid: false, error: '本地备份数据转换失败' };
    });
    const service = TestBed.inject(LocalBackupUIService);
    await service.loadRestorePreviewFromFile(
      new File([JSON.stringify(backupData)], 'unsafe-conflicts.json', { type: 'application/json' }), [],
    );
    expect(service.restoreStep()).toBe('error');
    expect(importServiceMock.generatePreview).not.toHaveBeenCalled();
    expect(restoreTransactionMock.prepare).not.toHaveBeenCalled();
  });

  it('aborts preparation when post-preview conflict tampering fails stage creation', async () => {
    const backupData = {
      payloadVersion: '2.0.0', projects: [], tasks: [], connections: [],
      localState: { dataSafety: { ownerUserId: 'user-1' }, conflicts: [] },
    } as unknown as BackupData;
    await prepareRestorePreview(backupData, createExportDataForRestore());
    backupData.localState!.conflicts = [{ ownerUserId: 'other-owner' }];
    restoreStageMock.createOperations.mockImplementationOnce(() => {
      throw new Error('conflict restore payload is invalid');
    });
    const service = TestBed.inject(LocalBackupUIService);
    await service.confirmRestore([]);

    expect(restoreTransactionMock.prepare).toHaveBeenCalledTimes(1);
    expect(abortPreparedRestore).toHaveBeenCalledTimes(1);
    expect(preparedRestoreRun).not.toHaveBeenCalled();
  });

  it('reports pending attachment upload restoration from the prepared stage result', async () => {
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
        dataSafety: { ownerUserId: 'user-1' },
        retryQueue: [{
          id: '33333333-3333-4333-8333-333333333333',
          operationId: '44444444-4444-4444-8444-444444444444',
          type: 'task',
          operation: 'upsert',
          data: { id: '55555555-5555-4555-8555-555555555555' },
          retryCount: 0,
          createdAt: Date.parse('2026-07-27T00:00:00.000Z'),
          sourceUserId: 'user-1',
        }],
        attachmentUploadOutbox: [{
          ownerUserId: 'user-1',
          operationId: 'attachment:create:attachment-1',
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
    preparedRestoreRun.mockResolvedValueOnce({
      status: 'completed',
      stageResults: { projects: 1, 'attachment-outbox': 1 },
    });
    const service = TestBed.inject(LocalBackupUIService);

    await service.handleRestoreFromLocalBackup();
    service.selectRestoreFile(0);
    await service.loadRestorePreview([]);
    expect(service.restorePreview()?.attachmentUploads).toBe(1);
    await service.confirmRestore([]);

    expect(restoreStageMock.createOperations).toHaveBeenCalledWith(expect.objectContaining({
      ownerUserId: 'user-1',
      backup: backupData,
    }));
    expect(restoreTransactionMock.prepare).toHaveBeenCalledWith(expect.objectContaining({
      retryQueueRestoreItems: backupData.localState?.retryQueue,
    }));
    expect(importServiceMock.executeImport).not.toHaveBeenCalled();
    expect(attachmentUploadOutboxMock.savePendingUpload).not.toHaveBeenCalled();
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
        dataSafety: { ownerUserId: 'user-1' },
        actionQueue: {
          actions: [
            {
              id: 'action-1',
              operationId: '88888888-8888-4888-8888-888888888888',
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
      attachmentUploads: 0,
      actionQueue: 1,
      retryQueue: 2,
      deadLetters: 1,
      conflicts: 1,
      projectCursors: 0,
      lastSyncTime: 0,
      replayLog: 0,
      lastWriteExplain: 0,
      taskTombstones: 0,
      connectionTombstones: 0,
    });
  });

  it('previews and restores validated data-safety metadata after project and queue restore succeeds', async () => {
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
      projects: [{ id: 'project-1', userId: 'user-1' }],
      tasks: [],
      connections: [],
      localState: {
        dataSafety: {
          schemaVersion: '1.0.0',
          ownerUserId: 'user-1',
        },
      },
    } as unknown as BackupData;
    const metadataCounts = {
      projectCursors: 1,
      lastSyncTime: 1,
      replayLog: 2,
      lastWriteExplain: 1,
      taskTombstones: 1,
      connectionTombstones: 1,
    };
    metadataRestoreMock.preview.mockResolvedValue({
      ownerUserId: 'user-1',
      target: {},
      counts: metadataCounts,
    });
    metadataRestoreMock.restore.mockResolvedValue(metadataCounts);
    localBackupServiceMock.listBackupFiles.mockResolvedValue([
      { name: 'backup.json', timestamp: 1, size: 1024 },
    ]);
    localBackupServiceMock.readBackupFile.mockResolvedValue(
      new File([JSON.stringify(backupData)], 'backup.json', { type: 'application/json' }),
    );
    importServiceMock.validateFile.mockResolvedValue({ valid: true, data: exportData });
    importServiceMock.generatePreview.mockResolvedValue({
      projects: [{ taskCount: 0, connectionCount: 0 }],
    });
    preparedRestoreRun.mockResolvedValueOnce({
      status: 'completed',
      stageResults: { projects: 1, metadata: metadataCounts },
    });
    const service = TestBed.inject(LocalBackupUIService);

    await service.handleRestoreFromLocalBackup();
    service.selectRestoreFile(0);
    await service.loadRestorePreview([]);

    expect(metadataRestoreMock.preview).toHaveBeenCalledWith(backupData, 'user-1');
    expect(service.restorePreview()).toEqual(expect.objectContaining(metadataCounts));

    await service.confirmRestore([]);

    expect(metadataRestoreMock.restore).not.toHaveBeenCalled();
    expect(restoreStageMock.createOperations).toHaveBeenCalledWith(expect.objectContaining({
      ownerUserId: 'user-1',
      backup: backupData,
    }));
    expect(service.restoreResultMsg()).toContain('已恢复 1 个项目同步游标');
    expect(service.restoreResultMsg()).toContain('已恢复 2 条写入审计');
    expect(service.restoreResultMsg()).toContain('已恢复最近写入解释');
  });

  it('reports a rolled-back restore without claiming success', async () => {
    const backupData = {
      payloadVersion: '2.0.0',
      projects: [],
      tasks: [],
      connections: [],
      localState: { dataSafety: { ownerUserId: 'user-1' } },
    } as unknown as BackupData;
    const exportData = createExportDataForRestore();
    await prepareRestorePreview(backupData, exportData);
    preparedRestoreRun.mockResolvedValueOnce({
      status: 'rolled-back',
      error: new Error('stage failed'),
      stageResults: {},
    });
    const service = TestBed.inject(LocalBackupUIService);

    await service.confirmRestore([]);

    expect(service.restoreStep()).toBe('error');
    expect(service.restoreError()).toContain('已恢复到写入前状态');
    expect(service.restoreResultMsg()).toBe('');
  });

  it('keeps a truthful blocked state when restore ownership is lost', async () => {
    const backupData = {
      payloadVersion: '2.0.0',
      projects: [],
      tasks: [],
      connections: [],
      localState: { dataSafety: { ownerUserId: 'user-1' } },
    } as unknown as BackupData;
    const exportData = createExportDataForRestore();
    await prepareRestorePreview(backupData, exportData);
    preparedRestoreRun.mockResolvedValueOnce({
      status: 'blocked',
      error: new Error('ownership lost'),
      ownershipLost: true,
      dataState: 'partial',
      stageResults: {},
    });
    const service = TestBed.inject(LocalBackupUIService);

    await service.confirmRestore([]);

    expect(service.restoreStep()).toBe('error');
    expect(service.restoreError()).toContain('恢复所有权已丢失');
    expect(service.restoreError()).toContain('安全标记和写入冻结已保留');
    expect(service.restoreResultMsg()).toBe('');
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

  it.each([
    {
      name: 'owner evidence is missing',
      projects: [],
      localState: {},
    },
    {
      name: 'project owners disagree with the safety owner',
      projects: [{ id: 'project-1', userId: 'other-user' }],
      localState: { dataSafety: { ownerUserId: 'user-1' } },
    },
    {
      name: 'projects contain multiple owners',
      projects: [
        { id: 'project-1', userId: 'user-1' },
        { id: 'project-2', userId: 'other-user' },
      ],
      localState: { dataSafety: { ownerUserId: 'user-1' } },
    },
  ])('fails closed before preview when $name', async ({ projects, localState }) => {
    const backupData = {
      payloadVersion: '2.0.0',
      projects,
      tasks: [],
      connections: [],
      localState,
    } as unknown as BackupData;
    await prepareRestorePreview(backupData, createExportDataForRestore());
    const service = TestBed.inject(LocalBackupUIService);

    expect(service.restoreStep()).toBe('error');
    expect(service.restoreError()).toContain('无法验证本地备份所属账号');
    expect(service.restorePreview()).toBeNull();
    expect(importServiceMock.generatePreview).not.toHaveBeenCalled();
    expect(metadataRestoreMock.preview).not.toHaveBeenCalled();
    expect(restoreTransactionMock.prepare).not.toHaveBeenCalled();
  });

  it('rejects unsupported ActionQueue operationIds before transaction preparation', async () => {
    const backupData = {
      payloadVersion: '2.0.0',
      projects: [{ id: 'project-1', userId: 'user-1' }],
      tasks: [],
      connections: [],
      localState: {
        dataSafety: { ownerUserId: 'user-1' },
        actionQueue: [{
          id: 'action-1',
          operationId: 'legacy-operation-7',
          type: 'update',
          entityType: 'task',
          entityId: 'task-1',
          payload: { projectId: 'project-1' },
          timestamp: 1,
          retryCount: 0,
        }],
      },
    } as unknown as BackupData;
    await prepareRestorePreview(backupData, createExportDataForRestore());
    const service = TestBed.inject(LocalBackupUIService);

    await service.confirmRestore([]);

    expect(service.restoreStep()).toBe('error');
    expect(service.restoreError()).toContain('ActionQueue operationId 格式无效');
    expect(restoreTransactionMock.prepare).not.toHaveBeenCalled();
    expect(restoreStageMock.createOperations).not.toHaveBeenCalled();
  });

  function createExportDataForRestore(): ExportData {
    return {
      metadata: {
        exportedAt: '2026-07-27T00:00:00.000Z',
        version: '2.0.0',
        appVersion: 'phase-2c1-test',
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
  }

  async function prepareRestorePreview(
    backupData: BackupData,
    exportData: ExportData,
  ): Promise<void> {
    localBackupServiceMock.listBackupFiles.mockResolvedValue([
      { name: 'backup.json', timestamp: 1, size: 1024 },
    ]);
    localBackupServiceMock.readBackupFile.mockResolvedValue(
      new File([JSON.stringify(backupData)], 'backup.json', { type: 'application/json' }),
    );
    importServiceMock.validateFile.mockResolvedValue({
      valid: true,
      data: exportData,
      rawBackupData: backupData,
    });
    importServiceMock.generatePreview.mockResolvedValue({
      projects: [{ taskCount: 0, connectionCount: 0 }],
    });
    const service = TestBed.inject(LocalBackupUIService);
    await service.handleRestoreFromLocalBackup();
    service.selectRestoreFile(0);
    await service.loadRestorePreview([]);
  }

});
