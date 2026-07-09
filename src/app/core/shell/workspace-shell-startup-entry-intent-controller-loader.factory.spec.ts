import { describe, expect, it, vi } from 'vitest';

import {
  createWorkspaceShellStartupEntryIntentControllerLoader,
  type WorkspaceShellStartupEntryIntentControllerLoaderOptions,
} from './workspace-shell-startup-entry-intent-controller-loader.factory';
import type {
  WorkspaceShellStartupEntryIntentHostDelegate,
} from './workspace-shell-startup-entry-intent-host.factory';

function createDelegate(): WorkspaceShellStartupEntryIntentHostDelegate {
  return {
    flushWidgetWorkspaceGateRecheck: vi.fn(),
    resetPrimeState: vi.fn(),
    sync: vi.fn(),
  };
}

function createOptions(
  overrides: Partial<WorkspaceShellStartupEntryIntentControllerLoaderOptions> = {},
): WorkspaceShellStartupEntryIntentControllerLoaderOptions {
  return {
    routeUrl: () => '/projects/project-1/task/task-1?entry=widget&intent=open-workspace',
    currentStartupEntryIntent: () => null,
    deferredStartupEntryIntent: () => null,
    currentUserId: () => 'user-1',
    isApplicationReady: () => true,
    isBlackBoxEnabled: () => true,
    setSidebarOpen: vi.fn(),
    preloadSidebarTools: vi.fn(),
    loadBlackBoxRecorder: vi.fn(),
    applyWidgetGateMutation: vi.fn(),
    primeWidgetWorkspaceGateSync: vi.fn(),
    refreshFocusSessionFromCloud: vi.fn(),
    recheckGate: vi.fn(),
    clearDeferredStartupEntryIntent: vi.fn(),
    resolveMobileRootProjectId: () => 'project-root',
    navigate: vi.fn(),
    warn: vi.fn(),
    ...overrides,
  };
}

describe('createWorkspaceShellStartupEntryIntentControllerLoader', () => {
  it('uses the provided startup entry intent controller loader', async () => {
    const delegate = createDelegate();
    const createStartupEntryIntentController = vi.fn().mockResolvedValue(delegate);
    const loadController = createWorkspaceShellStartupEntryIntentControllerLoader({
      ...createOptions(),
      createStartupEntryIntentController,
    });

    await expect(loadController()).resolves.toBe(delegate);

    expect(createStartupEntryIntentController).toHaveBeenCalledOnce();
  });

  it('creates the default startup entry intent host controller lazily', async () => {
    const currentStartupEntryIntent = vi.fn(() => null);
    const loadController = createWorkspaceShellStartupEntryIntentControllerLoader(createOptions({
      currentStartupEntryIntent,
    }));

    const controller = await loadController();
    controller.sync();

    expect(currentStartupEntryIntent).toHaveBeenCalledOnce();
  });
});
