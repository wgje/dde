import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  SpeechToTextOwnerSettlementController,
  type SpeechToTextOwnerSettlementControllerOptions,
} from './speech-to-text-owner-settlement.controller';

describe('SpeechToTextOwnerSettlementController', () => {
  let destroyed = false;
  let onTimeout: SpeechToTextOwnerSettlementControllerOptions['onTimeout'];

  const createController = (
    options: {
      maxAttempts?: number;
      retryDelayMs?: number;
    } = {},
  ) => {
    const controllerOptions: SpeechToTextOwnerSettlementControllerOptions = {
      isDestroyed: () => destroyed,
      onTimeout,
    };
    if (options.maxAttempts !== undefined) {
      controllerOptions.maxAttempts = options.maxAttempts;
    }
    if (options.retryDelayMs !== undefined) {
      controllerOptions.retryDelayMs = options.retryDelayMs;
    }
    return new SpeechToTextOwnerSettlementController(controllerOptions);
  };

  afterEach(() => {
    destroyed = false;
    vi.useRealTimers();
  });

  it('runs the callback immediately when the owner is already settled', () => {
    onTimeout = vi.fn();
    const onSettled = vi.fn();

    createController().deferUntilSettled(() => true, onSettled, 'already-settled');

    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it('waits until a later retry observes the settled owner', async () => {
    vi.useFakeTimers();
    onTimeout = vi.fn();
    let settled = false;
    const onSettled = vi.fn();

    createController({ maxAttempts: 3 }).deferUntilSettled(
      () => settled,
      onSettled,
      'session-restored',
    );

    expect(onSettled).not.toHaveBeenCalled();

    settled = true;
    await vi.advanceTimersByTimeAsync(50);

    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it('replaces a pending wait when a newer owner event arrives', async () => {
    vi.useFakeTimers();
    onTimeout = vi.fn();
    const firstSettled = vi.fn();
    const secondSettled = vi.fn();
    const controller = createController();

    controller.deferUntilSettled(() => false, firstSettled, 'first-event');
    controller.deferUntilSettled(() => true, secondSettled, 'second-event');
    await vi.advanceTimersByTimeAsync(50);

    expect(firstSettled).not.toHaveBeenCalled();
    expect(secondSettled).toHaveBeenCalledTimes(1);
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it('clears the pending wait on destroy', async () => {
    vi.useFakeTimers();
    onTimeout = vi.fn();
    const onSettled = vi.fn();
    const controller = createController({ maxAttempts: 1 });

    controller.deferUntilSettled(() => false, onSettled, 'destroyed');
    controller.destroy();
    await vi.advanceTimersByTimeAsync(50);

    expect(onSettled).not.toHaveBeenCalled();
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it('reports a timeout when the owner never settles', async () => {
    vi.useFakeTimers();
    onTimeout = vi.fn();
    const onSettled = vi.fn();

    createController({ maxAttempts: 1 }).deferUntilSettled(
      () => false,
      onSettled,
      'session-restored:storage',
    );
    await vi.advanceTimersByTimeAsync(50);

    expect(onSettled).not.toHaveBeenCalled();
    expect(onTimeout).toHaveBeenCalledWith('session-restored:storage');
  });
});
