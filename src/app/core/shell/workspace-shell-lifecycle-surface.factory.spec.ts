import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import type {
  WorkspaceShellLifecycleDelegates,
  WorkspaceShellLifecycleDelegatesOptions,
} from './workspace-shell-lifecycle-delegates.factory';
import {
  readCallOptionsFromSource,
  readWorkspaceShellControllerGraphSource,
  readWorkspaceShellSource,
} from './workspace-shell-source.spec-helpers';

async function loadFactory(): Promise<{
  createWorkspaceShellLifecycleSurface?: (
    options: Record<string, unknown>,
  ) => WorkspaceShellLifecycleDelegates<unknown>;
}> {
  const modulePath = './workspace-shell-lifecycle-surface.factory';
  const module = await import(/* @vite-ignore */ modulePath)
    .catch(() => ({}));

  return module as {
    createWorkspaceShellLifecycleSurface?: (
      options: Record<string, unknown>,
    ) => WorkspaceShellLifecycleDelegates<unknown>;
  };
}

function createLifecycleDelegates(): WorkspaceShellLifecycleDelegates<unknown> {
  return {
    afterViewInit: { initialize: vi.fn() },
    destroyController: {
      destroy: vi.fn(),
    } as unknown as WorkspaceShellLifecycleDelegates<unknown>['destroyController'],
    ngOnInitStartup: { initialize: vi.fn(), teardown: vi.fn() },
    startupBootstrap: { initialize: vi.fn(), teardown: vi.fn() },
  };
}

