import { afterEach, describe, expect, it, vi } from 'vitest';

import { WorkspaceShellStartupBootstrapController } from './workspace-shell-startup-bootstrap.controller';

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
  isMobile?: () => boolean;
  record?: string[];
} = {}) {
  const record = overrides.record ?? [];
  const push = (label: string) => vi.fn(() => record.push(label));
  const createCallbacks = vi.fn(() => {
    record.push('modalCallbacks.createCallbacks');
    return { onLogin: vi.fn() };
  });
  const initCallbacks = vi.fn(() => record.push('modalCoord.initCallbacks'));
  const setSidebarOpen = vi.fn((open: boolean) => record.push(`setSidebarOpen:${open}`));
  const controller = new WorkspaceShellStartupBootstrapController({
    isMobile: overrides.isMobile ?? (() => false),
    setSidebarOpen,
    initializeSwUpdateLifecycle: push('swUpdateLifecycle.initialize'),
    setupConflictHandler: push('conflictHandler.setup'),
    setupSidebarToggleEvent: push('sidebarToggleEvent.setup'),
    setupStorageEscape: push('storageEscape.setup'),
    setupBeforeUnload: push('beforeUnloadController.setup'),
    createModalCallbacks: createCallbacks,
    initModalCallbacks: initCallbacks,
    initializeAppLifecycle: push('appLifecycle.initialize'),
    prehydrateUserSessionFromSnapshot: push('userSession.prehydrateFromSnapshot'),
    restoreAndroidWidgetState: push('androidWidgetLazyLoad.restoreAll'),
    setupSignalEffects: push('signalEffects.setup'),
  });

  return { controller, createCallbacks, initCallbacks, record, setSidebarOpen };
}

