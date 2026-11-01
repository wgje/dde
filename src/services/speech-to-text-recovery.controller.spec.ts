import { Subject } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SpeechToTextRecoveryController } from './speech-to-text-recovery.controller';

type SessionRestoredEvent = {
  userId: string;
  source: string;
};

type SessionInvalidatedEvent = {
  userId: string | null;
  source: string;
};

function createHarness(options: {
  currentUserId?: () => string | null;
  isDestroyed?: () => boolean;
  isOnline?: () => boolean;
  processReplay?: () => Promise<void>;
} = {}) {
  const restored$ = new Subject<SessionRestoredEvent>();
  const invalidated$ = new Subject<SessionInvalidatedEvent>();
  const listeners = new Map<string, EventListener>();
  const onlineTarget = {
    addEventListener: vi.fn((type: string, listener: EventListener) => {
      listeners.set(type, listener);
    }),
    removeEventListener: vi.fn((type: string, listener: EventListener) => {
      if (listeners.get(type) === listener) {
        listeners.delete(type);
      }
    }),
  };
  const deferUntilSettled = vi.fn();
  const processReplay = vi.fn(options.processReplay ?? (() => Promise.resolve()));
  const processOfflineCache = vi.fn().mockResolvedValue([]);
  const notifyReplaySuccess = vi.fn();
  const refreshPendingCount = vi.fn().mockResolvedValue(undefined);
  const scheduleReplay = vi.fn();
  const logger = {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  };
  const controller = new SpeechToTextRecoveryController({
    currentUserId: options.currentUserId ?? (() => 'local-user'),
    defaultUpstreamRetryDelayMs: 30_000,
    deferUntilSettled,
    isDestroyed: options.isDestroyed ?? (() => false),
    isOnline: options.isOnline ?? (() => true),
    logger,
    networkErrorCode: 'NETWORK_ERROR',
    notifyReplaySuccess,
    offlineReplayRetryDelayMs: 1500,
    onlineTarget,
    processOfflineCache,
    processReplay,
    refreshPendingCount,
    scheduleReplay,
    sessionInvalidated$: invalidated$,
    sessionRestored$: restored$,
  });

  return {
    controller,
    deferUntilSettled,
    invalidated$,
    listeners,
    logger,
    onlineTarget,
    processOfflineCache,
    processReplay,
    notifyReplaySuccess,
    refreshPendingCount,
    scheduleReplay,
    restored$,
  };
}

describe('SpeechToTextRecoveryController', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reuses an in-flight replay without cancelling a scheduled retry', async () => {
    vi.useFakeTimers();
    let resolveReplay!: () => void;
    const replay = new Promise<void>(resolve => {
      resolveReplay = resolve;
    });
    const { controller, processReplay } = createHarness({
      processReplay: () => replay,
    });

    const firstRun = controller.run('initial');
    controller.schedule('retryable', 1500);
    const duplicateRun = controller.run('duplicate');

    expect(duplicateRun).toBe(firstRun);
    expect(controller.replayTimeout).not.toBeNull();
    expect(processReplay).toHaveBeenCalledTimes(1);

    resolveReplay();
    await Promise.all([firstRun, duplicateRun]);

    expect(controller.replayTimeout).not.toBeNull();
    controller.destroy();
  });

  it('waits for the restored owner before refreshing and replaying', async () => {
    let ownerUserId = 'old-user';
    const {
      controller,
      deferUntilSettled,
      processReplay,
      refreshPendingCount,
      restored$,
    } = createHarness({
      currentUserId: () => ownerUserId,
    });

    restored$.next({
      userId: 'new-user',
      source: 'storage-bridge',
    });

    expect(deferUntilSettled).toHaveBeenCalledTimes(1);
    const [isSettled, onSettled, reason] = deferUntilSettled.mock.calls[0] as [
      () => boolean,
      () => void,
      string,
    ];
    expect(reason).toBe('session-restored:storage-bridge');
    expect(isSettled()).toBe(false);

    ownerUserId = 'new-user';
    expect(isSettled()).toBe(true);
    onSettled();
    await Promise.resolve();

    expect(refreshPendingCount).toHaveBeenCalledTimes(1);
    expect(processReplay).toHaveBeenCalledTimes(1);
    controller.destroy();
  });

  it('refreshes pending count after the invalidated owner is released', () => {
    let ownerUserId: string | null = 'old-user';
    const {
      controller,
      deferUntilSettled,
      invalidated$,
      refreshPendingCount,
    } = createHarness({
      currentUserId: () => ownerUserId,
    });

    invalidated$.next({
      userId: 'old-user',
      source: 'sign-out',
    });

    const [isSettled, onSettled, reason] = deferUntilSettled.mock.calls[0] as [
      () => boolean,
      () => void,
      string,
    ];
    expect(reason).toBe('session-invalidated:sign-out');
    expect(isSettled()).toBe(false);

    ownerUserId = null;
    expect(isSettled()).toBe(true);
    onSettled();

    expect(refreshPendingCount).toHaveBeenCalledTimes(1);
    controller.destroy();
  });

  it('owns the online listener and clears listeners and timers on destroy', () => {
    vi.useFakeTimers();
    const {
      controller,
      listeners,
      onlineTarget,
      processReplay,
      restored$,
    } = createHarness();
    const onlineHandler = controller.onlineHandler;

    expect(onlineHandler).not.toBeNull();
    listeners.get('online')?.(new Event('online'));
    expect(processReplay).toHaveBeenCalledTimes(1);

    controller.schedule('retryable', 1500);
    expect(controller.replayTimeout).not.toBeNull();
    controller.destroy();

    expect(controller.onlineHandler).toBeNull();
    expect(controller.replayTimeout).toBeNull();
    expect(onlineTarget.removeEventListener).toHaveBeenCalledWith('online', onlineHandler);

    restored$.next({ userId: 'local-user', source: 'after-destroy' });
    expect(processReplay).toHaveBeenCalledTimes(1);
  });

  it('processes cached entries and publishes a success notification', async () => {
    const {
      controller,
      notifyReplaySuccess,
      processOfflineCache,
    } = createHarness();
    processOfflineCache.mockResolvedValueOnce([
      { id: 'one' },
      { id: 'two' },
    ]);

    await controller.processReplayAndNotify();

    expect(notifyReplaySuccess).toHaveBeenCalledWith(2);
    controller.destroy();
  });

  it('uses the controlled upstream delay for retryable replay', () => {
    const { controller, scheduleReplay } = createHarness();
    controller.setControlledRetryDelayMs(4000);

    controller.scheduleRetryableReplay(new Error('NETWORK_ERROR'), 'controlled-timeout');
    expect(scheduleReplay).toHaveBeenCalledWith('controlled-timeout', 4000);
    controller.destroy();
  });
});
