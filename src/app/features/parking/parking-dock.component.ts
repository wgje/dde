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
import { FormsModule } from '@angular/forms';
import { DockEngineService } from '../../../services/dock-engine.service';
import { DynamicModalService } from '../../../services/dynamic-modal.service';
import { FocusDockLeaderService } from '../../../services/focus-dock-leader.service';
import { GateService } from '../../../services/gate.service';
import { PerformanceTierService, type FocusPerformanceTier } from '../../../services/performance-tier.service';
import { FocusHudWindowService } from '../../../services/focus-hud-window.service';
import { ToastService } from '../../../services/toast.service';
import { ModalLoaderService } from '../../core/services/modal-loader.service';
import { ProjectStore, TaskStore } from '../../core/state/stores';
import { UiStateService } from '../../../services/ui-state.service';
import { PARKING_CONFIG } from '../../../config/parking.config';
import {
  DOCK_TOAST,
  DOCK_HELP_SECTIONS,
  DOCK_GROUP_LABELS,
  DOCK_DEFAULT_TASK_TITLE,
} from '../../../config/dock-i18n.config';
import {
  CognitiveLoad,
  DockExitAction,
  DockLane,
  DockFocusTransitionPhase,
  DockFocusTransitionState,
  DockPendingDecisionEntry,
  DockSourceSection,
} from '../../../models/parking-dock';
import { readTaskDragPayload, hasTaskDragTypes } from '../../../utils/task-drag-payload';
import { TimerHandle } from '../../../utils/timer-handle';
import {
  buildFocusTransition,
  createFlipGhostState,
  type DockFlipGhostState,
} from './utils/dock-flip-transition';
import {
  loadHudPosition as loadHudPositionUtil,
  persistHudPosition as persistHudPositionUtil,
  defaultHudPosition as defaultHudPositionUtil,
  resolveHudSize as resolveHudSizeUtil,
  clampHudPosition as clampHudPositionUtil,
} from './utils/dock-hud-position';
import { DockConsoleStackComponent } from './components/dock-console-stack.component';
import { DockRadarZoneComponent } from './components/dock-radar-zone.component';
import { DockStatusMachineComponent } from './components/dock-status-machine.component';
import { DockDailySlotComponent } from './components/dock-daily-slot.component';
import { DockZenModeComponent } from './components/dock-zen-mode.component';
import { DockFocusSceneComponent, type DockFocusSceneMode } from './components/dock-focus-scene.component';
import { type DockPlannerQuickEditPresentation } from './components/dock-planner-quick-edit.component';
import { formatDockMinutes, parseOptionalMinutes } from './utils/dock-format';

type DockDropState = 'idle' | 'canDrop' | 'isOver' | 'reject';

interface DockDropCandidate {
  taskId: string;
  sourceSection?: 'text' | 'flow';
}

type FocusExitConfirmAction =
  | 'save-exit'
  | 'clear-exit'
  | 'keep-focus-hide-scrim'
  | 'cancel'
  | 'request-end-focus'
  | 'back';

type FocusExitFlowStep = 'primary' | 'destructive';

interface DockActionFeedback {
  message: string;
  tone: 'info' | 'success';
}

