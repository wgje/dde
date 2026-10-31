import { Injector, runInInjectionContext } from '@angular/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  getConflictFallbackKey,
  toStoredConflictRecord,
  type ConflictRecord,
  type StoredConflictRecord,
} from './conflict-storage.helpers';
import { ConflictStorageService } from './conflict-storage.service';
import { LoggerService } from './logger.service';
import { AuthService } from './auth.service';
import {
  projectConflictRestoreSnapshot,
  type DataSafetyConflictRestoreSnapshot,
} from './data-safety-conflict-restore.helpers';

const OWNER_USER_ID = 'restore-owner';

function createConflict(
  projectId: string,
  name: string,
  conflictedAt: string,
  localVersion: number,
  operationId?: string,
): ConflictRecord {
  return {
    projectId,
    ownerUserId: OWNER_USER_ID,
    localProject: {
      id: projectId,
      name,
      description: '',
      createdDate: '2026-06-26T00:00:00.000Z',
      updatedAt: '2026-06-26T00:00:00.000Z',
      version: localVersion,
      tasks: [],
      connections: [],
    },
    conflictedAt,
    localVersion,
    reason: 'version_mismatch',
    operationConflicts: operationId ? [{
      actionType: 'task:update',
      entityType: 'task',
      entityId: `${projectId}-task`,
      projectId,
      operationId,
      localEntity: { id: `${projectId}-task`, title: name } as never,
      message: `Conflict ${operationId}`,
      conflictedAt,
      reason: 'remote-newer',
    }] : undefined,
  };
}

function createConflictDb(initialRecords: StoredConflictRecord[] = []): {
  database: IDBDatabase;
  readOwnerRecords(ownerUserId: string): StoredConflictRecord[];
} {
  const records = new Map(initialRecords.map(record => [record.scopedId, { ...record }]));

  const createRequest = <T>(resolver: () => T): IDBRequest<T> => {
    const request: Partial<IDBRequest<T>> = {};
    queueMicrotask(() => {
      try {
        (request as { result: T }).result = resolver();
        request.onsuccess?.call(request as IDBRequest<T>, { target: request } as Event);
      } catch (error) {
        (request as { error: DOMException }).error = error as DOMException;
        request.onerror?.call(request as IDBRequest<T>, { target: request } as Event);
      }
    });
    return request as IDBRequest<T>;
  };

  const database = {
    transaction: () => {
      const transaction: Partial<IDBTransaction> = {};
      let completionScheduled = false;
      const scheduleComplete = () => {
        if (completionScheduled) return;
        completionScheduled = true;
        queueMicrotask(() => transaction.oncomplete?.call(
          transaction as IDBTransaction,
          { target: transaction } as Event,
        ));
      };
      const store = {
        get: (scopedId: string) => createRequest(() => records.get(scopedId) ?? null),
        put: (record: StoredConflictRecord) => createRequest(() => {
          records.set(record.scopedId, { ...record });
          scheduleComplete();
          return record.scopedId;
        }),
        delete: (scopedId: string) => createRequest(() => {
          records.delete(scopedId);
          scheduleComplete();
          return undefined;
        }),
        index: () => ({
          getAll: (ownerUserId: string) => createRequest(() => (
            Array.from(records.values())
              .filter(record => record.ownerUserId === ownerUserId)
              .sort((left, right) => left.scopedId.localeCompare(right.scopedId))
          )),
        }),
      };
      transaction.objectStore = () => store as unknown as IDBObjectStore;
      return transaction as IDBTransaction;
    },
    close: vi.fn(),
  } as unknown as IDBDatabase;

  return {
    database,
    readOwnerRecords: ownerUserId => Array.from(records.values())
      .filter(record => record.ownerUserId === ownerUserId)
      .sort((left, right) => left.scopedId.localeCompare(right.scopedId)),
  };
}

function createConflictStorageService(): ConflictStorageService {
  const injector = Injector.create({
    providers: [
      { provide: ConflictStorageService, useClass: ConflictStorageService },
      {
        provide: LoggerService,
        useValue: {
          category: () => ({
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
            debug: vi.fn(),
          }),
        },
      },
      { provide: AuthService, useValue: { currentUserId: () => OWNER_USER_ID } },
    ],
  });
  return runInInjectionContext(injector, () => injector.get(ConflictStorageService));
}

