import type {
  DeadLetterItem,
  QueuedAction,
  QueueBackupPersonalRestoreIdentityV2,
  QueueBackupPersonalRestoreTerminalReceiptV2,
} from './action-queue.types';
import { canonicalizePersistedValue, isPersistedQueuedAction } from './action-queue-identity.helpers';
import {
  digestQueueBackupPersonalRestoreActions,
  getQueueBackupPersonalRestoreCatalogId,
  isQueueBackupPersonalRestoreTransitionV2,
  validateQueueBackupPersonalRestoreIdentity,
  type QueueBackupPersonalRestoreCatalogV2,
} from './queue-backup-personal-restore-transition.helpers';
import type { DeadLetterBackupRecord, QueueBackupRecord } from './queue-backup.service';

const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MAX_RECEIPTS = 64;

export type QueueBackupRestoreProviderRawSlot =
  | { status: 'ABSENT' }
  | { status: 'PRESENT'; value: unknown };

export interface QueueBackupRestoreProviderRawSnapshot {
  queue: QueueBackupRestoreProviderRawSlot;
  deadLetters: QueueBackupRestoreProviderRawSlot;
  catalog: QueueBackupRestoreProviderRawSlot;
  receipt: QueueBackupRestoreProviderRawSlot;
}

export type QueueBackupRestoreProviderClassification<T> =
  | { status: 'PRESENT_VALID'; value: T; rawSignature: string }
  | { status: 'ABSENT' }
  | { status: 'MALFORMED'; raw: unknown; rawSignature: string | null }
  | { status: 'UNREADABLE'; reason: QueueBackupRestoreProviderUnreadableReason };

export type QueueBackupRestoreProviderUnreadableReason =
  | 'STORAGE_UNAVAILABLE'
  | 'OPEN_FAILED'
  | 'VERSION_MISMATCH'
  | 'STORE_MISSING'
  | 'TRANSACTION_FAILED';

export type QueueBackupRestoreProviderTerminalEvidence =
  | { status: 'NOT_TERMINAL' }
  | {
    status: 'TERMINAL_CONFIRMED';
    receipt: QueueBackupPersonalRestoreTerminalReceiptV2;
    resultDigest: string;
    recordPresent: boolean;
  }
  | {
    status: 'RESULT_DIGEST_DRIFT';
    receipt: QueueBackupPersonalRestoreTerminalReceiptV2;
    expectedResultDigest: string;
    observedResultDigest: string;
    recordPresent: boolean;
  }
  | {
    status: 'UNVERIFIABLE';
    reason: 'SOURCE_UNREADABLE' | 'MALFORMED_EVIDENCE' | 'ACTIVE_TRANSITION'
      | 'RECEIPT_DIVERGENCE' | 'IDENTITY_COLLISION' | 'RESULT_DIGEST_UNAVAILABLE';
    recordPresent?: boolean;
  };

export interface QueueBackupRestoreProviderReadableEvidence {
  status: 'READABLE';
  storage: 'READBACK_CONFIRMED' | 'CONFIRMED_EMPTY';
  identity: QueueBackupPersonalRestoreIdentityV2;
  queue: QueueBackupRestoreProviderClassification<QueueBackupRecord>;
  deadLetters: QueueBackupRestoreProviderClassification<DeadLetterBackupRecord>;
  catalog: QueueBackupRestoreProviderClassification<QueueBackupPersonalRestoreCatalogV2>;
  receipt: QueueBackupRestoreProviderClassification<QueueBackupPersonalRestoreTerminalReceiptV2>;
  terminal: QueueBackupRestoreProviderTerminalEvidence;
  snapshotSignature: string | null;
}

export interface QueueBackupRestoreProviderUnreadableEvidence {
  status: 'UNREADABLE';
  identity: QueueBackupPersonalRestoreIdentityV2;
  queue: QueueBackupRestoreProviderClassification<QueueBackupRecord>;
  deadLetters: QueueBackupRestoreProviderClassification<DeadLetterBackupRecord>;
  catalog: QueueBackupRestoreProviderClassification<QueueBackupPersonalRestoreCatalogV2>;
  receipt: QueueBackupRestoreProviderClassification<QueueBackupPersonalRestoreTerminalReceiptV2>;
  terminal: QueueBackupRestoreProviderTerminalEvidence;
}

