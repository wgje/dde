import { Injectable, computed, inject, signal } from '@angular/core';
import { PARKING_CONFIG } from '../config/parking.config';
import {
  CognitiveLoad,
  DailySlotEntry,
  DockLane,
  DockExitAction,
  DockSchedulerPhase,
  DockEntry,
  DockFocusTransitionState,
  DockPendingDecision,
  DockRuleDecision,
  DockSourceSection,
  DockSnapshot,
  DockZoneSource,
  FragmentDefenseLevel,
  HighLoadCounter,
} from '../models/parking-dock';
import { TaskStore } from '../core-bridge';
import { BlackBoxService } from './black-box.service';
import { LoggerService } from './logger.service';
import { ProjectStateService } from './project-state.service';
import { ToastService } from './toast.service';
import { FocusHudWindowService } from './focus-hud-window.service';
import {
  DockSnapshotPersistenceService,
} from './dock-snapshot-persistence.service';
import { DockCloudSyncService } from './dock-cloud-sync.service';
import { DockCompletionFlowService } from './dock-completion-flow.service';
import { DockDailySlotService } from './dock-daily-slot.service';
import { DockFragmentRestService } from './dock-fragment-rest.service';
import { DockInlineCreationService } from './dock-inline-creation.service';
import { DockEntryFieldService } from './dock-entry-field.service';
import { DockPromotionService } from './dock-promotion.service';
import { DockTaskSyncService } from './dock-task-sync.service';
import { DockZoneService } from './dock-zone.service';
import { DockEngineLifecycleService } from './dock-engine-lifecycle.service';
import { DockSnapshotManagerService } from './dock-snapshot-manager.service';
import { DockEntryCrudService, type DockSnapshotOverrides } from './dock-entry-crud.service';
import { DockTaskFlowService } from './dock-task-flow.service';
import { TimerHandle } from '../utils/timer-handle';
import {
  applyDockSnapshotOverrides,
  getWaitRemainingSeconds,
} from './dock-engine.utils';
import { createDockEngineViewSignals } from './dock-engine-view-signals';

@Injectable({
  providedIn: 'root',
})
export class DockEngineService {
  private static readonly DEFAULT_DOCK_EXPANDED_PREFERENCE = false;

  private readonly taskStore = inject(TaskStore);
  private readonly logger = inject(LoggerService).category('DockEngine');
  private readonly projectState = inject(ProjectStateService);
  private readonly blackBoxService = inject(BlackBoxService);
  private readonly toast = inject(ToastService);
  private readonly focusHudWindow = inject(FocusHudWindowService);
  private readonly snapshotPersistence = inject(DockSnapshotPersistenceService);
  private readonly cloudSync = inject(DockCloudSyncService);
  /** 公开子服务——组件可直接调用碎片/休息相关 API，无需经过 engine 委托 */
  readonly fragmentRest = inject(DockFragmentRestService);
  private readonly zoneService = inject(DockZoneService);
  private readonly completionFlow = inject(DockCompletionFlowService);
  private readonly promotionService = inject(DockPromotionService);
  private readonly inlineCreation = inject(DockInlineCreationService);
  /** 公开子服务——组件可直接调用日常任务槽 API，无需经过 engine 委托 */
  readonly dailySlotService = inject(DockDailySlotService);
  private readonly taskSync = inject(DockTaskSyncService);
  private readonly entryField = inject(DockEntryFieldService);
  /** C-2: 生命周期管理（effects、tick、维护调度）提取至专属服务 */
  private readonly lifecycle = inject(DockEngineLifecycleService);
  /** 快照/会话管理服务，负责快照导出恢复、会话状态构建等 */
  private readonly snapshotManager = inject(DockSnapshotManagerService);
  /** 条目 CRUD 操作服务，负责任务入坞、主任务设置、雷达区操作等 */
  private readonly entryCrud = inject(DockEntryCrudService);
  /** 任务流程操作服务，负责专注模式、完成流程、挂起切换、决策处理等 */
  private readonly taskFlow = inject(DockTaskFlowService);

  /**
   * 持久化信号预期总数（与 persistenceDeps 内数组长度一对一对应）。
   * 新增/删除持久化信号时，必须同步更新此值，否则 dev 断言会在首次 effect 运行时报错。
   */
  private static readonly EXPECTED_PERSISTED_SIGNAL_COUNT = 16;

