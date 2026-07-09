import { signal } from '@angular/core';
import type { ComponentFixture } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';

import type { Task } from '../../../../models';
import type { FlowTaskDetailComponent } from './flow-task-detail.component';

interface FlowTaskDetailDrawerHeightSpecContext {
  component: FlowTaskDetailComponent;
  fixture: ComponentFixture<FlowTaskDetailComponent>;
  mockUiState: {
    isMobile: { set(value: boolean): void };
    isFlowDetailOpen: { set(value: boolean): void };
  };
  createMockTask(id: string, title: string, content: string): Task;
}

export function registerFlowTaskDetailDrawerHeightSpecs(
  getContext: () => FlowTaskDetailDrawerHeightSpecContext,
): void {
  const getComponent = (): FlowTaskDetailComponent => getContext().component;
  const getFixture = (): ComponentFixture<FlowTaskDetailComponent> => getContext().fixture;
  const getMockUiState = (): FlowTaskDetailDrawerHeightSpecContext['mockUiState'] => getContext().mockUiState;
  const createMockTask = (id: string, title: string, content: string): Task =>
    getContext().createMockTask(id, title, content);

  describe('移动端抽屉高度自适应', () => {
    it('自动高度模式下不应隐藏操作区（删除按钮必须可见）', () => {
      (getComponent() as any)['autoHeightEnabled'] = signal(true);
      (getComponent() as any)['drawerHeight'] = signal(8.5);

      expect(getComponent().isCompactMode()).toBe(false);
    });

    it('手动拖拽模式下允许进入紧凑态', () => {
      (getComponent() as any)['autoHeightEnabled'] = signal(false);
      (getComponent() as any)['drawerHeight'] = signal(8.5);

      expect(getComponent().isCompactMode()).toBe(true);
    });

    it('销毁时应移除进行中的抽屉 resize 全局监听', () => {
      const addSpy = vi.spyOn(window, 'addEventListener');
      const removeSpy = vi.spyOn(window, 'removeEventListener');

      getComponent().startDrawerResize(new MouseEvent('mousedown', { clientY: 320 }));

      const drawerResizeEventTypes = ['touchmove', 'touchend', 'touchcancel', 'mousemove', 'mouseup'];
      expect(addSpy.mock.calls.filter(([type]) => drawerResizeEventTypes.includes(String(type))).length).toBe(5);

      getFixture().destroy();

      for (const eventType of drawerResizeEventTypes) {
        expect(removeSpy).toHaveBeenCalledWith(eventType, expect.any(Function));
      }
    });

    it('拖拽抽屉手柄时按视口比例更新高度并限制范围', () => {
      const heightSpy = vi.spyOn(getComponent().drawerHeightChange, 'emit');
      const originalRaf = globalThis.requestAnimationFrame;
      const originalCancelRaf = globalThis.cancelAnimationFrame;
      const addSpy = vi.spyOn(window, 'addEventListener');
      const innerHeightSpy = vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(1000);
      let pendingFrame: FrameRequestCallback | null = null;
      const runPendingFrame = () => {
        const frame = pendingFrame;
        if (frame) {
          frame(0);
        }
      };
      globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
        pendingFrame = callback;
        return 1;
      }) as typeof requestAnimationFrame;
      globalThis.cancelAnimationFrame = vi.fn() as typeof cancelAnimationFrame;
      (getComponent() as any)['drawerHeight'] = signal(30);

      try {
        getComponent().startDrawerResize(new MouseEvent('mousedown', { clientY: 300 }));
        const mouseMove = addSpy.mock.calls.find(([type]) => type === 'mousemove')?.[1] as EventListener;

        mouseMove(new MouseEvent('mousemove', { clientY: 500 }));
        runPendingFrame();
        mouseMove(new MouseEvent('mousemove', { clientY: 2000 }));
        runPendingFrame();
        mouseMove(new MouseEvent('mousemove', { clientY: -2000 }));
        runPendingFrame();

        expect(heightSpy).toHaveBeenNthCalledWith(1, 50);
        expect(heightSpy).toHaveBeenNthCalledWith(2, 70);
        expect(heightSpy).toHaveBeenNthCalledWith(3, 8);
      } finally {
        innerHeightSpy.mockRestore();
        globalThis.requestAnimationFrame = originalRaf;
        globalThis.cancelAnimationFrame = originalCancelRaf;
        (getComponent() as any).cleanupDrawerResizeListeners();
      }
    });

    it('任务无关字段变化不应重复触发重测签名', () => {
      const task = createMockTask('task-a', 'Task A', 'Content A');
      (getComponent() as any)['task'] = signal(task);
      (getComponent() as any)['autoHeightEnabled'] = signal(true);
      getMockUiState().isMobile.set(true);
      getMockUiState().isFlowDetailOpen.set(true);
      getFixture().detectChanges();

      const signature = (getComponent() as any).lastAutoHeightSignature;
      (getComponent() as any)['task'].set({ ...task, x: 88, y: 99 });
      getFixture().detectChanges();

      expect((getComponent() as any).lastAutoHeightSignature).toBe(signature);
    });

    it('幂等算法：重复调用 measureAndEmitHeight 不应多次 emit', async () => {
      vi.useFakeTimers();
      const originalRaf = globalThis.requestAnimationFrame;
      const originalCancelRaf = globalThis.cancelAnimationFrame;

      globalThis.requestAnimationFrame = ((cb: FrameRequestCallback): number => {
        cb(0);
        return 1;
      }) as typeof requestAnimationFrame;
      globalThis.cancelAnimationFrame = (() => undefined) as typeof cancelAnimationFrame;

      try {
        getMockUiState().isMobile.set(true);
        getMockUiState().isFlowDetailOpen.set(true);

        const task = createMockTask('task-a', 'Task A', 'Short content');
        (getComponent() as any)['task'] = signal(task);

        const viewportHeight = window.innerHeight || 844;
        (getComponent() as any)['drawerHeight'] = signal(12);
        (getComponent() as any)['autoHeightEnabled'] = signal(true);

        getFixture().detectChanges();

        // 构建 mock DOM 元素
        const container = document.createElement('div');
        const title = document.createElement('div');
        const content = document.createElement('div');
        const handle = document.createElement('div');
        const contentChild = document.createElement('div');
        content.appendChild(contentChild);

        Object.defineProperty(title, 'offsetHeight', { configurable: true, get: () => 20 });
        Object.defineProperty(handle, 'offsetHeight', { configurable: true, get: () => 11 });
        // 子元素高 165px（含 margin 0）
        Object.defineProperty(contentChild, 'getBoundingClientRect', {
          configurable: true,
          value: () => ({ x: 0, y: 0, width: 200, height: 165, top: 0, right: 200, bottom: 165, left: 0, toJSON: () => ({}) })
        });

        (getComponent() as any).mobileDrawer = { nativeElement: container };
        (getComponent() as any).mobileDrawerTitle = { nativeElement: title };
        (getComponent() as any).mobileDrawerContent = { nativeElement: content };
        (getComponent() as any).mobileDrawerHandle = { nativeElement: handle };

        const emittedHeights: number[] = [];
        getComponent().drawerHeightChange.subscribe((value) => {
          emittedHeights.push(value);
          (getComponent() as any)['drawerHeight'].set(value);
        });

        // 第一次测量：应 emit（advanceTimersByTime 避免 ParkingService 递归 setTimeout 导致 10000 timer 限制）
        (getComponent() as any).requestAutoHeight();
        vi.advanceTimersByTime(200);

        const firstEmitCount = emittedHeights.length;
        expect(firstEmitCount).toBeGreaterThan(0);

        // 第二次测量：内容不变，lastEmittedVh 已缓存，不应再 emit
        (getComponent() as any).requestAutoHeight();
        vi.advanceTimersByTime(200);

        expect(emittedHeights.length).toBe(firstEmitCount);
      } finally {
        globalThis.requestAnimationFrame = originalRaf;
        globalThis.cancelAnimationFrame = originalCancelRaf;
        vi.useRealTimers();
      }
    }, 5000);

    it('算法: targetPx = titleH + intrinsicContentH + handleH + guard', async () => {
      vi.useFakeTimers();
      const originalRaf = globalThis.requestAnimationFrame;
      const originalCancelRaf = globalThis.cancelAnimationFrame;

      globalThis.requestAnimationFrame = ((cb: FrameRequestCallback): number => {
        cb(0);
        return 1;
      }) as typeof requestAnimationFrame;
      globalThis.cancelAnimationFrame = (() => undefined) as typeof cancelAnimationFrame;

      try {
        getMockUiState().isMobile.set(true);
        getMockUiState().isFlowDetailOpen.set(true);

        const task = createMockTask('task-a', 'Task A', 'Short content');
        (getComponent() as any)['task'] = signal(task);

        const viewportHeight = window.innerHeight || 844;
        (getComponent() as any)['drawerHeight'] = signal(12);
        (getComponent() as any)['autoHeightEnabled'] = signal(true);

        getFixture().detectChanges();

        // 构建 mock DOM：一个内容子元素 90px，加按钮区 45px
        const container = document.createElement('div');
        const title = document.createElement('div');
        const content = document.createElement('div');
        const handle = document.createElement('div');
        const contentBody = document.createElement('div');
        const actionSection = document.createElement('div');
        content.appendChild(contentBody);
        content.appendChild(actionSection);

        Object.defineProperty(title, 'offsetHeight', { configurable: true, get: () => 20 });
        Object.defineProperty(handle, 'offsetHeight', { configurable: true, get: () => 11 });
        Object.defineProperty(contentBody, 'getBoundingClientRect', {
          configurable: true,
          value: () => ({ x: 0, y: 0, width: 200, height: 90, top: 0, right: 200, bottom: 90, left: 0, toJSON: () => ({}) })
        });
        Object.defineProperty(actionSection, 'getBoundingClientRect', {
          configurable: true,
          value: () => ({ x: 0, y: 90, width: 200, height: 45, top: 90, right: 200, bottom: 135, left: 0, toJSON: () => ({}) })
        });

        (getComponent() as any).mobileDrawer = { nativeElement: container };
        (getComponent() as any).mobileDrawerTitle = { nativeElement: title };
        (getComponent() as any).mobileDrawerContent = { nativeElement: content };
        (getComponent() as any).mobileDrawerHandle = { nativeElement: handle };

        const emittedHeights: number[] = [];
        getComponent().drawerHeightChange.subscribe((value) => {
          emittedHeights.push(value);
          (getComponent() as any)['drawerHeight'].set(value);
        });

        (getComponent() as any).requestAutoHeight();
        vi.advanceTimersByTime(200);

        // targetPx = 20 + (90+45) + 11 + 4 = 170
        const expectedPx = 20 + 135 + 11 + 4;
        const expectedVh = (expectedPx / viewportHeight) * 100;

        expect(emittedHeights.length).toBeGreaterThan(0);
        expect(emittedHeights[0]).toBeCloseTo(expectedVh, 1);
      } finally {
        globalThis.requestAnimationFrame = originalRaf;
        globalThis.cancelAnimationFrame = originalCancelRaf;
        vi.useRealTimers();
      }
    });
  });
}
