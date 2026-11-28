import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DemoFlowDetailPreviewComponent } from './demo-flow-detail-preview.component';
import { FlowTaskDetailComponent } from '../features/flow/components/flow-task-detail.component';
import { KnowledgeAnchorComponent } from '../shared/components/knowledge-anchor/knowledge-anchor.component';

async function render(state = 'detail') {
  // Match AOT signal metadata while keeping the actual host/template bindings.
  const bindings: Array<[unknown, string[], string[]]> = [
    [FlowTaskDetailComponent, ['task','position','drawerHeight','autoHeightEnabled','layoutTick'],
      ['positionChange','drawerHeightChange','isResizingChange','titleChange','contentChange','attentionChange','addSibling','addChild','toggleStatus','archiveTask','deleteTask','parkTask','openLinkedTask','quickTodoAdd','attachmentAdd','attachmentRemove','attachmentsChange','attachmentError']],
    [KnowledgeAnchorComponent, ['taskId','isMobile','editable','manageable','compact','previewMode'], []],
  ];
  for (const [type, inputs, outputs] of bindings) {
    const def = (type as { ɵcmp: {inputs:Record<string,unknown>;outputs:Record<string,string>} }).ɵcmp;
    def.inputs = {...def.inputs}; def.outputs = {...def.outputs};
    for (const name of inputs) def.inputs[name] = [name, 1, null];
    for (const name of outputs) def.outputs[name] = name;
  }
  await TestBed.configureTestingModule({imports:[DemoFlowDetailPreviewComponent]}).compileComponents();
  const fixture = TestBed.createComponent(DemoFlowDetailPreviewComponent);
  fixture.componentRef.setInput('state',state);
  fixture.detectChanges(); await fixture.whenStable(); fixture.detectChanges();
  return fixture;
}

describe('real Flow detail memory preview', () => {
  let fixture: ComponentFixture<DemoFlowDetailPreviewComponent> | undefined;
  afterEach(() => {fixture?.destroy(); fixture=undefined; vi.restoreAllMocks(); TestBed.resetTestingModule();});
  it('renders the actual task via real signal input bindings', async () => {
    fixture = await render();
    const detail=fixture.debugElement.query(By.directive(FlowTaskDetailComponent)).componentInstance as FlowTaskDetailComponent;
    expect(detail.task()).toBe(fixture.componentInstance.memory.task());
    expect(fixture.nativeElement.textContent).toContain('准备一次清楚的演示');
    expect(fixture.nativeElement.textContent).toContain('任务详情');
    expect(await detail.onExpectedMinutesChange(fixture.componentInstance.memory.task().id, '45')).toBe(true);
    expect(fixture.componentInstance.memory.task().expected_minutes).toBe(45);
  });
  it('real completion button matches the completed-result fixture without network/storage', async () => {
    fixture = await render();
    const write=vi.spyOn(Storage.prototype,'setItem'); const network=vi.spyOn(globalThis,'fetch');
    const button=Array.from(fixture.nativeElement.querySelectorAll('button') as NodeListOf<HTMLButtonElement>).find(b=>b.textContent?.trim()==='完成');
    expect(button).toBeTruthy(); button!.click();
    await fixture.whenStable(); fixture.detectChanges();
    expect(fixture.componentInstance.memory.task().status).toBe('completed');
    expect(write).not.toHaveBeenCalled(); expect(network).not.toHaveBeenCalled();
  });
  it('starts the completed result without executing completion', async () => {
    fixture = await render('detail-completed');
    expect(fixture.componentInstance.memory.task().status).toBe('completed');
    expect(fixture.nativeElement.textContent).toContain('撤销');
  });
  it('real attention output persists edited notes in the isolated task', async () => {
    fixture = await render();
    const detail=fixture.debugElement.query(By.directive(FlowTaskDetailComponent)).componentInstance as FlowTaskDetailComponent;
    detail.attentionChange.emit({taskId: fixture.componentInstance.memory.task().id,items:[{text:'已修改的注意事项',level:'warning'}]});
    await fixture.whenStable(); fixture.detectChanges();
    expect(fixture.componentInstance.memory.task().attentionMeta?.items[0].text).toBe('已修改的注意事项');
  });
});