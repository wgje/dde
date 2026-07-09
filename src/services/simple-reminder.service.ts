/**
 * SimpleReminderService — 停泊任务提醒服务
 *
 * 策划案 A5.3 规范
 * 职责：定时提醒、Snooze、三阶段渐进消散
 *
 * ⚠️ 禁止恢复 Metronome 多级升级系统
 */

import { Injectable, Injector, effect, inject, signal, OnDestroy } from '@angular/core';
import { TaskStore, ProjectStore } from '../app/core/state/stores';
import { ParkingReminder, ParkingNotice } from '../models';
import { PARKING_CONFIG } from '../config/parking.config';
import { ParkingService } from './parking.service';
import { LoggerService } from './logger.service';
import { TaskOperationAdapterService } from './task-operation-adapter.service';

const REMINDER_CHECK_INTERVAL_MS = 30_000;

@Injectable({
  providedIn: 'root'
})
export class SimpleReminderService implements OnDestroy {
  private readonly injector = inject(Injector);
  private readonly taskStore = inject(TaskStore);
  private readonly projectStore = inject(ProjectStore);
  private readonly parkingService = inject(ParkingService);
  private readonly logger = inject(LoggerService);

  private get taskOpsAdapter(): TaskOperationAdapterService {
    return this.injector.get(TaskOperationAdapterService);
  }

  /** 活跃的提醒定时器 Map<taskId, timeoutId> */
  private readonly activeTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /** 当前显示的提醒通知 */
  readonly activeNotice = signal<ParkingNotice | null>(null);

  /** 检查间隔定时器 */
  private checkInterval: ReturnType<typeof setInterval> | null = null;

  private reminderCheckQueued = false;
  private destroyed = false;

  constructor() {
    effect(() => {
      const reminderSnapshot = this.taskStore.parkedTasks().map(task => ({
        taskId: task.id,
        reminderAt: task.parkingMeta?.reminder?.reminderAt ?? null,
        snoozeCount: task.parkingMeta?.reminder?.snoozeCount ?? null,
      }));
      void reminderSnapshot;
      this.queueReminderCheck();
    }, { injector: this.injector });

    this.checkReminders();
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    this.stopCheckInterval();
    for (const timer of this.activeTimers.values()) clearTimeout(timer);
    this.activeTimers.clear();
  }

  // ─── 对外 API ───

  /**
   * 设置提醒
   * @param taskId 任务 ID
   * @param reminderAt 提醒时间（ISO 字符串）
   */
  async setReminder(taskId: string, reminderAt: string): Promise<boolean> {
    if (this.destroyed) return false;

    const reminderTime = this.parseReminderTime(taskId, reminderAt);
    if (reminderTime === null) return false;

    // 验证时间必须是未来（P-22）
    if (reminderTime <= Date.now()) {
      this.logger.warn('SimpleReminderService', '请选择未来时间', { taskId, reminderAt });
      return false;
    }

    let task = this.taskStore.getTask(taskId);
    if (task && !task.parkingMeta) {
      const parked = await this.parkingService.parkTask(taskId);
      if (this.destroyed) return false;
      if (!parked) return false;
      task = this.taskStore.getTask(taskId);
    }
    if (!task?.parkingMeta) return false;

    const reminder: ParkingReminder = {
      reminderAt,
      snoozeCount: 0,
      maxSnoozeCount: PARKING_CONFIG.MAX_SNOOZE_COUNT,
    };

    const saved = await this.updateReminder(taskId, reminder);
    if (this.destroyed) return false;
    if (!saved) return false;
    this.scheduleTimer(taskId, reminderAt);
    this.startCheckInterval();
    return true;
  }

