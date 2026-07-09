import { describe, expect, it, vi } from 'vitest';

import {
  WorkspaceShellMobileFocusGateController,
  type WorkspaceShellMobileFocusGateControllerOptions,
} from './workspace-shell-mobile-focus-gate.controller';

function createController(
  overrides: Partial<WorkspaceShellMobileFocusGateControllerOptions> = {},
) {
  let throttledFocusStartup = true;
  let mobile = true;
  let currentUserId: string | null = 'user-1';
  const setFocusModeIntentActivated = vi.fn();
  const preloadFocusModeAssets = vi.fn<(reason: 'intent') => Promise<void>>().mockResolvedValue(undefined);
  const dispatchFocusEntrySyncPulseIfReady = vi.fn();
  const teardownFocusMountIntentListener = vi.fn();
  const checkGateForProjectEntry = vi.fn();
  const warmProjectEntryGateSnapshot = vi.fn();
  const controller = new WorkspaceShellMobileFocusGateController({
    isThrottledFocusStartup: () => throttledFocusStartup,
    isMobile: () => mobile,
    currentUserId: () => currentUserId,
    setFocusModeIntentActivated,
    preloadFocusModeAssets,
    dispatchFocusEntrySyncPulseIfReady,
    teardownFocusMountIntentListener,
    checkGateForProjectEntry,
    warmProjectEntryGateSnapshot,
    ...overrides,
  });

  return {
    checkGateForProjectEntry,
    controller,
    dispatchFocusEntrySyncPulseIfReady,
    preloadFocusModeAssets,
    setCurrentUserId: (userId: string | null) => {
      currentUserId = userId;
    },
    setFocusModeIntentActivated,
    setMobile: (value: boolean) => {
      mobile = value;
    },
    setThrottledFocusStartup: (value: boolean) => {
      throttledFocusStartup = value;
    },
    teardownFocusMountIntentListener,
    warmProjectEntryGateSnapshot,
  };
}

describe('WorkspaceShellMobileFocusGateController', () => {
  it('checks the project gate immediately on mobile with a confirmed user', () => {
    const {
      checkGateForProjectEntry,
      controller,
      dispatchFocusEntrySyncPulseIfReady,
      preloadFocusModeAssets,
      setFocusModeIntentActivated,
      teardownFocusMountIntentListener,
    } = createController();

    controller.checkGateForMobileProjectEntry();

    expect(setFocusModeIntentActivated).toHaveBeenCalledWith(true);
    expect(preloadFocusModeAssets).toHaveBeenCalledWith('intent');
    expect(dispatchFocusEntrySyncPulseIfReady).toHaveBeenCalledTimes(1);
    expect(teardownFocusMountIntentListener).toHaveBeenCalledTimes(1);
    expect(checkGateForProjectEntry).toHaveBeenCalledTimes(1);
  });

  it('queues the project gate check until a mobile user is confirmed', () => {
    const { checkGateForProjectEntry, controller, setCurrentUserId } = createController();
    setCurrentUserId(null);

    controller.checkGateForMobileProjectEntry();
    expect(checkGateForProjectEntry).not.toHaveBeenCalled();

    setCurrentUserId('user-1');
    controller.flushPendingMobileProjectGateCheck();
    controller.flushPendingMobileProjectGateCheck();

    expect(checkGateForProjectEntry).toHaveBeenCalledTimes(1);
  });

  it('keeps a pending project gate check while the viewport is desktop', () => {
    const { checkGateForProjectEntry, controller, setCurrentUserId, setMobile } = createController();
    setCurrentUserId(null);

    controller.checkGateForMobileProjectEntry();
    setCurrentUserId('user-1');
    setMobile(false);
    controller.flushPendingMobileProjectGateCheck();
    expect(checkGateForProjectEntry).not.toHaveBeenCalled();

    setMobile(true);
    controller.flushPendingMobileProjectGateCheck();
    expect(checkGateForProjectEntry).toHaveBeenCalledTimes(1);
  });

  it('keeps a pending project gate check while throttled focus startup is disabled', () => {
    const {
      checkGateForProjectEntry,
      controller,
      setCurrentUserId,
      setThrottledFocusStartup,
    } = createController();
    setCurrentUserId(null);

    controller.checkGateForMobileProjectEntry();
    setCurrentUserId('user-1');
    setThrottledFocusStartup(false);
    controller.flushPendingMobileProjectGateCheck();
    expect(checkGateForProjectEntry).not.toHaveBeenCalled();

    setThrottledFocusStartup(true);
    controller.flushPendingMobileProjectGateCheck();
    expect(checkGateForProjectEntry).toHaveBeenCalledTimes(1);
  });

  it('retains a pending project gate check when flushing the gate throws', () => {
    const gateError = new Error('project gate failed');
    const checkGateForProjectEntry = vi.fn()
      .mockImplementationOnce(() => {
        throw gateError;
      });
    const { controller, setCurrentUserId } = createController({
      checkGateForProjectEntry,
    });
    setCurrentUserId(null);
    controller.checkGateForMobileProjectEntry();

    setCurrentUserId('user-1');
    expect(() => controller.flushPendingMobileProjectGateCheck()).toThrow(gateError);
    controller.flushPendingMobileProjectGateCheck();

    expect(checkGateForProjectEntry).toHaveBeenCalledTimes(2);
  });

  it('clears a stale pending project gate check when an authenticated mobile entry runs', () => {
    const { checkGateForProjectEntry, controller, setCurrentUserId } = createController();
    setCurrentUserId(null);
    controller.checkGateForMobileProjectEntry();

    setCurrentUserId('user-1');
    controller.checkGateForMobileProjectEntry();
    controller.flushPendingMobileProjectGateCheck();

    expect(checkGateForProjectEntry).toHaveBeenCalledTimes(1);
  });

  it('warms the project gate snapshot only for mobile throttled startup', () => {
    const { controller, setMobile, setThrottledFocusStartup, warmProjectEntryGateSnapshot } = createController();

    controller.warmMobileProjectGateSnapshot();
    expect(warmProjectEntryGateSnapshot).toHaveBeenCalledTimes(1);

    setMobile(false);
    controller.warmMobileProjectGateSnapshot();
    setMobile(true);
    setThrottledFocusStartup(false);
    controller.warmMobileProjectGateSnapshot();

    expect(warmProjectEntryGateSnapshot).toHaveBeenCalledTimes(1);
  });

  it('skips project gate entry work outside mobile throttled startup', () => {
    const {
      checkGateForProjectEntry,
      controller,
      dispatchFocusEntrySyncPulseIfReady,
      preloadFocusModeAssets,
      setFocusModeIntentActivated,
      setMobile,
      setThrottledFocusStartup,
      teardownFocusMountIntentListener,
    } = createController();

    setMobile(false);
    controller.checkGateForMobileProjectEntry();
    setMobile(true);
    setThrottledFocusStartup(false);
    controller.checkGateForMobileProjectEntry();

    expect(setFocusModeIntentActivated).not.toHaveBeenCalled();
    expect(preloadFocusModeAssets).not.toHaveBeenCalled();
    expect(dispatchFocusEntrySyncPulseIfReady).not.toHaveBeenCalled();
    expect(teardownFocusMountIntentListener).not.toHaveBeenCalled();
    expect(checkGateForProjectEntry).not.toHaveBeenCalled();
  });
});
