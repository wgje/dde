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
import { FocusHudWindowService } from '../../../../services/focus-hud-window.service';
import { ToastService } from '../../../../services/toast.service';
import { ModalLoaderService } from '../../../core/services/modal-loader.service';
import { ProjectStore, TaskStore } from '../../../core/state/stores';
import { PARKING_CONFIG } from '../../../../config/parking.config';
import { UiStateService } from '../../../../services/ui-state.service';
import { resolveDockFocusChromePhase } from '../../../../utils/dock-focus-phase';

import { clampHudPosition } from '../utils/dock-hud-position';

import {
  DockEntry,
  DockPendingDecision,
  DockPendingDecisionEntry,
  StatusMachineEntry,
  DailySlotEntry,
  DockFocusTransitionState,
} from '../../../../models/parking-dock';

describe('ParkingDockComponent v4', () => {
  let fixture: ComponentFixture<ParkingDockComponent>;
  let component: ParkingDockComponent;
  let uiState: UiStateService;

  const dockedEntries = signal<DockEntry[]>([]);
  const focusMode = signal(false);
  const focusScrimOn = signal(true);
  const focusTransition = signal<DockFocusTransitionState | null>(null);
  const focusChromeRestoring = signal(false);
  const dockExpanded = signal(true);
  const pendingDecision = signal<DockPendingDecision | null>(null);
  const pendingDecisionEntries = signal<DockPendingDecisionEntry[]>([]);
  const statusMachineEntries = signal<StatusMachineEntry[]>([]);
  const muteWaitTone = signal(false);
  const suspendedEntries = signal<DockEntry[]>([]);
  const availableDailySlots = signal<DailySlotEntry[]>([]);
  const highlightedIds = signal<Set<string>>(new Set());
  const firstMainSelectionPending = signal<{ taskId: string; expiresAt: number } | null>(null);
  const fragmentEntryCountdown = signal<number | null>(null);
  const lastRadarInsertedTaskId = signal<string | null>(null);
  const lastRadarEvictedTaskId = signal<string | null>(null);
  const lastExitAction = signal<'save_exit' | 'clear_exit' | 'keep_focus_hide_scrim' | null>(null);
  const editLock = signal(false);
  const tick = signal(0);

  const mockEngine = {
    dockedEntries,
    orderedDockEntries: computed(() => dockedEntries()),
    dockedCount: computed(() => dockedEntries().length),
    consoleEntries: computed(() => dockedEntries().filter(entry => entry.isMain && entry.status !== 'completed')),
    consoleVisibleEntries: computed(() => dockedEntries().filter(entry => entry.isMain && entry.status !== 'completed').slice(0, 4)),
    focusingEntry: computed(
      () => dockedEntries().find(entry => entry.status === 'focusing') ?? null,
    ),
    focusMode,
    focusScrimOn,
    focusTransition,
    focusChromePhase: computed(() =>
      resolveDockFocusChromePhase(
        focusMode(),
        focusTransition(),
        focusScrimOn(),
        focusChromeRestoring(),
      ),
    ),
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
    lastExitAction,
    lastRadarInsertedTaskId,
    lastRadarEvictedTaskId,
    pendingRadarEviction: signal<string | null>(null),
    flushRadarEviction: vi.fn(),
    editLock,
    tick,
    isFragmentPhase: signal(false),
    isBurnoutActive: signal(false),
    blankPeriodActive: computed(
      () =>
        fragmentEntryCountdown() === null
        && pendingDecision() !== null
        && pendingDecisionEntries().length === 0,
    ),
    fragmentDefenseLevel: signal(1 as 1 | 2 | 3 | 4),
    burnoutTriggeredAt: signal<number | null>(null),
    lastRecommendationGroups: signal([]),
    highLoadCounter: signal({ count: 0, windowStartAt: 0 }),
    restReminderActive: signal(false),
    cumulativeHighLoadMs: signal(0),
    cumulativeLowLoadMs: signal(0),
    fragmentRest: {
      dismissRestReminder: vi.fn(),
      acceptFragmentEntry: vi.fn(),
      skipFragmentEntry: vi.fn(),
      dismissZenMode: vi.fn(),
    },
    dailySlotService: {
      completeDailySlot: vi.fn(),
      removeDailySlot: vi.fn(),
      addDailySlot: vi.fn(),
    },
    comboSelectEntries: signal([]),
    backupEntries: signal([]),
    toggleFocusMode: vi.fn(() => focusMode.update(value => !value)),
    toggleFocusScrim: vi.fn(() => focusScrimOn.update(value => !value)),
    setFocusScrim: vi.fn((on: boolean) => focusScrimOn.set(on)),
    beginFocusTransition: vi.fn((state: unknown) => focusTransition.set(state)),
    endFocusTransition: vi.fn(() => focusTransition.set(null)),
    beginFocusChromeRestore: vi.fn((durationMs: number = PARKING_CONFIG.DOCK_ANIMATION_MS) => {
      focusChromeRestoring.set(true);
      setTimeout(() => focusChromeRestoring.set(false), durationMs);
    }),
    clearFocusChromeRestore: vi.fn(() => focusChromeRestoring.set(false)),
    holdNonCriticalWork: vi.fn(),
    setDockExpanded: vi.fn((expanded: boolean) => dockExpanded.set(expanded)),
    choosePendingDecisionCandidate: vi.fn(),
    cancelPendingDecisionAutoPromote: vi.fn(),
    toggleMuteWaitTone: vi.fn(),
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
    markExitAction: vi.fn((action: 'save_exit' | 'clear_exit' | 'keep_focus_hide_scrim') => {
      lastExitAction.set(action);
    }),
    clearDockForExit: vi.fn(() => {
      dockedEntries.set([]);
      statusMachineEntries.set([]);
    }),
    finalizeClearDockForExit: vi.fn(),
    getInlineArchiveCandidates: vi.fn(() => []),
    archiveInlineEntriesToActiveProject: vi.fn(() => ({ converted: 0, failed: 0 })),
    reorderDockEntries: vi.fn(),
    toggleLoad: vi.fn(),
    setExpectedTime: vi.fn(),
    setWaitTime: vi.fn(),
    setDetail: vi.fn(),
    acquireDockEditLock: vi.fn(() => editLock.set(true)),
    releaseDockEditLock: vi.fn(() => editLock.set(false)),
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

  const mockFocusHudWindow = {
    isActive: signal(false),
    isSupported: signal(true),
    open: vi.fn().mockResolvedValue(true),
    close: vi.fn().mockResolvedValue(undefined),
  };

  const mockProjectStore = {
    projects: signal<Project[]>([]),
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
    warning: vi.fn(),
  };

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    dockedEntries.set([]);
    focusMode.set(false);
    focusScrimOn.set(true);
    focusTransition.set(null);
    focusChromeRestoring.set(false);
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
    lastExitAction.set(null);
    editLock.set(false);
    tick.set(0);
    mockFocusLeader.isLeader.set(true);
    mockFocusLeader.isFollower.set(false);
    mockFocusLeader.isReadOnlyFollower.set(false);
    mockFocusLeader.tryTakeover.mockClear();
    mockPerformanceTier.tier.set('T0');
    mockGateService.isActive.set(false);
    mockEngine.isFragmentPhase.set(false);
    mockEngine.isBurnoutActive.set(false);
    mockEngine.fragmentDefenseLevel.set(1);
    mockEngine.restReminderActive.set(false);
    mockEngine.cumulativeHighLoadMs.set(0);
    mockEngine.cumulativeLowLoadMs.set(0);
    mockFocusHudWindow.isActive.set(false);
    mockFocusHudWindow.isSupported.set(true);
    mockFocusHudWindow.open.mockClear();
    mockFocusHudWindow.open.mockResolvedValue(true);
    mockFocusHudWindow.close.mockClear();
    mockModalLoader.loadSettingsModal.mockResolvedValue(ParkingDockComponent);
    mockDynamicModal.open.mockClear();
    mockDynamicModal.close.mockClear();
    mockToast.error.mockClear();
    mockToast.warning.mockClear();

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
        { provide: FocusHudWindowService, useValue: mockFocusHudWindow },
        { provide: ToastService, useValue: mockToast },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(ParkingDockComponent);
    component = fixture.componentInstance;
    uiState = TestBed.inject(UiStateService);
    uiState.isMobile.set(false);
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

    expect(component.helpFeedback.showHelpOverlay()).toBe(false);
    expect(fixture.nativeElement.querySelector('[data-testid="dock-v3-help-overlay"]')).toBeNull();
  });

  it('should render full-mode advanced controls and drop-zone by default', () => {
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('[data-testid="dock-v3-create-toggle"]')).toBeTruthy();
    expect(fixture.nativeElement.querySelector('[data-testid="dock-v3-drop-zone"]')).toBeTruthy();
  });

  it('should hide inline create controls while focus scrim is enabled and restore them after scrim is closed', () => {
    fixture.detectChanges();
    component.toggleNewTaskForm();
    fixture.detectChanges();

    expect(component.showNewTaskForm()).toBe(true);
    expect(fixture.nativeElement.querySelector('[data-testid="dock-v3-create-toggle"]')).toBeTruthy();
    expect(fixture.nativeElement.querySelector('.new-task-form')).toBeTruthy();

    focusMode.set(true);
    focusScrimOn.set(true);
    fixture.detectChanges();

    expect(component.showNewTaskForm()).toBe(false);
    expect(fixture.nativeElement.querySelector('[data-testid="dock-v3-create-toggle"]')).toBeNull();
    expect(fixture.nativeElement.querySelector('.new-task-form')).toBeNull();

    focusScrimOn.set(false);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('[data-testid="dock-v3-create-toggle"]')).toBeTruthy();
  });

  it('clampHudPosition should allow HUD to reach any edge with only 12px margin', () => {
    const size = { width: 290, height: 220 };
    const minMargin = 12;

    // 右下角 — 不再有 FAB 避让带
    const bottomRight = clampHudPosition({ x: window.innerWidth, y: window.innerHeight }, size);
    expect(bottomRight.x).toBe(window.innerWidth - size.width - minMargin);
    expect(bottomRight.y).toBe(window.innerHeight - size.height - minMargin);

    // 右上角 — 按钮已内嵌，无避让
    const topRight = clampHudPosition({ x: window.innerWidth, y: 0 }, size);
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
    expect(component.dragDrop.dropState()).toBe('idle');
  });

  it('onDrop should fallback to text/plain and use default backup entrypoint', () => {
    const getData = vi.fn((mime: string) => (mime === 'text/plain' ? 'legacy-task' : ''));

    component.onDrop({
      preventDefault: vi.fn(),
      dataTransfer: { getData } as unknown as DataTransfer,
    } as unknown as DragEvent);

    expect(mockEngine.dockTaskFromExternalDrag).toHaveBeenCalledWith('legacy-task', undefined);
  });

  it('drop-zone drag depth should prevent state jitter when moving over child elements', () => {
    const taskDragTransfer = {
      types: ['application/x-nanoflow-task'],
    } as unknown as DataTransfer;

    component.dragDrop.onDropZoneDragEnter({
      preventDefault: vi.fn(),
      dataTransfer: taskDragTransfer,
    } as unknown as DragEvent);
    component.dragDrop.onDropZoneDragEnter({
      preventDefault: vi.fn(),
      dataTransfer: taskDragTransfer,
    } as unknown as DragEvent);

    component.dragDrop.onDropZoneDragLeave();
    expect(component.dragDrop.dropState()).toBe('isOver');

    component.dragDrop.onDropZoneDragLeave();
    expect(component.dragDrop.dropState()).toBe('canDrop');
  });

  it('drop-zone dragover without task types should not flash reject', () => {
    component.dragDrop.dropState.set('isOver');

    component.dragDrop.onDropZoneDragOver({
      preventDefault: vi.fn(),
      dataTransfer: { types: [] } as unknown as DataTransfer,
    } as unknown as DragEvent);

    expect(component.dragDrop.dropState()).toBe('canDrop');
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

    expect(component.dragDrop.dropState()).toBe('reject');
    expect(mockEngine.dockTaskFromExternalDrag).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(240);
    expect(component.dragDrop.dropState()).toBe('idle');
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
    expect(component.planner.recentlyDockedTaskId()).toBe('task-missing-fields');
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
    expect(panel?.className).toContain('mx-2');
    expect(panel?.className).toContain('border-amber-500/20');
    expect(panel?.className).toContain('animate-[plannerInlineExpand_300ms');
    expect(panel?.getAttribute('data-presentation')).toBe('popover');
    expect(panel?.textContent).toContain('当前负荷');
    expect(panel?.textContent).toContain('预计投入');
  });

  it('secondary rail banner should follow the current focusing task when opening planner quick edit', () => {
    dockedEntries.set([
      {
        taskId: 'focus-prev',
        title: 'Previous Focus',
        status: 'stalled',
        load: 'low',
        lane: 'backup',
        expectedMinutes: 30,
        waitMinutes: null,
        isMain: true,
      },
      {
        taskId: 'focus-current',
        title: 'Current Focus',
        status: 'focusing',
        load: 'high',
        lane: 'combo-select',
        expectedMinutes: null,
        waitMinutes: null,
        isMain: false,
      },
    ]);
    focusMode.set(true);
    focusScrimOn.set(true);
    fixture.detectChanges();

    const bannerToggle = fixture.nativeElement.querySelector(
      '[data-testid="dock-v3-secondary-rail-banner"] [data-testid="dock-v3-planner-toggle"]',
    ) as HTMLButtonElement | null;

    expect(component.planner.bannerTarget()?.taskId).toBe('focus-current');
    expect(fixture.nativeElement.textContent).toContain('Current Focus');

    bannerToggle?.click();
    fixture.detectChanges();

    expect(component.planner.activeEntry()?.taskId).toBe('focus-current');
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

  it('onFocusSessionToggle should start enter transition with flip ghost when dock entries exist', async () => {
    dockedEntries.set([
      {
        taskId: 'focus-source',
        title: 'Focus Source',
        status: 'pending_start',
        load: 'low',
        lane: 'backup',
        expectedMinutes: 25,
        waitMinutes: null,
        isMain: true,
      },
    ]);
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

  it('onFocusSessionToggle should skip the flip ghost when the dock is empty', async () => {
    dockedEntries.set([]);

    component.onFocusSessionToggle();
    fixture.detectChanges();

    expect(mockEngine.beginFocusTransition).toHaveBeenCalled();
    expect(focusTransition()?.phase).toBe('entering');
    expect(fixture.nativeElement.querySelector('[data-testid="dock-v4-flip-ghost"]')).toBeNull();

    await vi.advanceTimersByTimeAsync(PARKING_CONFIG.MOTION.focus.enterMs + 20);
    fixture.detectChanges();
    expect(focusTransition()?.phase).toBe('focused');
  });

  it('should freeze performance tier during focus transition until settled', () => {
    mockPerformanceTier.tier.set('T0');
    component.onFocusSessionToggle();
    fixture.detectChanges();

    expect(component.focusTransitionService.performanceTier()).toBe('T0');

    mockPerformanceTier.tier.set('T2');
    fixture.detectChanges();
    expect(component.focusTransitionService.performanceTier()).toBe('T0');

    component.onFocusTransitionSettled('entering');
    fixture.detectChanges();
    expect(component.focusTransitionService.performanceTier()).toBe('T2');
  });

  it('onFocusSessionToggle should require confirmation before handing off to the exit transition', async () => {
    focusMode.set(true);
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
    ]);
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
    expect(fixture.nativeElement.querySelector('[data-testid="dock-v4-flip-ghost"]')).toBeNull();
    expect(fixture.nativeElement.querySelector('[data-testid="dock-v3-console-card"]')).toBeNull();

    await vi.advanceTimersByTimeAsync(20);
    fixture.detectChanges();
    expect(mockEngine.toggleFocusMode).not.toHaveBeenCalled();
    expect(focusMode()).toBe(true);

    await vi.advanceTimersByTimeAsync(PARKING_CONFIG.MOTION.focus.exitMs + 20);
    fixture.detectChanges();
    expect(mockEngine.toggleFocusMode).toHaveBeenCalledTimes(1);
    expect(focusMode()).toBe(false);
    expect(mockEngine.beginFocusChromeRestore).toHaveBeenCalled();
    expect(mockEngine.endFocusTransition).not.toHaveBeenCalled();
    expect(focusTransition()?.phase).toBe('exiting');
  });

  it('confirmExitFocus clear-exit should keep exit visuals alive after live dock data is cleared', () => {
    focusMode.set(true);
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
    ]);
    statusMachineEntries.set([
      {
        taskId: 'focus-main',
        title: 'Focus Main',
        uiStatus: 'focusing',
        label: '专注中',
        waitRemainingSeconds: null,
        waitTotalSeconds: null,
      },
    ]);
    focusTransition.set({
      phase: 'exiting',
      direction: 'exit',
      fromRect: { left: 10, top: 10, width: 100, height: 100 },
      toRect: { left: 10, top: 500, width: 100, height: 100 },
      durationMs: PARKING_CONFIG.MOTION.focus.exitMs,
      startedAt: new Date().toISOString(),
    });
    fixture.detectChanges();

    component.confirmExitFocus('clear-exit');
    fixture.detectChanges();
    expect(mockEngine.markExitAction).toHaveBeenCalledWith('clear_exit');
    expect(mockEngine.clearDockForExit).toHaveBeenCalledTimes(1);
    expect(dockedEntries()).toHaveLength(0);
    expect(statusMachineEntries()).toHaveLength(0);
    expect(component.exitConsoleEntries()?.[0]?.taskId).toBe('focus-main');
    expect(component.exitStatusMachineEntries()?.[0]?.taskId).toBe('focus-main');
  });

  it('keep-focus-hide-scrim should not trigger archive conversion', () => {
    focusMode.set(true);

    component.confirmExitFocus('keep-focus-hide-scrim');

    expect(mockEngine.archiveInlineEntriesToActiveProject).not.toHaveBeenCalled();
    expect(mockEngine.setFocusScrim).toHaveBeenCalledWith(false);
    expect(mockEngine.beginFocusChromeRestore).toHaveBeenCalledWith(PARKING_CONFIG.MOTION.shell.enterMs);
  });
  it('Alt+H should render the help overlay when focus mode is active', () => {
    focusMode.set(true);
    focusScrimOn.set(true);
    fixture.detectChanges();

    component.onKeydown(new KeyboardEvent('keydown', { key: 'h', altKey: true }));
    fixture.detectChanges();

    expect(component.helpFeedback.showHelpOverlay()).toBe(true);
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
    expect(component.helpFeedback.dockActionFeedback()?.message).toContain('已切换到前台');
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

  it('clicking the dock main card should bring it back to C position when another task is in front', () => {
    dockedEntries.set([
      {
        taskId: 'focus-main',
        title: 'Focus Main',
        status: 'stalled',
        load: 'low',
        lane: 'backup',
        expectedMinutes: 25,
        waitMinutes: null,
        isMain: true,
      },
      {
        taskId: 'focus-secondary',
        title: 'Focus Secondary',
        status: 'focusing',
        load: 'low',
        lane: 'combo-select',
        expectedMinutes: 15,
        waitMinutes: null,
        isMain: false,
      },
    ]);
    focusMode.set(true);
    focusScrimOn.set(true);

    component.onDockCardClick('focus-main');

    expect(mockEngine.setMainTask).toHaveBeenCalledWith('focus-main');
    expect(component.helpFeedback.dockActionFeedback()?.message).toContain('已切换到前台');
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
    const mainLabelMatches = text.match(/主任务/g) ?? [];

    expect(text).toContain('主任务');
    expect(mainLabelMatches).toHaveLength(1);
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

  it('mobile hud minimal mode should sit lower in the top-center area for better visual balance', () => {
    uiState.isMobile.set(true);
    focusMode.set(true);
    focusScrimOn.set(false);

    const style = component.hudContainerStyle();

    expect(style.top).toBe(`calc(env(safe-area-inset-top) + ${PARKING_CONFIG.HUD_MINIMAL_MOBILE_TOP_PX}px)`);
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

  it('focus takeover should raise the dock host above workspace chrome', () => {
    focusMode.set(true);
    focusScrimOn.set(true);
    fixture.detectChanges();

    expect(component.focusHostZIndex()).toBe('60');
    expect((fixture.nativeElement as HTMLElement).style.zIndex).toBe('60');

    focusMode.set(false);
    fixture.detectChanges();
    expect(component.focusHostZIndex()).toBeNull();
  });

  it('sidebar offset should stay anchored to the content area during focus takeover and save-exit recovery', () => {
    uiState.isMobile.set(false);
    uiState.sidebarOpen.set(true);
    uiState.sidebarWidth.set(320);

    expect(component.sidebarEffectiveWidth()).toBe(320);

    focusMode.set(true);
    focusScrimOn.set(true);
    fixture.detectChanges();

    expect(component.sidebarEffectiveWidth()).toBe(320);
    expect(component.dockCenterLeft()).toBe('calc(50% + 160px)');

    focusMode.set(false);
    focusTransition.set({ phase: 'exiting' });
    fixture.detectChanges();

    expect(component.sidebarEffectiveWidth()).toBe(320);
    expect(component.dockCenterLeft()).toBe('calc(50% + 160px)');
  });

  it('should render fragment countdown overlay and wire accept/skip actions', () => {
    focusMode.set(true);
    fragmentEntryCountdown.set(8);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('[data-testid="fragment-countdown-number"]')?.textContent).toContain('8s');

    fixture.nativeElement.querySelector('[data-testid="fragment-countdown-skip"]')?.click();
    expect(mockEngine.fragmentRest.skipFragmentEntry).toHaveBeenCalledTimes(1);

    fixture.nativeElement.querySelector('[data-testid="fragment-countdown-accept"]')?.click();
    expect(mockEngine.fragmentRest.acceptFragmentEntry).toHaveBeenCalledTimes(1);
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

    expect(component.planner.presentation()).toBe('sheet');
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

  it('entering focus should delay floating HUD and backup FAB until transition service releases them', () => {
    focusMode.set(true);
    focusScrimOn.set(true);
    focusTransition.set({
      phase: 'entering',
      direction: 'enter',
      fromRect: { left: 10, top: 500, width: 120, height: 72 },
      toRect: { left: 200, top: 180, width: 320, height: 220 },
      durationMs: PARKING_CONFIG.MOTION.focus.enterMs,
      startedAt: new Date().toISOString(),
    });
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
    (component.focusTransitionService as unknown as {
      floatingUiVisible: { set: (value: boolean) => void };
    }).floatingUiVisible.set(false);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('[data-testid="dock-v3-backup-fab"]')).toBeNull();
    expect(fixture.nativeElement.querySelector('[data-testid="dock-v3-status-machine-container"]')).toBeNull();

    (component.focusTransitionService as unknown as {
      floatingUiVisible: { set: (value: boolean) => void };
    }).floatingUiVisible.set(true);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('[data-testid="dock-v3-backup-fab"]')).toBeTruthy();
    expect(fixture.nativeElement.querySelector('[data-testid="dock-v3-status-machine-container"]')).toBeTruthy();
  });

  it('mobile minimal HUD should enable pass-through styling for drawer gestures', () => {
    uiState.isMobile.set(true);
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

    const container = fixture.nativeElement.querySelector('[data-testid="dock-v3-status-machine-container"]') as HTMLElement | null;
    const minimal = fixture.nativeElement.querySelector('[data-testid="dock-v3-status-machine-minimal"]') as HTMLElement | null;

    expect(component.hudMinimalPassThrough()).toBe(true);
    expect(container?.classList.contains('pointer-events-none')).toBe(true);
    expect(container?.getAttribute('data-pass-through')).toBe('true');
    expect(minimal?.getAttribute('data-pass-through')).toBe('true');
  });

  it('mobile minimal HUD should keep explicit action buttons clickable in pass-through mode', () => {
    uiState.isMobile.set(true);
    focusMode.set(true);
    focusScrimOn.set(false);
    mockEngine.restReminderActive.set(true);
    mockEngine.cumulativeHighLoadMs.set(25 * 60 * 1000);
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

    const button = fixture.nativeElement.querySelector(
      '[data-testid="dock-v3-status-machine-minimal"] [data-status-interactive="true"]',
    ) as HTMLButtonElement | null;

    expect(button).toBeTruthy();

    button?.click();

    expect(mockEngine.fragmentRest.dismissRestReminder).toHaveBeenCalledTimes(1);
  });

  it('active PiP HUD should collapse the in-page HUD to minimal mode even with scrim on', () => {
    focusMode.set(true);
    focusScrimOn.set(true);
    mockFocusHudWindow.isActive.set(true);
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

    expect(component.hudMinimalMode()).toBe(true);
    expect(fixture.nativeElement.querySelector('[data-testid="dock-v3-status-machine-minimal"]')).toBeTruthy();
  });

  it('PiP HUD toggle should open the PiP window on desktop focus mode', async () => {
    focusMode.set(true);
    focusScrimOn.set(true);
    mockFocusHudWindow.isSupported.set(true);
    fixture.detectChanges();

    await component.togglePipHud();

    expect(mockFocusHudWindow.open).toHaveBeenCalledTimes(1);
    expect(mockFocusHudWindow.close).not.toHaveBeenCalled();
  });

  it('PiP HUD toggle should close the PiP window when it is already active', async () => {
    focusMode.set(true);
    focusScrimOn.set(true);
    mockFocusHudWindow.isSupported.set(true);
    mockFocusHudWindow.isActive.set(true);
    fixture.detectChanges();

    await component.togglePipHud();

    expect(mockFocusHudWindow.close).toHaveBeenCalledTimes(1);
    expect(mockFocusHudWindow.open).not.toHaveBeenCalled();
  });

  it('PiP HUD open failure should warn the user instead of failing silently', async () => {
    focusMode.set(true);
    focusScrimOn.set(true);
    mockFocusHudWindow.isSupported.set(true);
    mockFocusHudWindow.open.mockResolvedValue(false);
    fixture.detectChanges();

    await component.togglePipHud();

    expect(mockToast.warning).toHaveBeenCalledWith(
      '打开悬浮窗失败',
      '当前环境未能创建悬浮窗，请先留在主窗口继续处理。',
    );
  });

  it('HUD drag handler should ignore header action buttons so the PiP toggle remains clickable', () => {
    focusMode.set(true);
    focusScrimOn.set(true);
    mockFocusHudWindow.isSupported.set(true);
    fixture.detectChanges();

    const shell = fixture.nativeElement.querySelector('.status-machine-shell') as HTMLElement | null;
    const pipButton = fixture.nativeElement.querySelector('[data-testid="dock-v3-status-pip-toggle"]') as HTMLButtonElement | null;
    const preventDefault = vi.fn();

    component.onHudPointerDown({
      button: 0,
      clientX: 48,
      clientY: 48,
      currentTarget: shell,
      target: pipButton,
      pointerId: 1,
      preventDefault,
    } as unknown as PointerEvent);

    expect(component.hudDragging()).toBe(false);
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it('should render the PiP toggle inside the status HUD header instead of an external floating button', () => {
    focusMode.set(true);
    focusScrimOn.set(true);
    mockFocusHudWindow.isSupported.set(true);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('[data-testid="dock-v3-status-pip-toggle"]')).toBeTruthy();
    expect(fixture.nativeElement.querySelector('[data-testid="dock-v3-status-machine-pip-toggle"]')).toBeNull();
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