  /**
   * Snooze 提醒——延后到预设时间
   * 软上限 5 次后视觉弱化但不禁止继续
   */
  async snoozeReminder(taskId: string, presetKey: 'QUICK' | 'NORMAL' | 'TWO_HOURS_LATER'): Promise<boolean> {
    if (this.destroyed) return false;

    const task = this.taskStore.getTask(taskId);
    if (!task?.parkingMeta?.reminder) return false;

    const delay = PARKING_CONFIG.SNOOZE_PRESETS[presetKey];
    const newReminderAt = new Date(Date.now() + delay).toISOString();

    const reminder: ParkingReminder = {
      reminderAt: newReminderAt,
      snoozeCount: task.parkingMeta.reminder.snoozeCount + 1,
      maxSnoozeCount: PARKING_CONFIG.MAX_SNOOZE_COUNT,
    };

    const saved = await this.updateReminder(taskId, reminder);
    if (this.destroyed) return false;
    if (!saved) return false;
    this.scheduleTimer(taskId, newReminderAt);
    this.startCheckInterval();

    // 清除活跃通知
    if (this.activeNotice()?.taskId === taskId) {
      this.activeNotice.set(null);
    }

    // 清除红点
    this.parkingService.clearBadge(taskId);
    return true;
  }

  /**
   * 取消提醒——"忽略"语义（A5.3.3）
   * 任务保持停泊状态，reminder 置 null，可重新设置（snoozeCount 重置）
   */
  async cancelReminder(taskId: string): Promise<boolean> {
    if (this.destroyed) return false;

    const saved = await this.updateReminder(taskId, null);
    if (this.destroyed) return false;
    if (!saved) return false;

    // 取消定时器
    if (this.activeTimers.has(taskId)) {
      clearTimeout(this.activeTimers.get(taskId)!);
      this.activeTimers.delete(taskId);
    }
    this.syncCheckInterval(taskId);

    // 清除活跃通知
    if (this.activeNotice()?.taskId === taskId) {
      this.activeNotice.set(null);
    }

    // 清除红点
    this.parkingService.clearBadge(taskId);
    return true;
  }

  /**
   * 快速 snooze 方法（用于通知按钮）
   */
  snooze5m(taskId: string): Promise<boolean> {
    return this.snoozeReminder(taskId, 'QUICK');
  }

  snooze30m(taskId: string): Promise<boolean> {
    return this.snoozeReminder(taskId, 'NORMAL');
  }

  snooze2h(taskId: string): Promise<boolean> {
    return this.snoozeReminder(taskId, 'TWO_HOURS_LATER');
  }

  // ─── 提醒检查 ───

  private checkReminders(): void {
    if (this.destroyed) return;

    const now = Date.now();
    const parkedTasks = this.taskStore.parkedTasks();

    for (const task of parkedTasks) {
      if (!task.parkingMeta?.reminder) continue;

      const reminderTime = this.parseReminderTime(task.id, task.parkingMeta.reminder.reminderAt);
      if (reminderTime === null) continue;

      if (reminderTime <= now) {
        // 提醒到期
        this.triggerReminder(task.id, task.title, task.parkingMeta.reminder);
      } else if (!this.activeTimers.has(task.id)) {
        // 尚未到期但没有定时器，设置一个
        this.scheduleTimer(task.id, task.parkingMeta.reminder.reminderAt);
      }
    }

    this.syncCheckInterval();
  }

  private scheduleTimer(taskId: string, reminderAt: string): void {
    if (this.destroyed) return;

    // 取消已有定时器
    if (this.activeTimers.has(taskId)) {
      clearTimeout(this.activeTimers.get(taskId)!);
    }

    const reminderTime = this.parseReminderTime(taskId, reminderAt);
    if (reminderTime === null) {
      this.activeTimers.delete(taskId);
      return;
    }

    const delay = Math.max(0, reminderTime - Date.now());
    const timer = setTimeout(() => {
      if (this.destroyed) return;
      if (this.activeTimers.get(taskId) !== timer) return;

      const task = this.taskStore.getTask(taskId);
      const currentReminder = task?.parkingMeta?.reminder;
      if (currentReminder) {
        const currentReminderTime = this.parseReminderTime(taskId, currentReminder.reminderAt);
        if (currentReminderTime !== null && currentReminderTime > Date.now()) {
          this.scheduleTimer(taskId, currentReminder.reminderAt);
          this.syncCheckInterval();
          return;
        }
        if (currentReminderTime !== null) {
          this.triggerReminder(taskId, task.title, currentReminder);
        }
      }
      if (this.activeTimers.get(taskId) === timer) {
        this.activeTimers.delete(taskId);
      }
      this.syncCheckInterval();
    }, delay);

    this.activeTimers.set(taskId, timer);
  }

