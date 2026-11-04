import {
  createWorkspaceShellStartupEntryDelegates,
  type WorkspaceShellStartupEntryDelegatesOptions,
} from './workspace-shell-startup-entry-delegates.factory';
import type {
  WorkspaceShellToolControllers,
} from './workspace-shell-tool-controllers.factory';

export interface WorkspaceShellStartupEntryOptionsFactoryOptions {
  routeUrl: WorkspaceShellStartupEntryDelegatesOptions['routeState']['routeUrl'];
  uiState: { isMobile(): boolean };
  projectState: {
    activeProjectId(): string | null;
    projects(): WorkspaceShellStartupEntryDelegatesOptions['projects'] extends () => infer T
      ? T
      : never;
  };
  startupLaunchSnapshot:
    WorkspaceShellStartupEntryDelegatesOptions['startupLaunchSnapshot'];
  userSession: WorkspaceShellStartupEntryDelegatesOptions['userSession'];
  bootStage: { isApplicationReady(): boolean };
  focusPrefs: WorkspaceShellStartupEntryDelegatesOptions['focusPrefs'];
  sidebarOpen: WorkspaceShellStartupEntryDelegatesOptions['sidebarOpen'];
  toolControllers: Pick<
    WorkspaceShellToolControllers,
    'sidebarToolsLazyLoad' | 'widgetGateMutation' | 'panelToolsIntent'
  >;
  focusStartupProbe: {
    primeWidgetWorkspaceGateSync:
      WorkspaceShellStartupEntryDelegatesOptions['primeWidgetWorkspaceGateSync'];
    recheckGate: WorkspaceShellStartupEntryDelegatesOptions['recheckGate'];
  };
  dockEngine: {
    refreshFocusSessionFromCloud:
      WorkspaceShellStartupEntryDelegatesOptions['refreshFocusSessionFromCloud'];
  };
  authService: { sessionInitialized(): boolean };
  widgetBinding: {
    completeAndroidBootstrap:
      WorkspaceShellStartupEntryDelegatesOptions['completeAndroidBootstrap'];
  };
  router: WorkspaceShellStartupEntryDelegatesOptions['router'];
  beforeUnloadManager:
    WorkspaceShellStartupEntryDelegatesOptions['beforeUnloadManager'];
  logger: WorkspaceShellStartupEntryDelegatesOptions['logger'];
  toast: WorkspaceShellStartupEntryDelegatesOptions['toast'];
  warn: WorkspaceShellStartupEntryDelegatesOptions['warn'];
  createStartupEntryControllers?:
    WorkspaceShellStartupEntryDelegatesOptions['createStartupEntryControllers'];
}

export interface WorkspaceShellStartupEntrySurfaceOptions
  extends Omit<
    WorkspaceShellStartupEntryOptionsFactoryOptions,
    | 'dockEngine'
    | 'focusStartupProbe'
    | 'routeUrl'
    | 'router'
    | 'sidebarOpen'
    | 'startupLaunchSnapshot'
  > {
  chrome: {
    readonly dockEngine:
      WorkspaceShellStartupEntryOptionsFactoryOptions['dockEngine'];
  };
  launchSnapshotSurface: {
    readonly startupLaunchSnapshot:
      WorkspaceShellStartupEntryOptionsFactoryOptions['startupLaunchSnapshot'];
  };
  lazyServiceRefs: {
    readonly focusStartupProbe:
      WorkspaceShellStartupEntryOptionsFactoryOptions['focusStartupProbe'];
  };
  routing: {
    readonly routeUrl:
      WorkspaceShellStartupEntryOptionsFactoryOptions['routeUrl'];
    readonly router: WorkspaceShellStartupEntryOptionsFactoryOptions['router'];
  };
  uiState: WorkspaceShellStartupEntryOptionsFactoryOptions['uiState'] & {
    readonly sidebarOpen:
      WorkspaceShellStartupEntryOptionsFactoryOptions['sidebarOpen'];
  };
}

export function createWorkspaceShellStartupEntryOptions(
  options: WorkspaceShellStartupEntryOptionsFactoryOptions,
): WorkspaceShellStartupEntryDelegatesOptions {
  return {
    routeState: { routeUrl: options.routeUrl },
    isMobile: () => options.uiState.isMobile(),
    activeProjectId: () => options.projectState.activeProjectId(),
    projects: () => options.projectState.projects(),
    startupLaunchSnapshot: options.startupLaunchSnapshot,
    userSession: options.userSession,
    isApplicationReady: () => options.bootStage.isApplicationReady(),
    focusPrefs: options.focusPrefs,
 sidebarOpen: options.sidebarOpen,
 sidebarToolsLazyLoad: options.toolControllers.sidebarToolsLazyLoad,
 widgetGateMutation: options.toolControllers.widgetGateMutation,
 panelToolsIntent: options.toolControllers.panelToolsIntent,
  primeWidgetWorkspaceGateSync: () =>
      options.focusStartupProbe.primeWidgetWorkspaceGateSync(),
    refreshFocusSessionFromCloud: userId =>
      options.dockEngine.refreshFocusSessionFromCloud(userId),
    recheckGate: recheckOptions =>
      options.focusStartupProbe.recheckGate(recheckOptions),
    isSessionInitialized: () => options.authService.sessionInitialized(),
    completeAndroidBootstrap: request =>
      options.widgetBinding.completeAndroidBootstrap(request),
    router: options.router,
    beforeUnloadManager: options.beforeUnloadManager,
    logger: options.logger,
    toast: options.toast,
    warn: options.warn,
    ...(options.createStartupEntryControllers
      ? { createStartupEntryControllers: options.createStartupEntryControllers }
      : {}),
  };
}

export function createWorkspaceShellStartupEntryDelegate(
  options: WorkspaceShellStartupEntryOptionsFactoryOptions,
): ReturnType<typeof createWorkspaceShellStartupEntryDelegates> {
  return createWorkspaceShellStartupEntryDelegates(
    createWorkspaceShellStartupEntryOptions(options),
  );
}

export function createWorkspaceShellStartupEntrySurface(
  options: WorkspaceShellStartupEntrySurfaceOptions,
): ReturnType<typeof createWorkspaceShellStartupEntryDelegate> {
  return createWorkspaceShellStartupEntryDelegate({
    ...options,
    dockEngine: options.chrome.dockEngine,
    focusStartupProbe: options.lazyServiceRefs.focusStartupProbe,
    routeUrl: options.routing.routeUrl,
    router: options.routing.router,
    sidebarOpen: options.uiState.sidebarOpen,
    startupLaunchSnapshot:
      options.launchSnapshotSurface.startupLaunchSnapshot,
  });
}