describe('projectConflictRestoreSnapshot', () => {
  let service: ConflictStorageService | null = null;

  afterEach(async () => {
    if (service) await service.closeStorageConnections();
    service = null;
    localStorage.clear();
  });

  it('projects existing, merged, and new conflicts to the same IndexedDB state as saveConflict', async () => {
    const indexedRecord = toStoredConflictRecord(
      createConflict('project-a', 'Indexed version', '2026-06-26T01:00:00.000Z', 2, 'op-indexed'),
      OWNER_USER_ID,
    );
    const fallbackRecord = createConflict(
      'project-a',
      'Fallback version',
      '2026-06-26T01:05:00.000Z',
      3,
      'op-fallback',
    );
    const incoming = [
      createConflict('project-a', 'Backup version', '2026-06-26T01:10:00.000Z', 4, 'op-backup'),
      createConflict('project-b', 'Backup new project', '2026-06-26T01:15:00.000Z', 1, 'op-new'),
    ];
    const fallbackKey = getConflictFallbackKey('project-a', OWNER_USER_ID);
    const fallbackRaw = JSON.stringify(fallbackRecord);
    const preImage: DataSafetyConflictRestoreSnapshot = {
      indexedDbRecords: [indexedRecord],
      fallbackLocalStorageEntries: { [fallbackKey]: fallbackRaw },
    };
    const target = projectConflictRestoreSnapshot(preImage, incoming, OWNER_USER_ID);
    const db = createConflictDb([indexedRecord]);
    service = createConflictStorageService();
    vi.spyOn(service, 'refreshConflictCount').mockResolvedValue(undefined);
    vi.spyOn(service as unknown as { getDb: () => Promise<IDBDatabase> }, 'getDb')
      .mockResolvedValue(db.database);
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    localStorage.setItem(fallbackKey, fallbackRaw);

    for (const conflict of incoming) {
      await expect(service.saveConflict(conflict, { restoreWriterContinuation: true })).resolves.toBe(true);
    }

    expect({
      indexedDbRecords: db.readOwnerRecords(OWNER_USER_ID),
      fallbackLocalStorageEntries: { [fallbackKey]: localStorage.getItem(fallbackKey)! },
    }).toEqual(target);
    expect(target.indexedDbRecords?.find(record => record.projectId === 'project-a')?.operationConflicts)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ operationId: 'op-indexed' }),
        expect.objectContaining({ operationId: 'op-fallback' }),
        expect.objectContaining({ operationId: 'op-backup' }),
      ]));
  });

  it('projects fallback-only merges to the same localStorage value as saveConflict', async () => {
    const existing = createConflict(
      'project-a',
      'Existing local fallback',
      '2026-06-26T01:00:00.000Z',
      2,
      'op-existing',
    );
    const incoming = createConflict(
      'project-a',
      'Backup conflict',
      '2026-06-26T01:05:00.000Z',
      3,
      'op-backup',
    );
    const fallbackKey = getConflictFallbackKey('project-a', OWNER_USER_ID);
    const fallbackRaw = JSON.stringify(existing);
    const preImage: DataSafetyConflictRestoreSnapshot = {
      indexedDbRecords: null,
      fallbackLocalStorageEntries: { [fallbackKey]: fallbackRaw },
    };
    const target = projectConflictRestoreSnapshot(preImage, [incoming], OWNER_USER_ID);
    service = createConflictStorageService();
    vi.spyOn(service, 'refreshConflictCount').mockResolvedValue(undefined);
    vi.spyOn(service as unknown as { getDb: () => Promise<IDBDatabase> }, 'getDb')
      .mockRejectedValue(new Error('IndexedDB unavailable'));
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    localStorage.setItem(fallbackKey, fallbackRaw);

    await expect(
      service.saveConflict(incoming, { restoreWriterContinuation: true }),
    ).resolves.toBe(true);

    expect({
      indexedDbRecords: null,
      fallbackLocalStorageEntries: { [fallbackKey]: localStorage.getItem(fallbackKey)! },
    }).toEqual(target);
    expect(JSON.parse(localStorage.getItem(fallbackKey) ?? 'null')).toEqual(
      expect.objectContaining({
        localProject: expect.objectContaining({ name: 'Backup conflict' }),
        operationConflicts: expect.arrayContaining([
          expect.objectContaining({ operationId: 'op-existing' }),
          expect.objectContaining({ operationId: 'op-backup' }),
        ]),
      }),
    );
  });
});
