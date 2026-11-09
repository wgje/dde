import type {
  QueuedAction, QueueBackupPersonalRestoreAbandonCommandV2,
  QueueBackupPersonalRestoreCommandV2,
  QueueBackupPersonalRestoreIdentityInputV2, QueueBackupPersonalRestoreIdentityV2,
  QueueBackupPersonalRestorePreparedReceiptV2, QueueBackupPersonalRestoreResultV2,
  QueueBackupPersonalRestoreTerminalReceiptV2, QueueBackupPersonalRestoreTransitionV2,
} from './action-queue.types';
import {
  canonicalizePersistedValue,
  haveExactPersistedActions,
  isPersistedQueuedAction,
} from './action-queue-identity.helpers';

const IDENTITY_DOMAIN = 'nanoflow.queue-backup.personal-restore.identity\0v2\0';
const ACTION_DOMAIN = 'nanoflow.queue-backup.personal-restore.action-digest.';
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MAX_FIELD_BYTES = 512;
const MAX_RECEIPTS = 64;

export type QueueBackupPersonalRestoreActionDigestKind = 'preimage' | 'restored' | 'prepared' | 'result';

export interface QueueBackupPersonalRestoreCatalogV2 {
  id: string;
  kind: 'queue-backup-personal-restore-receipt-catalog';
  schemaVersion: 2;
  ownerUserId: string;
  receiptIds: string[];
  receipts: Record<string, QueueBackupPersonalRestoreTerminalReceiptV2>;
}

export interface QueueBackupPersonalRestoreRecordV2 {
  id: string;
  ownerUserId: string;
  actions: QueuedAction[];
  savedAt: string;
  personalRestoreTransition?: unknown;
  [key: string]: unknown;
}

export interface QueueBackupPersonalRestoreSnapshotV2 {
  record?: QueueBackupPersonalRestoreRecordV2;
  catalog?: unknown;
  receipt?: unknown;
}

export interface QueueBackupPersonalRestorePlanV2 {
  result: QueueBackupPersonalRestoreResultV2;
  nextRecord?: QueueBackupPersonalRestoreRecordV2; nextCatalog?: QueueBackupPersonalRestoreCatalogV2;
  receipt?: QueueBackupPersonalRestoreTerminalReceiptV2;
  write: boolean;
}

type V2Command = QueueBackupPersonalRestoreCommandV2 | QueueBackupPersonalRestoreAbandonCommandV2;
type Evidence =
  | { status: 'absent'; catalog: QueueBackupPersonalRestoreCatalogV2 }
  | { status: 'active'; catalog: QueueBackupPersonalRestoreCatalogV2; transition: unknown }
  | { status: 'terminal'; catalog: QueueBackupPersonalRestoreCatalogV2; receipt: QueueBackupPersonalRestoreTerminalReceiptV2 }
  | { status: 'identity-collision' } | { status: 'malformed-evidence' };
