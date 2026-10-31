import { describe, expect, it } from 'vitest';

import { ActionQueueRestoreBarrierController } from './action-queue-restore-barrier.controller';

describe('ActionQueueRestoreBarrierController', () => {
  it('releases deferred processing only after queue and dead-letter restores are both ready', () => {
    const barrier = new ActionQueueRestoreBarrierController();
    barrier.beginDeadLetters(1);
    expect(barrier.deferProcessing()).toBe(true);
    barrier.beginQueue(2);

    expect(barrier.finishDeadLetters(1, 'ready')).toEqual({
      flushQueue: false,
      flushDeadLetters: false,
      resumeProcessing: false,
    });
    expect(barrier.finishQueue(2, 'ready')).toEqual({
      flushQueue: false,
      flushDeadLetters: false,
      resumeProcessing: true,
    });
  });

  it('keeps failed restore channels blocked and ignores stale generations', () => {
    const barrier = new ActionQueueRestoreBarrierController();
    barrier.beginQueue(3);
    expect(barrier.deferQueueSave()).toBe(true);

    expect(barrier.finishQueue(2, 'ready').flushQueue).toBe(false);
    expect(barrier.finishQueue(3, 'failed').flushQueue).toBe(false);
    expect(barrier.deferQueueSave()).toBe(true);
  });
});
