import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { signal, type WritableSignal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectStateService } from '../../../../services/project-state.service';
import { TextStageCardComponent } from './text-stage-card.component';
import type { StageData } from './text-view.types';

const stage: StageData = { stageNumber: 3, tasks: [] };

describe('TextStageCardComponent', () => {
  let fixture: ComponentFixture<TextStageCardComponent>;
  let expanded: WritableSignal<boolean>;

  const host = () => fixture.nativeElement as HTMLElement;
  const disclosure = () => host().querySelector('header > h3 > button') as HTMLButtonElement;
  const taskList = () => host().querySelector('[data-stage-task-list]') as HTMLElement;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [TextStageCardComponent],
      providers: [
        { provide: ProjectStateService, useValue: { getTaskConnections: vi.fn() } },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(TextStageCardComponent);
    expanded = signal(false);
    Object.assign(fixture.componentInstance, {
      stage: signal(stage),
      isExpanded: expanded,
    });
    fixture.detectChanges();
  });

  it('折叠态应暴露原生阶段披露按钮并关联不可交互任务列表', () => {
    const button = disclosure();
    const list = taskList();

    expect(button).toBeInstanceOf(HTMLButtonElement);
    expect(button.type).toBe('button');
    expect(button.tabIndex).toBe(0);
    expect(button.getAttribute('aria-label')).toBe('阶段 3，0 个任务');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(button.getAttribute('aria-controls')).toBe('text-stage-task-list-3');
    expect(list.id).toBe('text-stage-task-list-3');
    expect(list.hasAttribute('inert')).toBe(true);
    expect(list.getAttribute('aria-hidden')).toBe('true');
    expect(list.classList.contains('max-h-0')).toBe(true);
    expect(list.classList.contains('collapsed-section')).toBe(true);
  });

  it('原生按钮单次点击应只请求父级切换且不自行改变展开态', () => {
    const emit = vi.fn();
    fixture.componentInstance.toggleExpand.subscribe(emit);

    disclosure().click();

    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith(3);
    expect(disclosure().getAttribute('aria-expanded')).toBe('false');
    expect(taskList().hasAttribute('inert')).toBe(true);
  });

  it('父级更新展开输入后应复用披露关系并恢复任务列表交互', () => {
    const button = disclosure();
    const list = taskList();

    expanded.set(true);
    fixture.detectChanges();

    expect(disclosure()).toBe(button);
    expect(taskList()).toBe(list);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(button.getAttribute('aria-controls')).toBe(list.id);
    expect(list.hasAttribute('inert')).toBe(false);
    expect(list.getAttribute('aria-hidden')).toBe('false');
    expect(list.classList.contains('animate-collapse-open')).toBe(true);
    expect(list.classList.contains('opacity-100')).toBe(true);
  });

  it('按钮上的拖放事件应继续冒泡到阶段卡片边界', () => {
    const dragOver = vi.fn();
    const drop = vi.fn();
    fixture.componentInstance.stageDragOver.subscribe(dragOver);
    fixture.componentInstance.stageDrop.subscribe(drop);
    const overEvent = new Event('dragover', { bubbles: true, cancelable: true }) as DragEvent;
    const dropEvent = new Event('drop', { bubbles: true, cancelable: true }) as DragEvent;

    disclosure().dispatchEvent(overEvent);
    disclosure().dispatchEvent(dropEvent);

    expect(overEvent.defaultPrevented).toBe(true);
    expect(dropEvent.defaultPrevented).toBe(true);
    expect(dragOver).toHaveBeenCalledWith({ event: overEvent, stageNumber: 3 });
    expect(drop).toHaveBeenCalledWith({ event: dropEvent, stageNumber: 3 });
  });

  it('应使用外部模板和样式文件，避免阶段卡片继续膨胀为内联组件', () => {
    const source = readFileSync(resolve(__dirname, 'text-stage-card.component.ts'), 'utf8');

    expect(source).toContain("templateUrl: './text-stage-card.component.html'");
    expect(source).toContain("styleUrl: './text-stage-card.component.css'");
    expect(source).not.toContain('template: `');
    expect(source).not.toContain('styles: [`');
  });

  it('阶段卡片应保留外层拖放监听且不添加自定义键盘处理', () => {
    const source = readFileSync(resolve(__dirname, 'text-stage-card.component.html'), 'utf8');

    expect(source).toContain('(dragover)="onStageDragOver($event)"');
    expect(source).toContain('(dragleave)="onStageDragLeave($event)"');
    expect(source).toContain('(drop)="onStageDrop($event)"');
    expect(source).not.toContain('(keydown)');
    expect(source).not.toContain('(keyup)');
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
