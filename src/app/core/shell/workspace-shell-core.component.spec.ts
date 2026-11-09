import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { WorkspaceShellCoreComponent } from './workspace-shell-core.component';

describe('WorkspaceShellCoreComponent', () => {
  @Component({
    standalone: true,
    imports: [WorkspaceShellCoreComponent],
    template: '<app-workspace-shell-core><span data-testid="slot">core</span></app-workspace-shell-core>',
  })
  class HostComponent {}

  it('renders projected shell content on the directive host', () => {
    TestBed.configureTestingModule({
      imports: [HostComponent],
    });
    const fixture = TestBed.createComponent(HostComponent);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('[data-testid="slot"]')?.textContent).toBe('core');
    expect(fixture.nativeElement.querySelector('app-workspace-shell-core')?.style.display).toBe('contents');
  });

  it('keeps the slot as a directive instead of a projection component', () => {
    const source = readFileSync(join(__dirname, 'workspace-shell-core.component.ts'), 'utf8');

    expect(source).toContain('Directive');
    expect(source).not.toContain("template: '<ng-content></ng-content>'");
  });
});
