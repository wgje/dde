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
import { resetBrowserNetworkSuspensionTrackingForTests } from '../utils/browser-network-suspension';
import { registerParkingLightweightSyncSpecs } from './parking-lightweight-sync.spec-helpers';
import { registerParkingNoteAndKeepSpecs } from './parking-note-and-keep.spec-helpers';
import { registerParkingPinnedSpecs } from './parking-pinned.spec-helpers';
import { registerParkingSoftLimitAndLifecycleSpecs } from './parking-soft-limit-and-lifecycle.spec-helpers';
import { registerParkingStatusChangeSpecs } from './parking-status-change.spec-helpers';
import { registerParkingTaskActionsSpecs } from './parking-task-actions.spec-helpers';

describe('ParkingService', () => {
  let service: ParkingService;
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
    getTaskProjectId: vi.fn(() => 'proj-1'),
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
      updates: Array<{ taskId: string; parkingMeta: TaskParkingMeta | undefined }>,
    ) => {
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
    getProject: vi.fn((projectId: string) => ({
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
      updates: Array<{ taskId: string; parkingMeta: TaskParkingMeta | undefined }>,
    ) => {
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

  // ─── P-09/P-10: 72h 衰老清理与撤回 ───

  describe('P-09/P-10: 衰老清理', () => {
    it('72h 未访问任务应在 durable 清理成功后发出通知', async () => {
      const staleTask = createTask({ id: 'stale-72h', parkingMeta: createParkingMeta() });
      taskMap.set(staleTask.id, staleTask);
      syncParkedSignals();

      await runEvictionCheck();

      expect(taskMap.get('stale-72h')?.parkingMeta).toBeUndefined();
      expect(service.pendingNotices().length).toBe(1);
    });

    it('清理通知包含撤回按钮', async () => {
      const staleTask = createTask({ id: 'stale-undo', title: '可撤回', parkingMeta: createParkingMeta() });
      taskMap.set(staleTask.id, staleTask);
      syncParkedSignals();

      await runEvictionCheck();

      const notice = service.pendingNotices()[0];
      expect(notice.type).toBe('eviction');
      expect(notice.actions.some(a => a.key === 'undo-eviction')).toBe(true);
    });

    it('本地 durable 清理失败时不应生成通知或可撤回 token', async () => {
      const staleTask = createTask({
        id: 'stale-clear-fail',
        title: '清理失败任务',
        parkingMeta: createParkingMeta(),
      });
      taskMap.set(staleTask.id, staleTask);
      syncParkedSignals();
      mockTaskOpsAdapter.updateTaskParkingMeta.mockResolvedValueOnce(false);

      await runEvictionCheck();

      expect(taskMap.get('stale-clear-fail')?.parkingMeta).toBeTruthy();
      expect(service.pendingNotices().length).toBe(0);
      expect(mockTaskOpsAdapter.updateTaskParkingMeta).toHaveBeenCalledWith(
        'stale-clear-fail',
        undefined,
      );
    });

    it('撤回应通过本地 durable restore 恢复原始停泊状态', async () => {
      const staleTask = createTask({
        id: 'stale-restore',
        parkingMeta: createParkingMeta({ pinned: false }),
      });
      taskMap.set(staleTask.id, staleTask);
      syncParkedSignals();

      await runEvictionCheck();

      const notice = service.pendingNotices()[0];
      const tokenId = notice.evictionTokenId!;
      await expect(service.undoEviction(tokenId)).resolves.toBe(true);

      const restored = taskMap.get('stale-restore');
      expect(restored?.parkingMeta?.state).toBe('parked');
    });

    it('撤回本地 durable restore 失败时不应消费 token，允许后续重试', async () => {
      const staleTask = createTask({
        id: 'stale-restore-fail',
        parkingMeta: createParkingMeta({ pinned: false }),
      });
      taskMap.set(staleTask.id, staleTask);
      syncParkedSignals();

      await runEvictionCheck();

      const notice = service.pendingNotices()[0];
      const tokenId = notice.evictionTokenId!;
      mockTaskOpsAdapter.updateTaskParkingMeta.mockResolvedValueOnce(false);

      await expect(service.undoEviction(tokenId)).resolves.toBe(false);
      expect(taskMap.get('stale-restore-fail')?.parkingMeta).toBeUndefined();

      await expect(service.undoEviction(tokenId)).resolves.toBe(true);
      expect(taskMap.get('stale-restore-fail')?.parkingMeta?.state).toBe('parked');
    });
  });

  // ─── P-11: 手动移除可撤回 ───

  describe('P-11: removeParkedTask', () => {
    it('本地 durable 移除后应显示 5s 撤回 Snackbar', async () => {
      const task = createTask({
        id: 'remove-1',
        title: '将移除的任务',
        parkingMeta: createParkingMeta({ state: 'parked' }),
      });
      taskMap.set(task.id, task);
      syncParkedSignals();

      await expect(service.removeParkedTask('remove-1')).resolves.toBe(true);

      expect(taskMap.get('remove-1')?.parkingMeta).toBeUndefined();
      expect(mockToastService.info).toHaveBeenCalled();
      const call = mockToastService.info.mock.calls[0];
      expect(call[0]).toContain('将移除的任务');
    });

    it('移除时若正在预览应在 durable 成功后清除预览状态', async () => {
      const task = createTask({
        id: 'remove-preview',
        parkingMeta: createParkingMeta(),
      });
      taskMap.set(task.id, task);
      syncParkedSignals();
      await service.previewTask('remove-preview');

      await expect(service.removeParkedTask('remove-preview')).resolves.toBe(true);

      expect(service.previewingTaskId()).toBeNull();
    });

    it('本地 durable 移除失败时不应清除停泊状态或显示撤回提示', async () => {
      const task = createTask({
        id: 'remove-fail',
        title: '失败任务',
        parkingMeta: createParkingMeta({ state: 'parked' }),
      });
      taskMap.set(task.id, task);
      syncParkedSignals();
      await service.previewTask('remove-fail');
      mockTaskOpsAdapter.updateTaskParkingMeta.mockResolvedValueOnce(false);

      await expect(service.removeParkedTask('remove-fail')).resolves.toBe(false);

      expect(taskMap.get('remove-fail')?.parkingMeta?.state).toBe('parked');
      expect(service.previewingTaskId()).toBe('remove-fail');
      expect(mockToastService.info).not.toHaveBeenCalledWith(
        expect.stringContaining('失败任务'),
        undefined,
        expect.anything(),
      );
    });
  });

  // ─── P-16: 离线保护 ───

  describe('P-16: 离线清理保护', () => {
    it('离线时不执行衰老清理', async () => {
      const staleTask = createTask({ id: 'offline-1', parkingMeta: createParkingMeta() });
      taskMap.set(staleTask.id, staleTask);
      syncParkedSignals();

      const onlineSpy = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
      await runEvictionCheck();

      expect(taskMap.get('offline-1')?.parkingMeta).toBeTruthy();
      expect(service.pendingNotices().length).toBe(0);
      onlineSpy.mockRestore();
    });

    it('恢复在线后应立即重新执行衰老清理并发出通知', async () => {
      const staleTask = createTask({ id: 'offline-retry-1', parkingMeta: createParkingMeta() });
      taskMap.set(staleTask.id, staleTask);
      syncParkedSignals();

      let isOnline = false;
      const onlineSpy = vi.spyOn(navigator, 'onLine', 'get').mockImplementation(() => isOnline);

      await runEvictionCheck();

      expect(taskMap.get('offline-retry-1')?.parkingMeta).toBeTruthy();
      expect(service.pendingNotices().length).toBe(0);

      isOnline = true;
      window.dispatchEvent(new Event('online'));
      await flushBackgroundEvictionCheck();

      expect(taskMap.get('offline-retry-1')?.parkingMeta).toBeUndefined();
      expect(service.pendingNotices().length).toBe(1);
      expect(service.pendingNotices()[0].type).toBe('eviction');

      onlineSpy.mockRestore();
    });
  });

  describe('停泊后台增量同步异常隔离', () => {
    it('恢复可见后的后台增量补拉失败应记录日志且不泄露 timer rejection', async () => {
      await flushBackgroundEvictionCheck();
      vi.clearAllMocks();
      currentUserIdSignal.set('user-1');
      const deltaFailure = new Error('parked delta unavailable');
      mockProjectDataService.pullParkedTasksDelta.mockRejectedValueOnce(deltaFailure);

      setVisibilityState('visible');
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(1800);
      await flushBackgroundEvictionCheck();

      expect(mockProjectDataService.pullParkedTasksDelta).toHaveBeenCalledTimes(1);
      expect(mockLoggerService.warn).toHaveBeenCalledWith(
        'ParkingService',
        'background parked delta sync failed',
        deltaFailure,
      );
    });
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
