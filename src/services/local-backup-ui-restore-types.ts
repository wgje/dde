import { createDataSafetyRestoreMarkerLease } from './data-safety-indexeddb-restore-marker-lease';
import type {
  QueueBackupPersonalRestoreIdentityStateV2,
  QueueBackupPersonalRestoreIdentityV2,
} from './action-queue.types';

export const LOCAL_BACKUP_UI_RESTORE_MARKER_SCHEMA_VERSION = 2 as const;

const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;

export const LOCAL_BACKUP_UI_RESTORE_STAGES = [
  'projects',
  'attachment-outbox',
  'action-queue',
  'retry-queue',
  'dead-letters',
  'conflicts',
  'metadata',
] as const;

export const LOCAL_BACKUP_UI_RESTORE_STATES = [
  'prepared',
  'restoring',
  'rolling-back',
  'rollback-failed',
  'completed',
  'rolled-back',
] as const;

export const LOCAL_BACKUP_UI_RESTORE_PHASES = [
  'pre-image-captured',
  ...LOCAL_BACKUP_UI_RESTORE_STAGES,
  'finalizing',
] as const;

export type LocalBackupUiRestoreStage = typeof LOCAL_BACKUP_UI_RESTORE_STAGES[number];
export type LocalBackupUiRestoreState = typeof LOCAL_BACKUP_UI_RESTORE_STATES[number];
export type LocalBackupUiRestorePhase = typeof LOCAL_BACKUP_UI_RESTORE_PHASES[number];
export type LocalBackupUiRestoreSourceKind = 'local-file' | 'cloud-backup';

export type LocalBackupUiRestoreJsonValue =
  | null
  | boolean
  | number
  | string
  | LocalBackupUiRestoreJsonValue[]
  | { [key: string]: LocalBackupUiRestoreJsonValue };

export interface LocalBackupUiRestoreSource {
  kind: LocalBackupUiRestoreSourceKind;
  reference: string | null;
  checksum: string;
}

export interface LocalBackupUiRestorePreImage {
  projectState: LocalBackupUiRestoreJsonValue;
  blackBox?: LocalBackupUiRestoreJsonValue;
  attachmentOutbox: LocalBackupUiRestoreJsonValue;
  actionQueue: LocalBackupUiRestoreJsonValue;
  retryQueue: LocalBackupUiRestoreJsonValue;
  deadLetters: LocalBackupUiRestoreJsonValue;
  conflicts: LocalBackupUiRestoreJsonValue;
  metadata: LocalBackupUiRestoreJsonValue;
}

export interface LocalBackupUiRestoreRollbackError {
  stage: LocalBackupUiRestoreStage;
  message: string;
  recordedAt: string;
}

export interface LocalBackupUiRestoreMarker {
  schemaVersion: typeof LOCAL_BACKUP_UI_RESTORE_MARKER_SCHEMA_VERSION;
  ownerUserId: string;
  runId: string;
  restoreRunId: string;
  actionQueueRestoreIdentity: QueueBackupPersonalRestoreIdentityV2;
  createdAt: string;
  leaseExpiresAt: string;
  state: LocalBackupUiRestoreState;
  phase: LocalBackupUiRestorePhase;
  completedStages: LocalBackupUiRestoreStage[];
  rollbackCompletedStages: LocalBackupUiRestoreStage[];
  source: LocalBackupUiRestoreSource;
  touchedProjectIds: string[];
  preImage: LocalBackupUiRestorePreImage;
  rollbackErrors: LocalBackupUiRestoreRollbackError[];
}

export function isLocalBackupUiRestoreQueueStateCompatible(
  marker: LocalBackupUiRestoreMarker,
  state: QueueBackupPersonalRestoreIdentityStateV2,
): boolean {
  const identity = marker.actionQueueRestoreIdentity;
  if (state.status === 'unknown') return false;
  if (state.status === 'absent-for-identity') {
    return hasSameQueueIdentity(state.identity, identity)
      && marker.state === 'prepared'
      && marker.phase === 'pre-image-captured'
      && marker.completedStages.length === 0
      && marker.rollbackCompletedStages.length === 0;
  }
  if (state.status === 'active') {
    return hasSameQueueIdentity(state.transition.preparedReceipt, identity);
  }
  return hasSameQueueIdentity(state.receipt, identity)
    && (marker.state === 'completed'
      ? state.receipt.outcome === 'finalized'
      : marker.state === 'prepared'
        ? state.receipt.outcome === 'rolled-back'
          || state.receipt.outcome === 'abandoned-before-prepare'
        : state.receipt.outcome === 'rolled-back');
}

