import { expect, it, vi } from 'vitest';

import type { Connection } from '../../../../models';
import {
  createBrowserNetworkSuspendedError,
  isBrowserNetworkSuspendedWindow,
} from '../../../../utils/browser-network-suspension';
import { createRetryDeferredError } from '../../../../utils/retry-deferred-error';
import type { RetryQueueCapacityAndSliceSpecContext } from './retry-queue-capacity-and-slice.spec-helpers';

type MockFn = ReturnType<typeof vi.fn>;

export function registerRetryQueueSliceSpecs(
  getContext: () => RetryQueueCapacityAndSliceSpecContext,
): void {
  it('processQueueSlice 应按 maxItems 切片并返回未完成状态', async () => {
    const { service, handler, setOnline, createTask } = getContext();
    service.add('task', 'upsert', createTask('slice-1'), 'p-1', undefined, undefined, 'task_full_upsert');
    service.add('task', 'upsert', createTask('slice-2'), 'p-1', undefined, undefined, 'task_full_upsert');
    service.add('task', 'upsert', createTask('slice-3'), 'p-1', undefined, undefined, 'task_full_upsert');
    setOnline(true);

    const result = await service.processQueueSlice({ maxItems: 2, maxDurationMs: 1000 });

    expect(result.processed).toBe(2);
    expect(result.completed).toBe(false);
    expect(result.remaining).toBe(1);
    expect(handler.pushTask).toHaveBeenCalledTimes(2);
  });

  it('processQueueSlice 应按 maxDurationMs 切片并可续跑完成', async () => {
    const { service, handler, setOnline, createTask } = getContext();
    let fakeNow = 1000;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => fakeNow);
    (handler.pushTask as MockFn).mockImplementation(async () => {
      fakeNow += 220;
      return true;
    });

    service.add('task', 'upsert', createTask('budget-1'), 'p-1', undefined, undefined, 'task_full_upsert');
    service.add('task', 'upsert', createTask('budget-2'), 'p-1', undefined, undefined, 'task_full_upsert');
    service.add('task', 'upsert', createTask('budget-3'), 'p-1', undefined, undefined, 'task_full_upsert');
    setOnline(true);

    const first = await service.processQueueSlice({ maxItems: 30, maxDurationMs: 150 });
    expect(first.processed).toBe(1);
    expect(first.completed).toBe(false);
    expect(first.remaining).toBe(2);

    const second = await service.processQueueSlice({ maxItems: 30, maxDurationMs: 150 });
    expect(second.processed).toBe(1);
    expect(second.completed).toBe(false);
    expect(second.remaining).toBe(1);

    const third = await service.processQueueSlice({ maxItems: 30, maxDurationMs: 150 });
    expect(third.processed).toBe(1);
    expect(third.completed).toBe(true);
    expect(third.remaining).toBe(0);

    nowSpy.mockRestore();
  });

  it('processQueueSlice 遇到浏览器网络挂起异常时不应消耗 retry budget', async () => {
    const { service, handler, setOnline, createTask } = getContext();
    const recordCircuitFailureSpy = vi.spyOn(service, 'recordCircuitFailure');
    const task = createTask('suspended-retry-item');
    service.add('task', 'upsert', task, 'p-1', undefined, undefined, 'task_full_upsert');
    setOnline(true);
    (handler.pushTask as MockFn).mockRejectedValueOnce(createBrowserNetworkSuspendedError());

    const result = await service.processQueueSlice({ maxItems: 1, maxDurationMs: 1000 });

    expect(result.processed).toBe(1);
    expect(result.completed).toBe(false);
    expect(recordCircuitFailureSpy).not.toHaveBeenCalled();
    expect(service.getItems()).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({ id: task.id }),
        retryCount: 0,
      }),
    ]);
  });

  it('processQueueSlice 遇到受控延后异常时应保留队列项且不消耗 retry budget', async () => {
    const { service, handler, setOnline, stableUUID } = getContext();
    const recordCircuitFailureSpy = vi.spyOn(service, 'recordCircuitFailure');
    const connection: Connection = {
      id: stableUUID('deferred-connection-retry-item'),
      source: stableUUID('deferred-source-task'),
      target: stableUUID('deferred-target-task'),
    };
    service.add('connection', 'upsert', connection, 'p-1');
    setOnline(true);
    (handler.pushConnection as MockFn).mockRejectedValueOnce(
      createRetryDeferredError('connection remote newer; waiting for pull merge'),
    );

    const result = await service.processQueueSlice({ maxItems: 1, maxDurationMs: 1000 });

    expect(result.processed).toBe(1);
    expect(result.completed).toBe(false);
    expect(recordCircuitFailureSpy).not.toHaveBeenCalled();
    expect(service.getItems()).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({ id: connection.id }),
        retryCount: 0,
      }),
    ]);
  });

  it('manual processQueue 应等待恢复保护期结束后再重放', async () => {
    const { service, handler, setOnline, setVisibilityState, createTask } = getContext();
    vi.useFakeTimers();
    try {
      const task = createTask('manual-suspended-wait');
      service.add('task', 'upsert', task, 'p-1', undefined, undefined, 'task_full_upsert');
      setOnline(true);

      expect(isBrowserNetworkSuspendedWindow()).toBe(false);
      setVisibilityState('hidden');
      document.dispatchEvent(new Event('visibilitychange'));
      setVisibilityState('visible');
      document.dispatchEvent(new Event('visibilitychange'));
      expect(isBrowserNetworkSuspendedWindow()).toBe(true);

      const processPromise = service.processQueue(undefined, true);
      expect(handler.pushTask).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1499);
      expect(handler.pushTask).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      await processPromise;

      expect(handler.pushTask).toHaveBeenCalledOnce();
      expect(service.getItems()).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
}
