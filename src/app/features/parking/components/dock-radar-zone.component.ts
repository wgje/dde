import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  HostListener,
  Input,
  AfterViewInit,
  OnChanges,
  OnDestroy,
  SimpleChanges,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { PARKING_CONFIG } from '../../../../config/parking.config';
import { DockEntry, DockLane, RecommendationGroupType } from '../../../../models/parking-dock';
import { DockEngineService } from '../../../../services/dock-engine.service';
import { ProjectStore } from '../../../core/state/stores';
import {
  RadarLayoutItem,
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

const RADAR_COMPACT_COMBO_VISIBLE_LIMIT = 3;
const RADAR_COMPACT_BACKUP_VISIBLE_LIMIT = 2;
const RADAR_VIEW_TRANSITION_MS = 240;

@Component({
  selector: 'app-dock-radar-zone',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [],
  styleUrl: './dock-radar-zone.component.scss',
  templateUrl: './dock-radar-zone.component.html',
})
export class DockRadarZoneComponent implements AfterViewInit, OnChanges, OnDestroy {
  private readonly engine = inject(DockEngineService);
  private readonly projectStore = inject(ProjectStore);
  private readonly hostElement = inject<ElementRef<HTMLElement>>(ElementRef);
  @Input() isMobile = false;
  @Input() canMutate = true;
  @Input() interactive = true;
  @Input() activeView: 'text' | 'flow' = 'text';

  readonly comboRadius = PARKING_CONFIG.RADAR_STRONG_RADIUS;
  readonly backupRadius = PARKING_CONFIG.RADAR_WEAK_RADIUS;
  readonly comboLayoutRadius = computed(() => this.viewMode() === 'panorama' ? this.comboRadius * 1.28 : this.comboRadius);
  readonly backupLayoutRadius = computed(() => this.viewMode() === 'panorama' ? this.backupRadius * 1.18 : this.backupRadius);
  readonly comboOpacity = PARKING_CONFIG.RADAR_STRONG_OPACITY;
  readonly backupOpacity = PARKING_CONFIG.RADAR_WEAK_OPACITY;
  readonly floatDuration = `${PARKING_CONFIG.RADAR_FLOAT_DURATION_S}s`;
  readonly backupFloatDuration = `${PARKING_CONFIG.RADAR_FLOAT_DURATION_S + 0.8}s`;
  readonly viewTransition = `${RADAR_VIEW_TRANSITION_MS}ms`;
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
  private readonly previewValidityEffect = effect(() => {
    if (!this.previewTaskId() || this.previewEntry()) return;
    untracked(() => this.closeTaskPreview());
  });
  private readonly focusExitResetEffect = effect(() => {
    if (this.engine.focusMode()) return;
    untracked(() => {
      this.viewMode.set('compact');
      this.showComboOverflowPanel.set(false);
      this.showBackupOverflowPanel.set(false);
      if (this.mobileTaskDrawerOpen()) this.closeMobileTaskDrawer();
      this.closeTaskPreview(false);
    });
  });
  private readonly overlayAvoidEffect = effect(() => {
    this.engine.focusMode();
    this.engine.focusTransition();
    this.comboEntries();
    this.backupEntries();
    this.scheduleOverlayAvoidRectRefresh();
  });

  private readonly promotionCleanupEffect = effect(() => {
    const lockedTaskId = this.promotionLockTaskId();
    if (!lockedTaskId) return;
    if (this.isRadarTaskVisible(lockedTaskId)) return;
    untracked(() => {
      this.clearPromotionTimer();
      this.magnetSlidingIds.update(prev => {
        if (!prev.has(lockedTaskId)) return prev;
        const next = new Set(prev);
        next.delete(lockedTaskId);
        return next;
      });
      if (this.promotionLockTaskId() === lockedTaskId) {
        this.promotionLockTaskId.set(null);
      }
    });
  });

  private readonly hoverExitTimers = new Map<string, ReturnType<typeof setTimeout>>();
  // M-11 fix: focus float 使用独立 timer map，避免与 hover 交叉取消
  private readonly focusExitTimers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly showComboOverflowPanel = signal(false);
  readonly showBackupOverflowPanel = signal(false);
  readonly viewMode = signal<'compact' | 'panorama'>('compact');
  readonly previewTaskId = signal<string | null>(null);
  readonly previewSource = signal<'radar-node' | 'overflow-stack' | 'mobile-rail' | 'task-drawer'>('radar-node');
  readonly mobileTaskDrawerOpen = signal(false);
  readonly announcement = signal('');
  private previewTriggerElement: HTMLElement | null = null;
  private mobileDrawerTriggerElement: HTMLElement | null = null;
  private mobileDrawerFocusRaf: number | null = null;
  private mobileDrawerOriginalParent: Node | null = null;
  private mobileDrawerOriginalNextSibling: Node | null = null;
  private mobileBackdropOriginalParent: Node | null = null;
  private mobileBackdropOriginalNextSibling: Node | null = null;
  private previousBodyOverflow: string | null = null;
  private mobileRailOriginalParent: Node | null = null;
  private mobileRailOriginalNextSibling: Node | null = null;
  private mobileRailPortalRaf: number | null = null;
  private radarControlsOriginalParent: Node | null = null;
  private radarControlsOriginalNextSibling: Node | null = null;
  private radarControlsPortalRaf: number | null = null;
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
  readonly orderedComboEntries = computed(() => this.orderActionableEntries(this.comboEntries()));
  readonly orderedBackupEntries = computed(() => this.orderActionableEntries(this.backupEntries()));
  readonly comboVisibleCount = computed(() => this.viewMode() === 'compact'
    ? RADAR_COMPACT_COMBO_VISIBLE_LIMIT
    : this.comboVisibleLimit);
  readonly backupVisibleCount = computed(() => this.viewMode() === 'compact'
    ? RADAR_COMPACT_BACKUP_VISIBLE_LIMIT
    : this.backupVisibleLimit);
  readonly visibleComboEntries = computed(() => this.orderedComboEntries().slice(0, this.comboVisibleCount()));
  readonly visibleBackupEntries = computed(() => this.orderedBackupEntries().slice(0, this.backupVisibleCount()));
  readonly mobileCandidateEntries = computed(() => this.orderedComboEntries().slice(0, RADAR_COMPACT_COMBO_VISIBLE_LIMIT));
  readonly mobileVisibleTaskCount = computed(() => this.mobileCandidateEntries().length);
  readonly comboOverflowEntries = computed(() =>
    this.orderedComboEntries().slice(this.comboVisibleCount()),
  );
  readonly backupOverflowEntries = computed(() =>
    this.orderedBackupEntries().slice(this.backupVisibleCount()),
  );
  readonly comboOverflowCount = computed(() => this.comboOverflowEntries().length);
  readonly backupOverflowCount = computed(() => this.backupOverflowEntries().length);
  readonly previewEntry = computed(() => {
    const taskId = this.previewTaskId();
    if (!taskId) return null;
    return this.comboEntries().find(entry => entry.taskId === taskId)
      ?? this.backupEntries().find(entry => entry.taskId === taskId)
      ?? null;
  });

  readonly comboItems = computed(() =>
    this.layoutRadarEntries(
      this.visibleComboEntries(),
      'combo-select',
      this.comboLayoutRadius(),
      this.comboLayoutRadius() * 0.84,
    ),
  );

  readonly backupItems = computed(() =>
    this.layoutRadarEntries(
      this.visibleBackupEntries(),
      'backup',
      this.backupLayoutRadius(),
      this.backupLayoutRadius() * 0.92,
    ),
  );

  ngOnDestroy(): void {
    if (this.promotionTimer !== null) {
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
    this.cancelMobileDrawerFocusRaf();
    this.restoreMobileDrawerFromBody();
    this.cancelMobileRailPortalRaf();
    this.restoreMobileRailFromBody();
    this.cancelRadarControlsPortalRaf();
    this.restoreRadarControlsFromBody();
  }

  ngAfterViewInit(): void {
    if (this.isMobile) this.scheduleMobileRailPortal();
    else this.scheduleRadarControlsPortal();
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['interactive'] && !this.interactive) {
      this.showComboOverflowPanel.set(false);
      this.showBackupOverflowPanel.set(false);
      if (this.mobileTaskDrawerOpen()) this.closeMobileTaskDrawer();
      this.closeTaskPreview(false);
    }
    if (changes['isMobile']) {
      if (this.isMobile) {
        this.cancelRadarControlsPortalRaf();
        this.restoreRadarControlsFromBody();
        this.scheduleMobileRailPortal();
      }
      else {
        if (this.mobileTaskDrawerOpen()) this.closeMobileTaskDrawer();
        this.cancelMobileRailPortalRaf();
        this.restoreMobileRailFromBody();
        this.scheduleRadarControlsPortal();
      }
    }
    if (!this.isMobile || this.activeView !== 'flow') return;
    this.viewMode.set('compact');
    this.showComboOverflowPanel.set(false);
    this.showBackupOverflowPanel.set(false);
    if (this.mobileTaskDrawerOpen()) this.closeMobileTaskDrawer();
    this.announcement.set('Flow 视图已打开，候选任务轨道仍可使用。');
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
    this.clearFocusExitTimer(taskId);
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

  onRadarItemClick(event: MouseEvent, taskId: string): void {
    event.stopPropagation();
    this.openTaskPreview(taskId, 'radar-node', event.currentTarget as HTMLElement);
  }

  onOverflowEntryClick(event: MouseEvent, taskId: string): void {
    event.stopPropagation();
    const lane = this.comboOverflowEntries().some(entry => entry.taskId === taskId) ? 'combo' : 'backup';
    const trigger = this.hostElement.nativeElement.querySelector<HTMLElement>(
      `[data-testid="dock-v3-radar-${lane}-overflow-trigger"]`,
    );
    this.openTaskPreview(taskId, 'overflow-stack', trigger);
  }

  setViewMode(mode: 'compact' | 'panorama'): void {
    if (!this.canPresent()) return;
    this.viewMode.set(mode);
    this.showComboOverflowPanel.set(false);
    this.showBackupOverflowPanel.set(false);
    this.closeTaskPreview(false);
  }

  selectGroup(group: RecommendationGroupType): void {
    if (!this.groupSwitchEnabled()) return;
    const index = this.groupOrder.indexOf(group);
    if (index >= 0) this.activeGroupIndex.set(index);
  }

  openTaskPreview(
    taskId: string,
    source: 'radar-node' | 'overflow-stack' | 'mobile-rail' | 'task-drawer' = 'radar-node',
    trigger: HTMLElement | null = null,
  ): void {
    if (!this.canPresent() || !this.isRadarTaskVisible(taskId)) return;
    this.previewTaskId.set(taskId);
    this.previewSource.set(source);
    this.previewTriggerElement = trigger ?? null;
    this.showComboOverflowPanel.set(false);
    this.showBackupOverflowPanel.set(false);
    if (this.isMobile) {
      const wasClosed = !this.mobileTaskDrawerOpen();
      this.mobileDrawerTriggerElement ??= trigger ?? null;
      this.mobileTaskDrawerOpen.set(true);
      if (wasClosed) {
        this.scheduleMobileDrawerFocus();
      }
    }
  }

  confirmPreviewPromotion(): void {
    const taskId = this.previewTaskId();
    if (!taskId || !this.canInteract() || this.promotionLockTaskId() !== null) return;
    if (this.isMobile && this.mobileTaskDrawerOpen()) {
      this.closeMobileTaskDrawer();
    } else {
      this.closeTaskPreview(false);
    }
    this.promoteToConsole(taskId);
  }

  togglePreviewLoad(): void {
    const entry = this.previewEntry();
    if (!entry || !this.canInteract()) return;
    this.engine.toggleLoad(entry.taskId, entry.load === 'low' ? 'up' : 'down');
  }

  commitPreviewMinutes(kind: 'expected' | 'wait', event: Event): void {
    const entry = this.previewEntry();
    if (!(event.target instanceof HTMLInputElement)) return;
    const value = event.target.value;
    const minutes = value.trim() ? Number(value) : null;
    if (!entry || !this.canInteract() || (minutes !== null && (!Number.isFinite(minutes) || minutes < 0))) return;
    const safeMinutes = minutes === null ? null : Math.floor(minutes);
    const save = kind === 'expected'
      ? this.engine.setExpectedTime(entry.taskId, safeMinutes)
      : this.engine.setWaitTime(entry.taskId, safeMinutes);
    void save.then(saved => {
      this.announcement.set(saved ? '规划时间已更新' : '规划时间未保存，请重试');
    });
  }

  openMobileTaskDrawer(event: MouseEvent): void {
    if (!this.canPresent()) return;
    this.mobileDrawerTriggerElement = event.currentTarget as HTMLElement;
    this.mobileTaskDrawerOpen.set(true);
    this.scheduleMobileDrawerFocus();
  }

  closeMobileTaskDrawer(): void {
    this.cancelMobileDrawerFocusRaf();
    this.restoreMobileDrawerFromBody();
    const restoreTarget = this.mobileDrawerTriggerElement ?? this.previewTriggerElement;
    this.mobileTaskDrawerOpen.set(false);
    this.closeTaskPreview(false);
    if (restoreTarget?.isConnected) restoreTarget.focus();
    this.mobileDrawerTriggerElement = null;
  }

  onMobileDrawerKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      if (this.previewTaskId()) this.closeTaskPreview(false);
      else this.closeMobileTaskDrawer();
      return;
    }
    if (event.key !== 'Tab') return;
    const controls = Array.from(document.querySelectorAll<HTMLElement>(
      '[data-testid="dock-v3-mobile-task-drawer"] button:not([disabled]), [data-testid="dock-v3-mobile-task-drawer"] [tabindex="0"]',
    )).filter(control => control.getClientRects().length > 0);
    if (controls.length === 0) return;
    const first = controls[0]!;
    const last = controls[controls.length - 1]!;
    const active = document.activeElement;
    if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }

  @HostListener('document:keydown.escape', ['$event'])
  onDocumentEscape(event: KeyboardEvent): void {
    if (this.mobileTaskDrawerOpen()) return;
    if (this.previewTaskId()) {
      event.preventDefault();
      event.stopPropagation();
      this.closeTaskPreview();
      return;
    }
    if (this.showComboOverflowPanel()) this.showComboOverflowPanel.set(false);
    if (this.showBackupOverflowPanel()) this.showBackupOverflowPanel.set(false);
  }

  closeTaskPreview(restoreFocus = true): void {
    const taskId = this.previewTaskId();
    this.previewTaskId.set(null);
    if (restoreFocus && !this.isMobile && this.previewTriggerElement?.isConnected) {
      this.previewTriggerElement.focus();
    } else if (!restoreFocus && this.isMobile && this.mobileTaskDrawerOpen() && taskId) {
      queueMicrotask(() => this.focusMobileTaskRow(taskId));
    }
    this.previewTriggerElement = null;
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
    this.clearPromotionTimer();
    this.promotionTimer = setTimeout(() => {
      this.promotionTimer = null;
      if (!this.isRadarTaskVisible(taskId)) {
        this.magnetSlidingIds.update(prev => {
          if (!prev.has(taskId)) return prev;
          const next = new Set(prev);
          next.delete(taskId);
          return next;
        });
        if (this.promotionLockTaskId() === taskId) {
          this.promotionLockTaskId.set(null);
        }
        return;
      }
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
      this.announcement.set(this.engine.focusMode() ? '已移入当前 Focus 的候选任务' : '已设为主任务');
      if (this.promotionLockTaskId() === taskId) {
        this.promotionLockTaskId.set(null);
      }
    }, PARKING_CONFIG.CONSOLE_MAGNET_PULL_MS);
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

  resolveStatusLabel(status: DockEntry['status']): string {
    switch (status) {
      case 'wait_finished': return '等待结束';
      case 'stalled': return '停滞';
      case 'pending_start': return '可行动';
      case 'suspended_waiting': return '等待中';
      case 'focusing': return '专注中';
      case 'completed': return '已完成';
      default: return '待处理';
    }
  }

  resolvePreviewReason(entry: DockEntry): string {
    if (entry.status === 'wait_finished') return '等待窗口已结束，先确认下一步再移入前台。';
    if (entry.status === 'stalled') return '任务处于停滞状态，先检查上下文再决定是否继续。';
    if (entry.status === 'suspended_waiting') return '任务仍在等待外部条件，可先检查等待时间。';
    const group = this.pendingEntryGroupByTaskId().get(entry.taskId);
    if (group === 'homologous-advancement') return '与当前工作同源，适合保持推进方向。';
    if (group === 'cognitive-downgrade') return '低负荷候选，适合作为恢复阶段的后续任务。';
    if (group === 'asynchronous-boot') return '任务可在等待其他工作时并行启动。';
    return entry.lane === 'backup' ? '这是待命任务，检查后可明确移入前台。' : '这是当前可行动候选，检查后再决定是否移入前台。';
  }

  private orderActionableEntries(entries: DockEntry[]): DockEntry[] {
    const priority: Record<DockEntry['status'], number> = {
      wait_finished: 0,
      stalled: 1,
      pending_start: 2,
      suspended_waiting: 3,
      focusing: 4,
      completed: 5,
    };
    return entries
      .map((entry, index) => ({ entry, index }))
      .sort((a, b) => priority[a.entry.status] - priority[b.entry.status] || a.index - b.index)
      .map(item => item.entry);
  }

  private canPresent(): boolean {
    return this.interactive && !this.engine.isFocusTransitionBlocking();
  }

  private canInteract(): boolean {
    return this.canMutate && this.canPresent();
  }

  private focusMobileDrawerCloseButton(): void {
    document.querySelector<HTMLElement>('[data-testid="dock-v3-mobile-task-drawer-close"]')
      ?.focus();
  }

  private scheduleMobileDrawerFocus(): void {
    this.cancelMobileDrawerFocusRaf();
    this.mobileDrawerFocusRaf = requestAnimationFrame(() => {
      this.mobileDrawerFocusRaf = null;
      this.portalMobileDrawerToBody();
      this.focusMobileDrawerCloseButton();
    });
  }

  private cancelMobileDrawerFocusRaf(): void {
    if (this.mobileDrawerFocusRaf === null) return;
    cancelAnimationFrame(this.mobileDrawerFocusRaf);
    this.mobileDrawerFocusRaf = null;
  }

  private portalMobileDrawerToBody(): void {
    if (typeof document === 'undefined') return;
    const drawer = this.hostElement.nativeElement.querySelector<HTMLElement>('[data-testid="dock-v3-mobile-task-drawer"]');
    const backdrop = this.hostElement.nativeElement.querySelector<HTMLElement>('[data-testid="dock-v3-mobile-drawer-backdrop"]');
    if (drawer && drawer.parentElement !== document.body) {
      this.mobileDrawerOriginalParent = drawer.parentNode;
      this.mobileDrawerOriginalNextSibling = drawer.nextSibling;
      document.body.appendChild(drawer);
    }
    if (backdrop && backdrop.parentElement !== document.body) {
      this.mobileBackdropOriginalParent = backdrop.parentNode;
      this.mobileBackdropOriginalNextSibling = backdrop.nextSibling;
      document.body.appendChild(backdrop);
    }
    this.previousBodyOverflow ??= document.body.style.overflow;
    document.body.style.overflow = 'hidden';
  }

  private restoreMobileDrawerFromBody(): void {
    if (typeof document === 'undefined') return;
    const drawer = document.querySelector<HTMLElement>('[data-testid="dock-v3-mobile-task-drawer"]');
    const backdrop = document.querySelector<HTMLElement>('[data-testid="dock-v3-mobile-drawer-backdrop"]');
    if (drawer && this.mobileDrawerOriginalParent) {
      this.mobileDrawerOriginalParent.insertBefore(drawer, this.mobileDrawerOriginalNextSibling);
    }
    if (backdrop && this.mobileBackdropOriginalParent) {
      this.mobileBackdropOriginalParent.insertBefore(backdrop, this.mobileBackdropOriginalNextSibling);
    }
    if (this.previousBodyOverflow !== null) {
      document.body.style.overflow = this.previousBodyOverflow;
      this.previousBodyOverflow = null;
    }
    this.mobileDrawerOriginalParent = null;
    this.mobileDrawerOriginalNextSibling = null;
    this.mobileBackdropOriginalParent = null;
    this.mobileBackdropOriginalNextSibling = null;
  }

  private scheduleMobileRailPortal(): void {
    if (typeof document === 'undefined' || this.mobileRailPortalRaf !== null) return;
    this.mobileRailPortalRaf = requestAnimationFrame(() => {
      this.mobileRailPortalRaf = null;
      const rail = this.hostElement.nativeElement.querySelector<HTMLElement>('[data-testid="dock-v3-mobile-candidate-rail"]');
      if (!rail || rail.parentElement === document.body) return;
      this.mobileRailOriginalParent = rail.parentNode;
      this.mobileRailOriginalNextSibling = rail.nextSibling;
      document.body.appendChild(rail);
    });
  }

  private cancelMobileRailPortalRaf(): void {
    if (this.mobileRailPortalRaf === null) return;
    cancelAnimationFrame(this.mobileRailPortalRaf);
    this.mobileRailPortalRaf = null;
  }

  private restoreMobileRailFromBody(): void {
    const rail = document.querySelector<HTMLElement>('[data-testid="dock-v3-mobile-candidate-rail"]');
    if (rail && this.mobileRailOriginalParent) {
      this.mobileRailOriginalParent.insertBefore(rail, this.mobileRailOriginalNextSibling);
    }
    this.mobileRailOriginalParent = null;
    this.mobileRailOriginalNextSibling = null;
  }

  private scheduleRadarControlsPortal(): void {
    if (typeof document === 'undefined' || this.radarControlsPortalRaf !== null) return;
    this.radarControlsPortalRaf = requestAnimationFrame(() => {
      this.radarControlsPortalRaf = null;
      const controls = this.hostElement.nativeElement.querySelector<HTMLElement>(
        '[data-testid="dock-v3-radar-edge-controls"]',
      );
      if (!controls || controls.parentElement === document.body) return;
      this.radarControlsOriginalParent = controls.parentNode;
      this.radarControlsOriginalNextSibling = controls.nextSibling;
      document.body.appendChild(controls);
    });
  }

  private cancelRadarControlsPortalRaf(): void {
    if (this.radarControlsPortalRaf === null) return;
    cancelAnimationFrame(this.radarControlsPortalRaf);
    this.radarControlsPortalRaf = null;
  }

  private restoreRadarControlsFromBody(): void {
    if (typeof document === 'undefined') return;
    const controls = document.querySelector<HTMLElement>('[data-testid="dock-v3-radar-edge-controls"]');
    if (controls && this.radarControlsOriginalParent) {
      this.radarControlsOriginalParent.insertBefore(controls, this.radarControlsOriginalNextSibling);
    }
    this.radarControlsOriginalParent = null;
    this.radarControlsOriginalNextSibling = null;
  }

  private focusMobileTaskRow(taskId: string): void {
    const encodedId = CSS.escape(taskId);
    this.hostElement.nativeElement
      .querySelector<HTMLElement>(`[data-testid="dock-v3-mobile-task-drawer"] [data-task-id="${encodedId}"]`)
      ?.focus();
  }

  private clearPromotionTimer(): void {
    if (this.promotionTimer === null) return;
    clearTimeout(this.promotionTimer);
    this.promotionTimer = null;
  }

  private isRadarTaskVisible(taskId: string): boolean {
    return this.comboEntries().some(item => item.taskId === taskId)
      || this.backupEntries().some(item => item.taskId === taskId);
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
    if (!this.hoverExitTimers.has(taskId)) return;
    clearTimeout(this.hoverExitTimers.get(taskId)!);
    this.hoverExitTimers.delete(taskId);
  }

  private clearFocusExitTimer(taskId: string): void {
    if (!this.focusExitTimers.has(taskId)) return;
    clearTimeout(this.focusExitTimers.get(taskId)!);
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
    if (!this.enteringTimers.has(taskId)) return;
    clearTimeout(this.enteringTimers.get(taskId)!);
    this.enteringTimers.delete(taskId);
  }

  private clearRadarReturnTimer(taskId: string): void {
    if (!this.radarReturnTimers.has(taskId)) return;
    clearTimeout(this.radarReturnTimers.get(taskId)!);
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
    const viewportCenterX = typeof window === 'undefined' ? 0 : window.innerWidth / 2;
    const viewportCenterY = typeof window === 'undefined' ? 0 : window.innerHeight / 2;
    this.hostElement.nativeElement.style.setProperty(
      '--radar-host-offset-x',
      `${hostRect.left + (hostRect.width / 2) - viewportCenterX}px`,
    );
    this.hostElement.nativeElement.style.setProperty(
      '--radar-host-offset-y',
      `${hostRect.top + (hostRect.height / 2) - viewportCenterY}px`,
    );
    const originX = hostRect.left;
    const originY = hostRect.top;
    const selectors = [
      '[data-testid="dock-v3-status-machine-container"]',
      '[data-testid="dock-v3-radar-edge-controls"]',
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
