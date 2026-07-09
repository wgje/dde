import { Injector } from '@angular/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectDataService } from './project-data.service';
import { ProjectOfflineSnapshotService } from './project-offline-snapshot.service';
import { ProjectParkedTasksDataService } from './project-parked-tasks-data.service';
import { ProjectSyncProbeService } from './project-sync-probe.service';
import { ProjectCloudListService } from './project-cloud-list.service';
import { ProjectDetailLoaderService } from './project-detail-loader.service';
import { ProjectTaskDataService } from './project-task-data.service';
import { SupabaseClientService } from '../../../../services/supabase-client.service';
import { AuthService } from '../../../../services/auth.service';
import { LoggerService } from '../../../../services/logger.service';
import { RequestThrottleService } from '../../../../services/request-throttle.service';
import { SyncStateService } from './sync-state.service';
import { TombstoneService } from './tombstone.service';
import { SentryLazyLoaderService } from '../../../../services/sentry-lazy-loader.service';
import { resetBrowserNetworkSuspensionTrackingForTests } from '../../../../utils/browser-network-suspension';
import { FEATURE_FLAGS } from '../../../../config/feature-flags.config';

const OFFLINE_SNAPSHOT_LOCAL_STORAGE_KEY = 'nanoflow.offline-cache-v2';

type MutableProjectDataFeatureFlags = {
  PROJECT_FULL_DATA_RPC_V1: boolean;
};

const projectDataFeatureFlags = FEATURE_FLAGS as unknown as MutableProjectDataFeatureFlags;
const initialProjectFullDataRpcFlag = FEATURE_FLAGS.PROJECT_FULL_DATA_RPC_V1;

function setVisibilityState(state: DocumentVisibilityState): void {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    value: state,
  });
}

interface PagedQuery<Row> extends PromiseLike<{ data: Row[]; error: null }> {
  select: ReturnType<typeof vi.fn>;
  eq: ReturnType<typeof vi.fn>;
  is: ReturnType<typeof vi.fn>;
  in: ReturnType<typeof vi.fn>;
  gt: ReturnType<typeof vi.fn>;
  not: ReturnType<typeof vi.fn>;
  order: ReturnType<typeof vi.fn>;
  range: ReturnType<typeof vi.fn>;
}

function createPagedQuery<Row>(
  rows: Row[],
  rangeCalls: Array<[number, number]> = [],
): PagedQuery<Row> {
  const resolveDefaultPage = () => Promise.resolve({ data: rows.slice(0, 1000), error: null });
  const query = {
    select: vi.fn(),
    eq: vi.fn(),
    is: vi.fn(),
    in: vi.fn(),
    gt: vi.fn(),
    not: vi.fn(),
    order: vi.fn(),
    range: vi.fn((from: number, to: number) => {
      rangeCalls.push([from, to]);
      return Promise.resolve({ data: rows.slice(from, to + 1), error: null });
    }),
    then: (
      onfulfilled?: ((value: { data: Row[]; error: null }) => unknown) | null,
      onrejected?: ((reason: unknown) => unknown) | null,
    ) => resolveDefaultPage().then(onfulfilled, onrejected),
  } as unknown as PagedQuery<Row>;

  query.select.mockReturnValue(query);
  query.eq.mockReturnValue(query);
  query.is.mockReturnValue(query);
  query.in.mockReturnValue(query);
  query.gt.mockReturnValue(query);
  query.not.mockReturnValue(query);
  query.order.mockReturnValue(query);

  return query;
}

