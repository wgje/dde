import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  HostListener,
  OnDestroy,
  computed,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { NgClass, NgStyle } from '@angular/common';
import { DockEngineService } from '../../../services/dock-engine.service';
import { DynamicModalService } from '../../../services/dynamic-modal.service';
import { FocusDockLeaderService } from '../../../services/focus-dock-leader.service';
import { GateService } from '../../../services/gate.service';
import { FocusHudWindowService } from '../../../services/focus-hud-window.service';
import { ToastService } from '../../../services/toast.service';
import { ModalLoaderService } from '../../core/services/modal-loader.service';
import { ProjectStore, TaskStore } from '../../core/state/stores';
import { UiStateService } from '../../../services/ui-state.service';
import { PARKING_CONFIG } from '../../../config/parking.config';
import {
  DOCK_TOAST,
  DOCK_GROUP_LABELS,
  DOCK_GROUP_FALLBACK_LABEL,
  DOCK_DEFAULT_TASK_TITLE,
} from '../../../config/dock-i18n.config';
import {
  CognitiveLoad,
  DockExitAction,
  DockLane,
  DockFocusTransitionPhase,
  DockPendingDecisionEntry,
  StatusMachineEntry,
  type RecommendationGroupType,
} from '../../../models/parking-dock';
import { hasTaskDragTypes } from '../../../utils/task-drag-payload';
import { DockConsoleStackComponent } from './components/dock-console-stack.component';
import { DockRadarZoneComponent } from './components/dock-radar-zone.component';
import { DockStatusMachineComponent } from './components/dock-status-machine.component';
import { DockDailySlotComponent } from './components/dock-daily-slot.component';
import { DockZenModeComponent } from './components/dock-zen-mode.component';
import { DockFocusSceneComponent, type DockFocusSceneMode } from './components/dock-focus-scene.component';
import { DockInlineTaskFormComponent } from './components/dock-inline-task-form.component';
import { DockPlannerQuickEditPanelComponent } from './components/dock-planner-quick-edit-panel.component';
import { DockPlannerQuickEditService } from './services/dock-planner-quick-edit.service';
import { DockHelpFeedbackService } from './services/dock-help-feedback.service';
import { DockDragDropService } from './services/dock-drag-drop.service';
import { DockFocusTransitionService } from './services/dock-focus-transition.service';
import { trapDialogFocus } from './utils/dock-focus-trap';
import { formatDockMinutes } from './utils/dock-format';
import { buildInlineDockTaskDraft, clearInlineDockTaskForm, shouldClearInlineDockTaskForm } from './utils/dock-task-form';
import {
  resolveDockFocusUiPhase,
  type DockFocusUiPhase,
} from '../../../utils/dock-focus-phase';
import * as DockFocusUi from './utils/dock-focus-ui';
import { ParkingDockHudDragController } from './parking-dock-hud-drag.controller';
import { ParkingDockPlannerPanelPortalController } from './parking-dock-planner-panel-portal.controller';
import { ParkingDockTransientSurfaceController } from './parking-dock-transient-surface.controller';

type FocusExitConfirmAction =
  | 'save-exit'
  | 'clear-exit'
  | 'keep-focus-hide-scrim'
  | 'cancel'
  | 'request-end-focus'
  | 'back';

@Component({
  selector: 'app-parking-dock',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '[style.z-index]': 'focusHostZIndex()',
  },
  imports: [
    NgClass,
    NgStyle,
    DockConsoleStackComponent,
    DockRadarZoneComponent,
    DockStatusMachineComponent,
    DockDailySlotComponent,
    DockZenModeComponent,
    DockFocusSceneComponent,
    DockInlineTaskFormComponent,
    DockPlannerQuickEditPanelComponent,
  ],
  providers: [DockPlannerQuickEditService, DockHelpFeedbackService, DockDragDropService, DockFocusTransitionService],
  styleUrl: './parking-dock.component.scss',
  templateUrl: './parking-dock.component.html',
})
export class ParkingDockComponent implements OnDestroy {
  private readonly hostElement = inject(ElementRef<HTMLElement>);
  readonly engine = inject(DockEngineService);
  private readonly focusLeader = inject(FocusDockLeaderService);
  private readonly gateService = inject(GateService);
  private readonly modalLoader = inject(ModalLoaderService);
  private readonly dynamicModal = inject(DynamicModalService);
  readonly focusHudWindow = inject(FocusHudWindowService);
  private readonly projectStore = inject(ProjectStore);
  private readonly taskStore = inject(TaskStore);
  private readonly toast = inject(ToastService);
  private readonly uiState = inject(UiStateService);
  readonly planner = inject(DockPlannerQuickEditService);
  readonly helpFeedback = inject(DockHelpFeedbackService);
  readonly dragDrop = inject(DockDragDropService);
  readonly focusTransitionService = inject(DockFocusTransitionService);
  readonly PARKING_CONFIG = PARKING_CONFIG;

