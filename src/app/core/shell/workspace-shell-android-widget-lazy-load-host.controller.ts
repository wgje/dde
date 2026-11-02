import type {
  AndroidWidgetBootstrapRequest,
  StartupEntryIntent,
} from '../../../utils/startup-entry-intent';
import {
  createWorkspaceShellAndroidWidgetLazyLoadResolverLoader,
  type WorkspaceShellAndroidWidgetLazyLoadResolverLoaderOptions,
} from './workspace-shell-android-widget-lazy-load-resolver-loader.factory';
import { WorkspaceShellLazyDelegateCallHostController } from './workspace-shell-lazy-delegate-call-host.controller';

const RESOLVER_LOAD_FAILURE_MESSAGE =
  'Android widget bootstrap lazy-load resolver 加载失败，相关入口暂不可用';
const RESOLVER_CAPTURE_FAILURE_MESSAGE =
  'Android widget bootstrap lazy-load resolver 路由捕获失败，已跳过';
const RESOLVER_COMPLETE_FAILURE_MESSAGE =
  'Android widget bootstrap lazy-load resolver 完成失败，已跳过';
const RESOLVER_OPERATION_FAILURE_MESSAGE =
  'Android widget bootstrap lazy-load resolver 操作失败，已跳过';
const RESOLVER_TEARDOWN_FAILURE_MESSAGE =
  'Android widget bootstrap lazy-load resolver 清理失败，已跳过';

export interface WorkspaceShellAndroidWidgetHostDelegate {
  captureFromRoute(routeUrl: string | null): Promise<boolean>;
  complete(bootstrapRequest: AndroidWidgetBootstrapRequest): Promise<void>;
  continueManualCallback(): void;
  dismissManualCallback(): void;
  persistDeferredStartupEntryIntent(startupEntryIntent: StartupEntryIntent | null): void;
  persistPendingBootstrap(request: AndroidWidgetBootstrapRequest | null): void;
  restoreAll(): void;
  syncProcessing(generation?: number): void;
  teardown(): void;
  useIntentFallback(): void;
}

export interface WorkspaceShellAndroidWidgetLazyLoadHostOptions
  extends WorkspaceShellAndroidWidgetLazyLoadResolverLoaderOptions {}

export class WorkspaceShellAndroidWidgetLazyLoadHostController {
  private readonly host: WorkspaceShellLazyDelegateCallHostController<
    WorkspaceShellAndroidWidgetHostDelegate
  >;

  constructor(options: WorkspaceShellAndroidWidgetLazyLoadHostOptions) {
    this.host = new WorkspaceShellLazyDelegateCallHostController({
      createDelegate: createWorkspaceShellAndroidWidgetLazyLoadResolverLoader(options),
      loadFailureMessage: RESOLVER_LOAD_FAILURE_MESSAGE,
      teardownFailureMessage: RESOLVER_TEARDOWN_FAILURE_MESSAGE,
      warn: options.warn,
    });
  }

  captureFromRoute(routeUrl: string | null): Promise<boolean> {
    return this.host.call(
      controller => controller.captureFromRoute(routeUrl),
      false,
      RESOLVER_CAPTURE_FAILURE_MESSAGE,
      RESOLVER_LOAD_FAILURE_MESSAGE,
    );
  }

  complete(bootstrapRequest: AndroidWidgetBootstrapRequest): Promise<void> {
    return this.host.call(
      controller => controller.complete(bootstrapRequest),
      undefined,
      RESOLVER_COMPLETE_FAILURE_MESSAGE,
      RESOLVER_LOAD_FAILURE_MESSAGE,
    );
  }

  restoreAll(): void {
    this.run(controller => controller.restoreAll());
  }

  persistPendingBootstrap(request: AndroidWidgetBootstrapRequest | null): void {
    this.run(controller => controller.persistPendingBootstrap(request));
  }

  persistDeferredStartupEntryIntent(startupEntryIntent: StartupEntryIntent | null): void {
    this.run(controller => controller.persistDeferredStartupEntryIntent(startupEntryIntent));
  }

  syncProcessing(generation?: number): void {
    this.run(controller => controller.syncProcessing(generation));
  }

  continueManualCallback(): void {
    this.run(controller => controller.continueManualCallback());
  }

  useIntentFallback(): void {
    this.run(controller => controller.useIntentFallback());
  }

  dismissManualCallback(): void {
    this.run(controller => controller.dismissManualCallback());
  }

  teardown(): void {
    this.host.teardown();
  }

  private run(action: (controller: WorkspaceShellAndroidWidgetHostDelegate) => void): void {
    this.host.run(action, RESOLVER_OPERATION_FAILURE_MESSAGE, RESOLVER_LOAD_FAILURE_MESSAGE);
  }
}
