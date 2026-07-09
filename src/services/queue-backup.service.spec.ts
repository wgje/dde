import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LoggerService } from './logger.service';
import { QueueBackupService, type LegacyQueueReviewItem, type QueueBackupRecord } from './queue-backup.service';
import type { QueuedAction } from './action-queue.types';

const DB_NAME = 'nanoflow-queue-backup';
const STORE_NAME = 'queue-backup';
const LEGACY_RECORD_ID = 'nanoflow-queue-backup-v1';

function deleteQueueBackupDatabase(): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error(`Failed to delete ${DB_NAME}`));
    request.onblocked = () => reject(new Error(`Delete blocked for ${DB_NAME}`));
  });
}

function makeAction(id: string): QueuedAction {
  return {
    id,
    operationId: `op-${id}`,
    type: 'update',
    entityType: 'task',
    entityId: id,
    payload: {
      task: {
        id,
        title: id,
        content: '',
        stage: 1,
        parentId: null,
        order: 0,
        rank: 10000,
        status: 'active',
        x: 0,
        y: 0,
        displayId: id,
        createdDate: '2026-06-08T00:00:00.000Z',
      },
      projectId: 'project-1',
    },
    timestamp: 1,
    retryCount: 0,
  };
}

function putQueueBackupRecord(record: QueueBackupRecord): Promise<void> {
  return new Promise((resolve, reject) => {
    const openRequest = indexedDB.open(DB_NAME, 1);
    openRequest.onupgradeneeded = () => {
      const db = openRequest.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
    openRequest.onerror = () => reject(openRequest.error ?? new Error('Failed to open queue backup DB'));
    openRequest.onsuccess = () => {
      const db = openRequest.result;
      const transaction = db.transaction([STORE_NAME], 'readwrite');
      transaction.objectStore(STORE_NAME).put(record);
      transaction.oncomplete = () => {
        db.close();
        resolve();
      };
      transaction.onerror = () => {
        db.close();
        reject(transaction.error ?? new Error('Failed to write queue backup record'));
      };
    };
  });
}

describe('QueueBackupService', () => {
  let service: QueueBackupService;

  beforeEach(async () => {
    await deleteQueueBackupDatabase().catch(() => undefined);

    TestBed.configureTestingModule({
      providers: [
        QueueBackupService,
        {
          provide: LoggerService,
          useValue: {
            category: vi.fn(() => ({
              debug: vi.fn(),
              info: vi.fn(),
              warn: vi.fn(),
              error: vi.fn(),
            })),
          },
        },
      ],
    });

    service = TestBed.inject(QueueBackupService);
  });

  afterEach(async () => {
    await deleteQueueBackupDatabase().catch(() => undefined);
    TestBed.resetTestingModule();
  });

  it('restores the current owner queue backup when it exists', async () => {
    const action = makeAction('task-1');
    await service.backupQueue([action], 'user-1');

    await expect(service.restoreQueue('user-1')).resolves.toEqual([action]);
  });

  it('atomically updates an owner queue without dropping concurrent writes', async () => {
    await Promise.all([
      service.updateQueue('user-1', queue => [...queue, makeAction('task-a')]),
      service.updateQueue('user-1', queue => [...queue, makeAction('task-b')]),
    ]);

    const restored = await service.restoreQueue('user-1');

    expect(restored?.map(action => action.id).sort()).toEqual(['task-a', 'task-b']);
  });

  it('reports an existing empty IndexedDB record to queue updaters', async () => {
    const recordFoundFlags: boolean[] = [];

    await service.updateQueue('user-1', (_queue, context) => {
      recordFoundFlags.push(context.recordFound);
      return [];
    });
    await service.updateQueue('user-1', (queue, context) => {
      recordFoundFlags.push(context.recordFound);
      expect(queue).toEqual([]);
      return [makeAction('task-after-empty-record')];
    });

    expect(recordFoundFlags).toEqual([false, true]);
    await expect(service.restoreQueue('user-1')).resolves.toEqual([
      makeAction('task-after-empty-record'),
    ]);
  });

  it('isolates legacy backup actions for review instead of restoring them directly', async () => {
    const action = makeAction('legacy-task');
    await putQueueBackupRecord({
      id: LEGACY_RECORD_ID,
      ownerUserId: '__legacy_unknown__',
      actions: [action],
      savedAt: '2026-06-08T00:00:00.000Z',
    });
    const legacyItems: LegacyQueueReviewItem[] = [];

    const restored = await service.restoreQueue('user-1', items => legacyItems.push(...items));

    expect(restored).toBeNull();
    expect(legacyItems).toEqual([{
      action,
      source: 'legacy-idb-backup',
      capturedAt: '2026-06-08T00:00:00.000Z',
      ownerUserId: '__legacy_unknown__',
    }]);
  });
});
