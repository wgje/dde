import { DestroyRef, Injectable, OnDestroy, computed, effect, inject, signal } from '@angular/core';
import { PARKING_CONFIG } from '../config/parking.config';
import {
  CognitiveLoad,
  DailySlotEntry,
  DockLane,
  DockExitAction,
  DockSchedulerPhase,
  DockUiStatus,
  DockEntry,
  DockFocusTransitionState,
  DockPendingDecision,
  DockPendingDecisionEntry,
  DockRuleDecision,
  DockSessionState,
  DockSourceSection,
  DockSnapshot,
  DockTaskStatus,
  DockZoneSource,
  FragmentDefenseLevel,
  FragmentEventEntry,
  FocusSessionState,
  FocusTaskSlot,
  HighLoadCounter,
  StatusMachineEntry,
} from '../models/parking-dock';
import { SimpleSyncService, TaskStore } from '../core-bridge';
import { AuthService } from './auth.service';
import { BlackBoxService } from './black-box.service';
import { FocusPreferenceService } from './focus-preference.service';
import { GateService } from './gate.service';
import { LoggerService } from './logger.service';
import { ProjectStateService } from './project-state.service';
import { TaskOperationAdapterService } from './task-operation-adapter.service';
import { ToastService } from './toast.service';
import {
  checkBurnoutThreshold,
  computeThreeDimensionalRecommendation,
  createRuleDecision,
  effectiveExecMin,
  evaluateTimeRemaining,
  updateHighLoadCounter,
} from './dock-scheduler.rules';
import { sanitizePlannerFields } from '../utils/planner-fields';
import {
  DockSnapshotPersistenceService,
  type SnapshotNormalizeContext,
} from './dock-snapshot-persistence.service';
import { DockCloudSyncService } from './dock-cloud-sync.service';
import { DockCompletionFlowService } from './dock-completion-flow.service';
import { DockDailySlotService } from './dock-daily-slot.service';
import { DockFragmentRestService } from './dock-fragment-rest.service';
import { DockInlineCreationService } from './dock-inline-creation.service';
import { DockTaskSyncService } from './dock-task-sync.service';
import { DockZoneService } from './dock-zone.service';
import {
  buildConsoleVisibleOrderHint,
  buildOverflowMeta,
  findConsoleEvictionCandidate,
  getWaitRemainingSeconds,
  isAutoPromotableStatus,
  isConsoleBackgroundStatus,
  isWaitExpired,
  isWaitingLike,
  mapDockStatusToFocusStatus,
  mapDockStatusToUiStatus,
  resolveOrderingWindowMinutes,
  sortDockEntriesForDisplay,
  toStatusMachineEntry,
} from './dock-engine.utils';

@Injectable({
  providedIn: 'root',
})
export class DockEngineService implements OnDestroy {
  private readonly taskStore = inject(TaskStore);
  private readonly auth = inject(AuthService);
  private readonly focusPreferenceService = inject(FocusPreferenceService);
  private readonly gateService = inject(GateService);
  private readonly logger = inject(LoggerService).category('DockEngine');
  private readonly syncService = inject(SimpleSyncService);
  private readonly projectState = inject(ProjectStateService);
  private readonly taskOps = inject(TaskOperationAdapterService);
  private readonly blackBoxService = inject(BlackBoxService);
  private readonly toast = inject(ToastService);
  private readonly snapshotPersistence = inject(DockSnapshotPersistenceService);
  private readonly cloudSync = inject(DockCloudSyncService);
  private readonly fragmentRest = inject(DockFragmentRestService);
  private readonly zoneService = inject(DockZoneService);
  private readonly completionFlow = inject(DockCompletionFlowService);
  private readonly inlineCreation = inject(DockInlineCreationService);
  private readonly dailySlotService = inject(DockDailySlotService);
  private readonly taskSync = inject(DockTaskSyncService);
  private readonly destroyRef = inject(DestroyRef);

  readonly entries = signal<DockEntry[]>([]);
  readonly focusMode = signal(false);
  readonly focusTransition = signal<DockFocusTransitionState | null>(null);
  readonly dockExpanded = signal(true);
  readonly muteWaitTone = signal(false);
  readonly focusScrimOn = signal(true);
  readonly dailySlots = signal<DailySlotEntry[]>([]);
  readonly highlightedIds = signal<Set<string>>(new Set(), { equal: () => false });
  readonly pendingDecision = signal<DockPendingDecision | null>(null);
  readonly lastRuleDecision = signal<DockRuleDecision | null>(null);
  readonly tick = signal(0);
  readonly dailyResetDate = signal(this.dailySlotService.todayDateKey());

  // v3.0 倦怠检测信号（§7.8 NG-16b）
  readonly highLoadCounter = signal<HighLoadCounter>({ count: 0, windowStartAt: 0 });
  readonly burnoutTriggeredAt = signal<number | null>(null);
  // v3.0 碎片阶段防御等级（§7.8 四级防御体系）
  readonly fragmentDefenseLevel = signal<FragmentDefenseLevel>(1);
  readonly schedulerPhase = signal<DockSchedulerPhase>('active');
  // v3.0 三维推荐阵列缓存
  readonly lastRecommendationGroups = signal<import('../models/parking-dock').RecommendationGroup[]>([]);
  readonly lastExitAction = signal<DockExitAction | null>(null);
  // v3.0 碎片事件推荐（策划案 §7.8 Level 2/3）
  readonly activeFragmentEvent = computed(() => this.fragmentRest.activeFragmentEvent());
  /** 编辑锁（策划案 §4.1：C 位卡片编辑时抑制待决策超时分支） */
  readonly editLock = signal(false);

  // 雷达区点选插入主控台的协调信号（供 console-stack / radar-zone UI 组件读取）
  /** 最近一次从雷达区插入到主控台 C 位的 taskId（UI 触发 magnetPullIn 动画后清除） */
  readonly lastRadarInsertedTaskId = signal<string | null>(null);
  /** 最近一次因雷达插入而被淘汰回备选区的 taskId（UI 触发返回动画后清除） */
  readonly lastRadarEvictedTaskId = signal<string | null>(null);
  /** 待延迟淘汰的 taskId（Phase 1 暂存，Phase 2 flushRadarEviction 后清除） */
  readonly pendingRadarEviction = signal<string | null>(null);
  /** 最近一次从 C 位退居后台的任务，用于稳定保持第二张卡的视觉顺序 */
  private readonly lastConsoleDemotedTaskId = signal<string | null>(null);
  /** C 位四卡的可见顺序提示：选中项前置，其余存活项保持交互前相对顺序。 */
  private readonly consoleVisibleOrderHint = signal<string[]>([]);

  // GAP-1: 休息时间提醒——累计专注时长追踪（策划案：高负荷 90min / 低负荷 30min 轻提醒）
  /** 累计高负荷专注毫秒数（10s tick 累加，仅 focusMode + focusing 状态下增长） */
  readonly cumulativeHighLoadMs = computed(() => this.fragmentRest.cumulativeHighLoadMs());
  /** 累计低负荷专注毫秒数 */
  readonly cumulativeLowLoadMs = computed(() => this.fragmentRest.cumulativeLowLoadMs());
  /** 是否已触发休息提醒（高负荷通道） */
  readonly restReminderHighShown = computed(() => this.fragmentRest.restReminderHighShown());
  /** 是否已触发休息提醒（低负荷通道） */
  readonly restReminderLowShown = computed(() => this.fragmentRest.restReminderLowShown());
  /** 是否正在展示休息提醒光晕（UI 读取此信号渲染边缘光晕） */
  readonly restReminderActive = computed(() => this.fragmentRest.restReminderActive());

  // GAP-2: 碎片时间进入倒计时（策划案：给用户一个选择是否进入碎片时间的短时间倒计时）
  /** 碎片进入倒计时剩余秒数（null=不在倒计时状态） */
  readonly fragmentEntryCountdown = computed(() => this.fragmentRest.fragmentEntryCountdown());

  private readonly firstDragIntervened = signal(false);
  private readonly firstMainSelectionWindow = signal<{ taskId: string; expiresAt: number } | null>(null);
  private readonly suspendRecommendationLocked = signal(false);
  private readonly suspendChainRootTaskId = signal<string | null>(null);
  private readonly focusSessionContext = signal<{ id: string; startedAt: number } | null>(null);
  private readonly softLimitNoticeShown = signal(false);

  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private localPersistTimer: ReturnType<typeof setTimeout> | null = null;
  private firstMainSelectionTimer: ReturnType<typeof setTimeout> | null = null;
  private switchMaintenanceIdleId: number | null = null;
  private switchMaintenanceFallbackTimer: ReturnType<typeof setTimeout> | null = null;
  private switchMaintenanceToken = 0;
  private nonCriticalWorkHoldUntil = 0;
  /** 完成操作 FIFO 队列（策划案 §18.1：防止并发 completeTask 竞态） */
  private completionQueue: string[] = [];
  private isProcessingCompletion = false;
  private completionDrainTimer: ReturnType<typeof setTimeout> | null = null;
  private highlightClearTimer: ReturnType<typeof setTimeout> | null = null;
  private audioStopTimer: ReturnType<typeof setTimeout> | null = null;

  private currentSnapshotUserId: string | null = null;
  private isRestoringSnapshot = false;
  private waitEndNotifiedIds = new Set<string>();
  private visibilityListener: (() => void) | null = null;

