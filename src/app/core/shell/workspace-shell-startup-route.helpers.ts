import type { Project } from '../../../models';
import {
  resolveStartupEntryRouteIntent,
  type StartupEntryIntent,
} from '../../../utils/startup-entry-intent';

export type ConsumedStartupEntryNavigationCommands = string[];

export function resolveStartupProjectFallbackId(input: {
  projects: readonly Pick<Project, 'id'>[];
  startupLaunchSnapshot: {
    activeProjectId: string | null;
    currentProject?: Pick<Project, 'id'> | null;
  } | null;
}): string | null {
  if (input.projects.length === 0) {
    return null;
  }

  const snapshotProjectId =
    input.startupLaunchSnapshot?.currentProject?.id
    ?? input.startupLaunchSnapshot?.activeProjectId
    ?? null;

  if (snapshotProjectId && input.projects.some((project) => project.id === snapshotProjectId)) {
    return snapshotProjectId;
  }

  return input.projects[0]?.id ?? null;
}

export function shouldNavigateRootStartupToTextProject(input: {
  routeUrl: string;
  isMobile: boolean;
  rootStartupTextNavigationApplied: boolean;
  startupEntryIntent: Pick<StartupEntryIntent, 'intent'> | null;
}): boolean {
  if (input.rootStartupTextNavigationApplied || !input.isMobile) {
    return false;
  }

  const routePath = input.routeUrl.split('?')[0] ?? input.routeUrl;
  if (routePath !== '/projects') {
    return false;
  }

  return !input.startupEntryIntent || input.startupEntryIntent.intent === 'open-workspace';
}

export function resolveConsumedStartupEntryNavigation(input: {
  routeUrl: string | null;
  mobileRootProjectId: string | null | (() => string | null);
}): ConsumedStartupEntryNavigationCommands {
  const routeIntent = resolveStartupEntryRouteIntent(input.routeUrl);

  if (!routeIntent?.projectId) {
    const mobileRootProjectId = typeof input.mobileRootProjectId === 'function'
      ? input.mobileRootProjectId()
      : input.mobileRootProjectId;
    return mobileRootProjectId
      ? ['/projects', mobileRootProjectId, 'text']
      : ['/projects'];
  }

  switch (routeIntent.kind) {
    case 'task':
      return routeIntent.taskId
        ? ['/projects', routeIntent.projectId, 'task', routeIntent.taskId]
        : ['/projects'];
    case 'flow':
      return ['/projects', routeIntent.projectId, 'flow'];
    case 'text':
      return ['/projects', routeIntent.projectId, 'text'];
    case 'project':
      return ['/projects', routeIntent.projectId];
    default:
      return ['/projects'];
  }
}
