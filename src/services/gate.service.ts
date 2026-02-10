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
import { PreferenceService } from './preference.service';
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
const ANIMATION_TIMEOUT_MS = 1000;

@Injectable({
  providedIn: 'root'
})
export class GateService {
  private blackBoxService = inject(BlackBoxService);
  private preferenceService = inject(PreferenceService);
  private logger = inject(LoggerService);
  private ngZone = inject(NgZone);
  
  // 暴露状态给组件
  readonly state = gateState;
  readonly pendingItems = gatePendingItems;
  readonly currentIndex = gateCurrentIndex;
  readonly snoozeCount = gateSnoozeCount;
  readonly currentEntry = gateCurrentEntry;
  readonly progress = gateProgress;
  readonly canSnooze = canSnooze;
  
  // 卡片动画状态：entering=首次入场, sinking=下沉, emerging=浮现, idle=静止
  readonly cardAnimation = signal<'idle' | 'entering' | 'sinking' | 'emerging'>('idle');
  
  // 是否显示完成提示
  readonly showCompletionMessage = signal<boolean>(false);
  
  /**
   * 大门是否激活（正在审查条目）
   */
  readonly isActive = isGateActive;
  
  /** 动画超时定时器 - 用于防止动画卡死 */
  private animationTimeoutId: ReturnType<typeof setTimeout> | null = null;
  
  /**
   * 检测用户是否启用了减少动画（prefers-reduced-motion）
   * 使用响应式 signal 支持运行时变化
   * 
   * 【Bug Fix】之前是一个只读属性，在构造时检测一次
   * 现在改为 signal 并监听 matchMedia 变化事件
   */
  private readonly prefersReducedMotionSignal = signal<boolean>(
    typeof window !== 'undefined' && 
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  );
  
  /**
   * 向后兼容的只读访问器
   */
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
    
