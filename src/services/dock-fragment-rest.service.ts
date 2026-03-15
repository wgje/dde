/**
 * DockFragmentRestService
 * Fragment phase countdown timer, rest reminder accumulation,
 * and fragment event recommendation.
 * Extracted from DockEngineService to separate timer-based
 * fragment/rest monitoring from core dock state logic.
 */
import { Injectable, Signal, WritableSignal, inject, signal, DestroyRef } from '@angular/core';
import { PARKING_CONFIG } from '../config/parking.config';
import {
  DockEntry,
  DockRuleDecision,
  DockSchedulerPhase,
  FragmentDefenseLevel,
  FragmentEventEntry,
  HighLoadCounter,
  PRESET_FRAGMENT_EVENTS,
} from '../models/parking-dock';
import { determineFragmentDefenseLevel } from './dock-scheduler.rules';
import { FocusPreferenceService } from './focus-preference.service';
import { LoggerService } from './logger.service';
import { IntervalHandle } from '../utils/timer-handle';

/**
 * Callbacks and signal references provided by DockEngineService
 * for engine state mutations during fragment phase transitions,
 * defense-level updates, and burnout cooldown checks.
 */
export interface FragmentRestEngineCallbacks {
  enterFragmentPhase: (reason: string, rootTaskId?: string, remainingMinutes?: number) => void;
  clearPendingDecisionState: () => void;
  // Signal references for fragment defense & burnout methods
  entries: Signal<DockEntry[]>;
  focusMode: Signal<boolean>;
  schedulerPhase: WritableSignal<DockSchedulerPhase>;
  fragmentDefenseLevel: WritableSignal<FragmentDefenseLevel>;
  burnoutTriggeredAt: WritableSignal<number | null>;
  highLoadCounter: WritableSignal<HighLoadCounter>;
  focusingEntry: Signal<DockEntry | null>;
  lastRuleDecision: WritableSignal<DockRuleDecision | null>;
  isFragmentPhase: Signal<boolean>;
  getWaitRemainingSeconds: (entry: DockEntry) => number | null;
}

@Injectable({
  providedIn: 'root',
})
export class DockFragmentRestService {
  private readonly focusPreferenceService = inject(FocusPreferenceService);
  private readonly logger = inject(LoggerService).category('DockFragmentRest');
  private readonly destroyRef = inject(DestroyRef);

  constructor() {
    this.destroyRef.onDestroy(() => this.resetAll());
  }

  // ─── Signals (owned here, re-exported by DockEngine) ───

  /** 碎片进入倒计时剩余秒数（null=不在倒计时状态） */
  readonly fragmentEntryCountdown = signal<number | null>(null);
  /** GAP-1: 累计高负荷专注毫秒数（10s tick 累加，仅 focusMode + focusing 状态下增长） */
  readonly cumulativeHighLoadMs = signal(0);
  /** 累计低负荷专注毫秒数 */
  readonly cumulativeLowLoadMs = signal(0);
  /** 是否已触发休息提醒（高负荷通道） */
  readonly restReminderHighShown = signal(false);
  /** 是否已触发休息提醒（低负荷通道） */
  readonly restReminderLowShown = signal(false);
  /** 是否正在展示休息提醒光晕（UI 读取此信号渲染边缘光晕） */
  readonly restReminderActive = signal(false);
  /** v3.0 碎片事件推荐（策划案 §7.8 Level 2/3） */
  readonly activeFragmentEvent = signal<FragmentEventEntry | null>(null);

  // ─── Private State ────────────────────────────

  /** 碎片倒计时 interval timer */
  private readonly fragmentCountdownInterval = new IntervalHandle();
  /** 碎片倒计时超时后是否用户已主动跳过 */
  private readonly fragmentEntryDismissed = signal(false);
  /** 倒计时上下文：进入碎片阶段时使用的原因/参数 */
  private fragmentCountdownContext: {
    reason: string;
    rootTaskId?: string;
    remainingMinutes?: number;
  } | null = null;

  private _callbacks: FragmentRestEngineCallbacks | null = null;

  /** 碎片事件推荐轮询索引，确保推荐结果可预测（非随机） */
  private fragmentEventRoundRobinIndex = 0;

