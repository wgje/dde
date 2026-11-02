import {
  AuthService,
  Injector,
  LoggerService,
  PROJECT_BATCH_RPC_PROBE_GRACE_MS,
  ProjectCloudListService,
  ProjectDataService,
  ProjectDetailLoaderService,
  ProjectOfflineSnapshotService,
  ProjectParkedTasksDataService,
  ProjectSyncProbeService,
  ProjectTaskDataService,
  RequestThrottleService,
  SentryLazyLoaderService,
  SupabaseClientService,
  SyncStateService,
  TombstoneService,
  createProjectDataPagedQuery,
  createProjectDataRangeQuery,
  describe,
  expect,
  it,
  setVisibilityState,
  vi,
} from './project-data.service.spec-context';
import type { Provider } from '@angular/core';
import type { Project } from './project-data.service.spec-context';

type MockFn = ReturnType<typeof vi.fn>;
type LoggerCategoryMock = {
  debug: MockFn;
  info: MockFn;
  warn: MockFn;
  error: MockFn;
};

interface ProjectDataCloudLoadInjectorOptions {
  supabase: Record<string, unknown>;
  auth?: Record<string, unknown>;
  logger?: LoggerCategoryMock;
  requestThrottle?: Record<string, unknown>;
  syncState?: Record<string, unknown>;
  tombstone?: Record<string, unknown>;
  sentry?: Record<string, unknown>;
  extraProviders?: Provider[];
}

const createLoggerCategory = (): LoggerCategoryMock => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
});

function createProjectDataCloudLoadInjector(options: ProjectDataCloudLoadInjectorOptions) {
  return Injector.create({
    providers: [
      { provide: ProjectDataService, useClass: ProjectDataService },
      { provide: ProjectOfflineSnapshotService, useClass: ProjectOfflineSnapshotService },
      { provide: ProjectParkedTasksDataService, useClass: ProjectParkedTasksDataService },
      { provide: ProjectSyncProbeService, useClass: ProjectSyncProbeService },
      { provide: ProjectCloudListService, useClass: ProjectCloudListService },
      { provide: ProjectDetailLoaderService, useClass: ProjectDetailLoaderService },
      { provide: ProjectTaskDataService, useClass: ProjectTaskDataService },
      { provide: SupabaseClientService, useValue: options.supabase },
      {
        provide: AuthService,
        useValue: options.auth ?? {
          currentUserId: vi.fn(() => 'user-1'),
        },
      },
      {
        provide: LoggerService,
        useValue: {
          category: () => options.logger ?? createLoggerCategory(),
        },
      },
      {
        provide: RequestThrottleService,
        useValue: options.requestThrottle ?? {
          execute: vi.fn(),
        },
      },
      {
        provide: SyncStateService,
        useValue: options.syncState ?? {
          setSyncError: vi.fn(),
        },
      },
      {
        provide: TombstoneService,
        useValue: options.tombstone ?? {
          getTombstonesWithCache: vi.fn().mockResolvedValue({ data: [], error: null }),
          getLocalTombstones: vi.fn().mockReturnValue(new Set()),
        },
      },
      {
        provide: SentryLazyLoaderService,
        useValue: options.sentry ?? {
          addBreadcrumb: vi.fn(),
          captureException: vi.fn(),
          captureMessage: vi.fn(),
        },
      },
      ...(options.extraProviders ?? []),
    ],
  });
}


