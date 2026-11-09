import { expect, it } from 'vitest';

import type { TaskSyncOperationsDeleteRpcSpecContext } from './task-sync-operations-delete-rpc.spec-helpers';

export function registerTaskSyncOperationsDeleteRpcSuccessCleanupSpecs(
  getContext: () => TaskSyncOperationsDeleteRpcSpecContext,
): void {
  it('softDeleteTasksBatch 成功后也应清理引用已删任务的连接重试项', async () => {
    const { service, createSyncRpcResult, mockClient, mockRetryQueue, mockSyncRpcClient } = getContext();
    mockSyncRpcClient.isFeatureEnabled.mockReturnValue(true);
    mockSyncRpcClient.deleteTasks.mockImplementationOnce(async () => createSyncRpcResult({
      entityId: 'project-1',
      affectedCount: 1,
      attachmentPaths: [] as string[],
    }));
    mockRetryQueue.removeByEntities.mockReturnValueOnce(['task-soft-delete-scoped']);
    mockRetryQueue.removeConnectionsReferencingTasks.mockReturnValueOnce(['conn-stale-soft-delete']);

    const result = await service.softDeleteTasksBatch('project-1', ['task-soft-delete-scoped']);

    expect(result).toBe(1);
    expect(mockClient.rpc).not.toHaveBeenCalledWith('safe_delete_tasks', expect.anything());
    expect(mockRetryQueue.removeByEntities).toHaveBeenCalledWith('task', ['task-soft-delete-scoped']);
    expect(mockRetryQueue.removeConnectionsReferencingTasks).toHaveBeenCalledWith('project-1', ['task-soft-delete-scoped']);
  });
}
