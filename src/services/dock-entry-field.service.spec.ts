import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DockEntryFieldService, DockEntryFieldContext } from './dock-entry-field.service';
import { DockTaskSyncService } from './dock-task-sync.service';
import { ToastService } from './toast.service';
import { DockEntry } from '../models/parking-dock';

// ---------------------------------------------------------------------------
//  Helper: build a minimal DockEntry with sensible defaults
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
//  Mock services
// ---------------------------------------------------------------------------

const mockTaskSync = {
  syncTaskPlannerFields: vi.fn(),
  syncTaskDetail: vi.fn(),
};

const mockToast = {
  info: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
};

// ---------------------------------------------------------------------------
//  Build a minimal DockEntryFieldContext from writable signals
// ---------------------------------------------------------------------------

function buildContext(initial?: DockEntry[]): {
  ctx: DockEntryFieldContext;
  entries: ReturnType<typeof signal<DockEntry[]>>;
  rebalanceAutoZones: ReturnType<typeof vi.fn>;
  persistDockSnapshotNow: ReturnType<typeof vi.fn>;
} {
  const entries = signal<DockEntry[]>(initial ?? []);
  const rebalanceAutoZones = vi.fn();
  const persistDockSnapshotNow = vi.fn().mockResolvedValue(true);
  const ctx: DockEntryFieldContext = {
    entries,
    focusSessionContext: () => null,
    rebalanceAutoZones,
    persistDockSnapshotNow,
  };
  return { ctx, entries, rebalanceAutoZones, persistDockSnapshotNow };
}

// ---------------------------------------------------------------------------
//  Test suite
// ---------------------------------------------------------------------------

