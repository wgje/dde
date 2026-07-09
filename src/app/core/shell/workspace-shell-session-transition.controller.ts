export interface WorkspaceShellSessionRestoredEvent {
  type: 'session-restored';
  source: string;
  userId: string;
}

export interface WorkspaceShellSessionInvalidatedEvent {
  type: 'session-invalidated';
  source: string;
  userId: string | null;
}

export interface WorkspaceShellSessionTransitionSubscription {
  unsubscribe: () => void;
}

export interface WorkspaceShellSessionTransitionControllerOptions {
  currentUserId: () => string | null;
  completeCrossTabSessionRestore: (userId: string) => void;
  resetFocusEntrySyncPulseState: (rearmIntentListener: boolean) => void;
  setLaunchSnapshotWriteBlocked: (blocked: boolean) => void;
  cancelPendingLaunchSnapshotPersist: () => void;
  stopSyncRuntime: () => void;
  startSyncRuntime: () => void;
  clearProjectSubscription: () => void;
  destroySyncPulse: () => void;
  setCurrentUser: (
    userId: string | null,
    options:
      | { forceLoad: true }
      | {
        skipPersistentReload: true;
        previousUserIdHint: string | null;
        preserveOfflineSnapshot: true;
      },
  ) => Promise<void>;
  isTieredStartupHydration: () => boolean;
  isStartupTierReady: (tier: 'p2') => boolean;
  warn: (message: string, context?: unknown) => void;
  subscribeToSessionRestored?: (
    listener: (event: WorkspaceShellSessionRestoredEvent) => void,
  ) => WorkspaceShellSessionTransitionSubscription;
  subscribeToSessionInvalidated?: (
    listener: (event: WorkspaceShellSessionInvalidatedEvent) => void,
  ) => WorkspaceShellSessionTransitionSubscription;
}

export class WorkspaceShellSessionTransitionController {
  private sessionRestoredSubscription: WorkspaceShellSessionTransitionSubscription | null = null;
  private sessionInvalidatedSubscription: WorkspaceShellSessionTransitionSubscription | null = null;
  private lifecycleGeneration = 0;

  constructor(private readonly options: WorkspaceShellSessionTransitionControllerOptions) {}

  setupSessionHandlers(): void {
    this.cleanup();
    let sessionRestoredSubscription: WorkspaceShellSessionTransitionSubscription | null = null;
    let sessionInvalidatedSubscription: WorkspaceShellSessionTransitionSubscription | null = null;

    try {
      sessionRestoredSubscription = this.options.subscribeToSessionRestored?.((event) => {
        void this.handleSessionRestored(event);
      }) ?? null;
      sessionInvalidatedSubscription = this.options.subscribeToSessionInvalidated?.((event) => {
        void this.handleSessionInvalidated(event);
      }) ?? null;

      this.sessionRestoredSubscription = sessionRestoredSubscription;
      this.sessionInvalidatedSubscription = sessionInvalidatedSubscription;
    } catch (error) {
      this.unsubscribeSessionTransition(sessionRestoredSubscription);
      this.unsubscribeSessionTransition(sessionInvalidatedSubscription);
      this.sessionRestoredSubscription = null;
      this.sessionInvalidatedSubscription = null;
      throw error;
    }
  }

  cleanup(): void {
    this.lifecycleGeneration += 1;
    const sessionRestoredSubscription = this.sessionRestoredSubscription;
    const sessionInvalidatedSubscription = this.sessionInvalidatedSubscription;
    this.sessionRestoredSubscription = null;
    this.sessionInvalidatedSubscription = null;
    this.unsubscribeSessionTransition(sessionRestoredSubscription);
    this.unsubscribeSessionTransition(sessionInvalidatedSubscription);
    this.options.setLaunchSnapshotWriteBlocked(false);
  }

