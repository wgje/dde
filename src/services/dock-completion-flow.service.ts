/**
 * DockCompletionFlowService
 * 从 DockEngineService 中提取的完成/推荐流逻辑。
 * 负责：任务完成后推荐、候选排序、待决策管理、碎片阶段进入、
 * 主控台排序、主任务一致性修复等纯调度流逻辑。
 */
import { Injectable, Signal, WritableSignal, inject } from '@angular/core';
import { PARKING_CONFIG } from '../config/parking.config';
import {
  CognitiveLoad,
  DockEntry,
  DockLane,
  DockPendingDecision,
  DockRuleDecision,
  DockSchedulerPhase,
  DockTaskStatus,
  FocusTaskSlot,
  FragmentDefenseLevel,
  RecommendationGroupType,
} from '../models/parking-dock';
import {
  type DockWaitFitMode,
  computeThreeDimensionalRecommendation,
  createRuleDecision,
  effectiveExecMin,
  evaluateTimeRemaining,
  rankDockCandidates,
} from './dock-scheduler.rules';
import { DockFragmentRestService } from './dock-fragment-rest.service';
import { DockZoneService } from './dock-zone.service';
import { normalizeNullableNumber } from './dock-snapshot-persistence.service';
import {
  getWaitRemainingSeconds,
  hasActiveWaitTimer,
  isAutoPromotableStatus,
  isConsoleBackgroundStatus,
  isRunnableStatus,
  isWaitingLike,
  mapDockStatusToFocusStatus,
} from './dock-engine.utils';

// ---------------------------------------------------------------------------
//  Context interface — engine 在 constructor 中调用 init() 注入信号引用
// ---------------------------------------------------------------------------

export interface DockCompletionContext {
  entries: WritableSignal<DockEntry[]>;
  pendingDecision: WritableSignal<DockPendingDecision | null>;
  highlightedIds: WritableSignal<Set<string>>;
  lastRuleDecision: WritableSignal<DockRuleDecision | null>;
  lastRecommendationGroups: WritableSignal<import('../models/parking-dock').RecommendationGroup[]>;
  schedulerPhase: WritableSignal<DockSchedulerPhase>;
  fragmentDefenseLevel: WritableSignal<FragmentDefenseLevel>;
  lastConsoleDemotedTaskId: WritableSignal<string | null>;
  consoleVisibleOrderHint: Signal<string[]>;
  focusingEntry: Signal<DockEntry | null>;
  focusMode: Signal<boolean>;
  suspendChainRootTaskId: Signal<string | null>;
  highlightClearTimer: { current: ReturnType<typeof setTimeout> | null };
}

@Injectable({
  providedIn: 'root',
})
export class DockCompletionFlowService {
  private readonly zoneService = inject(DockZoneService);
  private readonly fragmentRest = inject(DockFragmentRestService);

  private ctx!: DockCompletionContext;

  init(ctx: DockCompletionContext): void {
    this.ctx = ctx;
  }

  // ---------------------------------------------------------------------------
  //  Status helpers（委托至 dock-engine.utils 纯函数）
  // ---------------------------------------------------------------------------

  isWaitingLike(status: DockTaskStatus): boolean {
    return isWaitingLike(status);
  }

  isRunnableStatus(status: DockTaskStatus): boolean {
    return isRunnableStatus(status);
  }

  isAutoPromotableStatus(status: DockTaskStatus): boolean {
    return isAutoPromotableStatus(status);
  }

  isConsoleBackgroundStatus(status: DockTaskStatus): boolean {
    return isConsoleBackgroundStatus(status);
  }

  // ---------------------------------------------------------------------------
  //  Conversion helpers
  // ---------------------------------------------------------------------------

