import type { BlackBoxEntry } from '../models/focus';

export interface BlackBoxPreflightTimestampComparison {
  rawServerMs: number;
  rawLocalMs: number;
  timestampsDiffer: boolean;
}

export function compareBlackBoxPreflightTimestampValues(
  localUpdatedAt: string,
  serverUpdatedAt: string,
): BlackBoxPreflightTimestampComparison {
  const rawServerMs = new Date(serverUpdatedAt).getTime();
  const rawLocalMs = new Date(localUpdatedAt).getTime();
  return {
    rawServerMs,
    rawLocalMs,
    timestampsDiffer: Number.isFinite(rawServerMs)
      && Number.isFinite(rawLocalMs)
      && rawLocalMs !== rawServerMs,
  };
}

export function mergeBlackBoxPreflightMonotonicFacts(
  entry: BlackBoxEntry,
  serverEntry: BlackBoxEntry,
  serverIsNewer: boolean,
): BlackBoxEntry | null {
  if (!serverIsNewer && !hasBlackBoxPreflightMonotonicRegression(entry, serverEntry)) {
    return null;
  }

  return serverIsNewer
    ? serverEntry
    : {
        ...entry,
        isRead: entry.isRead || serverEntry.isRead,
        isCompleted: entry.isCompleted || serverEntry.isCompleted,
        completedAt: entry.completedAt ?? serverEntry.completedAt ?? null,
        deletedAt: entry.deletedAt ?? serverEntry.deletedAt,
      };
}

function hasBlackBoxPreflightMonotonicRegression(
  entry: BlackBoxEntry,
  serverEntry: BlackBoxEntry,
): boolean {
  return (serverEntry.isRead && !entry.isRead)
    || (serverEntry.isCompleted && !entry.isCompleted)
    || (Boolean(serverEntry.deletedAt) && !entry.deletedAt);
}