export function registerProjectDataCloudLoadSpecs(): void {
  describe('cloud load and paginated project details', () => {
      it('挂起窗口内 pullParkedTasksDelta 应直接跳过远端请求', async () => {
        setVisibilityState('hidden');
        const clientAsync = vi.fn(async () => ({
          from: vi.fn(),
        }));

        const injector = createProjectDataCloudLoadInjector({
          supabase: {
            isConfigured: true,
            clientAsync,
          },
        });

        const service = injector.get(ProjectDataService);
        const result = await service.pullParkedTasksDelta(null, []);

        expect(result).toEqual({
          entries: [],
          removedTasks: [],
          removedTaskIds: [],
          nextCursor: null,
          isComplete: false,
        });
        expect(clientAsync).not.toHaveBeenCalled();
      });

      it('getProjectSyncWatermark 应返回远端聚合水位', async () => {
        const rpc = vi.fn().mockResolvedValue({
          data: '2026-02-14T08:10:00.000Z',
          error: null,
        });

        const injector = createProjectDataCloudLoadInjector({
          supabase: {
            isConfigured: true,
            clientAsync: vi.fn(async () => ({ rpc })),
          },
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

        const injector = createProjectDataCloudLoadInjector({
          supabase: {
            isConfigured: false,
            isOfflineMode: () => true,
            clientAsync: vi.fn(),
          },
          auth: {
            currentUserId: vi.fn(() => null),
          },
          logger,
          syncState,
        });

        const service = injector.get(ProjectDataService);
        const getSupabaseClient = (service as unknown as { getSupabaseClient: () => Promise<unknown> }).getSupabaseClient.bind(service);

        await getSupabaseClient();
        await getSupabaseClient();

        expect(logger.info).toHaveBeenCalledTimes(1);
        expect(logger.warn).not.toHaveBeenCalled();
        expect(syncState.setSyncError).not.toHaveBeenCalled();
      });

      it('优化入口应始终委托给分段加载并完全跳过聚合 RPC', async () => {
        const rpc = vi.fn();
        const injector = createProjectDataCloudLoadInjector({
          supabase: {
            isConfigured: true,
            clientAsync: vi.fn(async () => ({ rpc })),
          },
        });

        const service = injector.get(ProjectDataService);
        const detailLoader = injector.get(ProjectDetailLoaderService);
        const fallbackSpy = vi.spyOn(detailLoader, 'loadFullProject').mockResolvedValue(null);

        await service.loadFullProjectOptimized('proj-default-stable', 'user-1');

        expect(rpc).not.toHaveBeenCalled();
        expect(fallbackSpy).toHaveBeenCalledWith('proj-default-stable', 'user-1', expect.any(Object));
      });

      it('loadFullProject 在 connections 查询失败时不应返回 fresh partial remote', async () => {
        const projectQuery = {
          select: vi.fn(),
          eq: vi.fn(),
          is: vi.fn(),
          maybeSingle: vi.fn().mockResolvedValue({
            data: {
              id: 'proj-connections-error',
              owner_id: 'user-1',
              title: 'Project with partial connections',
              description: '',
              created_date: '2026-06-27T00:00:00.000Z',
              updated_at: '2026-06-27T00:00:00.000Z',
              deleted_at: null,
              version: 1,
            },
            error: null,
          }),
        };
        projectQuery.select.mockReturnValue(projectQuery);
        projectQuery.eq.mockReturnValue(projectQuery);
        projectQuery.is.mockReturnValue(projectQuery);

        const from = vi.fn((table: string) => {
          if (table === 'projects') return projectQuery;
          if (table === 'tasks') return createProjectDataPagedQuery([]);
          if (table === 'connections') {
            return createProjectDataPagedQuery([
              { data: null, error: { message: 'connections unavailable' } },
            ]);
          }
          throw new Error(`unexpected table ${table}`);
        });

        const injector = createProjectDataCloudLoadInjector({
          supabase: {
            isConfigured: true,
            clientAsync: vi.fn(async () => ({ from })),
          },
          requestThrottle: {
            execute: vi.fn(async (_key: string, work: () => Promise<unknown>) => work()),
          },
        });

        const service = injector.get(ProjectDataService);
        const result = await service.loadFullProject('proj-connections-error', 'user-1');

        expect(result).toBeNull();
        expect(from).toHaveBeenCalledWith('connections');
      });

      it('loadProjectsFromCloud 应将 owner hint 传递给完整项目加载链路', async () => {
        const projectsQuery = createProjectDataRangeQuery([{ id: 'proj-owner-hint' }]);
        const from = vi.fn((table: string) => {
          if (table === 'projects') {
            return projectsQuery;
          }
          throw new Error(`unexpected table ${table}`);
        });

        const injector = createProjectDataCloudLoadInjector({
          supabase: {
            isConfigured: true,
            clientAsync: vi.fn(async () => ({ from })),
          },
          auth: {
            currentUserId: vi.fn(() => null),
            sessionInitialized: vi.fn(() => false),
            authState: vi.fn(() => ({ isCheckingSession: false })),
            runtimeState: vi.fn(() => 'idle'),
            peekPersistedSessionIdentity: vi.fn(() => null),
          },
          requestThrottle: {
            execute: vi.fn(async (_key: string, work: () => Promise<unknown>) => work()),
          },
          syncState: {
            setSyncError: vi.fn(),
            setLoadingRemote: vi.fn(),
            isLoadingRemote: vi.fn(() => false),
          },
        });

        const service = injector.get(ProjectDataService);
        const loadSpy = vi.spyOn(
          service as unknown as { loadFullProjectOptimized: (projectId: string, expectedUserId?: string) => Promise<Project | null> },
          'loadFullProjectOptimized'
        ).mockResolvedValue(null);

        await service.loadProjectsFromCloud('user-owner-hint');

        expect(loadSpy).toHaveBeenCalledWith('proj-owner-hint', 'user-owner-hint');
      });

      it('loadProjectsFromCloud 项目列表读取失败时应返回 null 而不是空数组', async () => {
        const projectsQuery = createProjectDataPagedQuery([
          { data: null, error: { message: 'network unavailable' } },
        ]);
        const from = vi.fn((table: string) => {
          if (table === 'projects') return projectsQuery;
          throw new Error(`unexpected table ${table}`);
        });
        const syncState = {
          setSyncError: vi.fn(),
          setLoadingRemote: vi.fn(),
        };
        const sentry = {
          addBreadcrumb: vi.fn(),
          captureException: vi.fn(),
          captureMessage: vi.fn(),
        };

        const injector = createProjectDataCloudLoadInjector({
          supabase: {
            isConfigured: true,
            clientAsync: vi.fn(async () => ({ from })),
          },
          requestThrottle: {
            execute: vi.fn(async (_key: string, work: () => Promise<unknown>) => work()),
          },
          syncState,
          sentry,
        });

        const service = injector.get(ProjectDataService);
        const result = await service.loadProjectsFromCloud('user-read-failure');

        expect(result).toBeNull();
        expect(syncState.setLoadingRemote).toHaveBeenNthCalledWith(1, true);
        expect(syncState.setLoadingRemote).toHaveBeenNthCalledWith(2, false);
        expect(sentry.captureException).toHaveBeenCalledWith(
          expect.any(Error),
          expect.objectContaining({ tags: { operation: 'loadProjectsFromCloud' } }),
        );
      });

      it('loadProjectsFromCloud 应分页加载超过 1000 个项目壳', async () => {
        const projectRows = Array.from({ length: 1001 }, (_, index) => ({
          id: `proj-page-${index}`,
          owner_id: 'user-project-pages',
          title: `Project ${index}`,
          description: '',
          created_date: '2026-06-09T00:00:00.000Z',
          updated_at: `2026-06-09T00:${String(index % 60).padStart(2, '0')}:00.000Z`,
          deleted_at: null,
          version: 1,
        }));
        const ranges: Array<[number, number]> = [];
        const projectsQuery = createProjectDataRangeQuery(projectRows, ranges);
        const from = vi.fn((table: string) => {
          if (table === 'projects') return projectsQuery;
          throw new Error(`unexpected table ${table}`);
        });

        const injector = createProjectDataCloudLoadInjector({
          supabase: {
            isConfigured: true,
            clientAsync: vi.fn(async () => ({ from })),
          },
          auth: {
            currentUserId: vi.fn(() => 'user-project-pages'),
          },
          requestThrottle: {
            execute: vi.fn(async (_key: string, work: () => Promise<unknown>) => work()),
          },
          syncState: {
            setSyncError: vi.fn(),
            setLoadingRemote: vi.fn(),
          },
        });

        const service = injector.get(ProjectDataService);
        const loadSpy = vi.spyOn(
          service as unknown as { loadFullProjectOptimized: (projectId: string, expectedUserId?: string) => Promise<Project | null> },
          'loadFullProjectOptimized'
        ).mockImplementation(async (projectId: string) => ({
          id: projectId,
          name: projectId,
          description: '',
          createdDate: '2026-06-09T00:00:00.000Z',
          tasks: [],
          connections: [],
        }));

        const projects = await service.loadProjectsFromCloud('user-project-pages');

        expect(projects).not.toBeNull();
        if (!projects) throw new Error('Expected paged project load to return projects');
        expect(projects).toHaveLength(1001);
        expect(projects[1000]?.id).toBe('proj-page-1000');
        expect(loadSpy).toHaveBeenCalledWith('proj-page-1000', 'user-project-pages');
        expect(ranges).toEqual([[0, 999], [1000, 1999]]);
      });

      it('pullProjects 应分页拉取项目列表并保留 owner/since 过滤', async () => {
        const rows = Array.from({ length: 1001 }, (_, index) => ({
          id: `project-${index.toString().padStart(4, '0')}`,
          title: `Project ${index}`,
          description: '',
          created_date: '2026-06-09T00:00:00.000Z',
          updated_at: new Date(Date.UTC(2026, 5, 9, 0, 0, index)).toISOString(),
          version: 1,
          owner_id: 'user-1',
        }));
        const ranges: Array<[number, number]> = [];
        const query = createProjectDataRangeQuery(rows, ranges);
        const from = vi.fn((table: string) => {
          if (table === 'projects') return query;
          throw new Error(`unexpected table ${table}`);
        });
        const injector = createProjectDataCloudLoadInjector({
          supabase: {
            isConfigured: true,
            clientAsync: vi.fn(async () => ({ from })),
          },
        });
        const service = injector.get(ProjectDataService);

        const projects = await service.pullProjects('2026-06-01T00:00:00.000Z', {
          getClient: vi.fn(async () => ({ from }) as never),
          getRecentValidatedUserId: vi.fn(() => 'user-1'),
          rowToProject: row => ({
            id: String(row.id ?? ''),
            name: String(row.title ?? ''),
            description: String(row.description ?? ''),
            createdDate: String(row.created_date ?? ''),
            updatedAt: String(row.updated_at ?? ''),
            version: Number(row.version ?? 1),
            tasks: [],
            connections: [],
          }),
        });

        expect(projects).toHaveLength(1001);
        expect(projects[1000]?.id).toBe('project-1000');
        expect(query.eq).toHaveBeenCalledWith('owner_id', 'user-1');
        expect(query.gt).toHaveBeenCalledWith('updated_at', '2026-06-01T00:00:00.000Z');
        expect(query.order).toHaveBeenCalledWith('updated_at', { ascending: true });
        expect(query.order).toHaveBeenCalledWith('id', { ascending: true });
        expect(ranges).toEqual([
          [0, 999],
          [1000, 1999],
        ]);
      });

      it('loadProjectsFromCloud 为每个项目委托分段加载', async () => {
        const projectsQuery = createProjectDataRangeQuery([
          { id: 'proj-sequential-1' },
          { id: 'proj-sequential-2' },
          { id: 'proj-sequential-3' },
        ]);
        const rpc = vi.fn();
        const from = vi.fn((table: string) => {
          if (table === 'projects') {
            return projectsQuery;
          }
          throw new Error(`unexpected table ${table}`);
        });

        const injector = createProjectDataCloudLoadInjector({
          supabase: {
            isConfigured: true,
            clientAsync: vi.fn(async () => ({ from, rpc })),
          },
          auth: {
            currentUserId: vi.fn(() => null),
            sessionInitialized: vi.fn(() => false),
            authState: vi.fn(() => ({ isCheckingSession: false })),
            runtimeState: vi.fn(() => 'idle'),
            peekPersistedSessionIdentity: vi.fn(() => null),
          },
          requestThrottle: {
            execute: vi.fn(async (_key: string, work: () => Promise<unknown>) => work()),
          },
          syncState: {
            setSyncError: vi.fn(),
            setLoadingRemote: vi.fn(),
            isLoadingRemote: vi.fn(() => false),
          },
        });

        const service = injector.get(ProjectDataService);
        const detailLoader = injector.get(ProjectDetailLoaderService);
        const fallbackSpy = vi.spyOn(detailLoader, 'loadFullProject').mockResolvedValue(null);

        const result = await service.loadProjectsFromCloud('user-sequential');

        expect(result).toEqual([]);
        expect(rpc).not.toHaveBeenCalled();
        expect(fallbackSpy).toHaveBeenCalledTimes(3);
        expect(fallbackSpy).toHaveBeenNthCalledWith(1, 'proj-sequential-1', 'user-sequential', expect.any(Object));
        expect(fallbackSpy).toHaveBeenNthCalledWith(2, 'proj-sequential-2', 'user-sequential', expect.any(Object));
        expect(fallbackSpy).toHaveBeenNthCalledWith(3, 'proj-sequential-3', 'user-sequential', expect.any(Object));
      });

      it('loadProjectsFromCloud 不应等待首个项目完整结束后才启动剩余项目加载', async () => {
        vi.useFakeTimers();

        const projectsQuery = createProjectDataRangeQuery([
          { id: 'proj-parallel-1' },
          { id: 'proj-parallel-2' },
          { id: 'proj-parallel-3' },
        ]);
        const from = vi.fn((table: string) => {
          if (table === 'projects') {
            return projectsQuery;
          }
          throw new Error(`unexpected table ${table}`);
        });

        const injector = createProjectDataCloudLoadInjector({
          supabase: {
            isConfigured: true,
            clientAsync: vi.fn(async () => ({ from })),
          },
          auth: {
            currentUserId: vi.fn(() => null),
            sessionInitialized: vi.fn(() => false),
            authState: vi.fn(() => ({ isCheckingSession: false })),
            runtimeState: vi.fn(() => 'idle'),
            peekPersistedSessionIdentity: vi.fn(() => null),
          },
          requestThrottle: {
            execute: vi.fn(async (_key: string, work: () => Promise<unknown>) => work()),
          },
          syncState: {
            setSyncError: vi.fn(),
            setLoadingRemote: vi.fn(),
            isLoadingRemote: vi.fn(() => false),
          },
        });

        const service = injector.get(ProjectDataService);
        let resolveFirstLoad = (): void => undefined;
        const loadSpy = vi.spyOn(
          service as unknown as { loadFullProjectOptimized: (projectId: string, expectedUserId?: string) => Promise<Project | null> },
          'loadFullProjectOptimized'
        ).mockImplementation((projectId: string) => {
          if (projectId === 'proj-parallel-1') {
            return new Promise<Project | null>((resolve) => {
              resolveFirstLoad = () => resolve(null);
            });
          }

          return Promise.resolve(null);
        });

        const pendingLoad = service.loadProjectsFromCloud('user-parallel-hint');

        try {
          await vi.waitFor(() => expect(loadSpy).toHaveBeenCalledTimes(1));

          await vi.advanceTimersByTimeAsync(PROJECT_BATCH_RPC_PROBE_GRACE_MS);
          expect(loadSpy).toHaveBeenCalledTimes(3);
          expect(loadSpy).toHaveBeenNthCalledWith(2, 'proj-parallel-2', 'user-parallel-hint');
          expect(loadSpy).toHaveBeenNthCalledWith(3, 'proj-parallel-3', 'user-parallel-hint');
        } finally {
          resolveFirstLoad();
          await pendingLoad;
          vi.useRealTimers();
        }
      });
  });
}