  readonly dockedEntries = computed(() => this.entries().filter(entry => entry.status !== 'completed'));
  readonly orderedDockEntries = computed(() => sortDockEntriesForDisplay(
    this.dockedEntries(),
    (entry) => this.completionFlow.toSchedulerCandidate(entry),
    (entry) => this.zoneService.resolveSourceProjectId(entry),
  ));
  readonly dockedCount = computed(() => this.dockedEntries().length);
  readonly dockedTaskIds = computed(() => new Set(this.dockedEntries().map(entry => entry.taskId)));
  readonly dockCapacity = computed(() => {
    const count = this.dockedCount();
    const softLimit = PARKING_CONFIG.DOCK_CONSOLE_SOFT_LIMIT;
    const hardLimit = PARKING_CONFIG.DOCK_CONSOLE_HARD_LIMIT;
    return {
      count,
      softLimit,
      hardLimit,
      softReached: count >= softLimit,
      hardReached: count >= hardLimit,
    };
  });
  readonly firstMainSelectionPending = computed(() => this.firstMainSelectionWindow());
  readonly isFocusTransitionBlocking = computed(() => {
    const phase = this.focusTransition()?.phase ?? null;
    return phase === 'entering' || phase === 'exiting';
  });
  readonly consoleEntries = computed(() =>
    this.entries().filter(
      entry =>
        entry.status !== 'completed' &&
        (entry.isMain || entry.status === 'focusing' || isConsoleBackgroundStatus(entry.status)),
    ),
  );
  /**
   * 主控台 UI / 状态机共享的唯一可见 4 卡真相。
   * pendingRadarEviction 在动画期间立即从可见集合排除，避免短暂出现第 5 张。
   */
  readonly consoleVisibleEntries = computed(() => {
    const pendingEvictionTaskId = this.pendingRadarEviction();
    const visibleCandidates = pendingEvictionTaskId
      ? this.consoleEntries().filter(entry => entry.taskId !== pendingEvictionTaskId)
      : this.consoleEntries();
    return this.completionFlow
      .sortConsoleEntriesForDisplay(visibleCandidates)
      .slice(0, PARKING_CONFIG.CONSOLE_STACK_VISIBLE_MAX);
  });
  readonly focusingEntry = computed(() =>
    this.entries().find(entry => entry.status === 'focusing') ?? null,
  );
  readonly suspendedEntries = computed(() =>
    this.consoleVisibleEntries().filter(entry => isWaitingLike(entry.status)),
  );
  // v3.0 组合选择区域（策划案 §4.2 zone 重命名）
  // 排除 isMain / focusing / waitingLike，这些已在 consoleEntries（主控台）中展示
  readonly comboSelectEntries = computed(() =>
    this.entries().filter(
      entry =>
        !entry.isMain &&
        entry.lane === 'combo-select' &&
        entry.status !== 'completed' &&
        entry.status !== 'focusing' &&
        !isConsoleBackgroundStatus(entry.status),
    ),
  );
  // v3.0 备选区域（策划案 §4.3 zone 重命名）
  // 排除 isMain / focusing / waitingLike，这些已在 consoleEntries（主控台）中展示
  readonly backupEntries = computed(() =>
    this.entries().filter(
      entry =>
        !entry.isMain &&
        entry.lane === 'backup' &&
        entry.status !== 'completed' &&
        entry.status !== 'focusing' &&
        !isConsoleBackgroundStatus(entry.status),
    ),
  );
  // v3.0 倦怠状态（策划案 §7.8 NG-16b）
  readonly isBurnoutActive = computed(() => this.burnoutTriggeredAt() !== null);
  readonly isFragmentPhase = computed(() => {
    const docked = this.dockedEntries();
    return (
      this.fragmentEntryCountdown() === null
      && docked.length > 0
      && docked.every(entry => isWaitingLike(entry.status))
      && !this.fragmentRest.isFragmentDismissed()
    );
  });
  readonly availableDailySlots = computed(() =>
    this.dailySlots().filter(slot => slot.isEnabled && slot.todayCompletedCount < slot.maxDailyCount),
  );
  /** GAP-5: 碎片阶段可选的停泊坞任务（非挂起、非完成、非正在专注）*/
  readonly availableFragmentDockTasks = computed(() =>
    this.entries().filter(
      entry =>
        entry.status !== 'completed' &&
        entry.status !== 'focusing' &&
        !isWaitingLike(entry.status),
    ),
  );
  readonly statusMachineEntries = computed<StatusMachineEntry[]>(() => {
    this.tick();
    return this.consoleVisibleEntries()
      .filter(
        entry =>
          entry.isMain ||
          entry.status === 'focusing' ||
          entry.status === 'suspended_waiting' ||
          entry.status === 'wait_finished' ||
          entry.status === 'stalled',
      )
      .map(entry => toStatusMachineEntry(entry));
  });
  readonly pendingDecisionEntries = computed<DockPendingDecisionEntry[]>(() => {
    const pending = this.pendingDecision();
    if (!pending) return [];

    const entryMap = new Map(this.entries().map(entry => [entry.taskId, entry]));
    const flattened = pending.candidateGroups.flatMap(group =>
      group.taskIds.map(taskId => ({ taskId, group: group.type })),
    );
    return flattened
      .map(item => {
        const entry = entryMap.get(item.taskId);
        if (!entry) return null;
        return {
          taskId: entry.taskId,
          title: entry.title,
          group: item.group,
          lane: entry.lane,
          load: entry.load,
          expectedMinutes: entry.expectedMinutes,
          recommendedScore: entry.recommendedScore,
        } satisfies DockPendingDecisionEntry;
      })
      .filter((entry): entry is DockPendingDecisionEntry => !!entry);
  });

