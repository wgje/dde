import { describe, expect, it, vi } from 'vitest';

import { SupabaseAuthAutoRefreshController } from './supabase-auth-auto-refresh.controller';
import type { Database } from '../types/supabase';
import {
  ensureBrowserNetworkSuspensionTracking,
  resetBrowserNetworkSuspensionTrackingForTests,
} from '../utils/browser-network-suspension';
import type { SupabaseClient } from '@supabase/supabase-js';

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>(res => {
    resolve = res;
  });
  return { promise, resolve };
}

function createRejectableDeferred(): {
  promise: Promise<void>;
  reject: (error: unknown) => void;
} {
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((_resolve, rej) => {
    reject = rej;
  });
  return { promise, reject };
}

async function waitForMockCall(mock: ReturnType<typeof vi.fn>, callCount: number): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (mock.mock.calls.length >= callCount) {
      return;
    }
    await Promise.resolve();
  }
  expect(mock).toHaveBeenCalledTimes(callCount);
}

function createClient(overrides: {
  startAutoRefresh?: ReturnType<typeof vi.fn>;
  stopAutoRefresh?: ReturnType<typeof vi.fn>;
} = {}): SupabaseClient<Database> {
  return {
    auth: {
      getSession: vi.fn().mockResolvedValue({ data: { session: null }, error: null }),
      refreshSession: vi.fn().mockResolvedValue({ data: { session: null }, error: null }),
      startAutoRefresh: overrides.startAutoRefresh ?? vi.fn().mockResolvedValue(undefined),
      stopAutoRefresh: overrides.stopAutoRefresh ?? vi.fn().mockResolvedValue(undefined),
    },
  } as unknown as SupabaseClient<Database>;
}

