import { describe, expect, it, vi } from 'vitest';

import {
  WorkspaceShellLazyLifecycleServiceController,
} from './workspace-shell-lazy-lifecycle-service.controller';
import {
  createWorkspaceShellLazyLifecycleDeferred,
  createWorkspaceShellLazyLifecycleSpecMember,
  flushWorkspaceShellLazyLifecycleMicrotasks,
} from './workspace-shell-lazy-lifecycle.spec-helpers';

describe('WorkspaceShellLazyLifecycleServiceController', () => {
  it('loads and initializes a lazy lifecycle service through the shared service host', async () => {
    const service = createWorkspaceShellLazyLifecycleSpecMember();
    const loadService = vi.fn().mockResolvedValue(service);
    const controller = new WorkspaceShellLazyLifecycleServiceController({
      destroyed: () => false,
      initializeFailureMessage: 'service initialize failed',
      loadService,
      teardownFailureMessage: 'service teardown failed',
      warn: vi.fn(),
    });

    controller.initialize();
    await flushWorkspaceShellLazyLifecycleMicrotasks();

    expect(loadService).toHaveBeenCalledTimes(1);
    expect(service.initialize).toHaveBeenCalledTimes(1);
  });

  it('tears down the resolved service instead of initializing when destroyed before load settles', async () => {
    let destroyed = false;
    const service = createWorkspaceShellLazyLifecycleSpecMember();
    const deferred = createWorkspaceShellLazyLifecycleDeferred<typeof service>();
    const controller = new WorkspaceShellLazyLifecycleServiceController({
      destroyed: () => destroyed,
      initializeFailureMessage: 'service initialize failed',
      loadService: vi.fn(() => deferred.promise),
      teardownFailureMessage: 'service teardown failed',
      warn: vi.fn(),
    });

    controller.initialize();
    destroyed = true;
    deferred.resolve(service);
    await flushWorkspaceShellLazyLifecycleMicrotasks();

    expect(service.initialize).not.toHaveBeenCalled();
    expect(service.teardown).toHaveBeenCalledTimes(1);
  });

  it('classifies destroyed-before-load cleanup failures as teardown failures', async () => {
    let destroyed = false;
    const cleanupError = new Error('keyboard shortcut cleanup failed');
    const service = createWorkspaceShellLazyLifecycleSpecMember();
    vi.mocked(service.teardown).mockImplementation(() => {
      throw cleanupError;
    });
    const deferred = createWorkspaceShellLazyLifecycleDeferred<typeof service>();
    const warn = vi.fn();
    const controller = new WorkspaceShellLazyLifecycleServiceController({
      destroyed: () => destroyed,
      initializeFailureMessage: 'service initialize failed',
      loadService: vi.fn(() => deferred.promise),
      teardownFailureMessage: 'service teardown failed',
      warn,
    });

    controller.initialize();
    destroyed = true;
    deferred.resolve(service);
    await flushWorkspaceShellLazyLifecycleMicrotasks();

    expect(service.initialize).not.toHaveBeenCalled();
    expect(service.teardown).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('service teardown failed', cleanupError);
    expect(warn).not.toHaveBeenCalledWith('service initialize failed', cleanupError);
  });
});
