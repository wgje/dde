import { describe, expect, it } from 'vitest';
import type { BackupData } from '../../supabase/functions/_shared/backup-utils';
import {
  convertBackupDataToExportData,
  deriveAttachmentUploadOutboxRestoreTarget,
  restoreActionQueueFromBackup,
  restoreAttachmentUploadOutboxFromBackup,
  restoreConflictsFromBackup,
  restoreDeadLettersFromBackup,
  restoreRetryQueueFromBackup,
} from './import-backup-conversion.helpers';
import type { SavePendingAttachmentUploadInput } from './attachment-upload-outbox.service';
import type { DeadLetterItem, QueuedAction } from './action-queue.types';
import type { RetryQueueItem } from '../app/core/services/sync/retry-queue.service';
import type { ConflictRecord } from './conflict-storage.service';
import type { Task } from '../models';

describe('convertBackupDataToExportData', () => {
  function createBackup(overrides: Partial<BackupData> = {}): BackupData {
    return {
      version: '2.0.0',
      payloadVersion: '2.0.0',
      type: 'full',
      createdAt: '2026-06-09T00:00:00.000Z',
      checksum: 'checksum-1',
      tableCounts: {
        projects: 1,
        tasks: 1,
        connections: 1,
        userPreferences: 0,
        blackBoxEntries: 0,
        focusSessions: 0,
        transcriptionUsage: 0,
        routineTasks: 0,
        routineCompletions: 0,
      },
      coverage: {
        includesProjectData: true,
        includesCloudUserState: false,
        includesLocalState: false,
      },
      projects: [{
        id: 'project-1',
        userId: 'user-1',
        name: 'Project 1',
        description: null as unknown as string,
        createdAt: '2026-06-08T00:00:00.000Z',
        updatedAt: '2026-06-08T01:00:00.000Z',
        version: 3,
      }],
      tasks: [{
        id: 'task-1',
        projectId: 'project-1',
        title: 'Task 1',
        content: null as unknown as string,
        parentId: null,
        stage: null,
        order: undefined,
        rank: undefined,
        status: undefined,
        x: undefined,
        y: undefined,
        displayId: undefined,
        shortId: 'T1',
        attachments: [{
          id: 'attachment-1',
          name: 'doc.pdf',
          size: '42',
          mime_type: 'application/pdf',
          type: 'document',
        }],
        priority: 'high',
        dueDate: '2026-06-10',
        expected_minutes: 45,
        cognitive_load: 'low',
        wait_minutes: null,
        parkingMeta: {
          state: 'parked',
          parkedAt: '2026-06-08T02:30:00.000Z',
          contextSnapshot: null,
        },
        attentionMeta: {
          version: 1,
          items: [{
            id: 'attention-1',
            text: '恢复时保留注意事项',
            checked: false,
            createdAt: '2026-06-08T02:45:00.000Z',
            updatedAt: '2026-06-08T02:45:00.000Z',
          }],
        },
        createdAt: '2026-06-08T02:00:00.000Z',
        updatedAt: '2026-06-08T03:00:00.000Z',
        completedAt: '2026-06-08T03:30:00.000Z',
        externalSourceLinks: [{
          id: 'link-1',
          sourceType: 'siyuan-block',
          targetId: '20260609120000-abcdefg',
          uri: 'siyuan://blocks/20260609120000-abcdefg',
          sortOrder: 0,
          createdAt: '2026-06-08T04:00:00.000Z',
          updatedAt: '2026-06-08T04:00:00.000Z',
        }],
      }],
      connections: [{
        id: 'connection-1',
        projectId: 'project-1',
        source: 'task-1',
        target: 'task-2',
        title: 'Connection 1',
        deletedAt: null,
      }],
      userPreferences: [],
      blackBoxEntries: [],
      focusSessions: [],
      transcriptionUsage: [],
      routineTasks: [],
      routineCompletions: [],
      ...overrides,
    };
  }

  it('groups flat backup rows into export projects and preserves metadata counts', () => {
    const exportData = convertBackupDataToExportData(createBackup());

    expect(exportData).toEqual({
      metadata: {
        exportedAt: '2026-06-09T00:00:00.000Z',
        version: '2.0.0',
        appVersion: 'backup-restore',
        projectCount: 1,
        taskCount: 1,
        connectionCount: 1,
        attachmentCount: 1,
        checksum: '',
        exportType: 'full',
      },
      projects: [{
        id: 'project-1',
        name: 'Project 1',
        description: '',
        createdAt: '2026-06-08T00:00:00.000Z',
        updatedAt: '2026-06-08T01:00:00.000Z',
        version: 3,
        tasks: [{
          id: 'task-1',
          title: 'Task 1',
          content: '',
          stage: null,
          parentId: null,
          order: 0,
          rank: 0,
          status: 'active',
          x: 0,
          y: 0,
          displayId: 'T1',
          shortId: 'T1',
          createdAt: '2026-06-08T02:00:00.000Z',
          updatedAt: '2026-06-08T03:00:00.000Z',
          completedAt: '2026-06-08T03:30:00.000Z',
          deletedAt: undefined,
          attachments: [{
            id: 'attachment-1',
            name: 'doc.pdf',
            size: 42,
            mimeType: 'application/pdf',
            type: 'document',
          }],
          tags: undefined,
          priority: 'high',
          dueDate: '2026-06-10',
          expected_minutes: 45,
          cognitive_load: 'low',
          wait_minutes: null,
          parkingMeta: {
            state: 'parked',
            parkedAt: '2026-06-08T02:30:00.000Z',
            contextSnapshot: null,
          },
          attentionMeta: {
            version: 1,
            items: [{
              id: 'attention-1',
              text: '恢复时保留注意事项',
              checked: false,
              createdAt: '2026-06-08T02:45:00.000Z',
              updatedAt: '2026-06-08T02:45:00.000Z',
            }],
          },
          externalSourceLinks: expect.any(Array),
        }],
        connections: [{
          id: 'connection-1',
          source: 'task-1',
          target: 'task-2',
          title: 'Connection 1',
        description: undefined,
          updatedAt: undefined,
          deletedAt: null,
        }],
      }],
    });
  });

  it('preserves completed task history and connection LWW timestamps', () => {
    const exportData = convertBackupDataToExportData(createBackup({
      tasks: [{
        id: 'task-completed',
        projectId: 'project-1',
        title: 'Completed task',
        status: 'completed',
        completedAt: '2026-06-08T04:00:00.000Z',
        updatedAt: '2026-06-08T05:00:00.000Z',
      }],
      connections: [{
        id: 'connection-lww',
        projectId: 'project-1',
        source: 'task-completed',
        target: 'task-2',
        updatedAt: '2026-06-08T06:00:00.000Z',
      }],
    }));

    expect(exportData?.projects[0].tasks[0]).toEqual(expect.objectContaining({
      id: 'task-completed',
      completedAt: '2026-06-08T04:00:00.000Z',
      updatedAt: '2026-06-08T05:00:00.000Z',
    }));
    expect(exportData?.projects[0].connections[0]).toEqual(expect.objectContaining({
      id: 'connection-lww',
      updatedAt: '2026-06-08T06:00:00.000Z',
    }));
  });
});

