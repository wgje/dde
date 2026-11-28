import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { afterEach, describe, expect, it } from 'vitest';
import { DemoTaskTreePreviewComponent } from './demo-task-tree-preview.component';
import { TextStageCardComponent } from '../features/text/components/text-stage-card.component';
import { TextTaskCardComponent } from '../features/text/components/text-task-card.component';
import { TextTaskEditorComponent } from '../features/text/components/text-task-editor.component';
import { KnowledgeAnchorComponent } from '../shared/components/knowledge-anchor/knowledge-anchor.component';
import { TextTaskConnectionsComponent } from '../features/text/components/text-task-connections.component';
describe('real task stage and connection previews',()=>{
 afterEach(()=>TestBed.resetTestingModule());
 async function render(state:string){
  const bindings:Array<[unknown,string[],string[]]>=[
   [TextStageCardComponent,['stage','isMobile','isExpanded','selectedTaskId','draggingTaskId','isDragOver','dropTargetInfo','userId','projectId'],['toggleExpand','taskSelect','addSibling','addChild','deleteTask','parkTask','attachmentError','openLinkedTask','taskDragStart','taskDragEnd','taskDragOver','taskTouchStart','taskTouchMove','taskTouchEnd','taskTouchCancel','stageDragOver','stageDragLeave','stageDrop']],
   [TextTaskCardComponent,['task','isSelected','isMobile','isDragging','userId','projectId','connections','stageNumber'],['select','addSibling','addChild','deleteTask','parkTask','attachmentError','openLinkedTask','dragStart','dragEnd','dragOver','touchStart','touchMove','touchEnd','touchCancel']],
   [TextTaskEditorComponent,['task','isMobile','userId','projectId','connections','initialPreview'],['addSibling','addChild','deleteTask','parkTask','attachmentError','openLinkedTask','previewModeChange']],
   [KnowledgeAnchorComponent,['taskId','isMobile','editable','manageable','compact','previewMode'],[]],
  ];
  for(const[type,inputs,outputs]of bindings){const def=(type as {ɵcmp:{inputs:Record<string,unknown>;outputs:Record<string,string>}}).ɵcmp;def.inputs={...def.inputs};def.outputs={...def.outputs};for(const name of inputs)def.inputs[name]=[name,1,null];for(const name of outputs)def.outputs[name]=name;}
  await TestBed.configureTestingModule({imports:[DemoTaskTreePreviewComponent]}).compileComponents();const view=TestBed.createComponent(DemoTaskTreePreviewComponent);view.componentRef.setInput('state',state);view.detectChanges();await view.whenStable();view.detectChanges();return view;
 }
 it.each(['expanded','collapsed','mobile'])('renders actual stage component in %s state',async state=>{const view=await render(state);try{expect(view.debugElement.query(By.directive(TextStageCardComponent))).not.toBeNull();expect(view.nativeElement.querySelector('header button').getAttribute('aria-expanded')).toBe(state==='collapsed'?'false':'true');}finally{view.destroy();}});
 it('real stage expand button changes local expansion',async()=>{const view=await render('collapsed');try{view.nativeElement.querySelector('header button').click();view.detectChanges();expect(view.componentInstance.expanded()).toBe(true);}finally{view.destroy();}});
 it('real connection selection shows the selected local task',async()=>{const view=await render('connections');try{const connection=view.debugElement.query(By.directive(TextTaskConnectionsComponent)).componentInstance as TextTaskConnectionsComponent;connection.onOpenTask(view.componentInstance.memory.additionalTasks()[0],new Event('click'));view.detectChanges();expect(view.nativeElement.textContent).toContain('已定位：新建的子任务');}finally{view.destroy();}});
 it.each(['connections-incoming','connections-both','connections-collapsed'])('renders actual connection branch %s',async state=>{const view=await render(state);try{const panel=view.debugElement.query(By.directive(TextTaskConnectionsComponent)).componentInstance as TextTaskConnectionsComponent;expect(panel.connections?.incoming.length).toBe(state==='connections-collapsed'?0:1);if(state==='connections-collapsed')expect(panel.isCollapsed()).toBe(true);}finally{view.destroy();}});
});
