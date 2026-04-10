import { Injector, runInInjectionContext } from '@angular/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConflictStorageService } from './conflict-storage.service';
import { LoggerService } from './logger.service';
import { AuthService } from './auth.service';
import { AUTH_CONFIG } from '../config/auth.config';

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
  const store = {
    put: (record: Record<string, unknown>) => createIdbRequest(() => {
      records.set(record.scopedId as string, { ...record });
      return record.scopedId as string;
    }),
    get: (scopedId: string) => createIdbRequest(() => records.get(scopedId)),
    getAll: () => createIdbRequest(() => Array.from(records.values())),
    delete: (scopedId: string) => createIdbRequest(() => {
      records.delete(scopedId);
      return undefined;
    }),
    index: (_name: string) => ({
      getAll: (ownerUserId: string) => createIdbRequest(() =>
        Array.from(records.values()).filter(record => record.ownerUserId === ownerUserId)
      ),
    }),
  };

  return {
    transaction: () => ({
      objectStore: () => store,
    }),
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

  beforeEach(() => {
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