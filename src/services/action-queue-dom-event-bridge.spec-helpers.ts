export function installWindowEventBridge(): () => void {
  const originalAddEventListener = window.addEventListener;
  const originalRemoveEventListener = window.removeEventListener;
  const originalDispatchEvent = window.dispatchEvent;
  const listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();

  Object.defineProperty(window, 'addEventListener', {
    configurable: true,
    writable: true,
    value: (type: string, listener: EventListenerOrEventListenerObject | null) => {
      if (!listener) {
        return;
      }
      const bucket = listeners.get(type) ?? new Set<EventListenerOrEventListenerObject>();
      bucket.add(listener);
      listeners.set(type, bucket);
    },
  });

  Object.defineProperty(window, 'removeEventListener', {
    configurable: true,
    writable: true,
    value: (type: string, listener: EventListenerOrEventListenerObject | null) => {
      if (!listener) {
        return;
      }
      listeners.get(type)?.delete(listener);
    },
  });

  Object.defineProperty(window, 'dispatchEvent', {
    configurable: true,
    writable: true,
    value: (event: Event) => {
      const bucket = listeners.get(event.type);
      if (!bucket) {
        return true;
      }

      for (const listener of bucket) {
        if (typeof listener === 'function') {
          listener.call(window, event);
          continue;
        }

        listener.handleEvent(event);
      }

      return true;
    },
  });

  return () => {
    Object.defineProperty(window, 'addEventListener', {
      configurable: true,
      writable: true,
      value: originalAddEventListener,
    });
    Object.defineProperty(window, 'removeEventListener', {
      configurable: true,
      writable: true,
      value: originalRemoveEventListener,
    });
    Object.defineProperty(window, 'dispatchEvent', {
      configurable: true,
      writable: true,
      value: originalDispatchEvent,
    });
  };
}