export type QueueBackupRestoreProviderResult =
  | QueueBackupRestoreProviderReadableEvidence
  | QueueBackupRestoreProviderUnreadableEvidence
  | {
    status: 'REJECTED';
    reason: 'AUTH_UNAVAILABLE' | 'OWNER_MISMATCH' | 'MALFORMED_IDENTITY' | 'CRYPTO_UNAVAILABLE';
  };

type QueueBackupRestoreProviderAccess =
  | Extract<QueueBackupRestoreProviderResult, { status: 'REJECTED' }>
  | { status: 'ACCEPTED'; identity: QueueBackupPersonalRestoreIdentityV2 };

export function createQueueBackupRestoreProviderRawSlot(value: unknown): QueueBackupRestoreProviderRawSlot {
  return value === undefined ? { status: 'ABSENT' } : { status: 'PRESENT', value };
}

export function createQueueBackupRestoreProviderRawSnapshot(
  values: readonly unknown[],
): QueueBackupRestoreProviderRawSnapshot {
  const [queue, deadLetters, catalog, receipt] = values;
  return {
    queue: createQueueBackupRestoreProviderRawSlot(queue),
    deadLetters: createQueueBackupRestoreProviderRawSlot(deadLetters),
    catalog: createQueueBackupRestoreProviderRawSlot(catalog),
    receipt: createQueueBackupRestoreProviderRawSlot(receipt),
  };
}

export async function validateQueueBackupRestoreProviderAccess(
  identity: QueueBackupPersonalRestoreIdentityV2,
  authenticatedOwnerUserId: string | null,
): Promise<QueueBackupRestoreProviderAccess> {
  if (!globalThis.crypto?.subtle) return { status: 'REJECTED', reason: 'CRYPTO_UNAVAILABLE' };
  if (!authenticatedOwnerUserId) return { status: 'REJECTED', reason: 'AUTH_UNAVAILABLE' };
  const snapshot = captureIdentity(identity);
  if (!snapshot) return { status: 'REJECTED', reason: 'MALFORMED_IDENTITY' };
  if (snapshot.ownerUserId !== authenticatedOwnerUserId) {
    return { status: 'REJECTED', reason: 'OWNER_MISMATCH' };
  }
  try {
    return await validateQueueBackupPersonalRestoreIdentity(snapshot)
      ? { status: 'ACCEPTED', identity: snapshot }
      : { status: 'REJECTED', reason: 'MALFORMED_IDENTITY' };
  } catch { return { status: 'REJECTED', reason: 'MALFORMED_IDENTITY' }; }
}

export async function projectQueueBackupRestoreProviderEvidence(
  identity: QueueBackupPersonalRestoreIdentityV2,
  raw: QueueBackupRestoreProviderRawSnapshot,
  storage: QueueBackupRestoreProviderReadableEvidence['storage'] = 'READBACK_CONFIRMED',
): Promise<QueueBackupRestoreProviderReadableEvidence> {
  const queue = await classifySlot<QueueBackupRecord>(raw.queue, value => isStrictQueueRecord(value, identity));
  const deadLetters = await classifySlot<DeadLetterBackupRecord>(
    raw.deadLetters,
    value => isStrictDeadLetterRecord(value, identity),
  );
  const catalog = await classifySlot<QueueBackupPersonalRestoreCatalogV2>(
    raw.catalog,
    value => isStrictCatalog(value, identity.ownerUserId),
  );
  const receipt = await classifySlot<QueueBackupPersonalRestoreTerminalReceiptV2>(
    raw.receipt,
    value => isStrictTerminalReceipt(value),
  );
  const terminal = await projectTerminal(identity, queue, catalog, receipt);
  return cloneAndFreeze({
    status: 'READABLE' as const,
    storage,
    identity,
    queue,
    deadLetters,
    catalog,
    receipt,
    terminal,
    snapshotSignature: safeCanonicalSignature(raw),
  });
}

