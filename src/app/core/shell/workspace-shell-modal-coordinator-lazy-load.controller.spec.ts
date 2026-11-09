import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ModalCallbacks } from '../../../services/workspace-modal-coordinator.service';
import {
  WorkspaceShellModalCoordinatorLazyLoadController,
  type WorkspaceShellModalCoordinatorLike,
  type WorkspaceShellModalCoordinatorLazyLoadControllerOptions,
} from './workspace-shell-modal-coordinator-lazy-load.controller';

type WarnFn = (message: string, error: unknown) => void;

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
}

function createModalCoord(options: { loadingType?: string } = {}): WorkspaceShellModalCoordinatorLike {
  return {
    initCallbacks: vi.fn(),
    isModalLoading: vi.fn((type: string) => type === options.loadingType),
  };
}

function createCallbacks(): ModalCallbacks {
  return {
    closeMigrationModal: vi.fn(),
    confirmCreateProject: vi.fn(),
    handleImportComplete: vi.fn(),
    handleLocalModeFromModal: vi.fn(),
    handleLoginFromModal: vi.fn(),
    handleMigrationComplete: vi.fn(),
    handleResetPasswordFromModal: vi.fn(),
    handleSignupFromModal: vi.fn(),
    signOut: vi.fn(),
    updateTheme: vi.fn(),
  } as unknown as ModalCallbacks;
}

function createController(overrides: {
  createCallbacks?: () => ModalCallbacks | Promise<ModalCallbacks>;
  destroyed?: () => boolean;
  fallbackModalCoord?: WorkspaceShellModalCoordinatorLike;
  loadModalCoord?: () => Promise<WorkspaceShellModalCoordinatorLike>;
  warn?: WarnFn;
} = {}) {
  const fallbackModalCoord = overrides.fallbackModalCoord ?? createModalCoord();
  const modalCoord = createModalCoord();
  const callbacks = createCallbacks();
  const loadModalCoord = overrides.loadModalCoord ?? vi.fn().mockResolvedValue(modalCoord);
  const controllerOptions:
    WorkspaceShellModalCoordinatorLazyLoadControllerOptions<WorkspaceShellModalCoordinatorLike> & {
      warn?: WarnFn;
    } = {
    createCallbacks: overrides.createCallbacks ?? (() => callbacks),
    destroyed: overrides.destroyed ?? (() => false),
    fallbackModalCoord,
    loadModalCoord,
    ...(overrides.warn ? { warn: overrides.warn } : {}),
  };
  const controller = new WorkspaceShellModalCoordinatorLazyLoadController(controllerOptions);

  return { callbacks, controller, fallbackModalCoord, loadModalCoord, modalCoord };
}

