import { describe, expect, it, vi } from 'vitest';

import {
  WorkspaceShellSessionTransitionSubscriptionsController,
  type WorkspaceShellSessionTransitionSubscriptionsControllerOptions,
} from './workspace-shell-session-transition-subscriptions.controller';

function createOptions(
  overrides: Partial<WorkspaceShellSessionTransitionSubscriptionsControllerOptions> = {},
): WorkspaceShellSessionTransitionSubscriptionsControllerOptions {
  return {
    onSessionInvalidated: vi.fn(),
    onSessionRestored: vi.fn(),
    warn: vi.fn(),
    ...overrides,
  };
}

describe('WorkspaceShellSessionTransitionSubscriptionsController', () => {
  it('forwards session events and unsubscribes both listeners during cleanup', () => {
    const restoredUnsubscribe = vi.fn();
    const invalidatedUnsubscribe = vi.fn();
    type RestoredListener = Parameters<
      NonNullable<WorkspaceShellSessionTransitionSubscriptionsControllerOptions[
        'subscribeToSessionRestored'
      ]>
    >[0];
    type InvalidatedListener = Parameters<
      NonNullable<WorkspaceShellSessionTransitionSubscriptionsControllerOptions[
        'subscribeToSessionInvalidated'
      ]>
    >[0];
    const listeners: {
      restored?: RestoredListener;
      invalidated?: InvalidatedListener;
    } = {};
    const onSessionRestored = vi.fn();
    const onSessionInvalidated = vi.fn();
    const controller = new WorkspaceShellSessionTransitionSubscriptionsController(
      createOptions({
        onSessionInvalidated,
        onSessionRestored,
        subscribeToSessionRestored: listener => {
          listeners.restored = listener;
          return { unsubscribe: restoredUnsubscribe };
        },
        subscribeToSessionInvalidated: listener => {
          listeners.invalidated = listener;
          return { unsubscribe: invalidatedUnsubscribe };
        },
      }),
    );
    const restoredEvent = {
      type: 'session-restored' as const,
      source: 'AuthService.storageBridge',
      userId: 'user-1',
    };
    const invalidatedEvent = {
      type: 'session-invalidated' as const,
      source: 'AuthService.backgroundRefresh',
      userId: 'user-1',
    };

    controller.setup();
    (listeners.restored as RestoredListener | undefined)?.(restoredEvent);
    (listeners.invalidated as InvalidatedListener | undefined)?.(invalidatedEvent);
    controller.cleanup();

    expect(onSessionRestored).toHaveBeenCalledWith(restoredEvent);
    expect(onSessionInvalidated).toHaveBeenCalledWith(invalidatedEvent);
    expect(restoredUnsubscribe).toHaveBeenCalledTimes(1);
    expect(invalidatedUnsubscribe).toHaveBeenCalledTimes(1);
  });

  it('replaces existing subscriptions when setup runs again', () => {
    const restoredUnsubscribes = [vi.fn(), vi.fn()];
    const invalidatedUnsubscribes = [vi.fn(), vi.fn()];
    let restoredIndex = 0;
    let invalidatedIndex = 0;
    const controller = new WorkspaceShellSessionTransitionSubscriptionsController(
      createOptions({
        subscribeToSessionRestored: () => ({
          unsubscribe: restoredUnsubscribes[restoredIndex++],
        }),
        subscribeToSessionInvalidated: () => ({
          unsubscribe: invalidatedUnsubscribes[invalidatedIndex++],
        }),
      }),
    );

    controller.setup();
    controller.setup();

    expect(restoredUnsubscribes[0]).toHaveBeenCalledTimes(1);
    expect(invalidatedUnsubscribes[0]).toHaveBeenCalledTimes(1);
    expect(restoredUnsubscribes[1]).not.toHaveBeenCalled();
    expect(invalidatedUnsubscribes[1]).not.toHaveBeenCalled();
  });

  it('rolls back a restored subscription when invalidated subscription setup fails', () => {
    const restoredUnsubscribe = vi.fn();
    const setupError = new Error('invalidated subscription failed');
    const controller = new WorkspaceShellSessionTransitionSubscriptionsController(
      createOptions({
        subscribeToSessionRestored: () => ({ unsubscribe: restoredUnsubscribe }),
        subscribeToSessionInvalidated: () => {
          throw setupError;
        },
      }),
    );

    expect(() => controller.setup()).toThrow(setupError);

    expect(restoredUnsubscribe).toHaveBeenCalledTimes(1);
    controller.cleanup();
    expect(restoredUnsubscribe).toHaveBeenCalledTimes(1);
  });

  it('continues cleanup when unsubscribe and warning sinks fail', () => {
    const unsubscribeError = new Error('restored subscription already closed');
    const restoredUnsubscribe = vi.fn(() => {
      throw unsubscribeError;
    });
    const invalidatedUnsubscribe = vi.fn();
    const warn = vi.fn(() => {
      throw new Error('warning sink failed');
    });
    const controller = new WorkspaceShellSessionTransitionSubscriptionsController(
      createOptions({
        subscribeToSessionRestored: () => ({ unsubscribe: restoredUnsubscribe }),
        subscribeToSessionInvalidated: () => ({ unsubscribe: invalidatedUnsubscribe }),
        warn,
      }),
    );
    controller.setup();

    expect(() => controller.cleanup()).not.toThrow();

    expect(restoredUnsubscribe).toHaveBeenCalledTimes(1);
    expect(invalidatedUnsubscribe).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      'Workspace session transition subscription cleanup failed',
      unsubscribeError,
    );
  });
});
