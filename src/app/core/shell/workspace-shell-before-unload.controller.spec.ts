import { describe, expect, it, vi } from 'vitest';

import { WorkspaceShellBeforeUnloadController } from './workspace-shell-before-unload.controller';

function createController(
  options: {
    browser?: boolean;
    onFlushError?: (step: string, error: unknown) => void;
    registerError?: Error;
  } = {},
) {
  let registeredCallback: (() => boolean) | null = null;
  const beforeUnloadManager = {
    initialize: vi.fn(),
    register: vi.fn((_id: string, callback: () => boolean, _priority: number) => {
      if (options.registerError) {
        throw options.registerError;
      }
      registeredCallback = callback;
    }),
    unregister: vi.fn(),
  };
  const beforeUnloadGuard = {
    enable: vi.fn(),
    disable: vi.fn(),
  };
  const flushPendingPersist = vi.fn();
  const flushPendingAction = vi.fn();
  const flushRetryQueueSync = vi.fn();
  const saveQueueToStorage = vi.fn();
  const saveDeadLetterToStorage = vi.fn();
  const controller = new WorkspaceShellBeforeUnloadController({
    isBrowser: () => options.browser ?? true,
    beforeUnloadManager,
    beforeUnloadGuard,
    flushPendingPersist,
    flushPendingAction,
    flushRetryQueueSync,
    saveQueueToStorage,
    saveDeadLetterToStorage,
    onFlushError: options.onFlushError,
  });

  return {
    beforeUnloadGuard,
    beforeUnloadManager,
    controller,
    flushPendingAction,
    flushPendingPersist,
    flushRetryQueueSync,
    registeredCallback: () => registeredCallback,
    saveDeadLetterToStorage,
    saveQueueToStorage,
  };
}