  /**
   * 触发提醒通知——三阶段渐进消散（A6.3）
   */
  private triggerReminder(taskId: string, title: string, reminder: ParkingReminder): void {
    if (this.destroyed) return;

    const currentNotice = this.activeNotice();
    if (currentNotice?.type === 'reminder' && currentNotice.taskId === taskId) return;

    // 单活跃通知规则：另一条提醒还在展示时不得同 tick 顶替——否则被顶掉的提醒
    // 永远不会渲染也不会留下淡出徽标（静默饿死），而顶替者的通知周期被反复重置。
    // 被延后的提醒仍处于到期状态，会在当前通知解决后的下一轮检查中触发
    if (currentNotice?.type === 'reminder' && currentNotice.taskId !== taskId) return;

    const isOverSoftLimit = reminder.snoozeCount >= PARKING_CONFIG.MAX_SNOOZE_COUNT;

    const notice: ParkingNotice = {
      id: crypto.randomUUID(),
      type: 'reminder',
      taskId,
      taskTitle: title,
      minVisibleMs: PARKING_CONFIG.REMINDER_IMMUNE_MS,
      fallbackTimeoutMs: PARKING_CONFIG.NOTICE_FALLBACK_TIMEOUT_MS,
      actions: [
        { key: 'start-work', label: '切换过去' },
        { key: 'snooze-5m', label: '5分钟' },
        { key: 'snooze-30m', label: '30分钟' },
        { key: 'snooze-2h-later', label: '2小时后' },
        { key: 'ignore', label: isOverSoftLimit ? '忽略（已延后' + reminder.snoozeCount + '次）' : '忽略' },
      ],
    };

    this.activeNotice.set(notice);
  }

  /**
   * 通知被兜底淡出时调用
   */
  handleNoticeFadeout(taskId: string): void {
    this.parkingService.recordReminderFadeout(taskId);
    this.activeNotice.set(null);
  }

  /**
   * 清除当前活跃通知（外部组件不可直接操作 activeNotice signal）
   */
  clearActiveNotice(): void {
    this.activeNotice.set(null);
  }

  // ─── 内部辅助 ───

  private updateReminder(taskId: string, reminder: ParkingReminder | null): Promise<boolean> {
    const task = this.taskStore.getTask(taskId);
    if (!task?.parkingMeta) return Promise.resolve(false);

    const projectId = this.findProjectId(taskId);
    if (!projectId) return Promise.resolve(false);

    return this.taskOpsAdapter.updateTaskParkingMeta(taskId, {
      ...task.parkingMeta,
      reminder,
    });
  }

  private findProjectId(taskId: string): string | null {
    return this.taskStore.getTaskProjectId(taskId)
      ?? this.projectStore.activeProjectId()
      ?? null;
  }

  private parseReminderTime(taskId: string, reminderAt: string): number | null {
    const reminderTime = new Date(reminderAt).getTime();
    if (!Number.isFinite(reminderTime)) {
      this.logger.warn('SimpleReminderService', '提醒时间无效', { taskId, reminderAt });
      return null;
    }

    return reminderTime;
  }

  private startCheckInterval(): void {
    if (this.destroyed) return;
    if (this.checkInterval !== null) return;
    this.checkInterval = setInterval(() => this.checkReminders(), REMINDER_CHECK_INTERVAL_MS);
  }

  private stopCheckInterval(): void {
    if (this.checkInterval === null) return;
    clearInterval(this.checkInterval);
    this.checkInterval = null;
  }

  private syncCheckInterval(excludeTaskId?: string): void {
    if (this.activeTimers.size > 0 || this.hasStoredReminder(excludeTaskId)) {
      this.startCheckInterval();
    } else {
      this.stopCheckInterval();
    }
  }

  private hasStoredReminder(excludeTaskId?: string): boolean {
    return this.taskStore.parkedTasks().some(task => {
      if (task.id === excludeTaskId) return false;
      const reminderAt = task.parkingMeta?.reminder?.reminderAt;
      return typeof reminderAt === 'string' && Number.isFinite(new Date(reminderAt).getTime());
    });
  }

  private queueReminderCheck(): void {
    if (this.destroyed || this.reminderCheckQueued) return;
    this.reminderCheckQueued = true;
    Promise.resolve().then(() => {
      this.reminderCheckQueued = false;
      if (!this.destroyed) this.checkReminders();
    });
  }
}
