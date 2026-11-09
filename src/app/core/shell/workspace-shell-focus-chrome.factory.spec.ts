import { signal } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';

import {
  WorkspaceShellFocusChromeController,
  type WorkspaceShellFocusChromeControllerOptions,
} from './workspace-shell-focus-chrome.controller';
import type { SidebarChromeState } from './workspace-shell-chrome.helpers';
import {
  readWorkspaceShellChromeSurfaceSource,
  readWorkspaceShellControllerGraphSource,
  readWorkspaceShellSessionRoutingSurfaceSource,
  readWorkspaceShellSource,
} from './workspace-shell-source.spec-helpers';

type FocusChromeFactoryModule = {
  createWorkspaceShellFocusChromeController?: unknown;
};

async function loadFactoryModule(): Promise<FocusChromeFactoryModule> {
  try {
    const modulePath = './workspace-shell-focus-chrome.factory';
    return await import(/* @vite-ignore */ modulePath) as FocusChromeFactoryModule;
  } catch {
    return {};
  }
}

describe('createWorkspaceShellFocusChromeController', () => {
  it('moves focus chrome controller construction out of WorkspaceShellComponent', () => {
    const componentSource = readWorkspaceShellSource();
    const graphSource = readWorkspaceShellControllerGraphSource();
    const sessionRoutingSource = readWorkspaceShellSessionRoutingSurfaceSource();
    const chromeSurfaceSource = readWorkspaceShellChromeSurfaceSource();

    expect(graphSource).toContain('createWorkspaceShellSessionRoutingSurface');
    expect(sessionRoutingSource).toContain('createWorkspaceShellChromeSurface');
    expect(chromeSurfaceSource).toContain('createWorkspaceShellFocusChromeController');
    expect(componentSource).not.toContain('createWorkspaceShellFocusChromeController');
    expect(componentSource).not.toContain('new WorkspaceShellFocusChromeController');
    expect(componentSource).not.toContain('focusMode: this.dockEngine.focusMode');
    expect(componentSource).not.toContain('phase: this.dockEngine.focusChromePhase');
  });

  it('adapts dock engine and UI state signals into focus chrome options', async () => {
    const { createWorkspaceShellFocusChromeController } =
      await loadFactoryModule();
    expect(createWorkspaceShellFocusChromeController).toBeTypeOf('function');
    const createFocusChrome = createWorkspaceShellFocusChromeController as (
      options: {
        createController: (
          options: WorkspaceShellFocusChromeControllerOptions,
        ) => WorkspaceShellFocusChromeController;
        focusChromePhase: WorkspaceShellFocusChromeControllerOptions['phase'];
        uiState: {
          isMobile: WorkspaceShellFocusChromeControllerOptions['isMobile'];
          sidebarOpen: WorkspaceShellFocusChromeControllerOptions['sidebarOpen'];
          sidebarWidth: WorkspaceShellFocusChromeControllerOptions['sidebarWidth'];
        };
      },
    ) => WorkspaceShellFocusChromeController;
    let controllerOptions!: WorkspaceShellFocusChromeControllerOptions;
    const createController = vi.fn((options) => {
      controllerOptions = options;
      return new WorkspaceShellFocusChromeController(options);
    });
    const focusChromePhase = signal<SidebarChromeState['phase']>('idle');
    const uiState = {
      isMobile: signal(false),
      sidebarOpen: signal(true),
      sidebarWidth: signal(320),
    };

    const controller = createFocusChrome({
      createController,
      focusChromePhase,
      uiState,
    });

    expect(controller).toBeInstanceOf(WorkspaceShellFocusChromeController);
    expect(controllerOptions.phase).toBe(focusChromePhase);
    expect(controllerOptions.isMobile).toBe(uiState.isMobile);
    expect(controllerOptions.sidebarOpen).toBe(uiState.sidebarOpen);
    expect(controllerOptions.sidebarWidth).toBe(uiState.sidebarWidth);
  });
});
