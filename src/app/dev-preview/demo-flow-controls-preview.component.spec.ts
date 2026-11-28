import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { By } from '@angular/platform-browser';
import { DemoFlowControlsPreviewComponent } from './demo-flow-controls-preview.component';
import { FlowCascadeAssignDialogComponent } from '../features/flow/components/flow-cascade-assign-dialog.component';
import { FlowBatchDeleteDialogComponent } from '../features/flow/components/flow-batch-delete-dialog.component';
import { FlowDeleteConfirmComponent } from '../features/flow/components/flow-delete-confirm.component';
import { FlowLinkTypeDialogComponent } from '../features/flow/components/flow-link-type-dialog.component';
import { FlowLinkActionMenuComponent } from '../features/flow/components/flow-link-action-menu.component';
import { FlowLinkDeleteHintComponent } from '../features/flow/components/flow-link-delete-hint.component';
import { FlowConnectionEditorComponent } from '../features/flow/components/flow-connection-editor.component';
import { FlowToolbarComponent } from '../features/flow/components/flow-toolbar.component';

describe('DemoFlowControlsPreviewComponent real safe controls', () => {
  afterEach(() => { vi.restoreAllMocks(); TestBed.resetTestingModule(); });
  async function render(state: string) {
    const bindings: Array<[unknown, string[], string[]]> = [
      [FlowCascadeAssignDialogComponent, ['data'], ['confirm','cancel']],
      [FlowBatchDeleteDialogComponent, ['data','isMobile'], ['confirm','cancel']],
      [FlowDeleteConfirmComponent, ['task','keepChildren','hasChildren','isMobile'], ['cancel','confirm','keepChildrenChange']],
      [FlowLinkTypeDialogComponent, ['data'], ['cancel','parentChildLink','crossTreeLink']],
      [FlowLinkActionMenuComponent, ['menu'], ['edit','view','deleteLink','cancel']],
      [FlowLinkDeleteHintComponent, ['hint'], ['confirm','cancel']],
      [FlowConnectionEditorComponent, ['data','position','readOnly','connectionTasks'], ['close','save','modeChange','delete','positionChange','dragStart','openTask']],
      [FlowToolbarComponent, ['isLinkMode','isPaletteOpen','linkSourceTask','isResizingDrawer','drawerHeightVh','isSelectMode','relationDisplayMode','saveToCloudCallback'], ['zoomIn','zoomOut','autoLayout','toggleLinkMode','cancelLinkMode','toggleSidebar','goBackToText','exportPng','exportSvg','exportStrategicReview','saveToCloud','toggleSelectMode','toggleRelationDisplayMode']],
    ];
    for (const [type, inputs, outputs] of bindings) {
      const def = (type as { ɵcmp: { inputs: Record<string,unknown>; outputs: Record<string,string> } }).ɵcmp;
      def.inputs = { ...def.inputs }; def.outputs = { ...def.outputs };
      for (const name of inputs) def.inputs[name] = [name, 1, null];
      for (const name of outputs) def.outputs[name] = name;
    }
    await TestBed.configureTestingModule({ imports: [DemoFlowControlsPreviewComponent] }).compileComponents();
    const fixture = TestBed.createComponent(DemoFlowControlsPreviewComponent);
    fixture.componentRef.setInput('state', state);
    fixture.detectChanges(); await fixture.whenStable(); fixture.detectChanges();
    return fixture;
  }
  it.each(['batch-toolbar','batch-toolbar-mobile','batch-delete','cascade-assign','delete-confirm','link-type','link-action','link-action-parent','link-delete-hint','connection-preview','connection-edit','connection-parent','toolbar','toolbar-mobile','toolbar-link'])('mounts actual control %s without external state', async state => {
    const read = vi.spyOn(Storage.prototype, 'getItem'); const write = vi.spyOn(Storage.prototype, 'setItem');
    const fixture = await render(state);
    expect(fixture.nativeElement.querySelector('.control-preview').children.length).toBeGreaterThan(0);
    expect(read).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled();
    fixture.destroy();
  });
  it('clears a virtual multiple selection with the real toolbar button', async () => {
    const fixture = await render('batch-toolbar');
    const button = Array.from(fixture.nativeElement.querySelectorAll('button')).find(button => (button as HTMLElement).textContent?.includes('取消选择')) as HTMLButtonElement;
    button.click(); fixture.detectChanges();
    expect(fixture.componentInstance.memory.selectionCount()).toBe(0);
    fixture.destroy();
  });
  it('keeps connection edits in memory and initializes another preview freshly', async () => {
    const fixture = await render('connection-edit');
    const editor = fixture.debugElement.query(By.directive(FlowConnectionEditorComponent)).componentInstance as FlowConnectionEditorComponent;
    editor.save.emit({sourceId:fixture.componentInstance.source.id,targetId:fixture.componentInstance.target.id,title:'新标题',description:'新说明'});
    fixture.detectChanges();
    expect(fixture.componentInstance.connection().title).toBe('新标题');
    const next = TestBed.createComponent(DemoFlowControlsPreviewComponent);
    expect(next.componentInstance.connection().title).not.toBe('新标题');
    fixture.destroy(); next.destroy();
  });
});