const DOCK_REORDER_MIME = 'application/x-nanoflow-dock-reorder';
const DOCK_CLOSE_TRANSIENT_SURFACES_EVENT = 'dock-close-transient-surfaces';

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
    FormsModule,
    DockConsoleStackComponent,
    DockRadarZoneComponent,
    DockStatusMachineComponent,
    DockDailySlotComponent,
    DockZenModeComponent,
    DockFocusSceneComponent,
  ],
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
  private readonly performanceTierService = inject(PerformanceTierService);
  readonly focusHudWindow = inject(FocusHudWindowService);
  private readonly projectStore = inject(ProjectStore);
  private readonly taskStore = inject(TaskStore);
  private readonly toast = inject(ToastService);
  private readonly uiState = inject(UiStateService);
  readonly PARKING_CONFIG = PARKING_CONFIG;

  /** 停泊坞和半圆入口的水平中心点：桌面端有侧边栏时向右偏移半个侧边栏宽度 */
  readonly sidebarEffectiveWidth = computed(() => {
    if (this.uiState.isMobile() || !this.uiState.sidebarOpen()) return 0;
    const transition = this.engine.focusTransition();
    if (
      (this.engine.focusMode() && this.engine.focusScrimOn())
      || transition?.phase === 'entering'
      || transition?.phase === 'exiting'
    ) {
      return 0;
    }
    return this.uiState.sidebarWidth();
  });
  readonly dockCenterLeft = computed(() => {
    const offset = this.sidebarEffectiveWidth();
    return offset === 0 ? '50%' : `calc(50% + ${offset / 2}px)`;
  });

  readonly showNewTaskForm = signal(false);
  readonly showHelpOverlay = signal(false);
  readonly showHelpNudge = signal(false);
  readonly dropState = signal<DockDropState>('idle');
  readonly dockActionFeedback = signal<DockActionFeedback | null>(null);
  readonly flipGhost = signal<DockFlipGhostState | null>(null);
  readonly flipGhostActive = signal(false);
  readonly focusHostZIndex = computed<string | null>(() => {
    if (this.engine.focusMode() || this.engine.focusTransition() !== null || this.flipGhost() !== null) {
      return '60';
    }
    return null;
  });
  readonly dockExpanded = computed(() => this.engine.dockExpanded());
  readonly semicircleHoverExpanded = signal(false);
  readonly semicircleExpanded = computed(() => this.dockExpanded() || this.semicircleHoverExpanded());
  readonly hudSize = signal<{ width: number; height: number }>({
    width: PARKING_CONFIG.HUD_FULL_MAX_WIDTH_PX,
    height: PARKING_CONFIG.HUD_FULL_MAX_HEIGHT_PX,
  });
  readonly hudPosition = signal<{ x: number; y: number } | null>(this.loadHudPosition());
  readonly hudDragging = signal(false);
  readonly showExitConfirm = signal(false);
  readonly exitFlowStep = signal<FocusExitFlowStep>('primary');
  readonly showRestoreHint = signal(false);
  readonly transitionPerformanceTierLock = signal<FocusPerformanceTier | null>(null);
  readonly performanceTier = computed(
    () => this.transitionPerformanceTierLock() ?? this.performanceTierService.tier(),
  );
  readonly takeoverBannerVisible = computed(
    () => this.engine.focusMode() && this.focusLeader.isReadOnlyFollower(),
  );
  readonly gateActive = computed(() => this.gateService.isActive());
  readonly canMutateDock = computed(
    () => !this.gateActive() && !this.focusLeader.isReadOnlyFollower(),
  );
  readonly canUseInlineDockCreate = computed(
    () => this.canMutateDock() && !(this.engine.focusMode() && this.engine.focusScrimOn()),
  );
  readonly showInlineDockCreate = computed(
    () => !this.engine.focusMode() || !this.engine.focusScrimOn(),
  );
  readonly canCreateBackupTask = computed(() => this.canMutateDock());
  readonly canUsePlannerQuickEdit = computed(() => this.canMutateDock());
  readonly canReorderDockCards = computed(
    () => this.canMutateDock() && !(this.engine.focusMode() && this.engine.focusScrimOn()),
  );
  readonly canAcceptExternalDrop = computed(() => this.canReorderDockCards());
  readonly canToggleScrim = computed(
    () => this.engine.focusMode() && this.canMutateDock(),
  );
  readonly dockSecondaryRailActive = computed(
    () => this.engine.focusMode() && this.engine.focusScrimOn(),
  );
  readonly focusMotionProfile = PARKING_CONFIG.FOCUS_MOTION_PROFILE;
  readonly motion = PARKING_CONFIG.MOTION;
  readonly reducedMotion = signal(this.prefersReducedMotion());
  readonly strictSampleMode = PARKING_CONFIG.DOCK_V3_STRICT_SAMPLE_UI;
  readonly showAdvancedUi = PARKING_CONFIG.DOCK_V3_SHOW_ADVANCED_UI;
  readonly blankPeriodActive = computed(
    () =>
      this.engine.fragmentEntryCountdown() === null
      && this.engine.pendingDecision() !== null
      && this.engine.pendingDecisionEntries().length === 0,
  );
  readonly focusSceneMode = computed<DockFocusSceneMode>(() => {
    if (this.engine.focusMode() && this.engine.fragmentDefenseLevel() >= 4) {
      return 'zen';
    }
    if (this.engine.isBurnoutActive()) {
      return 'burnout';
    }
    if (this.engine.isFragmentPhase() || this.blankPeriodActive()) {
      return 'fragment';
    }
    if (this.engine.pendingDecision()) {
      return 'decision';
    }
    return 'steady';
  });
  readonly showZenMode = computed(
    () => this.engine.focusMode() && this.engine.fragmentDefenseLevel() >= 4,
  );
  /** @deprecated 右侧避让带已移除，保留字段避免序列化断裂 */
  readonly hudSafeRightInsetPx = 12;
  readonly firstMainSelectionPending = computed(() => this.engine.firstMainSelectionPending());
  readonly hudMinimalMode = computed(
    () => this.engine.focusMode() && (!this.engine.focusScrimOn() || this.focusHudWindow.isActive()),
  );
  readonly canOpenPipHud = computed(
    () => this.engine.focusMode() && !this.uiState.isMobile() && this.focusHudWindow.isSupported(),
  );
  readonly focusStageTransform = computed(() => {
    if (this.uiState.isMobile()) {
      return this.dockExpanded() ? 'translateY(-128px)' : 'translateY(calc(50vh - 260px))';
    }
    return this.dockExpanded() ? 'translateY(-80px)' : 'translateY(calc(50vh - 240px))';
  });
  readonly hudContainerStyle = computed<Record<string, string>>(() => {
    if (this.hudMinimalMode()) {
      return {
        top: `${PARKING_CONFIG.HUD_MINIMAL_TOP_PX}px`,
        left: '50%',
        right: 'auto',
        transform: 'translateX(-50%)',
        cursor: 'default',
        width: `${PARKING_CONFIG.HUD_MINIMAL_WIDTH_PX}px`,
      };
    }
    const position = this.hudPosition() ?? this.defaultHudPosition();
    return {
      top: `${position.y}px`,
      left: `${position.x}px`,
      right: 'auto',
      transform: 'none',
      cursor: this.hudDragging() ? 'grabbing' : 'default',
      width: 'auto',
    };
  });

  newTaskTitle = '';
  newTaskLane: DockLane = 'backup';
  newTaskLoad: CognitiveLoad = 'low';
  newTaskExpectedMinutes: string | number = '';
  newTaskWaitMinutes: string | number = '';
  newTaskDetail = '';
  readonly plannerQuickEditTaskId = signal<string | null>(null);
  readonly recentlyDockedTaskId = signal<string | null>(null);
  readonly plannerPresentation = computed<DockPlannerQuickEditPresentation>(
    () => this.uiState.isMobile() ? 'sheet' : 'popover',
  );
  readonly plannerActiveEntry = computed(() => {
    const taskId = this.plannerQuickEditTaskId();
    if (!taskId) return null;
    return this.engine.orderedDockEntries().find(entry => entry.taskId === taskId) ?? null;
  });
  readonly plannerBackdropVisible = computed(
    () => this.plannerActiveEntry() !== null && this.plannerPresentation() === 'sheet',
  );
  readonly plannerMissingFieldCount = computed(() => {
    const entry = this.plannerActiveEntry();
    if (!entry) return 0;
    let count = 0;
    if (entry.expectedMinutes === null) count += 1;
    // 等待时间为选填，不计入缺失数
    return count;
  });
  /** 第一个存在必填属性缺失的停泊坞条目（不含 waitMinutes） */
  readonly bannerPlannerTarget = computed(() => {
    // 已有打开的 planner 面板时不再显示横幅
    if (this.plannerActiveEntry()) return null;
    // 专注模式背景操作轨里，banner 需要始终跟随当前前台任务，避免“打开编辑”指向旧任务。
    const focusEntry = this.dockSecondaryRailActive() ? this.engine.focusingEntry() : null;
    if (focusEntry) return focusEntry;
    const entries = this.engine.orderedDockEntries();
    // 优先取主任务
    const main = entries.find(e => e.isMain && e.expectedMinutes === null);
    if (main) return main;
    return entries.find(e => e.expectedMinutes === null) ?? null;
  });
  readonly bannerPlannerMissingCount = computed(() => {
    const entry = this.bannerPlannerTarget();
    if (!entry) return 0;
    let count = 0;
    if (entry.expectedMinutes === null) count += 1;
    return count;
  });
  readonly plannerPanelClasses = computed(() => {
    const baseClasses = [
      'pointer-events-auto',
      'overflow-y-auto',
      'hide-scrollbar',
      'rounded-2xl',
      'border',
      'border-slate-700/75',
      'bg-slate-950/97',
      'p-3.5',
      'shadow-[0_18px_56px_rgba(2,6,23,0.46)]',
      'backdrop-blur-md',
      'animate-[plannerSlideOpen_220ms_ease-out]',
      'origin-top',
    ].join(' ');
    if (this.plannerPresentation() === 'popover') {
      return `${baseClasses} absolute bottom-full right-2 z-20 mb-2 w-[min(calc(100%-1rem),26rem)] max-h-[min(340px,calc(100dvh-180px))]`;
    }
    return `${baseClasses} mx-2 mt-2 max-h-[min(46dvh,320px)]`;
  });
  readonly plannerExpectedPresets = [15, 30, 45, 60, 90, 120];
  readonly plannerWaitPresets = [5, 10, 15, 30, 45, 60];

  readonly dockMaxWidth = PARKING_CONFIG.DOCK_EXPANDED_MAX_WIDTH;
  readonly focusContentEffect = PARKING_CONFIG.DOCK_FOCUS_CONTENT_EFFECT;
  readonly focusBackgroundUrl = PARKING_CONFIG.DOCK_FOCUS_BG_IMAGE_URL;
  readonly dockBottomInset =
    `calc(${PARKING_CONFIG.DOCK_BOTTOM_OFFSET_PX}px + env(safe-area-inset-bottom))`;
  readonly dockSemicircleBottomInset = computed(() =>
    this.uiState.isMobile() ? this.dockBottomInset : 'env(safe-area-inset-bottom)',
  );
  readonly focusHelpSections = DOCK_HELP_SECTIONS;

  private touchStartY = 0;
  private readonly plannerPanel = viewChild<ElementRef<HTMLElement>>('plannerPanel');
  private readonly consoleStack = viewChild(DockConsoleStackComponent);
  private touchTaskId: string | null = null;
  private readonly longPress = new TimerHandle();
  private readonly flip = new TimerHandle();
  private readonly dropRejectReset = new TimerHandle();
  private readonly semicircleDragExpand = new TimerHandle();
  private readonly semicircleAutoCollapse = new TimerHandle();
  private readonly restoreHint = new TimerHandle();
  private readonly helpNudge = new TimerHandle();
  private readonly dockFeedback = new TimerHandle();
  private hudDragPointerId: number | null = null;
  private hudDragOffset: { x: number; y: number } | null = null;
  private draggingDockTaskId: string | null = null;
  private readonly recentlyDocked = new TimerHandle();
  private helpNudgeShownOnce = false;
  /** 用于 requestAnimationFrame 清理的追踪 ID 列表 */
  private readonly pendingRafs: number[] = [];
  /** planner 面板自动聚焦定时器 */
  private readonly plannerAutoFocus = new TimerHandle();

  constructor() {
    effect(() => {
      const activeEntry = this.plannerActiveEntry();
      if (!activeEntry) return;

      this.plannerAutoFocus.schedule(() => {
        this.focusPlannerPanel();
        this.scrollPlannerPanelIntoView();
      }, 0);
    });

    effect(() => {
      if (!this.plannerQuickEditTaskId()) return;
      if (this.plannerActiveEntry()) return;
      this.closePlannerQuickEdit(false);
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
    if (event.key === 'Tab' && this.plannerBackdropVisible()) {
      this.trapDialogFocus(event, '[data-testid="dock-v3-planner-panel"]');
      return;
    }

    if (event.key === 'Tab' && this.showExitConfirm()) {
      this.trapDialogFocus(event, '[data-testid="dock-v3-exit-confirm"]');
      return;
    }

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
    if (this.plannerPresentation() !== 'popover' || !this.plannerActiveEntry()) return;

    const target = event.target;
    if (!(target instanceof Element)) return;

    if (target.closest('[data-testid="dock-v3-planner-panel"]')) return;
    if (target.closest('[data-testid="dock-v3-planner-toggle"]')) return;

    this.closePlannerQuickEdit(false);
  }

  /** Escape 键分级处理：先关闭当前临时表面，再处理虚化与退出。 */
  private handleEscapeKey(event: KeyboardEvent): void {
    if (this.closeTransientSurface()) {
      event.preventDefault();
      return;
    }
    if (this.showZenMode()) {
      event.preventDefault();
      this.onZenExit();
      return;
    }
    if (this.engine.pendingDecision()) {
      event.preventDefault();
      this.cancelPendingAutoPromote();
      return;
    }
    if (this.engine.focusMode() && this.engine.focusScrimOn()) {
      event.preventDefault();
      this.engine.setFocusScrim(false);
      this.showRestoreHint.set(true);
      this.restoreHint.schedule(() => {
        this.showRestoreHint.set(false);
      }, PARKING_CONFIG.DOCK_EXIT_CONFIRM_RESTORE_HINT_MS);
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
    const key = event.key.toLowerCase();
    if (event.altKey && event.shiftKey) {
      if (key === 'l') { event.preventDefault(); this.onFocusSessionToggle(); return; }
      if (key === 'f') { if (!this.engine.focusMode()) return; event.preventDefault(); this.onScrimToggle(); return; }
      if (key === 'd') { event.preventDefault(); this.toggleDockExpanded(); return; }
    }
    if (event.altKey && !event.shiftKey && key === 'h') {
      event.preventDefault();
      this.toggleHelpOverlay();
    }
  }

  toggleHelpOverlay(): void {
    if (this.showHelpOverlay()) {
      this.closeHelpOverlay();
      return;
    }
    this.showHelpOverlay.set(true);
    this.showHelpNudge.set(false);
  }

  closeHelpOverlay(): void {
    this.showHelpOverlay.set(false);
    this.showHelpNudge.set(false);
  }

  @HostListener('window:dock-focus-session-toggle')
  onExternalFocusSessionToggle(): void {
    if (this.gateActive()) return;
    this.onFocusSessionToggle();
  }

  @HostListener('window:pointermove', ['$event'])
  onHudPointerMove(event: PointerEvent): void {
    if (!this.hudDragging()) return;
    if (this.hudDragPointerId !== null && event.pointerId !== this.hudDragPointerId) return;
    if (!this.hudDragOffset) return;
    const next = this.clampHudPosition({
      x: event.clientX - this.hudDragOffset.x,
      y: event.clientY - this.hudDragOffset.y,
    }, this.hudSize());
    this.hudPosition.set(next);
  }

  @HostListener('window:pointerup', ['$event'])
  @HostListener('window:pointercancel', ['$event'])
  onHudPointerUp(event: PointerEvent): void {
    if (!this.hudDragging()) return;
    if (this.hudDragPointerId !== null && event.pointerId !== this.hudDragPointerId) return;
    this.hudDragging.set(false);
    this.hudDragPointerId = null;
    this.hudDragOffset = null;
    this.persistHudPosition();
  }

  ngOnDestroy(): void {
    this.longPress.cancel();
    this.flip.cancel();
    this.dropRejectReset.cancel();
    this.semicircleDragExpand.cancel();
    this.semicircleAutoCollapse.cancel();
    this.restoreHint.cancel();
    this.helpNudge.cancel();
    this.dockFeedback.cancel();
    this.recentlyDocked.cancel();
    this.plannerAutoFocus.cancel();
    // 清理所有未完成的 requestAnimationFrame
    for (const id of this.pendingRafs) cancelAnimationFrame(id);
    this.pendingRafs.length = 0;
    this.persistHudPosition();
    this.transitionPerformanceTierLock.set(null);
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

  toggleDockExpanded(): void {
    if (this.gateActive()) return;
    const next = !this.engine.dockExpanded();
    this.engine.setDockExpanded(next);
    if (next) {
      this.semicircleHoverExpanded.set(true);
      this.semicircleAutoCollapse.cancel();
      return;
    }
    this.plannerQuickEditTaskId.set(null);
    this.scheduleSemicircleAutoCollapse();
  }

  onSemicircleMouseEnter(): void {
    if (this.gateActive()) return;
    this.semicircleHoverExpanded.set(true);
    this.semicircleAutoCollapse.cancel();
  }

  onSemicircleMouseLeave(): void {
    if (this.gateActive()) return;
    this.scheduleSemicircleAutoCollapse();
  }

  /**
   * 半圆入口拖拽悬停处理 — 拖拽任务悬停在半圆上时自动展开停泊坞，
   * 使坞栏 drop-zone 可见，用户可继续将任务拖入。
   */
  onSemicircleDragOver(event: DragEvent): void {
    if (!this.canAcceptExternalDrop()) return;
    if (!hasTaskDragTypes(event.dataTransfer)) return;
    event.preventDefault();
    // 设置拖放状态，触发半圆和坶栏的视觉反馈
    if (this.dropState() !== 'reject') {
      this.dropState.set('canDrop');
    }
    // 自动展开停泊坞面板，使 drop-zone 可触达
    if (!this.dockExpanded()) {
      this.scheduleSemicircleDragExpand();
    }
  }

  onSemicircleDragLeave(): void {
    // 重置拖放状态，移除视觉反馈
    if (this.dropState() !== 'reject') {
      this.dropState.set('idle');
    }
    // 不立即收起 — 给用户时间将任务移到展开后的 drop-zone
  }

  onHudPointerDown(event: PointerEvent): void {
    if (this.hudMinimalMode()) return;
    if (event.button !== 0) return;
    if (this.shouldIgnoreHudPointerDown(event.target)) return;
    const container = (event.currentTarget as HTMLElement)
      .closest('[data-testid=\"dock-v3-status-machine-container\"]') as HTMLElement | null;
    const rect = container?.getBoundingClientRect();
    const size = this.resolveHudSize(rect);
    this.hudSize.set(size);
    const current = this.hudPosition() ?? this.defaultHudPosition(size);
    const clamped = this.clampHudPosition(current, size);
    this.hudPosition.set(clamped);
    this.hudDragging.set(true);
    this.hudDragPointerId = event.pointerId;
    this.hudDragOffset = {
      x: event.clientX - clamped.x,
      y: event.clientY - clamped.y,
    };
    (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
    event.preventDefault();
  }

  private shouldIgnoreHudPointerDown(target: EventTarget | null): boolean {
    if (!(target instanceof Element)) return false;
    return target.closest(
      [
        'button',
        'a',
        'input',
        'textarea',
        'select',
        'label',
        'summary',
        '[role="button"]',
        '[contenteditable="true"]',
        '[data-hud-drag-ignore]',
      ].join(','),
    ) !== null;
  }

  onBackdropClick(): void {
    if (!this.engine.focusMode()) return;
    this.closeTransientSurface();
  }

  onFocusTransitionSettled(phase: DockFocusTransitionPhase): void {
    const transition = this.engine.focusTransition();
    if (!transition) return;
    if (phase === 'entering' && transition.phase === 'entering') {
      this.finalizeEnterFocusTransition(transition);
      return;
    }
    if (phase === 'exiting' && transition.phase === 'exiting') {
      this.finalizeExitFocusTransition();
    }
  }

  onFocusSessionToggle(): void {
    if (this.gateActive()) return;
    if (this.focusLeader.isReadOnlyFollower()) return;
    const transition = this.engine.focusTransition();
    if (transition?.phase === 'entering' || transition?.phase === 'exiting') return;

    if (this.engine.focusMode()) {
      this.exitFlowStep.set('primary');
      this.showExitConfirm.set(true);
      this.focusExitConfirmPrimaryAction();
      return;
    }

    // 进入专注模式前，先将停泊坞面板收起下沉，避免坞栏与专注虚化遮罩叠加
    if (this.engine.dockExpanded()) {
      this.engine.setDockExpanded(false);
      this.scheduleSemicircleAutoCollapse();
    }

    if (this.prefersReducedMotion()) {
      this.engine.endFocusTransition();
      this.engine.toggleFocusMode();
      this.showFocusHelpNudgeOnce();
      return;
    }
    this.showFocusHelpNudgeOnce();
    this.runEnterFocusTransition();
  }

  confirmExitFocus(action: FocusExitConfirmAction): void {
    if (action === 'cancel') {
      this.showExitConfirm.set(false);
      this.exitFlowStep.set('primary');
      return;
    }

    if (action === 'back') {
      this.exitFlowStep.set('primary');
      this.focusExitConfirmPrimaryAction();
      return;
    }

    if (action === 'request-end-focus') {
      this.exitFlowStep.set('destructive');
      this.focusExitConfirmPrimaryAction();
      return;
    }

    if (action === 'keep-focus-hide-scrim') {
      this.engine.markExitAction('keep_focus_hide_scrim');
      this.engine.setFocusScrim(false);
      this.showExitConfirm.set(false);
      this.exitFlowStep.set('primary');
      this.showRestoreHintToast();
      return;
    }

    const exitAction: DockExitAction = action === 'clear-exit' ? 'clear_exit' : 'save_exit';
    this.engine.markExitAction(exitAction);
    this.showExitConfirm.set(false);
    this.exitFlowStep.set('primary');
    if (exitAction === 'clear_exit') {
      this.engine.clearDockForExit();
    }
    if (this.prefersReducedMotion()) {
      this.engine.endFocusTransition();
      this.engine.toggleFocusMode();
      return;
    }
    this.runExitFocusTransition();
  }

  takeOverFocusControl(): void {
    this.focusLeader.tryTakeover();
  }

  onScrimToggle(): void {
    if (!this.engine.focusMode()) return;
    if (this.gateActive()) return;
    if (this.focusLeader.isReadOnlyFollower()) return;
    const nextScrimOn = !this.engine.focusScrimOn();
    this.engine.toggleFocusScrim();
    this.showDockFeedback(
      nextScrimOn ? DOCK_TOAST.SCRIM_ON : DOCK_TOAST.SCRIM_OFF,
      'info',
    );
  }

  onZenExit(): void {
    if (!this.engine.focusMode()) return;
    if (this.focusLeader.isReadOnlyFollower()) return;
    this.engine.fragmentRest.dismissZenMode();
  }

  createTask(): void {
    if (!this.showAdvancedUi) return;
    if (!this.canUseInlineDockCreate()) return;
    const title = this.newTaskTitle.trim();
    if (!title) return;

    const detail = this.newTaskDetail.trim();
    const expectedMinutes = parseOptionalMinutes(this.newTaskExpectedMinutes);
    const waitMinutes = parseOptionalMinutes(this.newTaskWaitMinutes);
    const createdId = this.engine.createInDock(title, this.newTaskLane, this.newTaskLoad, {
      expectedMinutes,
      waitMinutes,
      detail,
    });
    if (!createdId) return;

    this.markRecentlyDocked(createdId);
    this.newTaskTitle = '';
    this.newTaskExpectedMinutes = '';
    this.newTaskWaitMinutes = '';
    this.newTaskDetail = '';
    this.showNewTaskForm.set(false);
  }

  isPlannerQuickEditOpen(taskId: string): boolean {
    return this.plannerQuickEditTaskId() === taskId;
  }

  togglePlannerQuickEdit(taskId: string): void {
    if (!this.canUsePlannerQuickEdit()) return;
    this.closeHelpOverlay();
    if (this.plannerQuickEditTaskId() === taskId) {
      this.closePlannerQuickEdit();
      return;
    }
    this.plannerQuickEditTaskId.set(taskId);
    this.engine.setDockExpanded(true);
  }

  closePlannerQuickEdit(restoreFocus = true): void {
    const taskId = this.plannerQuickEditTaskId();
    this.plannerQuickEditTaskId.set(null);
    if (restoreFocus && taskId) {
      this.restorePlannerTriggerFocus(taskId);
    }
  }

  setPlannerQuickEditLoad(taskId: string, nextLoad: CognitiveLoad): void {
    if (!this.canUsePlannerQuickEdit()) return;
    const entry = this.engine.orderedDockEntries().find(item => item.taskId === taskId) ?? null;
    if (!entry || entry.load === nextLoad) return;
    this.engine.toggleLoad(taskId, nextLoad === 'high' ? 'up' : 'down');
  }

  setPlannerQuickEditExpected(taskId: string, minutes: number | null): void {
    if (!this.canUsePlannerQuickEdit()) return;
    this.engine.setExpectedTime(taskId, minutes);
  }

  setPlannerQuickEditWait(taskId: string, minutes: number | null): void {
    if (!this.canUsePlannerQuickEdit()) return;
    this.engine.setWaitTime(taskId, minutes);
  }

  private markRecentlyDocked(taskId: string): void {
    this.recentlyDockedTaskId.set(taskId);
    this.recentlyDocked.schedule(() => {
      this.recentlyDockedTaskId.set(null);
    }, 3000);

    this.plannerQuickEditTaskId.update(current => (current === taskId ? null : current));
  }

  createBackupTaskFromFab(): void {
    if (!this.canCreateBackupTask()) return;
    const createdId = this.engine.createInDock(DOCK_DEFAULT_TASK_TITLE, 'backup', 'low');
    if (!createdId) return;
    this.engine.setDockExpanded(true);
    this.semicircleHoverExpanded.set(true);
    this.markRecentlyDocked(createdId);
    if (this.engine.focusMode()) {
      this.showDockFeedback(DOCK_TOAST.BACKUP_CREATED_BODY, 'success');
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
        this.showDockFeedback(`当前已在前台：${entry.title}`, 'info');
      }
      return;
    }

    if (this.firstMainSelectionPending()) {
      this.engine.overrideFirstMainTask(taskId);
      if (this.engine.focusMode()) {
        this.showDockFeedback(`已改选前台任务：${entry.title}`, 'success');
      }
      return;
    }
    this.engine.setMainTask(taskId);
    if (this.engine.focusMode()) {
      this.showDockFeedback(`已切换到前台：${entry.title}`, 'success');
    }
  }

  onDockCardDragStart(event: DragEvent, taskId: string): void {
    if (!this.canReorderDockCards()) return;
    this.draggingDockTaskId = taskId;
    if (!event.dataTransfer) return;
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData(DOCK_REORDER_MIME, taskId);
    event.dataTransfer.setData('text/plain', taskId);
  }

  onDockCardDragOver(event: DragEvent, targetTaskId: string): void {
    if (!this.canReorderDockCards()) return;
    // dragover 期间 getData() 受浏览器安全限制返回空串，
    // 改用 types 判断是否为坞内重排拖拽，并通过已缓存的 draggingDockTaskId 判断来源
    if (!this.hasDockReorderType(event.dataTransfer)) return;
    if (this.draggingDockTaskId === targetTaskId) return;
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'move';
    }
  }

  onDockCardDrop(event: DragEvent, targetTaskId: string): void {
    if (!this.canReorderDockCards()) return;
    const sourceTaskId = this.extractDockReorderTaskId(event.dataTransfer);
    if (!sourceTaskId || sourceTaskId === targetTaskId) return;
    event.preventDefault();
    this.engine.reorderDockEntries(sourceTaskId, targetTaskId);
    this.draggingDockTaskId = null;
  }

  onDockCardDragEnd(): void {
    this.draggingDockTaskId = null;
  }

  onCardWheel(event: WheelEvent, taskId: string): void {
    if (!this.canReorderDockCards()) return;
    if (!event.altKey) return;
    event.preventDefault();
    this.engine.toggleLoad(taskId, event.deltaY > 0 ? 'down' : 'up');
  }

  onTouchStart(event: TouchEvent, taskId: string): void {
    if (!this.canReorderDockCards()) return;
    this.touchStartY = event.touches?.[0]?.clientY ?? 0;
    // H-8 fix: 不立即设置 touchTaskId，等长按回调后才允许滑动手势
    this.touchTaskId = null;
    this.longPress.schedule(() => {
      this.touchTaskId = taskId;
    }, PARKING_CONFIG.DOCK_LONG_PRESS_DELAY_MS);
  }

  onTouchMove(event: TouchEvent, _taskId?: string): void {
    if (!this.canReorderDockCards()) return;
    if (!this.touchTaskId) return;
    const deltaY = (event.touches?.[0]?.clientY ?? 0) - this.touchStartY;
    if (Math.abs(deltaY) > 30) {
      this.engine.toggleLoad(this.touchTaskId, deltaY > 0 ? 'down' : 'up');
      this.touchStartY = event.touches?.[0]?.clientY ?? 0;
    }
  }

  onTouchEnd(): void {
    this.longPress.cancel();
    this.touchTaskId = null;
  }

  onDockRailDragOver(event: DragEvent): void {
    if (!this.canAcceptExternalDrop()) return;
    // dragover 期间 getData() 受浏览器安全限制返回空串，改用 types 检查
    if (this.hasDockReorderType(event.dataTransfer)) {
      event.preventDefault();
      this.dropState.set('idle');
      return;
    }
    event.preventDefault();
    if (!hasTaskDragTypes(event.dataTransfer)) {
      if (this.dropState() !== 'reject') {
        this.dropState.set('idle');
      }
      return;
    }
    this.scheduleSemicircleDragExpand();
    if (this.dropState() !== 'reject') {
      this.dropState.set('canDrop');
    }
  }

  onDockRailDragLeave(): void {
    if (!this.canAcceptExternalDrop()) return;
    if (this.dropState() !== 'reject') {
      this.dropState.set('idle');
    }
    this.scheduleSemicircleAutoCollapse();
  }

  onDropZoneDragOver(event: DragEvent): void {
    if (!this.canAcceptExternalDrop()) return;
    event.preventDefault();
    // dragover 期间 getData() 受浏览器安全限制返回空串，只能检查 MIME types
    if (!hasTaskDragTypes(event.dataTransfer)) {
      this.triggerDropReject();
      return;
    }
    this.scheduleSemicircleDragExpand();
    if (this.dropState() !== 'reject') {
      this.dropState.set('isOver');
    }
  }

  onDropZoneDragLeave(): void {
    if (!this.canAcceptExternalDrop()) return;
    if (this.dropState() === 'isOver') {
      this.dropState.set('canDrop');
    }
    this.scheduleSemicircleAutoCollapse();
  }

  onDrop(event: DragEvent): void {
    if (!this.canAcceptExternalDrop()) return;
    event.preventDefault();
    const reorderTaskId = this.extractDockReorderTaskId(event.dataTransfer);
    if (reorderTaskId) {
      this.draggingDockTaskId = null;
      this.dropState.set('idle');
      this.scheduleSemicircleAutoCollapse();
      return;
    }

    const candidate = this.extractDropCandidate(event.dataTransfer);
    if (!candidate || !this.canDropCandidate(candidate)) {
      this.triggerDropReject();
      return;
    }
    this.dropState.set('idle');
    const docked = this.engine.dockTaskFromExternalDrag(candidate.taskId, candidate.sourceSection);
    if (!docked) return;
    this.markRecentlyDocked(candidate.taskId);
    this.scheduleSemicircleAutoCollapse();
  }

  private extractDockReorderTaskId(dataTransfer: DataTransfer | null): string | null {
    if (!dataTransfer) return null;
    const value = dataTransfer.getData(DOCK_REORDER_MIME).trim();
    return value || null;
  }

  private extractDropCandidate(dataTransfer: DataTransfer | null): DockDropCandidate | null {
    if (!dataTransfer) return null;

    const payload = readTaskDragPayload(dataTransfer);
    if (payload?.taskId) {
      const sourceSection: DockSourceSection | undefined =
        payload.source === 'text' || payload.source === 'flow'
          ? payload.source
          : undefined;
      return {
        taskId: payload.taskId,
        sourceSection,
      };
    }

    const text = dataTransfer.getData('text/plain').trim();
    if (!text) return null;
    return { taskId: text };
  }

  private canDropCandidate(candidate: DockDropCandidate): boolean {
    if (!this.canAcceptExternalDrop()) return false;
    const alreadyDocked = this.engine.dockedEntries().some(entry => entry.taskId === candidate.taskId);
    if (alreadyDocked) return false;
    const task = this.taskStore.getTask(candidate.taskId);
    return Boolean(task && task.status === 'active');
  }

  isEditingBlocked(): boolean {
    return !this.canUseInlineDockCreate();
  }

  private isDockSelectionBlocked(): boolean {
    return this.gateActive() || this.focusLeader.isReadOnlyFollower();
  }

  private closeTransientSurface(): boolean {
    if (this.plannerQuickEditTaskId()) {
      this.closePlannerQuickEdit();
      return true;
    }

    if (this.hasVisibleWaitMenu()) {
      this.dispatchCloseTransientSurfaceEvent();
      return true;
    }

    if (this.showHelpOverlay()) {
      this.closeHelpOverlay();
      return true;
    }

    if (this.showExitConfirm()) {
      if (this.exitFlowStep() === 'destructive') {
        this.exitFlowStep.set('primary');
        this.focusExitConfirmPrimaryAction();
      } else {
        this.showExitConfirm.set(false);
      }
      return true;
    }

    return false;
  }

  private showRestoreHintToast(): void {
    this.showRestoreHint.set(true);
    this.restoreHint.schedule(() => {
      this.showRestoreHint.set(false);
    }, PARKING_CONFIG.DOCK_EXIT_CONFIRM_RESTORE_HINT_MS);
  }

  private showFocusHelpNudgeOnce(): void {
    if (this.helpNudgeShownOnce) return;
    this.helpNudgeShownOnce = true;
    this.showHelpNudge.set(true);
    this.helpNudge.schedule(() => {
      this.showHelpNudge.set(false);
    }, PARKING_CONFIG.DOCK_HELP_NUDGE_DURATION_MS);
  }

  private showDockFeedback(message: string, tone: DockActionFeedback['tone']): void {
    this.dockActionFeedback.set({ message, tone });
    this.dockFeedback.schedule(() => {
      this.dockActionFeedback.set(null);
    }, PARKING_CONFIG.DOCK_FEEDBACK_TOAST_DURATION_MS);
  }

  private dispatchCloseTransientSurfaceEvent(): void {
    if (typeof window === 'undefined') return;
    window.dispatchEvent(new CustomEvent(DOCK_CLOSE_TRANSIENT_SURFACES_EVENT));
  }

  private hasVisibleWaitMenu(): boolean {
    return this.consoleStack()?.waitPresetTaskId() != null;
  }

  /**
   * 在 dragover 期间检查 dataTransfer 是否包含坞内重排 MIME 类型
   * （浏览器安全限制导致 dragover 期间 getData 返回空串，只能通过 types 检查）
   */
  private hasDockReorderType(dataTransfer: DataTransfer | null): boolean {
    if (!dataTransfer) return false;
    return dataTransfer.types.includes(DOCK_REORDER_MIME);
  }

  private triggerDropReject(): void {
    this.dropState.set('reject');
    this.scheduleSemicircleAutoCollapse();
    this.dropRejectReset.schedule(() => {
      this.dropState.set('idle');
    }, PARKING_CONFIG.DOCK_DROP_REJECT_RESET_MS);
  }

  private scheduleSemicircleDragExpand(): void {
    if (this.semicircleExpanded()) return;
    if (this.semicircleDragExpand.active) return;
    this.semicircleDragExpand.schedule(() => {
      this.semicircleHoverExpanded.set(true);
      // 拖拽悬停触发展开坞栏面板，使 drop-zone 可触达
      this.engine.setDockExpanded(true);
      this.scheduleSemicircleAutoCollapse();
    }, PARKING_CONFIG.DOCK_SEMICIRCLE_DRAG_EXPAND_DELAY_MS);
  }

  private scheduleSemicircleAutoCollapse(): void {
    this.semicircleDragExpand.cancel();
    this.semicircleAutoCollapse.cancel();
    if (this.dockExpanded()) return;
    this.semicircleAutoCollapse.schedule(() => {
      if (!this.dockExpanded()) {
        this.semicircleHoverExpanded.set(false);
      }
    }, PARKING_CONFIG.DOCK_SEMICIRCLE_AUTO_COLLAPSE_MS);
  }

  private loadHudPosition(): { x: number; y: number } | null {
    return loadHudPositionUtil(this.hudSize());
  }

  private persistHudPosition(): void {
    persistHudPositionUtil(this.hudPosition());
  }

  private defaultHudPosition(size: { width: number; height: number } = this.hudSize()): { x: number; y: number } {
    return defaultHudPositionUtil(size);
  }

  private resolveHudSize(rect?: Pick<DOMRect, 'width' | 'height'> | null): { width: number; height: number } {
    return resolveHudSizeUtil(rect, this.hudSize());
  }

  private clampHudPosition(
    position: { x: number; y: number },
    size: { width: number; height: number } = this.hudSize(),
  ): { x: number; y: number } {
    return clampHudPositionUtil(position, size);
  }

  private runEnterFocusTransition(): void {
    const transition = buildFocusTransition('enter', this.motion.focus, this.dockExpanded());
    if (!transition) {
      this.transitionPerformanceTierLock.set(null);
      this.engine.toggleFocusMode();
      return;
    }

    this.transitionPerformanceTierLock.set(this.performanceTierService.tier());
    this.engine.holdNonCriticalWork(transition.durationMs! + 120);
    this.engine.beginFocusTransition(transition);
    this.startFlipGhost(transition);

    this.pendingRafs.push(requestAnimationFrame(() => {
      this.engine.toggleFocusMode();
    }));

    this.flip.schedule(() => {
      const current = this.engine.focusTransition();
      if (current?.phase === 'entering') {
        this.finalizeEnterFocusTransition(current);
      }
    }, transition.durationMs!);
  }

  private runExitFocusTransition(): void {
    const transition = buildFocusTransition('exit', this.motion.focus, this.dockExpanded());
    if (!transition) {
      this.transitionPerformanceTierLock.set(null);
      this.engine.endFocusTransition();
      this.engine.toggleFocusMode();
      return;
    }

    this.transitionPerformanceTierLock.set(this.performanceTierService.tier());
    this.engine.holdNonCriticalWork(transition.durationMs! + 120);
    this.engine.beginFocusTransition(transition);
    this.startFlipGhost(transition);

    this.pendingRafs.push(requestAnimationFrame(() => {
      this.engine.toggleFocusMode();
    }));

    this.flip.schedule(() => {
      const current = this.engine.focusTransition();
      if (current?.phase === 'exiting') {
        this.finalizeExitFocusTransition();
      }
    }, transition.durationMs!);
  }

  private finalizeEnterFocusTransition(transition: DockFocusTransitionState): void {
    this.flip.cancel();
    this.engine.beginFocusTransition({
      ...transition,
      phase: 'focused',
    });
    this.clearFlipGhost();
    this.transitionPerformanceTierLock.set(null);
  }

  private finalizeExitFocusTransition(): void {
    this.flip.cancel();
    this.engine.endFocusTransition();
    this.clearFlipGhost();
    this.transitionPerformanceTierLock.set(null);
  }

  private startFlipGhost(transition: DockFocusTransitionState): void {
    const ghost = createFlipGhostState(transition);
    if (!ghost) return;

    this.flipGhost.set(ghost);
    this.flipGhostActive.set(false);
    // 单帧 rAF：让幽灵元素先渲染到初始位置，下一帧激活 CSS transition
    requestAnimationFrame(() => this.flipGhostActive.set(true));
  }

  private clearFlipGhost(): void {
    this.flipGhost.set(null);
    this.flipGhostActive.set(false);
  }

  private prefersReducedMotion(): boolean {
    if (typeof window === 'undefined' || !window.matchMedia) return false;
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  private focusExitConfirmPrimaryAction(): void {
    if (typeof document === 'undefined') return;
    setTimeout(() => {
      const selector = this.exitFlowStep() === 'destructive'
        ? '[data-testid="dock-v3-exit-save"]'
        : '[data-testid="dock-v3-exit-cancel"]';
      const primary = document.querySelector<HTMLElement>(selector);
      primary?.focus();
    }, 0);
  }

  private trapDialogFocus(event: KeyboardEvent, selector: string): void {
    if (typeof document === 'undefined') return;
    const container = document.querySelector<HTMLElement>(selector);
    if (!container) return;
    const focusables = Array.from(
      container.querySelectorAll<HTMLElement>(
        'button,[href],input,select,textarea,[tabindex]:not([tabindex="-1"])',
      ),
    ).filter(node => !node.hasAttribute('disabled'));
    if (focusables.length === 0) {
      event.preventDefault();
      return;
    }

    const active = document.activeElement as HTMLElement | null;
    const currentIndex = focusables.findIndex(node => node === active);
    const backward = event.shiftKey;
    let nextIndex = 0;
    if (currentIndex < 0) {
      nextIndex = backward ? focusables.length - 1 : 0;
    } else if (backward) {
      nextIndex = currentIndex === 0 ? focusables.length - 1 : currentIndex - 1;
    } else {
      nextIndex = currentIndex === focusables.length - 1 ? 0 : currentIndex + 1;
    }
    event.preventDefault();
    focusables[nextIndex]?.focus();
  }

  private focusPlannerPanel(): void {
    this.plannerPanel()?.nativeElement.focus();
  }

  /** 内联面板打开后自动滚动到可见区域 */
  private scrollPlannerPanelIntoView(): void {
    if (this.plannerPresentation() === 'popover') return;
    this.plannerPanel()?.nativeElement.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  private restorePlannerTriggerFocus(taskId: string): void {
    const trigger = this.resolvePlannerTrigger(taskId);
    trigger?.focus();
  }

  private resolvePlannerTrigger(taskId: string): HTMLButtonElement | null {
    return this.hostElement.nativeElement.querySelector(
      `[data-testid="dock-v3-planner-toggle"][data-planner-task-id="${CSS.escape(taskId)}"]`,
    ) as HTMLButtonElement | null;
  }

  formatTime(minutes: number): string {
    return formatDockMinutes(minutes);
  }


  /** 待决策候选任务（computed 避免模板每次 CD 重复调用） */
  readonly pendingDecisionRemainingMinutes = computed(() => {
    const remaining = this.engine.pendingDecision()?.rootRemainingMinutes ?? 0;
    return remaining > 0 ? Math.ceil(remaining) : 0;
  });

  /** 待决策候选条目，最多取 2 个（computed 避免模板重复调用） */
  readonly pendingDecisionEntries = computed(() =>
    this.engine.pendingDecisionEntries(),
  );

  choosePendingCandidate(taskId: string): void {
    this.engine.choosePendingDecisionCandidate(taskId);
  }

  cancelPendingAutoPromote(): void {
    this.engine.cancelPendingDecisionAutoPromote();
  }

  groupLabel(group: DockPendingDecisionEntry['group']): string {
    return DOCK_GROUP_LABELS[group as keyof typeof DOCK_GROUP_LABELS] ?? DOCK_GROUP_LABELS.fallback;
  }
}
