import type { Connection, Project, Task } from '../../../models';

export const STORE_PERSISTENCE_FALLBACK_PREFIX = 'nanoflow.idb-fallback.';

export interface ProjectPersistenceSnapshot {
  project: Project;
  tasks: Task[];
  connections: Connection[];
}

interface StoredProjectPersistenceFallback extends ProjectPersistenceSnapshot {
  version: 1;
  timestamp: string;
}

export function getStorePersistenceFallbackKey(projectId: string): string {
  return `${STORE_PERSISTENCE_FALLBACK_PREFIX}${projectId}`;
}

export function writeStorePersistenceFallback(
  projectId: string,
  snapshot: ProjectPersistenceSnapshot,
): void {
  if (typeof localStorage === 'undefined') {
    throw new Error('localStorage unavailable');
  }

  const fallback: StoredProjectPersistenceFallback = {
    version: 1,
    timestamp: new Date().toISOString(),
    ...snapshot,
  };
  localStorage.setItem(getStorePersistenceFallbackKey(projectId), JSON.stringify(fallback));
}

export function readStorePersistenceFallback(
  projectId: string,
): ProjectPersistenceSnapshot | null {
  if (typeof localStorage === 'undefined') return null;

  let raw: string | null = null;
  try {
    raw = localStorage.getItem(getStorePersistenceFallbackKey(projectId));
  } catch {
    raw = null;
  }
  if (!raw) return null;

  let parsed: Partial<StoredProjectPersistenceFallback> | null = null;
  try {
    parsed = JSON.parse(raw) as Partial<StoredProjectPersistenceFallback>;
  } catch {
    parsed = null;
  }
  if (
    !parsed
    || parsed.version !== 1
    || typeof parsed.timestamp !== 'string'
    || !isRecord(parsed.project)
    || parsed.project['id'] !== projectId
    || !Array.isArray(parsed.tasks)
    || !Array.isArray(parsed.connections)
  ) {
    return null;
  }

  return {
    project: parsed.project as unknown as Project,
    tasks: parsed.tasks as Task[],
    connections: parsed.connections as Connection[],
  };
}

export function shouldPreferStorePersistenceFallback(
  fallback: ProjectPersistenceSnapshot,
  indexedDbProject: Project,
): boolean {
  const fallbackUpdatedAt = parseTimestamp(fallback.project.updatedAt);
  const indexedDbUpdatedAt = parseTimestamp(indexedDbProject.updatedAt);
  if (fallbackUpdatedAt === null) return indexedDbUpdatedAt === null;
  if (indexedDbUpdatedAt === null) return true;
  return fallbackUpdatedAt >= indexedDbUpdatedAt;
}

export function removeStorePersistenceFallback(projectId: string): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.removeItem(getStorePersistenceFallbackKey(projectId));
  } catch {
    // Cleanup is best-effort; full wipe also removes the shared prefix.
  }
}

export function clearStorePersistenceFallbacks(): void {
  if (typeof localStorage === 'undefined') return;
  try {
    for (let index = localStorage.length - 1; index >= 0; index -= 1) {
      const key = localStorage.key(index);
      if (key?.startsWith(STORE_PERSISTENCE_FALLBACK_PREFIX)) {
        localStorage.removeItem(key);
      }
    }
  } catch {
    // Cleanup is best-effort; callers already isolate cache cleanup failures.
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseTimestamp(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}
