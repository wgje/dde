import 'fake-indexeddb/auto';

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DataSafetyAuditPersistence } from './data-safety-audit-persistence';
import { DisasterBackupLocalStateReader } from './disaster-backup-local-state.reader';
import { seedStore } from './disaster-backup.service.spec-helpers';

const TEST_DBS = [
  'nanoflow-offline-snapshots',
  'focus_mode',
  'nanoflow-retry-queue',
  'nanoflow-queue-backup',
  'keyval-store',
];

async function deleteDb(name: string): Promise<void> {
  await new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
    request.onblocked = () => resolve();
  });
}

function createReader(overrides: Partial<ConstructorParameters<typeof DisasterBackupLocalStateReader>[0]> = {}) {
  return new DisasterBackupLocalStateReader({
    conflictStorage: {
      getAllConflicts: vi.fn().mockResolvedValue([
        { projectId: 'project-1', reason: 'field_conflict' },
      ]),
    },
    externalSourceCache: {
      loadPendingLinks: vi.fn().mockResolvedValue([
        { id: 'pending-link-1', targetId: 'task-1' },
      ]),
    },
    attachmentUploadOutbox: null,
    dataSafetyAuditPersistence: new DataSafetyAuditPersistence(),
    ...overrides,
  });
}

describe('DisasterBackupLocalStateReader', () => {
  beforeEach(async () => {
    localStorage.clear();
    await Promise.all(TEST_DBS.map(deleteDb));
  });

  it('reads owner-scoped local state and filters project-scoped artifacts', async () => {
    localStorage.setItem('nanoflow.offline-cache-v2.user-1', JSON.stringify({
      projects: [{ id: 'offline-project' }],
    }));
    localStorage.setItem('nanoflow.retry-queue', JSON.stringify([
      { id: 'retry-1', sourceUserId: 'user-1', entityType: 'task', operation: 'upsert' },
      { id: 'retry-foreign', sourceUserId: 'user-2', entityType: 'task', operation: 'upsert' },
    ]));
    localStorage.setItem('nanoflow.action-queue.user-1', JSON.stringify([
      { id: 'action-1', entityType: 'project', operation: 'update' },
    ]));
    localStorage.setItem('nanoflow.action-queue.user-2', JSON.stringify([
      { id: 'action-foreign', entityType: 'project', operation: 'update' },
    ]));
    localStorage.setItem('nanoflow.dead-letter-queue.user-1', JSON.stringify([
      { id: 'dead-1', reason: 'failed' },
    ]));
    localStorage.setItem('nanoflow.local-tombstones', JSON.stringify({
      'project-1': { 'task-deleted': 123 },
      'project-2': { 'task-foreign': 456 },
    }));
    localStorage.setItem('nanoflow.local-connection-tombstones', JSON.stringify([
      { projectId: 'project-1', connectionId: 'conn-deleted' },
      { projectId: 'project-2', connectionId: 'conn-foreign' },
      { connectionId: 'conn-without-project' },
    ]));
    localStorage.setItem('nanoflow.dock-snapshot.v3.user-1', JSON.stringify({
      savedAt: '2026-03-10T00:00:00.000Z',
      session: { mainTaskId: 'task-1' },
    }));
    localStorage.setItem('nanoflow.launch-snapshot.v1', JSON.stringify({
      version: 1,
      userId: 'user-2',
      activeProjectId: 'project-2',
    }));
    localStorage.setItem('nanoflow.launch-snapshot.v2', JSON.stringify({
      version: 2,
      userId: 'user-1',
      activeProjectId: 'project-1',
    }));

    await seedStore(
      'nanoflow-offline-snapshots',
      1,
      (db) => {
        if (!db.objectStoreNames.contains('snapshots')) {
          db.createObjectStore('snapshots', { keyPath: 'id' });
        }
      },
      async (db) => {
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction('snapshots', 'readwrite');
          tx.objectStore('snapshots').put({
            id: 'offline-snapshot:user-1',
            data: JSON.stringify({ projects: [{ id: 'snapshot-project' }] }),
          });
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
      },
    );

    await seedStore(
      'focus_mode',
      3,
      (db) => {
        if (!db.objectStoreNames.contains('sync_metadata')) {
          db.createObjectStore('sync_metadata', { keyPath: 'key' });
        }
        if (!db.objectStoreNames.contains('parked_tasks')) {
          db.createObjectStore('parked_tasks', { keyPath: 'taskId' });
        }
      },
      async (db) => {
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction(['sync_metadata', 'parked_tasks'], 'readwrite');
          tx.objectStore('sync_metadata').put({ key: 'parking_sync_cursor_v1', value: 'cursor-1' });
          tx.objectStore('parked_tasks').put({
            taskId: 'task-parked',
            projectId: 'project-1',
          });
          tx.objectStore('parked_tasks').put({
            taskId: 'task-parked-foreign',
            projectId: 'project-2',
          });
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
      },
    );

    const localState = await createReader().readLocalState('user-1', new Set(['project-1']));

    expect(localState.offlineSnapshot).toEqual({
      localStorage: JSON.stringify({ projects: [{ id: 'offline-project' }] }),
      indexedDb: JSON.stringify({ projects: [{ id: 'snapshot-project' }] }),
    });
    expect(localState.retryQueue).toEqual([
      expect.objectContaining({ id: 'retry-1', sourceUserId: 'user-1' }),
    ]);
    expect(localState.actionQueue).toEqual([
      expect.objectContaining({ id: 'action-1' }),
    ]);
    expect(localState.deadLetters).toEqual([
      expect.objectContaining({ id: 'dead-1' }),
    ]);
    expect(localState.taskTombstones).toEqual({ 'project-1': { 'task-deleted': 123 } });
    expect(localState.connectionTombstones).toEqual([
      expect.objectContaining({ connectionId: 'conn-deleted' }),
    ]);
    expect(localState.dockSnapshot).toEqual(expect.objectContaining({
      localStorage: JSON.stringify({
        savedAt: '2026-03-10T00:00:00.000Z',
        session: { mainTaskId: 'task-1' },
      }),
    }));
    expect(localState.launchSnapshot).toEqual({
      v1: null,
      v2: JSON.stringify({
        version: 2,
        userId: 'user-1',
        activeProjectId: 'project-1',
      }),
    });
    expect(localState.parkedTaskCache).toEqual({
      entries: [expect.objectContaining({ taskId: 'task-parked', projectId: 'project-1' })],
      syncMetadata: { parking_sync_cursor_v1: 'cursor-1' },
    });
    expect(localState.conflicts).toEqual([
      expect.objectContaining({ projectId: 'project-1' }),
    ]);
    expect(localState.externalSourcePendingLinks).toEqual([
      expect.objectContaining({ id: 'pending-link-1' }),
    ]);
    expect(localState.dataSafety).toEqual(expect.objectContaining({
      ownerUserId: 'user-1',
      syncSnapshot: expect.objectContaining({
        queueCounts: {
          retryQueue: 1,
          actionQueue: 1,
          deadLetters: 1,
        },
      }),
    }));
  });

  it('serializes pending attachment upload blobs when an outbox is available', async () => {
    const reader = createReader({
      attachmentUploadOutbox: {
        listPendingUploads: vi.fn().mockResolvedValue([{
          attachmentId: 'attachment-1',
          blobKey: 'attachment-1',
          fileName: 'offline.txt',
          mimeType: 'text/plain',
          size: 2,
          createdAt: '2026-06-18T00:00:00.000Z',
          blob: new Blob([new Uint8Array([78, 70])], { type: 'text/plain' }),
        }]),
      },
    });

    const localState = await reader.readLocalState('user-1', new Set(['project-1']));

    expect(localState.attachmentUploadOutbox).toEqual([{
      attachmentId: 'attachment-1',
      blobKey: 'attachment-1',
      fileName: 'offline.txt',
      mimeType: 'text/plain',
      size: 2,
      createdAt: '2026-06-18T00:00:00.000Z',
      encoding: 'base64',
      blobBase64: 'TkY=',
    }]);
  });
});
