import { describe, expect, it, vi } from 'vitest';

import { ActionQueueFrozenPersistenceController } from './action-queue-frozen-persistence.controller';

describe('ActionQueueFrozenPersistenceController', () => {
  it('persists every request while the queue is not frozen', () => {
    const saveQueueToStorage = vi.fn();
    const controller = new ActionQueueFrozenPersistenceController({
      isQueueFrozen: () => false,
      saveQueueToStorage,
    });

    controller.persist();
    controller.persist();

    expect(saveQueueToStorage).toHaveBeenCalledTimes(2);
  });

  it('allows the first frozen persist attempt and cools down repeated attempts', () => {
    let now = 1_000;
    const saveQueueToStorage = vi.fn();
    const controller = new ActionQueueFrozenPersistenceController({
      isQueueFrozen: () => true,
      saveQueueToStorage,
      retryCooldownMs: 30_000,
      now: () => now,
    });

    controller.persist();
    now += 1_000;
    controller.persist();
    now += 29_000;
    controller.persist();

    expect(saveQueueToStorage).toHaveBeenCalledTimes(2);
  });

  it('does not let frozen cooldown suppress a later unfrozen persist', () => {
    let frozen = true;
    const saveQueueToStorage = vi.fn();
    const controller = new ActionQueueFrozenPersistenceController({
      isQueueFrozen: () => frozen,
      saveQueueToStorage,
      retryCooldownMs: 30_000,
      now: () => 1_000,
    });

    controller.persist();
    controller.persist();
    frozen = false;
    controller.persist();

    expect(saveQueueToStorage).toHaveBeenCalledTimes(2);
  });
});
