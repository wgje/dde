import type { DockSnapshot } from '../models/parking-dock';
import { TimerHandle } from '../utils/timer-handle';
import type { CategoryLogger } from './logger.service';

export interface DockCloudPushSchedulerCallbacks {
  scheduleLocalPersist: (snapshot: DockSnapshot, userId: string) => void;
  persistLocalSnapshotImmediately: (snapshot: DockSnapshot, userId: string) => Promise<boolean>;
  getNonCriticalHoldDelay: () => number;
  getCurrentSnapshotUserId: () => string | null;
}

interface DockCloudPushSchedulerControllerOptions {
  isDestroyed: () => boolean;
  isCurrentUser: (userId: string) => boolean;
  enqueueFocusSessionSync: (
    userId: string,
    snapshot: DockSnapshot,
  ) => Promise<boolean>;
  logger: Pick<CategoryLogger, 'debug' | 'error'>;
}

interface DockCloudPushScheduleResult {
  nextFocusMode: boolean;
  shouldFastTrackWidgetSync: boolean;
}

export class DockCloudPushSchedulerController {
  private readonly cloudPushTimer = new TimerHandle();
  private readonly lastScheduledFocusMode = new Map<string, boolean>();
  private pushGeneration = 0;

  constructor(private readonly options: DockCloudPushSchedulerControllerOptions) {}

  seedFocusModeBaseline(userId: string | null, snapshot: DockSnapshot | null): void {
    if (!userId || !snapshot) {
      return;
    }

    this.lastScheduledFocusMode.set(userId, snapshot.focusMode === true);
  }

  scheduleCloudPush(
    userId: string,
    frozenSnapshot: DockSnapshot,
    callbacks: DockCloudPushSchedulerCallbacks,
    debounceMs: number,
  ): DockCloudPushScheduleResult {
    const nextFocusMode = frozenSnapshot.focusMode === true;
    const shouldFastTrackWidgetSync =
      this.consumeFocusModeTransition(userId, nextFocusMode);
    const delayMs = shouldFastTrackWidgetSync ? 0 : debounceMs;
    const generation = ++this.pushGeneration;

    this.scheduleCloudPushRunner(userId, frozenSnapshot, callbacks, delayMs, generation);

    return { nextFocusMode, shouldFastTrackWidgetSync };
  }

  cancelPendingPush(): void {
    this.pushGeneration += 1;
    this.cloudPushTimer.cancel();
  }

  cancel(): void {
    this.cancelPendingPush();
    this.lastScheduledFocusMode.clear();
  }

  private consumeFocusModeTransition(userId: string, nextFocusMode: boolean): boolean {
    const prevFocusMode = this.lastScheduledFocusMode.get(userId);
    this.lastScheduledFocusMode.set(userId, nextFocusMode);
    return prevFocusMode !== undefined && prevFocusMode !== nextFocusMode;
  }

  private scheduleCloudPushRunner(
    userId: string,
    frozenSnapshot: DockSnapshot,
    callbacks: DockCloudPushSchedulerCallbacks,
    delayMs: number,
    generation: number,
  ): void {
    const runPush = (): void => this.runScheduledCloudPush(
      userId,
      frozenSnapshot,
      callbacks,
      runPush,
      generation,
    );
    this.cloudPushTimer.schedule(runPush, delayMs);
  }

  private runScheduledCloudPush(
    userId: string,
    frozenSnapshot: DockSnapshot,
    callbacks: DockCloudPushSchedulerCallbacks,
    rerun: () => void,
    generation: number,
  ): void {
    if (generation !== this.pushGeneration || this.options.isDestroyed()) {
      return;
    }

    if (!this.options.isCurrentUser(userId)) {
      this.options.logger.debug('scheduleCloudPush: stale owner — skipping', {
        userId,
        currentUserId: callbacks.getCurrentSnapshotUserId(),
      });
      return;
    }

    let holdDelay: number;
    try {
      holdDelay = callbacks.getNonCriticalHoldDelay();
    } catch (error: unknown) {
      this.options.logger.error('scheduleCloudPush: non-critical hold delay check failed', {
        userId,
        error,
      });
      return;
    }

    if (holdDelay > 0) {
      this.cloudPushTimer.schedule(rerun, holdDelay);
      return;
    }

    void this.persistThenEnqueue(userId, frozenSnapshot, callbacks, generation)
      .catch(error => {
        this.options.logger.error('scheduleCloudPush: focus session enqueue failed', {
          userId,
          error,
        });
      });
  }

  private async persistThenEnqueue(
    userId: string,
    frozenSnapshot: DockSnapshot,
    callbacks: DockCloudPushSchedulerCallbacks,
    generation: number,
  ): Promise<void> {
    const persisted = await callbacks.persistLocalSnapshotImmediately(frozenSnapshot, userId);
    if (!persisted || generation !== this.pushGeneration || this.options.isDestroyed()) {
      return;
    }

    if (!this.options.isCurrentUser(userId)) {
      this.options.logger.debug('scheduleCloudPush: owner changed after local persist — skipping enqueue', {
        userId,
        currentUserId: callbacks.getCurrentSnapshotUserId(),
      });
      return;
    }

    await this.options.enqueueFocusSessionSync(userId, frozenSnapshot);
  }
}
