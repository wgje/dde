import { Injector, runInInjectionContext } from '@angular/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FEATURE_FLAGS } from '../../../../config/feature-flags.config';
import type { Connection, Task } from '../../../../models';
import type { ConnectionRow, TaskRow } from '../../../../models/supabase-types';
import { ClockSyncService } from '../../../../services/clock-sync.service';
import { LoggerService } from '../../../../services/logger.service';
import { SentryLazyLoaderService } from '../../../../services/sentry-lazy-loader.service';
import { SyncCursorPersistenceService } from '../../state/persistence';
import type { ProjectSyncCursor } from '../../state/persistence';
import { ProjectDataService } from './project-data.service';
import { ProjectSyncCursorService } from './project-sync-cursor.service';
import { SessionManagerService } from './session-manager.service';
import { resetBrowserNetworkSuspensionTrackingForTests } from '../../../../utils/browser-network-suspension';

type MutableFeatureFlags = {
  INCREMENTAL_SYNC_ENABLED: boolean;
};

const featureFlags = FEATURE_FLAGS as unknown as MutableFeatureFlags;
const originalIncrementalSync = featureFlags.INCREMENTAL_SYNC_ENABLED;

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('ProjectSyncCursorService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetBrowserNetworkSuspensionTrackingForTests();
    featureFlags.INCREMENTAL_SYNC_ENABLED = true;
  });

  afterEach(() => {
    resetBrowserNetworkSuspensionTrackingForTests();
    featureFlags.INCREMENTAL_SYNC_ENABLED = originalIncrementalSync;
  });

  it('loads task and connection deltas across Supabase keyset pages', async () => {
    // 增量拉取必须走 (updated_at, id) keyset 翻页：offset 分页在翻页期间
    // 有并发写入时会因行左移静默跳行，被跳过的行随后被游标封口成永久缺口
    const taskRows = Array.from({ length: 1001 }, (_, index) => taskRow(index));
    const connectionRows = Array.from({ length: 1001 }, (_, index) => connectionRow(index));
    const keysetFilters: Record<string, Array<string | null>> = {
      tasks: [],
      connections: [],
    };
    const client = createKeysetPagedClient({ taskRows, connectionRows, keysetFilters });
    const { service } = createService();
    service.getSupabaseClientHandler = vi.fn(async () => client as never);
    service.setLastSyncTime('project-1', '2026-06-09T00:00:00.000Z');

    const drift = await service.checkForDrift('project-1');

    expect(drift.tasks).toHaveLength(1001);
    expect(drift.connections).toHaveLength(1001);
    expect(drift.tasks[0].id).toBe(entityUuid('a', 0));
    expect(drift.tasks[1000].id).toBe(entityUuid('a', 1000));
    expect(drift.connections[1000].id).toBe(entityUuid('b', 1000));
    // 第一页无 keyset（用 effectiveSince 下界），第二页以第 1000 行为锚点
    expect(keysetFilters.tasks).toEqual([
      null,
      `updated_at.gt.${taskRows[999].updated_at},and(updated_at.eq.${taskRows[999].updated_at},id.gt.${taskRows[999].id})`,
    ]);
    expect(keysetFilters.connections).toEqual([
      null,
      `updated_at.gt.${connectionRows[999].updated_at},and(updated_at.eq.${connectionRows[999].updated_at},id.gt.${connectionRows[999].id})`,
    ]);
  });

  it('commitProjectSyncCursor 不应让持久层返回的旧 cursor 回退内存游标', async () => {
    const staleCursor: ProjectSyncCursor = {
      updatedAt: '2026-06-09T00:00:00.000Z',
      entityType: 'task',
      id: 'task-old',
    };
    const freshCursor: ProjectSyncCursor = {
      updatedAt: '2026-06-09T00:05:00.000Z',
      entityType: 'task',
      id: 'task-new',
    };
    const { service, syncCursorPersistence } = createService();
    syncCursorPersistence.commitProjectCursor.mockResolvedValueOnce(staleCursor);

    await service.commitProjectSyncCursor('project-1', freshCursor);

    expect(service.getLastSyncTime('project-1')).toBe(freshCursor.updatedAt);
    expect(service.getProjectSyncCursor('project-1')).toEqual(freshCursor);
  });

  it('commitProjectSyncCursor 在持久层失败时不应推进内存游标', async () => {
    const cursor: ProjectSyncCursor = {
      updatedAt: '2026-06-09T00:05:00.000Z',
      entityType: 'task',
      id: 'task-new',
    };
    const { service, syncCursorPersistence } = createService();
    syncCursorPersistence.commitProjectCursor.mockRejectedValueOnce(new Error('IndexedDB unavailable'));

    await expect(service.commitProjectSyncCursor('project-1', cursor)).rejects.toThrow('IndexedDB unavailable');

    expect(service.getLastSyncTime('project-1')).toBeNull();
    expect(service.getProjectSyncCursor('project-1')).toBeNull();
  });

  it('commitProjectSyncCursor 不应让晚到旧提交覆盖已推进的内存游标', async () => {
    const staleCursor: ProjectSyncCursor = {
      updatedAt: '2026-06-09T00:00:00.000Z',
      entityType: 'task',
      id: 'task-old',
    };
    const freshCursor: ProjectSyncCursor = {
      updatedAt: '2026-06-09T00:05:00.000Z',
      entityType: 'task',
      id: 'task-new',
    };
    const staleCommit = createDeferred<ProjectSyncCursor>();
    const { service, syncCursorPersistence } = createService();
    syncCursorPersistence.commitProjectCursor.mockImplementation(
      async (_projectId, _userId, cursor: ProjectSyncCursor) =>
        cursor.id === 'task-old' ? staleCommit.promise : cursor,
    );

    const lateStaleCommit = service.commitProjectSyncCursor('project-1', staleCursor);
    await service.commitProjectSyncCursor('project-1', freshCursor);

    expect(service.getProjectSyncCursor('project-1')).toEqual(freshCursor);

    staleCommit.resolve(staleCursor);
    await lateStaleCommit;

    expect(service.getLastSyncTime('project-1')).toBe(freshCursor.updatedAt);
    expect(service.getProjectSyncCursor('project-1')).toEqual(freshCursor);
  });
});

