import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FlowConnectionEditorComponent } from './flow-connection-editor.component';
import { LoggerService } from '../../../../services/logger.service';
import type { Task } from '../../../../models';
import { registerFlowConnectionEditorSaveSyncSpecs } from './flow-connection-editor-save-sync.spec-helpers';

describe('flow-connection-editor.component.ts structure', () => {
  it('keeps public payload/task types in helpers and re-exports them from the component', () => {
    const componentPath = join(process.cwd(), 'src/app/features/flow/components/flow-connection-editor.component.ts');
    const helpersPath = join(process.cwd(), 'src/app/features/flow/components/flow-connection-editor.helpers.ts');
    const componentSource = readFileSync(componentPath, 'utf8');
    const helpersSource = readFileSync(helpersPath, 'utf8');

    expect(helpersSource).toContain('export interface ConnectionTasks');
    expect(helpersSource).toContain('export interface ConnectionEditorSavePayload');
    expect(componentSource).toContain('export type { ConnectionTasks, ConnectionEditorSavePayload }');
    expect(componentSource).not.toContain('export interface ConnectionTasks');
    expect(componentSource).not.toContain('export interface ConnectionEditorSavePayload');
  });
});

function createTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    title: 'Task',
    content: '',
    stage: 1,
    parentId: null,
    order: 0,
    rank: 1,
    status: 'active',
    x: 0,
    y: 0,
    createdDate: new Date().toISOString(),
    displayId: '1',
    ...overrides,
  } as Task;
}

function createPreviewMouseEvent(target: EventTarget): MouseEvent {
  const event = new MouseEvent('click', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'target', { configurable: true, value: target });
  return event;
}

function createPreviewTouchEvent(target: EventTarget): TouchEvent {
  return { target } as unknown as TouchEvent;
}