function hasSameQueueIdentity(
  value: QueueBackupPersonalRestoreIdentityV2,
  expected: QueueBackupPersonalRestoreIdentityV2,
): boolean {
  return value.ownerUserId === expected.ownerUserId
    && value.restoreRunId === expected.restoreRunId
    && value.participant === expected.participant
    && value.sourceDigest === expected.sourceDigest
    && value.token === expected.token
    && value.recordId === expected.recordId
    && value.identityDigest === expected.identityDigest
    && value.receiptId === expected.receiptId;
}

export type BuildLocalBackupUiRestoreMarkerInput = Omit<
  LocalBackupUiRestoreMarker,
  'schemaVersion' | 'runId' | 'createdAt' | 'leaseExpiresAt'
>;

const MARKER_KEYS = [
  'schemaVersion',
  'ownerUserId',
  'runId',
  'restoreRunId',
  'actionQueueRestoreIdentity',
  'createdAt',
  'leaseExpiresAt',
  'state',
  'phase',
  'completedStages',
  'rollbackCompletedStages',
  'source',
  'touchedProjectIds',
  'preImage',
  'rollbackErrors',
] as const;

const SOURCE_KEYS = ['kind', 'reference', 'checksum'] as const;
const ACTION_QUEUE_IDENTITY_KEYS = [
  'ownerUserId',
  'restoreRunId',
  'participant',
  'sourceDigest',
  'token',
  'recordId',
  'identityDigest',
  'receiptId',
] as const;
const PRE_IMAGE_KEYS = [
  'projectState',
  'blackBox',
  'attachmentOutbox',
  'actionQueue',
  'retryQueue',
  'deadLetters',
  'conflicts',
  'metadata',
] as const;
const ROLLBACK_ERROR_KEYS = ['stage', 'message', 'recordedAt'] as const;

export function buildLocalBackupUiRestoreMarker(
  input: BuildLocalBackupUiRestoreMarkerInput,
  now = Date.now(),
): LocalBackupUiRestoreMarker {
  const lease = createDataSafetyRestoreMarkerLease(input.ownerUserId, now);
  if (lease.runId === null || lease.leaseExpiresAt === null) {
    throw new Error('local backup UI restore marker lease identity is incomplete');
  }
  const marker: LocalBackupUiRestoreMarker = {
    schemaVersion: LOCAL_BACKUP_UI_RESTORE_MARKER_SCHEMA_VERSION,
    ...lease,
    ...input,
    runId: lease.runId,
    leaseExpiresAt: lease.leaseExpiresAt,
  };
  if (!validateLocalBackupUiRestoreMarker(marker, input.ownerUserId)) {
    throw new Error('local backup UI restore marker input failed schema validation');
  }
  return marker;
}

export function validateLocalBackupUiRestoreMarker(
  value: unknown,
  expectedOwnerUserId?: string,
): value is LocalBackupUiRestoreMarker {
  if (!isRecordWithExactKeys(value, MARKER_KEYS)) return false;
  if (value['schemaVersion'] !== LOCAL_BACKUP_UI_RESTORE_MARKER_SCHEMA_VERSION) return false;
  if (!isNonEmptyString(value['ownerUserId']) || !isNonEmptyString(value['runId'])) return false;
  if (!isNonEmptyString(value['restoreRunId']) || value['restoreRunId'] === value['runId']) return false;
  if (expectedOwnerUserId !== undefined && value['ownerUserId'] !== expectedOwnerUserId) return false;
  if (!isIsoTimestamp(value['createdAt']) || !isIsoTimestamp(value['leaseExpiresAt'])) return false;
  if (!isOneOf(value['state'], LOCAL_BACKUP_UI_RESTORE_STATES)) return false;
  if (!isOneOf(value['phase'], LOCAL_BACKUP_UI_RESTORE_PHASES)) return false;
  if (!isCanonicalStagePrefix(value['completedStages'])) return false;
  if (!isCanonicalStageSubset(
    value['rollbackCompletedStages'],
    [...LOCAL_BACKUP_UI_RESTORE_STAGES].reverse(),
  )) return false;
  if (!validateSource(value['source']) || !validateActionQueueIdentity(value)) return false;
  if (!isUniqueStringArray(value['touchedProjectIds'])) return false;
  if (!validatePreImage(value['preImage'])) return false;
  if (!validateRollbackErrors(value['rollbackErrors'])) return false;
  return isProgressConsistent(
    value['state'],
    value['phase'],
    value['completedStages'],
    value['rollbackCompletedStages'],
    value['rollbackErrors'],
  );
}

