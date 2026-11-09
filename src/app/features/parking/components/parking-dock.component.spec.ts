import { ComponentFixture, TestBed } from '@angular/core/testing';
import { computed, signal } from '@angular/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ParkingDockComponent } from '../parking-dock.component';
import { DockPlannerQuickEditComponent } from './dock-planner-quick-edit.component';
import { DockConsoleStackComponent } from './dock-console-stack.component';
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
import type { Project } from '../../../../models';
import { KnowledgeAnchorComponent } from '../../../shared/components/knowledge-anchor/knowledge-anchor.component';
import { KnowledgeAnchorStubComponent } from '../../../../tests/stubs/knowledge-anchor.stub';
import {
  registerParkingDockHudSpecs,
  type ParkingDockHudSpecContext,
} from './parking-dock-hud.spec-helpers';
import {
  registerParkingDockDropPlannerSpecs,
  type ParkingDockDropPlannerSpecContext,
} from './parking-dock-drop-planner.spec-helpers';
import {
  registerParkingDockFocusExitSpecs,
  type ParkingDockFocusExitSpecContext,
} from './parking-dock-focus-exit.spec-helpers';

import {
  DockEntry,
  DockPendingDecision,
  DockPendingDecisionEntry,
  StatusMachineEntry,
  DailySlotEntry,
  DockFocusTransitionState,
} from '../../../../models/parking-dock';

type MockDockEntry = Partial<DockEntry>
  & Pick<DockEntry, 'taskId' | 'title' | 'status' | 'load' | 'lane' | 'isMain'>;

type MockPendingDecision = Partial<DockPendingDecision>
  & Pick<DockPendingDecision, 'reason'>;

type MockPendingDecisionEntry = Partial<DockPendingDecisionEntry>
  & Pick<DockPendingDecisionEntry, 'taskId' | 'title' | 'lane' | 'load' | 'expectedMinutes' | 'recommendedScore'>;

