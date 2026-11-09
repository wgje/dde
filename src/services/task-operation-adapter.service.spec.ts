import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Injector, runInInjectionContext, signal } from '@angular/core';
import { TaskOperationAdapterService } from './task-operation-adapter.service';
import { TaskOperationService } from './task-operation.service';
import { TaskRecordTrackingService } from './task-record-tracking.service';
import { SyncCoordinatorService } from './sync-coordinator.service';
import { ChangeTrackerService } from './change-tracker.service';
import { UndoService } from './undo.service';
import { UiStateService } from './ui-state.service';
import { ProjectStateService } from './project-state.service';
import { OptimisticStateService } from './optimistic-state.service';
import { LoggerService } from './logger.service';
import { ConnectionAdapterService } from './connection-adapter.service';
import { ToastService } from './toast.service';
import { UserSessionService } from './user-session.service';
import { WriteGuardService } from './write-guard.service';
import { ActionQueueService } from './action-queue.service';
import { AuthService } from './auth.service';
import { Attachment, Project, Task } from '../models';
import { success } from '../utils/result';
import { registerTaskOperationAdapterCoreMutationsSpecs } from './task-operation-adapter-core-mutations.spec-helpers';
import { registerTaskOperationAdapterDurableMutationsSpecs } from './task-operation-adapter-durable-mutations.spec-helpers';
import { registerTaskOperationAdapterGuardSpecs } from './task-operation-adapter-guard.spec-helpers';
import { registerTaskOperationAdapterLifecycleSpecs } from './task-operation-adapter-lifecycle.spec-helpers';
import { registerTaskOperationAdapterPlannerSpecs } from './task-operation-adapter-planner.spec-helpers';
import { registerTaskOperationAdapterProjectAttachmentSpecs } from './task-operation-adapter-project-attachment.spec-helpers';

const createTask = (overrides: Partial<Task> = {}): Task => ({
  id: crypto.randomUUID(),
  title: '测试任务',
  content: '',
  stage: 1,
  parentId: null,
  order: 1,
  rank: 1000,
  status: 'active',
  x: 0,
  y: 0,
  createdDate: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  displayId: '1',
  hasIncompleteTask: false,
  ...overrides,
});

const createProject = (overrides: Partial<Project> = {}): Project => ({
  id: 'proj-1',
  name: '测试项目',
  description: '',
  createdDate: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  tasks: [],
  connections: [],
  version: 1,
  ...overrides,
});

// ========== Mock 服务 ==========

let mockProjectsSignal = signal<Project[]>([]);
let mockActiveProjectIdSignal = signal<string | null>(null);
let mockProjectOwnerGeneration = 0;
let mockSessionGeneration = 1;
let mockAuthIdentityFence = 'auth-fence-user-1';

const mockProjectStateService = {
  projects: () => mockProjectsSignal(),
  activeProject: () => {
    const projectId = mockActiveProjectIdSignal();
    return mockProjectsSignal().find(p => p.id === projectId) || null;
  },
  activeProjectId: () => mockActiveProjectIdSignal(),
  captureActiveProjectOwner: () => ({
    projectId: mockActiveProjectIdSignal(), generation: mockProjectOwnerGeneration,
  }),
  isActiveProjectOwnerCurrent: (owner: { projectId: string | null; generation: number }) =>
    owner.projectId === mockActiveProjectIdSignal() && owner.generation === mockProjectOwnerGeneration,
  setActiveProjectId: (projectId: string | null) => {
    if (mockActiveProjectIdSignal() === projectId) return;
    mockProjectOwnerGeneration += 1;
    mockActiveProjectIdSignal.set(projectId);
  },
  getTask: (taskId: string) => {
    const project = mockProjectStateService.activeProject();
    return project?.tasks.find(t => t.id === taskId);
  },
  getProjectWithCurrentData: (projectId: string) => mockProjectsSignal().find(project => project.id === projectId),
  getProjectsWithCurrentData: vi.fn(() => mockProjectsSignal()),
  setProjects: vi.fn((projects: Project[]) => {
    mockProjectsSignal.set(projects);
  }),
  updateProjects: vi.fn((mutator: (projects: Project[]) => Project[]) => {
    mockProjectsSignal.update(mutator);
  }),
};

