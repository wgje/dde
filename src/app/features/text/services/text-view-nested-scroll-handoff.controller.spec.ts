import { describe, expect, it, vi } from 'vitest';

import { TextViewNestedScrollHandoffController } from './text-view-nested-scroll-handoff.controller';

function defineScrollMetrics(element: HTMLElement, metrics: { top?: number; clientHeight: number; scrollHeight: number }): void {
  Object.defineProperty(element, 'scrollTop', {
    configurable: true,
    writable: true,
    value: metrics.top ?? 0,
  });
  Object.defineProperty(element, 'clientHeight', {
    configurable: true,
    value: metrics.clientHeight,
  });
  Object.defineProperty(element, 'scrollHeight', {
    configurable: true,
    value: metrics.scrollHeight,
  });
}

function createController() {
  return new TextViewNestedScrollHandoffController({
    zone: {
      runOutsideAngular: (fn: () => void) => fn(),
    } as never,
  });
}

describe('TextViewNestedScrollHandoffController', () => {
  it('routes wheel deltas from a nested task list to the task list and stage scroller', () => {
    vi.stubGlobal('MutationObserver', class {
      observe() {}
      disconnect() {}
    });
    const controller = createController();
    const root = document.createElement('div');
    const stageScroller = document.createElement('div');
    const taskList = document.createElement('div');
    const rafSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback: FrameRequestCallback) => {
      callback(0);
      return 0;
    });

    try {
      stageScroller.setAttribute('data-stage-scroll-container', '');
      taskList.setAttribute('data-stage-task-list', '1');
      stageScroller.appendChild(taskList);
      root.appendChild(stageScroller);
      document.body.appendChild(root);
      defineScrollMetrics(root, { clientHeight: 600, scrollHeight: 1200 });
      defineScrollMetrics(stageScroller, { clientHeight: 300, scrollHeight: 900 });
      defineScrollMetrics(taskList, { clientHeight: 120, scrollHeight: 360 });

      controller.attach(root);
      const event = new WheelEvent('wheel', { cancelable: true, deltaY: 100 });
      const prevented = !taskList.dispatchEvent(event);

      expect(prevented).toBe(true);
      expect(taskList.scrollTop).toBeGreaterThan(0);
      expect(stageScroller.scrollTop).toBeGreaterThan(0);
    } finally {
      controller.detach();
      root.remove();
      rafSpy.mockRestore();
    }
  });

  it('continues detach cleanup when one nested task list cleanup throws', () => {
    vi.stubGlobal('MutationObserver', class {
      observe() {}
      disconnect() {}
    });
    const controller = createController();
    const root = document.createElement('div');
    const firstTaskList = document.createElement('div');
    const secondTaskList = document.createElement('div');
    const secondRemoveEventListener = vi.spyOn(secondTaskList, 'removeEventListener');
    vi.spyOn(firstTaskList, 'removeEventListener').mockImplementation(() => {
      throw new Error('remove failed');
    });

    firstTaskList.setAttribute('data-stage-task-list', '1');
    secondTaskList.setAttribute('data-stage-task-list', '1');
    root.append(firstTaskList, secondTaskList);

    const internals = controller as unknown as {
      nestedTaskListCleanups: Map<HTMLElement, () => void>;
    };

    try {
      controller.attach(root);

      expect(() => controller.detach()).not.toThrow();
      expect(secondRemoveEventListener).toHaveBeenCalled();
      expect(internals.nestedTaskListCleanups.size).toBe(0);
    } finally {
      internals.nestedTaskListCleanups.clear();
      controller.detach();
    }
  });
});
