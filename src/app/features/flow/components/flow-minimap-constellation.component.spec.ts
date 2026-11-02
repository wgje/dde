import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as go from 'gojs';

import { LoggerService } from '../../../../services/logger.service';
import { FlowDiagramConfigService } from '../services/flow-diagram-config.service';
import { FlowDiagramService } from '../services/flow-diagram.service';
import type { MinimapNodeData } from './flow-minimap-geometry';
import { FlowMinimapComponent } from './flow-minimap.component';

type DiagramListener = (event: go.DiagramEvent) => void;
type ModelListener = (event: go.ChangedEvent) => void;

class ConstellationDiagram {
  readonly diagramListeners = new Map<string, DiagramListener[]>();
  readonly modelListeners: ModelListener[] = [];
  nodeEntries: Array<{ key: string; data: MinimapNodeData; actualBounds: go.Rect }> = [];
  viewportBounds = new go.Rect(0, 0, 100, 80);
  position = new go.Point(0, 0);
  scale = 1;
  minScale = 0.05;
  maxScale = 3;
  readonly nodes = { each: (callback: (node: (typeof this.nodeEntries)[number]) => void) => this.nodeEntries.forEach(callback) };
  readonly links = { each: (_callback: (link: Record<string, unknown>) => void) => undefined };

  addDiagramListener(name: string, listener: DiagramListener): void {
    this.diagramListeners.set(name, [...(this.diagramListeners.get(name) ?? []), listener]);
  }
  removeDiagramListener(name: string, listener: DiagramListener): void {
    this.diagramListeners.set(name, (this.diagramListeners.get(name) ?? []).filter(item => item !== listener));
  }
  addModelChangedListener(listener: ModelListener): void {
    this.modelListeners.push(listener);
  }
  removeModelChangedListener(listener: ModelListener): void {
    const index = this.modelListeners.indexOf(listener);
    if (index >= 0) this.modelListeners.splice(index, 1);
  }
}

type FlowMinimapConstellationInternals = {
  attachTo(diagram: go.Diagram): void;
};

function createFixture(diagram = new ConstellationDiagram()) {
  TestBed.configureTestingModule({
    imports: [FlowMinimapComponent],
    providers: [
      { provide: FlowDiagramService, useValue: { isInitialized: true, diagramInstance: diagram } },
      {
        provide: FlowDiagramConfigService,
        useValue: {
          currentStyles: () => ({
            link: { crossTreeColor: '#818cf8', parentChildColor: '#94a3b8' },
          }),
        },
      },
      {
        provide: LoggerService,
        useValue: {
          category: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
        },
      },
    ],
  });
  const fixture = TestBed.createComponent(FlowMinimapComponent);
  return { fixture, component: fixture.componentInstance, diagram };
}

function pointerMove(clientX: number, clientY: number): PointerEvent {
  const event = new Event('pointermove', { bubbles: true, cancelable: true }) as PointerEvent;
  Object.defineProperties(event, {
    pointerId: { value: 1 },
    clientX: { value: clientX },
    clientY: { value: clientY },
  });
  return event;
}

function injectedComponentStyles(marker: string): string {
  return Array.from(document.head.querySelectorAll('style'))
    .map(style => style.textContent ?? '')
    .filter(style => style.includes(marker))
    .join('\n');
}

