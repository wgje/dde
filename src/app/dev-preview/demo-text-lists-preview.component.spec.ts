import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { afterEach,describe,expect,it,vi } from 'vitest';
import { DemoTextListsPreviewComponent } from './demo-text-lists-preview.component';
import { TextUnassignedComponent } from '../features/text/components/text-unassigned.component';
import { TextUnfinishedComponent } from '../features/text/components/text-unfinished.component';
import { MobileTodoDrawerComponent } from '../features/flow/components/mobile-todo-drawer.component';
describe('real text list preview widgets',()=>{
 afterEach(()=>{TestBed.resetTestingModule();vi.restoreAllMocks();});
 async function render(state:string){
  const bindings:Array<[unknown,string[],string[]]>=[
   [TextUnassignedComponent,['isMobile','draggingTaskId'],['taskClick','createUnassigned','dragStart','dragEnd','touchStart','touchMove','touchEnd','touchCancel','openLinkedTask']],
   [TextUnfinishedComponent,['isMobile'],['jumpToTask']],
   [MobileTodoDrawerComponent,['isDropTargetActive','draggingTaskId','hasActiveDragSession'],['centerOnNode','createUnassigned','taskClick','taskDragStart','taskDrop','taskTouchStart','taskTouchMove','taskTouchEnd','taskTouchCancel','swipeToSwitch']],
  ];for(const[type,inputs,outputs]of bindings){const def=(type as {ɵcmp:{inputs:Record<string,unknown>;outputs:Record<string,string>}}).ɵcmp;def.inputs={...def.inputs};def.outputs={...def.outputs};for(const name of inputs)def.inputs[name]=[name,1,null];for(const name of outputs)def.outputs[name]=name;}
  await TestBed.configureTestingModule({imports:[DemoTextListsPreviewComponent]}).compileComponents();const view=TestBed.createComponent(DemoTextListsPreviewComponent);view.componentRef.setInput('state',state);view.detectChanges();await view.whenStable();view.detectChanges();return view;
 }
 it.each(['unassigned','unassigned-mobile','unassigned-edit','unfinished','unfinished-mobile','delete-single','delete-children','mobile-todo'])('renders actual list/dialog branch %s',async state=>{const view=await render(state);try{expect(view.nativeElement.textContent.length).toBeGreaterThan(10);}finally{view.destroy();}});
 it('real unfinished complete removes an item locally without browser storage',async()=>{const write=vi.spyOn(Storage.prototype,'setItem');const view=await render('unfinished');try{const before=view.componentInstance.memory.task().content;view.nativeElement.querySelector('button[title="点击完成"]').click();view.detectChanges();expect(view.componentInstance.memory.task().content).not.toBe(before);expect(view.componentInstance.memory.task().content).toContain('- [x] 看看');expect(write).not.toHaveBeenCalled();}finally{view.destroy();}});
 it('delete keep-children checkbox and confirmation use real events',async()=>{const view=await render('delete-children');try{const box=view.nativeElement.querySelector('[data-testid="keep-children-checkbox"]');box.dispatchEvent(new Event('change'));view.detectChanges();view.nativeElement.querySelector('[data-testid="confirm-delete-btn"]').click();view.detectChanges();expect(view.nativeElement.textContent).toContain('保留子任务');}finally{view.destroy();}});
 it('real unassigned create event adds visible memory task',async()=>{const view=await render('unassigned');try{const component=view.debugElement.query(By.directive(TextUnassignedComponent)).componentInstance as TextUnassignedComponent;component.createUnassigned.emit();view.detectChanges();expect(view.nativeElement.textContent).toContain('刚创建的待分配任务');}finally{view.destroy();}});
});
