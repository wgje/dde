import { describe, expect, it, vi } from 'vitest';
import type { WritableSignal } from '@angular/core';

import {
  createWorkspaceShellStartupEntryControllers,
  type WorkspaceShellStartupEntryControllersFactoryOptions,
} from './workspace-shell-startup-entry-controllers.factory';
import type { WorkspaceShellAndroidWidgetLazyLoadDelegate } from './workspace-shell-android-widget-lazy-load-delegate.factory';
import type { WorkspaceShellAndroidWidgetLazyLoadFactoryOptions } from './workspace-shell-android-widget-lazy-load.factory';
import type {
  WorkspaceShellMobileRootStartupNavigationController,
  WorkspaceShellMobileRootStartupNavigationControllerOptions,
} from './workspace-shell-mobile-root-startup-navigation.controller';
import type {
  WorkspaceShellStartupEntryIntentControllerLike,
  WorkspaceShellStartupEntryIntentFactoryOptions,
} from './workspace-shell-startup-entry-intent.factory';
import type { AndroidWidgetBootstrapCallbackResult } from '../../../services/widget-binding.service';
import type {
  AndroidWidgetBootstrapRequest,
  StartupEntryIntent,
} from '../../../utils/startup-entry-intent';

const BOOTSTRAP_REQUEST: AndroidWidgetBootstrapRequest = {
  bootstrapNonce: 'bootstrap-nonce',
  callbackUri: 'nanoflow-widget://bootstrap',
  clientVersion: null,
  deviceId: 'device-1',
  deviceSecret: 'secret',
  hostInstanceId: 'host-1',
  installationId: 'installation-1',
  instanceId: 'instance-1',
  pendingPushToken: null,
  sizeBucket: '4x2',
};

const CALLBACK_RESULT = {} as AndroidWidgetBootstrapCallbackResult;

const STARTUP_ENTRY_INTENT: StartupEntryIntent = {
  entry: 'widget',
  intent: 'open-focus-tools',
  rawIntent: 'open-focus-tools',
  widgetGateEntryId: null,
};

function createAndroidWidget(): WorkspaceShellAndroidWidgetLazyLoadDelegate {
  return {
    captureFromRoute: vi.fn(),
    complete: vi.fn(),
    continueManualCallback: vi.fn(),
    dismissManualCallback: vi.fn(),
    persistDeferredStartupEntryIntent: vi.fn(),
    persistPendingBootstrap: vi.fn(),
    restoreAll: vi.fn(),
    syncProcessing: vi.fn(),
    teardown: vi.fn(),
    useIntentFallback: vi.fn(),
  };
}

function createStartupEntryController(): WorkspaceShellStartupEntryIntentControllerLike {
  return {
    flushWidgetWorkspaceGateRecheck: vi.fn(),
    resetPrimeState: vi.fn(),
    resolveConsumedStartupEntryNavigation: vi.fn(() => ['/projects', 'mobile-root', 'text']),
    sync: vi.fn(),
    teardown: vi.fn(),
  };
}

function createMobileRootNavigation(): WorkspaceShellMobileRootStartupNavigationController {
  return {
    navigateRootStartupToTextProject: vi.fn(),
    resolveMobileRootStartupProjectId: vi.fn(() => 'mobile-root'),
    resolveStartupProjectFallbackId: vi.fn(() => 'fallback-project'),
    shouldNavigateRootStartupToTextProject: vi.fn(() => true),
  } as unknown as WorkspaceShellMobileRootStartupNavigationController;
}