  toSchedulerCandidate(entry: DockEntry): {
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
      sourceProjectId: entry.sourceProjectId ?? this.zoneService.resolveSourceProjectId(entry),
    };
  }

  toFocusTaskSlot(entry: DockEntry, zone: 'command' | 'combo-select' | 'backup' = 'command', idx = 0): FocusTaskSlot {
    return {
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
    };
  }

  getWaitRemainingSeconds(entry: DockEntry): number | null {
    return getWaitRemainingSeconds(entry);
  }

  deriveBackgroundStatus(
    entry: DockEntry,
    nextTarget: DockEntry | null = null,
    currentFocus: DockEntry | null = null,
  ): DockTaskStatus {
    if (hasActiveWaitTimer(entry)) {
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
    if (entry.status === 'focusing') {
      return 'stalled';
    }
    return 'pending_start';
  }

  // ---------------------------------------------------------------------------
  //  Core completion/recommendation flow
  // ---------------------------------------------------------------------------

  resolveAfterCompletion(completedTaskId: string): void {
    const rootTaskId = this.ctx.suspendChainRootTaskId();
    const rootEntry = rootTaskId ? this.ctx.entries().find(entry => entry.taskId === rootTaskId) ?? null : null;
    const rootRemainingSeconds = rootEntry ? this.getWaitRemainingSeconds(rootEntry) : null;

    // 主路径：主任务仍在等待中，尝试推荐候选或碎片倒计时
    if (rootEntry && rootRemainingSeconds !== null && rootRemainingSeconds > 0) {
      if (this.resolveWithActiveRoot(completedTaskId, rootTaskId, rootEntry, rootRemainingSeconds)) {
        return;
      }
    }

    // 恢复路径：有 wait_finished 的主任务，高亮等待用户恢复
    if (this.resolveWithRecoveredMain(rootRemainingSeconds)) {
      return;
    }

    // 兜底路径：无主任务等待，自动推进下一候选
    this.resolveFallbackPromotion(rootTaskId, rootRemainingSeconds);
  }

  // ---------------------------------------------------------------------------
  //  resolveAfterCompletion 子流程
  // ---------------------------------------------------------------------------

  /** 主任务仍在等待时，按时间分支推荐候选。返回 true 表示已处理。 */
  private resolveWithActiveRoot(
    completedTaskId: string,
    rootTaskId: string | null,
    rootEntry: DockEntry,
    rootRemainingSeconds: number,
  ): boolean {
    const rootRemainingMinutes = rootRemainingSeconds / 60;
    const excluded = [completedTaskId, rootTaskId].filter((id): id is string => id !== null);
    const recommendation = this.buildTwoStageRecommendationCandidateGroups(
      rootEntry, excluded, rootRemainingMinutes,
    );
    const waitFitMode: DockWaitFitMode = recommendation.mode === 'strict' ? 'strict' : 'relaxed';
    const primaryCandidate = this.pickPrimaryCandidate(
      excluded, rootRemainingMinutes, rootEntry, waitFitMode,
    );
    const branch = evaluateTimeRemaining(
      rootRemainingMinutes,
      primaryCandidate ? effectiveExecMin(this.toFocusTaskSlot(primaryCandidate)) : null,
    );
    const hasCandidates =
      recommendation.groups.some(g => g.taskIds.length > 0) || primaryCandidate !== null;

    if (!hasCandidates) {
      this.fragmentRest.startFragmentEntryCountdown({
        reason: '主任务仍在等待且暂无合适候选，进入碎片时间倒计时',
        rootTaskId: rootTaskId ?? undefined,
        remainingMinutes: rootRemainingMinutes,
      });
      return true;
    }

    if (branch === 'tight-blank') {
      this.handleTightBlankBranch(rootTaskId, rootEntry, rootRemainingMinutes);
      return true;
    }

    if (branch === 'mismatch-recompute' && recommendation.groups.length > 0) {
      this.handleMismatchRecompute(rootTaskId, rootEntry, rootRemainingMinutes, recommendation);
      return true;
    }

    if (primaryCandidate) {
      this.handlePrimaryCandidate(rootTaskId, rootEntry, rootRemainingMinutes, primaryCandidate, branch, recommendation);
      return true;
    }

    return false;
  }

  /** tight-blank 分支：留白窗口紧张，5s 后进入留白期 */
  private handleTightBlankBranch(
    rootTaskId: string | null,
    rootEntry: DockEntry,
    rootRemainingMinutes: number,
  ): void {
    const chainRootTaskId = rootTaskId ?? rootEntry.taskId;
    this.setPendingDecision(
      chainRootTaskId, rootRemainingMinutes, [],
      'tight-blank: 留白窗口紧张，5s 后进入留白期', 5000,
    );
    this.ctx.lastRuleDecision.set(
      createRuleDecision({
        type: 'pending_decision',
        reason: 'tight-blank: 留白窗口紧张，等待用户取消或确认',
        rootTaskId: rootTaskId ?? undefined,
        recommendedTaskIds: [],
        remainingMinutes: rootRemainingMinutes,
      }),
    );
  }

  /** mismatch-recompute 分支：时间偏差过大，展示重算候选并启动碎片过渡倒计时 */
  private handleMismatchRecompute(
    rootTaskId: string | null,
    rootEntry: DockEntry,
    rootRemainingMinutes: number,
    recommendation: { mode: string; groups: { type: RecommendationGroupType; taskIds: string[] }[] },
  ): void {
    const chainRootTaskId = rootTaskId ?? rootEntry.taskId;
    const candidateGroups = recommendation.groups;
    const reason =
      recommendation.mode === 'strict'
        ? 'mismatch-recompute: 时间偏差过大，触发三组重算'
        : recommendation.mode === 'relaxed'
          ? 'mismatch-recompute: 放宽时窗后触发候选重算'
          : 'mismatch-recompute: 规则引擎回退候选重算';
    this.setPendingDecision(chainRootTaskId, rootRemainingMinutes, candidateGroups, reason);
    this.ctx.highlightedIds.set(new Set(candidateGroups.flatMap(group => group.taskIds)));
    this.ctx.lastRuleDecision.set(
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
    this.startFragmentTransitionCountdown(rootTaskId, rootRemainingMinutes);
  }

  /** 单一最优候选分支：高亮候选并启动碎片过渡倒计时 */
  private handlePrimaryCandidate(
    rootTaskId: string | null,
    rootEntry: DockEntry,
    rootRemainingMinutes: number,
    primaryCandidate: DockEntry,
    branch: string,
    recommendation: { mode: string; groups: { type: RecommendationGroupType; taskIds: string[] }[] },
  ): void {
    this.setPendingDecision(
      rootTaskId ?? rootEntry.taskId,
      rootRemainingMinutes,
      [{ type: 'homologous-advancement' as RecommendationGroupType, taskIds: [primaryCandidate.taskId] }],
      branch === 'time-match'
        ? 'time-match: 候选时长匹配，等待用户决定是否切换'
        : recommendation.mode === 'strict'
          ? '候选不足，保留最优下一步供用户手动选择'
          : '候选不足，已放宽时窗后保留最优下一步供用户手动选择',
    );
    this.ctx.highlightedIds.set(new Set([primaryCandidate.taskId]));
    this.ctx.lastRuleDecision.set(
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
    this.startFragmentTransitionCountdown(rootTaskId, rootRemainingMinutes);
  }

  /** 恢复路径：高亮 wait_finished 的主任务。返回 true 表示已处理。 */
  private resolveWithRecoveredMain(rootRemainingSeconds: number | null): boolean {
    const recoveredMain = this.ctx.entries()
      .filter(entry => entry.isMain && entry.status === 'wait_finished')
      .sort((a, b) => this.entryOrder(a) - this.entryOrder(b))[0];
    if (!recoveredMain) return false;

    this.ctx.pendingDecision.set(null);
    this.ctx.highlightedIds.set(new Set([recoveredMain.taskId]));
    this.ctx.lastRuleDecision.set(
      createRuleDecision({
        type: 'completion_followup',
        reason: '主任务等待结束，置顶高亮等待用户恢复',
        rootTaskId: recoveredMain.taskId,
        recommendedTaskIds: [recoveredMain.taskId],
        remainingMinutes: rootRemainingSeconds !== null ? rootRemainingSeconds / 60 : undefined,
      }),
    );
    return true;
  }

  /** 兜底路径：清除待决策，自动推进下一候选 */
  private resolveFallbackPromotion(rootTaskId: string | null, rootRemainingSeconds: number | null): void {
    this.ctx.pendingDecision.set(null);
    this.promoteNext();
    const focused = this.ctx.focusingEntry();
    if (focused) {
      this.ctx.lastRuleDecision.set(
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

  /** GAP-A: 碎片过渡倒计时，不以绝对任务饱和为目标，保留推荐同时给用户休息选择 */
  private startFragmentTransitionCountdown(rootTaskId: string | null, rootRemainingMinutes: number): void {
    this.fragmentRest.startFragmentEntryCountdown({
      reason: '组合任务完成，碎片过渡期，可选择休息或切换任务',
      rootTaskId: rootTaskId ?? undefined,
      remainingMinutes: rootRemainingMinutes,
      preservePendingDecision: true,
      countdownSeconds: PARKING_CONFIG.FRAGMENT_TRANSITION_COUNTDOWN_S,
    });
  }

  pickPrimaryCandidate(
    excludedIds: string[],
    remainingMinutes: number,
    rootEntry: DockEntry | null,
    waitFitMode: DockWaitFitMode = 'strict',
  ): DockEntry | null {
    const excluded = new Set(excludedIds.filter(Boolean));
    const mainIdle = this.ctx.entries()
      .filter(entry => entry.isMain && this.isAutoPromotableStatus(entry.status) && !excluded.has(entry.taskId))
      .sort((a, b) => this.entryOrder(a) - this.entryOrder(b));
    if (mainIdle.length > 0) return mainIdle[0];

    const stalled = this.ctx.entries()
      .filter(entry => entry.status === 'stalled' && !excluded.has(entry.taskId))
      .sort((a, b) => this.entryOrder(a) - this.entryOrder(b));
    if (stalled.length > 0) return stalled[0];

    return this.pickBestCandidate(
      remainingMinutes,
      excludedIds,
      {
        rootLoad: rootEntry?.load ?? null,
        rootProjectId: rootEntry ? this.zoneService.resolveSourceProjectId(rootEntry) : null,
      },
      waitFitMode,
    );
  }

  pickBestCandidate(
    remainingMinutes: number,
    excludedIds: string[],
    context: { rootLoad?: CognitiveLoad | null; rootProjectId?: string | null } = {},
    waitFitMode: DockWaitFitMode = 'strict',
  ): DockEntry | null {
    const excluded = new Set(excludedIds.filter(Boolean));
    const candidates = this.ctx.entries().filter(
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

  scoreCandidate(entry: DockEntry, waitMinutes: number): number {
    const ranked = rankDockCandidates([this.toSchedulerCandidate(entry)], waitMinutes);
    return ranked[0]?.score ?? 0;
  }

  buildRecommendationCandidateGroups(
    rootEntry: DockEntry,
    excludedTaskIds: string[],
    remainingMinutes: number,
    waitFitMode: DockWaitFitMode = 'strict',
  ): Array<{ type: RecommendationGroupType; taskIds: string[] }> {
    const excluded = new Set(excludedTaskIds.filter(Boolean));
    const mainSlot = this.toFocusTaskSlot(rootEntry, 'command', 0);
    const pendingEntries = this.ctx.entries().filter(
      entry => this.isAutoPromotableStatus(entry.status) && !excluded.has(entry.taskId),
    );
    const pendingSlots = pendingEntries.map((entry, idx) =>
      this.toFocusTaskSlot(entry, entry.lane, idx),
    );
    const groups = computeThreeDimensionalRecommendation(mainSlot, pendingSlots, remainingMinutes, waitFitMode);
    this.ctx.lastRecommendationGroups.set(groups);

    return groups
      .map(group => ({
        type: group.type,
        taskIds: group.candidates
          .map(candidate => candidate.taskId)
          .filter((taskId): taskId is string => typeof taskId === 'string' && taskId.length > 0),
      }))
      .filter(group => group.taskIds.length > 0);
  }

  buildTwoStageRecommendationCandidateGroups(
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

  buildRankedFallbackGroups(
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

  rankRecommendedCandidates(
    rootEntry: DockEntry,
    excludedTaskIds: string[],
    remainingMinutes: number,
    waitFitMode: DockWaitFitMode = 'strict',
  ) {
    const excluded = new Set(excludedTaskIds.filter(Boolean));
    const candidateEntries = this.ctx.entries().filter(
      entry => this.isAutoPromotableStatus(entry.status) && !excluded.has(entry.taskId),
    );
    return rankDockCandidates(
      candidateEntries.map(entry => this.toSchedulerCandidate(entry)),
      remainingMinutes,
      {
        rootLoad: rootEntry.load,
        rootProjectId: this.zoneService.resolveSourceProjectId(rootEntry),
        waitFitMode,
      },
    );
  }

  promoteNext(): void {
    const stalled = this.ctx.entries()
      .filter(entry => entry.status === 'stalled')
      .sort((a, b) => this.entryOrder(a) - this.entryOrder(b))[0];
    if (stalled) {
      this.ctx.schedulerPhase.set('active');
      this.promoteCandidate(stalled.taskId);
      this.ctx.highlightedIds.set(new Set([stalled.taskId]));
      this.ctx.lastRuleDecision.set(
        createRuleDecision({
          type: 'idle_promote',
          reason: '主任务完成后优先恢复停滞任务',
          recommendedTaskIds: [stalled.taskId],
        }),
      );
      return;
    }

    const mainIdle = this.ctx.entries()
      .filter(entry => entry.isMain && this.isAutoPromotableStatus(entry.status))
      .sort((a, b) => this.entryOrder(a) - this.entryOrder(b))[0];
    if (mainIdle) {
      this.ctx.schedulerPhase.set('active');
      this.promoteCandidate(mainIdle.taskId);
      this.ctx.lastRuleDecision.set(
        createRuleDecision({
          type: 'idle_promote',
          reason: '主控链存在可运行任务，按入坞顺序推进',
          recommendedTaskIds: [mainIdle.taskId],
        }),
      );
      return;
    }

    const radarCandidates = this.ctx.entries().filter(
      entry => !entry.isMain && this.isAutoPromotableStatus(entry.status),
    );
    const focusReference = this.ctx.focusingEntry();
    const rankedRadar = rankDockCandidates(
      radarCandidates.map(entry => this.toSchedulerCandidate(entry)),
      PARKING_CONFIG.SCHEDULE_OVER_RUN_ALLOWANCE_MINUTES,
      {
        rootLoad: focusReference?.load ?? null,
        rootProjectId: focusReference ? this.zoneService.resolveSourceProjectId(focusReference) : null,
      },
    );
    const radarCandidate = rankedRadar.length > 0
      ? radarCandidates.find(entry => entry.taskId === rankedRadar[0].taskId) ?? null
      : null;
    if (radarCandidate) {
      this.ctx.schedulerPhase.set('active');
      this.promoteCandidate(radarCandidate.taskId);
      this.ctx.highlightedIds.set(new Set([radarCandidate.taskId]));
      this.ctx.lastRuleDecision.set(
        createRuleDecision({
          type: 'idle_promote',
          reason: '规则引擎从雷达区拉取最优候选进入主控台',
          recommendedTaskIds: [radarCandidate.taskId],
        }),
      );
      this.ctx.highlightClearTimer.current = setTimeout(() => {
        if (this.ctx.pendingDecision()) return;
        this.ctx.highlightedIds.set(new Set());
      }, 2000);
      return;
    }

    const recoveredMain = this.ctx.entries()
      .filter(entry => entry.isMain && entry.status === 'wait_finished')
      .sort((a, b) => this.entryOrder(a) - this.entryOrder(b))[0];
    if (recoveredMain) {
      this.ctx.schedulerPhase.set('active');
      this.ctx.highlightedIds.set(new Set([recoveredMain.taskId]));
      this.ctx.lastRuleDecision.set(
        createRuleDecision({
          type: 'idle_promote',
          reason: '等待结束任务已恢复，仅置顶高亮等待用户切换',
          recommendedTaskIds: [recoveredMain.taskId],
        }),
      );
    }
  }

  promoteCandidate(taskId: string, clearDecision: boolean = true): void {
    this.fragmentRest.stopFragmentEntryCountdown();
    this.fragmentRest.setFragmentDismissed(false);
    if (!this.ctx.focusMode()) {
      this.ctx.entries.update(prev =>
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

    const currentFocusId = this.ctx.focusingEntry()?.taskId ?? null;
    const targetEntry = this.ctx.entries().find(entry => entry.taskId === taskId) ?? null;
    this.ctx.entries.update(prev => {
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
      this.ctx.lastConsoleDemotedTaskId.set(currentFocusId);
    }
    if (clearDecision) {
      this.clearPendingDecisionIfMatched(taskId);
    }
  }

  promoteFocusedTaskToMaster(): void {
    this.ctx.entries.update(prev => {
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

  scheduleFirstSuspendRecommendation(suspendedTaskId: string, waitMinutes: number): void {
    const suspendedEntry = this.ctx.entries().find(entry => entry.taskId === suspendedTaskId) ?? null;
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
      this.ctx.pendingDecision.set(null);
      this.ctx.highlightedIds.set(new Set());
      return;
    }

    const scoreByTaskId = new Map(rankedFallback.map(item => [item.taskId, item.score]));
    const pendingGroups = recommendation.groups.map(group => ({ type: group.type, taskIds: group.taskIds }));

    this.ctx.entries.update(prev =>
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
    this.ctx.highlightedIds.set(new Set(highlighted));
    this.ctx.lastRuleDecision.set(
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

  setPendingDecision(
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
    this.ctx.pendingDecision.set({
      rootTaskId,
      rootRemainingMinutes,
      candidateGroups,
      reason,
      expiresAt: expiresAtMs === null ? undefined : new Date(nowDate.getTime() + expiresAtMs).toISOString(),
      autoPromoteAfterMs: expiresAtMs ?? undefined,
      createdAt: now,
    });

    this.ctx.entries.update(prev =>
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

    this.ctx.highlightedIds.set(new Set(candidateIds));
    this.ctx.lastRuleDecision.set(
      createRuleDecision({
        type: 'pending_decision',
        reason,
        rootTaskId,
        recommendedTaskIds: candidateIds,
        remainingMinutes: rootRemainingMinutes,
      }),
    );
  }

  enterFragmentPhase(reason: string, rootTaskId?: string, remainingMinutes?: number): void {
    this.fragmentRest.setFragmentDismissed(false);
    this.ctx.schedulerPhase.set('paused');
    if (this.ctx.fragmentDefenseLevel() < 2) {
      this.ctx.fragmentDefenseLevel.set(2);
    }
    // 碎片阶段进入时自动触发碎片事件推荐（策划案 §7.8 Step 3.5）
    if (this.ctx.fragmentDefenseLevel() >= 2) {
      this.fragmentRest.getFragmentEventRecommendation();
    }
    this.ctx.lastRuleDecision.set(
      createRuleDecision({
        type: 'fragment_phase',
        reason,
        rootTaskId,
        recommendedTaskIds: [],
        remainingMinutes,
      }),
    );
  }

  clearSystemSelectionOnEntries(entries: DockEntry[]): DockEntry[] {
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

  clearSuspendRecommendationStateOnEntries(entries: DockEntry[]): DockEntry[] {
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

  clearPendingDecisionIfMatched(taskId: string): void {
    const pending = this.ctx.pendingDecision();
    if (!pending || !this.pendingCandidateIds(pending).includes(taskId)) return;
    this.ctx.pendingDecision.set(null);
    this.ctx.highlightedIds.set(new Set());
    this.ctx.entries.update(prev => this.clearSystemSelectionOnEntries(prev));
  }

  enforceSingleMainInvariant(
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

  pendingCandidateIds(pending: DockPendingDecision): string[] {
    return pending.candidateGroups.flatMap(group => group.taskIds);
  }

  sortConsoleEntriesForDisplay(entries: DockEntry[]): DockEntry[] {
    if (entries.length <= 1) return entries;
    const demotedTaskId = this.ctx.lastConsoleDemotedTaskId();
    const hintIndex = new Map(
      this.ctx.consoleVisibleOrderHint().map((taskId, index) => [taskId, index] as const),
    );
    return [...entries].sort((a, b) => {
      // 1️⃣ C 位：focusing 永远排最前
      if (a.status === 'focusing') return -1;
      if (b.status === 'focusing') return 1;

      // 2️⃣ 最近一次交互命中的四卡顺序优先，保证"选中项前置，其余存活项顺延"
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

  // ---------------------------------------------------------------------------
  //  Private helpers
  // ---------------------------------------------------------------------------

  private entryOrder(entry: DockEntry): number {
    return this.zoneService.entryOrder(entry);
  }
}
