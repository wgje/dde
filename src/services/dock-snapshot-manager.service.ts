/**
 * DockSnapshotManagerService
 * 从 DockEngineService 中提取的快照/会话管理逻辑。
 * 负责：快照导出/恢复、会话状态构建、信号水化、重置操作、
 * 专注会话上下文管理、挂起推荐计算等快照相关纯逻辑。
 */
import { Injectable, WritableSignal, inject } from '@angular/core';
import {
  CURRENT_DOCK_SNAPSHOT_VERSION,
  DailySlotEntry,
  DockEntry,
  DockExitAction,
  DockFocusTransitionState,
  DockPendingDecision,
  DockRuleDecision,
  DockSchedulerPhase,
  DockSessionState,
  DockSnapshot,
  FragmentDefenseLevel,
  FocusSessionState,
  HighLoadCounter,
} from '../models/parking-dock';
import {
  buildOverflowMeta,
  isAutoPromotableStatus,
  toFocusTaskSlot,
} from './dock-engine.utils';
import { computeThreeDimensionalRecommendation } from './dock-scheduler.rules';
import { DockSnapshotPersistenceService, type SnapshotNormalizeContext } from './dock-snapshot-persistence.service';
import { DockCompletionFlowService } from './dock-completion-flow.service';
import { DockZoneService } from './dock-zone.service';
import { DockDailySlotService } from './dock-daily-slot.service';
import { DockFragmentRestService } from './dock-fragment-rest.service';
import { DockEngineLifecycleService } from './dock-engine-lifecycle.service';
import { LoggerService } from './logger.service';
import { UiStateService } from './ui-state.service';

function entryOrder(entry: DockEntry): number {
  return Number.isFinite(entry.manualOrder) ? Number(entry.manualOrder) : entry.dockedOrder;
}

function sortEntriesByDockOrder(entries: DockEntry[]): DockEntry[] {
  return [...entries].sort((a, b) => {
    if (a.status === 'completed' && b.status !== 'completed') return 1;
    if (b.status === 'completed' && a.status !== 'completed') return -1;
    const orderDelta = entryOrder(a) - entryOrder(b);
    if (orderDelta !== 0) return orderDelta;
    return a.taskId.localeCompare(b.taskId);
  });
}

// ---------------------------------------------------------------------------
//  Context interface — engine 在 constructor 中调用 init() 注入信号引用
// ---------------------------------------------------------------------------

export interface DockSnapshotManagerContext {
  // WritableSignals
  entries: WritableSignal<DockEntry[]>;
  focusMode: WritableSignal<boolean>;
  dockExpanded: WritableSignal<boolean>;
  muteWaitTone: WritableSignal<boolean>;
  focusScrimOn: WritableSignal<boolean>;
  firstDragIntervened: WritableSignal<boolean>;
  dailySlots: WritableSignal<DailySlotEntry[]>;
  suspendChainRootTaskId: WritableSignal<string | null>;
  suspendRecommendationLocked: WritableSignal<boolean>;
  pendingDecision: WritableSignal<DockPendingDecision | null>;
  lastRuleDecision: WritableSignal<DockRuleDecision | null>;
  dailyResetDate: WritableSignal<string>;
  focusSessionContext: WritableSignal<{ id: string; startedAt: number } | null>;
  highLoadCounter: WritableSignal<HighLoadCounter>;
  burnoutTriggeredAt: WritableSignal<number | null>;
  schedulerPhase: WritableSignal<DockSchedulerPhase>;
  lastRecommendationGroups: WritableSignal<import('../models/parking-dock').RecommendationGroup[]>;
  lastExitAction: WritableSignal<DockExitAction | null>;
  focusTransition: WritableSignal<DockFocusTransitionState | null>;
  highlightedIds: WritableSignal<Set<string>>;
  editLock: WritableSignal<boolean>;
  fragmentDefenseLevel: WritableSignal<FragmentDefenseLevel>;
  lastConsoleDemotedTaskId: WritableSignal<string | null>;
  consoleVisibleOrderHint: WritableSignal<string[]>;
  
