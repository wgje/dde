import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  createWorkspaceShellLifecycleDestroyControllerOptions,
} from './workspace-shell-lifecycle-destroy-delegate.factory';
import type { WorkspaceShellFlowPrewarmDelegate } from './workspace-shell-flow-prewarm-lazy-load.controller';
import type {
  WorkspaceShellLifecycleDestroyControllerOptions,
  WorkspaceShellLifecycleLazyLifecycleGroup,
  WorkspaceShellLifecycleNgOnInitStartupOptions,
  WorkspaceShellLifecycleStartupBootstrapOptions,
} from './workspace-shell-lifecycle-delegates.factory';
import type { WorkspaceShellNgOnInitStartupControllerLike } from './workspace-shell-ng-on-init-startup.factory';
import type { WorkspaceShellStartupLazyServicesHostDelegate } from './workspace-shell-startup-lazy-services-host.controller';
import type { WorkspaceShellStartupBootstrapController } from './workspace-shell-startup-bootstrap.controller';

type DestroyNgOnInitStartupOptions = Pick<
  WorkspaceShellLifecycleNgOnInitStartupOptions,
  | 'focusMountIntent'
  | 'interactionLifecycle'
  | 'routeSyncController'
  | 'startupTier'
  | 'warn'
>;

type DestroyStartupBootstrapOptions = Pick<
  WorkspaceShellLifecycleStartupBootstrapOptions<unknown>,
  | 'androidWidgetLazyLoad'
  | 'beforeUnloadController'
  | 'conflictHandler'
  | 'modalCoord'
  | 'sidebarToggleEvent'
  | 'signalEffects'
  | 'storageEscape'
>;

describe('workspace shell lifecycle destroy delegate factory', () => {
  it('delegates concrete destroy controller loading to the loader boundary', () => {
    const source = readFileSync(
      join(__dirname, 'workspace-shell-lifecycle-destroy-delegate.factory.ts'),
      'utf8',
    );

    expect(source).toContain('createWorkspaceShellDestroyControllerLoader');
    expect(source).not.toContain("import('./workspace-shell-destroy-controller.factory')");
    expect(source).not.toContain('createWorkspaceShellDestroyController(options).destroy()');
    expect(source).not.toMatch(
      /import\s+(?!type\s)\{[^;]*createWorkspaceShellDestroyController[^;]*\}\s+from\s+['"]\.\/workspace-shell-destroy-controller\.factory['"]/,
    );
  });

  it('maps startup and ngOnInit delegates into destroy controller options', () => {
    const flowPrewarm = {
      scheduleAggressivePrewarm: vi.fn(),
      teardown: vi.fn(),
    } as WorkspaceShellFlowPrewarmDelegate;
    const lazyLifecycles = {
      initializeConstructorStage: vi.fn(),
      initializeNgOnInitStage: vi.fn(),
      teardownKeyboardShortcutsStage: vi.fn(),
      teardownStartupStage: vi.fn(),
    } satisfies WorkspaceShellLifecycleLazyLifecycleGroup;
    const ngOnInitStartup = {
      initialize: vi.fn(),
      teardown: vi.fn(),
    } satisfies WorkspaceShellNgOnInitStartupControllerLike;
    const startupLazyServices = {
      scheduleStartupFontInitialization: vi.fn(),
      initializeStartupDiagnosticsLazy: vi.fn(),
      teardown: vi.fn(),
    } satisfies WorkspaceShellStartupLazyServicesHostDelegate;
    const startupBootstrap = {
      initialize: vi.fn(),
      teardown: vi.fn(),
    } as Pick<WorkspaceShellStartupBootstrapController<unknown>, 'teardown'>;
    const ngOnInitWarn = vi.fn();
    const destroyControllerOptions = {
      markDestroyed: vi.fn(),
      startupEntryIntent: { teardown: vi.fn() },
      undoService: { flushPendingAction: vi.fn() },
      sessionTransitionCleanup: { cleanup: vi.fn() },
      remoteCallbackTeardown: { teardown: vi.fn() },
      toolLazyLoad: { teardown: vi.fn() },
      syncPulseLifecycle: {
        clearFocusEntrySyncPulseRetry: vi.fn(),
        destroy: vi.fn(),
      },
      projectSubscription: { clear: vi.fn() },
      searchController: { cleanup: vi.fn() },
      beforeUnloadController: { cleanup: vi.fn() },
      storageEscape: {
        setup: vi.fn(),
        teardown: vi.fn(),
      },
    } as WorkspaceShellLifecycleDestroyControllerOptions;
    const ngOnInitStartupOptions = {
      focusMountIntent: { setup: vi.fn(), teardown: vi.fn() },
      interactionLifecycle: {
        setupNgOnInitStage: vi.fn(),
        teardownDestroyStage: vi.fn(),
        cleanupViewportStage: vi.fn(),
      },
      routeSyncController: { setupRouteSync: vi.fn(), cleanup: vi.fn() },
      startupTier: { initialize: vi.fn(), destroy: vi.fn() },
      warn: ngOnInitWarn,
    } satisfies DestroyNgOnInitStartupOptions;
    const startupBootstrapOptions = {
      androidWidgetLazyLoad: { restoreAll: vi.fn(), teardown: vi.fn() },
      beforeUnloadController: { setup: vi.fn(), cleanup: vi.fn() },
      conflictHandler: { setup: vi.fn(), cleanup: vi.fn() },
      modalCoord: {
        initCallbacks: vi.fn(),
        clearCallbacks: vi.fn(),
        preloadCommonModals: vi.fn(),
      },
      sidebarToggleEvent: { setup: vi.fn(), cleanup: vi.fn() },
      signalEffects: { setup: vi.fn(), teardown: vi.fn() },
      storageEscape: {
        setup: vi.fn(),
        teardown: vi.fn(),
      },
    } satisfies DestroyStartupBootstrapOptions;

    const options = createWorkspaceShellLifecycleDestroyControllerOptions({
      destroyControllerOptions,
      flowPrewarm,
      lazyLifecycles,
      ngOnInitStartup,
      ngOnInitStartupOptions,
      startupLazyServices,
      startupBootstrap,
      startupBootstrapOptions,
    });

    expect(options).toEqual(expect.objectContaining({
      androidWidgetLazyLoad: startupBootstrapOptions.androidWidgetLazyLoad,
      conflictHandler: startupBootstrapOptions.conflictHandler,
      flowPrewarm,
      focusMountIntent: ngOnInitStartupOptions.focusMountIntent,
      interactionLifecycle: ngOnInitStartupOptions.interactionLifecycle,
      lazyLifecycles,
      modalCoord: startupBootstrapOptions.modalCoord,
      ngOnInitStartup,
      routeSyncController: ngOnInitStartupOptions.routeSyncController,
      sidebarToggleEvent: startupBootstrapOptions.sidebarToggleEvent,
      startupBootstrap,
      startupLazyServices,
      startupTier: ngOnInitStartupOptions.startupTier,
      warn: ngOnInitWarn,
    }));
  });
});
