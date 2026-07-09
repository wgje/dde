/**
 * FlowMinimapComponent 纯函数单测。
 *
 * 聚焦可独立验证的核心逻辑（无需 GoJS / TestBed）：
 * - 几何：unionWorldRect / computeViewBox（根治抖动+瞬移的 React Flow 同款公式，
 *   用真实样本数据逐位验证）。
 * - 颜色：resolveNodeFill / resolveNodeStroke / resolveNodeStrokeWidth
 *   （修复历史「白块」+ 状态色映射）。
 *
 * 拖动跟手/点击定位的几何精度在浏览器实地验证（见策划案 §5），比 gojs mock 更可靠。
 */
import { describe, it, expect, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import * as go from 'gojs';
import { LoggerService } from '../../../../services/logger.service';
import { FlowDiagramConfigService } from '../services/flow-diagram-config.service';
import { FlowDiagramService } from '../services/flow-diagram.service';
import {
  FlowMinimapComponent,
  unionWorldRect,
  computeViewBox,
  resolveNodeFill,
  resolveNodeStroke,
  resolveNodeStrokeWidth,
  buildDecorationPips,
  type MinimapWorldRect,
  type MinimapNodeData,
} from './flow-minimap.component';

type FlowMinimapInternals = {
  attachTo(diagram: go.Diagram): void;
  scheduleRebuild(): void;
  ngOnDestroy(): void;
  svgEl: SVGSVGElement | null;
  boundDiagram: go.Diagram | null;
  viewportHandler: DiagramListener | null;
  documentHandler: DiagramListener | null;
  modelHandler: ModelListener | null;
};

type DiagramListener = (event: go.DiagramEvent) => void;
type ModelListener = (event: go.ChangedEvent) => void;

interface FakeMinimapNode {
  key: string;
  data: MinimapNodeData;
  actualBounds: go.Rect;
}

class FakeMinimapDiagram {
  readonly diagramListeners = new Map<string, DiagramListener[]>();
  readonly modelListeners: ModelListener[] = [];
  removeDiagramListenerError: Error | null = null;
  nodeEntries: FakeMinimapNode[] = [];
  linkEntries: Array<Record<string, unknown>> = [];
  viewportBounds = new go.Rect(0, 0, 100, 80);
  position = new go.Point(0, 0);
  scale = 1;
  minScale = 0.05;
  maxScale = 3;
  readonly nodes = {
    each: (callback: (node: FakeMinimapNode) => void) => {
      this.nodeEntries.forEach(callback);
    },
  };
  readonly links = {
    each: (callback: (link: Record<string, unknown>) => void) => {
      this.linkEntries.forEach(callback);
    },
  };

  addDiagramListener(name: string, listener: DiagramListener): void {
    const listeners = this.diagramListeners.get(name) ?? [];
    listeners.push(listener);
    this.diagramListeners.set(name, listeners);
  }

  removeDiagramListener(name: string, listener: DiagramListener): void {
    if (this.removeDiagramListenerError) {
      throw this.removeDiagramListenerError;
    }
    const listeners = this.diagramListeners.get(name) ?? [];
    this.diagramListeners.set(name, listeners.filter((candidate) => candidate !== listener));
  }

  addModelChangedListener(listener: ModelListener): void {
    this.modelListeners.push(listener);
  }

  removeModelChangedListener(listener: ModelListener): void {
    const index = this.modelListeners.indexOf(listener);
    if (index >= 0) this.modelListeners.splice(index, 1);
  }
}

function createPointerEvent(type: string, init: { pointerId: number; clientX: number; clientY: number }): PointerEvent {
  const event = new Event(type, { bubbles: true, cancelable: true }) as PointerEvent;
  Object.defineProperties(event, {
    pointerId: { value: init.pointerId },
    clientX: { value: init.clientX },
    clientY: { value: init.clientY },
  });
  return event;
}

function installQueuedAnimationFrame(): {
  flushNext(): void;
  restore(): void;
} {
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
  const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
  const queue: Array<{ id: number; callback: FrameRequestCallback; canceled: boolean }> = [];
  let nextId = 1;
  globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
    const id = nextId++;
    queue.push({ id, callback, canceled: false });
    return id;
  }) as typeof globalThis.requestAnimationFrame;
  globalThis.cancelAnimationFrame = ((id: number) => {
    const entry = queue.find(candidate => candidate.id === id);
    if (entry) entry.canceled = true;
  }) as typeof globalThis.cancelAnimationFrame;

  return {
    flushNext: () => {
      const entry = queue.shift();
      if (entry && !entry.canceled) {
        entry.callback(0);
      }
    },
    restore: () => {
      if (originalRequestAnimationFrame) {
        globalThis.requestAnimationFrame = originalRequestAnimationFrame;
      } else {
        Reflect.deleteProperty(globalThis as Record<string, unknown>, 'requestAnimationFrame');
      }
      if (originalCancelAnimationFrame) {
        globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
      } else {
        Reflect.deleteProperty(globalThis as Record<string, unknown>, 'cancelAnimationFrame');
      }
    },
  };
}

