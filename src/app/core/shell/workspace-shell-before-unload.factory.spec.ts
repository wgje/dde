import { describe, expect, it, vi } from 'vitest';

import { createWorkspaceShellBeforeUnloadController } from './workspace-shell-before-unload.factory';

function createController(
  options: {
    browser?: boolean;
    onFlushError?: (step: string, error: unknown) => void;
  } = {},
) {
  let registeredCallback: (() => boolean) | null = null;
  const beforeUnloadManager = {
    initialize: vi.fn(),
    register: vi.fn((_id: string, callback: () => boolean, _priority: number) => {
      registeredCallback = callback;
    }),
    unregister: vi.fn(),
  };
  const beforeUnloadGuard = {
    enable: vi.fn(),
    disable: vi.fn(),
  };
  const syncCoordinator = { flushPendingPersist: vi.fn() };
  const undoService = { flushPendingAction: vi.fn() };
  const simpleSync = { flushRetryQueueSync: vi.fn() };
  const actionQueue = {
    storage: {
      saveQueueToStorage: vi.fn(),
      saveDeadLetterToStorage: vi.fn(),
    },
  };
  const controller = createWorkspaceShellBeforeUnloadController({
    isBrowser: () => options.browser ?? true,
    beforeUnloadManager,
    beforeUnloadGuard,
    syncCoordinator,
    undoService,
    simpleSync: () => simpleSync,
    actionQueue,
    onFlushError: options.onFlushError,
  });

  return {
    actionQueue,
    beforeUnloadGuard,
    beforeUnloadManager,
    controller,
    registeredCallback: () => registeredCallback,
    simpleSync,
    syncCoordinator,
    undoService,
  };
}

describe('createWorkspaceShellBeforeUnloadController', () => {
  it('maps shell dependencies into the browser beforeunload lifecycle', () => {
    const {
      beforeUnloadGuard,
      beforeUnloadManager,
      controller,
      registeredCallback,
    } = createController();

    controller.setup();

    expect(beforeUnloadManager.initialize).toHaveBeenCalledTimes(1);
    expect(beforeUnloadGuard.enable).toHaveBeenCalledTimes(1);
    expect(beforeUnloadManager.register).toHaveBeenCalledWith(
      'app-core-save',
      expect.any(Function),
      1,
    );
    expect(registeredCallback()).toEqual(expect.any(Function));
  });

  it('flushes shell persistence through the registered beforeunload callback', () => {
    const {
      actionQueue,
      controller,
      registeredCallback,
      simpleSync,
      syncCoordinator,
      undoService,
    } = createController();

    controller.setup();
    const result = registeredCallback()?.();

    expect(result).toBe(false);
    expect(syncCoordinator.flushPendingPersist).toHaveBeenCalledTimes(1);
    expect(undoService.flushPendingAction).toHaveBeenCalledTimes(1);
    expect(simpleSync.flushRetryQueueSync).toHaveBeenCalledTimes(1);
    expect(actionQueue.storage.saveQueueToStorage).toHaveBeenCalledTimes(1);
    expect(actionQueue.storage.saveDeadLetterToStorage).toHaveBeenCalledTimes(1);
  });

  it('reports flush step errors through the factory-provided error handler', () => {
    const onFlushError = vi.fn();
    const {
      actionQueue,
      controller,
      registeredCallback,
      simpleSync,
      syncCoordinator,
      undoService,
    } = createController({ onFlushError });
    const flushError = new Error('undo flush failed');
    undoService.flushPendingAction.mockImplementation(() => {
      throw flushError;
    });

    controller.setup();

    expect(() => registeredCallback()?.()).not.toThrow();
    expect(onFlushError).toHaveBeenCalledWith('pending-action', flushError);
    expect(syncCoordinator.flushPendingPersist).toHaveBeenCalledTimes(1);
    expect(undoService.flushPendingAction).toHaveBeenCalledTimes(1);
    expect(simpleSync.flushRetryQueueSync).toHaveBeenCalledTimes(1);
    expect(actionQueue.storage.saveQueueToStorage).toHaveBeenCalledTimes(1);
    expect(actionQueue.storage.saveDeadLetterToStorage).toHaveBeenCalledTimes(1);
  });

  it('does not register beforeunload work outside browser environments', () => {
    const { beforeUnloadGuard, beforeUnloadManager, controller } = createController({ browser: false });

    controller.setup();

    expect(beforeUnloadManager.initialize).not.toHaveBeenCalled();
    expect(beforeUnloadGuard.enable).not.toHaveBeenCalled();
    expect(beforeUnloadManager.register).not.toHaveBeenCalled();
  });
});
