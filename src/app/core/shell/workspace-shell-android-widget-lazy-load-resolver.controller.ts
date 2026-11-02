import type {
  AndroidWidgetBootstrapRequest,
  StartupEntryIntent,
} from '../../../utils/startup-entry-intent';
import type {
  WorkspaceShellAndroidWidgetLazyLoadControllerOptions,
} from './workspace-shell-android-widget-lazy-load.controller';
import {
  createWorkspaceShellAndroidWidgetLazyLoadControllerLoader,
} from './workspace-shell-android-widget-lazy-load-controller-loader.factory';

export interface WorkspaceShellAndroidWidgetLazyLoadLike {
  captureFromRoute(routeUrl: string | null): boolean;
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

export interface WorkspaceShellAndroidWidgetLazyLoadResolverControllerOptions
  extends WorkspaceShellAndroidWidgetLazyLoadControllerOptions {
  warn: (message: string, error: unknown) => void;
  createAndroidWidgetLazyLoad?: () => Promise<WorkspaceShellAndroidWidgetLazyLoadLike>;
}

export class WorkspaceShellAndroidWidgetLazyLoadResolverController {
  private androidWidgetLazyLoadPromise: Promise<WorkspaceShellAndroidWidgetLazyLoadLike | null> | null = null;
  private androidWidgetLazyLoadInstance: WorkspaceShellAndroidWidgetLazyLoadLike | null = null;
  private readonly loadAndroidWidgetLazyLoadController:
    () => Promise<WorkspaceShellAndroidWidgetLazyLoadLike>;
  private isTornDown = false;

  constructor(
    private readonly options: WorkspaceShellAndroidWidgetLazyLoadResolverControllerOptions,
  ) {
    this.loadAndroidWidgetLazyLoadController =
      createWorkspaceShellAndroidWidgetLazyLoadControllerLoader(options);
  }

  captureFromRoute(routeUrl: string | null): Promise<boolean> {
    if (this.isTornDown) return Promise.resolve(false);

    return this.loadAndroidWidgetLazyLoad()
      .then(controller => {
        if (!controller || this.isTornDown) return false;
        try {
          return controller.captureFromRoute(routeUrl);
        } catch (error) {
          if (!this.isTornDown) {
            this.warn(
              'Android widget bootstrap 控制器路由捕获失败，已跳过',
              error,
            );
          }
          return false;
        }
      })
      .catch(() => false);
  }

  complete(bootstrapRequest: AndroidWidgetBootstrapRequest): Promise<void> {
    if (this.isTornDown) return Promise.resolve();

    return this.loadAndroidWidgetLazyLoad()
      .then(async controller => {
        if (!controller || this.isTornDown) return;
        try {
          await controller.complete(bootstrapRequest);
        } catch (error) {
          if (!this.isTornDown) {
            this.warn('Android widget bootstrap 控制器完成失败，已跳过', error);
          }
        }
      })
      .catch(() => undefined);
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
    if (this.isTornDown) return;

    this.isTornDown = true;
    if (this.androidWidgetLazyLoadInstance) {
      this.teardownAndroidWidgetLazyLoad(this.androidWidgetLazyLoadInstance);
      return;
    }

    void this.androidWidgetLazyLoadPromise
      ?.then(controller => {
        if (controller) {
          this.teardownAndroidWidgetLazyLoad(controller);
        }
      })
      .catch(error => {
        this.warn('Android widget bootstrap 控制器清理失败，已跳过', error);
      });
  }

  private run(action: (controller: WorkspaceShellAndroidWidgetLazyLoadLike) => void): void {
    if (this.isTornDown) return;

    void this.loadAndroidWidgetLazyLoad()
      .then(controller => {
        if (!controller || this.isTornDown) return;
        try {
          action(controller);
        } catch (error) {
          if (!this.isTornDown) {
            this.warn('Android widget bootstrap 控制器操作失败，已跳过', error);
          }
        }
      })
      .catch(() => undefined);
  }

  private loadAndroidWidgetLazyLoad(): Promise<WorkspaceShellAndroidWidgetLazyLoadLike | null> {
    if (this.androidWidgetLazyLoadInstance) {
      return Promise.resolve(this.androidWidgetLazyLoadInstance);
    }

    return (this.androidWidgetLazyLoadPromise ??= this.loadAndroidWidgetLazyLoadController()
      .then(controller => {
        if (this.isTornDown) {
          this.teardownAndroidWidgetLazyLoad(controller);
          return null;
        }

        this.androidWidgetLazyLoadInstance = controller;
        return controller;
      })
      .catch(error => {
        this.androidWidgetLazyLoadPromise = null;
        this.warn('Android widget bootstrap 控制器懒加载失败，相关入口暂不可用', error);
        throw error;
      }));
  }

  private teardownAndroidWidgetLazyLoad(controller: WorkspaceShellAndroidWidgetLazyLoadLike): void {
    try {
      controller.teardown();
    } catch (error) {
      this.warn('Android widget bootstrap 控制器清理失败，已跳过', error);
    }
  }

  private warn(message: string, error: unknown): void {
    try {
      this.options.warn(message, error);
    } catch {
      // Warning sinks must not break Android widget fallback or teardown paths.
    }
  }
}
