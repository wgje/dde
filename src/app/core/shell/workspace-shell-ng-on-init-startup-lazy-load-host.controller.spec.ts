import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  WorkspaceShellNgOnInitStartupLazyLoadHostController,
  type WorkspaceShellNgOnInitStartupHostDelegate,
} from './workspace-shell-ng-on-init-startup-lazy-load-host.controller';

function createDelegate(): WorkspaceShellNgOnInitStartupHostDelegate {
  return {
    initialize: vi.fn(),
    teardown: vi.fn(),
  };
}

function readNgOnInitStartupLazyLoadHostSource(): string {
  return readFileSync(
    join(__dirname, 'workspace-shell-ng-on-init-startup-lazy-load-host.controller.ts'),
    'utf8',
  );
}

function readNgOnInitStartupLazyHostSource(): string {
  try {
    return readFileSync(
      join(__dirname, 'workspace-shell-ng-on-init-startup-lazy-host.controller.ts'),
      'utf8',
    );
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

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
}

function createController(overrides: {
  createNgOnInitStartupController?: () => Promise<WorkspaceShellNgOnInitStartupHostDelegate>;
  warn?: (message: string, error: unknown) => void;
} = {}) {
  const delegate = createDelegate();
  const createNgOnInitStartupController = overrides.createNgOnInitStartupController
    ?? vi.fn().mockResolvedValue(delegate);
  const warn = overrides.warn ?? vi.fn();
  const controller = new WorkspaceShellNgOnInitStartupLazyLoadHostController({
    createNgOnInitStartupController,
    warn,
  });

  return { controller, createNgOnInitStartupController, delegate, warn };
}

async function flushMicrotasks(): Promise<void> {
  // 纯微任务多轮排空：轮次覆盖原生/zone-patched Promise 的最深链（thenable 采纳会放大跳数），
  // 不用宏任务 setTimeout —— 共享车道 CPU 饱和时宏任务可能 2s 内不被调度导致超时
  for (let flushRound = 0; flushRound < 25; flushRound += 1) {
    await Promise.resolve();
  }
}

describe('WorkspaceShellNgOnInitStartupLazyLoadHostController', () => {
  it('keeps concrete ngOnInit startup loading behind the named lazy host controller', () => {
    const lazyLoadHostSource = readNgOnInitStartupLazyLoadHostSource();
    const lazyHostSource = readNgOnInitStartupLazyHostSource();

    expect(lazyLoadHostSource).toContain('WorkspaceShellNgOnInitStartupLazyHostController');
    expect(lazyLoadHostSource).not.toContain('WorkspaceShellLazyDelegateCallHostController');
    expect(lazyLoadHostSource).not.toContain('workspace-shell-lazy-delegate-call-host.controller');
    expect(lazyLoadHostSource).not.toContain('createWorkspaceShellNgOnInitStartupControllerLoader');
    expect(lazyLoadHostSource).not.toContain("import('./workspace-shell-ng-on-init-startup.controller')");
    expect(lazyLoadHostSource).not.toContain('new WorkspaceShellNgOnInitStartupController');
    expect(lazyHostSource).toContain('WorkspaceShellLazyDelegateCallHostController');
    expect(lazyHostSource).toContain('createWorkspaceShellNgOnInitStartupControllerLoader');
  });

  it('delegates lazy caching to the shared delegate call host', () => {
    const source = readNgOnInitStartupLazyHostSource();

    expect(source).not.toContain('controllerPromise');
    expect(source).not.toContain('controllerInstance');
    expect(source).not.toContain('isTornDown');
  });

  it('keeps critical feature flag delegate creation inside the lazy host options chunk', () => {
    const source = readFileSync(
      join(__dirname, 'workspace-shell-ng-on-init-startup-host-options.factory.ts'),
      'utf8',
    );

    expect(source).toContain(
      "import('./workspace-shell-critical-feature-flags-delegates.factory')",
    );
  });

  it('keeps startup controller option wiring in the controller loader factory', () => {
    const loaderSource = readFileSync(
      join(__dirname, 'workspace-shell-ng-on-init-startup-controller-loader.factory.ts'),
      'utf8',
    );
    const hostSource = readFileSync(
      join(__dirname, 'workspace-shell-ng-on-init-startup-lazy-load-host.controller.ts'),
      'utf8',
    );

    expect(loaderSource).toContain('createWorkspaceShellNgOnInitStartupHostOptions');
    expect(hostSource).not.toContain('createWorkspaceShellNgOnInitStartupHostOptions');
    expect(hostSource).not.toContain('function createNgOnInitStartupHostOptions');
    expect(hostSource).not.toContain('function resolveCriticalFeatureFlags');
    expect(hostSource).not.toContain('function scheduleCancellableTimeout');
    expect(hostSource).not.toContain('FEATURE_FLAGS');
    expect(hostSource).not.toContain('IDLE_SCHEDULE_CONFIG');
  });

  it('loads the ngOnInit startup controller once and forwards initialize calls', async () => {
    const delegate = createDelegate();
    const createNgOnInitStartupController = vi.fn().mockResolvedValue(delegate);
    const { controller } = createController({ createNgOnInitStartupController });

    controller.initialize();
    controller.initialize();
    await flushMicrotasks();

    expect(createNgOnInitStartupController).toHaveBeenCalledTimes(1);
    expect(delegate.initialize).toHaveBeenCalledTimes(2);
  });

  it('warns and retries after the startup controller fails to load', async () => {
    const error = new Error('ngOnInit startup chunk missing');
    const delegate = createDelegate();
    const createNgOnInitStartupController = vi.fn()
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce(delegate);
    const { controller, warn } = createController({ createNgOnInitStartupController });

    controller.initialize();
    await flushMicrotasks();
    controller.initialize();
    await flushMicrotasks();

    expect(createNgOnInitStartupController).toHaveBeenCalledTimes(2);
    expect(delegate.initialize).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('ngOnInit startup controller 懒加载失败，已跳过本次启动编排', error);
  });

  it('warns with the initialize failure message when a loaded startup controller initialize call fails', async () => {
    const error = new Error('ngOnInit startup initialize failed');
    const delegate: WorkspaceShellNgOnInitStartupHostDelegate = {
      initialize: vi.fn(() => {
        throw error;
      }),
      teardown: vi.fn(),
    };
    const createNgOnInitStartupController = vi.fn().mockResolvedValue(delegate);
    const { controller, warn } = createController({ createNgOnInitStartupController });

    controller.initialize();
    await flushMicrotasks();

    expect(delegate.initialize).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      'ngOnInit startup controller 初始化失败，已跳过本次启动编排',
      error,
    );
    expect(warn).not.toHaveBeenCalledWith(
      'ngOnInit startup controller 懒加载失败，已跳过本次启动编排',
      error,
    );
  });

  it('warns with the teardown failure message when a loaded startup controller teardown call fails', async () => {
    const error = new Error('ngOnInit startup teardown failed');
    const delegate: WorkspaceShellNgOnInitStartupHostDelegate = {
      initialize: vi.fn(),
      teardown: vi.fn(() => {
        throw error;
      }),
    };
    const createNgOnInitStartupController = vi.fn().mockResolvedValue(delegate);
    const { controller, warn } = createController({ createNgOnInitStartupController });

    controller.initialize();
    await flushMicrotasks();
    controller.teardown();

    expect(delegate.teardown).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      'ngOnInit startup controller 清理失败，已跳过',
      error,
    );
    expect(warn).not.toHaveBeenCalledWith(
      'ngOnInit startup controller 懒加载失败，已跳过本次启动编排',
      error,
    );
  });

  it('does not initialize a pending startup controller after teardown', async () => {
    const delegate = createDelegate();
    const deferred = createDeferred<WorkspaceShellNgOnInitStartupHostDelegate>();
    const { controller } = createController({
      createNgOnInitStartupController: vi.fn(() => deferred.promise),
    });

    controller.initialize();
    controller.teardown();
    deferred.resolve(delegate);
    await flushMicrotasks();

    expect(delegate.initialize).not.toHaveBeenCalled();
    expect(delegate.teardown).toHaveBeenCalledTimes(1);
  });
});
