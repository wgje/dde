import { afterEach, describe, expect, it, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import type { BackupData } from '../../supabase/functions/_shared/backup-utils';

import { SYNC_CONFIG } from '../config';
import { ProjectDataService, RetryQueueService } from '../core-bridge';
import { ExternalSourceCacheService } from '../app/core/external-sources/external-source-cache.service';
import { ImportService } from './import.service';
import { ProjectStateService } from './project-state.service';
import { AttachmentUploadOutboxService } from './attachment-upload-outbox.service';
import { QueueBackupService } from './queue-backup.service';
import type { QueuedAction } from './action-queue.types';
import { ActionQueueStorageService } from './action-queue-storage.service';
import { ConflictStorageService, type ConflictRecord } from './conflict-storage.service';
import { BackupDataSafetyMetadataRestoreService } from './backup-data-safety-metadata-restore.service';
import { LocalBackupUiBlackBoxRestoreService } from './local-backup-ui-black-box-restore.service';
import type { LocalBackupUiBlackBoxRestoreSnapshot } from './local-backup-ui-black-box-restore.types';
import { convertBackupDataToExportData } from './import-backup-conversion.helpers';
import {
  LOCAL_BACKUP_UI_RESTORE_STAGES,
  type LocalBackupUiRestoreMarker,
  type LocalBackupUiRestoreStage,
} from './local-backup-ui-restore-types';
import type { LocalBackupUiRestoreStageOperationContext } from './local-backup-ui-restore-stage-protocol';
import type {
  LocalBackupUiRestoreRetryQueuePreImage,
  LocalBackupUiRestoreStageSnapshots,
} from './local-backup-ui-restore-stage-snapshots';
import {
  LocalBackupUiRestoreStageService,
  createLocalBackupUiRestoreStageOperations,
  type LocalBackupUiRestoreStageEffect,
} from './local-backup-ui-restore-stage.service';
import {
  registerLocalBackupUiRestoreProjectLocalStateSpecs,
} from './local-backup-ui-restore-project-local-state.spec-helpers';

const OWNER_USER_ID = 'restore-owner';
const RESTORE_RUN_ID = '11111111-1111-4111-8111-111111111111';
const SOURCE_DIGEST = `sha256:${'a'.repeat(64)}`;
const ACTION_QUEUE_RESTORE_IDENTITY = {
  ownerUserId: OWNER_USER_ID,
  restoreRunId: RESTORE_RUN_ID,
  participant: 'action-queue' as const,
  sourceDigest: SOURCE_DIGEST,
  token: '22222222-2222-4222-8222-222222222222',
  recordId: `queue-backup:${OWNER_USER_ID}`,
  identityDigest: `sha256:${'b'.repeat(64)}`,
  receiptId: `queue-backup-personal-restore-receipt:v2:${'b'.repeat(64)}`,
};

describe('createLocalBackupUiRestoreStageOperations', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('binds all seven stages to durable read-back and their exact rollback slots', async () => {
    const snapshots = makeSnapshots();
    const calls: string[] = [];
    const durable = new Map<LocalBackupUiRestoreStage, unknown>();
    const effects = Object.fromEntries(LOCAL_BACKUP_UI_RESTORE_STAGES.map(stage => [
      stage,
      makeEffect(stage, calls, durable),
    ])) as unknown as Record<LocalBackupUiRestoreStage, LocalBackupUiRestoreStageEffect>;
    const operations = createLocalBackupUiRestoreStageOperations({} as never, {
      decodePreImage: vi.fn(() => snapshots),
      effects,
    });
    const context = makeContext();

    operations.decodePreImage({} as LocalBackupUiRestoreMarker);
    for (const stage of LOCAL_BACKUP_UI_RESTORE_STAGES) {
      await operations.apply(stage, context);
      await operations.verifyApplied(stage, context);
    }
    for (const stage of [...LOCAL_BACKUP_UI_RESTORE_STAGES].reverse()) {
      await operations.rollback(stage, context);
      await operations.verifyRolledBack(stage, context);
    }

    expect(calls).toEqual(LOCAL_BACKUP_UI_RESTORE_STAGES.flatMap(stage => [
      `apply:${stage}`,
      `read:${stage}`,
    ]).concat([...LOCAL_BACKUP_UI_RESTORE_STAGES].reverse().flatMap(stage => [
      `restore:${stage}:${String(snapshotForStage(snapshots, stage))}`,
      `read:${stage}`,
    ])));
  });

  it('fails closed on read-back drift and when apply is attempted before decoding', async () => {
    const snapshots = makeSnapshots();
    const durable = new Map<LocalBackupUiRestoreStage, unknown>();
    const effects = Object.fromEntries(LOCAL_BACKUP_UI_RESTORE_STAGES.map(stage => [
      stage,
      makeEffect(stage, [], durable),
    ])) as unknown as Record<LocalBackupUiRestoreStage, LocalBackupUiRestoreStageEffect>;
    const operations = createLocalBackupUiRestoreStageOperations({} as never, {
      decodePreImage: () => snapshots,
      effects,
    });
    const context = makeContext();

    await expect(operations.apply('projects', context)).rejects.toThrow(/pre-image/i);
    operations.decodePreImage({} as LocalBackupUiRestoreMarker);
    await operations.apply('projects', context);
    durable.set('projects', { drifted: true });
    await expect(operations.verifyApplied('projects', context)).rejects.toThrow(/read-back/i);
  });

  it('rejects a stable stale read when the apply did not persist its target', async () => {
    const snapshots = makeSnapshots();
    const effects = Object.fromEntries(LOCAL_BACKUP_UI_RESTORE_STAGES.map(stage => [
      stage,
      {
        apply: vi.fn(async () => ({ result: stage, expected: { stage, state: 'target' } })),
        read: vi.fn(async () => ({ stage, state: 'old' })),
        restore: vi.fn(async () => undefined),
      },
    ])) as unknown as Record<LocalBackupUiRestoreStage, LocalBackupUiRestoreStageEffect>;
    const operations = createLocalBackupUiRestoreStageOperations({} as never, {
      decodePreImage: () => snapshots,
      effects,
    });

    operations.decodePreImage({} as LocalBackupUiRestoreMarker);
    await operations.apply('projects', makeContext());
    await expect(operations.verifyApplied('projects', makeContext())).rejects.toThrow(/read-back/i);
  });

  it('delegates the action-queue stage to the prepared QueueBackup participant only', async () => {
    const legacyQueueBackup = {
      updateQueue: vi.fn(async (
        _ownerUserId: string,
        updater: (queue: QueuedAction[], context: { recordFound: boolean }) => QueuedAction[],
      ) => updater([], { recordFound: false })),
    };
    const participant = {
      confirmPrepared: vi.fn(async () => 1),
      rollback: vi.fn(async () => undefined),
    };
    const marker = makeStageMarker();
    const service = makeStageService(undefined, undefined, legacyQueueBackup);
    const operations = service.createOperations({
      ownerUserId: OWNER_USER_ID,
      data: {} as never,
      backup: { localState: { actionQueue: [makeQueuedAction()] } } as never,
      existingProjects: [],
      actionQueueRestore: participant,
    } as never);
    operations.decodePreImage(marker);

    await operations.apply('action-queue', makeContext(marker));
    await operations.rollback('action-queue', makeContext(marker));

    expect(participant.confirmPrepared).toHaveBeenCalledTimes(1);
    expect(participant.rollback).toHaveBeenCalledTimes(1);
    expect(legacyQueueBackup.updateQueue).not.toHaveBeenCalled();
  });

  it('binds the durable Black Box snapshot while decoding recovery operations', () => {
    const marker = makeStageMarker();
    const snapshot = marker.preImage.blackBox as unknown as LocalBackupUiBlackBoxRestoreSnapshot;
    const blackBoxRestore = {
      decode: vi.fn(() => snapshot),
      apply: vi.fn(),
      read: vi.fn(),
      rollback: vi.fn(),
    };
    const service = makeStageService(undefined, undefined, undefined, blackBoxRestore);
    const operations = service.createRecoveryOperations(OWNER_USER_ID, {
      confirmPrepared: vi.fn(),
      rollback: vi.fn(),
    });

    operations.decodePreImage(marker);

    expect(blackBoxRestore.decode).toHaveBeenCalledOnce();
    expect(blackBoxRestore.decode).toHaveBeenCalledWith(
      snapshot,
      OWNER_USER_ID,
      marker.source.checksum,
    );
  });

  it('rolls retryQueue back from the marker footprint instead of runtime BackupData', async () => {
    const markerItem = makeRetryQueueItem(
      '33333333-3333-4333-8333-333333333333',
      '44444444-4444-4444-8444-444444444444',
    );
    const runtimeBackupItem = makeRetryQueueItem(
      '55555555-5555-4555-8555-555555555555',
      '66666666-6666-4666-8666-666666666666',
    );
    const marker = makeStageMarker(markerItem);
    localStorage.setItem('nanoflow.retry-queue', JSON.stringify({
      version: 1,
      items: [markerItem, runtimeBackupItem],
    }));
    const service = makeStageService();
    const operations = service.createOperations({
      ownerUserId: OWNER_USER_ID,
      data: {} as never,
      backup: { localState: { retryQueue: [runtimeBackupItem] } } as never,
      existingProjects: [],
      actionQueueRestore: makeActionQueueRestore(),
    });
    operations.decodePreImage(marker);

    try {
      await operations.rollback('retry-queue', makeContext(marker));

      expect(readRetryQueueLocalStorageItems()).toEqual([runtimeBackupItem]);
    } finally {
      localStorage.removeItem('nanoflow.retry-queue');
    }
  });

  it('verifies retryQueue rollback against durable items instead of the savedAt timestamp', async () => {
    const markerItem = makeRetryQueueItem(
      '33333333-3333-4333-8333-333333333333',
      '44444444-4444-4444-8444-444444444444',
    );
    const runtimeBackupItem = makeRetryQueueItem(
      '55555555-5555-4555-8555-555555555555',
      '66666666-6666-4666-8666-666666666666',
    );
    const marker = makeStageMarker(markerItem);
    const retryQueuePreImage = marker.preImage.retryQueue as Record<string, unknown>;
    marker.preImage.retryQueue = {
      ...retryQueuePreImage,
      indexedDb: [],
      localStorage: JSON.stringify({
        version: 1,
        items: [runtimeBackupItem],
        savedAt: '2026-07-27T00:00:00.000Z',
      }),
    };
    localStorage.setItem('nanoflow.retry-queue', JSON.stringify({
      version: 1,
      items: [markerItem, runtimeBackupItem],
      savedAt: '2026-07-27T00:05:00.000Z',
    }));
    const service = makeStageService();
    const operations = service.createRecoveryOperations(OWNER_USER_ID, makeActionQueueRestore());
    operations.decodePreImage(marker);

    try {
      await operations.rollback('retry-queue', makeContext(marker));
      await operations.verifyRolledBack('retry-queue', makeContext(marker));

      expect(readRetryQueueLocalStorageItems()).toEqual([runtimeBackupItem]);
    } finally {
      localStorage.removeItem('nanoflow.retry-queue');
    }
  });

  it('applies retryQueue from the marker footprint instead of runtime BackupData', async () => {
    const markerItems = [
      makeRetryQueueItem(
        '33333333-3333-4333-8333-333333333333',
        '44444444-4444-4444-8444-444444444444',
      ),
      makeRetryQueueItem(
        '55555555-5555-4555-8555-555555555555',
        '66666666-6666-4666-8666-666666666666',
      ),
    ];
    const runtimeBackupItem = makeRetryQueueItem(
      '77777777-7777-4777-8777-777777777777',
      '88888888-8888-4888-8888-888888888888',
    );
    const marker = makeStageMarker(...markerItems);
    marker.state = 'restoring';
    const validationNow = markerItems[0]!.createdAt + 1;
    const retryQueue = {
      MAX_RETRIES: Number.MAX_SAFE_INTEGER,
      restoreFromBackupItems: vi.fn(async () => markerItems.length),
    };
    const service = makeStageService(retryQueue);
    const operations = service.createOperations({
      ownerUserId: OWNER_USER_ID,
      data: {} as never,
      backup: { localState: { retryQueue: [runtimeBackupItem] } } as never,
      existingProjects: [],
      actionQueueRestore: makeActionQueueRestore(),
    });
    operations.decodePreImage(marker);
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(validationNow);

    try {
      await operations.apply('retry-queue', makeContext(marker));

      expect(retryQueue.restoreFromBackupItems).toHaveBeenCalledWith(
        markerItems,
        OWNER_USER_ID,
        { validationNow, terminalEvidence: 'forbid' },
      );
      expect(retryQueue.restoreFromBackupItems).not.toHaveBeenCalledWith(
        [runtimeBackupItem],
        OWNER_USER_ID,
      );
    } finally {
      nowSpy.mockRestore();
      localStorage.removeItem('nanoflow.retry-queue');
    }
  });

  it('rechecks retryQueue age at apply before terminal evidence can escape the transaction', async () => {
    const item = makeRetryQueueItem(
      '33333333-3333-4333-8333-333333333333',
      '44444444-4444-4444-8444-444444444444',
    );
    const marker = makeStageMarker(item);
    marker.state = 'restoring';
    const terminalEvidenceKey = 'nanoflow.retry-queue.phase2c2b1-terminal-evidence-test';
    const retryQueue = {
      MAX_RETRIES: Number.MAX_SAFE_INTEGER,
      restoreFromBackupItems: vi.fn(async () => {
        localStorage.setItem(terminalEvidenceKey, item.operationId);
        return 0;
      }),
    };
    const service = makeStageService(retryQueue);
    const operations = service.createOperations({
      ownerUserId: OWNER_USER_ID,
      data: {} as never,
      backup: { localState: { retryQueue: [item] } } as never,
      existingProjects: [],
      actionQueueRestore: makeActionQueueRestore(),
    });
    operations.decodePreImage(marker);
    const storageBefore = snapshotLocalStorage();
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(
      item.createdAt + SYNC_CONFIG.MAX_RETRY_ITEM_AGE,
    );

    const outcome = await operations.apply('retry-queue', makeContext(marker)).then(
      value => ({ value }),
      error => ({ error }),
    );
    const storageAfter = snapshotLocalStorage();
    nowSpy.mockRestore();

    try {
      expect.soft(retryQueue.restoreFromBackupItems).not.toHaveBeenCalled();
      expect.soft(storageAfter).toEqual(storageBefore);
      expect(outcome).toHaveProperty('error');
      expect(String('error' in outcome ? outcome.error : '')).toMatch(/retryQueue/i);
    } finally {
      localStorage.removeItem(terminalEvidenceKey);
      localStorage.removeItem('nanoflow.retry-queue');
    }
  });

  it('derives retryQueue restoredItems read-back from the durable persisted subset', async () => {
    const persistedItem = makeRetryQueueItem(
      '33333333-3333-4333-8333-333333333333',
      '44444444-4444-4444-8444-444444444444',
    );
    const missingItem = makeRetryQueueItem(
      '55555555-5555-4555-8555-555555555555',
      '66666666-6666-4666-8666-666666666666',
    );
    const marker = makeStageMarker(persistedItem, missingItem);
    marker.state = 'restoring';
    localStorage.setItem('nanoflow.retry-queue', JSON.stringify({
      version: 1,
      items: [persistedItem],
    }));
    const service = makeStageService();
    const retryQueueReader = service as unknown as {
      readRetryQueue(
        ownerUserId: string,
        snapshot: LocalBackupUiRestoreRetryQueuePreImage,
        context: LocalBackupUiRestoreStageOperationContext,
      ): Promise<LocalBackupUiRestoreRetryQueuePreImage>;
    };

    try {
      const readBack = await retryQueueReader.readRetryQueue(
        OWNER_USER_ID,
        marker.preImage.retryQueue as unknown as LocalBackupUiRestoreRetryQueuePreImage,
        makeContext(marker),
      );

      expect(readBack.restoredItems).toEqual([persistedItem]);
    } finally {
      localStorage.removeItem('nanoflow.retry-queue');
    }
  });

  it('creates startup recovery operations that roll back from marker pre-image without runtime backup input', async () => {
    const markerItem = makeRetryQueueItem(
      '99999999-9999-4999-8999-999999999999',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    );
    const marker = makeStageMarker(markerItem);
    const retryQueuePreImage = marker.preImage.retryQueue as Record<string, unknown>;
    marker.preImage.retryQueue = {
      ...retryQueuePreImage,
      indexedDb: [],
    };
    localStorage.setItem('nanoflow.retry-queue', JSON.stringify({
      version: 1,
      items: [markerItem],
    }));
    const service = makeStageService();
    const operations = service.createRecoveryOperations(OWNER_USER_ID, makeActionQueueRestore());
    operations.decodePreImage(marker);

    try {
      await operations.rollback('retry-queue', makeContext(marker));
      await operations.verifyRolledBack('retry-queue', makeContext(marker));

      expect(readRetryQueueLocalStorageItems()).toEqual([]);
    } finally {
      localStorage.removeItem('nanoflow.retry-queue');
    }
  });

  it('rejects post-preview attachment outbox tampering before creating stage operations', () => {
    const backup = {
      localState: {
        dataSafety: { ownerUserId: OWNER_USER_ID },
        attachmentUploadOutbox: [{
          ownerUserId: OWNER_USER_ID,
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
    } as BackupData;
    const service = makeStageService();
    const input = {
      ownerUserId: OWNER_USER_ID,
      data: {} as never,
      backup,
      existingProjects: [],
      actionQueueRestore: makeActionQueueRestore(),
    };

    expect(() => service.createOperations(input)).not.toThrow();
    backup.localState!.dataSafety!.ownerUserId = 'other-owner';
    backup.localState!.attachmentUploadOutbox![0]!.ownerUserId = 'other-owner';

    expect(() => service.createOperations(input)).toThrow(/attachment upload outbox/i);
  });

  it('rejects post-preview conflict owner tampering before creating stage operations', () => {
    const backup = makeConflictBackup();
    const service = makeStageService();
    const input = {
      ownerUserId: OWNER_USER_ID,
      data: {} as never,
      backup,
      existingProjects: [],
      actionQueueRestore: makeActionQueueRestore(),
    };

    expect(() => service.createOperations(input)).not.toThrow();
    (backup.localState!.conflicts![0] as ConflictRecord).ownerUserId = 'other-owner';

    expect(() => service.createOperations(input)).toThrow(/conflict/i);
  });

  it('surfaces false conflict persistence so the stage protocol can roll back', async () => {
    const saveConflict = vi.fn(async () => false);
    const service = makeStageService(undefined, { saveConflict });
    const marker = makeStageMarker();
    const operations = service.createOperations({
      ownerUserId: OWNER_USER_ID,
      data: {} as never,
      backup: makeConflictBackup(),
      existingProjects: [],
      actionQueueRestore: makeActionQueueRestore(),
    });
    operations.decodePreImage(marker);
    const context = makeContext(marker);

    await expect(operations.apply('conflicts', context)).rejects.toThrow(/conflict/i);
    expect(saveConflict).toHaveBeenCalledTimes(1);
    expect(saveConflict).toHaveBeenCalledWith(expect.any(Object), {
      restoreWriterContinuation: true,
    });
    expect(context.runWriterMutation).toHaveBeenCalledWith('conflicts', expect.any(Function));
  });

  it('routes attachment outbox restore writes through the attachment writer fence', async () => {
    const savePendingUpload = vi.fn(async () => undefined);
    const attachmentOutbox = {
      listPendingUploads: vi.fn(async () => []),
      savePendingUpload,
      removePendingUpload: vi.fn(async () => undefined),
    };
    const service = makeStageService(undefined, undefined, undefined, undefined, attachmentOutbox);
    const marker = makeStageMarker();
    const backup = makeConflictBackup();
    backup.localState!.attachmentUploadOutbox = [{
      ownerUserId: OWNER_USER_ID,
      operationId: 'attachment-operation-1',
      attachmentId: 'attachment-1',
      blobKey: 'attachment-1',
      fileName: 'note.txt',
      mimeType: 'text/plain',
      size: 0,
      createdAt: '2026-07-28T00:00:00.000Z',
      encoding: 'base64',
      blobBase64: '',
    }];
    const operations = service.createOperations({
      ownerUserId: OWNER_USER_ID,
      data: {} as never,
      backup,
      existingProjects: [],
      actionQueueRestore: makeActionQueueRestore(),
    });
    operations.decodePreImage(marker);
    const context = makeContext(marker);

    await operations.apply('attachment-outbox', context);

    expect(savePendingUpload).toHaveBeenCalledWith(expect.objectContaining({
      ownerUserId: OWNER_USER_ID,
      operationId: 'attachment-operation-1',
    }), { restoreWriterContinuation: true });
    expect(context.runWriterMutation).toHaveBeenCalledWith('attachment-outbox', expect.any(Function));
  });

  it('reads attachment outbox pre-images without cleanup writes', async () => {
    const listPendingUploads = vi.fn(async () => []);
    const attachmentOutbox = {
      listPendingUploads,
      savePendingUpload: vi.fn(async () => undefined),
      removePendingUpload: vi.fn(async () => undefined),
    };
    const service = makeStageService(undefined, undefined, undefined, undefined, attachmentOutbox);
    const marker = makeStageMarker();
    const operations = service.createOperations({
      ownerUserId: OWNER_USER_ID,
      data: {} as never,
      backup: makeConflictBackup(),
      existingProjects: [],
      actionQueueRestore: makeActionQueueRestore(),
    });
    operations.decodePreImage(marker);
    const context = makeContext(marker);

    await operations.verifyRolledBack('attachment-outbox', context);

    expect(listPendingUploads).toHaveBeenCalledWith(OWNER_USER_ID, { restoreSnapshot: true });
    expect(context.runWriterMutation).not.toHaveBeenCalled();
  });

  it('rejects incomplete project ownership and mismatched conflict evidence before side effects', () => {
    for (const backup of makeInvalidConflictBackups()) {
      const saveConflict = vi.fn(async () => true);
      const service = makeStageService(undefined, { saveConflict });

      expect.soft(convertBackupDataToExportData(backup)).toBeNull();
      expect.soft(() => service.createOperations({
        ownerUserId: OWNER_USER_ID,
        data: {} as never,
        backup,
        existingProjects: [],
        actionQueueRestore: makeActionQueueRestore(),
      })).toThrow(/conflict/i);
      expect.soft(saveConflict).not.toHaveBeenCalled();
    }
  });

  registerLocalBackupUiRestoreProjectLocalStateSpecs({ makeContext });
});

function makeEffect(
  stage: LocalBackupUiRestoreStage,
  calls: string[],
  durable: Map<LocalBackupUiRestoreStage, unknown>,
): LocalBackupUiRestoreStageEffect {
  return {
    apply: vi.fn(async () => {
      calls.push(`apply:${stage}`);
      durable.set(stage, { stage, state: 'applied' });
      return { result: stage, expected: { stage, state: 'applied' } };
    }),
    read: vi.fn(async () => {
      calls.push(`read:${stage}`);
      return durable.get(stage);
    }),
    restore: vi.fn(async snapshot => {
      calls.push(`restore:${stage}:${String(snapshot)}`);
      durable.set(stage, snapshot);
    }),
  };
}

function makeContext(
  marker: LocalBackupUiRestoreMarker = {} as LocalBackupUiRestoreMarker,
): LocalBackupUiRestoreStageOperationContext {
  return {
    marker: () => marker,
    checkpoint: vi.fn(async () => undefined),
    runWriterMutation: vi.fn(async (_source, write) => await write()),
  };
}

function makeActionQueueRestore() {
  return {
    confirmPrepared: vi.fn(async () => 0),
    rollback: vi.fn(async () => undefined),
  };
}

function makeSnapshots(): LocalBackupUiRestoreStageSnapshots {
  return {
    projects: {
      schemaVersion: 1,
      projects: [],
      externalSourceLinks: [],
      externalSourcePendingLinks: [],
      offlineSnapshot: { scopedLocalStorageValue: null, scopedIndexedDbRecord: null },
      dockSnapshot: { present: false, localStorage: null, indexedDb: null },
      launchSnapshot: { present: false, v1: null, v2: null },
      parkedTaskCache: { present: false, entries: [], syncMetadata: {} },
    },
    attachmentOutbox: [],
    actionQueue: { indexedDb: null, localStorage: null },
    retryQueue: { schemaVersion: 2, indexedDb: null, localStorage: null, restoredItems: [] },
    deadLetters: { indexedDb: null, localStorage: null },
    conflicts: { indexedDbRecords: null, fallbackLocalStorageEntries: {} },
    metadata: {
      projectCursors: [],
      lastSyncTime: null,
      replayLog: [],
      lastWriteExplain: null,
      taskTombstones: {},
      connectionTombstones: [],
    },
  };
}

function makeStageService(
  retryQueue: {
    readonly MAX_RETRIES: number;
    restoreFromBackupItems(
      items: unknown[],
      ownerUserId: string,
      policy?: { validationNow: number; terminalEvidence: 'forbid' },
    ): Promise<number>;
  } = {
    MAX_RETRIES: Number.MAX_SAFE_INTEGER,
    restoreFromBackupItems: vi.fn(async () => 0),
  },
  conflictStorage: Pick<ConflictStorageService, 'saveConflict'> = {
    saveConflict: vi.fn(async () => true),
  },
  queueBackup: Pick<QueueBackupService, 'updateQueue'> = {} as never,
  blackBoxRestore: Pick<LocalBackupUiBlackBoxRestoreService, 'decode' | 'apply' | 'read' | 'rollback'> = {
    decode: vi.fn(value => value as never),
    apply: vi.fn(async () => 0),
    read: vi.fn(async () => []),
    rollback: vi.fn(async () => undefined),
  },
  attachmentOutbox: Pick<
    AttachmentUploadOutboxService,
    'listPendingUploads' | 'savePendingUpload' | 'removePendingUpload'
  > = {
    listPendingUploads: vi.fn(async () => []),
    savePendingUpload: vi.fn(async () => undefined),
    removePendingUpload: vi.fn(async () => undefined),
  },
): LocalBackupUiRestoreStageService {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      LocalBackupUiRestoreStageService,
      { provide: ImportService, useValue: {} },
      { provide: ProjectStateService, useValue: {} },
      { provide: ProjectDataService, useValue: {} },
      { provide: ExternalSourceCacheService, useValue: {} },
      { provide: AttachmentUploadOutboxService, useValue: attachmentOutbox },
      { provide: QueueBackupService, useValue: queueBackup },
      { provide: RetryQueueService, useValue: retryQueue },
      { provide: ActionQueueStorageService, useValue: {} },
      { provide: ConflictStorageService, useValue: conflictStorage },
      { provide: BackupDataSafetyMetadataRestoreService, useValue: {} },
      { provide: LocalBackupUiBlackBoxRestoreService, useValue: blackBoxRestore },
    ],
  });
  return TestBed.inject(LocalBackupUiRestoreStageService);
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

function makeConflictBackup(): BackupData {
  return {
    payloadVersion: '2.0.0',
    projects: [{ id: 'project-1', userId: OWNER_USER_ID, name: 'Project 1' }],
    tasks: [],
    connections: [],
    localState: {
      dataSafety: { ownerUserId: OWNER_USER_ID },
      conflicts: [{
        projectId: 'project-1',
        ownerUserId: OWNER_USER_ID,
        localProject: {
          id: 'project-1',
          name: 'Local conflict',
          description: '',
          createdDate: '2026-07-28T00:00:00.000Z',
          updatedAt: '2026-07-28T00:00:00.000Z',
          version: 1,
          tasks: [],
          connections: [],
        },
        conflictedAt: '2026-07-28T00:00:00.000Z',
        localVersion: 1,
        reason: 'version_mismatch',
      }],
    },
  } as unknown as BackupData;
}

function makeInvalidConflictBackups(): BackupData[] {
  const zeroProjectOwner = makeConflictBackup();
  zeroProjectOwner.projects = [];
  const mixedProjectOwners = makeConflictBackup();
  mixedProjectOwners.projects.push({ id: 'project-2', userId: 'other-owner', name: 'Project 2' });
  const localProjectMismatch = makeConflictBackup();
  (localProjectMismatch.localState!.conflicts![0] as ConflictRecord).localProject.id = 'other-project';
  const operationProjectMismatch = makeConflictBackup();
  (operationProjectMismatch.localState!.conflicts![0] as ConflictRecord).operationConflicts = [{
    actionType: 'task:update',
    entityType: 'task',
    entityId: 'task-1',
    projectId: 'other-project',
    localEntity: { content: 'local' } as never,
    message: 'Operation belongs to another project',
    conflictedAt: '2026-07-28T00:00:00.000Z',
    reason: 'remote-newer',
  }];
  return [zeroProjectOwner, mixedProjectOwners, localProjectMismatch, operationProjectMismatch];
}

function snapshotLocalStorage(): Record<string, string | null> {
  return Object.fromEntries(
    Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index))
      .filter((key): key is string => key !== null)
      .sort()
      .map(key => [key, localStorage.getItem(key)]),
  );
}

