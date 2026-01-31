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
import { RemoteChangeHandlerService, RemoteProjectChangePayload } from './remote-change-handler.service';
import { SyncCoordinatorService } from './sync-coordinator.service';
import { UndoService } from './undo.service';
import { UiStateService } from './ui-state.service';
import { ProjectStateService } from './project-state.service';
import { ToastService } from './toast.service';
import { AuthService } from './auth.service';
import { LoggerService } from './logger.service';
import { ChangeTrackerService } from './change-tracker.service';
import { PermissionDeniedHandlerService } from './permission-denied-handler.service';

describe('RemoteChangeHandlerService', () => {
  let service: RemoteChangeHandlerService;
  let mockSyncCoordinator: any;
  let mockUiState: any;
  let mockLogger: any;
  let projectChangeCallback: ((payload: any) => Promise<void>) | null = null;
  let taskChangeCallback: ((payload: any) => void) | null = null;
  
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
    
    TestBed.configureTestingModule({
      providers: [
        RemoteChangeHandlerService,
        { provide: SyncCoordinatorService, useValue: mockSyncCoordinator },
        { provide: UndoService, useValue: { clearOutdatedHistory: vi.fn() } },
        { provide: UiStateService, useValue: mockUiState },
        { provide: ProjectStateService, useValue: { 
          projects: vi.fn().mockReturnValue([]),
          activeProjectId: vi.fn().mockReturnValue(null),
          setActiveProjectId: vi.fn(),
          updateProjects: vi.fn()
        }},
        { provide: ToastService, useValue: { info: vi.fn(), warning: vi.fn() } },
        { provide: AuthService, useValue: { currentUserId: vi.fn().mockReturnValue('user-123') } },
        { provide: LoggerService, useValue: { category: () => mockLogger } },
        { provide: ChangeTrackerService, useValue: { hasUnsyncedChanges: vi.fn().mockReturnValue(false) } },
        { provide: PermissionDeniedHandlerService, useValue: { handlePermissionDenied: vi.fn() } }
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
      expect(mockSyncCoordinator.loadSingleProject).not.toHaveBeenCalled();
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
      expect(mockSyncCoordinator.loadSingleProject).toHaveBeenCalledWith('project-1', 'user-123');
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
      
      expect(mockSyncCoordinator.loadSingleProject).toHaveBeenCalled();
      expect(onLoadProjects).not.toHaveBeenCalled();
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
      expect(mockSyncCoordinator.loadSingleProject).not.toHaveBeenCalled();
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
      
      expect(mockSyncCoordinator.loadSingleProject).not.toHaveBeenCalled();
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
      
      expect(mockSyncCoordinator.loadSingleProject).not.toHaveBeenCalled();
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
      };
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
      };
      taskChangeCallback!(taskPayload);
      
      // 不应记录跳过日志
      expect(mockLogger.debug).not.toHaveBeenCalledWith(
        '跳过任务级远程更新',
        expect.anything()
      );
    });
  });
});
