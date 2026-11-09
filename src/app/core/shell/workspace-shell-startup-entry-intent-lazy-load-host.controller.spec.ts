import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  WorkspaceShellStartupEntryIntentLazyLoadHostController,
  type WorkspaceShellStartupEntryIntentLazyLoadHostOptions,
} from './workspace-shell-startup-entry-intent-lazy-load-host.controller';

function createHost(
  overrides: Partial<WorkspaceShellStartupEntryIntentLazyLoadHostOptions> = {},
) {
  const controller = {
    flushWidgetWorkspaceGateRecheck: vi.fn(),
    resetPrimeState: vi.fn(),
    sync: vi.fn(),
  };
  const warn = vi.fn();
  const createStartupEntryIntentController = vi.fn()
    .mockResolvedValue(controller);
  const host = new WorkspaceShellStartupEntryIntentLazyLoadHostController({
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
    warn,
    createStartupEntryIntentController,
    ...overrides,
  });

  return {
    controller,
    createStartupEntryIntentController,
    host,
    warn,
  };
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
}

function readShellSource(fileName: string): string {
  try {
    return readFileSync(join(__dirname, fileName), 'utf8');
  } catch (error) {
    if (
      error instanceof Error
      && 'code' in error
      && error.code === 'ENOENT'
    ) {
      return '';
    }

    throw error;
  }
}

