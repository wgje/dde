/**
 * SimpleReminderService 单元测试
 * 策划案 A5.3 定时提醒 + A12 验收标准 P-05/P-06/P-07/P-22
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { SimpleReminderService } from './simple-reminder.service';
import { ParkingService } from './parking.service';
import { LoggerService } from './logger.service';
import { TaskStore, ProjectStore } from '../app/core/state/stores';
import { Task } from '../models';
import { PARKING_CONFIG } from '../config/parking.config';

describe('SimpleReminderService', () => {
  let service: SimpleReminderService;

  const createTask = (overrides: Partial<Task> = {}): Task => ({
    id: crypto.randomUUID(),
    title: '测试任务',
    content: '',
    stage: 0,
    parentId: null,
    order: 0,
    rank: 10000,
    status: 'active',
    x: 0,
    y: 0,
    displayId: 'T-1',
    createdDate: new Date().toISOString(),
    deletedAt: null,
    parkingMeta: null,
    ...overrides,
  });

  let mockTaskStore: {
    parkedTasks: ReturnType<typeof signal>;
    getTask: ReturnType<typeof vi.fn>;
    setTask: ReturnType<typeof vi.fn>;
    parkedTaskIds: ReturnType<typeof signal>;
    getTaskProjectId: ReturnType<typeof vi.fn>;
  };

  let mockProjectStore: {
    projects: ReturnType<typeof signal>;
    activeProjectId: ReturnType<typeof signal>;
  };

  let mockParkingService: {
    showNotice: ReturnType<typeof vi.fn>;
    recordReminderFadeout: ReturnType<typeof vi.fn>;
    clearBadge: ReturnType<typeof vi.fn>;
  };

  let mockLogger: {
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
    debug: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-23T10:00:00.000Z'));

    mockTaskStore = {
      parkedTasks: signal<Task[]>([]),
      getTask: vi.fn(),
      setTask: vi.fn(),
      parkedTaskIds: signal(new Set<string>()),
      getTaskProjectId: vi.fn(() => 'proj-1'),
    };

    mockProjectStore = {
      projects: signal([]),
      activeProjectId: signal('proj-1'),
    };

    mockParkingService = {
      showNotice: vi.fn(),
      recordReminderFadeout: vi.fn(),
      clearBadge: vi.fn(),
    };

    mockLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };

    TestBed.configureTestingModule({
      providers: [
        SimpleReminderService,
        { provide: TaskStore, useValue: mockTaskStore },
        { provide: ProjectStore, useValue: mockProjectStore },
        { provide: ParkingService, useValue: mockParkingService },
        { provide: LoggerService, useValue: mockLogger },
      ],
    });

    service = TestBed.inject(SimpleReminderService);
  });

  afterEach(() => {
    vi.useRealTimers();
    service.ngOnDestroy();
    TestBed.resetTestingModule();
  });

  // ─── P-05: 提醒设置 ───

  describe('P-05: setReminder', () => {
    it('应为任务设置提醒', () => {
      const task = createTask({
        id: 'task-1',
        parkingMeta: {
          state: 'parked',
          parkedAt: new Date().toISOString(),
          lastVisitedAt: new Date().toISOString(),
          contextSnapshot: null,
          reminder: null,
          pinned: false,
        },
      });
      mockTaskStore.getTask.mockReturnValue(task);

      const futureTime = new Date(Date.now() + 3600_000).toISOString();
      service.setReminder('task-1', futureTime);

      expect(mockTaskStore.setTask).toHaveBeenCalled();
      const updated = mockTaskStore.setTask.mock.calls[0][0];
      expect(updated.parkingMeta.reminder.reminderAt).toBe(futureTime);
      expect(updated.parkingMeta.reminder.snoozeCount).toBe(0);
    });
  });

  // ─── P-22: 过去时间拒绝 ───

  describe('P-22: setReminder 过去时间', () => {
    it('过去的时间应被拒绝', () => {
      const task = createTask({
        id: 'past-time',
        parkingMeta: {
          state: 'parked',
          parkedAt: new Date().toISOString(),
          lastVisitedAt: new Date().toISOString(),
          contextSnapshot: null,
          reminder: null,
          pinned: false,
        },
      });
      mockTaskStore.getTask.mockReturnValue(task);

      const pastTime = new Date(Date.now() - 3600_000).toISOString();
      service.setReminder('past-time', pastTime);

      expect(mockLogger.warn).toHaveBeenCalled();
      expect(mockTaskStore.setTask).not.toHaveBeenCalled();
    });
  });

  // ─── P-06: Snooze 提醒 ───

  describe('P-06: snooze 预设', () => {
    it('snooze5m 应延后 5 分钟', () => {
      const task = createTask({
        id: 'snooze-5m',
        parkingMeta: {
          state: 'parked',
          parkedAt: new Date().toISOString(),
          lastVisitedAt: new Date().toISOString(),
          contextSnapshot: null,
          reminder: {
            reminderAt: new Date().toISOString(), // 已到期
            snoozeCount: 0,
            maxSnoozeCount: 5,
          },
          pinned: false,
        },
      });
      mockTaskStore.getTask.mockReturnValue(task);

      service.snooze5m('snooze-5m');

      expect(mockTaskStore.setTask).toHaveBeenCalled();
      const updated = mockTaskStore.setTask.mock.calls[0][0];
      expect(updated.parkingMeta.reminder.snoozeCount).toBe(1);
      // 新的 reminderAt 应是 5 分钟后
      const newTime = new Date(updated.parkingMeta.reminder.reminderAt).getTime();
      const expectedTime = Date.now() + PARKING_CONFIG.SNOOZE_PRESETS.QUICK;
      // 允许 1s 误差
      expect(Math.abs(newTime - expectedTime)).toBeLessThan(1000);
    });

    it('snooze30m 应延后 30 分钟', () => {
      const task = createTask({
        id: 'snooze-30m',
        parkingMeta: {
          state: 'parked',
          parkedAt: new Date().toISOString(),
          lastVisitedAt: new Date().toISOString(),
          contextSnapshot: null,
          reminder: {
            reminderAt: new Date().toISOString(),
            snoozeCount: 1,
            maxSnoozeCount: 5,
          },
          pinned: false,
        },
      });
      mockTaskStore.getTask.mockReturnValue(task);

      service.snooze30m('snooze-30m');

      const updated = mockTaskStore.setTask.mock.calls[0][0];
      expect(updated.parkingMeta.reminder.snoozeCount).toBe(2);
    });

    it('snooze2h 应延后 2 小时', () => {
      const task = createTask({
        id: 'snooze-2h',
        parkingMeta: {
          state: 'parked',
          parkedAt: new Date().toISOString(),
          lastVisitedAt: new Date().toISOString(),
          contextSnapshot: null,
          reminder: {
            reminderAt: new Date().toISOString(),
            snoozeCount: 2,
            maxSnoozeCount: 5,
          },
          pinned: false,
        },
      });
      mockTaskStore.getTask.mockReturnValue(task);

      service.snooze2h('snooze-2h');

      const updated = mockTaskStore.setTask.mock.calls[0][0];
      expect(updated.parkingMeta.reminder.snoozeCount).toBe(3);
    });

    it('snooze 应清除活跃通知', () => {
      const task = createTask({
        id: 'snooze-clear',
        parkingMeta: {
          state: 'parked',
          parkedAt: new Date().toISOString(),
          lastVisitedAt: new Date().toISOString(),
          contextSnapshot: null,
          reminder: {
            reminderAt: new Date().toISOString(),
            snoozeCount: 0,
            maxSnoozeCount: 5,
          },
          pinned: false,
        },
      });
      mockTaskStore.getTask.mockReturnValue(task);

      // 先触发提醒
      (service as unknown as { triggerReminder: (id: string, title: string, reminder: unknown) => void })
        .triggerReminder('snooze-clear', '测试', task.parkingMeta!.reminder!);
      expect(service.activeNotice()).toBeTruthy();

      // snooze 后应清除
      service.snooze5m('snooze-clear');
      expect(service.activeNotice()).toBeNull();
    });

    it('snooze 应清除红点', () => {
      const task = createTask({
        id: 'snooze-badge',
        parkingMeta: {
          state: 'parked',
          parkedAt: new Date().toISOString(),
          lastVisitedAt: new Date().toISOString(),
          contextSnapshot: null,
          reminder: {
            reminderAt: new Date().toISOString(),
            snoozeCount: 0,
            maxSnoozeCount: 5,
          },
          pinned: false,
        },
      });
      mockTaskStore.getTask.mockReturnValue(task);

      service.snooze5m('snooze-badge');

      expect(mockParkingService.clearBadge).toHaveBeenCalledWith('snooze-badge');
    });
  });

  // ─── P-07: Snooze 软上限 ───

  describe('P-07: snooze 软上限', () => {
    it('snoozeCount 达到 maxSnoozeCount 后提醒显示累计次数', () => {
      const task = createTask({
        id: 'soft-limit-reminder',
        title: '累计提醒',
        parkingMeta: {
          state: 'parked',
          parkedAt: new Date().toISOString(),
          lastVisitedAt: new Date().toISOString(),
          contextSnapshot: null,
          reminder: {
            reminderAt: new Date().toISOString(),
            snoozeCount: PARKING_CONFIG.MAX_SNOOZE_COUNT,
            maxSnoozeCount: PARKING_CONFIG.MAX_SNOOZE_COUNT,
          },
          pinned: false,
        },
      });
      mockTaskStore.getTask.mockReturnValue(task);

      // 触发提醒
      (service as unknown as { triggerReminder: (id: string, title: string, reminder: unknown) => void })
        .triggerReminder('soft-limit-reminder', '累计提醒', task.parkingMeta!.reminder!);

      const notice = service.activeNotice();
      expect(notice).toBeTruthy();
      // 忽略按钮应包含累计次数
      const ignoreAction = notice?.actions.find(a => a.key === 'ignore');
      expect(ignoreAction?.label).toContain(`${PARKING_CONFIG.MAX_SNOOZE_COUNT}`);
    });

    it('超过软上限后仍可继续 snooze', () => {
      const task = createTask({
        id: 'over-limit',
        parkingMeta: {
          state: 'parked',
          parkedAt: new Date().toISOString(),
          lastVisitedAt: new Date().toISOString(),
          contextSnapshot: null,
          reminder: {
            reminderAt: new Date().toISOString(),
            snoozeCount: PARKING_CONFIG.MAX_SNOOZE_COUNT + 3,
            maxSnoozeCount: PARKING_CONFIG.MAX_SNOOZE_COUNT,
          },
          pinned: false,
        },
      });
      mockTaskStore.getTask.mockReturnValue(task);

      service.snooze5m('over-limit');

      expect(mockTaskStore.setTask).toHaveBeenCalled();
      const updated = mockTaskStore.setTask.mock.calls[0][0];
      expect(updated.parkingMeta.reminder.snoozeCount).toBe(PARKING_CONFIG.MAX_SNOOZE_COUNT + 4);
    });
  });

  // ─── P-07b: 取消提醒后重设 ───

  describe('P-07b: cancelReminder', () => {
    it('取消提醒后 reminder 为 null', () => {
      const task = createTask({
        id: 'cancel-1',
        parkingMeta: {
          state: 'parked',
          parkedAt: new Date().toISOString(),
          lastVisitedAt: new Date().toISOString(),
          contextSnapshot: null,
          reminder: {
            reminderAt: new Date(Date.now() + 3600_000).toISOString(),
            snoozeCount: 3,
            maxSnoozeCount: 5,
          },
          pinned: false,
        },
      });
      mockTaskStore.getTask.mockReturnValue(task);

      service.cancelReminder('cancel-1');

      expect(mockTaskStore.setTask).toHaveBeenCalled();
      const updated = mockTaskStore.setTask.mock.calls[0][0];
      expect(updated.parkingMeta.reminder).toBeNull();
    });

    it('取消后应清除红点', () => {
      const task = createTask({
        id: 'cancel-badge',
        parkingMeta: {
          state: 'parked',
          parkedAt: new Date().toISOString(),
          lastVisitedAt: new Date().toISOString(),
          contextSnapshot: null,
          reminder: {
            reminderAt: new Date(Date.now() + 3600_000).toISOString(),
            snoozeCount: 0,
            maxSnoozeCount: 5,
          },
          pinned: false,
        },
      });
      mockTaskStore.getTask.mockReturnValue(task);

      service.cancelReminder('cancel-badge');

      expect(mockParkingService.clearBadge).toHaveBeenCalledWith('cancel-badge');
    });

    it('取消后应清除活跃通知', () => {
      const task = createTask({
        id: 'cancel-notice',
        parkingMeta: {
          state: 'parked',
          parkedAt: new Date().toISOString(),
          lastVisitedAt: new Date().toISOString(),
          contextSnapshot: null,
          reminder: {
            reminderAt: new Date().toISOString(),
            snoozeCount: 0,
            maxSnoozeCount: 5,
          },
          pinned: false,
        },
      });
      mockTaskStore.getTask.mockReturnValue(task);

      // 先触发提醒
      (service as unknown as { triggerReminder: (id: string, title: string, reminder: unknown) => void })
        .triggerReminder('cancel-notice', '测试', task.parkingMeta!.reminder!);
      expect(service.activeNotice()).toBeTruthy();

      service.cancelReminder('cancel-notice');
      expect(service.activeNotice()).toBeNull();
    });
  });

  // ─── handleNoticeFadeout ───

  describe('handleNoticeFadeout', () => {
    it('淡出应记录到 ParkingService', () => {
      service.handleNoticeFadeout('fadeout-task');

      expect(mockParkingService.recordReminderFadeout).toHaveBeenCalledWith('fadeout-task');
    });

    it('淡出应清除活跃通知', () => {
      const task = createTask({
        id: 'fadeout-2',
        parkingMeta: {
          state: 'parked',
          parkedAt: new Date().toISOString(),
          lastVisitedAt: new Date().toISOString(),
          contextSnapshot: null,
          reminder: {
            reminderAt: new Date().toISOString(),
            snoozeCount: 0,
            maxSnoozeCount: 5,
          },
          pinned: false,
        },
      });
      mockTaskStore.getTask.mockReturnValue(task);

      (service as unknown as { triggerReminder: (id: string, title: string, reminder: unknown) => void })
        .triggerReminder('fadeout-2', '测试', task.parkingMeta!.reminder!);
      expect(service.activeNotice()).toBeTruthy();

      service.handleNoticeFadeout('fadeout-2');
      expect(service.activeNotice()).toBeNull();
    });
  });

  // ─── 初始状态 ───

  describe('activeNotice', () => {
    it('初始为 null', () => {
      expect(service.activeNotice()).toBeNull();
    });
  });

  // ─── 提醒到期触发 ───

  describe('提醒到期', () => {
    it('提醒到期时应触发通知', () => {
      const task = createTask({
        id: 'due-reminder',
        title: '到期任务',
        parkingMeta: {
          state: 'parked',
          parkedAt: new Date().toISOString(),
          lastVisitedAt: new Date().toISOString(),
          contextSnapshot: null,
          reminder: {
            reminderAt: new Date(Date.now() + 60_000).toISOString(), // 1 分钟后
            snoozeCount: 0,
            maxSnoozeCount: 5,
          },
          pinned: false,
        },
      });
      mockTaskStore.getTask.mockReturnValue(task);
      mockTaskStore.parkedTasks.set([task]);

      // 推进时间到提醒到期
      vi.advanceTimersByTime(60_000);

      expect(service.activeNotice()).toBeTruthy();
      expect(service.activeNotice()?.type).toBe('reminder');
      expect(service.activeNotice()?.taskId).toBe('due-reminder');
    });

    it('提醒通知应包含所有操作按钮', () => {
      const task = createTask({
        id: 'actions-test',
        title: '操作测试',
        parkingMeta: {
          state: 'parked',
          parkedAt: new Date().toISOString(),
          lastVisitedAt: new Date().toISOString(),
          contextSnapshot: null,
          reminder: {
            reminderAt: new Date().toISOString(),
            snoozeCount: 0,
            maxSnoozeCount: 5,
          },
          pinned: false,
        },
      });
      mockTaskStore.getTask.mockReturnValue(task);

      (service as unknown as { triggerReminder: (id: string, title: string, reminder: unknown) => void })
        .triggerReminder('actions-test', '操作测试', task.parkingMeta!.reminder!);

      const notice = service.activeNotice();
      expect(notice?.actions).toBeTruthy();
      const keys = notice?.actions.map(a => a.key) ?? [];
      expect(keys).toContain('start-work');
      expect(keys).toContain('snooze-5m');
      expect(keys).toContain('snooze-30m');
      expect(keys).toContain('snooze-2h-later');
      expect(keys).toContain('ignore');
    });
  });

  // ─── ngOnDestroy 清理 ───

  describe('ngOnDestroy', () => {
    it('销毁时应清理所有定时器', () => {
      const task = createTask({
        id: 'destroy-test',
        parkingMeta: {
          state: 'parked',
          parkedAt: new Date().toISOString(),
          lastVisitedAt: new Date().toISOString(),
          contextSnapshot: null,
          reminder: {
            reminderAt: new Date(Date.now() + 3600_000).toISOString(),
            snoozeCount: 0,
            maxSnoozeCount: 5,
          },
          pinned: false,
        },
      });
      mockTaskStore.getTask.mockReturnValue(task);
      service.setReminder('destroy-test', new Date(Date.now() + 3600_000).toISOString());

      service.ngOnDestroy();

      // 销毁后推进时间不应触发提醒
      vi.advanceTimersByTime(3600_000 + 1);
      expect(service.activeNotice()).toBeNull();
    });
  });
});