describe('WorkspaceShellBeforeUnloadController', () => {
  it('registers the app-core-save beforeunload callback in browser environments', () => {
    const { beforeUnloadGuard, beforeUnloadManager, controller } = createController();

    controller.setup();

    expect(beforeUnloadManager.initialize).toHaveBeenCalledTimes(1);
    expect(beforeUnloadGuard.enable).toHaveBeenCalledTimes(1);
    expect(beforeUnloadManager.register).toHaveBeenCalledWith(
      'app-core-save',
      expect.any(Function),
      1,
    );
  });

  it('keeps setup idempotent when lifecycle initialization runs more than once', () => {
    const { beforeUnloadGuard, beforeUnloadManager, controller } = createController();

    controller.setup();
    controller.setup();

    expect(beforeUnloadManager.initialize).toHaveBeenCalledTimes(1);
    expect(beforeUnloadGuard.enable).toHaveBeenCalledTimes(1);
    expect(beforeUnloadManager.register).toHaveBeenCalledTimes(1);
  });

  it('flushes all pending workspace persistence before unload', () => {
    const {
      controller,
      flushPendingAction,
      flushPendingPersist,
      flushRetryQueueSync,
      registeredCallback,
      saveDeadLetterToStorage,
      saveQueueToStorage,
    } = createController();

    controller.setup();
    const result = registeredCallback()?.();

    expect(result).toBe(false);
    expect(flushPendingPersist).toHaveBeenCalledTimes(1);
    expect(flushPendingAction).toHaveBeenCalledTimes(1);
    expect(flushRetryQueueSync).toHaveBeenCalledTimes(1);
    expect(saveQueueToStorage).toHaveBeenCalledTimes(1);
    expect(saveDeadLetterToStorage).toHaveBeenCalledTimes(1);
  });

  it('continues flushing durable queues when an earlier flush step throws', () => {
    const {
      controller,
      flushPendingAction,
      flushPendingPersist,
      flushRetryQueueSync,
      registeredCallback,
      saveDeadLetterToStorage,
      saveQueueToStorage,
    } = createController();
    flushPendingAction.mockImplementation(() => {
      throw new Error('pending action flush failed');
    });

    controller.setup();

    expect(() => registeredCallback()?.()).not.toThrow();
    expect(flushPendingPersist).toHaveBeenCalledTimes(1);
    expect(flushPendingAction).toHaveBeenCalledTimes(1);
    expect(flushRetryQueueSync).toHaveBeenCalledTimes(1);
    expect(saveQueueToStorage).toHaveBeenCalledTimes(1);
    expect(saveDeadLetterToStorage).toHaveBeenCalledTimes(1);
  });

  it('continues flushing when the diagnostic flush error handler throws', () => {
    const flushError = new Error('pending action flush failed');
    const diagnosticError = new Error('diagnostic sink failed');
    const onFlushError = vi.fn(() => {
      throw diagnosticError;
    });
    const {
      controller,
      flushPendingAction,
      flushPendingPersist,
      flushRetryQueueSync,
      registeredCallback,
      saveDeadLetterToStorage,
      saveQueueToStorage,
    } = createController({ onFlushError });
    flushPendingAction.mockImplementation(() => {
      throw flushError;
    });

    controller.setup();

    expect(() => registeredCallback()?.()).not.toThrow();
    expect(onFlushError).toHaveBeenCalledWith('pending-action', flushError);
    expect(flushPendingPersist).toHaveBeenCalledTimes(1);
    expect(flushPendingAction).toHaveBeenCalledTimes(1);
    expect(flushRetryQueueSync).toHaveBeenCalledTimes(1);
    expect(saveQueueToStorage).toHaveBeenCalledTimes(1);
    expect(saveDeadLetterToStorage).toHaveBeenCalledTimes(1);
  });

  it('skips registration outside browser environments', () => {
    const { beforeUnloadGuard, beforeUnloadManager, controller } = createController({ browser: false });

    controller.setup();

    expect(beforeUnloadManager.initialize).not.toHaveBeenCalled();
    expect(beforeUnloadGuard.enable).not.toHaveBeenCalled();
    expect(beforeUnloadManager.register).not.toHaveBeenCalled();
  });

  it('rolls back the enabled guard when beforeunload registration throws', () => {
    const registerError = new Error('beforeunload register failed');
    const {
      beforeUnloadGuard,
      beforeUnloadManager,
      controller,
      registeredCallback,
    } = createController({ registerError });

    expect(() => controller.setup()).toThrow('beforeunload register failed');

    expect(beforeUnloadManager.initialize).toHaveBeenCalledTimes(1);
    expect(beforeUnloadGuard.enable).toHaveBeenCalledTimes(1);
    expect(beforeUnloadManager.register).toHaveBeenCalledTimes(1);
    expect(beforeUnloadManager.unregister).toHaveBeenCalledWith('app-core-save');
    expect(beforeUnloadGuard.disable).toHaveBeenCalledTimes(1);
    expect(registeredCallback()).toBeNull();
  });

  it('skips cleanup side effects when setup never completed', () => {
    const { beforeUnloadGuard, beforeUnloadManager, controller } = createController();

    controller.cleanup();

    expect(beforeUnloadManager.unregister).not.toHaveBeenCalled();
    expect(beforeUnloadGuard.disable).not.toHaveBeenCalled();
  });

  it('does not repeat rollback cleanup after setup registration fails', () => {
    const registerError = new Error('beforeunload register failed');
    const { beforeUnloadGuard, beforeUnloadManager, controller } = createController({ registerError });

    expect(() => controller.setup()).toThrow('beforeunload register failed');
    controller.cleanup();

    expect(beforeUnloadManager.unregister).toHaveBeenCalledTimes(1);
    expect(beforeUnloadManager.unregister).toHaveBeenCalledWith('app-core-save');
    expect(beforeUnloadGuard.disable).toHaveBeenCalledTimes(1);
  });

  it('unregisters the beforeunload callback and disables the guard during cleanup after setup', () => {
    const { beforeUnloadGuard, beforeUnloadManager, controller } = createController();

    controller.setup();
    controller.cleanup();

    expect(beforeUnloadManager.unregister).toHaveBeenCalledWith('app-core-save');
    expect(beforeUnloadGuard.disable).toHaveBeenCalledTimes(1);
  });

  it('disables the guard when unregister throws during cleanup', () => {
    const { beforeUnloadGuard, beforeUnloadManager, controller } = createController();
    const unregisterError = new Error('beforeunload unregister failed');
    beforeUnloadManager.unregister.mockImplementationOnce(() => {
      throw unregisterError;
    });

    controller.setup();

    expect(() => controller.cleanup()).not.toThrow();

    expect(beforeUnloadManager.unregister).toHaveBeenCalledWith('app-core-save');
    expect(beforeUnloadGuard.disable).toHaveBeenCalledTimes(1);
  });
});
