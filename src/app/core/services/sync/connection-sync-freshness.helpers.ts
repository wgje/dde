export function getConnectionFreshnessTimestamp(
  updatedAt?: string | null,
  deletedAt?: string | null,
): number {
  return Math.max(toSyncTimestamp(updatedAt), toSyncTimestamp(deletedAt));
}

export function isRemoteTombstoneAtLeastAsFresh(
  remoteDeletedAt: string | null | undefined,
  localFreshnessTimestamp: number,
): boolean {
  if (!remoteDeletedAt) {
    return false;
  }

  const deletedAtTimestamp = toSyncTimestamp(remoteDeletedAt);
  return deletedAtTimestamp > 0
    && (localFreshnessTimestamp === 0 || deletedAtTimestamp >= localFreshnessTimestamp);
}

function toSyncTimestamp(value?: string | null): number {
  if (!value) {
    return 0;
  }

  const timestamp = new Date(value).getTime();
  return Number.isNaN(timestamp) ? 0 : timestamp;
}
