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
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(parsed).filter(([projectId]) => visibleProjectIds.has(projectId)),
  );
}

export function filterConnectionTombstonesByVisibleProjects(
  parsed: unknown,
  visibleProjectIds: Set<string>,
): unknown[] {
  if (!Array.isArray(parsed)) {
    return [];
  }

  return parsed.filter((entry) => {
    if (!entry || typeof entry !== 'object' || !('projectId' in entry)) {
      return false;
    }

    const projectId = (entry as Record<string, unknown>)['projectId'];
    return typeof projectId === 'string' && visibleProjectIds.has(projectId);
  });
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
