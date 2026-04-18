/**
 * SimpleReminderService — 停泊任务提醒服务
 *
 * 策划案 A5.3 规范
 * 职责：定时提醒、Snooze、三阶段渐进消散
 *
 * ⚠️ 禁止恢复 Metronome 多级升级系统
 */

import { Injectable, inject, signal, OnDestroy } from '@angular/core';
import { TaskStore, ProjectStore } from '../app/core/state/stores';
import { ParkingReminder, ParkingNotice } from '../models';
import { PARKING_CONFIG } from '../config/parking.config';
import { ParkingService } from './parking.service';
import { LoggerService } from './logger.service';

@Injectable({
  providedIn: 'root'
})
export class SimpleReminderService implements OnDestroy {
  private readonly taskStore = inject(TaskStore);
  private readonly projectStore = inject(ProjectStore);
  private readonly parkingService = inject(ParkingService);
  private readonly logger = inject(LoggerService);

  /** 活跃的提醒定时器 Map<taskId, timeoutId> */
  private readonly activeTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /** 当前显示的提醒通知 */
  readonly activeNotice = signal<ParkingNotice | null>(null);

  /** 检查间隔定时器 */
  private checkInterval: ReturnType<typeof setInterval> | null = null;

  constructor() {
    // 每 30s 检查一次是否有提醒到期
    // TODO(L-26): 优化机会 — 当无活跃提醒时可暂停此间隔，在 setReminder() 中按需恢复
    this.checkInterval = setInterval(() => this.checkReminders(), 30_000);
    // 立即检查一次
    this.checkReminders();
  }

  ngOnDestroy(): void {
    if (this.checkInterval) clearInterval(this.checkInterval);
    for (const timer of this.activeTimers.values()) clearTimeout(timer);
    this.activeTimers.clear();
  }

  // ─── 对外 API ───

  /**
   * 设置提醒
   * @param taskId 任务 ID
   * @param reminderAt 提醒时间（ISO 字符串）
   */
  setReminder(taskId: string, reminderAt: string): void {
    // 验证时间必须是未来（P-22）
    if (new Date(reminderAt).getTime() <= Date.now()) {
      this.logger.warn('SimpleReminderService', '请选择未来时间', { taskId, reminderAt });
      return;
    }

    let task = this.taskStore.getTask(taskId);
    if (task && !task.parkingMeta) {
      this.parkingService.parkTask(taskId);
      task = this.taskStore.getTask(taskId);
    }
    if (!task?.parkingMeta) return;

    const reminder: ParkingReminder = {
      reminderAt,
      snoozeCount: 0,
      maxSnoozeCount: PARKING_CONFIG.MAX_SNOOZE_COUNT,
    };

    this.updateReminder(taskId, reminder);
    this.scheduleTimer(taskId, reminderAt);
  }

  /**
   * Snooze 提醒——延后到预设时间
   * 软上限 5 次后视觉弱化但不禁止继续
   */
  snoozeReminder(taskId: string, presetKey: 'QUICK' | 'NORMAL' | 'TWO_HOURS_LATER'): void {
    const task = this.taskStore.getTask(taskId);
    if (!task?.parkingMeta?.reminder) return;

    const delay = PARKING_CONFIG.SNOOZE_PRESETS[presetKey];
    const newReminderAt = new Date(Date.now() + delay).toISOString();

    const reminder: ParkingReminder = {
      reminderAt: newReminderAt,
      snoozeCount: task.parkingMeta.reminder.snoozeCount + 1,
      maxSnoozeCount: PARKING_CONFIG.MAX_SNOOZE_COUNT,
    };

    this.updateReminder(taskId, reminder);
    this.scheduleTimer(taskId, newReminderAt);

    // 清除活跃通知
    if (this.activeNotice()?.taskId === taskId) {
      this.activeNotice.set(null);
    }

    // 清除红点
    this.parkingService.clearBadge(taskId);
  }

  /**
   * 取消提醒——"忽略"语义（A5.3.3）
   * 任务保持停泊状态，reminder 置 null，可重新设置（snoozeCount 重置）
   */
  cancelReminder(taskId: string): void {
    this.updateReminder(taskId, null);

    // 取消定时器
    const timer = this.activeTimers.get(taskId);
    if (timer) {
      clearTimeout(timer);
      this.activeTimers.delete(taskId);
    }

    // 清除活跃通知
    if (this.activeNotice()?.taskId === taskId) {
      this.activeNotice.set(null);
    }

    // 清除红点
    this.parkingService.clearBadge(taskId);
  }

  /**
   * 快速 snooze 方法（用于通知按钮）
   */
  snooze5m(taskId: string): void {
    this.snoozeReminder(taskId, 'QUICK');
  }

  snooze30m(taskId: string): void {
    this.snoozeReminder(taskId, 'NORMAL');
  }

  snooze2h(taskId: string): void {
    this.snoozeReminder(taskId, 'TWO_HOURS_LATER');
  }

  // ─── 提醒检查 ───

  private checkReminders(): void {
    const now = Date.now();
    const parkedTasks = this.taskStore.parkedTasks();

    for (const task of parkedTasks) {
      if (!task.parkingMeta?.reminder) continue;

      const reminderTime = new Date(task.parkingMeta.reminder.reminderAt).getTime();
      if (reminderTime <= now) {
        // 提醒到期
        this.triggerReminder(task.id, task.title, task.parkingMeta.reminder);
      } else if (!this.activeTimers.has(task.id)) {
        // 尚未到期但没有定时器，设置一个
        this.scheduleTimer(task.id, task.parkingMeta.reminder.reminderAt);
      }
    }
  }

  private scheduleTimer(taskId: string, reminderAt: string): void {
    // 取消已有定时器
    const existingTimer = this.activeTimers.get(taskId);
    if (existingTimer) clearTimeout(existingTimer);

    const delay = Math.max(0, new Date(reminderAt).getTime() - Date.now());
    const timer = setTimeout(() => {
      const task = this.taskStore.getTask(taskId);
      if (task?.parkingMeta?.reminder) {
        this.triggerReminder(taskId, task.title, task.parkingMeta.reminder);
      }
      this.activeTimers.delete(taskId);
    }, delay);

    this.activeTimers.set(taskId, timer);
  }

  /**
   * 触发提醒通知——三阶段渐进消散（A6.3）
   */
  private triggerReminder(taskId: string, title: string, reminder: ParkingReminder): void {
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

  // ─── 内部辅助 ───

  private updateReminder(taskId: string, reminder: ParkingReminder | null): void {
    const task = this.taskStore.getTask(taskId);
    if (!task?.parkingMeta) return;

    const projectId = this.findProjectId(taskId);
    if (!projectId) return;

    this.taskStore.setTask(
      {
        ...task,
        parkingMeta: {
          ...task.parkingMeta,
          reminder,
        },
        updatedAt: new Date().toISOString(),
      },
      projectId
    );
  }

  private findProjectId(taskId: string): string | null {
    return this.taskStore.getTaskProjectId(taskId)
      ?? this.projectStore.activeProjectId()
      ?? null;
  }
}
