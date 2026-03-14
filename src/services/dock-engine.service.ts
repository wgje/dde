import { DestroyRef, Injectable, OnDestroy, computed, effect, inject, signal } from '@angular/core';
import { FLOATING_TREE_CONFIG } from '../config/layout.config';
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
  RoutineCompletionMutation,
  RoutineTask,
  RecommendationGroupType,
  StatusMachineEntry,
} from '../models/parking-dock';
import { BlackBoxFocusMeta } from '../models/focus';
import { Task } from '../models';
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
  type DockWaitFitMode,
  determineFragmentDefenseLevel,
  effectiveExecMin,
  evaluateTimeRemaining,
  rankDockCandidates,
  updateHighLoadCounter,
} from './dock-scheduler.rules';
import { sanitizePlannerFields } from '../utils/planner-fields';
import {
  DockSnapshotPersistenceService,
  normalizeNullableNumber,
  type SnapshotNormalizeContext,
} from './dock-snapshot-persistence.service';
import { DockCloudSyncService } from './dock-cloud-sync.service';
import { DockFragmentRestService } from './dock-fragment-rest.service';

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
  readonly dailyResetDate = signal(this.todayDateKey());

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

  /** BFS 邻接表缓存（避免每次 computeTreeDistance 重新构建 O(n) 邻接表） */
  private adjacencyCache: {
    projectId: string;
    fingerprint: string;
    adjacency: Map<string, string[]>;
  } | null = null;

  readonly dockedEntries = computed(() => this.entries().filter(entry => entry.status !== 'completed'));
  readonly orderedDockEntries = computed(() => this.sortDockEntriesForDisplay(this.dockedEntries()));
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
        (entry.isMain || entry.status === 'focusing' || this.isConsoleBackgroundStatus(entry.status)),
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
    return this
      .sortConsoleEntriesForDisplay(visibleCandidates)
      .slice(0, PARKING_CONFIG.CONSOLE_STACK_VISIBLE_MAX);
  });
  readonly focusingEntry = computed(() =>
    this.entries().find(entry => entry.status === 'focusing') ?? null,
  );
  readonly suspendedEntries = computed(() =>
    this.consoleVisibleEntries().filter(entry => this.isWaitingLike(entry.status)),
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
        !this.isConsoleBackgroundStatus(entry.status),
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
        !this.isConsoleBackgroundStatus(entry.status),
    ),
  );
  // v3.0 倦怠状态（策划案 §7.8 NG-16b）
  readonly isBurnoutActive = computed(() => this.burnoutTriggeredAt() !== null);
  readonly isFragmentPhase = computed(() => {
    const docked = this.dockedEntries();
    return (
      this.fragmentEntryCountdown() === null
      && docked.length > 0
      && docked.every(entry => this.isWaitingLike(entry.status))
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
        !this.isWaitingLike(entry.status),
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
      .map(entry => this.toStatusMachineEntry(entry));
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
        this.enterFragmentPhase(reason, rootTaskId, remainingMinutes),
      clearPendingDecisionState: () => {
        this.pendingDecision.set(null);
        this.highlightedIds.set(new Set());
        this.entries.update(prev => this.clearSystemSelectionOnEntries(prev));
      },
    });

    // 10 秒一次 tick，配合 CSS transition 平滑过渡（避免 1s 频率导致动画卡顿）
    this.tickTimer = setInterval(() => {
      this.tick.update(value => value + 1);
      // 将 signal 写入操作移到 setInterval 回调中，避免在 effect 中写入 entries
      // （Angular signal 反模式：effect 中读 tick → 写 entries → 级联 10+ computed 重算）
      this.checkWaitExpiry();
      this.checkPendingDecisionExpiry();
      this.resetDailySlotsIfNeeded();
      // v3.0 倦怠冷却检查（§7.8 NG-16b）
      this.checkBurnoutCooldown();
      // v3.0 碎片阶段防御等级动态更新
      if (this.focusMode()) {
        this.updateFragmentDefenseLevel();
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
      this.resetDailySlotsIfNeeded();
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
    if (!this.ensureDockCapacity(task.title || 'Untitled task')) return false;

    const sourceProjectId = this.resolveTaskProjectId(taskId);
    const zoneSource: DockZoneSource = options?.zoneSource ?? (lane ? 'manual' : 'auto');
    const inferredRelation = lane
      ? {
          lane,
          relationScore: lane === 'combo-select' ? 100 : 20,
          relationReason: lane === 'combo-select' ? 'manual:combo-select' : 'manual:backup',
        }
      : this.inferAutoLaneForTask(task, sourceProjectId, taskId);
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
    this.syncTaskPlannerFields(taskId, {
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
    const taskId = crypto.randomUUID();
    const normalizedTitle = title.trim() || 'Untitled task';
    if (!this.ensureDockCapacity(normalizedTitle)) return null;
    const normalizedDetail = options?.detail?.trim() ?? '';
    const plannerFields = sanitizePlannerFields({
      expectedMinutes: options?.expectedMinutes,
      waitMinutes: options?.waitMinutes,
      cognitiveLoad: load,
    });
    const focusMeta: BlackBoxFocusMeta = {
      source: 'focus-console-inline',
      sessionId: this.focusSessionContext()?.id ?? crypto.randomUUID(),
      title: normalizedTitle,
      detail: normalizedDetail.length > 0 ? normalizedDetail : null,
      lane,
      expectedMinutes: plannerFields.expectedMinutes,
      waitMinutes: plannerFields.waitMinutes,
      cognitiveLoad: plannerFields.cognitiveLoad ?? load,
      dockEntryId: taskId,
    };

    const blackBoxCreate = this.blackBoxService.create({
      projectId: null,
      content: normalizedDetail.length > 0 ? normalizedDetail : normalizedTitle,
      focusMeta,
    });
    const sourceBlackBoxEntryId = blackBoxCreate.ok ? blackBoxCreate.value.id : null;
    const inlineArchiveStatus: DockEntry['inlineArchiveStatus'] = blackBoxCreate.ok ? 'pending' : 'failed';
    if (!blackBoxCreate.ok) {
      this.logger.warn('Inline dock creation persisted locally but black-box create failed', {
        dockEntryId: taskId,
        message: blackBoxCreate.error.message,
      });
    }

    const entry: DockEntry = {
      taskId,
      title: normalizedTitle,
      sourceProjectId: null,
      status: 'pending_start',
      load: plannerFields.cognitiveLoad ?? load,
      expectedMinutes: plannerFields.expectedMinutes,
      waitMinutes: plannerFields.waitMinutes,
      waitStartedAt: null,
      lane,
      zoneSource: 'manual',
      isMain: false,
      dockedOrder: this.entries().length,
      detail: normalizedDetail,
      sourceKind: 'dock-created',
      sourceBlackBoxEntryId,
      inlineArchiveStatus,
      inlineArchivedTaskId: null,
      systemSelected: false,
      recommendedScore: null,
      sourceSection: 'dock-create',
      manualMainSelected: false,
      recommendationLocked: false,
      snoozeRingMuted: this.muteWaitTone(),
      relationScore: lane === 'combo-select' ? 100 : 20,
      relationReason: lane === 'combo-select' ? 'manual:create-combo-select' : 'manual:create-backup',
    };
    if (plannerFields.adjusted) {
      this.toast.info('已校正等待/预计时长', `等待时长不能超过预计时长，已同步调整为 ${plannerFields.expectedMinutes ?? 0} 分钟`);
    }
    this.entries.update(prev => [...prev, entry]);
    if (!this.firstDragIntervened()) {
      this.setMainTask(taskId);
      this.firstDragIntervened.set(true);
    }
    return taskId;
  }

  private ensureDockCapacity(entryTitle: string): boolean {
    const count = this.dockedCount();
    const softLimit = PARKING_CONFIG.DOCK_CONSOLE_SOFT_LIMIT;
    const hardLimit = PARKING_CONFIG.DOCK_CONSOLE_HARD_LIMIT;
    if (count >= hardLimit) {
      this.toast.warning(
        '停泊坞已满',
        `最多可保留 ${hardLimit} 个任务，请先移除部分任务后再添加「${entryTitle}」。`,
      );
      return false;
    }
    if (count + 1 >= softLimit && !this.softLimitNoticeShown()) {
      this.toast.info(
        '停泊坞接近上限',
        `建议将入坞任务控制在 ${softLimit} 个以内，以保持专注控制台清晰。`,
      );
      this.softLimitNoticeShown.set(true);
    }
    return true;
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
    return this.entries().filter(entry => entry.sourceKind === 'dock-created');
  }

  archiveInlineEntriesToActiveProject(): { converted: number; failed: number } {
    const candidates = this.getInlineArchiveCandidates();
    if (candidates.length === 0) {
      return { converted: 0, failed: 0 };
    }

    const activeProjectId = this.projectState.activeProjectId();
    if (!activeProjectId) {
      const candidateIds = new Set(candidates.map(entry => entry.taskId));
      this.entries.update(prev =>
        prev.map(entry =>
          candidateIds.has(entry.taskId)
            ? { ...entry, inlineArchiveStatus: 'failed' }
            : entry,
        ),
      );
      this.logger.warn('Inline archive skipped because no active project');
      return { converted: 0, failed: candidates.length };
    }

    let converted = 0;
    let failed = 0;

    for (const entry of candidates) {
      const archived = this.replaceInlineEntryWithProjectTask(entry, activeProjectId);
      if (archived) {
        converted += 1;
      } else {
        failed += 1;
      }
    }

    if (converted > 0) {
      this.rebalanceAutoZones();
    }
    return { converted, failed };
  }

  private replaceInlineEntryWithProjectTask(entry: DockEntry, activeProjectId: string): boolean {
    let blackBoxEntryId = entry.sourceBlackBoxEntryId ?? null;
    if (!blackBoxEntryId) {
      const rebuildResult = this.blackBoxService.create({
        projectId: null,
        content: entry.detail?.trim() ? entry.detail : entry.title,
        focusMeta: {
          source: 'focus-console-inline',
          sessionId: this.focusSessionContext()?.id ?? crypto.randomUUID(),
          title: entry.title,
          detail: entry.detail?.trim() ? entry.detail : null,
          lane: entry.lane,
          expectedMinutes: normalizeNullableNumber(entry.expectedMinutes),
          waitMinutes: normalizeNullableNumber(entry.waitMinutes),
          cognitiveLoad: entry.load,
          dockEntryId: entry.taskId,
        },
      });

      if (!rebuildResult.ok) {
        this.entries.update(prev =>
          prev.map(item =>
            item.taskId === entry.taskId
              ? { ...item, inlineArchiveStatus: 'failed' }
              : item,
          ),
        );
        this.logger.warn('Inline archive failed: cannot rebuild source black-box entry', {
          dockEntryId: entry.taskId,
          message: rebuildResult.error.message,
        });
        return false;
      }

      blackBoxEntryId = rebuildResult.value.id;
      this.entries.update(prev =>
        prev.map(item =>
          item.taskId === entry.taskId
            ? {
                ...item,
                sourceBlackBoxEntryId: blackBoxEntryId,
                inlineArchiveStatus: 'pending',
              }
            : item,
        ),
      );
    }

    this.entries.update(prev =>
      prev.map(item =>
        item.taskId === entry.taskId
          ? { ...item, inlineArchiveStatus: 'archiving' }
          : item,
      ),
    );

    const createResult = this.taskOps.addTask(entry.title, entry.detail ?? '', null, null, false);
    if (!createResult.ok) {
      this.entries.update(prev =>
        prev.map(item =>
          item.taskId === entry.taskId
            ? { ...item, inlineArchiveStatus: 'failed' }
            : item,
        ),
      );
      this.logger.warn('Inline archive failed: cannot create project task', {
        dockEntryId: entry.taskId,
        projectId: activeProjectId,
        message: createResult.error.message,
      });
      return false;
    }

    const newTaskId = createResult.value;
    this.taskOps.updateTaskExpectedMinutes(newTaskId, normalizeNullableNumber(entry.expectedMinutes));
    this.taskOps.updateTaskCognitiveLoad(newTaskId, entry.load);
    this.taskOps.updateTaskWaitMinutes(newTaskId, normalizeNullableNumber(entry.waitMinutes));

    if (entry.status === 'completed') {
      this.taskOps.updateTaskStatus(newTaskId, 'completed');
      const completedResult = this.blackBoxService.markAsCompleted(blackBoxEntryId);
      if (!completedResult.ok) {
        this.logger.warn('Inline archive warning: failed to mark source black-box entry completed', {
          dockEntryId: entry.taskId,
          blackBoxEntryId,
          message: completedResult.error.message,
        });
      }
    }

    const archiveResult = this.blackBoxService.archive(blackBoxEntryId);
    if (!archiveResult.ok) {
      this.logger.warn('Inline archive warning: failed to archive source black-box entry', {
        dockEntryId: entry.taskId,
        blackBoxEntryId,
        message: archiveResult.error.message,
      });
    }

    const oldTaskId = entry.taskId;
    this.entries.update(prev =>
      prev.map(item =>
        item.taskId === oldTaskId
          ? {
              ...item,
              taskId: newTaskId,
              sourceKind: 'project-task',
              sourceProjectId: activeProjectId,
              sourceBlackBoxEntryId: blackBoxEntryId,
              inlineArchiveStatus: 'archived',
              inlineArchivedTaskId: newTaskId,
            }
          : item,
      ),
    );

    this.rewriteDockReferences(oldTaskId, newTaskId);
    return true;
  }

  private rewriteDockReferences(oldTaskId: string, newTaskId: string): void {
    if (!oldTaskId || oldTaskId === newTaskId) return;

    const pendingWindow = this.firstMainSelectionWindow();
    if (pendingWindow?.taskId === oldTaskId) {
      this.firstMainSelectionWindow.set({
        ...pendingWindow,
        taskId: newTaskId,
      });
    }

    if (this.suspendChainRootTaskId() === oldTaskId) {
      this.suspendChainRootTaskId.set(newTaskId);
    }

    const pending = this.pendingDecision();
    if (pending) {
      let touched = false;
      const rootTaskId = pending.rootTaskId === oldTaskId ? newTaskId : pending.rootTaskId;
      if (rootTaskId !== pending.rootTaskId) touched = true;
      const candidateGroups = pending.candidateGroups.map(group => {
        const taskIds = group.taskIds.map(taskId => (taskId === oldTaskId ? newTaskId : taskId));
        if (!touched && taskIds.some((taskId, index) => taskId !== group.taskIds[index])) {
          touched = true;
        }
        return { ...group, taskIds };
      });
      if (touched) {
        this.pendingDecision.set({
          ...pending,
          rootTaskId,
          candidateGroups,
        });
      }
    }

    const highlighted = this.highlightedIds();
    if (highlighted.has(oldTaskId)) {
      const next = new Set(highlighted);
      next.delete(oldTaskId);
      next.add(newTaskId);
      this.highlightedIds.set(next);
    }

    if (this.waitEndNotifiedIds.has(oldTaskId)) {
      this.waitEndNotifiedIds.delete(oldTaskId);
      this.waitEndNotifiedIds.add(newTaskId);
    }
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
    this.clearPendingDecisionIfMatched(taskId);
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
      evictedTaskId = this.findConsoleEvictionCandidate(preVisible, currentFocusId);
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
      this.buildConsoleVisibleOrderHint(preVisible, taskId, evictedTaskId),
    );

    // 设置协调信号：inserted 信号供 console-stack 触发 C 位入场动画。
    // evictedTaskId 通过 pendingRadarEviction 暂存,
    // 由 console-stack 动画结束后调用 flushRadarEviction() 执行淘汰，
    // flushRadarEviction 完成后才设置 lastRadarEvictedTaskId 触发雷达区返回动画。
    this.lastRadarInsertedTaskId.set(taskId);
    this.pendingRadarEviction.set(evictedTaskId);

    this.clearPendingDecisionIfMatched(taskId);
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
            status: this.deriveBackgroundStatus(entry),
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
    this.syncTaskPlannerFields(taskId, { cognitive_load: nextLoad });
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
    this.syncTaskPlannerFields(taskId, {
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
    this.syncTaskPlannerFields(taskId, {
      expected_minutes: plannerFields.expectedMinutes,
      wait_minutes: plannerFields.waitMinutes,
    });
  }

  setDetail(taskId: string, detail: string): void {
    this.entries.update(prev =>
      prev.map(entry => (entry.taskId === taskId ? { ...entry, detail } : entry)),
    );
    this.syncTaskDetail(taskId, detail);
  }

  setLane(taskId: string, lane: DockLane, zoneSource: DockZoneSource = 'manual'): void {
    this.entries.update(prev =>
      prev.map(entry => (entry.taskId === taskId ? { ...entry, lane, zoneSource } : entry)),
    );
    if (zoneSource === 'auto') {
      this.rebalanceAutoZones();
    }
  }

  private resolveTaskProjectId(taskId: string, fallbackProjectId?: string | null): string | null {
    const directProjectId = this.taskStore.getTaskProjectId(taskId);
    if (directProjectId) return directProjectId;
    if (fallbackProjectId) return fallbackProjectId;

    const project = this.projectState.projects().find(candidate =>
      candidate.tasks.some(task => task.id === taskId),
    );
    return project?.id ?? this.projectState.activeProjectId() ?? null;
  }

  private syncTaskDetail(taskId: string, detail: string): void {
    const inlineEntry = this.entries().find(entry => entry.taskId === taskId) ?? null;
    if (inlineEntry?.sourceKind === 'dock-created') {
      if (!inlineEntry.sourceBlackBoxEntryId) return;
      this.blackBoxService.update(inlineEntry.sourceBlackBoxEntryId, {
        content: detail.trim() || inlineEntry.title,
        focusMeta: {
          source: 'focus-console-inline',
          sessionId: this.focusSessionContext()?.id ?? crypto.randomUUID(),
          title: inlineEntry.title,
          detail: detail.trim() || null,
          lane: inlineEntry.lane,
          expectedMinutes: normalizeNullableNumber(inlineEntry.expectedMinutes),
          waitMinutes: normalizeNullableNumber(inlineEntry.waitMinutes),
          cognitiveLoad: inlineEntry.load,
          dockEntryId: inlineEntry.taskId,
        },
      });
      return;
    }

    const task = this.taskStore.getTask(taskId);
    if (!task) return;
    const projectId = this.resolveTaskProjectId(taskId, inlineEntry?.sourceProjectId ?? null);
    if (!projectId) return;

    if (this.projectState.activeProjectId() === projectId) {
      this.taskOps.updateTaskContent(taskId, detail);
      return;
    }

    this.applyCrossProjectTaskPatch(taskId, projectId, {
      content: detail,
    });
  }

  private syncTaskPlannerFields(
    taskId: string,
    patch: {
      expected_minutes?: number | null;
      cognitive_load?: CognitiveLoad | null;
      wait_minutes?: number | null;
    },
  ): void {
    const task = this.taskStore.getTask(taskId);
    if (!task) return;
    const projectId = this.resolveTaskProjectId(taskId);
    if (!projectId) return;

    const normalizedPatch: {
      expected_minutes?: number | null;
      cognitive_load?: CognitiveLoad | null;
      wait_minutes?: number | null;
    } = {};
    const plannerFields = sanitizePlannerFields({
      expectedMinutes:
        'expected_minutes' in patch ? patch.expected_minutes : task.expected_minutes,
      waitMinutes:
        'wait_minutes' in patch ? patch.wait_minutes : task.wait_minutes,
      cognitiveLoad:
        'cognitive_load' in patch ? patch.cognitive_load : task.cognitive_load,
    });
    if ('expected_minutes' in patch || ('wait_minutes' in patch && plannerFields.adjusted)) {
      normalizedPatch.expected_minutes = plannerFields.expectedMinutes;
    }
    if ('cognitive_load' in patch) {
      normalizedPatch.cognitive_load = plannerFields.cognitiveLoad;
    }
    if ('wait_minutes' in patch) {
      normalizedPatch.wait_minutes = plannerFields.waitMinutes;
    }

    if (this.projectState.activeProjectId() === projectId) {
      if ('expected_minutes' in normalizedPatch) {
        this.taskOps.updateTaskExpectedMinutes(taskId, normalizedPatch.expected_minutes ?? null);
      }
      if ('cognitive_load' in normalizedPatch) {
        this.taskOps.updateTaskCognitiveLoad(taskId, normalizedPatch.cognitive_load ?? null);
      }
      if ('wait_minutes' in normalizedPatch) {
        this.taskOps.updateTaskWaitMinutes(taskId, normalizedPatch.wait_minutes ?? null);
      }
      return;
    }

    this.applyCrossProjectTaskPatch(taskId, projectId, normalizedPatch);
  }

  private applyCrossProjectTaskPatch(
    taskId: string,
    projectId: string,
    patch: Partial<Task>,
  ): void {
    const currentTask = this.taskStore.getTask(taskId);
    if (!currentTask) return;

    const updatedTask: Task = {
      ...currentTask,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    this.taskStore.setTask(updatedTask, projectId);
    this.projectState.updateProjects(projects =>
      projects.map(project =>
        project.id === projectId
          ? {
              ...project,
              tasks: project.tasks.map(item => (item.id === taskId ? updatedTask : item)),
            }
          : project,
      ),
    );
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
        const candidate = this.consoleEntries().find(entry => this.isAutoPromotableStatus(entry.status));
        if (candidate) {
          this.promoteCandidate(candidate.taskId);
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
      this.updateFragmentDefenseLevel();
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
    const projectId = this.resolveTaskProjectId(taskId);
    if (task && projectId) {
      if (this.projectState.activeProjectId() === projectId) {
        this.taskOps.updateTaskStatus(taskId, 'completed');
      } else {
        this.applyCrossProjectTaskPatch(taskId, projectId, {
          status: 'completed',
        });
      }
    }

    this.resolveAfterCompletion(taskId);
    if (wasMaster) {
      this.promoteFocusedTaskToMaster();
    }
    this.entries.update(prev => this.enforceSingleMainInvariant(prev));
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
    this.syncTaskPlannerFields(taskId, { wait_minutes: normalizedWait });

    // 多层挂起嵌套检测（策划案 §7.9）：≥3 层同时挂起 → 直接进入碎片阶段
    const suspendNestingDepth = this.entries().filter(
      e => e.status === 'suspended_waiting' || e.status === 'wait_finished',
    ).length;
    if (suspendNestingDepth >= 3) {
      this.logger.info(`挂起嵌套深度 ${suspendNestingDepth} ≥ 3，自动进入碎片阶段`);
      this.enterFragmentPhase('挂起嵌套 ≥ 3 层，自动进入碎片阶段', taskId, normalizedWait);
      return;
    }

    if (firstSuspendInChain) {
      this.suspendChainRootTaskId.set(taskId);
      this.suspendRecommendationLocked.set(true);
      this.scheduleFirstSuspendRecommendation(taskId, normalizedWait);
      return;
    }

    this.promoteNext();
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
    const shouldClearPending = !!pending && this.pendingCandidateIds(pending).includes(taskId);

    const result = this.applySwitchEntries(taskId, currentFocusId, currentFocus, target, shouldClearPending);
    if (!result.committed) return;

    if (currentFocusId && currentFocusId !== taskId) {
      this.lastConsoleDemotedTaskId.set(currentFocusId);
    }
    this.consoleVisibleOrderHint.set(this.buildConsoleVisibleOrderHint(preVisible, taskId));
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
          const backgroundStatus = this.deriveBackgroundStatus(entry, target, currentFocus);
          if (entry.status === backgroundStatus) return entry;
          changed = true;
          return { ...entry, status: backgroundStatus };
        }
        return entry;
      });

      if (shouldClearPending) {
        const cleared = this.clearSystemSelectionOnEntries(next);
        if (cleared !== next) { next = cleared; changed = true; }
      }

      const hasSuspended = next.some(entry => this.isWaitingLike(entry.status));
      if (!hasSuspended) {
        unlockSuspendChain = true;
        const unlocked = this.clearSuspendRecommendationStateOnEntries(next);
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
    const candidateIds = this.pendingCandidateIds(pending);
    if (!candidateIds.includes(taskId)) return;

    const selectedId = taskId;
    const rejectedIds = candidateIds.filter(id => id !== selectedId);
    this.promoteCandidate(selectedId, false);
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
    this.entries.update(prev => this.clearSystemSelectionOnEntries(prev));
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
      this.promoteFocusedTaskToMaster();
    }
    this.entries.update(prev => this.enforceSingleMainInvariant(prev));
    this.rebalanceAutoZones();
    this.waitEndNotifiedIds.delete(taskId);
    if (this.entries().length === 0) {
      this.pendingDecision.set(null);
      this.highlightedIds.set(new Set());
    }
    this.refreshSuspendRecommendationLock();
  }

  addDailySlot(title: string, maxDailyCount = 1): string {
    const id = crypto.randomUUID();
    const slot: DailySlotEntry = {
      id,
      title: title.trim() || 'Untitled daily task',
      maxDailyCount: Math.max(1, Math.floor(maxDailyCount)),
      todayCompletedCount: 0,
      isEnabled: true,
      createdAt: new Date().toISOString(),
    };
    this.dailySlots.update(prev => [...prev, slot]);
    const userId = this.auth.currentUserId();
    if (userId) {
      this.cloudSync.enqueueRoutineTaskSync(userId, {
        routineId: slot.id,
        title: slot.title,
        triggerCondition: 'any-blank-period',
        maxTimesPerDay: slot.maxDailyCount,
        isEnabled: true,
      });
    }
    return id;
  }

  setDailySlotEnabled(id: string, enabled: boolean): void {
    const target = this.dailySlots().find(slot => slot.id === id) ?? null;
    if (!target || target.isEnabled === enabled) return;
    this.dailySlots.update(prev =>
      prev.map(slot => (slot.id === id ? { ...slot, isEnabled: enabled } : slot)),
    );
    const userId = this.auth.currentUserId();
    if (userId) {
      this.cloudSync.enqueueRoutineTaskSync(userId, {
        routineId: target.id,
        title: target.title,
        triggerCondition: 'any-blank-period',
        maxTimesPerDay: target.maxDailyCount,
        isEnabled: enabled,
      });
    }
  }

  completeDailySlot(id: string): void {
    const target = this.dailySlots().find(slot => slot.id === id) ?? null;
    if (!target) return;
    this.dailySlots.update(prev =>
      prev.map(slot =>
        slot.id === id
          ? { ...slot, todayCompletedCount: Math.min(slot.maxDailyCount, slot.todayCompletedCount + 1) }
          : slot,
      ),
    );
    const userId = this.auth.currentUserId();
    if (userId) {
      const completion: RoutineCompletionMutation = {
        completionId: crypto.randomUUID(),
        userId,
        routineId: target.id,
        dateKey: this.todayDateKey(),
      };
      this.cloudSync.enqueueRoutineCompletionSync(completion);
    }
    if (this.isFragmentPhase() && this.fragmentDefenseLevel() >= 3) {
      this.fragmentDefenseLevel.set(4);
      this.schedulerPhase.set('paused');
    }
  }

  skipDailySlot(id: string): void {
    this.dailySlots.update(prev =>
      prev.map(slot =>
        slot.id === id
          ? { ...slot, todayCompletedCount: slot.maxDailyCount }
          : slot,
      ),
    );
  }

  dismissZenMode(): void {
    if (!this.focusMode()) return;
    if (this.isFragmentPhase()) {
      this.fragmentDefenseLevel.set(2);
      this.schedulerPhase.set('paused');
      return;
    }
    this.fragmentDefenseLevel.set(1);
    this.schedulerPhase.set('active');
  }

  /**
   * 碎片事件推荐（策划案 §7.8 Level 2）
   * 按 physical-crossover > digital-janitor > micro-progress 优先级
   * 从预置列表中随机选取一个推荐给用户
   */
  getFragmentEventRecommendation(): FragmentEventEntry | null {
    return this.fragmentRest.getFragmentEventRecommendation(this.fragmentDefenseLevel());
  }

  /**
   * 完成碎片事件（策划案 §7.8 Level 3→4）
   * 完成后不连发，直接进入 Zen Mode
   */
  completeFragmentEvent(): void {
    if (this.fragmentRest.completeFragmentEvent()) {
      // Level 3→4：碎片做完后直接进入 Zen Mode（不连发）
      this.fragmentDefenseLevel.set(4);
      this.schedulerPhase.set('paused');
    }
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
    const removed = this.dailySlots().find(slot => slot.id === id) ?? null;
    this.dailySlots.update(prev => prev.filter(slot => slot.id !== id));
    const userId = this.auth.currentUserId();
    if (userId && removed) {
      this.cloudSync.enqueueRoutineTaskSync(userId, {
        routineId: removed.id,
        title: removed.title,
        triggerCondition: 'any-blank-period',
        maxTimesPerDay: removed.maxDailyCount,
        isEnabled: false,
      });
    }
  }

  getWaitRemainingSeconds(entry: DockEntry): number | null {
    if (!entry.waitStartedAt || !entry.waitMinutes) return null;
    const elapsed = Date.now() - new Date(entry.waitStartedAt).getTime();
    const total = entry.waitMinutes * 60_000;
    return Math.max(0, Math.ceil((total - elapsed) / 1000));
  }

  isWaitExpired(entry: DockEntry): boolean {
    const remaining = this.getWaitRemainingSeconds(entry);
    return remaining !== null && remaining <= 0;
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
      focusStatus: this.mapDockStatusToFocusStatus(entry.status),
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

  private mapDockStatusToFocusStatus(status: DockTaskStatus): FocusTaskSlot['focusStatus'] {
    switch (status) {
      case 'focusing': return 'focusing';
      case 'suspended_waiting': return 'suspend-waiting';
      case 'wait_finished': return 'wait-ended';
      case 'stalled': return 'stalled';
      case 'completed': return 'completed';
      default: return 'pending';
    }
  }

  restoreSnapshot(snapshot: DockSnapshot): void {
    const normalized = this.snapshotPersistence.normalizeSnapshot(snapshot, this.buildNormalizeContext());
    if (!normalized) return;
    const hydratedEntries = this.applySessionToEntries(normalized.entries, normalized.session);
    const recoveredEntries = this.snapshotPersistence.recoverLegacyExternalDragDefaultBackup(hydratedEntries);
    const recoveredWithMain = this.enforceSingleMainInvariant(
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
    this.dailyResetDate.set(this.todayDateKey());
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
    this.adjacencyCache = null;
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
        this.entries.update(prev => this.rebalanceAutoZonesEntries(prev));
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
      todayDateKey: this.todayDateKey(),
      buildOverflowMeta: (entries) => this.buildOverflowMeta(entries),
    };
  }

  private getNonCriticalHoldDelay(nowMs: number = Date.now()): number {
    return Math.max(0, this.nonCriticalWorkHoldUntil - nowMs);
  }

  private pickAutoLaneForNextEntry(entriesSnapshot: DockEntry[] = this.entries()): DockLane {
    const autoEntries = entriesSnapshot
      .filter(entry => entry.status !== 'completed' && entry.zoneSource === 'auto');
    const comboCount = autoEntries.filter(entry => entry.lane === 'combo-select').length;
    const backupCount = autoEntries.length - comboCount;
    return comboCount <= backupCount ? 'combo-select' : 'backup';
  }

  private rebalanceAutoZones(): void {
    this.entries.update(prev => this.rebalanceAutoZonesEntries(prev));
  }

  private rebalanceAutoZonesEntries(entriesSnapshot: DockEntry[]): DockEntry[] {
    let changed = false;
    const next = entriesSnapshot.map(entry => {
      if (entry.status === 'completed' || entry.zoneSource !== 'auto') return entry;
      const task = this.taskStore.getTask(entry.taskId);
      if (!task) return entry;
      const sourceProjectId = entry.sourceProjectId ?? this.taskStore.getTaskProjectId(entry.taskId);
      const inferred = this.inferAutoLaneForTask(task, sourceProjectId, entry.taskId, entriesSnapshot);
      if (
        entry.lane === inferred.lane &&
        (entry.relationScore ?? null) === inferred.relationScore &&
        (entry.relationReason ?? null) === inferred.relationReason
      ) {
        return entry;
      }
      changed = true;
      return {
        ...entry,
        lane: inferred.lane,
        relationScore: inferred.relationScore,
        relationReason: inferred.relationReason,
      };
    });
    return changed ? next : entriesSnapshot;
  }

  private toSchedulerCandidate(entry: DockEntry): {
    taskId: string;
    lane: DockLane;
    load: CognitiveLoad;
    expectedMinutes: number | null;
    waitMinutes: number | null;
    dockedOrder: number;
    manualOrder: number | null;
    relationScore: number | null;
    sourceProjectId: string | null;
  } {
    return {
      taskId: entry.taskId,
      lane: entry.lane,
      load: entry.load,
      expectedMinutes: entry.expectedMinutes,
      waitMinutes: entry.waitMinutes,
      dockedOrder: entry.dockedOrder,
      manualOrder: normalizeNullableNumber(entry.manualOrder),
      relationScore: normalizeNullableNumber(entry.relationScore),
      sourceProjectId: entry.sourceProjectId ?? this.taskStore.getTaskProjectId(entry.taskId),
    };
  }

  private inferAutoLaneForTask(
    task: Task,
    sourceProjectId: string | null,
    selfTaskId?: string,
    entriesSnapshot: DockEntry[] = this.entries(),
  ): { lane: DockLane; relationScore: number | null; relationReason: string | null } {
    const referenceMain = this.pickReferenceMainEntry(selfTaskId, entriesSnapshot);
    if (!referenceMain) {
      return {
        lane: this.pickAutoLaneForNextEntry(entriesSnapshot),
        relationScore: 0,
        relationReason: 'auto:no-main-fallback',
      };
    }

    const referenceTask = this.taskStore.getTask(referenceMain.taskId);
    const referenceProjectId = this.resolveSourceProjectId(referenceMain);
    if (!referenceTask || !sourceProjectId || !referenceProjectId || sourceProjectId !== referenceProjectId) {
      return {
        lane: 'backup',
        relationScore: 10,
        relationReason: 'auto:cross-project-default-backup',
      };
    }

    let score = 0;
    const reasons: string[] = [];

    if (task.parentId === referenceTask.id || referenceTask.parentId === task.id) {
      score += 70;
      reasons.push('parent-child');
    }

    if (task.parentId && referenceTask.parentId && task.parentId === referenceTask.parentId) {
      score += 25;
      reasons.push('shared-parent');
    }

    if (this.hasDirectConnection(sourceProjectId, task.id, referenceTask.id)) {
      score += 60;
      reasons.push('direct-connection');
    }

    // 树距离评分：同一棵树上的距离越近，优先级越高
    const treeDistance = this.computeTreeDistance(sourceProjectId, task.id, referenceTask.id);
    if (treeDistance !== null && treeDistance >= 2) {
      // 距离 2 → 40分，距离 3 → 30分，距离 4 → 20分，距离 5+ → 10分
      const distanceScore = Math.max(10, 50 - treeDistance * 10);
      score += distanceScore;
      reasons.push(`tree-distance:${treeDistance}`);
    }

    if (task.stage !== null && referenceTask.stage !== null && task.stage === referenceTask.stage) {
      score += 12;
      reasons.push('same-stage');
      if (Math.abs((task.order ?? 0) - (referenceTask.order ?? 0)) <= 1) {
        score += 15;
        reasons.push('adjacent-order');
      }
    }

    const normalizedScore = Math.max(0, Math.min(100, score));
    const lane: DockLane = normalizedScore >= 50 ? 'combo-select' : 'backup';
    return {
      lane,
      relationScore: normalizedScore,
      relationReason: reasons.length > 0
        ? `auto:${reasons.join('|')}`
        : 'auto:same-project-low-relation',
    };
  }

  private pickReferenceMainEntry(
    excludeTaskId?: string,
    entriesSnapshot: DockEntry[] = this.entries(),
  ): DockEntry | null {
    const activeEntries = entriesSnapshot.filter(entry => entry.status !== 'completed');
    const focusing = activeEntries.find(
      entry => entry.status === 'focusing' && (!excludeTaskId || entry.taskId !== excludeTaskId),
    );
    if (focusing) return focusing;

    const manualMain = activeEntries
      .filter(
        entry =>
          entry.isMain &&
          entry.manualMainSelected &&
          (!excludeTaskId || entry.taskId !== excludeTaskId),
      )
      .sort((a, b) => b.dockedOrder - a.dockedOrder)[0];
    if (manualMain) return manualMain;

    const fallbackMain = activeEntries
      .filter(entry => entry.isMain && (!excludeTaskId || entry.taskId !== excludeTaskId))
      .sort((a, b) => this.entryOrder(a) - this.entryOrder(b))[0];
    return fallbackMain ?? null;
  }

  private hasDirectConnection(projectId: string, taskAId: string, taskBId: string): boolean {
    if (!projectId) return false;
    const project = this.projectState.getProject(projectId);
    const connections = Array.isArray(project?.connections) ? project.connections : [];
    return connections.some(connection =>
      (connection.source === taskAId && connection.target === taskBId) ||
      (connection.source === taskBId && connection.target === taskAId),
    );
  }

  /**
   * 计算同一项目内两个任务在 parentId 树上的最短距离（迭代 BFS）。
   * 距离 1 = 直接父子，距离 2 = 祖孙或经由共同父节点的兄弟。
   * 返回 null 表示不在同一棵树上或超过搜索上限。
   */
  private computeTreeDistance(projectId: string, taskAId: string, taskBId: string): number | null {
    if (!projectId || taskAId === taskBId) return taskAId === taskBId ? 0 : null;

    const tasks = this.taskStore.getTasksByProject(projectId);
    if (!tasks || tasks.length === 0) return null;

    // 复用缓存的邻接表（同 projectId 且任务数未变则视为有效）
    const adjacency = this.getOrBuildAdjacency(projectId, tasks);

    if (!adjacency.has(taskAId) || !adjacency.has(taskBId)) return null;

    // 迭代 BFS，上限 100 层（避免性能问题）
    const MAX_SEARCH_DEPTH = FLOATING_TREE_CONFIG.MAX_SUBTREE_DEPTH;
    const visited = new Set<string>([taskAId]);
    let frontier = [taskAId];
    let depth = 0;

    while (frontier.length > 0 && depth < MAX_SEARCH_DEPTH) {
      depth++;
      const nextFrontier: string[] = [];
      for (const nodeId of frontier) {
        const neighbors = adjacency.get(nodeId);
        if (!neighbors) continue;
        for (const neighbor of neighbors) {
          if (neighbor === taskBId) return depth;
          if (!visited.has(neighbor)) {
            visited.add(neighbor);
            nextFrontier.push(neighbor);
          }
        }
      }
      frontier = nextFrontier;
    }

    return null;
  }

  /** 获取或构建项目邻接表缓存（按 projectId + 结构指纹失效，防止任务重挂后缓存脏读） */
  private getOrBuildAdjacency(projectId: string, tasks: Task[]): Map<string, string[]> {
    const fingerprint = this.buildAdjacencyFingerprint(tasks);
    if (
      this.adjacencyCache &&
      this.adjacencyCache.projectId === projectId &&
      this.adjacencyCache.fingerprint === fingerprint
    ) {
      return this.adjacencyCache.adjacency;
    }

    const adjacency = new Map<string, string[]>();
    for (const t of tasks) {
      if (!adjacency.has(t.id)) adjacency.set(t.id, []);
      if (t.parentId) {
        if (!adjacency.has(t.parentId)) adjacency.set(t.parentId, []);
        adjacency.get(t.id)!.push(t.parentId);
        adjacency.get(t.parentId)!.push(t.id);
      }
    }

    this.adjacencyCache = { projectId, fingerprint, adjacency };
    return adjacency;
  }

  /**
   * 构建邻接表结构指纹：id:parentId 排序拼接，任务增删或重挂时指纹必变
   * TODO: For large task sets (1000+) the string concatenation + sort is O(n log n)
   *       and allocates a large intermediate string. Consider a hash-based fingerprint
   *       (e.g. incremental FNV-1a) for better performance at scale.
   */
  private buildAdjacencyFingerprint(tasks: Task[]): string {
    const pairs: string[] = [];
    for (const t of tasks) {
      pairs.push(`${t.id}:${t.parentId ?? ''}`);  
    }
    pairs.sort();
    return pairs.join('|');
  }

  private resolveSourceProjectId(entry: DockEntry): string | null {
    return entry.sourceProjectId ?? this.taskStore.getTaskProjectId(entry.taskId);
  }

  // Internal helpers
  private resolveAfterCompletion(completedTaskId: string): void {
    const rootTaskId = this.suspendChainRootTaskId();
    const rootEntry = rootTaskId ? this.entries().find(entry => entry.taskId === rootTaskId) ?? null : null;
    const rootRemainingSeconds = rootEntry ? this.getWaitRemainingSeconds(rootEntry) : null;

    if (rootEntry && rootRemainingSeconds !== null && rootRemainingSeconds > 0) {
      const rootRemainingMinutes = rootRemainingSeconds / 60;
      const excluded = [completedTaskId, rootTaskId];
      const recommendation = this.buildTwoStageRecommendationCandidateGroups(
        rootEntry,
        excluded.filter((id): id is string => id !== null),
        rootRemainingMinutes,
      );
      const waitFitMode: DockWaitFitMode = recommendation.mode === 'strict' ? 'strict' : 'relaxed';
      const primaryCandidate = this.pickPrimaryCandidate(
        excluded.filter(Boolean) as string[],
        rootRemainingMinutes,
        rootEntry,
        waitFitMode,
      );
      const branch = evaluateTimeRemaining(
        rootRemainingMinutes,
        primaryCandidate ? effectiveExecMin(this.toFocusTaskSlot(primaryCandidate)) : null,
      );
      // GAP-A: 组合任务完成后始终触发碎片过渡倒计时，不以绝对的任务饱和为目标
      // 有候选时同时展示推荐（preservePendingDecision），用户可选择休息或切换任务
      const hasCandidates =
        recommendation.groups.some(g => g.taskIds.length > 0) || primaryCandidate !== null;

      if (!hasCandidates) {
        // 无候选：纯碎片倒计时
        this.fragmentRest.startFragmentEntryCountdown({
          reason: '主任务仍在等待且暂无合适候选，进入碎片时间倒计时',
          rootTaskId: rootTaskId ?? undefined,
          remainingMinutes: rootRemainingMinutes,
        });
        return;
      }

      if (branch === 'tight-blank') {
        const chainRootTaskId = rootTaskId ?? rootEntry.taskId;
        this.setPendingDecision(
          chainRootTaskId,
          rootRemainingMinutes,
          [],
          'tight-blank: 留白窗口紧张，5s 后进入留白期',
          5000,
        );
        this.lastRuleDecision.set(
          createRuleDecision({
            type: 'pending_decision',
            reason: 'tight-blank: 留白窗口紧张，等待用户取消或确认',
            rootTaskId: rootTaskId ?? undefined,
            recommendedTaskIds: [],
            remainingMinutes: rootRemainingMinutes,
          }),
        );
        return;
      }

      if (branch === 'mismatch-recompute') {
        const candidateGroups = recommendation.groups;
        if (candidateGroups.length > 0) {
          const chainRootTaskId = rootTaskId ?? rootEntry.taskId;
          const reason =
            recommendation.mode === 'strict'
              ? 'mismatch-recompute: 时间偏差过大，触发三组重算'
              : recommendation.mode === 'relaxed'
                ? 'mismatch-recompute: 放宽时窗后触发候选重算'
                : 'mismatch-recompute: 规则引擎回退候选重算';
          this.setPendingDecision(
            chainRootTaskId,
            rootRemainingMinutes,
            candidateGroups,
            reason,
          );
          this.highlightedIds.set(new Set(candidateGroups.flatMap(group => group.taskIds)));
          this.lastRuleDecision.set(
            createRuleDecision({
              type: 'pending_decision',
              reason:
                recommendation.mode === 'strict'
                  ? 'mismatch-recompute: 三组候选已重算，等待用户手动决策'
                  : recommendation.mode === 'relaxed'
                    ? 'mismatch-recompute: 已放宽时窗并重算候选，等待用户手动决策'
                    : 'mismatch-recompute: 回退候选已生成，等待用户手动决策',
              rootTaskId: rootTaskId ?? undefined,
              recommendedTaskIds: candidateGroups.flatMap(group => group.taskIds),
              remainingMinutes: rootRemainingMinutes,
            }),
          );
          // GAP-A: 碎片过渡倒计时，不以绝对任务饱和为目标，保留推荐同时给用户休息选择
          this.fragmentRest.startFragmentEntryCountdown({
            reason: '组合任务完成，碎片过渡期，可选择休息或切换任务',
            rootTaskId: rootTaskId ?? undefined,
            remainingMinutes: rootRemainingMinutes,
            preservePendingDecision: true,
            countdownSeconds: PARKING_CONFIG.FRAGMENT_TRANSITION_COUNTDOWN_S,
          });
          return;
        }
      }

      if (primaryCandidate) {
        this.setPendingDecision(
          rootTaskId ?? rootEntry.taskId,
          rootRemainingMinutes,
          [{ type: 'homologous-advancement', taskIds: [primaryCandidate.taskId] }],
          branch === 'time-match'
            ? 'time-match: 候选时长匹配，等待用户决定是否切换'
            : recommendation.mode === 'strict'
              ? '候选不足，保留最优下一步供用户手动选择'
              : '候选不足，已放宽时窗后保留最优下一步供用户手动选择',
        );
        this.highlightedIds.set(new Set([primaryCandidate.taskId]));
        this.lastRuleDecision.set(
          createRuleDecision({
            type: 'completion_followup',
            reason:
              branch === 'time-match'
                ? 'time-match: 候选时长匹配，保持高亮等待用户切换'
                : recommendation.mode === 'strict'
                  ? '候选不足，保留最优下一步'
                  : '候选不足，已放宽时窗后保留最优下一步',
            rootTaskId: rootTaskId ?? undefined,
            recommendedTaskIds: [primaryCandidate.taskId],
            remainingMinutes: rootRemainingMinutes,
          }),
        );
        // GAP-A: 碎片过渡倒计时，不以绝对任务饱和为目标，保留推荐同时给用户休息选择
        this.fragmentRest.startFragmentEntryCountdown({
          reason: '组合任务完成，碎片过渡期，可选择休息或切换任务',
          rootTaskId: rootTaskId ?? undefined,
          remainingMinutes: rootRemainingMinutes,
          preservePendingDecision: true,
          countdownSeconds: PARKING_CONFIG.FRAGMENT_TRANSITION_COUNTDOWN_S,
        });
        return;
      }
    }

    const recoveredMain = this.entries()
      .filter(entry => entry.isMain && entry.status === 'wait_finished')
      .sort((a, b) => this.entryOrder(a) - this.entryOrder(b))[0];
    if (recoveredMain) {
      this.pendingDecision.set(null);
      this.highlightedIds.set(new Set([recoveredMain.taskId]));
      this.lastRuleDecision.set(
        createRuleDecision({
          type: 'completion_followup',
          reason: '主任务等待结束，置顶高亮等待用户恢复',
          rootTaskId: recoveredMain.taskId,
          recommendedTaskIds: [recoveredMain.taskId],
          remainingMinutes: rootRemainingSeconds !== null ? rootRemainingSeconds / 60 : undefined,
        }),
      );
      return;
    }

    this.pendingDecision.set(null);
    this.promoteNext();
    const focused = this.focusingEntry();
    if (focused) {
      this.lastRuleDecision.set(
        createRuleDecision({
          type: 'completion_followup',
          reason: '任务完成后按规则推进下一候选',
          rootTaskId: rootTaskId ?? undefined,
          recommendedTaskIds: [focused.taskId],
          remainingMinutes: rootRemainingSeconds !== null ? rootRemainingSeconds / 60 : undefined,
        }),
      );
    }
  }

  private pickPrimaryCandidate(
    excludedIds: string[],
    remainingMinutes: number,
    rootEntry: DockEntry | null,
    waitFitMode: DockWaitFitMode = 'strict',
  ): DockEntry | null {
    const excluded = new Set(excludedIds.filter(Boolean));
    const mainIdle = this.entries()
      .filter(entry => entry.isMain && this.isAutoPromotableStatus(entry.status) && !excluded.has(entry.taskId))
      .sort((a, b) => this.entryOrder(a) - this.entryOrder(b));
    if (mainIdle.length > 0) return mainIdle[0];

    const stalled = this.entries()
      .filter(entry => entry.status === 'stalled' && !excluded.has(entry.taskId))
      .sort((a, b) => this.entryOrder(a) - this.entryOrder(b));
    if (stalled.length > 0) return stalled[0];

    return this.pickBestCandidate(
      remainingMinutes,
      excludedIds,
      {
        rootLoad: rootEntry?.load ?? null,
        rootProjectId: rootEntry ? this.resolveSourceProjectId(rootEntry) : null,
      },
      waitFitMode,
    );
  }

  private pickBestCandidate(
    remainingMinutes: number,
    excludedIds: string[],
    context: { rootLoad?: CognitiveLoad | null; rootProjectId?: string | null } = {},
    waitFitMode: DockWaitFitMode = 'strict',
  ): DockEntry | null {
    const excluded = new Set(excludedIds.filter(Boolean));
    const candidates = this.entries().filter(
      entry => this.isAutoPromotableStatus(entry.status) && !excluded.has(entry.taskId),
    );
    if (candidates.length === 0) return null;

    const ranked = rankDockCandidates(
      candidates.map(entry => this.toSchedulerCandidate(entry)),
      remainingMinutes,
      {
        ...context,
        waitFitMode,
      },
    );
    return ranked.length > 0
      ? candidates.find(entry => entry.taskId === ranked[0].taskId) ?? null
      : null;
  }

  private scoreCandidate(entry: DockEntry, waitMinutes: number): number {
    const ranked = rankDockCandidates([this.toSchedulerCandidate(entry)], waitMinutes);
    return ranked[0]?.score ?? 0;
  }

  private setPendingDecision(
    rootTaskId: string,
    rootRemainingMinutes: number,
    candidateGroups: Array<{ type: RecommendationGroupType; taskIds: string[] }>,
    reason: string,
    autoPromoteAfterMs?: number,
  ): void {
    const nowDate = new Date();
    const now = nowDate.toISOString();
    const expiresAtMs =
      typeof autoPromoteAfterMs === 'number'
        ? Math.max(1_000, autoPromoteAfterMs)
        : null;
    const candidateIds = candidateGroups.flatMap(group => group.taskIds);
    this.pendingDecision.set({
      rootTaskId,
      rootRemainingMinutes,
      candidateGroups,
      reason,
      expiresAt: expiresAtMs === null ? undefined : new Date(nowDate.getTime() + expiresAtMs).toISOString(),
      autoPromoteAfterMs: expiresAtMs ?? undefined,
      createdAt: now,
    });

    this.entries.update(prev =>
      prev.map(entry => {
        if (candidateIds.includes(entry.taskId)) {
          return {
            ...entry,
            // 策划案 §2.8 G-38c：isMain 仅标记唯一主任务，推荐候选不应设 isMain
            systemSelected: true,
            recommendationLocked: true,
            recommendedScore: this.scoreCandidate(entry, rootRemainingMinutes),
          };
        }
        return {
          ...entry,
          systemSelected: false,
          recommendationLocked: false,
        };
      }),
    );

    this.highlightedIds.set(new Set(candidateIds));
    this.lastRuleDecision.set(
      createRuleDecision({
        type: 'pending_decision',
        reason,
        rootTaskId,
        recommendedTaskIds: candidateIds,
        remainingMinutes: rootRemainingMinutes,
      }),
    );
  }

  private enterFragmentPhase(reason: string, rootTaskId?: string, remainingMinutes?: number): void {
    this.fragmentRest.setFragmentDismissed(false);
    this.schedulerPhase.set('paused');
    if (this.fragmentDefenseLevel() < 2) {
      this.fragmentDefenseLevel.set(2);
    }
    // 碎片阶段进入时自动触发碎片事件推荐（策划案 §7.8 Step 3.5）
    if (this.fragmentDefenseLevel() >= 2) {
      this.getFragmentEventRecommendation();
    }
    this.lastRuleDecision.set(
      createRuleDecision({
        type: 'fragment_phase',
        reason,
        rootTaskId,
        recommendedTaskIds: [],
        remainingMinutes,
      }),
    );
  }

  private buildRecommendationCandidateGroups(
    rootEntry: DockEntry,
    excludedTaskIds: string[],
    remainingMinutes: number,
    waitFitMode: DockWaitFitMode = 'strict',
  ): Array<{ type: RecommendationGroupType; taskIds: string[] }> {
    const excluded = new Set(excludedTaskIds.filter(Boolean));
    const mainSlot = this.toFocusTaskSlot(rootEntry, 'command', 0);
    const pendingEntries = this.entries().filter(
      entry => this.isAutoPromotableStatus(entry.status) && !excluded.has(entry.taskId),
    );
    const pendingSlots = pendingEntries.map((entry, idx) =>
      this.toFocusTaskSlot(entry, entry.lane, idx),
    );
    const groups = computeThreeDimensionalRecommendation(mainSlot, pendingSlots, remainingMinutes, waitFitMode);
    this.lastRecommendationGroups.set(groups);

    return groups
      .map(group => ({
        type: group.type,
        taskIds: group.candidates
          .map(candidate => candidate.taskId)
          .filter((taskId): taskId is string => typeof taskId === 'string' && taskId.length > 0),
      }))
      .filter(group => group.taskIds.length > 0);
  }

  private buildTwoStageRecommendationCandidateGroups(
    rootEntry: DockEntry,
    excludedTaskIds: string[],
    remainingMinutes: number,
  ): {
    groups: Array<{ type: RecommendationGroupType; taskIds: string[] }>;
    mode: DockWaitFitMode | 'ranked-fallback' | 'none';
  } {
    const strictGroups = this.buildRecommendationCandidateGroups(
      rootEntry,
      excludedTaskIds,
      remainingMinutes,
      'strict',
    );
    if (strictGroups.length > 0) {
      return { groups: strictGroups, mode: 'strict' };
    }

    const relaxedGroups = this.buildRecommendationCandidateGroups(
      rootEntry,
      excludedTaskIds,
      remainingMinutes,
      'relaxed',
    );
    if (relaxedGroups.length > 0) {
      return { groups: relaxedGroups, mode: 'relaxed' };
    }

    // 策划案：等待时间完全不匹配时忽略 wait 属性进行三维推荐组合挑选
    const ignoreWaitGroups = this.buildRecommendationCandidateGroups(
      rootEntry,
      excludedTaskIds,
      remainingMinutes,
      'ignore-wait',
    );
    if (ignoreWaitGroups.length > 0) {
      return { groups: ignoreWaitGroups, mode: 'ignore-wait' };
    }

    const fallbackGroups = this.buildRankedFallbackGroups(rootEntry, excludedTaskIds, remainingMinutes);
    if (fallbackGroups.length > 0) {
      return { groups: fallbackGroups, mode: 'ranked-fallback' };
    }

    return { groups: [], mode: 'none' };
  }

  private buildRankedFallbackGroups(
    rootEntry: DockEntry,
    excludedTaskIds: string[],
    remainingMinutes: number,
  ): Array<{ type: RecommendationGroupType; taskIds: string[] }> {
    const ranked = this.rankRecommendedCandidates(
      rootEntry,
      excludedTaskIds,
      remainingMinutes,
      // GAP-3: 完全忽略等待时间匹配，仅按其他属性排序
      'ignore-wait',
    );
    const candidateIds = ranked.slice(0, 3).map(item => item.taskId);
    if (candidateIds.length === 0) return [];
    return [{ type: 'homologous-advancement', taskIds: candidateIds }];
  }

  private rankRecommendedCandidates(
    rootEntry: DockEntry,
    excludedTaskIds: string[],
    remainingMinutes: number,
    waitFitMode: DockWaitFitMode = 'strict',
  ) {
    const excluded = new Set(excludedTaskIds.filter(Boolean));
    const candidateEntries = this.entries().filter(
      entry => this.isAutoPromotableStatus(entry.status) && !excluded.has(entry.taskId),
    );
    return rankDockCandidates(
      candidateEntries.map(entry => this.toSchedulerCandidate(entry)),
      remainingMinutes,
      {
        rootLoad: rootEntry.load,
        rootProjectId: this.resolveSourceProjectId(rootEntry),
        waitFitMode,
      },
    );
  }

  private clearSystemSelectionOnEntries(entries: DockEntry[]): DockEntry[] {
    // 策划案 §2.8 G-38c：清除系统推荐时，同时修正被错误标记 isMain 的候选任务
    // isMain 应始终仅属于唯一主任务，系统推荐的候选不应持有 isMain
    const realMainId = entries.find(
      e => e.isMain && !e.systemSelected && e.status !== 'completed',
    )?.taskId ?? null;
    let changed = false;
    const next = entries.map(entry => {
      const wasSystemSelected = entry.systemSelected || entry.recommendationLocked;
      // 修正：系统推荐的候选如果被错误标记了 isMain，在清除时一并还原
      const hasStaleMain = entry.isMain && entry.systemSelected && entry.taskId !== realMainId;
      if (!wasSystemSelected && !hasStaleMain) return entry;
      changed = true;
      return {
        ...entry,
        isMain: hasStaleMain ? false : entry.isMain,
        systemSelected: false,
        recommendationLocked: false,
      };
    });
    return this.enforceSingleMainInvariant(changed ? next : entries, realMainId);
  }

  private pendingCandidateIds(pending: DockPendingDecision): string[] {
    return pending.candidateGroups.flatMap(group => group.taskIds);
  }

  private clearSuspendRecommendationStateOnEntries(entries: DockEntry[]): DockEntry[] {
    // 策划案 §2.8 G-38c：清除挂起推荐状态时，同步修正被错误标记 isMain 的候选
    const realMainId = entries.find(
      e => e.isMain && !e.systemSelected && e.status !== 'completed',
    )?.taskId ?? null;
    let changed = false;
    const next = entries.map(entry => {
      const hasStaleMain = entry.isMain && entry.systemSelected && entry.taskId !== realMainId;
      if (!entry.systemSelected && !entry.recommendationLocked && entry.recommendedScore === null && !hasStaleMain) {
        return entry;
      }
      changed = true;
      return {
        ...entry,
        isMain: hasStaleMain ? false : entry.isMain,
        systemSelected: false,
        recommendationLocked: false,
        recommendedScore: null,
      };
    });
    return this.enforceSingleMainInvariant(changed ? next : entries, realMainId);
  }

  private clearPendingDecisionIfMatched(taskId: string): void {
    const pending = this.pendingDecision();
    if (!pending || !this.pendingCandidateIds(pending).includes(taskId)) return;
    this.pendingDecision.set(null);
    this.highlightedIds.set(new Set());
    this.entries.update(prev => this.clearSystemSelectionOnEntries(prev));
  }

  private scheduleFirstSuspendRecommendation(suspendedTaskId: string, waitMinutes: number): void {
    const suspendedEntry = this.entries().find(entry => entry.taskId === suspendedTaskId) ?? null;
    if (!suspendedEntry) {
      this.promoteNext();
      return;
    }

    const recommendation = this.buildTwoStageRecommendationCandidateGroups(
      suspendedEntry,
      [suspendedTaskId],
      waitMinutes,
    );
    const rankedFallback = this.rankRecommendedCandidates(
      suspendedEntry,
      [suspendedTaskId],
      waitMinutes,
      'relaxed',
    );
    const recommendationIds = recommendation.groups.flatMap(group => group.taskIds);
    const candidateIds = recommendationIds;
    if (candidateIds.length === 0) {
      this.pendingDecision.set(null);
      this.highlightedIds.set(new Set());
      return;
    }

    const scoreByTaskId = new Map(rankedFallback.map(item => [item.taskId, item.score]));
    const pendingGroups = recommendation.groups.map(group => ({ type: group.type, taskIds: group.taskIds }));

    this.entries.update(prev =>
      prev.map(entry => {
        if (entry.taskId === suspendedTaskId) {
          return {
            ...entry,
            // 被挂起的主任务保留原 isMain 状态（策划案 §2.8 G-38c）
            isMain: entry.isMain,
            status: 'suspended_waiting',
            systemSelected: false,
            recommendationLocked: false,
            recommendedScore: null,
          };
        }
        if (candidateIds.includes(entry.taskId)) {
          return {
            ...entry,
            status: 'pending_start',
            systemSelected: true,
            recommendationLocked: true,
            recommendedScore: scoreByTaskId.get(entry.taskId) ?? null,
          };
        }
        return {
          ...entry,
          systemSelected: false,
          recommendationLocked: false,
          recommendedScore: scoreByTaskId.get(entry.taskId) ?? null,
        };
      }),
    );

    this.setPendingDecision(
      suspendedTaskId,
      waitMinutes,
      pendingGroups,
      recommendation.mode === 'strict'
        ? '首次挂起触发三维推荐阵列'
        : recommendation.mode === 'relaxed'
          ? '首次挂起触发放宽时窗推荐，等待用户手动决策'
          : '首次挂起触发回退推荐，等待用户手动决策',
    );
    const highlighted = candidateIds;
    this.highlightedIds.set(new Set(highlighted));
    this.lastRuleDecision.set(
      createRuleDecision({
        type: 'first_suspend_recommendation',
        reason: recommendation.mode === 'strict'
          ? '首次挂起触发三维推荐阵列'
          : recommendation.mode === 'relaxed'
            ? '首次挂起触发放宽时窗推荐'
            : '首次挂起触发规则引擎回退推荐',
        rootTaskId: suspendedTaskId,
          recommendedTaskIds: highlighted,
          remainingMinutes: waitMinutes,
        }),
    );
  }

  private promoteNext(): void {
    const stalled = this.entries()
      .filter(entry => entry.status === 'stalled')
      .sort((a, b) => this.entryOrder(a) - this.entryOrder(b))[0];
    if (stalled) {
      this.schedulerPhase.set('active');
      this.promoteCandidate(stalled.taskId);
      this.highlightedIds.set(new Set([stalled.taskId]));
      this.lastRuleDecision.set(
        createRuleDecision({
          type: 'idle_promote',
          reason: '主任务完成后优先恢复停滞任务',
          recommendedTaskIds: [stalled.taskId],
        }),
      );
      return;
    }

    const mainIdle = this.entries()
      .filter(entry => entry.isMain && this.isAutoPromotableStatus(entry.status))
      .sort((a, b) => this.entryOrder(a) - this.entryOrder(b))[0];
    if (mainIdle) {
      this.schedulerPhase.set('active');
      this.promoteCandidate(mainIdle.taskId);
      this.lastRuleDecision.set(
        createRuleDecision({
          type: 'idle_promote',
          reason: '主控链存在可运行任务，按入坞顺序推进',
          recommendedTaskIds: [mainIdle.taskId],
        }),
      );
      return;
    }

    const radarCandidates = this.entries().filter(
      entry => !entry.isMain && this.isAutoPromotableStatus(entry.status),
    );
    const focusReference = this.focusingEntry();
    const rankedRadar = rankDockCandidates(
      radarCandidates.map(entry => this.toSchedulerCandidate(entry)),
      PARKING_CONFIG.SCHEDULE_OVER_RUN_ALLOWANCE_MINUTES,
      {
        rootLoad: focusReference?.load ?? null,
        rootProjectId: focusReference ? this.resolveSourceProjectId(focusReference) : null,
      },
    );
    const radarCandidate = rankedRadar.length > 0
      ? radarCandidates.find(entry => entry.taskId === rankedRadar[0].taskId) ?? null
      : null;
    if (radarCandidate) {
      this.schedulerPhase.set('active');
      this.promoteCandidate(radarCandidate.taskId);
      this.highlightedIds.set(new Set([radarCandidate.taskId]));
      this.lastRuleDecision.set(
        createRuleDecision({
          type: 'idle_promote',
          reason: '规则引擎从雷达区拉取最优候选进入主控台',
          recommendedTaskIds: [radarCandidate.taskId],
        }),
      );
      this.highlightClearTimer = setTimeout(() => {
        if (this.pendingDecision()) return;
        this.highlightedIds.set(new Set());
      }, 2000);
      return;
    }

    const recoveredMain = this.entries()
      .filter(entry => entry.isMain && entry.status === 'wait_finished')
      .sort((a, b) => this.entryOrder(a) - this.entryOrder(b))[0];
    if (recoveredMain) {
      this.schedulerPhase.set('active');
      this.highlightedIds.set(new Set([recoveredMain.taskId]));
      this.lastRuleDecision.set(
        createRuleDecision({
          type: 'idle_promote',
          reason: '等待结束任务已恢复，仅置顶高亮等待用户切换',
          recommendedTaskIds: [recoveredMain.taskId],
        }),
      );
    }
  }

  private promoteCandidate(taskId: string, clearDecision: boolean = true): void {
    this.fragmentRest.stopFragmentEntryCountdown();
    this.fragmentRest.setFragmentDismissed(false);
    if (!this.focusMode()) {
      this.entries.update(prev =>
        prev.map(entry =>
          entry.taskId === taskId
            ? {
                ...entry,
                isMain: true,
                status: 'pending_start',
                systemSelected: false,
                recommendationLocked: false,
              }
            : { ...entry, isMain: false },
        ),
      );
      return;
    }

    const currentFocusId = this.focusingEntry()?.taskId ?? null;
    const targetEntry = this.entries().find(entry => entry.taskId === taskId) ?? null;
    this.entries.update(prev => {
      const hasOtherMaster = prev.some(
        entry => entry.taskId !== taskId && entry.status !== 'completed' && entry.isMain,
      );
      return prev.map(entry => {
        if (entry.taskId === taskId) {
          return {
            ...entry,
            isMain: entry.isMain || !hasOtherMaster,
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
            status: this.deriveBackgroundStatus(entry, targetEntry, entry),
          };
        }
        return entry;
      });
    });
    if (currentFocusId && currentFocusId !== taskId) {
      this.lastConsoleDemotedTaskId.set(currentFocusId);
    }
    if (clearDecision) {
      this.clearPendingDecisionIfMatched(taskId);
    }
  }

  private promoteFocusedTaskToMaster(): void {
    this.entries.update(prev => {
      const active = prev.filter(entry => entry.status !== 'completed');
      if (active.length === 0) return prev;
      const hasMaster = active.some(entry => entry.isMain);
      if (hasMaster) return prev;

      const nextMaster =
        active.find(entry => entry.status === 'focusing') ??
        active.find(entry => this.isRunnableStatus(entry.status)) ??
        active[0];
      if (!nextMaster) return prev;

      return prev.map(entry =>
        entry.taskId === nextMaster.taskId
          ? { ...entry, isMain: true }
          : entry,
      );
    });
  }

  /**
   * 主任务一致性修复：
   * 1) completed 任务强制 isMain=false
   * 2) active 任务保证且仅保证一个 isMain=true
   */
  private enforceSingleMainInvariant(
    entries: DockEntry[],
    preferredTaskId: string | null = null,
  ): DockEntry[] {
    if (entries.length === 0) return entries;

    const activeEntries = entries.filter(entry => entry.status !== 'completed');
    if (activeEntries.length === 0) {
      let changed = false;
      const cleared = entries.map(entry => {
        if (!entry.isMain) return entry;
        changed = true;
        return { ...entry, isMain: false };
      });
      return changed ? cleared : entries;
    }

    const ordered = [...activeEntries].sort((a, b) => this.entryOrder(a) - this.entryOrder(b));
    const preferredMain = preferredTaskId
      ? activeEntries.find(entry => entry.taskId === preferredTaskId) ?? null
      : null;
    const existingMain = ordered.find(entry => entry.isMain) ?? null;
    const focusingEntry = activeEntries.find(entry => entry.status === 'focusing') ?? null;
    const fallbackEntry = ordered[0] ?? null;
    const targetMainTaskId =
      preferredMain?.taskId ??
      existingMain?.taskId ??
      focusingEntry?.taskId ??
      fallbackEntry?.taskId ??
      null;

    let changed = false;
    const next = entries.map(entry => {
      const normalizedIsMain =
        entry.status !== 'completed' &&
        targetMainTaskId !== null &&
        entry.taskId === targetMainTaskId;
      if (entry.isMain === normalizedIsMain) return entry;
      changed = true;
      return {
        ...entry,
        isMain: normalizedIsMain,
      };
    });
    return changed ? next : entries;
  }

  /**
   * 主控台可见排序：
   * 1️⃣ focusing 固定第一（C 位）
   * 2️⃣ 命中顺序提示的后台卡按最近一次交互前的相对顺序排列
   * 3️⃣ 刚退出 C 位的 stalled 卡在 fallback 排序中优先第二
   * 4️⃣ 其余 stalled 在前、waiting 在后，按入坞顺序稳定排序
   */
  private sortConsoleEntriesForDisplay(entries: DockEntry[]): DockEntry[] {
    if (entries.length <= 1) return entries;
    const demotedTaskId = this.lastConsoleDemotedTaskId();
    const hintIndex = new Map(
      this.consoleVisibleOrderHint().map((taskId, index) => [taskId, index] as const),
    );
    return [...entries].sort((a, b) => {
      // 1️⃣ C 位：focusing 永远排最前
      if (a.status === 'focusing') return -1;
      if (b.status === 'focusing') return 1;

      // 2️⃣ 最近一次交互命中的四卡顺序优先，保证“选中项前置，其余存活项顺延”
      const aHintIndex = hintIndex.get(a.taskId);
      const bHintIndex = hintIndex.get(b.taskId);
      if (aHintIndex !== undefined || bHintIndex !== undefined) {
        if (aHintIndex !== undefined && bHintIndex !== undefined && aHintIndex !== bHintIndex) {
          return aHintIndex - bHintIndex;
        }
        if (aHintIndex !== undefined && bHintIndex === undefined) return -1;
        if (bHintIndex !== undefined && aHintIndex === undefined) return 1;
      }

      // 3️⃣ 刚离开 C 位的 stalled 卡固定第二（fallback）
      if (demotedTaskId) {
        const aDemoted = a.taskId === demotedTaskId && a.status === 'stalled';
        const bDemoted = b.taskId === demotedTaskId && b.status === 'stalled';
        if (aDemoted && !bDemoted) return -1;
        if (bDemoted && !aDemoted) return 1;
      }

      // 4️⃣ stalled 在 waiting 之前
      const aStalled = a.status === 'stalled';
      const bStalled = b.status === 'stalled';
      if (aStalled && !bStalled) return -1;
      if (bStalled && !aStalled) return 1;

      const aSuspended = this.isWaitingLike(a.status);
      const bSuspended = this.isWaitingLike(b.status);
      if (aSuspended && !bSuspended) return 1;
      if (bSuspended && !aSuspended) return -1;

      // 5️⃣ 同状态按入坞序稳定排列
      if (a.dockedOrder !== b.dockedOrder) return a.dockedOrder - b.dockedOrder;
      return a.taskId.localeCompare(b.taskId);
    });
  }

  private findConsoleEvictionCandidate(
    visibleEntries: DockEntry[],
    currentFocusId: string | null,
  ): string | null {
    for (let index = visibleEntries.length - 1; index >= 0; index -= 1) {
      const entry = visibleEntries[index];
      if (!entry || entry.taskId === currentFocusId || entry.status === 'focusing' || entry.isMain) {
        continue;
      }
      return entry.taskId;
    }
    return null;
  }

  private buildConsoleVisibleOrderHint(
    preVisibleEntries: ReadonlyArray<Pick<DockEntry, 'taskId'>>,
    selectedTaskId: string,
    evictedTaskId: string | null = null,
  ): string[] {
    return [
      selectedTaskId,
      ...preVisibleEntries
        .map(entry => entry.taskId)
        .filter(taskId => taskId !== selectedTaskId && taskId !== evictedTaskId),
    ].slice(0, PARKING_CONFIG.CONSOLE_STACK_VISIBLE_MAX);
  }

  private sortDockEntriesForDisplay(entries: DockEntry[]): DockEntry[] {
    if (entries.length <= 1) return entries;
    const root =
      entries.find(entry => entry.status === 'focusing') ??
      entries.find(entry => entry.isMain) ??
      entries[0] ??
      null;
    const rootProjectId = root ? this.resolveSourceProjectId(root) : null;
    const remainingMinutes = this.resolveOrderingWindowMinutes(root);
    const scoreMap = new Map<string, number>();
    const ranked = rankDockCandidates(
      entries.map(entry => this.toSchedulerCandidate(entry)),
      remainingMinutes,
      {
        rootLoad: root?.load ?? null,
        rootProjectId,
      },
    );
    for (const item of ranked) {
      scoreMap.set(item.taskId, item.score);
    }

    // 排序优先级：主任务 > 手动序 > 调度分数 > 同项目（最低优先级） > 入坞序 > 稳定ID
    // 策划案规定"同项目为最低优先级"，树距离/调度分数应主导排列
    return [...entries].sort((a, b) => {
      if (a.isMain !== b.isMain) return a.isMain ? -1 : 1;

      const aManual = normalizeNullableNumber(a.manualOrder);
      const bManual = normalizeNullableNumber(b.manualOrder);
      if (aManual !== null || bManual !== null) {
        if (aManual === null) return 1;
        if (bManual === null) return -1;
        if (aManual !== bManual) return aManual - bManual;
      }

      const aScore = scoreMap.get(a.taskId) ?? Number.MIN_SAFE_INTEGER;
      const bScore = scoreMap.get(b.taskId) ?? Number.MIN_SAFE_INTEGER;
      if (aScore !== bScore) return bScore - aScore;

      // 同项目为最低优先级弱上下文，仅在调度分数一致时参与排序
      const aSameProject = rootProjectId && this.resolveSourceProjectId(a) === rootProjectId ? 1 : 0;
      const bSameProject = rootProjectId && this.resolveSourceProjectId(b) === rootProjectId ? 1 : 0;
      if (aSameProject !== bSameProject) return bSameProject - aSameProject;

      if (a.dockedOrder !== b.dockedOrder) return a.dockedOrder - b.dockedOrder;
      return a.taskId.localeCompare(b.taskId);
    });
  }

  private resolveOrderingWindowMinutes(root: DockEntry | null): number {
    if (!root) return 30;
    const waitSeconds = this.getWaitRemainingSeconds(root);
    if (waitSeconds !== null && waitSeconds > 0) {
      return Math.max(1, Math.ceil(waitSeconds / 60));
    }
    if (root.expectedMinutes && root.expectedMinutes > 0) {
      return root.expectedMinutes;
    }
    return 30;
  }

  private buildOverflowMeta(entries: DockEntry[]): { comboSelectOverflow: number; backupOverflow: number } {
    const comboCount = entries.filter(entry => !entry.isMain && entry.lane === 'combo-select').length;
    const backupCount = entries.filter(entry => !entry.isMain && entry.lane === 'backup').length;
    return {
      comboSelectOverflow: Math.max(0, comboCount - PARKING_CONFIG.RADAR_COMBO_VISIBLE_LIMIT),
      backupOverflow: Math.max(0, backupCount - PARKING_CONFIG.RADAR_BACKUP_VISIBLE_LIMIT),
    };
  }

  private nextManualOrder(): number {
    const orders = this.entries()
      .map(entry => entry.manualOrder)
      .filter((value): value is number => Number.isFinite(value));
    if (orders.length === 0) return this.entries().length;
    return Math.max(...orders) + 1;
  }

  private entryOrder(entry: DockEntry): number {
    if (Number.isFinite(entry.manualOrder)) {
      return Number(entry.manualOrder);
    }
    return entry.dockedOrder;
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

  private hasActiveWaitTimer(entry: DockEntry): boolean {
    if (!entry.waitStartedAt || !entry.waitMinutes) return false;
    return !this.isWaitExpired(entry);
  }

  private isWaitingLike(status: DockTaskStatus): boolean {
    return status === 'suspended_waiting' || status === 'wait_finished';
  }

  private isRunnableStatus(status: DockTaskStatus): boolean {
    return status === 'pending_start' || status === 'wait_finished' || status === 'stalled';
  }

  private isAutoPromotableStatus(status: DockTaskStatus): boolean {
    return status === 'pending_start' || status === 'stalled';
  }

  private isConsoleBackgroundStatus(status: DockTaskStatus): boolean {
    return this.isWaitingLike(status) || status === 'stalled';
  }

  private deriveBackgroundStatus(
    entry: DockEntry,
    nextTarget: DockEntry | null = null,
    currentFocus: DockEntry | null = null,
  ): DockTaskStatus {
    if (this.hasActiveWaitTimer(entry)) {
      return 'suspended_waiting';
    }
    if (entry.waitStartedAt && entry.waitMinutes) {
      return 'wait_finished';
    }
    if (currentFocus && !currentFocus.isMain && nextTarget?.isMain) {
      return 'stalled';
    }
    if (entry.status === 'stalled') {
      return 'stalled';
    }
    // 当前 C 位 focusing 任务退出 C 位时保留在主控台，
    // 防止非 isMain 的 focusing 任务被降级为 pending_start 后从主控台掉落到备选区
    if (entry.status === 'focusing') {
      return 'stalled';
    }
    return 'pending_start';
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
      overflowMeta: this.buildOverflowMeta(activeEntries),
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
      return this.enforceSingleMainInvariant(hydrated, null);
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
      return this.enforceSingleMainInvariant(hydrated, session.mainTaskId);
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
    return this.enforceSingleMainInvariant(hydrated, session.mainTaskId);
  }

  private refreshSuspendRecommendationLock(): void {
    const hasSuspended = this.entries().some(entry => this.isWaitingLike(entry.status));
    if (hasSuspended) return;

    this.suspendRecommendationLocked.set(false);
    this.suspendChainRootTaskId.set(null);
    this.pendingDecision.set(null);
    this.highlightedIds.set(new Set());
    this.entries.update(prev => this.clearSuspendRecommendationStateOnEntries(prev));
  }

  private checkWaitExpiry(): void {
    let shouldPlaySound = false;
    this.entries.update(prev => {
      let changed = false;
      const next = [...prev];
      for (let index = 0; index < prev.length; index += 1) {
        const entry = prev[index];
        if (entry.status !== 'suspended_waiting' || !entry.waitStartedAt || !entry.waitMinutes) continue;
        if (!this.isWaitExpired(entry)) continue;
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
    if (this.pendingCandidateIds(pending).length > 0) return;
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
    this.enterFragmentPhase('tight-blank 超时，自动进入留白期', pending.rootTaskId, pending.rootRemainingMinutes);
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

  private toStatusMachineEntry(entry: DockEntry): StatusMachineEntry {
    const remainingSec = this.getWaitRemainingSeconds(entry);
    const totalSec = entry.waitMinutes ? entry.waitMinutes * 60 : null;
    const uiStatus = this.mapDockStatusToUiStatus(entry.status);
    let label: StatusMachineEntry['label'];

    switch (uiStatus) {
      case 'focusing':
        label = '专注中';
        break;
      case 'waiting_done':
        label = '等待结束';
        break;
      case 'suspended_waiting':
        label = '挂起等待';
        break;
      case 'stalled':
        label = '停滞中';
        break;
      default:
        label = '待启动';
        break;
    }

    return {
      taskId: entry.taskId,
      title: entry.title,
      uiStatus,
      label,
      waitRemainingSeconds: remainingSec,
      waitTotalSeconds: totalSec,
    };
  }

  private mapDockStatusToUiStatus(status: DockTaskStatus): DockUiStatus {
    if (status === 'focusing') return 'focusing';
    if (status === 'suspended_waiting') return 'suspended_waiting';
    if (status === 'wait_finished') return 'waiting_done';
    if (status === 'stalled') return 'stalled';
    return 'queued';
  }

  private resetDailySlotsIfNeeded(): void {
    const today = this.todayDateKey();
    if (today === this.dailyResetDate()) return;
    this.dailyResetDate.set(today);
    this.dailySlots.update(prev => prev.map(slot => ({ ...slot, todayCompletedCount: 0 })));
  }

  private todayDateKey(now: Date = new Date()): string {
    const rawResetHour = Number(this.focusPreferenceService.preferences().routineResetHourLocal);
    const resetHour = Number.isFinite(rawResetHour)
      ? Math.min(23, Math.max(0, Math.floor(rawResetHour)))
      : PARKING_CONFIG.ROUTINE_RESET_HOUR_DEFAULT;
    const logicalDate = new Date(now);
    if (logicalDate.getHours() < resetHour) {
      logicalDate.setDate(logicalDate.getDate() - 1);
    }
    const year = logicalDate.getFullYear();
    const month = String(logicalDate.getMonth() + 1).padStart(2, '0');
    const day = String(logicalDate.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  private scheduleLocalPersist(_snapshot: DockSnapshot | null, userId: string | null): void {
    this.snapshotPersistence.scheduleLocalPersist(
      () => this.exportSnapshot(),
      userId,
      () => this.getNonCriticalHoldDelay(),
    );
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
  // v3.0 碎片阶段防御等级（§7.8）
  // ============================================

  /**
   * 更新碎片阶段防御等级（策划案 §7.8 四级防御体系）
   * 基于最短等待时间和倦怠状态判定
   */
  private updateFragmentDefenseLevel(): void {
    if (this.fragmentDefenseLevel() === 4 && this.isFragmentPhase()) {
      this.schedulerPhase.set('paused');
      return;
    }

    const waitingEntries = this.entries().filter(
      entry => entry.status === 'suspended_waiting' && entry.waitStartedAt && entry.waitMinutes,
    );
    if (waitingEntries.length === 0) {
      this.fragmentRest.stopFragmentEntryCountdown();
      this.fragmentRest.setFragmentDismissed(false);
      this.fragmentDefenseLevel.set(1);
      this.schedulerPhase.set('active');
      return;
    }

    const shortestWaitMin = Math.min(
      ...waitingEntries.map(entry => {
        const remaining = this.getWaitRemainingSeconds(entry);
        return remaining !== null ? remaining / 60 : Infinity;
      }),
    );

    const hasBurnout = this.burnoutTriggeredAt() !== null;
    this.fragmentDefenseLevel.set(determineFragmentDefenseLevel(shortestWaitMin, hasBurnout));
    this.schedulerPhase.set('paused');
  }

  /**
   * 倦怠冷却检查（策划案 §7.8 NG-16b）
   * 在 tick 中调用，检查倦怠冷却期是否已过
   */
  private checkBurnoutCooldown(): void {
    const burnoutAt = this.burnoutTriggeredAt();
    if (burnoutAt === null) return;
    if (Date.now() - burnoutAt > PARKING_CONFIG.BURNOUT_COOLDOWN_MS) {
      this.burnoutTriggeredAt.set(null);
      this.highLoadCounter.set({ count: 0, windowStartAt: 0 });
      this.logger.info('倦怠冷却期结束，计数器重置');
    }
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
   * v3.0 将 DockEntry 转换为 FocusTaskSlot（用于三维推荐阵列）
   */
  private toFocusTaskSlot(entry: DockEntry, zone: 'command' | 'combo-select' | 'backup' = 'command', idx = 0): FocusTaskSlot {
    return {
      slotId: entry.taskId,
      taskId: entry.taskId,
      estimatedMinutes: entry.expectedMinutes,
      waitMinutes: entry.waitMinutes,
      cognitiveLoad: entry.load,
      focusStatus: this.mapDockStatusToFocusStatus(entry.status),
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
    };
  }

  /**
   * v3.0 使用三维推荐阵列增强挂起推荐（策划案 §4.2.4）
   * 在首次挂起时触发，替代原始单分数排序
   */
  computeRecommendationForSuspended(suspendedTaskId: string, waitMinutes: number): void {
    const suspendedEntry = this.entries().find(e => e.taskId === suspendedTaskId);
    if (!suspendedEntry) return;

    const mainSlot = this.toFocusTaskSlot(suspendedEntry, 'command', 0);
    const pendingEntries = this.entries().filter(
      e => this.isAutoPromotableStatus(e.status) && e.taskId !== suspendedTaskId,
    );
    const pendingSlots = pendingEntries.map((e, i) => this.toFocusTaskSlot(e, 'combo-select', i));

    const groups = computeThreeDimensionalRecommendation(mainSlot, pendingSlots, waitMinutes);
    this.lastRecommendationGroups.set(groups);
  }
}
