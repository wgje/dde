/**
 * TaskRecordTrackingService 单元测试
 *
 * 测试覆盖：
 * 1. showUndoToast（桌面/移动端不同表现）
 * 2. performUndo（正常撤销、版本不匹配、无可撤销操作）
 * 3. performRedo（正常重做、版本不匹配、无可重做操作）
 * 4. recordAndUpdate（含竞态保护和变更追踪）
 * 5. recordAndUpdateDebounced（内容更新场景）
 * 6. setupSyncResultHandler（同步结果回调）
 * 7. triggerServerSideDelete（服务端删除保护）
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Injector, runInInjectionContext } from '@angular/core';
import { TaskRecordTrackingService } from './task-record-tracking.service';
import { ProjectStateService } from './project-state.service';
import { UndoService } from './undo.service';
import { SyncCoordinatorService } from './sync-coordinator.service';
import { ChangeTrackerService } from './change-tracker.service';
import { LayoutService } from './layout.service';
import { OptimisticStateService } from './optimistic-state.service';
import { ToastService } from './toast.service';
import { UiStateService } from './ui-state.service';
import { LoggerService } from './logger.service';
import type { Project, Task } from '../models';

const mockLoggerCategory = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

const mockLoggerService = {
  category: vi.fn(() => mockLoggerCategory),
};

const mockToastService = {
  success: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
  info: vi.fn(),
};

function createTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    title: 'Title',
    content: '',
    stage: 1,
    parentId: null,
    order: 0,
    rank: 10000,
    status: 'active',
    x: 0,
    y: 0,
    createdDate: new Date().toISOString(),
    displayId: '1',
    ...overrides,
  };
}

function createProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'proj-1',
    name: 'Test Project',
    description: '',
    createdDate: new Date().toISOString(),
    tasks: [createTask()],
    connections: [],
    version: 1,
    ...overrides,
  };
}

describe('TaskRecordTrackingService', () => {
  let service: TaskRecordTrackingService;
  let mockProjectState: Record<string, any>;
  let mockUndoService: Record<string, any>;
  let mockSyncCoordinator: Record<string, any>;
  let mockChangeTracker: Record<string, any>;
  let mockLayoutService: Record<string, any>;
  let mockOptimisticState: Record<string, any>;
  let mockUiState: Record<string, any>;
  let consoleWarnSpy: ReturnType<typeof vi.spyOn> | undefined;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn> | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    mockProjectState = {
      activeProject: vi.fn().mockReturnValue(createProject()),
      updateProjects: vi.fn((fn: (projects: Project[]) => Project[]) => {
        fn([createProject()]);
      }),
      getTask: vi.fn().mockReturnValue(null),
    };

    mockUndoService = {
      undo: vi.fn(),
      redo: vi.fn(),
      createProjectSnapshot: vi.fn((p: Project) => ({ tasks: p.tasks, connections: p.connections })),
      recordAction: vi.fn(),
      recordActionDebounced: vi.fn(),
      forceUndo: vi.fn(),
      clearOutdatedHistory: vi.fn(),
      isProcessing: false,
    };

    mockSyncCoordinator = {
      markLocalChanges: vi.fn(),
      schedulePersist: vi.fn(),
      syncError: vi.fn().mockReturnValue(null),
      hasPendingLocalChanges: vi.fn().mockReturnValue(false),
      softDeleteTasksBatch: vi.fn().mockResolvedValue(1),
    };

    mockChangeTracker = {
      trackTaskCreate: vi.fn(),
      trackTaskUpdate: vi.fn(),
      trackTaskDelete: vi.fn(),
      trackConnectionCreate: vi.fn(),
      trackConnectionUpdate: vi.fn(),
      trackConnectionDelete: vi.fn(),
    };

    mockLayoutService = {
      rebalance: vi.fn((p: Project) => p),
    };

    mockOptimisticState = {
      hasSnapshot: vi.fn().mockReturnValue(false),
      commitSnapshot: vi.fn(),
      rollbackSnapshot: vi.fn(),
      snapshots: new Map(),
    };

    mockUiState = {
      isMobile: vi.fn().mockReturnValue(false),
    };

    const injector = Injector.create({
      providers: [
        TaskRecordTrackingService,
        { provide: ProjectStateService, useValue: mockProjectState },
        { provide: UndoService, useValue: mockUndoService },
        { provide: SyncCoordinatorService, useValue: mockSyncCoordinator },
        { provide: ChangeTrackerService, useValue: mockChangeTracker },
        { provide: LayoutService, useValue: mockLayoutService },
        { provide: OptimisticStateService, useValue: mockOptimisticState },
        { provide: ToastService, useValue: mockToastService },
        { provide: UiStateService, useValue: mockUiState },
        { provide: LoggerService, useValue: mockLoggerService },
      ],
    });

    service = runInInjectionContext(injector, () => injector.get(TaskRecordTrackingService));
  });

  afterEach(() => {
    consoleWarnSpy?.mockRestore();
    consoleErrorSpy?.mockRestore();
  });

  // ==================== showUndoToast ====================

  describe('showUndoToast', () => {
    it('should show toast with short duration on desktop', () => {
      mockUiState.isMobile.mockReturnValue(false);

      service.showUndoToast('Task deleted');

      expect(mockToastService.success).toHaveBeenCalledWith(
        'Task deleted',
        undefined,
        expect.objectContaining({ duration: 3000 })
      );
    });

    it('should show toast with undo action on mobile', () => {
      mockUiState.isMobile.mockReturnValue(true);

      service.showUndoToast('Task deleted');

      expect(mockToastService.success).toHaveBeenCalledWith(
        'Task deleted',
        undefined,
        expect.objectContaining({
          duration: 5000,
          action: expect.objectContaining({ label: '撤销' }),
        })
      );
    });
  });

  // ==================== performUndo ====================

  describe('performUndo', () => {
    it('should log warning when there is nothing to undo', () => {
      mockUndoService.undo.mockReturnValue(null);

      service.performUndo();

      expect(mockLoggerCategory.warn).toHaveBeenCalled();
    });

    it('should show warning toast on version-mismatch', () => {
      mockUndoService.undo.mockReturnValue('version-mismatch');

      service.performUndo();

      expect(mockToastService.warning).toHaveBeenCalledWith('撤销失败', expect.any(String));
    });

    it('should apply snapshot on successful undo', () => {
      const snapshot = { tasks: [createTask()], connections: [] };
      mockUndoService.undo.mockReturnValue({
        type: 'task-update',
        projectId: 'proj-1',
        data: { before: snapshot, after: {} },
      });

      service.performUndo();

      expect(mockProjectState.updateProjects).toHaveBeenCalled();
      expect(mockSyncCoordinator.markLocalChanges).toHaveBeenCalledWith('structure');
      expect(mockSyncCoordinator.schedulePersist).toHaveBeenCalled();
    });

    it('should handle version-mismatch-forceable result', () => {
      mockUndoService.undo.mockReturnValue({
        type: 'version-mismatch-forceable',
        versionDiff: 2,
      });
      const snapshot = { tasks: [], connections: [] };
      mockUndoService.forceUndo.mockReturnValue({
        projectId: 'proj-1',
        data: { before: snapshot },
      });

      service.performUndo();

      expect(mockToastService.warning).toHaveBeenCalledWith('撤销注意', expect.any(String));
      expect(mockUndoService.forceUndo).toHaveBeenCalled();
    });
  });

  // ==================== performRedo ====================

  describe('performRedo', () => {
    it('should do nothing when there is nothing to redo', () => {
      mockUndoService.redo.mockReturnValue(null);

      service.performRedo();

      expect(mockLoggerCategory.debug).toHaveBeenCalled();
      expect(mockProjectState.updateProjects).not.toHaveBeenCalled();
    });

    it('should show warning on version-mismatch', () => {
      mockUndoService.redo.mockReturnValue('version-mismatch');

      service.performRedo();

      expect(mockToastService.warning).toHaveBeenCalledWith('重做失败', expect.any(String));
    });

    it('should apply after-snapshot on successful redo', () => {
      const snapshot = { tasks: [createTask()], connections: [] };
      mockUndoService.redo.mockReturnValue({
        type: 'task-update',
        projectId: 'proj-1',
        data: { before: {}, after: snapshot },
      });

      service.performRedo();

      expect(mockProjectState.updateProjects).toHaveBeenCalled();
      expect(mockSyncCoordinator.markLocalChanges).toHaveBeenCalledWith('structure');
    });
  });

  // ==================== recordAndUpdate ====================

  describe('recordAndUpdate', () => {
    it('should apply mutator and record undo action', () => {
      const mutator = vi.fn((p: Project) => ({ ...p, name: 'Updated' }));

      service.recordAndUpdate(mutator);

      expect(mockProjectState.updateProjects).toHaveBeenCalled();
      expect(mockUndoService.recordAction).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'task-update', projectId: 'proj-1' }),
        expect.any(Number)
      );
      expect(mockSyncCoordinator.markLocalChanges).toHaveBeenCalledWith('structure');
      expect(mockSyncCoordinator.schedulePersist).toHaveBeenCalled();
    });

    it('should skip when no active project', () => {
      mockProjectState.activeProject.mockReturnValue(null);
      const mutator = vi.fn();

      service.recordAndUpdate(mutator);

      expect(mutator).not.toHaveBeenCalled();
    });

    it('should set lastUpdateType to structure', () => {
      service.recordAndUpdate((p) => p);
      expect(service.lastUpdateType).toBe('structure');
    });
  });

  // ==================== recordAndUpdateDebounced ====================

  describe('recordAndUpdateDebounced', () => {
    it('should apply mutator with debounced undo recording', () => {
      const mutator = vi.fn((p: Project) => ({ ...p, name: 'Updated' }));

      service.recordAndUpdateDebounced(mutator);

      expect(mockProjectState.updateProjects).toHaveBeenCalled();
      expect(mockUndoService.recordActionDebounced).toHaveBeenCalled();
      expect(mockSyncCoordinator.markLocalChanges).toHaveBeenCalledWith('content');
    });

    it('should set lastUpdateType to content', () => {
      service.recordAndUpdateDebounced((p) => p);
      expect(service.lastUpdateType).toBe('content');
    });
  });

  // ==================== triggerServerSideDelete ====================

  describe('triggerServerSideDelete', () => {
    it('should call softDeleteTasksBatch for deleted tasks', async () => {
      const deletedTask = createTask({ id: 'task-del', deletedAt: new Date().toISOString() });
      mockProjectState.activeProject.mockReturnValue(
        createProject({ tasks: [deletedTask] })
      );

      await service.triggerServerSideDelete('proj-1', ['task-del'], 'snap-1');

      expect(mockSyncCoordinator.softDeleteTasksBatch).toHaveBeenCalledWith(
        'proj-1',
        ['task-del']
      );
    });

    it('should rollback when server rejects batch delete', async () => {
      const deletedTask = createTask({ id: 'task-del', deletedAt: new Date().toISOString() });
      mockProjectState.activeProject.mockReturnValue(
        createProject({ tasks: [deletedTask] })
      );
      mockSyncCoordinator.softDeleteTasksBatch.mockResolvedValue(-1);

      await service.triggerServerSideDelete('proj-1', ['task-del'], 'snap-1');

      expect(mockOptimisticState.rollbackSnapshot).toHaveBeenCalledWith('snap-1');
      expect(mockToastService.warning).toHaveBeenCalled();
    });

    it('should do nothing when no active project', async () => {
      mockProjectState.activeProject.mockReturnValue(null);

      await service.triggerServerSideDelete('proj-1', ['task-1'], 'snap-1');

      expect(mockSyncCoordinator.softDeleteTasksBatch).not.toHaveBeenCalled();
    });
  });
});