describe('restoreAttachmentUploadOutboxFromBackup', () => {
  it('restores pending attachment upload blobs from JSON backup local state', async () => {
    const savedUploads: Array<{
      attachmentId: string;
      blobKey: string;
      fileName: string;
      mimeType: string;
      size: number;
      createdAt?: string;
      blob: Blob;
    }> = [];

    const restoredCount = await restoreAttachmentUploadOutboxFromBackup({
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
    } as BackupData, {
      savePendingUpload: async (upload) => {
        savedUploads.push(upload);
      },
    });

    expect(restoredCount).toBe(1);
    expect(savedUploads).toHaveLength(1);
    expect(savedUploads[0]).toEqual(expect.objectContaining({
      attachmentId: 'attachment-1',
      blobKey: 'attachment-1',
      fileName: 'offline.txt',
      mimeType: 'text/plain',
      size: 2,
      createdAt: '2026-06-18T00:00:00.000Z',
    }));
    expect(Array.from(new Uint8Array(await savedUploads[0].blob.arrayBuffer()))).toEqual([78, 70]);
  });

  it('projects the complete owner-scoped upsert result from pre-image and backup', async () => {
    const ownerUserId = 'restore-owner';
    const makeUpload = (
      attachmentId: string,
      blobKey: string,
      operationId: string,
      blobBase64: string,
    ) => ({
      ownerUserId,
      operationId,
      attachmentId,
      blobKey,
      fileName: `${attachmentId}.txt`,
      mimeType: 'text/plain',
      size: 1,
      createdAt: '2026-06-18T00:00:00.000Z',
      encoding: 'base64' as const,
      blobBase64,
    });
    const preImage = [
      makeUpload('attachment-replaced-old', 'blob-same', 'operation-same', 'QQ=='),
      makeUpload('attachment-kept', 'blob-kept', 'operation-kept', 'RA=='),
    ];
    const backup = {
      localState: {
        dataSafety: { ownerUserId },
        attachmentUploadOutbox: [
          makeUpload('attachment-replaced', 'blob-same', 'operation-same', 'Qg=='),
          makeUpload('attachment-added', 'blob-added', 'operation-added', 'Qw=='),
        ],
      },
    } as BackupData;
    const target = deriveAttachmentUploadOutboxRestoreTarget(preImage, backup, ownerUserId);
    const persisted = new Map<string, SavePendingAttachmentUploadInput>();
    const identity = (upload: Pick<SavePendingAttachmentUploadInput, 'ownerUserId' | 'blobKey' | 'operationId'>) => (
      JSON.stringify([upload.ownerUserId, upload.blobKey, upload.operationId])
    );
    const toSaveInput = (upload: typeof preImage[number]): SavePendingAttachmentUploadInput => ({
      ownerUserId: upload.ownerUserId,
      operationId: upload.operationId,
      attachmentId: upload.attachmentId,
      blobKey: upload.blobKey,
      fileName: upload.fileName,
      mimeType: upload.mimeType,
      size: upload.size,
      createdAt: upload.createdAt,
      blob: new Blob([
        Uint8Array.from(atob(upload.blobBase64), character => character.charCodeAt(0)),
      ], { type: upload.mimeType }),
    });
    for (const upload of preImage) {
      persisted.set(identity(upload), toSaveInput(upload));
    }

    const restoredCount = await restoreAttachmentUploadOutboxFromBackup(backup, {
      savePendingUpload: async upload => {
        persisted.set(identity(upload), upload);
      },
    });
    const actual = await Promise.all(Array.from(persisted.values(), async upload => {
      const bytes = new Uint8Array(await upload.blob.arrayBuffer());
      const blobBase64 = btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(''));
      return {
        ownerUserId: upload.ownerUserId,
        operationId: upload.operationId,
        attachmentId: upload.attachmentId,
        blobKey: upload.blobKey,
        fileName: upload.fileName,
        mimeType: upload.mimeType,
        size: upload.size,
        createdAt: upload.createdAt,
        encoding: 'base64' as const,
        blobBase64,
      };
    }));
    actual.sort((left, right) => left.blobKey.localeCompare(right.blobKey)
      || left.operationId.localeCompare(right.operationId));

    expect(restoredCount).toBe(2);
    expect(actual).toEqual(target);
  });
});

