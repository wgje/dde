import { POLLING_CHECK_DELAY } from '../config/timeout.config';

export interface TaskRecordSyncResultLogger {
  debug(message: string, context?: unknown): void;
  warn(message: string, context?: unknown): void;
}

export interface TaskRecordSyncResultControllerDependencies {
  currentOwnerUserId(): string | null;
  getSnapshotCreatedAt(snapshotId: string): number | null;
  commitSnapshot(snapshotId: string): void;
  discardSnapshot(snapshotId: string): void;
  syncError(): unknown;
  hasPendingLocalChanges(): boolean;
  logger: TaskRecordSyncResultLogger;
}

interface TrackedSyncResult {
  snapshotId: string;
  ownerUserId: string | null;
  nextCheckAt: number;
}

const SYNC_RESULT_MAX_WAIT_MS = 30_000;

/** Coordinates optimistic snapshot settlement through one cancellable polling timer. */
export class TaskRecordSyncResultController {
  private readonly tracked = new Map<string, TrackedSyncResult>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private timerDueAt: number | null = null;
  private destroyed = false;

  constructor(private readonly dependencies: TaskRecordSyncResultControllerDependencies) {}

  track(snapshotId: string): void {
    if (this.destroyed) {
      return;
    }

    let ownerUserId: string | null;
    try {
      ownerUserId = this.dependencies.currentOwnerUserId();
    } catch (error) {
      this.safeWarn('读取同步快照 owner 失败，本次暂不启动轮询', { snapshotId, error });
      return;
    }

    this.discardEntriesFromOtherOwners(ownerUserId);
    if (this.tracked.has(snapshotId)) {
      return;
    }

    this.tracked.set(snapshotId, {
      snapshotId,
      ownerUserId,
      nextCheckAt: Date.now() + POLLING_CHECK_DELAY.SYNC_READY,
    });
    this.scheduleNextCheck();
  }

  destroy(): void {
    if (this.destroyed) {
      return;
    }

    this.destroyed = true;
    this.clearTimer();
    this.tracked.clear();
  }

  private runDueChecks(): void {
    if (this.destroyed) {
      return;
    }

    const now = Date.now();
    for (const entry of [...this.tracked.values()]) {
      if (entry.nextCheckAt > now) {
        continue;
      }
      this.checkEntry(entry, now);
    }

    this.scheduleNextCheck();
  }

  private checkEntry(entry: TrackedSyncResult, now: number): void {
    try {
      const currentOwnerUserId = this.dependencies.currentOwnerUserId();
      if (currentOwnerUserId !== entry.ownerUserId) {
        this.discardEntryForOwnerChange(entry, currentOwnerUserId);
        return;
      }

      const createdAt = this.dependencies.getSnapshotCreatedAt(entry.snapshotId);
      if (createdAt === null) {
        this.tracked.delete(entry.snapshotId);
        return;
      }

      const shouldKeepWaiting = now - createdAt < SYNC_RESULT_MAX_WAIT_MS;
      const syncError = this.dependencies.syncError();
      if (syncError) {
        if (shouldKeepWaiting) {
          this.safeWarn('同步暂不可用，保留本地快照等待后台重试', {
            snapshotId: entry.snapshotId,
            error: syncError,
          });
          this.reschedule(entry, now);
          return;
        }

        this.commitEntry(entry, '同步错误等待超时，提交本地快照并交由后台重试收敛', {
          error: syncError,
        });
        return;
      }

      if (!this.dependencies.hasPendingLocalChanges()) {
        this.commitEntry(entry, '同步成功，提交快照');
        return;
      }

      if (shouldKeepWaiting) {
        this.reschedule(entry, now);
        return;
      }

      this.commitEntry(entry, '同步超时，假定成功');
    } catch (error) {
      this.safeWarn('检查同步快照结果失败，稍后重试', {
        snapshotId: entry.snapshotId,
        error,
      });
      this.reschedule(entry, now);
    }
  }

  private commitEntry(
    entry: TrackedSyncResult,
    message: string,
    context: Record<string, unknown> = {},
  ): void {
    this.dependencies.commitSnapshot(entry.snapshotId);
    this.tracked.delete(entry.snapshotId);
    this.safeDebug(message, { snapshotId: entry.snapshotId, ...context });
  }

  private discardEntriesFromOtherOwners(currentOwnerUserId: string | null): void {
    for (const entry of [...this.tracked.values()]) {
      if (entry.ownerUserId !== currentOwnerUserId) {
        this.discardEntryForOwnerChange(entry, currentOwnerUserId);
      }
    }
  }

  private discardEntryForOwnerChange(
    entry: TrackedSyncResult,
    currentOwnerUserId: string | null,
  ): void {
    this.tracked.delete(entry.snapshotId);
    try {
      this.dependencies.discardSnapshot(entry.snapshotId);
    } catch (error) {
      this.safeWarn('owner 变化后丢弃旧同步快照失败', {
        snapshotId: entry.snapshotId,
        ownerUserId: entry.ownerUserId,
        currentOwnerUserId,
        error,
      });
      return;
    }

    this.safeDebug('owner 已变化，停止跟踪旧同步快照', {
      snapshotId: entry.snapshotId,
      ownerUserId: entry.ownerUserId,
      currentOwnerUserId,
    });
  }

  private reschedule(entry: TrackedSyncResult, now: number): void {
    if (this.destroyed || this.tracked.get(entry.snapshotId) !== entry) {
      return;
    }
    entry.nextCheckAt = now + POLLING_CHECK_DELAY.CONDITION_READY;
  }

  private scheduleNextCheck(): void {
    if (this.destroyed || this.tracked.size === 0) {
      this.clearTimer();
      return;
    }

    let nextCheckAt = Number.POSITIVE_INFINITY;
    for (const entry of this.tracked.values()) {
      nextCheckAt = Math.min(nextCheckAt, entry.nextCheckAt);
    }

    if (this.timer && this.timerDueAt === nextCheckAt) {
      return;
    }

    this.clearTimer();
    this.timerDueAt = nextCheckAt;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.timerDueAt = null;
      this.runDueChecks();
    }, Math.max(0, nextCheckAt - Date.now()));
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.timerDueAt = null;
  }

  private safeDebug(message: string, context?: unknown): void {
    try {
      this.dependencies.logger.debug(message, context);
    } catch {
      // Logging must never break snapshot settlement.
    }
  }

  private safeWarn(message: string, context?: unknown): void {
    try {
      this.dependencies.logger.warn(message, context);
    } catch {
      // Logging must never break snapshot settlement.
    }
  }
}