  /**
   * 获取回调——必须在 DockEngineService 构造期间调用 init() 注入。
   * 如未初始化则抛出明确错误，便于定位 DI 顺序问题。
   */
  private get callbacks(): FragmentRestEngineCallbacks {
    if (!this._callbacks) {
      throw new Error(
        'DockFragmentRestService.init() must be called before use. ' +
        'Ensure DockEngineService is constructed before accessing this service.',
      );
    }
    return this._callbacks;
  }

  /**
   * 由 DockEngineService 在其构造函数中调用，注入引擎回调和信号引用。
   * 此服务使用手动上下文注入而非 Angular DI，因为所需回调引用的是 DockEngineService 的私有成员，
   * 无法通过常规注入获取。这是有意的架构权衡：以运行时初始化检查换取信号封装性。
   */
  init(callbacks: FragmentRestEngineCallbacks): void {
    if (this._callbacks) {
      this.logger.warn('init() called again — overwriting previous callbacks');
    }
    this._callbacks = callbacks;
  }

  // ─── Fragment Entry Countdown ─────────────────

  /**
   * 开始碎片时间进入倒计时。
   * 在等待插入任务完成后、主任务仍有剩余等待时间时调用。
   */
  startFragmentEntryCountdown(context?: {
    reason?: string;
    rootTaskId?: string;
    remainingMinutes?: number;
    /** 保留已有的 pendingDecision，碎片过渡期间同时展示推荐候选 */
    preservePendingDecision?: boolean;
    /** 覆盖倒计时秒数（默认使用 FRAGMENT_ENTRY_COUNTDOWN_S） */
    countdownSeconds?: number;
  }): void {
    this.stopFragmentEntryCountdown(false);
    if (!context?.preservePendingDecision) {
      this.callbacks.clearPendingDecisionState();
    }
    this.fragmentEntryDismissed.set(false);
    this.fragmentCountdownContext = {
      reason: context?.reason ?? '碎片时间倒计时结束/用户确认，进入碎片阶段',
      rootTaskId: context?.rootTaskId,
      remainingMinutes: context?.remainingMinutes,
    };
    const totalSeconds = context?.countdownSeconds ?? PARKING_CONFIG.FRAGMENT_ENTRY_COUNTDOWN_S;
    this.fragmentEntryCountdown.set(totalSeconds);
    this.fragmentCountdownInterval.start(() => {
      const current = this.fragmentEntryCountdown();
      if (current === null || current <= 1) {
        // 倒计时结束，自动进入碎片阶段
        const countdownContext = this.fragmentCountdownContext;
        this.stopFragmentEntryCountdown();
        this.fragmentCountdownContext = countdownContext;
        this.enterFragmentPhaseFromCountdown();
        return;
      }
      this.fragmentEntryCountdown.set(current - 1);
    }, 1000);
  }

  /** 用户在倒计时内主动选择进入碎片时间 */
  acceptFragmentEntry(): void {
    const countdownContext = this.fragmentCountdownContext;
    this.stopFragmentEntryCountdown();
    this.fragmentCountdownContext = countdownContext;
    this.enterFragmentPhaseFromCountdown();
  }

  /** 用户在倒计时内主动跳过碎片时间 */
  skipFragmentEntry(): void {
    this.stopFragmentEntryCountdown();
    this.fragmentEntryDismissed.set(true);
    this.logger.info('用户跳过碎片时间进入');
  }

  stopFragmentEntryCountdown(clearContext: boolean = true): void {
    this.fragmentCountdownInterval.stop();
    this.fragmentEntryCountdown.set(null);
    if (clearContext) {
      this.fragmentCountdownContext = null;
    }
  }

  private enterFragmentPhaseFromCountdown(): void {
    const context = this.fragmentCountdownContext;
    this.fragmentCountdownContext = null;
    this.callbacks.enterFragmentPhase(
      context?.reason ?? '碎片时间倒计时结束/用户确认，进入碎片阶段',
      context?.rootTaskId,
      context?.remainingMinutes,
    );
    this.logger.info('碎片时间倒计时结束/用户确认，进入碎片阶段');
  }