describe('restoreActionQueueFromBackup', () => {
  function createAction(overrides: Partial<QueuedAction> = {}): QueuedAction {
    return {
      id: overrides.id ?? 'action-1',
      operationId: overrides.operationId ?? 'operation-1',
      type: 'update',
      entityType: 'task',
      entityId: 'task-1',
      payload: {
        task: { id: 'task-1', title: 'Task' },
        projectId: 'project-1',
      } as QueuedAction['payload'],
      timestamp: 1,
      retryCount: 0,
      ...overrides,
    };
  }

  it('merges backup action queue into current persisted queue without duplicating operation ids', async () => {
    const currentAction = createAction({
      id: 'current-action',
      operationId: 'op-current',
    });
    const backupDuplicate = createAction({
      id: 'backup-duplicate-current',
      operationId: 'op-current',
    });
    const backupOnlyAction = createAction({
      id: 'backup-only-action',
      operationId: 'op-backup-only',
      syncState: 'syncing',
    });
    const updaterCalls: QueuedAction[][] = [];

    const restoredCount = await restoreActionQueueFromBackup({
      localState: {
        actionQueue: [backupDuplicate, backupOnlyAction],
      },
    } as BackupData, 'user-1', {
      updateQueue: async (_ownerUserId, updater) => {
        updaterCalls.push([currentAction]);
        return updater([currentAction], { recordFound: true });
      },
    });

    expect(restoredCount).toBe(1);
    expect(updaterCalls).toEqual([[currentAction]]);
    expect(await restoreActionQueueFromBackup({
      localState: {
        actionQueue: { actions: [backupOnlyAction] },
      },
    } as BackupData, 'user-1', {
      updateQueue: async (_ownerUserId, updater) => updater([backupOnlyAction], { recordFound: true }),
    })).toBe(0);
  });

  it('skips dead_letter actions from legacy localState.actionQueue instead of reviving them as pending', async () => {
    const deadLetterAction = createAction({
      id: 'dead-letter-action',
      operationId: 'op-dead-letter',
      syncState: 'dead_letter',
      retryCount: 5,
      lastError: 'business failure',
      errorType: 'business',
    });
    const updateQueue = vi.fn();

    const restoredCount = await restoreActionQueueFromBackup({
      localState: {
        actionQueue: [deadLetterAction],
      },
    } as BackupData, 'user-1', { updateQueue });

    expect(restoredCount).toBe(0);
    expect(updateQueue).not.toHaveBeenCalled();
  });

  it('returns zero when backup action queue is missing or invalid', async () => {
    const updateQueue = vi.fn();

    await expect(restoreActionQueueFromBackup({ localState: {} } as BackupData, 'user-1', {
      updateQueue,
    })).resolves.toBe(0);

    await expect(restoreActionQueueFromBackup({
      localState: { actionQueue: { actions: 'not-array' } },
    } as BackupData, 'user-1', {
      updateQueue,
    })).resolves.toBe(0);
    expect(updateQueue).not.toHaveBeenCalled();
  });
});