function createService(): {
  service: ProjectSyncCursorService;
  syncCursorPersistence: {
    loadProjectCursor: ReturnType<typeof vi.fn>;
    commitProjectCursor: ReturnType<typeof vi.fn>;
    clearProjectCursor: ReturnType<typeof vi.fn>;
  };
} {
  const logger = {
    category: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  };
  const syncCursorPersistence = {
    loadProjectCursor: vi.fn(async () => null),
    commitProjectCursor: vi.fn(async (_projectId, _userId, cursor) => cursor),
    clearProjectCursor: vi.fn(async () => undefined),
  };
  const injector = Injector.create({
    providers: [
      ProjectSyncCursorService,
      { provide: LoggerService, useValue: logger },
      { provide: ClockSyncService, useValue: { currentDriftMs: vi.fn(() => 0) } },
      {
        provide: SentryLazyLoaderService,
        useValue: {
          setContext: vi.fn(),
          addBreadcrumb: vi.fn(),
        },
      },
      {
        provide: ProjectDataService,
        useValue: {
          rowToTask: (row: TaskRow): Task => ({
            id: row.id,
            title: row.title ?? '',
            content: row.content ?? '',
            stage: row.stage,
            parentId: row.parent_id,
            order: row.order ?? 0,
            rank: row.rank ?? 0,
            status: row.status ?? 'active',
            x: row.x ?? 0,
            y: row.y ?? 0,
            createdDate: row.created_at ?? '',
            updatedAt: row.updated_at,
            displayId: row.id,
            hasIncompleteTask: false,
            attachments: [],
          }),
          rowToConnection: (row: ConnectionRow): Connection => ({
            id: row.id,
            source: row.source_id,
            target: row.target_id,
            updatedAt: row.updated_at,
          }),
        },
      },
      {
        provide: SessionManagerService,
        useValue: {
          getRecentValidationSnapshot: vi.fn(() => ({ userId: 'user-1' })),
        },
      },
      {
        provide: SyncCursorPersistenceService,
        useValue: syncCursorPersistence,
      },
    ],
  });

  return {
    service: runInInjectionContext(injector, () => injector.get(ProjectSyncCursorService)),
    syncCursorPersistence,
  };
}

function createKeysetPagedClient(input: {
  taskRows: TaskRow[];
  connectionRows: ConnectionRow[];
  keysetFilters: Record<string, Array<string | null>>;
}) {
  return {
    from: vi.fn((table: 'tasks' | 'connections') => ({
      select: vi.fn(() => {
        let pendingKeysetFilter: string | null = null;
        const rowsAfterKeyset = (rows: Array<{ id: string; updated_at: string }>, filter: string | null) => {
          if (!filter) return rows;
          const match = /^updated_at\.gt\.(.+?),and\(updated_at\.eq\.\1,id\.gt\.(.+?)\)$/.exec(filter);
          if (!match) return rows;
          const [, updatedAt, id] = match;
          return rows.filter(row =>
            row.updated_at > updatedAt || (row.updated_at === updatedAt && row.id > id));
        };
        const query = {
          eq: vi.fn(() => query),
          gt: vi.fn(() => query),
          or: vi.fn((filter: string) => {
            pendingKeysetFilter = filter;
            return query;
          }),
          order: vi.fn(() => query),
          limit: vi.fn(async (count: number) => {
            input.keysetFilters[table].push(pendingKeysetFilter);
            const rows = table === 'tasks' ? input.taskRows : input.connectionRows;
            const filtered = rowsAfterKeyset(
              rows as Array<{ id: string; updated_at: string }>,
              pendingKeysetFilter,
            );
            pendingKeysetFilter = null;
            return { data: filtered.slice(0, count), error: null };
          }),
        };
        return query;
      }),
    })),
  };
}

/** 生成确定性的实体 UUID（keyset 游标要求合法 UUID id，见 §5.1 客户端 UUID 硬规则）。 */
function entityUuid(family: string, index: number): string {
  return `00000000-0000-4000-${family}000-${index.toString().padStart(12, '0')}`;
}

function taskRow(index: number): TaskRow {
  return {
    id: entityUuid('a', index),
    project_id: 'project-1',
    title: `Task ${index}`,
    content: `Content ${index}`,
    stage: 1,
    parent_id: null,
    order: index,
    rank: 10000 + index,
    status: 'active',
    x: 0,
    y: 0,
    updated_at: new Date(Date.UTC(2026, 5, 9, 0, 1, index)).toISOString(),
    created_at: '2026-06-09T00:00:00.000Z',
    completed_at: null,
    deleted_at: null,
    short_id: null,
    priority: null,
    due_date: null,
    expected_minutes: null,
    cognitive_load: null,
    wait_minutes: null,
    parking_meta: null,
    attention_meta: null,
    attachments: [],
    tags: [],
  };
}

function connectionRow(index: number): ConnectionRow {
  return {
    id: entityUuid('b', index),
    project_id: 'project-1',
    source_id: entityUuid('a', 0),
    target_id: entityUuid('a', index),
    title: '',
    description: '',
    created_at: '2026-06-09T00:00:00.000Z',
    updated_at: new Date(Date.UTC(2026, 5, 9, 0, 2, index)).toISOString(),
    deleted_at: null,
  };
}
