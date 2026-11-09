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
import { ActionQueueService } from './action-queue.service';
import { ProjectDataService } from '../app/core/services/sync/project-data.service';
import { TaskSyncOperationsService } from '../app/core/services/sync/task-sync-operations.service';
import type { TombstoneQueryResult } from '../app/core/services/sync/task-sync-operations.types';
import type { Project, Task } from '../models';
import { registerRemoteChangeHandlerProjectRaceSpecs } from './remote-change-handler-project-race.spec-helpers';
import { registerRemoteChangeHandlerRoutingSpecs } from './remote-change-handler-routing.spec-helpers';
import { registerRemoteChangeHandlerDurableDirtyProtectionSpecs } from './remote-change-handler-durable-dirty-protection.spec-helpers';
import { registerRemoteChangeHandlerTaskRequestRaceSpecs } from './remote-change-handler-task-request-race.spec-helpers';

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
  let mockTaskSyncOps: { getTombstoneIdsWithStatus: SpyFn };
  let mockActionQueue: {
    getPendingActionsForProject: SpyFn;
    hasPendingActions: SpyFn;
    hasDurablePendingTaskMutation: SpyFn;
  };
  let mockChangeTracker: {
    hasUnsyncedChanges: SpyFn;
    pruneExpiredChanges: SpyFn;
    getPendingChange: SpyFn;
    getLockedFields: SpyFn;
  };
  let mockUndoService: { clearOutdatedHistory: SpyFn; clearTaskHistory: SpyFn };
  let mockUserSession: {
    currentUserId: SpyFn;
    getCurrentSessionGeneration: SpyFn;
    isSessionContextCurrent: SpyFn;
  };
  let currentUserId: string | null;
  let sessionGeneration: number;
  let localProjects: Project[];
  let mockProjectState: {
    projects: SpyFn;
    getProjectsWithCurrentData: SpyFn;
    activeProjectId: SpyFn;
    setActiveProjectId: SpyFn;
    updateProjects: SpyFn;
    getProject: SpyFn;
    getProjectWithCurrentData: SpyFn;
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
      hasPendingChangesForProject: vi.fn(),
      getAccessibleProjectProbe: vi.fn().mockResolvedValue({
        projectId: 'project-1',
        accessible: false,
        watermark: null,
      }),
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
    mockTaskSyncOps = {
      getTombstoneIdsWithStatus: vi.fn().mockResolvedValue({
        ids: new Set(),
        deletedAtByTaskId: new Map(),
        fromRemote: true,
        localCacheOnly: false,
        timestamp: Date.now(),
      } satisfies TombstoneQueryResult),
    };
    mockActionQueue = {
      getPendingActionsForProject: vi.fn().mockReturnValue([]),
      hasPendingActions: vi.fn().mockReturnValue(false),
      hasDurablePendingTaskMutation: vi.fn().mockReturnValue(false),
    };
    mockSyncCoordinator.hasPendingChangesForProject.mockImplementation(
      (projectId: string) => (
        (mockActionQueue.getPendingActionsForProject as (id: string) => unknown[])(projectId).length > 0
      ),
    );
    mockChangeTracker = {
      hasUnsyncedChanges: vi.fn().mockReturnValue(false),
      pruneExpiredChanges: vi.fn(),
      getPendingChange: vi.fn().mockReturnValue(null),
      getLockedFields: vi.fn().mockReturnValue([]),
    };
    mockUndoService = {
      clearOutdatedHistory: vi.fn().mockReturnValue(0),
      clearTaskHistory: vi.fn(),
    };
    currentUserId = 'user-123';
    sessionGeneration = 1;
    mockUserSession = {
      currentUserId: vi.fn(() => currentUserId),
      getCurrentSessionGeneration: vi.fn(() => sessionGeneration),
      isSessionContextCurrent: vi.fn((generation: number, userId: string | null) => (
        generation === sessionGeneration && userId === currentUserId
      )),
    };

    localProjects = [];
    mockProjectState = {
      projects: vi.fn(() => localProjects),
      getProjectsWithCurrentData: vi.fn(() => localProjects),
      activeProjectId: vi.fn().mockReturnValue(null),
      setActiveProjectId: vi.fn(),
      updateProjects: vi.fn((updater: (projects: Project[]) => Project[]) => {
        localProjects = updater(localProjects);
      }),
      getProject: vi.fn((projectId: string) => localProjects.find(project => project.id === projectId)),
      getProjectWithCurrentData: vi.fn((projectId: string) => localProjects.find(project => project.id === projectId)),
    };
    
    TestBed.configureTestingModule({
      providers: [
        RemoteChangeHandlerService,
        { provide: SyncCoordinatorService, useValue: mockSyncCoordinator },
        { provide: ProjectDataService, useValue: {
          loadFullProject: mockSyncCoordinator.core.loadSingleProject,
          getAccessibleProjectProbe: vi.fn(),
        } },
        { provide: TaskSyncOperationsService, useValue: mockTaskSyncOps },
        { provide: ActionQueueService, useValue: mockActionQueue },
        { provide: UndoService, useValue: mockUndoService },
        { provide: UiStateService, useValue: mockUiState },
        { provide: ProjectStateService, useValue: mockProjectState },
        { provide: ToastService, useValue: mockToast },
        { provide: AuthService, useValue: { currentUserId: vi.fn(() => currentUserId) } },
        { provide: UserSessionService, useValue: mockUserSession },
        { provide: LoggerService, useValue: { category: () => mockLogger } },
        { provide: ChangeTrackerService, useValue: mockChangeTracker },
        { provide: PermissionDeniedHandlerService, useValue: mockPermissionDeniedHandler }
      ]
    });
    
    service = TestBed.inject(RemoteChangeHandlerService);
  });

  registerRemoteChangeHandlerProjectRaceSpecs({
    service: () => service,
    projectChangeCallback: () => projectChangeCallback!,
    localProjects: () => localProjects,
    setLocalProjects: projects => { localProjects = projects; },
    setCurrentUserId: userId => { currentUserId = userId; },
    setSessionGeneration: generation => { sessionGeneration = generation; },
    syncCoordinator: () => mockSyncCoordinator,
    taskSyncOps: () => mockTaskSyncOps,
    projectState: () => mockProjectState,
    undoService: () => mockUndoService,
  });

  registerRemoteChangeHandlerRoutingSpecs({
    service: () => service,
    projectChangeCallback: () => projectChangeCallback!,
    taskChangeCallback: () => taskChangeCallback,
    syncCoordinator: () => mockSyncCoordinator,
    logger: () => mockLogger,
    actionQueue: () => mockActionQueue,
    localProjects: () => localProjects,
    setLocalProjects: projects => { localProjects = projects; },
  });

  registerRemoteChangeHandlerDurableDirtyProtectionSpecs({
    service: () => service,
    projectChangeCallback: () => projectChangeCallback!,
    taskChangeCallback: () => taskChangeCallback!,
    localProjects: () => localProjects,
    setLocalProjects: projects => { localProjects = projects; },
    projectState: () => mockProjectState,
    syncCoordinator: () => mockSyncCoordinator,
    taskSyncOps: () => mockTaskSyncOps,
    actionQueue: () => mockActionQueue,
    changeTracker: () => mockChangeTracker,
  });

  registerRemoteChangeHandlerTaskRequestRaceSpecs({
    service: () => service,
    taskChangeCallback: () => taskChangeCallback!,
    localProjects: () => localProjects,
    setLocalProjects: projects => { localProjects = projects; },
    setCurrentUserId: userId => { currentUserId = userId; },
    setSessionGeneration: generation => { sessionGeneration = generation; },
    projectState: () => ({
      activeProjectId: mockProjectState.activeProjectId,
      updateProjects: mockProjectState.updateProjects,
    }),
    syncCoordinator: () => mockSyncCoordinator,
    logger: () => mockLogger,
    permissionDeniedHandler: () => mockPermissionDeniedHandler,
    toast: () => mockToast,
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

  it('项目级软删除不得在 tombstone-aware merge 前移除更新更晚的本地任务', async () => {
    const localTask = createTask({
      id: 'task-local-newer',
      updatedAt: '2026-02-03T00:00:00.000Z',
    });
    localProjects = [createProject({
      id: 'project-1',
      version: 1,
      tasks: [localTask],
    })];
    mockSyncCoordinator.core.loadSingleProject.mockResolvedValueOnce(createProject({
      id: 'project-1',
      version: 2,
      tasks: [createTask({
        id: 'task-local-newer',
        updatedAt: '2026-02-02T00:00:00.000Z',
        deletedAt: '2026-02-02T00:00:00.000Z',
      })],
    }));
    mockTaskSyncOps.getTombstoneIdsWithStatus.mockResolvedValueOnce({
      ids: new Set(['task-local-newer']),
      deletedAtByTaskId: new Map([
        ['task-local-newer', Date.parse('2026-02-02T00:00:00.000Z')],
      ]),
      fromRemote: true,
      localCacheOnly: false,
      timestamp: Date.now(),
    } satisfies TombstoneQueryResult);
    mockSyncCoordinator.smartMerge.mockImplementationOnce((local: Project) => ({
      project: local,
      conflictCount: 0,
    }));
    service.setupCallbacks(vi.fn().mockResolvedValue(undefined));

    await projectChangeCallback!({ eventType: 'UPDATE', projectId: 'project-1' });

    expect(mockSyncCoordinator.smartMerge).toHaveBeenCalledWith(
      expect.objectContaining({
        tasks: [expect.objectContaining({ id: 'task-local-newer' })],
      }),
      expect.anything(),
      expect.objectContaining({
        ids: new Set(['task-local-newer']),
      }),
    );
    expect(localProjects[0].tasks.map(task => task.id)).toEqual(['task-local-newer']);
  });

  it('项目级合并必须使用当前 TaskStore 数据而不是陈旧 ProjectStore 壳', async () => {
    localProjects = [createProject({
      id: 'project-1',
      version: 1,
      tasks: [createTask({ id: 'task-1', stage: null, rank: 0 })],
    })];
    const currentDataProject = createProject({
      id: 'project-1',
      version: 1,
      tasks: [
        createTask({
          id: 'task-1',
          stage: 2,
          rank: 2000,
          updatedAt: '2026-02-03T00:01:00.000Z',
        }),
        createTask({
          id: 'task-2',
          stage: 3,
          rank: 3000,
          updatedAt: '2026-02-03T00:02:00.000Z',
        }),
      ],
    });
    mockProjectState.getProjectWithCurrentData.mockReturnValue(currentDataProject);
    mockSyncCoordinator.core.loadSingleProject.mockResolvedValueOnce(createProject({
      id: 'project-1',
      version: 2,
      tasks: currentDataProject.tasks,
    }));
    mockSyncCoordinator.smartMerge.mockImplementationOnce((local: Project) => ({
      project: local,
      conflictCount: 0,
    }));
    service.setupCallbacks(vi.fn().mockResolvedValue(undefined));

    await projectChangeCallback!({ eventType: 'UPDATE', projectId: 'project-1' });

    expect(mockSyncCoordinator.smartMerge).toHaveBeenCalledWith(
      expect.objectContaining({
        tasks: expect.arrayContaining([
          expect.objectContaining({ id: 'task-1', stage: 2, rank: 2000 }),
          expect.objectContaining({ id: 'task-2', stage: 3, rank: 3000 }),
        ]),
      }),
      expect.anything(),
      expect.anything(),
    );
    expect(localProjects[0].tasks.map(task => task.id).sort()).toEqual(['task-1', 'task-2']);
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

    it('缺少 projectId 的 DELETE 必须从当前 TaskStore 投影定位任务项目', () => {
      localProjects = [createProject({ id: 'project-1', tasks: [] })];
      mockProjectState.getProjectsWithCurrentData.mockReturnValue([
        createProject({
          id: 'project-1',
          tasks: [createTask({ id: 'task-1', stage: 2 })],
        }),
      ]);
      mockProjectState.activeProjectId.mockReturnValue('project-1');
      mockSyncCoordinator.core.loadSingleProject.mockResolvedValueOnce(createProject({
        id: 'project-1',
        tasks: [],
      }));
      service.setupCallbacks(vi.fn().mockResolvedValue(undefined));

      taskChangeCallback!({
        eventType: 'DELETE',
        taskId: 'task-1',
      });

      expect(mockSyncCoordinator.core.loadSingleProject).toHaveBeenCalledWith('project-1', 'user-123');
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

    it('DELETE tombstone 早于本地任务更新时间时必须保留本地任务', async () => {
      localProjects = [createProject({
        id: 'project-1',
        tasks: [createTask({
          id: 'task-1',
          updatedAt: '2026-02-03T00:00:00.000Z',
        })],
      })];
      mockProjectState.activeProjectId.mockReturnValue('project-1');
      mockSyncCoordinator.core.loadSingleProject.mockResolvedValueOnce(createProject({
        id: 'project-1',
        tasks: [],
      }));
      mockTaskSyncOps.getTombstoneIdsWithStatus.mockResolvedValueOnce({
        ids: new Set(['task-1']),
        deletedAtByTaskId: new Map([
          ['task-1', Date.parse('2026-02-02T00:00:00.000Z')],
        ]),
        fromRemote: true,
        localCacheOnly: false,
        timestamp: Date.now(),
      } satisfies TombstoneQueryResult);
      service.setupCallbacks(vi.fn().mockResolvedValue(undefined));

      taskChangeCallback!({
        eventType: 'DELETE',
        taskId: 'task-1',
        projectId: 'project-1',
      });
      await flushPromises();
      await flushPromises();

      expect(localProjects[0].tasks.map(task => task.id)).toEqual(['task-1']);
      expect(mockUndoService.clearTaskHistory).not.toHaveBeenCalled();
    });

    it('DELETE tombstone 晚于本地任务更新时间时应确认删除本地任务', async () => {
      localProjects = [createProject({
        id: 'project-1',
        tasks: [createTask({
          id: 'task-1',
          updatedAt: '2026-02-02T00:00:00.000Z',
        })],
      })];
      mockProjectState.activeProjectId.mockReturnValue('project-1');
      mockSyncCoordinator.core.loadSingleProject.mockResolvedValueOnce(createProject({
        id: 'project-1',
        tasks: [],
      }));
      mockTaskSyncOps.getTombstoneIdsWithStatus.mockResolvedValueOnce({
        ids: new Set(['task-1']),
        deletedAtByTaskId: new Map([
          ['task-1', Date.parse('2026-02-03T00:00:00.000Z')],
        ]),
        fromRemote: true,
        localCacheOnly: false,
        timestamp: Date.now(),
      } satisfies TombstoneQueryResult);
      service.setupCallbacks(vi.fn().mockResolvedValue(undefined));

      taskChangeCallback!({
        eventType: 'DELETE',
        taskId: 'task-1',
        projectId: 'project-1',
      });
      await flushPromises();
      await flushPromises();

      expect(localProjects[0].tasks).toEqual([]);
      expect(mockUndoService.clearTaskHistory).toHaveBeenCalledWith('task-1', 'project-1');
    });

    it('DELETE 仅有 local-cache tombstone 证据时必须保留本地任务', async () => {
      localProjects = [createProject({
        id: 'project-1',
        tasks: [createTask({
          id: 'task-1',
          updatedAt: '2026-02-02T00:00:00.000Z',
        })],
      })];
      mockProjectState.activeProjectId.mockReturnValue('project-1');
      mockSyncCoordinator.core.loadSingleProject.mockResolvedValueOnce(createProject({
        id: 'project-1',
        tasks: [],
      }));
      mockTaskSyncOps.getTombstoneIdsWithStatus.mockResolvedValueOnce({
        ids: new Set(['task-1']),
        deletedAtByTaskId: new Map([
          ['task-1', Date.parse('2026-02-03T00:00:00.000Z')],
        ]),
        fromRemote: false,
        localCacheOnly: true,
        timestamp: Date.now(),
      } satisfies TombstoneQueryResult);
      service.setupCallbacks(vi.fn().mockResolvedValue(undefined));

      taskChangeCallback!({
        eventType: 'DELETE',
        taskId: 'task-1',
        projectId: 'project-1',
      });
      await flushPromises();
      await flushPromises();

      expect(localProjects[0].tasks.map(task => task.id)).toEqual(['task-1']);
      expect(mockUndoService.clearTaskHistory).not.toHaveBeenCalled();
      expect(mockLogger.warn).toHaveBeenCalledWith(
        '远程任务删除仅有本地 tombstone 缓存证据，已保留本地任务',
        expect.objectContaining({ taskId: 'task-1', projectId: 'project-1' }),
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
        expect.objectContaining({
          ownerUserId: 'user-123',
          shouldNotify: expect.any(Function),
        }),
      );
      expect(mockToast.warning).not.toHaveBeenCalled();
    });

    it('任务级幂等检查必须使用当前 TaskStore revision 而不是陈旧项目壳', async () => {
      localProjects = [createProject({
        id: 'project-1',
        tasks: [createTask({
          id: 'task-1',
          title: 'Stale shell',
          updatedAt: '2026-02-03T00:00:00.000Z',
        })],
      })];
      const currentDataProject = createProject({
        id: 'project-1',
        tasks: [createTask({
          id: 'task-1',
          title: 'Current local',
          stage: 2,
          updatedAt: '2026-02-03T00:02:00.000Z',
        })],
      });
      mockProjectState.getProjectWithCurrentData.mockReturnValue(currentDataProject);
      mockProjectState.activeProjectId.mockReturnValue('project-1');
      mockSyncCoordinator.core.loadSingleProject.mockResolvedValueOnce(createProject({
        id: 'project-1',
        tasks: [createTask({
          id: 'task-1',
          title: 'Older remote',
          stage: null,
          updatedAt: '2026-02-03T00:01:00.000Z',
        })],
      }));
      service.setupCallbacks(vi.fn().mockResolvedValue(undefined));

      taskChangeCallback!({
        eventType: 'UPDATE',
        taskId: 'task-1',
        projectId: 'project-1',
      });
      await flushPromises();
      await flushPromises();

      expect(mockProjectState.getProjectWithCurrentData).toHaveBeenCalledWith('project-1');
      expect(mockProjectState.updateProjects).not.toHaveBeenCalled();
      expect(mockLogger.debug).toHaveBeenCalledWith(
        '幂等检查：跳过过时或相同版本的远程更新',
        expect.objectContaining({ taskId: 'task-1' }),
      );
    });

    it('权限错误数据保全必须从当前 TaskStore 读取受影响任务', async () => {
      const affectedTask = createTask({ id: 'task-1', title: 'Current local task', stage: 2 });
      const expectedSnapshot = structuredClone(affectedTask);
      localProjects = [createProject({ id: 'project-1', tasks: [] })];
      mockProjectState.getProjectWithCurrentData.mockReturnValue(createProject({
        id: 'project-1',
        tasks: [affectedTask],
      }));
      mockProjectState.activeProjectId.mockReturnValue('project-1');
      mockSyncCoordinator.core.loadSingleProject.mockRejectedValueOnce({
        error: {
          code: '42501',
          message: 'permission denied for table tasks',
        },
        status: 401,
      });
      service.setupCallbacks(vi.fn().mockResolvedValue(undefined));

      taskChangeCallback!({
        eventType: 'UPDATE',
        taskId: 'task-1',
        projectId: 'project-1',
      });
      affectedTask.title = 'Changed after request start';
      await flushPromises();
      await flushPromises();

      expect(mockPermissionDeniedHandler.handlePermissionDenied).toHaveBeenCalledWith(
        expect.anything(),
        [expectedSnapshot],
        'project-1',
        expect.objectContaining({
          ownerUserId: 'user-123',
          shouldNotify: expect.any(Function),
        }),
      );
      const permissionContext = mockPermissionDeniedHandler.handlePermissionDenied.mock.calls[0][3] as {
        ownerUserId: string;
        shouldNotify: () => boolean;
      };
      expect(permissionContext.shouldNotify()).toBe(true);
      currentUserId = 'user-456';
      sessionGeneration = 2;
      expect(permissionContext.shouldNotify()).toBe(false);
    });

  });
});
