import { describe, expect, it, vi } from 'vitest';

import {
  WorkspaceShellStartupTierHydrationController,
  type WorkspaceShellStartupTierHydrationControllerOptions,
} from './workspace-shell-startup-tier-hydration.controller';

function createController(
  overrides: Partial<WorkspaceShellStartupTierHydrationControllerOptions> = {},
) {
  let enabled = true;
  let currentUserId: string | null = 'user-1';
  let coreDataLoaded = true;
  const readyTiers = new Set<'p1' | 'p2'>();
  const markAuthReady = vi.fn();
  const warmupTaskOperations = vi.fn<() => Promise<unknown>>().mockResolvedValue(undefined);
  const preloadSidebarTools = vi.fn<(reason: 'p1') => void>();
  const initializeSyncCoordinator = vi.fn();
  const startSyncRuntime = vi.fn();
  let sidebarToolsDynamicLoadEnabled = true;
  const controller = new WorkspaceShellStartupTierHydrationController({
    isEnabled: () => enabled,
    currentUserId: () => currentUserId,
    coreDataLoaded: () => coreDataLoaded,
    isTierReady: tier => readyTiers.has(tier),
    markAuthReady,
    warmupTaskOperations,
    isSidebarToolsDynamicLoadEnabled: () => sidebarToolsDynamicLoadEnabled,
    preloadSidebarTools,
    initializeSyncCoordinator,
    startSyncRuntime,
    ...overrides,
  });

  return {
    controller,
    initializeSyncCoordinator,
    markAuthReady,
    preloadSidebarTools,
    readyTiers,
    setCoreDataLoaded: (value: boolean) => {
      coreDataLoaded = value;
    },
    setCurrentUserId: (userId: string | null) => {
      currentUserId = userId;
    },
    setEnabled: (value: boolean) => {
      enabled = value;
    },
    setSidebarToolsDynamicLoadEnabled: (value: boolean) => {
      sidebarToolsDynamicLoadEnabled = value;
    },
    startSyncRuntime,
    warmupTaskOperations,
  };
}

const flushMicrotasks = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

