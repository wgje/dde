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
  resolveRejectedTaskDeleteConflictPurgeResult,
  resolveTaskDeleteSessionUserId,
  selectAppliedTaskDeleteIds,
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

  it('resolveRejectedTaskDeleteConflictPurgeResult 应清理冲突重试并保留持久化结果', async () => {
    const removeConflictRetries = vi.fn();
    const captureConflict = vi.fn(async () => true);

    await expect(resolveRejectedTaskDeleteConflictPurgeResult({
      taskIds: ['task-conflict'],
      conflictTaskIds: ['task-conflict'],
      hasRetryEntity: vi.fn(() => true),
      removeConflictRetries,
      captureConflict,
    })).resolves.toEqual({
      success: false,
      deletedTaskIds: [],
      skippedTaskIds: ['task-conflict'],
      retriedTaskIds: [],
      conflictTaskIds: ['task-conflict'],
      conflictPersisted: true,
    });

    expect(removeConflictRetries).toHaveBeenCalledWith(['task-conflict']);
    expect(captureConflict).toHaveBeenCalledOnce();
  });

  it('resolveRejectedTaskDeleteConflictPurgeResult 在冲突持久化失败时应保留重试删除意图', async () => {
    const removeConflictRetries = vi.fn();

    await expect(resolveRejectedTaskDeleteConflictPurgeResult({
      taskIds: ['task-conflict'],
      conflictTaskIds: ['task-conflict'],
      hasRetryEntity: vi.fn(() => true),
      removeConflictRetries,
      captureConflict: vi.fn(async () => false),
    })).resolves.toEqual({
      success: false,
      deletedTaskIds: [],
      skippedTaskIds: ['task-conflict'],
      retriedTaskIds: ['task-conflict'],
      conflictTaskIds: ['task-conflict'],
      conflictPersisted: false,
    });

    expect(removeConflictRetries).not.toHaveBeenCalled();
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

});