function makeStageMarker(
  ...restoredItems: ReturnType<typeof makeRetryQueueItem>[]
): LocalBackupUiRestoreMarker {
  return {
    schemaVersion: 2,
    ownerUserId: OWNER_USER_ID,
    runId: '11111111-1111-4111-8111-111111111111',
    restoreRunId: RESTORE_RUN_ID,
    actionQueueRestoreIdentity: ACTION_QUEUE_RESTORE_IDENTITY,
    createdAt: '2026-07-27T00:00:00.000Z',
    leaseExpiresAt: '2099-07-27T00:00:00.000Z',
    state: 'rolling-back',
    phase: 'retry-queue',
    completedStages: ['retry-queue'],
    rollbackCompletedStages: [],
    source: { kind: 'local-file', reference: 'backup.json', checksum: SOURCE_DIGEST },
    touchedProjectIds: [],
    preImage: {
      projectState: {
        schemaVersion: 1,
        projects: [],
        externalSourceLinks: [],
        externalSourcePendingLinks: [],
        offlineSnapshot: { scopedLocalStorageValue: null, scopedIndexedDbRecord: null },
        dockSnapshot: { present: false, localStorage: null, indexedDb: null },
        launchSnapshot: { present: false, v1: null, v2: null },
        parkedTaskCache: { present: false, entries: [], syncMetadata: {} },
      },
      blackBox: {
        schemaVersion: 1,
        ownerUserId: OWNER_USER_ID,
        sourceDigest: `sha256:${'a'.repeat(64)}`,
        before: [],
        target: [],
      },
      attachmentOutbox: [],
      actionQueue: { indexedDb: null, localStorage: null },
      retryQueue: {
        schemaVersion: 2,
        indexedDb: null,
        localStorage: null,
        restoredItems,
      },
      deadLetters: { indexedDb: null, localStorage: null },
      conflicts: { indexedDbRecords: null, fallbackLocalStorageEntries: {} },
      metadata: {
        projectCursors: [],
        lastSyncTime: null,
        replayLog: [],
        lastWriteExplain: null,
        taskTombstones: {},
        connectionTombstones: [],
      },
    },
    rollbackErrors: [],
  };
}

function makeRetryQueueItem(id: string, operationId: string) {
  return {
    id,
    operationId,
    type: 'task',
    operation: 'upsert',
    data: { id },
    retryCount: 0,
    createdAt: Date.parse('2026-07-27T00:00:00.000Z'),
    sourceUserId: OWNER_USER_ID,
  };
}

function readRetryQueueLocalStorageItems(): unknown[] {
  const raw = localStorage.getItem('nanoflow.retry-queue');
  if (!raw) return [];
  return (JSON.parse(raw) as { items: unknown[] }).items;
}

function snapshotForStage(
  snapshots: LocalBackupUiRestoreStageSnapshots,
  stage: LocalBackupUiRestoreStage,
): unknown {
  switch (stage) {
    case 'projects': return snapshots.projects;
    case 'attachment-outbox': return snapshots.attachmentOutbox;
    case 'action-queue': return snapshots.actionQueue;
    case 'retry-queue': return snapshots.retryQueue;
    case 'dead-letters': return snapshots.deadLetters;
    case 'conflicts': return snapshots.conflicts;
    case 'metadata': return snapshots.metadata;
  }
}
