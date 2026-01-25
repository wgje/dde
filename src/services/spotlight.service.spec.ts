/**
 * Spotlight 服务单元测试
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { SpotlightService } from './spotlight.service';
import { BlackBoxService } from './black-box.service';
import { ProjectStateService } from './project-state.service';
import { TaskOperationService } from './task-operation.service';
import { LoggerService } from './logger.service';
import { 
  spotlightTask,
  isSpotlightMode,
  spotlightTaskQueue,
  focusPreferences,
  setBlackBoxEntries
} from '../app/core/state/focus-stores';
import { Task } from '../models';

describe('SpotlightService', () => {
  let service: SpotlightService;
  let mockBlackBoxService: {
    entriesMap: ReturnType<typeof signal>;
  };
  let mockProjectStateService: {
    activeProjectId: ReturnType<typeof signal>;
    tasks: ReturnType<typeof signal>;
  };
  let mockTaskOperationService: {
    updateTaskStatus: ReturnType<typeof vi.fn>;
  };
  let mockLoggerService: {
    debug: ReturnType<typeof vi.fn>;
    info: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };

  const createMockTask = (overrides: Partial<Task> = {}): Task => ({
    id: crypto.randomUUID(),
    title: '测试任务',
    content: '',
    stage: 0,
    parentId: null,
    order: 0,
    rank: 0,
    status: 'active',
    x: 0,
    y: 0,
    displayId: '1',
    createdDate: new Date().toISOString(),
    deletedAt: null,
    ...overrides
  });

  beforeEach(() => {
    // 重置状态
    spotlightTask.set(null);
    isSpotlightMode.set(false);
    spotlightTaskQueue.set([]);
    setBlackBoxEntries([]);
    focusPreferences.set({
      gateEnabled: true,
      spotlightEnabled: true,
      strataEnabled: true,
      blackBoxEnabled: true,
      maxSnoozePerDay: 3
    });

    mockBlackBoxService = {
      entriesMap: signal(new Map())
    };

    mockProjectStateService = {
      activeProjectId: signal('test-project'),
      tasks: signal<Task[]>([])
    };

    mockTaskOperationService = {
      updateTaskStatus: vi.fn()
    };

    mockLoggerService = {
      debug: vi.fn(),
      info: vi.fn(),
      error: vi.fn()
    };

    TestBed.configureTestingModule({
      providers: [
        SpotlightService,
        { provide: BlackBoxService, useValue: mockBlackBoxService },
        { provide: ProjectStateService, useValue: mockProjectStateService },
        { provide: TaskOperationService, useValue: mockTaskOperationService },
        { provide: LoggerService, useValue: mockLoggerService }
      ]
    });

    service = TestBed.inject(SpotlightService);
  });

  describe('enter', () => {
    it('应该进入聚光灯模式', () => {
      const task = createMockTask();
      mockProjectStateService.tasks.set([task]);

      service.enter();

      expect(isSpotlightMode()).toBe(true);
      expect(spotlightTask()).not.toBeNull();
    });

    it('无任务时不应该进入', () => {
      mockProjectStateService.tasks.set([]);

      service.enter();

      expect(isSpotlightMode()).toBe(false);
    });

    it('聚光灯禁用时不应该进入', () => {
      focusPreferences.update(p => ({ ...p, spotlightEnabled: false }));
      mockProjectStateService.tasks.set([createMockTask()]);

      service.enter();

      expect(isSpotlightMode()).toBe(false);
    });
  });

  describe('exit', () => {
    it('应该退出聚光灯模式', () => {
      isSpotlightMode.set(true);
      spotlightTask.set(createMockTask());

      service.exit();

      expect(isSpotlightMode()).toBe(false);
      expect(spotlightTask()).toBeNull();
      expect(spotlightTaskQueue()).toEqual([]);
    });
  });

  describe('completeCurrentTask', () => {
    it('应该完成当前任务', () => {
      const task = createMockTask();
      spotlightTask.set(task);
      isSpotlightMode.set(true);

      service.completeCurrentTask();

      expect(mockTaskOperationService.updateTaskStatus).toHaveBeenCalledWith(task.id, 'completed');
    });

    it('无当前任务时不应该执行', () => {
      spotlightTask.set(null);

      service.completeCurrentTask();

      expect(mockTaskOperationService.updateTaskStatus).not.toHaveBeenCalled();
    });
  });

  describe('skipCurrentTask', () => {
    it('应该跳过当前任务', () => {
      const task1 = createMockTask({ id: '1', title: '任务1' });
      const task2 = createMockTask({ id: '2', title: '任务2' });
      spotlightTask.set(task1);
      spotlightTaskQueue.set([task2]);
      isSpotlightMode.set(true);

      service.skipCurrentTask();

      // 当前任务应该被放到队列末尾
      const queue = spotlightTaskQueue();
      expect(queue.some(t => t.id === '1')).toBe(true);
    });
  });

  describe('hasTasks', () => {
    it('有当前任务时应该返回 true', () => {
      spotlightTask.set(createMockTask());

      expect(service.hasTasks()).toBe(true);
    });

    it('队列中有任务时应该返回 true', () => {
      spotlightTask.set(null);
      spotlightTaskQueue.set([createMockTask()]);

      expect(service.hasTasks()).toBe(true);
    });

    it('无任务时应该返回 false', () => {
      spotlightTask.set(null);
      spotlightTaskQueue.set([]);

      expect(service.hasTasks()).toBe(false);
    });
  });

  describe('isActive', () => {
    it('应该返回聚光灯模式状态', () => {
      expect(service.isActive()).toBe(false);

      isSpotlightMode.set(true);

      expect(service.isActive()).toBe(true);
    });
  });
});
