import { describe, expect, it, vi } from 'vitest';

import {
  WorkspaceShellLazyLifecycleHostController,
  type WorkspaceShellLazyLifecycleDelegate,
} from './workspace-shell-lazy-lifecycle-host.controller';
import {
  createWorkspaceShellLazyLifecycleSpecMember,
  createWorkspaceShellLazyLifecycleDeferred,
  flushWorkspaceShellLazyLifecycleMicrotasks,
} from './workspace-shell-lazy-lifecycle.spec-helpers';

describe('WorkspaceShellLazyLifecycleHostController', () => {
  it('loads and initializes the lifecycle delegate on demand', async () => {
    const delegate = createWorkspaceShellLazyLifecycleSpecMember();
    const createController = vi.fn().mockResolvedValue(delegate);
    const controller = new WorkspaceShellLazyLifecycleHostController({
      createController,
      initializeFailureMessage: 'initialize failed',
      teardownFailureMessage: 'teardown failed',
      warn: vi.fn(),
    });

    controller.initialize();
    await flushWorkspaceShellLazyLifecycleMicrotasks();

    expect(createController).toHaveBeenCalledTimes(1);
    expect(delegate.initialize).toHaveBeenCalledTimes(1);
  });

  it('reuses a pending delegate load while initialize is already in flight', async () => {
    const delegate = createWorkspaceShellLazyLifecycleSpecMember();
    let resolveDelegate: (delegate: WorkspaceShellLazyLifecycleDelegate) => void = () => undefined;
    const createController = vi.fn().mockImplementation(() => new Promise(resolve => {
      resolveDelegate = resolve;
    }));
    const controller = new WorkspaceShellLazyLifecycleHostController({
      createController,
      initializeFailureMessage: 'initialize failed',
      initializeMode: 'latest-only',
      teardownFailureMessage: 'teardown failed',
      warn: vi.fn(),
    });

    controller.initialize();
    controller.initialize();

    expect(createController).toHaveBeenCalledTimes(1);
    resolveDelegate(delegate);
    await flushWorkspaceShellLazyLifecycleMicrotasks();

    expect(delegate.initialize).toHaveBeenCalledTimes(1);
  });

  it('allows initialize retry after the delegate chunk fails to load', async () => {
    const error = new Error('first load failed');
    const delegate = createWorkspaceShellLazyLifecycleSpecMember();
    const warn = vi.fn();
    const createController = vi.fn()
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce(delegate);
    const controller = new WorkspaceShellLazyLifecycleHostController({
      createController,
      initializeFailureMessage: 'initialize failed',
      teardownFailureMessage: 'teardown failed',
      warn,
    });

    controller.initialize();
    await flushWorkspaceShellLazyLifecycleMicrotasks();
    controller.initialize();
    await flushWorkspaceShellLazyLifecycleMicrotasks();

    expect(createController).toHaveBeenCalledTimes(2);
    expect(delegate.initialize).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('initialize failed', error);
  });

  it('allows initialize retry after the delegate factory throws synchronously', async () => {
    const error = new Error('delegate factory threw');
    const delegate = createWorkspaceShellLazyLifecycleSpecMember();
    const warn = vi.fn();
    const createController = vi.fn()
      .mockImplementationOnce(() => {
        throw error;
      })
      .mockResolvedValueOnce(delegate);
    const controller = new WorkspaceShellLazyLifecycleHostController({
      createController,
      initializeFailureMessage: 'initialize failed',
      teardownFailureMessage: 'teardown failed',
      warn,
    });

    expect(() => controller.initialize()).not.toThrow();
    await flushWorkspaceShellLazyLifecycleMicrotasks();
    controller.initialize();
    await flushWorkspaceShellLazyLifecycleMicrotasks();

    expect(createController).toHaveBeenCalledTimes(2);
    expect(delegate.initialize).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('initialize failed', error);
  });

  it('warns and allows retry when a delegate initialize rejects asynchronously', async () => {
    const initializeError = new Error('delegate initialize rejected');
    const firstDelegate = createWorkspaceShellLazyLifecycleSpecMember();
    const nextDelegate = createWorkspaceShellLazyLifecycleSpecMember();
    vi.mocked(firstDelegate.initialize).mockImplementation(() =>
      Promise.reject(initializeError),
    );
    const warn = vi.fn();
    const createController = vi.fn()
      .mockResolvedValueOnce(firstDelegate)
      .mockResolvedValueOnce(nextDelegate);
    const controller = new WorkspaceShellLazyLifecycleHostController({
      createController,
      initializeFailureMessage: 'initialize failed',
      teardownFailureMessage: 'teardown failed',
      warn,
    });

    controller.initialize();
    await flushWorkspaceShellLazyLifecycleMicrotasks();
    controller.teardown();
    controller.initialize();
    await flushWorkspaceShellLazyLifecycleMicrotasks();

    expect(warn).toHaveBeenCalledWith('initialize failed', initializeError);
    expect(firstDelegate.teardown).toHaveBeenCalledTimes(1);
    expect(nextDelegate.initialize).toHaveBeenCalledTimes(1);
  });

  it('tears down a delegate that resolves after teardown was requested', async () => {
    const delegate = createWorkspaceShellLazyLifecycleSpecMember();
    let resolveDelegate: (delegate: WorkspaceShellLazyLifecycleDelegate) => void = () => undefined;
    const createController = vi.fn().mockImplementation(() => new Promise(resolve => {
      resolveDelegate = resolve;
    }));
    const controller = new WorkspaceShellLazyLifecycleHostController({
      createController,
      initializeFailureMessage: 'initialize failed',
      teardownFailureMessage: 'teardown failed',
      warn: vi.fn(),
    });

    controller.initialize();
    controller.teardown();
    resolveDelegate(delegate);
    await flushWorkspaceShellLazyLifecycleMicrotasks();

    expect(delegate.initialize).not.toHaveBeenCalled();
    expect(delegate.teardown).toHaveBeenCalledTimes(1);
  });

  it('warns only once when a pending delegate load rejects after teardown', async () => {
    const error = new Error('delegate load failed after teardown');
    const deferred = createWorkspaceShellLazyLifecycleDeferred<WorkspaceShellLazyLifecycleDelegate>();
    const warn = vi.fn();
    const controller = new WorkspaceShellLazyLifecycleHostController({
      createController: vi.fn(() => deferred.promise),
      initializeFailureMessage: 'initialize failed',
      teardownFailureMessage: 'teardown failed',
      warn,
    });

    controller.initialize();
    controller.teardown();
    deferred.reject(error);
    await flushWorkspaceShellLazyLifecycleMicrotasks();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('teardown failed', error);
    expect(warn).not.toHaveBeenCalledWith('initialize failed', error);
  });

  it('does not reuse a pending delegate load after teardown when initialized again', async () => {
    const staleDelegate = createWorkspaceShellLazyLifecycleSpecMember();
    const nextDelegate = createWorkspaceShellLazyLifecycleSpecMember();
    const resolvers: Array<(delegate: WorkspaceShellLazyLifecycleDelegate) => void> = [];
    const createController = vi.fn().mockImplementation(() => new Promise(resolve => {
      resolvers.push(resolve);
    }));
    const controller = new WorkspaceShellLazyLifecycleHostController({
      createController,
      initializeFailureMessage: 'initialize failed',
      teardownFailureMessage: 'teardown failed',
      warn: vi.fn(),
    });

    controller.initialize();
    controller.teardown();
    controller.initialize();
    resolvers[0]?.(staleDelegate);
    resolvers[1]?.(nextDelegate);
    await flushWorkspaceShellLazyLifecycleMicrotasks();

    expect(createController).toHaveBeenCalledTimes(2);
    expect(staleDelegate.initialize).not.toHaveBeenCalled();
    expect(staleDelegate.teardown).toHaveBeenCalledTimes(1);
    expect(nextDelegate.initialize).toHaveBeenCalledTimes(1);
    expect(nextDelegate.teardown).not.toHaveBeenCalled();
  });

  it('does not reuse a resolved delegate after teardown when initialized again', async () => {
    const staleDelegate = createWorkspaceShellLazyLifecycleSpecMember();
    const nextDelegate = createWorkspaceShellLazyLifecycleSpecMember();
    const createController = vi.fn()
      .mockResolvedValueOnce(staleDelegate)
      .mockResolvedValueOnce(nextDelegate);
    const controller = new WorkspaceShellLazyLifecycleHostController({
      createController,
      initializeFailureMessage: 'initialize failed',
      teardownFailureMessage: 'teardown failed',
      warn: vi.fn(),
    });

    controller.initialize();
    await flushWorkspaceShellLazyLifecycleMicrotasks();
    controller.teardown();
    controller.initialize();
    await flushWorkspaceShellLazyLifecycleMicrotasks();

    expect(createController).toHaveBeenCalledTimes(2);
    expect(staleDelegate.initialize).toHaveBeenCalledTimes(1);
    expect(staleDelegate.teardown).toHaveBeenCalledTimes(1);
    expect(nextDelegate.initialize).toHaveBeenCalledTimes(1);
    expect(nextDelegate.teardown).not.toHaveBeenCalled();
  });

  it('does not throw when warning a loaded delegate teardown failure also fails', async () => {
    const teardownError = new Error('delegate teardown failed');
    const warningError = new Error('warning sink failed');
    const delegate = createWorkspaceShellLazyLifecycleSpecMember();
    vi.mocked(delegate.teardown).mockImplementation(() => {
      throw teardownError;
    });
    const warn = vi.fn(() => {
      throw warningError;
    });
    const controller = new WorkspaceShellLazyLifecycleHostController({
      createController: vi.fn().mockResolvedValue(delegate),
      initializeFailureMessage: 'initialize failed',
      teardownFailureMessage: 'teardown failed',
      warn,
    });

    controller.initialize();
    await flushWorkspaceShellLazyLifecycleMicrotasks();

    expect(() => controller.teardown()).not.toThrow();
    expect(delegate.teardown).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('teardown failed', teardownError);
  });

  it('warns when a loaded delegate teardown rejects asynchronously', async () => {
    const teardownError = new Error('delegate teardown rejected');
    const delegate = createWorkspaceShellLazyLifecycleSpecMember();
    vi.mocked(delegate.teardown).mockImplementation(() => Promise.reject(teardownError));
    const warn = vi.fn();
    const controller = new WorkspaceShellLazyLifecycleHostController({
      createController: vi.fn().mockResolvedValue(delegate),
      initializeFailureMessage: 'initialize failed',
      teardownFailureMessage: 'teardown failed',
      warn,
    });

    controller.initialize();
    await flushWorkspaceShellLazyLifecycleMicrotasks();
    controller.teardown();
    await flushWorkspaceShellLazyLifecycleMicrotasks();

    expect(delegate.teardown).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('teardown failed', teardownError);
  });
});
