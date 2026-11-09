import { describe, expect, it, vi } from 'vitest';

import type {
  WorkspaceShellSidebarToolsControllerLike,
  WorkspaceShellSidebarToolsLazyLoadControllerOptions,
} from './workspace-shell-sidebar-tools-lazy-load.controller';
import {
  createWorkspaceShellSidebarToolsControllerLoader,
} from './workspace-shell-sidebar-tools-controller-loader.factory';

function createSidebarTools(): WorkspaceShellSidebarToolsControllerLike {
  return {
    loadBlackBoxRecorderComponent: vi.fn().mockResolvedValue(null),
    loadFocusSessionTriggerComponent: vi.fn().mockResolvedValue(null),
    onToolsIntent: vi.fn(),
    onVoiceTranscribed: vi.fn(),
    preload: vi.fn(),
    preloadFocusModeAssets: vi.fn().mockResolvedValue(undefined),
    scheduleFocusModePreload: vi.fn(),
  };
}

function createOptions(
  overrides: Partial<WorkspaceShellSidebarToolsLazyLoadControllerOptions> = {},
): WorkspaceShellSidebarToolsLazyLoadControllerOptions {
  return {
    addBreadcrumb: vi.fn(),
    createBlackBoxEntry: vi.fn().mockResolvedValue({ ok: true } as const),
    dynamicLoadEnabled: () => true,
    isBlackBoxEnabled: () => false,
    loadBlackBoxRecorder: vi.fn().mockResolvedValue(null),
    loadFocusSessionTrigger: vi.fn().mockResolvedValue(null),
    preloadFocusMode: vi.fn().mockResolvedValue(undefined),
    scheduleFocusModePreload: vi.fn(),
    warn: vi.fn(),
    warning: vi.fn(),
    ...overrides,
  };
}

describe('createWorkspaceShellSidebarToolsControllerLoader', () => {
  it('uses the provided sidebar tools controller loader', async () => {
    const sidebarTools = createSidebarTools();
    const createSidebarToolsController = vi.fn().mockResolvedValue(sidebarTools);
    const loadController = createWorkspaceShellSidebarToolsControllerLoader(createOptions({
      createSidebarToolsController,
    }));

    await expect(loadController()).resolves.toBe(sidebarTools);

    expect(createSidebarToolsController).toHaveBeenCalledOnce();
  });
});
