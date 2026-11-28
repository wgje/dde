import { By } from '@angular/platform-browser';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DemoTaskPreviewComponent } from './demo-task-preview.component';
import { TextTaskEditorComponent } from '../features/text/components/text-task-editor.component';
import { KnowledgeAnchorComponent } from '../shared/components/knowledge-anchor/knowledge-anchor.component';
import { TextTaskCardComponent } from '../features/text/components/text-task-card.component';
import { DemoTaskPreviewMemory } from './demo-task-preview.providers';
import { TaskOperationAdapterService } from '../../services/task-operation-adapter.service';

describe('DemoTaskPreviewComponent isolated real task cards', () => {
  let fixture: ComponentFixture<DemoTaskPreviewComponent> | undefined;
  afterEach(() => { fixture?.destroy(); fixture = undefined; vi.restoreAllMocks(); TestBed.resetTestingModule(); });
  async function render(state = 'active') {
    // The Vitest JIT transform doesn't extract input()/output() metadata.
    // Register signal bindings here; application AOT extracts the same metadata.
    const bindings: Array<[unknown, string[], string[]]> = [
      [DemoTaskPreviewComponent, ['state'], []],
      [TextTaskCardComponent, ['task', 'isSelected', 'isMobile', 'isDragging', 'userId', 'projectId', 'connections', 'stageNumber'], ['select','addSibling','addChild','deleteTask','parkTask','attachmentError','openLinkedTask','dragStart','dragEnd','dragOver','touchStart','touchMove','touchEnd','touchCancel']],
      [TextTaskEditorComponent, ['task','isMobile','userId','projectId','connections','initialPreview'], ['addSibling','addChild','deleteTask','parkTask','attachmentError','openLinkedTask','previewModeChange']],
      [KnowledgeAnchorComponent, ['taskId','isMobile','editable','manageable','compact','previewMode'], []],
    ];
    for (const [type, inputs, outputs] of bindings) {
      const def = (type as { ɵcmp: { inputs: Record<string, unknown>; outputs: Record<string,string> } }).ɵcmp;
      def.inputs = { ...def.inputs }; def.outputs = { ...def.outputs };
      for (const name of inputs) def.inputs[name] = [name, 1, null];
      for (const name of outputs) def.outputs[name] = name;
    }
    await TestBed.configureTestingModule({ imports: [DemoTaskPreviewComponent] }).compileComponents();
    fixture = TestBed.createComponent(DemoTaskPreviewComponent);
    fixture.componentRef.setInput('state', state);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    return fixture;
  }
  it.each(['active', 'completed', 'archived', 'sidecar'])('renders a real task card for %s with client generated IDs', async state => {
    const view = await render(state);
    expect(view.nativeElement.querySelector('app-text-task-card')).not.toBeNull();
    expect(view.componentInstance.memory.task().id).toMatch(/^[a-f0-9-]{36}$/i);
    expect(view.componentInstance.memory.task().status).toBe(state === 'completed' || state === 'archived' ? state : 'active');
    if (state === 'sidecar') expect(view.nativeElement.querySelector('app-text-task-editor')).not.toBeNull();
  });
  it('keeps title, planner and todo changes only in the component-scoped memory', async () => {
    const read = vi.spyOn(Storage.prototype, 'getItem');
    const write = vi.spyOn(Storage.prototype, 'setItem');
    const remove = vi.spyOn(Storage.prototype, 'removeItem');
    const view = await render('sidecar');
    const card = view.debugElement.children[0].children.find(child => child.componentInstance instanceof TextTaskCardComponent);
    expect(card).toBeDefined();
    const editor = view.debugElement.query(By.directive(TextTaskEditorComponent)).componentInstance as TextTaskEditorComponent;
    expect(editor).toBeDefined();
    editor.onTitleInput('只在预览里修改');
    await view.whenStable();
    view.detectChanges();
    expect(view.componentInstance.memory.task().title).toBe('只在预览里修改');
    await editor.onExpectedMinutesChange('42');
    expect(view.componentInstance.memory.task().expected_minutes).toBe(42);
    expect(read).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });
  it('has no shared task or draft state across preview instances', async () => {
    const first = await render('active');
    const initialId = first.componentInstance.memory.task().id;
    const memory = first.componentInstance.memory;
    await memory.patch(initialId, { title: '不能串到另一个预览' });
    const second = TestBed.createComponent(DemoTaskPreviewComponent);
    second.detectChanges(); await second.whenStable(); second.detectChanges();
    try {
      expect(second.componentInstance.memory).not.toBe(memory);
      expect(second.componentInstance.memory.task().id).not.toBe(initialId);
      expect(second.componentInstance.memory.task().title).toBe('准备一次清楚的演示');
      const scoped = second.debugElement.injector.get(DemoTaskPreviewMemory);
      const adapter = second.debugElement.injector.get(TaskOperationAdapterService);
      await adapter.updateTaskTitle(scoped.task().id, '第二个预览');
      expect(first.componentInstance.memory.task().title).toBe('不能串到另一个预览');
    } finally { second.destroy(); }
  });
  it('completion changes the rendered badge without a root writer', async () => {
    const view = await render();
    view.componentInstance.toggleCompleted(); view.detectChanges();
    expect(view.nativeElement.querySelector('[data-testid="text-task-status-badge"]').textContent).toContain('Completed');
  });
  it('renders the archived badge instead of active', async () => {
    const view = await render('archived');
    expect(view.componentInstance.memory.task().status).toBe('archived');
  });
  it('add sibling and child events create visible real task cards with correct relationships', async () => {
    const view = await render('sidecar');
    const card = view.debugElement.query(By.directive(TextTaskCardComponent)).componentInstance as TextTaskCardComponent;
    card.addSibling.emit(); card.addChild.emit(); view.detectChanges();
    const tasks = view.componentInstance.memory.additionalTasks();
    expect(tasks).toHaveLength(2);
    expect(tasks[0].parentId).toBeNull();
    expect(tasks[1].parentId).toBe(view.componentInstance.memory.task().id);
    expect(tasks[1].stage).toBe(2);
    expect(view.nativeElement.querySelectorAll('app-text-task-card')).toHaveLength(3);
    expect(view.nativeElement.textContent).toContain('新建的子任务');
  });
  it('park event updates the local Dock badge without writing browser storage', async () => {
    const write = vi.spyOn(Storage.prototype, 'setItem');
    const view = await render('sidecar');
    const card = view.debugElement.query(By.directive(TextTaskCardComponent)).componentInstance as TextTaskCardComponent;
    card.parkTask.emit(); view.detectChanges();
    expect(view.componentInstance.memory.dockedTaskIds().has(view.componentInstance.memory.task().id)).toBe(true);
    expect(view.componentInstance.memory.task().parkingMeta?.state).toBe('parked');
    expect(view.nativeElement.textContent).toContain('Docked');
    expect(write).not.toHaveBeenCalled();
  });
  it('expanded sidecar opens the actual editor directly in edit mode', async () => {
    const view = await render('sidecar-expanded');
    const editor = view.debugElement.query(By.directive(TextTaskEditorComponent)).componentInstance as TextTaskEditorComponent;
    expect(editor.isPreview()).toBe(false);
    expect(view.nativeElement.querySelector('[data-testid="task-title-input"]')).not.toBeNull();
    expect(view.nativeElement.textContent).toContain('注意事项');
  });
  it('sidecar summary starts with the real collapsed card badge', async () => {
    const view = await render('sidecar-summary');
    expect(view.nativeElement.querySelector('[data-testid="text-task-sidecar-trigger"]')).not.toBeNull();
    expect(view.nativeElement.querySelector('app-text-task-editor')).toBeNull();
  });});
