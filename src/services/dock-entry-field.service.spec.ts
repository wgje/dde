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
} {
  const entries = signal<DockEntry[]>(initial ?? []);
  const rebalanceAutoZones = vi.fn();
  const ctx: DockEntryFieldContext = {
    entries,
    focusSessionContext: () => null,
    rebalanceAutoZones,
  };
  return { ctx, entries, rebalanceAutoZones };
}

// ---------------------------------------------------------------------------
//  Test suite
// ---------------------------------------------------------------------------

describe('DockEntryFieldService', () => {
  let service: DockEntryFieldService;
  let entries: ReturnType<typeof signal<DockEntry[]>>;
  let rebalanceAutoZones: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();

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
    service.init(built.ctx);
  });

  // =========================================================================
  //  1. toggleLoad
  // =========================================================================

  describe('toggleLoad', () => {
    it('should cycle load to high when direction is up', () => {
      service.toggleLoad('task-1', 'up');

      const updated = entries().find(e => e.taskId === 'task-1')!;
      expect(updated.load).toBe('high');
      expect(mockTaskSync.syncTaskPlannerFields).toHaveBeenCalledWith('task-1', {
        cognitive_load: 'high',
      });
    });

    it('should cycle load to low when direction is down', () => {
      service.toggleLoad('task-2', 'down');

      const updated = entries().find(e => e.taskId === 'task-2')!;
      expect(updated.load).toBe('low');
      expect(mockTaskSync.syncTaskPlannerFields).toHaveBeenCalledWith('task-2', {
        cognitive_load: 'low',
      });
    });

    it('should no-op entries and skip sync for missing taskId', () => {
      const before = entries();
      service.toggleLoad('non-existent', 'up');

      // Entries remain unchanged (same content)
      expect(entries()).toEqual(before);
      // Sync is NOT called because entry doesn't exist (guard added)
      expect(mockTaskSync.syncTaskPlannerFields).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  //  2. setExpectedTime
  // =========================================================================

  describe('setExpectedTime', () => {
    it('should update expectedMinutes on the matching entry', () => {
      service.setExpectedTime('task-1', 45);

      const updated = entries().find(e => e.taskId === 'task-1')!;
      expect(updated.expectedMinutes).toBe(45);
      expect(mockTaskSync.syncTaskPlannerFields).toHaveBeenCalledWith(
        'task-1',
        expect.objectContaining({ expected_minutes: 45 }),
      );
    });
  });

  // =========================================================================
  //  3. setWaitTime
  // =========================================================================

  describe('setWaitTime', () => {
    it('should update waitMinutes on the matching entry', () => {
      service.setWaitTime('task-1', 10);

      const updated = entries().find(e => e.taskId === 'task-1')!;
      expect(updated.waitMinutes).toBe(10);
      expect(mockTaskSync.syncTaskPlannerFields).toHaveBeenCalledWith(
        'task-1',
        expect.objectContaining({ wait_minutes: 10 }),
      );
    });
  });

  // =========================================================================
  //  4. setDetail
  // =========================================================================

  describe('setDetail', () => {
    it('should update detail and sync to task store', () => {
      service.setDetail('task-1', 'new detail text');

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
  });

  // =========================================================================
  //  5. setLane
  // =========================================================================

  describe('setLane', () => {
    it('should update lane and zoneSource', () => {
      service.setLane('task-1', 'backup', 'manual');

      const updated = entries().find(e => e.taskId === 'task-1')!;
      expect(updated.lane).toBe('backup');
      expect(updated.zoneSource).toBe('manual');
      expect(rebalanceAutoZones).not.toHaveBeenCalled();
    });

    it('should default zoneSource to manual', () => {
      service.setLane('task-1', 'backup');

      const updated = entries().find(e => e.taskId === 'task-1')!;
      expect(updated.zoneSource).toBe('manual');
    });

    it('should call rebalanceAutoZones when zoneSource is auto', () => {
      service.setLane('task-1', 'backup', 'auto');

      const updated = entries().find(e => e.taskId === 'task-1')!;
      expect(updated.lane).toBe('backup');
      expect(updated.zoneSource).toBe('auto');
      expect(rebalanceAutoZones).toHaveBeenCalledOnce();
    });
  });

  // =========================================================================
  //  6. Error paths — init guard
  // =========================================================================

  describe('init guard', () => {
    it('should throw if accessed before init()', () => {
      // Create a second instance via TestBed that hasn't had init() called
      const freshService = TestBed.inject(DockEntryFieldService);
      // Reset its internal context to simulate un-initialized state
      (freshService as unknown as { _ctx: unknown })._ctx = null;
      expect(() => freshService.toggleLoad('task-1', 'up')).toThrow(
        /init\(\) must be called before use/,
      );
    });
  });
});