  // Non-signal state
  waitEndNotifiedIds: Set<string>;
  
  // Callbacks for methods that remain on engine
  getDockExpandedPreference: () => boolean;
  persistDockExpandedPreference: (expanded: boolean) => void;
  clearFirstMainSelectionWindow: () => void;
  rebalanceAutoZones: () => void;
}

interface SessionEntryHydrationContext {
  session: DockSessionState;
  commandOrder: Map<string, number>;
  fallbackOrder: Map<string, number>;
  comboSet: Set<string>;
  backupSet: Set<string>;
  hasLaneHints: boolean;
}

@Injectable({
  providedIn: 'root',
})
export class DockSnapshotManagerService {
  private readonly snapshotPersistence = inject(DockSnapshotPersistenceService);
  private readonly completionFlow = inject(DockCompletionFlowService);
  private readonly zoneService = inject(DockZoneService);
  private readonly dailySlotService = inject(DockDailySlotService);
  private readonly fragmentRest = inject(DockFragmentRestService);
  private readonly lifecycle = inject(DockEngineLifecycleService);
  private readonly logger = inject(LoggerService).category('DockSnapshotManager');
  private readonly uiState = inject(UiStateService);

  private _ctx: DockSnapshotManagerContext | null = null;

  /**
   * 获取上下文——必须在 DockEngineService 构造期间调用 init() 注入。
   * 如未初始化则抛出明确错误，便于定位 DI 顺序问题。
   */
  private get ctx(): DockSnapshotManagerContext {
    if (!this._ctx) {
      throw new Error(
        'DockSnapshotManagerService.init() must be called before use. ' +
        'Ensure DockEngineService is constructed before accessing this service.',
      );
    }
    return this._ctx;
  }

  /**
   * 由 DockEngineService 在其构造函数中调用，注入共享信号引用。
   * 此服务使用手动上下文注入而非 Angular DI，因为所需信号是 DockEngineService 的私有成员，
   * 无法通过常规注入获取。这是有意的架构权衡：以运行时初始化检查换取信号封装性。
   */
  init(ctx: DockSnapshotManagerContext): void {
    if (this._ctx) {
      this.logger.warn('init() called again — overwriting previous context');
    }
    this._ctx = ctx;
  }

  // ---------------------------------------------------------------------------
  //  Snapshot Export/Import
  // ---------------------------------------------------------------------------

  exportSnapshot(): DockSnapshot {
    const session = this.buildSessionState();
    return {
      version: CURRENT_DOCK_SNAPSHOT_VERSION,
      entries: this.ctx.entries(),
      focusMode: this.ctx.focusMode(),
      isDockExpanded: this.ctx.getDockExpandedPreference(),
      muteWaitTone: this.ctx.muteWaitTone(),
      session,
      firstDragDone: this.ctx.firstDragIntervened(),
      dailySlots: this.ctx.dailySlots(),
      suspendChainRootTaskId: this.ctx.suspendChainRootTaskId(),
      suspendRecommendationLocked: this.ctx.suspendRecommendationLocked(),
      pendingDecision: this.ctx.pendingDecision(),
      lastRuleDecision: this.ctx.lastRuleDecision(),
      dailyResetDate: this.ctx.dailyResetDate(),
      savedAt: new Date().toISOString(),
      // v3.0 专注模式会话状态（§2.5）
      focusSessionState: this.ctx.focusMode() ? this.buildFocusSessionState() : null,
    };
  }

