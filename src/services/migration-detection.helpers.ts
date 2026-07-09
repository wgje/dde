import type { Project } from '../models';

export function detectMigrationNeed(localProjects: Project[], remoteProjects: Project[]): boolean {
  const effectiveRemoteProjects = remoteProjects.filter(project => project.syncSource === 'synced');
  const remoteProjectIds = new Set(effectiveRemoteProjects.map(project => project.id));
  const remoteProjectMap = new Map(effectiveRemoteProjects.map(project => [project.id, project]));

  const hasLocalOnlyProjects = localProjects.some(local => !remoteProjectIds.has(local.id));
  if (hasLocalOnlyProjects) {
    return true;
  }

  return localProjects.some(local => {
    const remote = remoteProjectMap.get(local.id);
    if (!remote) return false;
    return (local.version ?? 0) > (remote.version ?? 0);
  });
}
