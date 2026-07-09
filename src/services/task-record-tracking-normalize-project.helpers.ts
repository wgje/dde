import type { Project } from '../models';
import { softDeleteParentChildDuplicateConnections } from '../utils/parent-child-connection-integrity';
import type { CategoryLogger } from './logger.service';

export function normalizeTaskRecordProjectConnections(
  project: Project,
  logger: Pick<CategoryLogger, 'warn'>,
): Project {
  if (project.connections.length === 0) {
    return project;
  }

  const now = new Date().toISOString();
  const normalizedConnections = softDeleteParentChildDuplicateConnections(
    project.tasks,
    project.connections,
    now,
  );

  if (normalizedConnections === project.connections) {
    return project;
  }

  const affectedConnectionIds = collectSoftDeletedConnectionIds(
    project.connections,
    normalizedConnections,
  );
  logger.warn('检测到与 parentId 重复的 shadow connection，已自动软删', {
    projectId: project.id,
    affectedConnectionIds,
  });

  return {
    ...project,
    connections: normalizedConnections,
  };
}

function collectSoftDeletedConnectionIds(
  beforeConnections: Project['connections'],
  afterConnections: Project['connections'],
): string[] {
  const affectedConnectionIds: string[] = [];
  for (let index = 0; index < beforeConnections.length; index += 1) {
    const beforeConnection = beforeConnections[index];
    const afterConnection = afterConnections[index];
    if (!beforeConnection || !afterConnection) {
      continue;
    }

    if (!beforeConnection.deletedAt && !!afterConnection.deletedAt) {
      affectedConnectionIds.push(afterConnection.id);
    }
  }

  return affectedConnectionIds;
}
