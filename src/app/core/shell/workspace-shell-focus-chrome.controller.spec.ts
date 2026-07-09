import { signal } from '@angular/core';
import { describe, expect, it } from 'vitest';

import { WorkspaceShellFocusChromeController } from './workspace-shell-focus-chrome.controller';
import type { SidebarChromeState } from './workspace-shell-chrome.helpers';

function createController() {
  const phase = signal<SidebarChromeState['phase']>('idle');
  const isMobile = signal(false);
  const sidebarOpen = signal(true);
  const sidebarWidth = signal(320);
  const controller = new WorkspaceShellFocusChromeController({
    phase,
    isMobile,
    sidebarOpen,
    sidebarWidth,
  });

  return {
    controller,
    isMobile,
    phase,
    sidebarOpen,
    sidebarWidth,
  };
}

describe('WorkspaceShellFocusChromeController', () => {
  it('forwards workspace sidebar chrome signals from shell state', () => {
    const { controller, isMobile, phase, sidebarOpen, sidebarWidth } = createController();

    expect(controller.focusWorkspaceTakeoverActive()).toBe(false);
    expect(controller.workspaceSidebarWidthPx()).toBe(320);
    expect(controller.mobileSidebarBackdropVisible()).toBe(false);

    phase.set('focused');
    expect(controller.focusWorkspaceTakeoverActive()).toBe(true);
    expect(controller.workspaceSidebarOpacity()).toBe('0');
    expect(controller.workspaceSidebarPointerEvents()).toBe('none');

    phase.set('idle');
    isMobile.set(true);
    sidebarOpen.set(false);
    sidebarWidth.set(280);
    expect(controller.workspaceSidebarWidthPx()).toBe(240);
    expect(controller.mobileSidebarBackdropVisible()).toBe(false);
    expect(controller.workspaceSidebarPointerEvents()).toBe('none');

    sidebarOpen.set(true);
    expect(controller.mobileSidebarBackdropVisible()).toBe(true);
  });
});
