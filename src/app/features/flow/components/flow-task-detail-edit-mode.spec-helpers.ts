import { signal } from '@angular/core';
import type { ComponentFixture } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';

import type { Task } from '../../../../models';
import type { FlowTaskDetailComponent } from './flow-task-detail.component';

interface FlowTaskDetailEditModeSpecContext {
  component: FlowTaskDetailComponent;
  fixture: ComponentFixture<FlowTaskDetailComponent>;
  createClickEvent(timeStamp: number, target?: HTMLElement): MouseEvent;
  createMockTask(id: string, title: string, content: string): Task;
}

export function registerFlowTaskDetailEditModeSpecs(
  getContext: () => FlowTaskDetailEditModeSpecContext,
): void {
  const getComponent = (): FlowTaskDetailComponent => getContext().component;
  const getFixture = (): ComponentFixture<FlowTaskDetailComponent> => getContext().fixture;
  const createClickEvent = (timeStamp: number, target?: HTMLElement): MouseEvent =>
    getContext().createClickEvent(timeStamp, target);
  const createMockTask = (id: string, title: string, content: string): Task =>
    getContext().createMockTask(id, title, content);

  describe('编辑模式切换', () => {
    it('应该正确切换编辑模式', async () => {
      // 使用 fake timers 避免等待真实的 350ms
      vi.useFakeTimers();
      
      const task = createMockTask('task-a', 'Task A', 'Content A');
      (getComponent() as any)['task'] = signal(task);
      getFixture().detectChanges();

      expect(getComponent().isEditMode()).toBe(false);

      getComponent().toggleEditMode();
      expect(getComponent().isEditMode()).toBe(true);

      // 使用 fake timers 快进节流时间（300ms + 余量）
      await vi.advanceTimersByTimeAsync(350);

      getComponent().toggleEditMode();
      expect(getComponent().isEditMode()).toBe(false);
      
      vi.useRealTimers();
    });

    it('应该防止快速连续切换（节流保护）', () => {
      const task = createMockTask('task-a', 'Task A', 'Content A');
      (getComponent() as any)['task'] = signal(task);
      getFixture().detectChanges();

      getComponent().toggleEditMode();
      expect(getComponent().isEditMode()).toBe(true);
      expect(getComponent()['isTogglingMode']()).toBe(true);

      // 快速再次点击应被忽略
      getComponent().toggleEditMode();
      expect(getComponent().isEditMode()).toBe(true); // 仍然是 true
    });

    it('编辑切换按钮只应在节流窗口内禁用', async () => {
      vi.useFakeTimers();

      const task = createMockTask('task-a', 'Task A', 'Content A');
      (getComponent() as any)['task'] = signal(task);
      getFixture().detectChanges();

      const editButton = getFixture().nativeElement.querySelector('[data-testid="flow-edit-toggle-btn"]') as HTMLButtonElement | null;
      expect(editButton?.disabled).toBe(false);

      getComponent().toggleEditMode();
      getFixture().detectChanges();
      expect(editButton?.disabled).toBe(true);

      await vi.advanceTimersByTimeAsync(300);
      getFixture().detectChanges();
      expect(editButton?.disabled).toBe(false);

      vi.clearAllTimers();
      vi.useRealTimers();
    });

    it('任务切换后立刻点击预览区不应进入编辑态或卡住节流', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-03-11T00:00:00.000Z'));

      const taskA = createMockTask('task-a', 'Task A', 'Content A');
      const taskB = createMockTask('task-b', 'Task B', 'Content B');

      (getComponent() as any)['task'] = signal(taskA);
      getFixture().detectChanges();

      (getComponent() as any)['task'].set(taskB);
      getFixture().detectChanges();

      getComponent().onPreviewClick(createClickEvent(100));

      expect(getComponent().isEditMode()).toBe(false);
      expect(getComponent()['isTogglingMode']()).toBe(false);

      vi.useRealTimers();
    });

    it('预览区主动进入编辑态时，同一点击不应被 document:click 立即撤销', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-03-11T00:00:00.000Z'));

      const task = createMockTask('task-a', 'Task A', 'Content A');
      (getComponent() as any)['task'] = signal(task);
      getFixture().detectChanges();

      vi.advanceTimersByTime(181);

      const previewClick = createClickEvent(200);
      getComponent().onPreviewClick(previewClick);
      getComponent().onDocumentClick(previewClick);

      expect(getComponent().isEditMode()).toBe(true);

      vi.useRealTimers();
    });

    it('任务刚切换后的编辑按钮应确保保留编辑态，而不是把意外编辑态切回预览', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-03-11T00:00:00.000Z'));

      const task = createMockTask('task-a', 'Task A', 'Content A');
      (getComponent() as any)['task'] = signal(task);
      getFixture().detectChanges();

      getComponent().isEditMode.set(true);
      getComponent()['isTogglingMode'].set(true);

      getComponent().onEditToggleClick();

      expect(getComponent().isEditMode()).toBe(true);
      expect(getComponent()['isTogglingMode']()).toBe(false);

      vi.useRealTimers();
    });

    it('后续新的 document:click 仍应正常退出编辑态', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-03-11T00:00:00.000Z'));

      const task = createMockTask('task-a', 'Task A', 'Content A');
      (getComponent() as any)['task'] = signal(task);
      getFixture().detectChanges();

      vi.advanceTimersByTime(181);

      getComponent().onPreviewClick(createClickEvent(300));
      expect(getComponent().isEditMode()).toBe(true);

      getComponent().onDocumentClick(createClickEvent(301));
      expect(getComponent().isEditMode()).toBe(false);
      expect(getComponent()['isTogglingMode']()).toBe(false);

      vi.useRealTimers();
    });

    it('存在文本选区时第一次外部点击应只清空选区，第二次才退出编辑态', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-03-11T00:00:00.000Z'));

      const task = createMockTask('task-a', 'Task A', 'Content A');
      (getComponent() as any)['task'] = signal(task);
      getFixture().detectChanges();

      vi.advanceTimersByTime(181);

      getComponent().onPreviewClick(createClickEvent(400));
      expect(getComponent().isEditMode()).toBe(true);

      let selectionActive = true;
      const removeAllRanges = vi.fn(() => {
        selectionActive = false;
      });
      const getSelectionSpy = vi.spyOn(window, 'getSelection').mockReturnValue({
        toString: () => selectionActive ? 'Task' : '',
        rangeCount: selectionActive ? 1 : 0,
        isCollapsed: !selectionActive,
        removeAllRanges,
      } as unknown as Selection);

      try {
        getComponent().onDocumentClick(createClickEvent(401));

        expect(removeAllRanges).toHaveBeenCalledTimes(1);
        expect(getComponent().isEditMode()).toBe(true);

        getComponent().onDocumentClick(createClickEvent(402));

        expect(getComponent().isEditMode()).toBe(false);
        expect(getComponent()['isTogglingMode']()).toBe(false);
      } finally {
        getSelectionSpy.mockRestore();
      }

      vi.useRealTimers();
    });
  });
}
