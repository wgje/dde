/**
 * ParkingService 单元测试
 * 覆盖 A12 验收标准 P-01 ~ P-40
 */

import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Project, Task, TaskParkingMeta } from '../models';
import { TaskStore, ProjectStore } from '../app/core/state/stores';
import { ParkingService } from './parking.service';
import { ToastService } from './toast.service';
import { UndoService } from './undo.service';
import { LoggerService } from './logger.service';
import { BeforeUnloadManagerService } from './before-unload-manager.service';
import { StartupTierOrchestratorService } from './startup-tier-orchestrator.service';
import { GateService } from './gate.service';
import { ContextRestoreService } from './context-restore.service';
import { ProjectDataService } from '../core-bridge';
import { PARKING_CONFIG } from '../config/parking.config';
import { AUTH_CONFIG } from '../config/auth.config';
import { AuthService } from './auth.service';
import { TaskOperationAdapterService } from './task-operation-adapter.service';
import { SessionRuntimeResetRegistry } from './session-runtime-reset.service';
import { resetBrowserNetworkSuspensionTrackingForTests } from '../utils/browser-network-suspension';
import { registerParkingCleanupSpecs } from './parking-cleanup.spec-helpers';
import { registerParkingLightweightSyncSpecs } from './parking-lightweight-sync.spec-helpers';
import { registerParkingNoteAndKeepSpecs } from './parking-note-and-keep.spec-helpers';
import { registerParkingPinnedSpecs } from './parking-pinned.spec-helpers';
import { registerParkingSoftLimitAndLifecycleSpecs } from './parking-soft-limit-and-lifecycle.spec-helpers';
import { registerParkingStatusChangeSpecs } from './parking-status-change.spec-helpers';
import { registerParkingTaskActionsSpecs } from './parking-task-actions.spec-helpers';

