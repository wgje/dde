import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DockEngineService } from './dock-engine.service';
import { TaskStore, SimpleSyncService } from '../core-bridge';
import { ActionQueueService } from './action-queue.service';
import { AuthService } from './auth.service';
import { FocusPreferenceService } from './focus-preference.service';
import { PreferenceService } from './preference.service';
import { ProjectStateService } from './project-state.service';
import { TaskOperationAdapterService } from './task-operation-adapter.service';
import { BlackBoxService } from './black-box.service';
import { LoggerService } from './logger.service';
import { ToastService } from './toast.service';
import { FocusAttentionService } from './focus-attention.service';
import { FocusHudWindowService } from './focus-hud-window.service';
import { Task } from '../models';
import { registerDockEngineAutoLaneSpecs } from './dock-engine-auto-lane.spec-helpers';
import { registerDockEngineBasicDockingSpecs } from './dock-engine-basic-docking.spec-helpers';
import { registerDockEngineCommandCenterSpecs } from './dock-engine-command-center.spec-helpers';
import { registerDockEngineConsoleCompletionSpecs } from './dock-engine-console-completion.spec-helpers';
import { registerDockEngineFocusSessionSpecs } from './dock-engine-focus-session.spec-helpers';
import { registerDockEngineRoutineLifecycleSpecs } from './dock-engine-routine-lifecycle.spec-helpers';
import { registerDockEngineSnapshotPreferenceSpecs } from './dock-engine-snapshot-preferences.spec-helpers';
import { registerDockEngineRestAndAttentionSpecs } from './dock-engine-rest-and-attention.spec-helpers';
import { DEFAULT_FOCUS_PREFERENCES } from '../models/focus';
import { resetDockEngineIdbKeyvalMocks } from './dock-engine-idb-keyval.spec-helpers';

vi.mock('idb-keyval', () => ({
  clear: vi.fn().mockResolvedValue(undefined),
  createStore: vi.fn(() => ({})),
  del: vi.fn().mockResolvedValue(undefined),
  get: vi.fn().mockResolvedValue(null),
  keys: vi.fn().mockResolvedValue([]),
  set: vi.fn().mockResolvedValue(undefined),
  update: vi.fn().mockImplementation(async (_key: unknown, updater: (value: unknown) => unknown) => {
    updater(undefined);
  }),
  values: vi.fn().mockResolvedValue([]),
}));

