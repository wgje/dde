/**
 * RetryQueue unknown-outcome 对账语义（目标3 离线弱网同步收口）
 *
 * 业务意图（§5.2 / §5.6）：
 * - 推送超时/abort 后客户端无法区分「服务端已写入」与「真失败」；
 * - 重放路径的 timeout 类失败必须把队列项标记为 unknown-outcome（不消耗 retryCount）；
 * - unknown-outcome 项在下一次重放前先对账：
 *   命中 → 按成功结算不重放；未命中 → 清除标记正常重放；对账失败 → 保持状态等下轮。
 *
 * 注意：按任务要求不改动 retry-queue-capacity-and-slice / retry-queue-operation-id /
 * sync-coordinator-offline-merge 三个既有 spec-helpers 大文件，新断言集中在本文件。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createRetryQueueServiceSpecHarness,
  type RetryQueueServiceSpecHarness,
} from './retry-queue-service.spec-fixture';
import { createTask, stableUUID } from './retry-queue-test-data.spec-helpers';
import type {
  RetryQueueLastFailure,
  RetryQueueUnknownOutcomeReconcileResult,
} from './retry-queue.types';

function createUnknownOutcomeLastFailure(recordedAt = 1_000): RetryQueueLastFailure {
  return {
    errorType: 'TimeoutError',
    message: '请求超时 (30000ms): push-task:unknown-outcome-spec',
    remoteOutcome: 'unknown',
    recordedAt,
  };
}

/** 模拟推送层 rethrow 的增强超时错误（remoteOutcome=unknown，走 server-pressure 延后通道）。 */
function createTimeoutEnhancedError(): Error {
  const error = new Error('请求超时 (30000ms): push-task:unknown-outcome-spec') as Error & {
    errorType: string;
    isRetryable: boolean;
    remoteOutcome: 'unknown';
  };
  error.name = 'TimeoutError';
  error.errorType = 'TimeoutError';
  error.isRetryable = true;
  error.remoteOutcome = 'unknown';
  return error;
}