describe('restoreRetryQueueFromBackup', () => {
  function createRetryQueueItem(overrides: Partial<RetryQueueItem> = {}): RetryQueueItem {
    return {
      id: overrides.id ?? '11111111-1111-4111-8111-111111111111',
      type: 'task',
      operation: 'upsert',
      data: {
        id: '22222222-2222-4222-8222-222222222222',
        title: 'Retry task',
      } as RetryQueueItem['data'],
      projectId: 'project-1',
      retryCount: 0,
      createdAt: 1,
      sourceUserId: 'user-1',
      operationId: 'op-retry-1',
      ...overrides,
    };
  }

  it('delegates backup retry queue restore to RetryQueueService without bypassing its safeguards', async () => {
    const restoredItem = createRetryQueueItem({
      lastFailure: {
        errorType: 'network',
        message: 'remote write outcome is unknown',
        remoteOutcome: 'unknown',
        recordedAt: 10,
      },
    });
    const retryQueue = {
      restoreFromBackupItems: vi.fn(async () => 1),
    };

    const restoredCount = await restoreRetryQueueFromBackup({
      localState: {
        retryQueue: [restoredItem],
      },
    } as BackupData, 'user-1', retryQueue);

    expect(restoredCount).toBe(1);
    expect(retryQueue.restoreFromBackupItems).toHaveBeenCalledWith([restoredItem], 'user-1');
  });

  it('returns zero when backup retry queue is missing or invalid', async () => {
    const retryQueue = {
      restoreFromBackupItems: vi.fn(),
    };

    await expect(restoreRetryQueueFromBackup({ localState: {} } as BackupData, 'user-1', retryQueue))
      .resolves.toBe(0);
    await expect(restoreRetryQueueFromBackup({
      localState: { retryQueue: 'not-array' as unknown as unknown[] },
    } as BackupData, 'user-1', retryQueue)).resolves.toBe(0);

    expect(retryQueue.restoreFromBackupItems).not.toHaveBeenCalled();
  });
});

describe('restoreDeadLettersFromBackup', () => {
  function createDeadLetter(overrides: Partial<DeadLetterItem> = {}): DeadLetterItem {
    return {
      action: {
        id: 'action-1',
        operationId: 'operation-1',
        type: 'update',
        entityType: 'task',
        entityId: 'task-1',
        payload: {
          task: { id: 'task-1', title: 'Task' },
          projectId: 'project-1',
          sourceUserId: 'user-1',
        } as QueuedAction['payload'],
        timestamp: 1,
        retryCount: 5,
        syncState: 'dead_letter',
      },
      failedAt: '2026-06-18T00:00:00.000Z',
      reason: 'business failure',
      ...overrides,
    };
  }

  it('delegates backup dead letters restore to ActionQueueStorageService', () => {
    const deadLetter = createDeadLetter();
    const actionQueueStorage = {
      restoreDeadLettersFromBackupItems: vi.fn(() => 1),
    };

    const restoredCount = restoreDeadLettersFromBackup({
      localState: {
        deadLetters: [deadLetter],
      },
    } as BackupData, 'user-1', actionQueueStorage);

    expect(restoredCount).toBe(1);
    expect(actionQueueStorage.restoreDeadLettersFromBackupItems).toHaveBeenCalledWith([deadLetter], 'user-1');
  });

  it('returns zero when backup dead letters are missing or invalid', () => {
    const actionQueueStorage = {
      restoreDeadLettersFromBackupItems: vi.fn(),
    };

    expect(restoreDeadLettersFromBackup({ localState: {} } as BackupData, 'user-1', actionQueueStorage))
      .toBe(0);
    expect(restoreDeadLettersFromBackup({
      localState: { deadLetters: 'not-array' as unknown as unknown[] },
    } as BackupData, 'user-1', actionQueueStorage)).toBe(0);
    expect(actionQueueStorage.restoreDeadLettersFromBackupItems).not.toHaveBeenCalled();
  });
});

