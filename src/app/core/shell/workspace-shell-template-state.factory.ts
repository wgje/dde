export interface WorkspaceShellTemplateStateFactoryOptions<
  TAuthCoord,
  TFocusSyncControllers,
  TIsMobile,
  TProjectState,
  TProjectCoord,
  TSupabaseClient,
  TUserSession,
  TSyncCoordinator,
  TDerivedUiState,
  TFloatingNoticeChrome,
  TFocusChrome,
  TFocusPrefs,
  TSidebarOpen,
  TSearchLazyLoad,
  TUnifiedSearchQuery,
> {
  readonly authCoord: TAuthCoord;
  readonly focusSyncControllers: TFocusSyncControllers;
  readonly isMobile: TIsMobile;
  readonly projectState: TProjectState;
  readonly projectCoord: TProjectCoord;
  readonly supabaseClient: TSupabaseClient;
  readonly userSession: TUserSession;
  readonly syncCoordinator: TSyncCoordinator;
  readonly derivedUiState: TDerivedUiState;
  readonly floatingNoticeChrome: TFloatingNoticeChrome;
  readonly focusChrome: TFocusChrome;
  readonly focusPrefs: TFocusPrefs;
  readonly isSidebarOpen: TSidebarOpen;
  readonly searchLazyLoad: TSearchLazyLoad;
  readonly unifiedSearchQuery: TUnifiedSearchQuery;
}

export interface WorkspaceShellTemplateProjectStateLike {
  readonly activeProjectId: unknown;
  readonly deletedTasks: unknown;
  readonly projects: unknown;
}

export interface WorkspaceShellTemplateUserSessionLike {
  readonly currentUserId: unknown;
}

export interface WorkspaceShellTemplateSyncCoordinatorLike {
  readonly offlineMode: unknown;
  readonly sessionExpired: unknown;
}

export interface WorkspaceShellTemplateState {
  readonly activeProjectId: unknown;
  readonly authCoord: unknown;
  readonly currentUserId: unknown;
  readonly deletedTasks: unknown;
  readonly derivedUiState: unknown;
  readonly floatingNoticeChrome: unknown;
  readonly focusChrome: unknown;
  readonly focusPrefs: unknown;
  readonly focusSyncControllers: unknown;
  readonly isMobile: unknown;
  readonly isSidebarOpen: unknown;
  readonly offlineMode: unknown;
  readonly projectCoord: unknown;
  readonly projects: unknown;
  readonly searchLazyLoad: unknown;
  readonly sessionExpired: unknown;
  readonly supabaseClient: unknown;
  readonly unifiedSearchQuery: unknown;
}

type WorkspaceShellTemplateStateConstrainedOptions =
  WorkspaceShellTemplateStateFactoryOptions<
    unknown,
    unknown,
    unknown,
    WorkspaceShellTemplateProjectStateLike,
    unknown,
    unknown,
    WorkspaceShellTemplateUserSessionLike,
    WorkspaceShellTemplateSyncCoordinatorLike,
    unknown,
    unknown,
    unknown,
    unknown,
    unknown,
    unknown,
    unknown
  >;

export type WorkspaceShellTemplateStateDependencies =
  WorkspaceShellTemplateStateConstrainedOptions;

export interface WorkspaceShellTemplateStateDependenciesFactoryOptions {
  readonly authCoord: WorkspaceShellTemplateStateDependencies['authCoord'];
  readonly chrome: {
    readonly floatingNoticeChrome:
      WorkspaceShellTemplateStateDependencies['floatingNoticeChrome'];
    readonly focusChrome:
      WorkspaceShellTemplateStateDependencies['focusChrome'];
  };
  readonly derivedUiState:
    WorkspaceShellTemplateStateDependencies['derivedUiState'];
  readonly focusPrefs: WorkspaceShellTemplateStateDependencies['focusPrefs'];
  readonly focusSyncControllers:
    WorkspaceShellTemplateStateDependencies['focusSyncControllers'];
  readonly projectCoord:
    WorkspaceShellTemplateStateDependencies['projectCoord'];
  readonly projectState:
    WorkspaceShellTemplateStateDependencies['projectState'];
  readonly searchDelegates: {
    readonly searchLazyLoad:
      WorkspaceShellTemplateStateDependencies['searchLazyLoad'];
    readonly unifiedSearchQuery:
      WorkspaceShellTemplateStateDependencies['unifiedSearchQuery'];
  };
  readonly supabaseClient:
    WorkspaceShellTemplateStateDependencies['supabaseClient'];
  readonly syncCoordinator:
    WorkspaceShellTemplateStateDependencies['syncCoordinator'];
  readonly uiState: {
    readonly isMobile: WorkspaceShellTemplateStateDependencies['isMobile'];
    readonly sidebarOpen:
      WorkspaceShellTemplateStateDependencies['isSidebarOpen'];
  };
  readonly userSession:
    WorkspaceShellTemplateStateDependencies['userSession'];
}

export function createWorkspaceShellTemplateStateDependencies(
  options: WorkspaceShellTemplateStateDependenciesFactoryOptions,
): WorkspaceShellTemplateStateDependencies {
  return {
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
  };
}

export function createWorkspaceShellTemplateState(
  options: WorkspaceShellTemplateStateDependencies,
): WorkspaceShellTemplateState {
  return {
    ...createWorkspaceShellTemplateProjectState(options.projectState),
    ...createWorkspaceShellTemplateSessionState(
      options.userSession,
      options.syncCoordinator,
    ),
    authCoord: options.authCoord,
    derivedUiState: options.derivedUiState,
    floatingNoticeChrome: options.floatingNoticeChrome,
    focusSyncControllers: options.focusSyncControllers,
    focusChrome: options.focusChrome,
    focusPrefs: options.focusPrefs,
    isMobile: options.isMobile,
    isSidebarOpen: options.isSidebarOpen,
    projectCoord: options.projectCoord,
    searchLazyLoad: options.searchLazyLoad,
    supabaseClient: options.supabaseClient,
    unifiedSearchQuery: options.unifiedSearchQuery,
  };
}

function createWorkspaceShellTemplateProjectState<
  TProjectState extends WorkspaceShellTemplateProjectStateLike,
>(projectState: TProjectState) {
  return {
    activeProjectId: projectState.activeProjectId,
    deletedTasks: projectState.deletedTasks,
    projects: projectState.projects,
  };
}

function createWorkspaceShellTemplateSessionState<
  TUserSession extends WorkspaceShellTemplateUserSessionLike,
  TSyncCoordinator extends WorkspaceShellTemplateSyncCoordinatorLike,
>(
  userSession: TUserSession,
  syncCoordinator: TSyncCoordinator,
) {
  return {
    currentUserId: userSession.currentUserId,
    offlineMode: syncCoordinator.offlineMode,
    sessionExpired: syncCoordinator.sessionExpired,
  };
}
