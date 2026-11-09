import type { Project } from '../models';
import { captureLocalProjectRefreshState } from './sync-coordinator-signatures';

interface AccessibleProjectProbeLike {
  projectId: string;
  accessible: boolean;
}

interface RetryQueueProjectIntentLike {
  type: string;
  operation: string;
  projectId?: string;
  data: unknown;
}

export function createDownloadMergeLocalProjectsSignature(projects: readonly Project[]): string {
  return JSON.stringify(
    [...projects]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map(project => [project.id, captureLocalProjectRefreshState(project).signature]),
  );
}

export function hasPendingRetryQueueItemForProject(
  items: readonly RetryQueueProjectIntentLike[],
  projectId: string,
): boolean {
  return items.some(item => {
    if (item.type === 'project' && item.operation === 'delete') {
      return false;
    }
    if (item.projectId === projectId) {
      return true;
    }
    const data = item.data as { id?: unknown; projectId?: unknown };
    return data?.projectId === projectId || (item.type === 'project' && data?.id === projectId);
  });
}

export function isExplicitProjectInaccessibleProbe(
  probe: AccessibleProjectProbeLike | null,
  projectId: string,
): boolean {
  return probe?.projectId === projectId && probe.accessible === false;
}

export function isActiveProjectRefreshFastPath(
  pullCursorMs: number | null,
  remoteWatermark: string,
): boolean {
  if (pullCursorMs === null) return false;
  const remoteUpdatedAtMs = new Date(remoteWatermark).getTime();
  return Number.isFinite(remoteUpdatedAtMs) && remoteUpdatedAtMs <= pullCursorMs;
}
