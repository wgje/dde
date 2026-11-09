import { TestBed } from '@angular/core/testing';
import { NgZone } from '@angular/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as go from 'gojs';

import { FlowOverviewService } from './flow-overview.service';
import { LoggerService } from '../../../../services/logger.service';
import { ThemeService } from '../../../../services/theme.service';
import { FlowTemplateService } from './flow-template.service';
import { FlowLinkTemplateService } from './flow-link-template.service';
import { FlowDiagramConfigService } from './flow-diagram-config.service';
import { registerFlowOverviewConfigurationSpecs } from './flow-overview-configuration.spec-helpers';
import { registerFlowOverviewDragInteractionSpecs } from './flow-overview-drag-interaction.spec-helpers';
import { registerFlowOverviewPerformanceInteractionSpecs } from './flow-overview-performance-interaction.spec-helpers';
import { registerFlowOverviewPanRegressionSpecs } from './flow-overview-pan-regression.spec-helpers';

vi.mock('gojs', () => {
  class Point {
    constructor(
      public x = 0,
      public y = 0
    ) {}

    copy(): Point {
      return new Point(this.x, this.y);
    }

    equals(point: Point): boolean {
      return this.x === point.x && this.y === point.y;
    }
  }

  class Rect {
    constructor(
      public x = 0,
      public y = 0,
      public width = 0,
      public height = 0
    ) {}

    get right(): number {
      return this.x + this.width;
    }

    get bottom(): number {
      return this.y + this.height;
    }

    get center(): Point {
      return new Point(this.x + this.width / 2, this.y + this.height / 2);
    }

    isReal(): boolean {
      return [this.x, this.y, this.width, this.height].every(Number.isFinite);
    }

    containsPoint(point: Point): boolean {
      return point.x >= this.x && point.x <= this.right && point.y >= this.y && point.y <= this.bottom;
    }

    copy(): Rect {
      return new Rect(this.x, this.y, this.width, this.height);
    }

    unionRect(rect: Rect): Rect {
      const minX = Math.min(this.x, rect.x);
      const minY = Math.min(this.y, rect.y);
      const maxX = Math.max(this.right, rect.right);
      const maxY = Math.max(this.bottom, rect.bottom);
      this.x = minX;
      this.y = minY;
      this.width = maxX - minX;
      this.height = maxY - minY;
      return this;
    }
  }

  class Size {
    constructor(
      public width = 0,
      public height = 0
    ) {}

    equals(size: Size): boolean {
      return this.width === size.width && this.height === size.height;
    }
  }

  class Overview {
    box = {
      actualBounds: new Rect(0, 0, 800, 600),
      position: new Point(0, 0),
      location: new Point(0, 0),
      selectionObject: { desiredSize: new Size(800, 600), strokeWidth: 2 },
      isSelected: false,
    };
    position = new Point(0, 0);
    centerRect = vi.fn((rect: Rect) => {
      this.position = new Point(rect.x, rect.y);
      this.box.actualBounds = rect.copy();
      this.box.position = new Point(rect.x, rect.y);
      this.box.location = new Point(rect.x, rect.y);
      this.box.selectionObject.desiredSize = new Size(rect.width, rect.height);
      this.box.isSelected = true;
    });
    requestUpdate = vi.fn();
    transformViewToDoc = vi.fn((point: Point) => point);
    updateAllTargetBindings = vi.fn();
    div: HTMLDivElement | null;
    fixedBounds: Rect | undefined;
    observed: unknown;
    scale = 1;
    updateDelay = 0;

    get viewportBounds(): Rect {
      return new Rect(this.position.x, this.position.y, 800, 600);
    }

    constructor(div: HTMLDivElement, options: Record<string, unknown>) {
      this.div = div;
      Object.assign(this, options);
    }
  }

  return {
    Overview,
    Point,
    Rect,
    Size,
    Spot: { Center: new Point(0.5, 0.5) },
    AutoScale: { None: 1, Uniform: 2, UniformToFill: 3 },
  };
});

