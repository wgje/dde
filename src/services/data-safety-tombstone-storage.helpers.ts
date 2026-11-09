import type {
  DataSafetyConnectionTombstoneSnapshot,
  DataSafetyTaskTombstoneSnapshot,
} from './import-backup-data-safety-metadata.helpers';

export const TASK_TOMBSTONES_STORAGE_KEY = 'nanoflow.local-tombstones';
export const CONNECTION_TOMBSTONES_STORAGE_KEY = 'nanoflow.local-connection-tombstones';

export function writeScopedTaskTombstones(
  target: DataSafetyTaskTombstoneSnapshot,
  touchedProjectIds: ReadonlySet<string>,
): void {
  const parsed = parseStorageJson(TASK_TOMBSTONES_STORAGE_KEY, {});
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('current task tombstone state is invalid');
  }
  const merged = { ...(parsed as Record<string, unknown>) };
  for (const projectId of touchedProjectIds) delete merged[projectId];
  for (const [projectId, entries] of Object.entries(target)) {
    merged[projectId] = entries;
  }
  localStorage.setItem(TASK_TOMBSTONES_STORAGE_KEY, JSON.stringify(merged));
}

export function writeScopedConnectionTombstones(
  target: DataSafetyConnectionTombstoneSnapshot[],
  touchedProjectIds: ReadonlySet<string>,
): void {
  const parsed = parseStorageJson(CONNECTION_TOMBSTONES_STORAGE_KEY, []);
  if (!Array.isArray(parsed)) {
    throw new Error('current connection tombstone state is invalid');
  }
  const preserved = parsed.filter((entry) => {
    if (!entry || typeof entry !== 'object') return true;
    const projectId = (entry as Record<string, unknown>)['projectId'];
    return typeof projectId !== 'string' || !touchedProjectIds.has(projectId);
  });
  const restored = target.map(entry => ({
    projectId: entry.projectId,
    id: entry.connectionId,
    connectionId: entry.connectionId,
    timestamp: entry.timestamp,
  }));
  localStorage.setItem(
    CONNECTION_TOMBSTONES_STORAGE_KEY,
    JSON.stringify([...preserved, ...restored]),
  );
}

function parseStorageJson(key: string, fallback: unknown): unknown {
  const raw = localStorage.getItem(key);
  return raw === null ? fallback : JSON.parse(raw);
}
