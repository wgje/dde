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

  it('promoteToConsole should trigger magnet animation then set main task', async () => {
    component.promoteToConsole('S1');
    expect(mockEngine.setMainTask).not.toHaveBeenCalled();
    expect(component.isMagnetSliding('S1')).toBe(true);
    expect(component.promotionLockTaskId()).toBe('S1');

    await vi.advanceTimersByTimeAsync(PARKING_CONFIG.CONSOLE_MAGNET_PULL_MS + 10);
    expect(component.isMagnetSliding('S1')).toBe(false);
    expect(mockEngine.setMainTask).toHaveBeenCalledWith('S1');
    expect(component.promotionLockTaskId()).toBeNull();
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

  it('onWheel should toggle load only with alt key', () => {
    const preventDefault = vi.fn();
    component.onWheel({ altKey: false, deltaY: 120, preventDefault } as unknown as WheelEvent, 'S1');
    expect(mockEngine.toggleLoad).not.toHaveBeenCalled();

    component.onWheel({ altKey: true, deltaY: 120, preventDefault } as unknown as WheelEvent, 'S1');
    expect(preventDefault).toHaveBeenCalled();
    expect(mockEngine.toggleLoad).toHaveBeenCalledWith('S1', 'down');
  });

  it('keyboard Enter should promote radar task to console', () => {
    const preventDefault = vi.fn();
    const event = {
      key: 'Enter',
      preventDefault,
    } as unknown as KeyboardEvent;
    const promoteSpy = vi.spyOn(component, 'promoteToConsole');

    component.onRadarItemKeydown(event, 'S1');

    expect(preventDefault).toHaveBeenCalled();
    expect(promoteSpy).toHaveBeenCalledWith('S1');
  });

  it('submitCreate should create task in selected radar lane', () => {
    component.createFormLane.set('combo-select');
    component.createTitle = 'Radar Draft';
    component.createLoad = 'low';
    component.createExpected = '25';
    component.createWait = '5';

    component.submitCreate();

    expect(mockEngine.createInDock).toHaveBeenCalledWith('Radar Draft', 'combo-select', 'low', {
      expectedMinutes: 25,
      waitMinutes: 5,
    });
    expect(component.createFormLane()).toBeNull();
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

  it('should expose +N trigger and overflow panel when combo entries exceed limit', () => {
    const oversized = Array.from({ length: PARKING_CONFIG.RADAR_COMBO_VISIBLE_LIMIT + 2 }, (_, index) => ({
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
