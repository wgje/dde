import type {
  WorkspaceShellAndroidWidgetLazyLoadControllerOptions,
} from './workspace-shell-android-widget-lazy-load.controller';
import type {
  WorkspaceShellAndroidWidgetLazyLoadLike,
} from './workspace-shell-android-widget-lazy-load-resolver.controller';

export interface WorkspaceShellAndroidWidgetLazyLoadControllerLoaderOptions
  extends WorkspaceShellAndroidWidgetLazyLoadControllerOptions {
  createAndroidWidgetLazyLoad?: () => Promise<WorkspaceShellAndroidWidgetLazyLoadLike>;
}

export function createWorkspaceShellAndroidWidgetLazyLoadControllerLoader(
  options: WorkspaceShellAndroidWidgetLazyLoadControllerLoaderOptions,
): () => Promise<WorkspaceShellAndroidWidgetLazyLoadLike> {
  if (options.createAndroidWidgetLazyLoad) {
    return () => {
      try {
        return Promise.resolve(options.createAndroidWidgetLazyLoad?.())
          .then(controller => {
            if (!controller) {
              throw new Error('Android widget lazy-load controller loader returned no controller');
            }

            return controller;
          });
      } catch (error) {
        return Promise.reject(error);
      }
    };
  }

  return () => import('./workspace-shell-android-widget-lazy-load.controller')
    .then(({ WorkspaceShellAndroidWidgetLazyLoadController }) =>
      new WorkspaceShellAndroidWidgetLazyLoadController(options));
}
