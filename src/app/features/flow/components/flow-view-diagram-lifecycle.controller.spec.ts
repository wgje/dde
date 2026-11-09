import { ElementRef, signal } from '@angular/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { FlowViewDiagramLifecycleController } from './flow-view-diagram-lifecycle.controller';

interface ControllerHarnessOptions {
  activeProjectId?: () => string | null;
  overviewDiv?: () => ElementRef | undefined;
  scheduleTimer?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  isDestroyed?: () => boolean;
  updateDiagram?: ReturnType<typeof vi.fn>;
  diagramRetry?: { scheduleDiagramInit: ReturnType<typeof vi.fn> };
  flowCommand?: {
    centerNodeCommand: () => { taskId: string; openDetail: boolean } | null;
    markViewReady: ReturnType<typeof vi.fn>;
    consumePendingCenterCommand: ReturnType<typeof vi.fn>;
    clearCenterCommand: ReturnType<typeof vi.fn>;
  };
  executeCenterOnNode?: (taskId: string, openDetail: boolean) => void;
}
function createController(harness: ControllerHarnessOptions = {}) {
  const diagram = {
    get activeProjectId() { return harness.activeProjectId?.() ?? 'project-a'; },
    disposeOverview: vi.fn(),
    refreshOverview: vi.fn(),
    scheduleOverviewInit: vi.fn(),
    syncViewportMetrics: vi.fn(),
    isInitialized: true,
    updateDiagram: harness.updateDiagram ?? vi.fn(() => true),
  };
  const flowCommand = harness.flowCommand ?? { centerNodeCommand: signal(null), markViewReady: vi.fn(), consumePendingCenterCommand: vi.fn(() => null), clearCenterCommand: vi.fn() };
  const executeCenterOnNode = harness.executeCenterOnNode ?? vi.fn();
  const useSvgMinimap = signal(false);
  const isOverviewCollapsed = signal(false);
  const controller = new FlowViewDiagramLifecycleController({
    diagram: diagram as never,
    diagramRetry: (harness.diagramRetry ?? {}) as never,
    dragDrop: {} as never,
    eventRegistration: {} as never,
    flowCommand: flowCommand as never,
    isOverviewCollapsed,
    isOverviewVisible: signal(true),
    isPaletteOpen: signal(false),
    isMobile: () => false,
    logger: { warn: vi.fn() },
    overviewDiv: harness.overviewDiv ?? (() => undefined),
    diagramDiv: () => undefined,
    projectTasks: () => [],
    scheduleTimer: harness.scheduleTimer ?? ((callback, delay) => setTimeout(callback, delay)),
    selectMode: {} as never,
    selectedTaskId: signal(null),
    touch: {} as never,
    useSvgMinimap,
    zone: {} as never,
    bumpDetailLayoutTick: vi.fn(),
    expandDrawerToOptimalHeight: vi.fn(),
    handleDeleteKeyPressed: vi.fn(),
    handleDiagramDrop: vi.fn(),
    isDestroyed: harness.isDestroyed ?? (() => false),
    refreshDiagram: vi.fn(),
    executeCenterOnNode,
  });
  return { controller, diagram, executeCenterOnNode, flowCommand, isOverviewCollapsed, useSvgMinimap };
}

