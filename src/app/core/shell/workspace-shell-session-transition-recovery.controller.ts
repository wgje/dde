import { WorkspaceShellOwnerTransitionController } from './workspace-shell-owner-transition.controller';
import type {
  WorkspaceShellSessionInvalidatedEvent,
  WorkspaceShellSessionRestoredEvent,
} from './workspace-shell-session-transition-subscriptions.controller';

export interface WorkspaceShellSessionTransitionRecoveryControllerOptions {
  currentUserId: () => string | null;
  completeCrossTabSessionRestore: (userId: string) => void;
  reloadActionQueue: () => Promise<void>;
  replayActionQueue: () => Promise<unknown>;
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
}

export class WorkspaceShellSessionTransitionRecoveryController {
  private readonly ownerTransition: WorkspaceShellOwnerTransitionController;
  private lifecycleGeneration = 0;
  private transitionGeneration = 0;
  private sessionTransitionPending = false;

  constructor(
    private readonly options: WorkspaceShellSessionTransitionRecoveryControllerOptions,
  ) {
    this.ownerTransition = new WorkspaceShellOwnerTransitionController({
      resetFocusEntrySyncPulseState: options.resetFocusEntrySyncPulseState,
      setLaunchSnapshotWriteBlocked: options.setLaunchSnapshotWriteBlocked,
      cancelPendingLaunchSnapshotPersist: options.cancelPendingLaunchSnapshotPersist,
      stopSyncRuntime: options.stopSyncRuntime,
      clearProjectSubscription: options.clearProjectSubscription,
      destroySyncPulse: options.destroySyncPulse,
      warn: options.warn,
    });
  }

  cleanup(cleanupSubscriptions: () => void): void {
    this.lifecycleGeneration += 1;
    this.transitionGeneration += 1;
    this.sessionTransitionPending = false;
    cleanupSubscriptions();
    this.options.setLaunchSnapshotWriteBlocked(false);
  }

  async handleSessionRestored(event: WorkspaceShellSessionRestoredEvent): Promise<void> {
    if (event.source !== 'AuthService.storageBridge') {
      return;
    }
    const lifecycleGeneration = this.lifecycleGeneration;
    const transitionGeneration = ++this.transitionGeneration;

    this.warn('跨标签页会话恢复，切换 owner 视图', {
      restoredUserId: event.userId,
      source: event.source,
    });
    this.sessionTransitionPending = true;
    this.ownerTransition.prepare();

    try {
      await this.options.setCurrentUser(event.userId, { forceLoad: true });

      if (!this.isTransitionCurrent(lifecycleGeneration, transitionGeneration)) {
        return;
      }

      if (this.options.currentUserId() !== event.userId) {
        return;
      }

      this.options.completeCrossTabSessionRestore(event.userId);
      if (!this.isTransitionCurrent(lifecycleGeneration, transitionGeneration)) return;
      await this.restoreAndReplayActionQueueSafely(
        lifecycleGeneration,
        transitionGeneration,
        event,
      );
      if (!this.isTransitionCurrent(lifecycleGeneration, transitionGeneration)) return;
      if (this.options.currentUserId() !== event.userId) return;
      if (!this.options.isTieredStartupHydration() || this.options.isStartupTierReady('p2')) {
        this.options.startSyncRuntime();
      }
      this.sessionTransitionPending = false;
    } catch (error) {
      if (!this.isTransitionCurrent(lifecycleGeneration, transitionGeneration)) {
        return;
      }

      this.warn('跨标签页会话恢复失败，已保持同步运行时暂停', {
        restoredUserId: event.userId,
        source: event.source,
        error,
      });
    } finally {
      if (this.isTransitionCurrent(lifecycleGeneration, transitionGeneration)) {
        this.options.setLaunchSnapshotWriteBlocked(false);
      }
    }
  }

  async handleSessionInvalidated(event: WorkspaceShellSessionInvalidatedEvent): Promise<void> {
    const lifecycleGeneration = this.lifecycleGeneration;
    const transitionGeneration = ++this.transitionGeneration;

    this.warn('会话失效，停止同步运行时并清空旧 owner 视图', {
      invalidatedUserId: event.userId,
      source: event.source,
    });
    this.sessionTransitionPending = true;
    this.ownerTransition.prepare();

    try {
      await this.options.setCurrentUser(null, {
        skipPersistentReload: true,
        previousUserIdHint: event.userId,
        preserveOfflineSnapshot: true,
      });
      if (this.isTransitionCurrent(lifecycleGeneration, transitionGeneration)) {
        this.sessionTransitionPending = false;
        this.options.setLaunchSnapshotWriteBlocked(false);
      }
    } catch (error) {
      if (!this.isTransitionCurrent(lifecycleGeneration, transitionGeneration)) {
        return;
      }

      this.warn('会话失效处理失败，旧 owner 视图清理可能未完成', {
        invalidatedUserId: event.userId,
        source: event.source,
        error,
      });
    }
  }

  private isTransitionCurrent(lifecycleGeneration: number, transitionGeneration: number): boolean {
    return this.lifecycleGeneration === lifecycleGeneration
      && this.transitionGeneration === transitionGeneration;
  }

  private async replayActionQueueSafely(
    lifecycleGeneration: number,
    transitionGeneration: number,
    event: WorkspaceShellSessionRestoredEvent,
  ): Promise<void> {
    try {
      await this.options.replayActionQueue();
    } catch (error) {
      if (this.isTransitionCurrent(lifecycleGeneration, transitionGeneration)) {
        this.warn('跨标签页会话恢复后 ActionQueue 重放失败，保留队列等待后续自动重试', {
          restoredUserId: event.userId,
          source: event.source,
          error,
        });
      }
    }
  }

  private async restoreAndReplayActionQueueSafely(
    lifecycleGeneration: number,
    transitionGeneration: number,
    event: WorkspaceShellSessionRestoredEvent,
  ): Promise<void> {
    const reloaded = await this.reloadActionQueueSafely(
      lifecycleGeneration,
      transitionGeneration,
      event,
    );
    if (!this.isTransitionCurrent(lifecycleGeneration, transitionGeneration)) return;
    if (this.options.currentUserId() !== event.userId) return;
    if (!reloaded) return;
    await this.replayActionQueueSafely(
      lifecycleGeneration,
      transitionGeneration,
      event,
    );
  }

  private async reloadActionQueueSafely(
    lifecycleGeneration: number,
    transitionGeneration: number,
    event: WorkspaceShellSessionRestoredEvent,
  ): Promise<boolean> {
    try {
      await this.options.reloadActionQueue();
      return true;
    } catch (error) {
      if (this.isTransitionCurrent(lifecycleGeneration, transitionGeneration)) {
        this.warn('跨标签页会话恢复后重新加载持久化 ActionQueue 失败，跳过本次重放并保留队列等待后续自动重试', {
          restoredUserId: event.userId,
          source: event.source,
          error,
        });
      }
      return false;
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
