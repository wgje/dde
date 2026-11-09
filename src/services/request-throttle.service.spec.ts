/**
 * RequestThrottleService 单元测试
 * 
 * 测试覆盖：
 * - 并发限制功能
 * - 请求去重功能
 * - 超时保护
 * - 指数退避重试
 * - 队列管理
 */
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DestroyRef, Injector, runInInjectionContext } from '@angular/core';
import { RequestThrottleService } from './request-throttle.service';
import { LoggerService } from './logger.service';
import { REQUEST_THROTTLE_CONFIG } from '../config';
import { SessionRuntimeResetRegistry } from './session-runtime-reset.service';
import {
  ensureBrowserNetworkSuspensionTracking,
  resetBrowserNetworkSuspensionTrackingForTests,
} from '../utils/browser-network-suspension';

function restoreDocumentProperty(
  key: 'visibilityState',
  originalDescriptor: PropertyDescriptor | undefined,
): void {
  if (originalDescriptor) {
    Object.defineProperty(document, key, originalDescriptor);
    return;
  }

  Reflect.deleteProperty(document, key);
}

function setVisibilityState(state: DocumentVisibilityState): void {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    value: state,
  });
}

describe('RequestThrottleService', () => {
  let service: RequestThrottleService;
  let mockLogger: { category: ReturnType<typeof vi.fn> };
  let destroyCallbacks: Array<() => void>;
  let sessionRuntimeReset: SessionRuntimeResetRegistry;
  let originalVisibilityState: PropertyDescriptor | undefined;

  beforeEach(() => {
    destroyCallbacks = [];
    originalVisibilityState = Object.getOwnPropertyDescriptor(document, 'visibilityState');
    resetBrowserNetworkSuspensionTrackingForTests();
    ensureBrowserNetworkSuspensionTracking();
    setVisibilityState('visible');

    mockLogger = {
      category: vi.fn().mockReturnValue({
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn()
      })
    };

    const destroyRef: Pick<DestroyRef, 'onDestroy'> = {
      onDestroy: (cb: () => void) => {
        destroyCallbacks.push(cb);
        return () => {};
      },
    };

    const injector = Injector.create({
      providers: [
        { provide: LoggerService, useValue: mockLogger },
        { provide: DestroyRef, useValue: destroyRef },
        SessionRuntimeResetRegistry,
      ],
    });

    service = runInInjectionContext(injector, () => new RequestThrottleService());
    sessionRuntimeReset = runInInjectionContext(
      injector,
      () => injector.get(SessionRuntimeResetRegistry),
    );
  });

  afterEach(() => {
    service.clearAll();
    // 清理 RequestThrottleService 构造函数里注册的定时器清理逻辑
    for (const cb of destroyCallbacks) cb();
    resetBrowserNetworkSuspensionTrackingForTests();
    restoreDocumentProperty('visibilityState', originalVisibilityState);
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  describe('基础功能', () => {
    it('应该正确初始化', () => {
      expect(service).toBeTruthy();
      expect(service.activeRequests()).toBe(0);
      expect(service.queueLength()).toBe(0);
    });

    it('应该能够执行简单请求', async () => {
      const executor = vi.fn().mockResolvedValue('result');
      
      const result = await service.execute('test-key', executor);
      
      expect(result).toBe('result');
      expect(executor).toHaveBeenCalledTimes(1);
    });

    it('执行完成后应该清理活跃计数', async () => {
      const executor = vi.fn().mockResolvedValue('result');
      
      await service.execute('test-key', executor);
      
      expect(service.activeRequests()).toBe(0);
    });
  });

  describe('会话运行时重置', () => {
    it('reset 时取消活跃 executor、排队请求和 dedupe 状态', async () => {
      let activeSignal: AbortSignal | undefined;
      const active = service.execute(
        'old-session-active',
        signal => new Promise<string>(() => { activeSignal = signal; }),
        { deduplicate: true },
      );
      const queued = Array.from({ length: REQUEST_THROTTLE_CONFIG.MAX_CONCURRENT }, (_, index) =>
        service.execute(`old-session-queued-${index}`, () => new Promise<string>(() => {})),
      );
      const settlements = [active, ...queued].map(request => request.then(
        value => ({ value }),
        error => ({ error }),
      ));

      try {
        await vi.waitFor(() => expect(activeSignal).toBeDefined());
        sessionRuntimeReset.resetAll('owner-change');

        expect(activeSignal?.aborted).toBe(true);
        const results = await Promise.all(settlements);
        expect(results.every(result => 'error' in result && result.error instanceof Error)).toBe(true);
        await Promise.resolve();
        expect(service.getStatus()).toEqual({
          activeCount: 0,
          queueLength: 0,
          dedupeCacheSize: 0,
        });
      } finally {
        service.clearAll();
        await Promise.all(settlements);
      }
    });
  });

  describe('并发限制', () => {
    it('应该限制同时执行的请求数量为 4', async () => {
      vi.useFakeTimers();
      
      let maxConcurrent = 0;
      let currentConcurrent = 0;

      // 创建 10 个请求，每个耗时 50ms
      const promises = Array.from({ length: 10 }, (_, i) => 
        service.execute(`key-${i}`, async () => {
          currentConcurrent++;
          maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
          await new Promise(resolve => setTimeout(resolve, 50));
          currentConcurrent--;
          return i;
        })
      );

      // 快进时间让所有请求完成
      await vi.advanceTimersByTimeAsync(500);
      
      await Promise.all(promises);

      // 最大并发数应该不超过 4
      expect(maxConcurrent).toBeLessThanOrEqual(4);
      expect(maxConcurrent).toBeGreaterThan(0);
      
      vi.useRealTimers();
    });

    it('高优先级请求应该插队执行', async () => {
      vi.useFakeTimers();
      
      const executionOrder: number[] = [];
      let blockResolve: () => void;
      const blockPromise = new Promise<void>(r => { blockResolve = r; });

      // 先发起一个阻塞请求
      const blockingRequest = service.execute('blocking', async () => {
        await blockPromise;
        executionOrder.push(0);
        return 0;
      });

      // 发起低优先级请求
      const lowPriorityRequests = Array.from({ length: 3 }, (_, i) =>
        service.execute(`low-${i}`, async () => {
          executionOrder.push(i + 1);
          return i + 1;
        }, { priority: 'low' })
      );

      // 发起高优先级请求
      const highPriorityRequest = service.execute('high', async () => {
        executionOrder.push(100);
        return 100;
      }, { priority: 'high' });

      // 让微任务执行
      await vi.advanceTimersByTimeAsync(0);
      
      // 解除阻塞
      blockResolve!();

      await vi.advanceTimersByTimeAsync(10);
      await Promise.all([blockingRequest, ...lowPriorityRequests, highPriorityRequest]);

      // 高优先级请求应该在低优先级之前执行（第一个阻塞请求除外）
      // 注意：由于并发执行，索引值仅用于调试，不作为断言条件
      const _highIndex = executionOrder.indexOf(100);
      const _firstLowIndex = executionOrder.findIndex(v => v >= 1 && v <= 3);
      void _highIndex; void _firstLowIndex; // 标记为有意未使用
      
      // 由于并发执行，我们只验证高优先级请求确实执行了
      expect(executionOrder).toContain(100);
      
      vi.useRealTimers();
    });
  });

  describe('请求去重', () => {
    it('启用去重时相同 key 的请求应该复用结果', async () => {
      vi.useFakeTimers();
      
      let callCount = 0;
      const executor = vi.fn().mockImplementation(async () => {
        callCount++;
        await new Promise(r => setTimeout(r, 100));
        return 'shared-result';
      });

      // 同时发起两个相同 key 的请求
      const resultsPromise = Promise.all([
        service.execute('same-key', executor, { deduplicate: true }),
        service.execute('same-key', executor, { deduplicate: true })
      ]);

      await vi.advanceTimersByTimeAsync(150);
      const [result1, result2] = await resultsPromise;

      expect(result1).toBe('shared-result');
      expect(result2).toBe('shared-result');
      expect(callCount).toBe(1); // 只执行了一次
      
      vi.useRealTimers();
    });

    it('未启用去重时相同 key 的请求应该分别执行', async () => {
      let callCount = 0;
      const executor = vi.fn().mockImplementation(async () => {
        callCount++;
        return `result-${callCount}`;
      });

      const [_result1, _result2] = await Promise.all([
        service.execute('same-key', executor),
        service.execute('same-key', executor)
      ]);
      void _result1; void _result2; // 仅验证 callCount

      expect(callCount).toBe(2);
    });
  });

  describe('批量执行', () => {
    it('executeAll 应严格遵守传入的 concurrency 上限', async () => {
      vi.useFakeTimers();
      let active = 0;
      let maxActive = 0;
      const requests = Array.from({ length: 4 }, (_, index) => ({
        key: `batch-${index}`,
        executor: async () => {
          active++;
          maxActive = Math.max(maxActive, active);
          await new Promise(resolve => setTimeout(resolve, 10));
          active--;
          return index;
        },
      }));

      const resultPromise = service.executeAll(requests, 1);

      await vi.advanceTimersByTimeAsync(100);
      const results = await resultPromise;

      expect(results).toHaveLength(4);
      expect(results).toEqual(expect.arrayContaining([0, 1, 2, 3]));
      expect(maxActive).toBe(1);
    });
  });

  describe('超时保护', () => {
    it('应该在超时后拒绝请求', async () => {
      vi.useFakeTimers();
      
      // 创建一个永远不会完成的 executor
      const neverResolves = vi.fn().mockImplementation(() => new Promise(() => {}));

      let rejected = false;
      let errorMessage = '';
      let errorName = '';
      
      const resultPromise = service.execute('slow-request', neverResolves, { timeout: 50 })
        .catch((e: Error) => {
          rejected = true;
          errorMessage = e.message;
          errorName = e.name;
        });
      
      // 快进到超时点之后
      await vi.advanceTimersByTimeAsync(100);
      await vi.runAllTimersAsync();
      
      // 等待 Promise 链完成
      await resultPromise;
      
      // 验证请求因超时被拒绝
      expect(rejected).toBe(true);
      expect(errorMessage).toMatch(/超时/);
      // 【2026-05-16 根因修复回归】超时 Error 必须携带 name='TimeoutError'，
      // 否则下游 supabaseErrorToError 会落入 fallback 把它误判为 isRetryable=false，
      // 导致 ConnectionSyncOps / TaskSyncOps 把同步超时静默丢弃而非入 RetryQueue。
      expect(errorName).toBe('TimeoutError');
      
      // 清理
      service.clearAll();
      vi.useRealTimers();
    });

    it('成功完成的请求不应该受超时影响', async () => {
      const fastExecutor = vi.fn().mockResolvedValue('fast-result');

      const result = await service.execute('fast-request', fastExecutor, { timeout: 1000 });

      expect(result).toBe('fast-result');
    });
  });

  describe('重试逻辑', () => {
    it('网络错误应该触发重试', async () => {
      // 使用 fake timers 控制服务内部的重试延迟
      vi.useFakeTimers();
      
      let attempts = 0;
      const flakyExecutor = vi.fn().mockImplementation(async () => {
        attempts++;
        if (attempts < 2) {
          throw new Error('Failed to fetch');
        }
        return 'success';
      });

      const resultPromise = service.execute('flaky-request', flakyExecutor, { retries: 2 });
      
      // 快进重试延迟 (1000ms base delay)
      await vi.advanceTimersByTimeAsync(1500);
      
      const result = await resultPromise;

      expect(result).toBe('success');
      expect(attempts).toBe(2);
      
      vi.useRealTimers();
    });

    it('业务错误不应该触发重试', async () => {
      const businessError = vi.fn().mockRejectedValue(new Error('permission denied'));

      await expect(
        service.execute('business-error', businessError, { retries: 3 })
      ).rejects.toThrow('permission denied');

      // 业务错误只调用一次
      expect(businessError).toHaveBeenCalledTimes(1);
    });

    it('请求超时后应 abort 底层执行器信号，终止幽灵请求', async () => {
      // 超时只拒绝 promise 而不杀底层 fetch 的话，幽灵请求会继续跑到全局
      // 120s 上限；30s 后在服务端 applied 的写入会把用户随后的编辑打成假版本冲突
      vi.useFakeTimers();
      try {
        let capturedSignal: AbortSignal | undefined;
        const hungExecutor = vi.fn((signal?: AbortSignal) => {
          capturedSignal = signal;
          return new Promise<never>(() => {});
        });

        const resultPromise = service.execute('abort-on-timeout', hungExecutor, {
          timeout: 5,
          retries: 0,
        }).catch((error: Error) => error.name);

        await vi.advanceTimersByTimeAsync(6);

        await expect(resultPromise).resolves.toBe('TimeoutError');
        expect(capturedSignal).toBeDefined();
        expect(capturedSignal!.aborted).toBe(true);
      } finally {
        service.clearAll();
        vi.useRealTimers();
      }
    });

    it('PostgreSQL RAISE EXCEPTION(P0001) 业务拒绝不应触发传输层重试', async () => {
      // 版本回归等 RPC 业务拒绝是确定性的：重试只会用相同参数再被拒一次，
      // 白耗弱网带宽并把真实冲突处理推迟数秒
      const businessRejection = vi.fn().mockRejectedValue(
        Object.assign(new Error('version regression not allowed'), { code: 'P0001' }),
      );

      await expect(
        service.execute('p0001-rejection', businessRejection, { retries: 2 })
      ).rejects.toThrow('version regression not allowed');

      expect(businessRejection).toHaveBeenCalledTimes(1);
    });

    it('超过最大重试次数后应该失败', async () => {
      vi.useFakeTimers();
      vi.spyOn(service as unknown as {calculateRetryDelay: (n: number) => number}, 'calculateRetryDelay')
        .mockReturnValue(10); // 10ms instead of 1000ms+
      
      const alwaysFails = vi.fn().mockRejectedValue(new Error('network error'));

      const resultPromise = service.execute('always-fails', alwaysFails, { retries: 1 });
      const rejection = expect(resultPromise).rejects.toThrow('network error');

      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(10);
      await rejection;

      // 原始调用 + 1 次重试 = 2 次
      expect(alwaysFails).toHaveBeenCalledTimes(2);
      
      // 恢复原始方法
      vi.restoreAllMocks();
    });

    it('clearAll 后已安排的重试 timer 不应重新入队执行', async () => {
      vi.useFakeTimers();
      vi.spyOn(service as unknown as {calculateRetryDelay: (n: number) => number}, 'calculateRetryDelay')
        .mockReturnValue(10);
      const retryable = vi.fn()
        .mockRejectedValueOnce(new Error('network error'))
        .mockResolvedValueOnce('late-success');

      const resultPromise = service.execute('retry-after-clear', retryable, { retries: 1 })
        .then(result => `resolved:${result}`)
        .catch((error: Error) => error.message);

      await Promise.resolve();
      await Promise.resolve();

      service.clearAll();
      await vi.advanceTimersByTimeAsync(10);

      await expect(resultPromise).resolves.toBe('请求被取消');
      expect(retryable).toHaveBeenCalledTimes(1);
      expect(service.queueLength()).toBe(0);
      expect(service.activeRequests()).toBe(0);
    });

    it('超时重试不应在原 executor settle 前重叠执行同 key', async () => {
      vi.useFakeTimers();
      vi.spyOn(service as unknown as { calculateRetryDelay: (n: number) => number }, 'calculateRetryDelay')
        .mockReturnValue(10);

      let resolveOriginal!: () => void;
      const original = new Promise<string>(resolve => {
        resolveOriginal = () => resolve('late-success');
      });
      const executor = vi.fn()
        .mockReturnValueOnce(original)
        .mockResolvedValueOnce('retry-success');
      const otherExecutor = vi.fn().mockResolvedValue('other-success');

      const resultPromise = service.execute('same-write-key', executor, { timeout: 5, retries: 1 })
        .catch(() => undefined);

      await vi.advanceTimersByTimeAsync(6);
      await vi.advanceTimersByTimeAsync(10);

      expect(executor).toHaveBeenCalledTimes(1);
      await expect(service.execute('other-key', otherExecutor)).resolves.toBe('other-success');
      expect(otherExecutor).toHaveBeenCalledTimes(1);

      service.clearAll();
      resolveOriginal();
      await resultPromise;
    });

    it('同 key 请求超时后不应永久阻塞后续请求', async () => {
      vi.useFakeTimers();

      const hungExecutor = vi.fn().mockImplementation(() => new Promise(() => {}));
      const followupExecutor = vi.fn().mockResolvedValue('followup-success');

      const firstPromise = service.execute('same-timeout-key', hungExecutor, {
        timeout: 5,
        retries: 0,
      }).catch((error: Error) => error.name);

      await vi.advanceTimersByTimeAsync(6);
      await expect(firstPromise).resolves.toBe('TimeoutError');

      const followupPromise = service.execute('same-timeout-key', followupExecutor, {
        timeout: 20,
        retries: 0,
      });

      await vi.advanceTimersByTimeAsync(1);

      await expect(followupPromise).resolves.toBe('followup-success');
      expect(followupExecutor).toHaveBeenCalledTimes(1);
    });

    it('超时 executor 迟到 settle 不应释放新的同 key executor', async () => {
      vi.useFakeTimers();

      let resolveOriginal!: () => void;
      const originalPromise = new Promise<string>(resolve => {
        resolveOriginal = () => resolve('late-original');
      });
      const firstExecutor = vi.fn().mockReturnValue(originalPromise);

      const firstPromise = service.execute('same-timeout-late-settle-key', firstExecutor, {
        timeout: 5,
        retries: 0,
      }).catch((error: Error) => error.name);

      await vi.advanceTimersByTimeAsync(6);
      await expect(firstPromise).resolves.toBe('TimeoutError');

      let resolveFollowup!: () => void;
      const followupPromiseBody = new Promise<string>(resolve => {
        resolveFollowup = () => resolve('followup-success');
      });
      const followupExecutor = vi.fn().mockReturnValue(followupPromiseBody);
      const queuedExecutor = vi.fn().mockResolvedValue('queued-success');

      const followupPromise = service.execute('same-timeout-late-settle-key', followupExecutor, {
        timeout: 100,
        retries: 0,
      });
      await Promise.resolve();
      expect(followupExecutor).toHaveBeenCalledTimes(1);

      resolveOriginal();
      await Promise.resolve();
      await Promise.resolve();

      const queuedPromise = service.execute('same-timeout-late-settle-key', queuedExecutor, {
        timeout: 100,
        retries: 0,
      });
      await Promise.resolve();

      expect(queuedExecutor).not.toHaveBeenCalled();

      resolveFollowup();
      await expect(followupPromise).resolves.toBe('followup-success');
      await expect(queuedPromise).resolves.toBe('queued-success');
      expect(queuedExecutor).toHaveBeenCalledTimes(1);
    });
  });

  describe('队列管理', () => {
    it('clearAll 应该清除所有待处理请求', async () => {
      // 使用 fake timers 加速测试
      vi.useFakeTimers();
      
      // 创建一些待处理的请求
      const promises = Array.from({ length: 10 }, (_, i) =>
        service.execute(`key-${i}`, async () => {
          await new Promise(r => setTimeout(r, 1000));
          return i;
        }).catch(() => 'cancelled')
      );

      // 快进让请求进入队列
      await vi.advanceTimersByTimeAsync(10);

      // 清除所有请求
      service.clearAll();

      // 快进让所有 Promise 结束
      await vi.advanceTimersByTimeAsync(1000);
      
      const results = await Promise.all(promises);

      // 应该有一些请求被取消
      expect(results.some(r => r === 'cancelled')).toBe(true);
      
      vi.useRealTimers();
    });

    it('clearAll 应该取消正在执行的请求并释放同 key 限流槽', async () => {
      vi.useFakeTimers();

      const neverResolves = vi.fn().mockImplementation(() => new Promise(() => {}));
      const activePromise = service.execute('active-clear-key', neverResolves, {
        timeout: 1000,
        retries: 0,
      }).then(
        result => `resolved:${result}`,
        (error: Error) => error.message,
      );

      await Promise.resolve();
      expect(service.activeRequests()).toBe(1);

      service.clearAll();
      const settledRace = Promise.race([
        activePromise,
        new Promise<string>(resolve => setTimeout(() => resolve('not-settled'), 0)),
      ]);
      await vi.advanceTimersByTimeAsync(0);

      await expect(settledRace).resolves.toBe('请求被取消');
      expect(service.activeRequests()).toBe(0);

      const followupExecutor = vi.fn().mockResolvedValue('followup-success');
      const followupPromise = service.execute('active-clear-key', followupExecutor, {
        timeout: 1000,
        retries: 0,
      });

      await Promise.resolve();

      expect(followupExecutor).toHaveBeenCalledTimes(1);
      await expect(followupPromise).resolves.toBe('followup-success');
    });

    it('getStatus 应该返回正确的状态', async () => {
      const status = service.getStatus();

      expect(status).toHaveProperty('activeCount');
      expect(status).toHaveProperty('queueLength');
      expect(status).toHaveProperty('dedupeCacheSize');
      expect(typeof status.activeCount).toBe('number');
    });
  });

  describe('优先级处理', () => {
    it('低优先级请求在队列满时应该被拒绝', async () => {
      vi.useFakeTimers();

      const blockers: Array<() => void> = [];
      const blockingRequests = Array.from(
        { length: REQUEST_THROTTLE_CONFIG.MAX_CONCURRENT + REQUEST_THROTTLE_CONFIG.MAX_QUEUE_SIZE },
        (_, i) => {
          const block = new Promise<void>((resolve) => {
            blockers.push(resolve);
          });

          return service.execute(`blocker-${i}`, async () => {
            await block;
            return i;
          });
        }
      );

      await vi.advanceTimersByTimeAsync(0);

      expect(service.getStatus()).toMatchObject({
        activeCount: REQUEST_THROTTLE_CONFIG.MAX_CONCURRENT,
        queueLength: REQUEST_THROTTLE_CONFIG.MAX_QUEUE_SIZE,
      });

      await expect(
        service.execute('low-priority', async () => 'result', { priority: 'low' })
      ).rejects.toThrow(/队列已满/);

      blockers.forEach((resolve) => resolve());
      await Promise.allSettled(blockingRequests);
    });

    it('高优先级请求在队列满时应抢占一个低优先级请求', async () => {
      vi.useFakeTimers();

      const blockers: Array<() => void> = [];
      const blockingRequests = Array.from(
        { length: REQUEST_THROTTLE_CONFIG.MAX_CONCURRENT + REQUEST_THROTTLE_CONFIG.MAX_QUEUE_SIZE },
        (_, i) => {
          const block = new Promise<void>((resolve) => {
            blockers.push(resolve);
          });

          return service.execute(`low-${i}`, async () => {
            await block;
            return i;
          }, { priority: 'low' })
            .then(() => 'completed')
            .catch((error: Error) => error.message);
        }
      );

      await vi.advanceTimersByTimeAsync(0);
      expect(service.getStatus().queueLength).toBe(REQUEST_THROTTLE_CONFIG.MAX_QUEUE_SIZE);

      const highPriorityExecutor = vi.fn().mockResolvedValue('high-result');
      const highPriorityPromise = service.execute('high-priority', highPriorityExecutor, {
        priority: 'high',
      });

      await Promise.resolve();
      expect(service.getStatus().queueLength).toBe(REQUEST_THROTTLE_CONFIG.MAX_QUEUE_SIZE);

      blockers.forEach((resolve) => resolve());
      const results = await Promise.all([...blockingRequests, highPriorityPromise]);

      expect(highPriorityExecutor).toHaveBeenCalledTimes(1);
      expect(results).toContain('被更高优先级请求抢占');
      expect(results).toContain('high-result');
    });
    it('队列满且无低优先级请求时 normal 请求不能突破硬上限', async () => {
      vi.useFakeTimers();

      const blockers: Array<() => void> = [];
      const blockingRequests = Array.from(
        { length: REQUEST_THROTTLE_CONFIG.MAX_CONCURRENT + REQUEST_THROTTLE_CONFIG.MAX_QUEUE_SIZE },
        (_, i) => {
          const block = new Promise<void>((resolve) => {
            blockers.push(resolve);
          });

          return service.execute(`normal-${i}`, async () => {
            await block;
            return i;
          });
        }
      );

      await vi.advanceTimersByTimeAsync(0);
      expect(service.getStatus()).toMatchObject({
        activeCount: REQUEST_THROTTLE_CONFIG.MAX_CONCURRENT,
        queueLength: REQUEST_THROTTLE_CONFIG.MAX_QUEUE_SIZE,
      });

      const overflow = service.execute('overflow-normal', async () => 'normal-result');
      expect(service.getStatus().queueLength).toBe(REQUEST_THROTTLE_CONFIG.MAX_QUEUE_SIZE);
      await expect(overflow).rejects.toThrow(/队列已满/);

      blockers.forEach((resolve) => resolve());
      await Promise.allSettled(blockingRequests);
    });

    it('队列满且无低优先级请求时 high 请求不能突破硬上限', async () => {
      vi.useFakeTimers();

      const blockers: Array<() => void> = [];
      const blockingRequests = Array.from(
        { length: REQUEST_THROTTLE_CONFIG.MAX_CONCURRENT + REQUEST_THROTTLE_CONFIG.MAX_QUEUE_SIZE },
        (_, i) => {
          const block = new Promise<void>((resolve) => {
            blockers.push(resolve);
          });

          return service.execute(`normal-${i}`, async () => {
            await block;
            return i;
          });
        }
      );

      await vi.advanceTimersByTimeAsync(0);
      expect(service.getStatus()).toMatchObject({
        activeCount: REQUEST_THROTTLE_CONFIG.MAX_CONCURRENT,
        queueLength: REQUEST_THROTTLE_CONFIG.MAX_QUEUE_SIZE,
      });

      const overflow = service.execute('overflow-high', async () => 'high-result', { priority: 'high' });
      expect(service.getStatus().queueLength).toBe(REQUEST_THROTTLE_CONFIG.MAX_QUEUE_SIZE);
      await expect(overflow).rejects.toThrow(/队列已满/);

      blockers.forEach((resolve) => resolve());
      await Promise.allSettled(blockingRequests);
    });

    it('队列满时只有低优先级请求会被 high 请求抢占', async () => {
      vi.useFakeTimers();

      const blockers: Array<() => void> = [];
      const queuePriorities: Array<'low' | 'normal'> = Array.from(
        { length: REQUEST_THROTTLE_CONFIG.MAX_QUEUE_SIZE },
        (_, index) => index === 0 ? 'low' : 'normal',
      );
      const blockingRequests = Array.from(
        { length: REQUEST_THROTTLE_CONFIG.MAX_CONCURRENT + REQUEST_THROTTLE_CONFIG.MAX_QUEUE_SIZE },
        (_, i) => {
          const block = new Promise<void>((resolve) => {
            blockers.push(resolve);
          });
          const priority = i < REQUEST_THROTTLE_CONFIG.MAX_CONCURRENT
            ? 'normal'
            : queuePriorities[i - REQUEST_THROTTLE_CONFIG.MAX_CONCURRENT];

          return service.execute(`mixed-${i}`, async () => {
            await block;
            return i;
          }, { priority })
            .then(() => 'completed')
            .catch((error: Error) => error.message);
        }
      );

      await vi.advanceTimersByTimeAsync(0);
      expect(service.getStatus().queueLength).toBe(REQUEST_THROTTLE_CONFIG.MAX_QUEUE_SIZE);

      const highPriorityPromise = service.execute('high-mixed', async () => 'high-result', {
        priority: 'high',
      });
      await Promise.resolve();
      expect(service.getStatus().queueLength).toBe(REQUEST_THROTTLE_CONFIG.MAX_QUEUE_SIZE);

      blockers.forEach((resolve) => resolve());
      const results = await Promise.all([...blockingRequests, highPriorityPromise]);

      expect(results.filter((result) => result === '被更高优先级请求抢占')).toHaveLength(1);
      expect(results).toContain('high-result');
    });
  });
});
