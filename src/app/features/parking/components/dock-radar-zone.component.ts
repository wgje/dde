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
  untracked,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { PARKING_CONFIG } from '../../../../config/parking.config';
import { DockEntry, DockLane, CognitiveLoad, RecommendationGroupType } from '../../../../models/parking-dock';
import { DockEngineService } from '../../../../services/dock-engine.service';
import { ProjectStore } from '../../../core/state/stores';
import {
  RadarLayoutItem,
  ComboSector,
  RadarAvoidRect,
  DEFAULT_RADAR_LAYOUT_CONFIG,
  layoutEntries,
  hashCode,
  rand,
} from '../utils/dock-radar-layout';
import { formatDockMinutes } from '../utils/dock-format';

interface RadarProjectMeta {
  name: string;
  color: string | null;
}

@Component({
  selector: 'app-dock-radar-zone',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule],
  styleUrl: './dock-radar-zone.component.scss',
  templateUrl: './dock-radar-zone.component.html',
})
export class DockRadarZoneComponent implements OnDestroy {
  private readonly engine = inject(DockEngineService);
  private readonly projectStore = inject(ProjectStore);
  private readonly hostElement = inject<ElementRef<HTMLElement>>(ElementRef);

  readonly comboRadius = PARKING_CONFIG.RADAR_STRONG_RADIUS;
  readonly backupRadius = PARKING_CONFIG.RADAR_WEAK_RADIUS;
  readonly comboOpacity = PARKING_CONFIG.RADAR_STRONG_OPACITY;
  readonly backupOpacity = PARKING_CONFIG.RADAR_WEAK_OPACITY;
  readonly floatDuration = `${PARKING_CONFIG.RADAR_FLOAT_DURATION_S}s`;
  readonly backupFloatDuration = `${PARKING_CONFIG.RADAR_FLOAT_DURATION_S + 0.8}s`;
  readonly createFormWidth = PARKING_CONFIG.RADAR_CREATE_FORM_WIDTH;
  readonly enableRadarFloat = PARKING_CONFIG.FOCUS_ENABLE_RADAR_FLOAT;
  readonly comboVisibleLimit = PARKING_CONFIG.RADAR_COMBO_VISIBLE_LIMIT;
  readonly backupVisibleLimit = PARKING_CONFIG.RADAR_BACKUP_VISIBLE_LIMIT;
  private readonly hoverExitLingerMs = PARKING_CONFIG.MOTION.radar.hoverMs;
  private readonly radarLayoutConfig = DEFAULT_RADAR_LAYOUT_CONFIG;

  private readonly highlightedIds = this.engine.highlightedIds;
  private readonly magnetSlidingIds = signal(new Set<string>());
  private readonly hoverFloatIds = signal(new Set<string>());
  private readonly focusFloatIds = signal(new Set<string>());
  private readonly overlayAvoidRects = signal<RadarAvoidRect[]>([]);
  private readonly knownTaskIds = signal(new Set<string>());
  private readonly enteringTaskIds = signal(new Set<string>());
  readonly promotionLockTaskId = signal<string | null>(null);
  /** 从主控台被淘汰回备选区的 taskId 集合（用于触发返回入场动画） */
  private readonly radarReturningIds = signal(new Set<string>());
  private readonly enteringTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly radarReturnTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private promotionTimer: ReturnType<typeof setTimeout> | null = null;
  private overlayAvoidRefreshRaf: number | null = null;

  // 监听淘汰信号：engine 淘汰卡片回备选区时短暂标记 returning 状态
  private readonly radarEvictEffect = effect(() => {
    const evictedId = this.engine.lastRadarEvictedTaskId();
    if (!evictedId) return;
    untracked(() => {
      this.radarReturningIds.update(prev => {
        const next = new Set(prev);
        next.add(evictedId);
        return next;
      });
      this.engine.lastRadarEvictedTaskId.set(null);
      // 入场动画结束后清除标记
      this.clearRadarReturnTimer(evictedId);
      const timer = setTimeout(() => {
        this.radarReturnTimers.delete(evictedId);
        this.radarReturningIds.update(prev => {
          const next = new Set(prev);
          next.delete(evictedId);
          return next;
        });
      }, PARKING_CONFIG.MOTION.radar.returnMs + PARKING_CONFIG.RADAR_RETURN_BUFFER_MS);
      this.radarReturnTimers.set(evictedId, timer);
    });
  });

