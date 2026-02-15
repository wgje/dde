import { TestBed } from '@angular/core/testing';
import { WorkspaceSidebarComponent } from './workspace-sidebar.component';

describe('WorkspaceSidebarComponent', () => {
  it('should create', () => {
    TestBed.configureTestingModule({
      imports: [WorkspaceSidebarComponent],
    });
    const fixture = TestBed.createComponent(WorkspaceSidebarComponent);
    expect(fixture.componentInstance).toBeTruthy();
  });
});
