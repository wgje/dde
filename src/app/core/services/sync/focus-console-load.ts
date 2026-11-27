import type { DockSnapshot } from '../../../../models/parking-dock';

export interface FocusSessionLoadRow {
  session_state?: unknown;
  updated_at?: unknown;
  ended_at?: unknown;
}

function isDockSnapshotLike(value: unknown): value is DockSnapshot {
  if (!value || typeof value !== 'object') return false;
  const version = (value as Record<string, unknown>)['version'];
  return typeof version === 'number' && version >= 2 && version <= 7;
}

function toEpochMs(value: unknown): number | null {
  if (typeof value !== 'string' || !value) return null;
  const timestamp = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:0\d|1[0-4]):[0-5]\d)$/;
  const parts = timestamp.exec(value);
  if (!parts) return null;
  const year = Number(parts[1]);
  const month = Number(parts[2]);
  const day = Number(parts[3]);
  // Date.parse normalizes impossible calendar dates (for example February 30).
  // Reject those values rather than manufacture logical freshness evidence.
  const monthEnd = new Date(0);
  monthEnd.setUTCFullYear(year, month, 0);
  if (day > monthEnd.getUTCDate()) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

export function selectRemoteFocusSnapshot(
  row: FocusSessionLoadRow | null | undefined,
  localUpdatedAt?: string,
): DockSnapshot | null {
  if (!row || !isDockSnapshotLike(row.session_state)) {
    return null;
  }

  // Database updated_at may be a trigger/server write time, not the time the
  // business snapshot was produced. Never use it to promote an older snapshot.
  const remoteMs = toEpochMs(row.session_state.savedAt);
  if (remoteMs === null) return null;
  if (row.ended_at !== null) {
    const endedMs = toEpochMs(row.ended_at);
    if (endedMs === null || remoteMs < endedMs
      || row.session_state.focusMode !== false
      || row.session_state.focusSessionState?.isActive === true) {
      return null;
    }
  }
  if (localUpdatedAt !== undefined) {
    const localMs = toEpochMs(localUpdatedAt);
    if (localMs === null || remoteMs < localMs) {
      return null;
    }
  }

  return row.session_state;
}