describe('WorkspaceShellStartupEntryIntentLazyLoadHostController', () => {
  it('keeps startup entry intent controller resolution behind the pending-action resolver', () => {
    const source = readShellSource(
      'workspace-shell-startup-entry-intent-lazy-load-host.controller.ts',
    );
    const resolverSource = readShellSource(
      'workspace-shell-startup-entry-intent-pending-action-resolver.controller.ts',
    );

    expect(source).toContain('WorkspaceShellStartupEntryIntentPendingActionResolverController');
    expect(source).not.toContain('createWorkspaceShellStartupEntryIntentControllerLoader');
    expect(source).not.toContain('createWorkspaceShellStartupEntryIntentHostController');
    expect(source).not.toContain("import('./workspace-shell-startup-entry-intent.controller')");
    expect(source).not.toContain('new WorkspaceShellStartupEntryIntentController');
    expect(resolverSource).toContain('createWorkspaceShellStartupEntryIntentControllerLoader');
  });

  it('keeps startup entry intent controller caching inside the pending-action resolver', () => {
    const source = readShellSource(
      'workspace-shell-startup-entry-intent-lazy-load-host.controller.ts',
    );
    const resolverSource = readShellSource(
      'workspace-shell-startup-entry-intent-pending-action-resolver.controller.ts',
    );

    expect(source).toContain('WorkspaceShellStartupEntryIntentPendingActionResolverController');
    expect(source).not.toContain('controllerPromise');
    expect(source).not.toContain('controllerInstance');
    expect(source).not.toContain('pendingActionResolutionPromise');
    expect(source).not.toContain('createControllerSafely');
    expect(resolverSource).toContain('controllerPromise');
    expect(resolverSource).toContain('controllerInstance');
    expect(resolverSource).toContain('pendingActionResolutionPromise');
  });

  it('delegates pending startup entry actions to the pending-actions controller', () => {
    const source = readShellSource(
      'workspace-shell-startup-entry-intent-lazy-load-host.controller.ts',
    );

    expect(source).toContain('createWorkspaceShellStartupEntryIntentPendingActionsController');
    expect(source).not.toContain('private pendingFlush');
    expect(source).not.toContain('private pendingSync');
    expect(source).not.toContain('flushPendingActions(');
  });

  it('loads the startup entry intent controller once and forwards pending actions', async () => {
    const { controller, createStartupEntryIntentController, host } = createHost();

    host.sync();
    host.flushWidgetWorkspaceGateRecheck();

    await vi.waitFor(() => expect(controller.sync).toHaveBeenCalledOnce());
    expect(createStartupEntryIntentController).toHaveBeenCalledOnce();
    expect(controller.flushWidgetWorkspaceGateRecheck).toHaveBeenCalledOnce();

    host.sync();

    await vi.waitFor(() => expect(controller.sync).toHaveBeenCalledTimes(2));
    expect(createStartupEntryIntentController).toHaveBeenCalledOnce();
  });

  it('captures startup intent signals synchronously before lazy controller loading', () => {
    const routeUrl = vi.fn(() => '/projects?entry=shortcut&intent=open-focus-tools');
    const currentStartupEntryIntent = vi.fn(() => ({
      entry: 'shortcut' as const,
      intent: 'open-focus-tools' as const,
      rawIntent: 'open-focus-tools',
      widgetGateEntryId: null,
    }));
    const deferredStartupEntryIntent = vi.fn(() => null);
    const currentUserId = vi.fn(() => 'user-1');
    const isApplicationReady = vi.fn(() => true);
    const createStartupEntryIntentController = vi.fn(() => new Promise<never>(() => {}));
    const { host } = createHost({
      createStartupEntryIntentController,
      currentStartupEntryIntent,
      currentUserId,
      deferredStartupEntryIntent,
      isApplicationReady,
      routeUrl,
    });

    host.sync();

    expect(routeUrl).toHaveBeenCalledOnce();
    expect(currentStartupEntryIntent).toHaveBeenCalledOnce();
    expect(deferredStartupEntryIntent).toHaveBeenCalledOnce();
    expect(isApplicationReady).toHaveBeenCalledOnce();
    expect(currentUserId).toHaveBeenCalledOnce();
    expect(createStartupEntryIntentController).toHaveBeenCalledOnce();
  });

  it('keeps pending actions retryable after the controller fails to load', async () => {
    const controller = {
      flushWidgetWorkspaceGateRecheck: vi.fn(),
      resetPrimeState: vi.fn(),
      sync: vi.fn(),
    };
    const loadError = new Error('startup intent import failed');
    const createStartupEntryIntentController = vi.fn()
      .mockRejectedValueOnce(loadError)
      .mockResolvedValueOnce(controller);
    const { host, warn } = createHost({ createStartupEntryIntentController });

    host.sync();

    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(
      'Startup entry intent controller 懒加载失败，已保留待处理动作',
      loadError,
    ));
    expect(controller.sync).not.toHaveBeenCalled();

    host.flushWidgetWorkspaceGateRecheck();

    await vi.waitFor(() => expect(controller.sync).toHaveBeenCalledOnce());
    expect(createStartupEntryIntentController).toHaveBeenCalledTimes(2);
    expect(controller.flushWidgetWorkspaceGateRecheck).toHaveBeenCalledOnce();
  });

  it('keeps pending actions retryable when the load-failure warning sink fails', async () => {
    const controller = {
      flushWidgetWorkspaceGateRecheck: vi.fn(),
      resetPrimeState: vi.fn(),
      sync: vi.fn(),
    };
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const loadError = new Error('startup intent import failed');
    const warn = vi.fn(() => {
      throw new Error('warning sink failed');
    });
    const createStartupEntryIntentController = vi.fn()
      .mockRejectedValueOnce(loadError)
      .mockResolvedValueOnce(controller);
    const { host } = createHost({ createStartupEntryIntentController, warn });

    try {
      host.sync();

      await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(
        'Startup entry intent controller 懒加载失败，已保留待处理动作',
        loadError,
      ));
      expect(controller.sync).not.toHaveBeenCalled();
      expect(consoleError).not.toHaveBeenCalled();

      host.flushWidgetWorkspaceGateRecheck();

      await vi.waitFor(() => expect(controller.sync).toHaveBeenCalledOnce());
      expect(createStartupEntryIntentController).toHaveBeenCalledTimes(2);
      expect(controller.flushWidgetWorkspaceGateRecheck).toHaveBeenCalledOnce();
    } finally {
      consoleError.mockRestore();
    }
  });

  it('keeps pending actions retryable after the controller factory throws synchronously', async () => {
    const controller = {
      flushWidgetWorkspaceGateRecheck: vi.fn(),
      resetPrimeState: vi.fn(),
      sync: vi.fn(),
    };
    const loadError = new Error('startup intent factory failed');
    const createStartupEntryIntentController = vi.fn()
      .mockImplementationOnce(() => {
        throw loadError;
      })
      .mockResolvedValueOnce(controller);
    const { host, warn } = createHost({ createStartupEntryIntentController });

    expect(() => host.sync()).not.toThrow();

    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(
      'Startup entry intent controller 懒加载失败，已保留待处理动作',
      loadError,
    ));
    expect(controller.sync).not.toHaveBeenCalled();

    host.flushWidgetWorkspaceGateRecheck();

    await vi.waitFor(() => expect(controller.sync).toHaveBeenCalledOnce());
    expect(createStartupEntryIntentController).toHaveBeenCalledTimes(2);
    expect(controller.flushWidgetWorkspaceGateRecheck).toHaveBeenCalledOnce();
  });

  it('keeps sync pending when dependency capture fails before controller resolution', async () => {
    const controller = {
      flushWidgetWorkspaceGateRecheck: vi.fn(),
      resetPrimeState: vi.fn(),
      sync: vi.fn(),
    };
    const dependencyError = new Error('route unavailable');
    let routeReady = false;
    const createStartupEntryIntentController = vi.fn()
      .mockResolvedValue(controller);
    const { host, warn } = createHost({
      createStartupEntryIntentController,
      routeUrl: () => {
        if (!routeReady) {
          throw dependencyError;
        }

        return '/projects/project-1/task/task-1?entry=widget&intent=open-workspace';
      },
    });

    expect(() => host.sync()).not.toThrow();

    expect(createStartupEntryIntentController).not.toHaveBeenCalled();
    expect(controller.sync).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      'Startup entry intent 依赖捕获失败，已保留待处理动作',
      dependencyError,
    );

    routeReady = true;
    host.sync();

    await vi.waitFor(() => expect(controller.sync).toHaveBeenCalledOnce());
    expect(createStartupEntryIntentController).toHaveBeenCalledOnce();
  });

  it('warns only once when multiple pending actions share one rejected controller load', async () => {
    const controller = {
      flushWidgetWorkspaceGateRecheck: vi.fn(),
      resetPrimeState: vi.fn(),
      sync: vi.fn(),
    };
    const loadError = new Error('startup intent import failed');
    const deferred = createDeferred<ReturnType<typeof createHost>['controller']>();
    const createStartupEntryIntentController = vi.fn()
      .mockReturnValueOnce(deferred.promise)
      .mockResolvedValueOnce(controller);
    const { host, warn } = createHost({ createStartupEntryIntentController });

    host.sync();
    host.flushWidgetWorkspaceGateRecheck();
    deferred.reject(loadError);

    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
    expect(warn).toHaveBeenCalledWith(
      'Startup entry intent controller 懒加载失败，已保留待处理动作',
      loadError,
    );

    host.sync();

    await vi.waitFor(() => expect(controller.sync).toHaveBeenCalledOnce());
    expect(createStartupEntryIntentController).toHaveBeenCalledTimes(2);
    expect(controller.flushWidgetWorkspaceGateRecheck).toHaveBeenCalledOnce();
  });

  it('keeps pending actions retryable after a loaded controller action fails', async () => {
    const actionError = new Error('startup intent sync failed');
    const controller = {
      flushWidgetWorkspaceGateRecheck: vi.fn(),
      resetPrimeState: vi.fn(),
      sync: vi.fn()
        .mockImplementationOnce(() => {
          throw actionError;
        })
        .mockImplementationOnce(() => undefined),
    };
    const createStartupEntryIntentController = vi.fn()
      .mockResolvedValue(controller);
    const { host, warn } = createHost({ createStartupEntryIntentController });

    host.sync();

    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(
      'Startup entry intent controller 待处理动作执行失败，已保留待处理动作',
      actionError,
    ));
    expect(warn).not.toHaveBeenCalledWith(
      'Startup entry intent controller 懒加载失败，已保留待处理动作',
      actionError,
    );

    host.flushWidgetWorkspaceGateRecheck();

    await vi.waitFor(() => expect(controller.sync).toHaveBeenCalledTimes(2));
    expect(createStartupEntryIntentController).toHaveBeenCalledOnce();
    expect(controller.flushWidgetWorkspaceGateRecheck).toHaveBeenCalledOnce();
  });

  it('keeps pending action failures from being reclassified when the warning sink fails', async () => {
    const actionError = new Error('startup intent sync failed');
    const warningSinkError = new Error('warning sink failed');
    const controller = {
      flushWidgetWorkspaceGateRecheck: vi.fn(),
      resetPrimeState: vi.fn(),
      sync: vi.fn()
        .mockImplementationOnce(() => {
          throw actionError;
        })
        .mockImplementationOnce(() => undefined),
    };
    const warn = vi.fn()
      .mockImplementationOnce(() => {
        throw warningSinkError;
      });
    const createStartupEntryIntentController = vi.fn()
      .mockResolvedValue(controller);
    const { host } = createHost({ createStartupEntryIntentController, warn });

    host.sync();

    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(
      'Startup entry intent controller 待处理动作执行失败，已保留待处理动作',
      actionError,
    ));
    expect(warn).not.toHaveBeenCalledWith(
      'Startup entry intent controller 懒加载失败，已保留待处理动作',
      warningSinkError,
    );

    host.flushWidgetWorkspaceGateRecheck();

    await vi.waitFor(() => expect(controller.sync).toHaveBeenCalledTimes(2));
    expect(createStartupEntryIntentController).toHaveBeenCalledOnce();
    expect(controller.flushWidgetWorkspaceGateRecheck).toHaveBeenCalledOnce();
  });

  it('drops pending actions when torn down before the controller resolves', async () => {
    let resolveController: (
      controller: ReturnType<typeof createHost>['controller'],
    ) => void = () => undefined;
    const pendingController = {
      flushWidgetWorkspaceGateRecheck: vi.fn(),
      resetPrimeState: vi.fn(),
      sync: vi.fn(),
    };
    const createStartupEntryIntentController = vi.fn()
      .mockReturnValue(new Promise(resolve => {
        resolveController = resolve;
      }));
    const { host } = createHost({ createStartupEntryIntentController });

    host.sync();
    host.flushWidgetWorkspaceGateRecheck();
    expect(typeof (host as { teardown?: () => void }).teardown).toBe('function');

    (host as { teardown: () => void }).teardown();
    resolveController(pendingController);
    await Promise.resolve();

    expect(pendingController.sync).not.toHaveBeenCalled();
    expect(pendingController.flushWidgetWorkspaceGateRecheck).not.toHaveBeenCalled();
  });

  it('tears down a loaded startup entry intent controller when the host tears down', async () => {
    const controller = {
      flushWidgetWorkspaceGateRecheck: vi.fn(),
      resetPrimeState: vi.fn(),
      sync: vi.fn(),
      teardown: vi.fn(),
    };
    const createStartupEntryIntentController = vi.fn()
      .mockResolvedValue(controller);
    const { host } = createHost({ createStartupEntryIntentController });

    host.sync();
    await vi.waitFor(() => expect(controller.sync).toHaveBeenCalledOnce());

    host.teardown();

    expect(controller.teardown).toHaveBeenCalledOnce();
  });

  it('resolves consumed startup navigation without loading the controller', () => {
    const { createStartupEntryIntentController, host } = createHost();

    expect(host.resolveConsumedStartupEntryNavigation()).toEqual([
      '/projects',
      'project-1',
      'task',
      'task-1',
    ]);
    expect(createStartupEntryIntentController).not.toHaveBeenCalled();
  });

  it('forwards resetPrimeState only after the controller is loaded', async () => {
    const { controller, host } = createHost();

    host.resetPrimeState();
    expect(controller.resetPrimeState).not.toHaveBeenCalled();

    host.sync();
    await Promise.resolve();
    host.resetPrimeState();

    expect(controller.resetPrimeState).toHaveBeenCalledOnce();
  });
});
