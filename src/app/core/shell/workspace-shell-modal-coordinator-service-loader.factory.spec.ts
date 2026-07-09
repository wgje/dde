import type { Injector } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';

import {
  createWorkspaceShellModalCoordinatorServiceLoader,
} from './workspace-shell-modal-coordinator-service-loader.factory';
import type { WorkspaceShellModalCoordinatorLike } from './workspace-shell-modal-coordinator-lazy-load.controller';

vi.mock('../../../services/workspace-modal-coordinator.service', () => ({
  WorkspaceModalCoordinatorService: class WorkspaceModalCoordinatorService {},
}));

function createModalCoord(): WorkspaceShellModalCoordinatorLike {
  return {
    initCallbacks: vi.fn(),
    isModalLoading: vi.fn(() => false),
  };
}

describe('createWorkspaceShellModalCoordinatorServiceLoader', () => {
  it('uses the provided modal coordinator service loader', async () => {
    const modalCoord = createModalCoord();
    const loadModalCoord = vi.fn().mockResolvedValue(modalCoord);
    const loadService = createWorkspaceShellModalCoordinatorServiceLoader({
      injector: {} as Injector,
      loadModalCoord,
    });

    await expect(loadService()).resolves.toBe(modalCoord);

    expect(loadModalCoord).toHaveBeenCalledOnce();
  });

  it('loads the workspace modal coordinator service through the injector by default', async () => {
    const modalCoord = createModalCoord();
    const injectorGet = vi.fn().mockReturnValue(modalCoord);
    const injector = { get: injectorGet } as unknown as Injector;
    const loadService = createWorkspaceShellModalCoordinatorServiceLoader({ injector });

    await expect(loadService()).resolves.toBe(modalCoord);

    expect(injectorGet).toHaveBeenCalledOnce();
    const [token] = injectorGet.mock.calls[0];
    expect((token as { name?: string }).name).toBe('WorkspaceModalCoordinatorService');
  });
});