describe('SupabaseAuthAutoRefreshController', () => {
  it('bindLifecycle 注册失败时应回滚已注册监听器并允许后续重新绑定', () => {
    const logger = {
      debug: vi.fn(),
      warn: vi.fn(),
    };
    const controller = new SupabaseAuthAutoRefreshController({
      isOfflineMode: () => false,
      logger,
    });
    const firstSync = vi.fn();
    const secondSync = vi.fn();
    controller.bindLifecycle(vi.fn());
    controller.teardownLifecycle();

    const originalWindowAddEventListener = window.addEventListener.bind(window);
    const windowAdd = vi
      .spyOn(window, 'addEventListener')
      .mockImplementation((eventName, listener, options) => {
        if (eventName === 'pageshow') {
          throw new Error('bind pageshow failed');
        }
        return originalWindowAddEventListener(eventName, listener, options);
      });

    try {
      expect(() => controller.bindLifecycle(firstSync)).toThrow('bind pageshow failed');

      document.dispatchEvent(new Event('visibilitychange'));
      expect(firstSync).not.toHaveBeenCalled();

      windowAdd.mockRestore();
      controller.bindLifecycle(secondSync);
      document.dispatchEvent(new Event('visibilitychange'));

      expect(firstSync).not.toHaveBeenCalled();
      expect(secondSync).toHaveBeenCalledWith('visibilitychange');
    } finally {
      controller.teardownLifecycle();
      resetBrowserNetworkSuspensionTrackingForTests();
      windowAdd.mockRestore();
    }
  });

  it('teardownLifecycle 清理监听器时单个 removeEventListener 失败仍继续清理并允许重新绑定', () => {
    const logger = {
      debug: vi.fn(),
      warn: vi.fn(),
    };
    const controller = new SupabaseAuthAutoRefreshController({
      isOfflineMode: () => false,
      logger,
    });
    const firstSync = vi.fn();
    const secondSync = vi.fn();
    const documentRemove = vi
      .spyOn(document, 'removeEventListener')
      .mockImplementationOnce(() => {
        throw new Error('remove visibility failed');
      });
    const windowRemove = vi.spyOn(window, 'removeEventListener');

    try {
      controller.bindLifecycle(firstSync);

      expect(() => controller.teardownLifecycle()).not.toThrow();
      expect(windowRemove).toHaveBeenCalledWith('pageshow', expect.any(Function));
      expect(windowRemove).toHaveBeenCalledWith('online', expect.any(Function));
      expect(windowRemove).toHaveBeenCalledWith('offline', expect.any(Function));
      expect(logger.warn).toHaveBeenCalledWith(
        'Supabase Auth 生命周期监听解绑失败，继续清理其他监听',
        expect.objectContaining({
          eventName: 'visibilitychange',
          message: 'remove visibility failed',
        }),
      );

      controller.bindLifecycle(secondSync);
      window.dispatchEvent(new Event('pageshow'));

      expect(firstSync).not.toHaveBeenCalled();
      expect(secondSync).toHaveBeenCalledWith('pageshow');
    } finally {
      controller.teardownLifecycle();
      documentRemove.mockRestore();
      windowRemove.mockRestore();
    }
  });

  it('teardownLifecycle 清理警告日志失败时仍应继续释放其余生命周期监听器', () => {
    const logger = {
      debug: vi.fn(),
      warn: vi.fn(() => {
        throw new Error('logger unavailable');
      }),
    };
    const controller = new SupabaseAuthAutoRefreshController({
      isOfflineMode: () => false,
      logger,
    });
    const sync = vi.fn();
    const documentRemove = vi
      .spyOn(document, 'removeEventListener')
      .mockImplementationOnce(() => {
        throw new Error('remove visibility failed');
      });
    const windowRemove = vi.spyOn(window, 'removeEventListener');

    try {
      controller.bindLifecycle(sync);

      expect(() => controller.teardownLifecycle()).not.toThrow();
      expect(windowRemove).toHaveBeenCalledWith('pageshow', expect.any(Function));
      expect(windowRemove).toHaveBeenCalledWith('online', expect.any(Function));
      expect(windowRemove).toHaveBeenCalledWith('offline', expect.any(Function));
    } finally {
      controller.teardownLifecycle();
      documentRemove.mockRestore();
      windowRemove.mockRestore();
    }
  });

  it('生命周期事件触发 sync 抛错时应隔离异常并允许后续事件继续触发', () => {
    const logger = {
      debug: vi.fn(),
      warn: vi.fn(),
    };
    const controller = new SupabaseAuthAutoRefreshController({
      isOfflineMode: () => false,
      logger,
    });
    const sync = vi.fn()
      .mockImplementationOnce(() => {
        throw new Error('sync failed');
      })
      .mockImplementation(() => undefined);

    try {
      controller.bindLifecycle(sync);

      expect(() => document.dispatchEvent(new Event('visibilitychange'))).not.toThrow();
      window.dispatchEvent(new Event('online'));

      expect(sync).toHaveBeenNthCalledWith(1, 'visibilitychange');
      expect(sync).toHaveBeenNthCalledWith(2, 'online');
      expect(logger.warn).toHaveBeenCalledWith(
        'Supabase Auth 生命周期事件触发失败，已跳过本次触发',
        expect.objectContaining({
          reason: 'visibilitychange',
          message: 'sync failed',
        }),
      );
    } finally {
      controller.teardownLifecycle();
      resetBrowserNetworkSuspensionTrackingForTests();
    }
  });

  it('生命周期事件触发 sync 与警告日志同时失败时仍应允许后续事件继续触发', () => {
    const logger = {
      debug: vi.fn(),
      warn: vi.fn(() => {
        throw new Error('logger unavailable');
      }),
    };
    const controller = new SupabaseAuthAutoRefreshController({
      isOfflineMode: () => false,
      logger,
    });
    const sync = vi.fn()
      .mockImplementationOnce(() => {
        throw new Error('sync failed');
      })
      .mockImplementation(() => undefined);

    try {
      controller.bindLifecycle(sync);

      expect(() => document.dispatchEvent(new Event('visibilitychange'))).not.toThrow();
      expect(() => window.dispatchEvent(new Event('online'))).not.toThrow();

      expect(sync).toHaveBeenNthCalledWith(1, 'visibilitychange');
      expect(sync).toHaveBeenNthCalledWith(2, 'online');
      expect(logger.warn).toHaveBeenCalledWith(
        'Supabase Auth 生命周期事件触发失败，已跳过本次触发',
        expect.objectContaining({
          reason: 'visibilitychange',
          message: 'sync failed',
        }),
      );
    } finally {
      controller.teardownLifecycle();
      resetBrowserNetworkSuspensionTrackingForTests();
    }
  });

  it('reset 应清理 resume timer，即使浏览器 timer handle 为 0', async () => {
    const visibilityDescriptor = Object.getOwnPropertyDescriptor(document, 'visibilityState');
    const onlineDescriptor = Object.getOwnPropertyDescriptor(Navigator.prototype, 'onLine');
    const resumeTimer = 0 as unknown as ReturnType<typeof setTimeout>;
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(() => resumeTimer);
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout').mockImplementation(() => undefined);
    const stopAutoRefresh = vi.fn().mockResolvedValue(undefined);
    const client = createClient({ stopAutoRefresh });
    const scheduleResume = vi.fn();
    const controller = new SupabaseAuthAutoRefreshController({
      isOfflineMode: () => false,
      logger: {
        debug: vi.fn(),
        warn: vi.fn(),
      },
    });

    resetBrowserNetworkSuspensionTrackingForTests();
    try {
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        value: 'visible',
      });
      Object.defineProperty(Navigator.prototype, 'onLine', {
        configurable: true,
        value: true,
      });

      ensureBrowserNetworkSuspensionTracking();
      window.dispatchEvent(new Event('online'));
      await controller.sync(client, 'online', scheduleResume);

      expect(setTimeoutSpy).toHaveBeenCalledOnce();

      controller.reset(client);

      expect(clearTimeoutSpy).toHaveBeenCalledWith(0);
      expect(scheduleResume).not.toHaveBeenCalled();
    } finally {
      resetBrowserNetworkSuspensionTrackingForTests();
      setTimeoutSpy.mockRestore();
      clearTimeoutSpy.mockRestore();
      if (visibilityDescriptor) {
        Object.defineProperty(document, 'visibilityState', visibilityDescriptor);
      } else {
        Reflect.deleteProperty(document, 'visibilityState');
      }
      if (onlineDescriptor) {
        Object.defineProperty(Navigator.prototype, 'onLine', onlineDescriptor);
      } else {
        Reflect.deleteProperty(Navigator.prototype, 'onLine');
      }
    }
  });

  it('reset 清理 resume timer 失败时不应抛错并应允许后续 sync 重新启动', async () => {
    const visibilityDescriptor = Object.getOwnPropertyDescriptor(document, 'visibilityState');
    const onlineDescriptor = Object.getOwnPropertyDescriptor(Navigator.prototype, 'onLine');
    const resumeTimer = 1 as unknown as ReturnType<typeof setTimeout>;
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(() => resumeTimer);
    const clearTimeoutSpy = vi
      .spyOn(globalThis, 'clearTimeout')
      .mockImplementationOnce(() => {
        throw new Error('clear resume timer failed');
      })
      .mockImplementation(() => undefined);
    const startAutoRefresh = vi.fn().mockResolvedValue(undefined);
    const stopAutoRefresh = vi.fn().mockResolvedValue(undefined);
    const client = createClient({ startAutoRefresh, stopAutoRefresh });
    const scheduleResume = vi.fn();
    const logger = {
      debug: vi.fn(),
      warn: vi.fn(),
    };
    const controller = new SupabaseAuthAutoRefreshController({
      isOfflineMode: () => false,
      logger,
    });

    resetBrowserNetworkSuspensionTrackingForTests();
    try {
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        value: 'visible',
      });
      Object.defineProperty(Navigator.prototype, 'onLine', {
        configurable: true,
        value: true,
      });

      ensureBrowserNetworkSuspensionTracking();
      window.dispatchEvent(new Event('online'));
      await controller.sync(client, 'online', scheduleResume);

      expect(() => controller.reset(client)).not.toThrow();

      resetBrowserNetworkSuspensionTrackingForTests();
      await controller.sync(client, 'client-init', vi.fn());

      expect(clearTimeoutSpy).toHaveBeenCalledWith(resumeTimer);
      expect(clearTimeoutSpy).toHaveBeenCalledTimes(1);
      expect(startAutoRefresh).toHaveBeenCalledTimes(1);
      expect(scheduleResume).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(
        'Supabase Auth 恢复 timer 清理失败，已继续后续流程',
        expect.objectContaining({
          message: 'clear resume timer failed',
        }),
      );
    } finally {
      resetBrowserNetworkSuspensionTrackingForTests();
      setTimeoutSpy.mockRestore();
      clearTimeoutSpy.mockRestore();
      if (visibilityDescriptor) {
        Object.defineProperty(document, 'visibilityState', visibilityDescriptor);
      } else {
        Reflect.deleteProperty(document, 'visibilityState');
      }
      if (onlineDescriptor) {
        Object.defineProperty(Navigator.prototype, 'onLine', onlineDescriptor);
      } else {
        Reflect.deleteProperty(Navigator.prototype, 'onLine');
      }
    }
  });

  it('网络恢复 grace 期间 resume timer 调度失败时 sync 不应 rejected', async () => {
    const visibilityDescriptor = Object.getOwnPropertyDescriptor(document, 'visibilityState');
    const onlineDescriptor = Object.getOwnPropertyDescriptor(Navigator.prototype, 'onLine');
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(() => {
      throw new Error('schedule resume timer failed');
    });
    const stopAutoRefresh = vi.fn().mockResolvedValue(undefined);
    const client = createClient({ stopAutoRefresh });
    const scheduleResume = vi.fn();
    const logger = {
      debug: vi.fn(),
      warn: vi.fn(),
    };
    const controller = new SupabaseAuthAutoRefreshController({
      isOfflineMode: () => false,
      logger,
    });

    resetBrowserNetworkSuspensionTrackingForTests();
    try {
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        value: 'visible',
      });
      Object.defineProperty(Navigator.prototype, 'onLine', {
        configurable: true,
        value: true,
      });

      ensureBrowserNetworkSuspensionTracking();
      window.dispatchEvent(new Event('online'));

      await expect(controller.sync(client, 'online', scheduleResume)).resolves.toBeUndefined();

      expect(stopAutoRefresh).toHaveBeenCalledTimes(1);
      expect(scheduleResume).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(
        'Supabase Auth 恢复 timer 注册失败，已等待下一次生命周期事件重试',
        expect.objectContaining({
          reason: 'online',
          message: 'schedule resume timer failed',
        }),
      );
    } finally {
      resetBrowserNetworkSuspensionTrackingForTests();
      setTimeoutSpy.mockRestore();
      if (visibilityDescriptor) {
        Object.defineProperty(document, 'visibilityState', visibilityDescriptor);
      } else {
        Reflect.deleteProperty(document, 'visibilityState');
      }
      if (onlineDescriptor) {
        Object.defineProperty(Navigator.prototype, 'onLine', onlineDescriptor);
      } else {
        Reflect.deleteProperty(Navigator.prototype, 'onLine');
      }
    }
  });

  it('reset 后应忽略迟到的 startAutoRefresh 结果，下一次 sync 仍能重新启动', async () => {
    const visibilityDescriptor = Object.getOwnPropertyDescriptor(document, 'visibilityState');
    const onlineDescriptor = Object.getOwnPropertyDescriptor(Navigator.prototype, 'onLine');
    const firstStart = createDeferred();
    const startAutoRefresh = vi.fn()
      .mockReturnValueOnce(firstStart.promise)
      .mockResolvedValue(undefined);
    const client = createClient({ startAutoRefresh });
    const controller = new SupabaseAuthAutoRefreshController({
      isOfflineMode: () => false,
      logger: {
        debug: vi.fn(),
        warn: vi.fn(),
      },
    });

    resetBrowserNetworkSuspensionTrackingForTests();
    try {
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        value: 'visible',
      });
      Object.defineProperty(Navigator.prototype, 'onLine', {
        configurable: true,
        value: true,
      });

      const firstSync = controller.sync(client, 'client-init', vi.fn());
      await waitForMockCall(startAutoRefresh, 1);

      controller.reset(client);
      firstStart.resolve();
      await firstSync;

      await controller.sync(client, 'client-init', vi.fn());

      expect(startAutoRefresh).toHaveBeenCalledTimes(2);
    } finally {
      resetBrowserNetworkSuspensionTrackingForTests();
      if (visibilityDescriptor) {
        Object.defineProperty(document, 'visibilityState', visibilityDescriptor);
      } else {
        Reflect.deleteProperty(document, 'visibilityState');
      }
      if (onlineDescriptor) {
        Object.defineProperty(Navigator.prototype, 'onLine', onlineDescriptor);
      } else {
        Reflect.deleteProperty(Navigator.prototype, 'onLine');
      }
    }
  });

  it('reset 后应忽略迟到的 startAutoRefresh 失败，避免旧 generation 误报警', async () => {
    const visibilityDescriptor = Object.getOwnPropertyDescriptor(document, 'visibilityState');
    const onlineDescriptor = Object.getOwnPropertyDescriptor(Navigator.prototype, 'onLine');
    const firstStart = createRejectableDeferred();
    const startAutoRefresh = vi.fn()
      .mockReturnValueOnce(firstStart.promise)
      .mockResolvedValue(undefined);
    const client = createClient({ startAutoRefresh });
    const logger = {
      debug: vi.fn(),
      warn: vi.fn(),
    };
    const controller = new SupabaseAuthAutoRefreshController({
      isOfflineMode: () => false,
      logger,
    });

    resetBrowserNetworkSuspensionTrackingForTests();
    try {
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        value: 'visible',
      });
      Object.defineProperty(Navigator.prototype, 'onLine', {
        configurable: true,
        value: true,
      });

      const firstSync = controller.sync(client, 'client-init', vi.fn());
      await waitForMockCall(startAutoRefresh, 1);

      controller.reset(client);
      firstStart.reject(new Error('stale start failed'));
      await firstSync;

      expect(logger.warn).not.toHaveBeenCalledWith(
        '启动 Supabase Auth 自动刷新失败',
        expect.anything(),
      );

      await controller.sync(client, 'client-init', vi.fn());
      expect(startAutoRefresh).toHaveBeenCalledTimes(2);
    } finally {
      resetBrowserNetworkSuspensionTrackingForTests();
      if (visibilityDescriptor) {
        Object.defineProperty(document, 'visibilityState', visibilityDescriptor);
      } else {
        Reflect.deleteProperty(document, 'visibilityState');
      }
      if (onlineDescriptor) {
        Object.defineProperty(Navigator.prototype, 'onLine', onlineDescriptor);
      } else {
        Reflect.deleteProperty(Navigator.prototype, 'onLine');
      }
    }
  });
});