function createFlowMinimapHarness(diagram: go.Diagram | null = null): {
  fixture: ReturnType<typeof TestBed.createComponent<FlowMinimapComponent>>;
  component: FlowMinimapComponent;
  flowDiagram: { isInitialized: boolean; diagramInstance: go.Diagram | null };
} {
  TestBed.resetTestingModule();
  const flowDiagram = {
    isInitialized: diagram !== null,
    diagramInstance: diagram,
  };
  TestBed.configureTestingModule({
    imports: [FlowMinimapComponent],
    providers: [
      {
        provide: FlowDiagramService,
        useValue: flowDiagram,
      },
      {
        provide: FlowDiagramConfigService,
        useValue: {
          currentStyles: () => ({
            link: {
              crossTreeColor: '#818cf8',
              parentChildColor: '#94a3b8',
            },
          }),
        },
      },
      {
        provide: LoggerService,
        useValue: {
          category: () => ({
            debug: vi.fn(),
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
          }),
        },
      },
    ],
  });
  const fixture = TestBed.createComponent(FlowMinimapComponent);
  return { fixture, component: fixture.componentInstance, flowDiagram };
}

function createFlowMinimapComponent(): FlowMinimapComponent {
  return createFlowMinimapHarness().component;
}

describe('FlowMinimapComponent frame scheduling', () => {
  it('renders a focusable interactive SVG with keyboard instructions', () => {
    const { fixture } = createFlowMinimapHarness();

    fixture.detectChanges();

    const svg = fixture.nativeElement.querySelector('svg') as SVGSVGElement | null;
    expect(svg?.getAttribute('tabindex')).toBe('0');
    expect(svg?.getAttribute('role')).toBe('application');
    expect(svg?.getAttribute('aria-label')).toContain('方向键');
    expect(svg?.getAttribute('aria-label')).toContain('+/-');
    TestBed.resetTestingModule();
  });

  it('方向键聚焦操作应平移主图并阻止页面滚动', () => {
    const diagram = new FakeMinimapDiagram();
    diagram.viewportBounds = new go.Rect(0, 0, 100, 100);
    const { component } = createFlowMinimapHarness(diagram as unknown as go.Diagram);
    const internals = component as unknown as FlowMinimapInternals;
    internals.attachTo(diagram as unknown as go.Diagram);
    internals.svgEl = {
      getBoundingClientRect: () => ({
        left: 0,
        top: 0,
        width: 100,
        height: 100,
        right: 100,
        bottom: 100,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }),
    } as unknown as SVGSVGElement;
    const preventDefault = vi.fn();

    component.onKeyDown({ key: 'ArrowRight', preventDefault } as unknown as KeyboardEvent);

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(diagram.position.x).toBeGreaterThan(0);
    expect(diagram.position.y).toBe(0);

    internals.ngOnDestroy();
    TestBed.resetTestingModule();
  });

  it('加减键聚焦操作应缩放主图', () => {
    const diagram = new FakeMinimapDiagram();
    diagram.viewportBounds = new go.Rect(0, 0, 100, 100);
    const { component } = createFlowMinimapHarness(diagram as unknown as go.Diagram);
    const internals = component as unknown as FlowMinimapInternals;
    internals.attachTo(diagram as unknown as go.Diagram);
    const preventDefault = vi.fn();

    component.onKeyDown({ key: '+', preventDefault } as unknown as KeyboardEvent);

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(diagram.scale).toBeGreaterThan(1);

    component.onKeyDown({ key: '-', preventDefault: vi.fn() } as unknown as KeyboardEvent);

    expect(diagram.scale).toBeCloseTo(1, 5);

    internals.ngOnDestroy();
    TestBed.resetTestingModule();
  });

  it('requestAnimationFrame/cancelAnimationFrame 缺失时调度和销毁不抛错', () => {
    const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
    const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;

    try {
      Reflect.deleteProperty(globalThis as Record<string, unknown>, 'requestAnimationFrame');
      Reflect.deleteProperty(globalThis as Record<string, unknown>, 'cancelAnimationFrame');

      const component = createFlowMinimapComponent() as unknown as FlowMinimapInternals;
      expect(() => component.scheduleRebuild()).not.toThrow();
      expect(() => component.ngOnDestroy()).not.toThrow();
    } finally {
      TestBed.resetTestingModule();
      if (originalRequestAnimationFrame) {
        globalThis.requestAnimationFrame = originalRequestAnimationFrame;
      } else {
        Reflect.deleteProperty(globalThis as Record<string, unknown>, 'requestAnimationFrame');
      }
      if (originalCancelAnimationFrame) {
        globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
      } else {
        Reflect.deleteProperty(globalThis as Record<string, unknown>, 'cancelAnimationFrame');
      }
    }
  });

  it('GoJS model 数据变化后会调度重建 SVG 快照', () => {
    const diagram = new FakeMinimapDiagram();
    diagram.nodeEntries = [
      {
        key: 'task-1',
        data: { familyColor: '#111111' },
        actualBounds: new go.Rect(0, 0, 80, 40),
      },
    ];
    const { component } = createFlowMinimapHarness(diagram as unknown as go.Diagram);
    const internals = component as unknown as FlowMinimapInternals;
    internals.attachTo(diagram as unknown as go.Diagram);
    expect(component.nodeShapes()[0]?.fill).toBe('#111111');
    expect(diagram.modelListeners).toHaveLength(1);

    const raf = installQueuedAnimationFrame();
    try {
      diagram.nodeEntries[0].data = { isSearchMatch: true, color: '#B89C48', familyColor: '#111111' };
      diagram.modelListeners[0]({} as go.ChangedEvent);
      raf.flushNext();
      expect(component.nodeShapes()[0]?.fill).toBe('#B89C48');
    } finally {
      raf.restore();
      internals.ngOnDestroy();
      TestBed.resetTestingModule();
    }
  });

  it('销毁时 GoJS listener 移除失败不应阻断内部绑定状态清理', () => {
    const diagram = new FakeMinimapDiagram();
    const { component } = createFlowMinimapHarness(diagram as unknown as go.Diagram);
    const internals = component as unknown as FlowMinimapInternals;
    internals.attachTo(diagram as unknown as go.Diagram);
    diagram.removeDiagramListenerError = new Error('remove failed');

    expect(() => internals.ngOnDestroy()).not.toThrow();

    expect(internals.boundDiagram).toBeNull();
    expect(internals.viewportHandler).toBeNull();
    expect(internals.documentHandler).toBeNull();
    expect(internals.modelHandler).toBeNull();
    TestBed.resetTestingModule();
  });

  it('setPointerCapture 失败时拖出 SVG 仍通过 window 事件继续平移并在松手清理', () => {
    const diagram = new FakeMinimapDiagram();
    diagram.viewportBounds = new go.Rect(0, 0, 100, 100);
    const { component } = createFlowMinimapHarness(diagram as unknown as go.Diagram);
    const internals = component as unknown as FlowMinimapInternals;
    internals.attachTo(diagram as unknown as go.Diagram);
    internals.svgEl = {
      getBoundingClientRect: () => ({
        left: 0,
        top: 0,
        width: 100,
        height: 100,
        right: 100,
        bottom: 100,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }),
      setPointerCapture: () => {
        throw new Error('pointer capture unavailable');
      },
      releasePointerCapture: vi.fn(),
    } as unknown as SVGSVGElement;

    const raf = installQueuedAnimationFrame();
    try {
      component.onPointerDown(createPointerEvent('pointerdown', { pointerId: 7, clientX: 10, clientY: 10 }));
      window.dispatchEvent(createPointerEvent('pointermove', { pointerId: 7, clientX: 30, clientY: 25 }));
      raf.flushNext();
      expect(diagram.position.x).toBeGreaterThan(0);
      expect(diagram.position.y).toBeGreaterThan(0);

      window.dispatchEvent(createPointerEvent('pointerup', { pointerId: 7, clientX: 30, clientY: 25 }));
      const xAfterUp = diagram.position.x;
      window.dispatchEvent(createPointerEvent('pointermove', { pointerId: 7, clientX: 80, clientY: 80 }));
      raf.flushNext();
      expect(diagram.position.x).toBe(xAfterUp);
    } finally {
      raf.restore();
      internals.ngOnDestroy();
      TestBed.resetTestingModule();
    }
  });

  it('pointercancel 应取消待处理拖动帧而不是提交最终平移', () => {
    const diagram = new FakeMinimapDiagram();
    diagram.viewportBounds = new go.Rect(0, 0, 100, 100);
    const { component } = createFlowMinimapHarness(diagram as unknown as go.Diagram);
    const internals = component as unknown as FlowMinimapInternals;
    internals.attachTo(diagram as unknown as go.Diagram);
    internals.svgEl = {
      getBoundingClientRect: () => ({
        left: 0,
        top: 0,
        width: 100,
        height: 100,
        right: 100,
        bottom: 100,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }),
      setPointerCapture: vi.fn(),
      releasePointerCapture: vi.fn(),
    } as unknown as SVGSVGElement;

    const raf = installQueuedAnimationFrame();
    try {
      component.onPointerDown(createPointerEvent('pointerdown', { pointerId: 9, clientX: 10, clientY: 10 }));
      component.onPointerMove(createPointerEvent('pointermove', { pointerId: 9, clientX: 40, clientY: 40 }));

      component.onPointerCancel(createPointerEvent('pointercancel', { pointerId: 9, clientX: 40, clientY: 40 }));
      raf.flushNext();

      expect(diagram.position.x).toBe(0);
      expect(diagram.position.y).toBe(0);
      window.dispatchEvent(createPointerEvent('pointermove', { pointerId: 9, clientX: 80, clientY: 80 }));
      raf.flushNext();
      expect(diagram.position.x).toBe(0);
      expect(diagram.position.y).toBe(0);
    } finally {
      raf.restore();
      internals.ngOnDestroy();
      TestBed.resetTestingModule();
    }
  });

  it('销毁中的晚到 pointermove 不应重新调度拖动帧或平移主图', () => {
    const diagram = new FakeMinimapDiagram();
    diagram.viewportBounds = new go.Rect(0, 0, 100, 100);
    const { component } = createFlowMinimapHarness(diagram as unknown as go.Diagram);
    const internals = component as unknown as FlowMinimapInternals;
    internals.attachTo(diagram as unknown as go.Diagram);
    internals.svgEl = {
      getBoundingClientRect: () => ({
        left: 0,
        top: 0,
        width: 100,
        height: 100,
        right: 100,
        bottom: 100,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }),
      setPointerCapture: vi.fn(),
      releasePointerCapture: vi.fn(),
    } as unknown as SVGSVGElement;

    const raf = installQueuedAnimationFrame();
    try {
      component.onPointerDown(createPointerEvent('pointerdown', { pointerId: 11, clientX: 10, clientY: 10 }));

      internals.ngOnDestroy();
      component.onPointerMove(createPointerEvent('pointermove', { pointerId: 11, clientX: 80, clientY: 80 }));
      raf.flushNext();

      expect(diagram.position.x).toBe(0);
      expect(diagram.position.y).toBe(0);
    } finally {
      raf.restore();
      TestBed.resetTestingModule();
    }
  });
});

