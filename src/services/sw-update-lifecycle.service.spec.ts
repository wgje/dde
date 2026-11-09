import { vi, describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest';
import { Subject } from 'rxjs';
import { APP_LIFECYCLE_CONFIG } from '../config/app-lifecycle.config';
import type { AppLifecycleReloadCoordinator } from './app-lifecycle-reload.coordinator';
import { SwUpdateLifecycleService, type SwUpdateCheckReason } from './sw-update-lifecycle.service';
import type { ToastAction } from './toast.service';

type SwUpdateLifecyclePrivate = {
  initialize: () => void;
  teardown: () => void;
  setupSwUpdateChecks: () => void;
  teardownSwUpdateChecks: () => void;
  checkForSwUpdate: (reason: SwUpdateCheckReason, force?: boolean) => Promise<void>;
  swUpdateInitialCheckTimer: ReturnType<typeof setTimeout> | null;
  swUpdatePollTimer: ReturnType<typeof setInterval> | null;
  swUpdateCheckInFlight: boolean;
  swUpdateCheckGeneration: number;
  versionReloadState: 'idle' | 'prompted' | 'in-flight' | 'retry-pending' | 'completed';
  versionReloadRetryTimer: ReturnType<typeof setTimeout> | null;
  lastSwUpdateCheckAt: number;
  versionUpdatesSubscribed: boolean;
  stopped: boolean;
  initialized: boolean;
  swUpdate: {
    isEnabled: boolean;
    checkForUpdate: ReturnType<typeof vi.fn>;
    versionUpdates: Subject<unknown>;
    activateUpdate: ReturnType<typeof vi.fn>;
  };
  destroyRef: { onDestroy: ReturnType<typeof vi.fn> };
  logger: {
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    debug: ReturnType<typeof vi.fn>;
  };
  toast: { info: ReturnType<typeof vi.fn> };
  appLifecycle: { markVersionReady: ReturnType<typeof vi.fn> };
  reloadCoordinator: { triggerVersionReload: AppLifecycleReloadCoordinator['triggerVersionReload'] };
  handleSwUpdateVisibilityCheck: EventListener;
  handleSwUpdateFocusCheck: EventListener;
  handleSwUpdateOnlineCheck: EventListener;
  onSwUpdateOnline: () => void;
};

function createSwUpdateCheckContext(checkForUpdate = vi.fn().mockResolvedValue(false)): SwUpdateLifecyclePrivate {
  const context = Object.create(SwUpdateLifecycleService.prototype) as SwUpdateLifecyclePrivate;
  context.swUpdateInitialCheckTimer = null;
  context.swUpdatePollTimer = null;
  context.swUpdateCheckInFlight = false;
  context.swUpdateCheckGeneration = 0;
  context.versionReloadState = 'idle';
  context.versionReloadRetryTimer = null;
  context.lastSwUpdateCheckAt = 0;
  context.versionUpdatesSubscribed = false;
  context.stopped = false;
  context.initialized = false;
  context.swUpdate = {
    isEnabled: true,
    checkForUpdate,
    versionUpdates: new Subject<unknown>(),
    activateUpdate: vi.fn().mockResolvedValue(true),
  };
  context.destroyRef = { onDestroy: vi.fn() };
  context.logger = {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  };
  context.toast = { info: vi.fn() };
  context.appLifecycle = { markVersionReady: vi.fn() };
  context.reloadCoordinator = { triggerVersionReload: vi.fn().mockResolvedValue(undefined) };
  context.handleSwUpdateVisibilityCheck = vi.fn();
  context.handleSwUpdateFocusCheck = vi.fn();
  context.handleSwUpdateOnlineCheck = vi.fn();
  return context;
}

function emitVersionReady(context: SwUpdateLifecyclePrivate): void {
  context.swUpdate.versionUpdates.next({ type: 'VERSION_READY' });
}
function latestReloadAction(context: SwUpdateLifecyclePrivate): ToastAction {
  const options = context.toast.info.mock.calls.at(-1)?.[2] as { action?: ToastAction } | undefined;
  if (!options?.action) throw new Error('Expected version reload action');
  return options.action;
}
let originalVisibilityStateDescriptor: PropertyDescriptor | undefined;
let originalOnlineDescriptor: PropertyDescriptor | undefined;
let originalForceClearDescriptor: PropertyDescriptor | undefined;
function setDocumentVisibilityState(state: DocumentVisibilityState): void {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    value: state,
  });
}