const mockTaskOperationService = {
  moveTaskToStage: vi.fn(),
  moveTaskToStageDurably: vi.fn(),
  moveTaskToStageAtPosition: vi.fn(),
  moveTaskToStageAtPositionDurably: vi.fn(),
  updateTaskDraft: vi.fn(),
  updateTaskContent: vi.fn(),
  updateTaskPosition: vi.fn(),
  updateTaskPositionWithRankSync: vi.fn(),
  updateTaskStatus: vi.fn(),
  updateTaskAttachments: vi.fn(),
  addTaskAttachment: vi.fn(),
  removeTaskAttachment: vi.fn(),
  updateTaskPriority: vi.fn(),
  updateTaskDueDate: vi.fn(),
  updateTaskExpectedMinutes: vi.fn(),
  updateTaskCognitiveLoad: vi.fn(),
  updateTaskWaitMinutes: vi.fn(),
  updateTaskPlannerFields: vi.fn(),
  updateTaskTags: vi.fn(),
  addTaskTag: vi.fn(),
  removeTaskTag: vi.fn(),
  addTodoItem: vi.fn(),
  updateTaskAttentionItems: vi.fn(),
  updateTaskDraftDurably: vi.fn().mockResolvedValue(true),
  updateTaskContentDurably: vi.fn().mockResolvedValue(true),
  updateTaskTitleDurably: vi.fn().mockResolvedValue(true),
  updateTaskParkingMetaDurably: vi.fn().mockResolvedValue(true),
  updateTaskParkingMetaBatchDurably: vi.fn().mockResolvedValue(true),
  updateTaskPositionDurably: vi.fn().mockResolvedValue(true),
  updateTaskPositionWithRankSyncDurably: vi.fn().mockResolvedValue(true),
  updateTaskStatusDurably: vi.fn().mockResolvedValue(true),
  updateTaskAttachmentsDurably: vi.fn().mockResolvedValue(true),
  addTaskAttachmentDurably: vi.fn().mockResolvedValue(true),
  removeTaskAttachmentDurably: vi.fn().mockResolvedValue(true),
  updateTaskPriorityDurably: vi.fn().mockResolvedValue(true),
  updateTaskDueDateDurably: vi.fn().mockResolvedValue(true),
  updateTaskExpectedMinutesDurably: vi.fn().mockResolvedValue(true),
  updateTaskCognitiveLoadDurably: vi.fn().mockResolvedValue(true),
  updateTaskWaitMinutesDurably: vi.fn().mockResolvedValue(true),
  updateTaskPlannerFieldsDurably: vi.fn().mockResolvedValue(true),
  updateTaskTagsDurably: vi.fn().mockResolvedValue(true),
  addTaskTagDurably: vi.fn().mockResolvedValue(true),
  removeTaskTagDurably: vi.fn().mockResolvedValue(true),
  addTodoItemDurably: vi.fn().mockResolvedValue(true),
  updateTaskAttentionItemsDurably: vi.fn().mockResolvedValue(true),
  addTaskDurably: vi.fn().mockResolvedValue(success('new-task-id')),
  addTask: vi.fn(),
  addFloatingTaskDurably: vi.fn().mockResolvedValue(true),
  addFloatingTask: vi.fn(),
  repairMissingStageOneDurably: vi.fn().mockResolvedValue(true),
  repairMissingStageOne: vi.fn(),
  insertTaskBetweenDurably: vi.fn().mockResolvedValue(success(undefined)),
  insertTaskBetween: vi.fn(),
  insertTaskBetweenAtPositionDurably: vi.fn().mockResolvedValue(success(undefined)),
  insertTaskBetweenAtPosition: vi.fn(),
  reorderStageDurably: vi.fn().mockResolvedValue(true),
  reorderStage: vi.fn(),
  detachTaskDurably: vi.fn().mockResolvedValue(true),
  detachTask: vi.fn(),
  detachTaskWithSubtreeDurably: vi.fn().mockResolvedValue(success(undefined)),
  detachTaskWithSubtree: vi.fn(),
  moveSubtreeToNewParentDurably: vi.fn().mockResolvedValue(success(undefined)),
  moveSubtreeToNewParent: vi.fn(),
  replaceChildSubtreeWithUnassignedDurably: vi.fn().mockResolvedValue(success({ detachedSubtreeRootId: null })),
  replaceChildSubtreeWithUnassigned: vi.fn(),
  assignUnassignedToTaskDurably: vi.fn().mockResolvedValue(success(undefined)),
  assignUnassignedToTask: vi.fn(),
  deleteTaskDurably: vi.fn().mockResolvedValue({ saved: true, deletedTaskIds: new Set(['task-1']), deletedConnectionIds: [] }),
  deleteTask: vi.fn(),
  deleteTaskKeepChildrenDurably: vi.fn().mockResolvedValue({ saved: true, deletedTaskIds: new Set(['task-1']), deletedConnectionIds: [] }),
  deleteTaskKeepChildren: vi.fn(),
  deleteTasksBatchDurably: vi.fn().mockResolvedValue({ saved: true, deletedTaskIds: new Set(['task-1', 'task-2']), deletedConnectionIds: [] }),
  deleteTasksBatch: vi.fn(),
  permanentlyDeleteTaskDurably: vi.fn().mockResolvedValue({ saved: true, deletedTaskIds: new Set(['task-1']), deletedConnectionIds: [] }),
  permanentlyDeleteTask: vi.fn(),
  restoreTaskDurably: vi.fn().mockResolvedValue({ saved: true, restoredTaskIds: new Set(['task-1']), restoredConnectionIds: [] }),
  restoreTask: vi.fn(),
  emptyTrashDurably: vi.fn().mockResolvedValue({ saved: true, deletedTaskIds: new Set(['task-1']), deletedConnectionIds: [] }),
  emptyTrash: vi.fn(),
  setCallbacks: vi.fn(),
};

