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
  readonly activeProjectId:
    WorkspaceShellTemplateStateDependencies['projectState']['activeProjectId'];
  readonly authCoord: WorkspaceShellTemplateStateDependencies['authCoord'];
  readonly currentUserId:
    WorkspaceShellTemplateStateDependencies['userSession']['currentUserId'];
  readonly deletedTasks:
    WorkspaceShellTemplateStateDependencies['projectState']['deletedTasks'];
  readonly derivedUiState:
    WorkspaceShellTemplateStateDependencies['derivedUiState'];
  readonly floatingNoticeChrome:
    WorkspaceShellTemplateStateDependencies['floatingNoticeChrome'];
  readonly focusChrome: WorkspaceShellTemplateStateDependencies['focusChrome'];
  readonly focusPrefs: WorkspaceShellTemplateStateDependencies['focusPrefs'];
  readonly focusSyncControllers:
    WorkspaceShellTemplateStateDependencies['focusSyncControllers'];
  readonly isMobile: WorkspaceShellTemplateStateDependencies['isMobile'];
  readonly isSidebarOpen:
    WorkspaceShellTemplateStateDependencies['isSidebarOpen'];
  readonly offlineMode:
    WorkspaceShellTemplateStateDependencies['syncCoordinator']['offlineMode'];
  readonly projectCoord: WorkspaceShellTemplateStateDependencies['projectCoord'];
  readonly projects:
    WorkspaceShellTemplateStateDependencies['projectState']['projects'];
  readonly searchLazyLoad:
    WorkspaceShellTemplateStateDependencies['searchLazyLoad'];
  readonly sessionExpired:
    WorkspaceShellTemplateStateDependencies['syncCoordinator']['sessionExpired'];
  readonly supabaseClient:
    WorkspaceShellTemplateStateDependencies['supabaseClient'];
  readonly unifiedSearchQuery:
    WorkspaceShellTemplateStateDependencies['unifiedSearchQuery'];
}

type WorkspaceShellTemplateStateConstrainedOptions =
  WorkspaceShellTemplateStateFactoryOptions<
    WorkspaceShellGraphContext['authCoord'],
    WorkspaceShellSessionRoutingSurface['focusSyncControllers'],
    WorkspaceShellGraphContext['uiState']['isMobile'],
    WorkspaceShellGraphContext['projectState'],
    WorkspaceShellGraphContext['projectCoord'],
    WorkspaceShellGraphContext['supabaseClient'],
    WorkspaceShellGraphContext['userSession'],
    WorkspaceShellGraphContext['syncCoordinator'],
    WorkspaceShellInteractionSurfaces['derivedUiState'],
    WorkspaceShellSessionRoutingSurface['chrome']['floatingNoticeChrome'],
    WorkspaceShellSessionRoutingSurface['chrome']['focusChrome'],
    WorkspaceShellGraphContext['focusPrefs'],
    WorkspaceShellGraphContext['uiState']['sidebarOpen'],
    WorkspaceShellBaseSurfaces['searchDelegates']['searchLazyLoad'],
    WorkspaceShellBaseSurfaces['searchDelegates']['unifiedSearchQuery']
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
>(
  projectState: TProjectState,
): Pick<TProjectState, 'activeProjectId' | 'deletedTasks' | 'projects'> {
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
): Pick<TUserSession, 'currentUserId'>
  & Pick<TSyncCoordinator, 'offlineMode' | 'sessionExpired'> {
  return {
    currentUserId: userSession.currentUserId,
    offlineMode: syncCoordinator.offlineMode,
    sessionExpired: syncCoordinator.sessionExpired,
  };
}
import type {
  WorkspaceShellBaseSurfaces,
} from './workspace-shell-base-surfaces.factory';
import type {
  WorkspaceShellGraphContext,
} from './workspace-shell-graph-context.factory';
import type {
  WorkspaceShellInteractionSurfaces,
} from './workspace-shell-interaction-surfaces.factory';
import type {
  WorkspaceShellSessionRoutingSurface,
} from './workspace-shell-session-routing-surface.factory';
