import {
  createWorkspaceShellInteractionLazyLoadDelegates,
  type WorkspaceShellInteractionLazyLoadDelegateOptions,
  type WorkspaceShellInteractionLazyLoadDelegates,
} from './workspace-shell-interaction-lazy-load-delegates.factory';

type WorkspaceShellBooleanWritableSignal = (() => boolean) & {
  set(value: boolean): void;
};

export interface WorkspaceShellInteractionDelegatesOptions
  extends Omit<
    WorkspaceShellInteractionLazyLoadDelegateOptions,
    | 'activeProjectId'
    | 'activeView'
    | 'checkGateForMobileProjectEntry'
    | 'currentUserId'
    | 'isMobile'
    | 'navigateByUrl'
    | 'parkingService'
    | 'sidebarOpen'
    | 'setIsMobile'
    | 'setSidebarOpen'
    | 'uiState'
  > {
  focus: {
    mobileFocusGate: {
      checkGateForMobileProjectEntry(): void;
    };
  };
  layout: {
    sidebarOpen: WorkspaceShellInteractionLazyLoadDelegateOptions['sidebarOpen'];
    uiState: WorkspaceShellInteractionLazyLoadDelegateOptions['uiState'] & {
      activeView(): string | null;
      isMobile: WorkspaceShellBooleanWritableSignal;
    };
  };
  navigation: {
    projectState: {
      activeProjectId(): string | null;
    };
    router: {
      navigateByUrl(url: string): Promise<boolean>;
    };
  };
  runtime: {
    lazyServiceRefs: {
      readonly parkingService: {
        previewTask: WorkspaceShellInteractionLazyLoadDelegateOptions['parkingService']['previewTask'];
      };
    };
  };
  session: {
    authService: {
      currentUserId(): string | null;
    };
  };
  authCoord: WorkspaceShellInteractionLazyLoadDelegateOptions['authCoord'];
  createInteractionLazyLoadDelegates?: (
    options: WorkspaceShellInteractionLazyLoadDelegateOptions,
  ) => WorkspaceShellInteractionLazyLoadDelegates;
}

export function createWorkspaceShellInteractionDelegates(
  options: WorkspaceShellInteractionDelegatesOptions,
): WorkspaceShellInteractionLazyLoadDelegates {
  const {
    authCoord,
    focus,
    layout,
    navigation,
    runtime,
    session,
    createInteractionLazyLoadDelegates =
      createWorkspaceShellInteractionLazyLoadDelegates,
    ...delegateOptions
  } = options;
  const { uiState } = layout;

  return createInteractionLazyLoadDelegates({
    ...delegateOptions,
    authCoord,
    activeProjectId: () => navigation.projectState.activeProjectId(),
    activeView: () => uiState.activeView(),
    checkGateForMobileProjectEntry: () =>
      focus.mobileFocusGate.checkGateForMobileProjectEntry(),
    currentUserId: () => session.authService.currentUserId(),
    isMobile: () => uiState.isMobile(),
    navigateByUrl: url => navigation.router.navigateByUrl(url),
    parkingService: {
      previewTask: taskId =>
        runtime.lazyServiceRefs.parkingService.previewTask(taskId),
    },
    sidebarOpen: layout.sidebarOpen,
    setIsMobile: isMobile => uiState.isMobile.set(isMobile),
    setSidebarOpen: open => layout.sidebarOpen.set(open),
    uiState,
  });
}
