import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { WorkspaceSidebarComponent } from './workspace-sidebar.component';

describe('WorkspaceSidebarComponent', () => {
  @Component({
    standalone: true,
    imports: [WorkspaceSidebarComponent],
    template: '<app-workspace-sidebar><span data-testid="slot">sidebar</span></app-workspace-sidebar>',
  })
  class HostComponent {}

  it('renders projected sidebar content on the directive host', () => {
    TestBed.configureTestingModule({
      imports: [HostComponent],
    });
    const fixture = TestBed.createComponent(HostComponent);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('[data-testid="slot"]')?.textContent).toBe('sidebar');
    expect(fixture.nativeElement.querySelector('app-workspace-sidebar')?.style.display).toBe('contents');
  });

  it('keeps the slot as a directive instead of a projection component', () => {
    const source = readFileSync(join(__dirname, 'workspace-sidebar.component.ts'), 'utf8');

    expect(source).toContain('Directive');
    expect(source).not.toContain("template: '<ng-content></ng-content>'");
  });
});
