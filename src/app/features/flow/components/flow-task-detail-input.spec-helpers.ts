import { signal } from '@angular/core';
import type { ComponentFixture } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';

import type { Task } from '../../../../models';
import type { FlowTaskDetailComponent } from './flow-task-detail.component';

interface FlowTaskDetailInputSpecContext {
  component: FlowTaskDetailComponent;
  fixture: ComponentFixture<FlowTaskDetailComponent>;
  mockChangeTracker: {
    lockTaskField: ReturnType<typeof vi.fn>;
  };
  mockFlowTaskOps: {
    parkTask: ReturnType<typeof vi.fn>;
    addQuickTodo: ReturnType<typeof vi.fn>;
  };
  createMockTask(id: string, title: string, content: string): Task;
}

export function registerFlowTaskDetailInputSpecs(
  getContext: () => FlowTaskDetailInputSpecContext,
): void {
  const getComponent = (): FlowTaskDetailComponent => getContext().component;
  const getFixture = (): ComponentFixture<FlowTaskDetailComponent> => getContext().fixture;
  const getMockChangeTracker = (): FlowTaskDetailInputSpecContext['mockChangeTracker'] => getContext().mockChangeTracker;
  const getMockFlowTaskOps = (): FlowTaskDetailInputSpecContext['mockFlowTaskOps'] => getContext().mockFlowTaskOps;
  const createMockTask = (id: string, title: string, content: string): Task =>
    getContext().createMockTask(id, title, content);

  describe('输入处理', () => {
    it('应该在标题变更时发射事件', async () => {
      const task = createMockTask('task-a', 'Task A', 'Content A');
      (getComponent() as any)['task'] = signal(task);
      getFixture().detectChanges();
      
      // 🔴 等待 queueMicrotask 完成，确保 isTaskSwitching 标志被重置
      await Promise.resolve();

      let emittedEvent: any;
      getComponent().titleChange.subscribe((event) => {
        emittedEvent = event;
      });

      getComponent().onLocalTitleChange('New Title');

      expect(emittedEvent).toEqual({ taskId: 'task-a', title: 'New Title' });
      expect(getComponent()['localTitle']()).toBe('New Title');
    });

    it('应该在内容变更时发射事件', async () => {
      const task = createMockTask('task-a', 'Task A', 'Content A');
      (getComponent() as any)['task'] = signal(task);
      getFixture().detectChanges();
      
      // 🔴 等待 queueMicrotask 完成，确保 isTaskSwitching 标志被重置
      await Promise.resolve();

      let emittedEvent: any;
      getComponent().contentChange.subscribe((event) => {
        emittedEvent = event;
      });

      getComponent().onLocalContentChange('New Content');

      expect(emittedEvent).toEqual({ taskId: 'task-a', content: 'New Content' });
      expect(getComponent()['localContent']()).toBe('New Content');
    });

    it('应该在聚焦时锁定字段', () => {
      const task = createMockTask('task-a', 'Task A', 'Content A');
      (getComponent() as any)['task'] = signal(task);
      getFixture().detectChanges();

      getComponent().onInputFocus('title');

      expect(getMockChangeTracker().lockTaskField).toHaveBeenCalledWith(
        'task-a',
        'project-1',
        'title',
        expect.any(Number)
      );
      expect(getComponent().formService.isTitleFocused).toBe(true);
    });

    it('点击停泊按钮时应发射 parkTask 事件', async () => {
      const task = createMockTask('task-a', 'Task A', 'Content A');
      (getComponent() as any)['task'] = signal(task);
      getFixture().detectChanges();

      let emittedTask: any = null;
      getComponent().parkTask.subscribe((event) => {
        emittedTask = event;
      });

      const parkButton = getFixture().nativeElement.querySelector('[data-testid="flow-task-park-button"]') as HTMLButtonElement | null;
      parkButton?.click();
      await Promise.resolve();

      expect(getMockFlowTaskOps().parkTask).toHaveBeenCalledWith(task);
      expect(emittedTask?.id).toBe('task-a');
    });

    it('quick todo should keep input value when local durable add fails', async () => {
      const task = createMockTask('task-a', 'Task A', 'Content A');
      (getComponent() as any)['task'] = signal(task);
      getMockFlowTaskOps().addQuickTodo.mockResolvedValueOnce(false);
      const input = document.createElement('input');
      input.value = '  检查 outbox  ';
      const focusSpy = vi.spyOn(input, 'focus');

      const saved = await getComponent().addQuickTodo('task-a', input);

      expect(saved).toBe(false);
      expect(getMockFlowTaskOps().addQuickTodo).toHaveBeenCalledWith('task-a', '检查 outbox');
      expect(input.value).toBe('  检查 outbox  ');
      expect(focusSpy).not.toHaveBeenCalled();
    });

    it('未停泊任务点击提醒按钮时应先发射 parkTask 事件并打开提醒菜单', async () => {
      const task = createMockTask('task-a', 'Task A', 'Content A');
      (getComponent() as any)['task'] = signal(task);
      getFixture().detectChanges();

      let emittedTask: any = null;
      getComponent().parkTask.subscribe((event) => {
        emittedTask = event;
      });

      const reminderButton = getFixture().nativeElement.querySelector('[data-testid="flow-task-reminder-trigger"]') as HTMLButtonElement | null;
      reminderButton?.click();
      await Promise.resolve();
      getFixture().detectChanges();

      expect(getMockFlowTaskOps().parkTask).toHaveBeenCalledWith(task);
      expect(emittedTask?.id).toBe('task-a');
      expect(getComponent().showReminderMenu()).toBe(true);
    });

    it('应该在失焦时延迟解锁字段', async () => {
      // 使用 fake timers 加速测试
      vi.useFakeTimers();

      const task = createMockTask('task-a', 'Task A', 'Content A');
      (getComponent() as any)['task'] = signal(task);
      getFixture().detectChanges();

      getComponent().onInputFocus('title');
      getComponent().onInputBlur('title');

      // 验证定时器已创建
      expect(getComponent().formService['unlockTimers'].size).toBe(1);
      expect(getComponent().formService.isTitleFocused).toBe(true); // 仍然为 true（延迟解锁）

      // 使用 fake timers 快进 10.1 秒
      await vi.advanceTimersByTimeAsync(10100);

      expect(getComponent().formService.isTitleFocused).toBe(false);
      expect(getComponent().formService['unlockTimers'].size).toBe(0);
      
      vi.useRealTimers();
    }, 5000);

    it('点击任务 markdown 链接时应发射 openLinkedTask，而不是进入编辑态', () => {
      const emitSpy = vi.spyOn(getComponent().openLinkedTask, 'emit');
      const anchor = document.createElement('a');
      anchor.setAttribute('href', '#task:linked-task');
      anchor.setAttribute('data-link-kind', 'task');
      anchor.setAttribute('data-task-link-id', 'linked-task');
      const stopPropagation = vi.fn();
      const preventDefault = vi.fn();

      getComponent().onPreviewClick({ target: anchor, stopPropagation, preventDefault } as unknown as MouseEvent);

      expect(stopPropagation).toHaveBeenCalled();
      expect(preventDefault).toHaveBeenCalled();
      expect(emitSpy).toHaveBeenCalledWith('linked-task');
      expect(getComponent().isEditMode()).toBe(false);
    });

    it('点击外链时应保持预览态', () => {
      const anchor = document.createElement('a');
      anchor.setAttribute('href', 'https://example.com');
      anchor.setAttribute('data-link-kind', 'external');
      const stopPropagation = vi.fn();
      const preventDefault = vi.fn();

      getComponent().onPreviewClick({ target: anchor, stopPropagation, preventDefault } as unknown as MouseEvent);

      expect(stopPropagation).toHaveBeenCalled();
      expect(preventDefault).not.toHaveBeenCalled();
      expect(getComponent().isEditMode()).toBe(false);
    });

    it('点击 blocked 链接时应阻止默认行为并保持预览态', () => {
      const emitSpy = vi.spyOn(getComponent().openLinkedTask, 'emit');
      const anchor = document.createElement('a');
      anchor.setAttribute('href', '#__nf_blocked__');
      anchor.setAttribute('data-link-kind', 'blocked');
      const stopPropagation = vi.fn();
      const preventDefault = vi.fn();

      getComponent().onPreviewClick({ target: anchor, stopPropagation, preventDefault } as unknown as MouseEvent);

      expect(stopPropagation).toHaveBeenCalled();
      expect(preventDefault).toHaveBeenCalled();
      expect(emitSpy).not.toHaveBeenCalled();
      expect(getComponent().isEditMode()).toBe(false);
    });

    it('点击本地路径链接时应尝试打开并保持预览态', async () => {
      const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
      const writeText = vi.fn().mockResolvedValue(undefined);
      const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText },
      });

      try {
        const anchor = document.createElement('a');
        anchor.setAttribute('href', '#local-path');
        anchor.setAttribute('data-link-kind', 'local');
        anchor.setAttribute('data-local-link-path', 'C:\\Docs\\Plan.md');
        const stopPropagation = vi.fn();
        const preventDefault = vi.fn();

        getComponent().onPreviewClick({ target: anchor, stopPropagation, preventDefault } as unknown as MouseEvent);
        await Promise.resolve();

        expect(stopPropagation).toHaveBeenCalled();
        expect(preventDefault).toHaveBeenCalled();
        expect(getComponent().isEditMode()).toBe(false);
        expect(writeText).toHaveBeenCalledWith('C:\\Docs\\Plan.md');
        expect(clickSpy).toHaveBeenCalled();
      } finally {
        clickSpy.mockRestore();
        if (originalClipboard) {
          Object.defineProperty(navigator, 'clipboard', originalClipboard);
        } else {
          Reflect.deleteProperty(navigator as object, 'clipboard');
        }
      }
    });
  });
}