  // 首次出现在当前雷达区的任务只播放一次 appear，索引变化不再重播。
  private readonly radarEnterEffect = effect(() => {
    const visibleTaskIds = [
      ...this.comboItems().map(item => item.entry.taskId),
      ...this.backupItems().map(item => item.entry.taskId),
    ];
    const knownTaskIds = this.knownTaskIds();
    const newTaskIds = visibleTaskIds.filter(taskId => !knownTaskIds.has(taskId));
    if (newTaskIds.length === 0) return;

    untracked(() => {
      this.knownTaskIds.update(prev => {
        const next = new Set(prev);
        newTaskIds.forEach(taskId => next.add(taskId));
        return next;
      });

      newTaskIds.forEach(taskId => {
        this.enteringTaskIds.update(prev => {
          const next = new Set(prev);
          next.add(taskId);
          return next;
        });
        this.scheduleEnteringCleanup(taskId);
      });
    });
  });
  private readonly overlayAvoidEffect = effect(() => {
    this.engine.focusMode();
    this.engine.focusTransition();
    this.comboEntries();
    this.backupEntries();
    this.scheduleOverlayAvoidRectRefresh();
  });

  private longPressTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly hoverExitTimers = new Map<string, ReturnType<typeof setTimeout>>();
  // M-11 fix: focus float 使用独立 timer map，避免与 hover 交叉取消
  private readonly focusExitTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private touchActiveTaskId: string | null = null;
  private touchStartY = 0;
  private touchLongPressed = false;

  readonly createFormLane = signal<DockLane | null>(null);
  readonly showComboOverflowPanel = signal(false);
  readonly showBackupOverflowPanel = signal(false);
  createFormX = 0;
  createFormY = 0;
  createTitle = '';
  createLoad: CognitiveLoad = 'low';
  createExpected: number | string = '';
  createWait: number | string = '';
  readonly groupOrder: RecommendationGroupType[] = [
    'homologous-advancement',
    'cognitive-downgrade',
    'asynchronous-boot',
  ];
  readonly activeGroupIndex = signal(0);

  readonly pendingEntryGroupByTaskId = computed(() =>
    new Map(this.engine.pendingDecisionEntries().map(entry => [entry.taskId, entry.group])),
  );
  readonly groupSwitchEnabled = computed(() => this.pendingEntryGroupByTaskId().size > 0);
  readonly activeGroup = computed<RecommendationGroupType>(() =>
    this.groupOrder[this.activeGroupIndex()] ?? 'homologous-advancement',
  );
  readonly activeGroupLabel = computed(() => {
    const group = this.activeGroup();
    if (group === 'homologous-advancement') return '同源推进';
    if (group === 'cognitive-downgrade') return '认知降低';
    return '异步并发';
  });

  readonly projectMetaById = computed(() => {
    const map = new Map<string, RadarProjectMeta>();
    for (const project of this.projectStore.projects()) {
      map.set(project.id, {
        name: project.name || '未命名项目',
        color: this.readProjectColor(project),
      });
    }
    return map;
  });

  readonly comboEntries = computed(() => this.engine.comboSelectEntries());
  readonly backupEntries = computed(() => this.engine.backupEntries());
  readonly comboOverflowEntries = computed(() =>
    this.comboEntries().slice(this.comboVisibleLimit),
  );
  readonly backupOverflowEntries = computed(() =>
    this.backupEntries().slice(this.backupVisibleLimit),
  );
  readonly comboOverflowCount = computed(() => this.comboOverflowEntries().length);
  readonly backupOverflowCount = computed(() => this.backupOverflowEntries().length);

  readonly comboItems = computed(() =>
    this.layoutRadarEntries(
      this.comboEntries().slice(0, this.comboVisibleLimit),
      'combo-select',
      this.comboRadius,
      this.comboRadius * 0.84,
    ),
  );

  readonly backupItems = computed(() =>
    this.layoutRadarEntries(
      this.backupEntries().slice(0, this.backupVisibleLimit),
      'backup',
      this.backupRadius,
      this.backupRadius * 0.92,
    ),
  );

