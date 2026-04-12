import { TestBed } from '@angular/core/testing';
import { NgZone, signal } from '@angular/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as go from 'gojs';

import { FlowDiagramService } from './flow-diagram.service';
import { UiStateService } from '../../../../services/ui-state.service';
import { LoggerService } from '../../../../services/logger.service';
import { ToastService } from '../../../../services/toast.service';
import { ThemeService } from '../../../../services/theme.service';
import { FlowLayoutService } from './flow-layout.service';
import { FlowSelectionService } from './flow-selection.service';
import { FlowZoomService, type ViewState } from './flow-zoom.service';
import { FlowEventService } from './flow-event.service';
import { FlowTemplateService } from './flow-template.service';
import { FlowLinkTemplateService } from './flow-link-template.service';
import { FlowOverviewService } from './flow-overview.service';
import { FlowDiagramDataService } from './flow-diagram-data.service';
import { ProjectStateService } from '../../../../services/project-state.service';
import { SentryLazyLoaderService } from '../../../../services/sentry-lazy-loader.service';

describe('FlowDiagramService', () => {
  let service: FlowDiagramService;
  let container: HTMLDivElement;
  let currentWidth = 800;
  let currentHeight = 600;

  const mockDataService = {
    saveViewState: vi.fn(),
    cancelPendingViewStateSave: vi.fn(),
    restoreViewState: vi.fn(),
    setDiagram: vi.fn(),
    dispose: vi.fn(),
    clearTimers: vi.fn(),
    onFlowActivated: vi.fn(),
    updateDiagram: vi.fn(),
    exportToPng: vi.fn(),
    exportToSvg: vi.fn(),
  };

  const mockOverviewService = {
    updateTheme: vi.fn(),
    setDiagram: vi.fn(),
    initializeOverview: vi.fn(),
    destroyOverview: vi.fn(),
    refreshOverview: vi.fn(),
  };

  const mockZoomService = {
    fitToContents: vi.fn(),
    setDiagram: vi.fn(),
    setViewStatePersistenceGuard: vi.fn(),
    cancelPendingViewStateSave: vi.fn(),
    dispose: vi.fn(),
    getZoom: vi.fn(() => 1),
  };

  const mockSelectionService = {
    setDiagram: vi.fn(),
    getSelectedNodeKeys: vi.fn(() => []),
    selectNode: vi.fn(),
    selectMultiple: vi.fn(),
  };

  const mockProjectState = {
    getViewState: vi.fn(() => null as ViewState | null),
  };

  const mockLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  let originalRequestAnimationFrame: typeof globalThis.requestAnimationFrame | undefined;
  let originalCancelAnimationFrame: typeof globalThis.cancelAnimationFrame | undefined;
  let originalDevicePixelRatioDescriptor: PropertyDescriptor | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    currentWidth = 800;
    currentHeight = 600;

    originalRequestAnimationFrame = globalThis.requestAnimationFrame;
    originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
    originalDevicePixelRatioDescriptor = Object.getOwnPropertyDescriptor(window, 'devicePixelRatio');

    globalThis.requestAnimationFrame = ((callback: FrameRequestCallback): number => {
      return setTimeout(() => callback(0), 0) as unknown as number;
    }) as typeof requestAnimationFrame;

    globalThis.cancelAnimationFrame = ((id: number): void => {
      clearTimeout(id as unknown as ReturnType<typeof setTimeout>);
    }) as typeof cancelAnimationFrame;

    TestBed.configureTestingModule({
      providers: [
        FlowDiagramService,
        { provide: UiStateService, useValue: { isMobile: signal(false), activeView: signal<'text' | 'flow' | null>('flow') } },
        { provide: LoggerService, useValue: { category: () => mockLogger } },
        { provide: ToastService, useValue: { error: vi.fn(), info: vi.fn(), success: vi.fn(), warning: vi.fn() } },
        { provide: ThemeService, useValue: { isDark: signal(false), theme: signal('paper') } },
        { provide: FlowLayoutService, useValue: { setDiagram: vi.fn(), dispose: vi.fn() } },
        { provide: FlowSelectionService, useValue: mockSelectionService },
        { provide: FlowZoomService, useValue: mockZoomService },
        { provide: FlowEventService, useValue: { setDiagram: vi.fn(), dispose: vi.fn() } },
        { provide: FlowTemplateService, useValue: { ensureDiagramLayers: vi.fn(), setupNodeTemplate: vi.fn() } },
        { provide: FlowLinkTemplateService, useValue: { setupLinkTemplate: vi.fn() } },
        { provide: FlowOverviewService, useValue: mockOverviewService },
        { provide: FlowDiagramDataService, useValue: mockDataService },
        { provide: ProjectStateService, useValue: mockProjectState },
        { provide: SentryLazyLoaderService, useValue: { captureException: vi.fn() } },
        { provide: NgZone, useValue: new NgZone({ enableLongStackTrace: false }) },
      ],
    });

    service = TestBed.inject(FlowDiagramService);

    container = document.createElement('div');
    Object.defineProperty(container, 'clientWidth', {
      configurable: true,
      get: () => currentWidth,
    });
    Object.defineProperty(container, 'clientHeight', {
      configurable: true,
      get: () => currentHeight,
    });
  });

  afterEach(() => {
    if (originalRequestAnimationFrame) {
      globalThis.requestAnimationFrame = originalRequestAnimationFrame;
    } else {
      delete (globalThis as unknown as { requestAnimationFrame?: typeof globalThis.requestAnimationFrame }).requestAnimationFrame;
    }

    if (originalCancelAnimationFrame) {
      globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
    } else {
      delete (globalThis as unknown as { cancelAnimationFrame?: typeof globalThis.cancelAnimationFrame }).cancelAnimationFrame;
    }

    if (originalDevicePixelRatioDescriptor) {
      Object.defineProperty(window, 'devicePixelRatio', originalDevicePixelRatioDescriptor);
    } else {
      delete (window as Window & { devicePixelRatio?: number }).devicePixelRatio;
    }

    vi.useRealTimers();
    TestBed.resetTestingModule();
  });

  function attachDiagram(initialPosition: go.Point = new go.Point(0, 0), initialScale = 1) {
    let scale = initialScale;
    let position = initialPosition.copy();

    const diagram = {
      div: container,
      documentBounds: new go.Rect(0, 0, 400, 300),
      nodes: { count: 3 },
      updateAllTargetBindings: vi.fn(),
      requestUpdate: vi.fn(),
      get scale(): number {
        return scale;
      },
      set scale(value: number) {
        scale = value;
      },
      get position(): go.Point {
        return position;
      },
      set position(value: go.Point) {
        position = value;
      },
      get viewportBounds(): go.Rect {
        return new go.Rect(position.x, position.y, currentWidth, currentHeight);
      },
    };

    const internal = service as unknown as {
      diagram: typeof diagram;
      diagramDiv: HTMLDivElement;
    };
    internal.diagram = diagram;
    internal.diagramDiv = container;

    return diagram;
  }

  it('应在容器进入危险小尺寸时阻止坏视口状态持久化', () => {
    currentWidth = 120;
    currentHeight = 96;
    attachDiagram();

    const internal = service as unknown as {
      resizeRecoveryArmed: boolean;
      lastStableViewState: ViewState | null;
      handleViewportBoundsChanged: () => void;
    };
    internal.resizeRecoveryArmed = true;

    internal.handleViewportBoundsChanged();

    expect(mockDataService.saveViewState).not.toHaveBeenCalled();
    expect(internal.lastStableViewState).toBeNull();
  });

  it('设备像素比变化时应触发恢复链路而不是静默保留旧 canvas', () => {
    attachDiagram();

    const internal = service as unknown as {
      lastKnownDevicePixelRatio: number;
      syncViewportMetrics: () => void;
    };
    internal.lastKnownDevicePixelRatio = 1;
    Object.defineProperty(window, 'devicePixelRatio', {
      configurable: true,
      value: 1.5,
    });

    internal.syncViewportMetrics();
    vi.runAllTimers();

    expect(mockDataService.cancelPendingViewStateSave).toHaveBeenCalledTimes(1);
    expect(mockZoomService.cancelPendingViewStateSave).toHaveBeenCalledTimes(1);
    expect(internal.lastKnownDevicePixelRatio).toBe(1.5);
  });

  it('应在容器从危险小尺寸恢复后回到最近的稳定视口', () => {
    currentWidth = 120;
    currentHeight = 96;
    const diagram = attachDiagram(new go.Point(1200, 900), 0.45);

    const internal = service as unknown as {
      lastRecoverableViewState: ViewState | null;
      resizeRecoveryArmed: boolean;
      lastStableViewState: ViewState | null;
      handleDiagramContainerResize: (width: number, height: number) => void;
    };
    internal.lastRecoverableViewState = {
      scale: 1.2,
      positionX: 18,
      positionY: 24,
    };
    internal.lastStableViewState = {
      scale: 1.2,
      positionX: 18,
      positionY: 24,
    };

    internal.handleDiagramContainerResize(currentWidth, currentHeight);
    expect(internal.resizeRecoveryArmed).toBe(true);

    const restoreInternal = service as unknown as {
      lastRecoverableViewState: ViewState | null;
      lastStableViewState: ViewState | null;
      restoreBestKnownViewState: () => boolean;
    };
    restoreInternal.lastRecoverableViewState = {
      scale: 1.2,
      positionX: 18,
      positionY: 24,
    };
    restoreInternal.lastStableViewState = {
      scale: 1.2,
      positionX: 18,
      positionY: 24,
    };

    restoreInternal.restoreBestKnownViewState();
    expect(diagram.scale).toBe(1.2);
    expect(diagram.position.x).toBe(18);
    expect(diagram.position.y).toBe(24);

    diagram.scale = 0.45;
    diagram.position = new go.Point(1200, 900);

    currentWidth = 960;
    currentHeight = 720;

    internal.handleDiagramContainerResize(currentWidth, currentHeight);
    vi.runAllTimers();

    expect(diagram.updateAllTargetBindings).toHaveBeenCalled();
    expect(diagram.scale).toBe(1.2);
    expect(diagram.position.x).toBe(18);
    expect(diagram.position.y).toBe(24);
  });

  it('recoverable 视口不可见时应继续回退到可见的 stable 视口', () => {
    currentWidth = 960;
    currentHeight = 720;
    const diagram = attachDiagram(new go.Point(1200, 900), 0.45);

    const internal = service as unknown as {
      lastRecoverableViewState: ViewState | null;
      lastStableViewState: ViewState | null;
      restoreBestKnownViewState: () => boolean;
    };
    internal.lastRecoverableViewState = {
      scale: 0.45,
      positionX: 1200,
      positionY: 900,
    };
    internal.lastStableViewState = {
      scale: 1.15,
      positionX: 20,
      positionY: 28,
    };

    internal.restoreBestKnownViewState();
    expect(diagram.scale).toBe(1.15);
    expect(diagram.position.x).toBe(20);
    expect(diagram.position.y).toBe(28);
  });

  it('普通恢复后仍不可见时应升级到原地重建路径', () => {
    currentWidth = 960;
    currentHeight = 720;
    attachDiagram(new go.Point(1200, 900), 0.45);

    const internal = service as unknown as {
      resizeRecoveryArmed: boolean;
      restoreBestKnownViewState: () => boolean;
      tryHardDiagramRecovery: () => boolean;
      recoverDiagramAfterUnsafeResize: () => void;
    };
    internal.resizeRecoveryArmed = true;
    internal.restoreBestKnownViewState = vi.fn(() => false);
    internal.tryHardDiagramRecovery = vi.fn(() => true);
    mockZoomService.fitToContents.mockImplementation(() => undefined);

    internal.recoverDiagramAfterUnsafeResize();
    vi.runAllTimers();

    expect(internal.tryHardDiagramRecovery).toHaveBeenCalledTimes(1);
  });

  it('硬恢复兜底 fit 仍失败时应保持 recovery armed 并释放 mutex', () => {
    currentWidth = 960;
    currentHeight = 720;
    attachDiagram(new go.Point(1200, 900), 0.45);

    const internal = service as unknown as {
      resizeRecoveryArmed: boolean;
      hardRecoveryInProgress: boolean;
      recoveryFitFallbackUsed: boolean;
      completeRecoveryVerification: (allowHardRecovery: boolean) => void;
    };
    internal.resizeRecoveryArmed = false;
    internal.hardRecoveryInProgress = true;
    internal.recoveryFitFallbackUsed = true;

    internal.completeRecoveryVerification(false);

    expect(internal.resizeRecoveryArmed).toBe(true);
    expect(internal.hardRecoveryInProgress).toBe(false);
  });
});