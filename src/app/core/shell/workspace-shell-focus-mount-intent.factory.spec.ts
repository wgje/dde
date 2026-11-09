import { describe, expect, it, vi } from 'vitest';

import { createWorkspaceShellFocusMountIntentController } from './workspace-shell-focus-mount-intent.factory';

interface RegisteredListener {
  listener: EventListenerOrEventListenerObject;
  options?: boolean | AddEventListenerOptions;
}

function createController(options: { browser?: boolean; enabled?: boolean } = {}) {
  const listeners = new Map<string, RegisteredListener>();
  const windowRef = {
    addEventListener: vi.fn((
      eventName: string,
      listener: EventListenerOrEventListenerObject,
      eventOptions?: boolean | AddEventListenerOptions,
    ) => {
      listeners.set(eventName, { listener, options: eventOptions });
    }),
    removeEventListener: vi.fn((eventName: string) => {
      listeners.delete(eventName);
    }),
  };
  const focusModeIntentActivated = { set: vi.fn() };
  const syncPulseLifecycle = {
    dispatchFocusEntrySyncPulseIfReady: vi.fn(),
  };
  const controller = createWorkspaceShellFocusMountIntentController({
    getWindow: () => options.browser === false ? undefined : windowRef,
    isThrottledFocusStartup: () => options.enabled ?? true,
    setFocusModeIntentActivated: active =>
      focusModeIntentActivated.set(active),
    syncPulseLifecycle: () => syncPulseLifecycle,
  });

  return {
    controller,
    focusModeIntentActivated,
    listeners,
    syncPulseLifecycle,
    windowRef,
  };
}

describe('createWorkspaceShellFocusMountIntentController', () => {
  it('maps shell focus intent dependencies into first-interaction activation', () => {
    const {
      controller,
      focusModeIntentActivated,
      listeners,
      syncPulseLifecycle,
    } = createController();

    controller.setup();
    const pointerListener = listeners.get('pointerdown')?.listener as EventListener;
    pointerListener(new Event('pointerdown'));

    expect(focusModeIntentActivated.set).toHaveBeenCalledWith(true);
    expect(syncPulseLifecycle.dispatchFocusEntrySyncPulseIfReady).toHaveBeenCalledTimes(1);
  });

  it('skips browser listeners when focus startup throttling is disabled', () => {
    const { controller, windowRef } = createController({ enabled: false });

    controller.setup();

    expect(windowRef.addEventListener).not.toHaveBeenCalled();
  });
});
