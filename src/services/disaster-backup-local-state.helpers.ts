import { safeParseJson } from './disaster-backup-browser-storage.helpers';

export type DockSnapshotSource =
  | 'idb-current'
  | 'idb-anonymous'
  | 'legacy-current'
  | 'legacy-anonymous';

export interface DockSnapshotCandidate {
  source: DockSnapshotSource;
  snapshot: Record<string, unknown> & { savedAt: string };
  localStorageValue: string | null;
}

export function filterTaskTombstonesByVisibleProjects(
  parsed: unknown,
  visibleProjectIds: Set<string>,
): Record<string, unknown> {
  if (!isUnknownRecord(parsed)) {
    throw new Error('Task tombstone storage must be an object');
  }

  const visibleEntries: Array<[string, unknown]> = [];
  for (const [projectId, tombstones] of Object.entries(parsed)) {
    if (!projectId) throw new Error('Task tombstone requires a non-empty project ID');
    if (!visibleProjectIds.has(projectId)) continue;
    if (!isUnknownRecord(tombstones)) {
      throw new Error(`Task tombstone project ${projectId} must contain an ID map`);
    }
    for (const [taskId, timestamp] of Object.entries(tombstones)) {
      if (!taskId || !isValidTombstoneTimestamp(timestamp)) {
        throw new Error(`Task tombstone project ${projectId} contains an invalid ID or timestamp`);
      }
    }
    visibleEntries.push([projectId, tombstones]);
  }
  return Object.fromEntries(visibleEntries);
}

export function filterConnectionTombstonesByVisibleProjects(
  parsed: unknown,
  visibleProjectIds: Set<string>,
): unknown[] {
  if (!Array.isArray(parsed)) {
    throw new Error('Connection tombstone storage must be an array');
  }

  const visibleEntries: Record<string, unknown>[] = [];
  for (const entry of parsed) {
    if (!isUnknownRecord(entry)) throw new Error('Connection tombstone row must be an object');
    const projectId = nonEmptyString(entry['projectId']);
    if (!projectId) throw new Error('Connection tombstone requires a non-empty project ID');
    if (!visibleProjectIds.has(projectId)) continue;

    const hasId = Object.prototype.hasOwnProperty.call(entry, 'id');
    const hasConnectionId = Object.prototype.hasOwnProperty.call(entry, 'connectionId');
    const id = hasId ? nonEmptyString(entry['id']) : null;
    const connectionId = hasConnectionId ? nonEmptyString(entry['connectionId']) : null;
    if ((!hasId && !hasConnectionId) || (hasId && !id) || (hasConnectionId && !connectionId)) {
      throw new Error(`Connection tombstone project ${projectId} contains an invalid ID`);
    }
    if (id && connectionId && id !== connectionId) {
      throw new Error(`Connection tombstone project ${projectId} contains conflicting IDs`);
    }
    if (!isValidTombstoneTimestamp(entry['timestamp'])) {
      throw new Error(`Connection tombstone project ${projectId} contains an invalid timestamp`);
    }
    visibleEntries.push(entry);
  }
  return visibleEntries;
}

function isValidTombstoneTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function readDockSnapshotSavedAt(value: unknown): string | null {
  if (!value || typeof value !== 'object' || !('savedAt' in value)) {
    return null;
  }

  const savedAt = (value as { savedAt?: unknown }).savedAt;
  return typeof savedAt === 'string' && savedAt ? savedAt : null;
}

export function pickNewerDockSnapshot<T extends { snapshot: { savedAt: string } }>(
  current: T | null,
  incoming: T | null,
): T | null {
  if (!current) return incoming;
  if (!incoming) return current;

  const currentSavedAt = Date.parse(current.snapshot.savedAt);
  const incomingSavedAt = Date.parse(incoming.snapshot.savedAt);
  if (Number.isNaN(incomingSavedAt)) return current;
  if (Number.isNaN(currentSavedAt)) return incoming;
  return incomingSavedAt > currentSavedAt ? incoming : current;
}

export function isLaunchSnapshotOwnedByCurrentUser(value: unknown, ownerUserId: string | null): boolean {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const snapshotUserId = 'userId' in value ? value.userId : undefined;
  if (typeof snapshotUserId === 'string') {
    return snapshotUserId === ownerUserId;
  }

  return ownerUserId === null;
}

export function toDockSnapshotCandidate(
  source: DockSnapshotSource,
  value: unknown,
): DockSnapshotCandidate | null {
  if (value == null) {
    return null;
  }

  if (source.startsWith('legacy-')) {
    if (typeof value !== 'string') {
      return null;
    }

    const parsed = safeParseJson(value);
    const savedAt = readDockSnapshotSavedAt(parsed);
    if (!savedAt) {
      return null;
    }

    return {
      source,
      snapshot: { ...(parsed as Record<string, unknown>), savedAt },
      localStorageValue: value,
    };
  }

  const savedAt = readDockSnapshotSavedAt(value);
  if (!savedAt || typeof value !== 'object') {
    return null;
  }

  return {
    source,
    snapshot: { ...(value as Record<string, unknown>), savedAt },
    localStorageValue: null,
  };
}
