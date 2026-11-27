import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';
import { DemoPreviewPanelComponent } from './demo-preview-panel.component';
import { DemoFlowPreviewComponent } from './demo-flow-preview.component';
describe('minimap preview panel', () => {
  it('mounts the production minimap on initial render', async () => {
    vi.spyOn(DemoFlowPreviewComponent.prototype, 'ngAfterViewInit').mockImplementation(() => {});
    await TestBed.configureTestingModule({ imports: [DemoPreviewPanelComponent] }).compileComponents();
    const fixture = TestBed.createComponent(DemoPreviewPanelComponent);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('app-flow-minimap')).not.toBeNull();
    fixture.destroy(); TestBed.resetTestingModule(); vi.restoreAllMocks();
  });
});
