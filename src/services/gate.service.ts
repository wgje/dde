/**
 * 大门服务
 * 
 * 负责大门机制的状态管理和交互逻辑
 * 每日首次打开应用时，强制处理昨日遗留条目
 */

import { Injectable, inject, signal } from '@angular/core';
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
} from '../app/core/state/focus-stores';

interface OperationError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

/** LocalStorage 键：上次大门检查日期 */
const GATE_LAST_CHECK_DATE_KEY = 'focus_gate_last_check_date';
/** LocalStorage 键：当日跳过次数重置日期 */
const GATE_SNOOZE_RESET_DATE_KEY = 'focus_gate_snooze_reset_date';

@Injectable({
  providedIn: 'root'
})
export class GateService {
  private blackBoxService = inject(BlackBoxService);
  private preferenceService = inject(PreferenceService);
  private logger = inject(LoggerService);
  
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
  
  /**
   * 检测用户是否启用了减少动画（prefers-reduced-motion）
   * 当启用时，CSS 动画被禁用，需要跳过动画状态直接进入 idle
   */
  private readonly prefersReducedMotion = 
    typeof window !== 'undefined' && 
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  
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
      
      // 【Bug Fix】检测用户是否启用了减少动画偏好
      // 当 prefers-reduced-motion: reduce 时，CSS 动画被禁用
      // 导致 animationend 事件永远不触发，cardAnimation 卡在 'entering'
      // 此时按钮会被永久禁用。解决方案：直接设置为 'idle' 跳过动画
      if (this.prefersReducedMotion) {
        this.cardAnimation.set('idle');
        this.logger.debug('Gate', 'Reduced motion detected, skipping entry animation');
      } else {
        this.cardAnimation.set('entering');
      }
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
   * 【Bug Fix】当用户启用减少动画时，直接调用完成回调而不等待动画
   */
  private nextEntry(): void {
    if (this.prefersReducedMotion) {
      // 减少动画模式：直接执行状态切换，不触发动画
      this.onSinkingComplete();
    } else {
      // 正常模式：触发下沉动画，后续逻辑由 animationend 事件驱动
      this.cardAnimation.set('sinking');
    }
  }
  
  /**
   * 入场动画完成回调
   * 由 GateCardComponent 的 animationend 事件触发
   */
  onEnteringComplete(): void {
    this.cardAnimation.set('idle');
  }
  
  /**
   * 下沉动画完成回调
   * 由 GateCardComponent 的 animationend 事件触发
   * 
   * 【Bug Fix】当用户启用减少动画时，直接切换到下一条目不触发浮现动画
   */
  onSinkingComplete(): void {
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
      
      // 【Bug Fix】减少动画模式：直接设置 idle，不触发浮现动画
      if (this.prefersReducedMotion) {
        this.cardAnimation.set('idle');
      } else {
        this.cardAnimation.set('emerging');
      }
    }
  }
  
  /**
   * 浮现动画完成回调
   * 由 GateCardComponent 的 animationend 事件触发
   */
  onEmergingComplete(): void {
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
    
    // 稍后提醒
    if ((config.GATE_SNOOZE as readonly string[]).includes(key)) {
      event.preventDefault();
      this.snooze();
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
