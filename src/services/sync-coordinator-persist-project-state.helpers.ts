import { AUTH_CONFIG } from '../config/auth.config';
import type { Project } from '../models';
import {
  buildPartialPersistLogData,
  type PartialPersistFailureRiskReport,
} from './sync-coordinator-partial-persist-risk';
import {
  buildPersistConnectionSignature,
  buildPersistDataSignature,
  buildPersistTaskSignature,
} from './sync-coordinator-signatures';

export interface PersistSnapshotRepairSummary {
  staleTaskIds: string[];
  changedTaskIds: string[];
  staleConnectionIds: string[];
  changedConnectionIds: string[];
  supersededTaskIds: string[];
  supersededConnectionIds: string[];
}

interface PartialPersistRiskReporter {
  logger: {
    info(message: string, context?: unknown): void;
    warn(message: string, context?: unknown): void;
  };
  toast: {
    warning(title: string, message: string): void;
  };
}

interface RemotePersistProjectStateInput {
  projectId: string;
  newVersion: number | undefined;
  now: string;
  shouldClearProjectDirtyState: boolean;
}

export function hasPersistSnapshotDrift(activeProject: Project, currentProject: Project): boolean {
  return buildPersistDataSignature(activeProject) !== buildPersistDataSignature(currentProject);
}

export function buildPersistSnapshotRepairSummary(
  activeProject: Project,
  currentProject: Project,
): PersistSnapshotRepairSummary {
  const activeTasksById = new Map(activeProject.tasks.map(task => [task.id, task] as const));
  const activeConnectionsById = new Map(activeProject.connections.map(connection => [connection.id, connection] as const));
  const currentTaskIds = new Set(currentProject.tasks.map(task => task.id));
  const currentConnectionIds = new Set(currentProject.connections.map(connection => connection.id));
  const staleTaskIds = activeProject.tasks
    .filter(task => !currentTaskIds.has(task.id))
    .map(task => task.id);
  const changedTaskIds = currentProject.tasks
    .filter(task => {
      const activeTask = activeTasksById.get(task.id);
      return activeTask !== undefined
        && buildPersistTaskSignature(activeTask) !== buildPersistTaskSignature(task);
    })
    .map(task => task.id);
  const staleConnectionIds = activeProject.connections
    .filter(connection => !currentConnectionIds.has(connection.id))
    .map(connection => connection.id);
  const changedConnectionIds = currentProject.connections
    .filter(connection => {
      const activeConnection = activeConnectionsById.get(connection.id);
      return activeConnection !== undefined
        && buildPersistConnectionSignature(activeConnection) !== buildPersistConnectionSignature(connection);
    })
    .map(connection => connection.id);

  return {
    staleTaskIds,
    changedTaskIds,
    staleConnectionIds,
    changedConnectionIds,
    supersededTaskIds: Array.from(new Set([...staleTaskIds, ...changedTaskIds])),
    supersededConnectionIds: Array.from(new Set([...staleConnectionIds, ...changedConnectionIds])),
  };
}

export function applyPersistOfflineTimestamp(
  projects: Project[],
  projectId: string | null,
  now: string,
): Project[] {
  return projects.map(candidate => candidate.id === projectId ? { ...candidate, updatedAt: now } : candidate);
}

export function applyLocalOnlyPersistState(
  projects: Project[],
  projectId: string,
  now: string,
  userId: string,
): Project[] {
  return projects.map(project =>
    project.id === projectId
      ? {
          ...project,
          updatedAt: now,
          syncSource: 'local-only',
          pendingSync: userId === AUTH_CONFIG.LOCAL_MODE_USER_ID
            ? (project.pendingSync ?? false)
            : true,
        }
      : project,
  );
}

export function applyRemotePersistProjectState(
  projects: Project[],
  input: RemotePersistProjectStateInput,
): Project[] {
  return projects.map(project =>
    project.id === input.projectId
      ? {
          ...project,
          updatedAt: project.updatedAt && project.updatedAt > input.now ? project.updatedAt : input.now,
          version: input.newVersion ?? project.version,
          syncSource: 'synced',
          pendingSync: input.shouldClearProjectDirtyState ? false : true,
        }
      : project,
  );
}

export function reportPartialPersistFailureRisk(
  report: PartialPersistFailureRiskReport,
  reporter: PartialPersistRiskReporter,
): void {
  if (report.hasDataAtRisk && !report.actionQueueReplayPending) {
    reporter.logger.warn('远端未完全确认，存在未入重试队列的风险项', buildPartialPersistLogData(report));
    reporter.toast.warning(
      '同步未完成',
      `任务失败 ${report.failedTasks} 项，连接失败 ${report.failedConnections} 项，已保留待同步标记`,
    );
    return;
  }

  if (report.hasDataAtRisk) {
    reporter.logger.info('远端未完全确认，未入重试队列的项仍由 ActionQueue 保底回放', buildPartialPersistLogData(report));
    return;
  }

  reporter.logger.info('远端未完全确认，所有失败项已入重试队列，等待自动重试', {
    projectId: report.projectId,
    failedTasks: report.failedTasks,
    failedConnections: report.failedConnections,
    failureReason: report.failureReason,
  });
}