export function projectQueueBackupRestoreUnreadableEvidence(
  identity: QueueBackupPersonalRestoreIdentityV2,
  reason: QueueBackupRestoreProviderUnreadableReason,
): QueueBackupRestoreProviderUnreadableEvidence {
  const unreadable = { status: 'UNREADABLE' as const, reason };
  return cloneAndFreeze({
    status: 'UNREADABLE' as const,
    identity,
    queue: unreadable,
    deadLetters: unreadable,
    catalog: unreadable,
    receipt: unreadable,
    terminal: { status: 'UNVERIFIABLE' as const, reason: 'SOURCE_UNREADABLE' as const },
  });
}

async function classifySlot<T>(
  slot: QueueBackupRestoreProviderRawSlot,
  validate: (value: unknown) => boolean | Promise<boolean>,
): Promise<QueueBackupRestoreProviderClassification<T>> {
  if (slot.status === 'ABSENT') return cloneAndFreeze({ status: 'ABSENT' as const });
  const plainJson = isPlainJsonValue(slot.value, new WeakSet());
  const raw = cloneAndFreeze(slot.value);
  const rawSignature = safeCanonicalSignature(raw);
  let valid = false;
  try { valid = plainJson && await validate(raw); } catch { valid = false; }
  return valid && rawSignature !== null
    ? cloneAndFreeze({ status: 'PRESENT_VALID' as const, value: raw as T, rawSignature })
    : cloneAndFreeze({ status: 'MALFORMED' as const, raw, rawSignature });
}

async function isStrictQueueRecord(
  value: unknown,
  identity: QueueBackupPersonalRestoreIdentityV2,
): Promise<boolean> {
  if (!isRecord(value)) return false;
  const keys = ['id', 'ownerUserId', 'actions', 'savedAt'];
  if (value['personalRestoreTransition'] !== undefined) keys.push('personalRestoreTransition');
  if (!hasExactKeys(value, keys) || value['id'] !== identity.recordId
    || value['ownerUserId'] !== identity.ownerUserId || !isTimestamp(value['savedAt'])
    || !isStrictActions(value['actions'])) return false;
  const transition = value['personalRestoreTransition'];
  return transition === undefined
    || await isQueueBackupPersonalRestoreTransitionV2(transition, value['actions'] as QueuedAction[]);
}

function isStrictDeadLetterRecord(
  value: unknown,
  identity: QueueBackupPersonalRestoreIdentityV2,
): boolean {
  return isRecord(value) && hasExactKeys(value, ['id', 'ownerUserId', 'deadLetters', 'savedAt'])
    && value['id'] === `dead-letter-backup:${identity.ownerUserId}`
    && value['ownerUserId'] === identity.ownerUserId && isTimestamp(value['savedAt'])
    && Array.isArray(value['deadLetters']) && value['deadLetters'].every(isStrictDeadLetter);
}

function isStrictDeadLetter(value: unknown): value is DeadLetterItem {
  return isRecord(value) && hasExactKeys(value, ['action', 'failedAt', 'reason'])
    && isStrictAction(value['action']) && isTimestamp(value['failedAt'])
    && typeof value['reason'] === 'string' && value['reason'].length > 0;
}

async function isStrictCatalog(value: unknown, ownerUserId: string): Promise<boolean> {
  if (!isRecord(value) || !hasExactKeys(value, [
    'id', 'kind', 'schemaVersion', 'ownerUserId', 'receiptIds', 'receipts',
  ]) || value['id'] !== getQueueBackupPersonalRestoreCatalogId(ownerUserId)
    || value['kind'] !== 'queue-backup-personal-restore-receipt-catalog'
    || value['schemaVersion'] !== 2 || value['ownerUserId'] !== ownerUserId
    || !Array.isArray(value['receiptIds']) || value['receiptIds'].length > MAX_RECEIPTS
    || !value['receiptIds'].every(id => typeof id === 'string')
    || new Set(value['receiptIds']).size !== value['receiptIds'].length
    || !isRecord(value['receipts'])) return false;
  const receiptIds = value['receiptIds'] as string[];
  const receipts = value['receipts'];
  const receiptKeys = Object.keys(receipts).sort();
  if (receiptKeys.length !== receiptIds.length
    || receiptKeys.some((id, index) => id !== [...receiptIds].sort()[index])) return false;
  for (const id of receiptIds) {
    const receipt = receipts[id];
    const terminalReceipt = receipt as QueueBackupPersonalRestoreTerminalReceiptV2;
    if (!await isStrictTerminalReceipt(receipt) || terminalReceipt.ownerUserId !== ownerUserId
      || terminalReceipt.id !== id || terminalReceipt.receiptId !== id) return false;
  }
  return true;
}

