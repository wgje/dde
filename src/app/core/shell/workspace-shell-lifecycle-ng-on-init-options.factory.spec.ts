import { describe, expect, it, vi } from 'vitest';

import {
  createWorkspaceShellLifecycleNgOnInitOptions,
} from './workspace-shell-lifecycle-ng-on-init-options.factory';
import {
  readWorkspaceShellControllerGraphSource,
  readWorkspaceShellLifecycleGraphSource,
  readWorkspaceShellLifecycleSurfaceSource,
  readWorkspaceShellSource,
} from './workspace-shell-source.spec-helpers';

describe('workspace shell lifecycle ngOnInit options', () => {
  it('builds ngOnInit startup controller options from shell dependencies', () => {
    const options = {
      authCoord: { scheduleSessionBootstrap: vi.fn() },
      criticalFeatureFlags: { validate: vi.fn() },
      focusMountIntent: { setup: vi.fn(), teardown: vi.fn() },
      interactionSurface: {
        interactionLifecycle: {
          cleanupViewportStage: vi.fn(),
          setupNgOnInitStage: vi.fn(),
          teardownDestroyStage: vi.fn(),
        },
      },
      lazyServiceRefs: {
        simpleSync: { startRuntime: vi.fn() },
      },
      mobileFocusGate: { warmMobileProjectGateSnapshot: vi.fn() },
      routeSyncController: {
        cleanup: vi.fn(),
        setupRouteSync: vi.fn(),
      },
      sidebarToolsLazyLoad: {
        preload: vi.fn(),
        scheduleFocusModePreload: vi.fn(),
      },
      startupTier: {
        destroy: vi.fn(),
        initialize: vi.fn(),
      },
      syncCoordinator: { initialize: vi.fn() },
      warn: vi.fn(),
    };

    const { interactionSurface, ...expectedOptions } = options;

    expect(createWorkspaceShellLifecycleNgOnInitOptions(options)).toEqual({
      ...expectedOptions,
      interactionLifecycle: interactionSurface.interactionLifecycle,
    });
  });

  it('keeps ngOnInit lifecycle option wiring outside WorkspaceShellComponent', () => {
    const componentSource = readWorkspaceShellSource();
    const graphSource = readWorkspaceShellControllerGraphSource();
    const lifecycleGraphSource = readWorkspaceShellLifecycleGraphSource();
    const surfaceSource = readWorkspaceShellLifecycleSurfaceSource();

    expect(graphSource).toContain('createWorkspaceShellLifecycleGraph');
    expect(lifecycleGraphSource).toContain('createWorkspaceShellLifecycleSurface');
    expect(componentSource).not.toContain(
      'createWorkspaceShellLifecycleNgOnInitOptions',
    );
    expect(componentSource).not.toContain(
      'ngOnInitStartup: this.lifecycleNgOnInitOptions',
    );
    expect(surfaceSource).toContain(
      'ngOnInitStartup: createWorkspaceShellLifecycleNgOnInitOptions({',
    );
    expect(surfaceSource).toContain(
      'sidebarToolsLazyLoad: options.toolControllers.sidebarToolsLazyLoad',
    );
    expect(componentSource).not.toContain(
      'private readonly interactionLifecycle =',
    );
    expect(componentSource).not.toContain(
      'interactionLifecycle: this.interactionLifecycle',
    );
    expect(componentSource).not.toMatch(
      /ngOnInitStartup:\s*{\s*routeSyncController:\s*this\.routeSyncController,\s*interactionLifecycle:\s*this\.interactionLifecycle,/s,
    );
  });
});
