import { TestBed } from '@angular/core/testing';
import { WorkspaceShellCoreComponent } from './workspace-shell-core.component';

describe('WorkspaceShellCoreComponent', () => {
  it('should create', () => {
    TestBed.configureTestingModule({
      imports: [WorkspaceShellCoreComponent],
    });
    const fixture = TestBed.createComponent(WorkspaceShellCoreComponent);
    expect(fixture.componentInstance).toBeTruthy();
  });
});