async function isStrictTerminalReceipt(value: unknown): Promise<boolean> {
  if (!isStrictTerminalReceiptCommon(value)) return false;
  const common = [
    'kind', 'schemaVersion', 'participant', 'id', 'recordId', 'ownerUserId', 'restoreRunId',
    'sourceDigest', 'token', 'identityDigest', 'receiptId', 'outcome', 'recordPresent',
    'resultDigest', 'completedAt',
  ];
  if (value['outcome'] === 'abandoned-before-prepare') {
    return hasExactKeys(value, [...common, 'abandonReason'])
      && value['abandonReason'] === 'marker-committed-before-queue-prepare'
      && await validateQueueBackupPersonalRestoreIdentity(captureIdentity(value));
  }
  if (value['outcome'] !== 'finalized' && value['outcome'] !== 'rolled-back'
    && value['outcome'] !== 'invalidated') return false;
  const keys = [...common, 'preimageDigest', 'restoredDigest', 'preparedActionsDigest'];
  if (value['outcome'] === 'invalidated') keys.push('invalidationReason');
  return hasExactKeys(value, keys) && isSha256(value['preimageDigest'])
    && isSha256(value['restoredDigest']) && isSha256(value['preparedActionsDigest'])
    && (value['outcome'] !== 'invalidated'
      || typeof value['invalidationReason'] === 'string' && value['invalidationReason'].length > 0)
    && await validateQueueBackupPersonalRestoreIdentity(captureIdentity(value));
}

async function projectTerminal(
  identity: QueueBackupPersonalRestoreIdentityV2,
  queue: QueueBackupRestoreProviderClassification<QueueBackupRecord>,
  catalog: QueueBackupRestoreProviderClassification<QueueBackupPersonalRestoreCatalogV2>,
  receipt: QueueBackupRestoreProviderClassification<QueueBackupPersonalRestoreTerminalReceiptV2>,
): Promise<QueueBackupRestoreProviderTerminalEvidence> {
  const sources = [queue, catalog, receipt];
  if (sources.some(source => source.status === 'UNREADABLE'))
    return { status: 'UNVERIFIABLE', reason: 'SOURCE_UNREADABLE' };
  if (sources.some(source => source.status === 'MALFORMED'))
    return { status: 'UNVERIFIABLE', reason: 'MALFORMED_EVIDENCE' };
  if (queue.status === 'PRESENT_VALID' && queue.value.personalRestoreTransition !== undefined) {
    return { status: 'UNVERIFIABLE', reason: 'ACTIVE_TRANSITION' };
  }
  const catalogReceipt = catalog.status === 'PRESENT_VALID'
    ? catalog.value.receipts[identity.receiptId]
    : undefined;
  const directReceipt = receipt.status === 'PRESENT_VALID' ? receipt.value : undefined;
  if (!catalogReceipt && !directReceipt) return { status: 'NOT_TERMINAL' };
  if (!catalogReceipt || !directReceipt) {
    return { status: 'UNVERIFIABLE', reason: 'RECEIPT_DIVERGENCE' };
  }
  const expectedIdentity = canonicalizePersistedValue(identity);
  if ([catalogReceipt, directReceipt].some(item =>
    canonicalizePersistedValue(captureIdentity(item)) !== expectedIdentity)) {
    return { status: 'UNVERIFIABLE', reason: 'IDENTITY_COLLISION', recordPresent: directReceipt.recordPresent };
  }
  if (canonicalizePersistedValue(catalogReceipt) !== canonicalizePersistedValue(directReceipt)) {
    return { status: 'UNVERIFIABLE', reason: 'RECEIPT_DIVERGENCE', recordPresent: directReceipt.recordPresent };
  }
  const actions = queue.status === 'PRESENT_VALID' ? queue.value.actions : [];
  let observedResultDigest: string;
  try { observedResultDigest = await digestQueueBackupPersonalRestoreActions('result', actions); } catch {
    return {
      status: 'UNVERIFIABLE', reason: 'RESULT_DIGEST_UNAVAILABLE',
      recordPresent: directReceipt.recordPresent,
    };
  }
  return observedResultDigest === directReceipt.resultDigest
    ? {
      status: 'TERMINAL_CONFIRMED', receipt: directReceipt,
      resultDigest: observedResultDigest, recordPresent: directReceipt.recordPresent,
    }
    : {
      status: 'RESULT_DIGEST_DRIFT', receipt: directReceipt,
      expectedResultDigest: directReceipt.resultDigest,
      observedResultDigest,
      recordPresent: directReceipt.recordPresent,
    };
}