describe('ParkingService', () => {
  let service: ParkingService;
  let sessionRuntimeReset: SessionRuntimeResetRegistry;
  let onlineSpy: ReturnType<typeof vi.spyOn> | null = null;

  const taskMap = new Map<string, Task>();
  const parkedTasksSignal = signal<Task[]>([]);
  const parkedTaskIdsSignal = signal<Set<string>>(new Set());
  const projectListSignal = signal<Project[]>([]);

  const syncParkedSignals = (): void => {
    const parked = Array.from(taskMap.values()).filter(t => !!t.parkingMeta);
    parkedTasksSignal.set(parked);
    parkedTaskIdsSignal.set(new Set(parked.map(t => t.id)));
  };

  const createParkingMeta = (overrides: Partial<TaskParkingMeta> = {}): TaskParkingMeta => ({
    state: 'parked',
    parkedAt: new Date(Date.now() - 80 * 60 * 60 * 1000).toISOString(),
    lastVisitedAt: new Date(Date.now() - 80 * 60 * 60 * 1000).toISOString(),
    contextSnapshot: null,
    reminder: null,
    pinned: false,
    ...overrides,
  });

  const createTask = (overrides: Partial<Task> = {}): Task => ({
    id: crypto.randomUUID(),
    title: '测试任务',
    content: '',
    stage: 0,
    parentId: null,
    order: 0,
    rank: 10000,
    status: 'active',
    x: 0,
    y: 0,
    displayId: 'T-1',
    createdDate: new Date().toISOString(),
    deletedAt: null,
    parkingMeta: null,
    ...overrides,
  });

  const createProject = (projectId: string): Project => ({
    id: projectId,
    name: '测试项目',
    description: '',
    createdDate: new Date().toISOString(),
    tasks: Array.from(taskMap.values()),
    connections: [],
    deletedAt: null,
  });

  const mockTaskStore = {
    parkedTaskIds: parkedTaskIdsSignal,
    parkedTasks: parkedTasksSignal,
    getTask: vi.fn((id: string) => taskMap.get(id)),
    setTask: vi.fn((task: Task, _projectId: string) => {
      taskMap.set(task.id, task);
      syncParkedSignals();
    }),
    getTaskProjectId: vi.fn((_taskId?: string) => 'proj-1'),
  };

  const mockTaskOpsAdapter = {
    updateTaskParkingMeta: vi.fn(async (taskId: string, parkingMeta: TaskParkingMeta | undefined) => {
      const current = taskMap.get(taskId);
      if (!current) return false;
      taskMap.set(taskId, {
        ...current,
        parkingMeta,
        updatedAt: new Date().toISOString(),
      });
      syncParkedSignals();
      return true;
    }),
    updateTaskParkingMetaBatch: vi.fn(async (
      projectOrUpdates: string | Array<{ taskId: string; parkingMeta: TaskParkingMeta | undefined }>,
      explicitUpdates?: Array<{ taskId: string; parkingMeta: TaskParkingMeta | undefined }>,
    ) => {
      const updates = typeof projectOrUpdates === 'string' ? explicitUpdates ?? [] : projectOrUpdates;
      for (const update of updates) {
        const current = taskMap.get(update.taskId);
        if (!current) return false;
      }
      for (const update of updates) {
        const current = taskMap.get(update.taskId)!;
        taskMap.set(update.taskId, {
          ...current,
          parkingMeta: update.parkingMeta,
          updatedAt: new Date().toISOString(),
        });
      }
      syncParkedSignals();
      return true;
    }),
    updateTaskContent: vi.fn(async (taskId: string, content: string) => {
      const current = taskMap.get(taskId);
      if (!current) return false;
      taskMap.set(taskId, {
        ...current,
        content,
        updatedAt: new Date().toISOString(),
      });
      syncParkedSignals();
      return true;
    }),
  };

  const mockProjectStore = {
    activeProjectId: signal<string | null>('proj-1'),
    projects: projectListSignal,
    getProject: vi.fn((projectId: string): Project => ({
      id: projectId,
      name: '测试项目',
      description: '',
      createdDate: new Date().toISOString(),
      tasks: Array.from(taskMap.values()),
      connections: [],
    })),
  };

  const mockToastService = {
    info: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    show: vi.fn(),
  };

  const mockUndoService = {
    recordAction: vi.fn(),
    createProjectSnapshot: vi.fn((project: { id: string; tasks: Task[]; connections: unknown[] }) => ({
      id: project.id,
      tasks: project.tasks.map(t => ({ ...t })),
      connections: [...project.connections],
    })),
  };

  const mockLoggerService = {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };

  const mockBeforeUnloadManager = {
    register: vi.fn(),
  };

  const mockStartupOrchestrator = {
    isTierReady: vi.fn(() => true),
  };

  const mockGateService = {
    isActive: signal(false),
  };

  const mockContextRestoreService = {
    saveSnapshot: vi.fn(),
    restore: vi.fn(),
  };

  const currentUserIdSignal = signal<string | null>(null);

  const mockAuthService = {
    currentUserId: currentUserIdSignal,
  };

  const mockProjectDataService = {
    loadParkedTasksCache: vi.fn(async () => ({ entries: [], cursor: null })),
    pullParkedTasksDelta: vi.fn(async () => ({
      entries: [],
      removedTasks: [] as { taskId: string; updatedAt: string | null }[],
      removedTaskIds: [] as string[],
      nextCursor: null as string | null,
    })),
    saveParkedTasksCache: vi.fn(async () => {}),
  };

  const setVisibilityState = (state: DocumentVisibilityState): void => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: state,
    });
  };

  const runEvictionCheck = (): Promise<void> =>
    (service as unknown as { runEvictionCheck: () => Promise<void> }).runEvictionCheck();

  const flushBackgroundEvictionCheck = async (): Promise<void> => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  };

  beforeEach(() => {
    resetBrowserNetworkSuspensionTrackingForTests();
    onlineSpy = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-23T10:00:00.000Z'));
    setVisibilityState('visible');

    taskMap.clear();
    projectListSignal.set([createProject('proj-1')]);
    parkedTasksSignal.set([]);
    parkedTaskIdsSignal.set(new Set());
    mockGateService.isActive.set(false);
    currentUserIdSignal.set(null);
    localStorage.removeItem(AUTH_CONFIG.LOCAL_MODE_CACHE_KEY);
    localStorage.removeItem(PARKING_CONFIG.SNAPSHOT_DRAFT_KEY);
    vi.clearAllMocks();
    mockTaskStore.getTaskProjectId.mockReturnValue('proj-1');
    mockProjectStore.getProject.mockImplementation((projectId: string) => ({
      ...createProject(projectId),
      tasks: Array.from(taskMap.values()),
    }));
    mockTaskOpsAdapter.updateTaskParkingMeta.mockImplementation(async (taskId: string, parkingMeta: TaskParkingMeta | undefined) => {
      const current = taskMap.get(taskId);
      if (!current) return false;
      taskMap.set(taskId, {
        ...current,
        parkingMeta,
        updatedAt: new Date().toISOString(),
      });
      syncParkedSignals();
      return true;
    });
    mockTaskOpsAdapter.updateTaskParkingMetaBatch.mockImplementation(async (
      projectOrUpdates: string | Array<{ taskId: string; parkingMeta: TaskParkingMeta | undefined }>,
      explicitUpdates?: Array<{ taskId: string; parkingMeta: TaskParkingMeta | undefined }>,
    ) => {
      const updates = typeof projectOrUpdates === 'string' ? explicitUpdates ?? [] : projectOrUpdates;
      for (const update of updates) {
        const current = taskMap.get(update.taskId);
        if (!current) return false;
      }
      for (const update of updates) {
        const current = taskMap.get(update.taskId)!;
        taskMap.set(update.taskId, {
          ...current,
          parkingMeta: update.parkingMeta,
          updatedAt: new Date().toISOString(),
        });
      }
      syncParkedSignals();
      return true;
    });
    mockTaskOpsAdapter.updateTaskContent.mockImplementation(async (taskId: string, content: string) => {
      const current = taskMap.get(taskId);
      if (!current) return false;
      taskMap.set(taskId, {
        ...current,
        content,
        updatedAt: new Date().toISOString(),
      });
      syncParkedSignals();
      return true;
    });

    TestBed.configureTestingModule({
      providers: [
        ParkingService,
        SessionRuntimeResetRegistry,
        { provide: TaskStore, useValue: mockTaskStore },
        { provide: ProjectStore, useValue: mockProjectStore },
        { provide: ToastService, useValue: mockToastService },
        { provide: UndoService, useValue: mockUndoService },
        { provide: LoggerService, useValue: mockLoggerService },
        { provide: BeforeUnloadManagerService, useValue: mockBeforeUnloadManager },
        { provide: StartupTierOrchestratorService, useValue: mockStartupOrchestrator },
        { provide: GateService, useValue: mockGateService },
        { provide: ContextRestoreService, useValue: mockContextRestoreService },
        { provide: ProjectDataService, useValue: mockProjectDataService },
        { provide: AuthService, useValue: mockAuthService },
        { provide: TaskOperationAdapterService, useValue: mockTaskOpsAdapter },
      ],
    });

    service = TestBed.inject(ParkingService);
    sessionRuntimeReset = TestBed.inject(SessionRuntimeResetRegistry);
  });

  afterEach(() => {
    service?.ngOnDestroy();
    onlineSpy?.mockRestore();
    onlineSpy = null;
    resetBrowserNetworkSuspensionTrackingForTests();
    setVisibilityState('visible');
    localStorage.removeItem(PARKING_CONFIG.SNAPSHOT_DRAFT_KEY);
    vi.useRealTimers();
    TestBed.resetTestingModule();
  });

  // ─── P-01: 预览任务刷新 lastVisitedAt ───

  describe('P-01: previewTask', () => {
    it('预览停泊任务应先 durable 刷新 lastVisitedAt 再进入预览', async () => {
      const oldTime = new Date('2026-02-20T10:00:00.000Z').toISOString();
      const task = createTask({
        id: 'preview-1',
        parkingMeta: createParkingMeta({ lastVisitedAt: oldTime }),
      });
      taskMap.set(task.id, task);
      syncParkedSignals();

      await expect(service.previewTask('preview-1')).resolves.toBe(true);

      const updated = taskMap.get('preview-1');
      expect(updated?.parkingMeta?.lastVisitedAt).not.toBe(oldTime);
      expect(service.previewingTaskId()).toBe('preview-1');
    });

    it('非停泊任务预览应静默忽略', async () => {
      const task = createTask({ id: 'normal-1', parkingMeta: null });
      taskMap.set(task.id, task);

      await expect(service.previewTask('normal-1')).resolves.toBe(false);
      expect(service.previewingTaskId()).toBeNull();
    });

    it('预览本地 durable 写入失败时不应切换预览状态', async () => {
      const oldTime = new Date('2026-02-20T10:00:00.000Z').toISOString();
      const task = createTask({
        id: 'preview-fail',
        parkingMeta: createParkingMeta({ lastVisitedAt: oldTime }),
      });
      taskMap.set(task.id, task);
      syncParkedSignals();
      mockTaskOpsAdapter.updateTaskParkingMeta.mockResolvedValueOnce(false);

      await expect(service.previewTask('preview-fail')).resolves.toBe(false);

      expect(taskMap.get('preview-fail')?.parkingMeta?.lastVisitedAt).toBe(oldTime);
      expect(service.previewingTaskId()).toBeNull();
    });
  });

  // ─── P-02: startWork 切换任务 ───

  describe('P-02: startWork', () => {
    const arrangeCrossProjectSameId = () => {
      const focused = createTask({ id: 'shared', parkingMeta: createParkingMeta({ state: 'focused' }) });
      const target = createTask({ id: 'shared', parkingMeta: createParkingMeta() });
      const projectTasks = new Map([['project-a', target], ['project-b', focused]]);
      taskMap.set(focused.id, focused);
      syncParkedSignals();
      mockTaskStore.getTaskProjectId.mockReturnValue('project-b');
      mockProjectStore.getProject.mockImplementation((projectId: string) => ({
        ...createProject(projectId),
        tasks: [projectTasks.get(projectId)!],
      }));
      return {
        applyUpdates: (projectId: string, updates: Array<{ taskId: string; parkingMeta: TaskParkingMeta | undefined }>) => {
          const current = projectTasks.get(projectId)!;
          const update = updates.find(candidate => candidate.taskId === current.id)!;
          projectTasks.set(projectId, { ...current, parkingMeta: update.parkingMeta });
        },
      };
    };

    it('切换到目标任务并将当前 focused 停泊', async () => {
      const currentFocused = createTask({
        id: 'focused-1',
        title: '当前任务',
        parkingMeta: createParkingMeta({ state: 'focused', parkedAt: null }),
      });
      const targetTask = createTask({
        id: 'parked-1',
        title: '目标任务',
        parkingMeta: createParkingMeta({ state: 'parked' }),
      });
      taskMap.set(currentFocused.id, currentFocused);
      taskMap.set(targetTask.id, targetTask);
      syncParkedSignals();

      await expect(service.startWork(targetTask.id)).resolves.toBe(true);

      // 当前 focused → parked
      expect(taskMap.get('focused-1')?.parkingMeta?.state).toBe('parked');
      // 目标 → focused
      expect(taskMap.get('parked-1')?.parkingMeta?.state).toBe('focused');
    });

    it('应保存当前 focused 任务的上下文快照', async () => {
      const currentFocused = createTask({
        id: 'focused-save',
        parkingMeta: createParkingMeta({ state: 'focused', parkedAt: null }),
      });
      const target = createTask({
        id: 'target-save',
        parkingMeta: createParkingMeta({ state: 'parked' }),
      });
      taskMap.set(currentFocused.id, currentFocused);
      taskMap.set(target.id, target);
      syncParkedSignals();

      await service.startWork(target.id);

      expect(mockContextRestoreService.saveSnapshot).toHaveBeenCalledWith('focused-save');
    });

    it('same-project startWork uses one explicit-project durable batch', async () => {
      const focused = createTask({ id: 'focused-a', parkingMeta: createParkingMeta({ state: 'focused' }) });
      const target = createTask({ id: 'target-a', parkingMeta: createParkingMeta() });
      taskMap.set(focused.id, focused);
      taskMap.set(target.id, target);
      syncParkedSignals();
      mockTaskStore.getTaskProjectId.mockReturnValue('project-a');
      mockProjectStore.getProject.mockReturnValue(createProject('project-a'));

      await expect(service.startWork('project-a', target.id)).resolves.toBe(true);

      expect(mockTaskOpsAdapter.updateTaskParkingMetaBatch).toHaveBeenCalledTimes(1);
      expect(mockTaskOpsAdapter.updateTaskParkingMetaBatch).toHaveBeenCalledWith(
        'project-a',
        expect.arrayContaining([
          expect.objectContaining({ taskId: focused.id }),
          expect.objectContaining({ taskId: target.id }),
        ]),
      );
    });

    it('cross-project startWork commits demotion before promotion and reports partial failure', async () => {
      const focused = createTask({ id: 'focused-b', parkingMeta: createParkingMeta({ state: 'focused' }) });
      const target = createTask({ id: 'target-a', parkingMeta: createParkingMeta() });
      taskMap.set(focused.id, focused);
      taskMap.set(target.id, target);
      syncParkedSignals();
      mockTaskStore.getTaskProjectId.mockImplementation((taskId?: string) =>
        taskId === focused.id ? 'project-b' : 'project-a');
      mockProjectStore.getProject.mockImplementation((projectId: string) => ({
        ...createProject(projectId),
        tasks: Array.from(taskMap.values()).filter(task =>
          projectId === 'project-b' ? task.id === focused.id : task.id === target.id),
      }));
      mockTaskOpsAdapter.updateTaskParkingMetaBatch.mockImplementation(async (
        projectIdOrUpdates: string | Array<{ taskId: string; parkingMeta: TaskParkingMeta | undefined }>,
        explicitUpdates?: Array<{ taskId: string; parkingMeta: TaskParkingMeta | undefined }>,
      ) => {
        if (typeof projectIdOrUpdates !== 'string' || !explicitUpdates) return true;
        if (projectIdOrUpdates === 'project-a') return false;
        for (const update of explicitUpdates) {
          taskMap.set(update.taskId, { ...taskMap.get(update.taskId)!, parkingMeta: update.parkingMeta });
        }
        return true;
      });

      await expect(service.startWork('project-a', target.id)).resolves.toBe(false);

      expect(mockTaskOpsAdapter.updateTaskParkingMetaBatch.mock.calls.map(call => call[0]))
        .toEqual(['project-b', 'project-a']);
      expect(mockUndoService.recordAction).toHaveBeenCalledTimes(1);
      expect(mockUndoService.recordAction).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'project-b' }));
      expect(mockToastService.success).not.toHaveBeenCalled();
    });

    it('cross-project startWork demotes the exact same-id B task before promoting A', async () => {
      const { applyUpdates } = arrangeCrossProjectSameId();
      const calls: Array<{
        projectId: string;
        updates: Array<{ taskId: string; parkingMeta: TaskParkingMeta | undefined }>;
      }> = [];
      mockTaskOpsAdapter.updateTaskParkingMetaBatch.mockImplementation(async (
        projectIdOrUpdates: string | Array<{ taskId: string; parkingMeta: TaskParkingMeta | undefined }>,
        explicitUpdates?: Array<{ taskId: string; parkingMeta: TaskParkingMeta | undefined }>,
      ) => {
        if (typeof projectIdOrUpdates !== 'string' || !explicitUpdates) return false;
        calls.push({ projectId: projectIdOrUpdates, updates: explicitUpdates });
        applyUpdates(projectIdOrUpdates, explicitUpdates);
        return true;
      });

      await expect(service.startWork('project-a', 'shared')).resolves.toBe(true);

      expect(calls.map(call => call.projectId)).toEqual(['project-b', 'project-a']);
      expect(calls[0]?.updates).toEqual([
        expect.objectContaining({ taskId: 'shared', parkingMeta: expect.objectContaining({ state: 'parked' }) }),
      ]);
      expect(calls[1]?.updates).toEqual([
        expect.objectContaining({ taskId: 'shared', parkingMeta: expect.objectContaining({ state: 'focused' }) }),
      ]);
      expect(mockContextRestoreService.saveSnapshot).toHaveBeenCalledWith('project-b', 'shared');
      expect(mockUndoService.recordAction).toHaveBeenCalledTimes(2);
    });

    it('cross-project same-id startWork stops before A promotion when B demotion fails', async () => {
      arrangeCrossProjectSameId();
      const projects: string[] = [];
      mockTaskOpsAdapter.updateTaskParkingMetaBatch.mockImplementation(async (projectIdOrUpdates) => {
        if (typeof projectIdOrUpdates !== 'string') return false;
        projects.push(projectIdOrUpdates);
        return false;
      });

      await expect(service.startWork('project-a', 'shared')).resolves.toBe(false);

      expect(projects).toEqual(['project-b']);
      expect(mockUndoService.recordAction).not.toHaveBeenCalled();
      expect(mockToastService.success).not.toHaveBeenCalled();
    });

    it('cross-project same-id startWork retains only B undo when A promotion fails', async () => {
      const { applyUpdates } = arrangeCrossProjectSameId();
      const projects: string[] = [];
      mockTaskOpsAdapter.updateTaskParkingMetaBatch.mockImplementation(async (projectIdOrUpdates, explicitUpdates) => {
        if (typeof projectIdOrUpdates !== 'string' || !explicitUpdates) return false;
        projects.push(projectIdOrUpdates);
        if (projectIdOrUpdates !== 'project-b') return false;
        applyUpdates(projectIdOrUpdates, explicitUpdates);
        return true;
      });

      await expect(service.startWork('project-a', 'shared')).resolves.toBe(false);

      expect(projects).toEqual(['project-b', 'project-a']);
      expect(mockUndoService.recordAction).toHaveBeenCalledTimes(1);
      expect(mockUndoService.recordAction).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'project-b' }));
      expect(mockToastService.success).not.toHaveBeenCalled();
    });

    it('应恢复目标任务的上下文快照', async () => {
      const snapshot = {
        savedAt: new Date().toISOString(),
        contentHash: 'hash',
        viewMode: 'text' as const,
        cursorPosition: { line: 10, column: 5 },
        scrollAnchor: null,
        structuralAnchor: null,
        flowViewport: null,
      };
      const target = createTask({
        id: 'restore-target',
        parkingMeta: createParkingMeta({ state: 'parked', contextSnapshot: snapshot }),
      });
      taskMap.set(target.id, target);
      syncParkedSignals();

      await service.startWork(target.id);

      expect(mockContextRestoreService.restore).toHaveBeenCalledWith('restore-target', snapshot);
    });

    it('目标不存在时应 warn 并退出', async () => {
      await expect(service.startWork('nonexistent')).resolves.toBe(false);
      expect(mockLoggerService.warn).toHaveBeenCalled();
    });

    it('非 active 状态任务不应切换', async () => {
      const completedTask = createTask({
        id: 'completed-task',
        status: 'completed',
        parkingMeta: createParkingMeta(),
      });
      taskMap.set(completedTask.id, completedTask);
      syncParkedSignals();

      await expect(service.startWork('completed-task')).resolves.toBe(false);

      expect(mockLoggerService.warn).toHaveBeenCalled();
    });

    it('记录 task-park 的 Undo 操作（P-34）', async () => {
      const currentFocused = createTask({
        id: 'undo-focused',
        title: '当前任务',
        parkingMeta: createParkingMeta({ state: 'focused', parkedAt: null }),
      });
      const targetTask = createTask({
        id: 'undo-target',
        title: '目标任务',
        parkingMeta: createParkingMeta({ state: 'parked' }),
      });
      taskMap.set(currentFocused.id, currentFocused);
      taskMap.set(targetTask.id, targetTask);
      syncParkedSignals();

      await service.startWork(targetTask.id);

      expect(mockUndoService.recordAction).toHaveBeenCalled();
      const action = mockUndoService.recordAction.mock.calls[0][0] as {
        type: string;
        data: { before: { tasks: Task[] } };
      };
      expect(action.type).toBe('task-park');
      expect(action.data.before.tasks.length).toBe(2);
    });

    it('本地 durable 批量切换失败时不应恢复上下文、清预览或记录 undo', async () => {
      const snapshot = {
        savedAt: new Date().toISOString(),
        contentHash: 'hash',
        viewMode: 'text' as const,
        cursorPosition: { line: 10, column: 5 },
        scrollAnchor: null,
        structuralAnchor: null,
        flowViewport: null,
      };
      const currentFocused = createTask({
        id: 'focused-fail',
        parkingMeta: createParkingMeta({ state: 'focused', parkedAt: null }),
      });
      const targetTask = createTask({
        id: 'target-fail',
        parkingMeta: createParkingMeta({ state: 'parked', contextSnapshot: snapshot }),
      });
      taskMap.set(currentFocused.id, currentFocused);
      taskMap.set(targetTask.id, targetTask);
      syncParkedSignals();
      await service.previewTask(targetTask.id);
      mockTaskOpsAdapter.updateTaskParkingMetaBatch.mockResolvedValueOnce(false);

      await expect(service.startWork(targetTask.id)).resolves.toBe(false);

      expect(taskMap.get('focused-fail')?.parkingMeta?.state).toBe('focused');
      expect(taskMap.get('target-fail')?.parkingMeta?.state).toBe('parked');
      expect(service.previewingTaskId()).toBe('target-fail');
      expect(mockContextRestoreService.restore).not.toHaveBeenCalledWith('target-fail', snapshot);
      expect(mockUndoService.recordAction).not.toHaveBeenCalled();
    });
  });

  registerParkingCleanupSpecs({
    getService: () => service,
    createTask,
    createParkingMeta,
    currentUserIdSignal,
    setVisibilityState,
    syncParkedSignals,
    runEvictionCheck,
    flushBackgroundEvictionCheck,
    taskMap,
    mockTaskOpsAdapter,
    mockToastService,
    mockProjectDataService,
    mockLoggerService,
    getSessionRuntimeReset: () => sessionRuntimeReset,
  });

  registerParkingLightweightSyncSpecs({
    getService: () => service,
    createParkingMeta,
    createProject,
    createTask,
    currentUserIdSignal,
    projectListSignal,
    setVisibilityState,
    syncParkedSignals,
    taskMap,
    mockProjectDataService,
  });

  registerParkingSoftLimitAndLifecycleSpecs({
    getService: () => service,
    createTask,
    createParkingMeta,
    taskMap,
    syncParkedSignals,
    mockGateService,
  });

  registerParkingStatusChangeSpecs({
    getService: () => service,
    createTask,
    createParkingMeta,
    taskMap,
    syncParkedSignals,
  });

  registerParkingPinnedSpecs({
    getService: () => service,
    createTask,
    createParkingMeta,
    taskMap,
    syncParkedSignals,
    mockTaskOpsAdapter,
  });

  registerParkingNoteAndKeepSpecs({
    getService: () => service,
    createTask,
    createParkingMeta,
    taskMap,
    syncParkedSignals,
    mockTaskStore,
    mockTaskOpsAdapter,
    mockToastService,
  });

  // ─── parkTask ───

  registerParkingTaskActionsSpecs({
    getService: () => service,
    createTask,
    createParkingMeta,
    taskMap,
    syncParkedSignals,
    mockContextRestoreService,
    mockBeforeUnloadManager,
    mockToastService,
    mockTaskOpsAdapter,
  });
});