  // ─── Rest Reminder ────────────────────────────

  /**
   * 每 10s tick 时累加当前 focusing 任务对应负荷的专注时长，
   * 达到阈值后触发 restReminderActive 信号供 UI 渲染光晕。
   *
   * @param focusMode - engine focusMode signal value
   * @param focusingLoad - the cognitive load of the current focusing entry, or null
   */
  tickRestReminderAccumulator(
    focusMode: boolean,
    focusingLoad: 'high' | 'low' | null,
  ): void {
    if (!focusMode) return;
    if (focusingLoad === null) return;

    const TICK_MS = 10_000; // 与 tick interval 一致

    if (focusingLoad === 'high') {
      const next = this.cumulativeHighLoadMs() + TICK_MS;
      this.cumulativeHighLoadMs.set(next);
      if (next >= this.highLoadRestReminderThresholdMs() && !this.restReminderHighShown()) {
        this.restReminderHighShown.set(true);
        this.restReminderActive.set(true);
        this.logger.info(`休息提醒：高负荷累计专注 ${Math.round(next / 60_000)} 分钟`);
      }
    } else {
      const next = this.cumulativeLowLoadMs() + TICK_MS;
      this.cumulativeLowLoadMs.set(next);
      if (next >= this.lowLoadRestReminderThresholdMs() && !this.restReminderLowShown()) {
        this.restReminderLowShown.set(true);
        this.restReminderActive.set(true);
        this.logger.info(`休息提醒：低负荷累计专注 ${Math.round(next / 60_000)} 分钟`);
      }
    }
  }

  /**
   * 用户确认/关闭休息提醒（UI 调用）
   * 重置提醒状态以允许下一轮累计触发
   */
  dismissRestReminder(): void {
    this.restReminderActive.set(false);
    // 重置累计时长，允许下一周期再次触发
    if (this.restReminderHighShown()) {
      this.cumulativeHighLoadMs.set(0);
      this.restReminderHighShown.set(false);
    }
    if (this.restReminderLowShown()) {
      this.cumulativeLowLoadMs.set(0);
      this.restReminderLowShown.set(false);
    }
  }

  /** Reset all rest reminder state (called on focus mode exit or full reset). */
  resetRestState(): void {
    this.cumulativeHighLoadMs.set(0);
    this.cumulativeLowLoadMs.set(0);
    this.restReminderHighShown.set(false);
    this.restReminderLowShown.set(false);
    this.restReminderActive.set(false);
  }

  // ─── Fragment Event Recommendation ────────────

  /**
   * 碎片事件推荐（策划案 §7.8 Level 2）
   * 按 physical-crossover > digital-janitor > micro-progress 优先级
   * 从预置列表中以 round-robin 方式选取，确保推荐结果可预测且分布均匀
   */
  getFragmentEventRecommendation(): FragmentEventEntry | null {
    const defenseLevel = this.callbacks.fragmentDefenseLevel();
    if (defenseLevel < 2) return null;

    // 按分类优先级排列候选
    const categoryOrder: FragmentEventEntry['category'][] = [
      'physical-crossover',
      'digital-janitor',
      'micro-progress',
    ];

    for (const category of categoryOrder) {
      const candidates = PRESET_FRAGMENT_EVENTS.filter(e => e.category === category);
      if (candidates.length > 0) {
        // round-robin 轮询选取，避免随机导致的不可预测行为
        const pick = candidates[this.fragmentEventRoundRobinIndex % candidates.length];
        this.fragmentEventRoundRobinIndex++;
        this.activeFragmentEvent.set(pick);
        return pick;
      }
    }
    return null;
  }

  /**
   * 完成碎片事件（策划案 §7.8 Level 3→4）
   * 完成后不连发，直接进入 Zen Mode
   * @returns true if the event was active and completed
   */
  completeFragmentEvent(): boolean {
    if (!this.activeFragmentEvent()) return false;
    this.activeFragmentEvent.set(null);
    // Level 3→4：碎片做完后直接进入 Zen Mode（不连发）
    this.callbacks.fragmentDefenseLevel.set(4);
    this.callbacks.schedulerPhase.set('paused');
    this.logger.info('碎片事件完成，进入 Zen Mode（Level 4）');
    return true;
  }

