import type { DockSnapshot } from '../../../../models/parking-dock';

export interface FocusSessionLoadRow {
  session_state?: unknown;
  updated_at?: unknown;
}

function isDockSnapshotLike(value: unknown): value is DockSnapshot {
  if (!value || typeof value !== 'object') return false;
  const version = (value as Record<string, unknown>)['version'];
  return typeof version === 'number' && version >= 2 && version <= 7;
}

function toEpochMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || !value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

export function selectRemoteFocusSnapshot(
  row: FocusSessionLoadRow | null | undefined,
  localUpdatedAt?: string,
): DockSnapshot | null {
  if (!row) {
    return null;
  }

  if (localUpdatedAt && row.updated_at) {
    const remoteMs = toEpochMs(row.updated_at);
    const localMs = toEpochMs(localUpdatedAt);
    if (remoteMs !== null && localMs !== null && remoteMs < localMs) {
      return null;
    }
  }

  return isDockSnapshotLike(row.session_state)
    ? row.session_state
    : null;
}
