import { signal } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';

import {
  WorkspaceShellSidebarToggleEventController,
  type WorkspaceShellSidebarToggleEventControllerOptions,
} from './workspace-shell-sidebar-toggle-event.controller';
import {
  readWorkspaceShellLifecycleSurfaceSource,
  readWorkspaceShellSource,
} from './workspace-shell-source.spec-helpers';

type SidebarToggleFactoryModule = {
  createWorkspaceShellSidebarToggleEventController?: unknown;
};

async function loadFactoryModule(): Promise<SidebarToggleFactoryModule> {
  try {
    const modulePath = './workspace-shell-sidebar-toggle-event.factory';
    return await import(/* @vite-ignore */ modulePath) as SidebarToggleFactoryModule;
  } catch {
    return {};
  }
}

describe('createWorkspaceShellSidebarToggleEventController', () => {
  it('moves sidebar toggle event construction out of WorkspaceShellComponent', () => {
    const componentSource = readWorkspaceShellSource();
    const lifecycleSurfaceSource = readWorkspaceShellLifecycleSurfaceSource();

    expect(componentSource).not.toContain('createWorkspaceShellSidebarToggleEventController');
    expect(lifecycleSurfaceSource).toContain('createWorkspaceShellSidebarToggleEventController');
    expect(componentSource).not.toContain('new WorkspaceShellSidebarToggleEventController');
    expect(componentSource).not.toContain('toggleSidebar: () => this.isSidebarOpen.update');
    expect(componentSource).not.toContain('isSidebarOpen: this.isSidebarOpen');
  });

  it('adapts the sidebar open signal into a toggle callback', async () => {
    const { createWorkspaceShellSidebarToggleEventController } =
      await loadFactoryModule();
    expect(createWorkspaceShellSidebarToggleEventController).toBeTypeOf('function');
    const createSidebarToggle = createWorkspaceShellSidebarToggleEventController as (
      options: {
        createController: (
          options: WorkspaceShellSidebarToggleEventControllerOptions,
        ) => WorkspaceShellSidebarToggleEventController;
        isSidebarOpen: ReturnType<typeof signal<boolean>>;
      },
    ) => WorkspaceShellSidebarToggleEventController;
    let controllerOptions!: WorkspaceShellSidebarToggleEventControllerOptions;
    const createController = vi.fn((options) => {
      controllerOptions = options;
      return new WorkspaceShellSidebarToggleEventController(options);
    });
    const isSidebarOpen = signal(false);

    const controller = createSidebarToggle({
      createController,
      isSidebarOpen,
    });

    expect(controller).toBeInstanceOf(WorkspaceShellSidebarToggleEventController);
    controllerOptions.toggleSidebar();
    expect(isSidebarOpen()).toBe(true);
    controllerOptions.toggleSidebar();
    expect(isSidebarOpen()).toBe(false);
  });
});
