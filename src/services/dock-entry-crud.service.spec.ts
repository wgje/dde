import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TaskStore } from '../core-bridge';
import type { DockEntry } from '../models/parking-dock';
import { DockCompletionFlowService } from './dock-completion-flow.service';
import {
  DockEntryCrudContext,
  DockEntryCrudService,
} from './dock-entry-crud.service';
import { DockEngineLifecycleService } from './dock-engine-lifecycle.service';
import { DockFragmentRestService } from './dock-fragment-rest.service';
import { DockInlineCreationService } from './dock-inline-creation.service';
import { DockPromotionService } from './dock-promotion.service';
import { DockTaskSyncService } from './dock-task-sync.service';
import { DockZoneService } from './dock-zone.service';
import { LoggerService } from './logger.service';
import { ToastService } from './toast.service';

function makeEntry(overrides: Partial<DockEntry> & { taskId: string }): DockEntry {
  return {
    title: overrides.taskId,
    sourceProjectId: null,
    status: 'pending_start',
    load: 'low',
    expectedMinutes: 25,
    waitMinutes: null,
    waitStartedAt: null,
    lane: 'combo-select',
    zoneSource: 'auto',
    isMain: false,
    dockedOrder: 0,
    detail: '',
    sourceKind: 'project-task',
    systemSelected: false,
    recommendedScore: null,
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function buildContext(
  initial: DockEntry[],
  persistDockSnapshotNow = vi.fn().mockResolvedValue(true),
): {
  ctx: DockEntryCrudContext;
  entries: ReturnType<typeof signal<DockEntry[]>>;
  persistDockSnapshotNow: ReturnType<typeof vi.fn>;
} {
  const entries = signal<DockEntry[]>(initial);
  const focusMode = signal(false);
  const pendingDecision = signal(null);
  const ctx: DockEntryCrudContext = {
    entries,
    focusMode,
    muteWaitTone: signal(false),
    dockExpanded: signal(false),
    focusScrimOn: signal(true),
    firstDragIntervened: signal(false),
    pendingDecision,
    highlightedIds: signal(new Set<string>()),
    suspendRecommendationLocked: signal(false),
    suspendChainRootTaskId: signal(null),
    lastRadarInsertedTaskId: signal(null),
    lastRadarEvictedTaskId: signal(null),
    pendingRadarEviction: signal(null),
    lastConsoleDemotedTaskId: signal(null),
    consoleVisibleOrderHint: signal([]),
    firstMainSelectionWindow: signal(null),
    waitEndNotifiedIds: new Set<string>(),
    focusingEntry: () => entries().find(entry => entry.status === 'focusing') ?? null,
    consoleEntries: () => entries().filter(entry => entry.status !== 'completed'),
    consoleVisibleEntries: () => entries().filter(entry => entry.status !== 'completed'),
    switchToTask: vi.fn().mockResolvedValue(true),
    completeTask: vi.fn(),
    rebalanceAutoZones: vi.fn(),
    clearFirstMainSelectionWindow: vi.fn(),
    startFirstMainSelectionWindow: vi.fn(),
    persistDockSnapshotNow,
  };

  return { ctx, entries, persistDockSnapshotNow };
}

const loggerCategory = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

describe('DockEntryCrudService', () => {
  let service: DockEntryCrudService;
  let taskStoreGetTask: ReturnType<typeof vi.fn>;
  let syncTaskPlannerFields: ReturnType<typeof vi.fn>;
  let toastInfo: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    taskStoreGetTask = vi.fn();
    syncTaskPlannerFields = vi.fn().mockResolvedValue(true);
    toastInfo = vi.fn();
    TestBed.configureTestingModule({
      providers: [
        DockEntryCrudService,
        { provide: TaskStore, useValue: { getTask: taskStoreGetTask } },
        { provide: LoggerService, useValue: { category: vi.fn(() => loggerCategory) } },
        { provide: ToastService, useValue: { info: toastInfo } },
        { provide: DockInlineCreationService, useValue: { ensureDockCapacity: vi.fn(() => true) } },
        {
          provide: DockTaskSyncService,
          useValue: {
            resolveTaskProjectId: vi.fn(() => 'project-1'),
            syncTaskPlannerFields,
          },
        },
        { provide: DockZoneService, useValue: { inferAutoLaneForTask: vi.fn(() => 'backup') } },
        { provide: DockPromotionService, useValue: { clearPendingDecisionIfMatched: vi.fn() } },
        { provide: DockCompletionFlowService, useValue: { deriveBackgroundStatus: vi.fn(() => 'stalled') } },
        {
          provide: DockFragmentRestService,
          useValue: {
            stopFragmentEntryCountdown: vi.fn(),
            setFragmentDismissed: vi.fn(),
          },
        },
        { provide: DockEngineLifecycleService, useValue: { scheduleSwitchMaintenance: vi.fn() } },
      ],
    });

    service = TestBed.inject(DockEntryCrudService);
  });

  describe('dockTask', () => {
    it('should add an entry only after the dock snapshot is durably persisted', async () => {
      const pending = deferred<boolean>();
      taskStoreGetTask.mockReturnValue({
        id: 'task-1',
        title: 'Task 1',
        status: 'active',
        content: null,
        expected_minutes: 30,
        cognitive_load: 'low',
        wait_minutes: 45,
      });
      const built = buildContext([], vi.fn(() => pending.promise));
      service.init(built.ctx);

      const result = service.dockTask('task-1', 'backup', { zoneSource: 'manual' });

      expect(built.persistDockSnapshotNow).toHaveBeenCalledWith([
        expect.objectContaining({ taskId: 'task-1', lane: 'backup' }),
      ]);
      expect(built.entries()).toEqual([]);
      expect(syncTaskPlannerFields).not.toHaveBeenCalled();
      expect(toastInfo).not.toHaveBeenCalled();

      pending.resolve(true);

      await expect(result).resolves.toBe(true);
      expect(built.entries()).toEqual([
        expect.objectContaining({ taskId: 'task-1', lane: 'backup' }),
      ]);
      expect(syncTaskPlannerFields).toHaveBeenCalledWith('task-1', {
        expected_minutes: 45,
        cognitive_load: 'low',
        wait_minutes: 45,
      });
      expect(toastInfo).toHaveBeenCalledWith(
        '已校正等待/预计时长',
        '等待时长不能超过预计时长，已同步调整为 45 分钟',
      );
    });

    it('should keep entries unchanged when dock snapshot persistence fails', async () => {
      taskStoreGetTask.mockReturnValue({
        id: 'task-1',
        title: 'Task 1',
        status: 'active',
        content: null,
        expected_minutes: 30,
        cognitive_load: 'low',
        wait_minutes: null,
      });
      const built = buildContext([], vi.fn().mockResolvedValue(false));
      service.init(built.ctx);

      await expect(service.dockTask('task-1', 'backup', { zoneSource: 'manual' })).resolves.toBe(false);

      expect(built.entries()).toEqual([]);
      expect(syncTaskPlannerFields).not.toHaveBeenCalled();
      expect(loggerCategory.warn).toHaveBeenCalledWith('Dock task snapshot persisted only in memory', {
        taskId: 'task-1',
      });
    });
  });

  describe('reorderDockEntries', () => {
    it('should update entries only after the reordered snapshot is durably persisted', async () => {
      const pending = deferred<boolean>();
      const built = buildContext([
        makeEntry({ taskId: 'task-1', dockedOrder: 0, manualOrder: 0 }),
        makeEntry({ taskId: 'task-2', dockedOrder: 1, manualOrder: 1 }),
      ], vi.fn(() => pending.promise));
      service.init(built.ctx);

      const result = service.reorderDockEntries('task-2', 'task-1');

      expect(built.persistDockSnapshotNow).toHaveBeenCalledWith([
        expect.objectContaining({ taskId: 'task-1', dockedOrder: 1, manualOrder: 1 }),
        expect.objectContaining({ taskId: 'task-2', dockedOrder: 0, manualOrder: 0 }),
      ]);
      expect(built.entries().find(entry => entry.taskId === 'task-1')?.dockedOrder).toBe(0);
      expect(built.entries().find(entry => entry.taskId === 'task-2')?.dockedOrder).toBe(1);

      pending.resolve(true);

      await expect(result).resolves.toBe(true);
      expect(built.entries().find(entry => entry.taskId === 'task-1')?.dockedOrder).toBe(1);
      expect(built.entries().find(entry => entry.taskId === 'task-2')?.dockedOrder).toBe(0);
    });

    it('should keep entries unchanged when reordered snapshot persistence fails', async () => {
      const built = buildContext([
        makeEntry({ taskId: 'task-1', dockedOrder: 0, manualOrder: 0 }),
        makeEntry({ taskId: 'task-2', dockedOrder: 1, manualOrder: 1 }),
      ], vi.fn().mockResolvedValue(false));
      service.init(built.ctx);

      await expect(service.reorderDockEntries('task-2', 'task-1')).resolves.toBe(false);

      expect(built.entries().find(entry => entry.taskId === 'task-1')?.dockedOrder).toBe(0);
      expect(built.entries().find(entry => entry.taskId === 'task-2')?.dockedOrder).toBe(1);
      expect(loggerCategory.warn).toHaveBeenCalledWith('Dock reorder snapshot persisted only in memory', {
        sourceTaskId: 'task-2',
        targetTaskId: 'task-1',
      });
    });
  });

  describe('clearDockForExit', () => {
    it('should keep dock state unchanged when clear-exit snapshot persistence fails', async () => {
      const entry = makeEntry({ taskId: 'task-1' });
      const built = buildContext([entry], vi.fn().mockResolvedValue(false));
      built.ctx.highlightedIds.set(new Set(['task-1']));
      built.ctx.suspendRecommendationLocked.set(true);
      built.ctx.suspendChainRootTaskId.set('task-1');
      built.ctx.waitEndNotifiedIds.add('task-1');
      built.ctx.firstDragIntervened.set(true);
      built.ctx.pendingRadarEviction.set('task-1');
      built.ctx.lastConsoleDemotedTaskId.set('task-1');
      built.ctx.consoleVisibleOrderHint.set(['task-1']);
      built.ctx.firstMainSelectionWindow.set({ taskId: 'task-1', expiresAt: 123 });
      service.init(built.ctx);

      await expect(service.clearDockForExit()).resolves.toBe(false);

      expect(built.persistDockSnapshotNow).toHaveBeenCalledWith([]);
      expect(built.entries()).toEqual([entry]);
      expect(built.ctx.highlightedIds()).toEqual(new Set(['task-1']));
      expect(built.ctx.suspendRecommendationLocked()).toBe(true);
      expect(built.ctx.suspendChainRootTaskId()).toBe('task-1');
      expect(built.ctx.waitEndNotifiedIds.has('task-1')).toBe(true);
      expect(built.ctx.firstDragIntervened()).toBe(true);
      expect(built.ctx.pendingRadarEviction()).toBe('task-1');
      expect(built.ctx.lastConsoleDemotedTaskId()).toBe('task-1');
      expect(built.ctx.consoleVisibleOrderHint()).toEqual(['task-1']);
      expect(built.ctx.clearFirstMainSelectionWindow).not.toHaveBeenCalled();
      expect(loggerCategory.warn).toHaveBeenCalledWith('Dock clear-exit snapshot persisted only in memory');
    });

    it('should clear dock state after clear-exit snapshot is durably persisted', async () => {
      const built = buildContext([makeEntry({ taskId: 'task-1' })], vi.fn().mockResolvedValue(true));
      built.ctx.highlightedIds.set(new Set(['task-1']));
      built.ctx.suspendRecommendationLocked.set(true);
      built.ctx.suspendChainRootTaskId.set('task-1');
      built.ctx.waitEndNotifiedIds.add('task-1');
      built.ctx.firstDragIntervened.set(true);
      built.ctx.pendingRadarEviction.set('task-1');
      built.ctx.lastConsoleDemotedTaskId.set('task-1');
      built.ctx.consoleVisibleOrderHint.set(['task-1']);
      service.init(built.ctx);

      await expect(service.clearDockForExit()).resolves.toBe(true);

      expect(built.entries()).toEqual([]);
      expect(built.ctx.highlightedIds()).toEqual(new Set());
      expect(built.ctx.suspendRecommendationLocked()).toBe(false);
      expect(built.ctx.suspendChainRootTaskId()).toBeNull();
      expect(built.ctx.waitEndNotifiedIds.size).toBe(0);
      expect(built.ctx.firstDragIntervened()).toBe(false);
      expect(built.ctx.pendingRadarEviction()).toBeNull();
      expect(built.ctx.lastConsoleDemotedTaskId()).toBeNull();
      expect(built.ctx.consoleVisibleOrderHint()).toEqual([]);
      expect(built.ctx.clearFirstMainSelectionWindow).toHaveBeenCalledTimes(1);
    });
  });

  describe('dock preferences', () => {
    it('should update mute preference only after the snapshot is durably persisted', async () => {
      const pending = deferred<boolean>();
      const built = buildContext([
        makeEntry({ taskId: 'task-1', snoozeRingMuted: false }),
      ], vi.fn(() => pending.promise));
      service.init(built.ctx);

      const result = service.toggleMuteWaitTone();

      expect(built.persistDockSnapshotNow).toHaveBeenCalledWith([
        expect.objectContaining({ taskId: 'task-1', snoozeRingMuted: true }),
      ], { muteWaitTone: true });
      expect(built.ctx.muteWaitTone()).toBe(false);
      expect(built.entries()[0]?.snoozeRingMuted).toBe(false);

      pending.resolve(true);

      await expect(result).resolves.toBe(true);
      expect(built.ctx.muteWaitTone()).toBe(true);
      expect(built.entries()[0]?.snoozeRingMuted).toBe(true);
    });

    it('should keep mute preference unchanged when snapshot persistence fails', async () => {
      const built = buildContext([
        makeEntry({ taskId: 'task-1', snoozeRingMuted: false }),
      ], vi.fn().mockResolvedValue(false));
      service.init(built.ctx);

      await expect(service.toggleMuteWaitTone()).resolves.toBe(false);

      expect(built.ctx.muteWaitTone()).toBe(false);
      expect(built.entries()[0]?.snoozeRingMuted).toBe(false);
    });

    it('should update dock expanded only after the snapshot is durably persisted', async () => {
      const pending = deferred<boolean>();
      const built = buildContext([], vi.fn(() => pending.promise));
      service.init(built.ctx);

      const result = service.setDockExpanded(true);

      expect(built.persistDockSnapshotNow).toHaveBeenCalledWith([], { isDockExpanded: true });
      expect(built.ctx.dockExpanded()).toBe(false);

      pending.resolve(true);

      await expect(result).resolves.toBe(true);
      expect(built.ctx.dockExpanded()).toBe(true);
    });

    it('should keep dock expanded unchanged when snapshot persistence fails', async () => {
      const built = buildContext([], vi.fn().mockResolvedValue(false));
      service.init(built.ctx);

      await expect(service.setDockExpanded(true)).resolves.toBe(false);

      expect(built.ctx.dockExpanded()).toBe(false);
    });
  });
});