  /**
   * 跳过碎片事件 → 展示日常任务槽（策划案 §7.8 Step 3.5→Step 4）
   */
  skipFragmentEvent(): void {
    this.activeFragmentEvent.set(null);
    // 跳过后仍停留在 Level 2 碎片阶段，展示日常任务
    this.logger.info('碎片事件跳过，回到日常任务展示');
  }

  // ─── Dismissed State ──────────────────────────

  /** Whether the user has dismissed the fragment entry prompt. */
  isFragmentDismissed(): boolean {
    return this.fragmentEntryDismissed();
  }

  setFragmentDismissed(value: boolean): void {
    this.fragmentEntryDismissed.set(value);
  }

  // ─── Fragment Defense & Burnout ────────────────

  /** 碎片阶段防御等级动态更新（每 10s tick 调用） */
  updateFragmentDefenseLevel(): void {
    const ctx = this.callbacks;
    if (ctx.fragmentDefenseLevel() === 4 && ctx.isFragmentPhase()) {
      ctx.schedulerPhase.set('paused');
      return;
    }

    const waitingEntries = ctx.entries().filter(
      entry => entry.status === 'suspended_waiting' && entry.waitStartedAt && entry.waitMinutes,
    );
    if (waitingEntries.length === 0) {
      this.stopFragmentEntryCountdown();
      this.setFragmentDismissed(false);
      ctx.fragmentDefenseLevel.set(1);
      ctx.schedulerPhase.set('active');
      return;
    }

    const shortestWaitMin = Math.min(
      ...waitingEntries.map(entry => {
        const remaining = ctx.getWaitRemainingSeconds(entry);
        return remaining !== null ? remaining / 60 : Infinity;
      }),
    );

    const hasBurnout = ctx.burnoutTriggeredAt() !== null;
    ctx.fragmentDefenseLevel.set(determineFragmentDefenseLevel(shortestWaitMin, hasBurnout));
    ctx.schedulerPhase.set('paused');
  }

  /**
   * 倦怠冷却检查（策划案 §7.8 NG-16b）
   * 在 tick 中调用，检查倦怠冷却期是否已过
   */
  checkBurnoutCooldown(): void {
    const ctx = this.callbacks;
    const burnoutAt = ctx.burnoutTriggeredAt();
    if (burnoutAt === null) return;
    if (Date.now() - burnoutAt > PARKING_CONFIG.BURNOUT_COOLDOWN_MS) {
      ctx.burnoutTriggeredAt.set(null);
      ctx.highLoadCounter.set({ count: 0, windowStartAt: 0 });
      this.logger.info('倦怠冷却期结束，计数器重置');
    }
  }

  /** 退出 Zen Mode，回退到碎片/活跃阶段 */
  dismissZenMode(): void {
    const ctx = this.callbacks;
    if (!ctx.focusMode()) return;
    if (ctx.isFragmentPhase()) {
      ctx.fragmentDefenseLevel.set(2);
      ctx.schedulerPhase.set('paused');
      return;
    }
    ctx.fragmentDefenseLevel.set(1);
    ctx.schedulerPhase.set('active');
  }

  // ─── Full Reset ───────────────────────────────

  /** Reset all fragment/rest state to initial values. */
  resetAll(): void {
    this.stopFragmentEntryCountdown();
    this.fragmentEntryDismissed.set(false);
    this.activeFragmentEvent.set(null);
    // M-22 fix: 重置 round-robin 索引，避免跨会话状态泄漏
    this.fragmentEventRoundRobinIndex = 0;
    this.resetRestState();
  }

  // ─── Private Helpers ──────────────────────────

  private highLoadRestReminderThresholdMs(): number {
    return Math.max(
      60_000,
      Math.floor(this.focusPreferenceService.preferences().restReminderHighLoadMinutes) * 60_000,
    );
  }

  private lowLoadRestReminderThresholdMs(): number {
    return Math.max(
      60_000,
      Math.floor(this.focusPreferenceService.preferences().restReminderLowLoadMinutes) * 60_000,
    );
  }
}