  readonly entries = signal<DockEntry[]>([]);
  readonly focusMode = signal(false);
  readonly focusTransition = signal<DockFocusTransitionState | null>(null);
  private readonly focusChromeRestoring = signal(false);
  readonly dockExpanded = signal(DockEngineService.DEFAULT_DOCK_EXPANDED_PREFERENCE);
  readonly muteWaitTone = signal(false);
  readonly focusScrimOn = signal(true);
  readonly dailySlots = signal<DailySlotEntry[]>([]);
  readonly highlightedIds = signal<Set<string>>(new Set(), {
    equal: (a, b) => a.size === b.size && [...a].every(id => b.has(id)),
  });
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
  private readonly snapshotSavedAt = signal(new Date().toISOString());
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

  /** 持久化脏标记：聚合所有影响快照持久化的信号，避免多次冗余持久化。 */
  private readonly persistenceDeps = computed(() => {
    // 读取所有持久化相关信号以建立依赖关系
    // 返回新数组使 Object.is 检测到变更，无需自定义 equal
    const deps = [
      this.entries(),
      this.focusMode(),
      this.dockExpanded(),
      this.muteWaitTone(),
      this.focusScrimOn(),
      this.firstDragIntervened(),
      this.dailySlots(),
      this.suspendChainRootTaskId(),
      this.suspendRecommendationLocked(),
      this.pendingDecision(),
      this.lastRuleDecision(),
      this.dailyResetDate(),
      this.focusSessionContext(),
      // v3.0 倦怠检测 + 调度器阶段（§7.8）——缺失会导致这三个信号变更后不触发持久化
      this.highLoadCounter(),
      this.burnoutTriggeredAt(),
      this.schedulerPhase(),
    ];
    // dev 守卫：持久化信号数量漂移检测
    if (typeof ngDevMode === 'undefined' || ngDevMode) {
      if (deps.length !== DockEngineService.EXPECTED_PERSISTED_SIGNAL_COUNT) {
        this.logger.error(
          `persistenceDeps 信号数量不匹配：` +
          `预期 ${DockEngineService.EXPECTED_PERSISTED_SIGNAL_COUNT}，实际 ${deps.length}。` +
          `请同步更新 EXPECTED_PERSISTED_SIGNAL_COUNT、exportSnapshot 和 hydrateSignalsFromSnapshot。`,
        );
      }
    }
    return deps;
  });

  private readonly firstDragIntervened = signal(false);
  private readonly firstMainSelectionWindow = signal<{ taskId: string; expiresAt: number } | null>(null);
  private readonly suspendRecommendationLocked = signal(false);
  private readonly suspendChainRootTaskId = signal<string | null>(null);
  private readonly focusSessionContext = signal<{ id: string; startedAt: number } | null>(null);
  private readonly softLimitNoticeShown = signal(false);

  private readonly localPersist = new TimerHandle();
  private readonly firstMainSelection = new TimerHandle();
  private readonly highlightClearTimer = new TimerHandle();
  private readonly focusChromeRestoreTimer = new TimerHandle();

  private currentSnapshotUserId: string | null = null;
  private dockExpandedPreference = DockEngineService.DEFAULT_DOCK_EXPANDED_PREFERENCE;
  /** 快照恢复锁：使用 signal 确保 effect 能响应式追踪恢复状态，避免异步竞态 */
  private readonly restoringSnapshot = signal(false);
  private waitEndNotifiedIds = new Set<string>();
  private readonly blankPeriodNotified = signal(false);
  private readonly fragmentCountdownNotified = signal(false);