describe('unionWorldRect', () => {
  it('任一为空返回另一个的副本', () => {
    const r: MinimapWorldRect = { x: 1, y: 2, w: 3, h: 4 };
    expect(unionWorldRect(null, r)).toEqual(r);
    expect(unionWorldRect(r, null)).toEqual(r);
    expect(unionWorldRect(null, null)).toBeNull();
  });

  it('返回的是副本而非同一引用', () => {
    const r: MinimapWorldRect = { x: 1, y: 2, w: 3, h: 4 };
    expect(unionWorldRect(r, null)).not.toBe(r);
  });

  it('两矩形并集取最小左上 + 最大右下', () => {
    const a: MinimapWorldRect = { x: 0, y: 0, w: 100, h: 100 };
    const b: MinimapWorldRect = { x: 50, y: 80, w: 100, h: 100 };
    expect(unionWorldRect(a, b)).toEqual({ x: 0, y: 0, w: 150, h: 180 });
  });

  it('一个矩形完全包含另一个时返回大者', () => {
    const big: MinimapWorldRect = { x: -10, y: -10, w: 200, h: 200 };
    const small: MinimapWorldRect = { x: 0, y: 0, w: 10, h: 10 };
    expect(unionWorldRect(big, small)).toEqual(big);
  });
});

