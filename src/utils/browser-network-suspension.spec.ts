import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ensureBrowserNetworkSuspensionTracking,
  resetBrowserNetworkSuspensionTrackingForTests,
} from './browser-network-suspension';

describe('browser-network-suspension tracking', () => {
  afterEach(() => {
    vi.restoreAllMocks();
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
});
