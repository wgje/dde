import { describe, expect, it, vi } from 'vitest';

import {
  createWorkspaceShellStorageEscapeControllerLoader,
  type WorkspaceShellStorageEscapeControllerLike,
} from './workspace-shell-storage-escape-controller-loader.factory';
import type { WorkspaceShellStorageFailureData } from './workspace-shell-storage-escape.controller';

function createStorageEscapeController(): WorkspaceShellStorageEscapeControllerLike {
  return {
    close: vi.fn(),
    setup: vi.fn(),
    teardown: vi.fn(),
  };
}

function createControllerOptions() {
  return {
    onStorageFailure: vi.fn((callback: (data: WorkspaceShellStorageFailureData) => void) => {
      void callback;
    }),
    getProjects: vi.fn(() => []),
    setStorageEscapeData: vi.fn(),
    openStorageEscapeModalImperative: vi.fn(),
    closeStorageEscapeModal: vi.fn(),
    nowIso: vi.fn(() => '2026-06-29T00:00:00.000Z'),
  };
}

describe('createWorkspaceShellStorageEscapeControllerLoader', () => {
  it('uses the provided storage escape controller factory', async () => {
    const controller = createStorageEscapeController();
    const createStorageEscapeControllerFactory = vi.fn(() => controller);
    const loadController = createWorkspaceShellStorageEscapeControllerLoader({
      createStorageEscapeController: createStorageEscapeControllerFactory,
      options: createControllerOptions(),
    });

    await expect(loadController()).resolves.toBe(controller);

    expect(createStorageEscapeControllerFactory).toHaveBeenCalledOnce();
  });

  it('converts synchronous custom controller factory failures to rejected promises and retries later', async () => {
    const failure = new Error('storage escape controller factory failed');
    const controller = createStorageEscapeController();
    const createStorageEscapeControllerFactory = vi.fn()
      .mockImplementationOnce(() => {
        throw failure;
      })
      .mockReturnValueOnce(controller);
    const loadController = createWorkspaceShellStorageEscapeControllerLoader({
      createStorageEscapeController: createStorageEscapeControllerFactory,
      options: createControllerOptions(),
    });

    const loadPromise = loadController();

    await expect(loadPromise).rejects.toBe(failure);
    await expect(loadController()).resolves.toBe(controller);
    expect(createStorageEscapeControllerFactory).toHaveBeenCalledTimes(2);
  });

  it('creates the default storage escape controller lazily', async () => {
    const options = createControllerOptions();
    const loadController = createWorkspaceShellStorageEscapeControllerLoader({ options });

    expect(options.onStorageFailure).not.toHaveBeenCalled();

    const controller = await loadController();
    controller.setup();
    controller.close();

    expect(options.onStorageFailure).toHaveBeenCalledWith(expect.any(Function));
    expect(options.closeStorageEscapeModal).toHaveBeenCalledOnce();
  });
});
