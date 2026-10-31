type PreserveSoftDeleteTasksForRetry = () => Promise<number>;

interface SoftDeleteRejectionBaseInput {
  projectId: string;
  taskIds: string[];
  preserveForRetry: PreserveSoftDeleteTasksForRetry;
}

interface SoftDeleteSyncRpcClientRejectedInput extends SoftDeleteRejectionBaseInput {
  reportClientRejected(
    operation: 'softDeleteTasksBatch',
    extra: Record<string, unknown>,
  ): void;
}

interface SoftDeleteSyncRpcUnavailableInput extends SoftDeleteRejectionBaseInput {
  operationId: string;
  logWarning(message: string, context: Record<string, unknown>): void;
}

interface SoftDeleteSyncRpcFailureInput extends SoftDeleteRejectionBaseInput {
  operationId: string;
  error: unknown;
  logError(message: string, context: Record<string, unknown>): void;
  captureException(
    error: unknown,
    operation: string,
    context: Record<string, unknown>,
  ): void;
}

export async function handleSoftDeleteSyncRpcClientRejected(
  input: SoftDeleteSyncRpcClientRejectedInput,
): Promise<number> {
  input.reportClientRejected('softDeleteTasksBatch', {
    projectId: input.projectId,
    taskIds: input.taskIds,
  });
  return await input.preserveForRetry();
}

export async function handleSoftDeleteSyncRpcUnavailable(
  input: SoftDeleteSyncRpcUnavailableInput,
): Promise<number> {
  input.logWarning('softDeleteTasksBatch: sync RPC 不可用，已保留删除意图等待重试', {
    projectId: input.projectId,
    taskIds: input.taskIds,
    operationId: input.operationId,
  });
  return await input.preserveForRetry();
}

export async function preserveSoftDeleteTasksAfterRpcFailure(
  input: SoftDeleteSyncRpcFailureInput,
): Promise<number> {
  input.logError('softDeleteTasksBatch: sync RPC 失败，已保留删除意图等待重试', {
    projectId: input.projectId,
    taskIds: input.taskIds,
    operationId: input.operationId,
    error: input.error,
  });
  input.captureException(input.error, 'softDeleteTasksBatch', {
    projectId: input.projectId,
    taskCount: input.taskIds.length,
    operationId: input.operationId,
  });
  return await input.preserveForRetry();
}