  restoreSnapshot(snapshot: DockSnapshot): void {
    const normalized = this.snapshotPersistence.normalizeSnapshot(snapshot, this.buildNormalizeContext());
    if (!normalized) return;
    const hydratedEntries = this.applySessionToEntries(
      normalized.entries,
      normalized.session,
      normalized.focusSessionState?.commandCenterOrderIds,
    );
    const recoveredEntries = this.snapshotPersistence.recoverLegacyExternalDragDefaultBackup(hydratedEntries);
    const recoveredWithMain = this.completionFlow.enforceSingleMainInvariant(
      recoveredEntries,
      normalized.session.mainTaskId,
    );

    // C-1 fix: try/finally 保护 restoringSnapshot 标志，防止异常导致永久卡住
    // Note: restoringSnapshot flag is managed by the calling engine service
    this.hydrateSignalsFromSnapshot(normalized, recoveredWithMain);
    
    this.lifecycle.refreshSuspendRecommendationLock();
    this.lifecycle.checkWaitExpiry();
  }

  reset(): void {
    this.ctx.entries.set([]);
    this.ctx.consoleVisibleOrderHint.set([]);
    this.ctx.focusMode.set(false);
    this.ctx.dockExpanded.set(!this.uiState.isMobile() && this.ctx.getDockExpandedPreference());
    this.ctx.muteWaitTone.set(false);
    this.ctx.focusScrimOn.set(true);
    this.ctx.firstDragIntervened.set(false);
    this.ctx.dailySlots.set([]);
    this.ctx.suspendChainRootTaskId.set(null);
    this.ctx.suspendRecommendationLocked.set(false);
    this.ctx.pendingDecision.set(null);
    this.ctx.lastRuleDecision.set(null);
    this.ctx.lastExitAction.set(null);
    this.ctx.focusTransition.set(null);
    this.ctx.clearFirstMainSelectionWindow();
    this.ctx.focusSessionContext.set(null);
    this.ctx.highlightedIds.set(new Set());
    this.ctx.dailyResetDate.set(this.dailySlotService.todayDateKey());
    // v3.0 重置倦怠检测状态
    this.ctx.highLoadCounter.set({ count: 0, windowStartAt: 0 });
    this.ctx.burnoutTriggeredAt.set(null);
    this.ctx.fragmentDefenseLevel.set(1);
    this.ctx.lastRecommendationGroups.set([]);
    this.fragmentRest.resetAll();
    this.ctx.editLock.set(false);
    this.ctx.schedulerPhase.set('active');
    this.ctx.waitEndNotifiedIds.clear();
    this.ctx.lastConsoleDemotedTaskId.set(null);
    this.zoneService.clearAdjacencyCache();
  }

  // ---------------------------------------------------------------------------
  //  Focus Session Management
  // ---------------------------------------------------------------------------

  /**
   * 构建 FocusSessionState（策划案 §2.5）
   * 将当前 entries signal 映射为 FocusTaskSlot 格式
   */
  buildFocusSessionState(): FocusSessionState {
    const context = this.ensureFocusSessionContext();
    const activeEntries = sortEntriesByDockOrder(this.ctx.entries().filter(e => e.status !== 'completed'));
    const commandCenterCandidates = activeEntries.filter(
      entry => entry.isMain || entry.lane === 'combo-select' || entry.status === 'focusing',
    );
    const commandCenterOrderIds = this.completionFlow
      .sortConsoleEntriesForDisplay(commandCenterCandidates)
      .slice(0, 4)
      .map(entry => entry.taskId);

    const commandTasks = activeEntries
      .filter(e => e.isMain)
      .map((e, i) => toFocusTaskSlot(e, 'command', i));
    const comboSelectTasks = activeEntries
      .filter(e => !e.isMain && e.lane === 'combo-select')
      .map((e, i) => toFocusTaskSlot(e, 'combo-select', i));
    const backupTasks = activeEntries
      .filter(e => !e.isMain && e.lane === 'backup')
      .map((e, i) => toFocusTaskSlot(e, 'backup', i));

    return {
      schemaVersion: 2,
      sessionId: context.id,
      sessionStartedAt: context.startedAt,
      isActive: true,
      isFocusOverlayOn: this.ctx.focusScrimOn(),
      commandCenterOrderIds,
      commandCenterTasks: commandTasks,
      comboSelectTasks,
      backupTasks,
      hasFirstBatchSelected: this.ctx.firstDragIntervened(),
      routineSlotsShownToday: [],
      highLoadCounter: this.ctx.highLoadCounter(),
      burnoutTriggeredAt: this.ctx.burnoutTriggeredAt(),
    };
  }

