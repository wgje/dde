import { describe, expect, it, vi } from 'vitest';

import type {
  WorkspaceShellTemplateState,
} from './workspace-shell-template-state.factory';
import {
  readWorkspaceShellControllerGraphCallOptions,
  readWorkspaceShellControllerGraphSource,
  readWorkspaceShellSource,
  readWorkspaceShellStartupTemplateSurfacesCallOptions,
  readWorkspaceShellStartupTemplateSurfacesSource,
  readWorkspaceShellTemplate,
  readWorkspaceShellTemplateSurfaceSource,
  readWorkspaceShellTemplates,
} from './workspace-shell-source.spec-helpers';

type TemplateStateFactoryModule = {
  createWorkspaceShellTemplateState?: unknown;
  createWorkspaceShellTemplateStateDependencies?: unknown;
};

async function loadTemplateStateFactoryModule(): Promise<TemplateStateFactoryModule> {
  const modulePath = './workspace-shell-template-state.factory';
  return await import(/* @vite-ignore */ modulePath) as TemplateStateFactoryModule;
}

describe('createWorkspaceShellTemplateState', () => {
  it('exposes concrete callable state handles to Angular templates', () => {
    const assertTemplateStateTypes = (state: WorkspaceShellTemplateState): void => {
      const isMobile: () => boolean = state.isMobile;
      const blockingStartupHintOverlayVisible: () => boolean =
        state.floatingNoticeChrome.blockingStartupHintOverlayVisible;
      const showLoginRequired: () => boolean =
        state.derivedUiState.showLoginRequired;

      void [isMobile, blockingStartupHintOverlayVisible, showLoginRequired];
    };

    expect(assertTemplateStateTypes).toBeTypeOf('function');
  });

  it('groups the read-side state consumed by the WorkspaceShellComponent template', async () => {
    const options = {
      authCoord: {
        bootstrapFailed: vi.fn(),
        isCheckingSession: vi.fn(),
        sessionEmail: vi.fn(),
      },
      focusSyncControllers: {
        mountState: {
          shouldMountDeferredSyncStatus: vi.fn(),
          shouldMountFocusMode: vi.fn(),
        },
      },
      isMobile: vi.fn(),
      projectState: {
        activeProjectId: vi.fn(),
        deletedTasks: vi.fn(),
        projects: vi.fn(),
      },
      projectCoord: {
        expandedProjectId: vi.fn(),
        isDeleting: vi.fn(),
        isEditingDescription: vi.fn(),
        renameProjectName: vi.fn(),
        renamingProjectId: vi.fn(),
      },
      supabaseClient: {
        configurationError: vi.fn(),
      },
      userSession: {
        currentUserId: vi.fn(),
      },
      syncCoordinator: {
        offlineMode: vi.fn(),
        sessionExpired: vi.fn(),
      },
      derivedUiState: {
        showLoginRequired: vi.fn(),
      },
      floatingNoticeChrome: {
        installPromptTop: vi.fn(),
      },
      focusChrome: {
        mobileSidebarBackdropVisible: vi.fn(),
      },
      focusPrefs: {
        isBlackBoxEnabled: vi.fn(),
      },
      isSidebarOpen: vi.fn(),
      searchLazyLoad: {
        filteredProjects: vi.fn(),
        searchResults: vi.fn(),
      },
      unifiedSearchQuery: vi.fn(),
    };
    const {
      createWorkspaceShellTemplateState,
    } = await loadTemplateStateFactoryModule();
    expect(createWorkspaceShellTemplateState).toBeTypeOf('function');
    const createTemplateState = createWorkspaceShellTemplateState as (
      fixture: typeof options
    ) => unknown;

    expect(createTemplateState(options)).toEqual({
      activeProjectId: options.projectState.activeProjectId,
      authCoord: options.authCoord,
      currentUserId: options.userSession.currentUserId,
      deletedTasks: options.projectState.deletedTasks,
      derivedUiState: options.derivedUiState,
      floatingNoticeChrome: options.floatingNoticeChrome,
      focusSyncControllers: options.focusSyncControllers,
      focusChrome: options.focusChrome,
      focusPrefs: options.focusPrefs,
      isMobile: options.isMobile,
      isSidebarOpen: options.isSidebarOpen,
      offlineMode: options.syncCoordinator.offlineMode,
      projectCoord: options.projectCoord,
      projects: options.projectState.projects,
      searchLazyLoad: options.searchLazyLoad,
      sessionExpired: options.syncCoordinator.sessionExpired,
      supabaseClient: options.supabaseClient,
      unifiedSearchQuery: options.unifiedSearchQuery,
    });
  });

  it('builds template state dependencies from shell-level services and surfaces', async () => {
    const {
      createWorkspaceShellTemplateStateDependencies,
    } = await loadTemplateStateFactoryModule();
    expect(createWorkspaceShellTemplateStateDependencies).toBeTypeOf('function');
    const createDependencies =
      createWorkspaceShellTemplateStateDependencies as (options: {
        authCoord: unknown;
        chrome: { floatingNoticeChrome: unknown; focusChrome: unknown };
        derivedUiState: unknown;
        focusPrefs: unknown;
        focusSyncControllers: unknown;
        projectCoord: unknown;
        projectState: unknown;
        searchDelegates: {
          searchLazyLoad: unknown;
          unifiedSearchQuery: unknown;
        };
        supabaseClient: unknown;
        syncCoordinator: unknown;
        uiState: { isMobile: unknown; sidebarOpen: unknown };
        userSession: unknown;
      }) => unknown;
    const options = {
      authCoord: { bootstrapFailed: vi.fn() },
      chrome: {
        floatingNoticeChrome: { installPromptTop: vi.fn() },
        focusChrome: { mobileSidebarBackdropVisible: vi.fn() },
      },
      derivedUiState: { showLoginRequired: vi.fn() },
      focusPrefs: { isBlackBoxEnabled: vi.fn() },
      focusSyncControllers: { mountState: { shouldMountFocusMode: vi.fn() } },
      projectCoord: { renamingProjectId: vi.fn() },
      projectState: {
        activeProjectId: vi.fn(),
        deletedTasks: vi.fn(),
        projects: vi.fn(),
      },
      searchDelegates: {
        searchLazyLoad: { searchResults: vi.fn() },
        unifiedSearchQuery: vi.fn(),
      },
      supabaseClient: { configurationError: vi.fn() },
      syncCoordinator: {
        offlineMode: vi.fn(),
        sessionExpired: vi.fn(),
      },
      uiState: {
        isMobile: vi.fn(),
        sidebarOpen: vi.fn(),
      },
      userSession: { currentUserId: vi.fn() },
    };

    expect(createDependencies(options)).toEqual({
      authCoord: options.authCoord,
      focusSyncControllers: options.focusSyncControllers,
      isMobile: options.uiState.isMobile,
      projectState: options.projectState,
      projectCoord: options.projectCoord,
      supabaseClient: options.supabaseClient,
      userSession: options.userSession,
      syncCoordinator: options.syncCoordinator,
      derivedUiState: options.derivedUiState,
      floatingNoticeChrome: options.chrome.floatingNoticeChrome,
      focusChrome: options.chrome.focusChrome,
      focusPrefs: options.focusPrefs,
      isSidebarOpen: options.uiState.sidebarOpen,
      searchLazyLoad: options.searchDelegates.searchLazyLoad,
      unifiedSearchQuery: options.searchDelegates.unifiedSearchQuery,
    });
  });

  it('keeps template state assembly out of WorkspaceShellComponent', () => {
    const source = readWorkspaceShellSource();
    const graphSource = readWorkspaceShellControllerGraphSource();
    const startupTemplateSurfacesSource =
      readWorkspaceShellStartupTemplateSurfacesSource();
    const templateSurfaceSource = readWorkspaceShellTemplateSurfaceSource();

    expect(source).not.toContain('private readonly templateStateDependencies =');
    expect(source).not.toContain('state: this.templateStateDependencies');
    expect(graphSource).toContain('createWorkspaceShellStartupTemplateSurfaces({');
    expect(graphSource).not.toContain('createWorkspaceShellTemplateSurface({');
    expect(startupTemplateSurfacesSource)
      .toContain('createWorkspaceShellTemplateSurface({');
    expect(templateSurfaceSource)
      .toContain('createWorkspaceShellTemplateStateDependencies(options)');
    expect(source).not.toContain('state: {\n      authCoord: this.authCoord');
  });

  it('keeps migrated template state handles private on WorkspaceShellComponent', () => {
    const source = readWorkspaceShellSource();
    const startupTemplateBlock = readWorkspaceShellControllerGraphCallOptions(
      'createWorkspaceShellStartupTemplateSurfaces',
    );
    const templateOptions = readWorkspaceShellStartupTemplateSurfacesCallOptions(
      'createWorkspaceShellTemplateSurface',
    );
    const templateSurfaceSource = readWorkspaceShellTemplateSurfaceSource();
    const migratedHandles = [
      'authCoord',
      'projectCoord',
      'modalCoord',
      'supabaseClient',
      'bootStage',
      'focusSyncControllers',
    ];

    for (const handle of migratedHandles) {
      expect(source).not.toContain(`private readonly ${handle} =`);
      expect(source).not.toMatch(new RegExp(`\\n\\s{2}readonly ${handle} =`));
    }

    expect(startupTemplateBlock).toContain('...context');
    expect(startupTemplateBlock).toContain('...base');
    expect(startupTemplateBlock).toContain('...sessionRouting');
    expect(startupTemplateBlock).toContain('...interaction');
    expect(templateOptions).toContain('...options');
    expect(templateOptions).toContain('startupEntryControllers');
    expect(templateSurfaceSource)
      .toContain('createWorkspaceShellTemplateStateDependencies(options)');
    expect(source).not.toContain('private readonly isMobile =');
  });

  it('keeps template-only service reads behind template.state bindings', () => {
    // 中文注释：根模板拆分出子组件后，该合同覆盖根模板 + 全部壳层子模板的联合视图
    const template = readWorkspaceShellTemplates();

    expect(template).toContain('template.state.authCoord.bootstrapFailed()');
    expect(template).toContain('template.state.projectCoord.renamingProjectId()');
    expect(template).toContain('template.state.supabaseClient.configurationError()');
    expect(template).toContain('template.state.focusSyncControllers.mountState.shouldMountFocusMode()');
    expect(template).toContain('template.state.isMobile()');
    expect(template).not.toMatch(/(?<!template\.state\.)\bauthCoord\./);
    expect(template).not.toMatch(/(?<!template\.state\.)\bprojectCoord\./);
    expect(template).not.toMatch(/(?<!template\.state\.)\bsupabaseClient\./);
    expect(template).not.toMatch(/(?<!template\.state\.)\bfocusSyncControllers\./);
    expect(template).not.toMatch(/(?<!state\.)\bisMobile\(\)/);
  });

  it('keeps login actionable when the deferred login overlay chunk fails', () => {
    const template = readWorkspaceShellTemplate();
    const errorStart = template.indexOf('@error {', template.indexOf('login-required-overlay-fallback'));
    const errorEnd = template.indexOf('<router-outlet', errorStart);
    const loginOverlayErrorBlock = template.slice(errorStart, errorEnd);

    expect(loginOverlayErrorBlock).toContain('login-required-overlay-error');
    expect(loginOverlayErrorBlock).toContain('template.interaction.actions.openLoginModal()');
    expect(loginOverlayErrorBlock).toContain('<button');
  });
});
