import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { Injector, runInInjectionContext } from '@angular/core';

import { SyncWriterLeaseService } from './sync-writer-lease.service';
import { LoggerService } from './logger.service';
import { SentryLazyLoaderService } from './sentry-lazy-loader.service';
import { environment } from '../environments/environment';

const mockLoggerCategory = {
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

const mockLogger = {
  category: () => mockLoggerCategory,
} as unknown as LoggerService;
const mockSentry = {
  addBreadcrumb: vi.fn(),
};

interface MutableEnv {
  syncLeaseEnabled?: boolean;
  sentryEnvironment?: string;
}

function buildService(): SyncWriterLeaseService {
  const injector = Injector.create({
    providers: [
      { provide: LoggerService, useValue: mockLogger },
      { provide: SentryLazyLoaderService, useValue: mockSentry },
    ],
  });
  return runInInjectionContext(injector, () => new SyncWriterLeaseService());
}

describe('SyncWriterLeaseService', () => {
  let originalLeaseEnabled: boolean | undefined;
  let originalLocksDescriptor: PropertyDescriptor | undefined;

  function setLocks(value: unknown): void {
    Object.defineProperty(navigator, 'locks', {
      value,
      configurable: true,
      writable: true,
    });
  }

  function deleteLocks(): void {
    Object.defineProperty(navigator, 'locks', {
      value: undefined,
      configurable: true,
      writable: true,
    });
  }

  function installFailingIndexedDb(message = 'idb unavailable'): unknown {
    const globalWithIndexedDb = globalThis as { indexedDB?: unknown };
    const originalIndexedDb = globalWithIndexedDb.indexedDB;
    globalWithIndexedDb.indexedDB = {
      open: () => {
        const req: {
          result: unknown;
          error: Error | null;
          onerror: (() => void) | null;
          onsuccess: (() => void) | null;
          onupgradeneeded: (() => void) | null;
        } = {
          result: null,
          error: new Error(message),
          onerror: null,
          onsuccess: null,
          onupgradeneeded: null,
        };
        Promise.resolve().then(() => req.onerror?.());
        return req;
      },
    };
    return originalIndexedDb;
  }

  function installLeaseIndexedDb(
    options: {
      failDelete?: boolean;
      failHeartbeatGetsForFirstConnection?: boolean;
      failNextGetAfterAcquire?: boolean;
    } = {},
  ): {
    originalIndexedDb: unknown;
    close: ReturnType<typeof vi.fn>;
    stealLease: (lockName: string) => void;
    transaction: ReturnType<typeof vi.fn>;
  } {
    const globalWithIndexedDb = globalThis as { indexedDB?: unknown };
    const originalIndexedDb = globalWithIndexedDb.indexedDB;
    const records = new Map<string, unknown>();
    const connectionStates: Array<{
      acquiredLease: boolean;
      failNextGetAfterPut: boolean;
      shouldFailNextGet: boolean;
    }> = [];
    const close = vi.fn();
    const transaction = vi.fn();

    const createObjectStore = (connectionIndex: number) => ({
      get: (key: string) => {
        const state = connectionStates[connectionIndex];
        const shouldFailGet = state.shouldFailNextGet || (
          connectionIndex === 0 &&
          state.acquiredLease &&
          options.failHeartbeatGetsForFirstConnection === true
        );
        state.shouldFailNextGet = false;
        const req: {
          result: unknown;
          error: Error | null;
          onsuccess: (() => void) | null;
          onerror: (() => void) | null;
        } = {
          result: shouldFailGet ? undefined : records.get(key),
          error: shouldFailGet ? new Error('heartbeat failed') : null,
          onsuccess: null,
          onerror: null,
        };
        Promise.resolve().then(() => {
          if (shouldFailGet) {
            req.onerror?.();
            return;
          }
          req.onsuccess?.();
        });
        return req;
      },
      put: (value: unknown, key: string) => {
        const state = connectionStates[connectionIndex];
        const req: {
          result: undefined;
          error: Error | null;
          onsuccess: (() => void) | null;
          onerror: (() => void) | null;
        } = {
          result: undefined,
          error: null,
          onsuccess: null,
          onerror: null,
        };
        Promise.resolve().then(() => {
          records.set(key, value);
          state.acquiredLease = true;
          if (state.failNextGetAfterPut) {
            state.shouldFailNextGet = true;
            state.failNextGetAfterPut = false;
          }
          req.onsuccess?.();
        });
        return req;
      },
      delete: (key: string) => {
        const req: {
          result: undefined;
          error: Error | null;
          onsuccess: (() => void) | null;
          onerror: (() => void) | null;
        } = {
          result: undefined,
          error: options.failDelete ? new Error('release failed') : null,
          onsuccess: null,
          onerror: null,
        };
        Promise.resolve().then(() => {
          if (options.failDelete) {
            req.onerror?.();
            return;
          }
          records.delete(key);
          req.onsuccess?.();
        });
        return req;
      },
    });
    globalWithIndexedDb.indexedDB = {
      open: () => {
        const connectionIndex = connectionStates.length;
        connectionStates.push({
          acquiredLease: false,
          failNextGetAfterPut:
            connectionIndex === 0 && options.failNextGetAfterAcquire === true,
          shouldFailNextGet: false,
        });
        const objectStore = createObjectStore(connectionIndex);
        const db = {
          objectStoreNames: { contains: () => true },
          createObjectStore: vi.fn(),
          transaction: (...args: unknown[]) => {
            transaction(...args);
            return { objectStore: () => objectStore };
          },
          close,
        };
        const req: {
          result: unknown;
          error: Error | null;
          onerror: (() => void) | null;
          onsuccess: (() => void) | null;
          onupgradeneeded: (() => void) | null;
        } = {
          result: db,
          error: null,
          onerror: null,
          onsuccess: null,
          onupgradeneeded: null,
        };
        Promise.resolve().then(() => req.onsuccess?.());
        return req;
      },
    };
    return {
      originalIndexedDb,
      close,
      stealLease: (lockName: string) => {
        const existing = records.get(lockName) as {
          ownerTabId?: string;
          expiresAt?: number;
          lastHeartbeatAt?: number;
          acquiredAt?: number;
        } | undefined;
        records.set(lockName, {
          ...existing,
          ownerTabId: 'other-tab',
          expiresAt: Date.now() + 15_000,
          lastHeartbeatAt: Date.now(),
          acquiredAt: existing?.acquiredAt ?? Date.now(),
        });
      },
      transaction,
    };
  }

  function restoreIndexedDb(originalIndexedDb: unknown): void {
    (globalThis as { indexedDB?: unknown }).indexedDB = originalIndexedDb;
  }

  beforeEach(() => {
    mockLoggerCategory.info.mockReset();
    mockLoggerCategory.warn.mockReset();
    mockLoggerCategory.debug.mockReset();
    mockSentry.addBreadcrumb.mockReset();
    const env = environment as unknown as MutableEnv;
    originalLeaseEnabled = env.syncLeaseEnabled;
    originalLocksDescriptor = Object.getOwnPropertyDescriptor(navigator, 'locks');
  });

  afterEach(() => {
    const env = environment as unknown as MutableEnv;
    env.syncLeaseEnabled = originalLeaseEnabled;
    if (originalLocksDescriptor) {
      Object.defineProperty(navigator, 'locks', originalLocksDescriptor);
    } else {
      try { deleteLocks(); } catch { /* ignore */ }
    }
  });

  it('feature flag 关闭时返回 noop lease（mode=memory-only），保持向后兼容', async () => {
    const env = environment as unknown as MutableEnv;
    env.syncLeaseEnabled = false;

    const service = buildService();
    const lease = await service.requestLease({ userId: 'user-1', projectId: 'project-1' });

    expect(lease.mode).toBe('memory-only');
    expect(lease.tabId).toBeTruthy();
    expect(service.isHolder()).toBe(true);
    await lease.release();
    expect(service.isHolder()).toBe(false);
  });

  it('lockName 包含环境 / userId / projectId（按 origin 隔离）', async () => {
    const env = environment as unknown as MutableEnv;
    env.syncLeaseEnabled = false;
    env.sentryEnvironment = 'preview';

    const service = buildService();
    const lease = await service.requestLease({ userId: 'u', projectId: 'p' });

    expect(lease.lockName).toBe('nanoflow-sync:preview:u:p');
    await lease.release();
  });

  it('feature flag 开启 + Web Locks 可用时优先走 Web Locks', async () => {
    const env = environment as unknown as MutableEnv;
    env.syncLeaseEnabled = true;

    // 模拟 Web Locks API：request 在 callback 内 invoke 一次。
    const requestFn = vi.fn(async (
      _name: string,
      _opts: { signal?: AbortSignal },
      callback: () => Promise<unknown>,
    ) => {
      await callback();
    });
    setLocks({ request: requestFn });

    const service = buildService();
    const lease = await service.requestLease({ userId: 'u', projectId: 'p' });

    expect(lease.mode).toBe('weblocks');
    expect(requestFn).toHaveBeenCalledTimes(1);
    expect(mockSentry.addBreadcrumb).toHaveBeenCalledWith(expect.objectContaining({
      category: 'sync.lease',
      message: 'sync_writer_lease_acquired',
      data: expect.objectContaining({ mode: 'weblocks' }),
    }));
    await lease.release();
    expect(service.isHolder()).toBe(false);
    expect(mockSentry.addBreadcrumb).toHaveBeenCalledWith(expect.objectContaining({
      category: 'sync.lease',
      message: 'sync_writer_lease_released',
      data: expect.objectContaining({ mode: 'weblocks' }),
    }));
  });

  it('未显式配置 feature flag 时默认启用 single-writer lease', async () => {
    const env = environment as unknown as MutableEnv;
    delete env.syncLeaseEnabled;

    const requestFn = vi.fn(async (
      _name: string,
      _opts: { signal?: AbortSignal },
      callback: () => Promise<unknown>,
    ) => {
      await callback();
    });
    setLocks({ request: requestFn });

    const service = buildService();
    expect(service.isFeatureEnabled()).toBe(true);

    const lease = await service.requestLease({ userId: 'u', projectId: 'p' });

    expect(lease.mode).toBe('weblocks');
    expect(requestFn).toHaveBeenCalledTimes(1);
    await lease.release();
  });

  it('feature 开启时禁止重入：同实例必须 release 才能再次 requestLease', async () => {
    const env = environment as unknown as MutableEnv;
    env.syncLeaseEnabled = true;
    const requestFn = vi.fn(async (
      _name: string,
      _opts: { signal?: AbortSignal },
      callback: () => Promise<unknown>,
    ) => { await callback(); });
    setLocks({ request: requestFn });

    const service = buildService();
    const first = await service.requestLease({ userId: 'u', projectId: 'p' });

    await expect(
      service.requestLease({ userId: 'u', projectId: 'p' })
    ).rejects.toThrow(/已持有 lease/);

    await first.release();
  });

  it('Web Locks 不可用时降级（feature 开启 + 无 navigator.locks 时走 IDB 路径，但 IDB 不可用时回到 memory-only）', async () => {
    const env = environment as unknown as MutableEnv;
    env.syncLeaseEnabled = true;
    deleteLocks();

    // 不提供 indexedDB 时 openLeaseDb 会 reject —— 服务应回到 memory-only。
    const originalIndexedDb = (globalThis as { indexedDB?: unknown }).indexedDB;
    (globalThis as { indexedDB?: unknown }).indexedDB = {
      open: () => {
        const req: { result: unknown; error: Error | null; onerror: (() => void) | null; onsuccess: (() => void) | null; onupgradeneeded: (() => void) | null } = {
          result: null, error: new Error('idb unavailable'), onerror: null, onsuccess: null, onupgradeneeded: null,
        };
        Promise.resolve().then(() => req.onerror?.());
        return req;
      },
    };

    try {
      const service = buildService();
      const lease = await service.requestLease({ userId: 'u', projectId: 'p' });
      expect(lease.mode).toBe('memory-only');
      expect(mockLoggerCategory.warn).toHaveBeenCalled();
      expect(mockSentry.addBreadcrumb).toHaveBeenCalledWith(expect.objectContaining({
        category: 'sync.lease',
        level: 'warning',
        message: 'sync_writer_lease_fallback',
        data: expect.objectContaining({ mode: 'memory-only' }),
      }));
      await lease.release();
    } finally {
      (globalThis as { indexedDB?: unknown }).indexedDB = originalIndexedDb;
    }
  });

  it('IDB 降级路径的日志失败时仍返回 memory-only lease', async () => {
    const env = environment as unknown as MutableEnv;
    env.syncLeaseEnabled = true;
    deleteLocks();
    const originalIndexedDb = installFailingIndexedDb();
    mockLoggerCategory.warn.mockImplementationOnce(() => {
      throw new Error('logger failed');
    });

    try {
      const service = buildService();
      const lease = await service.requestLease({ userId: 'u', projectId: 'p' });

      expect(lease.mode).toBe('memory-only');
      expect(service.isHolder()).toBe(true);
      await lease.release();
      expect(service.isHolder()).toBe(false);
    } finally {
      restoreIndexedDb(originalIndexedDb);
    }
  });

  it('IDB 降级和 memory-only release 的 breadcrumb 失败时仍完成 lease 生命周期', async () => {
    const env = environment as unknown as MutableEnv;
    env.syncLeaseEnabled = true;
    deleteLocks();
    const originalIndexedDb = installFailingIndexedDb();
    mockSentry.addBreadcrumb.mockImplementationOnce(() => {
      throw new Error('breadcrumb failed');
    });

    try {
      const service = buildService();
      const lease = await service.requestLease({ userId: 'u', projectId: 'p' });

      expect(lease.mode).toBe('memory-only');
      expect(service.isHolder()).toBe(true);
      mockSentry.addBreadcrumb.mockImplementationOnce(() => {
        throw new Error('release breadcrumb failed');
      });
      await expect(lease.release()).resolves.toBeUndefined();
      expect(service.isHolder()).toBe(false);
    } finally {
      restoreIndexedDb(originalIndexedDb);
    }
  });

  it('Web Locks 降级路径的 breadcrumb 失败时仍继续回退到 memory-only lease', async () => {
    const env = environment as unknown as MutableEnv;
    env.syncLeaseEnabled = true;
    const requestFn = vi.fn(async () => {
      throw new Error('weblocks unavailable');
    });
    setLocks({ request: requestFn });
    const originalIndexedDb = installFailingIndexedDb();
    mockSentry.addBreadcrumb.mockImplementationOnce(() => {
      throw new Error('breadcrumb failed');
    });

    try {
      const service = buildService();
      const lease = await service.requestLease({ userId: 'u', projectId: 'p' });

      expect(requestFn).toHaveBeenCalledTimes(1);
      expect(lease.mode).toBe('memory-only');
      await lease.release();
      expect(service.isHolder()).toBe(false);
    } finally {
      restoreIndexedDb(originalIndexedDb);
    }
  });

  it('IDB lease 释放失败时清理本地持有状态并保留释放错误', async () => {
    const env = environment as unknown as MutableEnv;
    env.syncLeaseEnabled = true;
    deleteLocks();
    const idb = installLeaseIndexedDb({ failDelete: true });

    try {
      const service = buildService();
      const lease = await service.requestLease({ userId: 'u', projectId: 'p' });

      expect(lease.mode).toBe('idb-lease');
      expect(service.isHolder()).toBe(true);
      await expect(lease.release()).rejects.toThrow('release failed');
      expect(service.isHolder()).toBe(false);
      expect(idb.close).toHaveBeenCalledTimes(1);
    } finally {
      restoreIndexedDb(idb.originalIndexedDb);
    }
  });

  it('heartbeat 失败后的 debug 日志异常不产生未处理异步错误', async () => {
    vi.useFakeTimers();
    const env = environment as unknown as MutableEnv;
    env.syncLeaseEnabled = true;
    deleteLocks();
    const idb = installLeaseIndexedDb({ failNextGetAfterAcquire: true });
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mockLoggerCategory.debug.mockImplementationOnce(() => {
      throw new Error('debug failed');
    });

    try {
      const service = buildService();
      const lease = await service.requestLease({ userId: 'u', projectId: 'p' });

      expect(lease.mode).toBe('idb-lease');
      await vi.advanceTimersByTimeAsync(5_000);
      expect(mockLoggerCategory.debug).toHaveBeenCalledWith('lease_heartbeat_failed: heartbeat failed');
      expect(consoleErrorSpy.mock.calls.some(args => args.some(arg => (
        arg instanceof Error
          ? arg.message === 'debug failed'
          : String(arg).includes('debug failed')
      )))).toBe(false);
      expect(service.isHolder()).toBe(true);
      await lease.release();
      expect(service.isHolder()).toBe(false);
      expect(idb.close).toHaveBeenCalledTimes(1);
    } finally {
      restoreIndexedDb(idb.originalIndexedDb);
      consoleErrorSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('heartbeat 连续异常达到 TTL 后应撤销第一实例并允许第二实例接管', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const env = environment as unknown as MutableEnv;
    env.syncLeaseEnabled = true;
    deleteLocks();
    const idb = installLeaseIndexedDb({ failHeartbeatGetsForFirstConnection: true });
    let firstLease: Awaited<ReturnType<SyncWriterLeaseService['requestLease']>> | null = null;
    let secondLease: Awaited<ReturnType<SyncWriterLeaseService['requestLease']>> | null = null;

    try {
      const firstService = buildService();
      firstLease = await firstService.requestLease({
        userId: 'u',
        projectId: 'p',
        ttlMs: 10_000,
      });

      await vi.advanceTimersByTimeAsync(5_000);

      expect(firstService.isHolder()).toBe(true);
      expect(firstLease.signal?.aborted).toBe(false);

      await vi.advanceTimersByTimeAsync(5_000);
      const secondService = buildService();
      secondLease = await secondService.requestLease({
        userId: 'u',
        projectId: 'p',
        ttlMs: 10_000,
      });

      expect(secondLease.mode).toBe('idb-lease');
      expect(secondService.isHolder()).toBe(true);
      expect(firstLease.signal?.aborted).toBe(true);
      expect(firstService.isHolder()).toBe(false);
      expect(firstService.currentMode()).toBeNull();
    } finally {
      await firstLease?.release().catch(() => undefined);
      await secondLease?.release().catch(() => undefined);
      vi.clearAllTimers();
      restoreIndexedDb(idb.originalIndexedDb);
      vi.useRealTimers();
    }
  });

  it('IDB lease 被其他标签页抢占后应立即撤销本地持有状态并停止心跳', async () => {
    vi.useFakeTimers();
    const env = environment as unknown as MutableEnv;
    env.syncLeaseEnabled = true;
    deleteLocks();
    const idb = installLeaseIndexedDb();

    try {
      const service = buildService();
      const lease = await service.requestLease({ userId: 'u', projectId: 'p' });
      const leaseSignal = (lease as typeof lease & { signal?: AbortSignal }).signal;
      expect(lease.mode).toBe('idb-lease');
      expect(service.isHolder()).toBe(true);
      expect(leaseSignal?.aborted).toBe(false);

      idb.stealLease(lease.lockName);
      await vi.advanceTimersByTimeAsync(5_000);

      expect(service.isHolder()).toBe(false);
      expect(leaseSignal?.aborted).toBe(true);
      expect(idb.close).toHaveBeenCalledTimes(1);
      expect(mockSentry.addBreadcrumb).toHaveBeenCalledWith(expect.objectContaining({
        category: 'sync.lease',
        level: 'warning',
        message: 'sync_writer_lease_lost',
      }));

      const transactionCountAfterLoss = idb.transaction.mock.calls.length;
      await vi.advanceTimersByTimeAsync(10_000);
      expect(idb.transaction).toHaveBeenCalledTimes(transactionCountAfterLoss);

      await expect(lease.release()).resolves.toBeUndefined();
      expect(idb.close).toHaveBeenCalledTimes(1);
    } finally {
      restoreIndexedDb(idb.originalIndexedDb);
      vi.useRealTimers();
    }
  });

  it('等待 IDB lease 时 abort 应关闭未转移给 handle 的数据库连接', async () => {
    const env = environment as unknown as MutableEnv;
    env.syncLeaseEnabled = true;
    deleteLocks();
    const idb = installLeaseIndexedDb();
    const controller = new AbortController();
    idb.stealLease(`nanoflow-sync:${env.sentryEnvironment ?? 'unknown'}:u:p`);

    try {
      const service = buildService();
      const leasePromise = service.requestLease({
        userId: 'u',
        projectId: 'p',
        signal: controller.signal,
      });
      await Promise.resolve();
      await Promise.resolve();

      controller.abort();

      await expect(leasePromise).rejects.toMatchObject({ name: 'AbortError' });
      expect(idb.close).toHaveBeenCalledTimes(1);
      expect(service.isHolder()).toBe(false);
    } finally {
      restoreIndexedDb(idb.originalIndexedDb);
    }
  });

  it('sleepWithAbort 定时完成后应移除 abort listener', async () => {
    vi.useFakeTimers();
    const service = buildService();
    const controller = new AbortController();
    const addListenerSpy = vi.spyOn(controller.signal, 'addEventListener');
    const removeListenerSpy = vi.spyOn(controller.signal, 'removeEventListener');

    try {
      const sleeping = (service as unknown as {
        sleepWithAbort: (ms: number, signal: AbortSignal) => Promise<void>;
      }).sleepWithAbort(500, controller.signal);
      await vi.advanceTimersByTimeAsync(500);
      await sleeping;

      expect(addListenerSpy).toHaveBeenCalledWith('abort', expect.any(Function), { once: true });
      expect(removeListenerSpy).toHaveBeenCalledWith('abort', expect.any(Function));
    } finally {
      vi.useRealTimers();
    }
  });

  it('sleepWithAbort 收到已 abort 的 signal 时应立即返回且不创建 timer', async () => {
    const service = buildService();
    const controller = new AbortController();
    controller.abort();
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

    try {
      await (service as unknown as {
        sleepWithAbort: (ms: number, signal: AbortSignal) => Promise<void>;
      }).sleepWithAbort(500, controller.signal);

      expect(setTimeoutSpy).not.toHaveBeenCalled();
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  it('signal abort 时 reject(AbortError)（Web Locks 路径转发）', async () => {
    const env = environment as unknown as MutableEnv;
    env.syncLeaseEnabled = true;

    const requestFn = vi.fn(async (
      _name: string,
      opts: { signal?: AbortSignal },
    ) => {
      // 模拟 Web Locks 在 abort 时 reject AbortError
      return new Promise((_, reject) => {
        opts.signal?.addEventListener('abort', () => {
          reject(new DOMException('AbortError', 'AbortError'));
        }, { once: true });
      });
    });
    setLocks({ request: requestFn });

    const service = buildService();
    const controller = new AbortController();
    const leasePromise = service.requestLease({
      userId: 'u',
      projectId: 'p',
      signal: controller.signal,
    });
    controller.abort();

    await expect(leasePromise).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('feature flag 关闭时 isFeatureEnabled signal 为 false', () => {
    const env = environment as unknown as MutableEnv;
    env.syncLeaseEnabled = false;
    const service = buildService();
    expect(service.isFeatureEnabled()).toBe(false);
  });

  it('feature flag 开启时 isFeatureEnabled signal 为 true', () => {
    const env = environment as unknown as MutableEnv;
    env.syncLeaseEnabled = true;
    const service = buildService();
    expect(service.isFeatureEnabled()).toBe(true);
  });
});
