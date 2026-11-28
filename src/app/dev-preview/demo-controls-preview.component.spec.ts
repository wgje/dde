import { TestBed } from '@angular/core/testing';
import { afterEach,describe,expect,it,vi } from 'vitest';
import { DemoControlsPreviewComponent } from './demo-controls-preview.component';
import { DeleteConfirmModalComponent } from '../shared/modals/delete-confirm-modal.component';
describe('shared real controls preview',()=>{
 afterEach(()=>{TestBed.resetTestingModule();vi.restoreAllMocks();});
 async function render(state:string){
  const def=(DeleteConfirmModalComponent as unknown as {ɵcmp:{inputs:Record<string,unknown>}}).ɵcmp;def.inputs={...def.inputs};
  for(const name of ['title','message','itemName','warning'])def.inputs[name]=[name,1,null];
  await TestBed.configureTestingModule({imports:[DemoControlsPreviewComponent]}).compileComponents();
  const view=TestBed.createComponent(DemoControlsPreviewComponent);view.componentRef.setInput('state',state);view.detectChanges();await view.whenStable();view.detectChanges();return view;
 }
 it('creates a virtual project using actual form submit and no storage write',async()=>{const write=vi.spyOn(Storage.prototype,'setItem');const view=await render('project-create');try{expect(view.nativeElement.querySelector('[data-testid="project-name-input"]').value).toBe('今天的演示项目');view.nativeElement.querySelector('form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));view.detectChanges();expect(view.nativeElement.textContent).toContain('已创建虚拟项目：今天的演示项目');expect(write).not.toHaveBeenCalled();}finally{view.destroy();}});
 it('renders real delete confirmation and only changes preview result',async()=>{const write=vi.spyOn(Storage.prototype,'setItem');const view=await render('delete-confirm');try{const buttons=[...view.nativeElement.querySelectorAll('button')] as HTMLButtonElement[];buttons.find(button=>button.textContent?.includes('删除'))!.click();view.detectChanges();expect(view.nativeElement.textContent).toContain('虚拟任务已删除');expect(write).not.toHaveBeenCalled();}finally{view.destroy();}});
 it('closes real config help with its original close button',async()=>{const view=await render('config-help');try{expect(view.nativeElement.textContent).toContain('Supabase 配置指南');view.nativeElement.querySelector('button').click();view.detectChanges();expect(view.nativeElement.textContent).toContain('配置说明已关闭');}finally{view.destroy();}});
 it('real gate action marks a virtual entry without storage or recording',async()=>{const write=vi.spyOn(Storage.prototype,'setItem');const view=await render('gate-actions');try{view.nativeElement.querySelector('[data-testid="gate-read-button"]').click();view.detectChanges();expect(view.nativeElement.textContent).toContain('已标记已读');view.nativeElement.querySelector('[data-testid="gate-complete-button"]').click();view.detectChanges();expect(view.nativeElement.textContent).toContain('已标记完成');expect(write).not.toHaveBeenCalled();}finally{view.destroy();}});});