  ensureFocusSessionContext(seed?: { id?: string | null; startedAt?: number | null }): { id: string; startedAt: number } {
    const current = this.ctx.focusSessionContext();
    if (current) return current;

    const next = {
      id: typeof seed?.id === 'string' && seed.id ? seed.id : crypto.randomUUID(),
      startedAt:
        Number.isFinite(seed?.startedAt)
          ? Number(seed?.startedAt)
          : Date.now(),
    };
    this.ctx.focusSessionContext.set(next);
    return next;
  }

  // ---------------------------------------------------------------------------
  //  Recommendation Management
  // ---------------------------------------------------------------------------

  /**
   * v3.0 使用三维推荐阵列增强挂起推荐（策划案 §4.2.4）
   * 在首次挂起时触发，替代原始单分数排序
   */
  computeRecommendationForSuspended(suspendedTaskId: string, waitMinutes: number): void {
    const suspendedEntry = this.ctx.entries().find(e => e.taskId === suspendedTaskId);
    if (!suspendedEntry) return;

    const mainSlot = this.completionFlow.toFocusTaskSlot(suspendedEntry, 'command', 0);
    const pendingEntries = this.ctx.entries().filter(
      e => isAutoPromotableStatus(e.status) && e.taskId !== suspendedTaskId,
    );
    const pendingSlots = pendingEntries.map((e, i) => this.completionFlow.toFocusTaskSlot(e, 'combo-select', i));

    const groups = computeThreeDimensionalRecommendation(mainSlot, pendingSlots, waitMinutes);
    this.ctx.lastRecommendationGroups.set(groups);
  }

  // ---------------------------------------------------------------------------
  //  Private Helpers
  // ---------------------------------------------------------------------------

  buildNormalizeContext(): SnapshotNormalizeContext {
    return {
      muteWaitTone: this.ctx.muteWaitTone(),
      todayDateKey: this.dailySlotService.todayDateKey(),
      buildOverflowMeta: (entries) => buildOverflowMeta(entries),
    };
  }

  buildSessionState(entries: DockEntry[] = this.ctx.entries()): DockSessionState {
    const activeEntries = sortEntriesByDockOrder(entries.filter(entry => entry.status !== 'completed'));
    const mainCandidate =
      activeEntries.find(entry => entry.isMain) ??
      activeEntries.find(entry => entry.status === 'focusing') ??
      null;
    return {
      firstDragIntervened: this.ctx.firstDragIntervened(),
      focusBlurOn: this.ctx.focusMode(),
      focusScrimOn: this.ctx.focusScrimOn(),
      focusSessionId: this.ctx.focusSessionContext()?.id,
      focusSessionStartedAt: this.ctx.focusSessionContext()?.startedAt,
      mainTaskId: mainCandidate?.taskId ?? null,
      comboSelectIds: activeEntries
        .filter(entry => !entry.isMain && entry.lane === 'combo-select')
        .map(entry => entry.taskId),
      backupIds: activeEntries
        .filter(entry => !entry.isMain && entry.lane === 'backup')
        .map(entry => entry.taskId),
      highLoadCounter: this.ctx.highLoadCounter(),
      burnoutTriggeredAt: this.ctx.burnoutTriggeredAt(),
      hasFirstBatchSelected: this.ctx.firstDragIntervened(),
      schedulerPhase: this.ctx.schedulerPhase(),
      overflowMeta: buildOverflowMeta(activeEntries),
    };
  }

