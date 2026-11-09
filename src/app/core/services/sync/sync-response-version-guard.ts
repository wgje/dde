export interface SyncResponseVersionSnapshot {
  updatedAt: string | null;
  deletedAt: string | null;
}

type SyncVersionedEntity = {
  updatedAt?: string | null;
  deletedAt?: string | null;
};

export function captureSyncResponseVersion(
  entity: SyncVersionedEntity,
): SyncResponseVersionSnapshot {
  return {
    updatedAt: entity.updatedAt ?? null,
    deletedAt: entity.deletedAt ?? null,
  };
}

export function isSyncResponseVersionCurrent(
  requestVersion: SyncResponseVersionSnapshot,
  currentEntities: SyncVersionedEntity[],
): boolean {
  return currentEntities.every(entity => (
    (entity.updatedAt ?? null) === requestVersion.updatedAt
    && (entity.deletedAt ?? null) === requestVersion.deletedAt
  ));
}
