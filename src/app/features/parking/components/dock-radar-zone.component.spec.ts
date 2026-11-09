import { ComponentFixture, TestBed } from '@angular/core/testing';
import { computed, signal } from '@angular/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DockRadarZoneComponent } from './dock-radar-zone.component';
import { DockEngineService } from '../../../../services/dock-engine.service';
import { resolveSpacingConflicts } from '../utils/dock-radar-layout';
import { PARKING_CONFIG } from '../../../../config/parking.config';
import { ProjectStore } from '../../../core/state/stores';

describe('DockRadarZoneComponent', () => {
  let fixture: ComponentFixture<DockRadarZoneComponent>;
  let component: DockRadarZoneComponent;

  const comboEntries = signal<any[]>([
    {
      taskId: 'S1',
      title: 'Combo Task',
      lane: 'combo-select',
      load: 'low',
      expectedMinutes: 20,
      waitMinutes: null,
      dockedOrder: 1,
      status: 'pending_start',
      isMain: false,
    },
  ]);
  const backupEntries = signal<any[]>([
    {
      taskId: 'W1',
      title: 'Backup Task',
      lane: 'backup',
      load: 'high',
      expectedMinutes: 10,
      waitMinutes: null,
      dockedOrder: 2,
      status: 'pending_start',
      isMain: false,
    },
  ]);
  const highlightedIds = signal<Set<string>>(new Set());
  const pendingDecisionEntries = signal<any[]>([]);
  const focusMode = signal(false);
  const focusTransition = signal<any>(null);
  const lastRadarEvictedTaskId = signal<string | null>(null);
  const projects = signal<any[]>([
    { id: 'proj-1', name: '项目一', color: '#ff5722' },
  ]);

  const mockEngine = {
    comboSelectEntries: computed(() => comboEntries()),
    backupEntries: computed(() => backupEntries()),
    highlightedIds,
    pendingDecisionEntries,
    focusMode,
    focusTransition,
    isFocusTransitionBlocking: computed(() => {
      const phase = focusTransition()?.phase ?? null;
      return phase === 'entering' || phase === 'exiting';
    }),
    lastRadarEvictedTaskId,
    focusScrimOn: signal(false),
    toggleLoad: vi.fn(),
    setExpectedTime: vi.fn().mockResolvedValue(true),
    setWaitTime: vi.fn().mockResolvedValue(true),
    setMainTask: vi.fn(),
    insertToConsoleFromRadar: vi.fn(),
    createInDock: vi.fn(),
  };

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    comboEntries.set([
      {
        taskId: 'S1',
        title: 'Combo Task',
        lane: 'combo-select',
        load: 'low',
        expectedMinutes: 20,
        waitMinutes: null,
        dockedOrder: 1,
        status: 'pending_start',
        isMain: false,
      },
    ]);
    backupEntries.set([
      {
        taskId: 'W1',
        title: 'Backup Task',
        lane: 'backup',
        load: 'high',
        expectedMinutes: 10,
        waitMinutes: null,
        dockedOrder: 2,
        status: 'pending_start',
        isMain: false,
      },
    ]);
    projects.set([{ id: 'proj-1', name: '项目一', color: '#ff5722' }]);
    highlightedIds.set(new Set());
    pendingDecisionEntries.set([]);
    focusMode.set(false);
    focusTransition.set(null);
    lastRadarEvictedTaskId.set(null);

    await TestBed.configureTestingModule({
      imports: [DockRadarZoneComponent],
      providers: [
        { provide: DockEngineService, useValue: mockEngine },
        { provide: ProjectStore, useValue: { projects } },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(DockRadarZoneComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it('should distribute combo/backup entries in upper region', () => {
    const combo = component.comboItems();
    const backup = component.backupItems();
    expect(combo.length).toBe(1);
    expect(backup.length).toBe(1);
    expect(combo[0]?.y).toBeLessThanOrEqual(0);
    expect(backup[0]?.y).toBeLessThanOrEqual(0);
  });

  it('should distribute combo entries into left/top/right sectors when no group metadata exists', () => {
    component.setViewMode('panorama');
    comboEntries.set([
      { taskId: 'C1', title: 'C1', lane: 'combo-select', load: 'low', expectedMinutes: 15, status: 'pending_start', isMain: false },
      { taskId: 'C2', title: 'C2', lane: 'combo-select', load: 'low', expectedMinutes: 15, status: 'pending_start', isMain: false },
      { taskId: 'C3', title: 'C3', lane: 'combo-select', load: 'low', expectedMinutes: 15, status: 'pending_start', isMain: false },
      { taskId: 'C4', title: 'C4', lane: 'combo-select', load: 'low', expectedMinutes: 15, status: 'pending_start', isMain: false },
      { taskId: 'C5', title: 'C5', lane: 'combo-select', load: 'low', expectedMinutes: 15, status: 'pending_start', isMain: false },
      { taskId: 'C6', title: 'C6', lane: 'combo-select', load: 'low', expectedMinutes: 15, status: 'pending_start', isMain: false },
    ]);
    pendingDecisionEntries.set([]);
    fixture.detectChanges();

    const points = component.comboItems();
    expect(points.length).toBe(6);
    expect(points.some(item => Math.abs(item.x) > 180)).toBe(true);
    expect(points.some(item => item.y < -120)).toBe(true);
    expect(points.some(item => item.x < -40)).toBe(true);
    expect(points.some(item => item.x > 40)).toBe(true);
    expect(points.some(item => Math.abs(item.x) < 40 && item.y < -(component.comboRadius * 0.65))).toBe(true);
    expect(points.every(item => item.y <= 0)).toBe(true);
  });

  it('should map grouped combo entries to deterministic sectors', () => {
    comboEntries.set([
      { taskId: 'H1', title: 'H1', lane: 'combo-select', load: 'low', expectedMinutes: 20, status: 'pending_start', isMain: false },
      { taskId: 'D1', title: 'D1', lane: 'combo-select', load: 'low', expectedMinutes: 20, status: 'pending_start', isMain: false },
      { taskId: 'A1', title: 'A1', lane: 'combo-select', load: 'low', expectedMinutes: 20, status: 'pending_start', isMain: false },
    ]);
    pendingDecisionEntries.set([
      { taskId: 'H1', group: 'homologous-advancement' },
      { taskId: 'D1', group: 'cognitive-downgrade' },
      { taskId: 'A1', group: 'asynchronous-boot' },
    ]);
    fixture.detectChanges();

    const byId = new Map(component.comboItems().map(item => [item.entry.taskId, item]));
    expect(byId.get('H1')?.x ?? 0).toBeLessThan(-40);
    expect(byId.get('A1')?.x ?? 0).toBeGreaterThan(40);
    expect(Math.abs(byId.get('D1')?.x ?? 999)).toBeLessThan(70);
    expect(byId.get('D1')?.y ?? 0).toBeLessThan(-(component.comboRadius * 0.65));
  });

  it('should arrange backup entries on upper arc with stable spacing', () => {
    component.setViewMode('panorama');
    backupEntries.set(Array.from({ length: 10 }, (_, index) => ({
      taskId: `B${index}`,
      title: `Backup ${index}`,
      lane: 'backup',
      load: index % 2 === 0 ? 'low' : 'high',
      expectedMinutes: 10 + index,
      status: 'pending_start',
      isMain: false,
    })));
    fixture.detectChanges();

    const items = component.backupItems();
    expect(items.length).toBe(10);
    expect(items.every(item => item.y <= 0)).toBe(true);
    expect(minPairDistance(items.map(item => ({ x: item.x, y: item.y })))).toBeGreaterThan(18);
    expect(items.every(item => !isInsideCenterOcclusion(item.x, item.y))).toBe(true);
  });

  it('should use negative float delay phase to avoid hover-start jump', () => {
    const comboDelay = Number.parseFloat(component.getFloatDelay('S1', 'combo-select'));
    const backupDelay = Number.parseFloat(component.getFloatDelay('W1', 'backup'));
    expect(comboDelay).toBeLessThan(0);
    expect(backupDelay).toBeLessThan(0);
  });

  it('activating a radar task opens a preview and does not promote it', () => {
    const event = { stopPropagation: vi.fn() } as unknown as MouseEvent;
    component.onRadarItemClick(event, 'S1');

    expect(component.previewTaskId()).toBe('S1');
    expect(mockEngine.setMainTask).not.toHaveBeenCalled();
    expect(mockEngine.insertToConsoleFromRadar).not.toHaveBeenCalled();
  });

  it('promoteToConsole should trigger magnet animation then set main task', async () => {
    component.promoteToConsole('S1');
    fixture.detectChanges();
    expect(mockEngine.setMainTask).not.toHaveBeenCalled();
    expect(component.isMagnetSliding('S1')).toBe(true);
    expect(component.promotionLockTaskId()).toBe('S1');
    expect(fixture.nativeElement.querySelector('.dock-radar')?.classList.contains('radar-promotion-active')).toBe(true);

    await vi.advanceTimersByTimeAsync(PARKING_CONFIG.CONSOLE_MAGNET_PULL_MS + 10);
    fixture.detectChanges();
    expect(component.isMagnetSliding('S1')).toBe(false);
    expect(mockEngine.setMainTask).toHaveBeenCalledWith('S1');
    expect(component.promotionLockTaskId()).toBeNull();
    expect(fixture.nativeElement.querySelector('.dock-radar')?.classList.contains('radar-promotion-active')).toBe(false);
  });

  it('renders a return cue when a focused task is evicted back to the radar', () => {
    lastRadarEvictedTaskId.set('W1');
    fixture.detectChanges();

    const returningItem = fixture.nativeElement.querySelector('[data-task-id="W1"]') as HTMLElement | null;
    expect(component.isRadarReturning('W1')).toBe(true);
    expect(returningItem?.classList.contains('radar-returning')).toBe(true);
  });

  it('explicit preview confirmation promotes the selected task', async () => {
    component.openTaskPreview('S1', 'radar-node');
    component.confirmPreviewPromotion();
    await vi.advanceTimersByTimeAsync(PARKING_CONFIG.CONSOLE_MAGNET_PULL_MS + 10);

    expect(component.previewTaskId()).toBeNull();
    expect(mockEngine.setMainTask).toHaveBeenCalledWith('S1');
  });

  it('compact radar exposes 3 candidates and 2 backups before overflow', () => {
    comboEntries.set(Array.from({ length: 5 }, (_, index) => ({
      taskId: `compact-c-${index}`,
      title: `Candidate ${index}`,
      lane: 'combo-select',
      load: 'low',
      expectedMinutes: 10,
      status: 'pending_start',
      isMain: false,
      dockedOrder: index,
    })));
    backupEntries.set(Array.from({ length: 4 }, (_, index) => ({
      taskId: `compact-b-${index}`,
      title: `Backup ${index}`,
      lane: 'backup',
      load: 'low',
      expectedMinutes: 10,
      status: 'pending_start',
      isMain: false,
      dockedOrder: index,
    })));
    fixture.detectChanges();

    expect(component.comboItems()).toHaveLength(3);
    expect(component.backupItems()).toHaveLength(2);
    expect(component.comboOverflowCount()).toBe(2);
    expect(component.backupOverflowCount()).toBe(2);
  });

  it('panorama keeps the existing 8/10 task limits', () => {
    comboEntries.set(Array.from({ length: 11 }, (_, index) => ({
      taskId: `panorama-c-${index}`,
      title: `Candidate ${index}`,
      lane: 'combo-select',
      load: 'low',
      expectedMinutes: 10,
      status: 'pending_start',
      isMain: false,
      dockedOrder: index,
    })));
    backupEntries.set(Array.from({ length: 12 }, (_, index) => ({
      taskId: `panorama-b-${index}`,
      title: `Backup ${index}`,
      lane: 'backup',
      load: 'low',
      expectedMinutes: 10,
      status: 'pending_start',
      isMain: false,
      dockedOrder: index,
    })));
    component.setViewMode('panorama');
    fixture.detectChanges();

    expect(component.comboItems()).toHaveLength(8);
    expect(component.backupItems()).toHaveLength(10);
  });

  it('view controls and overflow stack render as separate affordances', () => {
    backupEntries.set(Array.from({ length: 4 }, (_, index) => ({
      taskId: `stack-${index}`,
      title: `Stack Task ${index}`,
      lane: 'backup',
      load: 'low',
      expectedMinutes: 10,
      status: 'pending_start',
      isMain: false,
      dockedOrder: index,
    })));
    fixture.detectChanges();
    const view = fixture.nativeElement.querySelector('.radar-edge-controls');
    const stack = fixture.nativeElement.querySelector('.radar-stack-backup');
    expect(view).toBeTruthy();
    expect(stack).toBeTruthy();
  });

  it('prioritizes actionable states while keeping the previous order within each state', () => {
    comboEntries.set([
      { taskId: 'pending-first', title: 'Pending first', lane: 'combo-select', load: 'low', status: 'pending_start', isMain: false, dockedOrder: 1 },
      { taskId: 'stalled', title: 'Stalled', lane: 'combo-select', load: 'low', status: 'stalled', isMain: false, dockedOrder: 2 },
      { taskId: 'wait-ended', title: 'Wait ended', lane: 'combo-select', load: 'low', status: 'wait_finished', isMain: false, dockedOrder: 3 },
      { taskId: 'pending-second', title: 'Pending second', lane: 'combo-select', load: 'low', status: 'pending_start', isMain: false, dockedOrder: 4 },
    ]);

    expect(component.orderedComboEntries().map(entry => entry.taskId)).toEqual([
      'wait-ended', 'stalled', 'pending-first', 'pending-second',
    ]);
  });

  it('mobile drawer opens as a modal task list and previews without promoting', async () => {
    fixture.componentRef.setInput('isMobile', true);
    fixture.detectChanges();
    const trigger = document.createElement('button');
    component.openMobileTaskDrawer({ currentTarget: trigger } as unknown as MouseEvent);
    component.openTaskPreview('S1', 'task-drawer', trigger);
    fixture.detectChanges();
    await vi.advanceTimersByTimeAsync(16);
    fixture.detectChanges();

    expect(document.querySelector('[data-testid="dock-v3-mobile-task-drawer"]')?.getAttribute('aria-modal'))
      .toBe('true');
    expect(document.querySelector('[data-testid="dock-v3-task-preview"]')).toBeTruthy();
    expect(document.activeElement?.getAttribute('data-testid')).toBe('dock-v3-mobile-task-drawer-close');
    expect(mockEngine.setMainTask).not.toHaveBeenCalled();
  });

  it('restores the prior body overflow when switching from mobile to desktop with drawer open', async () => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'auto';
    try {
      fixture.componentRef.setInput('isMobile', true);
      fixture.detectChanges();
      component.openMobileTaskDrawer({ currentTarget: document.createElement('button') } as unknown as MouseEvent);
      fixture.detectChanges();
      await vi.advanceTimersByTimeAsync(16);
      fixture.detectChanges();

      expect(document.body.style.overflow).toBe('hidden');
      fixture.componentRef.setInput('isMobile', false);
      fixture.detectChanges();

      expect(component.mobileTaskDrawerOpen()).toBe(false);
      expect(document.body.style.overflow).toBe('auto');
    } finally {
      document.body.style.overflow = previousOverflow;
    }
  });

  it('switching mobile Text to Flow closes the drawer and returns to compact display', () => {
    fixture.componentRef.setInput('isMobile', true);
    component.setViewMode('panorama');
    component.mobileTaskDrawerOpen.set(true);
    fixture.componentRef.setInput('activeView', 'flow');
    fixture.detectChanges();

    expect(component.viewMode()).toBe('compact');
    expect(component.mobileTaskDrawerOpen()).toBe(false);
  });

  it('read-only follower can inspect a task but cannot promote or change its load', () => {
    fixture.componentRef.setInput('canMutate', false);
    component.openTaskPreview('S1');
    component.confirmPreviewPromotion();
    component.togglePreviewLoad();

    expect(component.previewTaskId()).toBe('S1');
    expect(mockEngine.setMainTask).not.toHaveBeenCalled();
    expect(mockEngine.toggleLoad).not.toHaveBeenCalled();
  });

  it('preview exposes explicit load and planner changes through durable engine methods', async () => {
    component.openTaskPreview('S1');
    fixture.detectChanges();
    component.togglePreviewLoad();
    const expected = fixture.nativeElement.querySelector('[data-testid="dock-v3-task-preview"] .radar-preview-edit input[min="1"]') as HTMLInputElement;
    expected.value = '35';
    expected.dispatchEvent(new Event('change', { bubbles: true }));
    await Promise.resolve();

    expect(mockEngine.toggleLoad).toHaveBeenCalledWith('S1', 'up');
    expect(mockEngine.setExpectedTime).toHaveBeenCalledWith('S1', 35);
  });

  it('recommendation groups are available as explicit segmented controls', () => {
    pendingDecisionEntries.set([{ taskId: 'S1', group: 'homologous-advancement' }]);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelectorAll('.radar-group-switch button')).toHaveLength(3);
    component.selectGroup('cognitive-downgrade');
    fixture.detectChanges();
    expect(component.activeGroup()).toBe('cognitive-downgrade');
  });

  it('promoteToConsole should route to insertToConsoleFromRadar in focus mode', async () => {
    focusMode.set(true);

    component.promoteToConsole('S1');
    await vi.advanceTimersByTimeAsync(PARKING_CONFIG.CONSOLE_MAGNET_PULL_MS + 10);

    expect(mockEngine.insertToConsoleFromRadar).toHaveBeenCalledWith('S1');
    expect(mockEngine.setMainTask).not.toHaveBeenCalled();
  });

  it('focused steady phase should still allow radar promotion', async () => {
    focusMode.set(true);
    focusTransition.set({ phase: 'focused' });

    component.promoteToConsole('S1');
    await vi.advanceTimersByTimeAsync(PARKING_CONFIG.CONSOLE_MAGNET_PULL_MS + 10);

    expect(mockEngine.insertToConsoleFromRadar).toHaveBeenCalledWith('S1');
  });

  it('promoteToConsole should ignore a late promotion after the task leaves radar', async () => {
    component.promoteToConsole('S1');
    comboEntries.set([]);
    fixture.detectChanges();

    await vi.advanceTimersByTimeAsync(PARKING_CONFIG.CONSOLE_MAGNET_PULL_MS + 10);

    expect(mockEngine.setMainTask).not.toHaveBeenCalled();
    expect(mockEngine.insertToConsoleFromRadar).not.toHaveBeenCalled();
    expect(component.isMagnetSliding('S1')).toBe(false);
    expect(component.promotionLockTaskId()).toBeNull();
  });

  it('should only mark first-seen radar items as entering once', async () => {
    comboEntries.set([
      { taskId: 'S1', title: 'Combo 1', lane: 'combo-select', load: 'low', expectedMinutes: 20, waitMinutes: null, dockedOrder: 1, status: 'pending_start', isMain: false },
      { taskId: 'S2', title: 'Combo 2', lane: 'combo-select', load: 'low', expectedMinutes: 25, waitMinutes: null, dockedOrder: 2, status: 'pending_start', isMain: false },
    ]);
    fixture.detectChanges();

    expect(component.isEntering('S1')).toBe(true);
    expect(component.isEntering('S2')).toBe(true);

    await vi.advanceTimersByTimeAsync(PARKING_CONFIG.MOTION.radar.appearMs + 60);
    expect(component.isEntering('S1')).toBe(false);
    expect(component.isEntering('S2')).toBe(false);

    comboEntries.set([
      { taskId: 'S2', title: 'Combo 2', lane: 'combo-select', load: 'low', expectedMinutes: 25, waitMinutes: null, dockedOrder: 2, status: 'pending_start', isMain: false },
      { taskId: 'S1', title: 'Combo 1', lane: 'combo-select', load: 'low', expectedMinutes: 20, waitMinutes: null, dockedOrder: 1, status: 'pending_start', isMain: false },
    ]);
    fixture.detectChanges();

    expect(component.isEntering('S1')).toBe(false);
    expect(component.isEntering('S2')).toBe(false);
  });

  it('should clear entering timer when the timer handle is 0 before scheduling first-seen cleanup', () => {
    const state = component as unknown as {
      enteringTimers: Map<string, ReturnType<typeof setTimeout>>;
    };
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
    state.enteringTimers.set('S2', 0 as unknown as ReturnType<typeof setTimeout>);

    try {
      comboEntries.set([
        ...comboEntries(),
        { taskId: 'S2', title: 'Combo 2', lane: 'combo-select', load: 'low', expectedMinutes: 25, waitMinutes: null, dockedOrder: 2, status: 'pending_start', isMain: false },
      ]);
      fixture.detectChanges();

      expect(clearTimeoutSpy).toHaveBeenCalledWith(0);
      expect(component.isEntering('S2')).toBe(true);
    } finally {
      clearTimeoutSpy.mockRestore();
    }
  });

  it('promotion lock should ignore later radar promotions while the first is in flight', async () => {
    component.promoteToConsole('S1');
    component.promoteToConsole('W1');

    expect(component.promotionLockTaskId()).toBe('S1');
    expect(component.isMagnetSliding('W1')).toBe(false);

    await vi.advanceTimersByTimeAsync(PARKING_CONFIG.CONSOLE_MAGNET_PULL_MS + 10);

    expect(mockEngine.setMainTask).toHaveBeenCalledTimes(1);
    expect(mockEngine.setMainTask).toHaveBeenCalledWith('S1');
  });

  it('should push radar points out of overlay avoidance rects', () => {
    const avoidRects = [
      {
        centerX: 120,
        centerY: -120,
        halfWidth: 60,
        halfHeight: 30,
      },
    ];

    const adjusted = resolveSpacingConflicts(
      { x: 120, y: -120 },
      [],
      0,
      420,
      420,
      'backup',
      'seed-overlay',
      18,
      avoidRects,
    );

    const expandedHalfWidth = 60 + 104;
    const expandedHalfHeight = 30 + 18;
    expect(
      Math.abs(adjusted.x - 120) >= expandedHalfWidth
      || Math.abs(adjusted.y + 120) >= expandedHalfHeight,
    ).toBe(true);
  });

  it('should keep radar float while hovered and stop after leave linger', async () => {
    expect(component.shouldAnimate('S1')).toBe(false);

    component.onRadarItemEnter('S1');
    expect(component.shouldAnimate('S1')).toBe(true);

    await vi.advanceTimersByTimeAsync(1500);
    expect(component.shouldAnimate('S1')).toBe(true);

    component.onRadarItemLeave('S1');
    await vi.advanceTimersByTimeAsync(120);
    expect(component.shouldAnimate('S1')).toBe(true);

    await vi.advanceTimersByTimeAsync(80);
    expect(component.shouldAnimate('S1')).toBe(false);
  });

  it('should clear hover exit timer when the timer handle is 0', () => {
    const setTimeoutSpy = mockTimeoutHandleForDelay(
      PARKING_CONFIG.MOTION.radar.hoverMs,
      0 as unknown as ReturnType<typeof setTimeout>,
    );
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');

    try {
      component.onRadarItemEnter('S1');
      component.onRadarItemLeave('S1');
      component.onRadarItemEnter('S1');

      expect(clearTimeoutSpy).toHaveBeenCalledWith(0);
      expect(component.shouldAnimate('S1')).toBe(true);
    } finally {
      setTimeoutSpy.mockRestore();
      clearTimeoutSpy.mockRestore();
    }
  });

  it('should clear focus exit timer when the timer handle is 0', () => {
    const setTimeoutSpy = mockTimeoutHandleForDelay(
      PARKING_CONFIG.MOTION.radar.hoverMs,
      0 as unknown as ReturnType<typeof setTimeout>,
    );
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');

    try {
      component.onRadarItemFocus('S1');
      component.onRadarItemBlur('S1');
      component.onRadarItemBlur('S1');

      expect(clearTimeoutSpy).toHaveBeenCalledWith(0);
    } finally {
      setTimeoutSpy.mockRestore();
      clearTimeoutSpy.mockRestore();
    }
  });

  it('should keep radar float when focus returns before the exit timer settles', async () => {
    component.onRadarItemFocus('S1');
    expect(component.shouldAnimate('S1')).toBe(true);

    component.onRadarItemBlur('S1');
    await vi.advanceTimersByTimeAsync(120);
    component.onRadarItemFocus('S1');
    await vi.advanceTimersByTimeAsync(100);

    expect(component.shouldAnimate('S1')).toBe(true);
  });

  it('should clear promotion timer when the timer handle is 0 and the task leaves radar', () => {
    const state = component as unknown as {
      promotionTimer: ReturnType<typeof setTimeout> | null;
    };
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
    state.promotionTimer = 0 as unknown as ReturnType<typeof setTimeout>;

    try {
      component.promotionLockTaskId.set('S1');
      fixture.detectChanges();
      comboEntries.set([]);
      fixture.detectChanges();

      expect(clearTimeoutSpy).toHaveBeenCalledWith(0);
      expect(state.promotionTimer).toBeNull();
      expect(component.promotionLockTaskId()).toBeNull();
    } finally {
      clearTimeoutSpy.mockRestore();
    }
  });

  it('should clear radar return timer when the timer handle is 0 and the task is evicted again', () => {
    const state = component as unknown as {
      radarReturnTimers: Map<string, ReturnType<typeof setTimeout>>;
    };
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
    state.radarReturnTimers.set('W1', 0 as unknown as ReturnType<typeof setTimeout>);

    try {
      lastRadarEvictedTaskId.set('W1');
      fixture.detectChanges();

      expect(clearTimeoutSpy).toHaveBeenCalledWith(0);
      expect(component.isRadarReturning('W1')).toBe(true);
    } finally {
      clearTimeoutSpy.mockRestore();
    }
  });

  it('should clear owned timers on destroy when timer handles are 0', () => {
    const state = component as unknown as {
      promotionTimer: ReturnType<typeof setTimeout> | null;
    };
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
    state.promotionTimer = 0 as unknown as ReturnType<typeof setTimeout>;

    try {
      fixture.destroy();

      expect(clearTimeoutSpy).toHaveBeenCalledWith(0);
      expect(state.promotionTimer).toBeNull();
    } finally {
      clearTimeoutSpy.mockRestore();
    }
  });

  it('radar task controls are native buttons and keyboard activation opens preview', () => {
    const item = fixture.nativeElement.querySelector('[data-testid="dock-v3-radar-combo-item"]') as HTMLButtonElement;
    expect(item.tagName).toBe('BUTTON');
    item.click();
    fixture.detectChanges();

    expect(component.previewTaskId()).toBe('S1');
    expect(mockEngine.setMainTask).not.toHaveBeenCalled();
  });

  it('overflow task selection opens preview instead of promoting', () => {
    comboEntries.set([
      ...comboEntries(),
      { ...comboEntries()[0], taskId: 'S2', title: 'Overflow Task', dockedOrder: 2 },
      { ...comboEntries()[0], taskId: 'S3', title: 'Overflow Task 2', dockedOrder: 3 },
      { ...comboEntries()[0], taskId: 'S4', title: 'Overflow Task 3', dockedOrder: 4 },
    ]);
    component.setViewMode('compact');
    component.toggleComboOverflowPanel();
    fixture.detectChanges();
    const overflow = fixture.nativeElement.querySelector('[data-testid="dock-v3-radar-overflow-item"]') as HTMLButtonElement;
    overflow.click();
    fixture.detectChanges();

    expect(component.previewTaskId()).toBeTruthy();
    expect(mockEngine.setMainTask).not.toHaveBeenCalled();
  });

  it('should render project source color dot with accessible project text', () => {
    comboEntries.set([
      {
        taskId: 'S1',
        title: 'Combo Task',
        lane: 'combo-select',
        load: 'low',
        expectedMinutes: 20,
        sourceProjectId: 'proj-1',
        dockedOrder: 1,
        status: 'pending_start',
        isMain: false,
      },
    ]);
    fixture.detectChanges();

    const item = fixture.nativeElement.querySelector('[data-testid="dock-v3-radar-combo-item"]');
    expect(item.getAttribute('aria-label')).toContain('来源项目：项目一');
    expect(component.resolveProjectColor(comboEntries()[0])).toBe('#ff5722');
  });

  it('should expose a task stack and overflow list after the compact candidate budget', () => {
    const oversized = Array.from({ length: component.comboVisibleCount() + 2 }, (_, index) => ({
      taskId: `combo-${index}`,
      title: `Combo ${index}`,
      lane: 'combo-select',
      load: 'low',
      expectedMinutes: 10,
      sourceProjectId: `proj-${index}`,
      dockedOrder: index,
      status: 'pending_start',
      isMain: false,
    }));
    comboEntries.set(oversized);
    fixture.detectChanges();

    const trigger = fixture.nativeElement.querySelector('[data-testid="dock-v3-radar-combo-overflow-trigger"]');
    expect(trigger).toBeTruthy();
    expect(component.comboOverflowCount()).toBe(2);

    component.toggleComboOverflowPanel();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-testid="dock-v3-radar-combo-overflow-panel"]')).toBeTruthy();
  });
});

function minPairDistance(points: Array<{ x: number; y: number }>): number {
  if (points.length < 2) return Number.POSITIVE_INFINITY;
  let min = Number.POSITIVE_INFINITY;
  for (let i = 0; i < points.length; i += 1) {
    for (let j = i + 1; j < points.length; j += 1) {
      const dx = points[i]!.x - points[j]!.x;
      const dy = points[i]!.y - points[j]!.y;
      min = Math.min(min, Math.hypot(dx, dy));
    }
  }
  return min;
}

function isInsideCenterOcclusion(x: number, y: number): boolean {
  const centerX = 0;
  const centerY = -36;
  const rx = 220;
  const ry = 170;
  const dx = x - centerX;
  const dy = y - centerY;
  return ((dx * dx) / (rx * rx)) + ((dy * dy) / (ry * ry)) < 1;
}

function mockTimeoutHandleForDelay(delay: number, handle: ReturnType<typeof setTimeout>) {
  const originalSetTimeout = globalThis.setTimeout;
  return vi.spyOn(globalThis, 'setTimeout').mockImplementation((
    (handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
      if (timeout === delay) return handle;
      return originalSetTimeout(handler, timeout, ...args);
    }
  ) as typeof setTimeout);
}
