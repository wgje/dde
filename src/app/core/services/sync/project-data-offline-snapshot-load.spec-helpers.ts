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
  TombstoneService,
  expect,
  getOfflineSnapshotStorageKey,
  it,
  vi,
} from './project-data.service.spec-context';

type OfflineSnapshotAuthMock = {
  currentUserId: ReturnType<typeof vi.fn>;
  peekPersistedSessionIdentity?: ReturnType<typeof vi.fn>;
  peekPersistedOwnerHint?: ReturnType<typeof vi.fn>;
};

function createOfflineSnapshotService(authService: OfflineSnapshotAuthMock): ProjectDataService {
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
        provide: AuthService,
        useValue: authService,
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

  return injector.get(ProjectDataService);
}

function createCompleteSnapshotTask(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'task-complete',
    title: 'Complete task',
    content: '',
    stage: 1,
    parentId: null,
    order: 1,
    rank: 1000,
    status: 'active',
    x: 0,
    y: 0,
    createdDate: '2026-07-15T00:00:00.000Z',
    updatedAt: '2026-07-15T00:00:00.000Z',
    displayId: '1',
    ...overrides,
  };
}

export function registerProjectDataOfflineSnapshotLoadSpecs(): void {
  it('loadOfflineSnapshot 应拒绝非对象 envelope', () => {
    localStorage.setItem(getOfflineSnapshotStorageKey('user-1'), JSON.stringify([
      { projects: [] },
    ]));

    const service = createOfflineSnapshotService({
      currentUserId: vi.fn(() => 'user-1'),
    });

    expect(service.loadOfflineSnapshot()).toBeNull();
  });

  it('loadOfflineSnapshot 应原子拒绝重复 task ID 与坏连接引用', () => {
    localStorage.setItem(getOfflineSnapshotStorageKey('user-1'), JSON.stringify({
      projects: [
        {
          id: 'project-invalid-graph',
          name: 'Invalid Graph',
          description: '',
          createdDate: '2026-07-15T00:00:00.000Z',
          tasks: [
            createCompleteSnapshotTask({ id: 'duplicate-task', displayId: '1' }),
            createCompleteSnapshotTask({ id: 'duplicate-task', displayId: '2' }),
          ],
          connections: [
            {
              id: 'bad-connection',
              source: 'duplicate-task',
              target: 'missing-task',
              updatedAt: '2026-07-15T00:00:00.000Z',
            },
          ],
        },
      ],
      version: 6,
      ownerUserId: 'user-1',
      savedAt: '2026-07-15T00:00:00.000Z',
    }));

    const service = createOfflineSnapshotService({
      currentUserId: vi.fn(() => 'user-1'),
    });

    expect(service.loadOfflineSnapshot()).toBeNull();
  });

  it('loadOfflineSnapshot 应接受结构完整且 content 为空字符串的 sidecar 快照', () => {
    localStorage.setItem(getOfflineSnapshotStorageKey('user-1'), JSON.stringify({
      projects: [
        {
          id: 'project-valid-sidecar',
          name: 'Valid Sidecar',
          description: '',
          createdDate: '2026-07-15T00:00:00.000Z',
          viewState: { scale: 1, positionX: 10, positionY: 20 },
          tasks: [
            createCompleteSnapshotTask({
              attachments: [{
                id: 'attachment-valid',
                type: 'file',
                name: 'backup.txt',
                url: 'storage/backup.txt',
                createdAt: '2026-07-15T00:00:00.000Z',
              }],
              attentionMeta: {
                items: [{
                  id: 'attention-1',
                  text: 'Verify restore',
                  level: 'warning',
                  done: false,
                  createdAt: '2026-07-15T00:00:00.000Z',
                  updatedAt: '2026-07-15T00:00:00.000Z',
                }],
                pinned: true,
              },
              parkingMeta: null,
              deletedConnections: [],
            }),
          ],
          connections: [],
        },
      ],
      version: 6,
      ownerUserId: 'user-1',
      savedAt: '2026-07-15T00:00:00.000Z',
    }));

    const service = createOfflineSnapshotService({
      currentUserId: vi.fn(() => 'user-1'),
    });

    expect(service.loadOfflineSnapshot()).toEqual([
      expect.objectContaining({ id: 'project-valid-sidecar' }),
    ]);
  });

  it('loadOfflineSnapshot 遇到缺少 content 的任务时应拒绝整个快照', () => {
    localStorage.setItem(getOfflineSnapshotStorageKey('user-1'), JSON.stringify({
      projects: [
        {
          id: 'project-missing-content',
          name: 'Malformed Project',
          description: '',
          createdDate: '2026-07-15T00:00:00.000Z',
          updatedAt: '2026-07-15T00:00:00.000Z',
          tasks: [
            {
              id: 'task-missing-content',
              title: 'Malformed task',
              stage: 1,
              parentId: null,
              order: 1,
              rank: 1000,
              status: 'active',
              x: 0,
              y: 0,
              createdDate: '2026-07-15T00:00:00.000Z',
              updatedAt: '2026-07-15T00:00:00.000Z',
              displayId: '1',
            },
          ],
          connections: [],
        },
      ],
      version: 6,
      ownerUserId: 'user-1',
      savedAt: '2026-07-15T00:00:00.000Z',
    }));

    const service = createOfflineSnapshotService({
      currentUserId: vi.fn(() => 'user-1'),
    });

    expect(service.loadOfflineSnapshot()).toBeNull();
  });

  it('loadStartupOfflineSnapshot 不应物化只有 id/content 的部分任务对象', async () => {
    localStorage.setItem(getOfflineSnapshotStorageKey('user-1'), JSON.stringify({
      projects: [
        {
          id: 'project-partial-task',
          name: 'Malformed Project',
          description: '',
          createdDate: '2026-07-15T00:00:00.000Z',
          updatedAt: '2026-07-15T00:00:00.000Z',
          tasks: [
            {
              id: 'task-partial',
              content: 'partial payload must not be guessed',
            },
          ],
          connections: [],
        },
      ],
      version: 6,
      ownerUserId: 'user-1',
      savedAt: '2026-07-15T00:00:00.000Z',
    }));

    const service = createOfflineSnapshotService({
      currentUserId: vi.fn(() => 'user-1'),
    });

    const snapshot = await service.loadStartupOfflineSnapshot();

    expect(snapshot.source).toBe('none');
    expect(snapshot.projectCount).toBe(0);
    expect(snapshot.projects).toEqual([]);
  });

  it('loadOfflineSnapshot 应拒绝畸形 attachment 与 viewState sidecar', () => {
    localStorage.setItem(getOfflineSnapshotStorageKey('user-1'), JSON.stringify({
      projects: [
        {
          id: 'project-malformed-sidecar',
          name: 'Malformed Sidecar Project',
          description: '',
          createdDate: '2026-07-15T00:00:00.000Z',
          updatedAt: '2026-07-15T00:00:00.000Z',
          viewState: {
            scale: '1',
            positionX: 0,
            positionY: 0,
          },
          tasks: [
            {
              id: 'task-malformed-sidecar',
              title: 'Malformed sidecar task',
              content: 'content remains present',
              stage: 1,
              parentId: null,
              order: 1,
              rank: 1000,
              status: 'active',
              x: 0,
              y: 0,
              createdDate: '2026-07-15T00:00:00.000Z',
              updatedAt: '2026-07-15T00:00:00.000Z',
              displayId: '1',
              attachments: [{ id: 'attachment-partial' }],
            },
          ],
          connections: [],
        },
      ],
      version: 6,
      ownerUserId: 'user-1',
      savedAt: '2026-07-15T00:00:00.000Z',
    }));

    const service = createOfflineSnapshotService({
      currentUserId: vi.fn(() => 'user-1'),
    });

    expect(service.loadOfflineSnapshot()).toBeNull();
  });

  it('loadOfflineSnapshot 默认不应因 persisted owner hint 放宽 owner 可见性', () => {
    localStorage.setItem(getOfflineSnapshotStorageKey('user-1'), JSON.stringify({
      projects: [
        {
          id: 'persisted-owner-project',
          name: 'Persisted Owner Project',
          description: 'from scoped snapshot',
          createdDate: '2026-03-25T00:00:00.000Z',
          updatedAt: '2026-03-25T00:00:00.000Z',
          tasks: [],
          connections: [],
        },
      ],
      version: 6,
      ownerUserId: 'user-1',
    }));

    const service = createOfflineSnapshotService({
      currentUserId: vi.fn(() => null),
      peekPersistedSessionIdentity: vi.fn(() => null),
      peekPersistedOwnerHint: vi.fn(() => 'user-1'),
    });
    const safeSnapshot = service.loadOfflineSnapshot();
    const hintedSnapshot = service.loadOfflineSnapshot({ allowOwnerHint: true });

    expect(safeSnapshot).toBeNull();
    expect(hintedSnapshot).toEqual([
      expect.objectContaining({ id: 'persisted-owner-project', name: 'Persisted Owner Project' }),
    ]);
  });

  it('loadOfflineSnapshot 在当前 owner 与快照 owner 不匹配时应直接丢弃', () => {
    localStorage.setItem(getOfflineSnapshotStorageKey('user-1'), JSON.stringify({
      projects: [
        {
          id: 'foreign-owner-project',
          name: 'Foreign Owner Project',
          description: 'should stay isolated',
          createdDate: '2026-03-25T00:00:00.000Z',
          updatedAt: '2026-03-25T00:00:00.000Z',
          tasks: [],
          connections: [],
        },
      ],
      version: 6,
      ownerUserId: 'user-1',
    }));

    const service = createOfflineSnapshotService({
      currentUserId: vi.fn(() => 'user-2'),
      peekPersistedSessionIdentity: vi.fn(() => null),
      peekPersistedOwnerHint: vi.fn(() => 'user-1'),
    });

    expect(service.loadOfflineSnapshot()).toBeNull();
    expect(service.loadOfflineSnapshot({ allowOwnerHint: true })).toBeNull();
  });

  it('loadOfflineSnapshot 缺少 owner 元数据时应直接丢弃', () => {
    localStorage.setItem(getOfflineSnapshotStorageKey('user-1'), JSON.stringify({
      projects: [
        {
          id: 'ownerless-project',
          name: 'Ownerless Project',
          description: 'legacy payload without owner',
          createdDate: '2026-03-25T00:00:00.000Z',
          updatedAt: '2026-03-25T00:00:00.000Z',
          tasks: [],
          connections: [],
        },
      ],
      version: 6,
    }));

    const service = createOfflineSnapshotService({
      currentUserId: vi.fn(() => 'user-1'),
    });

    expect(service.loadOfflineSnapshot()).toBeNull();
  });

  it('loadStartupOfflineSnapshot 缺少 owner 元数据时不应把 scoped payload 归给当前用户', async () => {
    localStorage.setItem(getOfflineSnapshotStorageKey('user-1'), JSON.stringify({
      projects: [
        {
          id: 'startup-ownerless-project',
          name: 'Startup Ownerless Project',
          description: 'scoped key but payload has no owner',
          createdDate: '2026-03-25T00:00:00.000Z',
          updatedAt: '2026-03-25T00:00:00.000Z',
          tasks: [],
          connections: [],
        },
      ],
      version: 6,
      savedAt: '2026-04-11T00:00:00.000Z',
    }));

    const service = createOfflineSnapshotService({
      currentUserId: vi.fn(() => 'user-1'),
      peekPersistedSessionIdentity: vi.fn(() => null),
      peekPersistedOwnerHint: vi.fn(() => 'user-1'),
    });

    const snapshot = await service.loadStartupOfflineSnapshot();

    expect(snapshot.source).toBe('none');
    expect(snapshot.projectCount).toBe(0);
    expect(snapshot.projects).toEqual([]);
    expect(snapshot.ownerUserId).toBeNull();
  });
}
