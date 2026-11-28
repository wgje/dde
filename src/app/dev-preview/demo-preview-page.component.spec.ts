import {TestBed} from '@angular/core/testing';
import {describe,expect,it} from 'vitest';
import {DemoPreviewPageComponent} from './demo-preview-page.component';
import {DemoDockEntryPreviewComponent} from './demo-dock-entry-preview.component';

describe('development preview route readiness',()=>{
  it.each(['mobile-entry','mobile-open'] as const)('mounts the real Parking Dock fixture for %s on first render',async state=>{
    const page=(DemoPreviewPageComponent as unknown as {ɵcmp:{inputs:Record<string,unknown>}}).ɵcmp;
    page.inputs={...page.inputs,widget:['widget',1,null],state:['state',1,null]};
    const preview=(DemoDockEntryPreviewComponent as unknown as {ɵcmp:{inputs:Record<string,unknown>}}).ɵcmp;
    preview.inputs={...preview.inputs,state:['state',1,null]};
    await TestBed.configureTestingModule({imports:[DemoPreviewPageComponent]}).compileComponents();
    const fixture=TestBed.createComponent(DemoPreviewPageComponent);
    fixture.componentRef.setInput('widget','dock');fixture.componentRef.setInput('state',state);
    fixture.detectChanges();TestBed.flushEffects();fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-testid="dev-preview-page"] h1').textContent).toContain('手机停泊坞');
    expect(fixture.nativeElement.querySelector('app-demo-dock-entry-preview')).not.toBeNull();
    expect(fixture.nativeElement.textContent).toContain('虚拟数据');
    fixture.destroy();TestBed.resetTestingModule();
  });
});