  async handleSessionRestored(event: WorkspaceShellSessionRestoredEvent): Promise<void> {
    const lifecycleGeneration = this.lifecycleGeneration;

    if (event.source !== 'AuthService.storageBridge') {
      return;
    }

    if (this.options.currentUserId() === event.userId) {
      this.options.completeCrossTabSessionRestore(event.userId);
      return;
    }

    this.warn('跨标签页会话恢复，切换 owner 视图', {
      restoredUserId: event.userId,
      source: event.source,
    });
    this.prepareOwnerTransition();

    try {
      await this.options.setCurrentUser(event.userId, { forceLoad: true });

      if (!this.isLifecycleCurrent(lifecycleGeneration)) {
        return;
      }

      if (this.options.currentUserId() !== event.userId) {
        return;
      }

      this.options.completeCrossTabSessionRestore(event.userId);
      if (!this.options.isTieredStartupHydration() || this.options.isStartupTierReady('p2')) {
        this.options.startSyncRuntime();
      }
    } catch (error) {
      if (!this.isLifecycleCurrent(lifecycleGeneration)) {
        return;
      }

      this.warn('跨标签页会话恢复失败，已保持同步运行时暂停', {
        restoredUserId: event.userId,
        source: event.source,
        error,
      });
    } finally {
      if (this.isLifecycleCurrent(lifecycleGeneration)) {
        this.options.setLaunchSnapshotWriteBlocked(false);
      }
    }
  }

  async handleSessionInvalidated(event: WorkspaceShellSessionInvalidatedEvent): Promise<void> {
    const lifecycleGeneration = this.lifecycleGeneration;

    this.warn('会话失效，停止同步运行时并清空旧 owner 视图', {
      invalidatedUserId: event.userId,
      source: event.source,
    });
    this.prepareOwnerTransition();

    try {
      await this.options.setCurrentUser(null, {
        skipPersistentReload: true,
        previousUserIdHint: event.userId,
        preserveOfflineSnapshot: true,
      });
    } catch (error) {
      if (!this.isLifecycleCurrent(lifecycleGeneration)) {
        return;
      }

      this.warn('会话失效处理失败，旧 owner 视图清理可能未完成', {
        invalidatedUserId: event.userId,
        source: event.source,
        error,
      });
    } finally {
      if (this.isLifecycleCurrent(lifecycleGeneration)) {
        this.options.setLaunchSnapshotWriteBlocked(false);
      }
    }
  }

  private prepareOwnerTransition(): void {
    this.runOwnerTransitionStep('resetFocusEntrySyncPulseState', () => {
      this.options.resetFocusEntrySyncPulseState(false);
    });
    this.runOwnerTransitionStep('setLaunchSnapshotWriteBlocked', () => {
      this.options.setLaunchSnapshotWriteBlocked(true);
    });
    this.runOwnerTransitionStep('cancelPendingLaunchSnapshotPersist', () => {
      this.options.cancelPendingLaunchSnapshotPersist();
    });
    this.runOwnerTransitionStep('stopSyncRuntime', () => {
      this.options.stopSyncRuntime();
    });
    this.runOwnerTransitionStep('clearProjectSubscription', () => {
      this.options.clearProjectSubscription();
    });
    this.runOwnerTransitionStep('destroySyncPulse', () => {
      this.options.destroySyncPulse();
    });
  }

  private isLifecycleCurrent(lifecycleGeneration: number): boolean {
    return this.lifecycleGeneration === lifecycleGeneration;
  }

  private runOwnerTransitionStep(step: string, action: () => void): void {
    try {
      action();
    } catch (error) {
      this.warn('会话 owner 过渡步骤失败，已继续后续清理', {
        step,
        error,
      });
    }
  }

  private unsubscribeSessionTransition(
    subscription: WorkspaceShellSessionTransitionSubscription | null,
  ): void {
    try {
      subscription?.unsubscribe();
    } catch (error) {
      this.warn('Workspace session transition subscription cleanup failed', error);
    }
  }

  private warn(message: string, context?: unknown): void {
    try {
      this.options.warn(message, context);
    } catch {
      // Warning sinks must not interrupt session transition state changes.
    }
  }
}