describe('WorkspaceShellStartupBootstrapController', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs constructor-stage startup steps in the existing order', () => {
    const { controller, createCallbacks, initCallbacks, record, setSidebarOpen } = createController();

    controller.initialize();

    expect(setSidebarOpen).not.toHaveBeenCalled();
    expect(createCallbacks).toHaveBeenCalledTimes(1);
    expect(initCallbacks).toHaveBeenCalledTimes(1);
    expect(record).toEqual([
      'swUpdateLifecycle.initialize',
      'conflictHandler.setup',
      'sidebarToggleEvent.setup',
      'storageEscape.setup',
      'beforeUnloadController.setup',
      'modalCallbacks.createCallbacks',
      'modalCoord.initCallbacks',
      'appLifecycle.initialize',
      'userSession.prehydrateFromSnapshot',
      'androidWidgetLazyLoad.restoreAll',
      'signalEffects.setup',
    ]);
  });

  it('closes the sidebar before startup setup when booting on mobile', () => {
    const { controller, record, setSidebarOpen } = createController({
      isMobile: () => true,
    });

    controller.initialize();

    expect(setSidebarOpen).toHaveBeenCalledWith(false);
    expect(record[0]).toBe('setSidebarOpen:false');
    expect(record[1]).toBe('swUpdateLifecycle.initialize');
  });

  it('initializes modal callbacks after an async callback delegate resolves', async () => {
    const record: string[] = [];
    const callbacks = { onLogin: vi.fn() };
    const controller = new WorkspaceShellStartupBootstrapController({
      isMobile: () => false,
      setSidebarOpen: vi.fn(),
      initializeSwUpdateLifecycle: vi.fn(),
      setupConflictHandler: vi.fn(),
      setupSidebarToggleEvent: vi.fn(),
      setupStorageEscape: vi.fn(),
      setupBeforeUnload: vi.fn(),
      createModalCallbacks: vi.fn(() => {
        record.push('modalCallbacks.createCallbacks');
        return Promise.resolve(callbacks);
      }),
      initModalCallbacks: vi.fn((resolvedCallbacks) => {
        expect(resolvedCallbacks).toBe(callbacks);
        record.push('modalCoord.initCallbacks');
      }),
      initializeAppLifecycle: vi.fn(() => record.push('appLifecycle.initialize')),
      prehydrateUserSessionFromSnapshot: vi.fn(),
      restoreAndroidWidgetState: vi.fn(),
      setupSignalEffects: vi.fn(),
    });

    controller.initialize();

    expect(record).toEqual([
      'modalCallbacks.createCallbacks',
      'appLifecycle.initialize',
    ]);

    await Promise.resolve();

    expect(record).toEqual([
      'modalCallbacks.createCallbacks',
      'appLifecycle.initialize',
      'modalCoord.initCallbacks',
    ]);
  });

  it('ignores stale async modal callbacks when a newer bootstrap initializes first', async () => {
    const firstCallbacks = { id: 'first' };
    const secondCallbacks = { id: 'second' };
    const firstDeferred = createDeferred<typeof firstCallbacks>();
    const createModalCallbacks = vi.fn()
      .mockReturnValueOnce(firstDeferred.promise)
      .mockResolvedValueOnce(secondCallbacks);
    const initModalCallbacks = vi.fn();
    const controller = new WorkspaceShellStartupBootstrapController({
      isMobile: () => false,
      setSidebarOpen: vi.fn(),
      initializeSwUpdateLifecycle: vi.fn(),
      setupConflictHandler: vi.fn(),
      setupSidebarToggleEvent: vi.fn(),
      setupStorageEscape: vi.fn(),
      setupBeforeUnload: vi.fn(),
      createModalCallbacks,
      initModalCallbacks,
      initializeAppLifecycle: vi.fn(),
      prehydrateUserSessionFromSnapshot: vi.fn(),
      restoreAndroidWidgetState: vi.fn(),
      setupSignalEffects: vi.fn(),
    });

    controller.initialize();
    controller.initialize();
    await Promise.resolve();
    firstDeferred.resolve(firstCallbacks);
    await Promise.resolve();

    expect(createModalCallbacks).toHaveBeenCalledTimes(2);
    expect(initModalCallbacks).toHaveBeenCalledTimes(1);
    expect(initModalCallbacks).toHaveBeenCalledWith(secondCallbacks);
  });

  it('ignores async modal callbacks that resolve after teardown', async () => {
    const callbacks = { id: 'late' };
    const deferred = createDeferred<typeof callbacks>();
    const initModalCallbacks = vi.fn();
    const controller = new WorkspaceShellStartupBootstrapController({
      isMobile: () => false,
      setSidebarOpen: vi.fn(),
      initializeSwUpdateLifecycle: vi.fn(),
      setupConflictHandler: vi.fn(),
      setupSidebarToggleEvent: vi.fn(),
      setupStorageEscape: vi.fn(),
      setupBeforeUnload: vi.fn(),
      createModalCallbacks: vi.fn(() => deferred.promise),
      initModalCallbacks,
      initializeAppLifecycle: vi.fn(),
      prehydrateUserSessionFromSnapshot: vi.fn(),
      restoreAndroidWidgetState: vi.fn(),
      setupSignalEffects: vi.fn(),
    });

    controller.initialize();
    controller.teardown();
    deferred.resolve(callbacks);
    await Promise.resolve();

    expect(initModalCallbacks).not.toHaveBeenCalled();
  });

  it('warns and automatically retries async modal callback failures', async () => {
    vi.useFakeTimers();
    const error = new Error('modal callbacks failed');
    const callbacks = { id: 'retry-success' };
    const warn = vi.fn();
    const initModalCallbacks = vi.fn();
    const createModalCallbacks = vi.fn()
      .mockReturnValueOnce(Promise.reject(error))
      .mockResolvedValueOnce(callbacks);
    const controller = new WorkspaceShellStartupBootstrapController({
      isMobile: () => false,
      setSidebarOpen: vi.fn(),
      initializeSwUpdateLifecycle: vi.fn(),
      setupConflictHandler: vi.fn(),
      setupSidebarToggleEvent: vi.fn(),
      setupStorageEscape: vi.fn(),
      setupBeforeUnload: vi.fn(),
      createModalCallbacks,
      initModalCallbacks,
      initializeAppLifecycle: vi.fn(),
      prehydrateUserSessionFromSnapshot: vi.fn(),
      restoreAndroidWidgetState: vi.fn(),
      setupSignalEffects: vi.fn(),
      warn,
    });

    controller.initialize();
    await Promise.resolve();
    await Promise.resolve();

    // 失败必须可见：通过 warn 通道记录，且不误触发 initCallbacks
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('模态回调懒加载失败'), error);
    expect(initModalCallbacks).not.toHaveBeenCalled();

    // 生产只初始化一次；失败后 controller 自身必须重新创建回调并成功接线
    await vi.runOnlyPendingTimersAsync();
    await Promise.resolve();

    expect(createModalCallbacks).toHaveBeenCalledTimes(2);
    expect(initModalCallbacks).toHaveBeenCalledWith(callbacks);
  });

  it('continues modal callback retry when the warning sink throws', async () => {
    vi.useFakeTimers();
    const loadError = new Error('modal callbacks failed');
    const warnError = new Error('warning sink failed');
    const callbacks = { id: 'retry-success' };
    const warn = vi.fn(() => {
      throw warnError;
    });
    const initModalCallbacks = vi.fn();
    const createModalCallbacks = vi.fn()
      .mockImplementationOnce(() => {
        throw loadError;
      })
      .mockReturnValueOnce(callbacks);
    const controller = new WorkspaceShellStartupBootstrapController({
      isMobile: () => false,
      setSidebarOpen: vi.fn(),
      initializeSwUpdateLifecycle: vi.fn(),
      setupConflictHandler: vi.fn(),
      setupSidebarToggleEvent: vi.fn(),
      setupStorageEscape: vi.fn(),
      setupBeforeUnload: vi.fn(),
      createModalCallbacks,
      initModalCallbacks,
      initializeAppLifecycle: vi.fn(),
      prehydrateUserSessionFromSnapshot: vi.fn(),
      restoreAndroidWidgetState: vi.fn(),
      setupSignalEffects: vi.fn(),
      warn,
    });

    expect(() => controller.initialize()).not.toThrow();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('模态回调懒加载失败'), loadError);

    await vi.runOnlyPendingTimersAsync();

    expect(createModalCallbacks).toHaveBeenCalledTimes(2);
    expect(initModalCallbacks).toHaveBeenCalledWith(callbacks);
  });

  it('does not throw when async modal callbacks fail without a warn channel', async () => {
    const controller = new WorkspaceShellStartupBootstrapController({
      isMobile: () => false,
      setSidebarOpen: vi.fn(),
      initializeSwUpdateLifecycle: vi.fn(),
      setupConflictHandler: vi.fn(),
      setupSidebarToggleEvent: vi.fn(),
      setupStorageEscape: vi.fn(),
      setupBeforeUnload: vi.fn(),
      createModalCallbacks: vi.fn(() => Promise.reject(new Error('no warn channel'))),
      initModalCallbacks: vi.fn(),
      initializeAppLifecycle: vi.fn(),
      prehydrateUserSessionFromSnapshot: vi.fn(),
      restoreAndroidWidgetState: vi.fn(),
      setupSignalEffects: vi.fn(),
    });

    expect(() => controller.initialize()).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
  });
});