describe('WorkspaceShellModalCoordinatorLazyLoadController', () => {
  it('receives modal coordinator service resolution from a loader instead of importing it directly', () => {
    const source = readFileSync(
      join(__dirname, 'workspace-shell-modal-coordinator-lazy-load.controller.ts'),
      'utf8',
    );

    expect(source).not.toContain("import('../../../services/workspace-modal-coordinator.service')");
    expect(source).not.toContain('WorkspaceModalCoordinatorService })');
    expect(source).not.toContain('injector.get(WorkspaceModalCoordinatorService)');
  });

  it('loads the modal coordinator once while requests are in flight and initializes callbacks', async () => {
    const modalCoord = createModalCoord();
    const deferred = createDeferred<WorkspaceShellModalCoordinatorLike>();
    const { callbacks, controller, loadModalCoord } = createController({
      loadModalCoord: vi.fn(() => deferred.promise),
    });

    const first = controller.get();
    const second = controller.get();

    expect(loadModalCoord).toHaveBeenCalledTimes(1);
    deferred.resolve(modalCoord);
    await expect(Promise.all([first, second])).resolves.toEqual([modalCoord, modalCoord]);
    expect(modalCoord.initCallbacks).toHaveBeenCalledOnce();
    expect(modalCoord.initCallbacks).toHaveBeenCalledWith(callbacks);
  });

  it('waits for async modal callbacks before initializing the loaded coordinator', async () => {
    const modalCoord = createModalCoord();
    const callbacks = createCallbacks();
    const createCallbacksDeferred = createDeferred<ModalCallbacks>();
    const controller = new WorkspaceShellModalCoordinatorLazyLoadController({
      createCallbacks: vi.fn(() => createCallbacksDeferred.promise),
      destroyed: () => false,
      fallbackModalCoord: createModalCoord(),
      loadModalCoord: vi.fn().mockResolvedValue(modalCoord),
    });

    const load = controller.get();
    await Promise.resolve();

    expect(modalCoord.initCallbacks).not.toHaveBeenCalled();
    createCallbacksDeferred.resolve(callbacks);
    await load;

    expect(modalCoord.initCallbacks).toHaveBeenCalledWith(callbacks);
  });

  it('does not initialize callbacks when the shell is destroyed before load resolves', async () => {
    let destroyed = false;
    const modalCoord = createModalCoord();
    const deferred = createDeferred<WorkspaceShellModalCoordinatorLike>();
    const { controller } = createController({
      destroyed: () => destroyed,
      loadModalCoord: vi.fn(() => deferred.promise),
    });

    const load = controller.get();
    destroyed = true;
    deferred.resolve(modalCoord);
    await load;

    expect(modalCoord.initCallbacks).not.toHaveBeenCalled();
  });

  it('does not initialize or cache the coordinator when destroyed while callbacks are loading', async () => {
    let destroyed = false;
    const modalCoord = createModalCoord({ loadingType: 'loaded' });
    const fallbackModalCoord = createModalCoord({ loadingType: 'fallback' });
    const callbacksDeferred = createDeferred<ModalCallbacks>();
    const controller = new WorkspaceShellModalCoordinatorLazyLoadController({
      createCallbacks: vi.fn(() => callbacksDeferred.promise),
      destroyed: () => destroyed,
      fallbackModalCoord,
      loadModalCoord: vi.fn().mockResolvedValue(modalCoord),
    });

    const load = controller.get();
    await Promise.resolve();

    destroyed = true;
    callbacksDeferred.resolve(createCallbacks());
    await expect(load).resolves.toBeNull();

    expect(modalCoord.initCallbacks).not.toHaveBeenCalled();
    expect(controller.isModalLoading('fallback')).toBe(true);
    expect(controller.isModalLoading('loaded')).toBe(false);
  });

  it('returns null without loading the coordinator when the shell is already destroyed', async () => {
    const loadModalCoord = vi.fn().mockResolvedValue(createModalCoord());
    const { controller } = createController({
      destroyed: () => true,
      loadModalCoord,
    });

    await expect(controller.get()).resolves.toBeNull();

    expect(loadModalCoord).not.toHaveBeenCalled();
  });

  it('uses fallback loading state before load and loaded coordinator state after load', async () => {
    const fallbackModalCoord = createModalCoord({ loadingType: 'settings' });
    const modalCoord = createModalCoord({ loadingType: 'dashboard' });
    const { controller } = createController({
      fallbackModalCoord,
      loadModalCoord: vi.fn().mockResolvedValue(modalCoord),
    });

    expect(controller.isModalLoading('settings')).toBe(true);
    expect(controller.isModalLoading('dashboard')).toBe(false);
    await controller.get();

    expect(controller.isModalLoading('settings')).toBe(false);
    expect(controller.isModalLoading('dashboard')).toBe(true);
  });

  it('returns null, warns, and allows retrying after a modal coordinator load failure', async () => {
    const error = new Error('chunk missing');
    const modalCoord = createModalCoord();
    const warn = vi.fn();
    const { controller, loadModalCoord } = createController({
      loadModalCoord: vi.fn()
        .mockRejectedValueOnce(error)
        .mockResolvedValueOnce(modalCoord),
      warn,
    });

    await expect(controller.get()).resolves.toBeNull();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('modal coordinator'),
      error,
    );

    await expect(controller.get()).resolves.toBe(modalCoord);

    expect(loadModalCoord).toHaveBeenCalledTimes(2);
  });

  it('returns null, warns, and allows retrying after modal callback creation fails', async () => {
    const error = new Error('callbacks failed');
    const callbacks = createCallbacks();
    const modalCoord = createModalCoord();
    const createCallbacksMock = vi.fn()
      .mockRejectedValueOnce(error)
      .mockReturnValueOnce(callbacks);
    const warn = vi.fn();
    const { controller, loadModalCoord } = createController({
      createCallbacks: createCallbacksMock,
      loadModalCoord: vi.fn().mockResolvedValue(modalCoord),
      warn,
    });

    await expect(controller.get()).resolves.toBeNull();
    expect(modalCoord.initCallbacks).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('modal coordinator'),
      error,
    );

    await expect(controller.get()).resolves.toBe(modalCoord);

    expect(loadModalCoord).toHaveBeenCalledTimes(2);
    expect(createCallbacksMock).toHaveBeenCalledTimes(2);
    expect(modalCoord.initCallbacks).toHaveBeenCalledWith(callbacks);
  });
});