  private readonly viewSignals = createDockEngineViewSignals({
    entries: this.entries,
    firstMainSelectionWindow: this.firstMainSelectionWindow,
    focusTransition: this.focusTransition,
    focusMode: this.focusMode,
    focusScrimOn: this.focusScrimOn,
    focusChromeRestoring: this.focusChromeRestoring,
    pendingRadarEviction: this.pendingRadarEviction,
    pendingDecision: this.pendingDecision,
    burnoutTriggeredAt: this.burnoutTriggeredAt,
    fragmentEntryCountdown: this.fragmentEntryCountdown,
    dailySlots: this.dailySlots,
    tick: this.tick,
    completionFlow: this.completionFlow,
    zoneService: this.zoneService,
    fragmentRest: this.fragmentRest,
  });
  readonly dockedEntries = this.viewSignals.dockedEntries;
  readonly orderedDockEntries = this.viewSignals.orderedDockEntries;
  readonly dockedCount = this.viewSignals.dockedCount;
  readonly dockedTaskIds = this.viewSignals.dockedTaskIds;
  readonly dockCapacity = this.viewSignals.dockCapacity;
  readonly firstMainSelectionPending = this.viewSignals.firstMainSelectionPending;
  readonly isFocusTransitionBlocking = this.viewSignals.isFocusTransitionBlocking;
  readonly focusChromePhase = this.viewSignals.focusChromePhase;
  readonly consoleEntries = this.viewSignals.consoleEntries;
  readonly consoleVisibleEntries = this.viewSignals.consoleVisibleEntries;
  readonly focusingEntry = this.viewSignals.focusingEntry;
  readonly suspendedEntries = this.viewSignals.suspendedEntries;
  readonly comboSelectEntries = this.viewSignals.comboSelectEntries;
  readonly backupEntries = this.viewSignals.backupEntries;
  readonly isBurnoutActive = this.viewSignals.isBurnoutActive;
  readonly blankPeriodActive = this.viewSignals.blankPeriodActive;
  readonly isFragmentPhase = this.viewSignals.isFragmentPhase;
  readonly availableDailySlots = this.viewSignals.availableDailySlots;
  readonly availableFragmentDockTasks = this.viewSignals.availableFragmentDockTasks;
  readonly statusMachineEntries = this.viewSignals.statusMachineEntries;
  readonly pendingDecisionEntries = this.viewSignals.pendingDecisionEntries;

  constructor() {
    this.initSubServices();
    this.initLifecycle();
  }

  // ---------------------------------------------------------------------------
  //  Constructor 子初始化流程
  // ---------------------------------------------------------------------------

  /** C-2: 初始化生命周期服务并委托 effects、tick、visibility、cleanup */
  private initLifecycle(): void {
    this.lifecycle.init({
      entries: this.entries,
      focusMode: this.focusMode,
      muteWaitTone: this.muteWaitTone,
      pendingDecision: this.pendingDecision,
      highlightedIds: this.highlightedIds,
      editLock: this.editLock,
      suspendRecommendationLocked: this.suspendRecommendationLocked,
      suspendChainRootTaskId: this.suspendChainRootTaskId,
      softLimitNoticeShown: this.softLimitNoticeShown,
      restoringSnapshot: this.restoringSnapshot,
      blankPeriodNotified: this.blankPeriodNotified,
      fragmentCountdownNotified: this.fragmentCountdownNotified,
      tick: this.tick,
      persistenceDeps: () => this.persistenceDeps(),
      dockedCount: () => this.dockedCount(),
      statusMachineEntries: () => this.statusMachineEntries(),
      pendingDecisionEntries: () => this.pendingDecisionEntries(),
      focusingEntry: () => this.focusingEntry(),
      fragmentEntryCountdown: () => this.fragmentEntryCountdown(),
      waitEndNotifiedIds: this.waitEndNotifiedIds,
      getCurrentSnapshotUserId: () => this.currentSnapshotUserId,
      setCurrentSnapshotUserId: (userId) => { this.currentSnapshotUserId = userId; },
      exportSnapshot: () => this.exportSnapshot(),
      restoreSnapshot: (snapshot) => this.restoreSnapshot(snapshot),
      reset: () => this.reset(),
      reconcileExternallyCompletedTasks: (taskIds) => this.reconcileExternallyCompletedTasks(taskIds),
      buildNormalizeContext: () => this.snapshotManager.buildNormalizeContext(),
      getNonCriticalHoldDelay: () => this.lifecycle.getNonCriticalHoldDelay(),
      scheduleLocalPersist: (snapshot, userId) => this.scheduleLocalPersist(snapshot, userId),
      setSnapshotSavedAt: (savedAt) => this.snapshotSavedAt.set(savedAt),
    });
    this.lifecycle.startTickTimer();
    this.lifecycle.restoreInitialSnapshot();
    this.lifecycle.registerEffects();
    this.lifecycle.registerVisibilityListener();
    this.lifecycle.registerDestroyCleanup(() => {
      // engine 侧额外清理
      this.taskFlow.destroy();
      this.entryCrud.destroy();
      this.highlightClearTimer.cancel();
      this.localPersist.cancel();
      this.firstMainSelection.cancel();
      this.focusChromeRestoreTimer.cancel();
    });
  }

