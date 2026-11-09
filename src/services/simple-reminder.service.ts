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
import { ParkingReminder, ParkingNotice, Task } from '../models';
import { PARKING_CONFIG } from '../config/parking.config';
import { ParkingService } from './parking.service';
import { LoggerService } from './logger.service';
import { SessionRuntimeResetRegistry } from './session-runtime-reset.service';
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
  private readonly sessionRuntimeReset = inject(SessionRuntimeResetRegistry);

  private get taskOpsAdapter(): TaskOperationAdapterService {
    return this.injector.get(TaskOperationAdapterService);
  }

  /** 活跃的提醒定时器 Map<taskId, timeoutId> */
  private readonly activeTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /** 进行中的提醒写操作 Map<`${op}:${taskId}`, promise>：同一任务同类操作并发去重 */
  private readonly inFlightReminderWrites = new Map<string, Promise<boolean>>();

  /** 最近已展示的提醒修订 Map<taskId, `${reminderAt}|${snoozeCount}`> */
  private readonly presentedReminderRevisions = new Map<string, string>();

  /** 当前显示的提醒通知 */
  readonly activeNotice = signal<ParkingNotice | null>(null);

  /** 检查间隔定时器 */
  private checkInterval: ReturnType<typeof setInterval> | null = null;

  private reminderCheckQueued = false;
  private reminderCheckToken = 0;
  private sessionGeneration = 0;
  private destroyed = false;
  private readonly unregisterSessionRuntimeReset: () => void;

  constructor() {
    this.unregisterSessionRuntimeReset = this.sessionRuntimeReset.register(
      'SimpleReminderService',
      () => this.resetSessionRuntime(),
    );

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
    if (this.destroyed) return;
    this.destroyed = true;
    this.unregisterSessionRuntimeReset();
    this.resetSessionRuntime();
  }

  // ─── 对外 API ───

  /**
   * 设置提醒
   * @param taskId 任务 ID
   * @param reminderAt 提醒时间（ISO 字符串）
   */
  async setReminder(taskId: string, reminderAt: string): Promise<boolean> {
    if (this.destroyed) return false;
    const generation = this.sessionGeneration;

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
      if (!this.isSessionGenerationCurrent(generation)) return false;
      if (!parked) return false;
      task = this.taskStore.getTask(taskId);
    }
    if (!task?.parkingMeta) return false;

    const reminder: ParkingReminder = {
      reminderAt,
      snoozeCount: 0,
      maxSnoozeCount: PARKING_CONFIG.MAX_SNOOZE_COUNT,
    };

    const saved = await this.updateReminder({ taskId, projectId: this.findProjectId(taskId), explicit: false }, reminder);
    if (!this.isSessionGenerationCurrent(generation)) return false;
    if (!saved) return false;
    this.scheduleTimer(taskId, reminderAt);
    this.startCheckInterval();
    return true;
  }

  /**
   * Snooze 提醒——延后到预设时间
   * 软上限 5 次后视觉弱化但不禁止继续
   * 同一任务的并发 snooze 只生效一次，防止连点导致 snoozeCount 重复递增
   */
  snoozeReminder(taskId: string, presetKey: 'QUICK' | 'NORMAL' | 'TWO_HOURS_LATER'): Promise<boolean> {
    const target = { taskId, projectId: this.findProjectId(taskId), explicit: false };
    return this.snoozeTarget(target, presetKey);
  }

  private snoozeTarget(
    target: { taskId: string; projectId: string | null; explicit: boolean },
    presetKey: 'QUICK' | 'NORMAL' | 'TWO_HOURS_LATER',
  ): Promise<boolean> {
    const projectId = target.projectId;
    if (!projectId) return Promise.resolve(false);
    return this.dedupeReminderWrite(
      `snooze:${projectId}:${target.taskId}`,
      () => this.runSnoozeReminder({ ...target, projectId }, presetKey),
    );
  }

  private async runSnoozeReminder(
    target: { taskId: string; projectId: string; explicit: boolean },
    presetKey: 'QUICK' | 'NORMAL' | 'TWO_HOURS_LATER',
  ): Promise<boolean> {
    if (this.destroyed) return false;
    const generation = this.sessionGeneration;
    const { projectId, taskId } = target;

    const task = target.explicit ? this.getProjectTask(projectId, taskId) : this.taskStore.getTask(taskId);
    if (!task?.parkingMeta?.reminder) return false;

    const delay = PARKING_CONFIG.SNOOZE_PRESETS[presetKey];
    const newReminderAt = new Date(Date.now() + delay).toISOString();

    const reminder: ParkingReminder = {
      reminderAt: newReminderAt,
      snoozeCount: task.parkingMeta.reminder.snoozeCount + 1,
      maxSnoozeCount: PARKING_CONFIG.MAX_SNOOZE_COUNT,
    };

    const saved = await this.updateReminder(target, reminder);
    if (!this.isSessionGenerationCurrent(generation)) return false;
    if (!saved) return false;
    if (target.explicit && !this.getProjectTask(projectId, taskId)) return false;
    this.scheduleTimer(taskId, newReminderAt);
    this.startCheckInterval();

    // 清除活跃通知
    const activeNotice = this.activeNotice();
    if (activeNotice?.taskId === taskId && (!target.explicit || activeNotice.projectId === projectId)) {
      this.activeNotice.set(null);
      this.queueReminderCheck();
    }

    // 清除红点
    if (!target.explicit || this.projectStore.activeProjectId() === projectId) {
      this.parkingService.clearBadge(taskId);
    }
    return true;
  }

  /**
   * 取消提醒——"忽略"语义（A5.3.3）
   * 任务保持停泊状态，reminder 置 null，可重新设置（snoozeCount 重置）
   * 同一任务的并发取消只生效一次，防止重复写 parkingMeta
   */
  cancelReminder(taskId: string): Promise<boolean>;
  cancelReminder(projectId: string, taskId: string): Promise<boolean>;
  cancelReminder(projectOrTaskId: string, explicitTaskId?: string): Promise<boolean> {
    const target = explicitTaskId === undefined
      ? { taskId: projectOrTaskId, projectId: this.findProjectId(projectOrTaskId), explicit: false }
      : { taskId: explicitTaskId, projectId: projectOrTaskId, explicit: true };
    if (!target.projectId) return Promise.resolve(false);
    const projectId = target.projectId;
    return this.dedupeReminderWrite(
      `cancel:${target.projectId}:${target.taskId}`,
      () => this.runCancelReminder({ ...target, projectId }),
    );
  }

  private async runCancelReminder(
    target: { taskId: string; projectId: string; explicit: boolean },
  ): Promise<boolean> {
    if (this.destroyed) return false;
    const generation = this.sessionGeneration;
    const { projectId, taskId } = target;
    if (target.explicit && !this.getProjectTask(projectId, taskId)) return false;

    const saved = await this.updateReminder(target, null);
    if (!this.isSessionGenerationCurrent(generation)) return false;
    if (!saved) return false;
    if (target.explicit && !this.getProjectTask(projectId, taskId)) return false;

    // 取消定时器
    if (this.activeTimers.has(taskId)) {
      clearTimeout(this.activeTimers.get(taskId)!);
      this.activeTimers.delete(taskId);
    }
    this.syncCheckInterval(taskId);

    // 清除活跃通知
    const activeNotice = this.activeNotice();
    if (activeNotice?.taskId === taskId && (!target.explicit || activeNotice.projectId === projectId)) {
      this.activeNotice.set(null);
      this.queueReminderCheck();
    }

    // 清除红点
    if (!target.explicit || this.projectStore.activeProjectId() === projectId) {
      this.parkingService.clearBadge(taskId);
    }
    return true;
  }

  /**
   * 快速 snooze 方法（用于通知按钮）
   */
  snooze5m(taskId: string): Promise<boolean>;
  snooze5m(projectId: string, taskId: string): Promise<boolean>;
  snooze5m(projectOrTaskId: string, explicitTaskId?: string): Promise<boolean> {
    return explicitTaskId === undefined
      ? this.snoozeReminder(projectOrTaskId, 'QUICK')
      : this.snoozeTarget({ projectId: projectOrTaskId, taskId: explicitTaskId, explicit: true }, 'QUICK');
  }

  snooze30m(taskId: string): Promise<boolean>;
  snooze30m(projectId: string, taskId: string): Promise<boolean>;
  snooze30m(projectOrTaskId: string, explicitTaskId?: string): Promise<boolean> {
    return explicitTaskId === undefined
      ? this.snoozeReminder(projectOrTaskId, 'NORMAL')
      : this.snoozeTarget({ projectId: projectOrTaskId, taskId: explicitTaskId, explicit: true }, 'NORMAL');
  }

  snooze2h(taskId: string): Promise<boolean>;
  snooze2h(projectId: string, taskId: string): Promise<boolean>;
  snooze2h(projectOrTaskId: string, explicitTaskId?: string): Promise<boolean> {
    return explicitTaskId === undefined
      ? this.snoozeReminder(projectOrTaskId, 'TWO_HOURS_LATER')
      : this.snoozeTarget({ projectId: projectOrTaskId, taskId: explicitTaskId, explicit: true }, 'TWO_HOURS_LATER');
  }

  // ─── 提醒检查 ───

  private checkReminders(): void {
    if (this.destroyed) return;

    const now = Date.now();
    const parkedTasks = this.taskStore.parkedTasks();
    const reminderTaskIds = new Set<string>();

    for (const task of parkedTasks) {
      if (!task.parkingMeta?.reminder) continue;
      reminderTaskIds.add(task.id);
      const projectId = this.taskStore.getTaskProjectId(task.id);
      if (!projectId) continue;

      const reminderTime = this.parseReminderTime(task.id, task.parkingMeta.reminder.reminderAt);
      if (reminderTime === null) continue;

      if (reminderTime <= now) {
        // 提醒到期
        this.triggerReminder(task.id, task.title, task.parkingMeta.reminder, projectId);
      } else if (!this.activeTimers.has(task.id)) {
        // 尚未到期但没有定时器，设置一个
        this.scheduleTimer(task.id, task.parkingMeta.reminder.reminderAt);
      }
    }

    for (const taskId of this.presentedReminderRevisions.keys()) {
      if (!reminderTaskIds.has(taskId)) {
        this.presentedReminderRevisions.delete(taskId);
      }
    }

    this.syncCheckInterval();
  }

  private scheduleTimer(taskId: string, reminderAt: string): void {
    if (this.destroyed) return;
    const generation = this.sessionGeneration;

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
      if (!this.isSessionGenerationCurrent(generation)) return;
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
          const projectId = this.taskStore.getTaskProjectId(taskId);
          if (projectId) this.triggerReminder(taskId, task.title, currentReminder, projectId);
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
  private triggerReminder(
    taskId: string,
    title: string,
    reminder: ParkingReminder,
    projectId: string | null = this.findProjectId(taskId),
  ): void {
    if (this.destroyed) return;
    if (!projectId) return;

    const reminderRevision = `${reminder.reminderAt}|${reminder.snoozeCount}`;
    if (this.presentedReminderRevisions.get(taskId) === reminderRevision) return;

    const currentNotice = this.activeNotice();
    if (currentNotice?.type === 'reminder'
      && currentNotice.projectId === projectId && currentNotice.taskId === taskId) return;

    // 单活跃通知规则：另一条提醒还在展示时不得同 tick 顶替——否则被顶掉的提醒
    // 永远不会渲染也不会留下淡出徽标（静默饿死），而顶替者的通知周期被反复重置。
    // 被延后的提醒仍处于到期状态，会在当前通知解决后的下一轮检查中触发
    if (currentNotice?.type === 'reminder' && currentNotice.taskId !== taskId) return;

    const isOverSoftLimit = reminder.snoozeCount >= PARKING_CONFIG.MAX_SNOOZE_COUNT;

    const notice: ParkingNotice = {
      id: crypto.randomUUID(),
      type: 'reminder',
      projectId,
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
    this.presentedReminderRevisions.set(taskId, reminderRevision);
  }

  /**
   * 通知被兜底淡出时调用
   */
  handleNoticeFadeout(noticeId: string, taskId: string): void;
  handleNoticeFadeout(projectId: string, noticeId: string, taskId: string): void;
  handleNoticeFadeout(projectOrNoticeId: string, noticeOrTaskId: string, explicitTaskId?: string): void {
    const projectId = explicitTaskId === undefined ? null : projectOrNoticeId;
    const noticeId = explicitTaskId === undefined ? projectOrNoticeId : noticeOrTaskId;
    const taskId = explicitTaskId ?? noticeOrTaskId;
    const currentNotice = this.activeNotice();
    if (currentNotice?.id !== noticeId || currentNotice.taskId !== taskId
      || projectId && currentNotice.projectId !== projectId) return;

    this.parkingService.recordReminderFadeout(taskId);
    this.activeNotice.set(null);
    this.queueReminderCheck();
  }

  /**
   * 清除当前活跃通知（外部组件不可直接操作 activeNotice signal）
   */
  clearActiveNotice(noticeId: string, taskId: string): void;
  clearActiveNotice(projectId: string, noticeId: string, taskId: string): void;
  clearActiveNotice(projectOrNoticeId: string, noticeOrTaskId: string, explicitTaskId?: string): void {
    const projectId = explicitTaskId === undefined ? null : projectOrNoticeId;
    const noticeId = explicitTaskId === undefined ? projectOrNoticeId : noticeOrTaskId;
    const taskId = explicitTaskId ?? noticeOrTaskId;
    const currentNotice = this.activeNotice();
    if (currentNotice?.id !== noticeId || currentNotice.taskId !== taskId
      || projectId && currentNotice.projectId !== projectId) return;

    this.activeNotice.set(null);
    this.queueReminderCheck();
  }

  // ─── 内部辅助 ───

  /** 按 reminder/task id 去重进行中的写操作：同一 key 的并发调用复用同一个进行中 Promise */
  private dedupeReminderWrite(key: string, run: () => Promise<boolean>): Promise<boolean> {
    const inFlight = this.inFlightReminderWrites.get(key);
    if (inFlight) return inFlight;

    const operation = run().finally(() => {
      if (this.inFlightReminderWrites.get(key) === operation) {
        this.inFlightReminderWrites.delete(key);
      }
    });
    this.inFlightReminderWrites.set(key, operation);
    return operation;
  }

  private updateReminder(
    target: { taskId: string; projectId: string | null; explicit: boolean },
    reminder: ParkingReminder | null,
  ): Promise<boolean> {
    const { projectId, taskId } = target;
    if (!projectId) return Promise.resolve(false);
    const task = target.explicit ? this.getProjectTask(projectId, taskId) : this.taskStore.getTask(taskId);
    if (!task?.parkingMeta) return Promise.resolve(false);

    const parkingMeta = {
      ...task.parkingMeta,
      reminder,
    };
    return target.explicit
      ? this.taskOpsAdapter.updateTaskParkingMeta(projectId, taskId, parkingMeta)
      : this.taskOpsAdapter.updateTaskParkingMeta(taskId, parkingMeta);
  }

  private getProjectTask(projectId: string, taskId: string): Task | undefined {
    return this.projectStore.projects()
      .find(project => project.id === projectId)
      ?.tasks.find(task => task.id === taskId);
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
    const generation = this.sessionGeneration;
    this.checkInterval = setInterval(() => {
      if (this.isSessionGenerationCurrent(generation)) {
        this.checkReminders();
      }
    }, REMINDER_CHECK_INTERVAL_MS);
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
    const token = ++this.reminderCheckToken;
    const generation = this.sessionGeneration;
    Promise.resolve().then(() => {
      if (token !== this.reminderCheckToken) return;
      this.reminderCheckQueued = false;
      if (this.isSessionGenerationCurrent(generation)) this.checkReminders();
    });
  }

  private resetSessionRuntime(): void {
    this.sessionGeneration += 1;
    this.reminderCheckToken += 1;
    this.reminderCheckQueued = false;
    this.stopCheckInterval();
    for (const timer of this.activeTimers.values()) clearTimeout(timer);
    this.activeTimers.clear();
    this.activeNotice.set(null);
    this.presentedReminderRevisions.clear();
    this.inFlightReminderWrites.clear();
  }

  private isSessionGenerationCurrent(generation: number): boolean {
    return !this.destroyed && generation === this.sessionGeneration;
  }
}
