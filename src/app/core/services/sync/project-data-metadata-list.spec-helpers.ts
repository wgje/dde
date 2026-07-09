import {
  AuthService,
  Injector,
  LoggerService,
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
  TIMEOUT_CONFIG,
  TombstoneService,
  createProjectDataRangeQuery,
  describe,
  expect,
  it,
  vi,
} from './project-data.service.spec-context';

export function registerProjectDataMetadataListSpecs(): void {
  describe('project list metadata loading', () => {
      it('loadProjectListMetadataFromCloud 应仅返回项目壳数据，不触发完整项目展开', async () => {
        const logger = {
          debug: vi.fn(),
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
        };
        const throttleExecute = vi.fn(async (_key: string, operation: () => Promise<unknown>) => operation());
        const projectsQuery = createProjectDataRangeQuery([
          {
            id: 'proj-remote',
            title: '云端项目',
            description: '只需要壳数据',
            created_date: '2026-03-30T00:00:00.000Z',
            updated_at: '2026-03-30T01:00:00.000Z',
            deleted_at: null,
            version: 3,
          },
        ]);
        const from = vi.fn(() => projectsQuery);

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
                isConfigured: true,
                clientAsync: vi.fn(async () => ({ from })),
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
                execute: throttleExecute,
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
        const loadFullProjectSpy = vi.spyOn(service, 'loadFullProjectOptimized');

        const result = await service.loadProjectListMetadataFromCloud('user-1');

        expect(result).toEqual([
          {
            id: 'proj-remote',
            name: '云端项目',
            description: '只需要壳数据',
            createdDate: '2026-03-30T00:00:00.000Z',
            updatedAt: '2026-03-30T01:00:00.000Z',
            version: 3,
            syncSource: 'synced',
            pendingSync: false,
            tasks: [],
            connections: [],
          },
        ]);
        expect(loadFullProjectSpy).not.toHaveBeenCalled();
        expect(throttleExecute).toHaveBeenCalledOnce();
        expect(projectsQuery.is).toHaveBeenCalledWith('deleted_at', null);
      });

      it('loadProjectListMetadataFromCloud 应分页加载超过 1000 个项目壳', async () => {
        const projectRows = Array.from({ length: 1001 }, (_, index) => ({
          id: `proj-meta-page-${index}`,
          owner_id: 'user-meta-pages',
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
                isConfigured: true,
                clientAsync: vi.fn(async () => ({ from })),
              },
            },
            {
              provide: AuthService,
              useValue: {
                currentUserId: vi.fn(() => 'user-meta-pages'),
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
        const projects = await service.loadProjectListMetadataFromCloud('user-meta-pages');

        expect(projects).toHaveLength(1001);
        expect(projects?.[1000]?.id).toBe('proj-meta-page-1000');
        expect(ranges).toEqual([[0, 999], [1000, 1999]]);
      });

      it('rowToProject 应映射 deleted_at 字段', () => {
        const logger = {
          debug: vi.fn(),
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
        };

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
              useValue: {
                addBreadcrumb: vi.fn(),
                captureException: vi.fn(),
                captureMessage: vi.fn(),
              },
            },
          ],
        });

        const service = injector.get(ProjectDataService);
        const project = service.rowToProject({
          id: 'proj-deleted',
          title: '已删除项目',
          description: 'soft delete tombstone',
          created_date: '2026-04-03T00:00:00.000Z',
          updated_at: '2026-04-03T00:05:00.000Z',
          deleted_at: '2026-04-03T00:06:00.000Z',
          version: 7,
        });

        expect(project).toMatchObject({
          id: 'proj-deleted',
          deletedAt: '2026-04-03T00:06:00.000Z',
          version: 7,
        });
      });

      it('loadProjectListMetadataFromCloud 遇到错误时应返回 null，避免把失败误判为空列表', async () => {
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
        const throttleExecute = vi.fn().mockRejectedValue(new Error('network unavailable'));

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
                isConfigured: true,
                clientAsync: vi.fn(async () => ({ from: vi.fn() })),
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
                execute: throttleExecute,
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

        const service = injector.get(ProjectDataService);

        const result = await service.loadProjectListMetadataFromCloud('user-1');

        expect(result).toBeNull();
        expect(logger.warn).toHaveBeenCalledWith('加载项目元数据列表失败', expect.any(Error));
        expect(sentry.captureException).toHaveBeenCalledWith(expect.any(Error), {
          tags: { operation: 'loadProjectListMetadataFromCloud' }
        });
      });

      it('loadProjectListMetadataFromCloud 在瞬时超时时应降级为软失败而非告警', async () => {
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
        const throttleExecute = vi.fn().mockRejectedValue(
          new Error('请求超时 (10000ms): project-list-metadata:user-1')
        );

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
                isConfigured: true,
                clientAsync: vi.fn(async () => ({ from: vi.fn() })),
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
                execute: throttleExecute,
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

        const service = injector.get(ProjectDataService);

        const result = await service.loadProjectListMetadataFromCloud('user-1', {
          timeout: TIMEOUT_CONFIG.STANDARD,
          retries: 1,
          purpose: 'sync-download-merge',
          treatTransientFailureAsSoft: true,
        });

        expect(result).toBeNull();
        expect(logger.info).toHaveBeenCalledWith(
          '项目元数据列表拉取暂时不可用，已降级为软失败',
          expect.objectContaining({
            userId: 'user-1',
            purpose: 'sync-download-merge',
          })
        );
        expect(logger.warn).not.toHaveBeenCalled();
        expect(sentry.captureException).not.toHaveBeenCalled();
      });

      it('loadProjectListMetadataFromCloud 不同执行策略应使用不同去重 key', async () => {
        const logger = {
          debug: vi.fn(),
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
        };
        const order = vi.fn().mockResolvedValue({ data: [], error: null });
        const is = vi.fn().mockReturnValue({ order });
        const eq = vi.fn().mockReturnValue({ is });
        const select = vi.fn().mockReturnValue({ eq });
        const from = vi.fn().mockReturnValue({ select });
        const throttleExecute = vi.fn(async (_key: string, executor: () => Promise<unknown>) => executor());

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
                isConfigured: true,
                clientAsync: vi.fn(async () => ({ from })),
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
                execute: throttleExecute,
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

        await service.loadProjectListMetadataFromCloud('user-1');
        await service.loadProjectListMetadataFromCloud('user-1', {
          timeout: TIMEOUT_CONFIG.STANDARD,
          retries: 1,
          purpose: 'sync-download-merge',
        });

        expect(throttleExecute).toHaveBeenNthCalledWith(
          1,
          'project-list-metadata:user-1:5000:0',
          expect.any(Function),
          expect.objectContaining({ timeout: 5000, retries: 0 })
        );
        expect(throttleExecute).toHaveBeenNthCalledWith(
          2,
          'project-list-metadata:user-1:10000:1',
          expect.any(Function),
          expect.objectContaining({ timeout: 10000, retries: 1 })
        );
      });
  });
}
