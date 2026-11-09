export interface PersistedConnectionTombstone {
  id: string;
  timestamp: number;
  projectId?: string;
}

export function serializeLocalTombstones(
  tombstones: ReadonlyMap<string, ReadonlyMap<string, number>>,
): Record<string, Record<string, number>> {
  const serialized: Record<string, Record<string, number>> = {};

  for (const [projectId, taskTombstones] of tombstones) {
    const serializedTasks: Record<string, number> = {};
    for (const [taskId, timestamp] of taskTombstones) {
      serializedTasks[taskId] = timestamp;
    }
    serialized[projectId] = serializedTasks;
  }

  return serialized;
}

export function normalizePersistedConnectionTombstones(
  value: unknown,
  cutoff: number,
): PersistedConnectionTombstone[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const normalized: PersistedConnectionTombstone[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }

    const record = entry as Record<string, unknown>;
    const id = record['id'] ?? record['connectionId'];
    const timestamp = record['timestamp'];
    const projectId = record['projectId'];
    if (typeof id !== 'string'
      || !id
      || typeof timestamp !== 'number'
      || !Number.isFinite(timestamp)
      || timestamp <= cutoff) {
      continue;
    }

    normalized.push({
      id,
      timestamp,
      ...(typeof projectId === 'string' && projectId ? { projectId } : {}),
    });
  }

  return normalized;
}
