import { Injector } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';

import { DockEngineService } from '../../../services/dock-engine.service';
import type {
  WorkspaceShellFloatingNoticeChromeController,
  WorkspaceShellFloatingNoticeChromeControllerOptions,
} from './workspace-shell-floating-notice-chrome.controller';
import type {
  WorkspaceShellFocusChromeController,
  WorkspaceShellFocusChromeControllerOptions,
} from './workspace-shell-focus-chrome.controller';
import {
  readWorkspaceShellControllerGraphSource,
  readWorkspaceShellSessionRoutingSurfaceSource,
  readWorkspaceShellStartupTemplateSurfacesSource,
  readWorkspaceShellSource,
} from './workspace-shell-source.spec-helpers';

type WorkspaceShellChromeSurfaceFactory = (options: {
  injector: Injector;
  uiState: {
    isMobile(): boolean;
    sidebarOpen(): boolean;
    sidebarWidth(): number;
  };
  networkAwareness: { isOnline(): boolean };
  syncCoordinator: { offlineMode(): boolean };
  actionQueue: { queueFrozen(): boolean };
  userSession: {
    currentUserId(): string | null;
    isHintOnlyStartupPlaceholderVisible(): boolean;
  };
  createFocusChromeController?: (
    options: WorkspaceShellFocusChromeControllerOptions,
  ) => WorkspaceShellFocusChromeController;
  createFloatingNoticeChromeController?: (
    options: WorkspaceShellFloatingNoticeChromeControllerOptions,
  ) => WorkspaceShellFloatingNoticeChromeController;
}) => {
  readonly dockEngine: DockEngineService;
  readonly focusChrome: WorkspaceShellFocusChromeController;
  readonly floatingNoticeChrome: WorkspaceShellFloatingNoticeChromeController;
};

async function loadFactory(): Promise<{
  createWorkspaceShellChromeSurface?: WorkspaceShellChromeSurfaceFactory;
}> {
  const modulePath = './workspace-shell-chrome-surface.factory';
  const module = await import(/* @vite-ignore */ modulePath)
    .catch(() => ({}));

  return module as {
    createWorkspaceShellChromeSurface?: WorkspaceShellChromeSurfaceFactory;
  };
}

describe('createWorkspaceShellChromeSurface', () => {
  it('groups dock engine, focus chrome, and floating notice chrome wiring', async () => {
    const { createWorkspaceShellChromeSurface } = await loadFactory();

    expect(createWorkspaceShellChromeSurface).toEqual(expect.any(Function));

    let focusOptions!: WorkspaceShellFocusChromeControllerOptions;
    let floatingOptions!: WorkspaceShellFloatingNoticeChromeControllerOptions;
    const focusChrome = {} as WorkspaceShellFocusChromeController;
    const floatingNoticeChrome =
      {} as WorkspaceShellFloatingNoticeChromeController;
    const dockEngine = {
      focusChromePhase: vi.fn(() => 'idle'),
    } as unknown as DockEngineService;
    const injector = {
      get: vi.fn((token: unknown) => {
        if (token === DockEngineService) return dockEngine;
        throw new Error(`Unexpected token: ${String(token)}`);
      }),
    } as unknown as Injector;
    const uiState = {
      isMobile: vi.fn(() => false),
      sidebarOpen: vi.fn(() => true),
      sidebarWidth: vi.fn(() => 320),
    };
    const userSession = {
      currentUserId: vi.fn(() => 'user-1'),
      isHintOnlyStartupPlaceholderVisible: vi.fn(() => false),
    };

    const surface = createWorkspaceShellChromeSurface?.({
      injector,
      uiState,
      networkAwareness: { isOnline: vi.fn(() => true) },
      syncCoordinator: { offlineMode: vi.fn(() => false) },
      actionQueue: { queueFrozen: vi.fn(() => false) },
      userSession,
      createFocusChromeController: options => {
        focusOptions = options;
        return focusChrome;
      },
      createFloatingNoticeChromeController: options => {
        floatingOptions = options;
        return floatingNoticeChrome;
      },
    });

    expect(injector.get).toHaveBeenCalledWith(DockEngineService);
    expect(surface?.dockEngine).toBe(dockEngine);
    expect(surface?.focusChrome).toBe(focusChrome);
    expect(surface?.floatingNoticeChrome).toBe(floatingNoticeChrome);
    expect(focusOptions).toEqual({
      phase: dockEngine.focusChromePhase,
      isMobile: uiState.isMobile,
      sidebarOpen: uiState.sidebarOpen,
      sidebarWidth: uiState.sidebarWidth,
    });
    expect(floatingOptions.currentUserId()).toBe('user-1');
    expect(floatingOptions.hintOnlyStartupPlaceholderVisible()).toBe(false);
    expect(floatingOptions.isMobile()).toBe(false);
  });

  it('keeps chrome controller assembly out of WorkspaceShellComponent', () => {
    const source = readWorkspaceShellSource();
    const graphSource = readWorkspaceShellControllerGraphSource();
    const sessionRoutingSurfaceSource =
      readWorkspaceShellSessionRoutingSurfaceSource();
    const startupTemplateSurfacesSource =
      readWorkspaceShellStartupTemplateSurfacesSource();

    expect(graphSource).toContain('createWorkspaceShellSessionRoutingSurface');
    expect(sessionRoutingSurfaceSource).toContain(
      'chrome: createWorkspaceShellChromeSurface',
    );
    expect(graphSource).toContain('createWorkspaceShellStartupTemplateSurfaces');
    expect(graphSource).not.toContain('createWorkspaceShellTemplateSurface');
    expect(startupTemplateSurfacesSource)
      .toContain('createWorkspaceShellTemplateSurface');
    expect(source).not.toContain('createWorkspaceShellTemplateStateDependencies');
    expect(source).not.toContain('DockEngineService');
    expect(source).not.toContain('createWorkspaceShellFocusChromeController');
    expect(source).not.toContain('createWorkspaceShellFloatingNoticeChrome');
  });
});
