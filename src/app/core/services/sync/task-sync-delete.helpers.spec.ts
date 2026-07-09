import { describe, expect, it, vi } from 'vitest';

import {
  buildTaskBaseUpdatedAtMap,
  buildSingleTaskBaseUpdatedAtOverride,
  collectRetriedTaskIds,
  createRejectedTaskPurgeResult,
  createRetryTrackedRejectedTaskPurgeResult,
  createRetryTrackedTaskPurgeResult,
  createSettledTaskPurgeResult,
  createTaskPurgeResult,
  getSkippedTaskDeleteIds,
  resolveTaskDeleteSessionUserId,
  resolveLegacyPurgeSoftDeleteFallbackIds,
  selectAppliedTaskDeleteIds,
  selectLegacyPurgeSoftDeleteFallbackIds,
  softDeleteTasksWithBaseGuard,
} from './task-sync-delete.helpers';

describe('task-sync-delete helpers', () => {
  it('createTaskPurgeResult 应保持 purge 结果结构稳定', () => {
    expect(createTaskPurgeResult(true, ['deleted'], ['skipped'], ['retried'])).toEqual({
      success: true,
      deletedTaskIds: ['deleted'],
      skippedTaskIds: ['skipped'],
      retriedTaskIds: ['retried'],
    });
  });

  it('createRejectedTaskPurgeResult 应把请求任务标记为跳过并保留重试集合', () => {
    expect(createRejectedTaskPurgeResult(
      ['task-1', 'task-2'],
      ['task-2'],
    )).toEqual({
      success: false,
      deletedTaskIds: [],
      skippedTaskIds: ['task-1', 'task-2'],
      retriedTaskIds: ['task-2'],
    });
  });

  it('createRejectedTaskPurgeResult 缺省时应返回空重试集合', () => {
    expect(createRejectedTaskPurgeResult(['task-1'])).toEqual({
      success: false,
      deletedTaskIds: [],
      skippedTaskIds: ['task-1'],
      retriedTaskIds: [],
    });
  });

  it('createSettledTaskPurgeResult 应在没有跳过任务时标记成功', () => {
    expect(createSettledTaskPurgeResult(
      ['task-1', 'task-2'],
      [],
    )).toEqual({
      success: true,
      deletedTaskIds: ['task-1', 'task-2'],
      skippedTaskIds: [],
      retriedTaskIds: [],
    });
  });

  it('createSettledTaskPurgeResult 应在存在跳过任务时标记失败并保留重试集合', () => {
    expect(createSettledTaskPurgeResult(
      ['task-1'],
      ['task-2'],
      ['task-2'],
    )).toEqual({
      success: false,
      deletedTaskIds: ['task-1'],
      skippedTaskIds: ['task-2'],
      retriedTaskIds: ['task-2'],
    });
  });

  it('createRetryTrackedTaskPurgeResult 应只从跳过任务中收集已入队任务', () => {
    const hasRetryEntity = vi.fn((taskId: string) => taskId === 'task-skipped-retry');

    expect(createRetryTrackedTaskPurgeResult(
      ['task-deleted'],
      ['task-skipped-retry', 'task-skipped-new'],
      hasRetryEntity,
    )).toEqual({
      success: false,
      deletedTaskIds: ['task-deleted'],
      skippedTaskIds: ['task-skipped-retry', 'task-skipped-new'],
      retriedTaskIds: ['task-skipped-retry'],
    });
    expect(hasRetryEntity).toHaveBeenCalledTimes(2);
    expect(hasRetryEntity).toHaveBeenCalledWith('task-skipped-retry');
    expect(hasRetryEntity).toHaveBeenCalledWith('task-skipped-new');
  });

  it('createRetryTrackedRejectedTaskPurgeResult 应把请求任务作为跳过任务并收集重试集合', () => {
    const hasRetryEntity = vi.fn((taskId: string) => taskId === 'task-retried');

    expect(createRetryTrackedRejectedTaskPurgeResult(
      ['task-retried', 'task-new'],
      hasRetryEntity,
    )).toEqual({
      success: false,
      deletedTaskIds: [],
      skippedTaskIds: ['task-retried', 'task-new'],
      retriedTaskIds: ['task-retried'],
    });
  });

  it('collectRetriedTaskIds 应按 RetryQueue 查询结果过滤并保持原顺序', () => {
    const hasRetryEntity = vi.fn((taskId: string) => taskId === 'task-2' || taskId === 'task-4');

    expect(collectRetriedTaskIds(['task-1', 'task-2', 'task-3', 'task-4'], hasRetryEntity))
      .toEqual(['task-2', 'task-4']);
    expect(hasRetryEntity).toHaveBeenCalledTimes(4);
  });

  it('buildTaskBaseUpdatedAtMap 应让调用方 override 优先于 TaskStore 快照', () => {
    const getTask = vi.fn((taskId: string) => ({ updatedAt: `${taskId}-store` }));

    expect(buildTaskBaseUpdatedAtMap({
      taskIds: ['task-1', 'task-2', 'task-3'],
      overrideMap: {
        'task-1': 'task-1-override',
        'task-2': undefined,
      },
      getTask,
    })).toEqual({
      'task-1': 'task-1-override',
      'task-2': null,
      'task-3': 'task-3-store',
    });
    expect(getTask).toHaveBeenCalledTimes(1);
    expect(getTask).toHaveBeenCalledWith('task-3');
  });

  it('buildTaskBaseUpdatedAtMap 缺少任务快照或 updatedAt 时应显式写 null', () => {
    expect(buildTaskBaseUpdatedAtMap({
      taskIds: ['missing', 'empty', 'valid'],
      getTask: taskId => {
        if (taskId === 'empty') return { updatedAt: '' };
        if (taskId === 'valid') return { updatedAt: '2026-06-14T00:00:00.000Z' };
        return undefined;
      },
    })).toEqual({
      missing: null,
      empty: null,
      valid: '2026-06-14T00:00:00.000Z',
    });
  });

  it('buildTaskBaseUpdatedAtMap 空任务列表应返回 undefined', () => {
    expect(buildTaskBaseUpdatedAtMap({ taskIds: [] })).toBeUndefined();
  });

  it('buildSingleTaskBaseUpdatedAtOverride 应只在请求携带基线时构造单任务 override map', () => {
    expect(buildSingleTaskBaseUpdatedAtOverride({
      taskId: 'task-1',
      baseUpdatedAt: '2026-06-16T00:00:00.000Z',
    })).toEqual({
      'task-1': '2026-06-16T00:00:00.000Z',
    });

    expect(buildSingleTaskBaseUpdatedAtOverride({
      taskId: 'task-2',
      baseUpdatedAt: null,
    })).toEqual({
      'task-2': null,
    });
  });

  it('buildSingleTaskBaseUpdatedAtOverride 缺少基线字段时应返回 undefined', () => {
    expect(buildSingleTaskBaseUpdatedAtOverride({ taskId: 'task-1' })).toBeUndefined();
  });

  it('resolveTaskDeleteSessionUserId 应直接返回当前会话用户', async () => {
    const getSession = vi.fn(async () => ({
      data: { session: { user: { id: 'user-current' } } },
    }));
    const sessionRefresher = { tryRefreshSession: vi.fn() };

    await expect(resolveTaskDeleteSessionUserId(
      { auth: { getSession } },
      sessionRefresher,
      'deleteTask.getSession',
    )).resolves.toBe('user-current');

    expect(getSession).toHaveBeenCalledOnce();
    expect(sessionRefresher.tryRefreshSession).not.toHaveBeenCalled();
  });

  it('resolveTaskDeleteSessionUserId 应在缺少会话且刷新失败时返回 null', async () => {
    const getSession = vi.fn(async () => ({
      data: { session: null },
    }));
    const sessionRefresher = { tryRefreshSession: vi.fn(async () => false) };

    await expect(resolveTaskDeleteSessionUserId(
      { auth: { getSession } },
      sessionRefresher,
      'purgeTasksFromCloud.getSession',
    )).resolves.toBeNull();

    expect(getSession).toHaveBeenCalledOnce();
    expect(sessionRefresher.tryRefreshSession).toHaveBeenCalledWith('purgeTasksFromCloud.getSession');
  });

  it('resolveTaskDeleteSessionUserId 应在刷新成功后重新读取会话用户', async () => {
    const getSession = vi
      .fn()
      .mockResolvedValueOnce({ data: { session: null } })
      .mockResolvedValueOnce({ data: { session: { user: { id: 'user-refreshed' } } } });
    const sessionRefresher = { tryRefreshSession: vi.fn(async () => true) };

    await expect(resolveTaskDeleteSessionUserId(
      { auth: { getSession } },
      sessionRefresher,
      'deleteTask.getSession',
    )).resolves.toBe('user-refreshed');

    expect(getSession).toHaveBeenCalledTimes(2);
    expect(sessionRefresher.tryRefreshSession).toHaveBeenCalledWith('deleteTask.getSession');
  });

  it('getSkippedTaskDeleteIds 应只保留本次请求任务并去重', () => {
    expect(getSkippedTaskDeleteIds(
      { skippedIds: ['task-2', 'foreign-task', 'task-2', 'task-1'] },
      ['task-1', 'task-2', 'task-3'],
    )).toEqual(['task-2', 'task-1']);
  });

  it('selectAppliedTaskDeleteIds 应只从本次请求中剔除服务端跳过的任务', () => {
    expect(selectAppliedTaskDeleteIds(
      { skippedIds: ['task-2', 'foreign-task', 'task-2'] },
      ['task-1', 'task-2', 'task-3'],
    )).toEqual({
      deletedTaskIds: ['task-1', 'task-3'],
      skippedTaskIds: ['task-2'],
    });
  });

  it('selectAppliedTaskDeleteIds 无跳过项时应保留原请求顺序', () => {
    expect(selectAppliedTaskDeleteIds(
      { skippedIds: [] },
      ['task-1', 'task-2'],
    )).toEqual({
      deletedTaskIds: ['task-1', 'task-2'],
      skippedTaskIds: [],
    });
  });

  it('selectLegacyPurgeSoftDeleteFallbackIds 应只对仍存在的任务计算软删和重试集合', () => {
    expect(selectLegacyPurgeSoftDeleteFallbackIds({
      taskIds: ['task-1', 'missing-task', 'task-2', 'task-3'],
      existingTaskIds: new Set(['task-1', 'task-2', 'task-3']),
      updatedTaskIds: ['task-1', 'foreign-task', 'task-3', 'task-1'],
    })).toEqual({
      softDeleteTaskIds: ['task-1', 'task-2', 'task-3'],
      skippedTaskIds: ['task-2'],
    });
  });

  it('selectLegacyPurgeSoftDeleteFallbackIds 应在不存在远端任务时返回空集合', () => {
    expect(selectLegacyPurgeSoftDeleteFallbackIds({
      taskIds: ['missing-task'],
      existingTaskIds: new Set(),
      updatedTaskIds: ['missing-task'],
    })).toEqual({
      softDeleteTaskIds: [],
      skippedTaskIds: [],
    });
  });

  it('resolveLegacyPurgeSoftDeleteFallbackIds 应只软删仍存在的任务并计算重试集合', async () => {
    const softDeleteExistingTaskIds = vi.fn(async () => [
      'task-1',
      'foreign-task',
      'task-3',
      'task-1',
    ]);

    await expect(resolveLegacyPurgeSoftDeleteFallbackIds({
      taskIds: ['task-1', 'missing-task', 'task-2', 'task-3'],
      existingTaskIds: new Set(['task-1', 'task-2', 'task-3']),
      softDeleteExistingTaskIds,
    })).resolves.toEqual({
      updatedTaskIds: ['task-1', 'task-3'],
      skippedTaskIds: ['task-2'],
    });

    expect(softDeleteExistingTaskIds).toHaveBeenCalledOnce();
    expect(softDeleteExistingTaskIds).toHaveBeenCalledWith(['task-1', 'task-2', 'task-3']);
  });

  it('resolveLegacyPurgeSoftDeleteFallbackIds 无远端任务时不应调用软删回调', async () => {
    const softDeleteExistingTaskIds = vi.fn(async () => ['missing-task']);

    await expect(resolveLegacyPurgeSoftDeleteFallbackIds({
      taskIds: ['missing-task'],
      existingTaskIds: new Set(),
      softDeleteExistingTaskIds,
    })).resolves.toEqual({
      updatedTaskIds: [],
      skippedTaskIds: [],
    });

    expect(softDeleteExistingTaskIds).not.toHaveBeenCalled();
  });

  it('softDeleteTasksWithBaseGuard 应按 updatedAt 基线逐个执行 CAS 软删', async () => {
    const maybeSingle = vi.fn(async () => ({ data: { id: 'task-1' }, error: null }));
    const select = vi.fn(() => ({ maybeSingle }));
    const eq = vi.fn(function (
      this: { eq: typeof eq; select: typeof select },
      _column: string,
      _value: string,
    ) {
      return this;
    });
    const update = vi.fn(() => ({ eq, select }));
    const client = { from: vi.fn(() => ({ update })) };
    const logger = { warn: vi.fn(), error: vi.fn() };

    await expect(softDeleteTasksWithBaseGuard({
      client,
      projectId: 'project-1',
      taskIds: ['task-1'],
      baseUpdatedAtMap: { 'task-1': '2026-06-14T00:00:00.000Z' },
      deletedAt: '2026-06-15T00:00:00.000Z',
      logger,
    })).resolves.toEqual(['task-1']);

    expect(client.from).toHaveBeenCalledWith('tasks');
    expect(update).toHaveBeenCalledWith({
      deleted_at: '2026-06-15T00:00:00.000Z',
      updated_at: '2026-06-15T00:00:00.000Z',
    });
    expect(eq).toHaveBeenCalledWith('project_id', 'project-1');
    expect(eq).toHaveBeenCalledWith('id', 'task-1');
    expect(eq).toHaveBeenCalledWith('updated_at', '2026-06-14T00:00:00.000Z');
    expect(select).toHaveBeenCalledWith('id');
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('softDeleteTasksWithBaseGuard 缺少基线时应跳过，避免陈旧删除覆盖远端', async () => {
    const client = { from: vi.fn() };
    const logger = { warn: vi.fn(), error: vi.fn() };

    await expect(softDeleteTasksWithBaseGuard({
      client,
      projectId: 'project-1',
      taskIds: ['task-without-baseline'],
      baseUpdatedAtMap: { 'task-without-baseline': null },
      deletedAt: '2026-06-15T00:00:00.000Z',
      logger,
    })).resolves.toEqual([]);

    expect(client.from).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      '跳过缺少 updatedAt 基线的任务软删降级，避免陈旧删除覆盖远端',
      { projectId: 'project-1', taskId: 'task-without-baseline' },
    );
  });

  it('softDeleteTasksWithBaseGuard 远端版本已前进时应跳过该任务', async () => {
    const maybeSingle = vi.fn(async () => ({ data: null, error: null }));
    const select = vi.fn(() => ({ maybeSingle }));
    const eq = vi.fn(function (
      this: { eq: typeof eq; select: typeof select },
      _column: string,
      _value: string,
    ) {
      return this;
    });
    const update = vi.fn(() => ({ eq, select }));
    const client = { from: vi.fn(() => ({ update })) };
    const logger = { warn: vi.fn(), error: vi.fn() };

    await expect(softDeleteTasksWithBaseGuard({
      client,
      projectId: 'project-1',
      taskIds: ['remote-newer'],
      baseUpdatedAtMap: { 'remote-newer': '2026-06-14T00:00:00.000Z' },
      deletedAt: '2026-06-15T00:00:00.000Z',
      logger,
    })).resolves.toEqual([]);

    expect(logger.warn).toHaveBeenCalledWith(
      '跳过远端已前进的任务软删降级',
      {
        projectId: 'project-1',
        taskId: 'remote-newer',
        baseUpdatedAt: '2026-06-14T00:00:00.000Z',
      },
    );
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('softDeleteTasksWithBaseGuard 数据库错误应转换为增强错误并抛出', async () => {
    const dbError = { code: '42501', message: 'permission denied' };
    const maybeSingle = vi.fn(async () => ({ data: null, error: dbError }));
    const select = vi.fn(() => ({ maybeSingle }));
    const eq = vi.fn(function (
      this: { eq: typeof eq; select: typeof select },
      _column: string,
      _value: string,
    ) {
      return this;
    });
    const update = vi.fn(() => ({ eq, select }));
    const client = { from: vi.fn(() => ({ update })) };
    const logger = { warn: vi.fn(), error: vi.fn() };

    await expect(softDeleteTasksWithBaseGuard({
      client,
      projectId: 'project-1',
      taskIds: ['task-error'],
      baseUpdatedAtMap: { 'task-error': '2026-06-14T00:00:00.000Z' },
      deletedAt: '2026-06-15T00:00:00.000Z',
      logger,
    })).rejects.toMatchObject({
      code: '42501',
      errorType: 'PermissionError',
      isRetryable: false,
    });

    expect(logger.error).toHaveBeenCalledWith(
      '任务软删降级失败',
      { projectId: 'project-1', taskId: 'task-error', error: dbError },
    );
  });
});
