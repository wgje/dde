import type {
  WorkspaceShellAndroidWidgetHostDelegate,
} from './workspace-shell-android-widget-lazy-load-host.controller';
import type {
  WorkspaceShellAndroidWidgetLazyLoadResolverControllerOptions,
} from './workspace-shell-android-widget-lazy-load-resolver.controller';

export interface WorkspaceShellAndroidWidgetLazyLoadResolverLoaderOptions
  extends Partial<WorkspaceShellAndroidWidgetLazyLoadResolverControllerOptions> {
  createAndroidWidgetResolver?: () => Promise<WorkspaceShellAndroidWidgetHostDelegate>;
  warn: (message: string, error: unknown) => void;
}

export function createWorkspaceShellAndroidWidgetLazyLoadResolverLoader(
  options: WorkspaceShellAndroidWidgetLazyLoadResolverLoaderOptions,
): () => Promise<WorkspaceShellAndroidWidgetHostDelegate> {
  if (options.createAndroidWidgetResolver) {
    return options.createAndroidWidgetResolver;
  }

  return () => import('./workspace-shell-android-widget-lazy-load-resolver.controller')
    .then(({ WorkspaceShellAndroidWidgetLazyLoadResolverController }) =>
      new WorkspaceShellAndroidWidgetLazyLoadResolverController(
        options as WorkspaceShellAndroidWidgetLazyLoadResolverControllerOptions,
      ));
}
