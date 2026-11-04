import type { Injector } from '@angular/core';

export interface WorkspaceShellStartupFontSchedulerLazyLoadControllerOptions {
  injector?: Injector;
  initializeStartupFontScheduler?: () => Promise<void>;
  warn: (message: string, error: unknown) => void;
}

export class WorkspaceShellStartupFontSchedulerLazyLoadController {
  private initializationPromise: Promise<void> | null = null;
  private isTornDown = false;

  constructor(
    private readonly options: WorkspaceShellStartupFontSchedulerLazyLoadControllerOptions,
  ) {}

  initialize(): void {
    if (this.isTornDown || this.initializationPromise) return;

    this.initializationPromise = this.initializeScheduler()
      .catch((error: unknown) => {
        if (this.isTornDown) return;

        this.initializationPromise = null;
        this.warn('延迟初始化字体调度器失败', error);
      });
  }

  teardown(): void {
    if (this.isTornDown) return;

    this.isTornDown = true;
    this.initializationPromise = null;
  }

  private initializeScheduler(): Promise<void> {
    if (this.options.initializeStartupFontScheduler) {
      return this.options.initializeStartupFontScheduler();
    }

    return import('../../../services/startup-font-scheduler.service')
      .then(({ StartupFontSchedulerService }) => {
        if (this.isTornDown) return;

        this.requireInjector().get(StartupFontSchedulerService).initialize();
      });
  }

  private requireInjector(): Injector {
    if (!this.options.injector) {
      throw new Error(
        'WorkspaceShellStartupFontSchedulerLazyLoadController requires an injector',
      );
    }

    return this.options.injector;
  }

  private warn(message: string, error: unknown): void {
    try {
      this.options.warn(message, error);
    } catch {
      // Font initialization is best-effort and must not surface warning failures.
    }
  }
}
