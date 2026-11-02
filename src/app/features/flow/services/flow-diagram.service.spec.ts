import { TestBed } from '@angular/core/testing';
import { Injector, NgZone, signal } from '@angular/core';
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
import { FlowTouchService } from './flow-touch.service';
import { FlowCommandService } from './flow-command.service';
import { FlowDiagramEffectsService } from './flow-diagram-effects.service';
import { PreferenceService } from '../../../../services/preference.service';
import { ProjectStateService } from '../../../../services/project-state.service';
import { SentryLazyLoaderService } from '../../../../services/sentry-lazy-loader.service';
import { flowTemplateEventHandlers } from './flow-template-events';

describe('FlowDiagramService', () => {
  let service: FlowDiagramService;
  let container: HTMLDivElement;
  let currentWidth = 800;
  let currentHeight = 600;
  const activeProjectId = signal<string | null>('project-a');
  let activeProjectGeneration = 1;
  const projectTasks = signal([]);

  const mockDataService = {
    saveViewState: vi.fn(),
    cancelPendingViewStateSave: vi.fn(),
    restoreViewState: vi.fn(),
    setDiagram: vi.fn(),
    dispose: vi.fn(),
    clearTimers: vi.fn(),
    onFlowActivated: vi.fn(),
    updateDiagram: vi.fn(),
    beginHardRecovery: vi.fn(() => true),
    applyHardRecoveryViewport: vi.fn((
      _viewState: unknown,
      complete: (proof: { kind: 'FIT_TO_CONTENTS_APPLIED' }) => void,
    ) => {
      complete({ kind: 'FIT_TO_CONTENTS_APPLIED' });
      return true;
    }),
    completeHardRecovery: vi.fn(() => true),
    abortHardRecovery: vi.fn(),
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
    activeProjectId,
    tasks: projectTasks,
    captureActiveProjectOwner: () => ({
      projectId: activeProjectId(),
      generation: activeProjectGeneration,
    }),
    isActiveProjectOwnerCurrent: (owner: { projectId: string | null; generation: number }) => (
      owner.projectId === activeProjectId() && owner.generation === activeProjectGeneration
    ),
    getViewState: vi.fn(() => null as ViewState | null),
  };

  const switchProject = (projectId: string): void => {
    if (activeProjectId() !== projectId) activeProjectGeneration += 1;
    activeProjectId.set(projectId);
  };

  const mockTouchService = {
    installDiagramDragGhostListeners: vi.fn(),
    uninstallDiagramDragGhostListeners: vi.fn(),
    endDiagramNodeDragGhost: vi.fn(),
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
    activeProjectId.set('project-a');
    activeProjectGeneration = 1;
    projectTasks.set([]);
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
        FlowCommandService,
        FlowDiagramEffectsService,
        { provide: UiStateService, useValue: { isMobile: signal(false), activeView: signal<'text' | 'flow' | null>('flow') } },
        { provide: LoggerService, useValue: { category: () => mockLogger } },
        { provide: ToastService, useValue: { error: vi.fn(), info: vi.fn(), success: vi.fn(), warning: vi.fn() } },
        { provide: ThemeService, useValue: { isDark: signal(false), theme: signal('paper') } },
        { provide: PreferenceService, useValue: { theme: signal('paper') } },
        { provide: FlowLayoutService, useValue: { setDiagram: vi.fn(), dispose: vi.fn() } },
        { provide: FlowSelectionService, useValue: mockSelectionService },
        { provide: FlowZoomService, useValue: mockZoomService },
        { provide: FlowEventService, useValue: { setDiagram: vi.fn(), dispose: vi.fn() } },
        { provide: FlowTemplateService, useValue: { ensureDiagramLayers: vi.fn(), setupNodeTemplate: vi.fn(), closeSiyuanPopover: vi.fn() } },
        { provide: FlowLinkTemplateService, useValue: { setupLinkTemplate: vi.fn() } },
        { provide: FlowOverviewService, useValue: mockOverviewService },
        { provide: FlowDiagramDataService, useValue: mockDataService },
        { provide: FlowTouchService, useValue: mockTouchService },
        { provide: ProjectStateService, useValue: mockProjectState },
        { provide: SentryLazyLoaderService, useValue: { captureException: vi.fn() } },
        { provide: NgZone, useValue: new NgZone({ enableLongStackTrace: false }) },
      ],
    });

    service = TestBed.inject(FlowDiagramService);
    mockDataService.abortHardRecovery.mockImplementation(() => {
      TestBed.inject(FlowCommandService).markViewDestroyed();
    });
    mockDataService.dispose.mockImplementation(() => {
      TestBed.inject(FlowCommandService).markViewDestroyed();
    });

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
      Reflect.deleteProperty(globalThis as unknown as Record<string, unknown>, 'requestAnimationFrame');
    }

    if (originalCancelAnimationFrame) {
      globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
    } else {
      Reflect.deleteProperty(globalThis as unknown as Record<string, unknown>, 'cancelAnimationFrame');
    }

    if (originalDevicePixelRatioDescriptor) {
      Object.defineProperty(window, 'devicePixelRatio', originalDevicePixelRatioDescriptor);
    } else {
      Reflect.deleteProperty(window as unknown as Record<string, unknown>, 'devicePixelRatio');
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

  type RecoveryToken = Readonly<{ projectId: string; generation: number }>;
  type RecoveryInternals = {
    abortHardRecovery: (token: RecoveryToken) => void;
    beginHardRecovery: () => RecoveryToken | null;
    releaseHardRecovery: (token: RecoveryToken) => boolean;
    hardRecoveryHold: () => RecoveryToken | null;
    recovery: {
      hardRecoveryInProgress: boolean;
      hardRecoveryToken: RecoveryToken | null;
      armResizeRecovery: () => void;
      resetForInitialize: (container: HTMLDivElement, token?: RecoveryToken) => void;
      completeRecoveryVerification: (allowHardRecovery: boolean, token?: RecoveryToken) => void;
      tryHardDiagramRecovery: () => boolean;
      runtime: {
        initializeOutsideZone: (container: HTMLDivElement, token: RecoveryToken) => boolean;
        teardownDiagramForRecovery: () => void;
        updateDiagram: (forceRefresh: boolean) => boolean;
      };
    };
  };

  const recoveryInternals = () => service as unknown as RecoveryInternals;

  function stubHardRecovery(initializeResult: boolean, updateResult: boolean) {
    const diagram = attachDiagram(new go.Point(1200, 900), 0.45);
    (diagram as typeof diagram & { clear: () => void }).clear = vi.fn();
    const internal = recoveryInternals();
    let resetPreservedOwnership = false;
    internal.recovery.runtime.teardownDiagramForRecovery = vi.fn();
    internal.recovery.runtime.initializeOutsideZone = vi.fn((target, token) => {
      internal.recovery.resetForInitialize(target, token);
      resetPreservedOwnership = internal.recovery.hardRecoveryInProgress;
      return initializeResult;
    });
    internal.recovery.runtime.updateDiagram = vi.fn(() => updateResult);
    return { diagram, internal, resetPreservedOwnership: () => resetPreservedOwnership };
  }

  it('exposes the active project identity for lifecycle readiness fencing', () => {
    expect(service.activeProjectId).toBe('project-a');

    switchProject('project-b');

    expect(service.activeProjectId).toBe('project-b');
  });

  it('terminally aborts a failed hard recovery while preserving its pending center command', () => {
    const harness = stubHardRecovery(true, false);
    mockDataService.updateDiagram.mockReturnValue(true);
    const effects = TestBed.inject(FlowDiagramEffectsService);
    const commands = TestBed.inject(FlowCommandService);
    const injector = TestBed.inject(Injector);
    const executeCenter = vi.fn();
    commands.markViewReady(mockProjectState.captureActiveProjectOwner());
    const taskEffect = effects.createTasksEffect(injector, (tasks, force) =>
      effects.scheduleRafDiagramUpdate(tasks, force, () => false));
    const centerEffect = effects.createCenterCommandEffect(injector, executeCenter);
    TestBed.flushEffects();
    expect(harness.internal.recovery.tryHardDiagramRecovery()).toBe(false);
    const token = harness.internal.recovery.hardRecoveryToken!;
    commands.centerOnNode('task-1', false);
    TestBed.flushEffects(); vi.runOnlyPendingTimers(); TestBed.flushEffects();
    expect(harness.internal.hardRecoveryHold()).toBeNull();
    expect(mockDataService.abortHardRecovery).toHaveBeenCalled();
    expect(executeCenter).not.toHaveBeenCalled();
    expect(commands.centerNodeCommand()).not.toBeNull();

    (service as unknown as { _initializeOutsideZone: () => boolean })._initializeOutsideZone = vi.fn(() => true);
    expect(service.initialize(container)).toBe(true);
    expect(harness.internal.hardRecoveryHold()).toBeNull();
    expect(harness.internal.releaseHardRecovery(token)).toBe(false);
    TestBed.flushEffects(); vi.runOnlyPendingTimers(); TestBed.flushEffects();
    expect(mockDataService.updateDiagram).toHaveBeenCalledTimes(1);
    expect(executeCenter).not.toHaveBeenCalled();
    commands.markViewReady(mockProjectState.captureActiveProjectOwner());
    TestBed.flushEffects();
    expect(executeCenter).toHaveBeenCalledWith('task-1', false);
    expect(commands.centerNodeCommand()).toBeNull();
    taskEffect.destroy(); centerEffect.destroy();
  });

  it.each([
    ['initialization failure', false, true],
    ['model update failure', true, false],
  ])('publishes a terminal abort after %s', (_label, initializeResult, updateResult) => {
    const harness = stubHardRecovery(initializeResult, updateResult);
    expect(harness.internal.recovery.tryHardDiagramRecovery()).toBe(false);
    expect(harness.internal.hardRecoveryHold()).toBeNull();
    expect(mockDataService.abortHardRecovery).toHaveBeenCalled();
    expect(mockZoomService.fitToContents).not.toHaveBeenCalled();
    expect(mockSelectionService.selectMultiple).not.toHaveBeenCalled();
    expect(harness.resetPreservedOwnership()).toBe(true);
    const matchingToken = harness.internal.recovery.hardRecoveryToken!;
    harness.internal.recovery.resetForInitialize(container, { ...matchingToken });
    expect(harness.internal.recovery.hardRecoveryToken).toBeNull();
  });

  it('keeps invisible fallback held and releases once after visible verification', () => {
    const { diagram, internal } = stubHardRecovery(true, true);
    const viewportProofPublisher: {
      current: ((proof: { kind: 'FIT_TO_CONTENTS_APPLIED' }) => void) | null;
    } = { current: null };
    mockDataService.applyHardRecoveryViewport.mockImplementationOnce((
      _viewState: unknown,
      complete: (proof: { kind: 'FIT_TO_CONTENTS_APPLIED' }) => void,
    ) => {
      viewportProofPublisher.current = complete;
      return true;
    });

    expect(internal.recovery.tryHardDiagramRecovery()).toBe(true);
    const token = internal.recovery.hardRecoveryToken!;
    expect(service.isInitialized).toBe(false);
    expect(mockDataService.applyHardRecoveryViewport).not.toHaveBeenCalled();
    vi.runOnlyPendingTimers();
    expect(mockZoomService.fitToContents).toHaveBeenCalledTimes(1);
    expect(service.isInitialized).toBe(false);

    diagram.position = new go.Point(0, 0);
    Object.defineProperty(diagram, 'viewportBounds', {
      configurable: true, value: { isReal: () => true, width: 800, height: 600, intersectsRect: () => true },
    });
    expect(internal.recovery.hardRecoveryToken).toBe(token);
    expect(internal.hardRecoveryHold()).toBe(token);
    internal.recovery.completeRecoveryVerification(false, token);
    expect(mockDataService.applyHardRecoveryViewport).toHaveBeenCalledOnce();
    expect(mockDataService.completeHardRecovery).not.toHaveBeenCalled();
    expect(service.isInitialized).toBe(false);
    expect(internal.hardRecoveryHold()).toBe(token);
    viewportProofPublisher.current?.({ kind: 'FIT_TO_CONTENTS_APPLIED' });
    expect(mockDataService.completeHardRecovery).toHaveBeenCalledOnce();
    expect(service.isInitialized).toBe(true);
    expect(internal.hardRecoveryHold()).toBeNull();
    vi.runOnlyPendingTimers();
    expect(mockZoomService.fitToContents).toHaveBeenCalledTimes(1);
  });

  it('irreversibly retires stale project tokens without clearing a newer hold', () => {
    attachDiagram();
    const internal = recoveryInternals();
    const commands = TestBed.inject(FlowCommandService);
    const tokenA = internal.beginHardRecovery()!;
    switchProject('project-b');
    switchProject('project-a');
    expect(internal.releaseHardRecovery(tokenA)).toBe(false);
    expect(mockDataService.abortHardRecovery).toHaveBeenCalledOnce();

    const observedTokenA = internal.beginHardRecovery()!;
    switchProject('project-b');
    expect(service.isInitialized).toBe(true);
    expect(mockDataService.abortHardRecovery).toHaveBeenCalledTimes(2);
    commands.markViewReady(mockProjectState.captureActiveProjectOwner());
    switchProject('project-a');
    expect(internal.releaseHardRecovery(observedTokenA)).toBe(false);
    switchProject('project-b');
    expect(commands.isViewReady()).toBe(false);
    const tokenB = internal.beginHardRecovery()!;
    mockDataService.abortHardRecovery.mockClear();
    internal.abortHardRecovery(tokenA);
    expect(mockDataService.abortHardRecovery).not.toHaveBeenCalled();
    expect(internal.hardRecoveryHold()).toBe(tokenB);
    expect(service.isInitialized).toBe(false);
    internal.abortHardRecovery(tokenB);
    expect(mockDataService.abortHardRecovery).toHaveBeenCalledOnce();
    expect(internal.hardRecoveryHold()).toBeNull();
  });

  it('clears a held token on disposal while ordinary resize recovery leaves readiness intact', () => {
    attachDiagram();
    const commands = TestBed.inject(FlowCommandService);
    commands.markViewReady(mockProjectState.captureActiveProjectOwner());
    recoveryInternals().recovery.armResizeRecovery();
    expect(service.isInitialized).toBe(true);
    expect(commands.isViewReady()).toBe(true);

    (service as unknown as { diagram: null }).diagram = null;
    const token = recoveryInternals().beginHardRecovery()!;
    service.dispose();
    expect(recoveryInternals().releaseHardRecovery(token)).toBe(false);
    expect(commands.isViewReady()).toBe(false);
  });

  it('clearAllTimers 应清理 handle 为 0 的 resize debounce timer', () => {
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
    const internal = service as unknown as {
      resizeDebounceTimer: ReturnType<typeof setTimeout> | null;
      clearAllTimers: () => void;
    };
    internal.resizeDebounceTimer = 0 as unknown as ReturnType<typeof setTimeout>;

    internal.clearAllTimers();

    expect(clearTimeoutSpy).toHaveBeenCalledWith(0);
    expect(internal.resizeDebounceTimer).toBeNull();
  });

  it('ResizeObserver 重排 debounce 时应取消 handle 为 0 的旧 timer', () => {
    const originalResizeObserver = globalThis.ResizeObserver;
    let observerCallback: ResizeObserverCallback | null = null;

    class TestResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        observerCallback = callback;
      }

      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
    }

    globalThis.ResizeObserver = TestResizeObserver as unknown as typeof ResizeObserver;

    try {
      const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
      const internal = service as unknown as {
        diagramDiv: HTMLDivElement;
        resizeDebounceTimer: ReturnType<typeof setTimeout> | null;
        setupResizeObserver: () => void;
      };
      internal.diagramDiv = container;
      internal.resizeDebounceTimer = 0 as unknown as ReturnType<typeof setTimeout>;

      internal.setupResizeObserver();
      expect(observerCallback).toBeTypeOf('function');
      (observerCallback as unknown as ResizeObserverCallback)([
        {
          contentRect: {
            width: currentWidth,
            height: currentHeight,
          },
        } as ResizeObserverEntry,
      ], {} as ResizeObserver);

      expect(clearTimeoutSpy).toHaveBeenCalledWith(0);
      expect(internal.resizeDebounceTimer).not.toBe(0);
    } finally {
      if (typeof originalResizeObserver === 'undefined') {
        Reflect.deleteProperty(globalThis as unknown as Record<string, unknown>, 'ResizeObserver');
      } else {
        globalThis.ResizeObserver = originalResizeObserver;
      }
    }
  });

  it('应在容器进入危险小尺寸时阻止坏视口状态持久化', () => {
    currentWidth = 120;
    currentHeight = 96;
    attachDiagram();

    const internal = service as unknown as {
      recovery: {
        resizeRecoveryArmed: boolean;
        lastStableViewState: ViewState | null;
      };
      handleViewportBoundsChanged: () => void;
    };
    internal.recovery.resizeRecoveryArmed = true;

    internal.handleViewportBoundsChanged();

    expect(mockDataService.saveViewState).not.toHaveBeenCalled();
    expect(internal.recovery.lastStableViewState).toBeNull();
  });

  it('设备像素比变化时应触发恢复链路而不是静默保留旧 canvas', () => {
    attachDiagram();

    const internal = service as unknown as {
      recovery: { lastKnownDevicePixelRatio: number };
      syncViewportMetrics: () => void;
    };
    internal.recovery.lastKnownDevicePixelRatio = 1;
    Object.defineProperty(window, 'devicePixelRatio', {
      configurable: true,
      value: 1.5,
    });

    internal.syncViewportMetrics();
    vi.runAllTimers();

    expect(mockDataService.cancelPendingViewStateSave).toHaveBeenCalledTimes(1);
    expect(mockZoomService.cancelPendingViewStateSave).toHaveBeenCalledTimes(1);
    expect(internal.recovery.lastKnownDevicePixelRatio).toBe(1.5);
  });

  it('应在容器从危险小尺寸恢复后回到最近的稳定视口', () => {
    currentWidth = 120;
    currentHeight = 96;
    const diagram = attachDiagram(new go.Point(1200, 900), 0.45);

    const internal = service as unknown as {
      recovery: {
        lastRecoverableViewState: ViewState | null;
        resizeRecoveryArmed: boolean;
        lastStableViewState: ViewState | null;
        handleContainerResize: (width: number, height: number) => void;
      };
    };
    internal.recovery.lastRecoverableViewState = {
      scale: 1.2,
      positionX: 18,
      positionY: 24,
    };
    internal.recovery.lastStableViewState = {
      scale: 1.2,
      positionX: 18,
      positionY: 24,
    };

    internal.recovery.handleContainerResize(currentWidth, currentHeight);
    expect(internal.recovery.resizeRecoveryArmed).toBe(true);

    const restoreInternal = service as unknown as {
      recovery: {
        lastRecoverableViewState: ViewState | null;
        lastStableViewState: ViewState | null;
        restoreBestKnownViewState: () => boolean;
      };
    };
    restoreInternal.recovery.lastRecoverableViewState = {
      scale: 1.2,
      positionX: 18,
      positionY: 24,
    };
    restoreInternal.recovery.lastStableViewState = {
      scale: 1.2,
      positionX: 18,
      positionY: 24,
    };

    restoreInternal.recovery.restoreBestKnownViewState();
    expect(diagram.scale).toBe(1.2);
    expect(diagram.position.x).toBe(18);
    expect(diagram.position.y).toBe(24);

    diagram.scale = 0.45;
    diagram.position = new go.Point(1200, 900);

    currentWidth = 960;
    currentHeight = 720;

    internal.recovery.handleContainerResize(currentWidth, currentHeight);
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
      recovery: {
        lastRecoverableViewState: ViewState | null;
        lastStableViewState: ViewState | null;
        restoreBestKnownViewState: () => boolean;
      };
    };
    internal.recovery.lastRecoverableViewState = {
      scale: 0.45,
      positionX: 1200,
      positionY: 900,
    };
    internal.recovery.lastStableViewState = {
      scale: 1.15,
      positionX: 20,
      positionY: 28,
    };

    internal.recovery.restoreBestKnownViewState();
    expect(diagram.scale).toBe(1.15);
    expect(diagram.position.x).toBe(20);
    expect(diagram.position.y).toBe(28);
  });

  it('普通恢复后仍不可见时应升级到原地重建路径', () => {
    currentWidth = 960;
    currentHeight = 720;
    attachDiagram(new go.Point(1200, 900), 0.45);

    const internal = service as unknown as {
      recovery: {
        resizeRecoveryArmed: boolean;
        restoreBestKnownViewState: () => boolean;
        tryHardDiagramRecovery: () => boolean;
        recoverAfterUnsafeResize: () => void;
      };
    };
    internal.recovery.resizeRecoveryArmed = true;
    internal.recovery.restoreBestKnownViewState = vi.fn(() => false);
    internal.recovery.tryHardDiagramRecovery = vi.fn(() => true);
    mockZoomService.fitToContents.mockImplementation(() => undefined);

    internal.recovery.recoverAfterUnsafeResize();
    vi.runAllTimers();

    expect(internal.recovery.tryHardDiagramRecovery).toHaveBeenCalledTimes(1);
  });

  it('硬恢复兜底 fit 仍失败时应保持 recovery armed 并释放 mutex', () => {
    currentWidth = 960;
    currentHeight = 720;
    attachDiagram(new go.Point(1200, 900), 0.45);

    const internal = service as unknown as {
      recovery: {
        resizeRecoveryArmed: boolean;
        hardRecoveryInProgress: boolean;
        recoveryFitFallbackUsed: boolean;
        completeRecoveryVerification: (allowHardRecovery: boolean) => void;
      };
    };
    internal.recovery.resizeRecoveryArmed = false;
    internal.recovery.hardRecoveryInProgress = true;
    internal.recovery.recoveryFitFallbackUsed = true;

    internal.recovery.completeRecoveryVerification(false);

    expect(internal.recovery.resizeRecoveryArmed).toBe(true);
    expect(internal.recovery.hardRecoveryInProgress).toBe(false);
  });

  it('节点拖出画布边界时应取消 GoJS 拖拽并还原节点位置', () => {
    const originalLocation = new go.Point(10, 20);
    const node = new go.Node();
    Object.defineProperty(node, 'key', {
      configurable: true,
      value: 'task-1',
    });
    node.location = originalLocation.copy();
    const draggingTool = {
      doActivate: vi.fn(),
      doMouseMove: vi.fn(),
      doCancel: vi.fn(),
    };
    const selection = {
      count: 1,
      each: (callback: (part: go.Part) => void) => callback(node as unknown as go.Part),
    };
    const diagram = {
      toolManager: { draggingTool },
      selection,
      lastInput: { viewPoint: new go.Point(100, 660) },
      startTransaction: vi.fn(),
      commitTransaction: vi.fn(),
      findNodeForKey: vi.fn(() => node),
    } as unknown as go.Diagram;
    const dragOutHandler = vi.fn();
    flowTemplateEventHandlers.onNodesDragOutOfBounds = dragOutHandler;

    const internal = service as unknown as {
      diagram: go.Diagram;
      diagramDiv: HTMLDivElement;
      setupDragOutOfBoundsTool: (diagram: go.Diagram) => void;
    };
    internal.diagram = diagram;
    internal.diagramDiv = container;
    Object.defineProperty(container, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        left: 0,
        right: 800,
        top: 0,
        bottom: 600,
        width: 800,
        height: 600,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }),
    });

    internal.setupDragOutOfBoundsTool(diagram);
    draggingTool.doActivate();
    node.location = new go.Point(40, 80);
    draggingTool.doMouseMove();

    expect(draggingTool.doCancel).toHaveBeenCalledTimes(1);
    expect(node.location.x).toBe(10);
    expect(node.location.y).toBe(20);
    expect(dragOutHandler).toHaveBeenCalledWith(['task-1'], 100, 660);
    expect(diagram.startTransaction).toHaveBeenCalledWith('restore-drag-positions');
    expect(diagram.commitTransaction).toHaveBeenCalledWith('restore-drag-positions');
  });

  it('propagates the diagram data update outcome unchanged', () => {
    mockDataService.updateDiagram
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);

    expect(service.updateDiagram([])).toBe(false);
    expect(service.updateDiagram([], true)).toBe(true);
    expect(mockDataService.updateDiagram).toHaveBeenNthCalledWith(1, [], false);
    expect(mockDataService.updateDiagram).toHaveBeenNthCalledWith(2, [], true);
  });
});