describe('DockEngineService', () => {
  let service: DockEngineService;
  let currentUserId: ReturnType<typeof signal<string | null>>;
  let activeProjectId: ReturnType<typeof signal<string | null>>;
  let focusPreferences: ReturnType<typeof signal<typeof DEFAULT_FOCUS_PREFERENCES>>;

  type MockAddTaskResult =
    | { ok: true; value: string }
    | { ok: false; error: { message: string } };

  type MockBlackBoxCreateResult =
    | { ok: true; value: { id: string; content: string } }
    | { ok: false; error: { message: string } };

  const taskMap = new Map<string, Task>();
  const taskProjectMap = new Map<string, string>();
  const projectConnections = new Map<string, Array<{ id: string; source: string; target: string; deletedAt?: string | null }>>();

  const mockPreferenceService = {
    saveUserPreferences: vi.fn().mockResolvedValue(true),
  };

  const mockSyncService = {
    loadFocusSession: vi.fn().mockResolvedValue(null),
    listRoutineTasks: vi.fn().mockResolvedValue([]),
    importLegacyDockSnapshot: vi.fn().mockResolvedValue(null),
  };

  const mockActionQueue = {
    enqueue: vi.fn(() => crypto.randomUUID()),
    enqueueForOwner: vi.fn().mockResolvedValue('queued-owner-action'),
    enqueueDurablyForOwner: vi.fn().mockResolvedValue('queued-owner-action'),
  };

  const mockTaskOps = {
    updateTaskContent: vi.fn(),
    updateTaskExpectedMinutes: vi.fn().mockResolvedValue(true),
    updateTaskCognitiveLoad: vi.fn().mockResolvedValue(true),
    updateTaskWaitMinutes: vi.fn().mockResolvedValue(true),
    updateTaskPlannerFields: vi.fn().mockResolvedValue(true),
    updateTaskStatus: vi.fn().mockResolvedValue(true),
    addTask: vi.fn((title: string): MockAddTaskResult => ({ ok: true, value: `created-${title}-${crypto.randomUUID()}` })),
  };

  const mockBlackBoxService = {
    create: vi.fn((payload?: { content?: string; focusMeta?: { title?: string } }): MockBlackBoxCreateResult => ({
      ok: true,
      value: {
        id: `bb-${crypto.randomUUID()}`,
        content: payload?.content ?? payload?.focusMeta?.title ?? '',
      },
    })),
    createDurably: vi.fn((payload?: { content?: string; focusMeta?: { title?: string } }): Promise<MockBlackBoxCreateResult> => Promise.resolve({
      ok: true as const,
      value: {
        id: `bb-${crypto.randomUUID()}`,
        content: payload?.content ?? payload?.focusMeta?.title ?? '',
      },
    })),
    getEntry: vi.fn(() => undefined),
    archive: vi.fn(() => ({ ok: true as const, value: undefined })),
    archiveDurably: vi.fn(() => Promise.resolve({ ok: true as const, value: undefined })),
    markAsCompleted: vi.fn(() => ({ ok: true as const, value: undefined })),
    markAsCompletedDurably: vi.fn(() => Promise.resolve({ ok: true as const, value: undefined })),
  };

  const mockProjectState = {
    activeProjectId: () => activeProjectId(),
    projects: () =>
      Array.from(new Set(taskProjectMap.values())).map(projectId => ({
        id: projectId,
        name: projectId,
        description: '',
        createdDate: new Date().toISOString(),
        tasks: Array.from(taskMap.values()).filter(task => taskProjectMap.get(task.id) === projectId),
        connections: projectConnections.get(projectId) ?? [],
      })),
    updateProjects: vi.fn(),
    getProject: vi.fn((id: string) => ({
      id,
      name: id,
      description: '',
      createdDate: new Date().toISOString(),
      tasks: [],
      connections: projectConnections.get(id) ?? [],
    })),
  };

  // LoggerService：测试不关注日志输出，提供最小无操作实现
  const mockLogger = {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    category: () => ({ warn: () => {}, error: () => {}, info: () => {}, debug: () => {} }),
  };

  const mockToast = {
    info: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
  };

  const mockFocusAttention = {
    updateBadge: vi.fn(),
    notify: vi.fn().mockResolvedValue(undefined),
  };

  const mockFocusHudWindow = {
    isActive: signal(false),
    isSupported: signal(true),
  };

  const mockTaskStore = {
    tasksMap: signal<Map<string, Task>>(new Map(), { equal: () => false }),
    getTask: vi.fn((id: string) => taskMap.get(id)),
    getTaskProjectId: vi.fn((id: string) => taskProjectMap.get(id) ?? null),
    getTasksByProject: vi.fn((projectId: string) =>
      Array.from(taskMap.values()).filter(task => taskProjectMap.get(task.id) === projectId),
    ),
    setTask: vi.fn((task: Task, projectId: string) => {
      taskMap.set(task.id, task);
      taskProjectMap.set(task.id, projectId);
      mockTaskStore.tasksMap.update(map => {
        map.set(task.id, task);
        return map;
      });
    }),
  };

  const mockFocusPreferenceService = {
    preferences: () => focusPreferences(),
    update: vi.fn((updates: Partial<typeof DEFAULT_FOCUS_PREFERENCES>) => {
      focusPreferences.update(current => ({ ...current, ...updates }));
    }),
  };

  const seedTask = (id: string, options?: Partial<Task> & { projectId?: string }): void => {
    const projectId = options?.projectId ?? 'project-1';
    const task: Task = {
      id,
      title: options?.title ?? id,
      content: options?.content ?? '',
      stage: options?.stage ?? null,
      parentId: options?.parentId ?? null,
      order: options?.order ?? 0,
      rank: options?.rank ?? 1,
      status: options?.status ?? 'active',
      x: options?.x ?? 0,
      y: options?.y ?? 0,
      createdDate: options?.createdDate ?? new Date().toISOString(),
      updatedAt: options?.updatedAt,
      displayId: options?.displayId ?? id,
      shortId: options?.shortId,
      hasIncompleteTask: options?.hasIncompleteTask,
      deletedAt: options?.deletedAt ?? null,
      attachments: options?.attachments,
      tags: options?.tags,
      priority: options?.priority,
      dueDate: options?.dueDate,
      expected_minutes: options?.expected_minutes ?? null,
      cognitive_load: options?.cognitive_load ?? null,
      wait_minutes: options?.wait_minutes ?? null,
      parkingMeta: options?.parkingMeta,
    };
    taskMap.set(id, task);
    taskProjectMap.set(id, projectId);
    mockTaskStore.tasksMap.update(map => {
      map.set(id, task);
      return map;
    });
  };

  const seedConnection = (projectId: string, source: string, target: string): void => {
    const list = projectConnections.get(projectId) ?? [];
    list.push({
      id: `${source}->${target}`,
      source,
      target,
      deletedAt: null,
    });
    projectConnections.set(projectId, list);
  };

  beforeEach(async () => {
    await resetDockEngineIdbKeyvalMocks();
    vi.useFakeTimers();
    localStorage.clear();
    taskMap.clear();
    taskProjectMap.clear();
    projectConnections.clear();
    currentUserId = signal('user-1');
    activeProjectId = signal('project-1');
    focusPreferences = signal({ ...DEFAULT_FOCUS_PREFERENCES });
    mockTaskStore.tasksMap.set(new Map());
    mockPreferenceService.saveUserPreferences.mockClear();
    mockSyncService.loadFocusSession.mockClear();
    mockSyncService.listRoutineTasks.mockClear();
    mockSyncService.importLegacyDockSnapshot.mockClear();
    mockActionQueue.enqueue.mockClear();
    mockActionQueue.enqueueForOwner.mockClear();
    mockActionQueue.enqueueDurablyForOwner.mockClear();
    mockTaskStore.getTasksByProject.mockClear();
    mockTaskOps.updateTaskContent.mockClear();
    mockTaskOps.updateTaskExpectedMinutes.mockClear();
    mockTaskOps.updateTaskExpectedMinutes.mockResolvedValue(true);
    mockTaskOps.updateTaskCognitiveLoad.mockClear();
    mockTaskOps.updateTaskCognitiveLoad.mockResolvedValue(true);
    mockTaskOps.updateTaskWaitMinutes.mockClear();
    mockTaskOps.updateTaskWaitMinutes.mockResolvedValue(true);
    mockTaskOps.updateTaskPlannerFields.mockClear();
    mockTaskOps.updateTaskPlannerFields.mockResolvedValue(true);
    mockTaskOps.updateTaskStatus.mockClear();
    mockTaskOps.updateTaskStatus.mockResolvedValue(true);
    mockTaskOps.addTask.mockClear();
    mockBlackBoxService.create.mockClear();
    mockBlackBoxService.createDurably.mockClear();
    mockBlackBoxService.getEntry.mockClear();
    mockBlackBoxService.getEntry.mockReturnValue(undefined);
    mockBlackBoxService.archive.mockClear();
    mockBlackBoxService.archiveDurably.mockClear();
    mockBlackBoxService.markAsCompleted.mockClear();
    mockBlackBoxService.markAsCompletedDurably.mockClear();
    mockProjectState.updateProjects.mockClear();
    mockProjectState.getProject.mockClear();
    mockToast.info.mockClear();
    mockToast.warning.mockClear();
    mockToast.error.mockClear();
    mockFocusAttention.updateBadge.mockClear();
    mockFocusAttention.notify.mockClear();
    mockFocusHudWindow.isActive.set(false);
    mockFocusPreferenceService.update.mockClear();
    mockLogger.info.mockClear();
    mockLogger.debug.mockClear();
    mockLogger.warn.mockClear();
    mockLogger.error.mockClear();

    TestBed.configureTestingModule({
      providers: [
        DockEngineService,
        { provide: TaskStore, useValue: mockTaskStore },
        { provide: PreferenceService, useValue: mockPreferenceService },
        { provide: SimpleSyncService, useValue: mockSyncService },
        { provide: ActionQueueService, useValue: mockActionQueue },
        { provide: ProjectStateService, useValue: mockProjectState },
        { provide: TaskOperationAdapterService, useValue: mockTaskOps },
        { provide: BlackBoxService, useValue: mockBlackBoxService },
        { provide: AuthService, useValue: { currentUserId } },
        { provide: FocusPreferenceService, useValue: mockFocusPreferenceService },
        { provide: LoggerService, useValue: mockLogger },
        { provide: ToastService, useValue: mockToast },
        { provide: FocusAttentionService, useValue: mockFocusAttention },
        { provide: FocusHudWindowService, useValue: mockFocusHudWindow },
      ],
    });

    service = TestBed.inject(DockEngineService);
  });

  afterEach(() => {
    TestBed.resetTestingModule();
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  registerDockEngineBasicDockingSpecs({
    service: () => service,
    seedTask,
    taskMap,
    taskProjectMap,
    mockActionQueue,
    mockBlackBoxService,
    mockFocusAttention,
    mockFocusHudWindow,
    mockFocusPreferenceService,
    mockTaskOps,
    mockTaskStore,
    mockToast,
    testBed: TestBed,
  });

  registerDockEngineAutoLaneSpecs({
    service: () => service,
    seedTask,
    seedConnection,
    taskMap,
    taskProjectMap,
    mockActionQueue,
    mockBlackBoxService,
    mockFocusAttention,
    mockFocusHudWindow,
    mockFocusPreferenceService,
    mockTaskOps,
    mockTaskStore,
    mockToast,
    testBed: TestBed,
  });

  it('dockTask should inherit expected/load/wait attributes from task entity', async () => {
    seedTask('inherit-task', {
      expected_minutes: 35,
      cognitive_load: 'high',
      wait_minutes: 8,
    });

    await service.dockTask('inherit-task');

    const entry = service.entries().find(item => item.taskId === 'inherit-task');
    expect(entry?.expectedMinutes).toBe(35);
    expect(entry?.load).toBe('high');
    expect(entry?.waitMinutes).toBe(8);
  });

  it('dockTask should auto-raise expected minutes when inherited wait exceeds expected', async () => {
    seedTask('inherit-invalid-task', {
      expected_minutes: 10,
      cognitive_load: 'low',
      wait_minutes: 25,
    });

    await service.dockTask('inherit-invalid-task');

    const entry = service.entries().find(item => item.taskId === 'inherit-invalid-task');
    expect(entry?.expectedMinutes).toBe(25);
    expect(entry?.waitMinutes).toBe(25);
    expect(mockTaskOps.updateTaskPlannerFields).toHaveBeenCalledWith('inherit-invalid-task', {
      cognitiveLoad: 'low',
      expectedMinutes: 25,
      waitMinutes: 25,
    });
  });

  it('dock edits should write planner attributes back to active task', async () => {
    seedTask('sync-task');
    await service.dockTask('sync-task');

    await service.toggleLoad('sync-task', 'up');
    await service.setExpectedTime('sync-task', 42);
    await service.setWaitTime('sync-task', 15);

    expect(mockTaskOps.updateTaskPlannerFields).toHaveBeenCalledWith('sync-task', { cognitiveLoad: 'high' });
    expect(mockTaskOps.updateTaskPlannerFields).toHaveBeenCalledWith('sync-task', {
      expectedMinutes: 42,
      waitMinutes: null,
    });
    expect(mockTaskOps.updateTaskPlannerFields).toHaveBeenCalledWith('sync-task', {
      expectedMinutes: 42,
      waitMinutes: 15,
    });
  });

  it('createInDock should create shared black-box entry and record sourceBlackBoxEntryId', async () => {
    mockBlackBoxService.createDurably.mockResolvedValueOnce({
      ok: true,
      value: { id: 'bb-inline-1', content: 'Inline Task' },
    });

    const dockEntryId = await service.createInDock('Inline Task', 'backup', 'low', {
      expectedMinutes: 25,
      waitMinutes: 5,
      detail: 'inline detail',
    });

    const entry = service.entries().find(item => item.taskId === dockEntryId);
    expect(entry).toBeDefined();
    expect(entry?.sourceKind).toBe('dock-created');
    expect(entry?.sourceBlackBoxEntryId).toBe('bb-inline-1');
    expect(entry?.inlineArchiveStatus).toBe('pending');
    expect(mockBlackBoxService.createDurably).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: null,
        focusMeta: expect.objectContaining({
          source: 'focus-console-inline',
          dockEntryId,
          lane: 'backup',
          title: 'Inline Task',
        }),
      }),
    );
    expect(mockBlackBoxService.create).not.toHaveBeenCalled();
  });

  it('createInDock should not create dock entry when durable black-box create fails', async () => {
    mockBlackBoxService.createDurably.mockResolvedValueOnce({
      ok: false,
      error: { message: 'network failed' },
    });

    const dockEntryId = await service.createInDock('Inline Fallback', 'combo-select', 'high');
    const entry = service.entries().find(item => item.taskId === dockEntryId);

    expect(dockEntryId).toBeNull();
    expect(entry).toBeUndefined();
  });

  it('archiveInlineEntriesToActiveProject should convert inline entries and replace with project-task', async () => {
    mockBlackBoxService.createDurably.mockResolvedValueOnce({
      ok: true,
      value: { id: 'bb-inline-archive-1', content: 'Archive Me' },
    });
    mockTaskOps.addTask.mockReturnValueOnce({
      ok: true as const,
      value: 'archived-task-1',
    });

    const inlineId = await service.createInDock('Archive Me', 'combo-select', 'high', {
      expectedMinutes: 40,
      waitMinutes: 10,
      detail: 'archive detail',
    });

    const result = await service.archiveInlineEntriesToActiveProject();
    const archivedEntry = service.entries().find(item => item.taskId === 'archived-task-1');

    expect(result).toEqual({ converted: 1, failed: 0 });
    expect(archivedEntry).toBeDefined();
    expect(archivedEntry?.sourceKind).toBe('project-task');
    expect(archivedEntry?.sourceProjectId).toBe('project-1');
    expect(archivedEntry?.inlineArchiveStatus).toBe('archived');
    expect(archivedEntry?.inlineArchivedTaskId).toBe('archived-task-1');
    expect(mockTaskOps.addTask).toHaveBeenCalledWith('Archive Me', 'archive detail', null, null, false);
    expect(mockTaskOps.updateTaskExpectedMinutes).toHaveBeenCalledWith('archived-task-1', 40);
    expect(mockTaskOps.updateTaskCognitiveLoad).toHaveBeenCalledWith('archived-task-1', 'high');
    expect(mockTaskOps.updateTaskWaitMinutes).toHaveBeenCalledWith('archived-task-1', 10);
    expect(mockBlackBoxService.archiveDurably).toHaveBeenCalledWith('bb-inline-archive-1');
    expect(mockBlackBoxService.archive).not.toHaveBeenCalled();
    expect(service.entries().some(item => item.taskId === inlineId)).toBe(false);
  });

  it('archiveInlineEntriesToActiveProject should mark failed when no active project', async () => {
    activeProjectId.set(null);
    mockBlackBoxService.createDurably.mockResolvedValueOnce({
      ok: true,
      value: { id: 'bb-no-project', content: 'No Project' },
    });

    const inlineId = await service.createInDock('No Project', 'backup', 'low');
    const result = await service.archiveInlineEntriesToActiveProject();
    const entry = service.entries().find(item => item.taskId === inlineId);

    expect(result).toEqual({ converted: 0, failed: 1 });
    expect(entry?.sourceKind).toBe('dock-created');
    expect(entry?.inlineArchiveStatus).toBe('failed');
    expect(mockTaskOps.addTask).not.toHaveBeenCalled();
  });

  it('archiveInlineEntriesToActiveProject should support partial failures', async () => {
    mockBlackBoxService.createDurably
      .mockResolvedValueOnce({ ok: true, value: { id: 'bb-partial-1', content: 'Partial A' } })
      .mockResolvedValueOnce({ ok: true, value: { id: 'bb-partial-2', content: 'Partial B' } });
    mockTaskOps.addTask
      .mockReturnValueOnce({ ok: true, value: 'partial-ok-task' })
      .mockReturnValueOnce({ ok: false, error: { message: 'addTask failed' } });

    const inlineA = await service.createInDock('Partial A', 'combo-select', 'low');
    const inlineB = await service.createInDock('Partial B', 'backup', 'high');

    const result = await service.archiveInlineEntriesToActiveProject();
    const entryA = service.entries().find(item => item.taskId === 'partial-ok-task');
    const entryB = service.entries().find(item => item.taskId === inlineB);

    expect(result).toEqual({ converted: 1, failed: 1 });
    expect(entryA?.sourceKind).toBe('project-task');
    expect(entryA?.inlineArchiveStatus).toBe('archived');
    expect(entryB?.sourceKind).toBe('dock-created');
    expect(entryB?.inlineArchiveStatus).toBe('failed');
    expect(service.entries().some(item => item.taskId === inlineA)).toBe(false);
  });

  it('cross-project planner sync should use durable outbox before TaskStore + ProjectState update path', async () => {
    seedTask('cross-task', {
      projectId: 'project-2',
      expected_minutes: 20,
      cognitive_load: 'low',
      wait_minutes: 5,
    });
    mockTaskStore.setTask.mockClear();
    mockProjectState.updateProjects.mockClear();

    await service.dockTask('cross-task');
    await service.setExpectedTime('cross-task', 55);

    expect(mockActionQueue.enqueueDurablyForOwner).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({
        type: 'update',
        entityType: 'task',
        entityId: 'cross-task',
      }),
    );
    expect(mockTaskStore.setTask).toHaveBeenCalled();
    expect(mockProjectState.updateProjects).toHaveBeenCalled();
    expect(mockTaskOps.updateTaskExpectedMinutes).not.toHaveBeenCalledWith('cross-task', 55);
  });

  it('first suspend should keep recommendations highlighted without auto-promoting B', async () => {
    seedTask('A');
    seedTask('B');
    seedTask('C');

    await service.dockTask('A', 'combo-select', { expectedMinutes: 60, load: 'high', zoneSource: 'manual' });
    await service.dockTask('B', 'combo-select', { expectedMinutes: 20, waitMinutes: 5, load: 'low', zoneSource: 'manual' });
    await service.dockTask('C', 'backup', { expectedMinutes: 40, load: 'high', zoneSource: 'manual' });
    service.toggleFocusMode();
    service.switchToTask('A');
    service.suspendTask('A', 20);

    expect(service.focusingEntry()).toBeNull();
    expect(service.pendingDecision()).not.toBeNull();
    const b = service.entries().find(entry => entry.taskId === 'B');
    const c = service.entries().find(entry => entry.taskId === 'C');
    expect(b?.systemSelected).toBe(true);
    expect((b?.recommendedScore ?? 0) > (c?.recommendedScore ?? 0)).toBe(true);
  });

  it('toggleFocusMode should not expose entered focus state when snapshot persistence fails', async () => {
    const idbKeyval = await import('idb-keyval');
    seedTask('A');
    await service.dockTask('A', 'backup', { zoneSource: 'manual' });
    const initialScrimOn = service.focusScrimOn();
    vi.mocked(idbKeyval.set)
      .mockRejectedValueOnce(new Error('idb unavailable'))
      .mockRejectedValueOnce(new Error('idb unavailable'));

    await expect(service.toggleFocusMode()).resolves.toBe(false);

    expect(service.focusMode()).toBe(false);
    expect(service.focusScrimOn()).toBe(initialScrimOn);
    expect(service.exportSnapshot().focusSessionState).toBeNull();
    expect(service.exportSnapshot().focusMode).toBe(false);
  });

  it('first suspend should fall back to relaxed wait-fit recommendations when strict groups are empty', async () => {
    seedTask('A');
    seedTask('B');

    await service.dockTask('A', 'combo-select', { expectedMinutes: 60, load: 'high', zoneSource: 'manual' });
    await service.dockTask('B', 'backup', { expectedMinutes: 120, load: 'high', zoneSource: 'manual' });
    service.toggleFocusMode();
    service.switchToTask('A');

    service.suspendTask('A', 30);

    const pending = service.pendingDecision();
    const candidateIds = pending?.candidateGroups.flatMap(group => group.taskIds) ?? [];
    expect(candidateIds).toContain('B');
    expect(pending).not.toBeNull();
  });

  it('first suspend should escalate to ignore-wait recommendations when relaxed groups are still empty', async () => {
    seedTask('A');
    seedTask('B');

    await service.dockTask('A', 'combo-select', { expectedMinutes: 60, load: 'high', zoneSource: 'manual' });
    await service.dockTask('B', 'backup', { expectedMinutes: 200, load: 'high', zoneSource: 'manual' });
    service.toggleFocusMode();
    service.switchToTask('A');

    service.suspendTask('A', 30);

    const pending = service.pendingDecision();
    const candidateIds = pending?.candidateGroups.flatMap(group => group.taskIds) ?? [];
    expect(candidateIds).toContain('B');
    expect(pending).not.toBeNull();
  });

  it('after B completes in mismatch scenario, enters C/D pending decision', async () => {
    seedTask('A');
    seedTask('B');
    seedTask('C');
    seedTask('D');

    const waitStartedAt = new Date(Date.now() - 60 * 1000).toISOString();
    service.restoreSnapshot({
      version: 4,
      entries: [
        {
          taskId: 'A',
          title: 'A',
          sourceProjectId: 'project-1',
          status: 'suspended_waiting',
          load: 'high',
          expectedMinutes: 120,
          waitMinutes: 30,
          waitStartedAt,
          lane: 'combo-select',
          zoneSource: 'manual',
          isMain: true,
          dockedOrder: 0,
          detail: '',
          sourceKind: 'project-task',
          systemSelected: false,
          recommendedScore: null,
        },
        {
          taskId: 'B',
          title: 'B',
          sourceProjectId: 'project-1',
          status: 'focusing',
          load: 'low',
          expectedMinutes: 10,
          waitMinutes: null,
          waitStartedAt: null,
          lane: 'combo-select',
          zoneSource: 'manual',
          isMain: false,
          dockedOrder: 1,
          detail: '',
          sourceKind: 'project-task',
          systemSelected: false,
          recommendedScore: null,
        },
        {
          taskId: 'C',
          title: 'C',
          sourceProjectId: 'project-1',
          status: 'pending_start',
          load: 'low',
          expectedMinutes: 5,
          waitMinutes: null,
          waitStartedAt: null,
          lane: 'combo-select',
          zoneSource: 'manual',
          isMain: false,
          dockedOrder: 2,
          detail: '',
          sourceKind: 'project-task',
          systemSelected: false,
          recommendedScore: null,
        },
        {
          taskId: 'D',
          title: 'D',
          sourceProjectId: 'project-1',
          status: 'pending_start',
          load: 'high',
          expectedMinutes: 6,
          waitMinutes: null,
          waitStartedAt: null,
          lane: 'backup',
          zoneSource: 'manual',
          isMain: false,
          dockedOrder: 3,
          detail: '',
          sourceKind: 'project-task',
          systemSelected: false,
          recommendedScore: null,
        },
      ],
      focusMode: true,
      isDockExpanded: true,
      muteWaitTone: false,
      session: {
        firstDragIntervened: true,
        focusBlurOn: true,
        focusScrimOn: true,
        mainTaskId: 'B',
        comboSelectIds: ['D'],
        backupIds: [],
      },
      firstDragDone: true,
      dailySlots: [],
      suspendChainRootTaskId: 'A',
      suspendRecommendationLocked: true,
      pendingDecision: null,
      dailyResetDate: '2026-02-25',
      savedAt: new Date().toISOString(),
    });

    service.completeTask('B');
    await Promise.resolve();
    await Promise.resolve();

    const pending = service.pendingDecision();
    expect(pending).not.toBeNull();
    const candidateIds = pending?.candidateGroups.flatMap(group => group.taskIds) ?? [];
    expect(candidateIds).toContain('C');
    expect(candidateIds).toContain('D');
    expect(service.highlightedIds().has('C')).toBe(true);
    expect(service.highlightedIds().has('D')).toBe(true);
  });

  const registerExtendedSpecs = (): void => {
    const context = {
      service: () => service,
      seedTask,
      taskMap,
      taskProjectMap,
      mockActionQueue,
      mockBlackBoxService,
      mockFocusAttention,
      mockFocusHudWindow,
      mockFocusPreferenceService,
      mockTaskOps,
      mockTaskStore,
      mockToast,
      testBed: TestBed,
    };

    registerDockEngineFocusSessionSpecs(context);
    registerDockEngineCommandCenterSpecs(context);
    registerDockEngineConsoleCompletionSpecs(context);
    registerDockEngineRoutineLifecycleSpecs(context);
    registerDockEngineSnapshotPreferenceSpecs(context);
    registerDockEngineRestAndAttentionSpecs(context);
  };

  registerExtendedSpecs();
});