  private initSubServices(): void {
    this.initSnapshotManager();
    this.initCompletionAndSupportServices();
    this.initEntryServices();
    this.initTaskFlow();
  }

  private initSnapshotManager(): void {
    this.snapshotManager.init({
      entries: this.entries,
      focusMode: this.focusMode,
      dockExpanded: this.dockExpanded,
      muteWaitTone: this.muteWaitTone,
      focusScrimOn: this.focusScrimOn,
      firstDragIntervened: this.firstDragIntervened,
      dailySlots: this.dailySlots,
      suspendChainRootTaskId: this.suspendChainRootTaskId,
      suspendRecommendationLocked: this.suspendRecommendationLocked,
      pendingDecision: this.pendingDecision,
      lastRuleDecision: this.lastRuleDecision,
      dailyResetDate: this.dailyResetDate,
      focusSessionContext: this.focusSessionContext,
      highLoadCounter: this.highLoadCounter,
      burnoutTriggeredAt: this.burnoutTriggeredAt,
      schedulerPhase: this.schedulerPhase,
      lastRecommendationGroups: this.lastRecommendationGroups,
      lastExitAction: this.lastExitAction,
      focusTransition: this.focusTransition,
      highlightedIds: this.highlightedIds,
      editLock: this.editLock,
      fragmentDefenseLevel: this.fragmentDefenseLevel,
      lastConsoleDemotedTaskId: this.lastConsoleDemotedTaskId,
      consoleVisibleOrderHint: this.consoleVisibleOrderHint,
      snapshotSavedAt: this.snapshotSavedAt,
      waitEndNotifiedIds: this.waitEndNotifiedIds,
      getDockExpandedPreference: () => this.getDockExpandedPreference(),
      persistDockExpandedPreference: (expanded: boolean) => this.persistDockExpandedPreference(expanded),
      clearFirstMainSelectionWindow: () => this.clearFirstMainSelectionWindow(),
      rebalanceAutoZones: () => this.rebalanceAutoZones(),
    });
  }

