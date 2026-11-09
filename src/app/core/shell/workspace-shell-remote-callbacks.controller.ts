import type { Injector } from '@angular/core';

export interface WorkspaceShellRemoteChangeCallbacks {
  onLoadProjects?: () => Promise<void>;
  onRefreshActiveProject?: (reason: string) => Promise<void>;
}

export interface WorkspaceShellRemoteChangeHandler {
  setupCallbacks(callbacks: WorkspaceShellRemoteChangeCallbacks): void;
  reset?: () => void;
}

export interface WorkspaceShellRemoteCallbacksControllerOptions {
  isEnabled: () => boolean;
  isReady: () => boolean;
  importRemoteChangeHandler?: () => Promise<WorkspaceShellRemoteChangeHandler>;
  injector?: Pick<Injector, 'get'>;
  refreshActiveProjectSilent: (reason: string) => Promise<unknown>;
  warn: (message: string, error: unknown) => void;
}

export class WorkspaceShellRemoteCallbacksController {
  private initialized = false;
  private initializing = false;
  private isTornDown = false;
  private remoteChangeHandlerPromise: Promise<WorkspaceShellRemoteChangeHandler | null> | null = null;
  private registeredHandler: WorkspaceShellRemoteChangeHandler | null = null;

  constructor(private readonly options: WorkspaceShellRemoteCallbacksControllerOptions) {}

  registerIfReady(): void {
    if (this.isTornDown) {
      return;
    }

    if (!this.options.isEnabled() || !this.options.isReady()) {
      return;
    }

    if (this.initialized || this.initializing) {
      return;
    }

    this.initializing = true;
    void this.loadRemoteChangeHandlerLazy()
      .then((handler) => {
        if (
          !handler ||
          this.isTornDown ||
          !this.options.isEnabled() ||
          !this.options.isReady()
        ) {
          return;
        }

        try {
          handler.setupCallbacks({
            onRefreshActiveProject: async (reason) => {
              await this.refreshActiveProjectForRemoteCallback(
                reason,
                '远程恢复回调刷新当前项目失败',
              );
            },
            onLoadProjects: async () => {
              await this.refreshActiveProjectForRemoteCallback(
                'remote:fallback-load-projects',
                '远程恢复回调加载项目失败',
              );
            },
          });
        } catch (error) {
          this.resetRemoteChangeHandler(handler);
          throw error;
        }
        this.registeredHandler = handler;
        this.initialized = true;
      })
      .catch((error) => {
        this.warn('恢复回调初始化失败', error);
      })
      .finally(() => {
        this.initializing = false;
      });
  }

  teardown(): void {
    this.isTornDown = true;
    this.resetRemoteChangeHandler(this.registeredHandler);
  }

  private resetRemoteChangeHandler(handler: WorkspaceShellRemoteChangeHandler | null): void {
    if (!handler?.reset) return;
    try {
      handler.reset();
    } catch (error) {
      this.warn('远程恢复回调清理失败，已跳过', error);
    }
  }

  private loadRemoteChangeHandlerLazy(): Promise<WorkspaceShellRemoteChangeHandler | null> {
    if (this.remoteChangeHandlerPromise) {
      return this.remoteChangeHandlerPromise;
    }

    this.remoteChangeHandlerPromise = this.importRemoteChangeHandler()
      .catch((error) => {
        this.warn('RemoteChangeHandlerService 懒加载失败，降级为无回调恢复路径', error);
        return null;
      })
      .finally(() => {
        this.remoteChangeHandlerPromise = null;
      });

    return this.remoteChangeHandlerPromise;
  }

  private async refreshActiveProjectForRemoteCallback(
    reason: string,
    failureMessage: string,
  ): Promise<void> {
    if (this.isTornDown) {
      return;
    }

    try {
      await this.options.refreshActiveProjectSilent(reason);
    } catch (error) {
      if (this.isTornDown) {
        return;
      }
      this.warn(failureMessage, error);
    }
  }

  private async importRemoteChangeHandler(): Promise<WorkspaceShellRemoteChangeHandler> {
    if (this.options.importRemoteChangeHandler) {
      return this.options.importRemoteChangeHandler();
    }

    if (!this.options.injector) {
      throw new Error('RemoteChangeHandlerService injector unavailable');
    }

    const { RemoteChangeHandlerService } = await import('../../../services/remote-change-handler.service');
    return this.options.injector.get(RemoteChangeHandlerService);
  }

  private warn(message: string, error: unknown): void {
    try {
      this.options.warn(message, error);
    } catch {
      // Warning sinks must not break callback cleanup or degraded remote recovery paths.
    }
  }
}