function createOptions(
  overrides: Partial<WorkspaceShellStartupEntryControllersFactoryOptions> = {},
): WorkspaceShellStartupEntryControllersFactoryOptions {
  return {
    activeProjectId: () => null,
    applyWidgetGateMutation: vi.fn(),
    beforeUnloadManager: {} as never,
    completeAndroidBootstrap: vi.fn(),
    currentUserId: () => 'user-1',
    isApplicationReady: () => true,
    isBlackBoxEnabled: () => true,
    isMobile: () => true,
    isSessionInitialized: () => true,
    loadBlackBoxRecorder: vi.fn(),
    logger: {} as never,
    navigate: vi.fn(),
    navigateToTextProject: vi.fn(),
    preloadSidebarTools: vi.fn(),
    primeWidgetWorkspaceGateSync: vi.fn(),
    projects: () => [{ id: 'project-1' }],
    recheckGate: vi.fn(),
    refreshFocusSessionFromCloud: vi.fn(),
    routeUrl: () => '/projects/project-1/text?entry=shortcut&intent=open-focus-tools',
    setSidebarOpen: vi.fn(),
    startupLaunchSnapshot: () => null,
    warningToast: vi.fn(),
    warn: vi.fn(),
    ...overrides,
  };
}

describe('createWorkspaceShellStartupEntryControllers', () => {
  it('creates the shared Android widget and startup entry signals outside WorkspaceShellComponent', () => {
    let androidOptions!: WorkspaceShellAndroidWidgetLazyLoadFactoryOptions;
    let startupOptions!: WorkspaceShellStartupEntryIntentFactoryOptions;
    const androidWidget = createAndroidWidget();
    const startupEntryController = createStartupEntryController();
    const mobileRootNavigation = createMobileRootNavigation();

    const controllers = createWorkspaceShellStartupEntryControllers(createOptions({
      createAndroidWidgetLazyLoadController: (options) => {
        androidOptions = options;
        return androidWidget;
      },
      createMobileRootStartupNavigation: (options) => {
        expect(options.startupEntryIntent()).toEqual({
          androidWidgetBootstrap: undefined,
          entry: 'shortcut',
          intent: 'open-focus-tools',
          rawIntent: 'open-focus-tools',
          widgetGateEntryId: null,
        });
        return mobileRootNavigation;
      },
      createStartupEntryIntentController: (options) => {
        startupOptions = options;
        return startupEntryController;
      },
    }));

    androidOptions.pendingBootstrap.set(BOOTSTRAP_REQUEST);
    androidOptions.pendingCallback.set(CALLBACK_RESULT);
    androidOptions.deferredStartupEntryIntent.set(STARTUP_ENTRY_INTENT);

    expect(controllers.pendingAndroidWidgetBootstrap()).toBe(BOOTSTRAP_REQUEST);
    expect(controllers.pendingAndroidWidgetManualCallback()).toBe(CALLBACK_RESULT);
    expect(controllers.deferredStartupEntryIntent()).toBe(STARTUP_ENTRY_INTENT);
    expect(controllers.startupEntryIntentResolver()?.intent).toBe('open-focus-tools');

    expect(startupOptions.deferredStartupEntryIntent).toBe(
      controllers.deferredStartupEntryIntent as WritableSignal<StartupEntryIntent | null>,
    );
    expect(startupOptions.resolveMobileRootProjectId()).toBe('mobile-root');
    startupOptions.persistDeferredStartupEntryIntent(STARTUP_ENTRY_INTENT);
    expect(androidWidget.persistDeferredStartupEntryIntent).toHaveBeenCalledWith(STARTUP_ENTRY_INTENT);

    expect(androidOptions.resolveConsumedStartupEntryNavigation()).toEqual([
      '/projects',
      'mobile-root',
      'text',
    ]);
  });

  it('preserves the mobile root text navigation callback shape', () => {
    let mobileOptions!: WorkspaceShellMobileRootStartupNavigationControllerOptions;
    const navigateToTextProject = vi.fn();

    createWorkspaceShellStartupEntryControllers(createOptions({
      createAndroidWidgetLazyLoadController: createAndroidWidget,
      createMobileRootStartupNavigation: (options) => {
        mobileOptions = options;
        return createMobileRootNavigation();
      },
      createStartupEntryIntentController: createStartupEntryController,
      navigateToTextProject,
    }));

    void mobileOptions.navigateToTextProject('project-1');

    expect(navigateToTextProject).toHaveBeenCalledWith('project-1');
  });
});
