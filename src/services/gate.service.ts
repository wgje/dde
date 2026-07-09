/**
 * 大门服务
 *
 * 负责大门机制的状态管理和交互逻辑
 * 每日首次打开应用时，强制处理昨日遗留条目
 */

import { Injectable, inject, signal, NgZone, effect, DestroyRef } from '@angular/core';
import { BlackBoxEntry } from '../models/focus';
import { Result, success, failure, ErrorCodes, ErrorMessages } from '../utils/result';
import { FOCUS_CONFIG } from '../config/focus.config';
import { SYNC_CONFIG } from '../config/sync.config';
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
  refreshGateReviewClock,
  focusPreferences,
  resetGateState,
  getTomorrowDate,
  updateBlackBoxEntry
} from '../state/focus-stores';
import {
  buildNextReviewingQueue,
  type GateReviewQueueRefreshSource,
  isSameGateQueue,
  type RemoteEmptyQueueState,
  resolveRemoteEmptyQueueState,
} from './gate-review-queue.helpers';
import { GateAnimationController, type GateMotionState } from './gate-animation.controller';
import { GateDeferredMutationController } from './gate-deferred-mutation.controller';
import { createDevGateMockEntries } from './gate-dev-mock.helpers';
import {
  clearGateHandledToday,
  isGateHandledToday,
  persistGateHandledToday,
  resetDailyGateSnoozeCount,
} from './gate-storage.helpers';

interface OperationError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

interface CheckGateOptions {
  ignoreHandledToday?: boolean;
}

const GATE_REVIEW_SYNC_INTERVAL_MS = Math.max(30_000, SYNC_CONFIG.BLACKBOX_PULL_FRESHNESS_WINDOW);

@Injectable({
  providedIn: 'root'
})
export class GateService {
  private readonly blackBoxService = inject(BlackBoxService);
  private readonly logger = inject(LoggerService);
  private readonly ngZone = inject(NgZone);
  private readonly destroyRef = inject(DestroyRef);

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

  /** 动画两阶段超时保护 - 用于防止动画卡死 */
  private readonly animationController = new GateAnimationController({
    getAnimation: () => this.cardAnimation(),
    setAnimation: state => this.cardAnimation.set(state),
    prefersReducedMotion: () => this.prefersReducedMotion,
    run: callback => this.ngZone.run(callback),
    debug: message => this.logger.debug('Gate', message),
    warn: message => this.logger.warn('Gate', message),
  });
  private readonly deferredMutationController = new GateDeferredMutationController({
    blackBoxService: this.blackBoxService,
    logger: this.logger,
  });

  /** 当前动作动画（用于防止 timeout + animationend 双触发） */
  private actionInFlight: 'heave_read' | 'heavy_drop' | null = null;
  private reviewSyncTimerId: ReturnType<typeof setInterval> | null = null;
  private reviewSyncInFlight = false;
  private remoteEmptyQueueConfirmations = 0;
  /** 【修复 L-21/M-08】matchMedia 监听器引用，用于销毁时移除 */
  private reducedMotionMediaQuery: MediaQueryList | null = null;
  private reducedMotionHandler: ((e: MediaQueryListEvent) => void) | null = null;
  private reviewVisibilityHandler: (() => void) | null = null;

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
    this.setupLivePendingEntrySync();

