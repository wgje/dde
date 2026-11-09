import type { Injector } from '@angular/core';

export interface WorkspaceShellStartupDiagnosticsLike {
  initialize(): Promise<unknown> | unknown;
}

export interface WorkspaceShellStartupDiagnosticsLazyLoadControllerOptions {
  injector?: Injector;
  loadStartupDiagnostics?: () => Promise<WorkspaceShellStartupDiagnosticsLike[] | null>;
  warn: (message: string, error: unknown) => void;
}

export class WorkspaceShellStartupDiagnosticsLazyLoadController {
  private diagnosticsPromise: Promise<WorkspaceShellStartupDiagnosticsLike[] | null> | null = null;
  private isTornDown = false;

  constructor(
    private readonly options: WorkspaceShellStartupDiagnosticsLazyLoadControllerOptions,
  ) {}

  initialize(): void {
    if (this.isTornDown || this.diagnosticsPromise) return;

    this.diagnosticsPromise = this.loadDiagnostics()
      .catch((error: unknown) => {
        if (this.isTornDown) return null;

        this.diagnosticsPromise = null;
        this.warn('启动诊断服务懒加载失败，已跳过', error);
        return null;
      });

    void this.diagnosticsPromise.then((services) => {
      if (!services || this.isTornDown) return;

      for (const service of services) {
        if (this.isTornDown) return;
        this.initializeService(service);
      }
    });
  }

  teardown(): void {
    if (this.isTornDown) return;

    this.isTornDown = true;
    this.diagnosticsPromise = null;
  }

  private loadDiagnostics(): Promise<WorkspaceShellStartupDiagnosticsLike[] | null> {
    if (this.options.loadStartupDiagnostics) {
      return this.options.loadStartupDiagnostics();
    }

    return Promise.all([
      import('../../../services/storage-quota.service'),
      import('../../../services/indexeddb-health.service'),
    ]).then(([quotaModule, healthModule]) => {
      if (this.isTornDown) return null;

      const injector = this.requireInjector();
      const quota = injector.get(
        quotaModule.StorageQuotaService,
      ) as WorkspaceShellStartupDiagnosticsLike;
      const health = injector.get(
        healthModule.IndexedDBHealthService,
      ) as unknown as WorkspaceShellStartupDiagnosticsLike;
      return [quota, health];
    });
  }

  private initializeService(service: WorkspaceShellStartupDiagnosticsLike): void {
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
      throw new Error(
        'WorkspaceShellStartupDiagnosticsLazyLoadController requires an injector',
      );
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
