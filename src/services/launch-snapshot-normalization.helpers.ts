import type {
  LaunchRouteIntent,
  LaunchSnapshot,
  LaunchSnapshotProject,
  LaunchSnapshotTask,
} from '../models/launch-shell';
import { resolveRouteIntent } from '../utils/route-intent';

export const LAUNCH_SNAPSHOT_VERSION_V1 = 1 as const;
export const LAUNCH_SNAPSHOT_VERSION_V2 = 2 as const;

type LaunchView = 'text' | 'flow';

export function normalizeLaunchSnapshot(value: unknown): LaunchSnapshot | null {
  if (!isRecord(value)) {
    return null;
  }

  const source = value as Partial<LaunchSnapshot>;
  if (source.version !== LAUNCH_SNAPSHOT_VERSION_V1 && source.version !== LAUNCH_SNAPSHOT_VERSION_V2) {
    return null;
  }

  const projects = normalizeProjects(source.projects);
  const activeProjectId = typeof source.activeProjectId === 'string' ? source.activeProjectId : null;

  if (source.version === LAUNCH_SNAPSHOT_VERSION_V1) {
    return normalizeV1LaunchSnapshot(source, projects, activeProjectId);
  }

  return normalizeV2LaunchSnapshot(source, projects, activeProjectId);
}

function normalizeV1LaunchSnapshot(
  source: Partial<LaunchSnapshot>,
  projects: LaunchSnapshotProject[],
  activeProjectId: string | null,
): LaunchSnapshot {
  const preferredView = isLaunchView(source.lastActiveView) ? source.lastActiveView : null;

  return {
    version: LAUNCH_SNAPSHOT_VERSION_V2,
    savedAt: normalizeSavedAt(source.savedAt),
    activeProjectId,
    lastActiveView: preferredView,
    preferredView,
    resolvedLaunchView: preferredView ?? 'text',
    routeIntent: resolveRouteIntent(null, activeProjectId),
    mobileDegraded: false,
    degradeReason: null,
    theme: source.theme ?? 'default',
    colorMode: source.colorMode ?? 'system',
    projects,
    currentProject: findCurrentProject(projects, activeProjectId),
  };
}

function normalizeV2LaunchSnapshot(
  source: Partial<LaunchSnapshot>,
  projects: LaunchSnapshotProject[],
  activeProjectId: string | null,
): LaunchSnapshot {
  const preferredView = resolvePreferredView(source);
  const currentProject = normalizeLaunchProject(source.currentProject)
    ?? findCurrentProject(projects, activeProjectId);

  return {
    version: LAUNCH_SNAPSHOT_VERSION_V2,
    savedAt: normalizeSavedAt(source.savedAt),
    userId: typeof source.userId === 'string' ? source.userId : null,
    activeProjectId,
    lastActiveView: isLaunchView(source.lastActiveView) ? source.lastActiveView : preferredView,
    preferredView,
    resolvedLaunchView: isLaunchView(source.resolvedLaunchView)
      ? source.resolvedLaunchView
      : preferredView ?? 'text',
    routeIntent: normalizeLaunchRouteIntent(source.routeIntent, activeProjectId),
    mobileDegraded: source.mobileDegraded === true,
    degradeReason: typeof source.degradeReason === 'string' ? source.degradeReason : null,
    theme: source.theme ?? 'default',
    colorMode: source.colorMode ?? 'system',
    projects,
    currentProject,
  };
}

function normalizeProjects(value: unknown): LaunchSnapshotProject[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((project) => normalizeLaunchProject(project))
    .filter((project): project is LaunchSnapshotProject => !!project);
}

function normalizeLaunchProject(value: unknown): LaunchSnapshotProject | null {
  if (!isRecord(value)) {
    return null;
  }

  const source = value as Partial<LaunchSnapshotProject>;
  if (typeof source.id !== 'string' || typeof source.name !== 'string') {
    return null;
  }

  return {
    id: source.id,
    name: source.name,
    description: typeof source.description === 'string' ? source.description : '',
    updatedAt: typeof source.updatedAt === 'string' ? source.updatedAt : null,
    taskCount: Number.isFinite(source.taskCount) ? Number(source.taskCount) : 0,
    openTaskCount: Number.isFinite(source.openTaskCount) ? Number(source.openTaskCount) : 0,
    recentTasks: normalizeTasks(source.recentTasks),
  };
}

function normalizeTasks(value: unknown): LaunchSnapshotTask[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((task) => normalizeLaunchTask(task))
    .filter((task): task is LaunchSnapshotTask => !!task);
}

function normalizeLaunchTask(value: unknown): LaunchSnapshotTask | null {
  if (!isRecord(value)) {
    return null;
  }

  const source = value as Partial<LaunchSnapshotTask>;
  if (
    typeof source.id !== 'string' ||
    typeof source.title !== 'string' ||
    typeof source.displayId !== 'string' ||
    !isLaunchTaskStatus(source.status)
  ) {
    return null;
  }

  return {
    id: source.id,
    title: source.title,
    displayId: source.displayId,
    status: source.status,
  };
}

function normalizeLaunchRouteIntent(value: unknown, activeProjectId: string | null): LaunchRouteIntent {
  if (!isRecord(value)) {
    return resolveRouteIntent(null, activeProjectId);
  }

  const source = value as Partial<LaunchRouteIntent>;
  if (!isLaunchRouteIntentKind(source.kind)) {
    return resolveRouteIntent(null, activeProjectId);
  }

  return {
    kind: source.kind,
    projectId: typeof source.projectId === 'string' ? source.projectId : activeProjectId,
    taskId: typeof source.taskId === 'string' ? source.taskId : null,
  };
}

function normalizeSavedAt(value: unknown): string {
  return typeof value === 'string' && value ? value : new Date().toISOString();
}

function resolvePreferredView(source: Partial<LaunchSnapshot>): LaunchView | null {
  if (isLaunchView(source.preferredView)) {
    return source.preferredView;
  }

  return isLaunchView(source.lastActiveView) ? source.lastActiveView : null;
}

function findCurrentProject(
  projects: LaunchSnapshotProject[],
  activeProjectId: string | null,
): LaunchSnapshotProject | null {
  return activeProjectId
    ? projects.find((project) => project.id === activeProjectId) ?? null
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object';
}

function isLaunchView(value: unknown): value is LaunchView {
  return value === 'flow' || value === 'text';
}

function isLaunchTaskStatus(value: unknown): value is LaunchSnapshotTask['status'] {
  return value === 'active' || value === 'completed' || value === 'archived';
}

function isLaunchRouteIntentKind(value: unknown): value is LaunchRouteIntent['kind'] {
  return value === 'projects' || value === 'project' || value === 'text'
    || value === 'flow' || value === 'task';
}