describe('RetryQueue unknown-outcome 对账', () => {
  let harness: RetryQueueServiceSpecHarness;

  beforeEach(() => {
    sessionStorage.clear();
    harness = createRetryQueueServiceSpecHarness();
    harness.setOnline(true);
    harness.authServiceMock.currentUserId.mockReturnValue('test-user');
  });

  afterEach(async () => {
    await harness.teardown();
    vi.restoreAllMocks();
  });

  function enqueueTaskUpsert(label: string, lastFailure?: RetryQueueLastFailure): string {
    const task = createTask(label);
    harness.service.add(
      'task',
      'upsert',
      task,
      `project-${label}`,
      'test-user',
      undefined,
      'task_full_upsert',
      undefined,
      stableUUID(`op-${label}`),
      lastFailure,
    );
    return task.id;
  }

  function setReconcileMock(
    result: RetryQueueUnknownOutcomeReconcileResult | Error,
  ): ReturnType<typeof vi.fn> {
    const reconcile = result instanceof Error
      ? vi.fn().mockRejectedValue(result)
      : vi.fn().mockResolvedValue(result);
    harness.handler.reconcileUnknownOutcome = reconcile;
    return reconcile;
  }

  it('重放超时后应标记 unknown-outcome 且不消耗 retryCount', async () => {
    const persistNow = vi.spyOn(
      harness.service as unknown as { saveToStorageImmediate(): Promise<boolean> },
      'saveToStorageImmediate',
    ).mockResolvedValue(true);
    const taskId = enqueueTaskUpsert('unknown-mark');
    (harness.handler.pushTask as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(createTimeoutEnhancedError());

    await harness.service.processQueueSlice({ maxItems: 1, maxDurationMs: 1_000 });

    expect(harness.handler.pushTask).toHaveBeenCalledTimes(1);
    expect(persistNow).toHaveBeenCalledTimes(1);
    expect(harness.service.getItems()).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({ id: taskId }),
        retryCount: 0,
        lastFailure: expect.objectContaining({
          errorType: 'TimeoutError',
          remoteOutcome: 'unknown',
        }),
      }),
    ]);
  });

  it('对账命中（settled）时应按成功结算并移除，不再重放', async () => {
    const taskId = enqueueTaskUpsert('reconcile-settled', createUnknownOutcomeLastFailure());
    const reconcile = setReconcileMock('settled');

    await harness.service.processQueueSlice({ maxItems: 1, maxDurationMs: 1_000 });

    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(reconcile).toHaveBeenCalledWith(expect.objectContaining({
      type: 'task',
      operation: 'upsert',
      data: expect.objectContaining({ id: taskId }),
    }));
    expect(harness.handler.pushTask).not.toHaveBeenCalled();
    expect(harness.service.getItems()).toEqual([]);
  });

  it('对账未命中（replay）时应清除标记并正常重放一次', async () => {
    const taskId = enqueueTaskUpsert('reconcile-replay', createUnknownOutcomeLastFailure());
    const reconcile = setReconcileMock('replay');
    (harness.handler.pushTask as ReturnType<typeof vi.fn>).mockResolvedValueOnce(true);

    await harness.service.processQueueSlice({ maxItems: 1, maxDurationMs: 1_000 });

    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(harness.handler.pushTask).toHaveBeenCalledTimes(1);
    expect(harness.handler.pushTask).toHaveBeenCalledWith(
      expect.objectContaining({ id: taskId }),
      'project-reconcile-replay',
      'test-user',
      'task_full_upsert',
      stableUUID('op-reconcile-replay'),
    );
    expect(harness.service.getItems()).toEqual([]);
  });

  it('对账未命中且重放失败（false）时标记已清除、按普通失败消耗 retryCount', async () => {
    const taskId = enqueueTaskUpsert('reconcile-replay-fail', createUnknownOutcomeLastFailure());
    setReconcileMock('replay');
    (harness.handler.pushTask as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false);

    await harness.service.processQueueSlice({ maxItems: 1, maxDurationMs: 1_000 });

    expect(harness.service.getItems()).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({ id: taskId }),
        retryCount: 1,
      }),
    ]);
    expect(harness.service.getItems()[0]?.lastFailure).toBeUndefined();
  });

  it('清除 unknown 标记未能持久化时不应进入远端重放', async () => {
    const lastFailure = createUnknownOutcomeLastFailure(2_000);
    const taskId = enqueueTaskUpsert('reconcile-persist-fail', lastFailure);
    const reconcile = setReconcileMock('replay');
    vi.spyOn(
      harness.service as unknown as { saveToStorageImmediate(): Promise<boolean> },
      'saveToStorageImmediate',
    ).mockResolvedValue(false);

    await harness.service.processQueueSlice({ maxItems: 1, maxDurationMs: 1_000 });

    expect(reconcile).toHaveBeenCalledOnce();
    expect(harness.handler.pushTask).not.toHaveBeenCalled();
    expect(harness.service.getItems()).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({ id: taskId }),
        retryCount: 0,
        lastFailure,
      }),
    ]);
  });

  it('对账无法判定（unknown）时应保持状态与 retryCount 等待下一轮', async () => {
    const lastFailure = createUnknownOutcomeLastFailure(3_000);
    const taskId = enqueueTaskUpsert('reconcile-unknown', lastFailure);
    const reconcile = setReconcileMock('unknown');

    await harness.service.processQueueSlice({ maxItems: 1, maxDurationMs: 1_000 });

    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(harness.handler.pushTask).not.toHaveBeenCalled();
    expect(harness.service.getItems()).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({ id: taskId }),
        retryCount: 0,
        lastFailure,
      }),
    ]);
  });

  it('对账查询抛出异常时按 unknown 处理：保持状态不丢弃', async () => {
    const lastFailure = createUnknownOutcomeLastFailure(4_000);
    const taskId = enqueueTaskUpsert('reconcile-throw', lastFailure);
    setReconcileMock(new Error('freshness lookup failed'));

    await harness.service.processQueueSlice({ maxItems: 1, maxDurationMs: 1_000 });

    expect(harness.handler.pushTask).not.toHaveBeenCalled();
    expect(harness.service.getItems()).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({ id: taskId }),
        retryCount: 0,
        lastFailure,
      }),
    ]);
  });

  it('单个 unknown 项无法判定时仍应继续处理后续队列项', async () => {
    const blockedTaskId = enqueueTaskUpsert('reconcile-unknown-head', createUnknownOutcomeLastFailure());
    const followingTaskId = enqueueTaskUpsert('reconcile-unknown-following');
    setReconcileMock('unknown');
    (harness.handler.pushTask as ReturnType<typeof vi.fn>).mockResolvedValue(true);

    await harness.service.processQueueSlice({ maxItems: 2, maxDurationMs: 1_000 });

    expect(harness.handler.pushTask).toHaveBeenCalledWith(
      expect.objectContaining({ id: followingTaskId }),
      'project-reconcile-unknown-following',
      'test-user',
      'task_full_upsert',
      stableUUID('op-reconcile-unknown-following'),
    );
    expect(harness.service.getItems()).toEqual([
      expect.objectContaining({ data: expect.objectContaining({ id: blockedTaskId }), retryCount: 0 }),
    ]);
  });

  it('unknown-outcome 无法判定时不应继续处理同项目依赖写入', async () => {
    const blockedProjectId = 'project-reconcile-unknown-head';
    const blockedTaskId = enqueueTaskUpsert('reconcile-unknown-head', createUnknownOutcomeLastFailure());
    const followingTask = createTask('reconcile-unknown-same-project');
    harness.service.add(
      'task',
      'upsert',
      followingTask,
      blockedProjectId,
      'test-user',
      undefined,
      undefined,
      undefined,
      stableUUID('op-reconcile-unknown-same-project'),
    );
    setReconcileMock('unknown');
    (harness.handler.pushTask as ReturnType<typeof vi.fn>).mockResolvedValue(true);

    await harness.service.processQueueSlice({ maxItems: 2, maxDurationMs: 1_000 });

    expect(harness.handler.pushTask).not.toHaveBeenCalled();
    expect(harness.service.getItems()).toEqual([
      expect.objectContaining({ data: expect.objectContaining({ id: blockedTaskId }), retryCount: 0 }),
      expect.objectContaining({ data: expect.objectContaining({ id: followingTask.id }), retryCount: 0 }),
    ]);
  });

  it('明确不可重试的对账错误应进入终态分类而不是永久保留 unknown', async () => {
    const denied = Object.assign(new Error('row access denied'), {
      errorType: 'RlsPolicyViolation',
      isRetryable: false,
    });
    const deniedTaskId = enqueueTaskUpsert('reconcile-permanent', createUnknownOutcomeLastFailure());
    const followingTaskId = enqueueTaskUpsert('reconcile-permanent-following');
    setReconcileMock(denied);
    (harness.handler.pushTask as ReturnType<typeof vi.fn>).mockResolvedValue(true);

    await harness.service.processQueueSlice({ maxItems: 2, maxDurationMs: 1_000 });

    expect(harness.handler.pushTask).toHaveBeenCalledWith(
      expect.objectContaining({ id: followingTaskId }),
      'project-reconcile-permanent-following',
      'test-user',
      'task_full_upsert',
      stableUUID('op-reconcile-permanent-following'),
    );
    expect(harness.service.getItems().some(item => item.data.id === deniedTaskId)).toBe(false);
  });

  it('handler 未提供对账实现时 unknown-outcome 项保持既有重放路径', async () => {
    enqueueTaskUpsert('no-reconcile', createUnknownOutcomeLastFailure());
    (harness.handler.pushTask as ReturnType<typeof vi.fn>).mockResolvedValueOnce(true);

    await harness.service.processQueueSlice({ maxItems: 1, maxDurationMs: 1_000 });

    expect(harness.handler.pushTask).toHaveBeenCalledTimes(1);
    expect(harness.service.getItems()).toEqual([]);
  });

  it('刷新重建服务后应恢复 unknown-outcome 并在下一轮对账结算', async () => {
    const lastFailure = createUnknownOutcomeLastFailure(5_000);
    const taskId = enqueueTaskUpsert('reload-reconcile-settled', lastFailure);
    await expect((
      harness.service as unknown as { saveToStorageImmediate(): Promise<boolean> }
    ).saveToStorageImmediate()).resolves.toBe(true);
    expect(localStorage.getItem('nanoflow.retry-queue')).toContain('"remoteOutcome":"unknown"');

    await harness.destroy();
    harness.initDbSpy.mockRestore();
    harness.loadFromStorageSpy.mockRestore();

    harness = createRetryQueueServiceSpecHarness({
      clearLocalStorage: false,
      useRealLoadFromStorage: true,
    });
    harness.setOnline(true);
    harness.authServiceMock.currentUserId.mockReturnValue('test-user');
    const reconcile = vi.fn().mockResolvedValue('settled');
    harness.handler.reconcileUnknownOutcome = reconcile;

    await vi.waitFor(() => {
      expect(harness.service.getItems()).toEqual([
        expect.objectContaining({
          data: expect.objectContaining({ id: taskId }),
          retryCount: 0,
          lastFailure,
        }),
      ]);
    });

    await harness.service.processQueueSlice({ maxItems: 1, maxDurationMs: 1_000 });

    expect(reconcile).toHaveBeenCalledOnce();
    expect(harness.handler.pushTask).not.toHaveBeenCalled();
    expect(harness.service.getItems()).toEqual([]);
    expect(JSON.parse(localStorage.getItem('nanoflow.retry-queue') ?? '{}').items).toEqual([]);
  });
});
