import { describe, expect, it, vi } from 'vitest';

import {
  WorkspaceShellRouteEventSubscriptionController,
  type WorkspaceShellRouteEventSubscriptionControllerOptions,
} from './workspace-shell-route-event-subscription.controller';

type RouteEventListener = (event: unknown) => void;

function createController(
  overrides: Partial<WorkspaceShellRouteEventSubscriptionControllerOptions> = {},
) {
  const listeners: RouteEventListener[] = [];
  const unsubscribes: Array<ReturnType<typeof vi.fn>> = [];
  const onNavigationEnd = vi.fn();
  const warn = vi.fn();
  const subscribeToRouteEvents = vi.fn((listener: RouteEventListener) => {
    listeners.push(listener);
    const unsubscribe = vi.fn();
    unsubscribes.push(unsubscribe);
    return { unsubscribe };
  });
  const isNavigationEnd = vi.fn((event: unknown) => event === 'navigation-end');
  const controller = new WorkspaceShellRouteEventSubscriptionController({
    subscribeToRouteEvents,
    isNavigationEnd,
    onNavigationEnd,
    warn,
    ...overrides,
  });

  return {
    controller,
    isNavigationEnd,
    listeners,
    onNavigationEnd,
    subscribeToRouteEvents,
    unsubscribes,
    warn,
  };
}

describe('WorkspaceShellRouteEventSubscriptionController', () => {
  it('notifies only for navigation end events', () => {
    const { controller, listeners, onNavigationEnd } = createController();

    controller.setup();
    listeners[0]?.('ignored');
    listeners[0]?.('navigation-end');

    expect(onNavigationEnd).toHaveBeenCalledTimes(1);
  });

  it('replaces the active subscription and ignores stale listeners', () => {
    const { controller, listeners, onNavigationEnd, unsubscribes } = createController();

    controller.setup();
    controller.setup();

    expect(unsubscribes[0]).toHaveBeenCalledTimes(1);
    listeners[0]?.('navigation-end');
    expect(onNavigationEnd).not.toHaveBeenCalled();

    listeners[1]?.('navigation-end');
    expect(onNavigationEnd).toHaveBeenCalledTimes(1);
  });

  it('warns and allows retry when subscription setup fails', () => {
    const setupError = new Error('route subscription setup failed');
    const listeners: RouteEventListener[] = [];
    const unsubscribe = vi.fn();
    const subscribeToRouteEvents = vi.fn()
      .mockImplementationOnce(() => {
        throw setupError;
      })
      .mockImplementationOnce((listener: RouteEventListener) => {
        listeners.push(listener);
        return { unsubscribe };
      });
    const onNavigationEnd = vi.fn();
    const warn = vi.fn();
    const controller = new WorkspaceShellRouteEventSubscriptionController({
      subscribeToRouteEvents,
      isNavigationEnd: () => true,
      onNavigationEnd,
      warn,
    });

    expect(() => controller.setup()).not.toThrow();
    expect(warn).toHaveBeenCalledWith(
      'Workspace route sync subscription setup failed',
      setupError,
    );

    controller.setup();
    listeners[0]?.('navigation-end');
    expect(onNavigationEnd).toHaveBeenCalledTimes(1);
  });

  it('isolates navigation event predicate failures', () => {
    const predicateError = new Error('navigation predicate failed');
    const { controller, listeners, onNavigationEnd, warn } = createController({
      isNavigationEnd: () => {
        throw predicateError;
      },
    });

    controller.setup();

    expect(() => listeners[0]?.('navigation-end')).not.toThrow();
    expect(onNavigationEnd).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      'Workspace route sync navigation event predicate failed',
      predicateError,
    );
  });

  it('isolates navigation callback failures', () => {
    const callbackError = new Error('route sync failed');
    const { controller, listeners, warn } = createController({
      onNavigationEnd: () => {
        throw callbackError;
      },
    });

    controller.setup();

    expect(() => listeners[0]?.('navigation-end')).not.toThrow();
    expect(warn).toHaveBeenCalledWith(
      'Workspace route sync from navigation event failed',
      callbackError,
    );
  });

  it('continues replacement when the previous unsubscribe fails', () => {
    const unsubscribeError = new Error('route subscription cleanup failed');
    const firstUnsubscribe = vi.fn(() => {
      throw unsubscribeError;
    });
    const secondUnsubscribe = vi.fn();
    const listeners: RouteEventListener[] = [];
    const subscribeToRouteEvents = vi.fn()
      .mockImplementationOnce((listener: RouteEventListener) => {
        listeners.push(listener);
        return { unsubscribe: firstUnsubscribe };
      })
      .mockImplementationOnce((listener: RouteEventListener) => {
        listeners.push(listener);
        return { unsubscribe: secondUnsubscribe };
      });
    const onNavigationEnd = vi.fn();
    const warn = vi.fn();
    const controller = new WorkspaceShellRouteEventSubscriptionController({
      subscribeToRouteEvents,
      isNavigationEnd: () => true,
      onNavigationEnd,
      warn,
    });

    controller.setup();
    expect(() => controller.setup()).not.toThrow();

    expect(subscribeToRouteEvents).toHaveBeenCalledTimes(2);
    expect(firstUnsubscribe).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      'Workspace route sync subscription cleanup failed',
      unsubscribeError,
    );
    listeners[1]?.('navigation-end');
    expect(onNavigationEnd).toHaveBeenCalledTimes(1);
  });

  it('invalidates the listener before idempotent cleanup', () => {
    const { controller, listeners, onNavigationEnd, unsubscribes } = createController();

    controller.setup();
    controller.cleanup();
    controller.cleanup();
    listeners[0]?.('navigation-end');

    expect(unsubscribes[0]).toHaveBeenCalledTimes(1);
    expect(onNavigationEnd).not.toHaveBeenCalled();
  });

  it('contains warning sink failures at subscription boundaries', () => {
    const setupError = new Error('route subscription setup failed');
    const cleanupError = new Error('route subscription cleanup failed');
    const warn = vi.fn(() => {
      throw new Error('warning sink failed');
    });
    const setupController = new WorkspaceShellRouteEventSubscriptionController({
      subscribeToRouteEvents: () => {
        throw setupError;
      },
      isNavigationEnd: () => true,
      onNavigationEnd: vi.fn(),
      warn,
    });
    const cleanupController = new WorkspaceShellRouteEventSubscriptionController({
      subscribeToRouteEvents: () => ({
        unsubscribe: () => {
          throw cleanupError;
        },
      }),
      isNavigationEnd: () => true,
      onNavigationEnd: vi.fn(),
      warn,
    });

    expect(() => setupController.setup()).not.toThrow();
    cleanupController.setup();
    expect(() => cleanupController.cleanup()).not.toThrow();

    expect(warn).toHaveBeenCalledWith(
      'Workspace route sync subscription setup failed',
      setupError,
    );
    expect(warn).toHaveBeenCalledWith(
      'Workspace route sync subscription cleanup failed',
      cleanupError,
    );
  });
});
