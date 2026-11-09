import {
  createWorkspaceShellAndroidWidgetLazyLoadDelegate,
  type WorkspaceShellAndroidWidgetLazyLoadDelegate,
} from './workspace-shell-android-widget-lazy-load-delegate.factory';
import type {
  WorkspaceShellAndroidWidgetLazyLoadHostOptions,
} from './workspace-shell-android-widget-lazy-load-host.controller';
import type {
  WorkspaceShellAndroidWidgetLazyLoadControllerOptions,
} from './workspace-shell-android-widget-lazy-load.controller';

export interface WorkspaceShellAndroidWidgetLazyLoadFactoryOptions
  extends Omit<
      WorkspaceShellAndroidWidgetLazyLoadControllerOptions,
      | 'consumeStartupEntryIntent'
      | 'getDocument'
      | 'getStorage'
      | 'getWindow'
      | 'readRuntimePlatform'
      | 'warningToast'
    >,
    Pick<WorkspaceShellAndroidWidgetLazyLoadHostOptions, 'warn' | 'createAndroidWidgetResolver'> {
  getDocument?: WorkspaceShellAndroidWidgetLazyLoadControllerOptions['getDocument'];
  getStorage?: WorkspaceShellAndroidWidgetLazyLoadControllerOptions['getStorage'];
  getWindow?: WorkspaceShellAndroidWidgetLazyLoadControllerOptions['getWindow'];
  readRuntimePlatform?: WorkspaceShellAndroidWidgetLazyLoadControllerOptions['readRuntimePlatform'];
  resolveConsumedStartupEntryNavigation: () => unknown[];
  navigate: (commands: unknown[], extras: { replaceUrl: boolean }) => void | Promise<unknown>;
  warningToast: (title: string, message: string) => void;
  createAndroidWidgetLazyLoadHost?: (
    options: WorkspaceShellAndroidWidgetLazyLoadHostOptions,
  ) => Promise<WorkspaceShellAndroidWidgetLazyLoadDelegate>;
}

export function createWorkspaceShellAndroidWidgetLazyLoadController(
  options: WorkspaceShellAndroidWidgetLazyLoadFactoryOptions,
): WorkspaceShellAndroidWidgetLazyLoadDelegate {
  return createWorkspaceShellAndroidWidgetLazyLoadDelegate({
    warn: options.warn,
    createAndroidWidgetLazyLoadHost: () =>
      import('./workspace-shell-android-widget-lazy-load-default-host.factory')
        .then(({ createWorkspaceShellAndroidWidgetDefaultLazyLoadHost }) =>
          createWorkspaceShellAndroidWidgetDefaultLazyLoadHost(options)),
  });
}
