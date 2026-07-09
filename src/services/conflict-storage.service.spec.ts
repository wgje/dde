import { Injector, runInInjectionContext } from '@angular/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConflictStorageService, toStoredConflictRecord } from './conflict-storage.service';
import { LoggerService } from './logger.service';
import { AuthService } from './auth.service';
import { AUTH_CONFIG } from '../config/auth.config';
import type { Project } from '../models';

function createIdbRequest<T>(resolver: () => T): IDBRequest<T> {
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
}

function createFakeConflictDb(): IDBDatabase {
  const records = new Map<string, Record<string, unknown>>();

  return {
    transaction: () => {
      let completionScheduled = false;
      const transaction: Partial<IDBTransaction> = {};
      const scheduleComplete = () => {
        if (completionScheduled) {
          return;
        }
        completionScheduled = true;
        queueMicrotask(() => transaction.oncomplete?.call(transaction as IDBTransaction, { target: transaction } as Event));
      };
      const store = {
        put: (record: Record<string, unknown>) => createIdbRequest(() => {
          records.set(record.scopedId as string, { ...record });
          scheduleComplete();
          return record.scopedId as string;
        }),
        get: (scopedId: string) => createIdbRequest(() => records.get(scopedId)),
        getAll: () => createIdbRequest(() => Array.from(records.values())),
        delete: (scopedId: string) => createIdbRequest(() => {
          records.delete(scopedId);
          scheduleComplete();
          return undefined;
        }),
        index: (_name: string) => ({
          getAll: (ownerUserId: string) => createIdbRequest(() =>
            Array.from(records.values()).filter(record => record.ownerUserId === ownerUserId)
          ),
        }),
      };

      transaction.objectStore = () => store as unknown as IDBObjectStore;
      return transaction;
    },
  } as unknown as IDBDatabase;
}

function createAbortAfterPutConflictDb(initialRecords: Record<string, unknown>[] = []): IDBDatabase {
  const records = new Map<string, Record<string, unknown>>(
    initialRecords.map(record => [record.scopedId as string, { ...record }]),
  );

  return {
    transaction: () => {
      const transaction: Partial<IDBTransaction> = {};
      const store = {
        get: (scopedId: string) => createIdbRequest(() => records.get(scopedId)),
        put: (record: Record<string, unknown>) => {
          const request: Partial<IDBRequest<string>> = {};
          queueMicrotask(() => {
            (request as { result: string }).result = record.scopedId as string;
            request.onsuccess?.call(request as IDBRequest<string>, { target: request } as Event);
            queueMicrotask(() => {
              transaction.onabort?.call(transaction as IDBTransaction, { target: transaction } as Event);
            });
          });
          return request as IDBRequest<string>;
        },
        index: (_name: string) => ({
          getAll: (_ownerUserId: string) => createIdbRequest(() => []),
        }),
      };

      transaction.objectStore = () => store as unknown as IDBObjectStore;
      return transaction;
    },
  } as unknown as IDBDatabase;
}

