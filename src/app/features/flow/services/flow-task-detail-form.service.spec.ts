/**
 * FlowTaskDetailFormService 单元测试
 *
 * 测试覆盖：
 * 1. 字段锁定 / 解锁（lockTaskFields / unlockTaskFields）
 * 2. 输入框聚焦处理（onInputFocus）—— 含定时器清除
 * 3. 输入框失焦处理（onInputBlur）—— 含延迟解锁定时器
 * 4. 本地标题/内容变更（onLocalTitleChange / onLocalContentChange）—— 含任务切换保护
 * 5. 编辑模式切换（toggleEditMode）—— 含 300ms 节流
 * 6. 退出编辑模式判定（shouldExitEditMode）
 * 7. 定时器清理（cleanup）
 *
 * 注意：initSyncEffect 需要 Angular 组件 injection context，不在此测试范围
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Injector, runInInjectionContext } from '@angular/core';
import { FlowTaskDetailFormService } from './flow-task-detail-form.service';
import { ProjectStateService } from '../../../../services/project-state.service';
import { ChangeTrackerService } from '../../../../services/change-tracker.service';
import { LoggerService } from '../../../../services/logger.service';
import type { Task } from '../../../../models';

// ==================== Mock 依赖 ====================

const mockLoggerCategory = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

const mockLoggerService = {
  category: vi.fn(() => mockLoggerCategory),
};

const mockProjectState = {
  activeProjectId: vi.fn(() => 'project-1'),
};

const mockChangeTracker = {
  lockTaskField: vi.fn(),
  unlockTaskField: vi.fn(),
};

// ==================== 辅助函数 ====================

/** 创建符合 Task 接口的 mock 对象 */
function createMockTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    title: 'Test',
    content: 'Content',
    stage: 1,
    parentId: null,
    order: 0,
    rank: 10000,
    status: 'active',
    x: 0,
    y: 0,
    createdDate: new Date().toISOString(),
    displayId: '1',
    ...overrides,
  } as Task;
}