describe('workspace shell lifecycle surface', () => {
  it('builds shell lifecycle delegates from shell dependencies in one factory call', async () => {
    const { createWorkspaceShellLifecycleSurface } = await loadFactory();

    expect(createWorkspaceShellLifecycleSurface).toEqual(expect.any(Function));

    let mappedOptions!: WorkspaceShellLifecycleDelegatesOptions<unknown>;
    const lifecycleDelegates = createLifecycleDelegates();
    const injector = { get: vi.fn() };
    const destroyed = vi.fn(() => false);
    const warn = vi.fn();
    const toast = { warning: vi.fn() };
    const interactionSurface = {
      interactionLifecycle: {
        cleanupViewportStage: vi.fn(),
        setupNgOnInitStage: vi.fn(),
        teardownDestroyStage: vi.fn(),
      },
      modalCallbacks: { createCallbacks: vi.fn(() => ({})) },
    };
    const startupEntryControllers = {
      androidWidgetLazyLoad: {
        restoreAll: vi.fn(),
        teardown: vi.fn(),
      },
      startupEntryIntentController: { teardown: vi.fn() },
    };
    const toolControllers = {
      sidebarToolsLazyLoad: {
        preload: vi.fn(),
        scheduleFocusModePreload: vi.fn(),
      },
      toolLazyLoad: { teardown: vi.fn() },
    };
    const handoffControllers = {
      readiness: { signalWorkspaceHandoffReady: vi.fn() },
    };
    const beforeUnloadController = { cleanup: vi.fn(), setup: vi.fn() };
    const sessionTransition = { cleanup: vi.fn() };
    const uiState = {
      isMobile: vi.fn(() => false),
      sidebarOpen: { set: vi.fn(), update: vi.fn() },
    };
    const routing = {
      routeSyncController: { cleanup: vi.fn(), setupRouteSync: vi.fn() },
    };
    const focusSyncControllers = {
      focusMountIntent: { setup: vi.fn(), teardown: vi.fn() },
      mobileFocusGate: { warmMobileProjectGateSnapshot: vi.fn() },
      syncPulseLifecycle: {
        clearFocusEntrySyncPulseRetry: vi.fn(),
        destroy: vi.fn(),
      },
    };
    let conflictListener: ((event: unknown) => void) | undefined;
    const conflictSubscription = { unsubscribe: vi.fn() };
    const syncCoordinator = {
      initialize: vi.fn(),
      onConflict$: {
        subscribe: vi.fn((listener: (event: unknown) => void) => {
          conflictListener = listener;
          return conflictSubscription;
        }),
      },
    };
    const sidebarToggleEvent = { cleanup: vi.fn(), setup: vi.fn() };
    const createSidebarToggleEventController = vi.fn(() => sidebarToggleEvent);
    const modalCoord = {
      clearCallbacks: vi.fn(),
      initCallbacks: vi.fn(),
      openConflictModal: vi.fn(),
      preloadCommonModals: vi.fn(),
      setPendingConflict: vi.fn(),
    };

    const result = createWorkspaceShellLifecycleSurface?.({
      injector,
      destroyed,
      warn,
      appLifecycle: { initialize: vi.fn() },
      authCoord: { scheduleSessionBootstrap: vi.fn() },
      focusSyncControllers,
      handoffControllers,
      interactionSurface,
      routing,
      uiState,
      lazyServiceRefs: { simpleSync: { startRuntime: vi.fn() } },
      markDestroyed: vi.fn(),
      modalCoord,
      projectSubscription: { clear: vi.fn() },
      remoteCallbackTeardown: { teardown: vi.fn() },
      searchDelegates: {
        searchController: { cleanup: vi.fn() },
      },
      sessionExitSurface: { beforeUnloadController },
      sessionLaunchControllers: { sessionTransition },
      signalEffects: { setup: vi.fn(), teardown: vi.fn() },
      startupEntryControllers,
      startupTier: {
        destroy: vi.fn(),
        initialize: vi.fn(),
        isTierReady: vi.fn((tier: 'p1' | 'p2') => tier === 'p1'),
      },
      storageEscape: { setup: vi.fn(), teardown: vi.fn() },
      syncCoordinator,
      toast,
      toolControllers,
      undoService: { flushPendingAction: vi.fn() },
      userSession: { prehydrateFromSnapshot: vi.fn() },
      createSidebarToggleEventController,
      createLifecycleDelegates: (
        options: WorkspaceShellLifecycleDelegatesOptions<unknown>,
      ) => {
        mappedOptions = options;
        return lifecycleDelegates;
      },
    });

    expect(result).toBe(lifecycleDelegates);
    expect(createSidebarToggleEventController).toHaveBeenCalledWith({
      isSidebarOpen: uiState.sidebarOpen,
    });
    expect(mappedOptions.flowPrewarm).toEqual({
      isDestroyed: destroyed,
      gateScheduledPrewarm: expect.any(Function),
      warn,
    });
    expect(mappedOptions.lazyLifecycles).toEqual({
      injector,
      runtime: { destroyed },
      warn,
    });
    expect(mappedOptions.startupBootstrap).toEqual(
      expect.objectContaining({
        androidWidgetLazyLoad: startupEntryControllers.androidWidgetLazyLoad,
        beforeUnloadController,
        isMobile: uiState.isMobile,
        modalCallbacks: interactionSurface.modalCallbacks,
        sidebarToggleEvent,
      }),
    );
    expect(mappedOptions.startupBootstrap.conflictHandler).toEqual(
      expect.objectContaining({
        cleanup: expect.any(Function),
        setup: expect.any(Function),
      }),
    );
    mappedOptions.startupBootstrap.conflictHandler.setup();
    expect(syncCoordinator.onConflict$.subscribe).toHaveBeenCalledWith(
      expect.any(Function),
    );

    const conflictEvent = { id: 'conflict-1' };
    conflictListener?.(conflictEvent);
    expect(modalCoord.setPendingConflict).toHaveBeenCalledWith(conflictEvent);
    expect(modalCoord.openConflictModal).toHaveBeenCalledWith(conflictEvent);

    mappedOptions.startupBootstrap.conflictHandler.cleanup();
    expect(conflictSubscription.unsubscribe).toHaveBeenCalledTimes(1);
    expect(mappedOptions.afterViewInit).toEqual({
      handoffReadiness: handoffControllers.readiness,
    });
    expect(mappedOptions.ngOnInitStartup).toEqual(
      expect.objectContaining({
        focusMountIntent: focusSyncControllers.focusMountIntent,
        interactionLifecycle: interactionSurface.interactionLifecycle,
        mobileFocusGate: focusSyncControllers.mobileFocusGate,
        criticalFeatureFlags: { toast, warn },
        routeSyncController: routing.routeSyncController,
        sidebarToolsLazyLoad: toolControllers.sidebarToolsLazyLoad,
      }),
    );
    expect(mappedOptions.destroyController).toEqual(
      expect.objectContaining({
        beforeUnloadController,
        searchController: expect.anything(),
        sessionTransitionCleanup: sessionTransition,
        startupEntryIntent:
          startupEntryControllers.startupEntryIntentController,
        syncPulseLifecycle: focusSyncControllers.syncPulseLifecycle,
        toolLazyLoad: toolControllers.toolLazyLoad,
      }),
    );
  });

  it('keeps shell lifecycle option orchestration outside WorkspaceShellComponent', () => {
    const source = readWorkspaceShellSource();
    const graphSource = readWorkspaceShellControllerGraphSource();
    const lifecycleGraphSource = readFileSync(
      join(
        process.cwd(),
        'src/app/core/shell/workspace-shell-lifecycle-graph.factory.ts',
      ),
      'utf8',
    );
    const lifecycleSurfaceCall = readCallOptionsFromSource(
      lifecycleGraphSource,
      'createWorkspaceShellLifecycleSurface',
      'lifecycle graph',
    );

    expect(graphSource).toContain('createWorkspaceShellLifecycleGraph');
    expect(graphSource).not.toContain('createWorkspaceShellLifecycleSurface');
    expect(lifecycleGraphSource).toContain('createWorkspaceShellLifecycleSurface');
    expect(source).not.toContain('createWorkspaceShellLifecycleStartupOptions');
    expect(source).not.toContain('createWorkspaceShellLifecycleStartupBootstrapOptions');
    expect(source).not.toContain('createWorkspaceShellLifecycleAfterViewInitOptions');
    expect(source).not.toContain('createWorkspaceShellLifecycleNgOnInitOptions');
    expect(source).not.toContain('createWorkspaceShellLifecycleDestroyOptions');
    expect(source).not.toContain('private readonly lifecycleStartupOptions');
    expect(source).not.toContain('private readonly lifecycleStartupBootstrapOptions');
    expect(source).not.toContain('private readonly lifecycleAfterViewInitOptions');
    expect(source).not.toContain('private readonly lifecycleNgOnInitOptions');
    expect(source).not.toContain('private readonly lifecycleDestroyOptions');
    expect(source).not.toContain('private readonly sidebarToggleEvent =');
    expect(source).not.toContain('sidebarToggleEvent: this.sidebarToggleEvent');
    expect(source).not.toContain('createWorkspaceShellLifecycleDelegates({');
    expect(lifecycleSurfaceCall).toContain('...options');
    expect(lifecycleSurfaceCall).toContain('...sessionLifecycle');
    expect(lifecycleSurfaceCall).toContain('destroyed: options.runtime');
    expect(lifecycleSurfaceCall).toContain('markDestroyed: options.markDestroyed');
    expect(lifecycleSurfaceCall).not.toContain('criticalFeatureFlags: {');
    expect(lifecycleSurfaceCall).not.toContain(
      'routeSyncController: this.routing.routeSyncController',
    );
    expect(lifecycleSurfaceCall).not.toContain(
      'isMobile: () => this.uiState.isMobile()',
    );
    expect(lifecycleSurfaceCall).not.toContain(
      'isSidebarOpen: this.uiState.sidebarOpen',
    );
    expect(lifecycleSurfaceCall).not.toContain(
      'focusMountIntent: this.focusSyncControllers.focusMountIntent',
    );
    expect(lifecycleSurfaceCall).not.toContain(
      'mobileFocusGate: this.focusSyncControllers.mobileFocusGate',
    );
    expect(lifecycleSurfaceCall).not.toContain(
      'syncPulseLifecycle: this.focusSyncControllers.syncPulseLifecycle',
    );
  });
});
