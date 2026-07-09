import { describe, expect, it, vi } from 'vitest';

import { WorkspaceShellFocusMountIntentController } from './workspace-shell-focus-mount-intent.controller';

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
  const setFocusModeIntentActivated = vi.fn();
  const dispatchFocusEntrySyncPulseIfReady = vi.fn();
  const controller = new WorkspaceShellFocusMountIntentController({
    getWindow: () => options.browser === false ? undefined : windowRef,
    isEnabled: () => options.enabled ?? true,
    setFocusModeIntentActivated,
    dispatchFocusEntrySyncPulseIfReady,
  });

  return {
    controller,
    dispatchFocusEntrySyncPulseIfReady,
    listeners,
    setFocusModeIntentActivated,
    windowRef,
  };
}

describe('WorkspaceShellFocusMountIntentController', () => {
  it('registers first-interaction listeners when enabled in a browser', () => {
    const { controller, listeners, windowRef } = createController();

    controller.setup();

    expect(windowRef.addEventListener).toHaveBeenCalledWith(
      'pointerdown',
      expect.any(Function),
      { once: true, passive: true },
    );
    expect(windowRef.addEventListener).toHaveBeenCalledWith(
      'keydown',
      expect.any(Function),
      { once: true },
    );
    expect(windowRef.addEventListener).toHaveBeenCalledWith(
      'touchstart',
      expect.any(Function),
      { once: true, passive: true },
    );
    expect(Array.from(listeners.keys())).toEqual(['pointerdown', 'keydown', 'touchstart']);
  });

  it('does not register duplicate first-interaction listeners on repeated setup', () => {
    const { controller, windowRef } = createController();

    controller.setup();
    controller.setup();

    expect(windowRef.addEventListener).toHaveBeenCalledTimes(3);
  });

  it('skips registration when disabled or outside the browser', () => {
    const disabled = createController({ enabled: false });
    const server = createController({ browser: false });

    disabled.controller.setup();
    server.controller.setup();

    expect(disabled.windowRef.addEventListener).not.toHaveBeenCalled();
    expect(server.windowRef.addEventListener).not.toHaveBeenCalled();
  });

  it('activates focus intent, dispatches sync pulse, and removes listeners on first interaction', () => {
    const {
      controller,
      dispatchFocusEntrySyncPulseIfReady,
      listeners,
      setFocusModeIntentActivated,
      windowRef,
    } = createController();

    controller.setup();
    const pointerListener = listeners.get('pointerdown')?.listener as EventListener;
    pointerListener(new Event('pointerdown'));

    expect(setFocusModeIntentActivated).toHaveBeenCalledWith(true);
    expect(dispatchFocusEntrySyncPulseIfReady).toHaveBeenCalledTimes(1);
    expect(windowRef.removeEventListener).toHaveBeenCalledWith('pointerdown', expect.any(Function));
    expect(windowRef.removeEventListener).toHaveBeenCalledWith('keydown', expect.any(Function));
    expect(windowRef.removeEventListener).toHaveBeenCalledWith('touchstart', expect.any(Function));
    expect(listeners.size).toBe(0);
  });

  it('clears stale listeners when a first interaction arrives after intent is disabled', () => {
    const options = { enabled: true };
    const {
      controller,
      dispatchFocusEntrySyncPulseIfReady,
      listeners,
      setFocusModeIntentActivated,
      windowRef,
    } = createController(options);

    controller.setup();
    options.enabled = false;
    const pointerListener = listeners.get('pointerdown')?.listener as EventListener;
    pointerListener(new Event('pointerdown'));

    expect(setFocusModeIntentActivated).not.toHaveBeenCalled();
    expect(dispatchFocusEntrySyncPulseIfReady).not.toHaveBeenCalled();
    expect(windowRef.removeEventListener).toHaveBeenCalledWith('pointerdown', expect.any(Function));
    expect(windowRef.removeEventListener).toHaveBeenCalledWith('keydown', expect.any(Function));
    expect(windowRef.removeEventListener).toHaveBeenCalledWith('touchstart', expect.any(Function));
    expect(listeners.size).toBe(0);

    options.enabled = true;
    controller.setup();

    expect(windowRef.addEventListener).toHaveBeenCalledTimes(6);
    expect(Array.from(listeners.keys())).toEqual(['pointerdown', 'keydown', 'touchstart']);
  });

  it('tears down registered listeners explicitly', () => {
    const { controller, listeners, windowRef } = createController();

    controller.setup();
    controller.teardown();

    expect(windowRef.removeEventListener).toHaveBeenCalledWith('pointerdown', expect.any(Function));
    expect(windowRef.removeEventListener).toHaveBeenCalledWith('keydown', expect.any(Function));
    expect(windowRef.removeEventListener).toHaveBeenCalledWith('touchstart', expect.any(Function));
    expect(listeners.size).toBe(0);
  });

  it('removes first interaction listeners from the originally registered window', () => {
    function createWindowRef() {
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
      return { listeners, windowRef };
    }

    const firstWindow = createWindowRef();
    const nextWindow = createWindowRef();
    let activeWindow = firstWindow.windowRef;
    const controller = new WorkspaceShellFocusMountIntentController({
      getWindow: () => activeWindow,
      isEnabled: () => true,
      setFocusModeIntentActivated: vi.fn(),
      dispatchFocusEntrySyncPulseIfReady: vi.fn(),
    });

    controller.setup();
    activeWindow = nextWindow.windowRef;
    controller.teardown();

    expect(firstWindow.windowRef.removeEventListener)
      .toHaveBeenCalledWith('pointerdown', expect.any(Function));
    expect(firstWindow.windowRef.removeEventListener)
      .toHaveBeenCalledWith('keydown', expect.any(Function));
    expect(firstWindow.windowRef.removeEventListener)
      .toHaveBeenCalledWith('touchstart', expect.any(Function));
    expect(firstWindow.listeners.size).toBe(0);
    expect(nextWindow.windowRef.removeEventListener).not.toHaveBeenCalled();
  });

  it('continues teardown when one first-interaction listener removal fails', () => {
    const { controller, listeners, windowRef } = createController();
    windowRef.removeEventListener.mockImplementationOnce(() => {
      throw new Error('remove pointerdown failed');
    });

    controller.setup();

    expect(() => controller.teardown()).not.toThrow();
    expect(windowRef.removeEventListener).toHaveBeenCalledWith('keydown', expect.any(Function));
    expect(windowRef.removeEventListener).toHaveBeenCalledWith('touchstart', expect.any(Function));
    expect(listeners.size).toBe(0);
  });

  it('rolls back already-registered listeners when setup fails midway', () => {
    const { controller, listeners, windowRef } = createController();
    const error = new Error('keydown registration failed');
    windowRef.addEventListener
      .mockImplementationOnce((eventName, listener, eventOptions) => {
        listeners.set(eventName, { listener, options: eventOptions });
      })
      .mockImplementationOnce(() => {
        throw error;
      });

    expect(() => controller.setup()).toThrow(error);

    expect(windowRef.removeEventListener).toHaveBeenCalledWith('pointerdown', expect.any(Function));
    expect(listeners.size).toBe(0);
  });
});
