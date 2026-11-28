import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TaskStore } from '../core/state/stores';
import { ProjectStateService } from '../../services/project-state.service';
import { FlowTaskOperationsService } from '../features/flow/services/flow-task-operations.service';
import { TextStagesComponent } from '../features/text/components/text-stages.component';
import { TextStageCardComponent } from '../features/text/components/text-stage-card.component';
import { TextTaskCardComponent } from '../features/text/components/text-task-card.component';
import { TextTaskEditorComponent } from '../features/text/components/text-task-editor.component';
import { TextUnassignedComponent } from '../features/text/components/text-unassigned.component';
import { TextUnfinishedComponent } from '../features/text/components/text-unfinished.component';
import { KnowledgeAnchorComponent } from '../shared/components/knowledge-anchor/knowledge-anchor.component';
import { DemoTaskArchivePreviewComponent } from './demo-task-archive-preview.component';

describe('real task archive cross-view preview', () => {
  const restoreInputs: Array<() => void> = [];
  beforeEach(async () => {
    // Vitest uses Angular JIT: register signal input/output metadata normally emitted by ngc.
    const bindings: Array<[unknown, string[], string[]]> = [
      [TextStageCardComponent, ['stage', 'isMobile', 'isExpanded', 'selectedTaskId', 'draggingTaskId', 'isDragOver', 'dropTargetInfo', 'userId', 'projectId'], ['toggleExpand', 'taskSelect', 'addSibling', 'addChild', 'deleteTask', 'parkTask', 'attachmentError', 'openLinkedTask', 'taskDragStart', 'taskDragEnd', 'taskDragOver', 'taskTouchStart', 'taskTouchMove', 'taskTouchEnd', 'taskTouchCancel', 'stageDragOver', 'stageDragLeave', 'stageDrop']],
      [TextTaskCardComponent, ['task', 'isSelected', 'isMobile', 'isDragging', 'userId', 'projectId', 'connections', 'stageNumber'], ['select', 'addSibling', 'addChild', 'deleteTask', 'parkTask', 'attachmentError', 'openLinkedTask', 'dragStart', 'dragEnd', 'dragOver', 'touchStart', 'touchMove', 'touchEnd', 'touchCancel']],
      [TextTaskEditorComponent, ['task', 'isMobile', 'userId', 'projectId', 'connections', 'initialPreview'], ['addSibling', 'addChild', 'deleteTask', 'parkTask', 'attachmentError', 'openLinkedTask', 'previewModeChange']],
      [KnowledgeAnchorComponent, ['taskId', 'isMobile', 'editable', 'manageable', 'compact', 'previewMode'], []],
    ];
    for (const [component, inputs, outputs] of bindings) {
      const def = (component as { ɵcmp: { inputs: Record<string, unknown>; outputs: Record<string, string> } }).ɵcmp;
      const originalInputs = def.inputs;
      const originalOutputs = def.outputs;
      def.inputs = { ...originalInputs };
      def.outputs = { ...originalOutputs };
      for (const name of inputs) def.inputs[name] = [name, 1, null];
      for (const name of outputs) def.outputs[name] = name;
      restoreInputs.push(() => { def.inputs = originalInputs; def.outputs = originalOutputs; });
    }
    await TestBed.configureTestingModule({ imports: [DemoTaskArchivePreviewComponent] }).compileComponents();
  });
  afterEach(() => {
    TestBed.resetTestingModule();
    restoreInputs.splice(0).reverse().forEach(restore => restore());
    vi.restoreAllMocks();
  });

  async function render(state: string) {
    const view = TestBed.createComponent(DemoTaskArchivePreviewComponent);
    view.componentRef.setInput('previewState', state);
    view.detectChanges();
    await Promise.resolve();
    TestBed.flushEffects();
    await Promise.resolve();
    view.detectChanges();
    return view;
  }

  it.each(['assigned', 'assigned-archived', 'unassigned', 'unassigned-archived'])(
    'mounts real stages, unassigned and unfinished components on the first render of %s', async state => {
      const view = await render(state);
      expect(view.debugElement.query(By.directive(TextStagesComponent))).not.toBeNull();
      expect(view.debugElement.query(By.directive(TextUnassignedComponent))).not.toBeNull();
      expect(view.debugElement.query(By.directive(TextUnfinishedComponent))).not.toBeNull();
      expect(view.componentInstance.state).toBeInstanceOf(ProjectStateService);
      expect(view.debugElement.injector.get(FlowTaskOperationsService)).toBeInstanceOf(FlowTaskOperationsService);
      const id = view.componentInstance.task()!.id;
      const card = view.nativeElement.querySelector(`[data-task-id="${id}"], [data-unassigned-task="${id}"]`);
      expect(Boolean(card)).toBe(!state.endsWith('-archived'));
      if (state === 'assigned') {
        const stageCard = view.debugElement.query(By.directive(TextStageCardComponent));
        expect(stageCard.nativeElement.querySelector('header button').getAttribute('aria-expanded')).toBe('true');
      }
      expect(view.componentInstance.state.taskTodoStats().pending).toBe(state.endsWith('-archived') ? 0 : 1);
      view.destroy();
    },
  );

  it.each(['assigned', 'unassigned'])('archives and unarchives %s using the real Flow action and Text DOM', async state => {
    const storageWrite = vi.spyOn(Storage.prototype, 'setItem');
    const view = await render(state);
    const original = view.componentInstance.task()!;
    const flow = view.debugElement.injector.get(FlowTaskOperationsService);
    const archiveAction = vi.spyOn(flow, 'archiveTask');
    const card = () => view.nativeElement.querySelector(`[data-task-id="${original.id}"], [data-unassigned-task="${original.id}"]`);
    const button = view.nativeElement.querySelector('[data-testid="preview-archive-task"]') as HTMLButtonElement;
    expect(card()).not.toBeNull();
    button.click();
    await Promise.resolve();
    TestBed.flushEffects();
    await Promise.resolve();
    view.detectChanges();
    expect(archiveAction).toHaveBeenCalledWith(original);
    expect(view.componentInstance.task()?.status).toBe('archived');
    expect(card()).toBeNull();
    expect(view.nativeElement.textContent).not.toContain('归档后不再计入未完成事项');
    expect(view.componentInstance.state.allStage1Tasks()).toEqual([]);
    expect(view.componentInstance.state.taskTodoStats().pending).toBe(0);
    button.click();
    await Promise.resolve();
    TestBed.flushEffects();
    await Promise.resolve();
    view.detectChanges();
    expect(view.componentInstance.task()).toEqual(original);
    expect(card()).not.toBeNull();
    expect(view.componentInstance.state.taskTodoStats().pending).toBe(1);
    expect(storageWrite).not.toHaveBeenCalled();
    view.destroy();
  });

  it('seeds result URLs without invoking archive, and each new visit owns fresh stores and IDs', async () => {
    const archiveAction = vi.spyOn(FlowTaskOperationsService.prototype, 'archiveTask');
    const result = await render('assigned-archived');
    const firstId = result.componentInstance.task()!.id;
    const firstStore = result.debugElement.injector.get(TaskStore);
    expect(result.componentInstance.task()?.status).toBe('archived');
    expect(archiveAction).not.toHaveBeenCalled();
    const baseline = await render('assigned');
    expect(baseline.debugElement.injector.get(TaskStore)).not.toBe(firstStore);
    expect(baseline.componentInstance.task()!.id).not.toBe(firstId);
    expect(baseline.componentInstance.task()?.status).toBe('active');
    result.destroy();
    baseline.destroy();
  });
});