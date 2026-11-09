export interface WorkspaceShellNgOnInitStartupControllerOptions {
  setupRouteSync: () => void;
  cleanupRouteSync?: () => void;
  initializeLazyLifecycles: () => void;
  setupSidebarResize: () => void;
  cleanupSidebarResize?: () => void;
  setupActionsDocumentClick: () => void;
  scheduleSessionBootstrap: () => void;
  scheduleStartupFontInitialization: () => void;
  initializeStartupTier: () => void;
  scheduleFocusModePreload: (reason: 'startup') => void;
  preloadSidebarTools: (reason: 'startup') => void;
  setupFocusMountIntent: () => void;
  cleanupFocusMountIntent?: () => void;
  warmMobileProjectGateSnapshot: () => void;
  isSidebarToolsDynamicLoadEnabled: () => boolean;
  isTieredStartupHydration: () => boolean;
  scheduleLegacySyncRuntime: (callback: () => void) => void | (() => void);
  initializeSyncCoordinator: () => void;
  startSimpleSyncRuntime: () => void;
  preloadCommonModals: () => void;
  scheduleStartupDiagnostics: () => void | (() => void);
  validateCriticalFeatureFlags: () => void;
  warn?: (message: string, error: unknown) => void;
}

export class WorkspaceShellNgOnInitStartupController {
  private cleanupScheduledStartupTasks: Array<() => void> = [];
  private cleanupRegisteredStartupListeners: Array<() => void> = [];
  private hasInitialized = false;
  private isTornDown = false;

  constructor(private readonly options: WorkspaceShellNgOnInitStartupControllerOptions) {}

  initialize(): void {
    if (this.isTornDown) return;
    if (this.hasInitialized) return;

    this.hasInitialized = true;

    const cleanupStartIndex = this.cleanupScheduledStartupTasks.length;
    try {
      this.options.setupRouteSync();
      this.trackRegisteredStartupListenerCleanup(this.options.cleanupRouteSync);
      this.options.initializeLazyLifecycles();
      this.options.setupSidebarResize();
      this.trackRegisteredStartupListenerCleanup(this.options.cleanupSidebarResize);
      this.options.setupActionsDocumentClick();
      this.options.scheduleSessionBootstrap();
      this.options.scheduleStartupFontInitialization();
      this.options.initializeStartupTier();
      this.options.scheduleFocusModePreload('startup');

      if (!this.options.isSidebarToolsDynamicLoadEnabled()) {
        this.options.preloadSidebarTools('startup');
      }

      this.options.setupFocusMountIntent();
      this.trackRegisteredStartupListenerCleanup(this.options.cleanupFocusMountIntent);
      this.options.warmMobileProjectGateSnapshot();

      if (!this.options.isTieredStartupHydration()) {
        const cleanup = this.options.scheduleLegacySyncRuntime(() => {
          this.runScheduledStartupTask(() => {
            if (this.isTornDown) return;
            this.options.initializeSyncCoordinator();
            this.options.startSimpleSyncRuntime();
          });
        });
        this.trackCleanup(cleanup);
      }

      this.options.preloadCommonModals();
      this.trackCleanup(this.options.scheduleStartupDiagnostics());
      this.options.validateCriticalFeatureFlags();
    } catch (error) {
      this.hasInitialized = false;
      this.runRegisteredStartupListenerCleanups();
      const pendingCleanups = this.cleanupScheduledStartupTasks.splice(cleanupStartIndex);
      for (const cleanup of pendingCleanups) {
        this.runScheduledStartupCleanup(cleanup);
      }
      throw error;
    }
  }

  teardown(): void {
    if (this.isTornDown) return;

    this.isTornDown = true;
    this.runRegisteredStartupListenerCleanups();
    for (const cleanup of this.cleanupScheduledStartupTasks.splice(0)) {
      this.runScheduledStartupCleanup(cleanup);
    }
  }

  private trackRegisteredStartupListenerCleanup(cleanup: (() => void) | undefined): void {
    if (cleanup) {
      this.cleanupRegisteredStartupListeners.push(cleanup);
    }
  }

  private runRegisteredStartupListenerCleanups(): void {
    for (const cleanup of this.cleanupRegisteredStartupListeners.splice(0).reverse()) {
      this.runScheduledStartupCleanup(cleanup);
    }
  }

  private trackCleanup(cleanup: void | (() => void)): void {
    if (cleanup) {
      this.cleanupScheduledStartupTasks.push(cleanup);
    }
  }

  private runScheduledStartupCleanup(cleanup: () => void): void {
    try {
      cleanup();
    } catch (error) {
      this.warnStartupCleanupFailure(error);
    }
  }

  private runScheduledStartupTask(task: () => void): void {
    try {
      task();
    } catch (error) {
      this.warnStartupTaskFailure(error);
    }
  }

  private warnStartupTaskFailure(error: unknown): void {
    const warn = this.options.warn;
    if (!warn) return;

    try {
      warn('ngOnInit startup 定时任务执行失败，已跳过本次任务', error);
    } catch {
      // Logger failure must not interrupt scheduled startup boundaries.
    }
  }

  private warnStartupCleanupFailure(error: unknown): void {
    const warn = this.options.warn;
    if (!warn) return;

    try {
      warn('ngOnInit startup 定时清理任务执行失败，已继续清理后续任务', error);
    } catch {
      // Logger failure must not interrupt best-effort startup cleanup.
    }
  }
}
