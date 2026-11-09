import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Task } from '../../../../models';
import { ProjectStateService, type TaskConnectionInfo } from '../../../../services/project-state.service';
import { TextTaskConnectionsComponent } from './text-task-connections.component';

const task = (id: string, title: string, displayId = id): Task => ({
  id,
  title,
  displayId,
  content: '',
  stage: 1,
  parentId: null,
  order: 0,
  rank: 0,
  status: 'active',
  x: 0,
  y: 0,
  createdDate: '2026-08-03T00:00:00.000Z',
});

const outgoingTask = task('target-1', '目标任务', 'T1');
const incomingTask = task('source-1', '', 'S1');
const connections: TaskConnectionInfo = {
  outgoing: [
    { targetId: outgoingTask.id, targetTask: outgoingTask, description: '下一步' },
    { targetId: 'missing-target', targetTask: undefined },
  ],
  incoming: [
    { sourceId: incomingTask.id, sourceTask: incomingTask, description: '前置' },
    { sourceId: 'missing-source', sourceTask: undefined },
  ],
};

describe('TextTaskConnectionsComponent', () => {
  let fixture: ComponentFixture<TextTaskConnectionsComponent>;

  const host = () => fixture.nativeElement as HTMLElement;
  const header = () => host().querySelector('.text-task-connections-header') as HTMLButtonElement;
  const region = () => host().querySelector('.text-task-connections-region') as HTMLElement;
  const rows = () => Array.from(host().querySelectorAll('.text-task-connection-card')) as HTMLButtonElement[];

  const render = (value = connections, isMobile = false) => {
    fixture = TestBed.createComponent(TextTaskConnectionsComponent);
    fixture.componentInstance.connections = value;
    fixture.componentInstance.isMobile = isMobile;
    fixture.detectChanges();
  };

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [TextTaskConnectionsComponent],
      providers: [
        { provide: ProjectStateService, useValue: { compressDisplayId: (value: string) => value } },
      ],
    }).compileComponents();
    render();
  });

  it('应以原生按钮披露关联总数并指向始终挂载的区域', () => {
    const button = header();
    const content = region();

    expect(button).toBeInstanceOf(HTMLButtonElement);
    expect(button.type).toBe('button');
    expect(button.getAttribute('aria-label')).toBe('任务关联，共 4 条');
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(button.getAttribute('aria-controls')).toBe(content.id);
    expect(content.hidden).toBe(false);
    expect(content.getAttribute('aria-hidden')).toBe('false');
    expect(content.hasAttribute('inert')).toBe(false);
  });

  it('两个同时存在的实例应拥有不同且内部一致的披露关系', () => {
    const second = TestBed.createComponent(TextTaskConnectionsComponent);
    second.componentInstance.connections = connections;
    second.detectChanges();
    const firstButton = header();
    const firstRegion = region();
    const secondHost = second.nativeElement as HTMLElement;
    const secondButton = secondHost.querySelector('.text-task-connections-header') as HTMLButtonElement;
    const secondRegion = secondHost.querySelector('.text-task-connections-region') as HTMLElement;

    expect(firstRegion.id).toMatch(/^text-task-connections-region-\d+$/);
    expect(secondRegion.id).toMatch(/^text-task-connections-region-\d+$/);
    expect(secondRegion.id).not.toBe(firstRegion.id);
    expect(Number(secondRegion.id.split('-').at(-1))).toBe(Number(firstRegion.id.split('-').at(-1)) + 1);
    expect(firstButton.getAttribute('aria-controls')).toBe(firstRegion.id);
    expect(secondButton.getAttribute('aria-controls')).toBe(secondRegion.id);
    fixture.detectChanges();
    expect(region()).toBe(firstRegion);
    expect(region().id).toBe(firstRegion.id);
  });

  it('披露按钮应单次切换并保持同一区域节点及完整折叠语义', () => {
    const button = header();
    const content = region();
    const hostClick = vi.fn();
    host().addEventListener('click', hostClick);

    button.click();
    fixture.detectChanges();

    expect(region()).toBe(content);
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(content.hidden).toBe(true);
    expect(content.hasAttribute('inert')).toBe(true);
    expect(content.getAttribute('aria-hidden')).toBe('true');
    expect(content.classList.contains('animate-collapse-open')).toBe(false);
    expect(hostClick).not.toHaveBeenCalled();

    button.click();
    fixture.detectChanges();

    expect(region()).toBe(content);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(content.hidden).toBe(false);
    expect(content.hasAttribute('inert')).toBe(false);
    expect(content.getAttribute('aria-hidden')).toBe('false');
    expect(content.classList.contains('animate-collapse-open')).toBe(true);
  });

  it('可用发出关联应单次发送目标任务和原始事件且不折叠或冒泡', () => {
    const emit = vi.fn();
    const hostClick = vi.fn();
    fixture.componentInstance.openTask.subscribe(emit);
    host().addEventListener('click', hostClick);
    const row = rows()[0];

    expect(row).toBeInstanceOf(HTMLButtonElement);
    expect(row.type).toBe('button');
    expect(row.getAttribute('aria-label')).toBe('打开关联任务：目标任务');
    const event = new MouseEvent('click', { bubbles: true });
    row.dispatchEvent(event);

    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0][0].taskId).toBe('target-1');
    expect(emit.mock.calls[0][0].event).toBe(event);
    expect(hostClick).not.toHaveBeenCalled();
    expect(header().getAttribute('aria-expanded')).toBe('true');
  });

  it('可用来源关联应使用方向名称和标题缺失时的任务 ID', () => {
    const emit = vi.fn();
    fixture.componentInstance.openTask.subscribe(emit);
    const row = rows()[2];

    expect(row.getAttribute('aria-label')).toBe('打开来源任务：source-1');
    row.click();

    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0][0].taskId).toBe('source-1');
  });

  it('缺失目标和来源应为原生禁用按钮并拒绝发送', () => {
    const emit = vi.fn();
    fixture.componentInstance.openTask.subscribe(emit);
    const missingTarget = rows()[1];
    const missingSource = rows()[3];

    expect(missingTarget.disabled).toBe(true);
    expect(missingTarget.getAttribute('aria-label')).toBe('关联任务不可用：missing-target');
    expect(missingSource.disabled).toBe(true);
    expect(missingSource.getAttribute('aria-label')).toBe('来源任务不可用：missing-source');
    expect(missingTarget.classList.contains('disabled:cursor-default')).toBe(true);
    expect(missingSource.classList.contains('disabled:opacity-70')).toBe(true);
    expect(missingTarget.querySelector('svg')?.classList.contains('group-hover:text-violet-600')).toBe(false);
    expect(missingTarget.querySelector('svg')?.classList.contains('text-stone-300')).toBe(true);
    expect(missingTarget.querySelector('svg')?.classList.contains('text-violet-400')).toBe(false);
    expect(missingSource.querySelector('svg')?.classList.contains('group-hover:text-indigo-600')).toBe(false);
    expect(missingSource.querySelector('svg')?.classList.contains('text-stone-300')).toBe(true);
    expect(missingSource.querySelector('svg')?.classList.contains('text-indigo-400')).toBe(false);

    missingTarget.click();
    missingSource.click();
    expect(emit).not.toHaveBeenCalled();
  });

  it('移动布局应保留宽度类和单击打开行为', () => {
    const desktopPanel = host().querySelector('.text-task-connections-panel') as HTMLElement;
    expect(desktopPanel.classList.contains('w-36')).toBe(true);
    expect(header().classList.contains('w-full')).toBe(true);
    expect(header().classList.contains('focus-visible:ring-inset')).toBe(true);
    expect(rows()[0].classList.contains('enabled:hover:bg-violet-100/50')).toBe(true);
    expect(rows()[0].classList.contains('bg-violet-50/50')).toBe(true);
    expect(rows()[2].classList.contains('bg-indigo-50/50')).toBe(true);
    expect(rows()[0].querySelector('svg')?.classList.contains('text-violet-400')).toBe(true);
    expect(rows()[0].querySelector('svg')?.classList.contains('group-hover:text-violet-600')).toBe(true);
    expect(rows()[2].querySelector('svg')?.classList.contains('text-indigo-400')).toBe(true);
    expect(rows()[2].querySelector('svg')?.classList.contains('group-hover:text-indigo-600')).toBe(true);
    render(connections, true);
    const emit = vi.fn();
    fixture.componentInstance.openTask.subscribe(emit);
    const panel = host().querySelector('.text-task-connections-panel') as HTMLElement;

    expect(panel.classList.contains('border-t')).toBe(true);
    expect(panel.classList.contains('pt-2')).toBe(true);
    expect(panel.classList.contains('mt-2')).toBe(true);
    expect(panel.classList.contains('w-36')).toBe(false);
    rows()[0].click();
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it('所有装饰应隐藏且源码不应引入模拟交互或异步激活', () => {
    const decorations = host().querySelectorAll('svg, .text-task-connections-icon');
    const componentSource = readFileSync(resolve(__dirname, 'text-task-connections.component.ts'), 'utf8');

    expect(decorations.length).toBeGreaterThan(0);
    for (const decoration of decorations) {
      expect(decoration.getAttribute('aria-hidden')).toBe('true');
    }
    expect(componentSource).not.toMatch(/\((?:key|touch|pointer)[^)]+\)/);
    expect(componentSource).not.toContain('@HostListener');
    for (const forbidden of ['setTimeout(', 'setInterval(', 'autofocus', 'role="button"',
      'Router', '.navigate(']) {
      expect(componentSource).not.toContain(forbidden);
    }
  });

  it('按钮内容和交互验证应只依赖公开渲染 DOM', () => {
    const phrasingTags = new Set(['SPAN', 'SVG', 'PATH']);
    for (const button of host().querySelectorAll('button')) {
      expect(button.querySelector('div, button, a, input, select, textarea')).toBeNull();
      expect(button.querySelector('[tabindex], iframe, label, audio[controls], video[controls]')).toBeNull();
      for (const descendant of button.querySelectorAll('*')) {
        expect(phrasingTags.has(descendant.tagName.toUpperCase())).toBe(true);
      }
      expect(button.classList.contains('focus-visible:ring-inset')).toBe(true);
    }
  });
});
