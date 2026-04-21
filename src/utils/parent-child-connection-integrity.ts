import { Connection, Task } from '../models';

function getConnectionPairKey(sourceId: string, targetId: string): string {
  return `${sourceId}->${targetId}`;
}

export function buildActiveParentChildEdgeSet(tasks: Task[]): Set<string> {
  const edgeSet = new Set<string>();

  for (const task of tasks) {
    if (task.deletedAt || !task.parentId || task.parentId === task.id) {
      continue;
    }

    edgeSet.add(getConnectionPairKey(task.parentId, task.id));
  }

  return edgeSet;
}

export function isParentChildDuplicateConnection(
  tasks: Task[],
  sourceId: string,
  targetId: string,
): boolean {
  return buildActiveParentChildEdgeSet(tasks).has(getConnectionPairKey(sourceId, targetId));
}

export function filterParentChildDuplicateConnections(
  tasks: Task[],
  connections: Connection[],
): Connection[] {
  const parentChildEdgeSet = buildActiveParentChildEdgeSet(tasks);
  if (parentChildEdgeSet.size === 0) {
    return connections;
  }

  let changed = false;
  const filteredConnections = connections.filter(connection => {
    const keepConnection = !!connection.deletedAt || !parentChildEdgeSet.has(
      getConnectionPairKey(connection.source, connection.target),
    );

    if (!keepConnection) {
      changed = true;
    }

    return keepConnection;
  });

  return changed ? filteredConnections : connections;
}

export function softDeleteParentChildDuplicateConnections(
  tasks: Task[],
  connections: Connection[],
  now: string,
): Connection[] {
  const parentChildEdgeSet = buildActiveParentChildEdgeSet(tasks);
  if (parentChildEdgeSet.size === 0) {
    return connections;
  }

  let changed = false;
  const normalizedConnections = connections.map(connection => {
    if (connection.deletedAt) {
      return connection;
    }

    if (!parentChildEdgeSet.has(getConnectionPairKey(connection.source, connection.target))) {
      return connection;
    }

    changed = true;
    return {
      ...connection,
      deletedAt: now,
      updatedAt: now,
    };
  });

  return changed ? normalizedConnections : connections;
}