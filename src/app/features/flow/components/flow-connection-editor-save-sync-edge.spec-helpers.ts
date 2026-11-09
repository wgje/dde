import { signal } from '@angular/core';
import type { ComponentFixture } from '@angular/core/testing';
import { expect, it, vi } from 'vitest';

import type { Task } from '../../../../models';
import { FlowConnectionEditorComponent } from './flow-connection-editor.component';

interface FlowConnectionEditorSaveSyncSpecContext {
  getFixture: () => ComponentFixture<FlowConnectionEditorComponent>;
  getComponent: () => FlowConnectionEditorComponent;
}

interface FlowConnectionEditorSaveSyncEdgeSpecHelpers {
  createTask: (overrides?: Partial<Task>) => Task;
  createPreviewTouchEvent: (target: EventTarget) => TouchEvent;
  setOutsideEl: (outsideEl: HTMLButtonElement | null) => void;
}

export function registerFlowConnectionEditorSaveSyncEdgeSpecs(
  context: FlowConnectionEditorSaveSyncSpecContext,
  helpers: FlowConnectionEditorSaveSyncEdgeSpecHelpers,
): void {
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
      source: helpers.createTask({ id: 'source-task', displayId: 'A' }),
      target: helpers.createTask({ id: 'target-task', displayId: 'B' }),
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

  it('父层在组合输入期间清空数据时应保留真实输入 DOM 到 compositionend', () => {
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
      source: helpers.createTask({ id: 'source-task', displayId: 'A' }),
      target: helpers.createTask({ id: 'target-task', displayId: 'B' }),
    });
    (component as any).data = dataSignal;

    fixture.detectChanges();
    vi.advanceTimersByTime(60);
    fixture.detectChanges();

    const titleInput = fixture.nativeElement.querySelector('input') as HTMLInputElement;
    const textarea = fixture.nativeElement.querySelector('textarea') as HTMLTextAreaElement;
    textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    titleInput.value = '最终标题';
    textarea.value = '未 commit 描述';

    dataSignal.set(null);
    fixture.detectChanges();

    expect(saveSpy).not.toHaveBeenCalled();
    expect(fixture.nativeElement.contains(textarea)).toBe(true);

    textarea.value = '父层关闭前已 commit 的最终描述';
    textarea.dispatchEvent(new CompositionEvent('compositionend', {
      bubbles: true,
      data: '父层关闭前已 commit 的最终描述',
    }));
    fixture.detectChanges();

    expect(saveSpy).toHaveBeenCalledTimes(1);
    expect(saveSpy).toHaveBeenCalledWith({
      sourceId: 'source-task',
      targetId: 'target-task',
      title: '最终标题',
      description: '父层关闭前已 commit 的最终描述',
    });
    expect(fixture.nativeElement.contains(textarea)).toBe(false);
  });

  it('父层清空数据后 compositionend 缺失时应有界保存可见草稿并移除 DOM', () => {
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
      source: helpers.createTask({ id: 'source-task', displayId: 'A' }),
      target: helpers.createTask({ id: 'target-task', displayId: 'B' }),
    });
    (component as any).data = dataSignal;

    fixture.detectChanges();
    vi.advanceTimersByTime(60);
    fixture.detectChanges();

    const titleInput = fixture.nativeElement.querySelector('input') as HTMLInputElement;
    const textarea = fixture.nativeElement.querySelector('textarea') as HTMLTextAreaElement;
    textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    titleInput.value = 'fallback 标题';
    textarea.value = 'fallback 可见草稿';

    dataSignal.set(null);
    fixture.detectChanges();

    expect(fixture.nativeElement.contains(textarea)).toBe(true);
    expect(saveSpy).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1000);
    fixture.detectChanges();

    expect(saveSpy).toHaveBeenCalledTimes(1);
    expect(saveSpy).toHaveBeenCalledWith({
      sourceId: 'source-task',
      targetId: 'target-task',
      title: 'fallback 标题',
      description: 'fallback 可见草稿',
    });
    expect(fixture.nativeElement.contains(textarea)).toBe(false);
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
      source: helpers.createTask({ id: 'source-task', displayId: 'A' }),
      target: helpers.createTask({ id: 'target-task', displayId: 'B' }),
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
    const outsideEl = document.createElement('button');
    helpers.setOutsideEl(outsideEl);
    document.body.appendChild(outsideEl);

    saveSpy.mockClear();
    component.onDocumentTouchStart(helpers.createPreviewTouchEvent(outsideEl));
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
      source: helpers.createTask({ id: 'source-task', displayId: 'A' }),
      target: helpers.createTask({ id: 'target-task', displayId: 'B' }),
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

    const outsideEl = document.createElement('button');
    helpers.setOutsideEl(outsideEl);
    document.body.appendChild(outsideEl);

    component.onDocumentTouchStart(helpers.createPreviewTouchEvent(outsideEl));
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