describe('FlowConnectionEditorComponent', () => {
  let fixture: ComponentFixture<FlowConnectionEditorComponent>;
  let component: FlowConnectionEditorComponent;
  let outsideEl: HTMLButtonElement | null = null;

  beforeEach(() => {
    vi.useFakeTimers();

    TestBed.configureTestingModule({
      imports: [FlowConnectionEditorComponent],
      providers: [
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

    fixture = TestBed.createComponent(FlowConnectionEditorComponent);
    component = fixture.componentInstance;
  });

  afterEach(() => {
    outsideEl?.remove();
    outsideEl = null;
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  function getTimerInternals(): {
    saveTimer: ReturnType<typeof setTimeout> | null;
    focusTimer: ReturnType<typeof setTimeout> | null;
  } {
    return component as unknown as {
      saveTimer: ReturnType<typeof setTimeout> | null;
      focusTimer: ReturnType<typeof setTimeout> | null;
    };
  }

  it('标题变化重排保存时应清理 handle 为 0 的旧 save timer', () => {
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
    const internal = getTimerInternals();
    internal.saveTimer = 0 as unknown as ReturnType<typeof setTimeout>;

    component.onTitleChange('新标题');

    expect(clearTimeoutSpy).toHaveBeenCalledWith(0);
    expect(internal.saveTimer).not.toBe(0);
    expect(internal.saveTimer).not.toBeNull();
  });

  it('退出编辑态立即保存时应清理 handle 为 0 的旧 save timer', () => {
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
    const internal = getTimerInternals();
    component.isEditMode.set(true);
    internal.saveTimer = 0 as unknown as ReturnType<typeof setTimeout>;

    component.exitEditMode();

    expect(clearTimeoutSpy).toHaveBeenCalledWith(0);
    expect(internal.saveTimer).toBeNull();
  });

  it('进入编辑态重排聚焦时应清理 handle 为 0 的旧 focus timer', () => {
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
    const internal = getTimerInternals();
    internal.focusTimer = 0 as unknown as ReturnType<typeof setTimeout>;

    component.enterEditMode();

    expect(clearTimeoutSpy).toHaveBeenCalledWith(0);
    expect(internal.focusTimer).not.toBe(0);
    expect(internal.focusTimer).not.toBeNull();
  });

  it('销毁时应清理 handle 为 0 的保存和聚焦 timer', () => {
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
    const internal = getTimerInternals();
    internal.saveTimer = 0 as unknown as ReturnType<typeof setTimeout>;
    internal.focusTimer = 0 as unknown as ReturnType<typeof setTimeout>;

    component.ngOnDestroy();

    expect(clearTimeoutSpy).toHaveBeenCalledWith(0);
    expect(clearTimeoutSpy).toHaveBeenCalledTimes(2);
    expect(internal.saveTimer).toBeNull();
    expect(internal.focusTimer).toBeNull();
  });

  it('跨树关联首次打开应进入预览态', () => {
    (component as any).position = signal({ x: 160, y: 240 });
    (component as any).readOnly = signal(false);
    (component as any).connectionTasks = signal({
      source: createTask({ id: 'source-task', displayId: 'A' }),
      target: createTask({ id: 'target-task', displayId: 'B' }),
    });
    (component as any).data = signal<any>({
      sourceId: 'source-task',
      targetId: 'target-task',
      title: '依赖',
      description: '需要先完成前置任务',
      x: 160,
      y: 240,
      isCrossTree: true,
      mode: 'preview',
    });

    fixture.detectChanges();
    vi.advanceTimersByTime(60);
    fixture.detectChanges();

    expect(component.isEditMode()).toBe(false);
    expect(fixture.nativeElement.querySelector('input')).toBeNull();
    expect(fixture.nativeElement.querySelector('.markdown-preview')).not.toBeNull();
  });

  it('只读模式下点击预览区不应进入编辑态', () => {
    const modeChangeSpy = vi.spyOn(component.modeChange, 'emit');

    (component as any).position = signal({ x: 160, y: 240 });
    (component as any).readOnly = signal(true);
    (component as any).connectionTasks = signal({
      source: createTask({ id: 'source-task', displayId: 'A' }),
      target: createTask({ id: 'target-task', displayId: 'B' }),
    });
    (component as any).data = signal<any>({
      sourceId: 'source-task',
      targetId: 'target-task',
      title: '依赖',
      description: '需要先完成前置任务',
      x: 160,
      y: 240,
      isCrossTree: true,
      mode: 'preview',
    });

    fixture.detectChanges();
    vi.advanceTimersByTime(60);
    fixture.detectChanges();

    component.onPreviewClick(new MouseEvent('click'));
    fixture.detectChanges();

    expect(component.isEditMode()).toBe(false);
    expect(fixture.nativeElement.querySelector('input')).toBeNull();
    expect(modeChangeSpy).not.toHaveBeenCalledWith('edit');
  });

  it('点击任务 markdown 链接时应发射 openTask，而不是进入编辑态', () => {
    const openSpy = vi.spyOn(component.openTask, 'emit');
    const anchor = document.createElement('a');
    anchor.setAttribute('href', '#task:linked-task');
    anchor.setAttribute('data-link-kind', 'task');
    anchor.setAttribute('data-task-link-id', 'linked-task');
    const event = createPreviewMouseEvent(anchor);
    const stopPropagation = vi.spyOn(event, 'stopPropagation');
    const preventDefault = vi.spyOn(event, 'preventDefault');

    component.onPreviewClick(event);

    expect(stopPropagation).toHaveBeenCalled();
    expect(preventDefault).toHaveBeenCalled();
    expect(openSpy).toHaveBeenCalledWith('linked-task');
    expect(component.isEditMode()).toBe(false);
  });

  it('点击外链时应保持预览态', () => {
    const anchor = document.createElement('a');
    anchor.setAttribute('href', 'https://example.com');
    anchor.setAttribute('data-link-kind', 'external');
    const event = createPreviewMouseEvent(anchor);
    const stopPropagation = vi.spyOn(event, 'stopPropagation');
    const preventDefault = vi.spyOn(event, 'preventDefault');

    component.onPreviewClick(event);

    expect(stopPropagation).toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();
    expect(component.isEditMode()).toBe(false);
  });

  it('点击 blocked 链接时应阻止默认行为并保持预览态', () => {
    const openSpy = vi.spyOn(component.openTask, 'emit');
    const anchor = document.createElement('a');
    anchor.setAttribute('href', '#__nf_blocked__');
    anchor.setAttribute('data-link-kind', 'blocked');
    const event = createPreviewMouseEvent(anchor);
    const stopPropagation = vi.spyOn(event, 'stopPropagation');
    const preventDefault = vi.spyOn(event, 'preventDefault');

    component.onPreviewClick(event);

    expect(stopPropagation).toHaveBeenCalled();
    expect(preventDefault).toHaveBeenCalled();
    expect(openSpy).not.toHaveBeenCalled();
    expect(component.isEditMode()).toBe(false);
  });

  it('预览态文本被选中时，空白外部点击第一次只清选区，第二次关闭', () => {
    const closeSpy = vi.spyOn(component.close, 'emit');

    (component as any).position = signal({ x: 160, y: 240 });
    (component as any).readOnly = signal(false);
    (component as any).connectionTasks = signal({
      source: createTask({ id: 'source-task', displayId: 'A' }),
      target: createTask({ id: 'target-task', displayId: 'B' }),
    });
    (component as any).data = signal<any>({
      sourceId: 'source-task',
      targetId: 'target-task',
      title: '依赖',
      description: '需要先完成前置任务',
      x: 160,
      y: 240,
      isCrossTree: true,
      mode: 'preview',
    });

    fixture.detectChanges();
    vi.advanceTimersByTime(60);
    fixture.detectChanges();

    const removeAllRanges = vi.fn();
    const getSelectionSpy = vi.spyOn(window, 'getSelection').mockReturnValue({
      toString: () => '前置任务',
      rangeCount: 1,
      isCollapsed: false,
      removeAllRanges,
    } as unknown as Selection);

    const outsideBlank = document.createElement('div');
    outsideBlank.tabIndex = -1;
    document.body.appendChild(outsideBlank);
    outsideBlank.focus();
    const activeElementSpy = vi.spyOn(document, 'activeElement', 'get').mockReturnValue(outsideBlank);

    try {
      component.onDocumentClick(createPreviewMouseEvent(outsideBlank));

      expect(removeAllRanges).toHaveBeenCalledTimes(1);
      expect(closeSpy).not.toHaveBeenCalled();

      getSelectionSpy.mockReturnValue({
        toString: () => '',
        rangeCount: 0,
        isCollapsed: true,
        removeAllRanges: vi.fn(),
      } as unknown as Selection);
      component.onDocumentClick(createPreviewMouseEvent(outsideBlank));

      expect(closeSpy).toHaveBeenCalledTimes(1);
    } finally {
      activeElementSpy.mockRestore();
      getSelectionSpy.mockRestore();
      outsideBlank.remove();
    }
  });

  it('预览态文本被选中时，外部按钮点击应同次清选区并关闭', () => {
    const closeSpy = vi.spyOn(component.close, 'emit');

    (component as any).position = signal({ x: 160, y: 240 });
    (component as any).readOnly = signal(false);
    (component as any).connectionTasks = signal({
      source: createTask({ id: 'source-task', displayId: 'A' }),
      target: createTask({ id: 'target-task', displayId: 'B' }),
    });
    (component as any).data = signal<any>({
      sourceId: 'source-task',
      targetId: 'target-task',
      title: '依赖',
      description: '需要先完成前置任务',
      x: 160,
      y: 240,
      isCrossTree: true,
      mode: 'preview',
    });

    fixture.detectChanges();
    vi.advanceTimersByTime(60);
    fixture.detectChanges();

    const removeAllRanges = vi.fn();
    const getSelectionSpy = vi.spyOn(window, 'getSelection').mockReturnValue({
      toString: () => '前置任务',
      rangeCount: 1,
      isCollapsed: false,
      removeAllRanges,
    } as unknown as Selection);

    try {
      const outsideButton = document.createElement('button');
      const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      outsideButton.appendChild(icon);

      component.onDocumentClick(createPreviewMouseEvent(icon));

      expect(removeAllRanges).toHaveBeenCalledTimes(1);
      expect(closeSpy).toHaveBeenCalledTimes(1);
    } finally {
      getSelectionSpy.mockRestore();
    }
  });

  it('点击本地路径链接时应尝试打开并保持预览态', async () => {
    const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    const writeText = vi.fn().mockResolvedValue(undefined);
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    try {
      const openSpy = vi.spyOn(component.openTask, 'emit');
      const anchor = document.createElement('a');
      anchor.setAttribute('href', '#local-path');
      anchor.setAttribute('data-link-kind', 'local');
      anchor.setAttribute('data-local-link-path', 'C:\\Docs\\Plan.md');
      const event = createPreviewMouseEvent(anchor);
      const stopPropagation = vi.spyOn(event, 'stopPropagation');
      const preventDefault = vi.spyOn(event, 'preventDefault');

      component.onPreviewClick(event);
      await Promise.resolve();

      expect(stopPropagation).toHaveBeenCalled();
      expect(preventDefault).toHaveBeenCalled();
      expect(openSpy).not.toHaveBeenCalled();
      expect(component.isEditMode()).toBe(false);
      expect(writeText).toHaveBeenCalledWith('C:\\Docs\\Plan.md');
      expect(clickSpy).toHaveBeenCalled();
    } finally {
      clickSpy.mockRestore();
      if (originalClipboard) {
        Object.defineProperty(navigator, 'clipboard', originalClipboard);
      } else {
        Reflect.deleteProperty(navigator as object, 'clipboard');
      }
    }
  });

  it('只读预览态应移除可编辑提示文案和可点击光标', () => {
    (component as any).position = signal({ x: 160, y: 240 });
    (component as any).readOnly = signal(true);
    (component as any).connectionTasks = signal({
      source: createTask({ id: 'source-task', displayId: 'A' }),
      target: createTask({ id: 'target-task', displayId: 'B' }),
    });
    (component as any).data = signal<any>({
      sourceId: 'source-task',
      targetId: 'target-task',
      title: '',
      description: '',
      x: 160,
      y: 240,
      isCrossTree: true,
      mode: 'preview',
    });

    fixture.detectChanges();
    vi.advanceTimersByTime(60);
    fixture.detectChanges();

    const previewEl = fixture.nativeElement.querySelector('.cursor-default') as HTMLElement | null;

    expect(previewEl).not.toBeNull();
    expect(previewEl?.textContent).toContain('会话确认完成后可编辑标题和描述...');
    expect(previewEl?.textContent).not.toContain('点击添加标题和描述...');
  });

  it('父子关系打开后应保持只读关系说明', () => {
    (component as any).position = signal({ x: 160, y: 240 });
    (component as any).connectionTasks = signal({
      source: createTask({ id: 'parent-task', displayId: 'A' }),
      target: createTask({ id: 'child-task', displayId: 'A,1', parentId: 'parent-task' }),
    });
    (component as any).data = signal<any>({
      sourceId: 'parent-task',
      targetId: 'child-task',
      title: '',
      description: '',
      x: 160,
      y: 240,
      isCrossTree: false,
      mode: 'preview',
    });

    fixture.detectChanges();

    expect(component.isEditMode()).toBe(false);
    expect(fixture.nativeElement.textContent).toContain('这是树形结构的父子关系');
    expect(fixture.nativeElement.querySelector('textarea')).toBeNull();
  });

  it('编辑态触摸编辑器外部时应自动保存并退出编辑态', () => {
    const saveSpy = vi.spyOn(component.save, 'emit');
    const closeSpy = vi.spyOn(component.close, 'emit');
    const modeChangeSpy = vi.spyOn(component.modeChange, 'emit');

    (component as any).position = signal({ x: 160, y: 240 });
    (component as any).connectionTasks = signal({
      source: createTask({ id: 'source-task', displayId: 'A' }),
      target: createTask({ id: 'target-task', displayId: 'B' }),
    });
    (component as any).data = signal<any>({
      sourceId: 'source-task',
      targetId: 'target-task',
      title: '依赖',
      description: '旧描述',
      x: 160,
      y: 240,
      isCrossTree: true,
      mode: 'edit',
    });

    fixture.detectChanges();
    vi.advanceTimersByTime(60);
    fixture.detectChanges();

    const titleInput = fixture.nativeElement.querySelector('input') as HTMLInputElement;
    const textarea = fixture.nativeElement.querySelector('textarea') as HTMLTextAreaElement;
    expect(textarea).not.toBeNull();

    component.editingTitle = '过期标题';
    component.editingDescription = '过期描述';
    titleInput.value = '依赖';
    textarea.value = '新描述';
    Object.defineProperty(document, 'activeElement', {
      configurable: true,
      get: () => textarea,
    });
    vi.spyOn(window, 'getSelection').mockReturnValue({ toString: () => '' } as Selection);
    vi.advanceTimersByTime(300);

    outsideEl = document.createElement('button');
    document.body.appendChild(outsideEl);

    // 直接调用组件方法模拟触摸事件
    component.onDocumentTouchStart(createPreviewTouchEvent(outsideEl));
    // 推进定时器以触发延迟保存
    vi.advanceTimersByTime(100);

    expect(saveSpy).toHaveBeenCalledTimes(1);
    expect(saveSpy).toHaveBeenCalledWith({
      sourceId: 'source-task',
      targetId: 'target-task',
      title: '依赖',
      description: '新描述',
    });
    expect(modeChangeSpy).toHaveBeenCalledWith('preview');
    expect(component.isEditMode()).toBe(false);
    expect(closeSpy).not.toHaveBeenCalled();
  });

  it('销毁后延迟触摸回调不应再保存或切换编辑态', () => {
    const saveSpy = vi.spyOn(component.save, 'emit');
    const closeSpy = vi.spyOn(component.close, 'emit');
    const modeChangeSpy = vi.spyOn(component.modeChange, 'emit');

    (component as any).position = signal({ x: 160, y: 240 });
    (component as any).connectionTasks = signal({
      source: createTask({ id: 'source-task', displayId: 'A' }),
      target: createTask({ id: 'target-task', displayId: 'B' }),
    });
    (component as any).data = signal<any>({
      sourceId: 'source-task',
      targetId: 'target-task',
      title: '依赖',
      description: '旧描述',
      x: 160,
      y: 240,
      isCrossTree: true,
      mode: 'edit',
    });

    fixture.detectChanges();
    vi.advanceTimersByTime(60);
    fixture.detectChanges();

    outsideEl = document.createElement('button');
    document.body.appendChild(outsideEl);

    component.onDocumentTouchStart(createPreviewTouchEvent(outsideEl));
    component.ngOnDestroy();
    vi.advanceTimersByTime(100);

    expect(saveSpy).not.toHaveBeenCalled();
    expect(closeSpy).not.toHaveBeenCalled();
    expect(modeChangeSpy).not.toHaveBeenCalledWith('preview');
    expect(component.isEditMode()).toBe(true);
  });

  it('同一关联块会话从预览切到编辑时应响应外部 mode 变化', () => {
    const dataSignal = signal<any>({
      sourceId: 'source-task',
      targetId: 'target-task',
      title: '依赖',
      description: '需要先完成前置任务',
      x: 160,
      y: 240,
      isCrossTree: true,
      mode: 'preview',
    });

    (component as any).position = signal({ x: 160, y: 240 });
    (component as any).connectionTasks = signal({
      source: createTask({ id: 'source-task', displayId: 'A' }),
      target: createTask({ id: 'target-task', displayId: 'B' }),
    });
    (component as any).data = dataSignal;

    fixture.detectChanges();
    vi.advanceTimersByTime(60);
    fixture.detectChanges();

    expect(component.isEditMode()).toBe(false);

    dataSignal.set({
      ...dataSignal(),
      mode: 'edit',
    });
    fixture.detectChanges();
    vi.advanceTimersByTime(60);
    fixture.detectChanges();

    expect(component.isEditMode()).toBe(true);
    expect(fixture.nativeElement.querySelector('input')).not.toBeNull();
  });

  it('只读状态切入时应从本地编辑态回落到预览态', () => {
    const modeChangeSpy = vi.spyOn(component.modeChange, 'emit');
    const readOnlySignal = signal(false);
    const dataSignal = signal<any>({
      sourceId: 'source-task',
      targetId: 'target-task',
      title: '旧标题',
      description: '旧描述',
      x: 160,
      y: 240,
      isCrossTree: true,
      mode: 'edit',
    });

    (component as any).position = signal({ x: 160, y: 240 });
    (component as any).readOnly = readOnlySignal;
    (component as any).connectionTasks = signal({
      source: createTask({ id: 'source-task', displayId: 'A' }),
      target: createTask({ id: 'target-task', displayId: 'B' }),
    });
    (component as any).data = dataSignal;

    fixture.detectChanges();
    vi.advanceTimersByTime(60);
    fixture.detectChanges();

    expect(component.isEditMode()).toBe(true);

    component.editingTitle = '未保存标题';
    component.editingDescription = '未保存描述';

    readOnlySignal.set(true);
    fixture.detectChanges();

    expect(component.isEditMode()).toBe(false);
    expect(fixture.nativeElement.querySelector('input')).toBeNull();
    expect(component.currentTitle()).toBe('旧标题');
    expect(component.currentDescription()).toBe('旧描述');
    expect(modeChangeSpy).toHaveBeenCalledWith('preview');
  });

  registerFlowConnectionEditorSaveSyncSpecs({
    getFixture: () => fixture,
    getComponent: () => component,
  });
});
