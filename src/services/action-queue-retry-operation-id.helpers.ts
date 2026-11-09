export function retryOperationIdMatches(
  retryItem: { operationId?: unknown },
  operationId: string | undefined,
): boolean {
  if (operationId === undefined) {
    return retryItem.operationId === undefined;
  }

  return retryItem.operationId === operationId;
}
