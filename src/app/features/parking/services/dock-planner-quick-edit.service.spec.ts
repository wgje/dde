import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { DockPlannerQuickEditService } from './dock-planner-quick-edit.service';
import { DockEngineService } from '../../../../services/dock-engine.service';
import { UiStateService } from '../../../../services/ui-state.service';
import { CognitiveLoad } from '../../../../models/parking-dock';

// ── Mock dependencies ────────────────────────────────────────

const orderedDockEntries = signal<any[]>([]);
const mockDockEngineService = {
  orderedDockEntries,
  setDockExpanded: vi.fn(),
  toggleLoad: vi.fn(),
  setExpectedTime: vi.fn(),
  setWaitTime: vi.fn(),
};

const isMobile = signal(false);
const mockUiStateService = {
  isMobile,
};

// ── Helpers ──────────────────────────────────────────────────

function createMockEntry(overrides: Record<string, unknown> = {}) {
  return {
    taskId: 'task-1',
    title: 'Test',
    sourceProjectId: null,
    status: 'pending_start',
    load: 'low' as CognitiveLoad,
    expectedMinutes: null,
    waitMinutes: null,
    waitStartedAt: null,
    lane: 'combo-select',
    zoneSource: 'scheduler',
    isMain: false,
    dockedOrder: 0,
    detail: '',
    sourceKind: 'project-task',
    ...overrides,
  };
}