  constructor() {
    // Initialize completion flow service with engine signal references
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    this.completionFlow.init({
      entries: this.entries,
      pendingDecision: this.pendingDecision,
      highlightedIds: this.highlightedIds,
      lastRuleDecision: this.lastRuleDecision,
      lastRecommendationGroups: this.lastRecommendationGroups,
      schedulerPhase: this.schedulerPhase,
      fragmentDefenseLevel: this.fragmentDefenseLevel,
      lastConsoleDemotedTaskId: this.lastConsoleDemotedTaskId,
      consoleVisibleOrderHint: this.consoleVisibleOrderHint,
      focusingEntry: this.focusingEntry,
      focusMode: this.focusMode,
      suspendChainRootTaskId: this.suspendChainRootTaskId,
      highlightClearTimer: { get current() { return self.highlightClearTimer; }, set current(v) { self.highlightClearTimer = v; } },
    });

    // Initialize cloud sync service with engine callbacks
    this.cloudSync.init({
      exportSnapshot: () => this.exportSnapshot(),
      restoreSnapshot: (snapshot: DockSnapshot) => this.restoreSnapshot(snapshot),
      scheduleLocalPersist: (snapshot: DockSnapshot, userId: string) => this.scheduleLocalPersist(snapshot, userId),
      updateDailySlots: (updater: (prev: DailySlotEntry[]) => DailySlotEntry[]) => this.dailySlots.update(updater),
      getNonCriticalHoldDelay: () => this.getNonCriticalHoldDelay(),
      getFocusSessionContext: () => this.focusSessionContext(),
      setFocusSessionContext: (ctx: { id: string; startedAt: number }) => this.focusSessionContext.set(ctx),
      buildNormalizeContext: () => this.buildNormalizeContext(),
    });

    this.fragmentRest.init({
      enterFragmentPhase: (reason, rootTaskId, remainingMinutes) =>
        this.completionFlow.enterFragmentPhase(reason, rootTaskId, remainingMinutes),
      clearPendingDecisionState: () => {
        this.pendingDecision.set(null);
        this.highlightedIds.set(new Set());
        this.entries.update(prev => this.completionFlow.clearSystemSelectionOnEntries(prev));
      },
      entries: this.entries,
      focusMode: this.focusMode,
      schedulerPhase: this.schedulerPhase,
      fragmentDefenseLevel: this.fragmentDefenseLevel,
      burnoutTriggeredAt: this.burnoutTriggeredAt,
      highLoadCounter: this.highLoadCounter,
      focusingEntry: this.focusingEntry,
      lastRuleDecision: this.lastRuleDecision,
      isFragmentPhase: this.isFragmentPhase,
      getWaitRemainingSeconds: (entry) => getWaitRemainingSeconds(entry),
    });

    // Initialize inline creation service with engine signal references and callbacks
    this.inlineCreation.init({
      entries: this.entries,
      dockedCount: this.dockedCount,
      focusSessionContext: this.focusSessionContext,
      softLimitNoticeShown: this.softLimitNoticeShown,
      muteWaitTone: this.muteWaitTone,
      firstDragIntervened: this.firstDragIntervened,
      firstMainSelectionWindow: this.firstMainSelectionWindow,
      suspendChainRootTaskId: this.suspendChainRootTaskId,
      pendingDecision: this.pendingDecision,
      highlightedIds: this.highlightedIds,
      waitEndNotifiedIds: this.waitEndNotifiedIds,
      setMainTask: (taskId: string) => this.setMainTask(taskId),
      rebalanceAutoZones: () => this.rebalanceAutoZones(),
    });

    // Initialize daily slot service with engine signal references
    this.dailySlotService.init({
      dailySlots: this.dailySlots,
      dailyResetDate: this.dailyResetDate,
      schedulerPhase: this.schedulerPhase,
      fragmentDefenseLevel: this.fragmentDefenseLevel,
      isFragmentPhase: this.isFragmentPhase,
    });

    // 10 秒一次 tick，配合 CSS transition 平滑过渡（避免 1s 频率导致动画卡顿）
    this.tickTimer = setInterval(() => {
      this.tick.update(value => value + 1);
      // 将 signal 写入操作移到 setInterval 回调中，避免在 effect 中写入 entries
      // （Angular signal 反模式：effect 中读 tick → 写 entries → 级联 10+ computed 重算）
      this.checkWaitExpiry();
      this.checkPendingDecisionExpiry();
      this.dailySlotService.resetDailySlotsIfNeeded();
      // v3.0 倦怠冷却检查（§7.8 NG-16b）
      this.fragmentRest.checkBurnoutCooldown();
      // v3.0 碎片阶段防御等级动态更新
      if (this.focusMode()) {
        this.fragmentRest.updateFragmentDefenseLevel();
      }
      // GAP-1: 休息时间累计专注时长检查
      this.fragmentRest.tickRestReminderAccumulator(this.focusMode(), this.focusingEntry()?.load ?? null);
    }, 10_000);

    this.currentSnapshotUserId = this.auth.currentUserId();
    this.isRestoringSnapshot = true;
    void this.restoreLocalSnapshot(this.currentSnapshotUserId).finally(() => {
      this.isRestoringSnapshot = false;
    });

    effect(() => {
      const userId = this.auth.currentUserId();
      if (userId === this.currentSnapshotUserId) return;
      this.currentSnapshotUserId = userId;
      this.isRestoringSnapshot = true;
      void this.restoreLocalSnapshot(userId).finally(() => {
        this.isRestoringSnapshot = false;
      });
      if (userId) this.cloudSync.scheduleCloudPull(userId, true);
    });

    effect(() => {
      this.entries();
      this.focusMode();
      this.dockExpanded();
      this.muteWaitTone();
      this.focusScrimOn();
      this.firstDragIntervened();
      this.dailySlots();
      this.suspendChainRootTaskId();
      this.suspendRecommendationLocked();
      this.pendingDecision();
      this.lastRuleDecision();
      this.dailyResetDate();
      this.focusSessionContext();
      if (this.isRestoringSnapshot) return;

      // 延迟序列化到 persist 回调中执行（原来在此同步调用 exportSnapshot →
      // JSON.stringify 阻塞主线程 → 与动画帧竞争导致掉帧）
      this.scheduleLocalPersist(null, this.currentSnapshotUserId);
      if (this.currentSnapshotUserId) {
        this.cloudSync.scheduleCloudPush(this.currentSnapshotUserId, null);
      }
    });

    effect(() => {
      if (this.dockedCount() < PARKING_CONFIG.DOCK_CONSOLE_SOFT_LIMIT && this.softLimitNoticeShown()) {
        this.softLimitNoticeShown.set(false);
      }
    }, { allowSignalWrites: true });

    effect(() => {
      this.focusPreferenceService.preferences().routineResetHourLocal;
      this.dailySlotService.resetDailySlotsIfNeeded();
    }, { allowSignalWrites: true });

    effect(() => {
      const taskMap = this.taskStore.tasksMap();
      if (!taskMap) return;
      const externallyCompletedIds = this.entries()
        .filter(entry => {
          if (entry.sourceKind !== 'project-task' || entry.status === 'completed') return false;
          return taskMap.get(entry.taskId)?.status === 'completed';
        })
        .map(entry => entry.taskId);
      if (externallyCompletedIds.length === 0) return;
      queueMicrotask(() => {
        this.reconcileExternallyCompletedTasks(externallyCompletedIds);
      });
    });

    if (typeof document !== 'undefined') {
      this.visibilityListener = () => {
        if (document.visibilityState !== 'visible') return;
        if (!this.currentSnapshotUserId) return;
        this.cloudSync.scheduleCloudPull(this.currentSnapshotUserId, false);
      };
      document.addEventListener('visibilitychange', this.visibilityListener);
    }

    if (this.currentSnapshotUserId) {
      this.cloudSync.scheduleCloudPull(this.currentSnapshotUserId, true);
    }

    this.destroyRef.onDestroy(() => {
      if (this.tickTimer) {
        clearInterval(this.tickTimer);
        this.tickTimer = null;
      }
      if (this.completionDrainTimer) {
        clearTimeout(this.completionDrainTimer);
        this.completionDrainTimer = null;
      }
      this.completionQueue.length = 0;
      this.isProcessingCompletion = false;
      if (this.highlightClearTimer) {
        clearTimeout(this.highlightClearTimer);
        this.highlightClearTimer = null;
      }
      if (this.audioStopTimer) {
        clearTimeout(this.audioStopTimer);
        this.audioStopTimer = null;
      }
    });
  }

