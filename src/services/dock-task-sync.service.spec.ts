/**
 * DockTaskSyncService 单元测试（Vitest + Injector 隔离模式）
 *
 * 测试覆盖：
 * 1. resolveTaskProjectId — 从 TaskStore 返回项目 ID
 * 2. resolveTaskProjectId — TaskStore 返回 null 时使用 fallback
 * 3. resolveTaskProjectId — 两者都为 null 时返回 null
 * 4. syncTaskPlannerFields — 正确调用 taskOps
 * 5. syncTaskPlannerFields — taskId 无项目时 no-op
 * 6. syncTaskDetail — project-task 来源更新任务内容
 * 7. applyCrossProjectTaskPatch — 调用 taskStore.setTask 和 projectState.updateProjects
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Injector, runInInjectionContext, signal } from '@angular/core';
import { DockTaskSyncService } from './dock-task-sync.service';
import { TaskStore } from '../core-bridge';
import { TaskOperationAdapterService } from './task-operation-adapter.service';
import { ProjectStateService } from './project-state.service';
import { BlackBoxService } from './black-box.service';
import { LoggerService } from './logger.service';
import { ActionQueueService } from './action-queue.service';
import { AuthService } from './auth.service';
import { Task, Project } from '../models';
import { DockEntry } from '../models/parking-dock';

// ── Mock helpers ──

function createMockTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    title: 'Test Task',
    content: '',
    stage: 1,
    parentId: null,
    order: 0,
    rank: 500,
    status: 'active',
    x: 0,
    y: 0,
    createdDate: new Date().toISOString(),
    displayId: '1',
    ...overrides,
  };
}

function createMockProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'proj-1',
    name: 'Test Project',
    description: '',
    createdDate: new Date().toISOString(),
    tasks: [],
    connections: [],
    ...overrides,
  };
}

function createMockDockEntry(overrides: Partial<DockEntry> = {}): DockEntry {
  return {
    taskId: 'task-1',
    title: 'Dock Entry',
    sourceProjectId: 'proj-1',
    status: 'pending_start',
    load: 'low',
    expectedMinutes: 30,
    waitMinutes: null,
    waitStartedAt: null,
    lane: 'combo-select',
    zoneSource: 'manual',
    isMain: false,
    dockedOrder: 0,
    detail: '',
    sourceKind: 'project-task',
    systemSelected: false,
    recommendedScore: null,
    ...overrides,
  } as DockEntry;
}

// ── Mocks ──

// LoggerService：测试不关注日志输出，提供最小无操作实现
const noopLoggerCategory = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const mockLoggerService = { category: () => noopLoggerCategory };

const mockTaskStore = {
  getTaskProjectId: vi.fn<(taskId: string) => string | null>().mockReturnValue(null),
  getTask: vi.fn<(id: string) => Task | undefined>().mockReturnValue(undefined),
  setTask: vi.fn(),
};

const mockTaskOps = {
  updateTaskContent: vi.fn(),
  updateTaskExpectedMinutes: vi.fn(),
  updateTaskCognitiveLoad: vi.fn(),
  updateTaskWaitMinutes: vi.fn(),
  updateTaskPlannerFields: vi.fn(),
};

const mockActionQueue = {
  enqueueDurablyForOwner: vi.fn(),
};

const mockAuthService = {
  currentUserId: vi.fn(),
  captureAuthIdentityFence: vi.fn(),
};

const projectsSignal = signal<Project[]>([]);
const activeProjectIdSignal = signal<string | null>(null);

const mockProjectState = {
  projects: projectsSignal,
  activeProjectId: activeProjectIdSignal,
  updateProjects: vi.fn(),
};

const mockBlackBoxService = {
  update: vi.fn(),
  updateDurably: vi.fn().mockResolvedValue({ ok: true, value: {} }),
  getEntry: vi.fn().mockReturnValue(undefined),
  markAsCompleted: vi.fn().mockReturnValue({ ok: true, value: {} }),
  markAsCompletedDurably: vi.fn().mockResolvedValue({ ok: true, value: {} }),
};

// ── Test suite ──

describe('DockTaskSyncService', () => {
  let service: DockTaskSyncService;

  beforeEach(() => {
    vi.clearAllMocks();
    projectsSignal.set([]);
    activeProjectIdSignal.set(null);
    mockBlackBoxService.getEntry.mockReturnValue(undefined);
    mockTaskOps.updateTaskContent.mockResolvedValue(true);
    mockTaskOps.updateTaskExpectedMinutes.mockResolvedValue(true);
    mockTaskOps.updateTaskCognitiveLoad.mockResolvedValue(true);
    mockTaskOps.updateTaskWaitMinutes.mockResolvedValue(true);
    mockTaskOps.updateTaskPlannerFields.mockResolvedValue(true);
    mockActionQueue.enqueueDurablyForOwner.mockResolvedValue('action-1');
    mockAuthService.currentUserId.mockReturnValue('user-1');
    mockAuthService.captureAuthIdentityFence.mockReturnValue('fence-a');

    const injector = Injector.create({
      providers: [
        DockTaskSyncService,
        { provide: TaskStore, useValue: mockTaskStore },
        { provide: TaskOperationAdapterService, useValue: mockTaskOps },
        { provide: ProjectStateService, useValue: mockProjectState },
        { provide: BlackBoxService, useValue: mockBlackBoxService },
        { provide: LoggerService, useValue: mockLoggerService },
        { provide: ActionQueueService, useValue: mockActionQueue },
        { provide: AuthService, useValue: mockAuthService },
      ],
    });

    runInInjectionContext(injector, () => {
      service = injector.get(DockTaskSyncService);
    });
  });

  // ==================== resolveTaskProjectId ====================

  describe('resolveTaskProjectId', () => {
    it('should not resolve task operation adapter for read-only project lookup during startup', () => {
      const throwingTaskOpsProvider = vi.fn(() => {
        throw new Error('TaskOperationAdapterService should not be resolved for read-only dock startup');
      });
      const isolatedInjector = Injector.create({
        providers: [
          DockTaskSyncService,
          { provide: TaskStore, useValue: mockTaskStore },
          { provide: TaskOperationAdapterService, useFactory: throwingTaskOpsProvider },
          { provide: ProjectStateService, useValue: mockProjectState },
          { provide: BlackBoxService, useValue: mockBlackBoxService },
          { provide: LoggerService, useValue: mockLoggerService },
          { provide: ActionQueueService, useValue: mockActionQueue },
          { provide: AuthService, useValue: mockAuthService },
        ],
      });

      mockTaskStore.getTaskProjectId.mockReturnValue('proj-from-store');

      const isolatedService = runInInjectionContext(
        isolatedInjector,
        () => isolatedInjector.get(DockTaskSyncService),
      );

      expect(isolatedService.resolveTaskProjectId('task-1')).toBe('proj-from-store');
      expect(throwingTaskOpsProvider).not.toHaveBeenCalled();
    });

    it('should return project ID from task store', () => {
      mockTaskStore.getTaskProjectId.mockReturnValue('proj-from-store');

      const result = service.resolveTaskProjectId('task-1');

      expect(result).toBe('proj-from-store');
      expect(mockTaskStore.getTaskProjectId).toHaveBeenCalledWith('task-1');
    });

    it('should return fallback when task store returns null', () => {
      mockTaskStore.getTaskProjectId.mockReturnValue(null);

      const result = service.resolveTaskProjectId('task-1', 'proj-fallback');

      expect(result).toBe('proj-fallback');
    });

    it('should return null when both task store and fallback are null', () => {
      mockTaskStore.getTaskProjectId.mockReturnValue(null);
      projectsSignal.set([]);
      activeProjectIdSignal.set(null);

      const result = service.resolveTaskProjectId('task-1', null);

      expect(result).toBeNull();
    });
  });

  // ==================== syncTaskPlannerFields ====================

  describe('syncTaskPlannerFields', () => {
    it('should call task operation adapter with correct patch', async () => {
      const task = createMockTask({ id: 'task-1', expected_minutes: 30 });
      mockTaskStore.getTask.mockReturnValue(task);
      mockTaskStore.getTaskProjectId.mockReturnValue('proj-1');
      activeProjectIdSignal.set('proj-1');

      await expect(service.syncTaskPlannerFields('task-1', {
        expected_minutes: 60,
        cognitive_load: 'high',
      })).resolves.toBe(true);

      expect(mockTaskOps.updateTaskPlannerFields).toHaveBeenCalledWith('task-1', {
        expectedMinutes: 60,
        cognitiveLoad: 'high',
      });
      expect(mockTaskOps.updateTaskExpectedMinutes).not.toHaveBeenCalled();
      expect(mockTaskOps.updateTaskCognitiveLoad).not.toHaveBeenCalled();
      expect(mockTaskOps.updateTaskWaitMinutes).not.toHaveBeenCalled();
    });

    it('should no-op when taskId has no project', async () => {
      const task = createMockTask({ id: 'task-orphan' });
      mockTaskStore.getTask.mockReturnValue(task);
      mockTaskStore.getTaskProjectId.mockReturnValue(null);
      projectsSignal.set([]);
      activeProjectIdSignal.set(null);

      await expect(service.syncTaskPlannerFields('task-orphan', { expected_minutes: 10 }))
        .resolves.toBe(false);

      expect(mockTaskOps.updateTaskExpectedMinutes).not.toHaveBeenCalled();
      expect(mockTaskOps.updateTaskCognitiveLoad).not.toHaveBeenCalled();
      expect(mockTaskOps.updateTaskWaitMinutes).not.toHaveBeenCalled();
      expect(mockTaskOps.updateTaskPlannerFields).not.toHaveBeenCalled();
      expect(mockTaskStore.setTask).not.toHaveBeenCalled();
    });

    it('should durably enqueue cross-project planner patches before committing local store state', async () => {
      const task = createMockTask({ id: 'task-1', expected_minutes: 30 });
      mockTaskStore.getTask.mockReturnValue(task);
      mockTaskStore.getTaskProjectId.mockReturnValue('proj-other');
      activeProjectIdSignal.set('proj-active');
      projectsSignal.set([createMockProject({ id: 'proj-other', tasks: [task] })]);

      await expect(service.syncTaskPlannerFields('task-1', {
        expected_minutes: 60,
        cognitive_load: 'high',
      })).resolves.toBe(true);

      expect(mockActionQueue.enqueueDurablyForOwner).toHaveBeenCalledWith(
        'user-1',
        expect.objectContaining({
          type: 'update',
          entityType: 'task',
          entityId: 'task-1',
          payload: expect.objectContaining({
            projectId: 'proj-other',
            sourceUserId: 'user-1',
            task: expect.objectContaining({
              id: 'task-1',
              expected_minutes: 60,
              cognitive_load: 'high',
              updatedAt: expect.any(String),
            }),
          }),
        }),
      );
      expect(mockTaskStore.setTask).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'task-1', expected_minutes: 60, cognitive_load: 'high' }),
        'proj-other',
      );
      expect(mockProjectState.updateProjects).toHaveBeenCalledWith(expect.any(Function));
    });

    it('should not commit cross-project planner patches when durable enqueue fails', async () => {
      const task = createMockTask({ id: 'task-1', expected_minutes: 30 });
      mockTaskStore.getTask.mockReturnValue(task);
      mockTaskStore.getTaskProjectId.mockReturnValue('proj-other');
      activeProjectIdSignal.set('proj-active');
      projectsSignal.set([createMockProject({ id: 'proj-other', tasks: [task] })]);
      mockActionQueue.enqueueDurablyForOwner.mockResolvedValueOnce('');

      await expect(service.syncTaskPlannerFields('task-1', { expected_minutes: 60 }))
        .resolves.toBe(false);

      expect(mockActionQueue.enqueueDurablyForOwner).toHaveBeenCalled();
      expect(mockTaskStore.setTask).not.toHaveBeenCalled();
      expect(mockProjectState.updateProjects).not.toHaveBeenCalled();
    });
  });

  // ==================== syncTaskDetail ====================

  describe('syncTaskDetail', () => {
    it('should update task content for project-task source in active project', () => {
      const task = createMockTask({ id: 'task-1' });
      mockTaskStore.getTask.mockReturnValue(task);
      mockTaskStore.getTaskProjectId.mockReturnValue('proj-1');
      activeProjectIdSignal.set('proj-1');

      const entry = createMockDockEntry({
        taskId: 'task-1',
        sourceKind: 'project-task',
        sourceProjectId: 'proj-1',
      });

      service.syncTaskDetail('task-1', 'updated detail', {
        entries: [entry],
        focusSessionContext: null,
      });

      expect(mockTaskOps.updateTaskContent).toHaveBeenCalledWith('task-1', 'updated detail');
      expect(mockBlackBoxService.update).not.toHaveBeenCalled();
    });

    it('waits for durable task content persistence before resolving active project detail sync', async () => {
      const task = createMockTask({ id: 'task-1' });
      mockTaskStore.getTask.mockReturnValue(task);
      mockTaskStore.getTaskProjectId.mockReturnValue('proj-1');
      activeProjectIdSignal.set('proj-1');

      let resolveUpdate!: () => void;
      const updatePromise = new Promise<void>(resolve => {
        resolveUpdate = resolve;
      });
      mockTaskOps.updateTaskContent.mockReturnValue(updatePromise);

      const entry = createMockDockEntry({
        taskId: 'task-1',
        sourceKind: 'project-task',
        sourceProjectId: 'proj-1',
      });

      const completion = service.syncTaskDetail('task-1', 'updated detail', {
        entries: [entry],
        focusSessionContext: null,
      }) as unknown as Promise<void>;

      await Promise.resolve();
      expect(completion).toBeTruthy();
      expect(typeof completion.then).toBe('function');
      await expect(Promise.race([
        completion.then(() => 'resolved' as const),
        Promise.resolve('pending' as const),
      ])).resolves.toBe('pending');

      resolveUpdate();
      await completion;
    });

    it('should durably update source black-box detail for dock-created entries', () => {
      const entry = createMockDockEntry({
        taskId: 'inline-task',
        title: 'Inline title',
        sourceKind: 'dock-created',
        sourceBlackBoxEntryId: 'bb-inline',
        detail: 'old detail',
      });

      service.syncTaskDetail('inline-task', 'updated detail', {
        entries: [entry],
        focusSessionContext: { id: 'session-1', startedAt: Date.now() },
      });

      expect(mockBlackBoxService.updateDurably).toHaveBeenCalledWith('bb-inline', expect.objectContaining({
        content: 'updated detail',
        focusMeta: expect.objectContaining({
          source: 'focus-console-inline',
          sessionId: 'session-1',
          title: 'Inline title',
          detail: 'updated detail',
        }),
      }));
      expect(mockBlackBoxService.update).not.toHaveBeenCalled();
    });

    it('should durably enqueue cross-project task detail before committing local store state', async () => {
      const task = createMockTask({ id: 'task-1', content: 'old' });
      mockTaskStore.getTask.mockReturnValue(task);
      mockTaskStore.getTaskProjectId.mockReturnValue('proj-other');
      activeProjectIdSignal.set('proj-active');
      projectsSignal.set([createMockProject({ id: 'proj-other', tasks: [task] })]);
      const entry = createMockDockEntry({
        taskId: 'task-1',
        sourceKind: 'project-task',
        sourceProjectId: 'proj-other',
      });

      await expect(service.syncTaskDetail('task-1', 'updated detail', {
        entries: [entry],
        focusSessionContext: null,
      })).resolves.toBe(true);

      expect(mockActionQueue.enqueueDurablyForOwner).toHaveBeenCalledWith(
        'user-1',
        expect.objectContaining({
          type: 'update',
          entityType: 'task',
          entityId: 'task-1',
          payload: expect.objectContaining({
            projectId: 'proj-other',
            task: expect.objectContaining({ id: 'task-1', content: 'updated detail' }),
          }),
        }),
      );
      expect(mockTaskStore.setTask).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'task-1', content: 'updated detail' }),
        'proj-other',
      );
    });

    it('should not commit cross-project detail when durable enqueue fails', async () => {
      const task = createMockTask({ id: 'task-1', content: 'old' });
      mockTaskStore.getTask.mockReturnValue(task);
      mockTaskStore.getTaskProjectId.mockReturnValue('proj-other');
      activeProjectIdSignal.set('proj-active');
      projectsSignal.set([createMockProject({ id: 'proj-other', tasks: [task] })]);
      mockActionQueue.enqueueDurablyForOwner.mockResolvedValueOnce('');
      const entry = createMockDockEntry({
        taskId: 'task-1',
        sourceKind: 'project-task',
        sourceProjectId: 'proj-other',
      });

      await expect(service.syncTaskDetail('task-1', 'updated detail', {
        entries: [entry],
        focusSessionContext: null,
      })).resolves.toBe(false);

      expect(mockTaskStore.setTask).not.toHaveBeenCalled();
      expect(mockProjectState.updateProjects).not.toHaveBeenCalled();
    });
  });

  describe('syncInlineCompletion', () => {
    it('should mark the source black-box entry completed for dock-created entries', async () => {
      const entry = createMockDockEntry({
        taskId: 'inline-task',
        sourceKind: 'dock-created',
        sourceBlackBoxEntryId: 'bb-inline-task',
      });

      await expect(service.syncInlineCompletion(entry)).resolves.toBe(true);

      expect(mockBlackBoxService.markAsCompletedDurably).toHaveBeenCalledWith('bb-inline-task');
      expect(mockBlackBoxService.markAsCompleted).not.toHaveBeenCalled();
    });

    it('should fail closed when a dock-created entry has no source black-box entry', async () => {
      const entry = createMockDockEntry({
        sourceKind: 'dock-created',
        sourceBlackBoxEntryId: null,
      });

      await expect(service.syncInlineCompletion(entry)).resolves.toBe(false);

      expect(mockBlackBoxService.markAsCompletedDurably).not.toHaveBeenCalled();
      expect(mockBlackBoxService.markAsCompleted).not.toHaveBeenCalled();
    });

    it('should skip source black-box entries that are already completed', async () => {
      mockBlackBoxService.getEntry.mockReturnValue({ isCompleted: true });
      const entry = createMockDockEntry({
        sourceKind: 'dock-created',
        sourceBlackBoxEntryId: 'bb-completed',
      });

      await expect(service.syncInlineCompletion(entry)).resolves.toBe(true);

      expect(mockBlackBoxService.markAsCompletedDurably).not.toHaveBeenCalled();
      expect(mockBlackBoxService.markAsCompleted).not.toHaveBeenCalled();
    });

    it('should sync every completed dock-created entry in a restored entries batch', () => {
      service.syncCompletedInlineEntries([
        createMockDockEntry({
          taskId: 'inline-completed',
          sourceKind: 'dock-created',
          sourceBlackBoxEntryId: 'bb-completed-inline',
          status: 'completed',
        }),
        createMockDockEntry({
          taskId: 'inline-active',
          sourceKind: 'dock-created',
          sourceBlackBoxEntryId: 'bb-active-inline',
          status: 'pending_start',
        }),
        createMockDockEntry({
          taskId: 'project-completed',
          sourceKind: 'project-task',
          status: 'completed',
        }),
      ]);

      expect(mockBlackBoxService.markAsCompletedDurably).toHaveBeenCalledTimes(1);
      expect(mockBlackBoxService.markAsCompletedDurably).toHaveBeenCalledWith('bb-completed-inline');
      expect(mockBlackBoxService.markAsCompleted).not.toHaveBeenCalled();
    });
  });

  // ==================== applyCrossProjectTaskPatch ====================

  describe('applyCrossProjectTaskPatch', () => {
    it.each([
      {
        name: 'A to B',
        transition: () => {
          mockAuthService.currentUserId.mockReturnValue('user-2');
          mockAuthService.captureAuthIdentityFence.mockReturnValue('fence-b');
        },
      },
      {
        name: 'A to B to A',
        transition: () => {
          mockAuthService.currentUserId.mockReturnValue('user-2');
          mockAuthService.captureAuthIdentityFence.mockReturnValue('fence-b');
          mockAuthService.currentUserId.mockReturnValue('user-1');
          mockAuthService.captureAuthIdentityFence.mockReturnValue('fence-c');
        },
      },
      {
        name: 'same-owner relogin',
        transition: () => {
          mockAuthService.captureAuthIdentityFence.mockReturnValue('fence-relogin');
        },
      },
    ])('should retain the durable A action without local publication after $name', async ({ transition }) => {
      let resolveEnqueue!: (actionId: string) => void;
      mockActionQueue.enqueueDurablyForOwner.mockReturnValueOnce(new Promise<string>(resolve => {
        resolveEnqueue = resolve;
      }));
      const task = createMockTask({ id: 'task-1', content: 'old' });
      mockTaskStore.getTask.mockReturnValue(task);
      projectsSignal.set([createMockProject({ id: 'proj-other', tasks: [task] })]);

      const mutation = service.applyCrossProjectTaskPatch('task-1', 'proj-other', { content: 'new' });
      expect(mockActionQueue.enqueueDurablyForOwner).toHaveBeenCalledWith(
        'user-1',
        expect.objectContaining({
          entityId: 'task-1',
          payload: expect.objectContaining({
            projectId: 'proj-other',
            sourceUserId: 'user-1',
            task: expect.objectContaining({ id: 'task-1', content: 'new' }),
          }),
        }),
      );

      transition();
      resolveEnqueue('action-a');

      await expect(mutation).resolves.toBe(false);
      expect(mockActionQueue.enqueueDurablyForOwner).toHaveBeenCalledTimes(1);
      expect(mockTaskStore.setTask).not.toHaveBeenCalled();
      expect(mockProjectState.updateProjects).not.toHaveBeenCalled();
    });

    it('should call taskStore.setTask and projectState.updateProjects after durable enqueue succeeds', async () => {
      const task = createMockTask({ id: 'task-1', content: 'old' });
      mockTaskStore.getTask.mockReturnValue(task);

      const project = createMockProject({
        id: 'proj-other',
        tasks: [task],
      });
      projectsSignal.set([project]);

      await expect(service.applyCrossProjectTaskPatch('task-1', 'proj-other', { content: 'new' }))
        .resolves.toBe(true);

      expect(mockTaskStore.setTask).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'task-1', content: 'new' }),
        'proj-other',
      );
      expect(mockProjectState.updateProjects).toHaveBeenCalledWith(expect.any(Function));
    });

    it('should leave cross-project task state untouched when durable enqueue fails', async () => {
      const task = createMockTask({ id: 'task-1', content: 'old' });
      mockTaskStore.getTask.mockReturnValue(task);
      projectsSignal.set([createMockProject({ id: 'proj-other', tasks: [task] })]);
      mockActionQueue.enqueueDurablyForOwner.mockResolvedValueOnce('');

      await expect(service.applyCrossProjectTaskPatch('task-1', 'proj-other', { content: 'new' }))
        .resolves.toBe(false);

      expect(mockTaskStore.setTask).not.toHaveBeenCalled();
      expect(mockProjectState.updateProjects).not.toHaveBeenCalled();
    });
  });
});