describe('computeViewBox（对标 React Flow MiniMap）', () => {
  it('高主导：viewScale = 高比，宽方向 letterbox 居中', () => {
    // 高瘦内容：宽比 0.5、高比 2 → viewScale=2
    const bounding: MinimapWorldRect = { x: 0, y: 0, w: 100, h: 300 };
    const vb = computeViewBox(bounding, 200, 150);
    // viewScale=2, offset=10, viewW=400, viewH=300
    // vbX = 0 - (400-100)/2 - 10 = -160 ; vbY = 0 - (300-300)/2 - 10 = -10
    expect(vb.x).toBeCloseTo(-160, 5);
    expect(vb.y).toBeCloseTo(-10, 5);
    expect(vb.w).toBeCloseTo(420, 5); // 400 + 20
    expect(vb.h).toBeCloseTo(320, 5); // 300 + 20
  });

  it('内容完整可见且不变形（取 max 比例而非 min）', () => {
    const bounding: MinimapWorldRect = { x: 0, y: 0, w: 100, h: 300 };
    const vb = computeViewBox(bounding, 200, 150);
    // viewBox 必须把内容整个包住
    expect(vb.x).toBeLessThanOrEqual(bounding.x);
    expect(vb.y).toBeLessThanOrEqual(bounding.y);
    expect(vb.x + vb.w).toBeGreaterThanOrEqual(bounding.x + bounding.w);
    expect(vb.y + vb.h).toBeGreaterThanOrEqual(bounding.y + bounding.h);
  });

  it('逐位匹配真实 React Flow 样本（Supabase Schema Visualizer）', () => {
    // 样本：elW/elH=200/150；boundingRect ≈ {0,0,854.786844,5764.5}
    // 样本 viewBox="-3607.756577886388 -192.15 8070.3 6148.8"
    const bounding: MinimapWorldRect = { x: 0, y: 0, w: 854.786844, h: 5764.5 };
    const vb = computeViewBox(bounding, 200, 150);
    expect(vb.x).toBeCloseTo(-3607.7566, 2);
    expect(vb.y).toBeCloseTo(-192.15, 2);
    expect(vb.w).toBeCloseTo(8070.3, 1);
    expect(vb.h).toBeCloseTo(6148.8, 1);
  });

  it('elW/elH 为 0 时不抛错（兜底为 1）', () => {
    const bounding: MinimapWorldRect = { x: 0, y: 0, w: 10, h: 10 };
    expect(() => computeViewBox(bounding, 0, 0)).not.toThrow();
  });

  it('视口落在节点群内时 viewBox 仅由节点群决定（平移稳定不抖）', () => {
    // 节点群恒定，视口在其内部平移 → bounding ≡ 节点群 → viewBox 不变
    const nodes: MinimapWorldRect = { x: 0, y: 0, w: 1000, h: 800 };
    const vb1 = computeViewBox(nodes, 200, 150);
    const vb2 = computeViewBox(nodes, 200, 150);
    expect(vb1).toEqual(vb2);
  });
});

