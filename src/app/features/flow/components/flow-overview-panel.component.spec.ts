import { ElementRef } from '@angular/core';
import { By } from '@angular/platform-browser';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';
import * as go from 'gojs';

import { LoggerService } from '../../../../services/logger.service';
import { FlowDiagramConfigService } from '../services/flow-diagram-config.service';
import { FlowDiagramService } from '../services/flow-diagram.service';
import { FlowMinimapComponent } from './flow-minimap.component';
import { FlowOverviewPanelComponent } from './flow-overview-panel.component';

function createPanelFixture(diagram: go.Diagram | null = null) {
  TestBed.configureTestingModule({
    imports: [FlowOverviewPanelComponent],
    providers: [
      {
        provide: FlowDiagramService,
        useValue: { isInitialized: diagram !== null, diagramInstance: diagram },
      },
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
  return TestBed.createComponent(FlowOverviewPanelComponent);
}

describe('FlowOverviewPanelComponent', () => {
  it('锁定浅深主题表面、可见焦点与 reduced-motion 样式合同', () => {
    const fixture = createPanelFixture();
    fixture.detectChanges();
    const styles = Array.from(document.head.querySelectorAll('style'))
      .map(style => style.textContent ?? '')
      .find(style => style.includes('--overview-surface')) ?? '';

    expect(styles).toContain('--overview-surface: #efeee9');
    expect(styles).toContain('--overview-surface: #16191f');
    expect(styles).toContain('--overview-border: #dad8d0');
    expect(styles).toContain('--overview-border: #303640');
    expect(styles).toMatch(/\.overview-panel[^{]*\{[^}]*border-radius:\s*15px/);
    expect(styles).toMatch(/\.overview-toggle[^{]*\{[^}]*opacity:\s*0\.42/);
    expect(styles).toMatch(/\.overview-toggle[^{]*:focus-visible\s*\{[^}]*outline:/);
    expect(styles).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*\.overview-panel[^}]*\{\s*transition:\s*none;/);
  });

  it('统一呈现移动端 100×80 SVG 小地图与至少 24×24 的折叠控件', () => {
    const fixture = createPanelFixture();
    fixture.componentRef.setInput('mobile', true);
    fixture.detectChanges();

    const panel = fixture.nativeElement.querySelector('[data-testid="flow-overview-panel"]') as HTMLElement;
    const button = fixture.nativeElement.querySelector('[data-testid="flow-overview-toggle"]') as HTMLButtonElement;
    expect(panel.style.width).toBe('100px');
    expect(panel.style.height).toBe('80px');
    expect(button.classList.contains('mobile-control')).toBe(true);
    expect(fixture.nativeElement.querySelector('app-flow-minimap')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('[data-testid="minimap-legend-trigger"]')).not.toBeNull();
  });

  it('折叠按钮的 pointerdown 只截断画布冒泡，不提前切换或阻止原生 click', () => {
    const fixture = createPanelFixture();
    const emitSpy = vi.spyOn(fixture.componentInstance.collapseToggle, 'emit');
    fixture.detectChanges();

    const button = fixture.nativeElement.querySelector('[data-testid="flow-overview-toggle"]') as HTMLButtonElement;
    const event = new Event('pointerdown', { bubbles: true, cancelable: true });
    const stopPropagation = vi.spyOn(event, 'stopPropagation');
    button.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(stopPropagation).toHaveBeenCalled();
    expect(emitSpy).not.toHaveBeenCalled();
  });

  it('鼠标或触控的 pointerdown 后续 click 恰好发送一次切换并阻止冒泡', () => {
    const fixture = createPanelFixture();
    const emitSpy = vi.spyOn(fixture.componentInstance.collapseToggle, 'emit');
    fixture.detectChanges();

    const panel = fixture.nativeElement.querySelector('[data-testid="flow-overview-panel"]') as HTMLElement;
    const button = fixture.nativeElement.querySelector('[data-testid="flow-overview-toggle"]') as HTMLButtonElement;
    const bubbledClick = vi.fn();
    panel.addEventListener('click', bubbledClick);
    button.dispatchEvent(new Event('pointerdown', { bubbles: true, cancelable: true }));
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));

    expect(emitSpy).toHaveBeenCalledTimes(1);
    expect(bubbledClick).not.toHaveBeenCalled();
  });

  it.each(['Enter', ' '])('原生按钮由 %s 生成的 click 恰好切换一次', key => {
    const fixture = createPanelFixture();
    const emitSpy = vi.spyOn(fixture.componentInstance.collapseToggle, 'emit');
    fixture.detectChanges();

    const panel = fixture.nativeElement.querySelector('[data-testid="flow-overview-panel"]') as HTMLElement;
    const button = fixture.nativeElement.querySelector('[data-testid="flow-overview-toggle"]') as HTMLButtonElement;
    const bubbledClick = vi.fn();
    panel.addEventListener('click', bubbledClick);

    button.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 0 }));

    expect(button.type).toBe('button');
    expect(emitSpy).toHaveBeenCalledTimes(1);
    expect(bubbledClick).not.toHaveBeenCalled();
  });

  it('条件渲染 legacy Overview 时发送真实容器，切回 SVG 时发送 undefined', () => {
    const fixture = createPanelFixture();
    const emitSpy = vi.spyOn(fixture.componentInstance.legacyOverviewHostChange, 'emit');
    fixture.componentRef.setInput('useSvgMinimap', false);
    fixture.detectChanges();

    const emittedHost = emitSpy.mock.calls.find(call => call[0] instanceof ElementRef)?.[0] as ElementRef | undefined;
    expect(emittedHost?.nativeElement).toBe(
      fixture.nativeElement.querySelector('[data-testid="flow-legacy-overview-host"]'),
    );

    fixture.componentRef.setInput('useSvgMinimap', true);
    fixture.detectChanges();
    expect(emitSpy).toHaveBeenLastCalledWith(undefined);
  });

  it('legacy Overview 保留可聚焦语义与方向键、加减键导航', () => {
    const diagram = {
      position: new go.Point(0, 0),
      viewportBounds: new go.Rect(0, 0, 200, 100),
      scale: 1,
      minScale: 0.1,
      maxScale: 3,
    } as go.Diagram;
    const fixture = createPanelFixture(diagram);
    fixture.componentRef.setInput('useSvgMinimap', false);
    fixture.detectChanges();
    const host = fixture.nativeElement.querySelector('[data-testid="flow-legacy-overview-host"]') as HTMLElement;

    expect(host.tabIndex).toBe(0);
    expect(host.getAttribute('role')).toBe('application');
    expect(host.getAttribute('aria-label')).toContain('方向键');
    expect(host.getAttribute('aria-label')).toContain('+/-');

    const pan = new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true });
    host.dispatchEvent(pan);
    expect(pan.defaultPrevented).toBe(true);
    expect(diagram.position.x).toBeGreaterThan(0);

    const zoom = new KeyboardEvent('keydown', { key: '+', bubbles: true, cancelable: true });
    host.dispatchEvent(zoom);
    expect(zoom.defaultPrevented).toBe(true);
    expect(diagram.scale).toBeGreaterThan(1);
  });

  it('legacy Overview 保留滚轮缩放且不滚动页面', () => {
    const diagram = {
      position: new go.Point(0, 0),
      viewportBounds: new go.Rect(0, 0, 200, 100),
      scale: 1,
      minScale: 0.1,
      maxScale: 3,
    } as go.Diagram;
    const fixture = createPanelFixture(diagram);
    fixture.componentRef.setInput('useSvgMinimap', false);
    fixture.detectChanges();
    const host = fixture.nativeElement.querySelector('[data-testid="flow-legacy-overview-host"]') as HTMLElement;
    const wheel = new WheelEvent('wheel', {
      deltaY: -100,
      deltaMode: WheelEvent.DOM_DELTA_PIXEL,
      bubbles: true,
      cancelable: true,
    });

    host.dispatchEvent(wheel);

    expect(wheel.defaultPrevented).toBe(true);
    expect(diagram.scale).toBeGreaterThan(1);
  });

  it('折叠或 SVG 与 GoJS 切换会销毁重建小地图并重置临时筛选', () => {
    const fixture = createPanelFixture();
    fixture.detectChanges();
    const first = fixture.debugElement.query(By.directive(FlowMinimapComponent)).componentInstance as FlowMinimapComponent;
    first.toggleLegendCategory('sidecar');
    expect(first.hiddenCategories().has('sidecar')).toBe(true);

    fixture.componentRef.setInput('collapsed', true);
    fixture.detectChanges();
    expect(fixture.debugElement.query(By.directive(FlowMinimapComponent))).toBeNull();
    expect(first.hiddenCategories().size).toBe(0);

    fixture.componentRef.setInput('collapsed', false);
    fixture.detectChanges();
    const second = fixture.debugElement.query(By.directive(FlowMinimapComponent)).componentInstance as FlowMinimapComponent;
    expect(second).not.toBe(first);
    expect(second.hiddenCategories().size).toBe(0);
    second.toggleLegendCategory('sidecar');

    fixture.componentRef.setInput('useSvgMinimap', false);
    fixture.detectChanges();
    expect(fixture.debugElement.query(By.directive(FlowMinimapComponent))).toBeNull();
    expect(second.hiddenCategories().size).toBe(0);

    fixture.componentRef.setInput('useSvgMinimap', true);
    fixture.detectChanges();
    const third = fixture.debugElement.query(By.directive(FlowMinimapComponent)).componentInstance as FlowMinimapComponent;
    expect(third).not.toBe(second);
    expect(third.hiddenCategories().size).toBe(0);
  });
});
