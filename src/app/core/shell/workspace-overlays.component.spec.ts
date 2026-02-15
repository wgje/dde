import { TestBed } from '@angular/core/testing';
import { WorkspaceOverlaysComponent } from './workspace-overlays.component';

describe('WorkspaceOverlaysComponent', () => {
  it('should create', () => {
    TestBed.configureTestingModule({
      imports: [WorkspaceOverlaysComponent],
    });
    const fixture = TestBed.createComponent(WorkspaceOverlaysComponent);
    expect(fixture.componentInstance).toBeTruthy();
  });
});
