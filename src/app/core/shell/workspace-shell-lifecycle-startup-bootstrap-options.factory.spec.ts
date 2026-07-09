import { describe, expect, it, vi } from 'vitest';

import {
  createWorkspaceShellLifecycleStartupBootstrapOptions,
} from './workspace-shell-lifecycle-startup-bootstrap-options.factory';
import {
  readWorkspaceShellControllerGraphCallOptions,
  readWorkspaceShellControllerGraphSource,
  readWorkspaceShellLifecycleGraphCallOptions,
  readWorkspaceShellLifecycleGraphSource,
  readWorkspaceShellLifecycleSurfaceSource,
  readWorkspaceShellSource,
} from './workspace-shell-source.spec-helpers';

function createBeforeUnloadControllerMock() {
  return {
    cleanup: vi.fn(),
    setup: vi.fn(),
  } as unknown as Parameters<
    typeof createWorkspaceShellLifecycleStartupBootstrapOptions
  >[0]['sessionExitSurface']['beforeUnloadController'];
}

describe('workspace shell lifecycle startup bootstrap options', () => {
  it('builds startup bootstrap options from shell dependencies', () => {
    const androidWidgetLazyLoad = {
      restoreAll: vi.fn(),
      teardown: vi.fn(),
    };
    const options = {
      appLifecycle: { initialize: vi.fn() },
      sessionExitSurface: {
        beforeUnloadController: createBeforeUnloadControllerMock(),
      },
      beforeUnloadController: {
        cleanup: vi.fn(),
        setup: vi.fn(),
      },
      conflictHandler: {
        cleanup: vi.fn(),
        setup: vi.fn(),
      },
      isMobile: vi.fn(() => false),
      isSidebarOpen: { set: vi.fn() },
      interactionSurface: {
        modalCallbacks: { createCallbacks: vi.fn(() => ({})) },
      },
      modalCoord: {
        clearCallbacks: vi.fn(),
        initCallbacks: vi.fn(),
        preloadCommonModals: vi.fn(),
      },
      sidebarToggleEvent: {
        cleanup: vi.fn(),
        setup: vi.fn(),
      },
      startupEntryControllers: {
        androidWidgetLazyLoad,
      },
      signalEffects: {
        setup: vi.fn(),
        teardown: vi.fn(),
      },
      storageEscape: {
        setup: vi.fn(),
        teardown: vi.fn(),
      },
      userSession: { prehydrateFromSnapshot: vi.fn() },
    };

    const {
      beforeUnloadController: _legacyBeforeUnloadController,
      interactionSurface,
      sessionExitSurface,
      startupEntryControllers,
      ...expectedOptions
    } = options;
    void _legacyBeforeUnloadController;
    void startupEntryControllers;

    expect(createWorkspaceShellLifecycleStartupBootstrapOptions(options))
      .toEqual({
        ...expectedOptions,
        androidWidgetLazyLoad,
        beforeUnloadController: sessionExitSurface.beforeUnloadController,
        modalCallbacks: interactionSurface.modalCallbacks,
      });
  });

  it('keeps startup bootstrap option wiring outside WorkspaceShellComponent', () => {
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
    expect(componentSource).not.toContain(
      'createWorkspaceShellLifecycleStartupBootstrapOptions',
    );
    expect(componentSource).not.toContain(
      'startupBootstrap: this.lifecycleStartupBootstrapOptions',
    );
    expect(surfaceSource).toContain(
      'createWorkspaceShellLifecycleStartupBootstrapOptions({',
    );
    expect(surfaceSource).toContain('sidebarToggleEvent,');
    expect(lifecycleGraphOptions).toContain('...startupTemplate');
    expect(lifecycleOptions).toContain('...options');
    expect(surfaceSource).not.toContain('androidWidgetLazyLoad:');
    expect(surfaceSource).not.toContain(
      'this.startupEntryControllers.androidWidgetLazyLoad',
    );
    expect(componentSource).not.toContain(
      'private readonly modalCallbacks = this.interactionSurface.modalCallbacks',
    );
    expect(componentSource).not.toContain('modalCallbacks: this.modalCallbacks');
    expect(componentSource).not.toMatch(
      /startupBootstrap:\s*{\s*isMobile:\s*\(\)\s*=>\s*this\.uiState\.isMobile\(\),\s*isSidebarOpen:\s*this\.isSidebarOpen,/s,
    );
  });
});
