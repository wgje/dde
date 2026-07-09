import { AUTH_CONFIG } from '../config/auth.config';
import type { Project } from '../models';
import type { ProjectSyncResult } from './action-queue-retry-errors';
import type { ProjectPayload } from './action-queue.types';

export interface ProjectRetryPayloadCandidate {
  data: Project;
  sourceUserId?: string;
  taskIdsToDelete?: string[];
  taskDeleteBaseUpdatedAtMap?: ProjectPayload['taskDeleteBaseUpdatedAtMap'];
}

export function resolveProjectRetryOwnerUserId(
  sourceUserId: string | undefined,
  currentUserId: string | null | undefined,
  localModeUserId: string = AUTH_CONFIG.LOCAL_MODE_USER_ID,
): string {
  return sourceUserId ?? currentUserId ?? localModeUserId;
}

export function wasProjectFailureTransferredToRetryQueue(
  result: ProjectSyncResult,
  payload: ProjectPayload,
  options: {
    projectRetryPayloadMatches: (payload: ProjectPayload) => boolean;
  },
): boolean {
  const retryEntries = new Set(result.retryEnqueued ?? []);
  if (retryEntries.size === 0) {
    return false;
  }

  if (result.projectPushed === false) {
    if (!retryEntries.has(`project:${payload.project.id}`)) {
      return false;
    }

    if (!options.projectRetryPayloadMatches(payload)) {
      return false;
    }
  }

  const allFailedTasksTransferred = (result.failedTaskIds ?? [])
    .every(taskId => retryEntries.has(`task:${taskId}`));
  if (!allFailedTasksTransferred) {
    return false;
  }

  return (result.failedConnectionIds ?? [])
    .every(connectionId => retryEntries.has(`connection:${connectionId}`));
}

export function doesProjectRetryPayloadMatch(
  payload: ProjectPayload,
  queuedProjectRetry: ProjectRetryPayloadCandidate | null | undefined,
): boolean {
  if (!queuedProjectRetry) return false;

  return buildProjectRetryPayloadSignature(
    queuedProjectRetry.data,
    queuedProjectRetry.sourceUserId,
    queuedProjectRetry.taskIdsToDelete,
    queuedProjectRetry.taskDeleteBaseUpdatedAtMap,
  ) === buildProjectRetryPayloadSignature(
    payload.project,
    payload.sourceUserId,
    payload.taskIdsToDelete,
    payload.taskDeleteBaseUpdatedAtMap,
  );
}

export function buildProjectRetryPayloadSignature(
  project: Project,
  sourceUserId?: string,
  taskIdsToDelete?: string[],
  taskDeleteBaseUpdatedAtMap?: ProjectPayload['taskDeleteBaseUpdatedAtMap'],
): string {
  return JSON.stringify({
    project,
    sourceUserId: sourceUserId ?? null,
    taskIdsToDelete: [...(taskIdsToDelete ?? [])].sort(),
    taskDeleteBaseUpdatedAtMap: Object.fromEntries(
      Object.entries(taskDeleteBaseUpdatedAtMap ?? {}).sort(([left], [right]) => left.localeCompare(right)),
    ),
  });
}
