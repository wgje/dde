import { describe, expect, it } from 'vitest';

import {
  readWorkspaceShellSource,
  readWorkspaceShellTemplate,
} from './workspace-shell-source.spec-helpers';

describe('WorkspaceShellComponent sidebar resize delegation', () => {
  it('binds resize state and drag startup directly to the sidebar resize controller', () => {
    const template = readWorkspaceShellTemplate();

    expect(template).toContain('template.interaction.sidebarResize.isResizingAny()');
    expect(template).toContain(
      'template.interaction.sidebarResize.startSidebarResize($event)',
    );
    expect(template).not.toContain('isResizingAny"');
    expect(template).not.toContain('(mousedown)="startSidebarResize($event)"');
    expect(template).not.toContain('(mousedown)="startContentResize($event)"');
    expect(template).not.toMatch(/(?<!template\.interaction\.)sidebarResize\./);
  });

  it('keeps sidebar resize forwarding wrappers out of the component class', () => {
    const source = readWorkspaceShellSource();

    expect(source).not.toMatch(/\bget\s+isResizingAny\s*\(/);
    expect(source).not.toMatch(/\bstartSidebarResize\s*\(/);
    expect(source).not.toMatch(/\bstartContentResize\s*\(/);
    expect(source).not.toMatch(/\bonDocumentMouseMove\s*\(/);
    expect(source).not.toMatch(/\bonDocumentMouseUp\s*\(/);
    expect(source).not.toContain("@HostListener('document:mousemove'");
    expect(source).not.toContain("@HostListener('document:mouseup'");
  });
});
