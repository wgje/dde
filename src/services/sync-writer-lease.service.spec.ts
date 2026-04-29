import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { Injector, runInInjectionContext } from '@angular/core';

import { SyncWriterLeaseService } from './sync-writer-lease.service';
import { LoggerService } from './logger.service';
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

interface MutableEnv {
  syncLeaseEnabled?: boolean;
  sentryEnvironment?: string;
}

function buildService(): SyncWriterLeaseService {
  const injector = Injector.create({
    providers: [{ provide: LoggerService, useValue: mockLogger }],
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

  beforeEach(() => {
    mockLoggerCategory.info.mockReset();
    mockLoggerCategory.warn.mockReset();
    mockLoggerCategory.debug.mockReset();
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
    await lease.release();
    expect(service.isHolder()).toBe(false);
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
      await lease.release();
    } finally {
      (globalThis as { indexedDB?: unknown }).indexedDB = originalIndexedDb;
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
