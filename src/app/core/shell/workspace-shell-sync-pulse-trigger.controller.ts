import type { SyncPulseReason } from '../../../services/sync-pulse-engine.service';
import type { WorkspaceShellFocusEntrySyncPulseResult } from './workspace-shell-focus-entry-sync-pulse.controller';

export interface WorkspaceShellSyncPulseTriggerControllerOptions {
  isReady: () => boolean;
  trigger: (
    reason: SyncPulseReason,
  ) => Promise<WorkspaceShellFocusEntrySyncPulseResult | null>;
  onTriggerStarted: () => void;
  warn: (message: string, error: unknown) => void;
}

interface PendingSyncPulseTrigger {
  promise: Promise<WorkspaceShellFocusEntrySyncPulseResult | null>;
  resolve: (result: WorkspaceShellFocusEntrySyncPulseResult | null) => void;
}

export class WorkspaceShellSyncPulseTriggerController {
  private readonly pendingTriggers = new Map<SyncPulseReason, PendingSyncPulseTrigger>();
  private generation = 0;

  constructor(private readonly options: WorkspaceShellSyncPulseTriggerControllerOptions) {}

  async trigger(
    reason: SyncPulseReason,
  ): Promise<WorkspaceShellFocusEntrySyncPulseResult | null> {
    if (!this.options.isReady()) {
      return null;
    }

    const pendingTrigger = this.pendingTriggers.get(reason);
    if (pendingTrigger) {
      return pendingTrigger.promise;
    }

    const triggerGeneration = this.generation;
    let resolveTrigger!: (result: WorkspaceShellFocusEntrySyncPulseResult | null) => void;
    const pendingTriggerRecord: PendingSyncPulseTrigger = {
      promise: new Promise(resolve => {
        resolveTrigger = resolve;
      }),
      resolve: result => resolveTrigger(result),
    };
    this.options.onTriggerStarted();
    this.pendingTriggers.set(reason, pendingTriggerRecord);

    let baseTriggerPromise: Promise<WorkspaceShellFocusEntrySyncPulseResult | null>;
    try {
      baseTriggerPromise = Promise.resolve(this.options.trigger(reason));
    } catch (error) {
      this.warn('同步脉冲服务触发失败，跳过本次脉冲', error);
      baseTriggerPromise = Promise.resolve(null);
    }

    void baseTriggerPromise
      .catch(error => {
        if (triggerGeneration !== this.generation || !this.options.isReady()) {
          return null;
        }

        this.warn('同步脉冲服务触发失败，跳过本次脉冲', error);
        return null;
      })
      .then(result => {
        const settledResult = triggerGeneration === this.generation && this.options.isReady()
          ? result
          : null;
        pendingTriggerRecord.resolve(settledResult);
      })
      .finally(() => {
        if (this.pendingTriggers.get(reason) === pendingTriggerRecord) {
          this.pendingTriggers.delete(reason);
        }
      });

    return pendingTriggerRecord.promise;
  }

  hasPendingTriggers(): boolean {
    return this.pendingTriggers.size > 0;
  }

  reset(): void {
    this.generation += 1;
    for (const pendingTrigger of this.pendingTriggers.values()) {
      pendingTrigger.resolve(null);
    }
    this.pendingTriggers.clear();
  }

  private warn(message: string, error: unknown): void {
    try {
      this.options.warn(message, error);
    } catch {
      // Warning sinks must not interrupt trigger settlement.
    }
  }
}
