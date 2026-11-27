/**
 * Shadow comparison boundary for the offline-first sync rollout.
 *
 * This module intentionally has no dependency on the current sync chain. It
 * records a deterministic comparison between the new command path and the
 * legacy result without changing the result visible to callers.
 */

export type ShadowSyncMode = 'disabled' | 'shadow';

export type ShadowOutcomeStatus =
  | 'applied'
  | 'idempotent-replay'
  | 'remote-newer'
  | 'deleted-remote-newer'
  | 'client-version-rejected'
  | 'tombstoned'
  | 'quarantined'
  | 'accepted-shadow'
  | 'unauthorized'
  | 'unknown'
  | 'reconciliation-pending'
  | 'rejected';

export interface ShadowCommandIdentity {
  operationId: string;
  ownerUserId: string;
  installationId: string;
  deviceId: string;
  schemaVersion: number;
  entityType: string;
  entityId: string;
}

export interface ShadowOutcome {
  status: ShadowOutcomeStatus;
  decision?: string;
  changedFields?: readonly string[];
  entityId?: string | null;
  payloadDigest?: string | null;
  remoteUpdatedAt?: string | null;
  reason?: string | null;
}

export interface ShadowComparisonInput {
  command: ShadowCommandIdentity;
  newOutcome: ShadowOutcome;
  legacyOutcome: ShadowOutcome;
  comparedAt: string;
}

export interface ShadowComparisonRecord extends ShadowComparisonInput {
  equivalent: boolean;
  differences: readonly string[];
}

export interface ShadowComparisonSink {
  record(comparison: ShadowComparisonRecord): void;
}

export interface ShadowSyncAdapter {
  readonly mode: ShadowSyncMode;
  compare(input: ShadowComparisonInput): ShadowComparisonRecord | null;
}

const COMPARABLE_FIELDS = [
  'status',
  'decision',
  'changedFields',
  'entityId',
  'payloadDigest',
  'remoteUpdatedAt',
  'reason',
] as const;

function normalizeFields(fields: readonly string[] | undefined): string[] {
  return [...new Set(fields ?? [])].sort();
}

function normalizeOptional(value: string | null | undefined): string | null {
  return value ?? null;
}

function valueForField(outcome: ShadowOutcome, field: (typeof COMPARABLE_FIELDS)[number]): string | string[] | null {
  switch (field) {
    case 'status':
      return outcome.status;
    case 'decision':
      return normalizeOptional(outcome.decision);
    case 'changedFields':
      return normalizeFields(outcome.changedFields);
    case 'entityId':
      return normalizeOptional(outcome.entityId);
    case 'payloadDigest':
      return normalizeOptional(outcome.payloadDigest);
    case 'remoteUpdatedAt':
      return normalizeOptional(outcome.remoteUpdatedAt);
    case 'reason':
      return normalizeOptional(outcome.reason);
  }
}

function valuesEqual(left: string | string[] | null, right: string | string[] | null): boolean {
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((value, index) => value === right[index]);
  }
  return left === right;
}

function compareOutcomes(newOutcome: ShadowOutcome, legacyOutcome: ShadowOutcome): readonly string[] {
  return COMPARABLE_FIELDS.filter((field) =>
    !valuesEqual(valueForField(newOutcome, field), valueForField(legacyOutcome, field)),
  );
}

export class DisabledShadowSyncAdapter implements ShadowSyncAdapter {
  readonly mode = 'disabled' as const;

  compare(_input: ShadowComparisonInput): null {
    return null;
  }
}

export interface EnabledShadowSyncAdapterOptions {
  sink?: ShadowComparisonSink;
}

export class EnabledShadowSyncAdapter implements ShadowSyncAdapter {
  readonly mode = 'shadow' as const;

  constructor(private readonly options: EnabledShadowSyncAdapterOptions = {}) {}

  compare(input: ShadowComparisonInput): ShadowComparisonRecord {
    const differences = compareOutcomes(input.newOutcome, input.legacyOutcome);
    const comparison: ShadowComparisonRecord = {
      ...input,
      equivalent: differences.length === 0,
      differences,
    };

    try {
      this.options.sink?.record(comparison);
    } catch {
      // Shadow diagnostics must never affect the user-visible sync path.
    }

    return comparison;
  }
}

export function createShadowSyncAdapter(options: {
  enabled: boolean;
  sink?: ShadowComparisonSink;
}): ShadowSyncAdapter {
  return options.enabled
    ? new EnabledShadowSyncAdapter({ sink: options.sink })
    : new DisabledShadowSyncAdapter();
}
