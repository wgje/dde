import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FlowConnectionEditorComponent } from './flow-connection-editor.component';
import { LoggerService } from '../../../../services/logger.service';
import type { Task } from '../../../../models';

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

  it('跨树关联首次打开应进入预览态', () => {
    (component as any).position = signal({ x: 160, y: 240 });
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

  it('编辑态触摸编辑器外部时应自动保存并关闭编辑器', () => {
    const saveSpy = vi.spyOn(component.save, 'emit');
    const closeSpy = vi.spyOn(component.close, 'emit');

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
    component.onDocumentTouchStart({ target: outsideEl } as TouchEvent);
    // 推进定时器以触发延迟保存
    vi.advanceTimersByTime(100);

    expect(saveSpy).toHaveBeenCalledTimes(1);
    expect(saveSpy).toHaveBeenCalledWith({
      sourceId: 'source-task',
      targetId: 'target-task',
      title: '依赖',
      description: '新描述',
    });
    // 触摸外部应保存并关闭编辑器
    expect(closeSpy).toHaveBeenCalledTimes(1);
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

  it('同会话 data 更新后立即触摸外部也应退出编辑并保存（不应被保护窗口误拦截）', () => {
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

    // 同一关联块会话内的父层更新（不应重置外部点击保护窗口）
    dataSignal.set({
      ...dataSignal(),
      title: '旧标题',
      description: '旧描述',
      mode: 'edit',
    });
    fixture.detectChanges();

    outsideEl = document.createElement('button');
    document.body.appendChild(outsideEl);

    component.onDocumentTouchStart({ target: outsideEl } as TouchEvent);
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

    // 父层强制切到预览，服务层值尚未回流时仍应保存最新输入
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

    // 背景点击先由父层把 mode 切到 preview
    dataSignal.set({
      ...dataSignal(),
      mode: 'preview',
      title: '旧标题',
      description: '旧描述',
    });
    fixture.detectChanges();

    // 同一外部点击继续冒泡到 document:click，不应立即关闭浮层
    outsideEl = document.createElement('button');
    document.body.appendChild(outsideEl);
    component.onDocumentClick({ target: outsideEl } as MouseEvent);

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

  it('触摸编辑器外部时应优先保存输入框中的最新 DOM 值并关闭编辑器', () => {
    const saveSpy = vi.spyOn(component.save, 'emit');
    const closeSpy = vi.spyOn(component.close, 'emit');

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

    component.onDocumentTouchStart({ target: outsideEl } as TouchEvent);
    // 推进定时器以触发延迟保存
    vi.advanceTimersByTime(100);

    expect(saveSpy).toHaveBeenCalledTimes(1);
    expect(saveSpy).toHaveBeenCalledWith({
      sourceId: 'source-task',
      targetId: 'target-task',
      title: 'DOM 最新标题',
      description: 'DOM 最新描述',
    });
    // 触摸外部应保存并关闭编辑器
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it('输入法组合输入期间触摸编辑器外部时也应保存最后可见文本并关闭', () => {
    const saveSpy = vi.spyOn(component.save, 'emit');
    const closeSpy = vi.spyOn(component.close, 'emit');

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

    component.onDocumentTouchStart({ target: outsideEl } as TouchEvent);
    // IME 输入中需要更长延迟：touchstart 延迟 100ms + saveAndClose 延迟 100ms = 200ms
    vi.advanceTimersByTime(250);

    expect(saveSpy).toHaveBeenCalledTimes(1);
    expect(saveSpy).toHaveBeenCalledWith({
      sourceId: 'source-task',
      targetId: 'target-task',
      title: '依赖',
      description: '中文输入中的最新值',
    });
    // IME 输入中触摸外部也应关闭编辑器
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it('父层直接清空编辑器数据时也应保存最新 DOM 值', () => {
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

  it('服务层回流更新后用户继续编辑再触摸外部仍应保存最新内容', () => {
    const saveSpy = vi.spyOn(component.save, 'emit');
    const closeSpy = vi.spyOn(component.close, 'emit');

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
    component.onDocumentTouchStart({ target: outsideEl } as TouchEvent);
    vi.advanceTimersByTime(100);

    expect(saveSpy).toHaveBeenCalledTimes(1);
    expect(saveSpy).toHaveBeenCalledWith({
      sourceId: 'source-task',
      targetId: 'target-task',
      title: '最终标题',
      description: '最终描述',
    });
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });
});
