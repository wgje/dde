import type {
  OfflineCommandStore,
  OfflineProjectionRecord,
} from './offline-command-store';

export interface OfflineSyncRemoteProjectionRow {
  readonly ownerUserId: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly fields: Record<string, unknown>;
  readonly fieldVersions: Record<string, unknown>;
  readonly tombstone?: unknown;
  readonly updatedAt: string;
  readonly version?: number;
}

export interface ApplyOfflineSyncProjectionPullInput {
  readonly ownerUserId: string;
  readonly rows: readonly OfflineSyncRemoteProjectionRow[];
  readonly store: OfflineCommandStore;
}

export interface ApplyOfflineSyncProjectionPullResult {
  readonly applied: number;
  readonly skipped: number;
}

/**
 * Applies the server's shadow field-LWW projection without creating a local
 * command or audit record. Domain stores remain untouched until a separately
 * gated domain-application path is deployed.
 */
export async function applyOfflineSyncProjectionPull(
  input: ApplyOfflineSyncProjectionPullInput,
): Promise<ApplyOfflineSyncProjectionPullResult> {
  const rows = [...input.rows].sort(compareRemoteProjectionRows);
  let applied = 0;
  let skipped = 0;

  for (const row of rows) {
    if (!isValidRemoteProjectionRow(row, input.ownerUserId)) {
      skipped += 1;
      continue;
    }

    const key = `${input.ownerUserId}:projection:${row.entityType}:${row.entityId}`;
    const current = await input.store.getProjection<RemoteProjectionValue>(input.ownerUserId, key);
    if (current && compareProjectionFreshness(row, current) <= 0) {
      skipped += 1;
      continue;
    }

    const record: Omit<OfflineProjectionRecord<RemoteProjectionValue>, 'schemaVersion'> = {
      key,
      ownerUserId: input.ownerUserId,
      entityType: row.entityType,
      entityId: row.entityId,
      value: {
        fields: cloneRecord(row.fields),
        fieldVersions: cloneRecord(row.fieldVersions),
        ...(row.tombstone === undefined ? {} : { tombstone: row.tombstone }),
      },
      version: row.version ?? (current?.version ?? 0) + 1,
      updatedAt: row.updatedAt,
      tombstone: row.tombstone !== undefined && row.tombstone !== null,
    };
    await input.store.putProjection(record);
    applied += 1;
  }

  return { applied, skipped };
}

interface RemoteProjectionValue {
  readonly fields: Record<string, unknown>;
  readonly fieldVersions: Record<string, unknown>;
  readonly tombstone?: unknown;
}

function compareRemoteProjectionRows(
  left: OfflineSyncRemoteProjectionRow,
  right: OfflineSyncRemoteProjectionRow,
): number {
  return left.entityType.localeCompare(right.entityType)
    || left.entityId.localeCompare(right.entityId)
    || left.updatedAt.localeCompare(right.updatedAt);
}

function compareProjectionFreshness(
  incoming: OfflineSyncRemoteProjectionRow,
  current: OfflineProjectionRecord<RemoteProjectionValue>,
): number {
  const incomingVersion = incoming.version ?? 0;
  if (incomingVersion !== current.version) return incomingVersion - current.version;
  return incoming.updatedAt.localeCompare(current.updatedAt);
}

function isValidRemoteProjectionRow(
  row: OfflineSyncRemoteProjectionRow,
  ownerUserId: string,
): boolean {
  return row.ownerUserId === ownerUserId
    && typeof row.entityType === 'string'
    && row.entityType.length > 0
    && typeof row.entityId === 'string'
    && row.entityId.length > 0
    && isRecord(row.fields)
    && isRecord(row.fieldVersions)
    && typeof row.updatedAt === 'string'
    && Number.isFinite(Date.parse(row.updatedAt));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function cloneRecord(value: Record<string, unknown>): Record<string, unknown> {
  return { ...value };
}