import type { Injector } from '@angular/core';

import {
  createWorkspaceShellStartupLazyServicesControllerLoader,
  type WorkspaceShellStartupLazyServicesControllerLoaderOptions,
} from './workspace-shell-startup-lazy-services-controller-loader.factory';

export interface WorkspaceShellStartupLazyServicesHostDelegate {
  initializeStartupDiagnosticsLazy(): void;
  scheduleStartupFontInitialization(): void;
  teardown(): void;
}

export interface WorkspaceShellStartupLazyServicesHostOptions
  extends WorkspaceShellStartupLazyServicesControllerLoaderOptions {
  injector?: Injector;
  warn: (message: string, error: unknown) => void;
}

export class WorkspaceShellStartupLazyServicesHostController {
  private controllerPromise: Promise<WorkspaceShellStartupLazyServicesHostDelegate> | null = null;
  private resolvedController: WorkspaceShellStartupLazyServicesHostDelegate | null = null;
  private readonly loadController: () => Promise<WorkspaceShellStartupLazyServicesHostDelegate>;
  private isTornDown = false;

  constructor(private readonly options: WorkspaceShellStartupLazyServicesHostOptions) {
    this.loadController = createWorkspaceShellStartupLazyServicesControllerLoader(options);
  }

  scheduleStartupFontInitialization(): void {
    if (this.isTornDown) {
      return;
    }

    void this.resolveController()
      .then(controller => {
        if (!this.isTornDown) {
          try {
            controller.scheduleStartupFontInitialization();
          } catch (error) {
            this.warn('启动字体调度初始化转发失败，已跳过', error);
          }
        }
      })
      .catch(() => undefined);
  }

  initializeStartupDiagnosticsLazy(): void {
    if (this.isTornDown) {
      return;
    }

    void this.resolveController()
      .then(controller => {
        if (!this.isTornDown) {
          try {
            controller.initializeStartupDiagnosticsLazy();
          } catch (error) {
            this.warn('启动诊断 lazy 初始化转发失败，已跳过', error);
          }
        }
      })
      .catch(() => undefined);
  }

  teardown(): void {
    if (this.isTornDown) {
      return;
    }

    this.isTornDown = true;
    this.controllerPromise = null;
    this.teardownResolvedController();
  }

  private resolveController(): Promise<WorkspaceShellStartupLazyServicesHostDelegate> {
    return (this.controllerPromise ??= this.createStartupLazyServicesControllerSafely()
      .then(controller => {
        this.resolvedController = controller;
        if (this.isTornDown) {
          this.teardownResolvedController();
        }
        return controller;
      })
      .catch(error => {
        if (this.isTornDown) {
          throw error;
        }

        this.controllerPromise = null;
        this.warn('启动 lazy services controller 加载失败，已跳过', error);
        throw error;
      }));
  }

  private createStartupLazyServicesControllerSafely(): Promise<WorkspaceShellStartupLazyServicesHostDelegate> {
    try {
      return Promise.resolve(this.createStartupLazyServicesController());
    } catch (error) {
      return Promise.reject(error);
    }
  }

  private createStartupLazyServicesController(): Promise<WorkspaceShellStartupLazyServicesHostDelegate> {
    return this.loadController();
  }

  private teardownResolvedController(): void {
    const controller = this.resolvedController;
    if (!controller) {
      return;
    }

    this.resolvedController = null;
    try {
      controller.teardown();
    } catch (error) {
      this.warn('启动 lazy services controller 清理失败，已跳过', error);
    }
  }

  private warn(message: string, error: unknown): void {
    try {
      this.options.warn(message, error);
    } catch {
      // Warning sinks must not interrupt startup lazy-services fallback or teardown.
    }
  }
}
