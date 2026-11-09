import type { ProjectPayload } from './action-queue.types';
import type { ProjectMutationStaleness } from './action-queue-project-processors.types';

export type DeferredTaskDeleteReplayAction = 'continue' | 'handoff' | 'stop';

export interface ResolveDeferredTaskDeleteReplayActionOptions {
  staleness: ProjectMutationStaleness | 'none';
  currentUserId: string | null | undefined;
  replayOwnerUserId: string | undefined;
  remainingTaskIds: readonly string[];
}

export function collectDeferredTaskDeleteIds(
  taskIdsToDelete: readonly unknown[] | undefined,
): string[] {
  if (!taskIdsToDelete || taskIdsToDelete.length === 0) {
    return [];
  }

  return [...new Set(taskIdsToDelete.filter((taskId): taskId is string =>
    typeof taskId === 'string' && taskId.length > 0
  ))];
}

export function resolveDeferredTaskDeleteReplayAction(
  options: ResolveDeferredTaskDeleteReplayActionOptions,
): DeferredTaskDeleteReplayAction {
  const {
    staleness,
    currentUserId,
    replayOwnerUserId,
    remainingTaskIds,
  } = options;

  if (staleness === 'queue-view-stale') return 'handoff';
  if (staleness === 'project-view-stale') {
    return remainingTaskIds.length > 0 ? 'handoff' : 'stop';
  }

  if (!currentUserId || (replayOwnerUserId && currentUserId !== replayOwnerUserId)) {
    return remainingTaskIds.length > 0 ? 'handoff' : 'stop';
  }

  return 'continue';
}

export function pickTaskDeleteBaseUpdatedAtMap(
  taskDeleteBaseUpdatedAtMap: ProjectPayload['taskDeleteBaseUpdatedAtMap'] | undefined,
  taskIds: readonly string[],
): ProjectPayload['taskDeleteBaseUpdatedAtMap'] | undefined {
  if (!taskDeleteBaseUpdatedAtMap) {
    return undefined;
  }

  const picked: ProjectPayload['taskDeleteBaseUpdatedAtMap'] = {};
  for (const taskId of taskIds) {
    if (Object.prototype.hasOwnProperty.call(taskDeleteBaseUpdatedAtMap, taskId)) {
      picked[taskId] = taskDeleteBaseUpdatedAtMap[taskId] ?? null;
    }
  }

  return Object.keys(picked).length > 0 ? picked : undefined;
}