function createProjectDataService(options: {
  client?: unknown;
  currentUserId?: string | null;
} = {}): ProjectDataService {
  const clientAsync = vi.fn(async () => options.client ?? null);

  const injector = Injector.create({
    providers: [
      { provide: ProjectDataService, useClass: ProjectDataService },
      { provide: ProjectOfflineSnapshotService, useClass: ProjectOfflineSnapshotService },
      { provide: ProjectParkedTasksDataService, useClass: ProjectParkedTasksDataService },
        { provide: ProjectSyncProbeService, useClass: ProjectSyncProbeService },

        { provide: ProjectCloudListService, useClass: ProjectCloudListService },

        { provide: ProjectDetailLoaderService, useClass: ProjectDetailLoaderService },

        { provide: ProjectTaskDataService, useClass: ProjectTaskDataService },
      {
        provide: SupabaseClientService,
        useValue: {
          isConfigured: Boolean(options.client),
          clientAsync,
        },
      },
      {
        provide: AuthService,
        useValue: {
          currentUserId: vi.fn(() => options.currentUserId ?? 'user-1'),
        },
      },
      {
        provide: LoggerService,
        useValue: {
          category: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
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
          shouldMaterializeTaskDeletion: vi.fn().mockReturnValue(false),
          getLocalTombstoneTimestamp: vi.fn().mockReturnValue(undefined),
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

  return injector.get(ProjectDataService);
}

describe('ProjectDataService connection delete regressions', () => {
  beforeEach(() => {
    projectDataFeatureFlags.PROJECT_FULL_DATA_RPC_V1 = false;
    localStorage.clear();
    setVisibilityState('visible');
    resetBrowserNetworkSuspensionTrackingForTests();
  });

  afterEach(() => {
    projectDataFeatureFlags.PROJECT_FULL_DATA_RPC_V1 = initialProjectFullDataRpcFlag;
  });

  it('loadFullProject fallback 应保留 soft-deleted connections', async () => {
    const projectRow = {
      id: 'proj-1',
      owner_id: 'user-1',
      title: 'Project 1',
      description: '',
      created_date: '2026-04-11T00:00:00.000Z',
      updated_at: '2026-04-11T00:00:00.000Z',
      deleted_at: null,
      version: 1,
    };
    const deletedConnectionRow = {
      id: 'conn-1',
      source_id: 'task-1',
      target_id: 'task-2',
      title: 'Cross tree link',
      description: 'deleted on desktop',
      deleted_at: '2026-04-11T01:00:00.000Z',
      updated_at: '2026-04-11T01:00:00.000Z',
    };

    const projectMaybeSingle = vi.fn().mockResolvedValue({ data: projectRow, error: null });
    const projectIs = vi.fn().mockReturnValue({ maybeSingle: projectMaybeSingle });
    const projectEq = vi.fn().mockReturnValue({ is: projectIs });
    const taskQuery = createPagedQuery([]);
    const connectionQuery = createPagedQuery([deletedConnectionRow]);

    const client = {
      from: vi.fn((table: string) => {
        if (table === 'projects') {
          return {
            select: vi.fn().mockReturnValue({ eq: projectEq }),
          };
        }

        if (table === 'tasks') {
          return taskQuery;
        }

        if (table === 'connections') {
          return connectionQuery;
        }

        throw new Error(`Unexpected table: ${table}`);
      }),
    };

    const service = createProjectDataService({ client });
    const project = await service.loadFullProject('proj-1');

    expect(project?.connections).toEqual([
      expect.objectContaining({
        id: 'conn-1',
        source: 'task-1',
        target: 'task-2',
        deletedAt: '2026-04-11T01:00:00.000Z',
        updatedAt: '2026-04-11T01:00:00.000Z',
      }),
    ]);
    expect(connectionQuery.eq).toHaveBeenCalledWith('project_id', 'proj-1');
  });

  it('loadFullProject fallback 应用 expectedUserId 约束项目元数据查询', async () => {
    const projectRow = {
      id: 'proj-owner',
      owner_id: 'user-owner',
      title: 'Owned Project',
      description: '',
      created_date: '2026-04-11T00:00:00.000Z',
      updated_at: '2026-04-11T00:00:00.000Z',
      deleted_at: null,
      version: 1,
    };
    const projectQuery = {
      select: vi.fn(),
      eq: vi.fn(),
      is: vi.fn(),
      maybeSingle: vi.fn().mockResolvedValue({ data: projectRow, error: null }),
    };
    projectQuery.select.mockReturnValue(projectQuery);
    projectQuery.eq.mockReturnValue(projectQuery);
    projectQuery.is.mockReturnValue(projectQuery);
    const taskQuery = createPagedQuery([]);
    const connectionQuery = createPagedQuery([]);

    const client = {
      from: vi.fn((table: string) => {
        if (table === 'projects') return projectQuery;
        if (table === 'tasks') return taskQuery;
        if (table === 'connections') return connectionQuery;
        throw new Error(`Unexpected table: ${table}`);
      }),
    };

    const service = createProjectDataService({ client });
    const project = await service.loadFullProject('proj-owner', 'user-owner');

    expect(project?.id).toBe('proj-owner');
    expect(projectQuery.eq).toHaveBeenCalledWith('id', 'proj-owner');
    expect(projectQuery.eq).toHaveBeenCalledWith('owner_id', 'user-owner');
  });

  it('loadFullProject fallback 应分页加载超过 1000 条 tasks 和 connections', async () => {
    const projectRow = {
      id: 'proj-large',
      owner_id: 'user-1',
      title: 'Large Project',
      description: '',
      created_date: '2026-04-11T00:00:00.000Z',
      updated_at: '2026-04-11T00:00:00.000Z',
      deleted_at: null,
      version: 1,
    };
    const taskRows = Array.from({ length: 1001 }, (_, index) => ({
      id: `task-${index}`,
      title: `Task ${index}`,
      content: `Content ${index}`,
      stage: 1,
      parent_id: null,
      order: index,
      rank: index,
      status: 'active',
      x: 0,
      y: 0,
      updated_at: `2026-04-11T00:${String(index % 60).padStart(2, '0')}:00.000Z`,
      deleted_at: null,
      short_id: null,
      attachments: [],
      tags: [],
      priority: null,
      due_date: null,
      expected_minutes: null,
      cognitive_load: null,
      wait_minutes: null,
      created_at: '2026-04-11T00:00:00.000Z',
      parking_meta: null,
      attention_meta: null,
    }));
    const connectionRows = Array.from({ length: 1001 }, (_, index) => ({
      id: `conn-${index}`,
      source_id: `task-${index}`,
      target_id: `task-${(index + 1) % 1001}`,
      title: `Connection ${index}`,
      description: '',
      deleted_at: null,
      updated_at: `2026-04-11T01:${String(index % 60).padStart(2, '0')}:00.000Z`,
    }));

    const projectMaybeSingle = vi.fn().mockResolvedValue({ data: projectRow, error: null });
    const projectIs = vi.fn().mockReturnValue({ maybeSingle: projectMaybeSingle });
    const projectEq = vi.fn().mockReturnValue({ is: projectIs });
    const taskRangeCalls: Array<[number, number]> = [];
    const connectionRangeCalls: Array<[number, number]> = [];
    const taskQuery = createPagedQuery(taskRows, taskRangeCalls);
    const connectionQuery = createPagedQuery(connectionRows, connectionRangeCalls);

    const client = {
      from: vi.fn((table: string) => {
        if (table === 'projects') {
          return {
            select: vi.fn().mockReturnValue({ eq: projectEq }),
          };
        }
        if (table === 'tasks') return taskQuery;
        if (table === 'connections') return connectionQuery;
        throw new Error(`Unexpected table: ${table}`);
      }),
    };

    const service = createProjectDataService({ client });
    const project = await service.loadFullProject('proj-large');

    expect(project?.tasks).toHaveLength(1001);
    expect(project?.connections).toHaveLength(1001);
    expect(project?.tasks[1000]?.id).toBe('task-1000');
    expect(project?.connections[1000]?.id).toBe('conn-1000');
    expect(taskRangeCalls).toEqual([[0, 999], [1000, 1999]]);
    expect(connectionRangeCalls).toEqual([[0, 999], [1000, 1999]]);
  });

  it('loadFullProjectOptimized 主 RPC 路径应保留未 tombstone 的 soft-deleted connection', async () => {
    projectDataFeatureFlags.PROJECT_FULL_DATA_RPC_V1 = true;

    const deletedConnectionRow = {
      id: 'conn-rpc-1',
      source_id: 'task-1',
      target_id: 'task-2',
      title: 'Cross tree link',
      description: 'deleted on desktop',
      deleted_at: '2026-04-11T01:00:00.000Z',
      updated_at: '2026-04-11T01:00:00.000Z',
    };
    const client = {
      rpc: vi.fn().mockResolvedValue({
        data: {
          project: {
            id: 'proj-1',
            owner_id: 'user-1',
            title: 'Project 1',
            description: '',
            created_date: '2026-04-11T00:00:00.000Z',
            updated_at: '2026-04-11T00:00:00.000Z',
            deleted_at: null,
            version: 1,
          },
          tasks: [],
          connections: [deletedConnectionRow],
          task_tombstones: [],
          connection_tombstones: [],
        },
        error: null,
      }),
    };

    const service = createProjectDataService({ client });
    const project = await service.loadFullProjectOptimized('proj-1');

    expect(project?.connections).toEqual([
      expect.objectContaining({
        id: 'conn-rpc-1',
        deletedAt: '2026-04-11T01:00:00.000Z',
        updatedAt: '2026-04-11T01:00:00.000Z',
      }),
    ]);
    expect((client.rpc as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith('get_full_project_data', {
      p_project_id: 'proj-1',
    });
  });

  it('saveOfflineSnapshot 应保留活跃任务之间的已删连接', async () => {
    const service = createProjectDataService({ currentUserId: 'user-connection-delete' });

    await service.saveOfflineSnapshotAndWait([
      {
        id: 'proj-1',
        name: 'Project 1',
        description: '',
        createdDate: '2026-04-11T00:00:00.000Z',
        tasks: [
          { id: 'task-1', deletedAt: null },
          { id: 'task-2', deletedAt: null },
        ],
        connections: [
          {
            id: 'conn-1',
            source: 'task-1',
            target: 'task-2',
            description: 'deleted on desktop',
            deletedAt: '2026-04-11T01:00:00.000Z',
            updatedAt: '2026-04-11T01:00:00.000Z',
          },
        ],
      },
    ] as never[], 'user-connection-delete');

    const payload = JSON.parse(
      localStorage.getItem(`${OFFLINE_SNAPSHOT_LOCAL_STORAGE_KEY}.user-connection-delete`) || 'null'
    );
    const offlineSnapshot = service.loadOfflineSnapshot();
    const startupSnapshot = await service.loadStartupOfflineSnapshot();

    expect(payload.projects[0].connections).toEqual([
      expect.objectContaining({
        id: 'conn-1',
        deletedAt: '2026-04-11T01:00:00.000Z',
      }),
    ]);
    expect(offlineSnapshot?.[0].connections).toEqual([
      expect.objectContaining({
        id: 'conn-1',
        deletedAt: '2026-04-11T01:00:00.000Z',
        updatedAt: '2026-04-11T01:00:00.000Z',
      }),
    ]);
    expect(startupSnapshot.projects[0].connections).toEqual([
      expect.objectContaining({
        id: 'conn-1',
        deletedAt: '2026-04-11T01:00:00.000Z',
        updatedAt: '2026-04-11T01:00:00.000Z',
      }),
    ]);
  });
});