    // 监听变化
    mediaQuery.addEventListener('change', (e) => {
      this.prefersReducedMotionSignal.set(e.matches);
      this.logger.debug('Gate', `prefers-reduced-motion changed to: ${e.matches}`);
      
      // 如果当前在动画状态且启用了减少动画，立即切换到 idle
      if (e.matches && this.cardAnimation() !== 'idle') {
        this.logger.info('Gate', 'Reduced motion enabled, forcing idle state');
        this.cardAnimation.set('idle');
        this.clearAnimationTimeout();
      }
    });
  }
  
  /**
   * 设置动画状态并启动超时保护
   * 
   * 【Bug Fix】防止动画因任何原因（如 CSS 被禁用、事件未触发）卡死
   * 超时后自动恢复到 idle 状态，确保按钮可点击
   * 
   * 【Bug Fix】使用 NgZone.run() 包装超时回调，确保在 Angular 区域内执行，
   * 正确触发 OnPush 组件的变更检测
   */
  private setCardAnimationWithTimeout(
    state: 'idle' | 'entering' | 'sinking' | 'emerging'
  ): void {
    // 清除之前的超时
    this.clearAnimationTimeout();
    
    // 如果用户启用了减少动画，直接设置 idle
    if (state !== 'idle' && this.prefersReducedMotion) {
      this.cardAnimation.set('idle');
      this.logger.debug('Gate', `Reduced motion: skipping animation state '${state}'`);
      return;
    }
    
    this.cardAnimation.set(state);
    
    // 非 idle 状态设置超时保护
    if (state !== 'idle') {
      this.animationTimeoutId = setTimeout(() => {
        // 使用 NgZone.run() 确保在 Angular 区域内执行，正确触发变更检测
        this.ngZone.run(() => {
          if (this.cardAnimation() === state) {
            this.logger.warn('Gate', `Animation timeout (${ANIMATION_TIMEOUT_MS}ms), forcing idle from '${state}'`);
            this.cardAnimation.set('idle');
            
            // 如果是 sinking 状态超时，需要完成状态切换
            if (state === 'sinking') {
              this.onSinkingComplete();
            }
          }
        });
      }, ANIMATION_TIMEOUT_MS);
    }
  }
  
  /**
   * 清除动画超时定时器
   */
  private clearAnimationTimeout(): void {
    if (this.animationTimeoutId) {
      clearTimeout(this.animationTimeoutId);
      this.animationTimeoutId = null;
    }
  }
  
  /**
   * 检查是否需要显示大门
   * 在应用启动时调用
   */
  checkGate(): void {
    const preferences = focusPreferences();
    
    // 检查用户是否禁用了大门
    if (!preferences.gateEnabled) {
      gateState.set('disabled');
      this.logger.debug('Gate', 'Gate disabled by user preference');
      return;
    }
    
    // 重置每日跳过次数
    this.resetDailySnoozeCount();
    
    // 获取待处理条目（未读 + 未完成 + 未归档 + 未删除 + snoozeUntil 未到期）
    const pending = pendingBlackBoxEntries();
    
    if (pending.length > 0) {
      // 只要有待处理条目，就显示大门
      gatePendingItems.set(pending);
      gateCurrentIndex.set(0);
      gateState.set('reviewing');
      
      // 使用带超时保护的动画状态设置
      // 这会自动处理 prefers-reduced-motion 情况
      this.setCardAnimationWithTimeout('entering');
      this.logger.info('Gate', `Gate activated with ${pending.length} pending items`);
    } else {
      // 没有待处理条目，跳过大门
      gateState.set('bypassed');
      this.logger.debug('Gate', 'No pending items, gate bypassed');
    }
  }
  
  /**
   * 标记当前条目为已读
   */
  markAsRead(): Result<void, OperationError> {
    const current = this.getCurrentEntry();
    if (!current) {
      return failure(ErrorCodes.FOCUS_ENTRY_NOT_FOUND, '当前没有待处理条目');
    }
    
    const result = this.blackBoxService.markAsRead(current.id);
    if (result.ok) {
      this.nextEntry();
    }
    
    return success(undefined);
  }
  
  /**
   * 标记当前条目为完成
   */
  markAsCompleted(): Result<void, OperationError> {
    const current = this.getCurrentEntry();
    if (!current) {
      return failure(ErrorCodes.FOCUS_ENTRY_NOT_FOUND, '当前没有待处理条目');
    }
    
    const result = this.blackBoxService.markAsCompleted(current.id);
    if (result.ok) {
      this.nextEntry();
    }
    
    return success(undefined);
  }
  
  /**
   * 跳过当前条目（稍后提醒）
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
      this.nextEntry();
    }
    
    return success(undefined);
  }
  
  /**
   * 切换到下一个条目（触发下沉动画）
   * 动画完成后由 onSinkingComplete() 处理状态切换
   * 
   * 使用带超时保护的动画设置，确保即使动画卡死也能恢复
   */
  private nextEntry(): void {
    // 使用带超时保护的动画设置
    // 如果是减少动画模式，会自动设置为 idle 并跳过动画
    this.setCardAnimationWithTimeout('sinking');
    
    // 如果减少动画模式，setCardAnimationWithTimeout 已设置 idle
    // 需要手动触发状态切换
    if (this.prefersReducedMotion) {
      this.onSinkingComplete();
    }
  }
  
  /**
   * 入场动画完成回调
   * 由 GateCardComponent 的 animationend 事件触发
   */
  onEnteringComplete(): void {
    this.clearAnimationTimeout();
    this.cardAnimation.set('idle');
  }
  
  /**
   * 下沉动画完成回调
   * 由 GateCardComponent 的 animationend 事件触发
   */
  onSinkingComplete(): void {
    this.clearAnimationTimeout();
    
    const nextIndex = gateCurrentIndex() + 1;
    const total = gatePendingItems().length;
    
    if (nextIndex >= total) {
      // 全部处理完毕 - 显示完成提示
      gateState.set('completed');
      this.showCompletionMessage.set(true);
      this.cardAnimation.set('idle');
      
      this.logger.info('Gate', 'Gate completed, all items processed');
      
      // 1.5秒后隐藏完成提示
      setTimeout(() => {
        this.showCompletionMessage.set(false);
      }, 1500);
    } else {
      // 切换到下一个条目
      gateCurrentIndex.set(nextIndex);
      
      // 使用带超时保护的动画设置
      this.setCardAnimationWithTimeout('emerging');
    }
  }
  
  /**
   * 浮现动画完成回调
   * 由 GateCardComponent 的 animationend 事件触发
   */
  onEmergingComplete(): void {
    this.clearAnimationTimeout();
    this.cardAnimation.set('idle');
  }
  
  /**
   * 获取当前条目
   */
  getCurrentEntry(): BlackBoxEntry | null {
    const items = gatePendingItems();
    const index = gateCurrentIndex();
    return items[index] ?? null;
  }
  
  /**
   * 重置每日跳过次数
   */
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
    gateState.set('bypassed');
    localStorage.setItem(GATE_LAST_CHECK_DATE_KEY, getTodayDate());
    this.logger.warn('Gate', 'Gate force bypassed');
  }
  
  /**
   * 重置大门状态（用于测试或用户重新触发）
   */
  reset(): void {
    resetGateState();
    localStorage.removeItem(GATE_LAST_CHECK_DATE_KEY);
    this.logger.debug('Gate', 'Gate state reset');
  }
  
  /**
   * 处理键盘快捷键
   */
  handleKeydown(event: KeyboardEvent): boolean {
    if (!this.isActive()) return false;
    
    const key = event.key;
    const config = FOCUS_CONFIG.KEYBOARD;
    
    // 标记已读
    if ((config.GATE_MARK_READ as readonly string[]).includes(key)) {
      event.preventDefault();
      this.markAsRead();
      return true;
    }
    
    // 标记完成
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
    // 清除今日检查记录
    localStorage.removeItem(GATE_LAST_CHECK_DATE_KEY);
    
    // 创建模拟的待处理条目
    const mockEntries = [
      {
        id: crypto.randomUUID(),
        projectId: 'dev-test',
        userId: 'dev-user',
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
        projectId: 'dev-test',
        userId: 'dev-user',
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
        projectId: 'dev-test',
        userId: 'dev-user',
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
    
    // 设置待处理条目并激活大门
    // 1. 先将模拟条目存入 blackBoxEntriesMap（这样按钮操作才能找到条目）
    for (const entry of mockEntries) {
      updateBlackBoxEntry(entry);
    }
    
    // 2. 设置大门待处理列表
    gatePendingItems.set(mockEntries);
    gateCurrentIndex.set(0);
    gateSnoozeCount.set(0);
    gateState.set('reviewing');
    
    // 3. 设置动画状态（与正常流程一致）
    this.setCardAnimationWithTimeout('entering');
    
    this.logger.info('Gate', '[DEV] Gate force shown with mock entries');
  }
  
  /**
   * 获取昨天日期
   */
  private getYesterdayDate(): string {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    return yesterday.toISOString().split('T')[0];
  }
}
