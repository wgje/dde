/**
 * 大门服务
 *
 * 负责大门机制的状态管理和交互逻辑
 * 每日首次打开应用时，强制处理昨日遗留条目
 */

import { Injectable, inject, signal, NgZone } from '@angular/core';
import { BlackBoxEntry } from '../models/focus';
import { Result, success, failure, ErrorCodes, ErrorMessages } from '../utils/result';
import { FOCUS_CONFIG } from '../config/focus.config';
import { BlackBoxService } from './black-box.service';
import { LoggerService } from './logger.service';
import {
  gateState,
  gatePendingItems,
  gateCurrentIndex,
  gateSnoozeCount,
  gateCurrentEntry,
  gateProgress,
  canSnooze,
  isGateActive,
  pendingBlackBoxEntries,
  focusPreferences,
  resetGateState,
  getTodayDate,
  getTomorrowDate,
  updateBlackBoxEntry
} from '../state/focus-stores';

interface OperationError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

/** LocalStorage 键：上次大门检查日期 */
const GATE_LAST_CHECK_DATE_KEY = 'focus_gate_last_check_date';
/** LocalStorage 键：当日跳过次数重置日期 */
const GATE_SNOOZE_RESET_DATE_KEY = 'focus_gate_snooze_reset_date';

/** 动画超时时间（毫秒）- 防止动画卡死导致按钮永久禁用 */
const ANIMATION_TIMEOUT_MS = 1200;

export type GateMotionState =
  | 'idle'
  | 'entering'
  | 'heave_read'
  | 'heavy_drop'
  | 'settling';

@Injectable({
  providedIn: 'root'
})
export class GateService {
  private readonly blackBoxService = inject(BlackBoxService);
  private readonly logger = inject(LoggerService);
  private readonly ngZone = inject(NgZone);

  // 暴露状态给组件
  readonly state = gateState;
  readonly pendingItems = gatePendingItems;
  readonly currentIndex = gateCurrentIndex;
  readonly snoozeCount = gateSnoozeCount;
  readonly currentEntry = gateCurrentEntry;
  readonly progress = gateProgress;
  readonly canSnooze = canSnooze;

  /** 门体动效状态 */
  readonly cardAnimation = signal<GateMotionState>('idle');

  /** 完成落地冲击节拍（用于触发 Overlay 震动） */
  readonly impactTick = signal(0);

  // 是否显示完成提示
  readonly showCompletionMessage = signal<boolean>(false);

  /**
   * [DEV] 开发模式强制显示标志
   * 为 true 时，FocusModeComponent 跳过 loadFromLocal + checkGate，
   * 防止模拟数据被 IndexedDB 空数据覆盖
   */
  readonly devForceActive = signal<boolean>(false);

  /**
   * 大门是否激活（正在审查条目）
   */
  readonly isActive = isGateActive;

  /** 动画超时定时器 - 用于防止动画卡死 */
  private animationTimeoutId: ReturnType<typeof setTimeout> | null = null;

  /** 当前动作动画（用于防止 timeout + animationend 双触发） */
  private actionInFlight: 'heave_read' | 'heavy_drop' | null = null;

  /**
   * 检测用户是否启用了减少动画（prefers-reduced-motion）
   * 使用响应式 signal 支持运行时变化
   */
  private readonly prefersReducedMotionSignal = signal<boolean>(
    typeof window !== 'undefined' &&
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  );

  /** 向后兼容的只读访问器 */
  private get prefersReducedMotion(): boolean {
    return this.prefersReducedMotionSignal();
  }

  constructor() {
    this.setupReducedMotionListener();
  }

  /**
   * 监听 prefers-reduced-motion 变化
   * 当用户在运行时切换减少动画偏好时，立即响应
   */
  private setupReducedMotionListener(): void {
    if (typeof window === 'undefined') return;

    const mediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)');