describe('ParkingDockComponent v4', () => {
  let fixture: ComponentFixture<ParkingDockComponent>;
  let component: ParkingDockComponent;
  let uiState: UiStateService;

  const dockedEntries = signal<MockDockEntry[]>([]);
  const focusMode = signal(false);
  const focusScrimOn = signal(true);
  const focusTransition = signal<DockFocusTransitionState | null>(null);
  const focusChromeRestoring = signal(false);
  const dockExpanded = signal(true);
  const pendingDecision = signal<MockPendingDecision | null>(null);
  const pendingDecisionEntries = signal<MockPendingDecisionEntry[]>([]);
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
    toggleFocusMode: vi.fn(() => {
      focusMode.update(value => !value);
      return Promise.resolve(true);
    }),
    toggleFocusScrim: vi.fn(() => {
      focusScrimOn.update(value => !value);
      return Promise.resolve(true);
    }),
    setFocusScrim: vi.fn((on: boolean) => focusScrimOn.set(on)),
    beginFocusTransition: vi.fn((state: DockFocusTransitionState) => focusTransition.set(state)),
    endFocusTransition: vi.fn(() => focusTransition.set(null)),
    beginFocusChromeRestore: vi.fn((durationMs: number = PARKING_CONFIG.DOCK_ANIMATION_MS) => {
      focusChromeRestoring.set(true);
      setTimeout(() => focusChromeRestoring.set(false), durationMs);
    }),
    clearFocusChromeRestore: vi.fn(() => focusChromeRestoring.set(false)),
    holdNonCriticalWork: vi.fn(),
    setDockExpanded: vi.fn((expanded: boolean, _options?: { persistPreference?: boolean }) => {
      dockExpanded.set(expanded);
      return Promise.resolve(true);
    }),
    choosePendingDecisionCandidate: vi.fn(),
    cancelPendingDecisionAutoPromote: vi.fn(),
    toggleMuteWaitTone: vi.fn(),
    createInDock: vi.fn((): Promise<string | null> => Promise.resolve('dock-created')),
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

  // 组件模板和依赖较重，共享测试 lane 下 compileComponents 可能超过默认 1s hookTimeout。
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
    })
      .overrideComponent(DockConsoleStackComponent, {
        remove: { imports: [KnowledgeAnchorComponent] },
        add: { imports: [KnowledgeAnchorStubComponent] },
      })
      .compileComponents();

    fixture = TestBed.createComponent(ParkingDockComponent);
    component = fixture.componentInstance;
    uiState = TestBed.inject(UiStateService);
    uiState.isMobile.set(false);
    fixture.detectChanges();
  }, 5000);

  afterEach(() => {
    fixture?.destroy();
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  function getHudSpecContext(): ParkingDockHudSpecContext {
    return {
      fixture,
      component,
      uiState,
      focusMode,
      focusScrimOn,
      statusMachineEntries,
      pendingDecision,
      pendingDecisionEntries,
      mockEngine,
      mockFocusHudWindow,
      mockToast,
    };
  }

  function getDropPlannerSpecContext(): ParkingDockDropPlannerSpecContext {
    return {
      fixture,
      component,
      dockedEntries,
      focusMode,
      focusScrimOn,
      mockEngine,
    };
  }

  function getFocusExitSpecContext(): ParkingDockFocusExitSpecContext {
    return {
      fixture,
      component,
      uiState,
      dockedEntries,
      focusMode,
      focusScrimOn,
      focusTransition,
      statusMachineEntries,
      firstMainSelectionPending,
      mockEngine,
      mockPerformanceTier,
    };
  }

  it('createTask should create in dock with blackbox ownership semantics', async () => {
    component.newTaskTitle = 'New Task';
    component.newTaskDetail = 'Task detail';
    component.newTaskLane = 'backup';
    component.newTaskLoad = 'high';
    component.newTaskExpectedMinutes = '25';
    component.newTaskWaitMinutes = '5';

    await component.createTask();

    expect(mockEngine.createInDock).toHaveBeenCalledWith('New Task', 'backup', 'high', {
      expectedMinutes: 25,
      waitMinutes: 5,
      detail: 'Task detail',
    });
  });

  it('createTask should ignore duplicate triggers while the first create is pending', async () => {
    component.newTaskTitle = 'New Task';
    let resolveCreate: (value: string | null) => void = () => undefined;
    mockEngine.createInDock.mockReturnValueOnce(new Promise<string | null>(resolve => {
      resolveCreate = resolve;
    }));

    const firstCreate = component.createTask();
    await component.createTask();

    expect(mockEngine.createInDock).toHaveBeenCalledTimes(1);

    resolveCreate('dock-created');
    await firstCreate;
    expect(component.inlineDockCreatePending()).toBe(false);
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

  registerParkingDockDropPlannerSpecs(getDropPlannerSpecContext);
  registerParkingDockFocusExitSpecs(getFocusExitSpecContext);
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

  it('gate active should block dock expansion and focus session toggle', async () => {
    mockGateService.isActive.set(true);
    mockEngine.setDockExpanded.mockClear();
    mockEngine.toggleFocusMode.mockClear();

    await component.toggleDockExpanded();
    component.onFocusSessionToggle();

    expect(mockEngine.setDockExpanded).not.toHaveBeenCalled();
    expect(mockEngine.toggleFocusMode).not.toHaveBeenCalled();
  });

  it('collapsing dock should close planner quick edit through the portal-restoring wrapper', async () => {
    dockExpanded.set(true);
    const closePlannerQuickEdit = vi.spyOn(component, 'closePlannerQuickEdit');

    await component.toggleDockExpanded();

    expect(mockEngine.setDockExpanded).toHaveBeenCalledWith(false, { persistPreference: true });
    expect(closePlannerQuickEdit).toHaveBeenCalledWith(false);
  });

  it('expanding dock should not set hover-expanded when persistence fails', async () => {
    dockExpanded.set(false);
    component.dragDrop.semicircleHoverExpanded.set(false);
    mockEngine.setDockExpanded.mockResolvedValueOnce(false);

    await component.toggleDockExpanded();

    expect(mockEngine.setDockExpanded).toHaveBeenCalledWith(true, { persistPreference: true });
    expect(component.dragDrop.semicircleHoverExpanded()).toBe(false);
  });

  it('scrim toggle should not show feedback when persistence fails', async () => {
    focusMode.set(true);
    focusScrimOn.set(false);
    mockEngine.toggleFocusScrim.mockResolvedValueOnce(false);
    const showDockFeedback = vi.spyOn(component.helpFeedback, 'showDockFeedback');

    await component.onScrimToggle();

    expect(mockEngine.toggleFocusScrim).toHaveBeenCalledTimes(1);
    expect(showDockFeedback).not.toHaveBeenCalled();
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

  it('ordinary dock exposes a working Focus entry through the canonical event', () => {
    const listener = vi.fn();
    window.addEventListener('dock-focus-session-toggle', listener);
    fixture.detectChanges();
    const entry = fixture.nativeElement.querySelector('[data-testid="dock-v3-focus-entry"]') as HTMLButtonElement;

    expect(entry).toBeTruthy();
    expect(entry.disabled).toBe(false);
    entry.click();

    expect(listener).toHaveBeenCalledTimes(1);
    window.removeEventListener('dock-focus-session-toggle', listener);
  });

  it('active read-only follower sees the explanation and takeover action', () => {
    focusMode.set(true);
    mockFocusLeader.isReadOnlyFollower.set(true);
    fixture.detectChanges();

    const banner = fixture.nativeElement.querySelector('[data-testid="dock-v3-follower-banner"]');
    const takeover = banner?.querySelector('[data-testid="dock-v3-takeover-button"]') as HTMLButtonElement | null;
    expect(banner?.textContent).toContain('正在跟随另一端的 Focus');
    expect(takeover).toBeTruthy();
    takeover?.click();
    expect(mockFocusLeader.tryTakeover).toHaveBeenCalled();
  });

  it('mobile Text to Flow transition collapses the dock without leaving Focus', async () => {
    uiState.isMobile.set(true);
    uiState.activeView.set('text');
    dockExpanded.set(true);
    fixture.detectChanges();

    uiState.activeView.set('flow');
    fixture.detectChanges();
    await Promise.resolve();

    expect(mockEngine.setDockExpanded).toHaveBeenCalledWith(false, { persistPreference: false });
    expect(dockExpanded()).toBe(false);
    expect(focusMode()).toBe(false);
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

  it('gate active should block pending decision cancel, candidate choice, and Escape cancel', () => {
    focusMode.set(true);
    pendingDecision.set({ reason: '候选异常', rootRemainingMinutes: 20 });
    pendingDecisionEntries.set([
      { taskId: 'C', title: 'Candidate C', lane: 'combo-select', load: 'low', expectedMinutes: 60, recommendedScore: 10 },
    ]);
    mockGateService.isActive.set(true);
    fixture.detectChanges();

    fixture.nativeElement.querySelector('[data-testid="dock-v3-pending-cancel"]')?.click();
    fixture.nativeElement.querySelector('[data-testid="dock-v3-pending-choice-0"]')?.click();
    const escapeEvent = new KeyboardEvent('keydown', { key: 'Escape' });
    component.onKeydown(escapeEvent);

    expect(mockEngine.cancelPendingDecisionAutoPromote).not.toHaveBeenCalled();
    expect(mockEngine.choosePendingDecisionCandidate).not.toHaveBeenCalled();
  });

  it('read-only follower should block pending decision cancel, candidate choice, and Escape cancel', () => {
    focusMode.set(true);
    pendingDecision.set({ reason: '候选异常', rootRemainingMinutes: 20 });
    pendingDecisionEntries.set([
      { taskId: 'C', title: 'Candidate C', lane: 'combo-select', load: 'low', expectedMinutes: 60, recommendedScore: 10 },
    ]);
    mockFocusLeader.isReadOnlyFollower.set(true);
    fixture.detectChanges();

    fixture.nativeElement.querySelector('[data-testid="dock-v3-pending-cancel"]')?.click();
    fixture.nativeElement.querySelector('[data-testid="dock-v3-pending-choice-0"]')?.click();
    const escapeEvent = new KeyboardEvent('keydown', { key: 'Escape' });
    component.onKeydown(escapeEvent);

    expect(mockEngine.cancelPendingDecisionAutoPromote).not.toHaveBeenCalled();
    expect(mockEngine.choosePendingDecisionCandidate).not.toHaveBeenCalled();
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

  registerParkingDockHudSpecs(getHudSpecContext);

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
