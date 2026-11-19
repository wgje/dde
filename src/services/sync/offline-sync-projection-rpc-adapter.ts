import {
  applyOfflineSyncProjectionPull,
  type ApplyOfflineSyncProjectionPullResult,
  type OfflineSyncRemoteProjectionRow,
} from './offline-sync-projection-pull';
import type { OfflineCommandStore } from './offline-command-store';

export interface OfflineSyncProjectionPullTransport {
  fetchProjections(ownerUserId: string): Promise<unknown>;
}

export interface OfflineSyncProjectionRpcClient {
  pullOfflineProjections(): Promise<unknown[]>;
}

export function createOfflineSyncProjectionRpcTransport(
  client: OfflineSyncProjectionRpcClient,
): OfflineSyncProjectionPullTransport {
  return { fetchProjections: async () => client.pullOfflineProjections() };
}

export interface PullAndApplyOfflineSyncProjectionsInput {
  readonly ownerUserId: string;
  readonly transport: OfflineSyncProjectionPullTransport;
  readonly store: OfflineCommandStore;
}

/**
 * Boundary for the future Supabase `sync_pull_offline_projections` RPC.
 * Transport parsing stays here so malformed/foreign rows cannot cross into
 * the owner-scoped local projection store.
 */
export async function pullAndApplyOfflineSyncProjections(
  input: PullAndApplyOfflineSyncProjectionsInput,
): Promise<ApplyOfflineSyncProjectionPullResult> {
  const raw = await input.transport.fetchProjections(input.ownerUserId);
  const rows = normalizeProjectionRows(raw, input.ownerUserId);
  return applyOfflineSyncProjectionPull({
    ownerUserId: input.ownerUserId,
    rows,
    store: input.store,
  });
}

function normalizeProjectionRows(
  raw: unknown,
  ownerUserId: string,
): OfflineSyncRemoteProjectionRow[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap(value => {
    if (!isRecord(value)) return [];
    const entityType = value['entity_type'];
    const entityId = value['entity_id'];
    const fields = value['fields'];
    const fieldVersions = value['field_versions'];
    const updatedAt = value['updated_at'];
    if (typeof entityType !== 'string' || typeof entityId !== 'string'
      || !isRecord(fields) || !isRecord(fieldVersions) || typeof updatedAt !== 'string') {
      return [];
    }
    const tombstone = value['tombstone'];
    const version = typeof value['version'] === 'number' ? value['version'] : undefined;
    return [{
      ownerUserId,
      entityType,
      entityId,
      fields,
      fieldVersions,
      ...(tombstone === undefined ? {} : { tombstone }),
      updatedAt,
      ...(version === undefined ? {} : { version }),
    }];
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}