import { describe, expect, it, vi } from 'vitest';

import { WorkspaceShellSignOutController } from './workspace-shell-sign-out.controller';

function createController(signedOut: boolean) {
  const signOut = vi.fn().mockResolvedValue(signedOut);
  const resetFocusEntrySyncPulseState = vi.fn();
  const destroySyncPulse = vi.fn();
  const clearProjectState = vi.fn();
  const clearSearchState = vi.fn();
  const controller = new WorkspaceShellSignOutController({
    signOut,
    resetFocusEntrySyncPulseState,
    destroySyncPulse,
    clearProjectState,
    clearSearchState,
  });

  return {
    clearProjectState,
    clearSearchState,
    controller,
    destroySyncPulse,
    resetFocusEntrySyncPulseState,
    signOut,
  };
}

describe('WorkspaceShellSignOutController', () => {
  it('clears session-scoped workspace state after successful sign out', async () => {
    const {
      clearProjectState,
      clearSearchState,
      controller,
      destroySyncPulse,
      resetFocusEntrySyncPulseState,
      signOut,
    } = createController(true);

    await controller.signOut();

    expect(signOut).toHaveBeenCalledTimes(1);
    expect(resetFocusEntrySyncPulseState).toHaveBeenCalledWith(false);
    expect(destroySyncPulse).toHaveBeenCalledTimes(1);
    expect(clearProjectState).toHaveBeenCalledTimes(1);
    expect(clearSearchState).toHaveBeenCalledTimes(1);
  });

  it('continues local workspace cleanup when sync pulse reset fails after sign out', async () => {
    const {
      clearProjectState,
      clearSearchState,
      controller,
      destroySyncPulse,
      resetFocusEntrySyncPulseState,
      signOut,
    } = createController(true);
    resetFocusEntrySyncPulseState.mockImplementationOnce(() => {
      throw new Error('reset failed');
    });

    await expect(controller.signOut()).resolves.toBeUndefined();

    expect(signOut).toHaveBeenCalledTimes(1);
    expect(resetFocusEntrySyncPulseState).toHaveBeenCalledWith(false);
    expect(destroySyncPulse).toHaveBeenCalledTimes(1);
    expect(clearProjectState).toHaveBeenCalledTimes(1);
    expect(clearSearchState).toHaveBeenCalledTimes(1);
  });

  it('keeps workspace state when remote sign out is interrupted', async () => {
    const {
      clearProjectState,
      clearSearchState,
      controller,
      destroySyncPulse,
      resetFocusEntrySyncPulseState,
      signOut,
    } = createController(false);

    await controller.signOut();

    expect(signOut).toHaveBeenCalledTimes(1);
    expect(resetFocusEntrySyncPulseState).not.toHaveBeenCalled();
    expect(destroySyncPulse).not.toHaveBeenCalled();
    expect(clearProjectState).not.toHaveBeenCalled();
    expect(clearSearchState).not.toHaveBeenCalled();
  });
});
