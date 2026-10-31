import type { QueuedAction, QueueBackupPersonalRestoreCommand, QueueBackupPersonalRestoreReceipt,
  QueueBackupPersonalRestoreResult, QueueBackupPersonalRestoreTransition } from './action-queue.types';

const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;

function isSha256Digest(value: unknown): value is string { return typeof value === 'string' && SHA256_PATTERN.test(value); }
function canonicalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(item => canonicalizeJson(item));
  if (!value || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  return Object.keys(record).sort().reduce<Record<string, unknown>>((result, key) => {
    if (record[key] !== undefined) result[key] = canonicalizeJson(record[key]);
    return result;
  }, {});
}

export function buildActionQueuePayloadSignature(value: unknown): string { return JSON.stringify(canonicalizeJson(value)) ?? 'undefined'; }
export const buildAttachmentReplayPayloadSignature = buildActionQueuePayloadSignature;

export function hasExactActionIdentity(left: QueuedAction, right: QueuedAction): boolean {
  return left.id === right.id
    && left.operationId === right.operationId
    && left.type === right.type
    && left.entityType === right.entityType
    && left.entityId === right.entityId
    && buildActionQueuePayloadSignature(left.payload) === buildActionQueuePayloadSignature(right.payload);
}

export function canonicalizePersistedValue(value: unknown): string {
  const active = new Set<object>();
  const visit = (candidate: unknown): string => {
    if (candidate === null) return 'null';
    if (candidate === undefined) return 'undefined';
    if (typeof candidate === 'string') return `string:${JSON.stringify(candidate)}`;
    if (typeof candidate === 'boolean') return candidate ? 'boolean:true' : 'boolean:false';
    if (typeof candidate === 'number') {
      if (!Number.isFinite(candidate)) throw new TypeError('Non-finite persisted number');
      return `number:${Object.is(candidate, -0) ? '-0' : candidate}`;
    }
    if (typeof candidate !== 'object') throw new TypeError('Unsupported persisted value');
    if (active.has(candidate)) throw new TypeError('Cyclic persisted value');
    active.add(candidate);
    let result: string;
    if (Array.isArray(candidate)) {
      result = `array:[${candidate.map(item => visit(item)).join(',')}]`;
    } else if (candidate instanceof Date) {
      result = `date:${candidate.toISOString()}`;
    } else {
      const record = candidate as Record<string, unknown>;
      result = `object:{${Object.keys(record).sort()
        .map(key => `${JSON.stringify(key)}:${visit(record[key])}`).join(',')}}`;
    }
    active.delete(candidate);
    return result;
  };
  return visit(value);
}

export function haveExactPersistedActions(left: QueuedAction[], right: QueuedAction[]): boolean { return canonicalizePersistedValue(left) === canonicalizePersistedValue(right); }
export async function digestPersistedActions(actions: QueuedAction[]): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('Web Crypto SHA-256 is unavailable');
  const bytes = new TextEncoder().encode(canonicalizePersistedValue(actions));
  const digest = await subtle.digest('SHA-256', bytes);
  return `sha256:${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')}`;
}

async function hasContentBoundTransitionDigests(
  transition: QueueBackupPersonalRestoreTransition,
): Promise<boolean> {
  const [preimageDigest, restoredDigest, preparedActionsDigest] = await Promise.all([
    digestPersistedActions(transition.preimage),
    digestPersistedActions(transition.restoredActions),
    digestPersistedActions([...transition.preimage, ...transition.restoredActions]),
  ]);
  return transition.preimageDigest === preimageDigest
    && transition.restoredDigest === restoredDigest
    && transition.preparedActionsDigest === preparedActionsDigest;
}

function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
export function isPersistedQueuedAction(value: unknown): value is QueuedAction {
  if (!isRecord(value)) return false;
  return typeof value['id'] === 'string' && value['id'].length > 0
    && typeof value['operationId'] === 'string' && value['operationId'].length > 0
    && (value['type'] === 'create' || value['type'] === 'update' || value['type'] === 'delete')
    && typeof value['entityType'] === 'string' && value['entityType'].length > 0
    && typeof value['entityId'] === 'string' && value['entityId'].length > 0
    && isRecord(value['payload'])
    && typeof value['timestamp'] === 'number' && Number.isFinite(value['timestamp'])
    && Number.isInteger(value['retryCount']) && (value['retryCount'] as number) >= 0;
}

export function isQueueBackupPersonalRestoreTransition(
  value: unknown,
): value is QueueBackupPersonalRestoreTransition {
  if (!isRecord(value)) return false;
  return value['schemaVersion'] === 1
    && value['state'] === 'prepared'
    && typeof value['ownerUserId'] === 'string' && value['ownerUserId'].length > 0
    && typeof value['token'] === 'string' && value['token'].length > 0
    && Array.isArray(value['preimage'])
    && value['preimage'].every(isPersistedQueuedAction)
    && isSha256Digest(value['preimageDigest'])
    && Array.isArray(value['restoredActions'])
    && value['restoredActions'].every(isPersistedQueuedAction)
    && isSha256Digest(value['restoredDigest'])
    && isSha256Digest(value['preparedActionsDigest'])
    && typeof value['preparedAt'] === 'string';
}