  ngOnDestroy(): void {
    if (this.longPressTimer) {
      clearTimeout(this.longPressTimer);
      this.longPressTimer = null;
    }
    if (this.promotionTimer) {
      clearTimeout(this.promotionTimer);
      this.promotionTimer = null;
    }
    for (const timer of this.hoverExitTimers.values()) {
      clearTimeout(timer);
    }
    this.hoverExitTimers.clear();
    for (const timer of this.focusExitTimers.values()) {
      clearTimeout(timer);
    }
    this.focusExitTimers.clear();
    for (const timer of this.enteringTimers.values()) {
      clearTimeout(timer);
    }
    this.enteringTimers.clear();
    for (const timer of this.radarReturnTimers.values()) {
      clearTimeout(timer);
    }
    this.radarReturnTimers.clear();
    if (this.overlayAvoidRefreshRaf !== null) {
      cancelAnimationFrame(this.overlayAvoidRefreshRaf);
      this.overlayAvoidRefreshRaf = null;
    }
  }

  @HostListener('window:resize')
  onViewportResize(): void {
    this.scheduleOverlayAvoidRectRefresh();
  }

  @HostListener('window:pointerup')
  onGlobalPointerUp(): void {
    this.scheduleOverlayAvoidRectRefresh();
  }

  getFloatDelay(taskId: string, lane: DockLane): string {
    const duration = lane === 'combo-select'
      ? PARKING_CONFIG.RADAR_FLOAT_DURATION_S
      : PARKING_CONFIG.RADAR_FLOAT_DURATION_S + 0.8;
    const phase = 0.2 + rand(hashCode(`${taskId}:${lane}:phase`)) * 0.72;
    return `${-(duration * phase).toFixed(2)}s`;
  }

  isHighlighted(taskId: string): boolean {
    return this.highlightedIds().has(taskId);
  }

  isRadarReturning(taskId: string): boolean {
    return this.radarReturningIds().has(taskId);
  }

  isMagnetSliding(taskId: string): boolean {
    return this.magnetSlidingIds().has(taskId);
  }

  isEntering(taskId: string): boolean {
    return !this.isRadarReturning(taskId) && this.enteringTaskIds().has(taskId);
  }

  shouldAnimate(taskId: string): boolean {
    if (this.isMagnetSliding(taskId)) return false;
    return this.enableRadarFloat
      || this.isHighlighted(taskId)
      || this.hoverFloatIds().has(taskId)
      || this.focusFloatIds().has(taskId);
  }

  /** Backward-compatible alias for existing tests/callers. */
  onRadarItemInteract(taskId: string): void {
    this.onRadarItemEnter(taskId);
  }

  onRadarItemEnter(taskId: string): void {
    this.clearHoverExitTimer(taskId);
    this.hoverFloatIds.update(prev => {
      if (prev.has(taskId)) return prev;
      const next = new Set(prev);
      next.add(taskId);
      return next;
    });
  }

  onRadarItemLeave(taskId: string): void {
    this.scheduleHoverFloatRemoval(taskId);
  }

  onRadarItemFocus(taskId: string): void {
    this.clearHoverExitTimer(taskId);
    this.focusFloatIds.update(prev => {
      if (prev.has(taskId)) return prev;
      const next = new Set(prev);
      next.add(taskId);
      return next;
    });
  }

  onRadarItemBlur(taskId: string): void {
    this.scheduleFocusFloatRemoval(taskId);
  }

  onWheel(event: WheelEvent, taskId: string): void {
    if (!this.canInteract()) return;
    if (event.altKey) {
      event.preventDefault();
      this.engine.toggleLoad(taskId, event.deltaY > 0 ? 'down' : 'up');
      return;
    }
    if (this.groupSwitchEnabled()) {
      event.preventDefault();
      this.cycleGroup(event.deltaY > 0 ? 1 : -1);
    }
  }

  onTouchStart(event: TouchEvent, taskId: string): void {
    if (!this.canInteract()) return;
    this.touchStartY = event.touches?.[0]?.clientY ?? 0;
    this.touchActiveTaskId = taskId;
    this.touchLongPressed = false;
    if (this.longPressTimer) clearTimeout(this.longPressTimer);
    this.longPressTimer = setTimeout(() => {
      this.touchLongPressed = true;
    }, PARKING_CONFIG.RADAR_PROMOTION_DELAY_MS);
  }

