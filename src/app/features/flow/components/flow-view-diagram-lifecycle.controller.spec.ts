import { signal } from '@angular/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { FlowViewDiagramLifecycleController } from './flow-view-diagram-lifecycle.controller';

function createController() {
  const diagram = {
    refreshOverview: vi.fn(),
    syncViewportMetrics: vi.fn(),
  };
  const controller = new FlowViewDiagramLifecycleController({
    diagram: diagram as never,
    diagramRetry: {} as never,
    dragDrop: {} as never,
    eventRegistration: {} as never,
    flowCommand: {} as never,
    isOverviewCollapsed: signal(false),
    isOverviewVisible: signal(true),
    isPaletteOpen: signal(false),
    isMobile: () => false,
    logger: { warn: vi.fn() },
    overviewDiv: () => undefined,
    diagramDiv: () => undefined,
    projectTasks: () => [],
    scheduleTimer: (callback, delay) => setTimeout(callback, delay),
    selectMode: {} as never,
    selectedTaskId: signal(null),
    touch: {} as never,
    useSvgMinimap: signal(false),
    zone: {} as never,
    bumpDetailLayoutTick: vi.fn(),
    expandDrawerToOptimalHeight: vi.fn(),
    handleDeleteKeyPressed: vi.fn(),
    handleDiagramDrop: vi.fn(),
    isDestroyed: () => false,
    refreshDiagram: vi.fn(),
    executeCenterOnNode: vi.fn(),
  });

  return { controller, diagram };
}

describe('FlowViewDiagramLifecycleController', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('clears the tracked overview resize timer after the resize refresh flushes', () => {
    vi.useFakeTimers();
    const { controller, diagram } = createController();

    controller.handleResize();
    expect(controller.getOverviewResizeTimer()).not.toBeNull();

    vi.advanceTimersByTime(300);

    expect(diagram.syncViewportMetrics).toHaveBeenCalledOnce();
    expect(diagram.refreshOverview).toHaveBeenCalledOnce();
    expect(controller.getOverviewResizeTimer()).toBeNull();
  });

  it('cancels an existing overview resize timer when its handle is 0', () => {
    vi.useFakeTimers();
    const { controller } = createController();
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
    const internal = controller as unknown as {
      overviewResizeTimer: ReturnType<typeof setTimeout> | null;
    };
    internal.overviewResizeTimer = 0 as unknown as ReturnType<typeof setTimeout>;

    controller.handleResize();

    expect(clearTimeoutSpy).toHaveBeenCalledWith(0);
    expect(controller.getOverviewResizeTimer()).not.toBe(0);
  });
});
