import { describe, expect, it, vi } from 'vitest';

import { createWorkspaceShellSignOutController } from './workspace-shell-sign-out.factory';

function createController(signedOut: boolean) {
  const authCoord = { signOut: vi.fn().mockResolvedValue(signedOut) };
  const syncPulseLifecycle = {
    resetFocusEntrySyncPulse: vi.fn(),
    destroy: vi.fn(),
  };
  const projectCoord = { clearState: vi.fn() };
  const searchController = { clear: vi.fn() };
  const controller = createWorkspaceShellSignOutController({
    authCoord,
    syncPulseLifecycle: () => syncPulseLifecycle,
    projectCoord,
    searchController: () => searchController,
  });

  return {
    authCoord,
    controller,
    projectCoord,
    searchController,
    syncPulseLifecycle,
  };
}

describe('createWorkspaceShellSignOutController', () => {
  it('maps shell services into successful sign-out cleanup', async () => {
    const {
      authCoord,
      controller,
      projectCoord,
      searchController,
      syncPulseLifecycle,
    } = createController(true);

    await controller.signOut();

    expect(authCoord.signOut).toHaveBeenCalledTimes(1);
    expect(syncPulseLifecycle.resetFocusEntrySyncPulse).toHaveBeenCalledWith(false);
    expect(syncPulseLifecycle.destroy).toHaveBeenCalledTimes(1);
    expect(projectCoord.clearState).toHaveBeenCalledTimes(1);
    expect(searchController.clear).toHaveBeenCalledTimes(1);
  });

  it('leaves shell state intact when sign-out is interrupted', async () => {
    const {
      controller,
      projectCoord,
      searchController,
      syncPulseLifecycle,
    } = createController(false);

    await controller.signOut();

    expect(syncPulseLifecycle.resetFocusEntrySyncPulse).not.toHaveBeenCalled();
    expect(syncPulseLifecycle.destroy).not.toHaveBeenCalled();
    expect(projectCoord.clearState).not.toHaveBeenCalled();
    expect(searchController.clear).not.toHaveBeenCalled();
  });
});