  private initCompletionAndSupportServices(): void {
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
      consoleVisibleEntries: this.consoleVisibleEntries,
      focusingEntry: this.focusingEntry,
      focusMode: this.focusMode,
      suspendChainRootTaskId: this.suspendChainRootTaskId,
      highlightClearTimer: this.highlightClearTimer,
    });
    this.cloudSync.init(this.buildCloudSyncContext());
    this.fragmentRest.init(this.buildFragmentRestContext());
    this.inlineCreation.init(this.buildInlineCreationContext());
    this.dailySlotService.init({
      dailySlots: this.dailySlots,
      dailyResetDate: this.dailyResetDate,
      schedulerPhase: this.schedulerPhase,
      fragmentDefenseLevel: this.fragmentDefenseLevel,
      isFragmentPhase: this.isFragmentPhase,
      persistCurrentSnapshot: () => this.persistDockSnapshotNow(this.entries()),
    });
  }

  private initEntryServices(): void {
    this.entryField.init({
      entries: this.entries,
      focusSessionContext: () => this.focusSessionContext(),
      rebalanceAutoZones: () => this.rebalanceAutoZones(),
      persistDockSnapshotNow: (entries: DockEntry[], overrides?: DockSnapshotOverrides) => this.persistDockSnapshotNow(entries, overrides),
    });
    this.entryCrud.init({
      entries: this.entries,
      focusMode: this.focusMode,
      muteWaitTone: this.muteWaitTone,
      dockExpanded: this.dockExpanded,
      focusScrimOn: this.focusScrimOn,
      firstDragIntervened: this.firstDragIntervened,
      pendingDecision: this.pendingDecision,
      highlightedIds: this.highlightedIds,
      suspendRecommendationLocked: this.suspendRecommendationLocked,
      suspendChainRootTaskId: this.suspendChainRootTaskId,
      lastRadarInsertedTaskId: this.lastRadarInsertedTaskId,
      lastRadarEvictedTaskId: this.lastRadarEvictedTaskId,
      pendingRadarEviction: this.pendingRadarEviction,
      lastConsoleDemotedTaskId: this.lastConsoleDemotedTaskId,
      consoleVisibleOrderHint: this.consoleVisibleOrderHint,
      firstMainSelectionWindow: this.firstMainSelectionWindow,
      waitEndNotifiedIds: this.waitEndNotifiedIds,
      focusingEntry: this.focusingEntry,
      consoleEntries: this.consoleEntries,
      consoleVisibleEntries: this.consoleVisibleEntries,
      switchToTask: (taskId: string) => this.taskFlow.switchToTask(taskId),
      completeTask: (taskId: string) => this.taskFlow.completeTask(taskId),
      rebalanceAutoZones: () => this.rebalanceAutoZones(),
      clearFirstMainSelectionWindow: () => this.clearFirstMainSelectionWindow(),
      startFirstMainSelectionWindow: (taskId: string) => this.startFirstMainSelectionWindow(taskId),
      persistDockSnapshotNow: (entries: DockEntry[], overrides?: DockSnapshotOverrides) =>
        this.persistDockSnapshotNow(entries, overrides),
    });
  }

  private initTaskFlow(): void {
    this.taskFlow.init({
      entries: this.entries,
      focusMode: this.focusMode,
      focusScrimOn: this.focusScrimOn,
      schedulerPhase: this.schedulerPhase,
      focusSessionContext: this.focusSessionContext,
      lastRuleDecision: this.lastRuleDecision,
      lastRecommendationGroups: this.lastRecommendationGroups,
      focusTransition: this.focusTransition,
      pendingDecision: this.pendingDecision,
      highlightedIds: this.highlightedIds,
      suspendRecommendationLocked: this.suspendRecommendationLocked,
      suspendChainRootTaskId: this.suspendChainRootTaskId,
      highLoadCounter: this.highLoadCounter,
      burnoutTriggeredAt: this.burnoutTriggeredAt,
      lastConsoleDemotedTaskId: this.lastConsoleDemotedTaskId,
      consoleVisibleOrderHint: this.consoleVisibleOrderHint,
      waitEndNotifiedIds: this.waitEndNotifiedIds,
      focusingEntry: this.focusingEntry,
      consoleEntries: this.consoleEntries,
      consoleVisibleEntries: this.consoleVisibleEntries,
      rebalanceAutoZones: () => this.rebalanceAutoZones(),
      clearFirstMainSelectionWindow: () => this.clearFirstMainSelectionWindow(),
      startFirstMainSelectionWindow: (taskId: string) => this.startFirstMainSelectionWindow(taskId),
      persistDockSnapshotNow: (entries: DockEntry[]) => this.persistDockSnapshotNow(entries),
    });
  }

  private buildCloudSyncContext() {
    return {
      exportSnapshot: () => this.exportSnapshot(),
      restoreSnapshot: (snapshot: DockSnapshot) => this.restoreSnapshot(snapshot),
      scheduleLocalPersist: (snapshot: DockSnapshot, userId: string) => this.scheduleLocalPersist(snapshot, userId),
      persistLocalSnapshotImmediately: (snapshot: DockSnapshot, userId: string) =>
        this.persistLocalSnapshotImmediately(snapshot, userId),
      updateDailySlots: (updater: (prev: DailySlotEntry[]) => DailySlotEntry[]) => this.dailySlots.update(updater),
      getNonCriticalHoldDelay: () => this.lifecycle.getNonCriticalHoldDelay(),
      getFocusSessionContext: () => this.focusSessionContext(),
      setFocusSessionContext: (ctx: { id: string; startedAt: number }) => this.focusSessionContext.set(ctx),
      buildNormalizeContext: () => this.snapshotManager.buildNormalizeContext(),
      getCurrentSnapshotUserId: () => this.currentSnapshotUserId,
    };
  }

  private buildFragmentRestContext() {
    return {
      enterFragmentPhase: (reason: string, rootTaskId?: string, remainingMinutes?: number) =>
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
      getWaitRemainingSeconds: (entry: DockEntry) => getWaitRemainingSeconds(entry),
    };
  }

  private buildInlineCreationContext() {
    return {
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
    };
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
  ): Promise<boolean> {
    return this.entryCrud.dockTask(taskId, lane, options);
  }

  dockTaskFromExternalDrag(taskId: string, sourceSection?: Extract<DockSourceSection, 'text' | 'flow'>): Promise<boolean> {
    return this.entryCrud.dockTaskFromExternalDrag(taskId, sourceSection);
  }

  createInDock(
    title: string,
    lane: DockLane,
    load: CognitiveLoad = 'low',
    options?: { expectedMinutes?: number | null; waitMinutes?: number | null; detail?: string },
  ): Promise<string | null> {
    return this.inlineCreation.createInDock(title, lane, load, options);
  }

  private reconcileExternallyCompletedTasks(taskIds: string[]): void {
    this.entryCrud.reconcileExternallyCompletedTasks(taskIds);
  }

  getInlineArchiveCandidates(): DockEntry[] {
    return this.inlineCreation.getInlineArchiveCandidates();
  }

  archiveInlineEntriesToActiveProject(): Promise<{ converted: number; failed: number }> {
    return this.inlineCreation.archiveInlineEntriesToActiveProject();
  }

  setMainTask(taskId: string): void {
    this.entryCrud.setMainTask(taskId);
  }

  insertToConsoleFromRadar(taskId: string): string | null {
    return this.entryCrud.insertToConsoleFromRadar(taskId);
  }

  flushRadarEviction(taskId: string): void {
    this.entryCrud.flushRadarEviction(taskId);
  }

  overrideFirstMainTask(taskId: string): void {
    this.entryCrud.overrideFirstMainTask(taskId);
  }

  markExitAction(action: DockExitAction): void {
    this.lastExitAction.set(action);
  }

  clearDockForExit(): Promise<boolean> {
    return this.entryCrud.clearDockForExit();
  }

  finalizeClearDockForExit(): Promise<boolean> {
    this.dailySlots.set([]);
    this.lastRuleDecision.set(null);
    this.zoneService.clearAdjacencyCache();
    return this.persistDockSnapshotNow(this.entries());
  }

  reorderDockEntries(sourceTaskId: string, targetTaskId: string): Promise<boolean> {
    return this.entryCrud.reorderDockEntries(sourceTaskId, targetTaskId);
  }

  setDockExpanded(
    expanded: boolean,
    options?: { persistPreference?: boolean },
  ): Promise<boolean> {
    return this.entryCrud.setDockExpanded(expanded).then(persisted => {
      if (persisted && (options?.persistPreference ?? true)) {
        this.persistDockExpandedPreference(expanded);
      }
      return persisted;
    });
  }

  toggleMuteWaitTone(): Promise<boolean> {
    return this.entryCrud.toggleMuteWaitTone();
  }

  toggleLoad(taskId: string, direction: 'up' | 'down'): Promise<boolean> {
    return this.entryField.toggleLoad(taskId, direction);
  }

  setExpectedTime(taskId: string, minutes: number | null): Promise<boolean> {
    return this.entryField.setExpectedTime(taskId, minutes);
  }

  setWaitTime(taskId: string, minutes: number | null): Promise<boolean> {
    return this.entryField.setWaitTime(taskId, minutes);
  }

  setDetail(taskId: string, detail: string): Promise<boolean> {
    return this.entryField.setDetail(taskId, detail);
  }

  setLane(taskId: string, lane: DockLane, zoneSource: DockZoneSource = 'manual'): Promise<boolean> {
    return this.entryField.setLane(taskId, lane, zoneSource);
  }

  toggleFocusMode(): Promise<boolean> {
    this.clearFocusChromeRestore();
    return this.taskFlow.toggleFocusMode();
  }

  toggleFocusScrim(): Promise<boolean> {
    return this.setFocusScrim(!this.focusScrimOn());
  }

  setFocusScrim(on: boolean): Promise<boolean> {
    if (this.focusScrimOn() === on) return Promise.resolve(true);
    return this.persistDockSnapshotNow(this.entries(), { focusScrimOn: on }).then(persisted => {
      if (!persisted) return false;
      this.focusScrimOn.set(on);
      return true;
    });
  }

  beginFocusTransition(state: DockFocusTransitionState): void {
    this.clearFocusChromeRestore();
    this.focusTransition.set(state);
  }

  endFocusTransition(): void {
    this.focusTransition.set(null);
  }

  beginFocusChromeRestore(durationMs: number = PARKING_CONFIG.DOCK_ANIMATION_MS): void {
    this.focusChromeRestoreTimer.cancel();
    if (durationMs <= 0) {
      this.focusChromeRestoring.set(false);
      return;
    }

    this.focusChromeRestoring.set(true);
    this.focusChromeRestoreTimer.schedule(() => {
      this.focusChromeRestoring.set(false);
    }, durationMs);
  }

  clearFocusChromeRestore(): void {
    this.focusChromeRestoreTimer.cancel();
    this.focusChromeRestoring.set(false);
  }

  holdNonCriticalWork(durationMs: number): void {
    this.lifecycle.holdNonCriticalWork(durationMs);
  }

  completeTask(taskId: string): void {
    this.taskFlow.completeTask(taskId);
  }

  suspendTask(taskId: string, waitMinutes: number): Promise<boolean> {
    return this.taskFlow.suspendTask(taskId, waitMinutes);
  }

  switchToTask(taskId: string): Promise<boolean> {
    return this.taskFlow.switchToTask(taskId);
  }

  choosePendingDecisionCandidate(taskId: string): Promise<boolean> {
    return this.taskFlow.choosePendingDecisionCandidate(taskId);
  }

  cancelPendingDecisionAutoPromote(): Promise<boolean> {
    return this.taskFlow.cancelPendingDecisionAutoPromote();
  }

  removeFromDock(taskId: string): Promise<boolean> {
    return this.taskFlow.removeFromDock(taskId);
  }

  dismissZenMode(): void {
    this.fragmentRest.dismissZenMode();
  }

  acquireDockEditLock(): void {
    this.editLock.set(true);
  }

  releaseDockEditLock(): void {
    this.editLock.set(false);
  }

  exportSnapshot(): DockSnapshot {
    return this.snapshotManager.exportSnapshot();
  }

  restoreSnapshot(snapshot: DockSnapshot): void {
    // C-1 fix: try/finally 保护 restoringSnapshot 标志，防止异常导致永久卡住
    this.restoringSnapshot.set(true);
    try {
      this.snapshotManager.restoreSnapshot(snapshot);
    } finally {
      this.restoringSnapshot.set(false);
    }
  }

  reset(): void {
    this.snapshotManager.reset();
  }

  private rebalanceAutoZones(): void {
    this.entries.update(prev => this.zoneService.rebalanceAutoZonesEntries(prev));
  }

  private scheduleLocalPersist(_snapshot: DockSnapshot | null, userId: string | null): void {
    this.snapshotPersistence.scheduleLocalPersist(
      () => this.exportSnapshot(),
      userId,
      () => this.lifecycle.getNonCriticalHoldDelay(),
    );
  }

  private persistLocalSnapshotImmediately(snapshot: DockSnapshot, userId: string): Promise<boolean> {
    return this.snapshotPersistence.persistImmediateSnapshot(() => snapshot, userId);
  }

  private persistDockSnapshotNow(entries: DockEntry[], overrides: DockSnapshotOverrides = {}): Promise<boolean> {
    const userId = this.currentSnapshotUserId;
    if (userId === null) return Promise.resolve(false);

    const savedAt = new Date().toISOString();
    this.snapshotSavedAt.set(savedAt);
    return this.snapshotPersistence.persistImmediateSnapshot(
      () => this.buildDockSnapshotForImmediatePersist(entries, savedAt, overrides),
      userId,
    );
  }

  private buildDockSnapshotForImmediatePersist(
    entries: DockEntry[],
    savedAt: string,
    overrides: DockSnapshotOverrides,
  ): DockSnapshot {
    const snapshot = this.snapshotManager.exportSnapshotWithEntries(entries, savedAt);
    return applyDockSnapshotOverrides(snapshot, overrides);
  }

  private getDockExpandedPreference(): boolean {
    return this.dockExpandedPreference;
  }

  private persistDockExpandedPreference(expanded: boolean): void {
    this.dockExpandedPreference = expanded;
  }

  private startFirstMainSelectionWindow(taskId: string): void {
    this.clearFirstMainSelectionWindow();
    const expiresAt = Date.now() + PARKING_CONFIG.FIRST_MAIN_OVERRIDE_WINDOW_MS;
    this.firstMainSelectionWindow.set({ taskId, expiresAt });
    this.firstMainSelection.schedule(
      () => this.firstMainSelectionWindow.set(null),
      PARKING_CONFIG.FIRST_MAIN_OVERRIDE_WINDOW_MS,
    );
  }

  private clearFirstMainSelectionWindow(): void {
    this.firstMainSelection.cancel();
    this.firstMainSelectionWindow.set(null);
  }

  computeRecommendationForSuspended(suspendedTaskId: string, waitMinutes: number): void {
    this.snapshotManager.computeRecommendationForSuspended(suspendedTaskId, waitMinutes);
  }

  refreshFocusSessionFromCloud(userId: string | null = this.currentSnapshotUserId): void {
    if (!userId) return;
    this.cloudSync.scheduleCloudPull(userId, true);
  }
}
