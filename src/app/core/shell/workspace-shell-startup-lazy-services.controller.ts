import type { Injector } from '@angular/core';

import {
  WorkspaceShellStartupDiagnosticsLazyLoadController,
  type WorkspaceShellStartupDiagnosticsLike,
} from './workspace-shell-startup-diagnostics-lazy-load.controller';
import { WorkspaceShellStartupFontSchedulerLazyLoadController } from './workspace-shell-startup-font-scheduler-lazy-load.controller';

export type { WorkspaceShellStartupDiagnosticsLike } from './workspace-shell-startup-diagnostics-lazy-load.controller';

export interface WorkspaceShellStartupLazyServicesOptions {
  injector?: Injector;
  initializeStartupFontScheduler?: () => Promise<void>;
  loadStartupDiagnostics?: () => Promise<WorkspaceShellStartupDiagnosticsLike[] | null>;
  warn: (message: string, error: unknown) => void;
}

export class WorkspaceShellStartupLazyServicesController {
  private readonly diagnostics: WorkspaceShellStartupDiagnosticsLazyLoadController;
  private readonly fontScheduler: WorkspaceShellStartupFontSchedulerLazyLoadController;

  constructor(options: WorkspaceShellStartupLazyServicesOptions) {
    this.fontScheduler = new WorkspaceShellStartupFontSchedulerLazyLoadController(options);
    this.diagnostics = new WorkspaceShellStartupDiagnosticsLazyLoadController(options);
  }

  scheduleStartupFontInitialization(): void {
    this.fontScheduler.initialize();
  }

  initializeStartupDiagnosticsLazy(): void {
    this.diagnostics.initialize();
  }

  teardown(): void {
    this.fontScheduler.teardown();
    this.diagnostics.teardown();
  }
}