    mediaQuery.addEventListener('change', (e) => {
      this.prefersReducedMotionSignal.set(e.matches);
      this.logger.debug('Gate', `prefers-reduced-motion changed to: ${e.matches}`);

      if (e.matches && this.cardAnimation() !== 'idle') {
        this.logger.info('Gate', 'Reduced motion enabled, forcing idle state');
        this.cardAnimation.set('idle');
        this.actionInFlight = null;
        this.clearAnimationTimeout();
      }
    });
  }

  /**
   * 设置动画状态并启动超时保护
   */
  private setCardAnimationWithTimeout(
    state: GateMotionState,
    onTimeout?: () => void
  ): void {
    this.clearAnimationTimeout();

    if (state !== 'idle' && this.prefersReducedMotion) {
      this.cardAnimation.set('idle');
      this.logger.debug('Gate', `Reduced motion: skipping animation state '${state}'`);
      onTimeout?.();
      return;
    }

    this.cardAnimation.set(state);

    if (state !== 'idle') {
      this.animationTimeoutId = setTimeout(() => {
        this.ngZone.run(() => {
          if (this.cardAnimation() !== state) return;

          this.logger.warn('Gate', `Animation timeout (${ANIMATION_TIMEOUT_MS}ms), forcing idle from '${state}'`);
          this.cardAnimation.set('idle');
          onTimeout?.();
        });
      }, ANIMATION_TIMEOUT_MS);
    }
  }

  /** 清除动画超时定时器 */
  private clearAnimationTimeout(): void {
    if (!this.animationTimeoutId) return;
    clearTimeout(this.animationTimeoutId);
    this.animationTimeoutId = null;
  }

  /**
   * 检查是否需要显示大门
   * 在应用启动时调用
   */
  checkGate(): void {
    // 如果大门已经在审查中，不要重复初始化（避免动画叠加和状态重置）
    if (gateState() === 'reviewing') {
      this.logger.debug('Gate', 'Gate already reviewing, skipping re-init');
      return;
    }

    this.devForceActive.set(false);
    this.showCompletionMessage.set(false);
    this.actionInFlight = null;

    const preferences = focusPreferences();

    if (!preferences.gateEnabled) {
      gateState.set('disabled');
      this.logger.debug('Gate', 'Gate disabled by user preference');
      return;
    }

    this.resetDailySnoozeCount();

    const pending = pendingBlackBoxEntries();

    if (pending.length > 0) {
      gatePendingItems.set(pending);
      gateCurrentIndex.set(0);
      gateState.set('reviewing');
      this.setCardAnimationWithTimeout('entering', () => this.onEnteringComplete());
      this.logger.info('Gate', `Gate activated with ${pending.length} pending items`);
      return;
    }

    gateState.set('bypassed');
    this.logger.debug('Gate', 'No pending items, gate bypassed');
  }

  /** 标记当前条目为已读 */
  markAsRead(): Result<void, OperationError> {
    const current = this.getCurrentEntry();
    if (!current) {
      return failure(ErrorCodes.FOCUS_ENTRY_NOT_FOUND, '当前没有待处理条目');
    }

    const result = this.blackBoxService.markAsRead(current.id);
    if (result.ok) {
      this.startActionTransition('heave_read');
    }

    return success(undefined);
  }

  /** 标记当前条目为完成 */
  markAsCompleted(): Result<void, OperationError> {
    const current = this.getCurrentEntry();
    if (!current) {
      return failure(ErrorCodes.FOCUS_ENTRY_NOT_FOUND, '当前没有待处理条目');
    }

    const result = this.blackBoxService.markAsCompleted(current.id);
    if (result.ok) {
      this.startActionTransition('heavy_drop');
    }

    return success(undefined);
  }

  /**
   * 跳过当前条目（稍后提醒）
   * 兼容保留：UI 已隐藏此动作
   */
  snooze(): Result<void, OperationError> {
    if (!canSnooze()) {
      return failure(
        ErrorCodes.FOCUS_SNOOZE_LIMIT_EXCEEDED,
        ErrorMessages[ErrorCodes.FOCUS_SNOOZE_LIMIT_EXCEEDED]
      );
    }

    const current = this.getCurrentEntry();
    if (!current) {
      return failure(ErrorCodes.FOCUS_ENTRY_NOT_FOUND, '当前没有待处理条目');
    }

    const tomorrow = getTomorrowDate();
    const result = this.blackBoxService.snooze(current.id, tomorrow);

    if (result.ok) {
      gateSnoozeCount.update(c => c + 1);

      // 兼容路径：在新门体里统一使用 heave_read 过渡
      this.startActionTransition('heave_read');
    }

    return success(undefined);
  }

  /**
   * 启动动作动画并在结束后推进到下一条
   */
  private startActionTransition(state: 'heave_read' | 'heavy_drop'): void {
    this.actionInFlight = state;
    this.setCardAnimationWithTimeout(state, () => this.finalizeActionTransition(state));
  }

  /**
   * 动作动画结束（含 timeout 兜底）
   */
  private finalizeActionTransition(state: 'heave_read' | 'heavy_drop'): void {
    if (this.actionInFlight !== state) return;

    this.actionInFlight = null;
    this.clearAnimationTimeout();

    if (state === 'heavy_drop') {
      this.impactTick.update(v => v + 1);
    }

    const nextIndex = gateCurrentIndex() + 1;
    const total = gatePendingItems().length;

    if (nextIndex >= total) {
      gateState.set('completed');
      this.showCompletionMessage.set(true);
      this.cardAnimation.set('idle');

      this.logger.info('Gate', 'Gate completed, all items processed');

      setTimeout(() => {
        this.showCompletionMessage.set(false);
      }, 1500);
      return;
    }

    gateCurrentIndex.set(nextIndex);
    this.setCardAnimationWithTimeout('settling', () => this.onSettlingComplete());
  }

  /** 入场动画完成回调 */
  onEnteringComplete(): void {
    if (this.cardAnimation() !== 'entering') return;
    this.clearAnimationTimeout();
    this.cardAnimation.set('idle');
  }

  /** 已读抛掷动画完成回调 */
  onHeaveReadComplete(): void {
    if (this.cardAnimation() !== 'heave_read' && !this.prefersReducedMotion) return;
    this.finalizeActionTransition('heave_read');
  }

  /** 完成重落动画完成回调 */
  onHeavyDropComplete(): void {
    if (this.cardAnimation() !== 'heavy_drop' && !this.prefersReducedMotion) return;
    this.finalizeActionTransition('heavy_drop');
  }

  /** 新条目沉降动画完成回调 */
  onSettlingComplete(): void {
    if (this.cardAnimation() !== 'settling') return;
    this.clearAnimationTimeout();
    this.cardAnimation.set('idle');
  }

  /**
   * 兼容旧 GateCard 回调名称
   * @deprecated 请使用 onHeavyDropComplete
   */
  onSinkingComplete(): void {
    this.onHeavyDropComplete();
  }

  /**
   * 兼容旧 GateCard 回调名称
   * @deprecated 请使用 onSettlingComplete
   */
  onEmergingComplete(): void {
    this.onSettlingComplete();
  }

  /** 获取当前条目 */
  getCurrentEntry(): BlackBoxEntry | null {
    const items = gatePendingItems();
    const index = gateCurrentIndex();
    return items[index] ?? null;
  }

  /** 重置每日跳过次数 */
  private resetDailySnoozeCount(): void {
    const today = getTodayDate();
    const lastResetDate = localStorage.getItem(GATE_SNOOZE_RESET_DATE_KEY);

    if (lastResetDate !== today) {
      gateSnoozeCount.set(0);
      localStorage.setItem(GATE_SNOOZE_RESET_DATE_KEY, today);
      this.logger.debug('Gate', 'Daily snooze count reset');
    }
  }

  /**
   * 强制跳过大门（用于紧急情况）
   * 注意：这不会标记条目为已处理
   */
  forceBypass(): void {
    this.devForceActive.set(false);
    gateState.set('bypassed');
    localStorage.setItem(GATE_LAST_CHECK_DATE_KEY, getTodayDate());
    this.logger.warn('Gate', 'Gate force bypassed');
  }

  /** 重置大门状态（用于测试或用户重新触发） */
  reset(): void {
    this.devForceActive.set(false);
    this.showCompletionMessage.set(false);
    this.actionInFlight = null;
    this.clearAnimationTimeout();
    this.cardAnimation.set('idle');
    resetGateState();
    localStorage.removeItem(GATE_LAST_CHECK_DATE_KEY);
    this.logger.debug('Gate', 'Gate state reset');
  }

  /** 处理键盘快捷键 */
  handleKeydown(event: KeyboardEvent): boolean {
    if (!this.isActive()) return false;

    const key = event.key;
    const config = FOCUS_CONFIG.KEYBOARD;

    if ((config.GATE_MARK_READ as readonly string[]).includes(key)) {
      event.preventDefault();
      this.markAsRead();
      return true;
    }

    if ((config.GATE_MARK_COMPLETED as readonly string[]).includes(key)) {
      event.preventDefault();
      this.markAsCompleted();
      return true;
    }

    return false;
  }

  // ============================================
  // 开发环境测试方法
  // ============================================

  /**
   * [DEV] 强制显示大门（用于开发测试）
   * 创建模拟的待处理条目并激活大门
   */
  devForceShowGate(): void {
    this.devForceActive.set(true);
    localStorage.removeItem(GATE_LAST_CHECK_DATE_KEY);

    if (!focusPreferences().gateEnabled) {
      focusPreferences.update(p => ({ ...p, gateEnabled: true }));
      this.logger.info('Gate', '[DEV] Auto-enabled gateEnabled for testing');
    }

    const mockProjectId = crypto.randomUUID();
    const mockUserId = crypto.randomUUID();
    const mockEntries = [
      {
        id: crypto.randomUUID(),
        projectId: mockProjectId,
        userId: mockUserId,
        content: '这是一条测试遗留条目 - 先做A模块，然后连B数据库，不对，那个接口有问题，要先弄C...',
        date: this.getYesterdayDate(),
        createdAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
        updatedAt: new Date().toISOString(),
        isRead: false,
        isCompleted: false,
        isArchived: false,
        deletedAt: null,
        syncStatus: 'synced' as const,
        localCreatedAt: new Date().toISOString(),
        snoozeCount: 0,
        snoozeUntil: undefined
      },
      {
        id: crypto.randomUUID(),
        projectId: mockProjectId,
        userId: mockUserId,
        content: '第二条测试条目 - 需要修复支付接口的bug，客户反馈订单状态没有正确更新',
        date: this.getYesterdayDate(),
        createdAt: new Date(Date.now() - 23 * 60 * 60 * 1000).toISOString(),
        updatedAt: new Date().toISOString(),
        isRead: false,
        isCompleted: false,
        isArchived: false,
        deletedAt: null,
        syncStatus: 'synced' as const,
        localCreatedAt: new Date().toISOString(),
        snoozeCount: 1,
        snoozeUntil: undefined
      },
      {
        id: crypto.randomUUID(),
        projectId: mockProjectId,
        userId: mockUserId,
        content: '第三条 - 优化首页加载速度，现在太慢了',
        date: this.getYesterdayDate(),
        createdAt: new Date(Date.now() - 22 * 60 * 60 * 1000).toISOString(),
        updatedAt: new Date().toISOString(),
        isRead: false,
        isCompleted: false,
        isArchived: false,
        deletedAt: null,
        syncStatus: 'synced' as const,
        localCreatedAt: new Date().toISOString(),
        snoozeCount: 0,
        snoozeUntil: undefined
      }
    ];

    for (const entry of mockEntries) {
      updateBlackBoxEntry(entry);
    }

    gatePendingItems.set(mockEntries);
    gateCurrentIndex.set(0);
    gateSnoozeCount.set(0);
    gateState.set('reviewing');
    this.showCompletionMessage.set(false);
    this.actionInFlight = null;

    this.setCardAnimationWithTimeout('entering', () => this.onEnteringComplete());

    this.logger.info('Gate', '[DEV] Gate force shown with mock entries');
  }

  /** 获取昨天日期 */
  private getYesterdayDate(): string {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    return yesterday.toISOString().split('T')[0];
  }
}
