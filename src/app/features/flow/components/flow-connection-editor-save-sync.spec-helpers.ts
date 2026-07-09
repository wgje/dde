import { signal } from '@angular/core';
import type { ComponentFixture } from '@angular/core/testing';
import { afterEach, expect, it, vi } from 'vitest';

import type { Task } from '../../../../models';
import { FlowConnectionEditorComponent } from './flow-connection-editor.component';

interface FlowConnectionEditorSaveSyncSpecContext {
  getFixture: () => ComponentFixture<FlowConnectionEditorComponent>;
  getComponent: () => FlowConnectionEditorComponent;
}

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

function createPreviewTouchEvent(target: EventTarget): TouchEvent {
  return { target } as unknown as TouchEvent;
}

function createPreviewMouseEvent(target: EventTarget): MouseEvent {
  const event = new MouseEvent('click', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'target', { configurable: true, value: target });
  return event;
}

export function registerFlowConnectionEditorSaveSyncSpecs(
  context: FlowConnectionEditorSaveSyncSpecContext,
): void {
  let outsideEl: HTMLButtonElement | null = null;

  afterEach(() => {
    outsideEl?.remove();
    outsideEl = null;
  });

  it('同会话 data 更新后立即触摸外部也应退出编辑并保存（不应被保护窗口误拦截）', () => {
    const fixture = context.getFixture();
    const component = context.getComponent();
    const saveSpy = vi.spyOn(component.save, 'emit');

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
    (component as any).connectionTasks = signal({
      source: createTask({ id: 'source-task', displayId: 'A' }),
      target: createTask({ id: 'target-task', displayId: 'B' }),
    });
    (component as any).data = dataSignal;

    fixture.detectChanges();
    vi.advanceTimersByTime(260);
    fixture.detectChanges();

    const titleInput = fixture.nativeElement.querySelector('input') as HTMLInputElement;
    const textarea = fixture.nativeElement.querySelector('textarea') as HTMLTextAreaElement;

    component.editingTitle = '过期标题';
    component.editingDescription = '过期描述';
    titleInput.value = '同会话最新标题';
    textarea.value = '同会话最新描述';

    dataSignal.set({
      ...dataSignal(),
      title: '旧标题',
      description: '旧描述',
      mode: 'edit',
    });
    fixture.detectChanges();

    outsideEl = document.createElement('button');
    document.body.appendChild(outsideEl);

    component.onDocumentTouchStart(createPreviewTouchEvent(outsideEl));
    vi.advanceTimersByTime(120);

    expect(saveSpy).toHaveBeenCalledTimes(1);
    expect(saveSpy).toHaveBeenCalledWith({
      sourceId: 'source-task',
      targetId: 'target-task',
      title: '同会话最新标题',
      description: '同会话最新描述',
    });
  });

  it('父层将 mode 从 edit 切到 preview 时应先保存最新 DOM 值', () => {
    const fixture = context.getFixture();
    const component = context.getComponent();
    const saveSpy = vi.spyOn(component.save, 'emit');

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
    (component as any).connectionTasks = signal({
      source: createTask({ id: 'source-task', displayId: 'A' }),
      target: createTask({ id: 'target-task', displayId: 'B' }),
    });
    (component as any).data = dataSignal;

    fixture.detectChanges();
    vi.advanceTimersByTime(60);
    fixture.detectChanges();

    const titleInput = fixture.nativeElement.querySelector('input') as HTMLInputElement;
    const textarea = fixture.nativeElement.querySelector('textarea') as HTMLTextAreaElement;

    component.editingTitle = '过期标题';
    component.editingDescription = '过期描述';
    titleInput.value = '切换前最新标题';
    textarea.value = '切换前最新描述';

    dataSignal.set({
      ...dataSignal(),
      mode: 'preview',
      title: '旧标题',
      description: '旧描述',
    });
    fixture.detectChanges();

    expect(saveSpy).toHaveBeenCalledTimes(1);
    expect(saveSpy).toHaveBeenCalledWith({
      sourceId: 'source-task',
      targetId: 'target-task',
      title: '切换前最新标题',
      description: '切换前最新描述',
    });
    expect(component.isEditMode()).toBe(false);
  });

  it('父层触发 edit->preview 的同一次外部点击不应立即把预览态关闭', () => {
    const fixture = context.getFixture();
    const component = context.getComponent();
    const saveSpy = vi.spyOn(component.save, 'emit');
    const closeSpy = vi.spyOn(component.close, 'emit');

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
    (component as any).connectionTasks = signal({
      source: createTask({ id: 'source-task', displayId: 'A' }),
      target: createTask({ id: 'target-task', displayId: 'B' }),
    });
    (component as any).data = dataSignal;

    fixture.detectChanges();
    vi.advanceTimersByTime(60);
    fixture.detectChanges();

    const titleInput = fixture.nativeElement.querySelector('input') as HTMLInputElement;
    const textarea = fixture.nativeElement.querySelector('textarea') as HTMLTextAreaElement;
    titleInput.value = '竞态标题';
    textarea.value = '竞态描述';

    dataSignal.set({
      ...dataSignal(),
      mode: 'preview',
      title: '旧标题',
      description: '旧描述',
    });
    fixture.detectChanges();

    outsideEl = document.createElement('button');
    document.body.appendChild(outsideEl);
    component.onDocumentClick(createPreviewMouseEvent(outsideEl));

    expect(saveSpy).toHaveBeenCalledTimes(1);
    expect(saveSpy).toHaveBeenCalledWith({
      sourceId: 'source-task',
      targetId: 'target-task',
      title: '竞态标题',
      description: '竞态描述',
    });
    expect(closeSpy).not.toHaveBeenCalled();
    expect(component.isEditMode()).toBe(false);
  });

  it('触摸编辑器外部时应优先保存输入框中的最新 DOM 值并退出编辑态', () => {
    const fixture = context.getFixture();
    const component = context.getComponent();
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
      title: '旧标题',
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

    component.editingTitle = '过期标题';
    component.editingDescription = '过期描述';
    titleInput.value = 'DOM 最新标题';
    textarea.value = 'DOM 最新描述';
    vi.advanceTimersByTime(300);

    outsideEl = document.createElement('button');
    document.body.appendChild(outsideEl);

    component.onDocumentTouchStart(createPreviewTouchEvent(outsideEl));
    vi.advanceTimersByTime(100);

    expect(saveSpy).toHaveBeenCalledTimes(1);
    expect(saveSpy).toHaveBeenCalledWith({
      sourceId: 'source-task',
      targetId: 'target-task',
      title: 'DOM 最新标题',
      description: 'DOM 最新描述',
    });
    expect(modeChangeSpy).toHaveBeenCalledWith('preview');
    expect(component.isEditMode()).toBe(false);
    expect(closeSpy).not.toHaveBeenCalled();
  });

  it('输入法组合输入期间触摸编辑器外部时也应保存最后可见文本并退出编辑态', () => {
    const fixture = context.getFixture();
    const component = context.getComponent();
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

    component.onCompositionStart('description');
    component.editingDescription = '组合前旧值';
    titleInput.value = '依赖';
    textarea.value = '中文输入中的最新值';
    vi.advanceTimersByTime(300);

    outsideEl = document.createElement('button');
    document.body.appendChild(outsideEl);

    component.onDocumentTouchStart(createPreviewTouchEvent(outsideEl));
    vi.advanceTimersByTime(250);

    expect(saveSpy).toHaveBeenCalledTimes(1);
    expect(saveSpy).toHaveBeenCalledWith({
      sourceId: 'source-task',
      targetId: 'target-task',
      title: '依赖',
      description: '中文输入中的最新值',
    });
    expect(modeChangeSpy).toHaveBeenCalledWith('preview');
    expect(component.isEditMode()).toBe(false);
    expect(closeSpy).not.toHaveBeenCalled();
  });

  it('输入法组合输入期间防抖保存不应提交未完成文本，应等待 compositionend 后保存最终值', () => {
    const fixture = context.getFixture();
    const component = context.getComponent();
    const saveSpy = vi.spyOn(component.save, 'emit');

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

    component.onCompositionStart('description');
    titleInput.value = '依赖';
    textarea.value = '未完成输入';
    component.onDescriptionChange('未完成输入');

    vi.advanceTimersByTime(600);

    expect(saveSpy).not.toHaveBeenCalled();

    textarea.value = '最终中文';
    component.onCompositionEnd('description');
    vi.advanceTimersByTime(500);

    expect(saveSpy).toHaveBeenCalledTimes(1);
    expect(saveSpy).toHaveBeenCalledWith({
      sourceId: 'source-task',
      targetId: 'target-task',
      title: '依赖',
      description: '最终中文',
    });
  });

  it('触摸外部的延迟回调在父层切换到另一条连接后不应作用到新会话', () => {
    const fixture = context.getFixture();
    const component = context.getComponent();
    const saveSpy = vi.spyOn(component.save, 'emit');
    const modeChangeSpy = vi.spyOn(component.modeChange, 'emit');

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
    (component as any).connectionTasks = signal({
      source: createTask({ id: 'source-task', displayId: 'A' }),
      target: createTask({ id: 'target-task', displayId: 'B' }),
    });
    (component as any).data = dataSignal;

    fixture.detectChanges();
    vi.advanceTimersByTime(60);
    fixture.detectChanges();

    const titleInput = fixture.nativeElement.querySelector('input') as HTMLInputElement;
    const textarea = fixture.nativeElement.querySelector('textarea') as HTMLTextAreaElement;
    titleInput.value = '旧连接最新标题';
    textarea.value = '旧连接最新描述';

    outsideEl = document.createElement('button');
    document.body.appendChild(outsideEl);

    component.onDocumentTouchStart(createPreviewTouchEvent(outsideEl));

    dataSignal.set({
      sourceId: 'new-source-task',
      targetId: 'new-target-task',
      title: '新连接标题',
      description: '新连接描述',
      x: 240,
      y: 320,
      isCrossTree: true,
      mode: 'edit',
    });
    fixture.detectChanges();
    vi.advanceTimersByTime(60);
    fixture.detectChanges();

    saveSpy.mockClear();
    modeChangeSpy.mockClear();

    vi.advanceTimersByTime(100);

    expect(component.isEditMode()).toBe(true);
    expect(saveSpy).not.toHaveBeenCalled();
    expect(modeChangeSpy).not.toHaveBeenCalledWith('preview');
  });

  it('父层直接清空编辑器数据时也应保存最新 DOM 值', () => {
    const fixture = context.getFixture();
    const component = context.getComponent();
    const saveSpy = vi.spyOn(component.save, 'emit');

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
    (component as any).connectionTasks = signal({
      source: createTask({ id: 'source-task', displayId: 'A' }),
      target: createTask({ id: 'target-task', displayId: 'B' }),
    });
    (component as any).data = dataSignal;

    fixture.detectChanges();
    vi.advanceTimersByTime(60);
    fixture.detectChanges();

    const titleInput = fixture.nativeElement.querySelector('input') as HTMLInputElement;
    const textarea = fixture.nativeElement.querySelector('textarea') as HTMLTextAreaElement;

    component.editingTitle = '过期标题';
    component.editingDescription = '过期描述';
    titleInput.value = '父层关闭前的最新标题';
    textarea.value = '父层关闭前的最新描述';
    vi.advanceTimersByTime(300);

    dataSignal.set(null);
    fixture.detectChanges();

    expect(saveSpy).toHaveBeenCalledTimes(1);
    expect(saveSpy).toHaveBeenCalledWith({
      sourceId: 'source-task',
      targetId: 'target-task',
      title: '父层关闭前的最新标题',
      description: '父层关闭前的最新描述',
    });
  });

  it('服务层回流更新后用户继续编辑再触摸外部仍应保存最新内容并退出编辑态', () => {
    const fixture = context.getFixture();
    const component = context.getComponent();
    const saveSpy = vi.spyOn(component.save, 'emit');
    const closeSpy = vi.spyOn(component.close, 'emit');
    const modeChangeSpy = vi.spyOn(component.modeChange, 'emit');

    const dataSignal = signal<any>({
      sourceId: 'source-task',
      targetId: 'target-task',
      title: '初始标题',
      description: '初始描述',
      x: 160,
      y: 240,
      isCrossTree: true,
      mode: 'edit',
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

    const titleInput = fixture.nativeElement.querySelector('input') as HTMLInputElement;
    const textarea = fixture.nativeElement.querySelector('textarea') as HTMLTextAreaElement;

    // 第一次编辑
    titleInput.value = '第一次编辑标题';
    textarea.value = '第一次编辑描述';
    component.onTitleChange('第一次编辑标题');
    component.onDescriptionChange('第一次编辑描述');

    // 等待防抖保存触发
    vi.advanceTimersByTime(600);

    // 模拟服务层回流更新 data（这在真实场景中会由 saveConnectionContent 触发）
    dataSignal.set({
      ...dataSignal(),
      title: '第一次编辑标题',
      description: '第一次编辑描述',
    });
    fixture.detectChanges();

    // 用户继续编辑
    titleInput.value = '最终标题';
    textarea.value = '最终描述';
    component.onTitleChange('最终标题');
    component.onDescriptionChange('最终描述');

    // 此时用户立即点击外部（不等待防抖），应该保存最新值
    outsideEl = document.createElement('button');
    document.body.appendChild(outsideEl);

    saveSpy.mockClear();
    component.onDocumentTouchStart(createPreviewTouchEvent(outsideEl));
    vi.advanceTimersByTime(100);

    expect(saveSpy).toHaveBeenCalledTimes(1);
    expect(saveSpy).toHaveBeenCalledWith({
      sourceId: 'source-task',
      targetId: 'target-task',
      title: '最终标题',
      description: '最终描述',
    });
    expect(modeChangeSpy).toHaveBeenCalledWith('preview');
    expect(component.isEditMode()).toBe(false);
    expect(closeSpy).not.toHaveBeenCalled();
  });

  it('标题和描述重组后即使包含分隔符也应再次保存，不应被旧 payload key 误判去重', () => {
    const fixture = context.getFixture();
    const component = context.getComponent();
    const saveSpy = vi.spyOn(component.save, 'emit');

    const dataSignal = signal<any>({
      sourceId: 'source-task',
      targetId: 'target-task',
      title: '',
      description: '',
      x: 160,
      y: 240,
      isCrossTree: true,
      mode: 'edit',
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

    const titleInput = fixture.nativeElement.querySelector('input') as HTMLInputElement;
    const textarea = fixture.nativeElement.querySelector('textarea') as HTMLTextAreaElement;

    titleInput.value = 'Alpha|Beta';
    textarea.value = 'Gamma';
    component.onTitleChange('Alpha|Beta');
    component.onDescriptionChange('Gamma');

    vi.advanceTimersByTime(600);

    expect(saveSpy).toHaveBeenCalledWith({
      sourceId: 'source-task',
      targetId: 'target-task',
      title: 'Alpha|Beta',
      description: 'Gamma',
    });

    saveSpy.mockClear();

    titleInput.value = 'Alpha';
    textarea.value = 'Beta|Gamma';
    component.onTitleChange('Alpha');
    component.onDescriptionChange('Beta|Gamma');

    outsideEl = document.createElement('button');
    document.body.appendChild(outsideEl);

    component.onDocumentTouchStart(createPreviewTouchEvent(outsideEl));
    vi.advanceTimersByTime(120);

    expect(saveSpy).toHaveBeenCalledTimes(1);
    expect(saveSpy).toHaveBeenCalledWith({
      sourceId: 'source-task',
      targetId: 'target-task',
      title: 'Alpha',
      description: 'Beta|Gamma',
    });
  });
}