describe('DockEntryFieldService', () => {
  let service: DockEntryFieldService;
  let entries: ReturnType<typeof signal<DockEntry[]>>;
  let rebalanceAutoZones: ReturnType<typeof vi.fn>;
  let persistDockSnapshotNow: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockTaskSync.syncTaskPlannerFields.mockResolvedValue(true);
    mockTaskSync.syncTaskDetail.mockResolvedValue(true);

    TestBed.configureTestingModule({
      providers: [
        DockEntryFieldService,
        { provide: DockTaskSyncService, useValue: mockTaskSync },
        { provide: ToastService, useValue: mockToast },
      ],
    });

    service = TestBed.inject(DockEntryFieldService);

    const built = buildContext([
      makeEntry({ taskId: 'task-1', load: 'low' }),
      makeEntry({ taskId: 'task-2', load: 'high', expectedMinutes: 30, waitMinutes: 10 }),
    ]);
    entries = built.entries;
    rebalanceAutoZones = built.rebalanceAutoZones;
    persistDockSnapshotNow = built.persistDockSnapshotNow;
    service.init(built.ctx);
  });

  // =========================================================================
  //  1. toggleLoad
  // =========================================================================

  describe('toggleLoad', () => {
    it('should cycle load to high after durable local planner persistence succeeds', async () => {
      await expect(service.toggleLoad('task-1', 'up')).resolves.toBe(true);

      const updated = entries().find(e => e.taskId === 'task-1')!;
      expect(updated.load).toBe('high');
      expect(mockTaskSync.syncTaskPlannerFields).toHaveBeenCalledWith('task-1', {
        cognitive_load: 'high',
      });
    });

    it('should cycle load to low after durable local planner persistence succeeds', async () => {
      await expect(service.toggleLoad('task-2', 'down')).resolves.toBe(true);

      const updated = entries().find(e => e.taskId === 'task-2')!;
      expect(updated.load).toBe('low');
      expect(mockTaskSync.syncTaskPlannerFields).toHaveBeenCalledWith('task-2', {
        cognitive_load: 'low',
      });
    });

    it('should no-op entries and skip sync for missing taskId', async () => {
      const before = entries();
      await expect(service.toggleLoad('non-existent', 'up')).resolves.toBe(false);

      // Entries remain unchanged (same content)
      expect(entries()).toEqual(before);
      // Sync is NOT called because entry doesn't exist (guard added)
      expect(mockTaskSync.syncTaskPlannerFields).not.toHaveBeenCalled();
    });

    it('should not update load when durable local planner persistence fails', async () => {
      mockTaskSync.syncTaskPlannerFields.mockResolvedValueOnce(false);

      await expect(service.toggleLoad('task-1', 'up')).resolves.toBe(false);

      const updated = entries().find(e => e.taskId === 'task-1')!;
      expect(updated.load).toBe('low');
    });

    it('should apply the latest rapid opposite load intent after pending persistence settles', async () => {
      const firstSave = createDeferred<boolean>();
      mockTaskSync.syncTaskPlannerFields
        .mockReturnValueOnce(firstSave.promise)
        .mockResolvedValueOnce(true);

      const firstToggle = service.toggleLoad('task-2', 'down');
      const secondToggle = service.toggleLoad('task-2', 'up');

      expect(mockTaskSync.syncTaskPlannerFields).toHaveBeenCalledTimes(1);
      firstSave.resolve(true);

      await expect(Promise.all([firstToggle, secondToggle])).resolves.toEqual([true, true]);

      const updated = entries().find(e => e.taskId === 'task-2')!;
      expect(updated.load).toBe('high');
      expect(mockTaskSync.syncTaskPlannerFields).toHaveBeenNthCalledWith(1, 'task-2', {
        cognitive_load: 'low',
      });
      expect(mockTaskSync.syncTaskPlannerFields).toHaveBeenNthCalledWith(2, 'task-2', {
        cognitive_load: 'high',
      });
    });
  });

  // =========================================================================
  //  2. setExpectedTime
  // =========================================================================

  describe('setExpectedTime', () => {
    it('should update expectedMinutes after durable local planner persistence succeeds', async () => {
      await expect(service.setExpectedTime('task-1', 45)).resolves.toBe(true);

      const updated = entries().find(e => e.taskId === 'task-1')!;
      expect(updated.expectedMinutes).toBe(45);
      expect(mockTaskSync.syncTaskPlannerFields).toHaveBeenCalledWith(
        'task-1',
        expect.objectContaining({ expected_minutes: 45 }),
      );
    });

    it('should not update expectedMinutes when durable local planner persistence fails', async () => {
      mockTaskSync.syncTaskPlannerFields.mockResolvedValueOnce(false);

      await expect(service.setExpectedTime('task-1', 45)).resolves.toBe(false);

      const updated = entries().find(e => e.taskId === 'task-1')!;
      expect(updated.expectedMinutes).toBe(25);
    });
  });

  // =========================================================================
  //  3. setWaitTime
  // =========================================================================

  describe('setWaitTime', () => {
    it('should update waitMinutes after durable local planner persistence succeeds', async () => {
      await expect(service.setWaitTime('task-1', 10)).resolves.toBe(true);

      const updated = entries().find(e => e.taskId === 'task-1')!;
      expect(updated.waitMinutes).toBe(10);
      expect(mockTaskSync.syncTaskPlannerFields).toHaveBeenCalledWith(
        'task-1',
        expect.objectContaining({ wait_minutes: 10 }),
      );
    });

    it('should not update waitMinutes when durable local planner persistence fails', async () => {
      mockTaskSync.syncTaskPlannerFields.mockResolvedValueOnce(false);

      await expect(service.setWaitTime('task-1', 10)).resolves.toBe(false);

      const updated = entries().find(e => e.taskId === 'task-1')!;
      expect(updated.waitMinutes).toBeNull();
    });
  });

  // =========================================================================
  //  4. setDetail
  // =========================================================================

  describe('setDetail', () => {
    it('should update detail after durable local task persistence succeeds', async () => {
      await expect(service.setDetail('task-1', 'new detail text')).resolves.toBe(true);

      const updated = entries().find(e => e.taskId === 'task-1')!;
      expect(updated.detail).toBe('new detail text');
      expect(mockTaskSync.syncTaskDetail).toHaveBeenCalledWith(
        'task-1',
        'new detail text',
        expect.objectContaining({
          entries: expect.any(Array),
          focusSessionContext: null,
        }),
      );
    });

    it('should not update detail when durable local task persistence fails', async () => {
      mockTaskSync.syncTaskDetail.mockResolvedValueOnce(false);

      await expect(service.setDetail('task-1', 'new detail text')).resolves.toBe(false);

      const updated = entries().find(e => e.taskId === 'task-1')!;
      expect(updated.detail).toBe('');
    });
  });

  // =========================================================================
  //  5. setLane
  // =========================================================================

  describe('setLane', () => {
    it('should update lane and zoneSource after snapshot persistence is queued', async () => {
      await expect(service.setLane('task-1', 'backup', 'manual')).resolves.toBe(true);

      const updated = entries().find(e => e.taskId === 'task-1')!;
      expect(updated.lane).toBe('backup');
      expect(updated.zoneSource).toBe('manual');
      expect(persistDockSnapshotNow).toHaveBeenCalledWith([
        expect.objectContaining({
          taskId: 'task-1',
          lane: 'backup',
          zoneSource: 'manual',
        }),
        expect.objectContaining({ taskId: 'task-2' }),
      ]);
      expect(rebalanceAutoZones).not.toHaveBeenCalled();
    });

    it('should default zoneSource to manual', async () => {
      await expect(service.setLane('task-1', 'backup')).resolves.toBe(true);

      const updated = entries().find(e => e.taskId === 'task-1')!;
      expect(updated.zoneSource).toBe('manual');
    });

    it('should call rebalanceAutoZones when zoneSource is auto', async () => {
      await expect(service.setLane('task-1', 'backup', 'auto')).resolves.toBe(true);

      const updated = entries().find(e => e.taskId === 'task-1')!;
      expect(updated.lane).toBe('backup');
      expect(updated.zoneSource).toBe('auto');
      expect(rebalanceAutoZones).toHaveBeenCalledOnce();
    });

    it('should not update lane when snapshot persistence fails', async () => {
      persistDockSnapshotNow.mockResolvedValueOnce(false);

      await expect(service.setLane('task-1', 'backup', 'manual')).resolves.toBe(false);

      const unchanged = entries().find(e => e.taskId === 'task-1')!;
      expect(unchanged.lane).toBe('combo-select');
      expect(unchanged.zoneSource).toBe('auto');
    });
  });

  // =========================================================================
  //  6. Error paths — init guard
  // =========================================================================

  describe('init guard', () => {
    it('should throw if accessed before init()', async () => {
      // Create a second instance via TestBed that hasn't had init() called
      const freshService = TestBed.inject(DockEntryFieldService);
      // Reset its internal context to simulate un-initialized state
      (freshService as unknown as { _ctx: unknown })._ctx = null;
      await expect(freshService.toggleLoad('task-1', 'up')).rejects.toThrow(
        /init\(\) must be called before use/,
      );
    });
  });
});

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
