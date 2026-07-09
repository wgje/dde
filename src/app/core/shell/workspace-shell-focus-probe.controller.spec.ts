import { describe, expect, it, vi } from 'vitest';

import {
  WorkspaceShellFocusProbeController,
  type WorkspaceShellFocusProbeControllerOptions,
} from './workspace-shell-focus-probe.controller';

function createController(
  overrides: Partial<WorkspaceShellFocusProbeControllerOptions> = {},
) {
  let enabled = true;
  let currentUserId: string | null = 'user-1';
  let coreDataLoaded = true;
  const flushWidgetWorkspaceGateRecheck = vi.fn();
  const warmMobileProjectGateSnapshot = vi.fn();
  const flushPendingMobileProjectGateCheck = vi.fn();
  const initializeFocusStartupProbe = vi.fn();
  const controller = new WorkspaceShellFocusProbeController({
    isEnabled: () => enabled,
    currentUserId: () => currentUserId,
    coreDataLoaded: () => coreDataLoaded,
    flushWidgetWorkspaceGateRecheck,
    warmMobileProjectGateSnapshot,
    flushPendingMobileProjectGateCheck,
    initializeFocusStartupProbe,
    ...overrides,
  });

  return {
    controller,
    flushPendingMobileProjectGateCheck,
    flushWidgetWorkspaceGateRecheck,
    initializeFocusStartupProbe,
    setCoreDataLoaded: (value: boolean) => {
      coreDataLoaded = value;
    },
    setCurrentUserId: (userId: string | null) => {
      currentUserId = userId;
    },
    setEnabled: (value: boolean) => {
      enabled = value;
    },
    warmMobileProjectGateSnapshot,
  };
}

describe('WorkspaceShellFocusProbeController', () => {
  it('skips all focus probe work while disabled', () => {
    const {
      controller,
      flushPendingMobileProjectGateCheck,
      flushWidgetWorkspaceGateRecheck,
      initializeFocusStartupProbe,
      setEnabled,
      warmMobileProjectGateSnapshot,
    } = createController();
    setEnabled(false);

    controller.sync();

    expect(flushWidgetWorkspaceGateRecheck).not.toHaveBeenCalled();
    expect(warmMobileProjectGateSnapshot).not.toHaveBeenCalled();
    expect(flushPendingMobileProjectGateCheck).not.toHaveBeenCalled();
    expect(initializeFocusStartupProbe).not.toHaveBeenCalled();
  });

  it('flushes pending focus entry gates before core data is loaded', () => {
    const {
      controller,
      flushPendingMobileProjectGateCheck,
      flushWidgetWorkspaceGateRecheck,
      initializeFocusStartupProbe,
      setCoreDataLoaded,
      warmMobileProjectGateSnapshot,
    } = createController();
    setCoreDataLoaded(false);

    controller.sync();

    expect(flushWidgetWorkspaceGateRecheck).toHaveBeenCalledTimes(1);
    expect(warmMobileProjectGateSnapshot).toHaveBeenCalledTimes(1);
    expect(flushPendingMobileProjectGateCheck).toHaveBeenCalledTimes(1);
    expect(initializeFocusStartupProbe).not.toHaveBeenCalled();
  });

  it('initializes the focus startup probe once per confirmed user after core data loads', () => {
    const { controller, flushWidgetWorkspaceGateRecheck, initializeFocusStartupProbe } = createController();

    controller.sync();
    controller.sync();

    expect(initializeFocusStartupProbe).toHaveBeenCalledTimes(1);
    expect(flushWidgetWorkspaceGateRecheck).toHaveBeenCalledTimes(3);
  });

  it('resets the initialized user when the owner clears', () => {
    const { controller, initializeFocusStartupProbe, setCurrentUserId } = createController();

    controller.sync();
    setCurrentUserId(null);
    controller.sync();
    setCurrentUserId('user-1');
    controller.sync();

    expect(initializeFocusStartupProbe).toHaveBeenCalledTimes(2);
  });

  it('initializes again when the confirmed user changes', () => {
    const { controller, initializeFocusStartupProbe, setCurrentUserId } = createController();

    controller.sync();
    setCurrentUserId('user-2');
    controller.sync();

    expect(initializeFocusStartupProbe).toHaveBeenCalledTimes(2);
  });
});
