import { describe, expect, it, vi } from 'vitest';

import {
  createWorkspaceShellFloatingNoticeChrome,
  type WorkspaceShellFloatingNoticeChromeFactoryOptions,
} from './workspace-shell-floating-notice-chrome.factory';
import type {
  WorkspaceShellFloatingNoticeChromeControllerOptions,
} from './workspace-shell-floating-notice-chrome.controller';
import { WorkspaceShellFloatingNoticeChromeController } from './workspace-shell-floating-notice-chrome.controller';
import {
  readWorkspaceShellChromeSurfaceSource,
  readWorkspaceShellControllerGraphSource,
  readWorkspaceShellSessionRoutingSurfaceSource,
  readWorkspaceShellSource,
} from './workspace-shell-source.spec-helpers';

function createOptions(
  overrides: Partial<WorkspaceShellFloatingNoticeChromeFactoryOptions> = {},
): WorkspaceShellFloatingNoticeChromeFactoryOptions {
  return {
    actionQueue: { queueFrozen: () => false },
    networkAwareness: { isOnline: () => true },
    syncCoordinator: { offlineMode: () => false },
    uiState: { isMobile: () => true },
    userSession: {
      currentUserId: () => 'user-1',
      isHintOnlyStartupPlaceholderVisible: () => false,
    },
    ...overrides,
  };
}

describe('createWorkspaceShellFloatingNoticeChrome', () => {
  it('moves floating notice chrome construction out of WorkspaceShellComponent', () => {
    const componentSource = readWorkspaceShellSource();
    const graphSource = readWorkspaceShellControllerGraphSource();
    const sessionRoutingSource = readWorkspaceShellSessionRoutingSurfaceSource();
    const chromeSurfaceSource = readWorkspaceShellChromeSurfaceSource();

    expect(graphSource).toContain('createWorkspaceShellSessionRoutingSurface');
    expect(sessionRoutingSource).toContain('createWorkspaceShellChromeSurface');
    expect(chromeSurfaceSource).toContain('createWorkspaceShellFloatingNoticeChrome');
    expect(componentSource).not.toContain('createWorkspaceShellFloatingNoticeChrome');
    expect(componentSource).not.toContain('new WorkspaceShellFloatingNoticeChromeController');
  });

  it('adapts shell services into the floating notice controller options', () => {
    let controllerOptions!: WorkspaceShellFloatingNoticeChromeControllerOptions;
    const createController = vi.fn((options) => {
      controllerOptions = options;
      return new WorkspaceShellFloatingNoticeChromeController(options);
    });
    const uiState = { isMobile: vi.fn(() => false) };
    const networkAwareness = { isOnline: vi.fn(() => false) };
    const syncCoordinator = { offlineMode: vi.fn(() => true) };
    const actionQueue = { queueFrozen: vi.fn(() => true) };
    const userSession = {
      currentUserId: vi.fn(() => 'user-1'),
      isHintOnlyStartupPlaceholderVisible: vi.fn(() => true),
    };

    const result = createWorkspaceShellFloatingNoticeChrome({
      actionQueue,
      createController,
      networkAwareness,
      syncCoordinator,
      uiState,
      userSession,
    });

    expect(result).toBeInstanceOf(WorkspaceShellFloatingNoticeChromeController);
    expect(controllerOptions.currentUserId()).toBe('user-1');
    expect(controllerOptions.hintOnlyStartupPlaceholderVisible()).toBe(true);
    expect(controllerOptions.isMobile()).toBe(false);
    expect(controllerOptions.isOnline()).toBe(false);
    expect(controllerOptions.offlineMode()).toBe(true);
    expect(controllerOptions.queueFrozen()).toBe(true);
  });

  it('passes optional chrome probes into the floating notice controller options', () => {
    let controllerOptions!: WorkspaceShellFloatingNoticeChromeControllerOptions;
    const createController = vi.fn((options) => {
      controllerOptions = options;
      return new WorkspaceShellFloatingNoticeChromeController(options);
    });
    const getLocalStorage = vi.fn(() => undefined);
    const installPromptVisible = vi.fn(() => true);
    const isDemoBannerDismissed = vi.fn(() => true);

    const result = createWorkspaceShellFloatingNoticeChrome(createOptions({
      createController,
      getLocalStorage,
      installPromptVisible,
      isDemoBannerDismissed,
    }));

    expect(result).toBeInstanceOf(WorkspaceShellFloatingNoticeChromeController);
    expect(controllerOptions.getLocalStorage?.()).toBeUndefined();
    expect(controllerOptions.installPromptVisible?.()).toBe(true);
    expect(controllerOptions.isDemoBannerDismissed?.()).toBe(true);
  });
});