describe('restoreConflictsFromBackup', () => {
  function createConflict(overrides: Partial<ConflictRecord> = {}): ConflictRecord {
    return {
      projectId: overrides.projectId ?? 'project-1',
      ownerUserId: overrides.ownerUserId ?? 'user-1',
      localProject: overrides.localProject ?? {
        id: overrides.projectId ?? 'project-1',
        name: 'Local conflict',
        description: '',
        createdDate: '2026-06-18T00:00:00.000Z',
        updatedAt: '2026-06-18T00:00:00.000Z',
        version: 2,
        tasks: [],
        connections: [],
      },
      remoteProject: overrides.remoteProject,
      conflictedAt: overrides.conflictedAt ?? '2026-06-18T00:00:00.000Z',
      localVersion: overrides.localVersion ?? 2,
      remoteVersion: overrides.remoteVersion,
      reason: overrides.reason ?? 'version_mismatch',
      acknowledged: overrides.acknowledged ?? false,
      conflictedFields: overrides.conflictedFields,
      operationConflicts: overrides.operationConflicts,
    };
  }

  it('restores only valid conflict records scoped to the target owner', async () => {
    const savedConflicts: ConflictRecord[] = [];
    const ownerConflict = createConflict({ projectId: 'project-owner', ownerUserId: 'user-1' });
    const crossOwnerConflict = createConflict({ projectId: 'project-other', ownerUserId: 'user-2' });

    const restoredCount = await restoreConflictsFromBackup({
      localState: {
        conflicts: [
          ownerConflict,
          crossOwnerConflict,
          { projectId: 'missing-local-project', ownerUserId: 'user-1' },
          'invalid-conflict',
        ],
      },
    } as BackupData, 'user-1', {
      saveConflict: async (record) => {
        savedConflicts.push(record);
        return true;
      },
    });

    expect(restoredCount).toBe(1);
    expect(savedConflicts).toEqual([
      expect.objectContaining({
        projectId: 'project-owner',
        ownerUserId: 'user-1',
        localProject: expect.objectContaining({ name: 'Local conflict' }),
      }),
    ]);
  });

  it('preserves valid operation-level conflict evidence during restore', async () => {
    const savedConflicts: ConflictRecord[] = [];
    const localTask: Task = {
      id: 'task-1',
      title: 'Local task',
      content: 'local',
      stage: null,
      parentId: null,
      order: 0,
      rank: 0,
      status: 'active',
      x: 0,
      y: 0,
      createdDate: '2026-06-18T00:00:00.000Z',
      updatedAt: '2026-06-18T00:01:00.000Z',
      displayId: 'T1',
    };
    const remoteTask: Task = {
      ...localTask,
      title: 'Remote task',
      content: 'remote',
      updatedAt: '2026-06-18T00:02:00.000Z',
    };
    const conflict = createConflict({
      operationConflicts: [{
        actionType: 'task:update',
        entityType: 'task',
        entityId: 'task-1',
        projectId: 'project-1',
        operationId: 'op-task-1',
        localEntity: localTask,
        remoteEntity: remoteTask,
        message: 'Remote task is newer',
        conflictedAt: '2026-06-18T00:03:00.000Z',
        reason: 'remote-newer',
      }],
    });

    const restoredCount = await restoreConflictsFromBackup({
      localState: { conflicts: [conflict] },
    } as BackupData, 'user-1', {
      saveConflict: async (record) => {
        savedConflicts.push(record);
        return true;
      },
    });

    expect(restoredCount).toBe(1);
    expect(savedConflicts[0].operationConflicts).toEqual(conflict.operationConflicts);
  });

  it('skips conflict records whose operation-level evidence is structurally incomplete', async () => {
    const saveConflict = vi.fn(async () => true);
    const malformedConflict = createConflict() as unknown as Record<string, unknown>;
    malformedConflict['operationConflicts'] = [{
      actionType: 'task:update',
      entityType: 'task',
      entityId: 'task-1',
      projectId: 'project-1',
      message: 'Missing local entity and reason',
      conflictedAt: '2026-06-18T00:03:00.000Z',
    }];

    const restoredCount = await restoreConflictsFromBackup({
      localState: { conflicts: [malformedConflict] },
    } as BackupData, 'user-1', { saveConflict });

    expect(restoredCount).toBe(0);
    expect(saveConflict).not.toHaveBeenCalled();
  });
});