  applySessionToEntries(
    entries: DockEntry[],
    session: DockSessionState,
    commandCenterOrderIds: string[] = [],
  ): DockEntry[] {
    const activeTaskIds = new Set(entries.filter(entry => entry.status !== 'completed').map(entry => entry.taskId));
    const commandCenterOrder = this.buildCommandCenterOrder(commandCenterOrderIds, activeTaskIds);
    const commandOrder = new Map(commandCenterOrder.map((taskId, index) => [taskId, index] as const));
    const fallbackOrder = this.buildSessionFallbackOrder(session, activeTaskIds, commandOrder);
    const comboSet = new Set(session.comboSelectIds);
    const backupSet = new Set(session.backupIds);
    const hydrationContext: SessionEntryHydrationContext = {
      session,
      commandOrder,
      fallbackOrder,
      comboSet,
      backupSet,
      hasLaneHints: comboSet.size > 0 || backupSet.size > 0,
    };

    // M-9 fix: 提取 lane 分配逻辑为辅助函数，消除 6 层嵌套三元
    const assignLane = (entry: DockEntry, markMain: boolean): DockEntry => {
      return this.applySessionEntryState(entry, markMain, hydrationContext);
    };

    if (!session.mainTaskId) {
      const hydrated = entries.map(e => assignLane(e, false));
      const fallbackMainTaskId = session.comboSelectIds[0] ?? session.backupIds[0] ?? null;
      return sortEntriesByDockOrder(this.completionFlow.enforceSingleMainInvariant(hydrated, fallbackMainTaskId));
    }

    const hasMain = entries.some(entry => entry.isMain && entry.status !== 'completed');
    if (hasMain || !entries.some(entry => entry.taskId === session.mainTaskId)) {
      const hydrated = entries.map(e => assignLane(e, false));
      return sortEntriesByDockOrder(this.completionFlow.enforceSingleMainInvariant(hydrated, session.mainTaskId));
    }

    const hydrated = entries.map(e => assignLane(e, true));
    return sortEntriesByDockOrder(this.completionFlow.enforceSingleMainInvariant(hydrated, session.mainTaskId));
  }

  private applySessionEntryState(
    entry: DockEntry,
    markMain: boolean,
    context: SessionEntryHydrationContext,
  ): DockEntry {
    if (entry.status === 'completed') return entry;
    if (entry.taskId === context.session.mainTaskId && (markMain || entry.isMain)) {
      const nextOrder = this.resolveSnapshotEntryOrder(entry, context);
      return { ...entry, isMain: true, dockedOrder: nextOrder, manualOrder: nextOrder };
    }
    if (!context.hasLaneHints) {
      return context.commandOrder.has(entry.taskId) ? this.withSnapshotEntryOrder(entry, context) : entry;
    }
    if (context.comboSet.has(entry.taskId)) {
      const nextOrder = this.resolveSnapshotEntryOrder(entry, context);
      return { ...entry, lane: 'combo-select', isMain: false, dockedOrder: nextOrder, manualOrder: nextOrder };
    }
    if (context.backupSet.has(entry.taskId)) {
      const nextOrder = this.resolveSnapshotEntryOrder(entry, context);
      return { ...entry, lane: 'backup', isMain: false, dockedOrder: nextOrder, manualOrder: nextOrder };
    }
    if (entry.isMain) return entry;
    if (context.commandOrder.has(entry.taskId)) return this.withSnapshotEntryOrder(entry, context);
    return entry;
  }

  private resolveSnapshotEntryOrder(entry: DockEntry, context: SessionEntryHydrationContext): number {
    return context.commandOrder.get(entry.taskId) ?? context.fallbackOrder.get(entry.taskId) ?? entryOrder(entry);
  }

