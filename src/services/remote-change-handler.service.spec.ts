/**
 * RemoteChangeHandlerService 单元测试
 * 
 * 覆盖场景：
 * 1. Polling 事件正确路由到 onLoadProjects
 * 2. Realtime 事件正确路由到 handleIncrementalUpdate
 * 3. 编辑保护机制
 * 4. 回声保护机制
 */
import { TestBed } from '@angular/core/testing';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { RemoteChangeHandlerService, RemoteProjectChangePayload, RemoteTaskChangePayload } from './remote-change-handler.service';
import { SyncCoordinatorService } from './sync-coordinator.service';
import { UndoService } from './undo.service';
import { UiStateService } from './ui-state.service';
import { ProjectStateService } from './project-state.service';
import { ToastService } from './toast.service';
import { AuthService } from './auth.service';
import { LoggerService } from './logger.service';
import { ChangeTrackerService } from './change-tracker.service';
import { PermissionDeniedHandlerService } from './permission-denied-handler.service';
import { UserSessionService } from './user-session.service';
import { ProjectDataService } from '../app/core/services/sync/project-data.service';
import type { Connection, Project, Task } from '../models';

type SpyFn = ReturnType<typeof vi.fn>;
type ProjectChangeCallbackPayload = { eventType?: string; projectId?: string } | undefined;

function createTask(overrides: Partial<Task> = {}): Task {
  return {
    id: overrides.id ?? 'task-1',
    title: overrides.title ?? 'Task',
    content: overrides.content ?? '',
    stage: overrides.stage ?? 1,
    parentId: overrides.parentId ?? null,
    order: overrides.order ?? 1,
    rank: overrides.rank ?? 1000,
    status: overrides.status ?? 'active',
    x: overrides.x ?? 0,
    y: overrides.y ?? 0,
    createdDate: overrides.createdDate ?? '2026-01-01T00:00:00.000Z',
    updatedAt: overrides.updatedAt ?? '2026-01-01T00:00:00.000Z',
    displayId: overrides.displayId ?? '?',
    deletedAt: overrides.deletedAt,
  };
}

function createProject(overrides: Partial<Project> = {}): Project {
  return {
    id: overrides.id ?? 'project-1',
    name: overrides.name ?? 'Project',
    description: overrides.description ?? '',
    createdDate: overrides.createdDate ?? '2026-01-01T00:00:00.000Z',
    updatedAt: overrides.updatedAt,
    version: overrides.version,
    tasks: overrides.tasks ?? [],
    connections: overrides.connections ?? [],
  };
}

