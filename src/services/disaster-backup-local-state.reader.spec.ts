import 'fake-indexeddb/auto';

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DataSafetyAuditPersistence } from './data-safety-audit-persistence';
import { normalizeParkedTaskCacheRestoreSnapshot } from './data-safety-indexeddb-local-state';
import { DisasterBackupLocalStateReader } from './disaster-backup-local-state.reader';
import { DisasterBackupService } from './disaster-backup.service';
import { seedStore } from './disaster-backup.service.spec-helpers';

const TEST_DBS = [
  'nanoflow-offline-snapshots',
  'focus_mode',
  'nanoflow-retry-queue',
  'nanoflow-queue-backup',
  'keyval-store',
  'nanoflow-store-cache',
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

interface TestRetryQueueItem {
  id: string;
  operationId: string;
  sourceUserId: string;
  type: 'task';
  operation: 'upsert';
  data: { id: string; content: string; displayId?: string };
  projectId: string;
  retryCount: number;
  lastFailure?: {
    errorType: string;
    message: string;
    remoteOutcome: 'unknown';
    recordedAt: number;
  };
  createdAt: number;
}

function createRetryQueueItem(overrides: Partial<TestRetryQueueItem> = {}): TestRetryQueueItem {
  const id = overrides.id ?? crypto.randomUUID();
  return {
    id,
    operationId: overrides.operationId ?? crypto.randomUUID(),
    sourceUserId: overrides.sourceUserId ?? 'user-1',
    type: 'task',
    operation: 'upsert',
    data: overrides.data ?? { id: `task-${id}`, content: 'must survive export' },
    projectId: overrides.projectId ?? 'project-1',
    retryCount: overrides.retryCount ?? 0,
    createdAt: overrides.createdAt ?? 1,
  };
}

async function seedRetryQueue(items: TestRetryQueueItem[]): Promise<void> {
  await seedStore(
    'nanoflow-retry-queue',
    1,
    (db) => {
      if (!db.objectStoreNames.contains('offline_mutation_queue')) {
        db.createObjectStore('offline_mutation_queue', { keyPath: 'id' });
      }
    },
    async (db) => {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('offline_mutation_queue', 'readwrite');
        const store = tx.objectStore('offline_mutation_queue');
        items.forEach(item => store.put(item));
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    },
  );
}

type TestProjectCursorRecord = Record<string, unknown> & { key: string };

function createProjectCursorRecord(
  overrides: Record<string, unknown> = {},
): TestProjectCursorRecord {
  return {
    key: 'project:user-1:project-1',
    scope: 'project',
    userId: 'user-1',
    projectId: 'project-1',
    cursor: {
      updatedAt: '2026-03-11T00:00:00.000Z',
      entityType: 'task',
      id: 'task-9',
    },
    committedAt: '2026-03-11T00:00:01.000Z',
    ...overrides,
  };
}

async function seedProjectCursorRows(rows: TestProjectCursorRecord[]): Promise<void> {
  await seedStore(
    'nanoflow-store-cache',
    3,
    db => db.createObjectStore('sync_cursors', { keyPath: 'key' }),
    async (db) => {
      const tx = db.transaction('sync_cursors', 'readwrite');
      rows.forEach(row => tx.objectStore('sync_cursors').put(row));
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    },
  );
}

async function readIndexedDbRow(key: string, dbName = 'nanoflow-store-cache', storeName = 'sync_cursors'): Promise<unknown> {
  let row: unknown;
  await seedStore(dbName, 3, () => undefined, async (db) => {
    const request = db.transaction(storeName, 'readonly').objectStore(storeName).get(key);
    row = await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
  });
  return row;
}
function createParkedTaskRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ownerUserId: 'user-1', taskId: 'user-1:task-parked', projectId: 'project-1',
    task: { id: 'task-parked', content: 'parked content' }, updatedAt: '2026-03-08T00:00:00.000Z', ...overrides,
  };
}
async function seedParkedTaskRows(rows: unknown[]): Promise<void> {
  await seedStore('focus_mode', 3, db => {
    if (!db.objectStoreNames.contains('sync_metadata')) db.createObjectStore('sync_metadata', { keyPath: 'key' });
    if (!db.objectStoreNames.contains('parked_tasks')) db.createObjectStore('parked_tasks', { keyPath: 'taskId' });
  }, db => new Promise<void>((resolve, reject) => {
    const tx = db.transaction(['parked_tasks', 'sync_metadata'], 'readwrite');
    rows.forEach(row => tx.objectStore('parked_tasks').put(row)); tx.objectStore('sync_metadata').put({ key: 'parking_last_sync_time:user-1', value: 'cursor-1' });
    tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error);
  }));
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
      {
        id: 'retry-1',
        operationId: 'operation-retry-1',
        sourceUserId: 'user-1',
        type: 'task',
        operation: 'upsert',
        data: { id: 'task-retry-1', content: 'legacy array item' },
        projectId: 'project-1',
        retryCount: 0,
        createdAt: 1,
      },
      {
        id: 'retry-foreign',
        operationId: 'operation-retry-foreign',
        sourceUserId: 'user-2',
        type: 'task',
        operation: 'upsert',
        data: { id: 'task-retry-foreign', content: 'foreign legacy array item' },
        projectId: 'project-2',
        retryCount: 0,
        createdAt: 2,
      },
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
      { projectId: 'project-1', connectionId: 'conn-deleted', timestamp: 123 },
      { projectId: 'project-2', connectionId: 'conn-foreign', timestamp: 456 },
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
          tx.objectStore('sync_metadata').put({ key: 'parking_last_sync_time:user-1', value: 'cursor-1' });
          tx.objectStore('sync_metadata').put({ key: 'parking_last_sync_time:user-2', value: 'cursor-2' });
          tx.objectStore('parked_tasks').put(createParkedTaskRow());
          tx.objectStore('parked_tasks').put({
            ownerUserId: 'user-2',
            taskId: 'user-2:task-parked-foreign',
            projectId: 'project-1',
          });
          tx.objectStore('parked_tasks').put({
            ownerUserId: 'user-1',
            taskId: 'user-1:task-parked-hidden',
            projectId: 'project-2',
          });
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
      },
    );

    await seedProjectCursorRows([
      createProjectCursorRecord(),
      createProjectCursorRecord({
        key: 'project:user-2:project-1',
        userId: 'user-2',
      }),
      createProjectCursorRecord({
        key: 'project:user-1:project-2',
        projectId: 'project-2',
      }),
    ]);

    const localState = await createReader({
      readSyncState: () => ({
        lastSyncTime: '2026-03-11T00:00:02.000Z',
        pendingCount: 7,
      }),
    }).readLocalState('user-1', new Set(['project-1']));

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
      entries: [expect.objectContaining({
        ownerUserId: 'user-1',
        taskId: 'user-1:task-parked',
        projectId: 'project-1',
      })],
      syncMetadata: { 'parking_last_sync_time:user-1': 'cursor-1' },
    });
    expect(normalizeParkedTaskCacheRestoreSnapshot({
      present: true, ...localState.parkedTaskCache,
    }, 'user-1')).not.toBeNull();
    expect(localState.conflicts).toEqual([
      expect.objectContaining({ projectId: 'project-1' }),
    ]);
    expect(localState.externalSourcePendingLinks).toEqual([
      expect.objectContaining({ id: 'pending-link-1' }),
    ]);
    expect(localState.dataSafety).toEqual(expect.objectContaining({
      ownerUserId: 'user-1',
      syncSnapshot: expect.objectContaining({
        syncState: expect.objectContaining({
          lastSyncTime: '2026-03-11T00:00:02.000Z',
          pendingCount: 7,
        }),
        projectCursors: [{
          projectId: 'project-1',
          userId: 'user-1',
          cursor: {
            updatedAt: '2026-03-11T00:00:00.000Z',
            entityType: 'task',
            id: 'task-9',
          },
        }],
        queueCounts: {
          retryQueue: 1,
          actionQueue: 1,
          deadLetters: 1,
        },
      }),
    }));
  });

  describe('project cursor export integrity', () => {
    it.each([
      ['scope', createProjectCursorRecord({ scope: 'task' })],
      ['owner', createProjectCursorRecord({ userId: 'user-2' })],
      ['project', createProjectCursorRecord({ projectId: 'project-2' })],
      ['bare envelope', { key: 'project:user-1:project-1', cursor: createProjectCursorRecord()['cursor'] }],
      ['committedAt', createProjectCursorRecord({ committedAt: 'invalid' })],
      ['cursor shape', createProjectCursorRecord({ cursor: { updatedAt: '2026-03-11T00:00:00.000Z' } })],
      ['cursor updatedAt', createProjectCursorRecord({ cursor: { updatedAt: 'invalid', entityType: 'task', id: 'task-9' } })],
    ] satisfies [string, TestProjectCursorRecord][])(
      'rejects malformed %s without changing its bytes',
      async (_field, row) => {
        await seedProjectCursorRows([row]);

        await expect(createReader().readLocalState('user-1', new Set(['project-1'])))
          .rejects.toThrow(/sync cursor/i);
        expect(await readIndexedDbRow(row.key)).toEqual(row);
      },
    );

    it('accepts a canonical legacy cursor with an empty project entity id', async () => {
      await seedProjectCursorRows([createProjectCursorRecord({
        cursor: { updatedAt: '2026-03-11T00:00:00.000Z', entityType: 'project', id: '' },
      })]);

      const state = await createReader().readLocalState('user-1', new Set(['project-1']));

      expect(state.dataSafety?.syncSnapshot?.projectCursors).toEqual([
        expect.objectContaining({ projectId: 'project-1', cursor: expect.objectContaining({ id: '' }) }),
      ]);
    });

    it('treats an absent exact key as empty without scanning an unrelated malformed row', async () => {
      const unrelated = createProjectCursorRecord({ key: 'unrelated', scope: null });
      await seedProjectCursorRows([unrelated]);

      const state = await createReader().readLocalState('user-1', new Set(['project-1']));

      expect(state.dataSafety?.syncSnapshot?.projectCursors).toEqual([]);
      expect(await readIndexedDbRow(unrelated.key)).toEqual(unrelated);
    });

    it('reads visible exact keys without enumerating the sync cursor store', async () => {
      await seedProjectCursorRows([createProjectCursorRecord()]);
      const getAll = vi.spyOn(IDBObjectStore.prototype, 'getAll');

      try {
        await createReader().readLocalState('user-1', new Set(['project-1']));
        expect(getAll.mock.contexts.map(context => {
          if (!(context instanceof IDBObjectStore)) {
            throw new TypeError('Expected getAll to run with an IDBObjectStore context');
          }
          return context.name;
        })).not.toContain('sync_cursors');
      } finally {
        getAll.mockRestore();
      }
    });
  });

  describe('tombstone export integrity', () => {
    it.each([
      'nanoflow.local-tombstones',
      'nanoflow.local-connection-tombstones',
    ])('rejects malformed JSON in %s without changing its bytes', async (key) => {
      const malformed = '{broken-json';
      localStorage.setItem(key, malformed);

      await expect(createReader().readLocalState('user-1', new Set(['project-1'])))
        .rejects.toThrow(/tombstone/i);
      expect(localStorage.getItem(key)).toBe(malformed);
    });

    it('accepts actually absent tombstone keys as empty', async () => {
      localStorage.removeItem('nanoflow.local-tombstones');
      localStorage.removeItem('nanoflow.local-connection-tombstones');

      const localState = await createReader().readLocalState('user-1', new Set(['project-1']));

      expect(localState.taskTombstones).toEqual({});
      expect(localState.connectionTombstones).toEqual([]);
    });

    it('rejects tombstone storage access failure', async () => {
      const originalGetItem = localStorage.getItem.bind(localStorage);
      vi.spyOn(localStorage, 'getItem').mockImplementation((key) => {
        if (key === 'nanoflow.local-tombstones') throw new Error('storage denied');
        return originalGetItem(key);
      });

      await expect(createReader().readLocalState('user-1', new Set(['project-1'])))
        .rejects.toThrow(/storage denied/);
    });

    it('prevents caller Blob construction when tombstone validation fails', async () => {
      localStorage.setItem('nanoflow.local-tombstones', '{broken-json');
      const blobConstructor = vi.fn();
      vi.stubGlobal('Blob', blobConstructor);

      try {
        await expect(Reflect.apply(DisasterBackupService.prototype.buildLocalBlob, {
          buildLocalPayload: () => createReader().readLocalState('user-1', new Set(['project-1'])),
          shouldDeferLocalBackupWrite: () => false,
        }, [[], { autoBackupEnabled: false, autoBackupIntervalMs: 900_000 }]))
          .rejects.toThrow(/tombstone/i);
        expect(blobConstructor).not.toHaveBeenCalled();
      } finally {
        vi.unstubAllGlobals();
      }
    });
  });

  describe('RetryQueue export', () => {
    it('reads the production localStorage envelope when IndexedDB is absent', async () => {
      const fallbackItem = createRetryQueueItem({ createdAt: 2 });
      localStorage.setItem('nanoflow.retry-queue', JSON.stringify({
        version: 1,
        items: [fallbackItem],
        savedAt: 2,
      }));

      const localState = await createReader().readLocalState('user-1', new Set(['project-1']));

      expect(localState.retryQueue).toEqual([fallbackItem]);
    });

    it('exports the deterministic union of IndexedDB and fallback writes without duplicating the same item', async () => {
      const indexedDbItem = createRetryQueueItem({ createdAt: 1 });
      const fallbackOnlyItem = createRetryQueueItem({ createdAt: 2 });
      await seedRetryQueue([indexedDbItem]);
      localStorage.setItem('nanoflow.retry-queue', JSON.stringify({
        version: 1,
        items: [indexedDbItem, fallbackOnlyItem],
        savedAt: 2,
      }));

      const localState = await createReader().readLocalState('user-1', new Set(['project-1']));

      expect(localState.retryQueue).toEqual([indexedDbItem, fallbackOnlyItem]);
    });

    it('deduplicates the same mirror when IndexedDB keeps undefined fields omitted by JSON', async () => {
      const baseItem = createRetryQueueItem({ createdAt: 1 });
      const indexedDbItem = {
        ...baseItem,
        writeIntent: undefined,
        lastFailure: undefined,
        taskIdsToDelete: undefined,
      };
      const fallbackMirror = JSON.parse(JSON.stringify(indexedDbItem)) as TestRetryQueueItem;
      await seedRetryQueue([indexedDbItem]);
      localStorage.setItem('nanoflow.retry-queue', JSON.stringify({
        version: 1,
        items: [fallbackMirror],
        savedAt: 2,
      }));

      const localState = await createReader().readLocalState('user-1', new Set(['project-1']));

      expect(localState.retryQueue).toHaveLength(1);
      expect(localState.retryQueue).toEqual([
        expect.objectContaining({ id: baseItem.id, operationId: baseItem.operationId }),
      ]);
    });

    it('deduplicates task mirrors when persistence removes displayId only', async () => {
      const indexedDbItem = createRetryQueueItem({
        data: {
          id: 'task-display-id-mirror',
          content: 'content remains authoritative',
          displayId: '42',
        },
      });
      const fallbackMirror = {
        ...indexedDbItem,
        data: {
          id: indexedDbItem.data.id,
          content: indexedDbItem.data.content,
        },
      };
      await seedRetryQueue([indexedDbItem]);
      localStorage.setItem('nanoflow.retry-queue', JSON.stringify({
        version: 1,
        items: [fallbackMirror],
        savedAt: 2,
      }));

      const localState = await createReader().readLocalState('user-1', new Set(['project-1']));

      expect(localState.retryQueue).toHaveLength(1);
      expect(localState.retryQueue).toEqual([
        expect.objectContaining({
          id: indexedDbItem.id,
          operationId: indexedDbItem.operationId,
          data: expect.objectContaining({ content: 'content remains authoritative' }),
        }),
      ]);
    });

    it('exports the monotonic newer retry state for the same queue identity', async () => {
      const indexedDbItem = createRetryQueueItem({
        retryCount: 1,
        lastFailure: {
          errorType: 'network',
          message: 'first failure',
          remoteOutcome: 'unknown',
          recordedAt: 10,
        },
      });
      const fallbackItem = {
        ...indexedDbItem,
        retryCount: 2,
        lastFailure: {
          ...indexedDbItem.lastFailure!,
          message: 'second failure',
          recordedAt: 20,
        },
      };
      await seedRetryQueue([indexedDbItem]);
      localStorage.setItem('nanoflow.retry-queue', JSON.stringify({
        version: 1,
        items: [fallbackItem],
        savedAt: 2,
      }));

      const localState = await createReader().readLocalState('user-1', new Set(['project-1']));

      expect(localState.retryQueue).toEqual([fallbackItem]);
    });

    it('fails closed when the same queue identity carries different task content', async () => {
      const indexedDbItem = createRetryQueueItem({ createdAt: 1 });
      const fallbackItem = {
        ...indexedDbItem,
        data: { ...indexedDbItem.data, content: 'divergent content' },
      };
      await seedRetryQueue([indexedDbItem]);
      localStorage.setItem('nanoflow.retry-queue', JSON.stringify({
        version: 1,
        items: [fallbackItem],
        savedAt: 2,
      }));

      await expect(
        createReader().readLocalState('user-1', new Set(['project-1'])),
      ).rejects.toThrow(/RetryQueue export divergence/);
    });

    it('fails closed when the same owner entity has different queue and operation identities', async () => {
      const indexedDbItem = createRetryQueueItem({ createdAt: 1 });
      const fallbackItem = createRetryQueueItem({
        createdAt: 2,
        data: { ...indexedDbItem.data },
      });
      await seedRetryQueue([indexedDbItem]);
      localStorage.setItem('nanoflow.retry-queue', JSON.stringify({
        version: 1,
        items: [fallbackItem],
        savedAt: 2,
      }));

      await expect(
        createReader().readLocalState('user-1', new Set(['project-1'])),
      ).rejects.toThrow(/RetryQueue export divergence/);
    });

    it.each([
      { field: 'operationId' as const, expected: /operationId/ },
      { field: 'sourceUserId' as const, expected: /sourceUserId/ },
    ])('fails closed without generating identity when $field is missing', async ({ field, expected }) => {
      const completeItem = createRetryQueueItem({ createdAt: 1 });
      const item = { ...completeItem } as Partial<TestRetryQueueItem>;
      delete item[field];
      localStorage.setItem('nanoflow.retry-queue', JSON.stringify({
        version: 1,
        items: [item],
        savedAt: 2,
      }));
      const randomUuid = vi.spyOn(crypto, 'randomUUID');

      try {
        await expect(
          createReader().readLocalState('user-1', new Set(['project-1'])),
        ).rejects.toThrow(expected);
        expect(randomUuid).not.toHaveBeenCalled();
      } finally {
        randomUuid.mockRestore();
      }
    });

    it('fails closed for an unknown RetryQueue localStorage envelope version', async () => {
      localStorage.setItem('nanoflow.retry-queue', JSON.stringify({
        version: 2,
        items: [createRetryQueueItem()],
        savedAt: 2,
      }));

      await expect(
        createReader().readLocalState('user-1', new Set(['project-1'])),
      ).rejects.toThrow(/unsupported version/);
    });

    it.each([
      {
        identity: 'id',
        createFallback: (indexedDbItem: TestRetryQueueItem) => createRetryQueueItem({
          id: indexedDbItem.id,
          operationId: crypto.randomUUID(),
          data: { id: 'task-diverged-by-id', content: 'different write' },
        }),
      },
      {
        identity: 'operationId',
        createFallback: (indexedDbItem: TestRetryQueueItem) => createRetryQueueItem({
          operationId: indexedDbItem.operationId,
          data: { id: 'task-diverged-by-operation', content: 'different write' },
        }),
      },
    ])('fails closed when the same $identity identifies divergent RetryQueue writes', async ({ createFallback }) => {
      const indexedDbItem = createRetryQueueItem({ createdAt: 1 });
      const fallbackItem = createFallback(indexedDbItem);
      await seedRetryQueue([indexedDbItem]);
      localStorage.setItem('nanoflow.retry-queue', JSON.stringify({
        version: 1,
        items: [fallbackItem],
        savedAt: 2,
      }));

      await expect(
        createReader().readLocalState('user-1', new Set(['project-1'])),
      ).rejects.toThrow(/RetryQueue export divergence/);
    });
  });

  describe('parked task cache export', () => {
    it.each([
      ['ownerless', { ownerUserId: undefined }], ['projectless', { projectId: undefined }],
      ['task key mismatch', { taskId: 'user-1:other' }], ['invalid timestamp', { updatedAt: 'invalid' }],
      ['missing task id', { task: { content: 'parked content' } }], ['missing task content', { task: { id: 'task-parked' } }],
    ])('rejects %s visible evidence', async (_caseName, overrides) => {
      const row = createParkedTaskRow(overrides); await seedParkedTaskRows([row]);
      const taskKey = row['taskId']; if (typeof taskKey !== 'string') throw new Error('test fixture taskId must be a string');
      const keys = [taskKey, 'parking_last_sync_time:user-1']; const stores = ['parked_tasks', 'sync_metadata'];
      const before = await Promise.all(keys.map((key, index) => readIndexedDbRow(key, 'focus_mode', stores[index])));
      await expect(createReader().readLocalState('user-1', new Set(['project-1'])))
        .rejects.toThrow(/parked task cache/i);
      await expect(Promise.all(keys.map((key, index) => readIndexedDbRow(key, 'focus_mode', stores[index]))))
        .resolves.toEqual(before);
    });
    it('fails buildLocalBlob before checksum digest or Blob construction', async () => {
      await seedParkedTaskRows([createParkedTaskRow({ taskId: 'user-1:other' })]);
      const digest = vi.spyOn(crypto.subtle, 'digest');
      const blobConstructor = vi.fn(); vi.stubGlobal('Blob', blobConstructor);
      try {
        const context = {
          buildLocalPayload: DisasterBackupService.prototype.buildLocalPayload,
          resolveEffectiveUserId: () => 'user-1', externalSourceLinks: { ensureLoaded: vi.fn() },
          buildProjectPayload: () => ({ projects: [], tasks: [], connections: [] }),
          collectUserPreferences: async () => [], collectBlackBoxEntries: () => [],
          collectRemoteUserState: async () => ({ focusSessions: [], transcriptionUsage: [], routineTasks: [], routineCompletions: [] }),
          localStateReader: createReader(), supabase: { isConfigured: false }, shouldDeferLocalBackupWrite: () => false,
        };
        await expect(Reflect.apply(DisasterBackupService.prototype.buildLocalBlob, context,
          [[{ id: 'project-1' }], { autoBackupEnabled: false, autoBackupIntervalMs: 900_000 }])).rejects.toThrow(/parked task cache/i);
        expect(digest).not.toHaveBeenCalled(); expect(blobConstructor).not.toHaveBeenCalled();
      } finally { digest.mockRestore(); vi.unstubAllGlobals(); }
    });
  });

  it('serializes pending attachment upload blobs when an outbox is available', async () => {
    const listPendingUploads = vi.fn().mockResolvedValue([{
      ownerUserId: 'user-1',
      operationId: 'attachment:create:attachment-1',
      attachmentId: 'attachment-1',
      blobKey: 'attachment-1',
      fileName: 'offline.txt',
      mimeType: 'text/plain',
      size: 2,
      createdAt: '2026-06-18T00:00:00.000Z',
      blob: new Blob([new Uint8Array([78, 70])], { type: 'text/plain' }),
    }]);
    const reader = createReader({
      attachmentUploadOutbox: {
        listPendingUploads,
      },
    });

    const localState = await reader.readLocalState('user-1', new Set(['project-1']));

    expect(listPendingUploads).toHaveBeenCalledWith('user-1');
    expect(localState.attachmentUploadOutbox).toEqual([{
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
    }]);
  });

  it('does not export attachment uploads when no owner scope was captured', async () => {
    const listPendingUploads = vi.fn().mockResolvedValue([{
      ownerUserId: 'user-1',
      operationId: 'attachment:create:attachment-1',
      attachmentId: 'attachment-1',
      blobKey: 'attachment-1',
      fileName: 'offline.txt',
      mimeType: 'text/plain',
      size: 2,
      createdAt: '2026-06-18T00:00:00.000Z',
      blob: new Blob(['NF'], { type: 'text/plain' }),
    }]);
    const reader = createReader({
      attachmentUploadOutbox: { listPendingUploads },
    });

    const localState = await reader.readLocalState(null, new Set(['project-1']));

    expect(listPendingUploads).not.toHaveBeenCalled();
    expect(localState.attachmentUploadOutbox).toEqual([]);
  });
});