function validateSource(value: unknown): value is LocalBackupUiRestoreSource {
  return isRecordWithExactKeys(value, SOURCE_KEYS)
    && (value['kind'] === 'local-file' || value['kind'] === 'cloud-backup')
    && isNullableString(value['reference'])
    && isSha256(value['checksum']);
}

function validateActionQueueIdentity(
  marker: Record<(typeof MARKER_KEYS)[number], unknown>,
): boolean {
  const identity = marker['actionQueueRestoreIdentity'];
  if (!isRecordWithExactKeys(identity, ACTION_QUEUE_IDENTITY_KEYS)) return false;
  if (identity['ownerUserId'] !== marker['ownerUserId']
    || identity['restoreRunId'] !== marker['restoreRunId']
    || identity['participant'] !== 'action-queue'
    || identity['sourceDigest'] !== (marker['source'] as LocalBackupUiRestoreSource).checksum
    || !isNonEmptyString(identity['token'])
    || identity['recordId'] !== `queue-backup:${marker['ownerUserId']}`
    || !isSha256(identity['identityDigest'])) return false;
  return identity['receiptId']
    === `queue-backup-personal-restore-receipt:v2:${identity['identityDigest'].slice(7)}`;
}

function validatePreImage(value: unknown): value is LocalBackupUiRestorePreImage {
  if (!isRecordWithExactKeys(value, PRE_IMAGE_KEYS)) return false;
  return PRE_IMAGE_KEYS.every(key => isJsonValue(value[key]));
}

function validateRollbackErrors(value: unknown): value is LocalBackupUiRestoreRollbackError[] {
  return Array.isArray(value) && value.every(error => (
    isRecordWithExactKeys(error, ROLLBACK_ERROR_KEYS)
    && isOneOf(error['stage'], LOCAL_BACKUP_UI_RESTORE_STAGES)
    && isNonEmptyString(error['message'])
    && isIsoTimestamp(error['recordedAt'])
  ));
}

function isCanonicalStageSubset(
  value: unknown,
  order: readonly LocalBackupUiRestoreStage[],
): value is LocalBackupUiRestoreStage[] {
  if (!Array.isArray(value)) return false;
  let previousIndex = -1;
  for (const stage of value) {
    const index = order.indexOf(stage as LocalBackupUiRestoreStage);
    if (index <= previousIndex) return false;
    previousIndex = index;
  }
  return true;
}

function isCanonicalStagePrefix(value: unknown): value is LocalBackupUiRestoreStage[] {
  return Array.isArray(value)
    && value.every((stage, index) => stage === LOCAL_BACKUP_UI_RESTORE_STAGES[index]);
}

