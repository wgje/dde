import { describe, expect, it, vi } from 'vitest';

import { SYNC_CONFIG } from '../config';
import type { Project } from '../models';
import {
  captureLocalBackupUiRestorePreImage,
  type LocalBackupUiRestorePreImageReaders,
} from './local-backup-ui-restore-pre-image.service';

const OWNER_USER_ID = 'restore-owner';
const RETRY_QUEUE_RESTORE_ITEM = {
  id: '33333333-3333-4333-8333-333333333333',
  operationId: '44444444-4444-4444-8444-444444444444',
  type: 'task',
  operation: 'upsert',
  data: { id: '55555555-5555-4555-8555-555555555555' },
  retryCount: 0,
  createdAt: Date.parse('2026-07-27T00:00:00.000Z'),
  sourceUserId: OWNER_USER_ID,
};
const RETRY_QUEUE_POLICY = {
  now: RETRY_QUEUE_RESTORE_ITEM.createdAt + SYNC_CONFIG.MAX_RETRY_ITEM_AGE - 1,
  maxItemAgeMs: SYNC_CONFIG.MAX_RETRY_ITEM_AGE,
  maxRetries: RETRY_QUEUE_RESTORE_ITEM.retryCount + 1,
};
const DOCK_LOCAL_STORAGE_RAW = JSON.stringify({
  version: 7,
  savedAt: '2026-07-27T00:03:00.000Z',
  entries: [{ taskId: 'dock-task-1' }],
});
const DOCK_INDEXED_DB_RAW = {
  version: 7,
  savedAt: '2026-07-27T00:04:00.000Z',
  entries: [{ taskId: 'dock-task-1' }],
};
const LAUNCH_SNAPSHOT_V1_RAW = JSON.stringify({
  version: 1,
  userId: OWNER_USER_ID,
  savedAt: '2026-07-27T00:04:00.000Z',
  activeProjectId: 'project-1',
  lastActiveView: 'text',
  theme: 'default',
  colorMode: 'light',
  projects: [],
});
const LAUNCH_SNAPSHOT_V2_RAW = JSON.stringify({
  version: 2,
  userId: OWNER_USER_ID,
  savedAt: '2026-07-27T00:05:00.000Z',
  activeProjectId: 'project-1',
  lastActiveView: 'text',
  preferredView: 'text',
  resolvedLaunchView: 'text',
  routeIntent: { kind: 'project', projectId: 'project-1', taskId: null },
  mobileDegraded: false,
  degradeReason: null,
  theme: 'default',
  colorMode: 'light',
  projects: [],
  currentProject: null,
});
const PARKED_TASK_ENTRY = {
  ownerUserId: OWNER_USER_ID,
  taskId: `${encodeURIComponent(OWNER_USER_ID)}:task-parked-1`,
  projectId: 'project-1',
  task: {
    id: 'task-parked-1',
    title: 'Parked task',
    content: 'parked cache content survives restore pre-image',
    stage: 1,
    parentId: null,
    order: 0,
    rank: 100,
    status: 'active',
    displayId: 'parked-1',
    x: 0,
    y: 0,
    createdDate: '2026-07-27T00:00:00.000Z',
    updatedAt: '2026-07-27T00:05:00.000Z',
  },
  updatedAt: '2026-07-27T00:05:00.000Z',
};