function isStrictTerminalReceiptCommon(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && value['kind'] === 'queue-backup-personal-restore-receipt'
    && value['schemaVersion'] === 2 && value['id'] === value['receiptId']
    && typeof value['recordPresent'] === 'boolean' && isTimestamp(value['completedAt'])
    && isSha256(value['resultDigest']);
}

function isStrictActions(value: unknown): value is QueuedAction[] {
  if (!Array.isArray(value) || !value.every(isStrictAction)) return false;
  return new Set(value.map(action => action.id)).size === value.length
    && new Set(value.map(action => action.operationId)).size === value.length;
}

function isStrictAction(value: unknown): value is QueuedAction {
  if (!isPersistedQueuedAction(value)) return false;
  const optional = [
    'localCommittedAt', 'syncState', 'localHandoff', 'retryQueueSupersessions',
    'lastError', 'errorType', 'priority',
  ];
  const required = ['id', 'operationId', 'type', 'entityType', 'entityId', 'payload', 'timestamp', 'retryCount'];
  if (!hasExactKeys(value as unknown as Record<string, unknown>, [...required,
    ...optional.filter(key => value[key as keyof QueuedAction] !== undefined)])) {
    return false;
  }
  return ['project', 'task', 'connection', 'attachment', 'preference',
    'focus-session', 'routine-task', 'routine-completion'].includes(value.entityType)
    && isOptionalActionEvidence(value);
}

function isOptionalActionEvidence(action: QueuedAction): boolean {
  return (action.localCommittedAt === undefined
      || typeof action.localCommittedAt === 'number' && Number.isFinite(action.localCommittedAt))
    && (action.syncState === undefined || [
      'local_committed', 'held', 'pending_sync', 'syncing', 'retry_scheduled', 'synced',
      'conflict_detected', 'conflict_saved', 'dead_letter', 'blocked_by_auth',
      'blocked_by_protocol', 'storage_frozen',
    ].includes(action.syncState))
    && (action.priority === undefined || ['low', 'normal', 'critical'].includes(action.priority))
    && (action.errorType === undefined
      || ['network', 'business', 'permission', 'timeout', 'unknown', 'deferred'].includes(action.errorType))
    && (action.lastError === undefined || typeof action.lastError === 'string')
    && (action.localHandoff === undefined || isStrictLocalHandoff(action))
    && (action.retryQueueSupersessions === undefined || isStrictSupersessions(action));
}