  private withSnapshotEntryOrder(entry: DockEntry, context: SessionEntryHydrationContext): DockEntry {
    const nextOrder = this.resolveSnapshotEntryOrder(entry, context);
    if (entry.dockedOrder === nextOrder && entry.manualOrder === nextOrder) return entry;
    return { ...entry, dockedOrder: nextOrder, manualOrder: nextOrder };
  }

  private buildCommandCenterOrder(commandCenterOrderIds: string[], activeTaskIds: Set<string>): string[] {
    const seen = new Set<string>();
    const ordered: string[] = [];
    for (const taskId of commandCenterOrderIds) {
      if (!activeTaskIds.has(taskId) || seen.has(taskId)) continue;
      seen.add(taskId);
      ordered.push(taskId);
    }
    return ordered;
  }

  private buildSessionFallbackOrder(
    session: DockSessionState,
    activeTaskIds: Set<string>,
    commandOrder: Map<string, number>,
  ): Map<string, number> {
    const fallbackOrder = new Map<string, number>();
    const seen = new Set<string>();
    const enqueue = (taskId: string | null | undefined): void => {
      if (!taskId || !activeTaskIds.has(taskId) || commandOrder.has(taskId) || seen.has(taskId)) return;
      seen.add(taskId);
      fallbackOrder.set(taskId, commandOrder.size + fallbackOrder.size);
    };

    enqueue(session.mainTaskId);
    session.comboSelectIds.forEach(enqueue);
    session.backupIds.forEach(enqueue);
    return fallbackOrder;
  }

  /** 从规范化快照恢复所有信号状态 */
  private hydrateSignalsFromSnapshot(normalized: DockSnapshot, entries: DockEntry[]): void {
    const restoreDockExpanded = !this.uiState.isMobile() && normalized.isDockExpanded;

    this.ctx.entries.set(entries);
    this.ctx.consoleVisibleOrderHint.set([]);
    this.ctx.focusMode.set(normalized.focusMode);
    this.ctx.persistDockExpandedPreference(normalized.isDockExpanded);
    // 移动端启动恢复时强制从折叠态进入，避免启动后首屏内容被大面积覆盖。
    this.ctx.dockExpanded.set(restoreDockExpanded);
    this.ctx.muteWaitTone.set(normalized.muteWaitTone);
    this.ctx.focusScrimOn.set(normalized.session.focusScrimOn);
    this.ctx.firstDragIntervened.set(normalized.session.firstDragIntervened);
    this.ctx.dailySlots.set(normalized.dailySlots);
    this.ctx.suspendChainRootTaskId.set(normalized.suspendChainRootTaskId);
    this.ctx.suspendRecommendationLocked.set(normalized.suspendRecommendationLocked);
    this.ctx.pendingDecision.set(normalized.pendingDecision);
    this.ctx.lastRuleDecision.set(normalized.lastRuleDecision ?? null);
    this.ctx.lastExitAction.set(null);
    this.ctx.focusTransition.set(null);
    this.ctx.clearFirstMainSelectionWindow();
    this.ctx.dailyResetDate.set(normalized.dailyResetDate);
    this.ctx.schedulerPhase.set(normalized.session.schedulerPhase ?? 'active');
    if (
      typeof normalized.session.focusSessionId === 'string' &&
      normalized.session.focusSessionId &&
      Number.isFinite(normalized.session.focusSessionStartedAt)
    ) {
      this.ctx.focusSessionContext.set({
        id: normalized.session.focusSessionId,
        startedAt: Number(normalized.session.focusSessionStartedAt),
      });
    } else if (normalized.focusMode) {
      this.ensureFocusSessionContext();
    } else {
      this.ctx.focusSessionContext.set(null);
    }
    this.ctx.highLoadCounter.set(normalized.session.highLoadCounter ?? { count: 0, windowStartAt: 0 });
    this.ctx.burnoutTriggeredAt.set(normalized.session.burnoutTriggeredAt ?? null);
    this.ctx.rebalanceAutoZones();
  }
}
