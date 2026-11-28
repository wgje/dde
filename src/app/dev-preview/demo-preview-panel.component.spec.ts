import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { describe, expect, it, vi } from 'vitest';
import { DemoPreviewPanelComponent } from './demo-preview-panel.component';
import { DemoFlowPreviewComponent } from './demo-flow-preview.component';
import { FlowMinimapComponent } from '../features/flow/components/flow-minimap.component';
describe('minimap preview panel', () => {
  it('mounts the production minimap on initial render', async () => {
    vi.spyOn(DemoFlowPreviewComponent.prototype, 'ngAfterViewInit').mockImplementation(() => {});
    await TestBed.configureTestingModule({ imports: [DemoFlowPreviewComponent] }).compileComponents();
    const fixture = TestBed.createComponent(DemoFlowPreviewComponent);
    fixture.componentRef.setInput('state', 'overview-dense');
    fixture.detectChanges();
    expect(fixture.debugElement.query(By.directive(FlowMinimapComponent))).not.toBeNull();
    fixture.destroy(); TestBed.resetTestingModule(); vi.restoreAllMocks();
  });
});