type AbsenceBinding = { identityDigest: string; snapshotSignature: string };
export async function createQueueBackupPersonalRestoreIdentity(
  input: QueueBackupPersonalRestoreIdentityInputV2,
): Promise<QueueBackupPersonalRestoreIdentityV2> {
  validateIdentityInput(input);
  const framed = concatBytes(
    new TextEncoder().encode(IDENTITY_DOMAIN),
    ...([
      [1, input.ownerUserId], [2, input.restoreRunId], [3, input.participant],
      [4, input.sourceDigest], [5, input.token],
    ] as const).map(([tag, value]) => frameField(tag, value)),
  );
  const digestHex = await sha256Hex(framed);
  return Object.freeze({
    ...input,
    recordId: `queue-backup:${input.ownerUserId}`,
    identityDigest: `sha256:${digestHex}`,
    receiptId: `queue-backup-personal-restore-receipt:v2:${digestHex}`,
  });
}
export async function digestQueueBackupPersonalRestoreActions(
  kind: QueueBackupPersonalRestoreActionDigestKind,
  actions: QueuedAction[],
): Promise<string> {
  if (!Array.isArray(actions) || !actions.every(isPersistedQueuedAction)) {
    throw new TypeError('Malformed persisted action array');
  }
  const canonical = new TextEncoder().encode(canonicalizePersistedValue(actions));
  if (canonical.byteLength > 0xffffffff) throw new RangeError('Canonical action bytes exceed U32');
  const domain = new TextEncoder().encode(`${ACTION_DOMAIN}${kind}\0v2\0`);
  return `sha256:${await sha256Hex(concatBytes(domain, u32be(canonical.byteLength), canonical))}`;
}
export function getQueueBackupPersonalRestoreCatalogId(ownerUserId: string): string {
  return `queue-backup-personal-restore-catalog:v2:${encodeURIComponent(ownerUserId)}`;
}
export function createQueueBackupPersonalRestoreAuthority() {
  const issuedProofs = new WeakSet<object>();
  const proofBindings = new WeakMap<object, AbsenceBinding>();
  const consume = (proof: object): AbsenceBinding | null => {
    if (!issuedProofs.has(proof)) return null;
    issuedProofs.delete(proof);
    const binding = proofBindings.get(proof) ?? null; proofBindings.delete(proof);
    return binding;
  };
  return {
    async inspect(identity: QueueBackupPersonalRestoreIdentityV2, snapshot: QueueBackupPersonalRestoreSnapshotV2) {
      const evidence = await inspectQueueBackupPersonalRestoreEvidence(identity, snapshot);
      if (evidence.status !== 'absent') return evidence;
      const absenceProof = Object.freeze({}); issuedProofs.add(absenceProof);
      proofBindings.set(absenceProof, { identityDigest: identity.identityDigest, snapshotSignature: snapshotSignature(snapshot) });
      return { ...evidence, absenceProof };
    },
    plan: (snapshot: QueueBackupPersonalRestoreSnapshotV2, command: V2Command) =>
      planQueueBackupPersonalRestoreV2(snapshot, command, consume),
  };
}
export async function validateQueueBackupPersonalRestoreIdentity(
  value: unknown,
): Promise<boolean> {
  if (!isRecord(value) || !hasExactKeys(value, [
    'ownerUserId', 'restoreRunId', 'participant', 'sourceDigest', 'token',
    'recordId', 'identityDigest', 'receiptId',
  ])) return false;
  try {
    const expected = await createQueueBackupPersonalRestoreIdentity(
      value as unknown as QueueBackupPersonalRestoreIdentityInputV2,
    );
    return canonicalizePersistedValue(value) === canonicalizePersistedValue(expected);
  } catch {
    return false;
  }
}
async function inspectQueueBackupPersonalRestoreEvidence(
  identity: QueueBackupPersonalRestoreIdentityV2,
  snapshot: QueueBackupPersonalRestoreSnapshotV2,
): Promise<Evidence> {
  const record = snapshot.record;
  if (record !== undefined && !isRecordForIdentity(record, identity)) {
    return { status: 'malformed-evidence' };
  }
  const catalog = await normalizeCatalog(identity.ownerUserId, snapshot.catalog);
  if (!catalog) return { status: 'malformed-evidence' };
  const catalogReceipt = catalog.receipts[identity.receiptId];
  const rawReceipt = snapshot.receipt;
  if ((catalogReceipt === undefined) !== (rawReceipt === undefined)) {
    return { status: 'malformed-evidence' };
  }
  if (rawReceipt !== undefined) {
    if (looksLikeReceiptCollision(rawReceipt, identity)) return { status: 'identity-collision' };
    if (!await isTerminalReceipt(rawReceipt)
      || canonicalizePersistedValue(rawReceipt) !== canonicalizePersistedValue(catalogReceipt)) {
      return { status: 'malformed-evidence' };
    }
    if (record?.personalRestoreTransition !== undefined) return { status: 'malformed-evidence' };
    return { status: 'terminal', catalog, receipt: rawReceipt as QueueBackupPersonalRestoreTerminalReceiptV2 };
  }
  if (record?.personalRestoreTransition !== undefined) {
    const transition = record.personalRestoreTransition;
    if (!isRecord(transition) || transition['schemaVersion'] !== 2
      || !await isQueueBackupPersonalRestoreTransitionV2(transition, record.actions)) {
      return { status: 'malformed-evidence' };
    }
    return { status: 'active', catalog, transition };
  }
  return { status: 'absent', catalog };
}
async function planQueueBackupPersonalRestoreV2(
  snapshot: QueueBackupPersonalRestoreSnapshotV2,
  command: V2Command,
  consumeAbsenceProof: (proof: object) => AbsenceBinding | null,
): Promise<QueueBackupPersonalRestorePlanV2> {
  const identity = command.identity;
  if (!await validateQueueBackupPersonalRestoreIdentity(identity)) {
    return reject('malformed-evidence');
  }
  const evidence = await inspectQueueBackupPersonalRestoreEvidence(identity, snapshot);
  if (evidence.status === 'identity-collision' || evidence.status === 'malformed-evidence') {
    return reject(evidence.status);
  }
  if (evidence.status === 'terminal') return replayTerminal(command, evidence.receipt);
  if (command.kind === 'abandon-before-prepare') {
    if (evidence.status === 'active') return reject('active-transition');
    const binding = consumeAbsenceProof(command.absenceProof);
    if (!binding || binding.identityDigest !== identity.identityDigest
      || binding.snapshotSignature !== snapshotSignature(snapshot)) {
      return reject('state-changed');
    }
    if (evidence.catalog.receiptIds.length >= MAX_RECEIPTS) return reject('retention-full');
    const receipt = await createAbandonmentReceipt(identity, snapshot.record);
    return terminalPlan(receipt, appendReceipt(evidence.catalog, receipt));
  }
  if (evidence.status === 'active') {
    const transition = evidence.transition as QueueBackupPersonalRestoreTransitionV2;
    if (!sameIdentity(transition.preparedReceipt, identity)) return reject('stale-identity');
    return command.kind === 'prepare'
      ? planRepeatedPrepare(command, transition)
      : planTerminal(command, snapshot.record!, evidence.catalog, transition);
  }
  if (command.kind !== 'prepare') return reject('not-prepared');
  return planPrepare(command, snapshot.record);
}
async function planPrepare(
  command: Extract<QueueBackupPersonalRestoreCommandV2, { kind: 'prepare' }>,
  record: QueueBackupPersonalRestoreRecordV2 | undefined,
): Promise<QueueBackupPersonalRestorePlanV2> {
  const current = record?.actions ?? [];
  if (!validUniqueActions(current) || !validUniqueActions(command.expectedActions)
    || !validUniqueActions(command.restoredActions)
    || !haveExactPersistedActions(current, command.expectedActions)) {
    return reject('state-changed');
  }
  const prepared = [...current, ...command.restoredActions];
  if (!validUniqueActions(prepared)) return reject('identity-collision');
  const receipt: QueueBackupPersonalRestorePreparedReceiptV2 = {
    ...command.identity,
    id: command.identity.identityDigest, kind: 'queue-backup-personal-restore-prepared-receipt', schemaVersion: 2,
    recordPresent: record !== undefined,
    preimageDigest: await digestQueueBackupPersonalRestoreActions('preimage', current),
    restoredDigest: await digestQueueBackupPersonalRestoreActions('restored', command.restoredActions),
    preparedActionsDigest: await digestQueueBackupPersonalRestoreActions('prepared', prepared),
    preparedAt: nowTimestamp(),
  };
  const transition: QueueBackupPersonalRestoreTransitionV2 = {
    kind: 'queue-backup-personal-restore-transition', schemaVersion: 2, state: 'prepared',
    id: command.identity.identityDigest,
    preparedReceipt: receipt, preimage: current, restoredActions: command.restoredActions,
  };
  return {
    result: { status: 'prepared' }, write: true,
    nextRecord: {
      ...(record ?? {}), id: command.identity.recordId, ownerUserId: command.identity.ownerUserId,
      actions: prepared,
      savedAt: nowTimestamp(), personalRestoreTransition: transition,
    },
  };
}
async function planRepeatedPrepare(
  command: Extract<QueueBackupPersonalRestoreCommandV2, { kind: 'prepare' }>,
  transition: QueueBackupPersonalRestoreTransitionV2,
): Promise<QueueBackupPersonalRestorePlanV2> {
  const exact = haveExactPersistedActions(command.expectedActions, transition.preimage)
    && haveExactPersistedActions(command.restoredActions, transition.restoredActions);
  return exact ? { result: { status: 'already-prepared' }, write: false }
    : reject('state-changed');
}
async function planTerminal(
  command: Exclude<QueueBackupPersonalRestoreCommandV2, { kind: 'prepare' }>,
  record: QueueBackupPersonalRestoreRecordV2,
  catalog: QueueBackupPersonalRestoreCatalogV2,
  transition: QueueBackupPersonalRestoreTransitionV2,
): Promise<QueueBackupPersonalRestorePlanV2> {
  if (catalog.receiptIds.length >= MAX_RECEIPTS) return reject('retention-full');
  const protectedActions = [...transition.preimage, ...transition.restoredActions];
  if (!validUniqueActions(record.actions)
    || !protectedActions.every(action => containsExact(record.actions, action))) {
    return reject('state-changed');
  }
  const removed = command.kind === 'finalize' ? transition.preimage
    : command.kind === 'rollback' ? transition.restoredActions : record.actions;
  const removedSignatures = new Set(removed.map(canonicalizePersistedValue));
  const nextActions = record.actions.filter(action => !removedSignatures.has(canonicalizePersistedValue(action)));
  const receipt = await createTerminalReceipt(command, transition.preparedReceipt, nextActions);
  const nextRecord = { ...record, actions: nextActions, savedAt: nowTimestamp() };
  delete nextRecord.personalRestoreTransition;
  return {
    ...terminalPlan(receipt, appendReceipt(catalog, receipt)),
    nextRecord,
  };
}
function replayTerminal(
  command: V2Command,
  receipt: QueueBackupPersonalRestoreTerminalReceiptV2,
): QueueBackupPersonalRestorePlanV2 {
  if (command.kind === 'abandon-before-prepare') {
    return receipt.outcome === 'abandoned-before-prepare'
      ? terminalResult('already-abandoned-before-prepare', receipt)
      : reject('opposite-terminal');
  }
  if (command.kind === 'prepare') return terminalResult(alreadyStatus(receipt.outcome), receipt);
  const expected = command.kind === 'finalize' ? 'finalized'
    : command.kind === 'rollback' ? 'rolled-back' : 'invalidated';
  return receipt.outcome === expected
    ? terminalResult(alreadyStatus(expected), receipt)
    : reject('opposite-terminal');
}
async function createAbandonmentReceipt(
  identity: QueueBackupPersonalRestoreIdentityV2,
  record: QueueBackupPersonalRestoreRecordV2 | undefined,
): Promise<QueueBackupPersonalRestoreTerminalReceiptV2> {
  return {
    ...identity, id: identity.receiptId,
    kind: 'queue-backup-personal-restore-receipt', schemaVersion: 2,
    outcome: 'abandoned-before-prepare',
    abandonReason: 'marker-committed-before-queue-prepare',
    recordPresent: record !== undefined,
    resultDigest: await digestQueueBackupPersonalRestoreActions('result', record?.actions ?? []),
    completedAt: nowTimestamp(),
  };
}
async function createTerminalReceipt(
  command: Exclude<QueueBackupPersonalRestoreCommandV2, { kind: 'prepare' }>,
  prepared: QueueBackupPersonalRestorePreparedReceiptV2,
  result: QueuedAction[],
): Promise<QueueBackupPersonalRestoreTerminalReceiptV2> {
  const outcome = command.kind === 'finalize' ? 'finalized'
    : command.kind === 'rollback' ? 'rolled-back' : 'invalidated';
  return {
    ownerUserId: prepared.ownerUserId, restoreRunId: prepared.restoreRunId,
    participant: prepared.participant, sourceDigest: prepared.sourceDigest, token: prepared.token,
    recordId: prepared.recordId, identityDigest: prepared.identityDigest, receiptId: prepared.receiptId,
    id: prepared.receiptId, kind: 'queue-backup-personal-restore-receipt', schemaVersion: 2,
    outcome, recordPresent: prepared.recordPresent,
    preimageDigest: prepared.preimageDigest, restoredDigest: prepared.restoredDigest,
    preparedActionsDigest: prepared.preparedActionsDigest,
    resultDigest: await digestQueueBackupPersonalRestoreActions('result', result),
    completedAt: nowTimestamp(),
    ...(command.kind === 'invalidate' ? { invalidationReason: command.invalidationReason } : {}),
  } as QueueBackupPersonalRestoreTerminalReceiptV2;
}
function appendReceipt(
  catalog: QueueBackupPersonalRestoreCatalogV2,
  receipt: QueueBackupPersonalRestoreTerminalReceiptV2,
): QueueBackupPersonalRestoreCatalogV2 {
  return {
    ...catalog,
    receiptIds: [...catalog.receiptIds, receipt.receiptId],
    receipts: { ...catalog.receipts, [receipt.receiptId]: receipt },
  };
}
function terminalPlan(
  receipt: QueueBackupPersonalRestoreTerminalReceiptV2,
  catalog: QueueBackupPersonalRestoreCatalogV2,
): QueueBackupPersonalRestorePlanV2 {
  const status = receipt.outcome === 'abandoned-before-prepare'
    ? 'abandoned-before-prepare' : receipt.outcome;
  return { result: { status, receipt }, receipt, nextCatalog: catalog, write: true };
}
function terminalResult(
  status: 'already-finalized' | 'already-rolled-back' | 'already-invalidated'
    | 'already-abandoned-before-prepare',
  receipt: QueueBackupPersonalRestoreTerminalReceiptV2,
): QueueBackupPersonalRestorePlanV2 {
  return { result: { status, receipt }, write: false };
}
function reject(reason: Extract<QueueBackupPersonalRestoreResultV2, { status: 'rejected' }>['reason']): QueueBackupPersonalRestorePlanV2 {
  return { result: { status: 'rejected', reason }, write: false };
}
async function normalizeCatalog(
  ownerUserId: string,
  value: unknown,
): Promise<QueueBackupPersonalRestoreCatalogV2 | null> {
  if (value === undefined) return emptyCatalog(ownerUserId);
  if (!isRecord(value) || !hasExactKeys(value, [
    'id', 'kind', 'schemaVersion', 'ownerUserId', 'receiptIds', 'receipts',
  ]) || value['id'] !== getQueueBackupPersonalRestoreCatalogId(ownerUserId)
    || value['kind'] !== 'queue-backup-personal-restore-receipt-catalog'
    || value['schemaVersion'] !== 2 || value['ownerUserId'] !== ownerUserId
    || !Array.isArray(value['receiptIds']) || value['receiptIds'].length > MAX_RECEIPTS
    || !value['receiptIds'].every(id => typeof id === 'string')
    || new Set(value['receiptIds']).size !== value['receiptIds'].length
    || !isRecord(value['receipts'])) return null;
  const receipts = value['receipts'];
  if (!sameStringSet(Object.keys(receipts), value['receiptIds'])) return null;
  for (const id of value['receiptIds']) {
    const receipt = receipts[id];
    if (!await isTerminalReceipt(receipt)) return null;
    const validReceipt = receipt as QueueBackupPersonalRestoreTerminalReceiptV2;
    if (validReceipt.ownerUserId !== ownerUserId || validReceipt.receiptId !== id || validReceipt.id !== id) return null;
  }
  return value as unknown as QueueBackupPersonalRestoreCatalogV2;
}
export async function isQueueBackupPersonalRestoreTransitionV2(value: unknown, actions?: QueuedAction[]): Promise<boolean> {
  if (!isRecord(value) || !hasExactKeys(value, [
    'kind', 'schemaVersion', 'state', 'id', 'preparedReceipt', 'preimage', 'restoredActions',
  ]) || value['kind'] !== 'queue-backup-personal-restore-transition'
    || value['schemaVersion'] !== 2 || value['state'] !== 'prepared'
    || !isRecord(value['preparedReceipt']) || !Array.isArray(value['preimage'])
    || !Array.isArray(value['restoredActions'])) return false;
  const prepared = value['preparedReceipt'];
  if (!await isPreparedReceipt(prepared, value['preimage'], value['restoredActions'])) return false;
  return value['id'] === prepared.identityDigest
    && (actions === undefined || preservesPreparedRestoreActionsV2(actions, actions, value));
}
async function isPreparedReceipt(
  value: Record<string, unknown>, preimage: unknown[], restored: unknown[],
): Promise<boolean> {
  if (!hasExactKeys(value, [
    'kind', 'schemaVersion', 'participant', 'id', 'recordId', 'ownerUserId', 'restoreRunId',
    'sourceDigest', 'token', 'identityDigest', 'receiptId', 'recordPresent',
    'preimageDigest', 'restoredDigest', 'preparedActionsDigest', 'preparedAt',
  ]) || value['kind'] !== 'queue-backup-personal-restore-prepared-receipt'
    || value['schemaVersion'] !== 2 || value['id'] !== value['identityDigest']
    || typeof value['recordPresent'] !== 'boolean' || !isTimestamp(value['preparedAt'])
    || !preimage.every(isPersistedQueuedAction) || !restored.every(isPersistedQueuedAction)
    || !await hasValidIdentityFields(value)) return false;
  return value['preimageDigest'] === await digestQueueBackupPersonalRestoreActions('preimage', preimage as QueuedAction[])
    && value['restoredDigest'] === await digestQueueBackupPersonalRestoreActions('restored', restored as QueuedAction[])
    && value['preparedActionsDigest'] === await digestQueueBackupPersonalRestoreActions(
      'prepared', [...preimage, ...restored] as QueuedAction[],
    );
}

