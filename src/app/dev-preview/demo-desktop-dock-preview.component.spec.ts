import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DemoDesktopDockPreviewComponent } from './demo-desktop-dock-preview.component';
import { KnowledgeAnchorComponent } from '../shared/components/knowledge-anchor/knowledge-anchor.component';
import { DockConsoleStackComponent } from '../features/parking/components/dock-console-stack.component';
import { DockRadarZoneComponent } from '../features/parking/components/dock-radar-zone.component';
import { DockPlannerQuickEditPanelComponent } from '../features/parking/components/dock-planner-quick-edit-panel.component';
describe('desktop Dock real component memory preview',()=>{
  afterEach(()=>{TestBed.resetTestingModule();vi.restoreAllMocks();});
  async function render(state='console'){
    const definition = (KnowledgeAnchorComponent as unknown as { ɵcmp: { inputs: Record<string, unknown> } }).ɵcmp;
    definition.inputs = { ...definition.inputs };
    for (const name of ['taskId','isMobile','editable','compact','manageable','previewMode']) definition.inputs[name] = [name,1,null];
    await TestBed.configureTestingModule({imports:[DemoDesktopDockPreviewComponent]}).compileComponents();
    const view=TestBed.createComponent(DemoDesktopDockPreviewComponent);view.componentRef.setInput('state',state);view.detectChanges();await view.whenStable();view.detectChanges();return view;
  }
  it.each(['console','main','backup','waiting','planner','planner-complete','low-load','no-detail','wait-presets','radar-preview','radar-panorama','radar-overflow','radar-groups'])('renders real desktop components for %s',async state=>{
    const view=await render(state);try{
      expect(view.debugElement.query(By.directive(DockConsoleStackComponent))).not.toBeNull();
      expect(view.debugElement.query(By.directive(DockRadarZoneComponent))).not.toBeNull();
      if(state==='planner' || state==='planner-complete') expect(view.debugElement.query(By.directive(DockPlannerQuickEditPanelComponent))).not.toBeNull();
    }finally{view.destroy();}
  });
  it('real console complete/wait/load callbacks update local entries without browser storage',async()=>{
    const write=vi.spyOn(Storage.prototype,'setItem');const view=await render();try{
      const console=view.debugElement.query(By.directive(DockConsoleStackComponent)).componentInstance as DockConsoleStackComponent;
      const memory=view.componentInstance.memory;const first=memory.entries()[0].taskId;
      console.setLoad(first,'low');expect(memory.entries()[0].load).toBe('low');
      console.onWait(first,10);expect(memory.entries().find(entry=>entry.taskId===first)?.status).toBe('suspended_waiting');
      expect(write).not.toHaveBeenCalled();
    }finally{view.destroy();}
  });
  it('real planner presets persist only to scoped entry fields',async()=>{
    const write=vi.spyOn(Storage.prototype,'setItem');const view=await render('planner');try{
      const id=view.componentInstance.memory.entries()[0].taskId;
      view.nativeElement.querySelector('[data-testid="dock-v3-planner-expected"]').click();view.detectChanges();
      expect(view.componentInstance.memory.entries().find(entry=>entry.taskId===id)?.expectedMinutes).toBe(15);
      expect(write).not.toHaveBeenCalled();
    }finally{view.destroy();}
  });
  it('real complete callback removes the task and promotes the next local card',async()=>{
    const view=await render();try{
      const console=view.debugElement.query(By.directive(DockConsoleStackComponent)).componentInstance as DockConsoleStackComponent;
      const first=view.componentInstance.memory.entries()[0].taskId;
      console.onComplete(first);
      expect(view.componentInstance.memory.entries().some(entry=>entry.taskId===first)).toBe(false);
      expect(view.componentInstance.memory.focusingEntry()).not.toBeNull();
    }finally{view.destroy();}
  });
  it('radar preview edits and promotion callbacks update local entries',async()=>{
    const view=await render();try{
      const radar=view.debugElement.query(By.directive(DockRadarZoneComponent)).componentInstance as DockRadarZoneComponent;
      const memory=view.componentInstance.memory;const id=memory.backupEntries()[0].taskId;
      radar.openTaskPreview(id);radar.togglePreviewLoad();
      expect(memory.entries().find(entry=>entry.taskId===id)?.load).toBe('high');
      const input=document.createElement('input');input.value='42';
      const event=new Event('change');Object.defineProperty(event,'target',{value:input});
      radar.commitPreviewMinutes('expected',event);await view.whenStable();
      expect(memory.entries().find(entry=>entry.taskId===id)?.expectedMinutes).toBe(42);
      // Finish the same local callback used after the radar's visual animation.
      memory.insertToConsoleFromRadar(id);
      expect(memory.consoleVisibleEntries().some(entry=>entry.taskId===id)).toBe(true);
    }finally{view.destroy();}
  });
  it('two desktop previews never share their in-memory engine',async()=>{
    const first=await render();const second=TestBed.createComponent(DemoDesktopDockPreviewComponent);
    second.detectChanges();await second.whenStable();second.detectChanges();try{
      const id=first.componentInstance.memory.entries()[0].taskId;
      first.componentInstance.memory.completeTask(id);
      expect(second.componentInstance.memory.entries()).toHaveLength(5);
      expect(second.componentInstance.memory.entries().some(entry=>entry.taskId===id)).toBe(false);
    }finally{first.destroy();second.destroy();}
  });
});
