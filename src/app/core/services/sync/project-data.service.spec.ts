import { Injector } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';
import { ProjectDataService } from './project-data.service';
import { SupabaseClientService } from '../../../../services/supabase-client.service';
import { LoggerService } from '../../../../services/logger.service';
import { RequestThrottleService } from '../../../../services/request-throttle.service';
import { SyncStateService } from './sync-state.service';
import { TombstoneService } from './tombstone.service';
import { SentryLazyLoaderService } from '../../../../services/sentry-lazy-loader.service';

const OFFLINE_SNAPSHOT_DB_NAME = 'nanoflow-offline-snapshots';
const OFFLINE_SNAPSHOT_STORE_NAME = 'snapshots';
const OFFLINE_SNAPSHOT_RECORD_ID = 'offline-snapshot';
const OFFLINE_SNAPSHOT_LOCAL_STORAGE_KEY = 'nanoflow.offline-cache-v2';

async function writeOfflineSnapshotToIdb(payload: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.open(OFFLINE_SNAPSHOT_DB_NAME, 1);

    request.onerror = () => reject(request.error);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(OFFLINE_SNAPSHOT_STORE_NAME)) {
        db.createObjectStore(OFFLINE_SNAPSHOT_STORE_NAME, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction(OFFLINE_SNAPSHOT_STORE_NAME, 'readwrite');
      tx.objectStore(OFFLINE_SNAPSHOT_STORE_NAME).put({
        id: OFFLINE_SNAPSHOT_RECORD_ID,
        data: payload,
      });
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error);
      };
    };
  });
}

async function readOfflineSnapshotFromIdb(): Promise<string | null> {
  return await new Promise<string | null>((resolve) => {
    try {
      const request = indexedDB.open(OFFLINE_SNAPSHOT_DB_NAME, 1);

      request.onerror = () => resolve(null);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(OFFLINE_SNAPSHOT_STORE_NAME)) {
          db.createObjectStore(OFFLINE_SNAPSHOT_STORE_NAME, { keyPath: 'id' });
        }
      };
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction(OFFLINE_SNAPSHOT_STORE_NAME, 'readonly');
        const req = tx.objectStore(OFFLINE_SNAPSHOT_STORE_NAME).get(OFFLINE_SNAPSHOT_RECORD_ID);
        req.onsuccess = () => {
          db.close();
          resolve(req.result?.data ?? null);
        };
        req.onerror = () => {
          db.close();
          resolve(null);
        };
        tx.onerror = () => {
          db.close();
          resolve(null);
        };
      };
    } catch {
      resolve(null);
    }
  });
}

async function clearOfflineSnapshotIdb(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.open(OFFLINE_SNAPSHOT_DB_NAME, 1);

    request.onerror = () => reject(request.error);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(OFFLINE_SNAPSHOT_STORE_NAME)) {
        db.createObjectStore(OFFLINE_SNAPSHOT_STORE_NAME, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction(OFFLINE_SNAPSHOT_STORE_NAME, 'readwrite');
      tx.objectStore(OFFLINE_SNAPSHOT_STORE_NAME).delete(OFFLINE_SNAPSHOT_RECORD_ID);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error);
      };
    };
  });
}