function isStrictLocalHandoff(action: QueuedAction): boolean {
  const handoff = action.localHandoff as unknown as Record<string, unknown>;
  const optional = ['reservationId', 'reservedAt', 'effectsAppliedAt', 'completedAt', 'removalAuthorization'];
  const required = [
    'kind', 'state', 'ownerUserId', 'projectId', 'actionId', 'operationId',
    'payloadDigest', 'conflictFingerprint',
  ];
  return isRecord(handoff) && hasExactKeys(handoff, [...required, ...optional.filter(key => handoff[key] !== undefined)])
    && handoff['kind'] === 'resolved-project-conflict'
    && ['required', 'reserved', 'effects-applied', 'complete'].includes(handoff['state'] as string)
    && nonEmptyStrings(handoff, ['ownerUserId', 'projectId', 'payloadDigest', 'conflictFingerprint'])
    && handoff['actionId'] === action.id && handoff['operationId'] === action.operationId
    && optional.filter(key => key !== 'removalAuthorization').every(key =>
      handoff[key] === undefined || typeof handoff[key] === 'string')
    && (handoff['removalAuthorization'] === undefined
      || isStrictRemovalAuthorization(handoff['removalAuthorization'], action));
}

function isStrictRemovalAuthorization(value: unknown, action: QueuedAction): boolean {
  return isRecord(value) && hasExactKeys(value, ['kind', 'actionId', 'operationId', 'authorizedAt'])
    && value['kind'] === 'dead-letter' && value['actionId'] === action.id
    && value['operationId'] === action.operationId && typeof value['authorizedAt'] === 'string';
}

function isStrictSupersessions(action: QueuedAction): boolean {
  const reservations = action.retryQueueSupersessions;
  return Array.isArray(reservations) && reservations.every(reservation =>
    isRecord(reservation) && hasExactKeys(reservation, [
      'token', 'ownerUserId', 'entityType', 'entityId', 'actionId', 'actionOperationId', 'retryItems',
    ]) && nonEmptyStrings(reservation, ['token', 'ownerUserId', 'entityId', 'actionId', 'actionOperationId'])
      && ['project', 'task', 'connection'].includes(reservation.entityType)
      && Array.isArray(reservation.retryItems) && reservation.retryItems.every(item =>
        isRecord(item) && hasExactKeys(item, ['id', 'operationId'])
          && nonEmptyStrings(item, ['id', 'operationId'])))
    && new Set(reservations.map(reservation => reservation.token)).size === reservations.length;
}

function nonEmptyStrings(value: Record<string, unknown>, keys: string[]): boolean {
  return keys.every(key => typeof value[key] === 'string' && (value[key] as string).length > 0);
}

function safeCanonicalSignature(value: unknown): string | null {
  let signature: string | null = null;
  try { signature = canonicalizePersistedValue(value); } catch { /* Unrepresentable raw evidence stays malformed. */ }
  return signature;
}

function cloneAndFreeze<T>(value: T): T {
  return deepFreeze(structuredClone(value), new WeakSet());
}

function deepFreeze<T>(value: T, seen: WeakSet<object>): T {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  Object.values(value).forEach(item => deepFreeze(item, seen));
  return Object.freeze(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length
    && actual.every((key, index) => key === sortedExpected[index]);
}

function isTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !TIMESTAMP_PATTERN.test(value)) return false;
  const timestamp = new Date(value);
  return !Number.isNaN(timestamp.getTime()) && timestamp.toISOString() === value;
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && SHA256_PATTERN.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function captureIdentity(value: unknown): QueueBackupPersonalRestoreIdentityV2 | null {
  if (!isRecord(value)) return null;
  const identity = Object.freeze({
    ownerUserId: value['ownerUserId'], restoreRunId: value['restoreRunId'], participant: value['participant'],
    sourceDigest: value['sourceDigest'], token: value['token'], recordId: value['recordId'],
    identityDigest: value['identityDigest'], receiptId: value['receiptId'],
  });
  return Object.values(identity).every(item => typeof item === 'string') ? identity as QueueBackupPersonalRestoreIdentityV2 : null;
}

function isPlainJsonValue(value: unknown, seen: WeakSet<object>): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object') return false;
  if (seen.has(value)) return true;
  if (Array.isArray(value)) {
    seen.add(value);
    return Reflect.ownKeys(value).length === value.length + 1
      && value.every(item => isPlainJsonValue(item, seen));
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  seen.add(value);
  const keys = Reflect.ownKeys(value);
  return keys.every(key => {
    if (typeof key !== 'string') return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return !!descriptor?.enumerable && 'value' in descriptor && isPlainJsonValue(descriptor.value, seen);
  });
}