  /** 停泊坞和半圆入口的水平中心点：桌面端有侧边栏时向右偏移半个侧边栏宽度 */
  readonly sidebarEffectiveWidth = computed(() => DockFocusUi.resolveSidebarEffectiveWidth({
    mobile: this.uiState.isMobile(),
    sidebarOpen: this.uiState.sidebarOpen(),
    sidebarWidth: this.uiState.sidebarWidth(),
  }));
  readonly dockCenterLeft = computed(() => DockFocusUi.resolveDockCenterLeft(this.sidebarEffectiveWidth()));

  /** 移动端流程图视图时隐藏半圆按钮，避免遮挡底部功能按键 */
  readonly hideSemicircleOnMobileFlow = computed(() => DockFocusUi.shouldHideSemicircleOnMobileFlow({
    mobile: this.uiState.isMobile(),
    activeView: this.uiState.activeView(),
  }));

  readonly showNewTaskForm = signal(false);
  readonly inlineDockCreatePending = signal(false);
  readonly focusHostZIndex = computed<string | null>(() => {
    if (this.engine.focusMode() || this.engine.focusTransition() !== null || this.focusTransitionService.flipGhost() !== null) {
      return '60';
    }
    return null;
  });
  readonly focusSessionPhase = computed<DockFocusUiPhase>(() =>
    resolveDockFocusUiPhase(this.engine.focusMode(), this.engine.focusTransition()),
  );
  readonly focusSessionMounted = computed(() => DockFocusUi.isFocusSessionMounted(this.focusSessionPhase()));
  readonly focusSessionInteractive = computed(() => DockFocusUi.isFocusSessionInteractive(this.focusSessionPhase()));
  readonly focusSceneTransitionPhase = computed<DockFocusTransitionPhase | null>(() =>
    DockFocusUi.resolveFocusSceneTransitionPhase(this.focusSessionPhase()),
  );
  readonly focusConsoleStageMounted = computed(() => DockFocusUi.shouldMountFocusConsoleStage({
    focusSessionMounted: this.focusSessionMounted(),
    focusSessionPhase: this.focusSessionPhase(),
  }));
  readonly focusFloatingUiMounted = computed(() => DockFocusUi.shouldMountFocusFloatingUi({
    focusSessionPhase: this.focusSessionPhase(),
    floatingUiVisible: this.focusTransitionService.floatingUiVisible(),
  }));
  readonly exitVisualSnapshot = computed(() => this.focusTransitionService.exitVisualSnapshot());
  readonly exitConsoleEntries = computed(() =>
    this.focusSessionPhase() === 'exiting'
      ? (this.exitVisualSnapshot()?.consoleEntries ?? null)
      : null,
  );
  readonly exitStatusMachineEntries = computed<StatusMachineEntry[] | null>(() =>
    this.focusSessionPhase() === 'exiting'
      ? (this.exitVisualSnapshot()?.statusMachineEntries ?? null)
      : null,
  );
  readonly dockExpanded = this.engine.dockExpanded;
  readonly semicircleExpanded = computed(() => this.dockExpanded() || this.dragDrop.semicircleHoverExpanded());
  readonly takeoverBannerVisible = computed(
    () => this.focusSessionMounted() && this.focusLeader.isReadOnlyFollower(),
  );
  readonly gateActive = computed(() => this.gateService.isActive());
  readonly canMutateDock = computed(() => !this.gateActive() && !this.focusLeader.isReadOnlyFollower());
  readonly canUseInlineDockCreate = computed(() => DockFocusUi.canUseInlineDockCreate({
    canMutateDock: this.canMutateDock(),
    focusSessionMounted: this.focusSessionMounted(),
    focusScrimOn: this.engine.focusScrimOn(),
  }));
  readonly showInlineDockCreate = computed(() => DockFocusUi.shouldShowInlineDockCreate({
    focusSessionMounted: this.focusSessionMounted(),
    focusScrimOn: this.engine.focusScrimOn(),
  }));
  readonly canCreateBackupTask = computed(() => this.canMutateDock());
  readonly canUsePlannerQuickEdit = computed(() => this.canMutateDock());
  readonly canReorderDockCards = computed(() => this.dragDrop.canReorderDockCards());
  readonly canAcceptExternalDrop = computed(() => this.dragDrop.canAcceptExternalDrop());
  readonly canToggleScrim = computed(() => DockFocusUi.canToggleFocusScrim({
    focusSessionInteractive: this.focusSessionInteractive(),
    canMutateDock: this.canMutateDock(),
  }));
  readonly dockSecondaryRailActive = computed(() => DockFocusUi.resolveDockSecondaryRailActive({
    focusSessionMounted: this.focusSessionMounted(),
    focusScrimOn: this.engine.focusScrimOn(),
  }));
  readonly focusMotionProfile = PARKING_CONFIG.FOCUS_MOTION_PROFILE;
  readonly motion = PARKING_CONFIG.MOTION;
  readonly reducedMotion = signal(this.focusTransitionService.prefersReducedMotion());
  readonly strictSampleMode = PARKING_CONFIG.DOCK_V3_STRICT_SAMPLE_UI;
  readonly showAdvancedUi = PARKING_CONFIG.DOCK_V3_SHOW_ADVANCED_UI;
  readonly blankPeriodActive = computed(() => this.engine.blankPeriodActive());
  readonly focusSceneMode = computed<DockFocusSceneMode>(() => DockFocusUi.resolveDockFocusSceneMode({
    focusSessionMounted: this.focusSessionMounted(),
    fragmentDefenseLevel: this.engine.fragmentDefenseLevel(),
    burnoutActive: this.engine.isBurnoutActive(),
    fragmentPhase: this.engine.isFragmentPhase(),
    blankPeriodActive: this.blankPeriodActive(),
    pendingDecisionActive: this.engine.pendingDecision() !== null,
  }));
  readonly showZenMode = computed(() => DockFocusUi.shouldShowZenMode({
    focusSessionMounted: this.focusSessionMounted(),
    fragmentDefenseLevel: this.engine.fragmentDefenseLevel(),
  }));
  readonly firstMainSelectionPending = computed(() => this.engine.firstMainSelectionPending());
  readonly hudMinimalMode = computed(() => DockFocusUi.resolveHudMinimalMode({
    focusSessionPhase: this.focusSessionPhase(),
    focusScrimOn: this.engine.focusScrimOn(),
    externalHudActive: this.focusHudWindow.isActive(),
  }));
  readonly hudMinimalPassThrough = computed(() => DockFocusUi.shouldPassThroughMinimalHud({
    mobile: this.uiState.isMobile(),
    minimalMode: this.hudMinimalMode(),
  }));
  readonly canOpenPipHud = computed(() => DockFocusUi.canOpenFloatingHudWindow({
    focusSessionPhase: this.focusSessionPhase(),
    mobile: this.uiState.isMobile(),
    supported: this.focusHudWindow.isSupported(),
  }));
  readonly focusStageTransform = computed(() =>
    DockFocusUi.resolveFocusStageTransform(this.uiState.isMobile(), this.dockExpanded()),
  );
  private readonly hudDrag = new ParkingDockHudDragController({
    minimalMode: this.hudMinimalMode,
    mobile: this.uiState.isMobile,
  });
  readonly hudSize = this.hudDrag.hudSize;
  readonly hudPosition = this.hudDrag.hudPosition;
  readonly hudDragging = this.hudDrag.hudDragging;
  readonly hudContainerStyle = this.hudDrag.hudContainerStyle;