function relativeLuminance(hex: string): number {
  const channels = hex.slice(1).match(/.{2}/g)?.map(channel => Number.parseInt(channel, 16) / 255) ?? [];
  const linear = channels.map(channel => (
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  ));
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function contrastRatio(first: string, second: string): number {
  const lighter = Math.max(relativeLuminance(first), relativeLuminance(second));
  const darker = Math.min(relativeLuminance(first), relativeLuminance(second));
  return (lighter + 0.05) / (darker + 0.05);
}

describe('FlowMinimapComponent Constellation', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('焦点轮廓在浅色瓷白与深空表面均达到 3:1，并保留主题与减弱动效合同', () => {
    const { fixture } = createFixture();
    fixture.detectChanges();
    const styles = injectedComponentStyles('--minimap-control-surface');
    fixture.destroy();
    const focusColor = styles.match(
      /\.minimap-svg[^{]*:focus-visible\s*\{[^}]*outline:\s*2px solid\s*(#[0-9a-f]{6})/i,
    )?.[1];

    expect(focusColor).toBeDefined();
    expect(contrastRatio(focusColor as string, '#efeee9')).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(focusColor as string, '#16191f')).toBeGreaterThanOrEqual(3);
    expect(styles.match(/--minimap-control-surface:/g)?.length).toBeGreaterThanOrEqual(2);
    expect(styles.match(/--minimap-viewport-stroke:/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(styles).toContain("[data-color-mode='dark']");

    const reducedMotionStyles = styles.slice(styles.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(reducedMotionStyles).toMatch(/\.minimap-map-layer[^}]*\{\s*transition:\s*none;/);
    expect(reducedMotionStyles).toMatch(/\.minimap-attention-lens[^}]*\{\s*transition:\s*none;/);
    expect(reducedMotionStyles).toMatch(/\.minimap-viewport[^}]*\{\s*transition:\s*none;/);
    expect(reducedMotionStyles).toMatch(/\.minimap-legend-anchor-desktop[^}]*\{\s*animation:\s*none;/);
  });

  it('普通节点渲染为原稿中的中性实心胶囊，并用表面色光学切口分隔相邻节点', () => {
    const { fixture, component, diagram } = createFixture();
    diagram.nodeEntries = [{
      key: 'task-1',
      actualBounds: new go.Rect(0, 0, 100, 50),
      data: { color: '#f4cf73', borderColor: '#64748b' },
    }];
    (component as unknown as FlowMinimapConstellationInternals).attachTo(diagram as unknown as go.Diagram);
    fixture.detectChanges();

    const body = fixture.nativeElement.querySelector('.minimap-node-body') as SVGRectElement;

    expect(body).not.toBeNull();
    expect(body.getAttribute('fill')).toBe('var(--minimap-node-fill)');
    expect(body.getAttribute('stroke')).toBe('var(--overview-surface, #efeee9)');
    expect(body.getAttribute('stroke-width')).toBe('1.2');
    expect(body.getAttribute('x')).toBe('-12.5');
    expect(body.getAttribute('width')).toBe('125');
    expect(body.getAttribute('rx')).toBe('25');
    expect(getComputedStyle(body).opacity).toBe('1');
    expect(injectedComponentStyles('--minimap-node-fill')).toMatch(
      /\.minimap-map-layer[^{]*\{[^}]*opacity:\s*0\.48/,
    );
    expect(fixture.nativeElement.querySelector('.minimap-node-orbit')).toBeNull();
    expect(fixture.nativeElement.querySelector('.minimap-star-halo')).toBeNull();
    expect(fixture.nativeElement.querySelector('.minimap-star-core')).toBeNull();
  });

  it('注意力状态使用独立可见的径向光晕，alpha mask 只负责远淡近亮', () => {
    vi.useFakeTimers();
    const { fixture, component } = createFixture();
    fixture.detectChanges();

    const lensGradient = fixture.nativeElement.querySelector(
      'radialGradient[data-minimap-attention-lens-gradient]',
    ) as SVGRadialGradientElement;
    const lens = fixture.nativeElement.querySelector(
      '[data-minimap-attention-lens]',
    ) as SVGCircleElement;
    const styles = injectedComponentStyles('--minimap-lens-core-opacity');

    expect(lensGradient).not.toBeNull();
    expect(lens).not.toBeNull();
    expect(fixture.nativeElement.querySelector('[data-minimap-attention-orbit]')).toBeNull();
    expect(styles).toContain('--minimap-lens-core-opacity: 0.18');
    expect(styles).toContain('--minimap-lens-mid-opacity: 0.05');
    expect(styles).toContain('--minimap-lens-core-opacity: 0.24');
    expect(styles).toContain('--minimap-lens-mid-opacity: 0.06');
    expect(lens.getAttribute('fill')).toBe(component.attentionLensGradientFill);
    expect(getComputedStyle(lens).opacity).toBe('0');

    const stage = fixture.nativeElement.querySelector('.minimap-stage') as HTMLDivElement;
    stage.dispatchEvent(new Event('pointerenter'));
    fixture.detectChanges();
    expect(getComputedStyle(lens).opacity).toBe('0');
    vi.advanceTimersByTime(239);
    fixture.detectChanges();
    expect(getComputedStyle(lens).opacity).toBe('0');
    vi.advanceTimersByTime(1);
    fixture.detectChanges();
    expect(getComputedStyle(lens).opacity).not.toBe('0');
  });

  it('渲染六类几何标记与径向 alpha mask，不以颜色作为唯一语义', () => {
    const { fixture, component, diagram } = createFixture();
    diagram.nodeEntries = [{
      key: 'task-1',
      actualBounds: new go.Rect(0, 0, 100, 50),
      data: {
        sidecarHasSignals: true,
        hasSiyuanLink: true,
        isDocked: true,
        isParked: true,
        isDockFocused: true,
        isSearchMatch: true,
      },
    }];
    (component as unknown as FlowMinimapConstellationInternals).attachTo(diagram as unknown as go.Diagram);
    fixture.detectChanges();

    const kinds = Array.from(fixture.nativeElement.querySelectorAll('[data-minimap-marker]'))
      .map(node => (node as Element).getAttribute('data-minimap-marker'));
    const searchCircle = fixture.nativeElement.querySelector(
      '[data-minimap-marker="search"] circle',
    ) as SVGCircleElement;
    const cornerPaths = ['sidecar', 'siyuan', 'docked'].map(kind => (
      fixture.nativeElement.querySelector(`[data-minimap-marker="${kind}"]`) as SVGPathElement
    ));
    expect(kinds).toEqual(['sidecar', 'siyuan', 'docked', 'parked', 'focused', 'search']);
    expect(cornerPaths.every(path => path.tagName.toLowerCase() === 'path')).toBe(true);
    expect(new Set(cornerPaths.map(path => path.getAttribute('d'))).size).toBe(3);
    expect(fixture.nativeElement.querySelector('[data-minimap-marker="parked"]')?.tagName.toLowerCase()).toBe('rect');
    expect(fixture.nativeElement.querySelector('[data-minimap-marker="focused"]')?.tagName.toLowerCase()).toBe('rect');
    expect(fixture.nativeElement.querySelector('[data-minimap-marker="search"]')?.tagName.toLowerCase()).toBe('g');
    expect(searchCircle.getAttribute('vector-effect')).toBe('non-scaling-stroke');
    expect(fixture.nativeElement.querySelectorAll('radialGradient')).toHaveLength(2);
    expect(fixture.nativeElement.querySelector('mask[data-minimap-attention-mask]')).not.toBeNull();
  });

  it('同页两个小地图使用互不冲突的渐变、遮罩 ID 与 URL 引用', () => {
    vi.useFakeTimers();
    const first = createFixture();
    const secondFixture = TestBed.createComponent(FlowMinimapComponent);
    first.fixture.detectChanges();
    secondFixture.detectChanges();

    const components = [first.component, secondFixture.componentInstance];
    expect(new Set(components.map(component => component.attentionGradientId)).size).toBe(2);
    expect(new Set(components.map(component => component.attentionMaskId)).size).toBe(2);
    expect(new Set(components.map(component => component.attentionLensGradientId)).size).toBe(2);

    for (const fixture of [first.fixture, secondFixture]) {
      const component = fixture.componentInstance;
      const alphaGradient = fixture.nativeElement.querySelector(
        `radialGradient[id="${component.attentionGradientId}"]`,
      ) as SVGRadialGradientElement;
      const lensGradient = fixture.nativeElement.querySelector(
        `radialGradient[id="${component.attentionLensGradientId}"]`,
      ) as SVGRadialGradientElement;
      const mask = fixture.nativeElement.querySelector(
        `mask[id="${component.attentionMaskId}"]`,
      ) as SVGMaskElement;
      const maskRect = fixture.nativeElement.querySelector(
        'mask[data-minimap-attention-mask] rect',
      ) as SVGRectElement;
      const lens = fixture.nativeElement.querySelector(
        '[data-minimap-attention-lens]',
      ) as SVGCircleElement;
      expect(alphaGradient).not.toBeNull();
      expect(lensGradient).not.toBeNull();
      expect(mask).not.toBeNull();
      expect(maskRect.getAttribute('fill')).toBe(component.attentionGradientFill);
      expect(lens.getAttribute('fill')).toBe(component.attentionLensGradientFill);

      const stage = fixture.nativeElement.querySelector('.minimap-stage') as HTMLDivElement;
      stage.dispatchEvent(new Event('pointerenter'));
      vi.advanceTimersByTime(240);
      fixture.detectChanges();
      const mapLayer = fixture.nativeElement.querySelector('.minimap-map-layer') as SVGGElement;
      expect(mapLayer.getAttribute('mask')).toBe(component.attentionMaskFill);
    }

    first.fixture.destroy();
    secondFixture.destroy();
  });

  it('视口只保留细框，静止可辨识且交互时退后给镜头让位', () => {
    vi.useFakeTimers();
    const { fixture } = createFixture();
    fixture.detectChanges();
    const stage = fixture.nativeElement.querySelector('.minimap-stage') as HTMLDivElement;
    const viewport = fixture.nativeElement.querySelector('.minimap-viewport') as SVGRectElement;

    expect(fixture.nativeElement.querySelector('.minimap-viewport-veil')).toBeNull();
    expect(getComputedStyle(viewport).opacity).toBe('0.72');

    stage.dispatchEvent(new Event('pointerenter'));
    fixture.detectChanges();
    expect(getComputedStyle(viewport).opacity).toBe('0.72');
    vi.advanceTimersByTime(240);
    fixture.detectChanges();
    expect(getComputedStyle(viewport).opacity).toBe('0.55');
  });

  it('120 次同帧 pointermove 只更新一次镜头且不重建节点快照', () => {
    const { fixture, component, diagram } = createFixture();
    diagram.nodeEntries = [{
      key: 'task-1',
      actualBounds: new go.Rect(0, 0, 100, 50),
      data: { sidecarHasSignals: true },
    }];
    (component as unknown as FlowMinimapConstellationInternals).attachTo(diagram as unknown as go.Diagram);
    fixture.detectChanges();
    const stage = fixture.nativeElement.querySelector('.minimap-stage') as HTMLDivElement;
    const svg = fixture.nativeElement.querySelector('svg') as SVGSVGElement;
    vi.spyOn(svg, 'getBoundingClientRect').mockReturnValue({
      left: 0, top: 0, width: 100, height: 80, right: 100, bottom: 80, x: 0, y: 0,
      toJSON: () => ({}),
    });
    const initialShapes = component.nodeShapes();
    const callbacks: FrameRequestCallback[] = [];
    const requestSpy = vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(callback => {
      callbacks.push(callback);
      return callbacks.length;
    });

    try {
      stage.dispatchEvent(new Event('pointerenter'));
      for (let index = 0; index < 120; index += 1) {
        svg.dispatchEvent(pointerMove(index / 1.19, 60));
      }
      expect(callbacks).toHaveLength(1);
      callbacks[0](0);
      expect(component.attentionLens()).toEqual({ x: 1, y: 0.75 });
      expect(component.nodeShapes()).toBe(initialShapes);
    } finally {
      requestSpy.mockRestore();
      fixture.destroy();
    }
  });

  it('键盘移动激活中心镜头后，焦点离开且无指针或筛选时完全收起', () => {
    vi.useFakeTimers();
    const callbacks: FrameRequestCallback[] = [];
    const requestSpy = vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(callback => {
      callbacks.push(callback);
      return callbacks.length;
    });
    const { fixture, component } = createFixture();

    try {
      component.onAttentionFocus();
      component.onKeyDown(new KeyboardEvent('keydown', { key: 'ArrowRight', cancelable: true }));
      expect(callbacks).toHaveLength(1);
      callbacks[0](0);
      expect(component.attentionActive()).toBe(false);
      vi.advanceTimersByTime(240);
      expect(component.attentionActive()).toBe(true);
      expect(component.attentionLens()).toEqual({ x: 0.5, y: 0.5 });

      component.onAttentionFocusOut(new FocusEvent('focusout'));

      expect(component.attentionActive()).toBe(false);
      expect(component.attentionLegendVisible()).toBe(false);
      expect(component.attentionLens()).toBeNull();
    } finally {
      requestSpy.mockRestore();
      fixture.destroy();
    }
  });

  it('滚轮更新镜头不会伪造 pointerInside，失焦后完全收起', () => {
    const callbacks: FrameRequestCallback[] = [];
    const requestSpy = vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(callback => {
      callbacks.push(callback);
      return callbacks.length;
    });
    const { fixture, component } = createFixture();

    try {
      fixture.detectChanges();
      const svg = fixture.nativeElement.querySelector('svg') as SVGSVGElement;
      vi.spyOn(svg, 'getBoundingClientRect').mockReturnValue({
        left: 0, top: 0, width: 100, height: 80, right: 100, bottom: 80, x: 0, y: 0,
        toJSON: () => ({}),
      });
      component.onAttentionFocus();
      const wheel = new Event('wheel', { cancelable: true }) as WheelEvent;
      Object.defineProperties(wheel, {
        clientX: { value: 25 },
        clientY: { value: 60 },
        deltaY: { value: 1 },
      });
      component.onWheel(wheel);
      expect(callbacks.length).toBeGreaterThan(0);
      callbacks.splice(0).forEach(callback => callback(0));
      expect(component.attentionLens()).toEqual({ x: 0.25, y: 0.75 });

      component.onAttentionFocusOut(new FocusEvent('focusout'));

      expect(component.attentionActive()).toBe(false);
      expect(component.attentionLegendVisible()).toBe(false);
      expect(component.attentionLens()).toBeNull();
    } finally {
      requestSpy.mockRestore();
      fixture.destroy();
    }
  });

  it('桌面图例在 240ms 后浮现，筛选仅改变展示标记', () => {
    vi.useFakeTimers();
    const { fixture, component, diagram } = createFixture();
    diagram.nodeEntries = [{
      key: 'task-1',
      actualBounds: new go.Rect(0, 0, 100, 50),
      data: { sidecarHasSignals: true, isParked: true },
    }];
    (component as unknown as FlowMinimapConstellationInternals).attachTo(diagram as unknown as go.Diagram);
    fixture.detectChanges();
    const stage = fixture.nativeElement.querySelector('.minimap-stage') as HTMLDivElement;
    stage.dispatchEvent(new Event('pointerenter'));
    vi.advanceTimersByTime(239);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[role="group"]')).toBeNull();
    vi.advanceTimersByTime(1);
    fixture.detectChanges();

    const sidecarButton = fixture.nativeElement.querySelector(
      '[data-minimap-legend-category="sidecar"]',
    ) as HTMLButtonElement;
    expect(sidecarButton).not.toBeNull();
    const snapshotMarkers = component.semanticMarkerShapes();
    sidecarButton.click();
    fixture.detectChanges();
    expect(component.semanticMarkerShapes()).toBe(snapshotMarkers);
    expect(component.visibleSemanticMarkers().map(marker => marker.kind)).toEqual(['parked']);
    fixture.destroy();
  });

  it('桌面图例收敛为单行图标控制岛', () => {
    vi.useFakeTimers();
    const desktop = createFixture();
    desktop.fixture.detectChanges();
    const desktopStage = desktop.fixture.nativeElement.querySelector('.minimap-stage') as HTMLDivElement;
    desktopStage.dispatchEvent(new Event('pointerenter'));
    vi.advanceTimersByTime(240);
    desktop.fixture.detectChanges();

    const desktopLegend = desktop.fixture.nativeElement.querySelector('.legend') as HTMLElement;
    const desktopLabel = desktop.fixture.nativeElement.querySelector('.legend-item span') as HTMLSpanElement;
    const desktopButtons = Array.from(
      desktop.fixture.nativeElement.querySelectorAll('.legend-item'),
    ) as HTMLButtonElement[];
    expect(getComputedStyle(desktopLegend).display).toBe('flex');
    expect(Number.parseFloat(getComputedStyle(desktopLegend).gap)).toBe(0);
    expect(getComputedStyle(desktopLabel).display).toBe('none');
    expect(desktopButtons).toHaveLength(6);
    expect(desktopButtons.every(button => Boolean(button.title))).toBe(true);
    desktop.fixture.destroy();
  });

  it('从 SVG 移向图例不应触发离开收起，离开整个舞台后才收起', () => {
    vi.useFakeTimers();
    const { fixture } = createFixture();
    fixture.detectChanges();
    const stage = fixture.nativeElement.querySelector('.minimap-stage') as HTMLDivElement;
    const svg = fixture.nativeElement.querySelector('svg') as SVGSVGElement;

    stage.dispatchEvent(new Event('pointerenter'));
    vi.advanceTimersByTime(240);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[role="group"]')).not.toBeNull();

    svg.dispatchEvent(new Event('pointerleave'));
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[role="group"]')).not.toBeNull();

    stage.dispatchEvent(new Event('pointerleave'));
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[role="group"]')).toBeNull();
    fixture.destroy();
  });

  it('移动端只常驻 24px 图例入口，点击后在地图上方展开完整图例', () => {
    const { fixture } = createFixture();
    fixture.componentRef.setInput('mobile', true);
    fixture.detectChanges();

    const trigger = fixture.nativeElement.querySelector('[data-testid="minimap-legend-trigger"]') as HTMLButtonElement;
    expect(trigger).not.toBeNull();
    expect(trigger.classList.contains('mobile-legend-trigger')).toBe(true);
    expect(fixture.nativeElement.querySelector('[role="group"]')).toBeNull();
    trigger.click();
    fixture.detectChanges();
    const mobileLegend = fixture.nativeElement.querySelector('.legend-mobile') as HTMLElement;
    const mobileLabel = fixture.nativeElement.querySelector('.legend-item span') as HTMLSpanElement;
    expect(fixture.nativeElement.querySelector('.minimap-legend-anchor')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('[role="group"]')).not.toBeNull();
    expect(getComputedStyle(mobileLegend).display).toBe('grid');
    expect(getComputedStyle(mobileLegend).gridTemplateColumns).toContain('repeat(3');
    expect(getComputedStyle(mobileLabel).display).not.toBe('none');
    expect(getComputedStyle(mobileLabel).whiteSpace).toBe('nowrap');
  });

  it('关闭移动图例不清除临时筛选，解除最后筛选后才收起注意力', () => {
    const { fixture, component } = createFixture();
    fixture.componentRef.setInput('mobile', true);
    fixture.detectChanges();
    const trigger = fixture.nativeElement.querySelector('[data-testid="minimap-legend-trigger"]') as HTMLButtonElement;

    trigger.click();
    component.toggleLegendCategory('sidecar');
    fixture.detectChanges();
    trigger.click();

    expect(component.mobileLegendOpen()).toBe(false);
    expect(component.hiddenCategories().has('sidecar')).toBe(true);
    expect(component.attentionActive()).toBe(true);

    component.toggleLegendCategory('sidecar');
    expect(component.hiddenCategories().size).toBe(0);
    expect(component.attentionActive()).toBe(false);
    expect(component.attentionLegendVisible()).toBe(false);
    expect(component.attentionLens()).toBeNull();
  });
});