  ngOnDestroy(): void {
    if (this.localPersistTimer) {
      clearTimeout(this.localPersistTimer);
      this.localPersistTimer = null;
    }
    this.cloudSync.cancelTimers();
    if (this.firstMainSelectionTimer) {
      clearTimeout(this.firstMainSelectionTimer);
      this.firstMainSelectionTimer = null;
    }
    // GAP-2: 清除碎片进入倒计时
    this.fragmentRest.resetAll();
    this.cancelSwitchMaintenance();
    if (this.visibilityListener && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.visibilityListener);
      this.visibilityListener = null;
    }
  }

  // Public API
  dockTask(
    taskId: string,
    lane?: DockLane,
    options?: {
      sourceKind?: DockEntry['sourceKind'];
      sourceSection?: DockSourceSection;
      load?: CognitiveLoad;
      expectedMinutes?: number | null;
      waitMinutes?: number | null;
      detail?: string;
      zoneSource?: DockZoneSource;
    },
  ): boolean {
    if (this.entries().some(entry => entry.taskId === taskId)) return false;

    const task = this.taskStore.getTask(taskId);
    if (!task || task.status !== 'active') {
      this.logger.warn(`Task ${taskId} is missing or not active; reject docking.`);
      return false;
    }
    if (!this.inlineCreation.ensureDockCapacity(task.title || 'Untitled task')) return false;

    const sourceProjectId = this.taskSync.resolveTaskProjectId(taskId);
    const zoneSource: DockZoneSource = options?.zoneSource ?? (lane ? 'manual' : 'auto');
    const inferredRelation = lane
      ? {
          lane,
          relationScore: lane === 'combo-select' ? 100 : 20,
          relationReason: lane === 'combo-select' ? 'manual:combo-select' : 'manual:backup',
        }
      : this.zoneService.inferAutoLaneForTask(task, sourceProjectId, taskId);
    const normalizedLane = inferredRelation.lane;
    const inheritedLoad: CognitiveLoad = task.cognitive_load === 'high' ? 'high' : 'low';
    const plannerFields = sanitizePlannerFields({
      expectedMinutes: options?.expectedMinutes ?? task.expected_minutes,
      waitMinutes: options?.waitMinutes ?? task.wait_minutes,
      cognitiveLoad: options?.load ?? task.cognitive_load,
    });
    const entry: DockEntry = {
      taskId,
      title: task.title || 'Untitled task',
      sourceProjectId,
      status: 'pending_start',
      load: plannerFields.cognitiveLoad ?? inheritedLoad,
      expectedMinutes: plannerFields.expectedMinutes,
      waitMinutes: plannerFields.waitMinutes,
      waitStartedAt: null,
      lane: normalizedLane,
      zoneSource,
      isMain: false,
      dockedOrder: this.entries().length,
      detail: options?.detail ?? task.content ?? '',
      sourceKind: options?.sourceKind ?? 'project-task',
      sourceBlackBoxEntryId: null,
      inlineArchiveStatus: undefined,
      inlineArchivedTaskId: null,
      systemSelected: false,
      recommendedScore: null,
      sourceSection: options?.sourceSection,
      manualMainSelected: false,
      recommendationLocked: false,
      snoozeRingMuted: this.muteWaitTone(),
      relationScore: inferredRelation.relationScore,
      relationReason: inferredRelation.relationReason,
    };

    if (plannerFields.adjusted) {
      this.toast.info('已校正等待/预计时长', `等待时长不能超过预计时长，已同步调整为 ${plannerFields.expectedMinutes ?? 0} 分钟`);
    }

    this.entries.update(prev => [...prev, entry]);
    this.rebalanceAutoZones();
    this.taskSync.syncTaskPlannerFields(taskId, {
      expected_minutes: entry.expectedMinutes,
      cognitive_load: entry.load,
      wait_minutes: entry.waitMinutes,
    });

    if (!this.firstDragIntervened()) {
      this.setMainTask(taskId);
      this.firstDragIntervened.set(true);
    }
    return true;
  }

  /**
   * 统一外部拖拽入坞策略：
   * 文本/流程图拖拽默认进入备选区（backup），并视为手动分区。
   */
  dockTaskFromExternalDrag(taskId: string, sourceSection?: Extract<DockSourceSection, 'text' | 'flow'>): boolean {
    return this.dockTask(taskId, 'backup', {
      sourceSection,
      zoneSource: 'manual',
    });
  }

  createInDock(
    title: string,
    lane: DockLane,
    load: CognitiveLoad = 'low',
    options?: { expectedMinutes?: number | null; waitMinutes?: number | null; detail?: string },
  ): string | null {
    return this.inlineCreation.createInDock(title, lane, load, options);
  }

  private reconcileExternallyCompletedTasks(taskIds: string[]): void {
    for (const taskId of taskIds) {
      const entry = this.entries().find(item => item.taskId === taskId);
      const task = this.taskStore.getTask(taskId);
      if (!entry || entry.status === 'completed' || task?.status !== 'completed') continue;
      this.completeTask(taskId);
    }
  }

  getInlineArchiveCandidates(): DockEntry[] {
    return this.inlineCreation.getInlineArchiveCandidates();
  }

  archiveInlineEntriesToActiveProject(): { converted: number; failed: number } {
    return this.inlineCreation.archiveInlineEntriesToActiveProject();
  }

  setMainTask(taskId: string): void {
    if (this.focusMode()) {
      this.switchToTask(taskId);
      return;
    }

    this.entries.update(prev =>
      prev.map(entry =>
        entry.taskId === taskId
          ? { ...entry, isMain: true, systemSelected: false, manualMainSelected: true }
          : { ...entry, isMain: false },
      ),
    );
    this.completionFlow.clearPendingDecisionIfMatched(taskId);
    this.rebalanceAutoZones();
  }

  /**
   * 从雷达区（备选/组合选择）点选任务插入到主控台 C 位。
   * 不改变主任务标记（isMain），仅切换 focusing 状态。
   * 超出 CONSOLE_STACK_VISIBLE_MAX 的末尾卡片回到备选区。
   * 主任务不可被淘汰——如果溢出位是主任务，则淘汰其前一张非主任务卡片。
   *
   * @returns 被淘汰回备选区的 taskId，null 表示无淘汰
   */
  insertToConsoleFromRadar(taskId: string): string | null {
    this.fragmentRest.stopFragmentEntryCountdown();
    this.fragmentRest.setFragmentDismissed(false);

    const target = this.entries().find(e => e.taskId === taskId && e.status !== 'completed');
    if (!target) return null;

    const currentFocusId = this.focusingEntry()?.taskId ?? null;
    const preVisible = this.consoleVisibleEntries();
    let evictedTaskId: string | null = null;

    // 点击背景任务时，以“切换前可见 4 卡”决定淘汰对象。
    // 这样可以保证：
    // 1. 旧 C 位稳定后推到第二张
    // 2. 主任务永不被退回备选区
    // 3. 动画窗口内不会临时出现第 5 张卡
    if (preVisible.length >= PARKING_CONFIG.CONSOLE_STACK_VISIBLE_MAX) {
      evictedTaskId = findConsoleEvictionCandidate(preVisible, currentFocusId);
    }

    // Phase 1: 仅切换 focusing/stalled 状态，不立即淘汰。
    // 淘汰延迟到 UI 动画窗口结束后由 flushRadarEviction() 执行，
    // 避免 DOM 元素被 Angular @for 立即移除导致无退出过渡。
    // visibleStackEntries 限制为 4 张，溢出的淘汰候选自然超出渲染范围。
    this.entries.update(prev =>
      prev.map(entry => {
        if (entry.taskId === taskId) {
          return {
            ...entry,
            status: 'focusing' as DockTaskStatus,
            waitMinutes: null,
            waitStartedAt: null,
            systemSelected: false,
            recommendationLocked: false,
          };
        }
        if (currentFocusId && entry.taskId === currentFocusId) {
          return {
            ...entry,
            status: 'stalled' as DockTaskStatus,
          };
        }
        return entry;
      }),
    );
    if (currentFocusId && currentFocusId !== taskId) {
      this.lastConsoleDemotedTaskId.set(currentFocusId);
    }
    this.consoleVisibleOrderHint.set(
      buildConsoleVisibleOrderHint(preVisible, taskId, evictedTaskId),
    );

    // 设置协调信号：inserted 信号供 console-stack 触发 C 位入场动画。
    // evictedTaskId 通过 pendingRadarEviction 暂存,
    // 由 console-stack 动画结束后调用 flushRadarEviction() 执行淘汰，
    // flushRadarEviction 完成后才设置 lastRadarEvictedTaskId 触发雷达区返回动画。
    this.lastRadarInsertedTaskId.set(taskId);
    this.pendingRadarEviction.set(evictedTaskId);

    this.completionFlow.clearPendingDecisionIfMatched(taskId);
    this.scheduleSwitchMaintenance();
    return evictedTaskId;
  }

  /**
   * Phase 2: 将指定任务从主控台淘汰回备选区。
   * 由 console-stack 组件在动画窗口结束时调用，确保 DOM 退出过渡已完成。
   * 完成后设置 lastRadarEvictedTaskId 信号，触发雷达区返回入场动画。
   */
  flushRadarEviction(taskId: string): void {
    const entry = this.entries().find(e => e.taskId === taskId);
    if (!entry) return;
    // 安全检查：只淘汰仍在 console 中且非 focusing/主任务的卡片
    if (entry.status === 'focusing' || entry.isMain) return;
    this.entries.update(prev =>
      prev.map(e =>
        e.taskId === taskId
          ? {
              ...e,
              status: 'pending_start' as DockTaskStatus,
              lane: 'backup' as DockLane,
              zoneSource: 'auto' as DockZoneSource,
              relationReason: 'auto:evicted-from-console',
            }
          : e,
      ),
    );
    this.pendingRadarEviction.set(null);
    // 淘汰实际生效后触发雷达区返回入场动画
    this.lastRadarEvictedTaskId.set(taskId);
  }

  overrideFirstMainTask(taskId: string): void {
    const pending = this.firstMainSelectionWindow();
    if (!pending) {
      this.setMainTask(taskId);
      return;
    }
    const exists = this.entries().some(entry => entry.taskId === taskId && entry.status !== 'completed');
    if (!exists) return;
    if (!this.focusMode()) {
      this.setMainTask(taskId);
      this.clearFirstMainSelectionWindow();
      return;
    }

    const currentFocusId = this.focusingEntry()?.taskId ?? null;
    this.entries.update(prev =>
      prev.map(entry => {
        if (entry.taskId === taskId) {
          return {
            ...entry,
            isMain: true,
            status: 'focusing' as DockTaskStatus,
            waitMinutes: null,
            waitStartedAt: null,
            systemSelected: false,
            recommendationLocked: false,
            manualMainSelected: true,
          };
        }
        if (entry.taskId === currentFocusId) {
          return {
            ...entry,
            isMain: false,
            status: this.completionFlow.deriveBackgroundStatus(entry),
            systemSelected: false,
            recommendationLocked: false,
          };
        }
        return entry.isMain
          ? { ...entry, isMain: false }
          : entry;
      }),
    );
    if (currentFocusId && currentFocusId !== taskId) {
      this.lastConsoleDemotedTaskId.set(currentFocusId);
    }
    this.clearFirstMainSelectionWindow();
  }

  markExitAction(action: DockExitAction): void {
    this.lastExitAction.set(action);
  }

  clearDockForExit(): void {
    this.entries.set([]);
    this.dailySlots.set([]);
    this.pendingDecision.set(null);
    this.lastRuleDecision.set(null);
    this.highlightedIds.set(new Set());
    this.suspendRecommendationLocked.set(false);
    this.suspendChainRootTaskId.set(null);
    this.waitEndNotifiedIds.clear();
    this.firstDragIntervened.set(false);
    this.clearFirstMainSelectionWindow();
    this.pendingRadarEviction.set(null);
    this.lastConsoleDemotedTaskId.set(null);
    this.consoleVisibleOrderHint.set([]);
  }

  reorderDockEntries(sourceTaskId: string, targetTaskId: string): void {
    if (!sourceTaskId || !targetTaskId || sourceTaskId === targetTaskId) return;

    this.entries.update(prev => {
      const activeEntries = prev.filter(entry => entry.status !== 'completed');
      const sourceIndex = activeEntries.findIndex(entry => entry.taskId === sourceTaskId);
      const targetIndex = activeEntries.findIndex(entry => entry.taskId === targetTaskId);
      if (sourceIndex < 0 || targetIndex < 0) return prev;

      const reordered = [...activeEntries];
      const [moved] = reordered.splice(sourceIndex, 1);
      reordered.splice(targetIndex, 0, moved);

      const orderByTaskId = new Map<string, number>();
      reordered.forEach((entry, index) => {
        orderByTaskId.set(entry.taskId, index);
      });

      let changed = false;
      const next = prev.map(entry => {
        const nextOrder = orderByTaskId.get(entry.taskId);
        if (nextOrder === undefined) return entry;
        if (entry.dockedOrder === nextOrder && entry.manualOrder === nextOrder) return entry;
        changed = true;
        return {
          ...entry,
          dockedOrder: nextOrder,
          manualOrder: nextOrder,
        };
      });
      return changed ? next : prev;
    });
  }

  setDockExpanded(expanded: boolean): void {
    this.dockExpanded.set(expanded);
  }

  toggleMuteWaitTone(): void {
    const next = !this.muteWaitTone();
    this.muteWaitTone.set(next);
    this.entries.update(prev => prev.map(entry => ({ ...entry, snoozeRingMuted: next })));
  }

  toggleLoad(taskId: string, direction: 'up' | 'down'): void {
    const nextLoad: CognitiveLoad = direction === 'up' ? 'high' : 'low';
    this.entries.update(prev =>
      prev.map(entry => (entry.taskId === taskId ? { ...entry, load: nextLoad } : entry)),
    );
    this.taskSync.syncTaskPlannerFields(taskId, { cognitive_load: nextLoad });
  }

  setExpectedTime(taskId: string, minutes: number | null): void {
    const currentEntry = this.entries().find(entry => entry.taskId === taskId) ?? null;
    const plannerFields = sanitizePlannerFields({
      expectedMinutes: minutes,
      waitMinutes: currentEntry?.waitMinutes ?? null,
      cognitiveLoad: currentEntry?.load ?? null,
    });
    this.entries.update(prev =>
      prev.map(entry =>
        entry.taskId === taskId
          ? {
              ...entry,
              expectedMinutes: plannerFields.expectedMinutes,
              waitMinutes: plannerFields.waitMinutes,
            }
          : entry,
      ),
    );
    if (plannerFields.adjusted) {
      this.toast.info('已校正等待/预计时长', `等待时长不能超过预计时长，已同步调整为 ${plannerFields.expectedMinutes ?? 0} 分钟`);
    }
    this.taskSync.syncTaskPlannerFields(taskId, {
      expected_minutes: plannerFields.expectedMinutes,
      wait_minutes: plannerFields.waitMinutes,
    });
  }

  setWaitTime(taskId: string, minutes: number | null): void {
    const currentEntry = this.entries().find(entry => entry.taskId === taskId) ?? null;
    const plannerFields = sanitizePlannerFields({
      expectedMinutes: currentEntry?.expectedMinutes ?? null,
      waitMinutes: minutes,
      cognitiveLoad: currentEntry?.load ?? null,
    });
    this.entries.update(prev =>
      prev.map(entry =>
        entry.taskId === taskId
          ? {
              ...entry,
              expectedMinutes: plannerFields.expectedMinutes,
              waitMinutes: plannerFields.waitMinutes,
            }
          : entry,
      ),
    );
    if (plannerFields.adjusted) {
      this.toast.info('已校正等待/预计时长', `等待时长不能超过预计时长，已同步调整为 ${plannerFields.expectedMinutes ?? 0} 分钟`);
    }
    this.taskSync.syncTaskPlannerFields(taskId, {
      expected_minutes: plannerFields.expectedMinutes,
      wait_minutes: plannerFields.waitMinutes,
    });
  }

  setDetail(taskId: string, detail: string): void {
    this.entries.update(prev =>
      prev.map(entry => (entry.taskId === taskId ? { ...entry, detail } : entry)),
    );
    this.taskSync.syncTaskDetail(taskId, detail, {
      entries: this.entries(),
      focusSessionContext: this.focusSessionContext(),
    });
  }

  setLane(taskId: string, lane: DockLane, zoneSource: DockZoneSource = 'manual'): void {
    this.entries.update(prev =>
      prev.map(entry => (entry.taskId === taskId ? { ...entry, lane, zoneSource } : entry)),
    );
    if (zoneSource === 'auto') {
      this.rebalanceAutoZones();
    }
  }

  toggleFocusMode(): void {
    const next = !this.focusMode();
    this.focusMode.set(next);

    if (next) {
      // 进入专注模式时重置遮罩，确保完整专注 UI 可见
      this.focusScrimOn.set(true);
      this.focusSessionContext.set({
        id: crypto.randomUUID(),
        startedAt: Date.now(),
      });
      this.schedulerPhase.set('active');
      const focused = this.focusingEntry();
      if (!focused) {
        const candidate = this.consoleEntries().find(entry => isAutoPromotableStatus(entry.status));
        if (candidate) {
          this.completionFlow.promoteCandidate(candidate.taskId);
          this.lastRuleDecision.set(
            createRuleDecision({
              type: 'idle_promote',
              reason: '进入专注模式后自动将首个可运行任务推入主控台',
              recommendedTaskIds: [candidate.taskId],
            }),
          );
        }
      }

      const initialTaskId =
        this.focusingEntry()?.taskId ??
        this.entries().find(entry => entry.isMain && entry.status !== 'completed')?.taskId ??
        null;
      if (initialTaskId) {
        this.startFirstMainSelectionWindow(initialTaskId);
      }

      // v3.0 进入专注模式时更新碎片阶段防御等级（§7.8）
      this.fragmentRest.updateFragmentDefenseLevel();
      return;
    }

    this.clearFirstMainSelectionWindow();

    // 退出专注模式：批量重置状态。使用 queueMicrotask 延迟非关键信号写入，
    // 避免与 focusMode.set(false) 的 @if DOM 销毁在同一同步块竞争主线程。
    queueMicrotask(() => {
      this.suspendRecommendationLocked.set(false);
      this.suspendChainRootTaskId.set(null);
      this.pendingDecision.set(null);
      this.lastRuleDecision.set(null);
      this.highlightedIds.set(new Set());
      this.focusTransition.set(null);
      this.lastRecommendationGroups.set([]);
      this.schedulerPhase.set('active');
      // GAP-1: 退出专注模式时重置休息提醒累计
      this.fragmentRest.resetRestState();
      // GAP-2: 清除碎片倒计时
      this.fragmentRest.stopFragmentEntryCountdown();
      this.fragmentRest.setFragmentDismissed(false);
    });
  }

  toggleFocusScrim(): void {
    this.focusScrimOn.update(value => !value);
  }

  setFocusScrim(on: boolean): void {
    this.focusScrimOn.set(on);
  }

  beginFocusTransition(state: DockFocusTransitionState): void {
    this.focusTransition.set(state);
  }

  endFocusTransition(): void {
    this.focusTransition.set(null);
  }

  /**
   * Temporarily defer non-critical work (maintenance / persistence / cloud push)
   * so animation-critical frames can run without main-thread contention.
   */
  holdNonCriticalWork(durationMs: number): void {
    if (!Number.isFinite(durationMs)) return;
    const clamped = Math.max(0, Math.floor(durationMs));
    if (clamped === 0) return;
    const until = Date.now() + clamped;
    if (until > this.nonCriticalWorkHoldUntil) {
      this.nonCriticalWorkHoldUntil = until;
    }
  }

  completeTask(taskId: string): void {
    // FIFO 队列序列化（策划案 §18.1）：防止快速连续完成导致竞态
    this.completionQueue.push(taskId);
    if (this.isProcessingCompletion) return;
    this.drainCompletionQueue();
  }

  private drainCompletionQueue(): void {
    if (this.completionQueue.length === 0) {
      this.isProcessingCompletion = false;
      return;
    }
    this.isProcessingCompletion = true;
    const taskId = this.completionQueue.shift()!;
    this.executeCompleteTask(taskId);
    // 300ms 间隔处理下一个，给动画和信号传播留余量
    if (this.completionQueue.length > 0) {
      this.completionDrainTimer = setTimeout(() => {
        this.completionDrainTimer = null;
        this.drainCompletionQueue();
      }, 300);
    } else {
      this.isProcessingCompletion = false;
    }
  }

  private executeCompleteTask(taskId: string): void {
    const entry = this.entries().find(item => item.taskId === taskId);
    if (!entry) return;
    const wasMaster = entry.isMain;

    // v3.0 倦怠检测：高负荷任务完成时更新计数器（§7.8 NG-16b）
    if (entry.load === 'high') {
      const now = Date.now();
      const updated = updateHighLoadCounter(this.highLoadCounter(), now);
      this.highLoadCounter.set(updated);
      if (checkBurnoutThreshold(updated, now)) {
        this.burnoutTriggeredAt.set(now);
        this.logger.info('倦怠熔断触发：2h 内完成 ≥ 3 个高负荷任务');
      }
    }

    this.entries.update(prev =>
      prev.map(item =>
        item.taskId === taskId
          ? {
              ...item,
              status: 'completed' as DockTaskStatus,
              isMain: false,
              systemSelected: false,
              recommendedScore: null,
            }
          : item,
      ),
    );

    const task = this.taskStore.getTask(taskId);
    const projectId = this.taskSync.resolveTaskProjectId(taskId);
    if (task && projectId) {
      if (this.projectState.activeProjectId() === projectId) {
        this.taskOps.updateTaskStatus(taskId, 'completed');
      } else {
        this.taskSync.applyCrossProjectTaskPatch(taskId, projectId, {
          status: 'completed',
        });
      }
    }

    this.completionFlow.resolveAfterCompletion(taskId);
    if (wasMaster) {
      this.completionFlow.promoteFocusedTaskToMaster();
    }
    this.entries.update(prev => this.completionFlow.enforceSingleMainInvariant(prev));
    this.rebalanceAutoZones();
    this.refreshSuspendRecommendationLock();
    this.waitEndNotifiedIds.delete(taskId);
  }

  suspendTask(taskId: string, waitMinutes: number): void {
    const normalizedWait = Math.max(1, Math.floor(waitMinutes));
    const firstSuspendInChain = !this.suspendRecommendationLocked();

    this.entries.update(prev =>
      prev.map(entry =>
        entry.taskId === taskId
          ? {
              ...entry,
              status: 'suspended_waiting' as DockTaskStatus,
              waitMinutes: normalizedWait,
              waitStartedAt: new Date().toISOString(),
              isMain: entry.isMain,
              systemSelected: false,
            }
          : entry,
      ),
    );
    this.taskSync.syncTaskPlannerFields(taskId, { wait_minutes: normalizedWait });

    // 多层挂起嵌套检测（策划案 §7.9）：≥3 层同时挂起 → 直接进入碎片阶段
    const suspendNestingDepth = this.entries().filter(
      e => e.status === 'suspended_waiting' || e.status === 'wait_finished',
    ).length;
    if (suspendNestingDepth >= 3) {
      this.logger.info(`挂起嵌套深度 ${suspendNestingDepth} ≥ 3，自动进入碎片阶段`);
      this.completionFlow.enterFragmentPhase('挂起嵌套 ≥ 3 层，自动进入碎片阶段', taskId, normalizedWait);
      return;
    }

    if (firstSuspendInChain) {
      this.suspendChainRootTaskId.set(taskId);
      this.suspendRecommendationLocked.set(true);
      this.completionFlow.scheduleFirstSuspendRecommendation(taskId, normalizedWait);
      return;
    }

    this.completionFlow.promoteNext();
  }

  switchToTask(taskId: string): void {
    this.fragmentRest.stopFragmentEntryCountdown();
    this.fragmentRest.setFragmentDismissed(false);
    const target = this.entries().find(entry => entry.taskId === taskId && entry.status !== 'completed');
    if (!target) return;

    const preVisible = this.consoleVisibleEntries();
    const currentFocusId = this.focusingEntry()?.taskId ?? null;
    const currentFocus = currentFocusId
      ? this.entries().find(entry => entry.taskId === currentFocusId) ?? null
      : null;
    const pending = this.pendingDecision();
    const shouldClearPending = !!pending && this.completionFlow.pendingCandidateIds(pending).includes(taskId);

    const result = this.applySwitchEntries(taskId, currentFocusId, currentFocus, target, shouldClearPending);
    if (!result.committed) return;

    if (currentFocusId && currentFocusId !== taskId) {
      this.lastConsoleDemotedTaskId.set(currentFocusId);
    }
    this.consoleVisibleOrderHint.set(buildConsoleVisibleOrderHint(preVisible, taskId));
    this.scheduleSwitchMaintenance();

    if (result.unlockSuspendChain) {
      this.suspendRecommendationLocked.set(false);
      this.suspendChainRootTaskId.set(null);
      this.pendingDecision.set(null);
      this.highlightedIds.set(new Set());
      return;
    }

    if (shouldClearPending) {
      this.pendingDecision.set(null);
      this.highlightedIds.set(new Set());
    }
  }

  /** 切换任务 entries 更新逻辑（从 switchToTask 提取，降低方法体积） */
  private applySwitchEntries(
    taskId: string,
    currentFocusId: string | null,
    currentFocus: DockEntry | null,
    target: DockEntry,
    shouldClearPending: boolean,
  ): { committed: boolean; unlockSuspendChain: boolean } {
    let unlockSuspendChain = false;
    let committed = false;

    this.entries.update(prev => {
      let changed = false;
      let next = prev.map(entry => {
        if (entry.taskId === taskId) {
          changed = true;
          return {
            ...entry,
            isMain: entry.isMain,
            status: 'focusing' as DockTaskStatus,
            waitMinutes: null,
            waitStartedAt: null,
            systemSelected: false,
            recommendationLocked: false,
            manualMainSelected: entry.manualMainSelected,
          };
        }
        if (currentFocusId && entry.taskId === currentFocusId) {
          const backgroundStatus = this.completionFlow.deriveBackgroundStatus(entry, target, currentFocus);
          if (entry.status === backgroundStatus) return entry;
          changed = true;
          return { ...entry, status: backgroundStatus };
        }
        return entry;
      });

      if (shouldClearPending) {
        const cleared = this.completionFlow.clearSystemSelectionOnEntries(next);
        if (cleared !== next) { next = cleared; changed = true; }
      }

      const hasSuspended = next.some(entry => isWaitingLike(entry.status));
      if (!hasSuspended) {
        unlockSuspendChain = true;
        const unlocked = this.completionFlow.clearSuspendRecommendationStateOnEntries(next);
        if (unlocked !== next) { next = unlocked; changed = true; }
      }

      committed = changed;
      return changed ? next : prev;
    });

    return { committed, unlockSuspendChain: unlockSuspendChain };
  }

  choosePendingDecisionCandidate(taskId: string): void {
    const pending = this.pendingDecision();
    if (!pending) return;
    const candidateIds = this.completionFlow.pendingCandidateIds(pending);
    if (!candidateIds.includes(taskId)) return;

    const selectedId = taskId;
    const rejectedIds = candidateIds.filter(id => id !== selectedId);
    this.completionFlow.promoteCandidate(selectedId, false);
    this.pendingDecision.set(null);
    this.highlightedIds.set(new Set());

    this.entries.update(prev =>
      prev.map(entry => {
        if (entry.taskId === selectedId) {
          return {
            ...entry,
            isMain: entry.isMain,
            systemSelected: false,
            recommendationLocked: false,
            manualMainSelected: entry.manualMainSelected,
            recommendedScore: null,
          };
        }
        if (rejectedIds.includes(entry.taskId)) {
          return {
            ...entry,
            isMain: entry.isMain,
            systemSelected: false,
            recommendationLocked: false,
            recommendedScore: null,
          };
        }
        return {
          ...entry,
          systemSelected: false,
          recommendationLocked: false,
          recommendedScore: entry.systemSelected ? null : entry.recommendedScore,
        };
      }),
    );
    this.lastRuleDecision.set(
      createRuleDecision({
        type: 'completion_followup',
        reason: '异常时长分叉由用户手动决策',
        rootTaskId: pending.rootTaskId,
        recommendedTaskIds: [selectedId],
        remainingMinutes: pending.rootRemainingMinutes,
      }),
    );
  }

  cancelPendingDecisionAutoPromote(): void {
    const pending = this.pendingDecision();
    if (!pending) return;
    this.pendingDecision.set(null);
    this.highlightedIds.set(new Set());
    this.entries.update(prev => this.completionFlow.clearSystemSelectionOnEntries(prev));
    this.lastRuleDecision.set(
      createRuleDecision({
        type: 'completion_followup',
        reason: '用户收起推荐提示，保持当前状态',
        rootTaskId: pending.rootTaskId,
        recommendedTaskIds: [],
        remainingMinutes: pending.rootRemainingMinutes,
      }),
    );
  }

  removeFromDock(taskId: string): void {
    // 从完成队列中移除该任务，防止 removeFromDock 后 drainCompletionQueue 操作已移除的幽灵条目
    const queueIdx = this.completionQueue.indexOf(taskId);
    if (queueIdx !== -1) {
      this.completionQueue.splice(queueIdx, 1);
    }
    const removed = this.entries().find(entry => entry.taskId === taskId) ?? null;
    this.entries.update(prev => prev.filter(entry => entry.taskId !== taskId));
    if (removed?.isMain) {
      this.completionFlow.promoteFocusedTaskToMaster();
    }
    this.entries.update(prev => this.completionFlow.enforceSingleMainInvariant(prev));
    this.rebalanceAutoZones();
    this.waitEndNotifiedIds.delete(taskId);
    if (this.entries().length === 0) {
      this.pendingDecision.set(null);
      this.highlightedIds.set(new Set());
    }
    this.refreshSuspendRecommendationLock();
  }

  addDailySlot(title: string, maxDailyCount = 1): string {
    return this.dailySlotService.addDailySlot(title, maxDailyCount);
  }

  setDailySlotEnabled(id: string, enabled: boolean): void {
    this.dailySlotService.setDailySlotEnabled(id, enabled);
  }

  completeDailySlot(id: string): void {
    this.dailySlotService.completeDailySlot(id);
  }

  skipDailySlot(id: string): void {
    this.dailySlotService.skipDailySlot(id);
  }

  dismissZenMode(): void {
    this.fragmentRest.dismissZenMode();
  }

  /**
   * 碎片事件推荐（策划案 §7.8 Level 2）
   * 按 physical-crossover > digital-janitor > micro-progress 优先级
   * 从预置列表中随机选取一个推荐给用户
   */
  getFragmentEventRecommendation(): FragmentEventEntry | null {
    return this.fragmentRest.getFragmentEventRecommendation();
  }

  /**
   * 完成碎片事件（策划案 §7.8 Level 3→4）
   * 完成后不连发，直接进入 Zen Mode
   */
  completeFragmentEvent(): void {
    this.fragmentRest.completeFragmentEvent();
  }

  /**
   * 跳过碎片事件 → 展示日常任务槽（策划案 §7.8 Step 3.5→Step 4）
   */
  skipFragmentEvent(): void {
    this.fragmentRest.skipFragmentEvent();
  }

  /**
   * 获取编辑锁（C 位卡片输入框获焦时调用）
   * 持有锁期间抑制 pendingDecision 超时分支
   */
  acquireDockEditLock(): void {
    this.editLock.set(true);
  }

  /**
   * 释放编辑锁（C 位卡片输入框失焦时调用）
   */
  releaseDockEditLock(): void {
    this.editLock.set(false);
  }

  removeDailySlot(id: string): void {
    this.dailySlotService.removeDailySlot(id);
  }

  getWaitRemainingSeconds(entry: DockEntry): number | null {
    return getWaitRemainingSeconds(entry);
  }

  isWaitExpired(entry: DockEntry): boolean {
    return isWaitExpired(entry);
  }

  exportSnapshot(): DockSnapshot {
    const session = this.buildSessionState();
    return {
      version: 7,
      entries: this.entries(),
      focusMode: this.focusMode(),
      isDockExpanded: this.dockExpanded(),
      muteWaitTone: this.muteWaitTone(),
      session,
      firstDragDone: this.firstDragIntervened(),
      dailySlots: this.dailySlots(),
      suspendChainRootTaskId: this.suspendChainRootTaskId(),
      suspendRecommendationLocked: this.suspendRecommendationLocked(),
      pendingDecision: this.pendingDecision(),
      lastRuleDecision: this.lastRuleDecision(),
      dailyResetDate: this.dailyResetDate(),
      savedAt: new Date().toISOString(),
      // v3.0 专注模式会话状态（§2.5）
      focusSessionState: this.focusMode() ? this.buildFocusSessionState() : null,
    };
  }

  /**
   * 构建 FocusSessionState（策划案 §2.5）
   * 将当前 entries signal 映射为 FocusTaskSlot 格式
   */
  private buildFocusSessionState(): FocusSessionState {
    const context = this.ensureFocusSessionContext();
    const activeEntries = this.entries().filter(e => e.status !== 'completed');
    const toSlot = (entry: DockEntry, zone: 'command' | 'combo-select' | 'backup', idx: number): FocusTaskSlot => ({
      slotId: entry.taskId,
      taskId: entry.taskId,
      estimatedMinutes: entry.expectedMinutes,
      waitMinutes: entry.waitMinutes,
      cognitiveLoad: entry.load,
      focusStatus: mapDockStatusToFocusStatus(entry.status),
      zone,
      zoneIndex: idx,
      isMaster: entry.isMain,
      waitStartedAt: entry.waitStartedAt ? new Date(entry.waitStartedAt).getTime() : null,
      waitEndAt: entry.waitStartedAt && entry.waitMinutes
        ? new Date(entry.waitStartedAt).getTime() + entry.waitMinutes * 60_000
        : null,
      sourceProjectId: entry.sourceProjectId ?? null,
      sourceBlockType: entry.sourceKind === 'dock-created' ? 'text' : null,
      draggedInAt: Date.now(),
      isFirstBatch: entry.dockedOrder === 0,
      inlineTitle: entry.title,
      inlineDetail: entry.detail ?? null,
    });

    const commandTasks = activeEntries
      .filter(e => e.isMain)
      .map((e, i) => toSlot(e, 'command', i));
    const comboSelectTasks = activeEntries
      .filter(e => !e.isMain && e.lane === 'combo-select')
      .map((e, i) => toSlot(e, 'combo-select', i));
    const backupTasks = activeEntries
      .filter(e => !e.isMain && e.lane === 'backup')
      .map((e, i) => toSlot(e, 'backup', i));

    return {
      schemaVersion: 2,
      sessionId: context.id,
      sessionStartedAt: context.startedAt,
      isActive: true,
      isFocusOverlayOn: this.focusScrimOn(),
      commandCenterTasks: commandTasks,
      comboSelectTasks,
      backupTasks,
      hasFirstBatchSelected: this.firstDragIntervened(),
      routineSlotsShownToday: [],
      highLoadCounter: this.highLoadCounter(),
      burnoutTriggeredAt: this.burnoutTriggeredAt(),
    };
  }

  private ensureFocusSessionContext(seed?: { id?: string | null; startedAt?: number | null }): { id: string; startedAt: number } {
    const current = this.focusSessionContext();
    if (current) return current;

    const next = {
      id: typeof seed?.id === 'string' && seed.id ? seed.id : crypto.randomUUID(),
      startedAt:
        Number.isFinite(seed?.startedAt)
          ? Number(seed?.startedAt)
          : Date.now(),
    };
    this.focusSessionContext.set(next);
    return next;
  }

  restoreSnapshot(snapshot: DockSnapshot): void {
    const normalized = this.snapshotPersistence.normalizeSnapshot(snapshot, this.buildNormalizeContext());
    if (!normalized) return;
    const hydratedEntries = this.applySessionToEntries(normalized.entries, normalized.session);
    const recoveredEntries = this.snapshotPersistence.recoverLegacyExternalDragDefaultBackup(hydratedEntries);
    const recoveredWithMain = this.completionFlow.enforceSingleMainInvariant(
      recoveredEntries,
      normalized.session.mainTaskId,
    );

    this.isRestoringSnapshot = true;
    this.entries.set(recoveredWithMain);
    this.consoleVisibleOrderHint.set([]);
    this.focusMode.set(normalized.focusMode);
    this.dockExpanded.set(normalized.isDockExpanded);
    this.muteWaitTone.set(normalized.muteWaitTone);
    this.focusScrimOn.set(normalized.session.focusScrimOn);
    this.firstDragIntervened.set(normalized.session.firstDragIntervened);
    this.dailySlots.set(normalized.dailySlots);
    this.suspendChainRootTaskId.set(normalized.suspendChainRootTaskId);
    this.suspendRecommendationLocked.set(normalized.suspendRecommendationLocked);
    this.pendingDecision.set(normalized.pendingDecision);
    this.lastRuleDecision.set(normalized.lastRuleDecision ?? null);
    this.lastExitAction.set(null);
    this.focusTransition.set(null);
    this.clearFirstMainSelectionWindow();
    this.dailyResetDate.set(normalized.dailyResetDate);
    this.schedulerPhase.set(normalized.session.schedulerPhase ?? 'active');
    if (
      typeof normalized.session.focusSessionId === 'string' &&
      normalized.session.focusSessionId &&
      Number.isFinite(normalized.session.focusSessionStartedAt)
    ) {
      this.focusSessionContext.set({
        id: normalized.session.focusSessionId,
        startedAt: Number(normalized.session.focusSessionStartedAt),
      });
    } else if (normalized.focusMode) {
      this.ensureFocusSessionContext();
    } else {
      this.focusSessionContext.set(null);
    }
    // v3.0 恢复倦怠检测状态
    this.highLoadCounter.set(normalized.session.highLoadCounter ?? { count: 0, windowStartAt: 0 });
    this.burnoutTriggeredAt.set(normalized.session.burnoutTriggeredAt ?? null);
    this.rebalanceAutoZones();
    this.isRestoringSnapshot = false;
    this.refreshSuspendRecommendationLock();
    // 恢复快照后立即检查过期等待（策划案：跨天恢复不等 10s tick）
    this.checkWaitExpiry();
  }

  reset(): void {
    this.entries.set([]);
    this.consoleVisibleOrderHint.set([]);
    this.focusMode.set(false);
    this.dockExpanded.set(true);
    this.muteWaitTone.set(false);
    this.focusScrimOn.set(true);
    this.firstDragIntervened.set(false);
    this.dailySlots.set([]);
    this.suspendChainRootTaskId.set(null);
    this.suspendRecommendationLocked.set(false);
    this.pendingDecision.set(null);
    this.lastRuleDecision.set(null);
    this.lastExitAction.set(null);
    this.focusTransition.set(null);
    this.clearFirstMainSelectionWindow();
    this.focusSessionContext.set(null);
    this.highlightedIds.set(new Set());
    this.dailyResetDate.set(this.dailySlotService.todayDateKey());
    // v3.0 重置倦怠检测状态
    this.highLoadCounter.set({ count: 0, windowStartAt: 0 });
    this.burnoutTriggeredAt.set(null);
    this.fragmentDefenseLevel.set(1);
    this.lastRecommendationGroups.set([]);
    this.fragmentRest.resetAll();
    this.editLock.set(false);
    this.schedulerPhase.set('active');
    this.waitEndNotifiedIds.clear();
    this.lastConsoleDemotedTaskId.set(null);
  }

  private scheduleSwitchMaintenance(): void {
    this.cancelSwitchMaintenance();
    const scheduleCore = () => {
      const holdDelay = this.getNonCriticalHoldDelay();
      if (holdDelay > 0) {
        this.switchMaintenanceFallbackTimer = setTimeout(scheduleCore, holdDelay);
        return;
      }

      const token = ++this.switchMaintenanceToken;
      const run = () => {
        if (token !== this.switchMaintenanceToken) return;
        // 互斥清理：无论是 idleCallback 还是 fallback 先触发，都清除对方
        if (this.switchMaintenanceIdleId !== null) {
          const gi = globalThis as typeof globalThis & { cancelIdleCallback?: (handle: number) => void };
          if (typeof gi.cancelIdleCallback === 'function') {
            gi.cancelIdleCallback(this.switchMaintenanceIdleId);
          }
          this.switchMaintenanceIdleId = null;
        }
        if (this.switchMaintenanceFallbackTimer) {
          clearTimeout(this.switchMaintenanceFallbackTimer);
          this.switchMaintenanceFallbackTimer = null;
        }
        this.entries.update(prev => this.zoneService.rebalanceAutoZonesEntries(prev));
        this.refreshSuspendRecommendationLock();
      };

      const g = globalThis as typeof globalThis & {
        requestIdleCallback?: (
          cb: (deadline: { didTimeout: boolean; timeRemaining: () => number }) => void,
          options?: { timeout: number },
        ) => number;
      };

      if (typeof g.requestIdleCallback === 'function') {
        this.switchMaintenanceIdleId = g.requestIdleCallback(() => run(), { timeout: 120 });
        this.switchMaintenanceFallbackTimer = setTimeout(run, 140);
        return;
      }

      this.switchMaintenanceFallbackTimer = setTimeout(run, 0);
    };

    scheduleCore();
  }

  private cancelSwitchMaintenance(): void {
    const g = globalThis as typeof globalThis & {
      cancelIdleCallback?: (handle: number) => void;
    };

    if (this.switchMaintenanceIdleId !== null && typeof g.cancelIdleCallback === 'function') {
      g.cancelIdleCallback(this.switchMaintenanceIdleId);
    }
    this.switchMaintenanceIdleId = null;

    if (this.switchMaintenanceFallbackTimer) {
      clearTimeout(this.switchMaintenanceFallbackTimer);
      this.switchMaintenanceFallbackTimer = null;
    }
  }

  private buildNormalizeContext(): SnapshotNormalizeContext {
    return {
      muteWaitTone: this.muteWaitTone(),
      todayDateKey: this.dailySlotService.todayDateKey(),
      buildOverflowMeta: (entries) => buildOverflowMeta(entries),
    };
  }

  private getNonCriticalHoldDelay(nowMs: number = Date.now()): number {
    return Math.max(0, this.nonCriticalWorkHoldUntil - nowMs);
  }

  private rebalanceAutoZones(): void {
    this.entries.update(prev => this.zoneService.rebalanceAutoZonesEntries(prev));
  }

  private startFirstMainSelectionWindow(taskId: string): void {
    this.clearFirstMainSelectionWindow();
    const expiresAt = Date.now() + PARKING_CONFIG.FIRST_MAIN_OVERRIDE_WINDOW_MS;
    this.firstMainSelectionWindow.set({ taskId, expiresAt });
    this.firstMainSelectionTimer = setTimeout(() => {
      this.firstMainSelectionTimer = null;
      this.firstMainSelectionWindow.set(null);
    }, PARKING_CONFIG.FIRST_MAIN_OVERRIDE_WINDOW_MS);
  }

  private clearFirstMainSelectionWindow(): void {
    if (this.firstMainSelectionTimer) {
      clearTimeout(this.firstMainSelectionTimer);
      this.firstMainSelectionTimer = null;
    }
    this.firstMainSelectionWindow.set(null);
  }

  private buildSessionState(entries: DockEntry[] = this.entries()): DockSessionState {
    const activeEntries = entries.filter(entry => entry.status !== 'completed');
    const mainCandidate =
      activeEntries.find(entry => entry.status === 'focusing') ??
      activeEntries.find(entry => entry.isMain) ??
      null;
    return {
      firstDragIntervened: this.firstDragIntervened(),
      focusBlurOn: this.focusMode(),
      focusScrimOn: this.focusScrimOn(),
      focusSessionId: this.focusSessionContext()?.id,
      focusSessionStartedAt: this.focusSessionContext()?.startedAt,
      mainTaskId: mainCandidate?.taskId ?? null,
      comboSelectIds: activeEntries
        .filter(entry => !entry.isMain && entry.lane === 'combo-select')
        .map(entry => entry.taskId),
      backupIds: activeEntries
        .filter(entry => !entry.isMain && entry.lane === 'backup')
        .map(entry => entry.taskId),
      highLoadCounter: this.highLoadCounter(),
      burnoutTriggeredAt: this.burnoutTriggeredAt(),
      hasFirstBatchSelected: this.firstDragIntervened(),
      schedulerPhase: this.schedulerPhase(),
      overflowMeta: buildOverflowMeta(activeEntries),
    };
  }

  private applySessionToEntries(entries: DockEntry[], session: DockSessionState): DockEntry[] {
    const comboSet = new Set(session.comboSelectIds);
    const backupSet = new Set(session.backupIds);
    const hasLaneHints = comboSet.size > 0 || backupSet.size > 0;
    let hydrated = entries;

    if (!session.mainTaskId) {
      if (hasLaneHints) {
        hydrated = entries.map(entry => {
          if (entry.status === 'completed' || entry.isMain) return entry;
          if (comboSet.has(entry.taskId)) return { ...entry, lane: 'combo-select' };
          if (backupSet.has(entry.taskId)) return { ...entry, lane: 'backup' };
          return entry;
        });
      }
      return this.completionFlow.enforceSingleMainInvariant(hydrated, null);
    }

    const hasMain = entries.some(entry => entry.isMain && entry.status !== 'completed');
    if (hasMain || !entries.some(entry => entry.taskId === session.mainTaskId)) {
      if (hasLaneHints) {
        hydrated = entries.map(entry => {
          if (entry.status === 'completed' || entry.isMain) return entry;
          if (comboSet.has(entry.taskId)) return { ...entry, lane: 'combo-select' };
          if (backupSet.has(entry.taskId)) return { ...entry, lane: 'backup' };
          return entry;
        });
      }
      return this.completionFlow.enforceSingleMainInvariant(hydrated, session.mainTaskId);
    }

    hydrated = entries.map(entry =>
      entry.status === 'completed'
        ? entry
        : entry.taskId === session.mainTaskId
          ? { ...entry, isMain: true }
          : hasLaneHints && !entry.isMain
            ? comboSet.has(entry.taskId)
              ? { ...entry, lane: 'combo-select' }
              : backupSet.has(entry.taskId)
                ? { ...entry, lane: 'backup' }
                : entry
            : entry,
    );
    return this.completionFlow.enforceSingleMainInvariant(hydrated, session.mainTaskId);
  }

  private refreshSuspendRecommendationLock(): void {
    const hasSuspended = this.entries().some(entry => isWaitingLike(entry.status));
    if (hasSuspended) return;

    this.suspendRecommendationLocked.set(false);
    this.suspendChainRootTaskId.set(null);
    this.pendingDecision.set(null);
    this.highlightedIds.set(new Set());
    this.entries.update(prev => this.completionFlow.clearSuspendRecommendationStateOnEntries(prev));
  }

  private checkWaitExpiry(): void {
    let shouldPlaySound = false;
    this.entries.update(prev => {
      let changed = false;
      const next = [...prev];
      for (let index = 0; index < prev.length; index += 1) {
        const entry = prev[index];
        if (entry.status !== 'suspended_waiting' || !entry.waitStartedAt || !entry.waitMinutes) continue;
        if (!isWaitExpired(entry)) continue;
        changed = true;
        if (!this.waitEndNotifiedIds.has(entry.taskId)) {
          this.waitEndNotifiedIds.add(entry.taskId);
          shouldPlaySound = true;
        }
        next[index] = { ...entry, status: 'wait_finished' as DockTaskStatus };
      }
      return changed ? next : prev;
    });
    if (shouldPlaySound) {
      this.playWaitEndSound();
    }
  }

  private checkPendingDecisionExpiry(): void {
    const pending = this.pendingDecision();
    if (!pending?.expiresAt) return;
    // 编辑锁持有期间、Gate 审查中不执行待决策超时分支（策划案 §4.1 + §7.5）
    if (this.editLock()) return;
    if (this.gateService.isActive()) return;
    if (this.completionFlow.pendingCandidateIds(pending).length > 0) return;
    const expiresAt = Date.parse(pending.expiresAt);
    if (Number.isNaN(expiresAt)) return;
    if (Date.now() < expiresAt) return;
    this.pendingDecision.set(null);
    this.highlightedIds.set(new Set());
    this.entries.update(prev =>
      prev.map(entry => ({
        ...entry,
        systemSelected: false,
        recommendationLocked: false,
      })),
    );

    // pendingCandidateIds is guaranteed empty here (early-returned above otherwise)
    this.completionFlow.enterFragmentPhase('tight-blank 超时，自动进入留白期', pending.rootTaskId, pending.rootRemainingMinutes);
  }

  private playWaitEndSound(): void {
    if (this.muteWaitTone()) return;
    try {
      const audio = new AudioContext();
      const oscillator = audio.createOscillator();
      const gain = audio.createGain();
      oscillator.connect(gain);
      gain.connect(audio.destination);
      oscillator.frequency.value = PARKING_CONFIG.STATUS_MACHINE_NOTIFICATION_TONE_HZ;
      gain.gain.value = 0.08;
      oscillator.start();
      this.audioStopTimer = setTimeout(() => {
        this.audioStopTimer = null;
        oscillator.stop();
        void audio.close();
      }, PARKING_CONFIG.STATUS_MACHINE_NOTIFICATION_DURATION_MS + 20);
    } catch {
      // Ignore audio failures.
    }
  }

  private scheduleLocalPersist(_snapshot: DockSnapshot | null, userId: string | null): void {
    this.snapshotPersistence.scheduleLocalPersist(
      () => this.exportSnapshot(),
      userId,
      () => this.getNonCriticalHoldDelay(),
    );
  }

  /** 保留内部委托，供 spec 通过 (service as any).todayDateKey() 访问 */
  private todayDateKey(now?: Date): string {
    return this.dailySlotService.todayDateKey(now);
  }

  private async restoreLocalSnapshot(userId: string | null): Promise<void> {
    const ctx = this.buildNormalizeContext();
    const normalized = await this.snapshotPersistence.restoreLocalSnapshot(userId, ctx);
    if (normalized) {
      this.restoreSnapshot(normalized);
      return;
    }
    this.reset();
  }

  // ============================================
  // GAP-1 & GAP-2: Delegated to DockFragmentRestService
  // ============================================

  /**
   * 用户确认/关闭休息提醒（UI 调用）
   * 重置提醒状态以允许下一轮累计触发
   */
  dismissRestReminder(): void {
    this.fragmentRest.dismissRestReminder();
  }

  /**
   * 开始碎片时间进入倒计时
   * 在等待插入任务完成后、主任务仍有剩余等待时间时调用
   */
  startFragmentEntryCountdown(context?: {
    reason?: string;
    rootTaskId?: string;
    remainingMinutes?: number;
    preservePendingDecision?: boolean;
    countdownSeconds?: number;
  }): void {
    this.fragmentRest.startFragmentEntryCountdown(context);
  }

  /** 用户在倒计时内主动选择进入碎片时间 */
  acceptFragmentEntry(): void {
    this.fragmentRest.acceptFragmentEntry();
  }

  /** 用户在倒计时内主动跳过碎片时间 */
  skipFragmentEntry(): void {
    this.fragmentRest.skipFragmentEntry();
  }

  /**
   * v3.0 使用三维推荐阵列增强挂起推荐（策划案 §4.2.4）
   * 在首次挂起时触发，替代原始单分数排序
   */
  computeRecommendationForSuspended(suspendedTaskId: string, waitMinutes: number): void {
    const suspendedEntry = this.entries().find(e => e.taskId === suspendedTaskId);
    if (!suspendedEntry) return;

    const mainSlot = this.completionFlow.toFocusTaskSlot(suspendedEntry, 'command', 0);
    const pendingEntries = this.entries().filter(
      e => isAutoPromotableStatus(e.status) && e.taskId !== suspendedTaskId,
    );
    const pendingSlots = pendingEntries.map((e, i) => this.completionFlow.toFocusTaskSlot(e, 'combo-select', i));

    const groups = computeThreeDimensionalRecommendation(mainSlot, pendingSlots, waitMinutes);
    this.lastRecommendationGroups.set(groups);
  }
}
