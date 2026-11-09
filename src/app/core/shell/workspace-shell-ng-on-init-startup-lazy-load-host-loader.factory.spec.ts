import { describe, expect, it, vi } from 'vitest';

import {
  createWorkspaceShellNgOnInitStartupLazyLoadHostLoader,
  type WorkspaceShellNgOnInitStartupLazyLoadHostLike,
  type WorkspaceShellNgOnInitStartupLazyLoadHostLoaderOptions,
} from './workspace-shell-ng-on-init-startup-lazy-load-host-loader.factory';

function createLazyLoadHost(): WorkspaceShellNgOnInitStartupLazyLoadHostLike {
  return {
    initialize: vi.fn(),
    teardown: vi.fn(),
  };
}

function createOptions(
  overrides: Partial<WorkspaceShellNgOnInitStartupLazyLoadHostLoaderOptions> = {},
): WorkspaceShellNgOnInitStartupLazyLoadHostLoaderOptions {
  return {
    options: {
      warn: vi.fn(),
    },
    ...overrides,
  };
}

describe('createWorkspaceShellNgOnInitStartupLazyLoadHostLoader', () => {
  it('uses the provided ngOnInit startup lazy-load host factory', async () => {
    const host = createLazyLoadHost();
    const createNgOnInitStartupLazyLoadHost = vi.fn(() => host);
    const loadHost = createWorkspaceShellNgOnInitStartupLazyLoadHostLoader({
      ...createOptions(),
      createNgOnInitStartupLazyLoadHost,
    });

    await expect(loadHost()).resolves.toBe(host);

    expect(createNgOnInitStartupLazyLoadHost).toHaveBeenCalledOnce();
  });

  it('converts synchronous custom host factory failures to rejected promises and retries later', async () => {
    const failure = new Error('ngOnInit startup host factory failed');
    const host = createLazyLoadHost();
    const createNgOnInitStartupLazyLoadHost = vi.fn()
      .mockImplementationOnce(() => {
        throw failure;
      })
      .mockReturnValueOnce(host);
    const loadHost = createWorkspaceShellNgOnInitStartupLazyLoadHostLoader({
      ...createOptions(),
      createNgOnInitStartupLazyLoadHost,
    });

    const loadPromise = loadHost();

    await expect(loadPromise).rejects.toBe(failure);
    await expect(loadHost()).resolves.toBe(host);
    expect(createNgOnInitStartupLazyLoadHost).toHaveBeenCalledTimes(2);
  });

  it('creates the default ngOnInit startup lazy-load host lazily', async () => {
    const delegate = {
      initialize: vi.fn(),
      teardown: vi.fn(),
    };
    const createNgOnInitStartupController = vi.fn()
      .mockResolvedValue(delegate);
    const loadHost = createWorkspaceShellNgOnInitStartupLazyLoadHostLoader(createOptions({
      options: {
        createNgOnInitStartupController,
        warn: vi.fn(),
      },
    }));

    const host = await loadHost();
    host.initialize();
    await vi.waitFor(() => expect(delegate.initialize).toHaveBeenCalledOnce());

    expect(createNgOnInitStartupController).toHaveBeenCalledOnce();
  });
});