describe('ProjectDataService', () => {
  it('P0001 Access Denied 时不应 fallback 到 loadFullProject', async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: null,
      error: {
        code: 'P0001',
        message: 'Access denied',
      },
    });

    const injector = Injector.create({
      providers: [
        { provide: ProjectDataService, useClass: ProjectDataService },
        {
          provide: SupabaseClientService,
          useValue: {
            isConfigured: true,
            clientAsync: vi.fn(async () => ({ rpc })),
          },
        },
        {
          provide: LoggerService,
          useValue: {
            category: () => ({
              debug: vi.fn(),
              info: vi.fn(),
              warn: vi.fn(),
              error: vi.fn(),
            }),
          },
        },
        {
          provide: RequestThrottleService,
          useValue: {
            execute: vi.fn(),
          },
        },
        {
          provide: SyncStateService,
          useValue: {
            setSyncError: vi.fn(),
          },
        },
        {
          provide: TombstoneService,
          useValue: {
            getTombstonesWithCache: vi.fn().mockResolvedValue({ data: [], error: null }),
            getLocalTombstones: vi.fn().mockReturnValue(new Set()),
          },
        },
        {
          provide: SentryLazyLoaderService,
          useValue: {
            addBreadcrumb: vi.fn(),
            captureException: vi.fn(),
            captureMessage: vi.fn(),
          },
        },
      ],
    });

    const service = injector.get(ProjectDataService);
    const fallbackSpy = vi.spyOn(
      service as unknown as { loadFullProject: (projectId: string) => Promise<unknown> },
      'loadFullProject'
    ).mockResolvedValue(null);

    const result = await service.loadFullProjectOptimized('proj-denied');

    expect(result).toBeNull();
    expect(fallbackSpy).not.toHaveBeenCalled();
  });

  it('getProjectSyncWatermark 应返回远端聚合水位', async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: '2026-02-14T08:10:00.000Z',
      error: null,
    });

    const injector = Injector.create({
      providers: [
        { provide: ProjectDataService, useClass: ProjectDataService },
        {
          provide: SupabaseClientService,
          useValue: {
            isConfigured: true,
            clientAsync: vi.fn(async () => ({ rpc })),
          },
        },
        {
          provide: LoggerService,
          useValue: {
            category: () => ({
              debug: vi.fn(),
              info: vi.fn(),
              warn: vi.fn(),
              error: vi.fn(),
            }),
          },
        },
        {
          provide: RequestThrottleService,
          useValue: {
            execute: vi.fn(),
          },
        },
        {
          provide: SyncStateService,
          useValue: {
            setSyncError: vi.fn(),
          },
        },
        {
          provide: TombstoneService,
          useValue: {
            getTombstonesWithCache: vi.fn().mockResolvedValue({ data: [], error: null }),
            getLocalTombstones: vi.fn().mockReturnValue(new Set()),
          },
        },
        {
          provide: SentryLazyLoaderService,
          useValue: {
            addBreadcrumb: vi.fn(),
            captureException: vi.fn(),
            captureMessage: vi.fn(),
          },
        },
      ],
    });

    const service = injector.get(ProjectDataService);
    const watermark = await service.getProjectSyncWatermark('proj-1');

    expect(rpc).toHaveBeenCalledWith('get_project_sync_watermark', { p_project_id: 'proj-1' });
    expect(watermark).toBe('2026-02-14T08:10:00.000Z');
  });

  it('Supabase 未配置且处于离线模式时应仅记录一次 info 且不设置同步错误', async () => {
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const syncState = {
      setSyncError: vi.fn(),
    };

    const injector = Injector.create({
      providers: [
        { provide: ProjectDataService, useClass: ProjectDataService },
        {
          provide: SupabaseClientService,
          useValue: {
            isConfigured: false,
            isOfflineMode: () => true,
            clientAsync: vi.fn(),
          },
        },
        {
          provide: LoggerService,
          useValue: {
            category: () => logger,
          },
        },
        {
          provide: RequestThrottleService,
          useValue: {
            execute: vi.fn(),
          },
        },
        {
          provide: SyncStateService,
          useValue: syncState,
        },
        {
          provide: TombstoneService,
          useValue: {
            getTombstonesWithCache: vi.fn().mockResolvedValue({ data: [], error: null }),
            getLocalTombstones: vi.fn().mockReturnValue(new Set()),
          },
        },
        {
          provide: SentryLazyLoaderService,
          useValue: {
            addBreadcrumb: vi.fn(),
            captureException: vi.fn(),
            captureMessage: vi.fn(),
          },
        },
      ],
    });

    const service = injector.get(ProjectDataService);
    const getSupabaseClient = (service as unknown as { getSupabaseClient: () => Promise<unknown> }).getSupabaseClient.bind(service);

    await getSupabaseClient();
    await getSupabaseClient();

    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(syncState.setSyncError).not.toHaveBeenCalled();
  });

  it('RPC 函数不存在时应回退并熔断后续 RPC 调用', async () => {
    const rpc = vi
      .fn()
      .mockResolvedValueOnce({
        data: null,
        error: {
          code: '42883',
          message: 'function public.get_full_project_data(uuid) does not exist',
        },
      })
      .mockResolvedValue({
        data: {
          id: 'proj-1',
          owner_id: 'user-1',
          title: 'Project 1',
          created_at: '2026-03-22T00:00:00.000Z',
          updated_at: '2026-03-22T00:00:00.000Z',
        },
        error: null,
      });

    const maybeSingle = vi.fn().mockResolvedValue({
      data: {
        id: 'proj-1',
        owner_id: 'user-1',
        title: 'Project 1',
        created_at: '2026-03-22T00:00:00.000Z',
        updated_at: '2026-03-22T00:00:00.000Z',
      },
      error: null,
    });
    const select = vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({ maybeSingle }),
    });

    const from = vi.fn((table: string) => {
      if (table === 'projects') {
        return { select };
      }
      return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockResolvedValue({ data: [], error: null }),
        }),
      };
    });

    const injector = Injector.create({
      providers: [
        { provide: ProjectDataService, useClass: ProjectDataService },
        {
          provide: SupabaseClientService,
          useValue: {
            isConfigured: true,
            clientAsync: vi.fn(async () => ({ rpc, from })),
          },
        },
        {
          provide: LoggerService,
          useValue: {
            category: () => ({
              debug: vi.fn(),
              info: vi.fn(),
              warn: vi.fn(),
              error: vi.fn(),
            }),
          },
        },
        {
          provide: RequestThrottleService,
          useValue: {
            execute: vi.fn(async (_key: string, work: () => Promise<unknown>) => work()),
          },
        },
        {
          provide: SyncStateService,
          useValue: {
            setSyncError: vi.fn(),
          },
        },
        {
          provide: TombstoneService,
          useValue: {
            getTombstonesWithCache: vi.fn().mockResolvedValue({ data: [], error: null }),
            getLocalTombstones: vi.fn().mockReturnValue(new Set()),
          },
        },
        {
          provide: SentryLazyLoaderService,
          useValue: {
            addBreadcrumb: vi.fn(),
            captureException: vi.fn(),
            captureMessage: vi.fn(),
          },
        },
      ],
    });

    const service = injector.get(ProjectDataService);

    const first = await service.loadFullProjectOptimized('proj-1');
    const second = await service.loadFullProjectOptimized('proj-1');

    expect(first?.id).toBe('proj-1');
    expect(second?.id).toBe('proj-1');
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(from).toHaveBeenCalledWith('projects');
  });

  it('PGRST202 schema cache miss 时应识别为 RPC 缺失并回退', async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: null,
      error: {
        code: 'PGRST202',
        message: 'Could not find the function public.get_full_project_data(p_project_id) in the schema cache',
      },
    });

    const from = vi.fn((table: string) => ({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue(
          table === 'projects'
            ? { maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }) }
            : Promise.resolve({ data: [], error: null })
        ),
      }),
    }));

    const injector = Injector.create({
      providers: [
        { provide: ProjectDataService, useClass: ProjectDataService },
        {
          provide: SupabaseClientService,
          useValue: {
            isConfigured: true,
            clientAsync: vi.fn(async () => ({ rpc, from })),
          },
        },
        {
          provide: LoggerService,
          useValue: {
            category: () => ({
              debug: vi.fn(),
              info: vi.fn(),
              warn: vi.fn(),
              error: vi.fn(),
            }),
          },
        },
        {
          provide: RequestThrottleService,
          useValue: {
            execute: vi.fn(async (_key: string, work: () => Promise<unknown>) => work()),
          },
        },
        {
          provide: SyncStateService,
          useValue: {
            setSyncError: vi.fn(),
          },
        },
        {
          provide: TombstoneService,
          useValue: {
            getTombstonesWithCache: vi.fn().mockResolvedValue({ data: [], error: null }),
            getLocalTombstones: vi.fn().mockReturnValue(new Set()),
          },
        },
        {
          provide: SentryLazyLoaderService,
          useValue: {
            addBreadcrumb: vi.fn(),
            captureException: vi.fn(),
            captureMessage: vi.fn(),
          },
        },
      ],
    });

    const service = injector.get(ProjectDataService);
    const result = await service.loadFullProjectOptimized('proj-missing-rpc');

    expect(result).toBeNull();
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('startup snapshot 应优先读取 IndexedDB 并返回元数据', async () => {
    localStorage.removeItem(OFFLINE_SNAPSHOT_LOCAL_STORAGE_KEY);
    await clearOfflineSnapshotIdb();

    const idbPayload = JSON.stringify({
      projects: [
        {
          id: 'idb-project',
          name: 'IDB Project',
          description: 'from idb',
          createdDate: '2026-03-26T00:00:00.000Z',
          tasks: [],
          connections: [],
        },
      ],
      version: 7,
    });
    const localStoragePayload = JSON.stringify({
      projects: [
        {
          id: 'legacy-project',
          name: 'Legacy Project',
          description: 'from localStorage',
          createdDate: '2026-03-25T00:00:00.000Z',
          tasks: [],
          connections: [],
        },
      ],
      version: 6,
    });

    localStorage.setItem(OFFLINE_SNAPSHOT_LOCAL_STORAGE_KEY, localStoragePayload);
    await writeOfflineSnapshotToIdb(idbPayload);

    const injector = Injector.create({
      providers: [
        { provide: ProjectDataService, useClass: ProjectDataService },
        {
          provide: SupabaseClientService,
          useValue: {
            isConfigured: false,
            clientAsync: vi.fn(),
          },
        },
        {
          provide: LoggerService,
          useValue: {
            category: () => ({
              debug: vi.fn(),
              info: vi.fn(),
              warn: vi.fn(),
              error: vi.fn(),
            }),
          },
        },
        {
          provide: RequestThrottleService,
          useValue: {
            execute: vi.fn(),
          },
        },
        {
          provide: SyncStateService,
          useValue: {
            setSyncError: vi.fn(),
          },
        },
        {
          provide: TombstoneService,
          useValue: {
            getTombstonesWithCache: vi.fn().mockResolvedValue({ data: [], error: null }),
            getLocalTombstones: vi.fn().mockReturnValue(new Set()),
          },
        },
        {
          provide: SentryLazyLoaderService,
          useValue: {
            addBreadcrumb: vi.fn(),
            captureException: vi.fn(),
            captureMessage: vi.fn(),
          },
        },
      ],
    });

    const service = injector.get(ProjectDataService) as unknown as {
      loadStartupOfflineSnapshot: () => Promise<{
        source: 'idb' | 'localStorage' | 'none';
        projectCount: number;
        bytes: number;
        migratedLegacy: boolean;
        projects: unknown[];
      }>;
    };

    const snapshot = await service.loadStartupOfflineSnapshot();

    expect(snapshot.source).toBe('idb');
    expect(snapshot.projectCount).toBe(1);
    expect(snapshot.migratedLegacy).toBe(false);
    expect(snapshot.bytes).toBeGreaterThan(0);
    expect(snapshot.projects).toHaveLength(1);
    expect((snapshot.projects[0] as { id?: string }).id).toBe('idb-project');
  }, 10000);

  it('startup snapshot 仅有 legacy localStorage 时应回迁到 IndexedDB', async () => {
    localStorage.removeItem(OFFLINE_SNAPSHOT_LOCAL_STORAGE_KEY);
    await clearOfflineSnapshotIdb();

    const legacyPayload = JSON.stringify({
      projects: [
        {
          id: 'legacy-project',
          name: 'Legacy Project',
          description: 'from localStorage',
          createdDate: '2026-03-25T00:00:00.000Z',
          tasks: [],
          connections: [],
        },
      ],
      version: 6,
    });

    localStorage.setItem(OFFLINE_SNAPSHOT_LOCAL_STORAGE_KEY, legacyPayload);

    const injector = Injector.create({
      providers: [
        { provide: ProjectDataService, useClass: ProjectDataService },
        {
          provide: SupabaseClientService,
          useValue: {
            isConfigured: false,
            clientAsync: vi.fn(),
          },
        },
        {
          provide: LoggerService,
          useValue: {
            category: () => ({
              debug: vi.fn(),
              info: vi.fn(),
              warn: vi.fn(),
              error: vi.fn(),
            }),
          },
        },
        {
          provide: RequestThrottleService,
          useValue: {
            execute: vi.fn(),
          },
        },
        {
          provide: SyncStateService,
          useValue: {
            setSyncError: vi.fn(),
          },
        },
        {
          provide: TombstoneService,
          useValue: {
            getTombstonesWithCache: vi.fn().mockResolvedValue({ data: [], error: null }),
            getLocalTombstones: vi.fn().mockReturnValue(new Set()),
          },
        },
        {
          provide: SentryLazyLoaderService,
          useValue: {
            addBreadcrumb: vi.fn(),
            captureException: vi.fn(),
            captureMessage: vi.fn(),
          },
        },
      ],
    });

    const service = injector.get(ProjectDataService) as unknown as {
      loadStartupOfflineSnapshot: () => Promise<{
        source: 'idb' | 'localStorage' | 'none';
        projectCount: number;
        bytes: number;
        migratedLegacy: boolean;
        projects: unknown[];
      }>;
    };

    const snapshot = await service.loadStartupOfflineSnapshot();
    const migratedPayload = await readOfflineSnapshotFromIdb();

    expect(snapshot.source).toBe('localStorage');
    expect(snapshot.projectCount).toBe(1);
    expect(snapshot.migratedLegacy).toBe(true);
    expect(snapshot.bytes).toBeGreaterThan(0);
    expect(snapshot.projects).toHaveLength(1);
    expect((snapshot.projects[0] as { id?: string }).id).toBe('legacy-project');
    expect(migratedPayload).toBe(legacyPayload);
  }, 10000);

  it('rowToTask 遇到缺失 content 字段时应告警并上报采样监控', () => {
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const sentry = {
      addBreadcrumb: vi.fn(),
      captureException: vi.fn(),
      captureMessage: vi.fn(),
    };

    const injector = Injector.create({
      providers: [
        { provide: ProjectDataService, useClass: ProjectDataService },
        {
          provide: SupabaseClientService,
          useValue: {
            isConfigured: false,
            clientAsync: vi.fn(),
          },
        },
        {
          provide: LoggerService,
          useValue: {
            category: () => logger,
          },
        },
        {
          provide: RequestThrottleService,
          useValue: {
            execute: vi.fn(),
          },
        },
        {
          provide: SyncStateService,
          useValue: {
            setSyncError: vi.fn(),
          },
        },
        {
          provide: TombstoneService,
          useValue: {
            getTombstonesWithCache: vi.fn().mockResolvedValue({ data: [], error: null }),
            getLocalTombstones: vi.fn().mockReturnValue(new Set()),
          },
        },
        {
          provide: SentryLazyLoaderService,
          useValue: sentry,
        },
      ],
    });

    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.01);
    const service = injector.get(ProjectDataService);

    const task = service.rowToTask({
      id: 'task-missing-content',
      title: '缺少正文',
      stage: 1,
      updated_at: '2026-03-29T00:00:00.000Z',
    } as never);

    expect(task.content).toBe('');
    expect(logger.warn).toHaveBeenCalledWith(
      'rowToTask: content 字段缺失，可能导致数据丢失！',
      expect.objectContaining({
        taskId: 'task-missing-content',
        hasTitle: true,
        hasStage: true,
      })
    );
    expect(sentry.captureMessage).toHaveBeenCalledWith(
      'Sync Warning: Task content field missing',
      expect.objectContaining({
        level: 'warning',
        tags: expect.objectContaining({
          operation: 'rowToTask',
          taskId: 'task-missing-content',
        }),
      })
    );

    randomSpy.mockRestore();
  });
});
