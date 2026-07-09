import { describe, expect, it, vi } from 'vitest';

import {
  createWorkspaceShellSignalEffectsLazyLoadHostLoader,
  type WorkspaceShellSignalEffectsLazyLoadHostLike,
  type WorkspaceShellSignalEffectsLazyLoadHostLoaderOptions,
} from './workspace-shell-signal-effects-lazy-load-host-loader.factory';

function createSignalEffectsHost(): WorkspaceShellSignalEffectsLazyLoadHostLike {
  return {
    setup: vi.fn(),
    teardown: vi.fn(),
  };
}

function createOptions(
  overrides: Partial<WorkspaceShellSignalEffectsLazyLoadHostLoaderOptions> = {},
): WorkspaceShellSignalEffectsLazyLoadHostLoaderOptions {
  return {
    options: {
      warn: vi.fn(),
    },
    ...overrides,
  };
}

describe('createWorkspaceShellSignalEffectsLazyLoadHostLoader', () => {
  it('uses the provided signal effects lazy-load host factory', async () => {
    const host = createSignalEffectsHost();
    const createSignalEffectsLazyLoadHost = vi.fn(() => host);
    const loadHost = createWorkspaceShellSignalEffectsLazyLoadHostLoader({
      ...createOptions(),
      createSignalEffectsLazyLoadHost,
    });

    await expect(loadHost()).resolves.toBe(host);

    expect(createSignalEffectsLazyLoadHost).toHaveBeenCalledOnce();
  });

  it('converts synchronous custom host factory failures to rejected promises and retries later', async () => {
    const failure = new Error('signal effects host factory failed');
    const host = createSignalEffectsHost();
    const createSignalEffectsLazyLoadHost = vi.fn()
      .mockImplementationOnce(() => {
        throw failure;
      })
      .mockReturnValueOnce(host);
    const loadHost = createWorkspaceShellSignalEffectsLazyLoadHostLoader({
      ...createOptions(),
      createSignalEffectsLazyLoadHost,
    });

    const loadPromise = loadHost();

    await expect(loadPromise).rejects.toBe(failure);
    await expect(loadHost()).resolves.toBe(host);
    expect(createSignalEffectsLazyLoadHost).toHaveBeenCalledTimes(2);
  });

  it('creates the default signal effects lazy-load host lazily', async () => {
    const signalEffects = {
      setup: vi.fn(),
    };
    const createSignalEffectsController = vi.fn()
      .mockResolvedValue(signalEffects);
    const loadHost = createWorkspaceShellSignalEffectsLazyLoadHostLoader(createOptions({
      options: {
        createSignalEffectsController,
        warn: vi.fn(),
      },
    }));

    const host = await loadHost();
    host.setup();
    await vi.waitFor(() => expect(signalEffects.setup).toHaveBeenCalledOnce());

    expect(createSignalEffectsController).toHaveBeenCalledOnce();
  });
});
