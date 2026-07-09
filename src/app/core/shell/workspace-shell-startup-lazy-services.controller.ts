import type { Injector } from '@angular/core';

export interface WorkspaceShellStartupDiagnosticsLike {
  initialize: () => Promise<unknown> | unknown;
}

export interface WorkspaceShellStartupLazyServicesOptions {
  injector?: Injector;
  initializeStartupFontScheduler?: () => Promise<void>;
  loadStartupDiagnostics?: () => Promise<WorkspaceShellStartupDiagnosticsLike[] | null>;
  warn: (message: string, error: unknown) => void;
}

export class WorkspaceShellStartupLazyServicesController {
  private startupFontSchedulerInitPromise: Promise<void> | null = null;
  private startupDiagnosticsPromise: Promise<WorkspaceShellStartupDiagnosticsLike[] | null> | null = null;
  private isTornDown = false;

  constructor(private readonly options: WorkspaceShellStartupLazyServicesOptions) {}

  scheduleStartupFontInitialization(): void {
    if (this.isTornDown) {
      return;
    }

    if (this.startupFontSchedulerInitPromise) {
      return;
    }

    this.startupFontSchedulerInitPromise = this.initializeStartupFontScheduler()
      .catch((error: unknown) => {
        if (this.isTornDown) {
          return;
        }

        this.startupFontSchedulerInitPromise = null;
        this.warn('延迟初始化字体调度器失败', error);
      });
  }

  initializeStartupDiagnosticsLazy(): void {
    if (this.isTornDown) {
      return;
    }

    if (this.startupDiagnosticsPromise) {
      return;
    }

    this.startupDiagnosticsPromise = this.loadStartupDiagnostics()
      .catch((error: unknown) => {
        if (this.isTornDown) {
          return null;
        }

        this.startupDiagnosticsPromise = null;
        this.warn('启动诊断服务懒加载失败，已跳过', error);
        return null;
      });

    void this.startupDiagnosticsPromise.then((services) => {
      if (!services || this.isTornDown) {
        return;
      }

      for (const service of services) {
        if (this.isTornDown) {
          return;
        }

        this.initializeStartupDiagnosticService(service);
      }
    });
  }

  teardown(): void {
    if (this.isTornDown) {
      return;
    }

    this.isTornDown = true;
    this.startupFontSchedulerInitPromise = null;
    this.startupDiagnosticsPromise = null;
  }

  private initializeStartupFontScheduler(): Promise<void> {
    if (this.options.initializeStartupFontScheduler) {
      return this.options.initializeStartupFontScheduler();
    }

    return import('../../../services/startup-font-scheduler.service')
      .then(({ StartupFontSchedulerService }) => {
        if (this.isTornDown) {
          return;
        }

        this.requireInjector().get(StartupFontSchedulerService).initialize();
      });
  }

  private loadStartupDiagnostics(): Promise<WorkspaceShellStartupDiagnosticsLike[] | null> {
    if (this.options.loadStartupDiagnostics) {
      return this.options.loadStartupDiagnostics();
    }

    return Promise.all([
      import('../../../services/storage-quota.service'),
      import('../../../services/indexeddb-health.service'),
    ]).then(([quotaModule, healthModule]) => {
      if (this.isTornDown) {
        return null;
      }

      const injector = this.requireInjector();
      const quota = injector.get(quotaModule.StorageQuotaService) as WorkspaceShellStartupDiagnosticsLike;
      const health = injector.get(healthModule.IndexedDBHealthService) as unknown as WorkspaceShellStartupDiagnosticsLike;
      return [quota, health];
    });
  }

  private initializeStartupDiagnosticService(
    service: WorkspaceShellStartupDiagnosticsLike,
  ): void {
    try {
      void Promise.resolve(service.initialize())
        .catch((error: unknown) => {
          if (!this.isTornDown) {
            this.warn('启动诊断服务初始化失败，已跳过', error);
          }
        });
    } catch (error) {
      if (!this.isTornDown) {
        this.warn('启动诊断服务初始化失败，已跳过', error);
      }
    }
  }

  private requireInjector(): Injector {
    if (!this.options.injector) {
      throw new Error('WorkspaceShellStartupLazyServicesController requires an injector');
    }

    return this.options.injector;
  }

  private warn(message: string, error: unknown): void {
    try {
      this.options.warn(message, error);
    } catch {
      // Startup diagnostics are best-effort and must not surface warning failures.
    }
  }
}
