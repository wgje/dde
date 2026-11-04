import { describe, expect, it, vi } from 'vitest';

import {
  createWorkspaceShellStartupEntryDelegates,
  type WorkspaceShellStartupEntryDelegatesOptions,
} from './workspace-shell-startup-entry-delegates.factory';
import type {
  WorkspaceShellStartupEntryControllers,
  WorkspaceShellStartupEntryControllersFactoryOptions,
} from './workspace-shell-startup-entry-controllers.factory';
import type { WorkspaceShellAndroidWidgetLazyLoadDelegate } from './workspace-shell-android-widget-lazy-load-delegate.factory';
import type {
  WorkspaceShellMobileRootStartupNavigationController,
  WorkspaceShellMobileRootStartupNavigationControllerOptions,
} from './workspace-shell-mobile-root-startup-navigation.controller';
import type {
  WorkspaceShellStartupEntryIntentControllerLike,
} from './workspace-shell-startup-entry-intent.factory';

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
    resolveConsumedStartupEntryNavigation: vi.fn(() => ['/projects', 'project-1', 'text']),
    sync: vi.fn(),
    teardown: vi.fn(),
  };
}

function createMobileRootNavigation(): WorkspaceShellMobileRootStartupNavigationController {
  return {
    navigateRootStartupToTextProject: vi.fn(),
    resolveMobileRootStartupProjectId: vi.fn(() => 'project-1'),
    resolveStartupProjectFallbackId: vi.fn(() => 'project-1'),
    shouldNavigateRootStartupToTextProject: vi.fn(() => true),
  } as unknown as WorkspaceShellMobileRootStartupNavigationController;
}

function createOptions(
  overrides: Partial<WorkspaceShellStartupEntryDelegatesOptions> = {},
): WorkspaceShellStartupEntryDelegatesOptions {
  return {
    activeProjectId: () => null,
    beforeUnloadManager: {} as never,
    completeAndroidBootstrap: vi.fn(),
    focusPrefs: {
      isBlackBoxEnabled: vi.fn(() => true),
    },
    isApplicationReady: () => true,
    isMobile: () => true,
    isSessionInitialized: () => true,
    logger: {} as never,
    router: {
      navigate: vi.fn(),
    },
    primeWidgetWorkspaceGateSync: vi.fn(),
    projects: () => [{ id: 'project-1' }],
    recheckGate: vi.fn(),
    refreshFocusSessionFromCloud: vi.fn(),
    routeState: {
      routeUrl: () => '/',
    },
    sidebarOpen: {
      set: vi.fn(),
    },
    sidebarToolsLazyLoad: {
      loadBlackBoxRecorderComponent: vi.fn().mockResolvedValue(null),
      onToolsIntent: vi.fn(),
      preload: vi.fn(),
    },
    startupLaunchSnapshot: () => null,
    toast: {
      warning: vi.fn(),
    },
    userSession: {
      currentUserId: () => 'user-1',
    },
    widgetGateMutation: {
      apply: vi.fn(),
    },
    warn: vi.fn(),
    createAndroidWidgetLazyLoadController: createAndroidWidget,
    createStartupEntryIntentController: createStartupEntryController,
    createMobileRootStartupNavigation: createMobileRootNavigation,
    ...overrides,
  };
}

