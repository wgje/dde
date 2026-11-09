import { describe, expect, it, vi } from 'vitest';

import { executeSimpleSyncWithRetryResult } from './simple-sync-execution.helpers';

describe('executeSimpleSyncWithRetryResult', () => {
  it('成功时返回显式 retryEnqueued=false 且不查询重试队列', async () => {
    const execute = vi.fn().mockResolvedValue(true);
    const hasRetryQueueEntity = vi.fn().mockReturnValue(true);

    await expect(executeSimpleSyncWithRetryResult(execute, hasRetryQueueEntity)).resolves.toEqual({
      success: true,
      retryEnqueued: false,
    });
    expect(execute).toHaveBeenCalledOnce();
    expect(hasRetryQueueEntity).not.toHaveBeenCalled();
  });

  it.each([
    { queued: true, expected: true },
    { queued: false, expected: false },
  ])('失败时把重试队列查询结果映射为 retryEnqueued=$expected', async ({ queued, expected }) => {
    const execute = vi.fn().mockResolvedValue(false);
    const hasRetryQueueEntity = vi.fn().mockReturnValue(queued);

    await expect(executeSimpleSyncWithRetryResult(execute, hasRetryQueueEntity)).resolves.toEqual({
      success: false,
      retryEnqueued: expected,
    });
    expect(execute).toHaveBeenCalledOnce();
    expect(hasRetryQueueEntity).toHaveBeenCalledOnce();
  });

  it('执行失败抛错时保持原异常并跳过重试队列查询', async () => {
    const error = new Error('sync execution failed');
    const execute = vi.fn().mockRejectedValue(error);
    const hasRetryQueueEntity = vi.fn();

    await expect(executeSimpleSyncWithRetryResult(execute, hasRetryQueueEntity)).rejects.toBe(error);
    expect(hasRetryQueueEntity).not.toHaveBeenCalled();
  });
});
