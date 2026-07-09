import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
  createWorkspaceShellTemplateSurface,
} from './workspace-shell-template-surface.factory';
import {
  readWorkspaceShellControllerGraphCallOptions,
  readWorkspaceShellSource,
} from './workspace-shell-source.spec-helpers';

function readWorkspaceShellStartupTemplateSurfacesSource(): string {
  return readFileSync(
    join(
      process.cwd(),
      'src/app/core/shell/workspace-shell-startup-template-surfaces.factory.ts',
    ),
    'utf8',
  );
}

function readStartupTemplateSurfacesCallOptions(callName: string): string {
  const source = readWorkspaceShellStartupTemplateSurfacesSource();
  const pattern = new RegExp(
    `${callName}\\(\\{(?<body>[\\s\\S]*?)\\n\\s{4}\\}\\)`,
    'm',
  );
  const match = source.match(pattern);
  if (!match?.groups?.body) {
    throw new Error(
      `Unable to find ${callName} options in startup template surfaces`,
    );
  }
  return match.groups.body;
}

describe('createWorkspaceShellTemplateSurface', () => {
  it('groups only the delegates needed by the WorkspaceShellComponent template', () => {
    const interaction = {
      actions: { openSettings: vi.fn() },
      sidebarResize: { isResizingAny: vi.fn() },
      touchGestures: { onMainTouchStart: vi.fn() },
    };
    const modalActions = { isLoading: vi.fn() };
    const toolBindings = {
      blackBoxRecorderComponent: vi.fn(),
      blackBoxRecorderOutletInputs: {
        appearance: 'obsidian',
        onTranscribed: vi.fn(),
      },
      focusSessionTriggerComponent: vi.fn(),
    };
    const sidebarTools = { onToolsIntent: vi.fn() };
    const androidWidgetLazyLoad = { continueManualCallback: vi.fn() };
    const pendingAndroidWidgetManualCallback = vi.fn();
    const authCoord = {
      bootstrapFailed: vi.fn(),
      isCheckingSession: vi.fn(),
      sessionEmail: vi.fn(),
    };
    const focusSyncControllers = {
      mountState: {
        shouldMountDeferredSyncStatus: vi.fn(),
        shouldMountFocusMode: vi.fn(),
      },
    };
    const uiState = {
      isMobile: vi.fn(),
      sidebarOpen: vi.fn(),
    };
    const projectState = {
      activeProjectId: vi.fn(),
      deletedTasks: vi.fn(),
      projects: vi.fn(),
    };
    const projectCoord = {
      expandedProjectId: vi.fn(),
      isDeleting: vi.fn(),
      isEditingDescription: vi.fn(),
      renameProjectName: vi.fn(),
      renamingProjectId: vi.fn(),
    };
    const supabaseClient = {
      configurationError: vi.fn(),
    };
    const userSession = {
      currentUserId: vi.fn(),
    };
    const syncCoordinator = {
      offlineMode: vi.fn(),
      sessionExpired: vi.fn(),
    };
    const derivedUiState = {
      showLoginRequired: vi.fn(),
    };
    const chrome = {
      floatingNoticeChrome: {
        installPromptTop: vi.fn(),
      },
      focusChrome: {
        mobileSidebarBackdropVisible: vi.fn(),
      },
    };
    const focusPrefs = {
      isBlackBoxEnabled: vi.fn(),
    };
    const searchDelegates = {
      searchLazyLoad: {
        filteredProjects: vi.fn(),
        searchResults: vi.fn(),
      },
      unifiedSearchQuery: vi.fn(),
    };
    const expectedStateDependencies = {
      authCoord: {
        bootstrapFailed: authCoord.bootstrapFailed,
        isCheckingSession: authCoord.isCheckingSession,
        sessionEmail: authCoord.sessionEmail,
      },
      focusSyncControllers,
      isMobile: uiState.isMobile,
      projectState,
      projectCoord,
      supabaseClient,
      userSession,
      syncCoordinator,
      derivedUiState,
      floatingNoticeChrome: chrome.floatingNoticeChrome,
      focusChrome: chrome.focusChrome,
      focusPrefs,
      isSidebarOpen: uiState.sidebarOpen,
      searchLazyLoad: searchDelegates.searchLazyLoad,
      unifiedSearchQuery: searchDelegates.unifiedSearchQuery,
    };

    const interactionSurface = {
      interaction,
      modalLazyLoad: { actions: modalActions },
    };

    const surface = createWorkspaceShellTemplateSurface({
      interactionSurface,
      startupEntryControllers: {
        androidWidgetLazyLoad,
        pendingAndroidWidgetManualCallback,
      },
      authCoord,
      chrome,
      derivedUiState,
      focusPrefs,
      focusSyncControllers,
      projectCoord,
      projectState,
      searchDelegates,
      supabaseClient,
      syncCoordinator,
      uiState,
      userSession,
      toolControllers: {
        sidebarToolsLazyLoad: sidebarTools,
        toolTemplateBindings: toolBindings,
      },
    } as never);

    expect(surface).toEqual({
      interaction,
      modal: { actions: modalActions },
      startup: {
        androidWidgetLazyLoad,
        pendingAndroidWidgetManualCallback,
      },
      state: {
        activeProjectId: expectedStateDependencies.projectState.activeProjectId,
        authCoord: expectedStateDependencies.authCoord,
        currentUserId: expectedStateDependencies.userSession.currentUserId,
        deletedTasks: expectedStateDependencies.projectState.deletedTasks,
        derivedUiState: expectedStateDependencies.derivedUiState,
        floatingNoticeChrome: expectedStateDependencies.floatingNoticeChrome,
        focusSyncControllers: expectedStateDependencies.focusSyncControllers,
        focusChrome: expectedStateDependencies.focusChrome,
        focusPrefs: expectedStateDependencies.focusPrefs,
        isMobile: expectedStateDependencies.isMobile,
        isSidebarOpen: expectedStateDependencies.isSidebarOpen,
        offlineMode: expectedStateDependencies.syncCoordinator.offlineMode,
        projectCoord: expectedStateDependencies.projectCoord,
        projects: expectedStateDependencies.projectState.projects,
        searchLazyLoad: expectedStateDependencies.searchLazyLoad,
        sessionExpired: expectedStateDependencies.syncCoordinator.sessionExpired,
        supabaseClient: expectedStateDependencies.supabaseClient,
        unifiedSearchQuery: expectedStateDependencies.unifiedSearchQuery,
      },
      tools: {
        bindings: toolBindings,
        sidebar: sidebarTools,
      },
    });
    expect(Object.keys(surface).sort()).toEqual([
      'interaction',
      'modal',
      'startup',
      'state',
      'tools',
    ]);
    expect(surface).not.toHaveProperty('lifecycle');
    expect(surface).not.toHaveProperty('modalCallbacks');
    expect(surface).not.toHaveProperty('toolLazyLoad');
  });

  it('keeps interaction and modal lazy-load extraction out of WorkspaceShellComponent', () => {
    const source = readWorkspaceShellSource();
    const startupTemplateOptions = readWorkspaceShellControllerGraphCallOptions(
      'createWorkspaceShellStartupTemplateSurfaces',
    );
    const templateOptions = readStartupTemplateSurfacesCallOptions(
      'createWorkspaceShellTemplateSurface',
    );

    expect(startupTemplateOptions).toContain('...interaction');
    expect(templateOptions).toContain('...options');
    expect(templateOptions).toContain('startupEntryControllers');
    expect(source).not.toContain('private readonly interaction = this.interactionSurface.interaction;');
    expect(source).not.toContain('private readonly modalLazyLoad = this.interactionSurface.modalLazyLoad;');
  });

  it('moves sidebar search and chrome template state behind the template surface', () => {
    const source = readWorkspaceShellSource();
    const startupTemplateOptions = readWorkspaceShellControllerGraphCallOptions(
      'createWorkspaceShellStartupTemplateSurfaces',
    );
    const templateOptions = readStartupTemplateSurfacesCallOptions(
      'createWorkspaceShellTemplateSurface',
    );

    expect(source).not.toContain('private readonly templateStateDependencies =');
    expect(source).not.toContain('state: this.templateStateDependencies');
    expect(startupTemplateOptions).toContain('...context');
    expect(startupTemplateOptions).toContain('...sessionRouting');
    expect(startupTemplateOptions).toContain('...interaction');
    expect(templateOptions).toContain('...options');
    expect(source).not.toContain('private readonly templateState =');
    expect(source).not.toContain('createWorkspaceShellTemplateState({');
    expect(source).not.toContain('readonly unifiedSearchQuery = this.searchDelegates.unifiedSearchQuery;');
    expect(source).not.toContain('readonly modalLoading = this.derivedUiState.modalLoading;');
  });

  it('keeps the template surface out of the component public API', () => {
    const source = readWorkspaceShellSource();
    const startupTemplateSurfacesSource =
      readWorkspaceShellStartupTemplateSurfacesSource();

    expect(startupTemplateSurfacesSource).toContain(
      'createWorkspaceShellTemplateSurface({',
    );
    expect(source).toContain('protected readonly template = this.shellGraph.template');
    expect(source).not.toMatch(/\n\s{2}readonly template = createWorkspaceShellTemplateSurface\{/);
  });
});
