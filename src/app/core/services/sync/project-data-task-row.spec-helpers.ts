import {
  AuthService,
  FIELD_SELECT_CONFIG,
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
  TombstoneService,
  createProjectDataPagedQuery,
  describe,
  expect,
  hasTaskContentMissingFromSource,
  it,
  vi,
} from './project-data.service.spec-context';
import type { Task } from './project-data.service.spec-context';


export function registerProjectDataTaskRowSpecs(): void {
  describe('task row mapping and legacy schema loading', () => {
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
        expect(hasTaskContentMissingFromSource(task)).toBe(true);
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

      it('rowToTask 应映射 attention_meta 到任务僚机元数据', () => {
        const attentionMeta: Task['attentionMeta'] = {
          items: [
            {
              id: 'attention-1',
              text: '接口字段未冻结',
              level: 'blocker',
              done: false,
              createdAt: '2026-06-05T00:00:00.000Z',
              updatedAt: '2026-06-05T00:00:00.000Z',
            },
          ],
          pinned: false,
          updatedAt: '2026-06-05T00:00:00.000Z',
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
                category: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
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

        const task = service.rowToTask({
          id: 'task-attention-row',
          title: '任务',
          content: '内容',
          stage: 1,
          updated_at: '2026-06-05T00:00:00.000Z',
          attention_meta: attentionMeta,
        } as never);

        expect(task.attentionMeta).toEqual(attentionMeta);
      });

      it('rowToTask 应保留云端显式清空的 attention_meta 为 null', () => {
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
                category: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
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

        const task = service.rowToTask({
          id: 'task-attention-cleared',
          title: '任务',
          content: '内容',
          stage: 1,
          updated_at: '2026-06-05T00:00:00.000Z',
          attention_meta: null,
        } as never);

        expect(task.attentionMeta).toBeNull();
      });

      it('pullTasksThrottled 遇到 completed_at 缺列时应降级重试并继续加载项目任务', async () => {
        const logger = {
          debug: vi.fn(),
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
        };
        const missingCompletedAtError = {
          code: '42703',
          message: 'column tasks.completed_at does not exist',
          details: null,
          hint: null,
        };
        const taskRow = {
          id: 'task-legacy-schema',
          title: '旧 schema 任务',
          content: '项目必须能继续加载',
          stage: 1,
          parent_id: null,
          order: 0,
          rank: 10000,
          status: 'active',
          x: 0,
          y: 0,
          updated_at: '2026-04-28T00:00:00.000Z',
          deleted_at: null,
          short_id: null,
          attachments: [],
          tags: [],
          priority: null,
          due_date: null,
          expected_minutes: null,
          cognitive_load: null,
          wait_minutes: null,
          created_at: '2026-04-27T00:00:00.000Z',
          parking_meta: null,
        };
        const tasksQuery = createProjectDataPagedQuery([
          { data: null, error: missingCompletedAtError },
          { data: [taskRow], error: null },
        ]);
        const client = {
          from: vi.fn(() => tasksQuery),
        };
        const throttleExecute = vi.fn(async (_key: string, operation: () => Promise<unknown>) => operation());

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
                shouldMaterializeTaskDeletion: vi.fn().mockReturnValue(false),
                getLocalTombstoneTimestamp: vi.fn().mockReturnValue(undefined),
                clearLocalTombstones: vi.fn(),
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
        const result = await (service as unknown as {
          pullTasksThrottled: (projectId: string, client: unknown) => Promise<unknown[]>;
        }).pullTasksThrottled('project-legacy-schema', client);

        expect(result).toHaveLength(1);
        expect(result[0]).toMatchObject({
          id: 'task-legacy-schema',
          title: '旧 schema 任务',
          completedAt: null,
        });
        expect(tasksQuery.select).toHaveBeenNthCalledWith(1, FIELD_SELECT_CONFIG.TASK_LIST_FIELDS);
        expect(tasksQuery.select).toHaveBeenNthCalledWith(
          2,
          expect.not.stringContaining('completed_at')
        );
        expect(logger.warn).toHaveBeenCalledWith(
          'tasks 可选字段缺失，已降级为旧 schema 任务字段',
          expect.objectContaining({
            projectId: 'project-legacy-schema',
            error: missingCompletedAtError,
          })
        );
      });

      it('pullTasksThrottled 遇到多个旧 schema 缺列时应持续降级直到可加载任务', async () => {
        const missingCompletedAtError = {
          code: '42703',
          message: 'column tasks.completed_at does not exist',
          details: null,
          hint: null,
        };
        const missingAttentionMetaError = {
          code: '42703',
          message: 'column tasks.attention_meta does not exist',
          details: null,
          hint: null,
        };
        const taskRow = {
          id: 'task-double-legacy-schema',
          title: '双缺列旧 schema 任务',
          content: '项目必须能继续加载',
          stage: 1,
          parent_id: null,
          order: 0,
          rank: 10000,
          status: 'active',
          x: 0,
          y: 0,
          updated_at: '2026-04-28T00:00:00.000Z',
          deleted_at: null,
          short_id: null,
          attachments: [],
          tags: [],
          priority: null,
          due_date: null,
          expected_minutes: null,
          cognitive_load: null,
          wait_minutes: null,
          created_at: '2026-04-27T00:00:00.000Z',
          parking_meta: null,
        };
        const tasksQuery = createProjectDataPagedQuery([
          { data: null, error: missingCompletedAtError },
          { data: null, error: missingAttentionMetaError },
          { data: [taskRow], error: null },
        ]);
        const client = {
          from: vi.fn(() => tasksQuery),
        };
        const throttleExecute = vi.fn(async (_key: string, operation: () => Promise<unknown>) => operation());

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
                category: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
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
                shouldMaterializeTaskDeletion: vi.fn().mockReturnValue(false),
                getLocalTombstoneTimestamp: vi.fn().mockReturnValue(undefined),
                clearLocalTombstones: vi.fn(),
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
        const result = await (service as unknown as {
          pullTasksThrottled: (projectId: string, client: unknown) => Promise<unknown[]>;
        }).pullTasksThrottled('project-double-legacy-schema', client);

        expect(result).toHaveLength(1);
        expect(result[0]).toMatchObject({
          id: 'task-double-legacy-schema',
          title: '双缺列旧 schema 任务',
          completedAt: null,
          attentionMeta: undefined,
        });
        expect(tasksQuery.select).toHaveBeenNthCalledWith(1, FIELD_SELECT_CONFIG.TASK_LIST_FIELDS);
        expect(tasksQuery.select).toHaveBeenNthCalledWith(2, expect.not.stringContaining('completed_at'));
        expect(tasksQuery.select).toHaveBeenNthCalledWith(2, expect.stringContaining('attention_meta'));
        expect(tasksQuery.select).toHaveBeenNthCalledWith(3, expect.not.stringContaining('completed_at'));
        expect(tasksQuery.select).toHaveBeenNthCalledWith(3, expect.not.stringContaining('attention_meta'));
      });

      it('pullTasksThrottled materialize tombstone 时应保留缺失 content marker', async () => {
        const taskRow = {
          id: 'task-missing-content-tombstone',
          title: '缺失正文但被 tombstone 物化',
          stage: 1,
          parent_id: null,
          order: 0,
          rank: 10000,
          status: 'active',
          x: 0,
          y: 0,
          updated_at: '2026-04-28T00:00:00.000Z',
          deleted_at: null,
          short_id: null,
          attachments: [],
          tags: [],
          priority: null,
          due_date: null,
          expected_minutes: null,
          cognitive_load: null,
          wait_minutes: null,
          created_at: '2026-04-27T00:00:00.000Z',
          parking_meta: null,
        };
        const tasksQuery = createProjectDataPagedQuery([{ data: [taskRow], error: null }]);
        const client = {
          from: vi.fn(() => tasksQuery),
        };
        const throttleExecute = vi.fn(async (_key: string, operation: () => Promise<unknown>) => operation());

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
                shouldMaterializeTaskDeletion: vi.fn().mockImplementation((_updatedAt: string | undefined, deletedAt?: number) => deletedAt !== undefined),
                getLocalTombstoneTimestamp: vi.fn().mockReturnValue(Date.parse('2026-04-29T00:00:00.000Z')),
                clearLocalTombstones: vi.fn(),
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
        const result = await (service as unknown as {
          pullTasksThrottled: (projectId: string, client: unknown) => Promise<Task[]>;
        }).pullTasksThrottled('project-marker-clone', client);

        expect(result).toHaveLength(1);
        expect(result[0]?.deletedAt).toBe('2026-04-29T00:00:00.000Z');
        expect(hasTaskContentMissingFromSource(result[0])).toBe(true);
      });
  });
}
