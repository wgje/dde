import { describe, expect, it } from 'vitest';

import type { Project } from '../models';
import type {
  LocalBackupUiRestoreJsonValue,
  LocalBackupUiRestoreMarker,
} from './local-backup-ui-restore-types';
import { decodeLocalBackupUiRestoreStageSnapshots } from './local-backup-ui-restore-stage-snapshots';

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
    content: 'preserved parked content',
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

describe('decodeLocalBackupUiRestoreStageSnapshots', () => {
  it('decodes every rollback slot before mutation without remapping project IDs', () => {
    const marker = makeMarker();

    const decoded = decodeLocalBackupUiRestoreStageSnapshots(marker);

    expect(decoded.projects.projects[0]).toEqual({
      projectId: 'project-1',
      existed: true,
      project: expect.objectContaining({ id: 'project-1' }),
    });
    expect(decoded.projects.projects[0]?.project?.tasks[0]?.content).toBe('preserved content');
    expect(decoded.projects.dockSnapshot).toEqual({
      present: true,
      localStorage: DOCK_LOCAL_STORAGE_RAW,
      indexedDb: DOCK_INDEXED_DB_RAW,
    });
    expect(decoded.projects.launchSnapshot).toEqual({
      present: true,
      v1: LAUNCH_SNAPSHOT_V1_RAW,
      v2: LAUNCH_SNAPSHOT_V2_RAW,
    });
    expect(decoded.projects.parkedTaskCache).toEqual({
      present: true,
      entries: [PARKED_TASK_ENTRY],
      syncMetadata: {
        'parking_last_sync_time:restore-owner': '2026-07-27T00:05:00.000Z',
      },
    });
    expect(decoded.attachmentOutbox[0]).toEqual(expect.objectContaining({
      ownerUserId: OWNER_USER_ID,
      operationId: 'attachment-operation',
    }));
    expect(decoded.actionQueue.indexedDb?.id).toBe(`queue-backup:${OWNER_USER_ID}`);
    expect(decoded.retryQueue.indexedDb).toEqual([{ id: 'retry-1' }]);
    expect(decoded.retryQueue.restoredItems).toEqual([makeRetryQueueRestoreItem()]);
    expect(decoded.deadLetters.indexedDb?.id).toBe(`dead-letter-backup:${OWNER_USER_ID}`);
    expect(decoded.conflicts).toEqual({
      indexedDbRecords: null,
      fallbackLocalStorageEntries: {},
    });
    expect(decoded.metadata.lastSyncTime).toBe('2026-07-27T00:02:00.000Z');
  });

  it('fails closed when any slot is malformed or belongs to another owner', () => {
    const missingProject = makeMarker();
    missingProject.preImage.projectState = {
      schemaVersion: 1,
      projects: [{ projectId: 'project-1', existed: true, project: null }],
      externalSourceLinks: [],
      externalSourcePendingLinks: [],
      offlineSnapshot: null,
    };
    expect(() => decodeLocalBackupUiRestoreStageSnapshots(missingProject)).toThrow(/projectState/i);

    const foreignAttachment = makeMarker();
    foreignAttachment.preImage.attachmentOutbox = [{
      ...(foreignAttachment.preImage.attachmentOutbox as unknown[])[0] as Record<string, unknown>,
      ownerUserId: 'another-owner',
    }];
    expect(() => decodeLocalBackupUiRestoreStageSnapshots(foreignAttachment)).toThrow(/attachmentOutbox/i);

    const foreignLaunchSnapshot = makeMarker();
    foreignLaunchSnapshot.preImage.projectState = makeProjectState({
      launchSnapshot: {
        present: true,
        v1: LAUNCH_SNAPSHOT_V1_RAW,
        v2: JSON.stringify({
          version: 2,
          userId: 'another-owner',
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
        }),
      },
    });
    expect(() => decodeLocalBackupUiRestoreStageSnapshots(foreignLaunchSnapshot)).toThrow(/projectState/i);

    const foreignParkedTaskCache = makeMarker();
    foreignParkedTaskCache.preImage.projectState = makeProjectState({
      parkedTaskCache: {
        present: true,
        entries: [{ ...PARKED_TASK_ENTRY, ownerUserId: 'another-owner' }],
        syncMetadata: {
          'parking_last_sync_time:restore-owner': '2026-07-27T00:05:00.000Z',
        },
      },
    });
    expect(() => decodeLocalBackupUiRestoreStageSnapshots(foreignParkedTaskCache)).toThrow(/projectState/i);

    const missingMetadata = makeMarker();
    missingMetadata.preImage.metadata = { projectCursors: [] };
    expect(() => decodeLocalBackupUiRestoreStageSnapshots(missingMetadata)).toThrow(/metadata/i);
  });

  it.each([
    ['foreign localStorage payload', {
      scopedLocalStorageValue: JSON.stringify({ ownerUserId: 'another-owner' }),
      scopedIndexedDbRecord: null,
    }],
    ['foreign IndexedDB owner', {
      scopedLocalStorageValue: null,
      scopedIndexedDbRecord: {
        id: `offline-snapshot:${OWNER_USER_ID}`,
        ownerUserId: 'another-owner',
        data: null,
      },
    }],
    ['foreign IndexedDB record ID', {
      scopedLocalStorageValue: null,
      scopedIndexedDbRecord: {
        id: 'offline-snapshot:another-owner',
        ownerUserId: OWNER_USER_ID,
        data: null,
      },
    }],
    ['global storage key', {
      scopedLocalStorageValue: null,
      scopedIndexedDbRecord: null,
      storageKey: 'nanoflow.offline-cache-v2',
    }],
    ['legacy localStorage field', {
      scopedLocalStorageValue: null,
      scopedIndexedDbRecord: null,
      legacyLocalStorageValue: null,
    }],
    ['legacy IndexedDB field', {
      scopedLocalStorageValue: null,
      scopedIndexedDbRecord: null,
      legacyIndexedDbRecord: null,
    }],
  ])('rejects %s in the owner-bound offline rollback snapshot', (_label, offlineSnapshot) => {
    const marker = makeMarker();
    marker.preImage.projectState = makeProjectState({ offlineSnapshot });

    expect(() => decodeLocalBackupUiRestoreStageSnapshots(marker)).toThrow(/projectState/i);
  });

  it('fails closed on a legacy retryQueue slot without the durable rollback footprint', () => {
    const legacy = makeMarker();
    legacy.preImage.retryQueue = { indexedDb: [], localStorage: null };

    expect(() => decodeLocalBackupUiRestoreStageSnapshots(legacy)).toThrow(/retryQueue/i);
  });

  it('fails closed on foreign or malformed retryQueue rollback footprints', () => {
    const foreign = makeMarker();
    foreign.preImage.retryQueue = {
      schemaVersion: 2,
      indexedDb: [],
      localStorage: null,
      restoredItems: [{ ...makeRetryQueueRestoreItem(), sourceUserId: 'foreign-owner' }],
    };
    expect(() => decodeLocalBackupUiRestoreStageSnapshots(foreign)).toThrow(/retryQueue/i);

    const malformed = makeMarker();
    malformed.preImage.retryQueue = {
      schemaVersion: 2,
      indexedDb: [],
      localStorage: null,
      restoredItems: [{ ...makeRetryQueueRestoreItem(), operationId: 'not-durable' }],
    };
    expect(() => decodeLocalBackupUiRestoreStageSnapshots(malformed)).toThrow(/retryQueue/i);
  });

  it.each([
    ['queue id', (item: ReturnType<typeof makeRetryQueueRestoreItem>) => ({
      ...item,
      operationId: '66666666-6666-4666-8666-666666666666',
      data: { id: '77777777-7777-4777-8777-777777777777' },
    })],
    ['operationId', (item: ReturnType<typeof makeRetryQueueRestoreItem>) => ({
      ...item,
      id: '66666666-6666-4666-8666-666666666666',
      data: { id: '77777777-7777-4777-8777-777777777777' },
    })],
    ['effective owner/type/data.id identity', (item: ReturnType<typeof makeRetryQueueRestoreItem>) => ({
      ...item,
      id: '66666666-6666-4666-8666-666666666666',
      operationId: '77777777-7777-4777-8777-777777777777',
    })],
  ])('fails closed when the durable retryQueue footprint has a duplicate %s', (
    _identity,
    makeConflict,
  ) => {
    const marker = makeMarker();
    const item = makeRetryQueueRestoreItem();
    marker.preImage.retryQueue = {
      schemaVersion: 2,
      indexedDb: [],
      localStorage: null,
      restoredItems: [item, makeConflict(item)],
    };

    expect(() => decodeLocalBackupUiRestoreStageSnapshots(marker)).toThrow(/retryQueue/i);
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
  ])('fails closed when durable retryQueue canonical UUID casing duplicates %s', (
    _identity,
    makeConflict,
  ) => {
    const marker = makeMarker();
    const item = makeCaseSensitiveRetryQueueRestoreItem();
    marker.preImage.retryQueue = {
      schemaVersion: 2,
      indexedDb: [],
      localStorage: null,
      restoredItems: [item, makeConflict(item)],
    };

    expect(() => decodeLocalBackupUiRestoreStageSnapshots(marker)).toThrow(/retryQueue/i);
  });
});