function createConnection(overrides: Partial<Connection> = {}): Connection {
  return {
    id: overrides.id ?? 'conn-1',
    source: overrides.source ?? 'task-1',
    target: overrides.target ?? 'task-2',
    deletedAt: overrides.deletedAt,
    updatedAt: overrides.updatedAt,
  };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('RemoteChangeHandlerService', () => {
  let service: RemoteChangeHandlerService;
  let mockSyncCoordinator: {
    setupRemoteChangeCallbacks: SpyFn;
    hasPendingLocalChanges: SpyFn;
    hasPendingChangesForProject: SpyFn;
    subscribeToProjectPendingWriteStateChanges: SpyFn;
    getAccessibleProjectProbe: SpyFn;
    getLastPersistAt: SpyFn;
    getTombstoneIds: SpyFn;
    smartMerge: SpyFn;
    validateAndRebalance: SpyFn;
    core: { loadSingleProject: SpyFn };
  };
  let mockUiState: { isEditing: boolean };
  let mockLogger: { debug: SpyFn; info: SpyFn; warn: SpyFn; error: SpyFn };
  let mockToast: { info: SpyFn; warning: SpyFn };
  let mockPermissionDeniedHandler: { handlePermissionDenied: SpyFn };
  let localProjects: Project[];
  let mockProjectState: {
    projects: SpyFn;
    activeProjectId: SpyFn;
    setActiveProjectId: SpyFn;
    updateProjects: SpyFn;
    getProject: SpyFn;
  };
  let projectChangeCallback: ((payload: ProjectChangeCallbackPayload) => Promise<void>) | null = null;
  let taskChangeCallback: ((payload: Partial<RemoteTaskChangePayload>) => void) | null = null;
  
  beforeEach(() => {
    projectChangeCallback = null;
    taskChangeCallback = null;
    
    mockLogger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    };
    
    mockSyncCoordinator = {
      setupRemoteChangeCallbacks: vi.fn((projectCb, taskCb) => {
        projectChangeCallback = projectCb;
        taskChangeCallback = taskCb;
      }),
      hasPendingLocalChanges: vi.fn().mockReturnValue(false),
      hasPendingChangesForProject: vi.fn().mockReturnValue(false),
      subscribeToProjectPendingWriteStateChanges: vi.fn(() => () => {}),
      getAccessibleProjectProbe: vi.fn().mockResolvedValue({ accessible: false, watermark: null }),
      getLastPersistAt: vi.fn().mockReturnValue(0),
      getTombstoneIds: vi.fn().mockResolvedValue(new Set()),
      smartMerge: vi.fn((local, remote) => ({ project: remote, conflictCount: 0 })),
      validateAndRebalance: vi.fn(p => p),
      // core 子对象：deprecated 方法迁移后的新调用路径
      core: {
        loadSingleProject: vi.fn().mockResolvedValue(null)
      }
    };
    
    mockUiState = {
      isEditing: false
    };
    mockToast = {
      info: vi.fn(),
      warning: vi.fn(),
    };
    mockPermissionDeniedHandler = {
      handlePermissionDenied: vi.fn().mockResolvedValue(undefined),
    };

    localProjects = [];
    mockProjectState = {
      projects: vi.fn(() => localProjects),
      activeProjectId: vi.fn().mockReturnValue(null),
      setActiveProjectId: vi.fn(),
      updateProjects: vi.fn((updater: (projects: Project[]) => Project[]) => {
        localProjects = updater(localProjects);
      }),
      getProject: vi.fn((projectId: string) => localProjects.find(project => project.id === projectId)),
    };
    
    TestBed.configureTestingModule({
      providers: [
        RemoteChangeHandlerService,
        { provide: SyncCoordinatorService, useValue: mockSyncCoordinator },
        { provide: ProjectDataService, useValue: {
          loadFullProject: mockSyncCoordinator.core.loadSingleProject,
          getAccessibleProjectProbe: vi.fn(),
        } },
        { provide: UndoService, useValue: { clearOutdatedHistory: vi.fn(), clearTaskHistory: vi.fn() } },
        { provide: UiStateService, useValue: mockUiState },
        { provide: ProjectStateService, useValue: mockProjectState },
        { provide: ToastService, useValue: mockToast },
        { provide: AuthService, useValue: { currentUserId: vi.fn().mockReturnValue('user-123') } },
        { provide: UserSessionService, useValue: {
          currentUserId: vi.fn().mockReturnValue('user-123'),
          getCurrentSessionGeneration: vi.fn().mockReturnValue(1),
          isSessionContextCurrent: vi.fn((generation: number, userId: string) => (
            generation === 1 && userId === 'user-123'
          )),
        } },
        { provide: LoggerService, useValue: { category: () => mockLogger } },
        { provide: ChangeTrackerService, useValue: {
          hasUnsyncedChanges: vi.fn().mockReturnValue(false),
          pruneExpiredChanges: vi.fn(),
          getPendingChange: vi.fn().mockReturnValue(null),
          getLockedFields: vi.fn().mockReturnValue([])
        } },
        { provide: PermissionDeniedHandlerService, useValue: mockPermissionDeniedHandler }
      ]
    });
    
    service = TestBed.inject(RemoteChangeHandlerService);
  });

  describe('setupCallbacks', () => {
    it('应正确设置回调', () => {
      const onLoadProjects = vi.fn().mockResolvedValue(undefined);
      
      service.setupCallbacks(onLoadProjects);
      
      expect(mockSyncCoordinator.setupRemoteChangeCallbacks).toHaveBeenCalled();
      expect(projectChangeCallback).toBeTruthy();
      expect(taskChangeCallback).toBeTruthy();
    });
    
    it('重复调用应记录警告并跳过', () => {
      const onLoadProjects = vi.fn().mockResolvedValue(undefined);
      
      service.setupCallbacks(onLoadProjects);
      service.setupCallbacks(onLoadProjects);
      
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'setupCallbacks 已被调用过，跳过重复初始化'
      );
      // 只应调用一次
      expect(mockSyncCoordinator.setupRemoteChangeCallbacks).toHaveBeenCalledTimes(1);
    });
  });

  describe('Polling 事件路由', () => {
    it('polling 事件应调用 onLoadProjects 而非 handleIncrementalUpdate', async () => {
      const onLoadProjects = vi.fn().mockResolvedValue(undefined);
      
      service.setupCallbacks(onLoadProjects);
      
      // 模拟 polling 事件
      const pollingPayload = { eventType: 'polling', projectId: 'project-1' };
      await projectChangeCallback!(pollingPayload);
      
      expect(onLoadProjects).toHaveBeenCalled();
      // 不应调用 loadSingleProject（handleIncrementalUpdate 的标志）
      expect(mockSyncCoordinator.core.loadSingleProject).not.toHaveBeenCalled();
    });

    it('配置 onRefreshActiveProject 时应优先走活动项目静默刷新', async () => {
      const onLoadProjects = vi.fn().mockResolvedValue(undefined);
      const onRefreshActiveProject = vi.fn().mockResolvedValue(undefined);

      service.setupCallbacks({
        onLoadProjects,
        onRefreshActiveProject,
      });

      await projectChangeCallback!({ eventType: 'polling', projectId: 'project-1' });

      expect(onRefreshActiveProject).toHaveBeenCalledWith('remote:polling');
      expect(onLoadProjects).not.toHaveBeenCalled();
      expect(mockSyncCoordinator.core.loadSingleProject).not.toHaveBeenCalled();
    });
    
    it('无 eventType 的事件应调用 onLoadProjects', async () => {
      const onLoadProjects = vi.fn().mockResolvedValue(undefined);
      
      service.setupCallbacks(onLoadProjects);
      
      // 模拟无 eventType 的事件
      const payload = { projectId: 'project-1' };
      await projectChangeCallback!(payload);
      
      expect(onLoadProjects).toHaveBeenCalled();
    });
  });

  describe('Realtime 事件路由', () => {
    it('INSERT 事件应调用 handleIncrementalUpdate', async () => {
      const onLoadProjects = vi.fn().mockResolvedValue(undefined);
      
      service.setupCallbacks(onLoadProjects);
      
      // 模拟 INSERT 事件
      const insertPayload: RemoteProjectChangePayload = { 
        eventType: 'INSERT', 
        projectId: 'project-1' 
      };
      await projectChangeCallback!(insertPayload);
      
      // handleIncrementalUpdate 会调用 loadSingleProject
      expect(mockSyncCoordinator.core.loadSingleProject).toHaveBeenCalledWith('project-1', 'user-123');
      // 不应调用 onLoadProjects
      expect(onLoadProjects).not.toHaveBeenCalled();
    });
    
    it('UPDATE 事件应调用 handleIncrementalUpdate', async () => {
      const onLoadProjects = vi.fn().mockResolvedValue(undefined);
      
      service.setupCallbacks(onLoadProjects);
      
      const updatePayload: RemoteProjectChangePayload = { 
        eventType: 'UPDATE', 
        projectId: 'project-1' 
      };
      await projectChangeCallback!(updatePayload);
      
      expect(mockSyncCoordinator.core.loadSingleProject).toHaveBeenCalled();
      expect(onLoadProjects).not.toHaveBeenCalled();
    });

    it('stale project UPDATE 不应在版本检查前应用远端删除集合', async () => {
      localProjects = [
        createProject({
          id: 'project-1',
          version: 5,
          tasks: [
            createTask({ id: 'task-still-local' }),
            createTask({ id: 'task-other' }),
          ],
          connections: [
            createConnection({
              id: 'conn-still-local',
              source: 'task-still-local',
              target: 'task-other',
            }),
          ],
        }),
      ];
      mockSyncCoordinator.core.loadSingleProject.mockResolvedValueOnce(createProject({
        id: 'project-1',
        version: 4,
        tasks: [
          createTask({
            id: 'task-still-local',
            deletedAt: '2026-02-01T00:00:00.000Z',
          }),
          createTask({ id: 'task-other' }),
        ],
        connections: [
          createConnection({
            id: 'conn-still-local',
            source: 'task-still-local',
            target: 'task-other',
            deletedAt: '2026-02-01T00:00:00.000Z',
          }),
        ],
      }));

      service.setupCallbacks(vi.fn().mockResolvedValue(undefined));

      await projectChangeCallback!({
        eventType: 'UPDATE',
        projectId: 'project-1',
      });

      expect(localProjects[0].tasks.map(task => task.id)).toEqual([
        'task-still-local',
        'task-other',
      ]);
      expect(localProjects[0].connections.map(connection => connection.id)).toEqual([
        'conn-still-local',
      ]);
      expect(mockSyncCoordinator.smartMerge).not.toHaveBeenCalled();
    });
    
    it('DELETE 事件应调用 handleIncrementalUpdate', async () => {
      const onLoadProjects = vi.fn().mockResolvedValue(undefined);
      
      service.setupCallbacks(onLoadProjects);
      
      const deletePayload: RemoteProjectChangePayload = { 
        eventType: 'DELETE', 
        projectId: 'project-1' 
      };
      await projectChangeCallback!(deletePayload);
      
      // DELETE 事件不调用 loadSingleProject，而是直接从本地删除
      // 但也不应调用 onLoadProjects
      expect(onLoadProjects).not.toHaveBeenCalled();
    });
  });

  describe('编辑保护', () => {
    it('用户编辑中时应跳过远程项目更新', async () => {
      mockUiState.isEditing = true;
      
      const onLoadProjects = vi.fn().mockResolvedValue(undefined);
      service.setupCallbacks(onLoadProjects);
      
      const payload: RemoteProjectChangePayload = { 
        eventType: 'UPDATE', 
        projectId: 'project-1' 
      };
      await projectChangeCallback!(payload);
      
      // 应跳过更新
      expect(mockSyncCoordinator.core.loadSingleProject).not.toHaveBeenCalled();
      expect(mockLogger.debug).toHaveBeenCalledWith('跳过项目级远程更新');
    });
    
    it('有待同步本地变更时应跳过远程项目更新', async () => {
      mockSyncCoordinator.hasPendingLocalChanges.mockReturnValue(true);
      
      const onLoadProjects = vi.fn().mockResolvedValue(undefined);
      service.setupCallbacks(onLoadProjects);
      
      const payload: RemoteProjectChangePayload = { 
        eventType: 'UPDATE', 
        projectId: 'project-1' 
      };
      await projectChangeCallback!(payload);
      
      expect(mockSyncCoordinator.core.loadSingleProject).not.toHaveBeenCalled();
      expect(mockLogger.debug).toHaveBeenCalledWith(
        '跳过远程项目更新',
        expect.objectContaining({ hasPendingLocalChanges: true })
      );
    });
    
    it('刚完成持久化时应跳过远程项目更新（防止回声）', async () => {
      // 模拟刚刚持久化
      mockSyncCoordinator.getLastPersistAt.mockReturnValue(Date.now() - 1000); // 1秒前
      
      const onLoadProjects = vi.fn().mockResolvedValue(undefined);
      service.setupCallbacks(onLoadProjects);
      
      const payload: RemoteProjectChangePayload = { 
        eventType: 'UPDATE', 
        projectId: 'project-1' 
      };
      await projectChangeCallback!(payload);
      
      expect(mockSyncCoordinator.core.loadSingleProject).not.toHaveBeenCalled();
      expect(mockLogger.debug).toHaveBeenCalledWith(
        '跳过远程项目更新',
        expect.objectContaining({ inEditGuard: true })
      );
    });
  });

  describe('任务级更新', () => {
    it('DELETE 事件应在回声保护窗口内被跳过', () => {
      mockSyncCoordinator.getLastPersistAt.mockReturnValue(Date.now() - 1000); // 1秒前
      
      const onLoadProjects = vi.fn().mockResolvedValue(undefined);
      service.setupCallbacks(onLoadProjects);
      
      const taskPayload = { 
        eventType: 'DELETE', 
        taskId: 'task-1',
        projectId: 'project-1' 
      } as const;
      taskChangeCallback!(taskPayload);
      
      expect(mockLogger.debug).toHaveBeenCalledWith(
        '跳过任务级远程更新',
        expect.objectContaining({ eventType: 'DELETE', taskId: 'task-1' })
      );
    });
    
    it('回声保护窗口外的任务更新应正常处理', () => {
      mockSyncCoordinator.getLastPersistAt.mockReturnValue(Date.now() - 5000); // 5秒前
      
      const onLoadProjects = vi.fn().mockResolvedValue(undefined);
      service.setupCallbacks(onLoadProjects);
      
      const taskPayload = { 
        eventType: 'UPDATE', 
        taskId: 'task-1',
        projectId: 'project-1' 
      } as const;
      taskChangeCallback!(taskPayload);
      
      // 不应记录跳过日志
      expect(mockLogger.debug).not.toHaveBeenCalledWith(
        '跳过任务级远程更新',
        expect.anything()
      );
    });

    it('PostgREST 权限包装错误应进入任务数据保全而不是普通刷新提示', async () => {
      const affectedTask = createTask({ id: 'task-1', title: 'Local task' });
      localProjects = [
        createProject({
          id: 'project-1',
          tasks: [affectedTask],
        }),
      ];
      mockProjectState.activeProjectId.mockReturnValue('project-1');
      mockSyncCoordinator.core.loadSingleProject.mockRejectedValueOnce({
        error: {
          code: '42501',
          message: 'permission denied for table tasks',
          details: null,
          hint: 'Grant access to the tasks table',
        },
        status: 401,
        statusText: 'Unauthorized',
      });

      service.setupCallbacks(vi.fn().mockResolvedValue(undefined));

      taskChangeCallback!({
        eventType: 'UPDATE',
        taskId: 'task-1',
        projectId: 'project-1',
      });
      await flushPromises();
      await flushPromises();

      expect(mockPermissionDeniedHandler.handlePermissionDenied).toHaveBeenCalledWith(
        expect.objectContaining({
          errorType: 'PermissionError',
          code: '42501',
          status: 401,
        }),
        [affectedTask],
        'project-1',
      );
      expect(mockToast.warning).not.toHaveBeenCalled();
    });

    it('tombstone 加载期间被新请求取代的任务更新不应再写入本地项目', async () => {
      let resolveTombstones: (ids: Set<string>) => void = () => undefined;
      localProjects = [
        createProject({
          id: 'project-1',
          tasks: [
            createTask({
              id: 'task-1',
              title: 'Local title',
              updatedAt: '2026-01-01T00:00:00.000Z',
            }),
          ],
        }),
      ];
      mockProjectState.activeProjectId.mockReturnValue('project-1');
      mockSyncCoordinator.core.loadSingleProject
        .mockResolvedValueOnce(createProject({
          id: 'project-1',
          tasks: [
            createTask({
              id: 'task-1',
              title: 'Remote title',
              updatedAt: '2026-02-01T00:00:00.000Z',
            }),
          ],
        }))
        .mockImplementationOnce(() => new Promise<Project | null>(() => undefined));
      mockSyncCoordinator.getTombstoneIds.mockImplementationOnce(() => new Promise<Set<string>>(resolve => {
        resolveTombstones = resolve;
      }));

      service.setupCallbacks(vi.fn().mockResolvedValue(undefined));

      taskChangeCallback!({
        eventType: 'UPDATE',
        taskId: 'task-1',
        projectId: 'project-1',
      });
      await flushPromises();

      taskChangeCallback!({
        eventType: 'UPDATE',
        taskId: 'task-2',
        projectId: 'project-1',
      });
      resolveTombstones(new Set());
      await flushPromises();

      expect(localProjects[0].tasks[0].title).toBe('Local title');
      expect(mockLogger.debug).toHaveBeenCalledWith(
        '远程任务更新已被更新请求取代',
        expect.objectContaining({ requestId: 1, currentId: 2 }),
      );
    });
  });
});
