import { describe, expect, it, vi } from 'vitest';

import {
  createWorkspaceShellStartupEntryIntentLazyLoadHostLoader,
  type WorkspaceShellStartupEntryIntentLazyLoadHostLoaderOptions,
  type WorkspaceShellStartupEntryIntentLazyLoadHostLike,
} from './workspace-shell-startup-entry-intent-lazy-load-host-loader.factory';

function createLazyLoadHost(): WorkspaceShellStartupEntryIntentLazyLoadHostLike {
  return {
    flushWidgetWorkspaceGateRecheck: vi.fn(),
    resetPrimeState: vi.fn(),
    resolveConsumedStartupEntryNavigation: vi.fn(() => []),
    sync: vi.fn(),
    teardown: vi.fn(),
  };
}

function createOptions(
  overrides: Partial<WorkspaceShellStartupEntryIntentLazyLoadHostLoaderOptions> = {},
): WorkspaceShellStartupEntryIntentLazyLoadHostLoaderOptions {
  return {
    options: {
      routeUrl: () => '/projects/project-1/task/task-1?entry=widget&intent=open-workspace',
      currentStartupEntryIntent: () => null,
      deferredStartupEntryIntent: () => null,
      currentUserId: () => 'user-1',
      isApplicationReady: () => true,
      isBlackBoxEnabled: () => true,
      setSidebarOpen: vi.fn(),
      preloadSidebarTools: vi.fn(),
      loadBlackBoxRecorder: vi.fn(),
      applyWidgetGateMutation: vi.fn(),
      primeWidgetWorkspaceGateSync: vi.fn(),
      refreshFocusSessionFromCloud: vi.fn(),
      recheckGate: vi.fn(),
      clearDeferredStartupEntryIntent: vi.fn(),
      resolveMobileRootProjectId: () => 'project-root',
      navigate: vi.fn(),
      warn: vi.fn(),
    },
    ...overrides,
  };
}

describe('createWorkspaceShellStartupEntryIntentLazyLoadHostLoader', () => {
  it('uses the provided startup entry intent lazy-load host factory', async () => {
    const host = createLazyLoadHost();
    const createStartupEntryIntentLazyLoadHost = vi.fn(() => host);
    const loadHost = createWorkspaceShellStartupEntryIntentLazyLoadHostLoader({
      ...createOptions(),
      createStartupEntryIntentLazyLoadHost,
    });

    await expect(loadHost()).resolves.toBe(host);

    expect(createStartupEntryIntentLazyLoadHost).toHaveBeenCalledOnce();
  });

  it('converts synchronous custom host factory failures to rejected promises and retries later', async () => {
    const failure = new Error('startup host factory failed');
    const host = createLazyLoadHost();
    const createStartupEntryIntentLazyLoadHost = vi.fn()
      .mockImplementationOnce(() => {
        throw failure;
      })
      .mockReturnValueOnce(host);
    const loadHost = createWorkspaceShellStartupEntryIntentLazyLoadHostLoader({
      ...createOptions(),
      createStartupEntryIntentLazyLoadHost,
    });

    const loadPromise = loadHost();

    await expect(loadPromise).rejects.toBe(failure);
    await expect(loadHost()).resolves.toBe(host);
    expect(createStartupEntryIntentLazyLoadHost).toHaveBeenCalledTimes(2);
  });

  it('creates the default startup entry intent lazy-load host lazily', async () => {
    const innerController = {
      flushWidgetWorkspaceGateRecheck: vi.fn(),
      resetPrimeState: vi.fn(),
      sync: vi.fn(),
    };
    const createStartupEntryIntentController = vi.fn()
      .mockResolvedValue(innerController);
    const loadHost = createWorkspaceShellStartupEntryIntentLazyLoadHostLoader(createOptions({
      options: {
        ...createOptions().options,
        createStartupEntryIntentController,
      },
    }));

    const host = await loadHost();
    host.sync();
    await vi.waitFor(() => expect(innerController.sync).toHaveBeenCalledOnce());

    expect(createStartupEntryIntentController).toHaveBeenCalledOnce();
  });
});
