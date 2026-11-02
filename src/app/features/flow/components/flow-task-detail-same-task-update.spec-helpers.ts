import { signal } from '@angular/core';
import type { ComponentFixture } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';

import type { Task } from '../../../../models';
import type { FlowTaskDetailComponent } from './flow-task-detail.component';

interface FlowTaskDetailSameTaskUpdateSpecContext {
  component: FlowTaskDetailComponent;
  fixture: ComponentFixture<FlowTaskDetailComponent>;
  mockTaskOpsAdapter: {
    updateTaskContent: ReturnType<typeof vi.fn>;
  };
  mockUndoService: {
    appliedReplay: ReturnType<typeof signal>;
  };
  createMockTask: (id: string, title: string, content: string) => Task;
}

export function registerFlowTaskDetailSameTaskUpdateSpecs(
  getContext: () => FlowTaskDetailSameTaskUpdateSpecContext,
): void {
  describe('同一任务的更新', () => {
    it('应该在内容更新且未聚焦时同步 localContent', () => {
      const { component, createMockTask, fixture } = getContext();
      const task = createMockTask('task-a', 'Task A', 'Content A');
      (component as any)['task'] = signal(task);
      fixture.detectChanges();

      expect(component['localContent']()).toBe('Content A');

      (component as any)['task'].set({ ...task, content: 'Updated Content A' });
      fixture.detectChanges();

      expect(component['localContent']()).toBe('Updated Content A');
    });

    it('应该在内容更新但已聚焦时保持 localContent 不变', () => {
      const { component, createMockTask, fixture } = getContext();
      const task = createMockTask('task-a', 'Task A', 'Content A');
      (component as any)['task'] = signal(task);
      fixture.detectChanges();

      component.onInputFocus('content');
      component['localContent'].set('Local Edit');
      (component as any)['task'].set({ ...task, content: 'Remote Update' });
      fixture.detectChanges();

      expect(component['localContent']()).toBe('Local Edit');
    });

    it('内容失焦提交后父任务仍回传旧内容时应保留未确认草稿', async () => {
      const { component, createMockTask, fixture } = getContext();
      vi.useFakeTimers();
      const task = createMockTask('task-a', 'Task A', 'Content A');
      const taskSignal = signal(task);
      (component as any)['task'] = taskSignal;
      fixture.detectChanges();
      await Promise.resolve();

      component.onInputFocus('content');
      component.onLocalContentChange('Offline Draft');
      component.onInputBlur('content');
      await vi.advanceTimersByTimeAsync(10100);

      taskSignal.set({
        ...task,
        content: 'Content A',
        updatedAt: '2025-12-31T00:01:00Z',
      });
      fixture.detectChanges();

      expect(component['localContent']()).toBe('Offline Draft');
    });

    it('点击预览待办项时应等待本地持久化成功后再提交本地内容', async () => {
      const { component, createMockTask, fixture, mockTaskOpsAdapter } = getContext();
      let resolveSave!: (saved: boolean) => void;
      mockTaskOpsAdapter.updateTaskContent.mockReturnValueOnce(
        new Promise<boolean>(resolve => {
          resolveSave = resolve;
        }),
      );
      const task = createMockTask('task-a', 'Task A', '- [ ] Durable todo');
      (component as any)['task'] = signal(task);
      fixture.detectChanges();
      const checkbox = document.createElement('button');
      checkbox.setAttribute('data-todo-index', '0');
      const stopPropagation = vi.fn();

      const previewResult = component.onPreviewClick({
        target: checkbox,
        stopPropagation,
      } as unknown as MouseEvent);

      expect(stopPropagation).toHaveBeenCalled();
      expect(mockTaskOpsAdapter.updateTaskContent).toHaveBeenCalledWith('task-a', '- [x] Durable todo');
      expect(component['localContent']()).toBe('- [ ] Durable todo');

      resolveSave(true);
      await previewResult;

      expect(component['localContent']()).toBe('- [x] Durable todo');
    });

    it('点击预览待办项本地持久化失败时不应留下本地内容变化', async () => {
      const { component, createMockTask, fixture, mockTaskOpsAdapter } = getContext();
      mockTaskOpsAdapter.updateTaskContent.mockResolvedValueOnce(false);
      const task = createMockTask('task-a', 'Task A', '- [ ] Durable todo');
      (component as any)['task'] = signal(task);
      fixture.detectChanges();
      const checkbox = document.createElement('button');
      checkbox.setAttribute('data-todo-index', '0');

      await component.onPreviewClick({
        target: checkbox,
        stopPropagation: vi.fn(),
      } as unknown as MouseEvent);

      expect(mockTaskOpsAdapter.updateTaskContent).toHaveBeenCalledWith('task-a', '- [x] Durable todo');
      expect(component['localContent']()).toBe('- [ ] Durable todo');
    });

    it('应该在撤销回放命中当前任务内容时覆盖聚焦中的本地缓冲', () => {
      const { component, createMockTask, fixture, mockUndoService } = getContext();
      const task = createMockTask('task-a', 'Task A', 'Content A');
      (component as any)['task'] = signal(task);
      fixture.detectChanges();

      component.onInputFocus('content');
      component['localContent'].set('');
      (component as any)['task'].set({ ...task, content: 'Recovered Content' });
      fixture.detectChanges();
      expect(component['localContent']()).toBe('');

      mockUndoService.appliedReplay.set({
        sequence: 1,
        kind: 'undo',
        projectId: 'project-1',
        taskFieldChanges: { 'task-a': ['content'] },
      });
      fixture.detectChanges();

      expect(component['localContent']()).toBe('Recovered Content');

      component['localContent'].set('Resume Edit');
      (component as any)['task'].set({ ...task, content: 'Remote Update After Replay' });
      fixture.detectChanges();

      expect(component['localContent']()).toBe('Resume Edit');
    });
  });
}
