import { AUTH_CONFIG } from '../config/auth.config';
import type { Project } from '../models';

export interface PendingOwnerHandoffProjectIdsInput {
  changedProjectIds: Iterable<string>;
  activeProjectId: string | null;
  hasPendingLocalChanges: boolean;
}

export function getPendingOwnerHandoffProjectIds(
  input: PendingOwnerHandoffProjectIdsInput,
): Set<string> {
  const projectIds = new Set(input.changedProjectIds);

  if (input.activeProjectId && input.hasPendingLocalChanges) {
    projectIds.add(input.activeProjectId);
  }

  return projectIds;
}

export function hasProtectedOfflineProjects(
  projects: readonly Project[],
  excludedProjectIds?: ReadonlySet<string>,
): boolean {
  return projects.some(project => {
    if (excludedProjectIds?.has(project.id)) {
      return false;
    }

    return project.pendingSync === true || project.syncSource === 'local-only';
  });
}

export function shouldRetainOwnerHandoffSnapshot(project: Project, ownerUserId: string | null): boolean {
  return !ownerUserId || ownerUserId === AUTH_CONFIG.LOCAL_MODE_USER_ID || project.syncSource === 'local-only';
}

export function getNonEmptyTaskDeleteBaseUpdatedAtMap(
  map: Record<string, string | null | undefined> | undefined,
): Record<string, string | null | undefined> | undefined {
  return map && Object.keys(map).length > 0 ? map : undefined;
}