  onTouchMove(event: TouchEvent, taskId: string): void {
    if (!this.canInteract()) return;
    const deltaY = (event.touches?.[0]?.clientY ?? 0) - this.touchStartY;
    if (this.groupSwitchEnabled() && !this.touchLongPressed && Math.abs(deltaY) > PARKING_CONFIG.RADAR_SWIPE_THRESHOLD_PX) {
      this.cycleGroup(deltaY > 0 ? 1 : -1);
      this.touchStartY = event.touches?.[0]?.clientY ?? 0;
      return;
    }

    if (!this.touchLongPressed || this.touchActiveTaskId !== taskId) return;
    if (Math.abs(deltaY) < PARKING_CONFIG.RADAR_SWIPE_MIN_PX) return;
    this.engine.toggleLoad(taskId, deltaY > 0 ? 'down' : 'up');
    this.touchStartY = event.touches?.[0]?.clientY ?? 0;
  }

  onTouchEnd(): void {
    if (this.longPressTimer) {
      clearTimeout(this.longPressTimer);
      this.longPressTimer = null;
    }
    this.touchLongPressed = false;
    this.touchActiveTaskId = null;
  }

  onRadarItemKeydown(event: KeyboardEvent, taskId: string): void {
    if (!this.canInteract()) return;
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    this.promoteToConsole(taskId);
  }

  onRadarItemClick(event: MouseEvent, taskId: string): void {
    event.stopPropagation();
    this.promoteToConsole(taskId);
  }

  onOverflowEntryClick(event: MouseEvent, taskId: string): void {
    event.stopPropagation();
    this.promoteToConsole(taskId);
  }

  onRadarItemDoubleClick(event: MouseEvent, lane: DockLane): void {
    event.stopPropagation();
    this.openCreateForm(lane, event);
  }

  onComboOverflowTriggerClick(event: MouseEvent): void {
    event.stopPropagation();
    this.toggleComboOverflowPanel();
  }

  onBackupOverflowTriggerClick(event: MouseEvent): void {
    event.stopPropagation();
    this.toggleBackupOverflowPanel();
  }

  toggleComboOverflowPanel(): void {
    if (!this.canInteract()) return;
    if (this.comboOverflowCount() <= 0) {
      this.showComboOverflowPanel.set(false);
      return;
    }
    this.showComboOverflowPanel.update(prev => !prev);
    if (this.showComboOverflowPanel()) {
      this.showBackupOverflowPanel.set(false);
    }
  }

  toggleBackupOverflowPanel(): void {
    if (!this.canInteract()) return;
    if (this.backupOverflowCount() <= 0) {
      this.showBackupOverflowPanel.set(false);
      return;
    }
    this.showBackupOverflowPanel.update(prev => !prev);
    if (this.showBackupOverflowPanel()) {
      this.showComboOverflowPanel.set(false);
    }
  }

  promoteToConsole(taskId: string): void {
    if (!this.canInteract()) return;
    if (this.promotionLockTaskId() !== null) return;
    this.showComboOverflowPanel.set(false);
    this.showBackupOverflowPanel.set(false);
    this.promotionLockTaskId.set(taskId);
    this.magnetSlidingIds.update(prev => {
      const next = new Set(prev);
      next.add(taskId);
      return next;
    });
    if (this.promotionTimer) {
      clearTimeout(this.promotionTimer);
      this.promotionTimer = null;
    }
    this.promotionTimer = setTimeout(() => {
      this.promotionTimer = null;
      this.magnetSlidingIds.update(prev => {
        const next = new Set(prev);
        next.delete(taskId);
        return next;
      });
      // 专注模式下：插入到 C 位但不改变主任务，溢出卡片回到备选区
      if (this.engine.focusMode()) {
        this.engine.insertToConsoleFromRadar(taskId);
      } else {
        this.engine.setMainTask(taskId);
      }
      if (this.promotionLockTaskId() === taskId) {
        this.promotionLockTaskId.set(null);
      }
    }, PARKING_CONFIG.CONSOLE_MAGNET_PULL_MS);
  }