describe('resolveNodeFill（修复历史白块）', () => {
  it('已分配节点 color=白 时用 familyColor（核心修复）', () => {
    const data: MinimapNodeData = { color: '#FFFFFF', familyColor: 'hsl(165, 89%, 52%)' };
    expect(resolveNodeFill(data)).toBe('hsl(165, 89%, 52%)');
  });

  it('搜索命中优先用高亮色（保留搜索 UX）', () => {
    const data: MinimapNodeData = {
      color: '#B89C48',
      familyColor: 'hsl(165, 89%, 52%)',
      isSearchMatch: true,
    };
    expect(resolveNodeFill(data)).toBe('#B89C48');
  });

  it('无 familyColor 时回退 data.color（待分配/已完成节点）', () => {
    const data: MinimapNodeData = { color: '#EBE7D9' };
    expect(resolveNodeFill(data)).toBe('#EBE7D9');
  });

  it('无 familyColor 且无 color 时琥珀兜底', () => {
    expect(resolveNodeFill({})).toBe('#fbbf24');
  });
});

describe('resolveNodeStroke', () => {
  it('停泊态优先琥珀描边', () => {
    const data: MinimapNodeData = { borderColor: '#78716C', isParked: true };
    expect(resolveNodeStroke(data)).toBe('#d97706');
  });

  it('专注高亮态靛紫描边', () => {
    const data: MinimapNodeData = { borderColor: '#78716C', isDockFocused: true };
    expect(resolveNodeStroke(data)).toBe('#6366f1');
  });

  it('普通态用 data.borderColor', () => {
    expect(resolveNodeStroke({ borderColor: '#78716C' })).toBe('#78716C');
  });

  it('无 borderColor 时兜底灰', () => {
    expect(resolveNodeStroke({})).toBe('#78716c');
  });

  it('停泊优先级高于专注', () => {
    const data: MinimapNodeData = { isParked: true, isDockFocused: true };
    expect(resolveNodeStroke(data)).toBe('#d97706');
  });
});

