import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  WorkspaceShellSwUpdateLifecycleController,
  type WorkspaceShellSwUpdateLifecycleLike,
} from './workspace-shell-sw-update-lifecycle.controller';
import {
  createWorkspaceShellLazyLifecycleDeferred,
  createWorkspaceShellLazyLifecycleSpecMember,
  flushWorkspaceShellLazyLifecycleMicrotasks,
} from './workspace-shell-lazy-lifecycle.spec-helpers';

function createController(overrides: {
  destroyed?: () => boolean;
  loadSwUpdateLifecycle?: () => Promise<WorkspaceShellSwUpdateLifecycleLike>;
  warn?: (message: string, error: unknown) => void;
} = {}) {
  const service = createWorkspaceShellLazyLifecycleSpecMember();
  const warn = overrides.warn ?? vi.fn();
  const loadSwUpdateLifecycle = overrides.loadSwUpdateLifecycle
    ?? vi.fn().mockResolvedValue(service as WorkspaceShellSwUpdateLifecycleLike);
  const controller = new WorkspaceShellSwUpdateLifecycleController({
    destroyed: overrides.destroyed ?? (() => false),
    loadSwUpdateLifecycle,
    warn,
  });

  return { controller, loadSwUpdateLifecycle, service, warn };
}

describe('WorkspaceShellSwUpdateLifecycleController', () => {
  it('delegates lazy lifecycle caching to the shared service controller', () => {
    const source = readFileSync(
      join(__dirname, 'workspace-shell-sw-update-lifecycle.controller.ts'),
      'utf8',
    );

    expect(source).toContain('WorkspaceShellLazyLifecycleServiceController');
    expect(source).not.toContain('WorkspaceShellLazyLifecycleHostController');
    expect(source).not.toContain('createWorkspaceShellLazyLifecycleServiceHost');
    expect(source).not.toContain('lifecyclePromise');
    expect(source).not.toContain('lifecycleInstance');
    expect(source).not.toContain('initializePromise');
  });

  it('loads and initializes the service only once while initialization is in flight', async () => {
    const service = createWorkspaceShellLazyLifecycleSpecMember();
    const deferred =
      createWorkspaceShellLazyLifecycleDeferred<WorkspaceShellSwUpdateLifecycleLike>();
    const { controller, loadSwUpdateLifecycle } = createController({
      loadSwUpdateLifecycle: vi.fn(() => deferred.promise),
    });

    controller.initialize();
    controller.initialize();

    expect(loadSwUpdateLifecycle).toHaveBeenCalledTimes(1);
    deferred.resolve(service);
    await deferred.promise;
    await flushWorkspaceShellLazyLifecycleMicrotasks();

    expect(service.initialize).toHaveBeenCalledTimes(1);
  });

  it('tears down the service instead of initializing when the shell is destroyed before load resolves', async () => {
    let destroyed = false;
    const service = createWorkspaceShellLazyLifecycleSpecMember();
    const deferred =
      createWorkspaceShellLazyLifecycleDeferred<WorkspaceShellSwUpdateLifecycleLike>();
    const { controller } = createController({
      destroyed: () => destroyed,
      loadSwUpdateLifecycle: vi.fn(() => deferred.promise),
    });

    controller.initialize();
    destroyed = true;
    deferred.resolve(service);
    await deferred.promise;
    await flushWorkspaceShellLazyLifecycleMicrotasks();

    expect(service.initialize).not.toHaveBeenCalled();
    expect(service.teardown).toHaveBeenCalledTimes(1);
  });

  it('tears down an already loaded service immediately', async () => {
    const { controller, service } = createController();

    controller.initialize();
    await flushWorkspaceShellLazyLifecycleMicrotasks();
    controller.teardown();

    expect(service.initialize).toHaveBeenCalledTimes(1);
    expect(service.teardown).toHaveBeenCalledTimes(1);
  });

  it('warns and allows retrying after the service load fails', async () => {
    const error = { message: 'chunk unavailable' };
    const service = createWorkspaceShellLazyLifecycleSpecMember();
    const { controller, loadSwUpdateLifecycle, warn } = createController({
      loadSwUpdateLifecycle: vi.fn()
        .mockImplementationOnce(() => Promise.resolve().then(() => {
          throw error;
        }))
        .mockResolvedValueOnce(service),
    });

    controller.initialize();
    await flushWorkspaceShellLazyLifecycleMicrotasks();
    controller.initialize();
    await flushWorkspaceShellLazyLifecycleMicrotasks();

    expect(loadSwUpdateLifecycle).toHaveBeenCalledTimes(2);
    expect(service.initialize).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('Service Worker 更新生命周期懒加载失败，已跳过', error);
  });
});