  newTaskTitle = '';
  newTaskLane: DockLane = 'backup';
  newTaskLoad: CognitiveLoad = 'low';
  newTaskExpectedMinutes: string | number = '';
  newTaskWaitMinutes: string | number = '';
  newTaskDetail = '';

  readonly dockMaxWidth = PARKING_CONFIG.DOCK_EXPANDED_MAX_WIDTH;
  readonly focusContentEffect = PARKING_CONFIG.DOCK_FOCUS_CONTENT_EFFECT;
  readonly focusBackgroundUrl = PARKING_CONFIG.DOCK_FOCUS_BG_IMAGE_URL;
  readonly dockBottomInset =
    `calc(${PARKING_CONFIG.DOCK_BOTTOM_OFFSET_PX}px + env(safe-area-inset-bottom))`;
  readonly dockSemicircleBottomInset = computed(() =>
    this.uiState.isMobile() ? this.dockBottomInset : 'env(safe-area-inset-bottom)',
  );
  private readonly plannerPanel = viewChild(DockPlannerQuickEditPanelComponent);
  private readonly plannerPanelPortal = new ParkingDockPlannerPanelPortalController(() => this.plannerPanel()?.panelElement());
  private readonly consoleStack = viewChild(DockConsoleStackComponent);
  private readonly transientSurface = new ParkingDockTransientSurfaceController({
    plannerQuickEditTaskId: () => this.planner.plannerQuickEditTaskId(),
    closePlannerQuickEdit: () => this.closePlannerQuickEdit(),
    waitPresetTaskId: () => this.consoleStack()?.waitPresetTaskId() ?? null,
    showHelpOverlay: () => this.helpFeedback.showHelpOverlay(),
    closeHelpOverlay: () => this.helpFeedback.closeHelpOverlay(),
  });
  readonly showExitConfirm = this.transientSurface.showExitConfirm;
  readonly exitFlowStep = this.transientSurface.exitFlowStep;