export function isQueueBackupPersonalRestoreReceipt(
  value: unknown,
): value is QueueBackupPersonalRestoreReceipt {
  if (!isRecord(value)) return false;
  return typeof value['id'] === 'string'
    && value['kind'] === 'queue-backup-personal-restore-receipt'
    && value['schemaVersion'] === 1
    && typeof value['ownerUserId'] === 'string' && value['ownerUserId'].length > 0
    && typeof value['token'] === 'string' && value['token'].length > 0
    && (value['outcome'] === 'finalized' || value['outcome'] === 'rolled-back')
    && isSha256Digest(value['preimageDigest'])
    && isSha256Digest(value['restoredDigest'])
    && isSha256Digest(value['preparedActionsDigest'])
    && isSha256Digest(value['resultDigest'])
    && typeof value['completedAt'] === 'string';
}

export function getQueueBackupPersonalRestoreReceiptId(ownerUserId: string, token: string): string {
  return `queue-backup-personal-restore-receipt:${encodeURIComponent(ownerUserId)}:${encodeURIComponent(token)}`;
}

function actionKeysAreUnique(actions: QueuedAction[]): boolean {
  const ids = new Set<string>();
  const operations = new Set<string>();
  return actions.every(action => {
    if (ids.has(action.id) || operations.has(action.operationId)) return false;
    ids.add(action.id);
    operations.add(action.operationId);
    return true;
  });
}

function containsExactAction(actions: QueuedAction[], expected: QueuedAction): boolean {
  const signature = canonicalizePersistedValue(expected);
  return actions.filter(action => canonicalizePersistedValue(action) === signature).length === 1;
}

export function preservesPreparedRestoreActions(
  current: QueuedAction[],
  next: QueuedAction[],
  transition: QueueBackupPersonalRestoreTransition,
): boolean {
  if (!isQueueBackupPersonalRestoreTransition(transition)) return false;
  const protectedActions = [...transition.preimage, ...transition.restoredActions];
  if (!actionKeysAreUnique(protectedActions) || !actionKeysAreUnique(current) || !actionKeysAreUnique(next)) return false;
  return protectedActions.every(action =>
    containsExactAction(current, action) && containsExactAction(next, action));
}

export interface QueueBackupPersonalRestorePlan {
  result: QueueBackupPersonalRestoreResult;
  nextActions?: QueuedAction[];
  nextTransition?: QueueBackupPersonalRestoreTransition | null;
  receipt?: QueueBackupPersonalRestoreReceipt;
}

interface QueueBackupPersonalRestorePlannerInput {
  ownerUserId: string;
  command: QueueBackupPersonalRestoreCommand;
  currentActions: QueuedAction[];
  transition?: unknown;
  receipt?: unknown;
}

export async function planQueueBackupPersonalRestore(
  input: QueueBackupPersonalRestorePlannerInput,
): Promise<QueueBackupPersonalRestorePlan> {
  const { ownerUserId, command, currentActions } = input;
  const suppliedActions = command.kind === 'prepare'
    ? [...command.expectedActions, ...command.restoredActions]
    : [];
  if (!command.token || !currentActions.every(isPersistedQueuedAction)
    || !suppliedActions.every(isPersistedQueuedAction)
    || !actionKeysAreUnique(currentActions)) {
    return { result: { status: 'rejected', reason: 'malformed-record' } };
  }
  if (input.receipt !== undefined) {
    return planExistingReceipt(ownerUserId, command, input.receipt);
  }
  return command.kind === 'prepare'
    ? planPersonalRestorePreparation(input, command)
    : planPersonalRestoreTerminal(input, command);
}

function planExistingReceipt(
  ownerUserId: string,
  command: QueueBackupPersonalRestoreCommand,
  receipt: unknown,
): QueueBackupPersonalRestorePlan {
  if (!isQueueBackupPersonalRestoreReceipt(receipt)
    || receipt.ownerUserId !== ownerUserId
    || receipt.token !== command.token) {
    return { result: { status: 'rejected', reason: 'malformed-record' } };
  }
  if (command.kind === 'prepare') {
    return { result: { status: 'rejected', reason: 'terminal-conflict' } };
  }
  const expected = command.kind === 'finalize' ? 'finalized' : 'rolled-back';
  return { result: receipt.outcome === expected
    ? { status: expected === 'finalized' ? 'already-finalized' : 'already-rolled-back' }
    : { status: 'rejected', reason: 'terminal-conflict' } };
}

