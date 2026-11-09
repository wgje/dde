import { describe, expect, it, vi } from 'vitest';

import {
  createWorkspaceShellLazyLifecycleServiceHost,
} from './workspace-shell-lazy-lifecycle-service-host.factory';
import {
  createWorkspaceShellLazyLifecycleDeferred,
  createWorkspaceShellLazyLifecycleSpecService,
  flushWorkspaceShellLazyLifecycleMicrotasks,
} from './workspace-shell-lazy-lifecycle.spec-helpers';
import type {
  WorkspaceShellLazyLifecycleDelegate,
} from './workspace-shell-lazy-lifecycle-host.controller';

describe('createWorkspaceShellLazyLifecycleServiceHost', () => {
  it('loads and initializes the lazy service while the shell is alive', async () => {
    const service = createWorkspaceShellLazyLifecycleSpecService();
    const loadService = vi.fn().mockResolvedValue(service);
    const host = createWorkspaceShellLazyLifecycleServiceHost({
      destroyed: () => false,
      initializeFailureMessage: 'initialize failed',
      loadService,
      teardownFailureMessage: 'teardown failed',
      warn: vi.fn(),
    });

    host.initialize();
    await flushWorkspaceShellLazyLifecycleMicrotasks();

    expect(loadService).toHaveBeenCalledTimes(1);
    expect(service.initialize).toHaveBeenCalledTimes(1);
    expect(service.teardown).not.toHaveBeenCalled();
  });

  it('tears down the lazy service when the shell is destroyed before initialization', async () => {
    const service = createWorkspaceShellLazyLifecycleSpecService();
    const deferred = createWorkspaceShellLazyLifecycleDeferred<
      WorkspaceShellLazyLifecycleDelegate
    >();
    const warn = vi.fn();
    let destroyed = false;
    const host = createWorkspaceShellLazyLifecycleServiceHost({
      destroyed: () => destroyed,
      initializeFailureMessage: 'initialize failed',
      loadService: vi.fn(() => deferred.promise),
      teardownFailureMessage: 'teardown failed',
      warn,
    });

    host.initialize();
    destroyed = true;
    deferred.resolve(service);
    await flushWorkspaceShellLazyLifecycleMicrotasks();

    expect(service.initialize).not.toHaveBeenCalled();
    expect(service.teardown).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it('tears down the loaded service when the host is torn down', async () => {
    const service = createWorkspaceShellLazyLifecycleSpecService();
    const host = createWorkspaceShellLazyLifecycleServiceHost({
      destroyed: () => false,
      initializeFailureMessage: 'initialize failed',
      loadService: vi.fn().mockResolvedValue(service),
      teardownFailureMessage: 'teardown failed',
      warn: vi.fn(),
    });

    host.initialize();
    await flushWorkspaceShellLazyLifecycleMicrotasks();
    host.teardown();

    expect(service.initialize).toHaveBeenCalledTimes(1);
    expect(service.teardown).toHaveBeenCalledTimes(1);
  });
});