  constructor() {
    effect(() => {
      const activeEntry = this.planner.activeEntry();
      const presentation = this.planner.presentation();
      if (!activeEntry) {
        this.plannerPanelPortal.restore();
        return;
      }

      this.plannerPanelPortal.scheduleOpen(presentation);
    });

    effect(() => {
      this.planner.closeIfEntryGone();
    });

    effect(() => {
      if (this.showInlineDockCreate()) return;
      if (!this.showNewTaskForm()) return;
      this.showNewTaskForm.set(false);
    });

    effect(() => {
      if (this.engine.focusMode()) return;
      if (!this.focusHudWindow.isActive()) return;
      void this.focusHudWindow.close();
    });
  }

  @HostListener('document:keydown', ['$event'])
  onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Tab' && this.planner.backdropVisible()) {
      trapDialogFocus(event, '[data-testid="dock-v3-planner-panel"]');
      return;
    }

    if (event.key === 'Tab' && this.showExitConfirm()) {
      trapDialogFocus(event, '[data-testid="dock-v3-exit-confirm"]');
      return;
    }

    if (this.isEditableKeyTarget(event.target)) return;

    // 抑制重复按键事件（按住键时操作系统会持续触发 keydown）。
    // Tab 焦点陷阱不受影响，因为 Tab 的处理在此行之前已提前 return。
    if (event.repeat) return;

    if (event.key === 'Escape') {
      this.handleEscapeKey(event);
      return;
    }

    this.handleShortcutKey(event);
  }

  @HostListener('document:pointerdown', ['$event'])
  onDocumentPointerDown(event: PointerEvent): void {
    if (this.planner.presentation() !== 'popover' || !this.planner.activeEntry()) return;

    const target = event.target;
    if (!(target instanceof Element)) return;

    if (target.closest('[data-testid="dock-v3-planner-panel"]')) return;
    if (target.closest('[data-testid="dock-v3-planner-toggle"]')) return;

    this.closePlannerQuickEdit(false);
  }

  /** Escape 键分级处理：先关闭当前临时表面，再处理虚化与退出。 */
  private handleEscapeKey(event: KeyboardEvent): void {
    if (this.transientSurface.closeFirst()) {
      event.preventDefault();
      return;
    }
    if (this.showZenMode()) {
      event.preventDefault();
      this.onZenExit();
      return;
    }
    if (this.engine.pendingDecision()) {
      if (this.pendingDecisionActionsBlocked()) return;
      event.preventDefault();
      this.cancelPendingDecisionAutoPromote();
      return;
    }
    if (this.engine.focusMode() && this.engine.focusScrimOn()) {
      event.preventDefault();
      void this.engine.setFocusScrim(false);
      this.helpFeedback.showRestoreHintToast();
      return;
    }
    // 遮罩已关闭时再按 Escape，弹出退出确认对话框
    if (this.engine.focusMode() && !this.engine.focusScrimOn()) {
      event.preventDefault();
      this.onFocusSessionToggle();
    }
  }

  /** Alt+Shift 快捷键分发 */
  private handleShortcutKey(event: KeyboardEvent): void {
    const key = typeof event.key === 'string' ? event.key.toLowerCase() : '';
    if (!key) return;

    if (event.altKey && event.shiftKey) {
      if (key === 'l') { event.preventDefault(); this.onFocusSessionToggle(); return; }
      if (key === 'f') { if (!this.engine.focusMode()) return; event.preventDefault(); this.onScrimToggle(); return; }
      if (key === 'd') { event.preventDefault(); this.toggleDockExpanded(); return; }
    }
    if (event.altKey && !event.shiftKey && key === 'h') {
      event.preventDefault();
      this.helpFeedback.toggleHelpOverlay();
    }
  }

  private isEditableKeyTarget(target: EventTarget | null): boolean {
    if (!(target instanceof Element)) {
      return false;
    }

    return target.closest('input, textarea, select, [contenteditable="true"]') !== null;
  }

  @HostListener('window:dock-focus-session-toggle')
  onExternalFocusSessionToggle(): void {
    if (this.gateActive()) return;
    this.onFocusSessionToggle();
  }

  @HostListener('window:pointermove', ['$event'])
  onHudPointerMove(event: PointerEvent): void {
    this.hudDrag.onPointerMove(event);
  }

  @HostListener('window:pointerup', ['$event'])
  @HostListener('window:pointercancel', ['$event'])
  onHudPointerUp(event: PointerEvent): void {
    this.hudDrag.onPointerUp(event);
  }

  ngOnDestroy(): void {
    this.plannerPanelPortal.destroy();
    this.transientSurface.destroy();
    this.hudDrag.persist();
    this.focusTransitionService.transitionPerformanceTierLock.set(null);
    this.engine.endFocusTransition();
    void this.focusHudWindow.close();
  }

  async togglePipHud(): Promise<void> {
    if (!this.canOpenPipHud()) return;
    if (this.focusHudWindow.isActive()) {
      await this.focusHudWindow.close();
      return;
    }
    const opened = await this.focusHudWindow.open();
    if (!opened) {
      this.toast.warning(DOCK_TOAST.PIP_OPEN_FAIL_TITLE, DOCK_TOAST.PIP_OPEN_FAIL_BODY);
    }
  }

  toggleNewTaskForm(): void {
    if (!this.showAdvancedUi) return;
    if (!this.canUseInlineDockCreate()) return;
    this.showNewTaskForm.update(value => !value);
  }

  async toggleDockExpanded(): Promise<void> {
    if (this.gateActive()) return;
    const next = !this.engine.dockExpanded();
    const persisted = await this.engine.setDockExpanded(next, { persistPreference: true });
    if (!persisted) return;
    if (next) {
      this.dragDrop.semicircleHoverExpanded.set(true);
      this.dragDrop.cancelAutoCollapse();
      return;
    }
    this.closePlannerQuickEdit(false);
    this.dragDrop.scheduleSemicircleAutoCollapse();
  }

  onSemicircleMouseEnter(): void {
    if (this.gateActive()) return;
    this.dragDrop.semicircleHoverExpanded.set(true);
    this.dragDrop.cancelAutoCollapse();
  }

  onSemicircleMouseLeave(): void {
    if (this.gateActive()) return;
    this.dragDrop.scheduleSemicircleAutoCollapse();
  }

  /**
   * 半圆入口拖拽悬停处理 — 拖拽任务悬停在半圆上时自动展开停泊坞，
   * 使坞栏 drop-zone 可见，用户可继续将任务拖入。
   */
  onSemicircleDragOver(event: DragEvent): void {
    if (!this.canAcceptExternalDrop()) return;
    if (!hasTaskDragTypes(event.dataTransfer)) return;
    event.preventDefault();
    if (this.dragDrop.dropState() !== 'reject') {
      this.dragDrop.dropState.set('canDrop');
    }
    if (!this.dockExpanded()) {
      this.dragDrop.scheduleSemicircleDragExpand();
    }
  }

  onSemicircleDragLeave(): void {
    if (this.dragDrop.dropState() !== 'reject') {
      this.dragDrop.dropState.set('idle');
    }
  }

  onHudPointerDown(event: PointerEvent): void {
    this.hudDrag.onPointerDown(event);
  }

  onBackdropClick(): void {
    if (!this.engine.focusMode()) return;
    this.transientSurface.closeFirst();
  }

  onFocusTransitionSettled(phase: DockFocusTransitionPhase): void {
    const transition = this.engine.focusTransition();
    if (!transition) return;
    if (phase === 'entering' && transition.phase === 'entering') {
      this.focusTransitionService.finalizeEnterFocusTransition(transition);
      return;
    }
    if (phase === 'exiting' && transition.phase === 'exiting') {
      this.focusTransitionService.finalizeExitFocusTransition();
    }
  }

  onFocusSessionToggle(): void {
    if (this.gateActive()) return;
    if (this.focusLeader.isReadOnlyFollower()) return;
    const transition = this.engine.focusTransition();
    if (transition?.phase === 'entering' || transition?.phase === 'exiting') return;

    if (this.engine.focusMode()) {
      this.transientSurface.openExitConfirm();
      return;
    }

    if (this.focusTransitionService.prefersReducedMotion()) {
      if (this.engine.dockExpanded()) {
        void this.engine.setDockExpanded(false, { persistPreference: false });
        this.dragDrop.scheduleSemicircleAutoCollapse();
      }
      this.focusTransitionService.clearExitVisualSnapshot();
      this.engine.endFocusTransition();
      void this.engine.toggleFocusMode();
      this.helpFeedback.showFocusHelpNudgeOnce();
      return;
    }
    this.helpFeedback.showFocusHelpNudgeOnce();
    this.focusTransitionService.runEnterFocusTransition();
    // 先捕获 enter 几何，再让停泊坞下沉，避免源卡片首帧抖动。
    if (this.engine.dockExpanded()) {
      void this.engine.setDockExpanded(false, { persistPreference: false });
      this.dragDrop.scheduleSemicircleAutoCollapse();
    }
  }

  confirmExitFocus(action: FocusExitConfirmAction): void {
    if (action === 'cancel') {
      this.transientSurface.resetExitFlow();
      return;
    }

    if (action === 'back') {
      this.exitFlowStep.set('primary');
      this.transientSurface.focusExitConfirmPrimaryAction();
      return;
    }

    if (action === 'request-end-focus') {
      this.exitFlowStep.set('destructive');
      this.transientSurface.focusExitConfirmPrimaryAction();
      return;
    }

    if (action === 'keep-focus-hide-scrim') {
      this.engine.markExitAction('keep_focus_hide_scrim');
      void this.engine.setFocusScrim(false);
      this.engine.beginFocusChromeRestore(this.motion.shell.enterMs);
      this.transientSurface.resetExitFlow();
      this.helpFeedback.showRestoreHintToast();
      return;
    }

    const exitAction: DockExitAction = action === 'clear-exit' ? 'clear_exit' : 'save_exit';
    this.engine.markExitAction(exitAction);
    this.transientSurface.resetExitFlow();
    if (exitAction === 'clear_exit') {
      this.captureExitVisualSnapshot();
      void this.engine.clearDockForExit();
    } else {
      this.focusTransitionService.clearExitVisualSnapshot();
    }
    if (this.focusTransitionService.prefersReducedMotion()) {
      if (exitAction === 'clear_exit') {
        void this.engine.finalizeClearDockForExit();
      }
      this.focusTransitionService.clearExitVisualSnapshot();
      this.engine.endFocusTransition();
      void this.engine.toggleFocusMode();
      return;
    }
    this.focusTransitionService.runExitFocusTransition();
  }

  takeOverFocusControl(): void {
    this.focusLeader.tryTakeover();
  }

  async onScrimToggle(): Promise<void> {
    if (!this.engine.focusMode()) return;
    if (this.gateActive()) return;
    if (this.focusLeader.isReadOnlyFollower()) return;
    const nextScrimOn = !this.engine.focusScrimOn();
    const persisted = await this.engine.toggleFocusScrim();
    if (!persisted) return;
    this.helpFeedback.showDockFeedback(
      nextScrimOn ? DOCK_TOAST.SCRIM_ON : DOCK_TOAST.SCRIM_OFF,
      'info',
    );
  }

  onZenExit(): void {
    if (!this.engine.focusMode()) return;
    if (this.focusLeader.isReadOnlyFollower()) return;
    this.engine.fragmentRest.dismissZenMode();
  }

  async createTask(): Promise<void> {
    if (this.inlineDockCreatePending()) return;
    const draft = buildInlineDockTaskDraft({
      showAdvancedUi: this.showAdvancedUi,
      canUseInlineDockCreate: this.canUseInlineDockCreate(),
      titleInput: this.newTaskTitle,
      lane: this.newTaskLane,
      load: this.newTaskLoad,
      expectedMinutesInput: this.newTaskExpectedMinutes,
      waitMinutesInput: this.newTaskWaitMinutes,
      detailInput: this.newTaskDetail,
    });
    if (!draft) return;

    this.inlineDockCreatePending.set(true);
    try {
      const createdId = await this.engine.createInDock(draft.title, draft.lane, draft.load, draft.options);
      if (!shouldClearInlineDockTaskForm(createdId)) return;

      this.planner.markRecentlyDocked(createdId);
      clearInlineDockTaskForm(this);
    } finally {
      this.inlineDockCreatePending.set(false);
    }
  }

  togglePlannerQuickEdit(taskId: string): void {
    if (!this.canUsePlannerQuickEdit()) return;
    if (this.planner.isPlannerQuickEditOpen(taskId)) {
      this.closePlannerQuickEdit(false);
      return;
    }
    this.planner.togglePlannerQuickEdit(taskId);
    this.plannerPanelPortal.scheduleOpen(this.planner.presentation(), 50);
  }

  closePlannerQuickEdit(restoreFocus = true): void {
    this.plannerPanelPortal.restore();
    const taskId = this.planner.closePlannerQuickEdit();
    if (restoreFocus && taskId) {
      const trigger = this.hostElement.nativeElement.querySelector(
        `[data-testid="dock-v3-planner-toggle"][data-planner-task-id="${CSS.escape(taskId)}"]`,
      ) as HTMLButtonElement | null;
      trigger?.focus();
    }
  }

  isPlannerQuickEditOpen(taskId: string): boolean {
    return this.planner.isPlannerQuickEditOpen(taskId);
  }

  setPlannerQuickEditExpected(taskId: string, minutes: number | null): void {
    this.planner.setPlannerQuickEditExpected(taskId, minutes);
  }

  setPlannerQuickEditWait(taskId: string, minutes: number | null): void {
    this.planner.setPlannerQuickEditWait(taskId, minutes);
  }

  setPlannerQuickEditLoad(taskId: string, nextLoad: CognitiveLoad): void {
    this.planner.setPlannerQuickEditLoad(taskId, nextLoad);
  }

  toggleHelpOverlay(): void {
    this.helpFeedback.toggleHelpOverlay();
  }

  async createBackupTaskFromFab(): Promise<void> {
    if (!this.canCreateBackupTask()) return;
    const createdId = await this.engine.createInDock(DOCK_DEFAULT_TASK_TITLE, 'backup', 'low');
    if (!createdId) return;
    void this.engine.setDockExpanded(true, { persistPreference: true });
    this.dragDrop.semicircleHoverExpanded.set(true);
    this.planner.markRecentlyDocked(createdId);
    if (this.engine.focusMode()) {
      this.helpFeedback.showDockFeedback(DOCK_TOAST.BACKUP_CREATED_BODY, 'success');
    }
  }

  async openFocusRoutineSettings(): Promise<void> {
    try {
      const component = await this.modalLoader.loadSettingsModal();
      this.dynamicModal.open(component, {
        inputs: {
          sessionEmail: null,
          projects: this.projectStore.projects(),
          initialSection: 'focus-routines',
        },
        outputs: {
          close: () => this.dynamicModal.close(),
        },
      });
    } catch {
      this.toast.error(DOCK_TOAST.SETTINGS_LOAD_FAIL_TITLE, DOCK_TOAST.SETTINGS_LOAD_FAIL_BODY);
    }
  }

  onDockCardClick(taskId: string): void {
    if (this.isDockSelectionBlocked()) return;
    const entry = this.engine.orderedDockEntries().find(item => item.taskId === taskId) ?? null;
    if (!entry) return;
    const currentFrontTaskId = this.engine.focusMode()
      ? (this.engine.focusingEntry()?.taskId ?? null)
      : (this.engine.orderedDockEntries().find(item => item.isMain)?.taskId ?? null);

    // 前台判定要看当前 C 位，而不是是否主任务；主任务在专注中可能暂时退居后台。
    if (!this.firstMainSelectionPending() && currentFrontTaskId === taskId) {
      if (this.dockSecondaryRailActive()) {
        this.helpFeedback.showDockFeedback(`当前已在前台：${entry.title}`, 'info');
      }
      return;
    }

    if (this.firstMainSelectionPending()) {
      this.engine.overrideFirstMainTask(taskId);
      if (this.engine.focusMode()) {
        this.helpFeedback.showDockFeedback(`已改选前台任务：${entry.title}`, 'success');
      }
      return;
    }
    this.engine.setMainTask(taskId);
    if (this.engine.focusMode()) {
      this.helpFeedback.showDockFeedback(`已切换到前台：${entry.title}`, 'success');
    }
  }

  pendingDecisionActionsBlocked(): boolean {
    return this.isDockSelectionBlocked();
  }

  cancelPendingDecisionAutoPromote(): void {
    if (this.pendingDecisionActionsBlocked()) return;

    void this.engine.cancelPendingDecisionAutoPromote();
  }

  choosePendingDecisionCandidate(taskId: string): void {
    if (this.pendingDecisionActionsBlocked()) return;

    this.engine.choosePendingDecisionCandidate(taskId);
  }

  onDrop(event: DragEvent): void {
    this.dragDrop.onDrop(event, (taskId) => this.planner.markRecentlyDocked(taskId));
  }

  private isDockSelectionBlocked(): boolean {
    return this.gateActive() || this.focusLeader.isReadOnlyFollower();
  }

  readonly formatTime = formatDockMinutes;

  /** 待决策候选任务（computed 避免模板每次 CD 重复调用） */
  readonly pendingDecisionRemainingMinutes = computed(() => {
    const remaining = this.engine.pendingDecision()?.rootRemainingMinutes ?? 0;
    return remaining > 0 ? Math.ceil(remaining) : 0;
  });

  groupLabel(group: DockPendingDecisionEntry['group']): string {
    return DOCK_GROUP_LABELS[group as RecommendationGroupType] ?? DOCK_GROUP_FALLBACK_LABEL;
  }

  private captureExitVisualSnapshot(): void {
    this.focusTransitionService.captureExitVisualSnapshot({
      consoleEntries: this.engine.consoleVisibleEntries().map((entry) => ({ ...entry })),
      statusMachineEntries: this.engine.statusMachineEntries().map((entry) => ({ ...entry })),
    });
  }
}
