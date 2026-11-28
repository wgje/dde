import { By } from '@angular/platform-browser';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { DockMobileDrawerComponent } from '../features/parking/components/dock-mobile-drawer.component';
import { DemoDockEntryPreviewComponent } from './demo-dock-entry-preview.component';

describe('mobile dock transparent preview', () => {
  afterEach(() => TestBed.resetTestingModule());
  const registerInputs = () => {
    const drawer = (DockMobileDrawerComponent as unknown as {ɵcmp:{inputs:Record<string,unknown>;outputs:Record<string,string>}}).ɵcmp;
    drawer.inputs = {...drawer.inputs}; drawer.outputs = {...drawer.outputs};
    for (const name of ['entries','projects','showTrigger','activeView','focusActive','interactive','readOnly']) drawer.inputs[name]=[name,1,null];
    for (const name of ['taskConfirmed','focusRequested','createRequested','dismissed']) drawer.outputs[name]=name;
    const preview = (DemoDockEntryPreviewComponent as unknown as {ɵcmp:{inputs:Record<string,unknown>}}).ɵcmp;
    preview.inputs = {...preview.inputs,state:['state',1,null]};
  };
  const render = async (state:'mobile-entry'|'mobile-open') => {
    registerInputs();
    await TestBed.configureTestingModule({imports:[DemoDockEntryPreviewComponent]}).compileComponents();
    const fixture=TestBed.createComponent(DemoDockEntryPreviewComponent);fixture.componentRef.setInput('state',state);
    fixture.detectChanges();TestBed.flushEffects();fixture.detectChanges();return fixture;
  };
  it('starts collapsed and opens from its transparent touch target',async()=>{
    const fixture=await render('mobile-entry');
    const drawer=fixture.debugElement.query(By.directive(DockMobileDrawerComponent)).componentInstance as DockMobileDrawerComponent;
    const trigger=fixture.nativeElement.querySelector('[data-testid="dock-v3-mobile-drawer-trigger"]') as HTMLButtonElement;
    expect(drawer.opened()).toBe(false);expect(trigger.textContent).toContain('停泊坞');expect(trigger.textContent).not.toContain('个可行动');
    expect(fixture.nativeElement.querySelector('.trigger-focus.primary')).toBeNull();
    trigger.click();fixture.detectChanges();expect(drawer.opened()).toBe(true);
    expect(fixture.nativeElement.querySelector('[aria-label="当前主任务"]')).not.toBeNull();
    fixture.destroy();TestBed.resetTestingModule();
    const fresh=await render('mobile-entry');expect((fresh.debugElement.query(By.directive(DockMobileDrawerComponent)).componentInstance as DockMobileDrawerComponent).opened()).toBe(false);fresh.destroy();
  });
  it('shows a ready expanded result and explicit preview confirmation',async()=>{
    const fixture=await render('mobile-open');
    expect(fixture.nativeElement.querySelector('[data-testid="dock-v3-mobile-task-drawer"]')).not.toBeNull();
    const rows=fixture.nativeElement.querySelectorAll('[data-testid="dock-v3-mobile-task-row"]');expect(rows.length).toBe(3);
    rows[1].click();fixture.detectChanges();expect(fixture.nativeElement.querySelector('[data-testid="dock-v3-mobile-task-preview"]')?.textContent).toContain('预览不会切换当前任务');
    const before=fixture.componentInstance.taskIds.current;
    expect(fixture.componentInstance.currentTaskId()).toBe(before);
    fixture.nativeElement.querySelector('[data-testid="dock-v3-mobile-preview-promote"]').click();fixture.detectChanges();
    expect(fixture.componentInstance.currentTaskId()).toBe(fixture.componentInstance.taskIds.candidate);
    expect(fixture.componentInstance.entries().filter(entry=>entry.status==='focusing')).toHaveLength(1);
    expect(fixture.nativeElement.querySelector('[data-testid="dock-v3-mobile-task-drawer"]')).toBeNull();fixture.destroy();
  });
});