describe('ConflictStorageService fallback isolation', () => {
  let service: ConflictStorageService;
  let currentUserId = 'user-a';

  const loggerCategory = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };

  const loggerServiceMock = {
    category: vi.fn(() => loggerCategory),
  };

  const authServiceMock = {
    currentUserId: vi.fn(() => currentUserId),
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    localStorage.clear();
    currentUserId = 'user-a';

    const injector = Injector.create({
      providers: [
        { provide: ConflictStorageService, useClass: ConflictStorageService },
        { provide: LoggerService, useValue: loggerServiceMock },
        { provide: AuthService, useValue: authServiceMock },
      ],
    });

    service = runInInjectionContext(injector, () => injector.get(ConflictStorageService));
    await service.refreshConflictCount();
  });

  afterEach(async () => {
    await service.closeStorageConnections();
  });

  it('clearFallbackStorageForOwner 应只清理指定 owner 的 scoped key', () => {
    localStorage.setItem('nanoflow.conflict.user-a.proj-a', JSON.stringify({ ownerUserId: 'user-a' }));
    localStorage.setItem('nanoflow.conflict.user-b.proj-b', JSON.stringify({ ownerUserId: 'user-b' }));

    service.clearFallbackStorageForOwner('user-a');

    expect(localStorage.getItem('nanoflow.conflict.user-a.proj-a')).toBeNull();
    expect(localStorage.getItem('nanoflow.conflict.user-b.proj-b')).toBe(JSON.stringify({ ownerUserId: 'user-b' }));
  });

  it('IndexedDB 主存应按 owner + project 隔离相同 projectId 的冲突记录', async () => {
    vi.spyOn(service as unknown as { getDb: () => Promise<IDBDatabase> }, 'getDb').mockResolvedValue(createFakeConflictDb());

    currentUserId = 'user-a';
    await service.saveConflict({
      projectId: 'proj-shared',
      localProject: {
        id: 'proj-shared',
        name: 'Owner A',
        description: '',
        createdDate: '2026-03-30T00:00:00.000Z',
        updatedAt: '2026-03-30T00:00:00.000Z',
        version: 1,
        tasks: [],
        connections: [],
      },
      conflictedAt: '2026-03-30T00:00:00.000Z',
      localVersion: 1,
      reason: 'version_mismatch',
      acknowledged: false,
    });

    currentUserId = 'user-b';
    await service.saveConflict({
      projectId: 'proj-shared',
      localProject: {
        id: 'proj-shared',
        name: 'Owner B',
        description: '',
        createdDate: '2026-03-30T00:00:00.000Z',
        updatedAt: '2026-03-30T00:00:00.000Z',
        version: 1,
        tasks: [],
        connections: [],
      },
      conflictedAt: '2026-03-30T00:00:00.000Z',
      localVersion: 1,
      reason: 'version_mismatch',
      acknowledged: false,
    });

    currentUserId = 'user-a';
    const ownerAConflict = await service.getConflict('proj-shared');
    currentUserId = 'user-b';
    const ownerBConflict = await service.getConflict('proj-shared');

    expect(ownerAConflict?.localProject.name).toBe('Owner A');
    expect(ownerBConflict?.localProject.name).toBe('Owner B');

    currentUserId = 'user-a';
    await service.deleteConflict('proj-shared');
    currentUserId = 'user-b';

    expect(await service.getConflict('proj-shared')).toEqual(
      expect.objectContaining({
        ownerUserId: 'user-b',
        localProject: expect.objectContaining({ name: 'Owner B' }),
      })
    );
  });

  it('saveConflict 应合并同项目的 operationConflicts，避免连续冲突覆盖早先证据', async () => {
    vi.spyOn(service as unknown as { getDb: () => Promise<IDBDatabase> }, 'getDb').mockResolvedValue(createFakeConflictDb());

    const baseProject = {
      id: 'proj-operation-conflicts',
      name: 'Local Project',
      description: '',
      createdDate: '2026-06-26T00:00:00.000Z',
      updatedAt: '2026-06-26T00:00:00.000Z',
      version: 3,
      tasks: [{ id: 'task-a', title: 'Local task' } as Project['tasks'][number]],
      connections: [{ id: 'connection-a', source: 'task-a', target: 'task-b' }],
    };

    await service.saveConflict({
      projectId: 'proj-operation-conflicts',
      ownerUserId: 'user-a',
      localProject: baseProject,
      conflictedAt: '2026-06-26T01:00:00.000Z',
      localVersion: 3,
      reason: 'version_mismatch',
      acknowledged: false,
      operationConflicts: [{
        actionId: 'action-task-a',
        actionType: 'task:update',
        entityType: 'task',
        entityId: 'task-a',
        projectId: 'proj-operation-conflicts',
        operationId: 'op-task-a',
        localEntity: { id: 'task-a', title: 'Local task' },
        code: 'TASK_REMOTE_NEWER',
        message: 'Task conflict',
        conflictedAt: '2026-06-26T01:00:00.000Z',
        reason: 'remote-newer',
      }],
    } as Parameters<ConflictStorageService['saveConflict']>[0]);

    await service.saveConflict({
      projectId: 'proj-operation-conflicts',
      ownerUserId: 'user-a',
      localProject: baseProject,
      conflictedAt: '2026-06-26T01:05:00.000Z',
      localVersion: 3,
      reason: 'version_mismatch',
      acknowledged: false,
      operationConflicts: [{
        actionId: 'action-connection-a',
        actionType: 'connection:update',
        entityType: 'connection',
        entityId: 'connection-a',
        projectId: 'proj-operation-conflicts',
        operationId: 'op-connection-a',
        localEntity: { id: 'connection-a', source: 'task-a', target: 'task-b' },
        code: 'CONNECTION_REMOTE_NEWER',
        message: 'Connection conflict',
        conflictedAt: '2026-06-26T01:05:00.000Z',
        reason: 'remote-newer',
      }],
    } as Parameters<ConflictStorageService['saveConflict']>[0]);

    const conflict = await service.getConflict('proj-operation-conflicts') as {
      operationConflicts?: Array<{ operationId?: string }>;
    } | null;

    expect(conflict?.operationConflicts?.map(item => item.operationId)).toEqual([
      'op-task-a',
      'op-connection-a',
    ]);
  });

  it('saveConflict 应合并 IndexedDB 与 fallback 中的 operationConflicts，避免恢复源互相覆盖', async () => {
    const db = createFakeConflictDb();
    vi.spyOn(service as unknown as { getDb: () => Promise<IDBDatabase> }, 'getDb').mockResolvedValue(db);

    const baseProject = {
      id: 'proj-operation-source-merge',
      name: 'Local Project',
      description: '',
      createdDate: '2026-06-26T00:00:00.000Z',
      updatedAt: '2026-06-26T00:00:00.000Z',
      version: 3,
      tasks: [{ id: 'task-a', title: 'Local task' } as Project['tasks'][number]],
      connections: [{ id: 'connection-a', source: 'task-a', target: 'task-b' }],
    };
    const createRecord = (
      operationId: string,
      conflictedAt: string,
    ): Parameters<ConflictStorageService['saveConflict']>[0] => ({
      projectId: 'proj-operation-source-merge',
      ownerUserId: 'user-a',
      localProject: baseProject,
      conflictedAt,
      localVersion: 3,
      reason: 'version_mismatch',
      acknowledged: false,
      operationConflicts: [{
        actionId: `action-${operationId}`,
        actionType: 'task:update',
        entityType: 'task',
        entityId: 'task-a',
        projectId: 'proj-operation-source-merge',
        operationId,
        localEntity: { id: 'task-a', title: `Local ${operationId}` } as Project['tasks'][number],
        code: 'TASK_REMOTE_NEWER',
        message: `Task conflict ${operationId}`,
        conflictedAt,
        reason: 'remote-newer',
      }],
    } as Parameters<ConflictStorageService['saveConflict']>[0]);

    await service.saveConflict(createRecord('op-indexed', '2026-06-26T01:00:00.000Z'));
    await expect(service.getConflict('proj-operation-source-merge')).resolves.toEqual(expect.objectContaining({
      operationConflicts: [expect.objectContaining({ operationId: 'op-indexed' })],
    }));
    localStorage.setItem(
      'nanoflow.conflict.user-a.proj-operation-source-merge',
      JSON.stringify(createRecord('op-fallback', '2026-06-26T01:05:00.000Z')),
    );

    await service.saveConflict(createRecord('op-incoming', '2026-06-26T01:10:00.000Z'));

    const conflict = await service.getConflict('proj-operation-source-merge') as {
      operationConflicts?: Array<{ operationId?: string }>;
    } | null;

    expect(conflict?.operationConflicts?.map(item => item.operationId)).toEqual([
      'op-indexed',
      'op-fallback',
      'op-incoming',
    ]);
  });

  it('saveConflict 应等待 IndexedDB transaction 完成，提交失败时保留 localStorage fallback', async () => {
    vi.spyOn(service as unknown as { getDb: () => Promise<IDBDatabase> }, 'getDb').mockResolvedValue(createAbortAfterPutConflictDb());

    const saved = await service.saveConflict({
      projectId: 'proj-transaction-abort',
      ownerUserId: 'user-a',
      localProject: {
        id: 'proj-transaction-abort',
        name: 'Local survives transaction abort',
        description: '',
        createdDate: '2026-03-30T00:00:00.000Z',
        updatedAt: '2026-03-30T00:00:00.000Z',
        version: 2,
        tasks: [],
        connections: [],
      },
      remoteProject: {
        id: 'proj-transaction-abort',
        name: 'Remote side retained',
        description: '',
        createdDate: '2026-03-30T00:00:00.000Z',
        updatedAt: '2026-03-30T01:00:00.000Z',
        version: 3,
        tasks: [],
        connections: [],
      },
      remoteSnapshotFresh: true,
      conflictedAt: '2026-03-30T02:00:00.000Z',
      localVersion: 2,
      remoteVersion: 3,
      reason: 'version_mismatch',
      acknowledged: false,
    });

    expect(saved).toBe(true);
    expect(localStorage.getItem('nanoflow.conflict.user-a.proj-transaction-abort')).toContain('Local survives transaction abort');
    expect(localStorage.getItem('nanoflow.conflict.user-a.proj-transaction-abort')).toContain('Remote side retained');
  });

  it('saveConflict 主存提交失败时 localStorage fallback 应保留已读到的 IndexedDB 操作证据', async () => {
    const baseProject = {
      id: 'proj-abort-preserve-existing',
      name: 'Abort Preserve Existing',
      description: '',
      createdDate: '2026-06-26T00:00:00.000Z',
      updatedAt: '2026-06-26T00:00:00.000Z',
      version: 3,
      tasks: [{ id: 'task-a', title: 'Local task' } as Project['tasks'][number]],
      connections: [],
    };
    const createRecord = (
      operationId: string,
      conflictedAt: string,
    ): Parameters<ConflictStorageService['saveConflict']>[0] => ({
      projectId: 'proj-abort-preserve-existing',
      ownerUserId: 'user-a',
      localProject: baseProject,
      conflictedAt,
      localVersion: 3,
      reason: 'version_mismatch',
      acknowledged: false,
      operationConflicts: [{
        actionId: `action-${operationId}`,
        actionType: 'task:update',
        entityType: 'task',
        entityId: 'task-a',
        projectId: 'proj-abort-preserve-existing',
        operationId,
        localEntity: { id: 'task-a', title: `Local ${operationId}` } as Project['tasks'][number],
        message: `Task conflict ${operationId}`,
        conflictedAt,
        reason: 'remote-newer',
      }],
    } as Parameters<ConflictStorageService['saveConflict']>[0]);
    const existingRecord = toStoredConflictRecord(
      createRecord('op-existing-abort', '2026-06-26T01:00:00.000Z'),
      'user-a',
    ) as unknown as Record<string, unknown>;
    vi.spyOn(service as unknown as { getDb: () => Promise<IDBDatabase> }, 'getDb')
      .mockResolvedValue(createAbortAfterPutConflictDb([existingRecord]));

    const saved = await service.saveConflict(createRecord('op-incoming-abort', '2026-06-26T01:05:00.000Z'));
    const fallback = JSON.parse(
      localStorage.getItem('nanoflow.conflict.user-a.proj-abort-preserve-existing') ?? '{}',
    ) as { operationConflicts?: Array<{ operationId?: string }> };

    expect(saved).toBe(true);
    expect(fallback.operationConflicts?.map(conflict => conflict.operationId)).toEqual([
      'op-existing-abort',
      'op-incoming-abort',
    ]);
  });

  it('IndexedDB 主存 deleteConflict 显式指定 owner 时应删除目标 bucket', async () => {
    const db = createFakeConflictDb();
    vi.spyOn(service as unknown as { getDb: () => Promise<IDBDatabase> }, 'getDb').mockResolvedValue(db);

    currentUserId = 'user-a';
    await service.saveConflict({
      projectId: 'proj-explicit-idb',
      localProject: {
        id: 'proj-explicit-idb',
        name: 'Owner A',
        description: '',
        createdDate: '2026-03-30T00:00:00.000Z',
        updatedAt: '2026-03-30T00:00:00.000Z',
        version: 1,
        tasks: [],
        connections: [],
      },
      conflictedAt: '2026-03-30T00:00:00.000Z',
      localVersion: 1,
      reason: 'version_mismatch',
      acknowledged: false,
    });
    localStorage.setItem('nanoflow.conflict.user-a.proj-explicit-idb', JSON.stringify({
      projectId: 'proj-explicit-idb',
      ownerUserId: 'user-a',
      localProject: { id: 'proj-explicit-idb', name: 'Owner A', tasks: [], connections: [] },
      conflictedAt: '2026-03-30T00:00:00.000Z',
      localVersion: 1,
      reason: 'version_mismatch',
      acknowledged: false,
    }));

    currentUserId = 'user-b';
    const deleted = await service.deleteConflict('proj-explicit-idb', 'user-a');

    expect(deleted).toBe(true);
    expect(localStorage.getItem('nanoflow.conflict.user-a.proj-explicit-idb')).toBeNull();
    currentUserId = 'user-a';
    expect(await service.getConflict('proj-explicit-idb')).toBeNull();
  });

  it('IDB 可用但仅 fallback 存在时 getConflict 应回退并迁移到主存', async () => {
    const db = createFakeConflictDb();
    vi.spyOn(service as unknown as { getDb: () => Promise<IDBDatabase> }, 'getDb').mockResolvedValue(db);
    localStorage.setItem('nanoflow.conflict.user-a.proj-fallback-only', JSON.stringify({
      projectId: 'proj-fallback-only',
      ownerUserId: 'user-a',
      localProject: { id: 'proj-fallback-only', name: 'Fallback', tasks: [], connections: [] },
      conflictedAt: '2026-03-31T00:00:00.000Z',
      localVersion: 2,
      reason: 'version_mismatch',
      acknowledged: false,
    }));

    const conflict = await service.getConflict('proj-fallback-only');

    expect(conflict).toEqual(expect.objectContaining({
      ownerUserId: 'user-a',
      localProject: expect.objectContaining({ name: 'Fallback' }),
    }));
    expect(localStorage.getItem('nanoflow.conflict.user-a.proj-fallback-only')).toBeNull();
    expect(await service.getConflict('proj-fallback-only')).toEqual(expect.objectContaining({
      ownerUserId: 'user-a',
      localProject: expect.objectContaining({ name: 'Fallback' }),
    }));
  });

  it('IDB 可用时 getAllConflicts 应包含 fallback-only 记录并完成迁移', async () => {
    const db = createFakeConflictDb();
    vi.spyOn(service as unknown as { getDb: () => Promise<IDBDatabase> }, 'getDb').mockResolvedValue(db);
    localStorage.setItem('nanoflow.conflict.user-a.proj-list-fallback', JSON.stringify({
      projectId: 'proj-list-fallback',
      ownerUserId: 'user-a',
      localProject: { id: 'proj-list-fallback', name: 'List Fallback', tasks: [], connections: [] },
      conflictedAt: '2026-03-31T00:00:00.000Z',
      localVersion: 3,
      reason: 'version_mismatch',
      acknowledged: false,
    }));

    const conflicts = await service.getAllConflicts();

    expect(conflicts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        projectId: 'proj-list-fallback',
        ownerUserId: 'user-a',
      }),
    ]));
    expect(localStorage.getItem('nanoflow.conflict.user-a.proj-list-fallback')).toBeNull();
  });

  it('getAllConflicts 应合并 IndexedDB 与 fallback 中同项目的 operationConflicts', async () => {
    const db = createFakeConflictDb();
    vi.spyOn(service as unknown as { getDb: () => Promise<IDBDatabase> }, 'getDb').mockResolvedValue(db);

    const baseProject = {
      id: 'proj-list-source-merge',
      name: 'List Source Merge',
      description: '',
      createdDate: '2026-06-26T00:00:00.000Z',
      updatedAt: '2026-06-26T00:00:00.000Z',
      version: 3,
      tasks: [{ id: 'task-a', title: 'Local task' } as Project['tasks'][number]],
      connections: [],
    };
    const createRecord = (
      operationId: string,
      conflictedAt: string,
    ): Parameters<ConflictStorageService['saveConflict']>[0] => ({
      projectId: 'proj-list-source-merge',
      ownerUserId: 'user-a',
      localProject: baseProject,
      conflictedAt,
      localVersion: 3,
      reason: 'version_mismatch',
      acknowledged: false,
      operationConflicts: [{
        actionId: `action-${operationId}`,
        actionType: 'task:update',
        entityType: 'task',
        entityId: 'task-a',
        projectId: 'proj-list-source-merge',
        operationId,
        localEntity: { id: 'task-a', title: `Local ${operationId}` } as Project['tasks'][number],
        message: `Task conflict ${operationId}`,
        conflictedAt,
        reason: 'remote-newer',
      }],
    } as Parameters<ConflictStorageService['saveConflict']>[0]);

    await service.saveConflict(createRecord('op-indexed-list', '2026-06-26T01:00:00.000Z'));
    localStorage.setItem(
      'nanoflow.conflict.user-a.proj-list-source-merge',
      JSON.stringify(createRecord('op-fallback-list', '2026-06-26T01:05:00.000Z')),
    );

    const conflicts = await service.getAllConflicts();
    const conflict = conflicts.find(item => item.projectId === 'proj-list-source-merge') as {
      operationConflicts?: Array<{ operationId?: string }>;
    } | undefined;

    expect(conflict?.operationConflicts?.map(item => item.operationId)).toEqual([
      'op-indexed-list',
      'op-fallback-list',
    ]);
    expect(localStorage.getItem('nanoflow.conflict.user-a.proj-list-source-merge')).toBeNull();
  });

  it('fallback-only deleteConflict 应只删除当前 owner 的记录', async () => {
    localStorage.setItem('nanoflow.conflict.user-a.proj-shared', JSON.stringify({
      projectId: 'proj-shared',
      ownerUserId: 'user-a',
      localProject: { id: 'proj-shared', name: 'A', tasks: [], connections: [] },
      conflictedAt: '2026-03-30T00:00:00.000Z',
      localVersion: 1,
      reason: 'version_mismatch',
      acknowledged: false,
    }));
    localStorage.setItem('nanoflow.conflict.user-b.proj-shared', JSON.stringify({
      projectId: 'proj-shared',
      ownerUserId: 'user-b',
      localProject: { id: 'proj-shared', name: 'B', tasks: [], connections: [] },
      conflictedAt: '2026-03-30T00:00:00.000Z',
      localVersion: 1,
      reason: 'version_mismatch',
      acknowledged: false,
    }));
    vi.spyOn(service as unknown as { getDb: () => Promise<IDBDatabase> }, 'getDb').mockRejectedValue(new Error('idb unavailable'));

    const deleted = await service.deleteConflict('proj-shared');

    expect(deleted).toBe(true);
    expect(localStorage.getItem('nanoflow.conflict.user-a.proj-shared')).toBeNull();
    expect(localStorage.getItem('nanoflow.conflict.user-b.proj-shared')).not.toBeNull();
  });

  it('fallback-only deleteConflict 显式指定 owner 时应删除对应 bucket', async () => {
    currentUserId = 'user-b';
    localStorage.setItem('nanoflow.conflict.user-a.proj-explicit', JSON.stringify({
      projectId: 'proj-explicit',
      ownerUserId: 'user-a',
      localProject: { id: 'proj-explicit', name: 'A', tasks: [], connections: [] },
      conflictedAt: '2026-03-30T00:00:00.000Z',
      localVersion: 1,
      reason: 'version_mismatch',
      acknowledged: false,
    }));
    vi.spyOn(service as unknown as { getDb: () => Promise<IDBDatabase> }, 'getDb').mockRejectedValue(new Error('idb unavailable'));

    const deleted = await service.deleteConflict('proj-explicit', 'user-a');

    expect(deleted).toBe(true);
    expect(localStorage.getItem('nanoflow.conflict.user-a.proj-explicit')).toBeNull();
  });

  it('实名用户删除自己的 fallback 冲突时不应删除 local-user legacy key', async () => {
    localStorage.setItem('nanoflow.conflict.user-a.proj-shared', JSON.stringify({
      projectId: 'proj-shared',
      ownerUserId: 'user-a',
      localProject: { id: 'proj-shared', name: 'A', tasks: [], connections: [] },
      conflictedAt: '2026-03-30T00:00:00.000Z',
      localVersion: 1,
      reason: 'version_mismatch',
      acknowledged: false,
    }));
    localStorage.setItem('nanoflow.conflict.proj-shared', JSON.stringify({
      projectId: 'proj-shared',
      localProject: { id: 'proj-shared', name: 'Guest', tasks: [], connections: [] },
      conflictedAt: '2026-03-30T00:00:00.000Z',
      localVersion: 1,
      reason: 'version_mismatch',
      acknowledged: false,
    }));
    vi.spyOn(service as unknown as { getDb: () => Promise<IDBDatabase> }, 'getDb').mockRejectedValue(new Error('idb unavailable'));

    const deleted = await service.deleteConflict('proj-shared');

    expect(deleted).toBe(true);
    expect(localStorage.getItem('nanoflow.conflict.user-a.proj-shared')).toBeNull();
    expect(localStorage.getItem('nanoflow.conflict.proj-shared')).not.toBeNull();
  });

  it('IDB 主存删除 local-user 记录时不应误删 unknown-owner legacy key', async () => {
    const db = createFakeConflictDb();
    vi.spyOn(service as unknown as { getDb: () => Promise<IDBDatabase> }, 'getDb').mockResolvedValue(db);
    currentUserId = AUTH_CONFIG.LOCAL_MODE_USER_ID;

    await service.saveConflict({
      projectId: 'proj-local-main',
      ownerUserId: AUTH_CONFIG.LOCAL_MODE_USER_ID,
      localProject: {
        id: 'proj-local-main',
        name: 'Local User',
        description: '',
        createdDate: '2026-03-30T00:00:00.000Z',
        updatedAt: '2026-03-30T00:00:00.000Z',
        version: 1,
        tasks: [],
        connections: [],
      },
      conflictedAt: '2026-03-30T00:00:00.000Z',
      localVersion: 1,
      reason: 'version_mismatch',
      acknowledged: false,
    });
    localStorage.setItem('nanoflow.conflict.proj-local-main', JSON.stringify({
      projectId: 'proj-local-main',
      localProject: { id: 'proj-local-main', name: 'Legacy', tasks: [], connections: [] },
      conflictedAt: '2026-03-30T00:00:00.000Z',
      localVersion: 1,
      reason: 'version_mismatch',
      acknowledged: false,
    }));

    const deleted = await service.deleteConflict('proj-local-main');

    expect(deleted).toBe(true);
    expect(localStorage.getItem('nanoflow.conflict.proj-local-main')).not.toBeNull();
  });

  it('显式删除 unknown-owner 记录时应清理 legacy key', async () => {
    const db = createFakeConflictDb();
    vi.spyOn(service as unknown as { getDb: () => Promise<IDBDatabase> }, 'getDb').mockResolvedValue(db);

    await service.saveConflict({
      projectId: 'proj-unknown-owner',
      ownerUserId: '__legacy_unknown__',
      localProject: {
        id: 'proj-unknown-owner',
        name: 'Unknown Owner',
        description: '',
        createdDate: '2026-03-30T00:00:00.000Z',
        updatedAt: '2026-03-30T00:00:00.000Z',
        version: 1,
        tasks: [],
        connections: [],
      },
      conflictedAt: '2026-03-30T00:00:00.000Z',
      localVersion: 1,
      reason: 'version_mismatch',
      acknowledged: false,
    });
    localStorage.setItem('nanoflow.conflict.proj-unknown-owner', JSON.stringify({
      projectId: 'proj-unknown-owner',
      localProject: { id: 'proj-unknown-owner', name: 'Unknown Owner', tasks: [], connections: [] },
      conflictedAt: '2026-03-30T00:00:00.000Z',
      localVersion: 1,
      reason: 'version_mismatch',
      acknowledged: false,
    }));

    const deleted = await service.deleteConflict('proj-unknown-owner', '__legacy_unknown__');

    expect(deleted).toBe(true);
    expect(localStorage.getItem('nanoflow.conflict.proj-unknown-owner')).toBeNull();
  });

  it('local-user 会话不应读取 owner 缺失的 legacy fallback 冲突', async () => {
    currentUserId = AUTH_CONFIG.LOCAL_MODE_USER_ID;
    localStorage.setItem('nanoflow.conflict.proj-legacy', JSON.stringify({
      projectId: 'proj-legacy',
      localProject: { id: 'proj-legacy', name: 'Leaked', tasks: [], connections: [] },
      conflictedAt: '2026-03-30T00:00:00.000Z',
      localVersion: 1,
      reason: 'version_mismatch',
      acknowledged: false,
    }));
    vi.spyOn(service as unknown as { getDb: () => Promise<IDBDatabase> }, 'getDb').mockRejectedValue(new Error('idb unavailable'));

    const conflict = await service.getConflict('proj-legacy');

    expect(conflict).toBeNull();
  });

  it('legacy migration 缺少 owner 时应隔离到 unknown-owner 桶', () => {
    currentUserId = 'user-b';

    const ownerUserId = (service as unknown as {
      resolveLegacyConflictOwnerUserId: (record: Record<string, unknown>) => string;
    }).resolveLegacyConflictOwnerUserId({
      projectId: 'proj-legacy',
      localProject: { id: 'proj-legacy', tasks: [], connections: [] },
      conflictedAt: '2026-03-30T00:00:00.000Z',
      localVersion: 1,
      reason: 'version_mismatch',
    });

    expect(ownerUserId).toBe('__legacy_unknown__');
  });
});

describe('toStoredConflictRecord', () => {
  it('isolates ownerless legacy records into the unknown-owner scoped bucket', () => {
    const record = toStoredConflictRecord({
      projectId: 'proj-legacy',
      localProject: { id: 'proj-legacy', name: 'Legacy', tasks: [], connections: [] } as never,
      conflictedAt: '2026-03-30T00:00:00.000Z',
      localVersion: 1,
      reason: 'version_mismatch',
    });

    expect(record.ownerUserId).toBe('__legacy_unknown__');
    expect(record.scopedId).toBe('__legacy_unknown__::proj-legacy');
  });
});