describe('DockPlannerQuickEditService', () => {
  let service: DockPlannerQuickEditService;

  beforeEach(() => {
    vi.useFakeTimers();

    // Reset mock signals
    orderedDockEntries.set([]);
    isMobile.set(false);

    TestBed.configureTestingModule({
      providers: [
        DockPlannerQuickEditService,
        { provide: DockEngineService, useValue: mockDockEngineService },
        { provide: UiStateService, useValue: mockUiStateService },
      ],
    });

    service = TestBed.inject(DockPlannerQuickEditService);
    vi.clearAllMocks();
  });

  afterEach(() => {
    service.ngOnDestroy();
    vi.useRealTimers();
  });

  // ── Initial state ──────────────────────────────────────────

  it('should have null initial signal values', () => {
    expect(service.plannerQuickEditTaskId()).toBeNull();
    expect(service.recentlyDockedTaskId()).toBeNull();
  });

  // ── isPlannerQuickEditOpen ─────────────────────────────────

  it('should return true when taskId matches', () => {
    service.plannerQuickEditTaskId.set('task-1');
    expect(service.isPlannerQuickEditOpen('task-1')).toBe(true);
  });

  it('should return false when taskId does not match', () => {
    service.plannerQuickEditTaskId.set('task-1');
    expect(service.isPlannerQuickEditOpen('task-2')).toBe(false);
  });

  // ── togglePlannerQuickEdit ─────────────────────────────────

  it('should open planner and expand dock', () => {
    service.togglePlannerQuickEdit('task-1');
    expect(service.plannerQuickEditTaskId()).toBe('task-1');
    expect(mockDockEngineService.setDockExpanded).toHaveBeenCalledWith(true);
  });

  it('should close planner when toggled with same taskId', () => {
    service.togglePlannerQuickEdit('task-1');
    service.togglePlannerQuickEdit('task-1');
    expect(service.plannerQuickEditTaskId()).toBeNull();
  });

  // ── closePlannerQuickEdit ──────────────────────────────────

  it('should return the previous taskId and set to null', () => {
    service.plannerQuickEditTaskId.set('task-1');
    const result = service.closePlannerQuickEdit();
    expect(result).toBe('task-1');
    expect(service.plannerQuickEditTaskId()).toBeNull();
  });

  it('should return null when nothing was open', () => {
    expect(service.closePlannerQuickEdit()).toBeNull();
  });

  // ── presentation computed ──────────────────────────────────

  it('should return "popover" on desktop', () => {
    isMobile.set(false);
    expect(service.presentation()).toBe('popover');
  });

  it('should return "sheet" on mobile', () => {
    isMobile.set(true);
    expect(service.presentation()).toBe('sheet');
  });

  // ── activeEntry computed ───────────────────────────────────

  it('should return null when no planner is open', () => {
    expect(service.activeEntry()).toBeNull();
  });

  it('should return matching entry when planner is open', () => {
    const entry = createMockEntry({ taskId: 'task-1' });
    orderedDockEntries.set([entry]);
    service.plannerQuickEditTaskId.set('task-1');
    expect(service.activeEntry()).toEqual(entry);
  });

  it('should return null when entry not found in dock', () => {
    orderedDockEntries.set([]);
    service.plannerQuickEditTaskId.set('task-missing');
    expect(service.activeEntry()).toBeNull();
  });

  // ── backdropVisible computed ───────────────────────────────

  it('should be true when active entry exists and mobile', () => {
    const entry = createMockEntry({ taskId: 'task-1' });
    orderedDockEntries.set([entry]);
    service.plannerQuickEditTaskId.set('task-1');
    isMobile.set(true);
    expect(service.backdropVisible()).toBe(true);
  });

  it('should be false on desktop even with active entry', () => {
    const entry = createMockEntry({ taskId: 'task-1' });
    orderedDockEntries.set([entry]);
    service.plannerQuickEditTaskId.set('task-1');
    isMobile.set(false);
    expect(service.backdropVisible()).toBe(false);
  });

  // ── missingFieldCount computed ─────────────────────────────

  it('should return 0 when no active entry', () => {
    expect(service.missingFieldCount()).toBe(0);
  });

  it('should return 1 when expectedMinutes is null', () => {
    const entry = createMockEntry({ taskId: 'task-1', expectedMinutes: null });
    orderedDockEntries.set([entry]);
    service.plannerQuickEditTaskId.set('task-1');
    expect(service.missingFieldCount()).toBe(1);
  });

  it('should return 0 when expectedMinutes is set', () => {
    const entry = createMockEntry({ taskId: 'task-1', expectedMinutes: 30 });
    orderedDockEntries.set([entry]);
    service.plannerQuickEditTaskId.set('task-1');
    expect(service.missingFieldCount()).toBe(0);
  });

  // ── markRecentlyDocked ─────────────────────────────────────

  it('should set recentlyDockedTaskId and auto-clear after 3000ms', () => {
    service.markRecentlyDocked('task-1');
    expect(service.recentlyDockedTaskId()).toBe('task-1');

    vi.advanceTimersByTime(2999);
    expect(service.recentlyDockedTaskId()).toBe('task-1');

    vi.advanceTimersByTime(1);
    expect(service.recentlyDockedTaskId()).toBeNull();
  });

  it('should close planner if open for the same task', () => {
    service.plannerQuickEditTaskId.set('task-1');
    service.markRecentlyDocked('task-1');
    expect(service.plannerQuickEditTaskId()).toBeNull();
  });

  it('should keep planner open if open for a different task', () => {
    service.plannerQuickEditTaskId.set('task-2');
    service.markRecentlyDocked('task-1');
    expect(service.plannerQuickEditTaskId()).toBe('task-2');
  });

  // ── closeIfEntryGone ───────────────────────────────────────

  it('should close planner when active entry is gone', () => {
    service.plannerQuickEditTaskId.set('task-1');
    orderedDockEntries.set([]); // entry removed
    service.closeIfEntryGone();
    expect(service.plannerQuickEditTaskId()).toBeNull();
  });

  it('should not close when active entry still exists', () => {
    const entry = createMockEntry({ taskId: 'task-1' });
    orderedDockEntries.set([entry]);
    service.plannerQuickEditTaskId.set('task-1');
    service.closeIfEntryGone();
    expect(service.plannerQuickEditTaskId()).toBe('task-1');
  });

  it('should be no-op when no planner is open', () => {
    service.closeIfEntryGone();
    expect(service.plannerQuickEditTaskId()).toBeNull();
  });

  // ── ngOnDestroy ────────────────────────────────────────────

  it('should clear recentlyDocked timer on destroy', () => {
    service.markRecentlyDocked('task-1');
    service.ngOnDestroy();

    const snapshot = service.recentlyDockedTaskId();
    vi.advanceTimersByTime(60_000);
    expect(service.recentlyDockedTaskId()).toBe(snapshot);
  });
});
