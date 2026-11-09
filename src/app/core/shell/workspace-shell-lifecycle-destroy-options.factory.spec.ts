import { describe, expect, it, vi } from 'vitest';

import {
  createWorkspaceShellLifecycleDestroyOptions,
} from './workspace-shell-lifecycle-destroy-options.factory';
import {
  readWorkspaceShellControllerGraphCallOptions,
  readWorkspaceShellControllerGraphSource,
  readWorkspaceShellLifecycleGraphCallOptions,
  readWorkspaceShellLifecycleGraphSource,
  readWorkspaceShellLifecycleSurfaceSource,
  readWorkspaceShellSource,
} from './workspace-shell-source.spec-helpers';
import type {
  WorkspaceShellToolLazyLoadDelegates,
} from './workspace-shell-tool-lazy-load-delegates.factory';

function createBeforeUnloadControllerMock() {
  return {
    cleanup: vi.fn(),
  } as unknown as Parameters<
    typeof createWorkspaceShellLifecycleDestroyOptions
  >[0]['sessionExitSurface']['beforeUnloadController'];
}

describe('workspace shell lifecycle destroy options', () => {
  it('builds destroy controller options from shell lifecycle dependencies', () => {
    const toolLazyLoad = {
      focusToolsLazyLoad: { teardown: vi.fn() },
      sidebarToolsLazyLoad: { teardown: vi.fn() },
      focusSessionTriggerComponent: vi.fn(),
      blackBoxRecorderComponent: vi.fn(),
      blackBoxRecorderOutletInputs: {
        appearance: 'obsidian',
        onTranscribed: vi.fn(),
      },
      templateBindings: {},
      teardown: vi.fn(),
    } as unknown as WorkspaceShellToolLazyLoadDelegates;
    const options = {
      markDestroyed: vi.fn(),
      projectSubscription: { clear: vi.fn() },
      remoteCallbackTeardown: { teardown: vi.fn() },
      searchDelegates: {
        searchController: {
          cleanup: vi.fn(),
        } as unknown as Parameters<typeof createWorkspaceShellLifecycleDestroyOptions>[0]['searchDelegates']['searchController'],
      },
      sessionExitSurface: {
        beforeUnloadController: createBeforeUnloadControllerMock(),
      },
      sessionLaunchControllers: {
        sessionTransition: { cleanup: vi.fn() },
      },
      storageEscape: { teardown: vi.fn() },
      startupEntryControllers: {
        startupEntryIntentController: { teardown: vi.fn() },
      },
      syncPulseLifecycle: {
        clearFocusEntrySyncPulseRetry: vi.fn(),
        destroy: vi.fn(),
      },
      toolControllers: {
        toolLazyLoad,
      },
      undoService: { flushPendingAction: vi.fn() },
      warn: vi.fn(),
    };

    expect(createWorkspaceShellLifecycleDestroyOptions(options)).toEqual({
      beforeUnloadController: options.sessionExitSurface.beforeUnloadController,
      markDestroyed: options.markDestroyed,
      projectSubscription: options.projectSubscription,
      remoteCallbackTeardown: options.remoteCallbackTeardown,
      searchController: options.searchDelegates.searchController,
      sessionTransitionCleanup:
        options.sessionLaunchControllers.sessionTransition,
      storageEscape: options.storageEscape,
      startupEntryIntent:
        options.startupEntryControllers.startupEntryIntentController,
      syncPulseLifecycle: options.syncPulseLifecycle,
      toolLazyLoad,
      undoService: options.undoService,
      warn: options.warn,
    });
    expect(createWorkspaceShellLifecycleDestroyOptions(options)).not.toHaveProperty(
      'flowPrewarm',
    );
    expect(createWorkspaceShellLifecycleDestroyOptions(options)).not.toHaveProperty(
      'toolControllers',
    );
    expect(createWorkspaceShellLifecycleDestroyOptions(options)).not.toHaveProperty(
      'sessionLaunchControllers',
    );
  });

  it('keeps destroy lifecycle option wiring outside WorkspaceShellComponent', () => {
    const componentSource = readWorkspaceShellSource();
    const graphSource = readWorkspaceShellControllerGraphSource();
    const lifecycleGraphSource = readWorkspaceShellLifecycleGraphSource();
    const lifecycleGraphOptions = readWorkspaceShellControllerGraphCallOptions(
      'createWorkspaceShellLifecycleGraph',
    );
    const lifecycleOptions = readWorkspaceShellLifecycleGraphCallOptions(
      'createWorkspaceShellLifecycleSurface',
    );
    const surfaceSource = readWorkspaceShellLifecycleSurfaceSource();

    expect(graphSource).toContain('createWorkspaceShellLifecycleGraph');
    expect(lifecycleGraphSource).toContain('createWorkspaceShellLifecycleSurface');
    expect(componentSource).not.toContain('createWorkspaceShellLifecycleDestroyOptions');
    expect(componentSource).not.toContain(
      'destroyController: this.lifecycleDestroyOptions',
    );
    expect(lifecycleOptions).toContain('...sessionLifecycle');
    expect(surfaceSource).toContain(
      'destroyController: createWorkspaceShellLifecycleDestroyOptions({',
    );
    expect(surfaceSource).toContain(
      'syncPulseLifecycle: options.focusSyncControllers.syncPulseLifecycle',
    );
    expect(lifecycleGraphOptions).toContain('...startupTemplate');
    expect(lifecycleOptions).toContain('...options');
    expect(surfaceSource).not.toContain('startupEntryIntent:');
    expect(surfaceSource).not.toContain(
      'this.startupEntryControllers.startupEntryIntentController',
    );
    expect(componentSource).not.toContain(
      'private readonly searchController = this.searchDelegates.searchController',
    );
    expect(componentSource).not.toContain('searchController: this.searchController');
    expect(componentSource).not.toContain(
      'private readonly toolLazyLoad = this.toolControllers.toolLazyLoad',
    );
    expect(componentSource).not.toMatch(
      /destroyController:\s*{\s*markDestroyed:\s*\(\)\s*=>\s*{\s*this\.destroyed = true;\s*}/s,
    );
  });
});
