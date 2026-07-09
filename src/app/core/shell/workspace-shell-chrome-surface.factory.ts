import type { Injector } from '@angular/core';

import { DockEngineService } from '../../../services/dock-engine.service';
import {
  createWorkspaceShellFloatingNoticeChrome,
  type WorkspaceShellFloatingNoticeChromeFactoryOptions,
} from './workspace-shell-floating-notice-chrome.factory';
import {
  createWorkspaceShellFocusChromeController,
  type WorkspaceShellFocusChromeFactoryOptions,
} from './workspace-shell-focus-chrome.factory';

export interface WorkspaceShellChromeSurfaceOptions
  extends Omit<
      WorkspaceShellFocusChromeFactoryOptions,
      'createController' | 'focusChromePhase' | 'uiState'
    >,
    Omit<
      WorkspaceShellFloatingNoticeChromeFactoryOptions,
      'createController' | 'uiState'
    > {
  injector: Injector;
  uiState: WorkspaceShellFocusChromeFactoryOptions['uiState']
    & WorkspaceShellFloatingNoticeChromeFactoryOptions['uiState'];
  createFocusChromeController?: WorkspaceShellFocusChromeFactoryOptions['createController'];
  createFloatingNoticeChromeController?: WorkspaceShellFloatingNoticeChromeFactoryOptions['createController'];
}

export interface WorkspaceShellChromeSurface {
  readonly dockEngine: DockEngineService;
  readonly floatingNoticeChrome: ReturnType<
    typeof createWorkspaceShellFloatingNoticeChrome
  >;
  readonly focusChrome: ReturnType<typeof createWorkspaceShellFocusChromeController>;
}

export function createWorkspaceShellChromeSurface(
  options: WorkspaceShellChromeSurfaceOptions,
): WorkspaceShellChromeSurface {
  const dockEngine = options.injector.get(DockEngineService);

  return {
    dockEngine,
    focusChrome: createWorkspaceShellFocusChromeController({
      focusChromePhase: dockEngine.focusChromePhase,
      uiState: options.uiState,
      ...(options.createFocusChromeController
        ? { createController: options.createFocusChromeController }
        : {}),
    }),
    floatingNoticeChrome: createWorkspaceShellFloatingNoticeChrome({
      actionQueue: options.actionQueue,
      networkAwareness: options.networkAwareness,
      syncCoordinator: options.syncCoordinator,
      uiState: options.uiState,
      userSession: options.userSession,
      ...(options.createFloatingNoticeChromeController
        ? { createController: options.createFloatingNoticeChromeController }
        : {}),
    }),
  };
}
