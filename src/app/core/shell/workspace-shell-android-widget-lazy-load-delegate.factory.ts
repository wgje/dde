import { createWorkspaceShellDeferredController } from './workspace-shell-deferred-controller.helpers';
import type {
  WorkspaceShellAndroidWidgetHostDelegate,
  WorkspaceShellAndroidWidgetLazyLoadHostOptions,
} from './workspace-shell-android-widget-lazy-load-host.controller';

export interface WorkspaceShellAndroidWidgetLazyLoadDelegate
  extends WorkspaceShellAndroidWidgetHostDelegate {}

export interface WorkspaceShellAndroidWidgetLazyLoadDelegateOptions
  extends Pick<WorkspaceShellAndroidWidgetLazyLoadHostOptions, 'warn'> {
  createAndroidWidgetLazyLoadHost: () => Promise<WorkspaceShellAndroidWidgetLazyLoadDelegate>;
}

export function createWorkspaceShellAndroidWidgetLazyLoadDelegate(
  options: WorkspaceShellAndroidWidgetLazyLoadDelegateOptions,
): WorkspaceShellAndroidWidgetLazyLoadDelegate {
  const delegate =
    createWorkspaceShellDeferredController<WorkspaceShellAndroidWidgetLazyLoadDelegate>(
      () => createAndroidWidgetLazyLoadHost(options),
      {
        failureMessage: 'Android widget bootstrap lazy-load host 加载失败，相关入口暂不可用',
        warn: options.warn,
      },
    );

  return {
    captureFromRoute: routeUrl => delegate.captureFromRoute(routeUrl)
      .then(captured => captured ?? false),
    complete: bootstrapRequest => delegate.complete(bootstrapRequest)
      .then(() => undefined),
    continueManualCallback: () => {
      void delegate.continueManualCallback();
    },
    dismissManualCallback: () => {
      void delegate.dismissManualCallback();
    },
    persistDeferredStartupEntryIntent: startupEntryIntent => {
      void delegate.persistDeferredStartupEntryIntent(startupEntryIntent);
    },
    persistPendingBootstrap: request => {
      void delegate.persistPendingBootstrap(request);
    },
    restoreAll: () => {
      void delegate.restoreAll();
    },
    syncProcessing: () => {
      void delegate.syncProcessing();
    },
    teardown: () => {
      delegate.teardown();
    },
    useIntentFallback: () => {
      void delegate.useIntentFallback();
    },
  };
}

function createAndroidWidgetLazyLoadHost(
  options: WorkspaceShellAndroidWidgetLazyLoadDelegateOptions,
): Promise<WorkspaceShellAndroidWidgetLazyLoadDelegate> {
  return options.createAndroidWidgetLazyLoadHost();
}
