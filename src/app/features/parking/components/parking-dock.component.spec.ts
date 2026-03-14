import { ComponentFixture, TestBed } from '@angular/core/testing';
import { computed, signal } from '@angular/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ParkingDockComponent } from '../parking-dock.component';
import { DockPlannerQuickEditComponent } from './dock-planner-quick-edit.component';
import { DockEngineService } from '../../../../services/dock-engine.service';
import { DynamicModalService } from '../../../../services/dynamic-modal.service';
import { FocusDockLeaderService } from '../../../../services/focus-dock-leader.service';
import { GateService } from '../../../../services/gate.service';
import { PerformanceTierService } from '../../../../services/performance-tier.service';
import { ToastService } from '../../../../services/toast.service';
import { ModalLoaderService } from '../../../core/services/modal-loader.service';
import { ProjectStore, TaskStore } from '../../../core/state/stores';
import { PARKING_CONFIG } from '../../../../config/parking.config';
import { UiStateService } from '../../../../services/ui-state.service';

describe('ParkingDockComponent v4', () => {
  let fixture: ComponentFixture<ParkingDockComponent>;
  let component: ParkingDockComponent;
  let uiState: UiStateService;

  const dockedEntries = signal<any[]>([]);
  const focusMode = signal(false);
  const focusScrimOn = signal(true);
  const focusTransition = signal<any>(null);
  const dockExpanded = signal(true);
  const pendingDecision = signal<any>(null);
  const pendingDecisionEntries = signal<any[]>([]);
  const statusMachineEntries = signal<any[]>([]);
  const muteWaitTone = signal(false);
  const suspendedEntries = signal<any[]>([]);
  const availableDailySlots = signal<any[]>([]);
  const highlightedIds = signal<Set<string>>(new Set());
  const firstMainSelectionPending = signal<{ taskId: string; expiresAt: number } | null>(null);
  const fragmentEntryCountdown = signal<number | null>(null);
  const lastRadarInsertedTaskId = signal<string | null>(null);
  const lastRadarEvictedTaskId = signal<string | null>(null);
  const editLock = signal(false);
  const tick = signal(0);

  const mockEngine = {
    dockedEntries,
    orderedDockEntries: computed(() => dockedEntries()),
    dockedCount: computed(() => dockedEntries().length),
    consoleEntries: computed(() => dockedEntries().filter(entry => entry.isMain && entry.status !== 'completed')),
    consoleVisibleEntries: computed(() => dockedEntries().filter(entry => entry.isMain && entry.status !== 'completed').slice(0, 4)),
    focusingEntry: computed(
      () => dockedEntries().find(entry => entry.status === 'focusing' && entry.isMain) ?? null,
    ),
    focusMode,
    focusScrimOn,
    focusTransition,
    dockExpanded,
    pendingDecision,
    pendingDecisionEntries,
    statusMachineEntries,
    muteWaitTone,
    suspendedEntries,
    availableDailySlots,
    highlightedIds,
    firstMainSelectionPending,
    fragmentEntryCountdown,
    lastRadarInsertedTaskId,
    lastRadarEvictedTaskId,
    pendingRadarEviction: signal<string | null>(null),
    flushRadarEviction: vi.fn(),
    editLock,
    tick,
    isFragmentPhase: signal(false),
    isBurnoutActive: signal(false),
    fragmentDefenseLevel: signal(1 as 1 | 2 | 3 | 4),
    burnoutTriggeredAt: signal<number | null>(null),
    lastRecommendationGroups: signal([]),
    highLoadCounter: signal({ count: 0, windowStartAt: 0 }),
    restReminderActive: signal(false),
    cumulativeHighLoadMs: signal(0),
    cumulativeLowLoadMs: signal(0),
    dismissRestReminder: vi.fn(),
    comboSelectEntries: signal([]),
    backupEntries: signal([]),
    toggleFocusMode: vi.fn(() => focusMode.update(value => !value)),
    toggleFocusScrim: vi.fn(() => focusScrimOn.update(value => !value)),
    setFocusScrim: vi.fn((on: boolean) => focusScrimOn.set(on)),
    beginFocusTransition: vi.fn((state: unknown) => focusTransition.set(state)),
    endFocusTransition: vi.fn(() => focusTransition.set(null)),
    holdNonCriticalWork: vi.fn(),
    setDockExpanded: vi.fn((expanded: boolean) => dockExpanded.set(expanded)),
    choosePendingDecisionCandidate: vi.fn(),
    cancelPendingDecisionAutoPromote: vi.fn(),
    toggleMuteWaitTone: vi.fn(),
    getWaitRemainingSeconds: vi.fn(() => null),
    completeDailySlot: vi.fn(),
    removeDailySlot: vi.fn(),
    addDailySlot: vi.fn(),
    createInDock: vi.fn(() => 'dock-created'),
    completeTask: vi.fn(),
    suspendTask: vi.fn(),
    switchToTask: vi.fn(),
    insertToConsoleFromRadar: vi.fn(),
    dockTaskFromExternalDrag: vi.fn(() => true),
    dockTask: vi.fn(() => true),
    removeFromDock: vi.fn(),
    setMainTask: vi.fn(),
    overrideFirstMainTask: vi.fn(),
    markExitAction: vi.fn(),
    clearDockForExit: vi.fn(),
    getInlineArchiveCandidates: vi.fn(() => []),
    archiveInlineEntriesToActiveProject: vi.fn(() => ({ converted: 0, failed: 0 })),
    reorderDockEntries: vi.fn(),
    toggleLoad: vi.fn(),
    setExpectedTime: vi.fn(),
    setWaitTime: vi.fn(),
    setDetail: vi.fn(),
    acquireDockEditLock: vi.fn(() => editLock.set(true)),
    releaseDockEditLock: vi.fn(() => editLock.set(false)),
    acceptFragmentEntry: vi.fn(),
    skipFragmentEntry: vi.fn(),
    dismissZenMode: vi.fn(),
  };

  const mockTaskStore = {
    getTask: vi.fn((id: string) => ({ id, status: 'active' })),
  };

  const mockFocusLeader = {
    isLeader: signal(true),
    isFollower: signal(false),
    isReadOnlyFollower: signal(false),
    tryTakeover: vi.fn(() => true),
  };

  const mockPerformanceTier = {
    tier: signal<'T0' | 'T1' | 'T2'>('T0'),
    isTier1Plus: signal(false),
    isTier2: signal(false),
    lastMeasuredFps: signal(60),
    startMeasuring: vi.fn(),
    stopMeasuring: vi.fn(),
  };

  const mockGateService = {
    isActive: signal(false),
  };

  const mockProjectStore = {
    projects: signal([] as any[]),
  };

  const mockModalLoader = {
    loadSettingsModal: vi.fn().mockResolvedValue(ParkingDockComponent),
  };

  const mockDynamicModal = {
    open: vi.fn(),
    close: vi.fn(),
  };

  const mockToast = {
    error: vi.fn(),
  };

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    dockedEntries.set([]);
    focusMode.set(false);
    focusScrimOn.set(true);
    focusTransition.set(null);
    dockExpanded.set(true);
    pendingDecision.set(null);
    pendingDecisionEntries.set([]);
    statusMachineEntries.set([]);
    muteWaitTone.set(false);
    suspendedEntries.set([]);
    availableDailySlots.set([]);
    highlightedIds.set(new Set());
    firstMainSelectionPending.set(null);
    fragmentEntryCountdown.set(null);
    lastRadarInsertedTaskId.set(null);
    lastRadarEvictedTaskId.set(null);
    editLock.set(false);
    tick.set(0);
    mockFocusLeader.isLeader.set(true);
    mockFocusLeader.isFollower.set(false);
    mockFocusLeader.isReadOnlyFollower.set(false);
    mockFocusLeader.tryTakeover.mockClear();
    mockPerformanceTier.tier.set('T0');
    mockGateService.isActive.set(false);
    mockModalLoader.loadSettingsModal.mockResolvedValue(ParkingDockComponent);
    mockDynamicModal.open.mockClear();
    mockDynamicModal.close.mockClear();
    mockToast.error.mockClear();

    await TestBed.configureTestingModule({
      imports: [ParkingDockComponent, DockPlannerQuickEditComponent],
      providers: [
        { provide: DockEngineService, useValue: mockEngine },
        { provide: TaskStore, useValue: mockTaskStore },
        { provide: ProjectStore, useValue: mockProjectStore },
        { provide: FocusDockLeaderService, useValue: mockFocusLeader },
        { provide: GateService, useValue: mockGateService },
        { provide: ModalLoaderService, useValue: mockModalLoader },
        { provide: DynamicModalService, useValue: mockDynamicModal },
        { provide: PerformanceTierService, useValue: mockPerformanceTier },
        { provide: ToastService, useValue: mockToast },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(ParkingDockComponent);
    component = fixture.componentInstance;
    uiState = TestBed.inject(UiStateService);
    fixture.detectChanges();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it('createTask should create in dock with blackbox ownership semantics', () => {
    component.newTaskTitle = 'New Task';
    component.newTaskDetail = 'Task detail';
    component.newTaskLane = 'backup';
    component.newTaskLoad = 'high';
    component.newTaskExpectedMinutes = '25';
    component.newTaskWaitMinutes = '5';

    component.createTask();

    expect(mockEngine.createInDock).toHaveBeenCalledWith('New Task', 'backup', 'high', {
      expectedMinutes: 25,
      waitMinutes: 5,
      detail: 'Task detail',
    });
  });

  it('onBackdropClick should not change focus or scrim state when no transient surface is open', () => {
    focusMode.set(true);
    focusScrimOn.set(true);
    fixture.detectChanges();

    component.onBackdropClick();

    expect(mockEngine.toggleFocusScrim).not.toHaveBeenCalled();
    expect(mockEngine.toggleFocusMode).not.toHaveBeenCalled();
    expect(focusMode()).toBe(true);
    expect(focusScrimOn()).toBe(true);
  });

  it('onBackdropClick should close planner quick edit before touching focus state', () => {
    dockedEntries.set([
      {
        taskId: 'task-planner-open',
        title: 'Planner Open Task',
        status: 'pending_start',
        load: 'low',
        lane: 'backup',
        expectedMinutes: null,
        waitMinutes: null,
        isMain: false,
      },
    ]);
    focusMode.set(true);
    focusScrimOn.set(true);
    component.togglePlannerQuickEdit('task-planner-open');
    fixture.detectChanges();

    component.onBackdropClick();

    expect(component.isPlannerQuickEditOpen('task-planner-open')).toBe(false);
    expect(mockEngine.toggleFocusMode).not.toHaveBeenCalled();
    expect(mockEngine.toggleFocusScrim).not.toHaveBeenCalled();
  });

  it('onBackdropClick should close the help overlay before touching focus state', () => {
    focusMode.set(true);
    focusScrimOn.set(true);
    component.toggleHelpOverlay();
    fixture.detectChanges();

    component.onBackdropClick();
    fixture.detectChanges();

    expect(component.showHelpOverlay()).toBe(false);
    expect(fixture.nativeElement.querySelector('[data-testid="dock-v3-help-overlay"]')).toBeNull();
  });

  it('should render full-mode advanced controls and drop-zone by default', () => {
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('[data-testid="dock-v3-create-toggle"]')).toBeTruthy();
    expect(fixture.nativeElement.querySelector('[data-testid="dock-v3-drop-zone"]')).toBeTruthy();
  });

  it('clampHudPosition should allow HUD to reach any edge with only 12px margin', () => {
    const size = { width: 290, height: 220 };
    const minMargin = 12;

    // TODO(L-19): Consider exposing via protected method or test harness
    // 右下角 — 不再有 FAB 避让带
    const bottomRight = (component as unknown as {
      clampHudPosition: (position: { x: number; y: number }, size: { width: number; height: number }) => { x: number; y: number };
    }).clampHudPosition({ x: window.innerWidth, y: window.innerHeight }, size);
    expect(bottomRight.x).toBe(window.innerWidth - size.width - minMargin);
    expect(bottomRight.y).toBe(window.innerHeight - size.height - minMargin);

    // 右上角 — 按钮已内嵌，无避让
    const topRight = (component as unknown as {
      clampHudPosition: (position: { x: number; y: number }, size: { width: number; height: number }) => { x: number; y: number };
    }).clampHudPosition({ x: window.innerWidth, y: 0 }, size);
    expect(topRight.x).toBe(window.innerWidth - size.width - minMargin);
    expect(topRight.y).toBe(minMargin);
  });

  it('onDrop should prefer unified payload protocol taskId', () => {
    const getData = vi.fn((mime: string) => {
      if (mime === 'application/x-nanoflow-task') {
        return JSON.stringify({ v: 1, type: 'task', taskId: 'task-1', projectId: 'p-1', source: 'flow' });
      }
      return '';
    });

    component.onDrop({
      preventDefault: vi.fn(),
      dataTransfer: { getData } as unknown as DataTransfer,
    } as unknown as DragEvent);

    expect(mockEngine.dockTaskFromExternalDrag).toHaveBeenCalledWith('task-1', 'flow');
    expect(component.dropState()).toBe('idle');
  });

  it('onDrop should fallback to text/plain and use default backup entrypoint', () => {
    const getData = vi.fn((mime: string) => (mime === 'text/plain' ? 'legacy-task' : ''));

    component.onDrop({
      preventDefault: vi.fn(),
      dataTransfer: { getData } as unknown as DataTransfer,
    } as unknown as DragEvent);

    expect(mockEngine.dockTaskFromExternalDrag).toHaveBeenCalledWith('legacy-task', undefined);
  });

  it('onDrop should ignore laneHint and still use default backup entrypoint', () => {
    const getData = vi.fn((mime: string) => {
      if (mime === 'application/x-nanoflow-task') {
        return JSON.stringify({
          v: 1,
          type: 'task',
          taskId: 'task-lane-hint',
          projectId: 'p-1',
          source: 'text',
          laneHint: 'combo-select',
        });
      }
      return '';
    });

    component.onDrop({
      preventDefault: vi.fn(),
      dataTransfer: { getData } as unknown as DataTransfer,
    } as unknown as DragEvent);

    expect(mockEngine.dockTaskFromExternalDrag).toHaveBeenCalledWith('task-lane-hint', 'text');
    expect(mockEngine.dockTask).not.toHaveBeenCalled();
  });

  it('invalid drop should enter reject state and not dock duplicated task', async () => {
    dockedEntries.set([
      {
        taskId: 'task-1',
        title: 'Task 1',
        status: 'pending_start',
        load: 'low',
        lane: 'combo-select',
        isMain: false,
      },
    ]);

    const getData = vi.fn((mime: string) => {
      if (mime === 'application/x-nanoflow-task') {
        return JSON.stringify({ v: 1, type: 'task', taskId: 'task-1', projectId: 'p-1', source: 'flow' });
      }
      return '';
    });

    component.onDrop({
      preventDefault: vi.fn(),
      dataTransfer: { getData } as unknown as DataTransfer,
    } as unknown as DragEvent);

    expect(component.dropState()).toBe('reject');
    expect(mockEngine.dockTaskFromExternalDrag).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(240);
    expect(component.dropState()).toBe('idle');
  });

  it('drop with incomplete planner fields should keep planner as an explicit opt-in action', () => {
    const getData = vi.fn((mime: string) => {
      if (mime === 'application/x-nanoflow-task') {
        return JSON.stringify({
          v: 1,
          type: 'task',
          taskId: 'task-missing-fields',
          projectId: 'p-1',
          source: 'text',
        });
      }
      return '';
    });

    component.onDrop({
      preventDefault: vi.fn(),
      dataTransfer: { getData } as unknown as DataTransfer,
    } as unknown as DragEvent);

    expect(component.isPlannerQuickEditOpen('task-missing-fields')).toBe(false);
    expect(component.recentlyDockedTaskId()).toBe('task-missing-fields');
  });

  it('planner quick edit should forward explicit planner changes to the engine', () => {
    dockedEntries.set([
      {
        taskId: 'task-planner',
        title: 'Planner Task',
        status: 'pending_start',
        load: 'low',
        lane: 'backup',
        expectedMinutes: null,
        waitMinutes: null,
        isMain: false,
      },
    ]);

    component.togglePlannerQuickEdit('task-planner');
    component.setPlannerQuickEditExpected('task-planner', 45);
    component.setPlannerQuickEditWait('task-planner', 15);
    component.setPlannerQuickEditLoad('task-planner', 'high');

    expect(mockEngine.setExpectedTime).toHaveBeenCalledWith('task-planner', 45);
    expect(mockEngine.setWaitTime).toHaveBeenCalledWith('task-planner', 15);
    expect(mockEngine.toggleLoad).toHaveBeenCalledWith('task-planner', 'up');
  });

  it('planner quick edit should render a card-level trigger even when planner fields are already complete', () => {
    dockedEntries.set([
      {
        taskId: 'task-planner-complete',
        title: 'Planner Complete Task',
        status: 'pending_start',
        load: 'low',
        lane: 'backup',
        expectedMinutes: 45,
        waitMinutes: 15,
        isMain: false,
      },
    ]);
    fixture.detectChanges();

    const card = fixture.nativeElement.querySelector('[data-testid="dock-v3-item"]') as HTMLElement | null;
    const trigger = card?.querySelector('[data-testid="dock-v3-planner-toggle"]') as HTMLButtonElement | null;

    expect(trigger).toBeTruthy();
    expect(trigger?.getAttribute('data-planner-task-id')).toBe('task-planner-complete');
    expect(trigger?.disabled).toBe(false);
  });

  it('planner quick edit should mark the dock card as open while rendering the panel outside the card rail', () => {
    dockedEntries.set([
      {
        taskId: 'task-planner-open',
        title: 'Planner Open Task',
        status: 'pending_start',
        load: 'low',
        lane: 'backup',
        expectedMinutes: null,
        waitMinutes: null,
        isMain: false,
      },
    ]);

    component.togglePlannerQuickEdit('task-planner-open');
    fixture.detectChanges();
    // 避免 vi.runAllTimersAsync() —— 在 isolate:false 环境下会触发其它测试文件泄漏的 setInterval，导致 10000 timer 限制
    vi.advanceTimersByTime(0);
    fixture.detectChanges();

    const card = fixture.nativeElement.querySelector('[data-testid="dock-v3-item"]') as HTMLElement | null;
    const panel = fixture.nativeElement.querySelector('[data-testid="dock-v3-planner-panel"]') as HTMLElement | null;

    expect(card?.classList.contains('planner-open')).toBe(true);
    expect(component.isPlannerQuickEditOpen('task-planner-open')).toBe(true);
    expect(panel).toBeTruthy();
    expect(card?.contains(panel as Node)).toBe(false);
    expect(panel?.className).toContain('rounded-2xl');
    expect(panel?.className).toContain('animate-[plannerSlideOpen_200ms_ease-out]');
  });

  it('desktop planner quick edit should close on outside pointer down', () => {
    dockedEntries.set([
      {
        taskId: 'task-planner-outside',
        title: 'Planner Outside Task',
        status: 'pending_start',
        load: 'low',
        lane: 'backup',
        expectedMinutes: null,
        waitMinutes: null,
        isMain: false,
      },
    ]);

    component.togglePlannerQuickEdit('task-planner-outside');
    fixture.detectChanges();

    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    fixture.detectChanges();

    expect(component.isPlannerQuickEditOpen('task-planner-outside')).toBe(false);
  });

  it('onFocusSessionToggle should start enter transition with flip ghost', async () => {
    component.onFocusSessionToggle();
    fixture.detectChanges();

    expect(mockEngine.beginFocusTransition).toHaveBeenCalled();
    expect(focusTransition()?.phase).toBe('entering');
    expect(fixture.nativeElement.querySelector('[data-testid="dock-v4-flip-ghost"]')).toBeTruthy();

    await vi.advanceTimersByTimeAsync(20);
    fixture.detectChanges();
    expect(mockEngine.toggleFocusMode).toHaveBeenCalledTimes(1);
    expect(focusMode()).toBe(true);

    await vi.advanceTimersByTimeAsync(PARKING_CONFIG.MOTION.focus.enterMs + 20);
    fixture.detectChanges();
    expect(focusTransition()?.phase).toBe('focused');
  });

  it('should freeze performance tier during focus transition until settled', () => {
    mockPerformanceTier.tier.set('T0');
    component.onFocusSessionToggle();
    fixture.detectChanges();

    expect(component.performanceTier()).toBe('T0');

    mockPerformanceTier.tier.set('T2');
    fixture.detectChanges();
    expect(component.performanceTier()).toBe('T0');

    component.onFocusTransitionSettled('entering');
    fixture.detectChanges();
    expect(component.performanceTier()).toBe('T2');
  });

  it('onFocusSessionToggle should require confirmation before exit transition', async () => {
    focusMode.set(true);
    fixture.detectChanges();

    component.onFocusSessionToggle();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('[data-testid="dock-v3-exit-confirm"]')).toBeTruthy();
    expect(mockEngine.beginFocusTransition).not.toHaveBeenCalled();

    component.confirmExitFocus('request-end-focus');
    fixture.detectChanges();
    expect(component.exitFlowStep()).toBe('destructive');

    component.confirmExitFocus('save-exit');
    fixture.detectChanges();
    expect(mockEngine.beginFocusTransition).toHaveBeenCalled();
    expect(focusTransition()?.phase).toBe('exiting');

    await vi.advanceTimersByTimeAsync(20);
    fixture.detectChanges();
    expect(mockEngine.toggleFocusMode).toHaveBeenCalledTimes(1);
    expect(focusMode()).toBe(false);

    await vi.advanceTimersByTimeAsync(PARKING_CONFIG.MOTION.focus.exitMs + 20);
    fixture.detectChanges();
    expect(mockEngine.endFocusTransition).toHaveBeenCalled();
    expect(focusTransition()).toBeNull();
  });

  it('confirmExitFocus clear-exit should clear dock immediately before exit transition', () => {
    focusMode.set(true);

    component.confirmExitFocus('clear-exit');
    expect(mockEngine.markExitAction).toHaveBeenCalledWith('clear_exit');
    expect(mockEngine.clearDockForExit).toHaveBeenCalledTimes(1);
  });

  it('keep-focus-hide-scrim should not trigger archive conversion', () => {
    focusMode.set(true);

    component.confirmExitFocus('keep-focus-hide-scrim');

    expect(mockEngine.archiveInlineEntriesToActiveProject).not.toHaveBeenCalled();
  });
  it('Alt+H should render the help overlay when focus mode is active', () => {
    focusMode.set(true);
    focusScrimOn.set(true);
    fixture.detectChanges();

    component.onKeydown(new KeyboardEvent('keydown', { key: 'h', altKey: true }));
    fixture.detectChanges();

    expect(component.showHelpOverlay()).toBe(true);
    expect(fixture.nativeElement.querySelector('[data-testid="dock-v3-help-overlay"]')).toBeTruthy();
  });

  it('background dock clicks should surface feedback while switching the front task', () => {
    dockedEntries.set([
      {
        taskId: 'focus-main',
        title: 'Focus Main',
        status: 'focusing',
        load: 'low',
        lane: 'backup',
        expectedMinutes: 25,
        waitMinutes: null,
        isMain: true,
      },
      {
        taskId: 'focus-next',
        title: 'Focus Next',
        status: 'pending_start',
        load: 'low',
        lane: 'backup',
        expectedMinutes: 15,
        waitMinutes: null,
        isMain: false,
      },
    ]);
    focusMode.set(true);
    focusScrimOn.set(true);
    fixture.detectChanges();

    component.onDockCardClick('focus-next');
    fixture.detectChanges();

    expect(mockEngine.setMainTask).toHaveBeenCalledWith('focus-next');
    expect(component.dockActionFeedback()?.message).toContain('已切换到前台');
    expect(fixture.nativeElement.querySelector('[data-testid="dock-v3-dock-feedback"]')).toBeTruthy();
  });

  it('two-step exit flow should allow returning from destructive choices', () => {
    focusMode.set(true);
    fixture.detectChanges();

    component.onFocusSessionToggle();
    component.confirmExitFocus('request-end-focus');
    fixture.detectChanges();
    expect(component.exitFlowStep()).toBe('destructive');

    component.confirmExitFocus('back');
    fixture.detectChanges();
    expect(component.exitFlowStep()).toBe('primary');
  });

  it('first main 15s window should route click to override path', () => {
    dockedEntries.set([
      {
        taskId: 'A',
        title: 'Focus A',
        status: 'focusing',
        load: 'low',
        lane: 'backup',
        expectedMinutes: 25,
        waitMinutes: null,
        isMain: true,
      },
      {
        taskId: 'B',
        title: 'Focus B',
        status: 'pending_start',
        load: 'low',
        lane: 'backup',
        expectedMinutes: 15,
        waitMinutes: null,
        isMain: false,
      },
    ]);
    firstMainSelectionPending.set({ taskId: 'A', expiresAt: Date.now() + 15000 });
    component.onDockCardClick('B');
    expect(mockEngine.overrideFirstMainTask).toHaveBeenCalledWith('B');
    expect(mockEngine.setMainTask).not.toHaveBeenCalled();
  });

  it('focus scrim should still allow switching the dock main task', () => {
    dockedEntries.set([
      {
        taskId: 'focus-main',
        title: 'Focus Main',
        status: 'focusing',
        load: 'low',
        lane: 'backup',
        expectedMinutes: 25,
        waitMinutes: null,
        isMain: true,
      },
      {
        taskId: 'focus-target',
        title: 'Focus Target',
        status: 'pending_start',
        load: 'low',
        lane: 'backup',
        expectedMinutes: 15,
        waitMinutes: null,
        isMain: false,
      },
    ]);
    focusMode.set(true);
    focusScrimOn.set(true);

    component.onDockCardClick('focus-target');

    expect(mockEngine.setMainTask).toHaveBeenCalledWith('focus-target');
  });

  it('main dock cards should not show backup or combo lane labels', () => {
    dockedEntries.set([
      {
        taskId: 'main-backup',
        title: 'Main Backup Task',
        status: 'pending_start',
        load: 'low',
        lane: 'backup',
        expectedMinutes: 25,
        waitMinutes: null,
        isMain: true,
      },
    ]);
    fixture.detectChanges();

    const card = fixture.nativeElement.querySelector('[data-testid="dock-v3-item"]') as HTMLElement | null;
    const text = card?.textContent ?? '';

    expect(text).toContain('主任务');
    expect(text).not.toContain('副任务');
    expect(text).not.toContain('组合选择');
  });

  it('should render visible first-main override hint during 15s window', () => {
    firstMainSelectionPending.set({ taskId: 'A', expiresAt: Date.now() + 15000 });
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('[data-testid="dock-v3-first-main-hint"]')).toBeTruthy();
    expect(fixture.nativeElement.textContent).toContain('15 秒内');
  });

  it('hud minimal mode should use fixed top-center width', () => {
    focusMode.set(true);
    focusScrimOn.set(false);
    const style = component.hudContainerStyle();
    expect(style.top).toBe('16px');
    expect(style.left).toBe('50%');
    expect(style.width).toBe('200px');
  });

  it('full HUD should default to upper-right with 12px margin', () => {
    focusMode.set(true);
    focusScrimOn.set(true);

    const style = component.hudContainerStyle();

    expect(style.top).toBe(`${PARKING_CONFIG.HUD_FULL_DEFAULT_TOP_PX}px`);
    expect(style.left).toBe(`${window.innerWidth - PARKING_CONFIG.HUD_FULL_MAX_WIDTH_PX - 12}px`);
    expect(style.right).toBe('auto');
  });

  it('should render fragment countdown overlay and wire accept/skip actions', () => {
    focusMode.set(true);
    fragmentEntryCountdown.set(8);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('[data-testid="fragment-countdown-number"]')?.textContent).toContain('8s');

    fixture.nativeElement.querySelector('[data-testid="fragment-countdown-skip"]')?.click();
    expect(mockEngine.skipFragmentEntry).toHaveBeenCalledTimes(1);

    fixture.nativeElement.querySelector('[data-testid="fragment-countdown-accept"]')?.click();
    expect(mockEngine.acceptFragmentEntry).toHaveBeenCalledTimes(1);
  });

  it('createBackupTaskFromFab should add low-load backup task', () => {
    component.createBackupTaskFromFab();
    expect(mockEngine.createInDock).toHaveBeenCalledWith('新备选任务', 'backup', 'low');
  });

  it('focus scrim should still allow planner quick edit and backup FAB actions', () => {
    dockedEntries.set([
      {
        taskId: 'focus-planner',
        title: 'Focus Planner',
        status: 'pending_start',
        load: 'low',
        lane: 'backup',
        expectedMinutes: null,
        waitMinutes: null,
        isMain: false,
      },
    ]);
    focusMode.set(true);
    focusScrimOn.set(true);
    fixture.detectChanges();

    component.togglePlannerQuickEdit('focus-planner');
    component.createBackupTaskFromFab();

    expect(component.isPlannerQuickEditOpen('focus-planner')).toBe(true);
    expect(mockEngine.createInDock).toHaveBeenCalledWith('新备选任务', 'backup', 'low');
  });

  it('read-only follower should block planner quick edit and backup FAB actions', () => {
    dockedEntries.set([
      {
        taskId: 'read-only-planner',
        title: 'Read Only Planner',
        status: 'pending_start',
        load: 'low',
        lane: 'backup',
        expectedMinutes: null,
        waitMinutes: null,
        isMain: false,
      },
    ]);
    mockFocusLeader.isReadOnlyFollower.set(true);
    fixture.detectChanges();

    component.togglePlannerQuickEdit('read-only-planner');
    component.createBackupTaskFromFab();

    expect(component.isPlannerQuickEditOpen('read-only-planner')).toBe(false);
    expect(mockEngine.createInDock).not.toHaveBeenCalledWith('新备选任务', 'backup', 'low');
  });

  it('mobile mode should switch planner to sheet presentation and lift the semicircle above the safe area', () => {
    uiState.isMobile.set(true);
    fixture.detectChanges();

    expect(component.plannerPresentation()).toBe('sheet');
    expect(component.dockSemicircleBottomInset()).toBe(component.dockBottomInset);
  });

  it('gate active should block dock expansion and focus session toggle', () => {
    mockGateService.isActive.set(true);
    mockEngine.setDockExpanded.mockClear();
    mockEngine.toggleFocusMode.mockClear();

    component.toggleDockExpanded();
    component.onFocusSessionToggle();

    expect(mockEngine.setDockExpanded).not.toHaveBeenCalled();
    expect(mockEngine.toggleFocusMode).not.toHaveBeenCalled();
  });

  it('HUD settings button should open settings modal anchored to focus routines', async () => {
    focusMode.set(true);
    focusScrimOn.set(true);
    fixture.detectChanges();

    await component.openFocusRoutineSettings();

    expect(mockModalLoader.loadSettingsModal).toHaveBeenCalledTimes(1);
    expect(mockDynamicModal.open).toHaveBeenCalled();
    const [, options] = mockDynamicModal.open.mock.calls[0];
    expect(options.inputs.initialSection).toBe('focus-routines');
  });

  it('follower tab should block focus toggle and allow takeover', () => {
    mockFocusLeader.isReadOnlyFollower.set(true);
    fixture.detectChanges();

    component.onFocusSessionToggle();
    expect(mockEngine.toggleFocusMode).not.toHaveBeenCalled();

    component.takeOverFocusControl();
    expect(mockFocusLeader.tryTakeover).toHaveBeenCalled();
  });

  it('should render pending decision panel when at least one choice is present', () => {
    focusMode.set(true);
    pendingDecision.set({ reason: '候选异常', rootRemainingMinutes: 20 });
    pendingDecisionEntries.set([
      { taskId: 'C', title: 'Candidate C', lane: 'combo-select', load: 'low', expectedMinutes: 60, recommendedScore: 10 },
    ]);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-testid="dock-v3-pending-decision"]')).toBeTruthy();
    expect(fixture.nativeElement.textContent).toContain('收起推荐');

    pendingDecisionEntries.set([
      { taskId: 'C', title: 'Candidate C', lane: 'combo-select', load: 'low', expectedMinutes: 60, recommendedScore: 10 },
      { taskId: 'D', title: 'Candidate D', lane: 'backup', load: 'high', expectedMinutes: 10, recommendedScore: 5 },
    ]);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-testid="dock-v3-pending-decision"]')).toBeTruthy();
  });
  it('transparent focus mode should keep stage mounted and HUD minimal', () => {
    focusMode.set(true);
    focusScrimOn.set(false);
    statusMachineEntries.set([
      {
        taskId: 'A',
        title: 'Focus A',
        uiStatus: 'focusing',
        label: '专注中',
        waitRemainingSeconds: null,
        waitTotalSeconds: null,
      },
    ]);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('[data-testid="dock-v3-focus-stage"]')).toBeTruthy();
    expect(fixture.nativeElement.querySelector('[data-testid="dock-v3-status-machine-container"]')).toBeTruthy();
    expect(fixture.nativeElement.querySelector('[data-testid="dock-v3-status-machine-minimal"]')).toBeTruthy();
  });



  it('blank period should render dedicated card and fragment scene mode', () => {
    focusMode.set(true);
    focusScrimOn.set(true);
    pendingDecision.set({ reason: '窗口过短', rootRemainingMinutes: 5 });
    pendingDecisionEntries.set([]);
    fixture.detectChanges();

    const scene = fixture.nativeElement.querySelector('[data-testid="dock-v3-focus-scene"]');

    expect(component.blankPeriodActive()).toBe(true);
    expect(scene?.getAttribute('data-scene')).toBe('fragment');
    expect(fixture.nativeElement.querySelector('[data-testid="dock-v3-blank-period-card"]')).toBeTruthy();
    expect(fixture.nativeElement.querySelector('[data-testid="dock-v3-pending-decision"]')).toBeNull();
  });

  it('scrim on should render full HUD and scrim off should collapse to minimal HUD', () => {
    focusMode.set(true);
    statusMachineEntries.set([
      {
        taskId: 'A',
        title: 'Focus A',
        uiStatus: 'focusing',
        label: '专注中',
        waitRemainingSeconds: null,
        waitTotalSeconds: null,
      },
      {
        taskId: 'B',
        title: 'Waiting B',
        uiStatus: 'suspended_waiting',
        label: '挂起等待',
        waitRemainingSeconds: 120,
        waitTotalSeconds: 300,
      },
    ]);
    focusScrimOn.set(true);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-testid="dock-v3-status-machine"]')).toBeTruthy();

    focusScrimOn.set(false);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-testid="dock-v3-status-machine-minimal"]')).toBeTruthy();
  });
});