const mockOptimisticStateService = {
  createTaskSnapshot: vi.fn(() => ({ id: 'snapshot-1', type: 'task-move' })),
  commitSnapshot: vi.fn(),
  rollbackSnapshot: vi.fn(),
  discardSnapshot: vi.fn(),
};

const mockToastService = {
  success: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
  info: vi.fn(),
};

const mockLoggerCategory = {
  info: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
};

const mockLoggerService = {
  category: vi.fn(() => mockLoggerCategory),
  info: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
};

const mockSyncCoordinatorService = {
  markLocalChanges: vi.fn(),
  schedulePersist: vi.fn(),
  saveOfflineSnapshotAndWait: vi.fn().mockResolvedValue(undefined),
  hasPendingLocalChanges: vi.fn(() => false),
};

const mockChangeTrackerService = {
  trackTaskUpdate: vi.fn(),
  lockTaskField: vi.fn(),
};
const mockUndoService = { clearHistory: vi.fn() };
const mockUiStateService = { 
  isEditing: false, 
  isMobile: vi.fn(() => false),
  markEditing: vi.fn(),  // 【关键修复】添加 markEditing mock
};
const mockUserSessionService = {
  isHintOnlyStartupPlaceholderVisible: vi.fn(() => false),
  getCurrentSessionGeneration: vi.fn(() => mockSessionGeneration),
  isSessionContextCurrent: vi.fn((generation: number, userId: string | null) =>
    generation === mockSessionGeneration && userId === mockAuthService.currentUserId()),
};
const mockWriteGuardService = {
  isExportOnly: vi.fn(() => false),
};
const mockLayoutService = {};
const mockEventBusService = {
  emit: vi.fn(),
  on: vi.fn(() => ({ unsubscribe: vi.fn() })),
};

const mockConnectionAdapterService = {
  addCrossTreeConnection: vi.fn(),
  removeConnection: vi.fn(),
  relinkCrossTreeConnection: vi.fn(),
  updateConnectionContent: vi.fn(),
};

const mockActionQueueService = {
  enqueueDurably: vi.fn().mockResolvedValue('queued-action-1'),
  enqueueDurablyForOwner: vi.fn((_ownerUserId: string, action: unknown) =>
    mockActionQueueService.enqueueDurably(action)),
};

const mockAuthService = {
  currentUserId: vi.fn(() => 'user-1'),
  captureAuthIdentityFence: vi.fn(() => mockAuthIdentityFence),
};

const mockRecorderService = {
  lastUpdateType: 'structure' as 'content' | 'structure' | 'position',
  showUndoToast: vi.fn(),
  performUndo: vi.fn(),
  performRedo: vi.fn(),
  recordAndUpdate: vi.fn(),
  recordAndUpdateDurably: vi.fn().mockResolvedValue(true),
  recordAndUpdateDebounced: vi.fn(),
  setupSyncResultHandler: vi.fn(),
  triggerServerSideDelete: vi.fn(),
};