function makeMarker(): LocalBackupUiRestoreMarker {
  const project = makeProject();
  return {
    schemaVersion: 2,
    ownerUserId: OWNER_USER_ID,
    runId: '11111111-1111-4111-8111-111111111111',
    restoreRunId: RESTORE_RUN_ID,
    actionQueueRestoreIdentity: ACTION_QUEUE_RESTORE_IDENTITY,
    createdAt: '2026-07-27T00:00:00.000Z',
    leaseExpiresAt: '2026-07-27T00:05:00.000Z',
    state: 'prepared',
    phase: 'pre-image-captured',
    completedStages: [],
    rollbackCompletedStages: [],
    source: { kind: 'local-file', reference: 'backup.json', checksum: SOURCE_DIGEST },
    touchedProjectIds: ['project-1'],
    rollbackErrors: [],
    preImage: {
      projectState: makeProjectState({ project }),
      attachmentOutbox: [{
        ownerUserId: OWNER_USER_ID,
        operationId: 'attachment-operation',
        attachmentId: 'attachment-1',
        blobKey: 'blob-1',
        fileName: 'note.txt',
        mimeType: 'text/plain',
        size: 7,
        createdAt: '2026-07-27T00:00:00.000Z',
        encoding: 'base64',
        blobBase64: 'YmluYXJ5',
      }],
      actionQueue: {
        indexedDb: {
          id: `queue-backup:${OWNER_USER_ID}`,
          ownerUserId: OWNER_USER_ID,
          savedAt: '2026-07-27T00:00:00.000Z',
          actions: [],
        },
        localStorage: null,
      },
      retryQueue: {
        schemaVersion: 2,
        indexedDb: [{ id: 'retry-1' }],
        localStorage: null,
        restoredItems: [makeRetryQueueRestoreItem()],
      },
      deadLetters: {
        indexedDb: {
          id: `dead-letter-backup:${OWNER_USER_ID}`,
          ownerUserId: OWNER_USER_ID,
          savedAt: '2026-07-27T00:00:00.000Z',
          deadLetters: [],
        },
        localStorage: null,
      },
      conflicts: { indexedDbRecords: null, fallbackLocalStorageEntries: {} },
      metadata: {
        projectCursors: [],
        lastSyncTime: '2026-07-27T00:02:00.000Z',
        replayLog: [],
        lastWriteExplain: null,
        taskTombstones: {},
        connectionTombstones: [],
      },
    },
  };
}

