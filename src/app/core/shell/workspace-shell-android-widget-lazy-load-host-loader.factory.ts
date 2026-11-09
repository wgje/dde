import type {
  WorkspaceShellAndroidWidgetLazyLoadDelegate,
} from './workspace-shell-android-widget-lazy-load-delegate.factory';
import type {
  WorkspaceShellAndroidWidgetLazyLoadHostOptions,
} from './workspace-shell-android-widget-lazy-load-host.controller';

export interface WorkspaceShellAndroidWidgetLazyLoadHostLoaderOptions {
  readonly createAndroidWidgetLazyLoadHost?: (
    options: WorkspaceShellAndroidWidgetLazyLoadHostOptions,
  ) => Promise<WorkspaceShellAndroidWidgetLazyLoadDelegate>;
  readonly hostOptions: WorkspaceShellAndroidWidgetLazyLoadHostOptions;
}

export function createWorkspaceShellAndroidWidgetLazyLoadHostLoader(
  loaderOptions: WorkspaceShellAndroidWidgetLazyLoadHostLoaderOptions,
): () => Promise<WorkspaceShellAndroidWidgetLazyLoadDelegate> {
  return () => {
    const createAndroidWidgetLazyLoadHost =
      loaderOptions.createAndroidWidgetLazyLoadHost;
    if (createAndroidWidgetLazyLoadHost) {
      return Promise.resolve()
        .then(() =>
          createAndroidWidgetLazyLoadHost(loaderOptions.hostOptions));
    }

    return import('./workspace-shell-android-widget-lazy-load-host.controller')
      .then(({ WorkspaceShellAndroidWidgetLazyLoadHostController }) =>
        new WorkspaceShellAndroidWidgetLazyLoadHostController(loaderOptions.hostOptions));
  };
}