    // 【修复 M-13】DestroyRef 清理：停止 reviewSync 定时器和移除 matchMedia 监听器
    this.destroyRef.onDestroy(() => {
      this.stopReviewingRemoteSync();
      this.clearAnimationTimeout();
      if (this.reducedMotionMediaQuery && this.reducedMotionHandler) {
        this.reducedMotionMediaQuery.removeEventListener('change', this.reducedMotionHandler);
        this.reducedMotionMediaQuery = null;
        this.reducedMotionHandler = null;
      }
      if (typeof document !== 'undefined' && this.reviewVisibilityHandler) {
        document.removeEventListener('visibilitychange', this.reviewVisibilityHandler);
        this.reviewVisibilityHandler = null;
      }
    });
  }

  private setupLivePendingEntrySync(): void {
    if (typeof document !== 'undefined' && !this.reviewVisibilityHandler) {
      this.reviewVisibilityHandler = () => {
        if (document.visibilityState === 'visible' && gateState() === 'reviewing') {
          this.refreshReviewingQueueFromRemote(true);
        }
      };
      document.addEventListener('visibilitychange', this.reviewVisibilityHandler);
    }

    effect(() => {
      const state = gateState();
      const pending = pendingBlackBoxEntries();

      if (state !== 'reviewing') {
        this.stopReviewingRemoteSync();
        return;
      }

      this.syncReviewingQueueWithPending(pending, 'signal');
      this.ensureReviewingRemoteSync();
    });
  }

  private ensureReviewingRemoteSync(): void {
    if (typeof window === 'undefined') return;
    if (this.reviewSyncTimerId !== null) return;

    this.refreshReviewingQueueFromRemote(true);

    this.reviewSyncTimerId = setInterval(() => {
      if (gateState() !== 'reviewing') {
        this.stopReviewingRemoteSync();
        return;
      }

      this.refreshReviewingQueueFromRemote(true);
    }, GATE_REVIEW_SYNC_INTERVAL_MS);
  }

  private refreshReviewingQueueFromRemote(force = false): void {
    if (gateState() !== 'reviewing') {
      return;
    }

    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') {
      return;
    }

    if (this.reviewSyncInFlight) {
      return;
    }

    this.reviewSyncInFlight = true;
    const expectedUserId = this.blackBoxService.getExpectedSyncUserId() ?? undefined;

    this.blackBoxService.loadFromServer({ reason: 'gate-review', force, expectedUserId })
      .then(() => {
        this.ngZone.run(() => {
          if (gateState() !== 'reviewing') return;
          this.syncReviewingQueueWithPending(pendingBlackBoxEntries(), 'remote');
        });
      })
      .catch((error: unknown) => {
        this.logger.debug('Gate', 'Remote pull while gate reviewing failed', {
          error: error instanceof Error ? error.message : String(error)
        });
      })
      .finally(() => {
        this.reviewSyncInFlight = false;
      });
  }

  private stopReviewingRemoteSync(): void {
    if (this.reviewSyncTimerId !== null) {
      clearInterval(this.reviewSyncTimerId);
      this.reviewSyncTimerId = null;
    }
    this.reviewSyncInFlight = false;
  }

  private syncReviewingQueueWithPending(
    latestPending: BlackBoxEntry[],
    source: GateReviewQueueRefreshSource
  ): void {
    const currentItems = gatePendingItems();
    const safeIndex = this.normalizeGateCurrentIndex(currentItems.length);

    const remoteEmptyState = resolveRemoteEmptyQueueState({
      latestPendingLength: latestPending.length,
      source,
      safeIndex,
      currentLength: currentItems.length,
      hasLocalAction: !!this.actionInFlight || this.deferredMutationController.hasPending,
      remoteEmptyQueueConfirmations: this.remoteEmptyQueueConfirmations,
    });
    const nextItems = buildNextReviewingQueue({
      currentItems,
      latestPending,
      safeIndex,
      remoteEmptyState,
      hasActionInFlight: this.actionInFlight !== null,
    });

    if (!isSameGateQueue(currentItems, nextItems)) {
      gatePendingItems.set(nextItems);
      this.logQueueRefresh(source, currentItems.length, nextItems.length, safeIndex, remoteEmptyState);
    }

    this.updateRemoteEmptyConfirmations(latestPending, remoteEmptyState);

    // 仅当队列彻底空（没有保留项也没有未处理项）时才判定完成，
    // 避免在动画进行中因同步信号剔除导致的误判。
    // 【修复 2026-04-21】同时排除 deferredMutation：finalizeActionTransition 会先
    // 把 actionInFlight 置 null 再进入 settling 阶段，真正的 mark-read /
    // mark-completed 要等到 onSettlingComplete -> flushDeferredMutation 才落库。
    // 在这两步之间，远端 pull / BlackBox LWW 升级可能让 pendingBlackBoxEntries
    // 短暂归零，从而触发 queue-empty 误判，造成「大门瞬间消失」并把未提交的条目
    // 留在 pending 列表里，之后被其他路径重新唤起大门。
    if (
      nextItems.length === 0
      && !this.actionInFlight
      && !this.deferredMutationController.hasPending
    ) {
      this.completeGateSession('queue-empty');
    }
  }

  private normalizeGateCurrentIndex(currentLength: number): number {
    const currentIndex = gateCurrentIndex();
    const safeIndex = Math.min(Math.max(currentIndex, 0), currentLength);
    if (safeIndex !== currentIndex) gateCurrentIndex.set(safeIndex);
    return safeIndex;
  }

  private logQueueRefresh(
    source: GateReviewQueueRefreshSource,
    before: number,
    after: number,
    safeIndex: number,
    remoteEmptyState: RemoteEmptyQueueState,
  ): void {
    this.logger.debug('Gate', `Gate queue refreshed from ${source}`, {
      before,
      after,
      handled: safeIndex,
      currentPreserved: safeIndex < before
        && (this.actionInFlight !== null || remoteEmptyState.preserveCurrentDuringTransientEmpty),
      preserveCurrentDuringTransientEmpty: remoteEmptyState.preserveCurrentDuringTransientEmpty,
      firstRemoteEmptyProbe: remoteEmptyState.firstRemoteEmptyProbe,
      confirmedRemoteEmpty: remoteEmptyState.confirmedRemoteEmpty,
      remoteEmptyBlockedByLocalAction: remoteEmptyState.remoteEmptyBlockedByLocalAction,
      remoteEmptyConfirmations: this.remoteEmptyQueueConfirmations,
      inFlight: this.actionInFlight !== null
    });
  }

  private updateRemoteEmptyConfirmations(
    latestPending: BlackBoxEntry[],
    remoteEmptyState: RemoteEmptyQueueState,
  ): void {
    if (latestPending.length > 0) {
      this.remoteEmptyQueueConfirmations = 0;
    } else if (remoteEmptyState.firstRemoteEmptyProbe) {
      this.remoteEmptyQueueConfirmations += 1;
    }
  }

  private completeGateSession(reason: 'all-processed' | 'queue-empty'): void {
    gateState.set('completed');
    this.showCompletionMessage.set(true);
    this.cardAnimation.set('idle');
    this.actionInFlight = null;
    this.deferredMutationController.clear();
    this.remoteEmptyQueueConfirmations = 0;
    this.clearAnimationTimeout();
    this.stopReviewingRemoteSync();

    // 【根因修复 2026-05-09】标记今日大门已处理，避免后台闲置恢复时
    // FocusStartupProbe 的 local→remote 两阶段探针（或 pullChanges 带回的新 pending）
    // 让 checkGate() 重新进入 'reviewing' 状态而出现二次弹门。
    this.persistGateHandledToday();

    this.logger.info('Gate', `Gate completed (${reason})`);

    setTimeout(() => {
      this.showCompletionMessage.set(false);
    }, 1500);
  }

  /**
   * 监听 prefers-reduced-motion 变化
   * 当用户在运行时切换减少动画偏好时，立即响应
   */
  private setupReducedMotionListener(): void {
    if (typeof window === 'undefined') return;

    const mediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)');

    // 【修复 L-21/M-08】存储 mediaQuery 和 handler 引用，以便 DestroyRef 清理
    this.reducedMotionMediaQuery = mediaQuery;
    this.reducedMotionHandler = (e: MediaQueryListEvent) => {
      this.prefersReducedMotionSignal.set(e.matches);
      this.logger.debug('Gate', `prefers-reduced-motion changed to: ${e.matches}`);

      if (e.matches && this.cardAnimation() !== 'idle') {
        this.logger.info('Gate', 'Reduced motion enabled, forcing idle state');
        const currentAnimation = this.cardAnimation();

        if (currentAnimation === 'heave_read') {
          this.onHeaveReadComplete();
          return;
        }

        if (currentAnimation === 'heavy_drop') {
          this.onHeavyDropComplete();
          return;
        }

        if (currentAnimation === 'settling') {
          this.onSettlingComplete();
          return;
        }

        this.cardAnimation.set('idle');
        this.actionInFlight = null;
        this.clearAnimationTimeout();
      }
    };

    mediaQuery.addEventListener('change', this.reducedMotionHandler);
  }

  /**
   * 设置动画状态并启动两阶段超时保护
   * 
   * 阶段一：signal set → 等待 animationstart 在 ANIMATION_START_GRACE_MS 内触发。
   *         若超时，视为动画未实际启动（元素未渲染 / reduced motion CSS 介入等），
   *         直接切回 idle 并执行回调。
   * 阶段二：animationstart 触发后（由 GateCard 通过 onAnimationStart 通知），
   *         等待 animationend 在 ANIMATION_DURATION_MAX_MS 内触发。
   *         若超时，视为浏览器节流/丢事件，兜底切 idle。
   */
  private setCardAnimationWithTimeout(
    state: GateMotionState,
    onTimeout?: () => void
  ): void {
    this.animationController.setWithTimeout(state, onTimeout);
  }

  /**
   * GateCard 组件在真实 DOM animationstart 触发时调用。
   * 将超时计时从阶段一切换到阶段二（animationend 兜底）。
   */
  notifyAnimationStarted(state: GateMotionState): void {
    this.animationController.notifyStarted(state);
  }

  /** 清除动画超时定时器 */
  private clearAnimationTimeout(): void {
    this.animationController.clear();
  }

  /**
   * 检查是否需要显示大门
   * 在应用启动时调用
   */
  checkGate(options: CheckGateOptions = {}): void {
    refreshGateReviewClock();

    // 如果大门已经在审查中，不要重复初始化（避免动画叠加和状态重置）
    if (gateState() === 'reviewing') {
      this.syncReviewingQueueWithPending(pendingBlackBoxEntries(), 'checkGate');
      this.logger.debug('Gate', 'Gate already reviewing, queue refreshed');
      return;
    }

    // 【根因修复 2026-05-09】今日大门已处理（completeGateSession / forceBypass）则短路。
    // 避免后台闲置恢复时 FocusStartupProbe 的 local→remote 两阶段探针在用户刚审完
    // 之后再次把 gateState 推回 'reviewing'，出现"两次大门"。手机端和电脑端共享
    // 同一条 visibility/pageshow 恢复链路，因此修复一处即覆盖两端。
    if (!options.ignoreHandledToday && this.isGateHandledToday()) {
      // 短路时无论原状态是 'completed' / 'bypassed' / 其他都清掉缓存的 pendingItems，
      // 它们仅在 reviewing 期间用于显示，非激活态保留只会让外部观察到陈旧数据。
      gatePendingItems.set([]);
      gateCurrentIndex.set(0);
      if (gateState() !== 'completed' && gateState() !== 'bypassed') {
        gateState.set('bypassed');
      }
      this.logger.debug('Gate', 'Gate already handled today, skip re-check');
      return;
    }

    this.devForceActive.set(false);
    this.showCompletionMessage.set(false);
    this.actionInFlight = null;
    // 上一会话在确认动画窗口内被杀时，已读/完成/打盹决策仍在持久暂存里：
    // 先补写再继续（无暂存时等价于原来的 clear()），不得无条件清掉未提交决策
    void this.deferredMutationController.restorePersistedMutation();
    this.remoteEmptyQueueConfirmations = 0;

    const preferences = focusPreferences();

    if (!preferences.gateEnabled) {
      gatePendingItems.set([]);
      gateCurrentIndex.set(0);
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
      this.remoteEmptyQueueConfirmations = 0;
      this.setCardAnimationWithTimeout('entering', () => this.onEnteringComplete());
      this.logger.info('Gate', `Gate activated with ${pending.length} pending items`);
      return;
    }

    gatePendingItems.set([]);
    gateCurrentIndex.set(0);
    gateState.set('bypassed');
    this.logger.debug('Gate', 'No pending items, gate bypassed');
  }

  /** 标记当前条目为已读 */
  markAsRead(): Result<void, OperationError> {
    if (this.isActionLocked()) {
      return failure(ErrorCodes.OPERATION_FAILED, '动画处理中，请稍后');
    }

    const current = this.getCurrentEntry();
    if (!current) {
      return failure(ErrorCodes.FOCUS_ENTRY_NOT_FOUND, '当前没有待处理条目');
    }

    this.deferredMutationController.setMarkRead(current.id);
    this.startActionTransition('heave_read');
    return success(undefined);
  }

  /** 标记当前条目为完成 */
  markAsCompleted(): Result<void, OperationError> {
    if (this.isActionLocked()) {
      return failure(ErrorCodes.OPERATION_FAILED, '动画处理中，请稍后');
    }

    const current = this.getCurrentEntry();
    if (!current) {
      return failure(ErrorCodes.FOCUS_ENTRY_NOT_FOUND, '当前没有待处理条目');
    }

    this.deferredMutationController.setMarkCompleted(current.id);
    this.startActionTransition('heavy_drop');
    return success(undefined);
  }

  /**
   * 跳过当前条目（稍后提醒）
   * 兼容保留：UI 已隐藏此动作
   */
  snooze(): Result<void, OperationError> {
    if (this.isActionLocked()) {
      return failure(ErrorCodes.OPERATION_FAILED, '动画处理中，请稍后');
    }

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
    this.deferredMutationController.setSnooze(current.id, tomorrow);
    gateSnoozeCount.update(c => c + 1);

    // 兼容路径：在新门体里统一使用 heave_read 过渡
    this.startActionTransition('heave_read');

    return success(undefined);
  }

  /**
   * 启动动作动画并在结束后推进到下一条
   */
  private startActionTransition(state: 'heave_read' | 'heavy_drop'): void {
    this.remoteEmptyQueueConfirmations = 0;
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

    void this.flushDeferredMutationAndAdvance(state);
  }

  private async flushDeferredMutationAndAdvance(state: 'heave_read' | 'heavy_drop'): Promise<void> {
    const result = await this.deferredMutationController.flush();
    if (!result.ok) {
      this.handleDeferredMutationFailure(state, result.error);
      return;
    }

    const nextIndex = gateCurrentIndex() + 1;
    const total = gatePendingItems().length;

    if (nextIndex >= total) {
      this.completeGateSession('all-processed');
      return;
    }

    gateCurrentIndex.set(nextIndex);
    this.setCardAnimationWithTimeout('settling', () => this.onSettlingComplete());
  }

  private handleDeferredMutationFailure(
    state: 'heave_read' | 'heavy_drop',
    error: OperationError,
  ): void {
    this.logger.warn('Gate', 'Deferred gate mutation persistence failed; keeping current card reviewable', {
      state,
      message: error.message,
      details: error.details,
    });
    this.deferredMutationController.clear();
    this.cardAnimation.set('idle');
    this.actionInFlight = null;
    this.remoteEmptyQueueConfirmations = 0;
  }

  /** 入场动画完成回调 */
  onEnteringComplete(): void {
    if (this.cardAnimation() !== 'entering') return;
    this.clearAnimationTimeout();
    this.cardAnimation.set('idle');
  }

  /** 已读抛掷动画完成回调 */
  onHeaveReadComplete(): void {
    // 【修复 P2-02】修正逻辑运算符：reducedMotion 启用时应放行而非拦截
    if (this.cardAnimation() !== 'heave_read' && !this.prefersReducedMotion) return;
    this.finalizeActionTransition('heave_read');
  }

  /** 完成重落动画完成回调 */
  onHeavyDropComplete(): void {
    // 【修复 P2-02】同上
    if (this.cardAnimation() !== 'heavy_drop' && !this.prefersReducedMotion) return;
    this.finalizeActionTransition('heavy_drop');
  }

  /** 新条目沉降动画完成回调 */
  onSettlingComplete(): void {
    if (this.cardAnimation() !== 'settling' && !this.prefersReducedMotion) return;
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
    resetDailyGateSnoozeCount(this.logger);
  }

  /**
   * 今日大门是否已经被处理过（completeGateSession 或 forceBypass）
   * 用于阻止后台恢复链路里 local→remote 两次 checkGate 造成的二次弹门
   */
  private isGateHandledToday(): boolean {
    return isGateHandledToday(this.logger);
  }

  /** 标记今日大门已处理 */
  private persistGateHandledToday(): void {
    persistGateHandledToday(this.logger);
  }

  /**
   * 强制跳过大门（用于紧急情况）
   * 注意：这不会标记条目为已处理
   */
  forceBypass(): void {
    this.devForceActive.set(false);
    this.deferredMutationController.clear();
    this.remoteEmptyQueueConfirmations = 0;
    this.stopReviewingRemoteSync();
    gateState.set('bypassed');
    this.persistGateHandledToday();
    this.logger.warn('Gate', 'Gate force bypassed');
  }

  /** 重置大门状态（用于测试或用户重新触发） */
  reset(): void {
    this.devForceActive.set(false);
    this.showCompletionMessage.set(false);
    this.actionInFlight = null;
    this.deferredMutationController.clear();
    this.remoteEmptyQueueConfirmations = 0;
    this.stopReviewingRemoteSync();
    this.clearAnimationTimeout();
    this.cardAnimation.set('idle');
    resetGateState();
    clearGateHandledToday();
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
    this.prepareDevGate();
    const mockEntries = createDevGateMockEntries();

    for (const entry of mockEntries) {
      updateBlackBoxEntry(entry);
    }

    this.activateDevGate(mockEntries);
    this.logger.info('Gate', '[DEV] Gate force shown with mock entries');
  }

  private prepareDevGate(): void {
    this.devForceActive.set(true);
    this.stopReviewingRemoteSync();
    clearGateHandledToday();

    if (!focusPreferences().gateEnabled) {
      focusPreferences.update(p => ({ ...p, gateEnabled: true }));
      this.logger.info('Gate', '[DEV] Auto-enabled gateEnabled for testing');
    }
  }

  private activateDevGate(mockEntries: BlackBoxEntry[]): void {
    gatePendingItems.set(mockEntries);
    gateCurrentIndex.set(0);
    gateSnoozeCount.set(0);
    gateState.set('reviewing');
    this.showCompletionMessage.set(false);
    this.actionInFlight = null;
    this.deferredMutationController.clear();

    this.setCardAnimationWithTimeout('entering', () => this.onEnteringComplete());
  }

  /** 动画/延迟提交进行中时锁定新动作，避免覆盖 deferred mutation */
  private isActionLocked(): boolean {
    return this.cardAnimation() !== 'idle'
      || this.actionInFlight !== null
      || this.deferredMutationController.hasPending;
  }
}
