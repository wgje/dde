import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./flow-diagram.service', () => ({
  FlowDiagramService: class FlowDiagramService {},
}));

vi.mock('./flow-diagram-effects.service', () => ({
  FlowDiagramEffectsService: class FlowDiagramEffectsService {},
}));

vi.mock('./flow-mobile-drawer.service', () => ({
  FlowMobileDrawerService: class FlowMobileDrawerService {},
}));

vi.mock('./flow-touch.service', () => ({
  FlowTouchService: class FlowTouchService {},
}));

vi.mock('./flow-link.service', () => ({
  FlowLinkService: class FlowLinkService {},
}));

vi.mock('./flow-drag-drop.service', () => ({
  FlowDragDropService: class FlowDragDropService {},
}));

vi.mock('./flow-task-operations.service', () => ({
  FlowTaskOperationsService: class FlowTaskOperationsService {},
}));

vi.mock('./flow-command.service', () => ({
  FlowCommandService: class FlowCommandService {},
}));

vi.mock('./flow-template-events', () => ({
  flowTemplateEventHandlers: {
    onDeleteKeyPressed: undefined as undefined | (() => void),
  },
}));

describe('FlowViewCleanupService', () => {
  let service: import('./flow-view-cleanup.service').FlowViewCleanupService;
  let FlowViewCleanupServiceClass: typeof import('./flow-view-cleanup.service').FlowViewCleanupService;
  let FlowDiagramServiceClass: typeof import('./flow-diagram.service').FlowDiagramService;
  let FlowDiagramEffectsServiceClass: typeof import('./flow-diagram-effects.service').FlowDiagramEffectsService;
  let FlowMobileDrawerServiceClass: typeof import('./flow-mobile-drawer.service').FlowMobileDrawerService;
  let FlowTouchServiceClass: typeof import('./flow-touch.service').FlowTouchService;
  let FlowLinkServiceClass: typeof import('./flow-link.service').FlowLinkService;
  let FlowDragDropServiceClass: typeof import('./flow-drag-drop.service').FlowDragDropService;
  let FlowTaskOperationsServiceClass: typeof import('./flow-task-operations.service').FlowTaskOperationsService;
  let FlowCommandServiceClass: typeof import('./flow-command.service').FlowCommandService;
  let flowTemplateEventHandlers: { onDeleteKeyPressed: undefined | (() => void) };

  const diagram = {
    cancelIdleOverviewInit: vi.fn(),
    dispose: vi.fn(),
  };
  const diagramEffects = {
    cancelPendingRaf: vi.fn(),
  };
  const mobileDrawer = {
    cancelPendingDrawerRaf: vi.fn(),
  };
  const touch = {
    dispose: vi.fn(),
    endDiagramNodeDragGhost: vi.fn(),
  };
  const link = {
    dispose: vi.fn(),
  };
  const dragDrop = {
    dispose: vi.fn(),
  };
  const taskOps = {
    dispose: vi.fn(),
  };
  const flowCommand = {
    markViewDestroyed: vi.fn(),
  };

  let originalCancelIdleCallback: typeof globalThis.cancelIdleCallback | undefined;

  beforeEach(async () => {
    vi.useFakeTimers();
    originalCancelIdleCallback = globalThis.cancelIdleCallback;

    ({ FlowViewCleanupService: FlowViewCleanupServiceClass } = await import('./flow-view-cleanup.service'));
    ({ FlowDiagramService: FlowDiagramServiceClass } = await import('./flow-diagram.service'));
    ({ FlowDiagramEffectsService: FlowDiagramEffectsServiceClass } = await import('./flow-diagram-effects.service'));
    ({ FlowMobileDrawerService: FlowMobileDrawerServiceClass } = await import('./flow-mobile-drawer.service'));
    ({ FlowTouchService: FlowTouchServiceClass } = await import('./flow-touch.service'));
    ({ FlowLinkService: FlowLinkServiceClass } = await import('./flow-link.service'));
    ({ FlowDragDropService: FlowDragDropServiceClass } = await import('./flow-drag-drop.service'));
    ({ FlowTaskOperationsService: FlowTaskOperationsServiceClass } = await import('./flow-task-operations.service'));
    ({ FlowCommandService: FlowCommandServiceClass } = await import('./flow-command.service'));
    ({ flowTemplateEventHandlers } = await import('./flow-template-events'));

    TestBed.configureTestingModule({
      providers: [
        FlowViewCleanupServiceClass,
        { provide: FlowDiagramServiceClass, useValue: diagram },
        { provide: FlowDiagramEffectsServiceClass, useValue: diagramEffects },
        { provide: FlowMobileDrawerServiceClass, useValue: mobileDrawer },
        { provide: FlowTouchServiceClass, useValue: touch },
        { provide: FlowLinkServiceClass, useValue: link },
        { provide: FlowDragDropServiceClass, useValue: dragDrop },
        { provide: FlowTaskOperationsServiceClass, useValue: taskOps },
        { provide: FlowCommandServiceClass, useValue: flowCommand },
      ],
    });

    service = TestBed.inject(FlowViewCleanupServiceClass);
  });

  afterEach(() => {
    if (flowTemplateEventHandlers) {
      flowTemplateEventHandlers.onDeleteKeyPressed = undefined;
    }
    if (originalCancelIdleCallback === undefined) {
      delete globalThis.cancelIdleCallback;
    } else {
      Object.defineProperty(globalThis, 'cancelIdleCallback', {
        configurable: true,
        value: originalCancelIdleCallback,
      });
    }
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it('performCleanup 应清空异步资源并销毁流程图相关服务', () => {
    const cancelAnimationFrameSpy = vi
      .spyOn(globalThis, 'cancelAnimationFrame')
      .mockImplementation(() => undefined);
    const cancelIdleCallbackSpy = vi.fn();
    Object.defineProperty(globalThis, 'cancelIdleCallback', {
      configurable: true,
      value: cancelIdleCallbackSpy,
    });

    flowTemplateEventHandlers.onDeleteKeyPressed = vi.fn();

    const resources = {
      pendingTimers: [setTimeout(() => undefined, 1000), setTimeout(() => undefined, 2000)],
      pendingRetryRafIds: [11, 22],
      overviewResizeTimer: setTimeout(() => undefined, 3000),
      idleInitHandle: 77,
    };
    const uninstallMobileListeners = vi.fn();

    service.performCleanup(resources, uninstallMobileListeners);

    expect(flowCommand.markViewDestroyed).toHaveBeenCalledTimes(1);
    expect(uninstallMobileListeners).toHaveBeenCalledTimes(1);
    expect(touch.endDiagramNodeDragGhost).toHaveBeenCalledTimes(1);

    expect(diagramEffects.cancelPendingRaf).toHaveBeenCalledTimes(1);
    expect(mobileDrawer.cancelPendingDrawerRaf).toHaveBeenCalledTimes(1);
    expect(cancelAnimationFrameSpy).toHaveBeenCalledWith(11);
    expect(cancelAnimationFrameSpy).toHaveBeenCalledWith(22);
    expect(cancelIdleCallbackSpy).toHaveBeenCalledWith(77);
    expect(diagram.cancelIdleOverviewInit).toHaveBeenCalledTimes(1);

    expect(resources.pendingTimers).toHaveLength(0);
    expect(resources.pendingRetryRafIds).toHaveLength(0);
    expect(resources.overviewResizeTimer).toBeNull();
    expect(resources.idleInitHandle).toBeNull();

    expect(diagram.dispose).toHaveBeenCalledTimes(1);
    expect(touch.dispose).toHaveBeenCalledTimes(1);
    expect(link.dispose).toHaveBeenCalledTimes(1);
    expect(dragDrop.dispose).toHaveBeenCalledTimes(1);
    expect(taskOps.dispose).toHaveBeenCalledTimes(1);
    expect(flowTemplateEventHandlers.onDeleteKeyPressed).toBeUndefined();

    cancelAnimationFrameSpy.mockRestore();
  });
});