describe('TaskOperationAdapterService - moveTaskToStage', () => {
  let service: TaskOperationAdapterService;
  let project: Project;
  let task1: Task;
  let task2: Task;

  beforeEach(() => {
    // 重置所有 mock
    vi.clearAllMocks();
    
    const injector = Injector.create({
      providers: [
        { provide: TaskOperationService, useValue: mockTaskOperationService },
        { provide: TaskRecordTrackingService, useValue: mockRecorderService },
        { provide: ProjectStateService, useValue: mockProjectStateService },
        { provide: OptimisticStateService, useValue: mockOptimisticStateService },
        { provide: LoggerService, useValue: mockLoggerService },
        { provide: SyncCoordinatorService, useValue: mockSyncCoordinatorService },
        { provide: ChangeTrackerService, useValue: mockChangeTrackerService },
        { provide: UndoService, useValue: mockUndoService },
        { provide: UiStateService, useValue: mockUiStateService },
        { provide: ConnectionAdapterService, useValue: mockConnectionAdapterService },
        { provide: ToastService, useValue: mockToastService },
        { provide: UserSessionService, useValue: mockUserSessionService },
        { provide: WriteGuardService, useValue: mockWriteGuardService },
        { provide: ActionQueueService, useValue: mockActionQueueService },
        { provide: AuthService, useValue: mockAuthService },
      ],
    });

    service = runInInjectionContext(injector, () => new TaskOperationAdapterService());

    // 初始化项目和任务
    task1 = createTask({ id: 'task-1', stage: 1, parentId: null });
    task2 = createTask({ id: 'task-2', stage: 2, parentId: 'task-1' });
    project = createProject({ id: 'proj-1', tasks: [task1, task2] });
    
    mockProjectsSignal.set([project]);
    mockProjectOwnerGeneration = 0;
    mockSessionGeneration = 1;
    mockAuthIdentityFence = 'auth-fence-user-1';
    mockActiveProjectIdSignal.set('proj-1');
    mockUserSessionService.isHintOnlyStartupPlaceholderVisible.mockReturnValue(false);
    mockWriteGuardService.isExportOnly.mockReturnValue(false);
    mockTaskOperationService.moveTaskToStage.mockReturnValue(success(undefined));
    mockTaskOperationService.moveTaskToStageDurably.mockResolvedValue(success(undefined));
    mockTaskOperationService.moveTaskToStageAtPosition.mockReturnValue(success(undefined));
    mockTaskOperationService.moveTaskToStageAtPositionDurably.mockResolvedValue(success(undefined));
    mockTaskOperationService.updateTaskPositionWithRankSyncDurably.mockResolvedValue(true);
    mockTaskOperationService.insertTaskBetweenDurably.mockResolvedValue(success(undefined));
    mockTaskOperationService.insertTaskBetweenAtPositionDurably.mockResolvedValue(success(undefined));
    mockTaskOperationService.reorderStageDurably.mockResolvedValue(true);
    mockTaskOperationService.detachTaskDurably.mockResolvedValue(true);
    mockTaskOperationService.detachTaskWithSubtreeDurably.mockResolvedValue(success(undefined));
    mockTaskOperationService.moveSubtreeToNewParentDurably.mockResolvedValue(success(undefined));
    mockTaskOperationService.replaceChildSubtreeWithUnassignedDurably.mockResolvedValue(success({ detachedSubtreeRootId: null }));
    mockTaskOperationService.assignUnassignedToTaskDurably.mockResolvedValue(success(undefined));
    mockTaskOperationService.addTask.mockReturnValue(success('new-task-id'));
    mockTaskOperationService.addTaskDurably.mockResolvedValue(success('new-task-id'));
    mockTaskOperationService.addFloatingTaskDurably.mockResolvedValue(true);
    mockTaskOperationService.repairMissingStageOneDurably.mockResolvedValue(true);
    mockTaskOperationService.deleteTaskDurably.mockResolvedValue({ saved: true, deletedTaskIds: new Set(['task-1']), deletedConnectionIds: [] });
    mockTaskOperationService.deleteTaskKeepChildrenDurably.mockResolvedValue({ saved: true, deletedTaskIds: new Set(['task-1']), deletedConnectionIds: [] });
    mockTaskOperationService.deleteTasksBatchDurably.mockResolvedValue({ saved: true, deletedTaskIds: new Set(['task-1', 'task-2']), deletedConnectionIds: [] });
    mockTaskOperationService.permanentlyDeleteTaskDurably.mockResolvedValue({ saved: true, deletedTaskIds: new Set(['task-1']), deletedConnectionIds: [] });
    mockTaskOperationService.restoreTaskDurably.mockResolvedValue({ saved: true, restoredTaskIds: new Set(['task-1']), restoredConnectionIds: [] });
    mockTaskOperationService.emptyTrashDurably.mockResolvedValue({ saved: true, deletedTaskIds: new Set(['task-1']), deletedConnectionIds: [] });
    mockTaskOperationService.updateTaskContentDurably.mockResolvedValue(true);
    mockTaskOperationService.updateTaskDraftDurably.mockResolvedValue(true);
    mockTaskOperationService.updateTaskTitleDurably.mockResolvedValue(true);
    mockTaskOperationService.updateTaskParkingMetaBatchDurably.mockResolvedValue(true);
    mockTaskOperationService.updateTaskPositionDurably.mockResolvedValue(true);
    mockTaskOperationService.updateTaskStatusDurably.mockResolvedValue(true);
    mockTaskOperationService.updateTaskAttachmentsDurably.mockResolvedValue(true);
    mockTaskOperationService.addTaskAttachmentDurably.mockResolvedValue(true);
    mockTaskOperationService.removeTaskAttachmentDurably.mockResolvedValue(true);
    mockTaskOperationService.updateTaskPriorityDurably.mockResolvedValue(true);
    mockTaskOperationService.updateTaskDueDateDurably.mockResolvedValue(true);
    mockTaskOperationService.updateTaskExpectedMinutesDurably.mockResolvedValue(true);
    mockTaskOperationService.updateTaskCognitiveLoadDurably.mockResolvedValue(true);
    mockTaskOperationService.updateTaskWaitMinutesDurably.mockResolvedValue(true);
    mockTaskOperationService.updateTaskPlannerFieldsDurably.mockResolvedValue(true);
    mockTaskOperationService.updateTaskTagsDurably.mockResolvedValue(true);
    mockTaskOperationService.addTaskTagDurably.mockResolvedValue(true);
    mockTaskOperationService.removeTaskTagDurably.mockResolvedValue(true);
    mockTaskOperationService.addTodoItemDurably.mockResolvedValue(true);
    mockTaskOperationService.updateTaskAttentionItemsDurably.mockResolvedValue(true);
    mockRecorderService.recordAndUpdateDurably.mockResolvedValue(true);
    mockActionQueueService.enqueueDurably.mockResolvedValue('queued-action-1');
    mockActionQueueService.enqueueDurablyForOwner.mockClear();
    mockAuthService.currentUserId.mockReturnValue('user-1');
  });

  registerTaskOperationAdapterGuardSpecs({
    service: () => service,
    mockUserSessionService: () => mockUserSessionService,
    mockWriteGuardService: () => mockWriteGuardService,
    mockTaskOperationService: () => mockTaskOperationService,
    mockOptimisticStateService: () => mockOptimisticStateService,
    mockToastService: () => mockToastService,
    mockUiStateService: () => mockUiStateService,
    mockRecorderService: () => mockRecorderService,
    mockSyncCoordinatorService: () => mockSyncCoordinatorService,
  });

  registerTaskOperationAdapterCoreMutationsSpecs({
    service: () => service,
    mockTaskOperationService: () => mockTaskOperationService,
    mockUiStateService: () => mockUiStateService,
    mockRecorderService: () => mockRecorderService,
    mockOptimisticStateService: () => mockOptimisticStateService,
    mockLoggerCategory: () => mockLoggerCategory,
    mockChangeTrackerService: () => mockChangeTrackerService,
    mockSyncCoordinatorService: () => mockSyncCoordinatorService,
    switchActiveProject: projectId => {
      if (!mockProjectsSignal().some(project => project.id === projectId)) {
        mockProjectsSignal.update(projects => [
          ...projects,
          createProject({ id: projectId, tasks: [createTask({ id: 'task-1' })] }),
        ]);
      }
      mockProjectStateService.setActiveProjectId(projectId);
    },
  });

  registerTaskOperationAdapterDurableMutationsSpecs({
    service: () => service,
    mockTaskOperationService: () => mockTaskOperationService,
    mockUiStateService: () => mockUiStateService,
    mockRecorderService: () => mockRecorderService,
    mockOptimisticStateService: () => mockOptimisticStateService,
    mockLoggerCategory: () => mockLoggerCategory,
    mockSyncCoordinatorService: () => mockSyncCoordinatorService,
  });

  it('should not show toast when task is not actually moved (same stage and parentId)', async () => {
    // 模拟移动前后任务状态没有变化
    mockTaskOperationService.moveTaskToStageDurably.mockResolvedValue(success(undefined));
    
    // 调用移动（到相同的 stage，parentId 也相同）
    const result = await service.moveTaskToStage('task-1', 1, null, null);
    
    // 验证
    expect(result.ok).toBe(true);
    expect(mockTaskOperationService.moveTaskToStageDurably).toHaveBeenCalledWith({
      taskId: 'task-1',
      newStage: 1,
      beforeTaskId: null,
      newParentId: null,
    });
    expect(mockTaskOperationService.moveTaskToStage).not.toHaveBeenCalled();
    expect(mockRecorderService.showUndoToast).not.toHaveBeenCalled();
    expect(mockOptimisticStateService.discardSnapshot).toHaveBeenCalledWith('snapshot-1');
  });

  it('should show toast when task stage changes', async () => {
    // 模拟 stage 改变
    mockTaskOperationService.moveTaskToStageDurably.mockImplementation(async () => {
      // 修改任务的 stage
      const updatedProject = { ...project };
      updatedProject.tasks = project.tasks.map(t =>
        t.id === 'task-1' ? { ...t, stage: 2 } : t
      );
      mockProjectsSignal.set([updatedProject]);
      return success(undefined);
    });
    
    const result = await service.moveTaskToStage('task-1', 2, null, null);
    
    expect(result.ok).toBe(true);
    expect(mockTaskOperationService.moveTaskToStageDurably).toHaveBeenCalledWith({
      taskId: 'task-1',
      newStage: 2,
      beforeTaskId: null,
      newParentId: null,
    });
    expect(mockTaskOperationService.moveTaskToStage).not.toHaveBeenCalled();
    expect(mockRecorderService.showUndoToast).toHaveBeenCalledWith('已移动到阶段 2');
    expect(mockOptimisticStateService.discardSnapshot).not.toHaveBeenCalled();
  });

  it('should use one durable core call when moving task and position together', async () => {
    mockTaskOperationService.moveTaskToStageAtPositionDurably.mockImplementation(async () => {
      const updatedProject = { ...project };
      updatedProject.tasks = project.tasks.map(t =>
        t.id === 'task-1' ? { ...t, stage: 2, parentId: 'task-2', rank: 1500, x: 80, y: 160 } : t
      );
      mockProjectsSignal.set([updatedProject]);
      return success(undefined);
    });

    const result = await service.moveTaskToStageAtPosition('task-1', 2, 'next-1', 'task-2', 80, 160);

    expect(result.ok).toBe(true);
    expect(mockTaskOperationService.moveTaskToStageAtPositionDurably).toHaveBeenCalledWith({
      taskId: 'task-1',
      newStage: 2,
      beforeTaskId: 'next-1',
      newParentId: 'task-2',
      x: 80,
      y: 160,
    });
    expect(mockTaskOperationService.moveTaskToStageDurably).not.toHaveBeenCalled();
    expect(mockTaskOperationService.moveTaskToStage).not.toHaveBeenCalled();
    expect(mockRecorderService.showUndoToast).toHaveBeenCalledWith('已移动到阶段 2');
    expect(mockRecorderService.setupSyncResultHandler).toHaveBeenCalledWith('snapshot-1');
  });

  it('should show toast when task parentId changes', async () => {
    // 模拟 parentId 改变
    mockTaskOperationService.moveTaskToStageDurably.mockImplementation(async () => {
      const updatedProject = { ...project };
      updatedProject.tasks = project.tasks.map(t =>
        t.id === 'task-2' ? { ...t, parentId: null } : t
      );
      mockProjectsSignal.set([updatedProject]);
      return success(undefined);
    });
    
    const result = await service.moveTaskToStage('task-2', 2, null, null);
    
    expect(result.ok).toBe(true);
    expect(mockTaskOperationService.moveTaskToStageDurably).toHaveBeenCalled();
    expect(mockTaskOperationService.moveTaskToStage).not.toHaveBeenCalled();
    expect(mockRecorderService.showUndoToast).toHaveBeenCalled();
    expect(mockOptimisticStateService.discardSnapshot).not.toHaveBeenCalled();
  });

  it('should discard snapshot when project is switched during operation', async () => {
    // 模拟操作期间项目切换
    mockTaskOperationService.moveTaskToStageDurably.mockImplementation(async () => {
      // 切换到另一个项目
      mockActiveProjectIdSignal.set('proj-2');
      return success(undefined);
    });
    
    const result = await service.moveTaskToStage('task-1', 2, null, null);
    
    expect(result.ok).toBe(true);
    expect(mockTaskOperationService.moveTaskToStage).not.toHaveBeenCalled();
    expect(mockRecorderService.showUndoToast).not.toHaveBeenCalled();
    expect(mockOptimisticStateService.discardSnapshot).toHaveBeenCalledWith('snapshot-1');
    expect(mockLoggerCategory.warn).toHaveBeenCalledWith(
      '项目在操作期间被切换',
      expect.objectContaining({
        projectIdBefore: 'proj-1',
        projectIdAfter: 'proj-2',
      })
    );
  });

  it('should not show toast when parentId is undefined vs null (edge case)', async () => {
    // 边缘情况：任务的 parentId 是 undefined（而不是 null）
    // 移动后 parentId 仍然是 undefined，应该被视为"没有变化"
    const taskWithUndefinedParent = createTask({ id: 'task-3', stage: 1, parentId: null });
    // 强制将 parentId 设置为 undefined 来模拟边缘情况
    (taskWithUndefinedParent as { parentId: unknown }).parentId = undefined;
    
    const projectWithEdgeCase = createProject({ 
      id: 'proj-1', 
      tasks: [taskWithUndefinedParent] 
    });
    mockProjectsSignal.set([projectWithEdgeCase]);
    
    mockTaskOperationService.moveTaskToStageDurably.mockResolvedValue(success(undefined));
    
    const result = await service.moveTaskToStage('task-3', 1, null, null);
    
    expect(result.ok).toBe(true);
    expect(mockTaskOperationService.moveTaskToStage).not.toHaveBeenCalled();
    expect(mockRecorderService.showUndoToast).not.toHaveBeenCalled();
    expect(mockOptimisticStateService.discardSnapshot).toHaveBeenCalledWith('snapshot-1');
  });

  it('should discard the snapshot without workspace rollback when operation fails', async () => {
    // 模拟操作失败
    const failureResult = { ok: false, error: { code: 'ERROR', message: '操作失败' } };
    mockTaskOperationService.moveTaskToStageDurably.mockResolvedValue(failureResult);
    
    const result = await service.moveTaskToStage('task-1', 2, null, null);
    
    expect(result.ok).toBe(false);
    expect(mockTaskOperationService.moveTaskToStage).not.toHaveBeenCalled();
    expect(mockRecorderService.showUndoToast).not.toHaveBeenCalled();
    expect(mockOptimisticStateService.discardSnapshot).toHaveBeenCalledWith('snapshot-1');
    expect(mockOptimisticStateService.rollbackSnapshot).not.toHaveBeenCalled();
    expect(mockSyncCoordinatorService.markLocalChanges).not.toHaveBeenCalled();
  });

  it('should discard snapshot on conflict error without workspace rollback', async () => {
    const conflictResult = { ok: false, error: { code: 'CONFLICT', message: '版本冲突' } };
    mockTaskOperationService.moveTaskToStageDurably.mockResolvedValue(conflictResult);

    const result = await service.moveTaskToStage('task-1', 2, null, null);

    expect(result.ok).toBe(false);
    expect(mockTaskOperationService.moveTaskToStage).not.toHaveBeenCalled();
    expect(mockOptimisticStateService.discardSnapshot).toHaveBeenCalledWith('snapshot-1');
    expect(mockOptimisticStateService.rollbackSnapshot).not.toHaveBeenCalled();
  });

  it('should show toast when moving to unassigned area', async () => {
    // 模拟移动到待分配区
    mockTaskOperationService.moveTaskToStageDurably.mockImplementation(async () => {
      const updatedProject = { ...project };
      updatedProject.tasks = project.tasks.map(t =>
        t.id === 'task-1' ? { ...t, stage: null } : t
      );
      mockProjectsSignal.set([updatedProject]);
      return success(undefined);
    });
    
    const result = await service.moveTaskToStage('task-1', null, null, null);
    
    expect(result.ok).toBe(true);
    expect(mockTaskOperationService.moveTaskToStage).not.toHaveBeenCalled();
    expect(mockRecorderService.showUndoToast).toHaveBeenCalledWith('已移动到待分配区');
  });

  it('should use one durable core call when inserting between tasks and position together', async () => {
    mockTaskOperationService.insertTaskBetweenAtPositionDurably.mockImplementation(async () => {
      const updatedProject = { ...project };
      updatedProject.tasks = project.tasks.map(t =>
        t.id === 'task-1' ? { ...t, parentId: 'task-2', stage: 3, rank: 2000, x: 40, y: 60 } : t
      );
      mockProjectsSignal.set([updatedProject]);
      return success(undefined);
    });

    const result = await service.insertTaskBetweenAtPosition('task-1', 'source-1', 'target-1', 40, 60);

    expect(result.ok).toBe(true);
    expect(mockTaskOperationService.insertTaskBetweenAtPositionDurably).toHaveBeenCalledWith({
      taskId: 'task-1',
      sourceId: 'source-1',
      targetId: 'target-1',
      x: 40,
      y: 60,
    });
    expect(mockTaskOperationService.insertTaskBetweenDurably).not.toHaveBeenCalled();
    expect(mockTaskOperationService.insertTaskBetween).not.toHaveBeenCalled();
    expect(mockRecorderService.setupSyncResultHandler).toHaveBeenCalledWith('snapshot-1');
  });

  registerTaskOperationAdapterLifecycleSpecs({
    service: () => service,
  });

  registerTaskOperationAdapterPlannerSpecs({
    service: () => service,
    mockTaskOperationService: () => mockTaskOperationService,
    mockUiStateService: () => mockUiStateService,
    mockRecorderService: () => mockRecorderService,
  });

  it('同一用户 session generation 轮换期间附件写入应 fail closed', async () => {
    const attachment: Attachment = {
      id: 'att-session-rotation',
      type: 'file',
      name: 'session-rotation.txt',
      url: 'https://example.com/session-rotation.txt',
      mimeType: 'text/plain',
      size: 4,
      createdAt: '2026-06-01T00:00:00.000Z',
    };
    const task = createTask({ id: 'task-session-rotation', attachments: [] });
    mockProjectsSignal.set([createProject({ id: 'project-session-rotation', tasks: [task] })]);
    mockProjectOwnerGeneration = 0;
    mockActiveProjectIdSignal.set('project-session-rotation');
    let release!: () => void;
    mockActionQueueService.enqueueDurablyForOwner.mockReturnValueOnce(new Promise<string>(resolve => {
      release = () => resolve('queued-session-rotation');
    }));

    const completion = service.addTaskAttachmentToProject(
      'project-session-rotation',
      'task-session-rotation',
      attachment,
      { operationId: 'operation-session-rotation' },
    );
    await vi.waitFor(() => expect(mockActionQueueService.enqueueDurablyForOwner).toHaveBeenCalledOnce());
    mockSessionGeneration = 2;
    release();

    await expect(completion).resolves.toBe(false);
    expect(mockSyncCoordinatorService.saveOfflineSnapshotAndWait).not.toHaveBeenCalled();
    expect(mockProjectStateService.updateProjects).not.toHaveBeenCalled();
  });

  registerTaskOperationAdapterProjectAttachmentSpecs({
    service: () => service,
    createProject,
    createTask,
    getProjects: () => mockProjectsSignal(),
    setActiveProjectId: projectId => mockActiveProjectIdSignal.set(projectId),
    switchActiveProject: projectId => mockProjectStateService.setActiveProjectId(projectId),
    setProjects: projects => mockProjectsSignal.set(projects),
    mockProjectStateService: () => mockProjectStateService,
    mockChangeTrackerService: () => mockChangeTrackerService,
    mockSyncCoordinatorService: () => mockSyncCoordinatorService,
    mockActionQueueService: () => mockActionQueueService,
  });
});
