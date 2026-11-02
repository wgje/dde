import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';

import { FlowMinimapLegendComponent } from './flow-minimap-legend.component';

describe('FlowMinimapLegendComponent', () => {
  it('隐藏态不抢占第一视觉，显示后提供六类非颜色图例', () => {
    TestBed.configureTestingModule({ imports: [FlowMinimapLegendComponent] });
    const fixture = TestBed.createComponent(FlowMinimapLegendComponent);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[role="group"]')).toBeNull();

    fixture.componentRef.setInput('visible', true);
    fixture.detectChanges();

    const buttons = fixture.nativeElement.querySelectorAll(
      '[data-minimap-legend-category]',
    ) as NodeListOf<HTMLButtonElement>;
    expect(buttons).toHaveLength(6);
    expect(Array.from(buttons).map(button => (button as HTMLElement).textContent?.trim())).toEqual([
      '僚机',
      '思源',
      '入坞',
      '停泊',
      '专注',
      '搜索',
    ]);
    expect(Array.from(buttons).every(button => button.querySelector('svg'))).toBe(true);
  });

  it('用 aria-pressed 表达临时筛选并向外发送类别，不直接修改输入 Set', () => {
    TestBed.configureTestingModule({ imports: [FlowMinimapLegendComponent] });
    const fixture = TestBed.createComponent(FlowMinimapLegendComponent);
    const hidden = new Set<'sidecar'>(['sidecar']);
    const emitSpy = vi.spyOn(fixture.componentInstance.categoryToggle, 'emit');
    fixture.componentRef.setInput('visible', true);
    fixture.componentRef.setInput('hiddenCategories', hidden);
    fixture.detectChanges();

    const sidecar = fixture.nativeElement.querySelector(
      '[data-minimap-legend-category="sidecar"]',
    ) as HTMLButtonElement;
    const parked = fixture.nativeElement.querySelector(
      '[data-minimap-legend-category="parked"]',
    ) as HTMLButtonElement;
    expect(sidecar.getAttribute('aria-pressed')).toBe('false');
    expect(parked.getAttribute('aria-pressed')).toBe('true');

    parked.click();
    expect(emitSpy).toHaveBeenCalledWith('parked');
    expect(hidden).toEqual(new Set(['sidecar']));
  });

  it('桌面图例使用原稿中的深色半透明底部信息轨，而非白色浮动按钮条', () => {
    TestBed.configureTestingModule({ imports: [FlowMinimapLegendComponent] });
    const fixture = TestBed.createComponent(FlowMinimapLegendComponent);
    fixture.componentRef.setInput('visible', true);
    fixture.detectChanges();

    const styles = Array.from(document.head.querySelectorAll('style'))
      .map(style => style.textContent ?? '')
      .find(style => style.includes('--legend-surface')) ?? '';
    expect(styles).toContain('--legend-surface: rgba(21, 24, 32, 0.92)');
    expect(styles).toContain('--legend-ink: #d8dde6');
    expect(styles).toMatch(/\.legend[^{]*\{[^}]*width:\s*100%/);
    expect(styles).toMatch(/\.legend[^{]*\{[^}]*backdrop-filter:\s*blur\(12px\)/);
  });
});