describe('captureLocalBackupUiRestorePreImage', () => {
  it('captures all seven rollback slots after preserving IDs, task content, and absent projects', async () => {
    const project = {
      id: 'project-1',
      name: 'Current project',
      description: '',
      createdDate: '2026-07-27T00:00:00.000Z',
      updatedAt: '2026-07-27T00:01:00.000Z',
      version: 7,
      tasks: [{
        id: 'task-1',
        title: 'Current task',
        content: 'content must survive the pre-image',
        stage: 1,
        parentId: null,
        order: 0,
        rank: 100,
        status: 'active',
        displayId: 'task-1',
        x: 0,
        y: 0,
        createdDate: '2026-07-27T00:00:00.000Z',
      }],
      connections: [],
    } as Project;
    const readers = makeReaders([project]);

    const preImage = await captureLocalBackupUiRestorePreImage({
      ownerUserId: OWNER_USER_ID,
      touchedProjectIds: ['project-new', 'project-1'],
      retryQueueRestoreItems: [RETRY_QUEUE_RESTORE_ITEM],
    }, readers, RETRY_QUEUE_POLICY);

    expect(preImage.projectState).toEqual({
      schemaVersion: 1,
      projects: [
        { projectId: 'project-1', existed: true, project },
        { projectId: 'project-new', existed: false, project: null },
      ],
      externalSourceLinks: [{ id: 'link-current', taskId: 'task-1' }],
      externalSourcePendingLinks: [{ operationId: 'link-op', link: { id: 'link-pending' } }],
      offlineSnapshot: {
        scopedLocalStorageValue: 'offline-before',
        scopedIndexedDbRecord: null,
      },
      dockSnapshot: {
        present: true,
        localStorage: DOCK_LOCAL_STORAGE_RAW,
        indexedDb: DOCK_INDEXED_DB_RAW,
      },
      launchSnapshot: {
        present: true,
        v1: LAUNCH_SNAPSHOT_V1_RAW,
        v2: LAUNCH_SNAPSHOT_V2_RAW,
      },
      parkedTaskCache: {
        present: true,
        entries: [PARKED_TASK_ENTRY],
        syncMetadata: {
          'parking_last_sync_time:restore-owner': '2026-07-27T00:05:00.000Z',
        },
      },
    });
    expect(JSON.stringify(preImage.projectState)).toContain('content must survive the pre-image');
    expect(readers.readCurrentProjects).toHaveBeenCalledWith(OWNER_USER_ID);
    expect(preImage.attachmentOutbox).toEqual([{
      ownerUserId: OWNER_USER_ID,
      operationId: 'attachment-op',
      attachmentId: 'attachment-1',
      blobKey: 'blob-1',
      fileName: 'note.txt',
      mimeType: 'text/plain',
      size: 7,
      createdAt: '2026-07-27T00:00:00.000Z',
      encoding: 'base64',
      blobBase64: 'YmluYXJ5',
    }]);
    expect(preImage.actionQueue).toEqual({
      indexedDb: expect.objectContaining({
        id: 'queue-backup:restore-owner',
        ownerUserId: OWNER_USER_ID,
        actions: [expect.objectContaining({ id: 'action-1' })],
      }),
      localStorage: '[{"id":"action-1"}]',
    });
    expect(preImage.retryQueue).toEqual({
      schemaVersion: 3,
      indexedDb: [{ id: 'retry-1' }],
      localStorage: '{"version":1,"items":[]}',
      legacyReviewLocalStorageValue: null,
      restoredItems: [RETRY_QUEUE_RESTORE_ITEM],
    });
    expect(preImage.deadLetters).toEqual({
      indexedDb: expect.objectContaining({
        id: 'dead-letter-backup:restore-owner',
        ownerUserId: OWNER_USER_ID,
        deadLetters: [expect.objectContaining({ reason: 'dead-1' })],
      }),
      localStorage: '[{"id":"dead-1"}]',
    });
    expect(preImage.conflicts).toEqual({
      indexedDbRecords: null,
      fallbackLocalStorageEntries: { 'conflict:test': '{"id":"conflict-1"}' },
    });
    expect(preImage.metadata).toEqual(expect.objectContaining({
      lastSyncTime: '2026-07-27T00:02:00.000Z',
      replayLog: [{ operationId: 'write-1' }],
      taskTombstones: { 'task-1': '2026-07-27T00:00:00.000Z' },
    }));
    expect(readers.readMetadata).toHaveBeenCalledWith(
      OWNER_USER_ID,
      new Set(['project-1', 'project-new']),
    );
    expect(readers.readExternalPendingLinks).toHaveBeenCalledWith(OWNER_USER_ID);
  });

  it('captures the owner review storage value in the RetryQueue pre-image', async () => {
    const readers = makeReaders();
    const current = await readers.readLocalStateSnapshot(OWNER_USER_ID);
    const readLocalStateSnapshot = vi.spyOn(readers, 'readLocalStateSnapshot');
    const legacyReviewRaw = JSON.stringify([{
      item: {
        id: 'retry-review-1',
        operationId: 'operation-review-1',
        sourceUserId: OWNER_USER_ID,
        type: 'task',
        operation: 'upsert',
        data: { id: 'task-review-1', content: 'review only' },
        retryCount: 3,
        createdAt: 1781539200000,
      },
      reason: 'terminal outcome requires review',
      quarantinedAt: '2026-06-16T00:00:00.000Z',
      ownerUserId: OWNER_USER_ID,
    }]);
    readLocalStateSnapshot.mockResolvedValue({
      ...current,
      legacyRetryReviewLocalStorageValue: legacyReviewRaw,
    });

    const preImage = await captureLocalBackupUiRestorePreImage({
      ownerUserId: OWNER_USER_ID,
      touchedProjectIds: [],
      retryQueueRestoreItems: [],
    }, readers, RETRY_QUEUE_POLICY);

    expect((preImage.retryQueue as Record<string, unknown>).legacyReviewLocalStorageValue)
      .toBe(legacyReviewRaw);
  });

  it('binds pending links to the transaction owner across a transient A to B to A auth change', async () => {
    const readers = makeReaders();
    let activeAuthOwner = OWNER_USER_ID;
    readers.readExternalLinks = vi.fn(async () => {
      activeAuthOwner = 'auth-owner-b';
      return [];
    });
    readers.readExternalPendingLinks = vi.fn(async (ownerUserId = activeAuthOwner) => [{
      operationId: `pending:${ownerUserId}`,
      link: { id: `link:${ownerUserId}` },
    }]);
    readers.readAttachmentUploads = vi.fn(async () => {
      activeAuthOwner = OWNER_USER_ID;
      return [];
    });
    const preImage = await captureLocalBackupUiRestorePreImage({
      ownerUserId: OWNER_USER_ID,
      touchedProjectIds: [],
      retryQueueRestoreItems: [],
    }, readers, RETRY_QUEUE_POLICY);

    expect(activeAuthOwner).toBe(OWNER_USER_ID);
    expect(readers.readExternalPendingLinks).toHaveBeenCalledWith(OWNER_USER_ID);
    expect(preImage.projectState).toEqual(expect.objectContaining({
      externalSourcePendingLinks: [{
        operationId: `pending:${OWNER_USER_ID}`,
        link: { id: `link:${OWNER_USER_ID}` },
      }],
    }));
  });

  it('propagates an explicit-owner pending-link read failure before encoding attachments', async () => {
    const readers = makeReaders();
    readers.readExternalPendingLinks = vi.fn(async (ownerUserId = 'auth-owner-b') => {
      throw new Error(`pending read failed for ${ownerUserId}`);
    });
    await expect(captureLocalBackupUiRestorePreImage({
      ownerUserId: OWNER_USER_ID,
      touchedProjectIds: [],
      retryQueueRestoreItems: [],
    }, readers, RETRY_QUEUE_POLICY)).rejects.toThrow(`pending read failed for ${OWNER_USER_ID}`);
    expect(readers.readExternalPendingLinks).toHaveBeenCalledWith(OWNER_USER_ID);
    expect(readers.encodeBlob).not.toHaveBeenCalled();
  });

  it('fails closed before returning a pre-image when a reader is not JSON serializable', async () => {
    const readers = makeReaders();
    readers.readMetadata = vi.fn(async () => ({ invalid: BigInt(1) }));

    await expect(captureLocalBackupUiRestorePreImage({
      ownerUserId: OWNER_USER_ID,
      touchedProjectIds: ['project-1'],
      retryQueueRestoreItems: [],
    }, readers, RETRY_QUEUE_POLICY)).rejects.toThrow(/JSON/i);
  });

  it('fails closed when the retryQueue rollback footprint belongs to another owner', async () => {
    await expect(captureLocalBackupUiRestorePreImage({
      ownerUserId: OWNER_USER_ID,
      touchedProjectIds: [],
      retryQueueRestoreItems: [{
        ...RETRY_QUEUE_RESTORE_ITEM,
        sourceUserId: 'foreign-owner',
      }],
    }, makeReaders(), RETRY_QUEUE_POLICY)).rejects.toThrow(/retryQueue/i);
  });

  it('fails closed when the retryQueue rollback footprint is malformed', async () => {
    await expect(captureLocalBackupUiRestorePreImage({
      ownerUserId: OWNER_USER_ID,
      touchedProjectIds: [],
      retryQueueRestoreItems: [{
        ...RETRY_QUEUE_RESTORE_ITEM,
        operationId: 'not-a-durable-operation-id',
      }],
    }, makeReaders(), RETRY_QUEUE_POLICY)).rejects.toThrow(/retryQueue/i);
  });

  it.each([
    ['expired', {
      ...RETRY_QUEUE_RESTORE_ITEM,
      createdAt: RETRY_QUEUE_POLICY.now - RETRY_QUEUE_POLICY.maxItemAgeMs,
    }],
    ['retry-exhausted', {
      ...RETRY_QUEUE_RESTORE_ITEM,
      retryCount: RETRY_QUEUE_POLICY.maxRetries,
    }],
  ])('rejects a %s retryQueue footprint before any pre-image or terminal side effect', async (
    _caseName,
    rejectedItem,
  ) => {
    const readers = makeReaders();
    const storageBefore = snapshotLocalStorage();
    const randomUuidSpy = vi.spyOn(globalThis.crypto, 'randomUUID');

    const outcome = await captureLocalBackupUiRestorePreImage({
      ownerUserId: OWNER_USER_ID,
      touchedProjectIds: [],
      retryQueueRestoreItems: [rejectedItem],
    }, readers, RETRY_QUEUE_POLICY).then(
      value => ({ value }),
      error => ({ error }),
    );
    const generatedOperationIds = randomUuidSpy.mock.calls.length;
    randomUuidSpy.mockRestore();

    for (const reader of Object.values(readers)) {
      expect.soft(reader).not.toHaveBeenCalled();
    }
    expect.soft(snapshotLocalStorage()).toEqual(storageBefore);
    expect.soft(generatedOperationIds).toBe(0);
    expect(outcome).toHaveProperty('error');
    expect(String('error' in outcome ? outcome.error : '')).toMatch(/retryQueue/i);
  });

  it.each([
    ['queue id', {
      ...RETRY_QUEUE_RESTORE_ITEM,
      operationId: '66666666-6666-4666-8666-666666666666',
      data: { id: '77777777-7777-4777-8777-777777777777' },
    }],
    ['operationId', {
      ...RETRY_QUEUE_RESTORE_ITEM,
      id: '66666666-6666-4666-8666-666666666666',
      data: { id: '77777777-7777-4777-8777-777777777777' },
    }],
    ['effective owner/type/data.id identity', {
      ...RETRY_QUEUE_RESTORE_ITEM,
      id: '66666666-6666-4666-8666-666666666666',
      operationId: '77777777-7777-4777-8777-777777777777',
    }],
  ])('fails closed when the retryQueue footprint has a duplicate %s', async (
    _identity,
    conflictingItem,
  ) => {
    await expect(captureLocalBackupUiRestorePreImage({
      ownerUserId: OWNER_USER_ID,
      touchedProjectIds: [],
      retryQueueRestoreItems: [RETRY_QUEUE_RESTORE_ITEM, conflictingItem],
    }, makeReaders(), RETRY_QUEUE_POLICY)).rejects.toThrow(/retryQueue/i);
  });

  it.each([
    ['queue id', (item: ReturnType<typeof makeCaseSensitiveRetryQueueRestoreItem>) => ({
      ...item,
      id: item.id.toUpperCase(),
      operationId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      data: { id: 'ffffffff-ffff-4fff-8fff-ffffffffffff' },
    })],
    ['operationId', (item: ReturnType<typeof makeCaseSensitiveRetryQueueRestoreItem>) => ({
      ...item,
      id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      operationId: item.operationId.toUpperCase(),
      data: { id: 'ffffffff-ffff-4fff-8fff-ffffffffffff' },
    })],
    ['effective owner/type/data.id identity', (
      item: ReturnType<typeof makeCaseSensitiveRetryQueueRestoreItem>,
    ) => ({
      ...item,
      id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      operationId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      data: { id: item.data.id.toUpperCase() },
    })],
  ])('fails closed when canonical UUID casing duplicates the retryQueue %s', async (
    _identity,
    makeConflict,
  ) => {
    const item = makeCaseSensitiveRetryQueueRestoreItem();

    await expect(captureLocalBackupUiRestorePreImage({
      ownerUserId: OWNER_USER_ID,
      touchedProjectIds: [],
      retryQueueRestoreItems: [item, makeConflict(item)],
    }, makeReaders(), RETRY_QUEUE_POLICY)).rejects.toThrow(/retryQueue/i);
  });
});