async function isTerminalReceipt(value: unknown): Promise<boolean> {
  if (!isRecord(value) || value['kind'] !== 'queue-backup-personal-restore-receipt'
    || value['schemaVersion'] !== 2 || value['id'] !== value['receiptId']
    || typeof value['recordPresent'] !== 'boolean' || !isTimestamp(value['completedAt'])
    || !isSha256(value['resultDigest']) || !await hasValidIdentityFields(value)) return false;
  if (value['outcome'] === 'abandoned-before-prepare') {
    return hasExactKeys(value, [
      'kind', 'schemaVersion', 'participant', 'id', 'recordId', 'ownerUserId', 'restoreRunId',
      'sourceDigest', 'token', 'identityDigest', 'receiptId', 'outcome', 'abandonReason',
      'recordPresent', 'resultDigest', 'completedAt',
    ]) && value['abandonReason'] === 'marker-committed-before-queue-prepare';
  }
  if (value['outcome'] !== 'finalized' && value['outcome'] !== 'rolled-back'
    && value['outcome'] !== 'invalidated') return false;
  const keys = [
    'kind', 'schemaVersion', 'participant', 'id', 'recordId', 'ownerUserId', 'restoreRunId',
    'sourceDigest', 'token', 'identityDigest', 'receiptId', 'outcome', 'recordPresent',
    'preimageDigest', 'restoredDigest', 'preparedActionsDigest', 'resultDigest', 'completedAt',
    ...(value['outcome'] === 'invalidated' ? ['invalidationReason'] : []),
  ];
  return hasExactKeys(value, keys)
    && isSha256(value['preimageDigest']) && isSha256(value['restoredDigest'])
    && isSha256(value['preparedActionsDigest'])
    && (value['outcome'] !== 'invalidated' || validReason(value['invalidationReason']));
}