describe('resolveNodeStrokeWidth', () => {
  it('停泊/搜索/专注加粗为 2', () => {
    expect(resolveNodeStrokeWidth({ isParked: true })).toBe(2);
    expect(resolveNodeStrokeWidth({ isSearchMatch: true })).toBe(2);
    expect(resolveNodeStrokeWidth({ isDockFocused: true })).toBe(2);
  });

  it('普通态取 data.borderWidth', () => {
    expect(resolveNodeStrokeWidth({ borderWidth: 3 })).toBe(3);
  });

  it('无 borderWidth 时默认 1', () => {
    expect(resolveNodeStrokeWidth({})).toBe(1);
  });

  it('borderWidth 非正数时默认 1', () => {
    expect(resolveNodeStrokeWidth({ borderWidth: 0 })).toBe(1);
  });
});

describe('buildDecorationPips（装饰 pip 位置/颜色/稳定 key）', () => {
  const bounds: MinimapWorldRect = { x: 10, y: 20, w: 100, h: 50 };

  it('无任何附着标志时返回空数组', () => {
    expect(buildDecorationPips(bounds, {}, 'n1')).toEqual([]);
  });

  it('僚机：右上角琴珀色 pip', () => {
    const [pip] = buildDecorationPips(bounds, { sidecarHasSignals: true }, 'n1');
    expect(pip.color).toBe('#f59e0b');
    expect(pip.cx).toBe(110); // x + w
    expect(pip.cy).toBe(20); // y
    expect(pip.key).toBe('n1:sidecar');
  });

  it('思源：右下角靖蓝色 pip', () => {
    const [pip] = buildDecorationPips(bounds, { hasSiyuanLink: true }, 'n1');
    expect(pip.color).toBe('#818cf8');
    expect(pip.cx).toBe(110); // x + w
    expect(pip.cy).toBe(70); // y + h
    expect(pip.key).toBe('n1:siyuan');
  });

  it('入坞：左上角天蓝色 pip', () => {
    const [pip] = buildDecorationPips(bounds, { isDocked: true }, 'n1');
    expect(pip.color).toBe('#0284c7');
    expect(pip.cx).toBe(10); // x
    expect(pip.cy).toBe(20); // y
    expect(pip.key).toBe('n1:docked');
  });

  it('多标志并存时同时输出多个 pip（key 各自唯一）', () => {
    const data: MinimapNodeData = { sidecarHasSignals: true, hasSiyuanLink: true, isDocked: true };
    const pips = buildDecorationPips(bounds, data, 'n9');
    expect(pips).toHaveLength(3);
    expect(new Set(pips.map((p) => p.key)).size).toBe(3);
  });

  it('pip 半径 = max(2, min(w,h)×0.16)，小节点不小于 2', () => {
    const big = buildDecorationPips({ x: 0, y: 0, w: 100, h: 50 }, { isDocked: true }, 'b')[0];
    expect(big.r).toBeCloseTo(8, 5); // min(100,50)=50 × 0.16
    const small = buildDecorationPips({ x: 0, y: 0, w: 4, h: 4 }, { isDocked: true }, 's')[0];
    expect(small.r).toBe(2); // min=4 × 0.16=0.64 → 地板 2
  });
});
