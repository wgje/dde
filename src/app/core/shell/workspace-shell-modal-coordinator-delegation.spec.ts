import { describe, expect, it, vi } from 'vitest';

import { WorkspaceShellModalCoordinatorLazyLoadController } from './workspace-shell-modal-coordinator-lazy-load.controller';

describe('WorkspaceShell modal coordinator delegation', () => {
  it('resolves the modal coordinator through the lazy-load controller and initializes callbacks', async () => {
    const callbacks = { signOut: vi.fn() };
    const modalCoord = {
      initCallbacks: vi.fn(),
      isModalLoading: vi.fn(() => false),
    };
    const loadModalCoord = vi.fn().mockResolvedValue(modalCoord);
    const controller = new WorkspaceShellModalCoordinatorLazyLoadController({
      createCallbacks: () => callbacks,
      destroyed: () => false,
      fallbackModalCoord: modalCoord,
      loadModalCoord,
    });

    const result = await controller.get();

    expect(result).toBe(modalCoord);
    expect(loadModalCoord).toHaveBeenCalledTimes(1);
    expect(modalCoord.initCallbacks).toHaveBeenCalledWith(callbacks);
  });
});
