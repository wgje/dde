import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { WorkspaceOverlaysComponent } from './workspace-overlays.component';

describe('WorkspaceOverlaysComponent', () => {
  @Component({
    standalone: true,
    imports: [WorkspaceOverlaysComponent],
    template: '<app-workspace-overlays><span data-testid="slot">overlays</span></app-workspace-overlays>',
  })
  class HostComponent {}

  it('renders projected overlay content on the directive host', () => {
    TestBed.configureTestingModule({
      imports: [HostComponent],
    });
    const fixture = TestBed.createComponent(HostComponent);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('[data-testid="slot"]')?.textContent).toBe('overlays');
    expect(fixture.nativeElement.querySelector('app-workspace-overlays')?.style.display).toBe('contents');
  });

  it('keeps the slot as a directive instead of a projection component', () => {
    const source = readFileSync(join(__dirname, 'workspace-overlays.component.ts'), 'utf8');

    expect(source).toContain('Directive');
    expect(source).not.toContain("template: '<ng-content></ng-content>'");
  });
});
