import type { Project } from '../models';

interface ImmediateOfflineSnapshotLogger {
  warn(message: string, data?: Record<string, unknown>): void;
}

export interface BuildImmediateOfflineSnapshotProjectsInput {
  currentProjects: readonly Project[];
  targetProjectId: string;
  afterProject: Project;
}

export interface PersistImmediateOfflineSnapshotInput {
  projectId: string;
  afterProject: Project;
  currentProjects: readonly Project[];
  currentUserId: string | null | undefined;
  logger: ImmediateOfflineSnapshotLogger;
  saveOfflineSnapshotAndWait(projects: Project[], userId: string | null | undefined): Promise<void>;
}

export function buildImmediateOfflineSnapshotProjects(
  input: BuildImmediateOfflineSnapshotProjectsInput,
): Project[] {
  const { currentProjects, targetProjectId, afterProject } = input;
  if (currentProjects.length === 0) {
    return [afterProject];
  }

  let found = false;
  const snapshotProjects = currentProjects.map(project => {
    if (project.id !== targetProjectId) {
      return project;
    }

    found = true;
    return afterProject;
  });

  return found ? snapshotProjects : [...snapshotProjects, afterProject];
}

export async function persistImmediateOfflineSnapshot({
  projectId,
  afterProject,
  currentProjects,
  currentUserId,
  logger,
  saveOfflineSnapshotAndWait,
}: PersistImmediateOfflineSnapshotInput): Promise<void> {
  try {
    await saveOfflineSnapshotAndWait(
      buildImmediateOfflineSnapshotProjects({
        currentProjects,
        targetProjectId: projectId,
        afterProject,
      }),
      currentUserId,
    );
  } catch (error) {
    logger.warn('即时离线快照持久化失败，保留 Outbox 并等待后台持久化重试', {
      projectId,
      error,
    });
  }
}