describe('FlowViewDiagramLifecycleController', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
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

  it('legacy 容器出现时初始化 Overview，容器移除或切回 SVG 时释放', () => {
    const { controller, diagram, useSvgMinimap } = createController();
    const host = new ElementRef(document.createElement('div'));

    controller.handleLegacyOverviewHostChange(host);
    expect(diagram.scheduleOverviewInit).toHaveBeenCalledWith(
      host,
      true,
      false,
      expect.anything(),
      expect.any(Function),
      true,
    );

    controller.handleLegacyOverviewHostChange(undefined);
    expect(diagram.disposeOverview).toHaveBeenCalledOnce();

    useSvgMinimap.set(true);
    controller.handleLegacyOverviewHostChange(host);
    expect(diagram.scheduleOverviewInit).toHaveBeenCalledTimes(1);
    expect(diagram.disposeOverview).toHaveBeenCalledTimes(2);
  });

  it('legacy 容器移除会取消待执行 RAF，晚到 RAF 不得创建 100ms timer', () => {
    let lateFrame: FrameRequestCallback | undefined;
    const requestFrame = vi.fn((callback: FrameRequestCallback) => {
      lateFrame = callback;
      return 41;
    });
    const cancelFrame = vi.fn();
    const scheduleTimer = vi.fn(() => 71 as unknown as ReturnType<typeof setTimeout>);
    vi.stubGlobal('requestAnimationFrame', requestFrame);
    vi.stubGlobal('cancelAnimationFrame', cancelFrame);
    const { controller, diagram, isOverviewCollapsed } = createController({ scheduleTimer });
    isOverviewCollapsed.set(true);

    controller.toggleOverviewCollapse();
    controller.handleLegacyOverviewHostChange(undefined);

    expect(cancelFrame).toHaveBeenCalledWith(41);
    lateFrame?.(0);
    expect(scheduleTimer).not.toHaveBeenCalled();
    expect(diagram.scheduleOverviewInit).not.toHaveBeenCalled();
  });

  it('切换到 SVG 会取消待执行 legacy RAF，晚到回调无副作用', () => {
    let lateFrame: FrameRequestCallback | undefined;
    const cancelFrame = vi.fn();
    const scheduleTimer = vi.fn(() => 74 as unknown as ReturnType<typeof setTimeout>);
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      lateFrame = callback;
      return 43;
    });
    vi.stubGlobal('cancelAnimationFrame', cancelFrame);
    const { controller, diagram, isOverviewCollapsed, useSvgMinimap } = createController({ scheduleTimer });
    isOverviewCollapsed.set(true);

    controller.toggleOverviewCollapse();
    useSvgMinimap.set(true);
    controller.handleLegacyOverviewHostChange(new ElementRef(document.createElement('div')));

    expect(cancelFrame).toHaveBeenCalledWith(43);
    lateFrame?.(0);
    expect(scheduleTimer).not.toHaveBeenCalled();
    expect(diagram.scheduleOverviewInit).not.toHaveBeenCalled();
  });

  it('取消已由 RAF 创建的 timer 后，晚到 timer 不得初始化 Overview', () => {
    let frameCallback: FrameRequestCallback | undefined;
    let lateTimer: (() => void) | undefined;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frameCallback = callback;
      return 42;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
    const scheduleTimer = vi.fn((callback: () => void) => {
      lateTimer = callback;
      return 72 as unknown as ReturnType<typeof setTimeout>;
    });
    const { controller, diagram, isOverviewCollapsed } = createController({ scheduleTimer });
    isOverviewCollapsed.set(true);

    controller.toggleOverviewCollapse();
    frameCallback?.(0);
    expect(scheduleTimer).toHaveBeenCalledWith(expect.any(Function), 100);

    controller.handleLegacyOverviewHostChange(undefined);
    expect(clearTimeoutSpy).toHaveBeenCalledWith(72);
    lateTimer?.();
    expect(diagram.scheduleOverviewInit).not.toHaveBeenCalled();
  });

  it('折叠、重新调度与 cleanup 都取消旧的 legacy 展开 RAF', () => {
    let nextFrameId = 50;
    const requestFrame = vi.fn((_callback: FrameRequestCallback) => nextFrameId++);
    const cancelFrame = vi.fn();
    vi.stubGlobal('requestAnimationFrame', requestFrame);
    vi.stubGlobal('cancelAnimationFrame', cancelFrame);
    const { controller, isOverviewCollapsed } = createController();
    isOverviewCollapsed.set(true);

    controller.toggleOverviewCollapse();
    controller.toggleOverviewCollapse();
    controller.toggleOverviewCollapse();
    controller.clearOverviewResizeTimer();

    expect(requestFrame).toHaveBeenCalledTimes(2);
    expect(cancelFrame).toHaveBeenNthCalledWith(1, 50);
    expect(cancelFrame).toHaveBeenNthCalledWith(2, 51);
  });

  it('requestAnimationFrame API 不可用时仍通过受控 timer 完成 legacy 展开', () => {
    vi.stubGlobal('requestAnimationFrame', undefined);
    vi.stubGlobal('cancelAnimationFrame', undefined);
    const host = new ElementRef(document.createElement('div'));
    let timerCallback: (() => void) | undefined;
    const scheduleTimer = vi.fn((callback: () => void) => {
      timerCallback = callback;
      return 73 as unknown as ReturnType<typeof setTimeout>;
    });
    const { controller, diagram, isOverviewCollapsed } = createController({
      overviewDiv: () => host,
      scheduleTimer,
    });
    isOverviewCollapsed.set(true);

    expect(() => controller.toggleOverviewCollapse()).not.toThrow();
    expect(scheduleTimer).toHaveBeenCalledWith(expect.any(Function), 100);
    timerCallback?.();
    expect(diagram.scheduleOverviewInit).toHaveBeenCalledWith(
      host,
      true,
      false,
      expect.anything(),
      expect.any(Function),
      true,
    );
  });
  it('preserves readiness and pending center state when the initial diagram update fails', () => {
    const flowCommand = {
      centerNodeCommand: signal(null),
      markViewReady: vi.fn(),
      consumePendingCenterCommand: vi.fn(),
      clearCenterCommand: vi.fn(),
    };
    const scheduleTimer = vi.fn((callback: () => void) => {
      callback();
      return 81 as unknown as ReturnType<typeof setTimeout>;
    });
    const { controller, executeCenterOnNode } = createController({
      updateDiagram: vi.fn(() => false),
      diagramRetry: {
        scheduleDiagramInit: vi.fn((_init: () => void, onInitialized: () => void) => onInitialized()),
      },
      flowCommand,
      scheduleTimer,
    });
    controller.scheduleDiagramInit();
    expect(flowCommand.markViewReady).not.toHaveBeenCalled();
    expect(flowCommand.consumePendingCenterCommand).not.toHaveBeenCalled();
    expect(flowCommand.clearCenterCommand).not.toHaveBeenCalled();
    expect(executeCenterOnNode).not.toHaveBeenCalled();
    expect(scheduleTimer).toHaveBeenCalledTimes(1);
  });

  it('leaves readiness publication to the viewport controller after a successful update', () => {
    const { controller, flowCommand } = createController({
      diagramRetry: {
        scheduleDiagramInit: vi.fn((_init: () => void, onInitialized: () => void) => onInitialized()),
      },
      scheduleTimer: (callback) => {
        callback();
        return 82 as unknown as ReturnType<typeof setTimeout>;
      },
    });

    controller.scheduleDiagramInit();

    expect(flowCommand.consumePendingCenterCommand).not.toHaveBeenCalled();
    expect(flowCommand.markViewReady).not.toHaveBeenCalled();
  });

  it('does not consume a pending center or schedule a synthetic readiness delay', () => {
    const pendingCmd = { taskId: 'task-1', openDetail: true };
    const flowCommand = {
      centerNodeCommand: signal(pendingCmd),
      markViewReady: vi.fn(),
      consumePendingCenterCommand: vi.fn(() => pendingCmd),
      clearCenterCommand: vi.fn(),
    };
    const executeCenterOnNode = vi.fn();
    const scheduleTimer = vi.fn((callback: () => void) => {
      callback();
      return 83 as unknown as ReturnType<typeof setTimeout>;
    });
    const { controller } = createController({
      diagramRetry: {
        scheduleDiagramInit: vi.fn((_init: () => void, onInitialized: () => void) => onInitialized()),
      },
      flowCommand,
      executeCenterOnNode,
      scheduleTimer,
    });
    controller.scheduleDiagramInit();

    expect(scheduleTimer).toHaveBeenCalledTimes(1);
    expect(flowCommand.consumePendingCenterCommand).not.toHaveBeenCalled();
    expect(flowCommand.clearCenterCommand).not.toHaveBeenCalled();
    expect(flowCommand.markViewReady).not.toHaveBeenCalled();
    expect(executeCenterOnNode).not.toHaveBeenCalled();
  });
});
