export interface SimpleSyncExecutionResult {
  success: boolean;
  retryEnqueued?: boolean;
}

export async function executeSimpleSyncWithRetryResult(
  execute: () => Promise<boolean>,
  hasRetryQueueEntity: () => boolean,
): Promise<SimpleSyncExecutionResult> {
  const success = await execute();
  return {
    success,
    retryEnqueued: !success && hasRetryQueueEntity(),
  };
}