describe('WorkspaceShellStartupTierHydrationController', () => {
  it('marks auth ready only after a user and core data are available', () => {
    const { controller, markAuthReady, setCoreDataLoaded, setCurrentUserId } = createController();
    setCurrentUserId(null);

    controller.markAuthReadyIfReady();
    setCurrentUserId('user-1');
    setCoreDataLoaded(false);
    controller.markAuthReadyIfReady();
    setCoreDataLoaded(true);
    controller.markAuthReadyIfReady();

    expect(markAuthReady).toHaveBeenCalledTimes(1);
  });

  it('skips all startup tier work while disabled', () => {
    const {
      controller,
      initializeSyncCoordinator,
      markAuthReady,
      preloadSidebarTools,
      readyTiers,
      setEnabled,
      startSyncRuntime,
      warmupTaskOperations,
    } = createController();
    setEnabled(false);
    readyTiers.add('p1');
    readyTiers.add('p2');

    controller.markAuthReadyIfReady();
    controller.warmupInteractionIfReady();
    controller.startSyncHydrationIfReady();

    expect(markAuthReady).not.toHaveBeenCalled();
    expect(warmupTaskOperations).not.toHaveBeenCalled();
    expect(preloadSidebarTools).not.toHaveBeenCalled();
    expect(initializeSyncCoordinator).not.toHaveBeenCalled();
    expect(startSyncRuntime).not.toHaveBeenCalled();
  });

  it('warms interaction dependencies once when tier p1 is ready', async () => {
    const { controller, preloadSidebarTools, readyTiers, warmupTaskOperations } = createController();

    controller.warmupInteractionIfReady();
    readyTiers.add('p1');
    controller.warmupInteractionIfReady();
    controller.warmupInteractionIfReady();
    await flushMicrotasks();

    expect(warmupTaskOperations).toHaveBeenCalledTimes(1);
    expect(preloadSidebarTools).toHaveBeenCalledWith('p1');
  });

  it('does not preload sidebar tools when dynamic loading is disabled', () => {
    const {
      controller,
      preloadSidebarTools,
      readyTiers,
      setSidebarToolsDynamicLoadEnabled,
      warmupTaskOperations,
    } = createController();
    setSidebarToolsDynamicLoadEnabled(false);
    readyTiers.add('p1');

    controller.warmupInteractionIfReady();

    expect(warmupTaskOperations).toHaveBeenCalledTimes(1);
    expect(preloadSidebarTools).not.toHaveBeenCalled();
  });

  it('retries interaction warmup after task operation warmup fails', async () => {
    const startupError = new Error('warmup failed');
    const warmupTaskOperations = vi.fn<() => Promise<unknown>>()
      .mockRejectedValueOnce(startupError)
      .mockResolvedValueOnce(undefined);
    const { controller, preloadSidebarTools, readyTiers } = createController({
      warmupTaskOperations,
    });
    readyTiers.add('p1');

    controller.warmupInteractionIfReady();
    await expect(warmupTaskOperations.mock.results[0].value).rejects.toBe(startupError);
    controller.warmupInteractionIfReady();
    await flushMicrotasks();

    expect(warmupTaskOperations).toHaveBeenCalledTimes(2);
    expect(preloadSidebarTools).toHaveBeenCalledTimes(1);
  });

  it('retries interaction warmup after task operation warmup throws synchronously', async () => {
    const startupError = new Error('warmup failed');
    const warmupTaskOperations = vi.fn<() => Promise<unknown>>()
      .mockImplementationOnce(() => {
        throw startupError;
      })
      .mockResolvedValueOnce(undefined);
    const { controller, preloadSidebarTools, readyTiers } = createController({
      warmupTaskOperations,
    });
    readyTiers.add('p1');

    expect(() => controller.warmupInteractionIfReady()).not.toThrow();
    controller.warmupInteractionIfReady();
    await flushMicrotasks();

    expect(warmupTaskOperations).toHaveBeenCalledTimes(2);
    expect(preloadSidebarTools).toHaveBeenCalledTimes(1);
  });

  it('normalizes non-Promise interaction warmup results and keeps later calls deduped', async () => {
    const warmupTaskOperations = vi.fn<() => Promise<unknown>>()
      .mockReturnValueOnce(undefined as unknown as Promise<unknown>);
    const { controller, preloadSidebarTools, readyTiers } = createController({
      warmupTaskOperations,
    });
    readyTiers.add('p1');

    expect(() => controller.warmupInteractionIfReady()).not.toThrow();
    await flushMicrotasks();
    controller.warmupInteractionIfReady();
    await flushMicrotasks();

    expect(warmupTaskOperations).toHaveBeenCalledTimes(1);
    expect(preloadSidebarTools).toHaveBeenCalledTimes(1);
  });

  it('retries sidebar preload when p1 preload throws after task warmup succeeds', async () => {
    const preloadError = new Error('preload failed');
    const preloadSidebarTools = vi.fn<(reason: 'p1') => void>()
      .mockImplementationOnce(() => {
        throw preloadError;
      });
    const { controller, readyTiers, warmupTaskOperations } = createController({
      preloadSidebarTools,
    });
    readyTiers.add('p1');

    controller.warmupInteractionIfReady();
    await flushMicrotasks();
    controller.warmupInteractionIfReady();
    await flushMicrotasks();

    expect(warmupTaskOperations).toHaveBeenCalledTimes(2);
    expect(preloadSidebarTools).toHaveBeenCalledTimes(2);
  });

  it('starts sync hydration once when tier p2 is ready', () => {
    const { controller, initializeSyncCoordinator, readyTiers, startSyncRuntime } = createController();

    controller.startSyncHydrationIfReady();
    readyTiers.add('p2');
    controller.startSyncHydrationIfReady();
    controller.startSyncHydrationIfReady();

    expect(initializeSyncCoordinator).toHaveBeenCalledTimes(1);
    expect(startSyncRuntime).toHaveBeenCalledTimes(1);
  });

  it('isolates sync hydration startup failures and retries on the next effect pass', () => {
    const startupError = new Error('runtime start failed');
    const startSyncRuntime = vi.fn()
      .mockImplementationOnce(() => {
        throw startupError;
      });
    const { controller, initializeSyncCoordinator, readyTiers } = createController({
      startSyncRuntime,
    });
    readyTiers.add('p2');

    expect(() => controller.startSyncHydrationIfReady()).not.toThrow();
    controller.startSyncHydrationIfReady();

    expect(initializeSyncCoordinator).toHaveBeenCalledTimes(2);
    expect(startSyncRuntime).toHaveBeenCalledTimes(2);
  });
});