describe('FlowTaskDetailFormService', () => {
  let service: FlowTaskDetailFormService;
  let consoleWarnSpy: ReturnType<typeof vi.spyOn> | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // 模拟 TEXT_INPUT_LOCK_TIMEOUT_MS 静态属性
    (ChangeTrackerService as any).TEXT_INPUT_LOCK_TIMEOUT_MS = 3600000;

    const injector = Injector.create({
      providers: [
        FlowTaskDetailFormService,
        { provide: ProjectStateService, useValue: mockProjectState },
        { provide: ChangeTrackerService, useValue: mockChangeTracker },
        { provide: LoggerService, useValue: mockLoggerService },
      ],
    });

    service = runInInjectionContext(injector, () => injector.get(FlowTaskDetailFormService));
  });

  afterEach(() => {
    service.cleanup();
    consoleWarnSpy?.mockRestore();
    // 确保 fake timers 被恢复（防止泄漏到其他测试）
    vi.useRealTimers();
  });

  // ==================== lockTaskFields / unlockTaskFields ====================

  describe('lockTaskFields', () => {
    it('应为每个字段调用 changeTracker.lockTaskField', () => {
      // 锁定 title 和 content 两个字段
      service.lockTaskFields('task-1', ['title', 'content']);

      expect(mockChangeTracker.lockTaskField).toHaveBeenCalledTimes(2);
      expect(mockChangeTracker.lockTaskField).toHaveBeenCalledWith(
        'task-1',
        'project-1',
        'title',
        ChangeTrackerService.TEXT_INPUT_LOCK_TIMEOUT_MS,
      );
      expect(mockChangeTracker.lockTaskField).toHaveBeenCalledWith(
        'task-1',
        'project-1',
        'content',
        ChangeTrackerService.TEXT_INPUT_LOCK_TIMEOUT_MS,
      );
    });

    it('无活动项目时应直接返回，不调用锁定', () => {
      // 模拟无活动项目
      mockProjectState.activeProjectId.mockReturnValueOnce(null);

      service.lockTaskFields('task-1', ['title']);

      expect(mockChangeTracker.lockTaskField).not.toHaveBeenCalled();
    });
  });

  describe('unlockTaskFields', () => {
    it('应为每个字段调用 changeTracker.unlockTaskField', () => {
      service.unlockTaskFields('task-1', ['title', 'content']);

      expect(mockChangeTracker.unlockTaskField).toHaveBeenCalledTimes(2);
      expect(mockChangeTracker.unlockTaskField).toHaveBeenCalledWith(
        'task-1',
        'project-1',
        'title',
      );
      expect(mockChangeTracker.unlockTaskField).toHaveBeenCalledWith(
        'task-1',
        'project-1',
        'content',
      );
    });

    it('无活动项目时应直接返回，不调用解锁', () => {
      mockProjectState.activeProjectId.mockReturnValueOnce(null);

      service.unlockTaskFields('task-1', ['title']);

      expect(mockChangeTracker.unlockTaskField).not.toHaveBeenCalled();
    });
  });

  // ==================== onInputFocus ====================

  describe('onInputFocus', () => {
    it('聚焦 title 时应设置 isTitleFocused 并锁定 title 字段', () => {
      const task = createMockTask();

      service.onInputFocus('title', task);

      expect(service.isTitleFocused).toBe(true);
      expect(mockChangeTracker.lockTaskField).toHaveBeenCalledWith(
        'task-1',
        'project-1',
        'title',
        ChangeTrackerService.TEXT_INPUT_LOCK_TIMEOUT_MS,
      );
    });

    it('聚焦 content 时应设置 isContentFocused 并锁定 content 字段', () => {
      const task = createMockTask();

      service.onInputFocus('content', task);

      expect(service.isContentFocused).toBe(true);
      expect(mockChangeTracker.lockTaskField).toHaveBeenCalledWith(
        'task-1',
        'project-1',
        'content',
        ChangeTrackerService.TEXT_INPUT_LOCK_TIMEOUT_MS,
      );
    });

    it('重新聚焦时应清除该字段的已有解锁定时器', () => {
      vi.useFakeTimers();
      const task = createMockTask();

      // 先触发 blur 设置解锁定时器
      service.onInputFocus('title', task);
      service.onInputBlur('title', task);

      // 重新聚焦，定时器应被清除
      vi.clearAllMocks();
      service.onInputFocus('title', task);

      // 快进 10 秒，解锁定时器已被清除，不应调用 unlockTaskField
      vi.advanceTimersByTime(10000);

      expect(mockChangeTracker.unlockTaskField).not.toHaveBeenCalled();
      // title 应保持聚焦状态
      expect(service.isTitleFocused).toBe(true);

      vi.useRealTimers();
    });

    it('task 为 null 时应直接返回，不执行任何操作', () => {
      service.onInputFocus('title', null);

      expect(service.isTitleFocused).toBe(false);
      expect(mockChangeTracker.lockTaskField).not.toHaveBeenCalled();
    });
  });

  // ==================== onInputBlur ====================

  describe('onInputBlur', () => {
    it('title 失焦时应返回包含 localTitle 的事件数据', () => {
      vi.useFakeTimers();
      const task = createMockTask();
      // 设置 localTitle 值
      service.localTitle.set('Updated Title');

      const result = service.onInputBlur('title', task);

      expect(result).toEqual({
        field: 'title',
        taskId: 'task-1',
        value: 'Updated Title',
      });

      // 清理定时器，防止泄漏
      vi.runAllTimers();
      vi.useRealTimers();
    });

    it('content 失焦时应返回包含 localContent 的事件数据', () => {
      vi.useFakeTimers();
      const task = createMockTask();
      service.localContent.set('Updated Content');

      const result = service.onInputBlur('content', task);

      expect(result).toEqual({
        field: 'content',
        taskId: 'task-1',
        value: 'Updated Content',
      });

      vi.runAllTimers();
      vi.useRealTimers();
    });

    it('失焦后应设置 10 秒延迟解锁定时器', () => {
      vi.useFakeTimers();
      const task = createMockTask();

      // 先聚焦再失焦
      service.onInputFocus('title', task);
      vi.clearAllMocks();
      service.onInputBlur('title', task);

      // 定时器未触发前，title 应仍处于聚焦状态
      expect(service.isTitleFocused).toBe(true);

      // 9999ms 过去，解锁尚未执行
      vi.advanceTimersByTime(9999);
      expect(service.isTitleFocused).toBe(true);
      expect(mockChangeTracker.unlockTaskField).not.toHaveBeenCalled();

      // 10000ms 时触发解锁
      vi.advanceTimersByTime(1);
      expect(service.isTitleFocused).toBe(false);
      expect(mockChangeTracker.unlockTaskField).toHaveBeenCalledWith(
        'task-1',
        'project-1',
        'title',
      );

      vi.useRealTimers();
    });

    it('task 为 null 时应返回 null', () => {
      const result = service.onInputBlur('title', null);

      expect(result).toBeNull();
    });

    it('content 失焦后 10 秒定时器应解锁 content 字段', () => {
      vi.useFakeTimers();
      const task = createMockTask();

      service.onInputFocus('content', task);
      vi.clearAllMocks();
      service.onInputBlur('content', task);

      // 快进 10 秒
      vi.advanceTimersByTime(10000);

      expect(service.isContentFocused).toBe(false);
      expect(mockChangeTracker.unlockTaskField).toHaveBeenCalledWith(
        'task-1',
        'project-1',
        'content',
      );

      vi.useRealTimers();
    });
  });

  // ==================== onLocalTitleChange ====================

  describe('onLocalTitleChange', () => {
    it('应返回包含 taskId 和 title 的事件数据', () => {
      const task = createMockTask();

      const result = service.onLocalTitleChange('New Title', task);

      expect(result).toEqual({
        taskId: 'task-1',
        title: 'New Title',
      });
      // localTitle signal 也应被更新
      expect(service.localTitle()).toBe('New Title');
    });

    it('任务切换期间应返回 null（防止 ngModelChange 误发射）', () => {
      const task = createMockTask();

      // 模拟任务切换状态：通过访问私有属性
      (service as any).isTaskSwitching = true;

      const result = service.onLocalTitleChange('New Title', task);

      expect(result).toBeNull();
      // 日志应记录跳过原因
      expect(mockLoggerCategory.debug).toHaveBeenCalledWith(
        '任务切换中，跳过 titleChange 发射',
      );
    });

    it('task 为 null 时应返回 null', () => {
      const result = service.onLocalTitleChange('New Title', null);

      expect(result).toBeNull();
      // localTitle 仍然应被更新（set 在 null 检查之前执行）
      expect(service.localTitle()).toBe('New Title');
    });
  });

  // ==================== onLocalContentChange ====================

  describe('onLocalContentChange', () => {
    it('应返回包含 taskId 和 content 的事件数据', () => {
      const task = createMockTask();

      const result = service.onLocalContentChange('New Content', task);

      expect(result).toEqual({
        taskId: 'task-1',
        content: 'New Content',
      });
      expect(service.localContent()).toBe('New Content');
    });

    it('任务切换期间应返回 null', () => {
      const task = createMockTask();
      (service as any).isTaskSwitching = true;

      const result = service.onLocalContentChange('New Content', task);

      expect(result).toBeNull();
      expect(mockLoggerCategory.debug).toHaveBeenCalledWith(
        '任务切换中，跳过 contentChange 发射',
      );
    });

    it('task 为 null 时应返回 null', () => {
      const result = service.onLocalContentChange('New Content', null);

      expect(result).toBeNull();
    });
  });

  // ==================== toggleEditMode ====================

  describe('toggleEditMode', () => {
    it('应切换 isEditMode 状态（false → true）', () => {
      vi.useFakeTimers();

      expect(service.isEditMode()).toBe(false);

      service.toggleEditMode();

      expect(service.isEditMode()).toBe(true);

      vi.runAllTimers();
      vi.useRealTimers();
    });

    it('应切换 isEditMode 状态（true → false）', () => {
      vi.useFakeTimers();

      // 先切换到编辑模式
      service.toggleEditMode();
      expect(service.isEditMode()).toBe(true);

      // 等待节流期结束
      vi.advanceTimersByTime(300);

      // 再切换回预览模式
      service.toggleEditMode();
      expect(service.isEditMode()).toBe(false);

      vi.runAllTimers();
      vi.useRealTimers();
    });

    it('300ms 内第二次调用应被节流忽略（防止 Rage Click）', () => {
      vi.useFakeTimers();

      // 第一次点击：false → true
      service.toggleEditMode();
      expect(service.isEditMode()).toBe(true);
      expect(service.isTogglingMode()).toBe(true);

      // 200ms 后第二次点击：应被忽略
      vi.advanceTimersByTime(200);
      service.toggleEditMode();
      expect(service.isEditMode()).toBe(true); // 状态未改变

      // 300ms 后节流解除
      vi.advanceTimersByTime(100);
      expect(service.isTogglingMode()).toBe(false);

      // 此时可以再次切换
      service.toggleEditMode();
      expect(service.isEditMode()).toBe(false);

      vi.runAllTimers();
      vi.useRealTimers();
    });
  });

  // ==================== shouldExitEditMode ====================

  describe('shouldExitEditMode', () => {
    let containerEl: HTMLElement;

    beforeEach(() => {
      containerEl = document.createElement('div');
    });

    it('非编辑模式下应返回 false', () => {
      // isEditMode 默认为 false
      const target = document.createElement('div');

      const result = service.shouldExitEditMode(target, containerEl);

      expect(result).toBe(false);
    });

    it('点击 INPUT 元素时应返回 false（保持编辑模式）', () => {
      vi.useFakeTimers();
      service.toggleEditMode();

      const inputEl = document.createElement('input');
      containerEl.appendChild(inputEl);

      const result = service.shouldExitEditMode(inputEl, containerEl);

      expect(result).toBe(false);

      vi.runAllTimers();
      vi.useRealTimers();
    });

    it('点击 TEXTAREA 元素时应返回 false', () => {
      vi.useFakeTimers();
      service.toggleEditMode();

      const textareaEl = document.createElement('textarea');
      containerEl.appendChild(textareaEl);

      const result = service.shouldExitEditMode(textareaEl, containerEl);

      expect(result).toBe(false);

      vi.runAllTimers();
      vi.useRealTimers();
    });

    it('点击 BUTTON 元素时应返回 false', () => {
      vi.useFakeTimers();
      service.toggleEditMode();

      const buttonEl = document.createElement('button');
      containerEl.appendChild(buttonEl);

      const result = service.shouldExitEditMode(buttonEl, containerEl);

      expect(result).toBe(false);

      vi.runAllTimers();
      vi.useRealTimers();
    });

    it('点击 svg 元素时应返回 false', () => {
      vi.useFakeTimers();
      service.toggleEditMode();

      const svgEl = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      containerEl.appendChild(svgEl);

      // svg 的 tagName 是小写的 'svg'
      const result = service.shouldExitEditMode(svgEl as unknown as HTMLElement, containerEl);

      expect(result).toBe(false);

      vi.runAllTimers();
      vi.useRealTimers();
    });

    it('点击非交互区域时应返回 true（退出编辑模式）', () => {
      vi.useFakeTimers();
      service.toggleEditMode();

      // 模拟无文字选中
      vi.spyOn(window, 'getSelection').mockReturnValue({
        toString: () => '',
      } as Selection);

      const divEl = document.createElement('div');
      containerEl.appendChild(divEl);

      const result = service.shouldExitEditMode(divEl, containerEl);

      expect(result).toBe(true);

      vi.runAllTimers();
      vi.useRealTimers();
    });

    it('正在进行文字选择时应返回 false', () => {
      vi.useFakeTimers();
      service.toggleEditMode();
      service.isSelecting = true;

      const divEl = document.createElement('div');

      const result = service.shouldExitEditMode(divEl, containerEl);

      expect(result).toBe(false);

      service.isSelecting = false;
      vi.runAllTimers();
      vi.useRealTimers();
    });

    it('存在文字选中时应返回 false', () => {
      vi.useFakeTimers();
      service.toggleEditMode();

      vi.spyOn(window, 'getSelection').mockReturnValue({
        toString: () => 'selected text',
        length: 13,
      } as unknown as Selection);

      const divEl = document.createElement('div');

      const result = service.shouldExitEditMode(divEl, containerEl);

      expect(result).toBe(false);

      vi.runAllTimers();
      vi.useRealTimers();
    });

    it('点击 button 内部子元素时应返回 false（closest 检查）', () => {
      vi.useFakeTimers();
      service.toggleEditMode();

      const buttonEl = document.createElement('button');
      const spanEl = document.createElement('span');
      buttonEl.appendChild(spanEl);
      containerEl.appendChild(buttonEl);

      const result = service.shouldExitEditMode(spanEl, containerEl);

      expect(result).toBe(false);

      vi.runAllTimers();
      vi.useRealTimers();
    });
  });

  // ==================== cleanup ====================

  describe('cleanup', () => {
    it('应清除所有解锁定时器', () => {
      vi.useFakeTimers();
      const task = createMockTask();

      // 设置 title 和 content 的解锁定时器
      service.onInputFocus('title', task);
      service.onInputBlur('title', task);
      service.onInputFocus('content', task);
      service.onInputBlur('content', task);
      vi.clearAllMocks();

      // 清理
      service.cleanup();

      // 快进 10 秒，定时器已被清除，不应调用 unlockTaskField
      vi.advanceTimersByTime(10000);

      expect(mockChangeTracker.unlockTaskField).not.toHaveBeenCalled();

      vi.useRealTimers();
    });

    it('无定时器时调用 cleanup 不应抛错', () => {
      expect(() => service.cleanup()).not.toThrow();
    });
  });
});
