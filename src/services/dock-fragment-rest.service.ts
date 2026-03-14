/**
 * DockFragmentRestService
 * Fragment phase countdown timer, rest reminder accumulation,
 * and fragment event recommendation.
 * Extracted from DockEngineService to separate timer-based
 * fragment/rest monitoring from core dock state logic.
 */
import { Injectable, inject, signal } from '@angular/core';
import { PARKING_CONFIG } from '../config/parking.config';
import {
  FragmentDefenseLevel,
  FragmentEventEntry,
  PRESET_FRAGMENT_EVENTS,
} from '../models/parking-dock';
import { FocusPreferenceService } from './focus-preference.service';
import { LoggerService } from './logger.service';

/**
 * Callbacks provided by DockEngineService for engine state mutations
 * that must happen during fragment phase transitions.
 */
export interface FragmentRestEngineCallbacks {
  enterFragmentPhase: (reason: string, rootTaskId?: string, remainingMinutes?: number) => void;
  clearPendingDecisionState: () => void;
}

@Injectable({
  providedIn: 'root',
})
export class DockFragmentRestService {
  private readonly focusPreferenceService = inject(FocusPreferenceService);
  private readonly logger = inject(LoggerService).category('DockFragmentRest');

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
  private fragmentCountdownTimer: ReturnType<typeof setInterval> | null = null;
  /** 碎片倒计时超时后是否用户已主动跳过 */
  private readonly fragmentEntryDismissed = signal(false);
  /** 倒计时上下文：进入碎片阶段时使用的原因/参数 */
  private fragmentCountdownContext: {
    reason: string;
    rootTaskId?: string;
    remainingMinutes?: number;
  } | null = null;

  private callbacks: FragmentRestEngineCallbacks | null = null;

  /**
   * Initialize with engine callbacks. Must be called once during
   * DockEngineService construction.
   */
  init(callbacks: FragmentRestEngineCallbacks): void {
    this.callbacks = callbacks;
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
      this.callbacks?.clearPendingDecisionState();
    }
    this.fragmentEntryDismissed.set(false);
    this.fragmentCountdownContext = {
      reason: context?.reason ?? '碎片时间倒计时结束/用户确认，进入碎片阶段',
      rootTaskId: context?.rootTaskId,
      remainingMinutes: context?.remainingMinutes,
    };
    const totalSeconds = context?.countdownSeconds ?? PARKING_CONFIG.FRAGMENT_ENTRY_COUNTDOWN_S;
    this.fragmentEntryCountdown.set(totalSeconds);
    this.fragmentCountdownTimer = setInterval(() => {
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
    if (this.fragmentCountdownTimer) {
      clearInterval(this.fragmentCountdownTimer);
      this.fragmentCountdownTimer = null;
    }
    this.fragmentEntryCountdown.set(null);
    if (clearContext) {
      this.fragmentCountdownContext = null;
    }
  }

  private enterFragmentPhaseFromCountdown(): void {
    const context = this.fragmentCountdownContext;
    this.fragmentCountdownContext = null;
    this.callbacks?.enterFragmentPhase(
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
   * 从预置列表中随机选取一个推荐给用户
   */
  getFragmentEventRecommendation(defenseLevel: FragmentDefenseLevel): FragmentEventEntry | null {
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
        // 随机选一个，避免总是推同一条
        const pick = candidates[Math.floor(Math.random() * candidates.length)];
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

  // ─── Full Reset ───────────────────────────────

  /** Reset all fragment/rest state to initial values. */
  resetAll(): void {
    this.stopFragmentEntryCountdown();
    this.fragmentEntryDismissed.set(false);
    this.activeFragmentEvent.set(null);
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
