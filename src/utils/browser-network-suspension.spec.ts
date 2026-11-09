import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ensureBrowserNetworkSuspensionTracking,
  resetBrowserNetworkSuspensionTrackingForTests,
} from './browser-network-suspension';

interface ListenerTarget {
  addEventListener(type: string, listener: EventListener): void;
  removeEventListener(type: string, listener: EventListener): void;
  listenerCount(type: string): number;
}

function createListenerTarget(): ListenerTarget {
  const listeners = new Map<string, Set<EventListener>>();

  return {
    addEventListener(type: string, listener: EventListener): void {
      const current = listeners.get(type) ?? new Set<EventListener>();
      current.add(listener);
      listeners.set(type, current);
    },
    removeEventListener(type: string, listener: EventListener): void {
      listeners.get(type)?.delete(listener);
    },
    listenerCount(type: string): number {
      return listeners.get(type)?.size ?? 0;
    },
  };
}

describe('browser-network-suspension tracking', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    resetBrowserNetworkSuspensionTrackingForTests();
  });

  it('rolls back already registered listeners when initialization fails midway', () => {
    const registrationError = new Error('pageshow listener failed');
    const documentAddSpy = vi
      .spyOn(document, 'addEventListener')
      .mockImplementation(() => undefined);
    const documentRemoveSpy = vi
      .spyOn(document, 'removeEventListener')
      .mockImplementation(() => undefined);
    vi.spyOn(window, 'addEventListener').mockImplementation(((type: string) => {
      if (type === 'pageshow') {
        throw registrationError;
      }
    }) as typeof window.addEventListener);

    expect(() => ensureBrowserNetworkSuspensionTracking()).toThrow(registrationError);

    expect(documentAddSpy).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
    expect(documentRemoveSpy).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
  });

  it('continues cleanup and releases tracking state when listener removal fails', () => {
    vi.spyOn(document, 'addEventListener').mockImplementation(() => undefined);
    const windowAddSpy = vi.spyOn(window, 'addEventListener').mockImplementation(() => undefined);
    const documentRemoveSpy = vi
      .spyOn(document, 'removeEventListener')
      .mockImplementation(() => {
        throw new Error('visibility removal failed');
      });
    const windowRemoveSpy = vi
      .spyOn(window, 'removeEventListener')
      .mockImplementation(() => undefined);

    ensureBrowserNetworkSuspensionTracking();

    expect(() => resetBrowserNetworkSuspensionTrackingForTests()).not.toThrow();
    expect(documentRemoveSpy).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
    expect(windowRemoveSpy).toHaveBeenCalledWith('pageshow', expect.any(Function));
    expect(windowRemoveSpy).toHaveBeenCalledWith('online', expect.any(Function));

    ensureBrowserNetworkSuspensionTracking();

    const onlineRegistrations = windowAddSpy.mock.calls.filter(([type]) => type === 'online');
    expect(onlineRegistrations).toHaveLength(2);
  });

  it('removes listeners from the original targets after globals are replaced', () => {
    const originalDocument = createListenerTarget();
    const originalWindow = createListenerTarget();
    vi.stubGlobal('document', originalDocument);
    vi.stubGlobal('window', originalWindow);

    ensureBrowserNetworkSuspensionTracking();

    const replacementDocument = createListenerTarget();
    const replacementWindow = createListenerTarget();
    vi.stubGlobal('document', replacementDocument);
    vi.stubGlobal('window', replacementWindow);

    resetBrowserNetworkSuspensionTrackingForTests();

    expect(originalDocument.listenerCount('visibilitychange')).toBe(0);
    expect(originalWindow.listenerCount('pageshow')).toBe(0);
    expect(originalWindow.listenerCount('online')).toBe(0);
    expect(replacementDocument.listenerCount('visibilitychange')).toBe(0);
    expect(replacementWindow.listenerCount('pageshow')).toBe(0);
    expect(replacementWindow.listenerCount('online')).toBe(0);
  });

  it('reinitializes replacement targets without duplicating or inheriting old listeners', () => {
    const originalDocument = createListenerTarget();
    const originalWindow = createListenerTarget();
    vi.stubGlobal('document', originalDocument);
    vi.stubGlobal('window', originalWindow);
    ensureBrowserNetworkSuspensionTracking();

    const replacementDocument = createListenerTarget();
    const replacementWindow = createListenerTarget();
    vi.stubGlobal('document', replacementDocument);
    vi.stubGlobal('window', replacementWindow);

    resetBrowserNetworkSuspensionTrackingForTests();
    ensureBrowserNetworkSuspensionTracking();

    expect(originalDocument.listenerCount('visibilitychange')).toBe(0);
    expect(originalWindow.listenerCount('pageshow')).toBe(0);
    expect(originalWindow.listenerCount('online')).toBe(0);
    expect(replacementDocument.listenerCount('visibilitychange')).toBe(1);
    expect(replacementWindow.listenerCount('pageshow')).toBe(1);
    expect(replacementWindow.listenerCount('online')).toBe(1);

    resetBrowserNetworkSuspensionTrackingForTests();
    ensureBrowserNetworkSuspensionTracking();

    expect(replacementDocument.listenerCount('visibilitychange')).toBe(1);
    expect(replacementWindow.listenerCount('pageshow')).toBe(1);
    expect(replacementWindow.listenerCount('online')).toBe(1);
  });
});