describe('FlowOverviewService', () => {
  let service: FlowOverviewService;
  let container: HTMLDivElement;
  let diagramPosition: InstanceType<typeof go.Point>;
  let observedViewportPosition: InstanceType<typeof go.Point>;
  let documentBounds: InstanceType<typeof go.Rect>;
  let delayViewportCommit: boolean;
  let viewportListener: (() => void) | null;
  let documentBoundsListener: (() => void) | null;
  let diagramRequestUpdate: ReturnType<typeof vi.fn>;
  let diagramPositionWriteCount: number;
  let diagramPositionClamp: ((position: InstanceType<typeof go.Point>) => InstanceType<typeof go.Point>) | null;
  let originalRequestAnimationFrame: typeof globalThis.requestAnimationFrame | undefined;
  let originalCancelAnimationFrame: typeof globalThis.cancelAnimationFrame | undefined;

  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    diagramPosition = new go.Point(0, 0);
    observedViewportPosition = new go.Point(0, 0);
    documentBounds = new go.Rect(0, 0, 400, 300);
    delayViewportCommit = false;
    viewportListener = null;
    documentBoundsListener = null;
    diagramRequestUpdate = vi.fn();
    diagramPositionWriteCount = 0;
    diagramPositionClamp = null;

    originalRequestAnimationFrame = globalThis.requestAnimationFrame;
    originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
    globalThis.requestAnimationFrame = ((callback: FrameRequestCallback): number =>
      setTimeout(() => callback(0), 0) as unknown as number) as typeof requestAnimationFrame;
    globalThis.cancelAnimationFrame = ((id: number): void => {
      clearTimeout(id as unknown as ReturnType<typeof setTimeout>);
    }) as typeof cancelAnimationFrame;

    TestBed.configureTestingModule({
      providers: [
        FlowOverviewService,
        { provide: LoggerService, useValue: { category: () => logger } },
        { provide: ThemeService, useValue: { isDark: () => false } },
        { provide: FlowTemplateService, useValue: { setupOverviewNodeTemplate: vi.fn(), setupOverviewBoxStyle: vi.fn() } },
        { provide: FlowLinkTemplateService, useValue: { setupOverviewLinkTemplate: vi.fn() } },
        { provide: FlowDiagramConfigService, useValue: { currentStyles: () => ({ text: { titleColor: '#292524' } }) } },
        { provide: NgZone, useValue: new NgZone({ enableLongStackTrace: false }) },
      ],
    });

    service = TestBed.inject(FlowOverviewService);
    container = document.createElement('div');
    Object.defineProperty(container, 'clientWidth', { configurable: true, value: 180 });
    Object.defineProperty(container, 'clientHeight', { configurable: true, value: 140 });
    container.setPointerCapture = vi.fn();
    container.releasePointerCapture = vi.fn();
    document.body.appendChild(container);

    service.setDiagram(createDiagramMock());
    service.initializeOverview(container, false);
    vi.runOnlyPendingTimers();
  });

  afterEach(() => {
    service.destroyOverview();
    container.remove();
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
    vi.useRealTimers();
    TestBed.resetTestingModule();
  });

  registerFlowOverviewConfigurationSpecs({
    getService: () => service,
  });

  registerFlowOverviewDragInteractionSpecs({
    getService: () => service,
    getContainer: () => container,
    getDiagramPosition: () => diagramPosition,
    setDiagramPosition: position => {
      diagramPosition = position;
    },
    setObservedViewportPosition: position => {
      observedViewportPosition = position;
    },
    setDocumentBounds: bounds => {
      documentBounds = bounds;
    },
    getViewportListener: () => viewportListener,
    getDocumentBoundsListener: () => documentBoundsListener,
    setDelayViewportCommit: delayed => {
      delayViewportCommit = delayed;
    },
    commitObservedViewportPosition,
    dispatchPointer,
    dispatchMouse,
    expectCenteredBoundsToContainViewport,
  });

  // ============ 2026-05-15 A1/A2/A4 根因修复回归（PR #64）============

  it('A1：documentBounds 未就绪时初始化必须保持 overview.observed 为 null', () => {
    // 销毁 beforeEach 创建的实例，重新走未就绪路径
    service.destroyOverview();
    container.remove();

    container = document.createElement('div');
    Object.defineProperty(container, 'clientWidth', { configurable: true, value: 180 });
    Object.defineProperty(container, 'clientHeight', { configurable: true, value: 140 });
    container.setPointerCapture = vi.fn();
    container.releasePointerCapture = vi.fn();
    document.body.appendChild(container);

    // 让 documentBounds.isReal() 返回 false（width/height 为 NaN）
    documentBounds = new go.Rect(0, 0, NaN, NaN);
    const diagramMock = createDiagramMock();
    service.setDiagram(diagramMock);
    service.initializeOverview(container, false);
    vi.runOnlyPendingTimers();

    const overview = service.overviewInstance as unknown as { observed: unknown };
    expect(overview).toBeTruthy();
    // 未就绪：observed 必须不是 diagram
    expect(overview.observed).not.toBe(diagramMock);
  });

  it('A1：documentBounds 就绪后通过 InitialLayoutCompleted 回填 observed', () => {
    service.destroyOverview();
    container.remove();
    container = document.createElement('div');
    Object.defineProperty(container, 'clientWidth', { configurable: true, value: 180 });
    Object.defineProperty(container, 'clientHeight', { configurable: true, value: 140 });
    container.setPointerCapture = vi.fn();
    container.releasePointerCapture = vi.fn();
    document.body.appendChild(container);

    documentBounds = new go.Rect(0, 0, NaN, NaN);

    // 自建 diagram，捕获 InitialLayoutCompleted listener 引用
    let initialLayoutHandler: (() => void) | null = null;
    const diagramMock = {
      get documentBounds(): InstanceType<typeof go.Rect> {
        return documentBounds;
      },
      model: { nodeDataArray: [{ key: 'a' }] },
      skipsUndoManager: false,
      requestUpdate: vi.fn(),
      addDiagramListener: vi.fn((name: string, handler: () => void) => {
        if (name === 'InitialLayoutCompleted') initialLayoutHandler = handler;
        if (name === 'ViewportBoundsChanged') viewportListener = handler;
      }),
      removeDiagramListener: vi.fn(),
      get position(): InstanceType<typeof go.Point> {
        return diagramPosition;
      },
      set position(value: InstanceType<typeof go.Point>) {
        diagramPosition = value.copy();
        viewportListener?.();
      },
      get viewportBounds(): InstanceType<typeof go.Rect> {
        return new go.Rect(0, 0, 800, 600);
      },
    } as unknown as go.Diagram;

    service.setDiagram(diagramMock);
    service.initializeOverview(container, false);
    vi.runOnlyPendingTimers();

    const overview = service.overviewInstance as unknown as { observed: unknown };
    expect(overview.observed).not.toBe(diagramMock);
    expect(initialLayoutHandler).toBeTruthy();

    // 模拟首次布局完成
    documentBounds = new go.Rect(0, 0, 400, 300);
    initialLayoutHandler!();

    expect(overview.observed).toBe(diagramMock);
  });

  it('A2：销毁后所有 setter 必须 no-op，不抛错', () => {
    // 销毁后再调用任何 public 方法都不能抛错
    service.destroyOverview();

    expect(() => service.refreshOverview()).not.toThrow();
    expect(() => service.updateTheme()).not.toThrow();
    expect(service.overviewInstance).toBeNull();
    expect(service.isOverviewInitialized).toBe(false);
  });

  it('A2：销毁时必须 observed=null 再 div=null，杜绝异步 tick 持有 stale 引用', () => {
    const overview = service.overviewInstance as unknown as {
      observed: unknown;
      div: HTMLDivElement | null;
    };
    const internals = service as unknown as { diagram: go.Diagram | null };
    expect(overview.observed).toBeTruthy();
    expect(overview.div).toBe(container);
    expect(internals.diagram).toBeTruthy();

    service.destroyOverview();

    // 销毁后 service 内部引用被释放，overviewInstance 应为 null
    expect(service.overviewInstance).toBeNull();
    expect(internals.diagram).toBeNull();
    // GoJS Overview 实例本身的 observed / div 应已被解除
    expect(overview.observed).toBeNull();
    expect(overview.div).toBeNull();
  });

  it('A4：注册全局自愈钩子 __NANOFLOW_OVERVIEW_HEAL__，调用时触发 requestUpdate', () => {
    type HealWindow = Window & { __NANOFLOW_OVERVIEW_HEAL__?: () => void };
    const heal = (window as HealWindow).__NANOFLOW_OVERVIEW_HEAL__;
    expect(typeof heal).toBe('function');

    const overview = service.overviewInstance as unknown as {
      requestUpdate: ReturnType<typeof vi.fn>;
    };
    const before = overview.requestUpdate.mock.calls.length;

    heal!();

    expect(overview.requestUpdate.mock.calls.length).toBe(before + 1);
  });

  it('A4：销毁后调用自愈钩子必须 no-op（不能再触发 stale overview）', () => {
    type HealWindow = Window & { __NANOFLOW_OVERVIEW_HEAL__?: () => void };
    const heal = (window as HealWindow).__NANOFLOW_OVERVIEW_HEAL__;

    service.destroyOverview();

    // 销毁后自愈钩子应被卸载，或调用时安全 no-op
    expect(() => heal?.()).not.toThrow();
    expect((window as HealWindow).__NANOFLOW_OVERVIEW_HEAL__).toBeUndefined();
  });

  // ============ 2026-05-15 性能修复回归（PR #65）============

  registerFlowOverviewPerformanceInteractionSpecs({
    getService: () => service,
    getContainer: () => container,
    getDiagramPosition: () => diagramPosition,
    getDiagramRequestUpdate: () => diagramRequestUpdate,
    getDiagramPositionWriteCount: () => diagramPositionWriteCount,
    setDiagramPositionClamp: clamp => {
      diagramPositionClamp = clamp;
    },
    getViewportListener: () => viewportListener,
    getDocumentBoundsListener: () => documentBoundsListener,
    setDocumentBounds: bounds => {
      documentBounds = bounds;
    },
    dispatchPointer,
  });
  registerFlowOverviewPanRegressionSpecs({
    getService: () => service,
    getDiagramPosition: () => diagramPosition,
    setDiagramPosition: position => {
      diagramPosition = position;
    },
    setObservedViewportPosition: position => {
      observedViewportPosition = position;
    },
    setDocumentBounds: bounds => {
      documentBounds = bounds;
    },
    getViewportListener: () => viewportListener,
    getDocumentBoundsListener: () => documentBoundsListener,
    dispatchPointer,
  });

  function createDiagramMock(): go.Diagram {
    const listeners = new Map<string, () => void>();
    const diagram = {
      get documentBounds(): InstanceType<typeof go.Rect> {
        return documentBounds;
      },
      model: { nodeDataArray: [{ key: 'a' }] },
      skipsUndoManager: false,
      requestUpdate: diagramRequestUpdate,
      addDiagramListener: vi.fn((name: string, handler: () => void) => {
        listeners.set(name, handler);
        if (name === 'DocumentBoundsChanged') {
          documentBoundsListener = handler;
        }
        if (name === 'ViewportBoundsChanged') {
          viewportListener = handler;
        }
      }),
      removeDiagramListener: vi.fn((name: string) => listeners.delete(name)),
      get position(): InstanceType<typeof go.Point> {
        return diagramPosition;
      },
      set position(value: InstanceType<typeof go.Point>) {
        diagramPositionWriteCount += 1;
        const acceptedPosition = diagramPositionClamp ? diagramPositionClamp(value) : value;
        diagramPosition = acceptedPosition.copy();
        if (!delayViewportCommit) {
          observedViewportPosition = acceptedPosition.copy();
        }
        viewportListener?.();
      },
      get viewportBounds(): InstanceType<typeof go.Rect> {
        return new go.Rect(observedViewportPosition.x, observedViewportPosition.y, 800, 600);
      },
    };

    return diagram as unknown as go.Diagram;
  }

  function dispatchPointer(type: string, clientX: number, clientY: number): void {
    container.dispatchEvent(new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      pointerId: 1,
      clientX,
      clientY,
    }));
  }

  function dispatchMouse(target: EventTarget, type: string, clientX: number, clientY: number): void {
    target.dispatchEvent(new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX,
      clientY,
    }));
  }

  function commitObservedViewportPosition(): void {
    observedViewportPosition = diagramPosition.copy();
    viewportListener?.();
  }

  function expectCenteredBoundsToContainViewport(
    bounds: InstanceType<typeof go.Rect>,
    x: number,
    y: number,
  ): void {
    expect(bounds.x).toBeLessThanOrEqual(x);
    expect(bounds.y).toBeLessThanOrEqual(y);
    expect(bounds.right).toBeGreaterThanOrEqual(x + 800);
    expect(bounds.bottom).toBeGreaterThanOrEqual(y + 600);
  }
});