function isProgressConsistent(
  state: LocalBackupUiRestoreState,
  phase: LocalBackupUiRestorePhase,
  completedStages: LocalBackupUiRestoreStage[],
  rollbackCompletedStages: LocalBackupUiRestoreStage[],
  rollbackErrors: LocalBackupUiRestoreRollbackError[],
): boolean {
  const phaseIndex = LOCAL_BACKUP_UI_RESTORE_STAGES.indexOf(
    phase as LocalBackupUiRestoreStage,
  );
  switch (state) {
    case 'prepared':
      return phase === 'pre-image-captured'
        && completedStages.length === 0
        && rollbackCompletedStages.length === 0
        && rollbackErrors.length === 0;
    case 'restoring':
      return phaseIndex >= 0
        && completedStages.length >= phaseIndex
        && completedStages.length <= phaseIndex + 1
        && rollbackCompletedStages.length === 0
        && rollbackErrors.length === 0;
    case 'rolling-back':
      return phaseIndex >= 0 && isRollbackProgressConsistent(
        phaseIndex,
        completedStages,
        rollbackCompletedStages,
      );
    case 'rollback-failed':
      return phaseIndex >= 0
        && rollbackErrors.at(-1)?.stage === phase
        && isRollbackProgressConsistent(
          phaseIndex,
          completedStages,
          rollbackCompletedStages,
        );
    case 'completed':
      return phase === 'finalizing'
        && completedStages.length === LOCAL_BACKUP_UI_RESTORE_STAGES.length
        && rollbackCompletedStages.length === 0
        && rollbackErrors.length === 0;
    case 'rolled-back':
      return phase === 'finalizing'
        && isCompleteRollbackProgress(completedStages, rollbackCompletedStages);
  }
}

function isRollbackProgressConsistent(
  phaseIndex: number,
  completedStages: LocalBackupUiRestoreStage[],
  rollbackCompletedStages: LocalBackupUiRestoreStage[],
): boolean {
  const highIndex = rollbackCompletedStages.length > 0
    ? LOCAL_BACKUP_UI_RESTORE_STAGES.indexOf(rollbackCompletedStages[0])
    : Math.max(phaseIndex, completedStages.length - 1);
  if (highIndex < phaseIndex
    || (completedStages.length !== highIndex && completedStages.length !== highIndex + 1)) {
    return false;
  }

  const expectedRollbackStages = LOCAL_BACKUP_UI_RESTORE_STAGES
    .slice(0, highIndex + 1)
    .reverse();
  if (!rollbackCompletedStages.every((stage, index) => stage === expectedRollbackStages[index])) {
    return false;
  }

  const completedRollbackCount = rollbackCompletedStages.length;
  return phaseIndex === highIndex - completedRollbackCount
    || phaseIndex === highIndex - completedRollbackCount + 1;
}

function isCompleteRollbackProgress(
  completedStages: LocalBackupUiRestoreStage[],
  rollbackCompletedStages: LocalBackupUiRestoreStage[],
): boolean {
  if (rollbackCompletedStages.length === 0) return completedStages.length === 0;
  const highIndex = LOCAL_BACKUP_UI_RESTORE_STAGES.indexOf(rollbackCompletedStages[0]);
  const expectedRollbackStages = LOCAL_BACKUP_UI_RESTORE_STAGES
    .slice(0, highIndex + 1)
    .reverse();
  return (completedStages.length === highIndex || completedStages.length === highIndex + 1)
    && rollbackCompletedStages.length === expectedRollbackStages.length
    && rollbackCompletedStages.every((stage, index) => stage === expectedRollbackStages[index]);
}

function isUniqueStringArray(value: unknown): value is string[] {
  if (!Array.isArray(value) || !value.every(isNonEmptyString)) return false;
  return new Set(value).size === value.length;
}

function isJsonValue(value: unknown, ancestors = new WeakSet<object>()): value is LocalBackupUiRestoreJsonValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object') return false;
  if (ancestors.has(value)) return false;
  ancestors.add(value);
  const valid = Array.isArray(value)
    ? value.every(item => isJsonValue(item, ancestors))
    : isPlainRecord(value) && Object.values(value).every(item => isJsonValue(item, ancestors));
  ancestors.delete(value);
  return valid;
}

function isRecordWithExactKeys<const TKeys extends readonly string[]>(
  value: unknown,
  keys: TKeys,
): value is Record<TKeys[number], unknown> {
  if (!isPlainRecord(value)) return false;
  const actualKeys = Object.keys(value);
  return actualKeys.length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isOneOf<const TValue extends string>(
  value: unknown,
  allowed: readonly TValue[],
): value is TValue {
  return typeof value === 'string' && allowed.includes(value as TValue);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && SHA256_PATTERN.test(value);
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !Number.isNaN(Date.parse(value));
}
