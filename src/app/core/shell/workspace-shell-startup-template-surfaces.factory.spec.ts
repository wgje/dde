import { describe, expect, it, vi } from 'vitest';

import type {
  WorkspaceShellStartupEntryControllers,
  WorkspaceShellStartupEntryControllersFactoryOptions,
} from './workspace-shell-startup-entry-controllers.factory';
import {
  createWorkspaceShellStartupTemplateSurfaces,
} from './workspace-shell-startup-template-surfaces.factory';

describe('createWorkspaceShellStartupTemplateSurfaces', () => {
  it('registers startup entry controllers and builds the template from them', () => {
    const androidWidgetLazyLoad = { continueManualCallback: vi.fn() };
    const pendingAndroidWidgetManualCallback = vi.fn();
    const startupEntryControllers = {
      androidWidgetLazyLoad,
      pendingAndroidWidgetManualCallback,
    } as unknown as WorkspaceShellStartupEntryControllers;
    const createStartupEntryControllers = vi.fn(
      (_options: WorkspaceShellStartupEntryControllersFactoryOptions) =>
        startupEntryControllers,
    );
    const registerStartupEntryControllers = vi.fn();
    const interaction = { actions: { openSettings: vi.fn() } };
    const modalActions = { isLoading: vi.fn() };
    const toolTemplateBindings = {
      blackBoxRecorderComponent: vi.fn(),
      blackBoxRecorderOutletInputs: {
        appearance: 'obsidian',
        onTranscribed: vi.fn(),
      },
      focusSessionTriggerComponent: vi.fn(),
    };
    const sidebarToolsLazyLoad = {
      loadBlackBoxRecorderComponent: vi.fn().mockResolvedValue(null),
      onToolsIntent: vi.fn(),
      preload: vi.fn(),
    };

    const surface = createWorkspaceShellStartupTemplateSurfaces({
      routing: {
        routeUrl: vi.fn(() => '/projects/project-1/text'),
        router: { navigate: vi.fn() },
      },
      uiState: {
        isMobile: vi.fn(() => false),
        sidebarOpen: { set: vi.fn() },
      },
      projectState: {
        activeProjectId: vi.fn(() => 'project-1'),
        deletedTasks: vi.fn(),
        projects: vi.fn(() => []),
      },
      launchSnapshotSurface: { startupLaunchSnapshot: vi.fn(() => null) },
      userSession: { currentUserId: vi.fn(() => 'user-1') },
      bootStage: { isApplicationReady: vi.fn(() => true) },
      focusPrefs: { isBlackBoxEnabled: vi.fn(() => false) },
      toolControllers: {
        sidebarToolsLazyLoad,
        toolTemplateBindings,
        widgetGateMutation: { apply: vi.fn() },
      },
      lazyServiceRefs: {
        focusStartupProbe: {
          primeWidgetWorkspaceGateSync: vi.fn(),
          recheckGate: vi.fn(),
        },
      },
      chrome: {
        dockEngine: { refreshFocusSessionFromCloud: vi.fn() },
        floatingNoticeChrome: { installPromptTop: vi.fn() },
        focusChrome: { mobileSidebarBackdropVisible: vi.fn() },
      },
      authService: { sessionInitialized: vi.fn(() => true) },
      authCoord: {
        bootstrapFailed: vi.fn(),
        isCheckingSession: vi.fn(),
        sessionEmail: vi.fn(),
      },
      widgetBinding: { completeAndroidBootstrap: vi.fn() },
      beforeUnloadManager: {},
      logger: { warn: vi.fn() },
      toast: { warning: vi.fn() },
      warn: vi.fn(),
      createStartupEntryControllers,
      interactionSurface: {
        interaction,
        modalLazyLoad: { actions: modalActions },
      },
      focusSyncControllers: {
        mountState: {
          shouldMountDeferredSyncStatus: vi.fn(),
          shouldMountFocusMode: vi.fn(),
        },
      },
      projectCoord: {
        expandedProjectId: vi.fn(),
        isDeleting: vi.fn(),
        isEditingDescription: vi.fn(),
        renameProjectName: vi.fn(),
        renamingProjectId: vi.fn(),
      },
      searchDelegates: {
        searchLazyLoad: {
          filteredProjects: vi.fn(),
          searchResults: vi.fn(),
        },
        unifiedSearchQuery: vi.fn(),
      },
      supabaseClient: { configurationError: vi.fn() },
      syncCoordinator: {
        offlineMode: vi.fn(),
        sessionExpired: vi.fn(),
      },
      derivedUiState: { showLoginRequired: vi.fn() },
      registerStartupEntryControllers,
    } as never);

    expect(createStartupEntryControllers).toHaveBeenCalledOnce();
    expect(registerStartupEntryControllers)
      .toHaveBeenCalledWith(startupEntryControllers);
    expect(surface.startupEntryControllers).toBe(startupEntryControllers);
    expect(surface.template.startup.androidWidgetLazyLoad)
      .toBe(androidWidgetLazyLoad);
    expect(surface.template.startup.pendingAndroidWidgetManualCallback)
      .toBe(pendingAndroidWidgetManualCallback);
    expect(surface.template.interaction).toBe(interaction);
    expect(surface.template.modal.actions).toBe(modalActions);
    expect(surface.template.tools.bindings).toBe(toolTemplateBindings);
    expect(surface.template.tools.sidebar).toBe(sidebarToolsLazyLoad);
  });
});