function restoreDocumentVisibilityState(): void {
  if (typeof document === 'undefined') return;

  if (originalVisibilityStateDescriptor) {
    Object.defineProperty(document, 'visibilityState', originalVisibilityStateDescriptor);
    return;
  }

  Reflect.deleteProperty(document, 'visibilityState');
}

describe('SwUpdateLifecycleService 版本更新检查', () => {
  beforeAll(() => {
    originalVisibilityStateDescriptor = Object.getOwnPropertyDescriptor(document, 'visibilityState');
    originalOnlineDescriptor = Object.getOwnPropertyDescriptor(navigator, 'onLine');
    originalForceClearDescriptor = Object.getOwnPropertyDescriptor(window, '__NANOFLOW_FORCE_CLEAR_CACHE__');
  });

  afterEach(() => {
    restoreDocumentVisibilityState();
    if (originalOnlineDescriptor) Object.defineProperty(navigator, 'onLine', originalOnlineDescriptor);
    else Reflect.deleteProperty(navigator, 'onLine');
    if (originalForceClearDescriptor) Object.defineProperty(window, '__NANOFLOW_FORCE_CLEAR_CACHE__', originalForceClearDescriptor);
    else Reflect.deleteProperty(window, '__NANOFLOW_FORCE_CLEAR_CACHE__');
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  afterAll(() => {
    restoreDocumentVisibilityState();
  });

  it('无 document/window 环境时检查注册与销毁应安全退化', async () => {
    const context = createSwUpdateCheckContext();
    const originalDocument = globalThis.document;
    const originalWindow = globalThis.window;

    try {
      Reflect.deleteProperty(globalThis, 'document');
      Reflect.deleteProperty(globalThis, 'window');

      expect(() => context.setupSwUpdateChecks()).not.toThrow();
      await expect(context.checkForSwUpdate('focus')).resolves.toBeUndefined();
      expect(() => context.teardownSwUpdateChecks()).not.toThrow();
    } finally {
      Object.defineProperty(globalThis, 'document', {
        configurable: true,
        writable: true,
        value: originalDocument,
      });
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        writable: true,
        value: originalWindow,
      });
    }
  });

  it('销毁时单个监听器移除失败不应阻断其余 Service Worker 更新监听清理', () => {
    vi.useFakeTimers();
    const context = createSwUpdateCheckContext();
    const visibilityCleanupError = new Error('visibility cleanup failed');
    const removeDocumentListener = vi
      .spyOn(document, 'removeEventListener')
      .mockImplementationOnce(() => {
        throw visibilityCleanupError;
      });
    const removeWindowListener = vi.spyOn(window, 'removeEventListener');
    context.swUpdateInitialCheckTimer = setTimeout(() => undefined, 1000);
    context.swUpdatePollTimer = setInterval(() => undefined, 1000);

    expect(() => context.teardownSwUpdateChecks()).not.toThrow();

    expect(context.swUpdateInitialCheckTimer).toBeNull();
    expect(context.swUpdatePollTimer).toBeNull();
    expect(removeDocumentListener).toHaveBeenCalledWith(
      'visibilitychange',
      expect.any(Function),
    );
    expect(removeWindowListener).toHaveBeenCalledWith('focus', expect.any(Function));
    expect(removeWindowListener).toHaveBeenCalledWith('online', expect.any(Function));
    expect(context.logger.warn).toHaveBeenCalledWith(
      'SwUpdate lifecycle resource cleanup failed; continuing remaining cleanup',
      {
        resource: 'document.visibilitychange',
        message: visibilityCleanupError.message,
      },
    );
  });

  it('销毁时应清理数值为 0 的 Service Worker 更新检查定时器句柄', () => {
    const context = createSwUpdateCheckContext();
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
    context.swUpdateInitialCheckTimer = 0 as unknown as ReturnType<typeof setTimeout>;
    context.swUpdatePollTimer = 0 as unknown as ReturnType<typeof setInterval>;

    context.teardownSwUpdateChecks();

    expect(clearTimeoutSpy).toHaveBeenCalledWith(0);
    expect(clearIntervalSpy).toHaveBeenCalledWith(0);
    expect(context.swUpdateInitialCheckTimer).toBeNull();
    expect(context.swUpdatePollTimer).toBeNull();
  });

  it('应在启动延迟后主动检查 Service Worker 更新', async () => {
    vi.useFakeTimers();
    setDocumentVisibilityState('visible');
    const checkForUpdate = vi.fn().mockResolvedValue(false);
    const context = createSwUpdateCheckContext(checkForUpdate);

    try {
      context.setupSwUpdateChecks();

      await vi.advanceTimersByTimeAsync(APP_LIFECYCLE_CONFIG.SW_UPDATE_INITIAL_CHECK_DELAY_MS);

      expect(checkForUpdate).toHaveBeenCalledTimes(1);
      expect(context.logger.debug).toHaveBeenCalledWith(
        'SwUpdate checkForUpdate completed without new version',
        { reason: 'startup' },
      );
    } finally {
      context.teardownSwUpdateChecks();
    }
  });

  it('重复 initialize 不应注册重复的周期检查', async () => {
    vi.useFakeTimers();
    setDocumentVisibilityState('visible');
    const checkForUpdate = vi.fn().mockResolvedValue(false);
    const context = createSwUpdateCheckContext(checkForUpdate);

    try {
      context.initialize();
      context.initialize();

      await vi.advanceTimersByTimeAsync(APP_LIFECYCLE_CONFIG.SW_UPDATE_INITIAL_CHECK_DELAY_MS);
      expect(checkForUpdate).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(APP_LIFECYCLE_CONFIG.SW_UPDATE_VISIBLE_POLL_INTERVAL_MS);
      expect(checkForUpdate).toHaveBeenCalledTimes(2);
    } finally {
      context.teardown();
    }
  });

  it('initialize 期间生命周期监听注册失败时应回滚并允许后续重试', async () => {
    vi.useFakeTimers();
    setDocumentVisibilityState('visible');
    const setupError = new Error('online listener failed');
    const checkForUpdate = vi.fn().mockResolvedValue(false);
    const context = createSwUpdateCheckContext(checkForUpdate);
    const addDocumentListener = vi.spyOn(document, 'addEventListener');
    const removeDocumentListener = vi.spyOn(document, 'removeEventListener');
    const removeWindowListener = vi.spyOn(window, 'removeEventListener');
    const originalWindowAdd = window.addEventListener.bind(window);
    const addWindowListener = vi
      .spyOn(window, 'addEventListener')
      .mockImplementation((...args: Parameters<typeof window.addEventListener>) => {
        if (args[0] === 'online') {
          throw setupError;
        }
        return originalWindowAdd(...args);
      });

    try {
      expect(() => context.initialize()).not.toThrow();

      expect(addDocumentListener).toHaveBeenCalledWith(
        'visibilitychange',
        context.handleSwUpdateVisibilityCheck,
      );
      expect(addWindowListener).toHaveBeenCalledWith('focus', context.handleSwUpdateFocusCheck);
      expect(addWindowListener).toHaveBeenCalledWith('online', context.handleSwUpdateOnlineCheck);
      expect(removeDocumentListener).toHaveBeenCalledWith(
        'visibilitychange',
        context.handleSwUpdateVisibilityCheck,
      );
      expect(removeWindowListener).toHaveBeenCalledWith('focus', context.handleSwUpdateFocusCheck);
      expect(context.swUpdateInitialCheckTimer).toBeNull();
      expect(context.swUpdatePollTimer).toBeNull();
      expect(context.initialized).toBe(false);
      expect(context.versionUpdatesSubscribed).toBe(false);
      expect(context.logger.warn).toHaveBeenCalledWith(
        'SwUpdate lifecycle setup failed; rolled back partial resources',
        {
          resource: 'window.online',
          message: setupError.message,
        },
      );

      addWindowListener.mockRestore();
      context.initialize();
      await vi.advanceTimersByTimeAsync(APP_LIFECYCLE_CONFIG.SW_UPDATE_INITIAL_CHECK_DELAY_MS);

      expect(checkForUpdate).toHaveBeenCalledTimes(1);
    } finally {
      context.teardown();
    }
  });

  it('teardown 后重新 initialize 应恢复版本检查', async () => {
    vi.useFakeTimers();
    setDocumentVisibilityState('visible');
    const checkForUpdate = vi.fn().mockResolvedValue(false);
    const context = createSwUpdateCheckContext(checkForUpdate);

    try {
      context.initialize();
      context.teardown();
      context.initialize();

      await vi.advanceTimersByTimeAsync(APP_LIFECYCLE_CONFIG.SW_UPDATE_INITIAL_CHECK_DELAY_MS);

      expect(checkForUpdate).toHaveBeenCalledTimes(1);
    } finally {
      context.teardown();
    }
  });

  it('旧生命周期的在途检查不应阻塞或回写重新 initialize 后的新检查', async () => {
    vi.useFakeTimers();
    setDocumentVisibilityState('visible');
    let resolveFirstCheck!: (value: boolean) => void;
    let resolveSecondCheck!: (value: boolean) => void;
    const firstCheckResult = new Promise<boolean>(resolve => {
      resolveFirstCheck = resolve;
    });
    const secondCheckResult = new Promise<boolean>(resolve => {
      resolveSecondCheck = resolve;
    });
    const checkForUpdate = vi.fn()
      .mockReturnValueOnce(firstCheckResult)
      .mockReturnValueOnce(secondCheckResult);
    const context = createSwUpdateCheckContext(checkForUpdate);

    try {
      context.initialize();
      const firstCheck = context.checkForSwUpdate('startup', true);
      expect(context.swUpdateCheckInFlight).toBe(true);

      context.teardown();
      context.initialize();
      const secondCheck = context.checkForSwUpdate('startup', true);

      expect(checkForUpdate).toHaveBeenCalledTimes(2);
      expect(context.swUpdateCheckInFlight).toBe(true);

      resolveFirstCheck(false);
      await firstCheck;

      expect(context.swUpdateCheckInFlight).toBe(true);
      expect(context.lastSwUpdateCheckAt).toBe(0);
      expect(context.logger.debug).not.toHaveBeenCalled();

      resolveSecondCheck(false);
      await secondCheck;

      expect(context.swUpdateCheckInFlight).toBe(false);
      expect(context.lastSwUpdateCheckAt).toBeGreaterThan(0);
      expect(context.logger.debug).toHaveBeenCalledTimes(1);
      expect(context.logger.debug).toHaveBeenCalledWith(
        'SwUpdate checkForUpdate completed without new version',
        { reason: 'startup' },
      );
    } finally {
      context.teardown();
    }
  });

  it('离线点击应仅重置意图，重连与重复版本事件不重复 prompt', async () => {
    vi.useFakeTimers();
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
    const activateUpdate = vi.fn().mockResolvedValue(true);
    const forceClear = vi.fn();
    Object.defineProperty(window, '__NANOFLOW_FORCE_CLEAR_CACHE__', { configurable: true, value: forceClear });
    const context = createSwUpdateCheckContext();
    context.swUpdate.activateUpdate = activateUpdate;
    context.reloadCoordinator = { triggerVersionReload: vi.fn(async (_breadcrumb, reset) => {
      Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
      context.onSwUpdateOnline();
      reset();
    }) };
    context.initialize();
    emitVersionReady(context);
    await latestReloadAction(context).onClick();
    expect(activateUpdate).not.toHaveBeenCalled();
    expect(forceClear).not.toHaveBeenCalled();
    expect(context.toast.info).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(0);
    context.onSwUpdateOnline();
    emitVersionReady(context);
    expect(context.toast.info).toHaveBeenCalledTimes(2);
    context.teardown();
  });

  it('激活在途转离线时不应 force-clear', async () => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
    let resolveActivation!: () => void;
    const activateUpdate = vi.fn(() => new Promise<boolean>(resolve => { resolveActivation = () => resolve(true); }));
    const forceClear = vi.fn();
    Object.defineProperty(window, '__NANOFLOW_FORCE_CLEAR_CACHE__', { configurable: true, value: forceClear });
    const context = createSwUpdateCheckContext();
    context.swUpdate.activateUpdate = activateUpdate;
    context.reloadCoordinator = {
      triggerVersionReload: vi.fn(async (_breadcrumb, reset) => { await activateUpdate(); reset(); }),
    };
    context.initialize();
    emitVersionReady(context);
    const action = latestReloadAction(context).onClick();

    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
    resolveActivation();
    await action;
    expect(forceClear).not.toHaveBeenCalled();
    context.teardown();
  });

  it('teardown 应让旧 prompt action 失效', async () => {
    const context = createSwUpdateCheckContext();
    context.initialize();
    emitVersionReady(context);
    const action = latestReloadAction(context);
    context.teardown();
    await action.onClick();
    expect(context.swUpdate.activateUpdate).not.toHaveBeenCalled();
    expect(context.reloadCoordinator.triggerVersionReload).not.toHaveBeenCalled();
  });

  it('在线时应先激活再 force-clear，且日志异常不得阻断激活失败回退', async () => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
    const events: string[] = [];
    const activateUpdate = vi.fn().mockImplementationOnce(async () => { events.push('activate'); return true; })
      .mockImplementationOnce(async () => { events.push('reject'); throw new Error('activation failed'); });
    const forceClear = vi.fn(() => { events.push('force-clear'); });
    Object.defineProperty(window, '__NANOFLOW_FORCE_CLEAR_CACHE__', { configurable: true, value: forceClear });
    const context = createSwUpdateCheckContext();
    context.swUpdate.activateUpdate = activateUpdate;
    context.reloadCoordinator = {
      triggerVersionReload: vi.fn(async (breadcrumb) => {
        try {
          await activateUpdate();
          breadcrumb('lifecycle.version-reload.activate-ok', 'manual', {});
        } catch (error) {
          breadcrumb('lifecycle.version-reload.activate-failed', 'manual', { error: String(error) });
        }
        forceClear();
      }),
    };
    context.initialize();
    emitVersionReady(context);

    await latestReloadAction(context).onClick();
    expect(events).toEqual(['activate', 'force-clear']);
    context.teardown();
    context.initialize();
    context.logger.warn.mockImplementation(() => { throw new Error('logger failed'); });
    emitVersionReady(context);
    await expect(latestReloadAction(context).onClick()).resolves.toBeUndefined();
    expect(events).toEqual(['activate', 'force-clear', 'reject', 'force-clear']);
    context.teardown();
  });

  it('teardown 后不应再响应 VERSION_READY 更新事件', () => {
    const context = createSwUpdateCheckContext();

    context.initialize();
    context.teardown();
    context.swUpdate.versionUpdates.next({
      type: 'VERSION_READY',
      currentVersion: { hash: 'old' },
      latestVersion: { hash: 'new' },
    });

    expect(context.appLifecycle.markVersionReady).not.toHaveBeenCalled();
    expect(context.toast.info).not.toHaveBeenCalled();
  });

  it('应对 focus/visibility/online 触发的版本检查做冷却去重', async () => {
    vi.useFakeTimers();
    setDocumentVisibilityState('visible');
    const checkForUpdate = vi.fn().mockResolvedValue(true);
    const context = createSwUpdateCheckContext(checkForUpdate);

    try {
      await context.checkForSwUpdate('focus');
      await context.checkForSwUpdate('online');
      await vi.advanceTimersByTimeAsync(APP_LIFECYCLE_CONFIG.SW_UPDATE_RESUME_CHECK_COOLDOWN_MS);
      await context.checkForSwUpdate('visibility');

      expect(checkForUpdate).toHaveBeenCalledTimes(2);
      expect(context.logger.info).toHaveBeenCalledWith(
        'SwUpdate checkForUpdate detected a deploy version',
        { reason: 'focus' },
      );
    } finally {
      context.teardownSwUpdateChecks();
    }
  });

  it('失败的版本检查不应刷新冷却窗口，应允许 online 立即重试', async () => {
    vi.useFakeTimers();
    setDocumentVisibilityState('visible');
    const checkForUpdate = vi.fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(false);
    const context = createSwUpdateCheckContext(checkForUpdate);

    await context.checkForSwUpdate('periodic');
    await context.checkForSwUpdate('online');

    expect(checkForUpdate).toHaveBeenCalledTimes(2);
    expect(context.logger.warn).toHaveBeenCalledWith(
      'SwUpdate checkForUpdate failed',
      {
        reason: 'periodic',
        message: 'offline',
      },
    );
    expect(context.logger.debug).toHaveBeenCalledWith(
      'SwUpdate checkForUpdate completed without new version',
      { reason: 'online' },
    );
  });
});
