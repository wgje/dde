import { buildRefreshFingerprint as buildRefreshFingerprintPure } from './retry-queue-fingerprint';
import type {
  RefreshedRetryQueueItemDraft,
  RetryQueueItem,
  RetryQueueLastFailure,
} from './retry-queue.types';

type RefreshComparableFields = Pick<
  RetryQueueItem,
  | 'operation'
  | 'data'
  | 'projectId'
  | 'sourceUserId'
  | 'taskIdsToDelete'
  | 'taskDeleteBaseUpdatedAtMap'
  | 'writeIntent'
>;

export interface RefreshedRetryQueueFieldMergeInput {
  existing: RetryQueueItem;
  projectId: string | undefined;
  targetOwnerUserId: string;
  taskIdsToDelete: string[] | undefined;
  taskDeleteBaseUpdatedAtMap: RetryQueueItem['taskDeleteBaseUpdatedAtMap'];
  writeIntent: RetryQueueItem['writeIntent'];
}

export interface RefreshedRetryQueueFieldMergeResult {
  projectId: string | undefined;
  sourceUserId: string;
  taskIdsToDelete: string[] | undefined;
  taskDeleteBaseUpdatedAtMap: RetryQueueItem['taskDeleteBaseUpdatedAtMap'];
  writeIntent: RetryQueueItem['writeIntent'];
}

export interface RefreshedRetryQueueOperationContextInput
  extends RefreshedRetryQueueFieldMergeInput {
  operation: RetryQueueItem['operation'];
  data: RetryQueueItem['data'];
  explicitOperationId: string | undefined;
}

export interface RefreshedRetryQueueOperationContext
  extends RefreshedRetryQueueFieldMergeResult {
  operationId: string | undefined;
}

export interface RefreshedRetryQueueDraftBuildInput {
  existing: RetryQueueItem;
  operation: RetryQueueItem['operation'];
  data: RetryQueueItem['data'];
  nextFields: RefreshedRetryQueueFieldMergeResult;
  nextOperationId: string;
  lastFailure: RetryQueueLastFailure | undefined;
  createdAt: number;
}

export function mergeRefreshedQueueItemFields(
  input: RefreshedRetryQueueFieldMergeInput,
): RefreshedRetryQueueFieldMergeResult {
  return {
    sourceUserId: input.existing.sourceUserId ?? input.targetOwnerUserId,
    projectId: input.projectId ?? input.existing.projectId,
    taskIdsToDelete: input.taskIdsToDelete ?? input.existing.taskIdsToDelete,
    taskDeleteBaseUpdatedAtMap: input.taskDeleteBaseUpdatedAtMap ?? input.existing.taskDeleteBaseUpdatedAtMap,
    writeIntent: input.writeIntent ?? input.existing.writeIntent,
  };
}

export function buildRefreshedRetryQueueOperationContext(
  input: RefreshedRetryQueueOperationContextInput,
): RefreshedRetryQueueOperationContext {
  const mergedFields = mergeRefreshedQueueItemFields(input);
  const next: RefreshComparableFields = {
    operation: input.operation,
    data: input.data,
    projectId: mergedFields.projectId,
    sourceUserId: mergedFields.sourceUserId,
    taskIdsToDelete: mergedFields.taskIdsToDelete,
    taskDeleteBaseUpdatedAtMap: mergedFields.taskDeleteBaseUpdatedAtMap,
    writeIntent: mergedFields.writeIntent,
  };

  return {
    ...mergedFields,
    operationId: input.explicitOperationId
      ?? (isSameLogicalRetryOperation(input.existing, next) ? input.existing.operationId : undefined),
  };
}

export function resolveRefreshedQueueItemLastFailure(
  existing: RetryQueueItem,
  lastFailure: RetryQueueLastFailure | undefined,
  nextOperationId: string,
): RetryQueueLastFailure | undefined {
  if (lastFailure !== undefined) {
    return lastFailure;
  }

  return nextOperationId === existing.operationId
    && existing.lastFailure?.remoteOutcome === 'unknown'
    ? existing.lastFailure
    : undefined;
}

export function buildRefreshedRetryQueueDraft(
  input: RefreshedRetryQueueDraftBuildInput,
): Omit<RefreshedRetryQueueItemDraft, 'safeData'> {
  return {
    item: {
      ...input.existing,
      operation: input.operation,
      data: input.data,
      createdAt: input.createdAt,
      ...input.nextFields,
      operationId: input.nextOperationId,
      lastFailure: resolveRefreshedQueueItemLastFailure(
        input.existing,
        input.lastFailure,
        input.nextOperationId,
      ),
    },
    sourceUserId: input.nextFields.sourceUserId,
    taskIdsToDelete: input.nextFields.taskIdsToDelete,
    taskDeleteBaseUpdatedAtMap: input.nextFields.taskDeleteBaseUpdatedAtMap,
    operationId: input.nextOperationId,
  };
}

function isSameLogicalRetryOperation(
  existing: RetryQueueItem,
  next: RefreshComparableFields,
): boolean {
  const candidate: RetryQueueItem = {
    ...existing,
    ...next,
    createdAt: existing.createdAt,
    operationId: existing.operationId,
  };

  return buildRefreshFingerprintPure(candidate) === buildRefreshFingerprintPure(existing);
}
