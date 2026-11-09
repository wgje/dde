export type OwnerStorageRestoreOutcome = 'ready' | 'failed' | 'stale';

export interface ActionQueueRestoreBarrierRelease {
  flushQueue: boolean;
  flushDeadLetters: boolean;
  resumeProcessing: boolean;
}

const NO_RELEASE: ActionQueueRestoreBarrierRelease = {
  flushQueue: false,
  flushDeadLetters: false,
  resumeProcessing: false,
};

export class ActionQueueRestoreBarrierController {
  private queueGeneration: number | null = null;
  private deadLetterGeneration: number | null = null;
  private queueSaveDeferred = false;
  private deadLetterSaveDeferred = false;
  private processingDeferred = false;

  beginQueue(generation: number): void {
    this.queueGeneration = generation;
    this.queueSaveDeferred = false;
  }

  beginDeadLetters(generation: number): void {
    this.deadLetterGeneration = generation;
    this.deadLetterSaveDeferred = false;
  }

  deferQueueSave(): boolean {
    if (this.queueGeneration === null) return false;
    this.queueSaveDeferred = true;
    return true;
  }

  deferDeadLetterSave(): boolean {
    if (this.deadLetterGeneration === null) return false;
    this.deadLetterSaveDeferred = true;
    return true;
  }

  deferProcessing(): boolean {
    if (!this.hasBarrier()) return false;
    this.processingDeferred = true;
    return true;
  }

  finishQueue(
    generation: number,
    outcome: OwnerStorageRestoreOutcome,
  ): ActionQueueRestoreBarrierRelease {
    if (this.queueGeneration !== generation || outcome !== 'ready') return NO_RELEASE;
    this.queueGeneration = null;
    const flushQueue = this.queueSaveDeferred;
    this.queueSaveDeferred = false;
    return { flushQueue, flushDeadLetters: false, resumeProcessing: this.takeProcessingRelease() };
  }

  finishDeadLetters(
    generation: number,
    outcome: OwnerStorageRestoreOutcome,
  ): ActionQueueRestoreBarrierRelease {
    if (this.deadLetterGeneration !== generation || outcome !== 'ready') return NO_RELEASE;
    this.deadLetterGeneration = null;
    const flushDeadLetters = this.deadLetterSaveDeferred;
    this.deadLetterSaveDeferred = false;
    return { flushQueue: false, flushDeadLetters, resumeProcessing: this.takeProcessingRelease() };
  }

  reset(): void {
    this.queueGeneration = null;
    this.deadLetterGeneration = null;
    this.queueSaveDeferred = false;
    this.deadLetterSaveDeferred = false;
    this.processingDeferred = false;
  }

  private hasBarrier(): boolean {
    return this.queueGeneration !== null || this.deadLetterGeneration !== null;
  }

  private takeProcessingRelease(): boolean {
    if (this.hasBarrier() || !this.processingDeferred) return false;
    this.processingDeferred = false;
    return true;
  }
}
