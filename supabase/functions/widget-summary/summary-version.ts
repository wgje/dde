export interface SummaryVersionCursorInput {
  latestSessionUpdatedAt?: string | null;
  dockTasksWatermark?: string | null;
  blackBoxWatermark?: string | null;
  focusTaskUpdatedAt?: string | null;
  focusProjectUpdatedAt?: string | null;
  dockTaskUpdatedAts?: Array<string | null | undefined>;
  dockProjectUpdatedAts?: Array<string | null | undefined>;
}

const TIMESTAMP_FRACTION_PATTERN = /([Tt ]\d{2}:\d{2}:\d{2})\.(\d+)/;
const MICROSECONDS_PER_MILLISECOND = 1000n;

function parseTimestampInstant(value: string): bigint | null {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;

  const fractionMatch = TIMESTAMP_FRACTION_PATTERN.exec(value);
  if (!fractionMatch) {
    return BigInt(parsed) * MICROSECONDS_PER_MILLISECOND;
  }

  const normalizedFraction = fractionMatch[2].slice(0, 6).padEnd(6, '0');
  const millisecondTimestamp = value.replace(
    fractionMatch[0],
    `${fractionMatch[1]}.${normalizedFraction.slice(0, 3)}`,
  );
  const epochMilliseconds = Date.parse(millisecondTimestamp);
  if (!Number.isFinite(epochMilliseconds)) return null;

  const subMillisecondMicroseconds = Number(normalizedFraction.slice(3));
  return BigInt(epochMilliseconds) * MICROSECONDS_PER_MILLISECOND
    + BigInt(subMillisecondMicroseconds);
}

export function maxIsoTimestamp(values: Array<string | null | undefined>): string | null {
  let latestValue: string | null = null;
  let latestInstant: bigint | null = null;

  for (const value of values) {
    if (!value) continue;
    const instant = parseTimestampInstant(value);
    if (instant === null) continue;
    if (latestInstant === null || instant > latestInstant) {
      latestInstant = instant;
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

export function extractSummaryVersionTimestamp(version: string | null | undefined): bigint | null {
  if (!version) return null;

  const separatorIndex = version.indexOf('|');
  const timestampPart = separatorIndex >= 0 ? version.slice(0, separatorIndex) : version;
  if (timestampPart === 'none') return null;

  return parseTimestampInstant(timestampPart);
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