  openCreateForm(lane: DockLane, _event: MouseEvent): void {
    if (!this.canInteract()) return;
    this.showComboOverflowPanel.set(false);
    this.showBackupOverflowPanel.set(false);
    this.createFormLane.set(lane);
    this.createFormX = 0;
    this.createFormY = lane === 'combo-select'
      ? -(this.comboRadius - 24)
      : -(this.backupRadius - 24);
    this.createTitle = '';
    this.createLoad = 'low';
    this.createExpected = '';
    this.createWait = '';
  }

  closeCreateForm(): void {
    this.createFormLane.set(null);
  }

  submitCreate(): void {
    if (!this.canInteract()) return;
    const lane = this.createFormLane();
    if (!lane) return;
    const title = this.createTitle.trim();
    if (!title) return;

    const expectedMinutes = this.parseOptionalNumber(this.createExpected);
    const waitMinutes = this.parseOptionalNumber(this.createWait);

    this.engine.createInDock(title, lane, this.createLoad, {
      expectedMinutes,
      waitMinutes,
    });
    this.closeCreateForm();
  }

  formatTime(minutes: number): string {
    return formatDockMinutes(minutes);
  }

  getAppearDelay(taskId: string, lane: DockLane): string {
    const seed = hashCode(`${taskId}:${lane}:appear`);
    const minDelay = lane === 'combo-select' ? PARKING_CONFIG.RADAR_COMBO_MIN_DELAY_MS : PARKING_CONFIG.RADAR_BACKUP_MIN_DELAY_MS;
    const spread = lane === 'combo-select' ? PARKING_CONFIG.RADAR_COMBO_DELAY_SPREAD_MS : PARKING_CONFIG.RADAR_BACKUP_DELAY_SPREAD_MS;
    return `${Math.round(minDelay + (rand(seed) * spread))}ms`;
  }

  resolveOpacity(taskId: string, baseOpacity: number): number {
    if (!this.groupSwitchEnabled()) return baseOpacity;
    const group = this.pendingEntryGroupByTaskId().get(taskId);
    if (!group) return baseOpacity * 0.35;
    return group === this.activeGroup() ? baseOpacity : baseOpacity * 0.3;
  }

  resolveProjectName(entry: DockEntry): string {
    if (!entry.sourceProjectId) return '共享仓';
    return this.projectMetaById().get(entry.sourceProjectId)?.name ?? '未知项目';
  }

  resolveProjectColor(entry: DockEntry): string {
    if (!entry.sourceProjectId) return PARKING_CONFIG.RADAR_PROJECT_SHARED_COLOR;
    const explicit = this.projectMetaById().get(entry.sourceProjectId)?.color;
    if (explicit) return explicit;
    return this.hashProjectColor(entry.sourceProjectId);
  }

  private cycleGroup(step: 1 | -1): void {
    if (!this.groupSwitchEnabled()) return;
    this.activeGroupIndex.update(prev => {
      const total = this.groupOrder.length;
      return (prev + step + total) % total;
    });
  }

  private canInteract(): boolean {
    // 雷达区属于专注控制台 UI，scrim（背景虚化）遮挡的是 app 主体内容，
    // 不应阻止专注控制台内部的交互。仅在 focus 进入/退出过渡动画期间禁用。
    return !this.engine.isFocusTransitionBlocking();
  }

  private parseOptionalNumber(raw: string | number | null | undefined): number | null {
    if (raw === null || raw === undefined) return null;
    const value = typeof raw === 'string' ? raw.trim() : String(raw).trim();
    if (!value) return null;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return null;
    return Math.floor(parsed);
  }

  private layoutRadarEntries(
    entries: DockEntry[],
    lane: DockLane,
    radiusX: number,
    radiusY: number,
  ): RadarLayoutItem[] {
    this.overlayAvoidRects();
    return layoutEntries(
      entries,
      lane,
      radiusX,
      radiusY,
      this.radarLayoutConfig,
      this.pendingEntryGroupByTaskId(),
      this.overlayAvoidRects(),
    );
  }

  private scheduleHoverFloatRemoval(taskId: string): void {
    this.clearHoverExitTimer(taskId);
    const timer = setTimeout(() => {
      this.hoverExitTimers.delete(taskId);
      this.hoverFloatIds.update(prev => {
        if (!prev.has(taskId)) return prev;
        const next = new Set(prev);
        next.delete(taskId);
        return next;
      });
    }, this.hoverExitLingerMs);
    this.hoverExitTimers.set(taskId, timer);
  }