describe('createWorkspaceShellStartupEntryDelegates', () => {
  it('emits the panel tools intent after the lazy sidebar intent', () => {
    const panelToolsIntent = {
      register: vi.fn(),
      emit: vi.fn(),
    };
    const sidebarToolsLazyLoad = {
      loadBlackBoxRecorderComponent: vi.fn().mockResolvedValue(null),
      onToolsIntent: vi.fn(),
      preload: vi.fn(),
    };
    let controllerOptions!: WorkspaceShellStartupEntryControllersFactoryOptions;
    const controllers = {} as WorkspaceShellStartupEntryControllers;

    createWorkspaceShellStartupEntryDelegates(createOptions({
      createStartupEntryControllers: (options) => {
        controllerOptions = options;
        return controllers;
      },
      panelToolsIntent,
      sidebarToolsLazyLoad,
    }));

    controllerOptions.activateSidebarTools?.();

    expect(sidebarToolsLazyLoad.onToolsIntent).toHaveBeenCalledTimes(1);
    expect(panelToolsIntent.emit).toHaveBeenCalledTimes(1);
  });

  it('adapts mobile root startup navigation through the shared router navigate callback', () => {
    let mobileOptions!: WorkspaceShellMobileRootStartupNavigationControllerOptions;
    const router = {
      navigate: vi.fn(),
    };

    createWorkspaceShellStartupEntryDelegates(createOptions({
      createMobileRootStartupNavigation: (options) => {
        mobileOptions = options;
        return createMobileRootNavigation();
      },
      router,
    }));

    void mobileOptions.navigateToTextProject('project-1');

    expect(router.navigate).toHaveBeenCalledWith(
      ['/projects', 'project-1', 'text'],
      {
        replaceUrl: true,
        queryParamsHandling: 'preserve',
      },
    );
  });

  it('adapts shell services into startup entry controller options', async () => {
    let controllerOptions!: WorkspaceShellStartupEntryControllersFactoryOptions;
    const focusPrefs = {
      isBlackBoxEnabled: vi.fn(() => true),
    };
    const router = {
      navigate: vi.fn(),
    };
    const sidebarOpen = {
      set: vi.fn(),
    };
    const sidebarToolsLazyLoad = {
      loadBlackBoxRecorderComponent: vi.fn().mockResolvedValue('loaded'),
      onToolsIntent: vi.fn(),
      preload: vi.fn(),
    };
    const toast = {
      warning: vi.fn(),
    };
    const widgetGateMutation = {
      apply: vi.fn(),
    };
    const controllers = {
      androidWidgetLazyLoad: createAndroidWidget(),
      deferredStartupEntryIntent: vi.fn(),
      mobileRootStartupNavigation: createMobileRootNavigation(),
      pendingAndroidWidgetBootstrap: vi.fn(),
      pendingAndroidWidgetManualCallback: vi.fn(),
      startupEntryIntentController: createStartupEntryController(),
      startupEntryIntentResolver: vi.fn(() => null),
    } as unknown as WorkspaceShellStartupEntryControllers;

    createWorkspaceShellStartupEntryDelegates(createOptions({
      createStartupEntryControllers: (options) => {
        controllerOptions = options;
        return controllers;
      },
      focusPrefs,
      router,
      sidebarOpen,
      sidebarToolsLazyLoad,
      toast,
      widgetGateMutation,
    }));

    expect(controllerOptions.routeUrl()).toBe('/');
    expect(controllerOptions.currentUserId()).toBe('user-1');
    expect(controllerOptions.isBlackBoxEnabled()).toBe(true);
    controllerOptions.setSidebarOpen(true);
    controllerOptions.activateSidebarTools?.();
    controllerOptions.preloadSidebarTools('intent');
    await controllerOptions.loadBlackBoxRecorder();
    controllerOptions.applyWidgetGateMutation({ intent: 'mark-gate-read', widgetGateEntryId: null });
    void controllerOptions.navigate(['/projects'], { replaceUrl: true });
    controllerOptions.warningToast('启动入口', '跳过');

    expect(focusPrefs.isBlackBoxEnabled).toHaveBeenCalledTimes(1);
    expect(sidebarOpen.set).toHaveBeenCalledWith(true);
    expect(sidebarToolsLazyLoad.onToolsIntent).toHaveBeenCalledTimes(1);
    expect(sidebarToolsLazyLoad.preload).toHaveBeenCalledWith('intent');
    expect(sidebarToolsLazyLoad.loadBlackBoxRecorderComponent).toHaveBeenCalledOnce();
    expect(widgetGateMutation.apply).toHaveBeenCalledWith({
      intent: 'mark-gate-read',
      widgetGateEntryId: null,
    });
    expect(router.navigate).toHaveBeenCalledWith(['/projects'], { replaceUrl: true });
    expect(toast.warning).toHaveBeenCalledWith('启动入口', '跳过');
  });
});
