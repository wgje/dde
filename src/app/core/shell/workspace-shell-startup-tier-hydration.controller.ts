export interface WorkspaceShellStartupTierHydrationControllerOptions {
  isEnabled: () => boolean;
  currentUserId: () => string | null;
  coreDataLoaded: () => boolean;
  isTierReady: (tier: 'p1' | 'p2') => boolean;
  markAuthReady: () => void;
  warmupTaskOperations: () => Promise<unknown>;
  isSidebarToolsDynamicLoadEnabled: () => boolean;
  preloadSidebarTools: (reason: 'p1') => void;
  initializeSyncCoordinator: () => void;
  startSyncRuntime: () => void;
}

export class WorkspaceShellStartupTierHydrationController {
  private interactionWarmupDone = false;
  private interactionWarmupPending = false;
  private syncHydrationDone = false;

  constructor(private readonly options: WorkspaceShellStartupTierHydrationControllerOptions) {}

  markAuthReadyIfReady(): void {
    if (!this.options.isEnabled()) {
      return;
    }

    if (!this.options.currentUserId() || !this.options.coreDataLoaded()) {
      return;
    }

    this.options.markAuthReady();
  }

  warmupInteractionIfReady(): void {
    if (
      !this.options.isEnabled()
      || !this.options.isTierReady('p1')
      || this.interactionWarmupDone
      || this.interactionWarmupPending
    ) {
      return;
    }

    this.interactionWarmupPending = true;
    let warmupTaskOperations: Promise<unknown>;
    try {
      warmupTaskOperations = Promise.resolve(this.options.warmupTaskOperations());
    } catch {
      this.interactionWarmupPending = false;
      return;
    }

    void warmupTaskOperations
      .then(() => {
        if (this.options.isSidebarToolsDynamicLoadEnabled()) {
          this.options.preloadSidebarTools('p1');
        }
        this.interactionWarmupDone = true;
      })
      .catch(() => {
        // Keep P1 warmup retryable; the next startup-tier effect can try again.
      })
      .finally(() => {
        this.interactionWarmupPending = false;
      });
  }

  startSyncHydrationIfReady(): void {
    if (!this.options.isEnabled() || !this.options.isTierReady('p2') || this.syncHydrationDone) {
      return;
    }

    try {
      this.options.initializeSyncCoordinator();
      this.options.startSyncRuntime();
      this.syncHydrationDone = true;
    } catch {
      // Keep P2 hydration retryable; the startup-tier effect will run again.
    }
  }
}