function isRecordForIdentity(
  record: QueueBackupPersonalRestoreRecordV2,
  identity: QueueBackupPersonalRestoreIdentityV2,
): boolean {
  return record.id === identity.recordId && record.ownerUserId === identity.ownerUserId
    && Array.isArray(record.actions) && record.actions.every(isPersistedQueuedAction)
    && typeof record.savedAt === 'string';
}

function looksLikeReceiptCollision(
  value: unknown, identity: QueueBackupPersonalRestoreIdentityV2,
): boolean {
  return isRecord(value) && value['id'] === identity.receiptId
    && (value['identityDigest'] !== identity.identityDigest
      || value['ownerUserId'] !== identity.ownerUserId
      || value['restoreRunId'] !== identity.restoreRunId
      || value['sourceDigest'] !== identity.sourceDigest
      || value['token'] !== identity.token);
}
async function hasValidIdentityFields(value: Record<string, unknown>): Promise<boolean> {
  try {
    const expected = await createQueueBackupPersonalRestoreIdentity(
      value as unknown as QueueBackupPersonalRestoreIdentityInputV2,
    );
    return Object.keys(expected).every(key => value[key] === expected[key as keyof typeof expected]);
  } catch { return false; }
}
function emptyCatalog(ownerUserId: string): QueueBackupPersonalRestoreCatalogV2 {
  return {
    id: getQueueBackupPersonalRestoreCatalogId(ownerUserId),
    kind: 'queue-backup-personal-restore-receipt-catalog', schemaVersion: 2,
    ownerUserId, receiptIds: [], receipts: {},
  };
}
function validateIdentityInput(input: QueueBackupPersonalRestoreIdentityInputV2): void {
  const values = [input.ownerUserId, input.restoreRunId, input.participant, input.sourceDigest, input.token];
  if (input.participant !== 'action-queue' || !SHA256_PATTERN.test(input.sourceDigest)
    || !values.every(validIdentityString)) throw new TypeError('Invalid personal restore identity');
}
function validIdentityString(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')
    || value.normalize('NFC') !== value || /[\ud800-\udfff]/u.test(value)) return false;
  const bytes = new TextEncoder().encode(value).byteLength;
  return bytes > 0 && bytes <= MAX_FIELD_BYTES;
}
function validUniqueActions(actions: unknown): actions is QueuedAction[] {
  if (!Array.isArray(actions) || !actions.every(isPersistedQueuedAction)) return false;
  const ids = new Set<string>();
  const operations = new Set<string>();
  return actions.every(action => {
    if (ids.has(action.id) || operations.has(action.operationId)) return false;
    ids.add(action.id); operations.add(action.operationId); return true;
  });
}
function containsExact(actions: QueuedAction[], expected: QueuedAction): boolean {
  const signature = canonicalizePersistedValue(expected);
  return actions.filter(action => canonicalizePersistedValue(action) === signature).length === 1;
}
export function preservesPreparedRestoreActionsV2(
  current: QueuedAction[], next: QueuedAction[], transition: unknown,
): boolean {
  if (!isRecord(transition) || !hasExactKeys(transition, [
    'kind', 'schemaVersion', 'state', 'id', 'preparedReceipt', 'preimage', 'restoredActions',
  ]) || transition['kind'] !== 'queue-backup-personal-restore-transition'
    || transition['schemaVersion'] !== 2 || transition['state'] !== 'prepared'
    || !isRecord(transition['preparedReceipt'])
    || transition['id'] !== transition['preparedReceipt']['identityDigest']
    || !validUniqueActions(transition['preimage']) || !validUniqueActions(transition['restoredActions'])) return false;
  const protectedActions = [...transition['preimage'], ...transition['restoredActions']];
  return validUniqueActions(current) && validUniqueActions(next) && validUniqueActions(protectedActions)
    && protectedActions.every(action => containsExact(current, action) && containsExact(next, action));
}
function sameIdentity(
  left: QueueBackupPersonalRestoreIdentityInputV2,
  right: QueueBackupPersonalRestoreIdentityInputV2,
): boolean {
  return left.ownerUserId === right.ownerUserId && left.restoreRunId === right.restoreRunId
    && left.participant === right.participant && left.sourceDigest === right.sourceDigest
    && left.token === right.token;
}
function alreadyStatus(outcome: QueueBackupPersonalRestoreTerminalReceiptV2['outcome']) {
  return outcome === 'finalized' ? 'already-finalized' as const
    : outcome === 'rolled-back' ? 'already-rolled-back' as const
      : outcome === 'invalidated' ? 'already-invalidated' as const
        : 'already-abandoned-before-prepare' as const;
}
function snapshotSignature(snapshot: QueueBackupPersonalRestoreSnapshotV2): string {
  return canonicalizePersistedValue({ record: snapshot.record, catalog: snapshot.catalog, receipt: snapshot.receipt });
}
function frameField(tag: number, value: string): Uint8Array {
  const bytes = new TextEncoder().encode(value);
  return concatBytes(Uint8Array.of(tag), u32be(bytes.byteLength), bytes);
}
function u32be(value: number): Uint8Array {
  return Uint8Array.of(value >>> 24, value >>> 16, value >>> 8, value);
}
function concatBytes(...chunks: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('Web Crypto SHA-256 is unavailable');
  const digest = await subtle.digest('SHA-256', bytes as BufferSource);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
function hasExactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === [...expected].sort()[index]);
}
function sameStringSet(left: string[], right: unknown[]): boolean {
  const expected = [...right as string[]].sort();
  return left.length === expected.length
    && [...left].sort().every((value, index) => value === expected[index]);
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function isSha256(value: unknown): value is string {
  return typeof value === 'string' && SHA256_PATTERN.test(value);
}
function isTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !TIMESTAMP_PATTERN.test(value)) return false;
  const timestamp = new Date(value);
  return !Number.isNaN(timestamp.getTime()) && timestamp.toISOString() === value;
}
function nowTimestamp(): string { return new Date().toISOString(); }
function validReason(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_FIELD_BYTES;
}
