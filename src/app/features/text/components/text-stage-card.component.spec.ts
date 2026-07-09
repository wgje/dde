import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('TextStageCardComponent', () => {
  it('应使用外部模板和样式文件，避免阶段卡片继续膨胀为内联组件', () => {
    const source = readFileSync(resolve(__dirname, 'text-stage-card.component.ts'), 'utf8');

    expect(source).toContain("templateUrl: './text-stage-card.component.html'");
    expect(source).toContain("styleUrl: './text-stage-card.component.css'");
    expect(source).not.toContain('template: `');
    expect(source).not.toContain('styles: [`');
  });

  it('折叠列表模板应保留 inert 与 aria-hidden 防线', () => {
    const source = readFileSync(resolve(__dirname, 'text-stage-card.component.html'), 'utf8');

    expect(source).toContain('[attr.inert]="!isExpanded() ? \'\' : null"');
    expect(source).toContain('[attr.aria-hidden]="!isExpanded()"');
  });

  it('阶段任务列表应保留原生内外滚动链路', () => {
    const template = readFileSync(resolve(__dirname, 'text-stage-card.component.html'), 'utf8');
    const styles = readFileSync(resolve(__dirname, 'text-stage-card.component.css'), 'utf8');

    expect(template).toContain('overflow-y-auto');
    expect(template).toContain('max-h-[60vh]');
    expect(template).toContain('max-h-[40vh]');
    expect(styles).toContain('overscroll-behavior-y: auto');
    expect(styles).toContain('-webkit-overflow-scrolling: touch');
    expect(styles).toContain('scrollbar-gutter: stable');
    expect(template).not.toContain('(wheel)=');
    expect(template).not.toContain('(touchmove)=');
    expect(template).not.toContain('onTaskListWheel');
    expect(template).not.toContain('onTaskListTouchMove');
    expect(template).not.toContain('scrollTop =');
  });
});
