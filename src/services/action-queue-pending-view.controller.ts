import type { WritableSignal } from '@angular/core';

import type { QueuedAction } from './action-queue.types';

export interface ActionQueuePendingViewControllerOptions {
  pendingActions: WritableSignal<QueuedAction[]>;
  queueSize: WritableSignal<number>;
  setProcessing: (isProcessing: boolean) => void;
}

export class ActionQueuePendingViewController {
  constructor(private readonly options: ActionQueuePendingViewControllerOptions) {}

  setQueue(queue: QueuedAction[]): void {
    this.options.pendingActions.set(queue);
    this.options.queueSize.set(queue.length);
  }

  filterQueue(predicate: (action: QueuedAction) => boolean): number {
    const currentQueue = this.options.pendingActions();
    const nextQueue = currentQueue.filter(predicate);
    if (nextQueue.length === currentQueue.length) {
      return 0;
    }

    this.setQueue(nextQueue);
    return currentQueue.length - nextQueue.length;
  }

  mapQueue(mapper: (action: QueuedAction) => QueuedAction): boolean {
    let changed = false;
    const nextQueue = this.options.pendingActions().map(action => {
      const nextAction = mapper(action);
      if (nextAction !== action) {
        changed = true;
      }
      return nextAction;
    });

    if (changed) {
      this.setQueue(nextQueue);
    }

    return changed;
  }

  clearQueueView(): void {
    this.setQueue([]);
  }

  resetQueueView(): void {
    this.clearQueueView();
    this.options.setProcessing(false);
  }
}
