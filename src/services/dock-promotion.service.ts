/**
 * DockPromotionService
 * 从 DockCompletionFlowService 中提取的推进/推荐流逻辑。
 * 负责：候选推进（promoteCandidate）、自动推进（promoteNext）、
 * 主控台恢复（promoteFocusedTaskToMaster）、待决策匹配清除等调度流逻辑。
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
} from '../models/parking-dock';
import { createRuleDecision, rankDockCandidates } from './dock-scheduler.rules';
import {
  clearSystemSelectionFlags,
  deriveBackgroundStatus,
  pendingCandidateIds as pendingCandidateIdsPure,
} from './dock-completion.utils';
import { DockFragmentRestService } from './dock-fragment-rest.service';
import { DockZoneService } from './dock-zone.service';
import { LoggerService } from './logger.service';
import { normalizeNullableNumber } from './dock-snapshot-persistence.service';
import {
  entryOrder,
  isAutoPromotableStatus,
  isRunnableStatus,
} from './dock-engine.utils';
import { TimerHandle } from '../utils/timer-handle';

// ---------------------------------------------------------------------------
//  Context interface — engine 在 constructor 中调用 init() 注入信号引用
// ---------------------------------------------------------------------------

export interface DockPromotionContext {
  entries: WritableSignal<DockEntry[]>;
  pendingDecision: WritableSignal<DockPendingDecision | null>;
  highlightedIds: WritableSignal<Set<string>>;
  schedulerPhase: WritableSignal<DockSchedulerPhase>;
  lastRuleDecision: WritableSignal<DockRuleDecision | null>;
  lastConsoleDemotedTaskId: WritableSignal<string | null>;
  focusingEntry: Signal<DockEntry | null>;
  focusMode: Signal<boolean>;
  highlightClearTimer: TimerHandle;
}

@Injectable({
  providedIn: 'root',
})
export class DockPromotionService {
  private readonly zoneService = inject(DockZoneService);
  private readonly fragmentRest = inject(DockFragmentRestService);
  private readonly logger = inject(LoggerService);

  private _ctx: DockPromotionContext | null = null;

  /**
   * 获取上下文——必须在 DockEngineService 构造期间调用 init() 注入。
   * 如未初始化则抛出明确错误，便于定位 DI 顺序问题。
   */
  private get ctx(): DockPromotionContext {
    if (!this._ctx) {
      throw new Error(
        'DockPromotionService.init() must be called before use. ' +
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
  init(ctx: DockPromotionContext): void {
    if (this._ctx) {
      this.logger.category('DockPromotion').warn('init() called again — overwriting previous context');
    }
    this._ctx = ctx;
  }

  // ---------------------------------------------------------------------------
  //  Private helpers
  // ---------------------------------------------------------------------------

  /**
   * 封装 lastRuleDecision 的更新：创建决策记录并写入信号。
   */
  private setLastDecision(params: {
    type: Parameters<typeof createRuleDecision>[0]['type'];
    reason: string;
    rootTaskId?: string;
    recommendedTaskIds?: string[];
    remainingMinutes?: number;
    ratio?: number | null;
  }): void {
    this.ctx.lastRuleDecision.set(createRuleDecision(params));
  }

  // ---------------------------------------------------------------------------
  //  Conversion helper
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

  // ---------------------------------------------------------------------------
  //  Promote next — 自动推进调度链
  // ---------------------------------------------------------------------------

  /** 按优先级尝试推进下一个候选任务 */
  promoteNext(): void {
    const allEntries = this.ctx.entries();
    if (this.tryPromoteStalled(allEntries)) return;
    if (this.tryPromoteMainIdle(allEntries)) return;
    if (this.tryPromoteRadarCandidate(allEntries)) return;
    this.tryHighlightRecoveredMain(allEntries);
  }

  /** 优先恢复停滞任务 */
  private tryPromoteStalled(allEntries: readonly DockEntry[]): boolean {
    const stalled = allEntries
      .filter(entry => entry.status === 'stalled')
      .sort((a, b) => entryOrder(a) - entryOrder(b))[0];
    if (!stalled) return false;
    this.ctx.schedulerPhase.set('active');
    this.promoteCandidate(stalled.taskId);
    this.ctx.highlightedIds.set(new Set([stalled.taskId]));
    this.setLastDecision({
      type: 'idle_promote',
      reason: '主任务完成后优先恢复停滞任务',
      recommendedTaskIds: [stalled.taskId],
    });
    return true;
  }

  /** 主控链存在可运行任务时按入坞顺序推进 */
  private tryPromoteMainIdle(allEntries: readonly DockEntry[]): boolean {
    const mainIdle = allEntries
      .filter(entry => entry.isMain && isAutoPromotableStatus(entry.status))
      .sort((a, b) => entryOrder(a) - entryOrder(b))[0];
    if (!mainIdle) return false;
    this.ctx.schedulerPhase.set('active');
    this.promoteCandidate(mainIdle.taskId);
    this.setLastDecision({
      type: 'idle_promote',
      reason: '主控链存在可运行任务，按入坞顺序推进',
      recommendedTaskIds: [mainIdle.taskId],
    });
    return true;
  }

  /** 规则引擎从雷达区拉取最优候选进入主控台 */
  private tryPromoteRadarCandidate(allEntries: readonly DockEntry[]): boolean {
    const radarCandidates = allEntries.filter(
      entry => !entry.isMain && isAutoPromotableStatus(entry.status),
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
    if (!radarCandidate) return false;
    this.ctx.schedulerPhase.set('active');
    this.promoteCandidate(radarCandidate.taskId);
    this.ctx.highlightedIds.set(new Set([radarCandidate.taskId]));
    this.setLastDecision({
      type: 'idle_promote',
      reason: '规则引擎从雷达区拉取最优候选进入主控台',
      recommendedTaskIds: [radarCandidate.taskId],
    });
    this.ctx.highlightClearTimer.schedule(() => {
      if (this.ctx.pendingDecision()) return;
      this.ctx.highlightedIds.set(new Set());
    }, PARKING_CONFIG.HIGHLIGHT_CLEAR_DELAY_MS);
    return true;
  }

  /** 等待结束任务已恢复时仅高亮等待用户手动切换 */
  private tryHighlightRecoveredMain(allEntries: readonly DockEntry[]): void {
    const recoveredMain = allEntries
      .filter(entry => entry.isMain && entry.status === 'wait_finished')
      .sort((a, b) => entryOrder(a) - entryOrder(b))[0];
    if (recoveredMain) {
      this.ctx.schedulerPhase.set('active');
      this.ctx.highlightedIds.set(new Set([recoveredMain.taskId]));
      this.setLastDecision({
        type: 'idle_promote',
        reason: '等待结束任务已恢复，仅置顶高亮等待用户切换',
        recommendedTaskIds: [recoveredMain.taskId],
      });
    }
  }

  // ---------------------------------------------------------------------------
  //  Promote candidate — 候选推进到主控台
  // ---------------------------------------------------------------------------

  /** 推进候选任务：根据专注模式分发到不同推进策略 */
  promoteCandidate(taskId: string, clearDecision: boolean = true): void {
    this.fragmentRest.stopFragmentEntryCountdown();
    this.fragmentRest.setFragmentDismissed(false);
    if (!this.ctx.focusMode()) {
      this.promoteCandidateNonFocus(taskId);
      return;
    }
    this.promoteCandidateInFocus(taskId);
    if (clearDecision) {
      this.clearPendingDecisionIfMatched(taskId);
    }
  }

  /** 非专注模式下候选推进：设为 main + pending_start */
  private promoteCandidateNonFocus(taskId: string): void {
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
  }

  /** 专注模式下候选推进：设为 focusing，原焦点降级 */
  private promoteCandidateInFocus(taskId: string): void {
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
            status: 'focusing',
            waitMinutes: null,
            waitStartedAt: null,
            systemSelected: false,
            recommendationLocked: false,
          };
        }
        if (currentFocusId && entry.taskId === currentFocusId) {
          return {
            ...entry,
            status: deriveBackgroundStatus(entry, targetEntry, this.ctx.focusingEntry()),
          };
        }
        return entry;
      });
    });
    if (currentFocusId && currentFocusId !== taskId) {
      this.ctx.lastConsoleDemotedTaskId.set(currentFocusId);
    }
  }

  // ---------------------------------------------------------------------------
  //  Promote focused task to master — 确保主控台始终有主任务
  // ---------------------------------------------------------------------------

  /** 当主任务缺失时，自动将聚焦任务提升为主任务 */
  promoteFocusedTaskToMaster(): void {
    this.ctx.entries.update(prev => {
      const active = prev.filter(entry => entry.status !== 'completed');
      if (active.length === 0) return prev;
      const hasMaster = active.some(entry => entry.isMain);
      if (hasMaster) return prev;

      const nextMaster =
        active.find(entry => entry.status === 'focusing') ??
        active.find(entry => isRunnableStatus(entry.status)) ??
        active[0];
      if (!nextMaster) return prev;

      return prev.map(entry =>
        entry.taskId === nextMaster.taskId
          ? { ...entry, isMain: true }
          : entry,
      );
    });
  }

  // ---------------------------------------------------------------------------
  //  Pending decision — 待决策匹配清除
  // ---------------------------------------------------------------------------

  /** 如果 taskId 匹配当前待决策的候选列表，清除待决策状态 */
  clearPendingDecisionIfMatched(taskId: string): void {
    const pending = this.ctx.pendingDecision();
    if (!pending || !pendingCandidateIdsPure(pending).includes(taskId)) return;
    this.ctx.pendingDecision.set(null);
    this.ctx.highlightedIds.set(new Set());
    this.ctx.entries.update(prev => clearSystemSelectionFlags(prev));
  }
}
