import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type {
  WorkspaceShellDestroyControllerFactoryOptions,
} from './workspace-shell-destroy-controller.factory';
import {
  createWorkspaceShellDestroyControllerLoader,
} from './workspace-shell-destroy-controller-loader.factory';

function createOptions(
  overrides: Partial<WorkspaceShellDestroyControllerFactoryOptions> = {},
): WorkspaceShellDestroyControllerFactoryOptions {
  return {
    androidWidgetLazyLoad: { teardown: vi.fn() },
    beforeUnloadController: { cleanup: vi.fn() },
    conflictHandler: { cleanup: vi.fn() },
    flowPrewarm: { teardown: vi.fn() },
    focusMountIntent: { teardown: vi.fn() },
    interactionLifecycle: {
      cleanupViewportStage: vi.fn(),
      teardownDestroyStage: vi.fn(),
    },
    lazyLifecycles: {
      teardownKeyboardShortcutsStage: vi.fn(),
      teardownStartupStage: vi.fn(),
    },
    markDestroyed: vi.fn(),
    modalCoord: { clearCallbacks: vi.fn() },
    ngOnInitStartup: { teardown: vi.fn() },
    projectSubscription: { clear: vi.fn() },
    remoteCallbackTeardown: { teardown: vi.fn() },
    routeSyncController: { cleanup: vi.fn() },
    searchController: { cleanup: vi.fn() },
    sessionTransitionCleanup: { cleanup: vi.fn() },
    sidebarToggleEvent: { cleanup: vi.fn() },
    signalEffects: { teardown: vi.fn() },
    startupBootstrap: { teardown: vi.fn() },
    startupEntryIntent: { teardown: vi.fn() },
    startupLazyServices: { teardown: vi.fn() },
    startupTier: { destroy: vi.fn() },
    storageEscape: { teardown: vi.fn() },
    syncPulseLifecycle: {
      clearFocusEntrySyncPulseRetry: vi.fn(),
      destroy: vi.fn(),
    },
    toolLazyLoad: { teardown: vi.fn() },
    undoService: { flushPendingAction: vi.fn() },
    warn: vi.fn(),
    ...overrides,
  };
}

describe('createWorkspaceShellDestroyControllerLoader', () => {
  it('loads the concrete destroy controller lazily', async () => {
    const options = createOptions();
    const loadDestroyController = createWorkspaceShellDestroyControllerLoader({
      options,
    });

    expect(options.markDestroyed).not.toHaveBeenCalled();

    const destroyController = await loadDestroyController();
    destroyController.destroy();

    expect(options.markDestroyed).toHaveBeenCalledTimes(1);
    expect(options.startupBootstrap.teardown).toHaveBeenCalledTimes(1);
  });

  it('owns the dynamic import of the concrete destroy controller factory', () => {
    const source = readFileSync(
      join(__dirname, 'workspace-shell-destroy-controller-loader.factory.ts'),
      'utf8',
    );

    expect(source).toContain("import('./workspace-shell-destroy-controller.factory')");
    expect(source).not.toMatch(
      /import\s+(?!type\s)\{[^;]*createWorkspaceShellDestroyController[^;]*\}\s+from\s+['"]\.\/workspace-shell-destroy-controller\.factory['"]/,
    );
  });
});
