import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  WorkspaceShellStartupBreadcrumbController,
  type WorkspaceShellStartupBreadcrumbLike,
} from './workspace-shell-startup-breadcrumb.controller';
import {
  createWorkspaceShellLazyLifecycleDeferred,
  createWorkspaceShellLazyLifecycleSpecMember,
  flushWorkspaceShellLazyLifecycleMicrotasks,
} from './workspace-shell-lazy-lifecycle.spec-helpers';

function createController(overrides: {
  destroyed?: () => boolean;
  loadStartupBreadcrumb?: () => Promise<WorkspaceShellStartupBreadcrumbLike>;
  warn?: (message: string, error: unknown) => void;
} = {}) {
  const service = createWorkspaceShellLazyLifecycleSpecMember();
  const warn = overrides.warn ?? vi.fn();
  const loadStartupBreadcrumb = overrides.loadStartupBreadcrumb
    ?? vi.fn().mockResolvedValue(service as WorkspaceShellStartupBreadcrumbLike);
  const controller = new WorkspaceShellStartupBreadcrumbController({
    destroyed: overrides.destroyed ?? (() => false),
    loadStartupBreadcrumb,
    warn,
  });

  return { controller, loadStartupBreadcrumb, service, warn };
}

describe('WorkspaceShellStartupBreadcrumbController', () => {
  it('delegates lazy lifecycle caching to the shared service controller', () => {
    const source = readFileSync(
      join(__dirname, 'workspace-shell-startup-breadcrumb.controller.ts'),
      'utf8',
    );

    expect(source).toContain('WorkspaceShellLazyLifecycleServiceController');
    expect(source).not.toContain('WorkspaceShellLazyLifecycleHostController');
    expect(source).not.toContain('createWorkspaceShellLazyLifecycleServiceHost');
    expect(source).not.toContain('new WorkspaceShellLazyLifecycleHostController');
    expect(source).not.toContain('breadcrumbPromise');
    expect(source).not.toContain('breadcrumbInstance');
    expect(source).not.toContain('initializePromise');
    expect(source).not.toContain('createLifecycleDelegate');
  });

  it('delegates startup breadcrumb service loading out of the controller', () => {
    const source = readFileSync(
      join(__dirname, 'workspace-shell-startup-breadcrumb.controller.ts'),
      'utf8',
    );

    expect(source).toContain('createWorkspaceShellStartupBreadcrumbServiceLoader');
    expect(source).not.toContain("import('../../../services/startup-breadcrumb.service')");
    expect(source).not.toContain('injector.get(StartupBreadcrumbService)');
  });

  it('loads and initializes the service only once while initialization is in flight', async () => {
    const service = createWorkspaceShellLazyLifecycleSpecMember();
    const deferred =
      createWorkspaceShellLazyLifecycleDeferred<WorkspaceShellStartupBreadcrumbLike>();
    const { controller, loadStartupBreadcrumb } = createController({
      loadStartupBreadcrumb: vi.fn(() => deferred.promise),
    });

    controller.initialize();
    controller.initialize();

    expect(loadStartupBreadcrumb).toHaveBeenCalledTimes(1);
    deferred.resolve(service);
    await deferred.promise;
    await flushWorkspaceShellLazyLifecycleMicrotasks();

    expect(service.initialize).toHaveBeenCalledTimes(1);
  });

  it('tears down the service instead of initializing when the shell is destroyed before load resolves', async () => {
    let destroyed = false;
    const service = createWorkspaceShellLazyLifecycleSpecMember();
    const deferred =
      createWorkspaceShellLazyLifecycleDeferred<WorkspaceShellStartupBreadcrumbLike>();
    const { controller } = createController({
      destroyed: () => destroyed,
      loadStartupBreadcrumb: vi.fn(() => deferred.promise),
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
    const { controller, loadStartupBreadcrumb, warn } = createController({
      loadStartupBreadcrumb: vi.fn()
        .mockImplementationOnce(() => Promise.resolve().then(() => {
          throw error;
        }))
        .mockResolvedValueOnce(service),
    });

    controller.initialize();
    await flushWorkspaceShellLazyLifecycleMicrotasks();
    controller.initialize();
    await flushWorkspaceShellLazyLifecycleMicrotasks();

    expect(loadStartupBreadcrumb).toHaveBeenCalledTimes(2);
    expect(service.initialize).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('启动 breadcrumb 服务懒加载失败，已跳过', error);
  });
});