async function planPersonalRestorePreparation(
  input: QueueBackupPersonalRestorePlannerInput,
  command: Extract<QueueBackupPersonalRestoreCommand, { kind: 'prepare' }>,
): Promise<QueueBackupPersonalRestorePlan> {
  const preimageDigest = await digestPersistedActions(command.expectedActions);
  const restoredDigest = await digestPersistedActions(command.restoredActions);
  if (input.transition !== undefined) {
    return planExistingPreparation(input.ownerUserId, command.token, input.currentActions, input.transition, {
      preimageDigest,
      restoredDigest,
    });
  }
  if (!haveExactPersistedActions(input.currentActions, command.expectedActions)) {
    return { result: { status: 'rejected', reason: 'identity-mismatch' } };
  }
  const preparedActions = [...input.currentActions, ...command.restoredActions];
  if (!actionKeysAreUnique(preparedActions)) {
    return { result: { status: 'rejected', reason: 'identity-conflict' } };
  }
  const nextTransition: QueueBackupPersonalRestoreTransition = {
    schemaVersion: 1,
    state: 'prepared',
    ownerUserId: input.ownerUserId,
    token: command.token,
    preimage: input.currentActions,
    preimageDigest,
    restoredActions: command.restoredActions,
    restoredDigest,
    preparedActionsDigest: await digestPersistedActions(preparedActions),
    preparedAt: new Date().toISOString(),
  };
  return { result: { status: 'prepared' }, nextActions: preparedActions, nextTransition };
}

async function planExistingPreparation(
  ownerUserId: string,
  token: string,
  currentActions: QueuedAction[],
  transition: unknown,
  digests: { preimageDigest: string; restoredDigest: string },
): Promise<QueueBackupPersonalRestorePlan> {
  if (!isQueueBackupPersonalRestoreTransition(transition)
    || transition.ownerUserId !== ownerUserId) {
    return { result: { status: 'rejected', reason: 'malformed-record' } };
  }
  if (transition.token !== token) {
    return { result: { status: 'rejected', reason: 'transition-conflict' } };
  }
  if (!await hasContentBoundTransitionDigests(transition)) {
    return { result: { status: 'rejected', reason: 'identity-mismatch' } };
  }
  if (!preservesPreparedRestoreActions(currentActions, currentActions, transition)) {
    return { result: { status: 'rejected', reason: 'identity-mismatch' } };
  }
  return { result: transition.preimageDigest === digests.preimageDigest
    && transition.restoredDigest === digests.restoredDigest
    ? { status: 'already-prepared' }
    : { status: 'rejected', reason: 'identity-mismatch' } };
}

async function planPersonalRestoreTerminal(
  input: QueueBackupPersonalRestorePlannerInput,
  command: Extract<QueueBackupPersonalRestoreCommand, { kind: 'finalize' | 'rollback' }>,
): Promise<QueueBackupPersonalRestorePlan> {
  const { transition } = input;
  if (transition === undefined) {
    return { result: { status: 'rejected', reason: 'not-prepared' } };
  }
  if (!isQueueBackupPersonalRestoreTransition(transition)
    || transition.ownerUserId !== input.ownerUserId) {
    return { result: { status: 'rejected', reason: 'malformed-record' } };
  }
  if (transition.token !== command.token) {
    return { result: { status: 'rejected', reason: 'transition-conflict' } };
  }
  if (!await hasContentBoundTransitionDigests(transition)) {
    return { result: { status: 'rejected', reason: 'identity-mismatch' } };
  }
  if (!preservesPreparedRestoreActions(input.currentActions, input.currentActions, transition)) {
    return { result: { status: 'rejected', reason: 'identity-mismatch' } };
  }
  const removed = command.kind === 'finalize' ? transition.preimage : transition.restoredActions;
  const removedSignatures = new Set(removed.map(action => canonicalizePersistedValue(action)));
  const nextActions = input.currentActions.filter(action =>
    !removedSignatures.has(canonicalizePersistedValue(action)));
  const outcome = command.kind === 'finalize' ? 'finalized' : 'rolled-back';
  const receipt: QueueBackupPersonalRestoreReceipt = {
    id: getQueueBackupPersonalRestoreReceiptId(input.ownerUserId, command.token),
    kind: 'queue-backup-personal-restore-receipt',
    schemaVersion: 1,
    ownerUserId: input.ownerUserId,
    token: command.token,
    outcome,
    preimageDigest: transition.preimageDigest,
    restoredDigest: transition.restoredDigest,
    preparedActionsDigest: transition.preparedActionsDigest,
    resultDigest: await digestPersistedActions(nextActions),
    completedAt: new Date().toISOString(),
  };
  return {
    result: { status: outcome },
    nextActions,
    nextTransition: null,
    receipt,
  };
}
