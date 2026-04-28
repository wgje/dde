export interface SummaryVersionCursorInput {
  latestSessionUpdatedAt?: string | null;
  dockTasksWatermark?: string | null;
  blackBoxWatermark?: string | null;
  focusTaskUpdatedAt?: string | null;
  focusProjectUpdatedAt?: string | null;
  dockTaskUpdatedAts?: Array<string | null | undefined>;
  dockProjectUpdatedAts?: Array<string | null | undefined>;
}

export function maxIsoTimestamp(values: Array<string | null | undefined>): string | null {
  let latestValue: string | null = null;
  let latestTime = Number.NEGATIVE_INFINITY;

  for (const value of values) {
    if (!value) continue;
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed)) continue;
    if (parsed > latestTime) {
      latestTime = parsed;
      latestValue = value;
    }
  }

  return latestValue;
}

export function buildSummaryVersionCursor(input: SummaryVersionCursorInput): string | null {
  return maxIsoTimestamp([
    input.latestSessionUpdatedAt ?? null,
    input.dockTasksWatermark ?? null,
    input.blackBoxWatermark ?? null,
    input.focusTaskUpdatedAt ?? null,
    input.focusProjectUpdatedAt ?? null,
    ...(input.dockTaskUpdatedAts ?? []),
    ...(input.dockProjectUpdatedAts ?? []),
  ]);
}

export function buildSummaryVersion(cursorAt: string | null, signature: string): string {
  return `${cursorAt ?? 'none'}|${signature.slice(0, 24)}`;
}

export function extractSummaryVersionTimestamp(version: string | null | undefined): number | null {
  if (!version) return null;

  const separatorIndex = version.indexOf('|');
  const timestampPart = separatorIndex >= 0 ? version.slice(0, separatorIndex) : version;
  if (timestampPart === 'none') return null;

  const parsed = Date.parse(timestampPart);
  return Number.isFinite(parsed) ? parsed : null;
}

export function isSummaryVersionRegressed(lastKnownVersion: string | undefined, currentVersion: string): boolean {
  const lastKnownTimestamp = extractSummaryVersionTimestamp(lastKnownVersion);
  if (lastKnownTimestamp === null) {
    return false;
  }

  const currentTimestamp = extractSummaryVersionTimestamp(currentVersion);
  if (currentTimestamp === null) {
    return true;
  }

  return currentTimestamp < lastKnownTimestamp;
}