  private scheduleFocusFloatRemoval(taskId: string): void {
    this.clearFocusExitTimer(taskId);
    const timer = setTimeout(() => {
      this.focusExitTimers.delete(taskId);
      this.focusFloatIds.update(prev => {
        if (!prev.has(taskId)) return prev;
        const next = new Set(prev);
        next.delete(taskId);
        return next;
      });
    }, this.hoverExitLingerMs);
    this.focusExitTimers.set(taskId, timer);
  }

  private clearHoverExitTimer(taskId: string): void {
    const timer = this.hoverExitTimers.get(taskId);
    if (!timer) return;
    clearTimeout(timer);
    this.hoverExitTimers.delete(taskId);
  }

  private clearFocusExitTimer(taskId: string): void {
    const timer = this.focusExitTimers.get(taskId);
    if (!timer) return;
    clearTimeout(timer);
    this.focusExitTimers.delete(taskId);
  }

  private scheduleEnteringCleanup(taskId: string): void {
    this.clearEnteringTimer(taskId);
    const timer = setTimeout(() => {
      this.enteringTimers.delete(taskId);
      this.enteringTaskIds.update(prev => {
        if (!prev.has(taskId)) return prev;
        const next = new Set(prev);
        next.delete(taskId);
        return next;
      });
    }, PARKING_CONFIG.MOTION.radar.appearMs + PARKING_CONFIG.RADAR_APPEAR_BUFFER_MS);
    this.enteringTimers.set(taskId, timer);
  }

  private clearEnteringTimer(taskId: string): void {
    const timer = this.enteringTimers.get(taskId);
    if (!timer) return;
    clearTimeout(timer);
    this.enteringTimers.delete(taskId);
  }

  private clearRadarReturnTimer(taskId: string): void {
    const timer = this.radarReturnTimers.get(taskId);
    if (!timer) return;
    clearTimeout(timer);
    this.radarReturnTimers.delete(taskId);
  }

  private scheduleOverlayAvoidRectRefresh(): void {
    if (typeof window === 'undefined') return;
    if (this.overlayAvoidRefreshRaf !== null) {
      cancelAnimationFrame(this.overlayAvoidRefreshRaf);
    }
    this.overlayAvoidRefreshRaf = requestAnimationFrame(() => {
      this.overlayAvoidRefreshRaf = null;
      this.refreshOverlayAvoidRects();
    });
  }

  private refreshOverlayAvoidRects(): void {
    if (typeof document === 'undefined') {
      this.overlayAvoidRects.set([]);
      return;
    }

    const hostRect = this.hostElement.nativeElement.getBoundingClientRect();
    const originX = hostRect.left;
    const originY = hostRect.top;
    const selectors = [
      '[data-testid="dock-v3-status-machine-container"]',
      '[data-testid="dock-v3-focus-exit-btn"]',
      '[data-testid="dock-v3-hud-settings"]',
      '[data-testid="dock-v3-backup-fab"]',
      '[data-testid="dock-v3-pending-decision"]',
      '[data-testid="dock-v3-blank-period-card"]',
    ];

    const next: RadarAvoidRect[] = [];
    selectors.forEach(selector => {
      const element = document.querySelector<HTMLElement>(selector);
      if (!element) return;
      const rect = element.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) return;
      next.push({
        centerX: rect.left + (rect.width / 2) - originX,
        centerY: rect.top + (rect.height / 2) - originY,
        halfWidth: (rect.width / 2) + 12,
        halfHeight: (rect.height / 2) + 10,
      });
    });

    this.overlayAvoidRects.set(next);
  }

  private readProjectColor(project: unknown): string | null {
    if (!project || typeof project !== 'object') return null;
    const source = project as Record<string, unknown>;
    const color =
      source.color ??
      source.accentColor ??
      source.themeColor;
    if (typeof color !== 'string') return null;
    const normalized = color.trim();
    return normalized ? normalized : null;
  }

  private hashProjectColor(projectId: string): string {
    const palette = PARKING_CONFIG.RADAR_PROJECT_COLOR_PALETTE;
    const index = hashCode(projectId) % palette.length;
    return palette[index] ?? PARKING_CONFIG.RADAR_PROJECT_SHARED_COLOR;
  }
}
