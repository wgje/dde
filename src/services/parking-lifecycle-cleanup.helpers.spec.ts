import { describe, expect, it, vi } from 'vitest';
import {
  cleanupParkingFirstInteractionListeners,
  cleanupParkingLifecycleHandles,
  setupParkingFirstInteractionListeners,
  type ParkingLifecycleHandles,
} from './parking-lifecycle-cleanup.helpers';

type ParkingTimer = NonNullable<ParkingLifecycleHandles['evictionIntervalTimer']>;
type ParkingListener = NonNullable<ParkingLifecycleHandles['onlineListener']>;

function timer(label: string): ParkingTimer {
  return label as unknown as ParkingTimer;
}

function listener(): ParkingListener {
  return () => undefined;
}

function createHandles(
  overrides: Partial<ParkingLifecycleHandles> = {},
): ParkingLifecycleHandles {
  return {
    evictionIntervalTimer: timer('eviction-interval'),
    parkedDeltaTimer: timer('parked-delta'),
    startupEvictionTimer: timer('startup-eviction'),
    parkedDeltaRecoveryTimer: timer('parked-delta-recovery'),
    evictionReadyCheckTimer: timer('eviction-ready-check'),
    onlineListener: listener(),
    parkedSyncOnlineListener: listener(),
    visibilityChangeHandler: listener(),
    firstInteractionHandler: listener(),
    ...overrides,
  };
}

describe('cleanupParkingLifecycleHandles', () => {
  it('should clear every parking timer and browser listener handle', () => {
    const clearIntervalFn = vi.fn();
    const clearTimeoutFn = vi.fn();
    const removeWindowListener = vi.fn();
    const removeDocumentListener = vi.fn();
    const handles = createHandles({
      clearIntervalFn,
      clearTimeoutFn,
      removeWindowListener,
      removeDocumentListener,
    });

    const cleaned = cleanupParkingLifecycleHandles(handles);

    expect(clearIntervalFn).toHaveBeenCalledWith(handles.evictionIntervalTimer);
    expect(clearIntervalFn).toHaveBeenCalledWith(handles.parkedDeltaTimer);
    expect(clearTimeoutFn).toHaveBeenCalledWith(handles.startupEvictionTimer);
    expect(clearTimeoutFn).toHaveBeenCalledWith(handles.parkedDeltaRecoveryTimer);
    expect(clearTimeoutFn).toHaveBeenCalledWith(handles.evictionReadyCheckTimer);
    expect(removeWindowListener).toHaveBeenCalledWith('online', handles.onlineListener);
    expect(removeWindowListener).toHaveBeenCalledWith('online', handles.parkedSyncOnlineListener);
    expect(removeDocumentListener).toHaveBeenCalledWith('visibilitychange', handles.visibilityChangeHandler);
    expect(removeDocumentListener).toHaveBeenCalledWith('keydown', handles.firstInteractionHandler);
    expect(removeDocumentListener).toHaveBeenCalledWith('click', handles.firstInteractionHandler);
    expect(removeDocumentListener).toHaveBeenCalledWith('scroll', handles.firstInteractionHandler);
    expect(cleaned).toEqual({
      evictionIntervalTimer: null,
      parkedDeltaTimer: null,
      startupEvictionTimer: null,
      parkedDeltaRecoveryTimer: null,
      evictionReadyCheckTimer: null,
      onlineListener: null,
      parkedSyncOnlineListener: null,
      visibilityChangeHandler: null,
      firstInteractionHandler: null,
    });
  });

  it('should continue cleanup when one browser handle cleanup throws', () => {
    const clearIntervalFn = vi.fn()
      .mockImplementationOnce(() => {
        throw new Error('stale interval');
      });
    const clearTimeoutFn = vi.fn();
    const removeWindowListener = vi.fn()
      .mockImplementationOnce(() => {
        throw new Error('stale listener');
      });
    const removeDocumentListener = vi.fn();
    const handles = createHandles({
      clearIntervalFn,
      clearTimeoutFn,
      removeWindowListener,
      removeDocumentListener,
    });

    expect(() => cleanupParkingLifecycleHandles(handles)).not.toThrow();

    expect(clearIntervalFn).toHaveBeenCalledTimes(2);
    expect(clearTimeoutFn).toHaveBeenCalledTimes(3);
    expect(removeWindowListener).toHaveBeenCalledTimes(2);
    expect(removeDocumentListener).toHaveBeenCalledTimes(4);
  });
});

describe('cleanupParkingFirstInteractionListeners', () => {
  it('should remove every first-interaction listener and report full success', () => {
    const firstInteractionListener = vi.fn();
    const removeDocumentListener = vi.fn();

    const removed = cleanupParkingFirstInteractionListeners(
      firstInteractionListener,
      { removeDocumentListener },
    );

    expect(removed).toBe(true);
    expect(removeDocumentListener).toHaveBeenCalledWith('keydown', firstInteractionListener);
    expect(removeDocumentListener).toHaveBeenCalledWith('click', firstInteractionListener);
    expect(removeDocumentListener).toHaveBeenCalledWith('scroll', firstInteractionListener);
  });

  it('should continue listener cleanup and report failure when one removal throws', () => {
    const firstInteractionListener = vi.fn();
    const cleanupFailure = new Error('stale listener');
    const removeDocumentListener = vi.fn()
      .mockImplementationOnce(() => {
        throw cleanupFailure;
      });
    const warn = vi.fn();

    const removed = cleanupParkingFirstInteractionListeners(
      firstInteractionListener,
      { removeDocumentListener, warn },
    );

    expect(removed).toBe(false);
    expect(removeDocumentListener).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenCalledWith(
      'first interaction listener cleanup failed',
      cleanupFailure,
    );
  });
});

describe('setupParkingFirstInteractionListeners', () => {
  it('should register every first-interaction listener and report success', () => {
    const firstInteractionListener = vi.fn();
    const addDocumentListener = vi.fn();

    const registered = setupParkingFirstInteractionListeners(
      firstInteractionListener,
      { addDocumentListener },
    );

    expect(registered).toBe(true);
    expect(addDocumentListener).toHaveBeenCalledWith('keydown', firstInteractionListener);
    expect(addDocumentListener).toHaveBeenCalledWith('click', firstInteractionListener);
    expect(addDocumentListener).toHaveBeenCalledWith('scroll', firstInteractionListener);
  });

  it('should roll back registered first-interaction listeners when setup fails midway', () => {
    const firstInteractionListener = vi.fn();
    const registrationFailure = new Error('stale listener target');
    const addDocumentListener = vi.fn()
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => {
        throw registrationFailure;
      });
    const removeDocumentListener = vi.fn();
    const warn = vi.fn();

    const registered = setupParkingFirstInteractionListeners(
      firstInteractionListener,
      { addDocumentListener, removeDocumentListener, warn },
    );

    expect(registered).toBe(false);
    expect(removeDocumentListener).toHaveBeenCalledWith('keydown', firstInteractionListener);
    expect(removeDocumentListener).toHaveBeenCalledWith('click', firstInteractionListener);
    expect(removeDocumentListener).toHaveBeenCalledWith('scroll', firstInteractionListener);
    expect(warn).toHaveBeenCalledWith(
      'first interaction listener registration failed',
      registrationFailure,
    );
  });
});