function makeProjectState(overrides: {
  project?: LocalBackupUiRestoreJsonValue;
  launchSnapshot?: LocalBackupUiRestoreJsonValue;
  parkedTaskCache?: LocalBackupUiRestoreJsonValue;
  offlineSnapshot?: LocalBackupUiRestoreJsonValue;
} = {}): LocalBackupUiRestoreJsonValue {
  return {
    schemaVersion: 1,
    projects: [{
      projectId: 'project-1',
      existed: true,
      project: overrides.project ?? makeProject(),
    }],
    externalSourceLinks: [],
    externalSourcePendingLinks: [],
    offlineSnapshot: overrides.offlineSnapshot ?? {
      scopedLocalStorageValue: null,
      scopedIndexedDbRecord: null,
    },
    dockSnapshot: {
      present: true,
      localStorage: DOCK_LOCAL_STORAGE_RAW,
      indexedDb: DOCK_INDEXED_DB_RAW,
    },
    launchSnapshot: overrides.launchSnapshot ?? {
      present: true,
      v1: LAUNCH_SNAPSHOT_V1_RAW,
      v2: LAUNCH_SNAPSHOT_V2_RAW,
    },
    parkedTaskCache: overrides.parkedTaskCache ?? {
      present: true,
      entries: [PARKED_TASK_ENTRY],
      syncMetadata: {
        'parking_last_sync_time:restore-owner': '2026-07-27T00:05:00.000Z',
      },
    },
  };
}

function makeRetryQueueRestoreItem() {
  return {
    id: '33333333-3333-4333-8333-333333333333',
    operationId: '44444444-4444-4444-8444-444444444444',
    type: 'task',
    operation: 'upsert',
    data: { id: '55555555-5555-4555-8555-555555555555' },
    retryCount: 0,
    createdAt: Date.parse('2026-07-27T00:00:00.000Z'),
    sourceUserId: OWNER_USER_ID,
  };
}

function makeCaseSensitiveRetryQueueRestoreItem() {
  return {
    ...makeRetryQueueRestoreItem(),
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    operationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    data: { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' },
  };
}

function makeProject() {
  return {
    id: 'project-1',
    name: 'Current project',
    description: '',
    createdDate: '2026-07-27T00:00:00.000Z',
    updatedAt: '2026-07-27T00:01:00.000Z',
    version: 1,
    tasks: [{
      id: 'task-1',
      title: 'Task',
      content: 'preserved content',
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
  } satisfies Project;
}
