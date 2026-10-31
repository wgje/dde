import { expect, it } from 'vitest';

import type { TaskSyncOperationsDeleteRpcSpecContext } from './task-sync-operations-delete-rpc.spec-helpers';

const PROJECT_ID = 'project-1';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[45][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BATCH_PARENT_OPERATION_ID = '11111111-1111-4111-8111-111111111111';

export function registerTaskSyncOperationsDeleteRpcBatchingSpecs(
  getContext: () => TaskSyncOperationsDeleteRpcSpecContext,
): void {
  it('purgeTasksFromCloudDetailed 应按 100 个任务分块并聚合删除结果', async () => {
    const { service, createSyncRpcResult, mockSyncRpcClient } = getContext();
    const taskIds = Array.from({ length: 205 }, (_, index) => `task-purge-batch-${index}`);
    const baseUpdatedAtMap = Object.fromEntries(
      taskIds.map(taskId => [taskId, '2026-07-16T00:00:00.000Z']),
    );
    mockSyncRpcClient.isFeatureEnabled.mockReturnValue(true);
    mockSyncRpcClient.deleteTasks.mockImplementation(async (params: { taskIds: string[] }) => (
      createSyncRpcResult({
        entityId: PROJECT_ID,
        affectedCount: params.taskIds.length,
        attachmentPaths: [],
      })
    ));

    const result = await service.purgeTasksFromCloudDetailed(
      PROJECT_ID,
      taskIds,
      'user-1',
      false,
      baseUpdatedAtMap,
      BATCH_PARENT_OPERATION_ID,
    );

    const calls = mockSyncRpcClient.deleteTasks.mock.calls.map(([params]) => params as {
      operationId: string;
      taskIds: string[];
      baseUpdatedAtMap: Record<string, string | null>;
    });
    expect(calls.map(call => call.taskIds.length)).toEqual([100, 100, 5]);
    expect(calls.flatMap(call => call.taskIds)).toEqual(taskIds);
    expect(calls.map(call => Object.keys(call.baseUpdatedAtMap).length)).toEqual([100, 100, 5]);
    expect(new Set(calls.map(call => call.operationId)).size).toBe(3);
    for (const call of calls) {
      expect(call.operationId).toMatch(UUID_PATTERN);
    }
    expect(result).toEqual({
      success: true,
      deletedTaskIds: taskIds,
      skippedTaskIds: [],
      retriedTaskIds: [],
    });
  });

  it('softDeleteTasksBatch 应按 100 个任务分块并累计受影响数量', async () => {
    const { service, createSyncRpcResult, mockSyncRpcClient } = getContext();
    const taskIds = Array.from({ length: 205 }, (_, index) => `task-soft-batch-${index}`);
    const baseUpdatedAtMap = Object.fromEntries(
      taskIds.map(taskId => [taskId, '2026-07-16T00:00:00.000Z']),
    );
    mockSyncRpcClient.isFeatureEnabled.mockReturnValue(true);
    mockSyncRpcClient.deleteTasks.mockImplementation(async (params: { taskIds: string[] }) => (
      createSyncRpcResult({
        entityId: PROJECT_ID,
        affectedCount: params.taskIds.length,
        attachmentPaths: [],
      })
    ));

    const result = await service.softDeleteTasksBatch(
      PROJECT_ID,
      taskIds,
      undefined,
      baseUpdatedAtMap,
      BATCH_PARENT_OPERATION_ID,
    );

    const calls = mockSyncRpcClient.deleteTasks.mock.calls.map(([params]) => params as {
      operationId: string;
      taskIds: string[];
      baseUpdatedAtMap: Record<string, string | null>;
    });
    expect(calls.map(call => call.taskIds.length)).toEqual([100, 100, 5]);
    expect(calls.flatMap(call => call.taskIds)).toEqual(taskIds);
    expect(calls.map(call => Object.keys(call.baseUpdatedAtMap).length)).toEqual([100, 100, 5]);
    expect(new Set(calls.map(call => call.operationId)).size).toBe(3);
    for (const call of calls) {
      expect(call.operationId).toMatch(UUID_PATTERN);
    }
    expect(result).toBe(205);
  });
}
