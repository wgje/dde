import type { NavigationExtras } from '@angular/router';

import {
  createWorkspaceShellStartupEntryControllers,
  type WorkspaceShellStartupEntryControllers,
  type WorkspaceShellStartupEntryControllersFactoryOptions,
} from './workspace-shell-startup-entry-controllers.factory';

export type WorkspaceShellStartupEntryDelegatesOptions = Omit<
    WorkspaceShellStartupEntryControllersFactoryOptions,
    | 'applyWidgetGateMutation'
    | 'currentUserId'
    | 'isBlackBoxEnabled'
    | 'loadBlackBoxRecorder'
    | 'navigate'
    | 'navigateToTextProject'
    | 'preloadSidebarTools'
    | 'routeUrl'
    | 'setSidebarOpen'
    | 'warningToast'
  > & {
    focusPrefs: {
      isBlackBoxEnabled: WorkspaceShellStartupEntryControllersFactoryOptions['isBlackBoxEnabled'];
    };
    router: {
      navigate: (commands: unknown[], extras?: NavigationExtras) => void | Promise<unknown>;
    };
    routeState: {
      routeUrl(): string;
    };
    sidebarOpen: {
      set(value: boolean): void;
    };
    sidebarToolsLazyLoad: {
      loadBlackBoxRecorderComponent(): Promise<unknown>;
      onToolsIntent?(): void;
      preload: WorkspaceShellStartupEntryControllersFactoryOptions['preloadSidebarTools'];
    };
    panelToolsIntent?: {
      readonly register: (
        handler: () => void,
      ) => { readonly unregister: () => void };
      readonly emit: () => void;
    };
    toast: {
      warning: WorkspaceShellStartupEntryControllersFactoryOptions['warningToast'];
    };
    userSession: {
      currentUserId(): string | null;
    };
    widgetGateMutation: {
      apply: WorkspaceShellStartupEntryControllersFactoryOptions['applyWidgetGateMutation'];
    };
    createStartupEntryControllers?: (
      options: WorkspaceShellStartupEntryControllersFactoryOptions,
    ) => WorkspaceShellStartupEntryControllers;
  };

export function createWorkspaceShellStartupEntryDelegates(
  options: WorkspaceShellStartupEntryDelegatesOptions,
): WorkspaceShellStartupEntryControllers {
  const {
    createStartupEntryControllers = createWorkspaceShellStartupEntryControllers,
    focusPrefs,
    router,
    routeState,
    sidebarOpen,
    sidebarToolsLazyLoad,
    toast,
    userSession,
    widgetGateMutation,
    panelToolsIntent,
    ...controllerOptions
  } = options;

  return createStartupEntryControllers({
    ...controllerOptions,
    currentUserId: () => userSession.currentUserId(),
    isBlackBoxEnabled: () => focusPrefs.isBlackBoxEnabled(),
    routeUrl: () => routeState.routeUrl(),
    setSidebarOpen: open => sidebarOpen.set(open),
    activateSidebarTools: () => {
      if (panelToolsIntent) {
        panelToolsIntent.emit();
        sidebarToolsLazyLoad.onToolsIntent?.();
        return;
      }
      sidebarToolsLazyLoad.onToolsIntent?.();
    },
    preloadSidebarTools: reason => sidebarToolsLazyLoad.preload(reason),
    loadBlackBoxRecorder: () =>
      sidebarToolsLazyLoad.loadBlackBoxRecorderComponent().then(() => undefined),
    applyWidgetGateMutation: input => widgetGateMutation.apply(input),
    navigate: (commands, extras) => router.navigate(commands, extras),
    navigateToTextProject: (projectId) =>
      router.navigate(['/projects', projectId, 'text'], {
        replaceUrl: true,
        queryParamsHandling: 'preserve',
      }),
    warningToast: (title, message) => toast.warning(title, message),
  });
}