function makeCaseSensitiveRetryQueueRestoreItem() {
  return {
    ...RETRY_QUEUE_RESTORE_ITEM,
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    operationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    data: { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' },
  };
}

function snapshotLocalStorage(): Record<string, string | null> {
  return Object.fromEntries(
    Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index))
      .filter((key): key is string => key !== null)
      .sort()
      .map(key => [key, localStorage.getItem(key)]),
  );
}

function makeReaders(currentProjects: Project[] = []): LocalBackupUiRestorePreImageReaders & {
  readMetadata: ReturnType<typeof vi.fn>;
} {
  return {
    readCurrentProjects: vi.fn(async () => currentProjects),
    readLocalStateSnapshot: vi.fn(async () => ({
      retryQueueIndexedDbItems: [{ id: 'retry-1' }],
      retryQueueLocalStorageValue: '{"version":1,"items":[]}',
      legacyRetryReviewLocalStorageValue: null,
      actionQueueBackupRecord: {
        id: `queue-backup:${OWNER_USER_ID}`,
        ownerUserId: OWNER_USER_ID,
        savedAt: '2026-07-27T00:00:00.000Z',
        actions: [{
          id: 'action-1',
          operationId: '11111111-1111-4111-8111-111111111111',
          type: 'update' as const,
          entityType: 'preference' as const,
          entityId: 'preferences',
          payload: { preferences: {}, userId: OWNER_USER_ID },
          timestamp: 1,
          retryCount: 0,
        }],
      },
      actionQueueLocalStorageValue: '[{"id":"action-1"}]',
      deadLetterBackupRecord: {
        id: `dead-letter-backup:${OWNER_USER_ID}`,
        ownerUserId: OWNER_USER_ID,
        savedAt: '2026-07-27T00:00:00.000Z',
        deadLetters: [{
          action: {
            id: 'dead-action-1',
            operationId: '22222222-2222-4222-8222-222222222222',
            type: 'update' as const,
            entityType: 'preference' as const,
            entityId: 'preferences',
            payload: { preferences: {}, userId: OWNER_USER_ID },
            timestamp: 1,
            retryCount: 1,
          },
          failedAt: '2026-07-27T00:00:00.000Z',
          reason: 'dead-1',
        }],
      },
      deadLetterLocalStorageValue: '[{"id":"dead-1"}]',
      auditLocalStorageValue: null,
      conflictRestoreSnapshot: {
        indexedDbRecords: null,
        fallbackLocalStorageEntries: { 'conflict:test': '{"id":"conflict-1"}' },
      },
      offlineSnapshotRestoreSnapshot: {
        scopedLocalStorageValue: 'offline-before',
        scopedIndexedDbRecord: null,
      },
      dockSnapshotRestoreSnapshot: {
        present: true,
        localStorage: DOCK_LOCAL_STORAGE_RAW,
        indexedDb: DOCK_INDEXED_DB_RAW,
      },
      launchSnapshotRestoreSnapshot: {
        present: true,
        v1: LAUNCH_SNAPSHOT_V1_RAW,
        v2: LAUNCH_SNAPSHOT_V2_RAW,
      },
      parkedTaskCacheRestoreSnapshot: {
        present: true,
        entries: [PARKED_TASK_ENTRY],
        syncMetadata: {
          'parking_last_sync_time:restore-owner': '2026-07-27T00:05:00.000Z',
        },
      },
    })),
    readMetadata: vi.fn(async () => ({
      projectCursors: [{ projectId: 'project-1', cursor: { updatedAt: 'cursor-1' } }],
      lastSyncTime: '2026-07-27T00:02:00.000Z',
      replayLog: [{ operationId: 'write-1' }],
      lastWriteExplain: null,
      taskTombstones: { 'task-1': '2026-07-27T00:00:00.000Z' },
      connectionTombstones: [],
    })),
    readExternalLinks: vi.fn(async () => [{ id: 'link-current', taskId: 'task-1' }]),
    readExternalPendingLinks: vi.fn(async () => [{
      operationId: 'link-op',
      link: { id: 'link-pending' },
    }]),
    readAttachmentUploads: vi.fn(async () => [{
      ownerUserId: OWNER_USER_ID,
      operationId: 'attachment-op',
      attachmentId: 'attachment-1',
      blobKey: 'blob-1',
      fileName: 'note.txt',
      mimeType: 'text/plain',
      size: 7,
      createdAt: '2026-07-27T00:00:00.000Z',
      blob: new Blob(['binary'], { type: 'text/plain' }),
    }]),
    encodeBlob: vi.fn(async () => 'YmluYXJ5'),
  };
}
