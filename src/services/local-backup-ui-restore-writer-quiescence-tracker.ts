import { createSyncOperationId } from '../utils/sync-operation-id';
import type {
  QueueBackupPersonalRestoreIdentityV2,
  QueueBackupPersonalRestoreTerminalReceiptV2,
} from './action-queue.types';
import { canonicalizePersistedValue } from './action-queue-identity.helpers';
import type {
  LocalBackupUiRestoreJournal,
  LocalBackupUiRestoreMarkerHeartbeat,
} from './local-backup-ui-restore-journal';
import {
  LocalBackupUiRestoreOwnershipLostError,
  type LocalBackupUiRestoreFinalOutcome,
} from './local-backup-ui-restore-stage-protocol';
import type { PreparedLocalBackupUiRestoreWriterQuiescence } from './local-backup-ui-restore-writer-quiescence.service';
import type { QueueBackupRestoreProviderResult } from './queue-backup-restore-provider.helpers';
import type { QueueBackupService } from './queue-backup.service';

const QUIESCENCE_SENTINEL_PREFIX = 'nanoflow.local-backup-ui-restore-quiescence';
const ACTIVE_WRITER_PREFIX = 'nanoflow.local-backup-ui-writer-active';
const ACTIVE_WRITER_SCHEMA_VERSION = 1;
const DEFAULT_LEASE_MS = 15_000;
const nativeRandomUuid = typeof globalThis.crypto?.randomUUID === 'function'
  ? globalThis.crypto.randomUUID.bind(globalThis.crypto)
  : null;

export type LocalBackupUiRestoreWriterSource =
  | 'action-queue'
  | 'attachment-outbox'
  | 'conflicts'
  | 'retry-queue'
  | 'external-source'
  | 'dock-snapshot'
  | 'launch-snapshot'
  | 'parked-task-cache'
  | 'black-box';

export interface LocalBackupUiRestoreWriterIdentity {
  schemaVersion: typeof ACTIVE_WRITER_SCHEMA_VERSION;
  ownerUserId: string;
  runId: string;
  source: LocalBackupUiRestoreWriterSource;
  startedAt: string;
  leaseExpiresAt: string;
}

export interface LocalBackupUiRestoreWriterHandle {
  identity(): LocalBackupUiRestoreWriterIdentity;
  renew(): void;
  release(): void;
}

export type LocalBackupUiRestoreQueueBackupPort = Pick<QueueBackupService,
  'applyPersonalBackupRestoreTransitionV2'
  | 'readPersonalRestoreIdentityState'
  | 'abandonPersonalRestoreBeforePrepare'
  | 'readPersonalRestoreProviderEvidence'>;

export interface LocalBackupUiRestoreTerminalState {
  closed: boolean;
  markerHeartbeat: LocalBackupUiRestoreMarkerHeartbeat;
}

export interface LocalBackupUiRestoreTerminalContext {
  state: LocalBackupUiRestoreTerminalState;
  quiescence: PreparedLocalBackupUiRestoreWriterQuiescence;
  journal: LocalBackupUiRestoreJournal;
  queueBackup: LocalBackupUiRestoreQueueBackupPort;
  verifyOwnership(): Promise<boolean>;
}

interface LocalBackupUiRestoreWriterTrackerOptions {
  leaseMs?: number;
  allowContinuationOfActiveWriter?: boolean;
  heartbeat?: boolean;
}

const localActiveWriters = new Map<string, LocalBackupUiRestoreWriterIdentity>();
const preparedWriterAuthorizations = new Set<string>();

export class LocalBackupUiRestoreWriterPausedError extends Error {
  constructor(ownerUserId: string) {
    super(`local backup UI restore has paused writers for owner ${ownerUserId}`);
    this.name = 'LocalBackupUiRestoreWriterPausedError';
  }
}

export function getLocalBackupUiRestoreQuiescenceSentinelStorageKey(
  ownerUserId: string,
): string {
  return `${QUIESCENCE_SENTINEL_PREFIX}.${ownerUserId}`;
}

export function beginLocalBackupUiRestoreWriter(
  ownerUserId: string,
  source: LocalBackupUiRestoreWriterSource,
  options: LocalBackupUiRestoreWriterTrackerOptions = {},
): LocalBackupUiRestoreWriterHandle {
  assertOwner(ownerUserId);
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  const continuationAllowed = options.allowContinuationOfActiveWriter === true
    && hasLocalActiveWriter(ownerUserId, source);
  const lease = new LocalBackupUiRestoreWriterLease(ownerUserId, source, leaseMs);
  lease.claim(continuationAllowed);
  lease.startHeartbeat(options.heartbeat !== false);
  return lease.toHandle();
}

export function runWithLocalBackupUiRestoreWriterAuthorization<T>(
  ownerUserId: string,
  restoreRunId: string,
  source: LocalBackupUiRestoreWriterSource,
  write: () => T,
): T {
  assertOwner(ownerUserId);
  const sentinel = readQuiescenceSentinel(ownerUserId);
  if (!sentinel || sentinel.runId !== restoreRunId || sentinel.state !== 'quiesced') {
    throw new LocalBackupUiRestoreWriterPausedError(ownerUserId);
  }
  const key = preparedAuthorizationKey(ownerUserId, restoreRunId, source);
  if (preparedWriterAuthorizations.has(key)) {
    throw new Error('local backup UI restore writer authorization is already active');
  }
  preparedWriterAuthorizations.add(key);
  try {
    return write();
  } finally {
    preparedWriterAuthorizations.delete(key);
  }
}

class LocalBackupUiRestoreWriterLease {
  private readonly runId = nativeRandomUuid?.() ?? createSyncOperationId();
  private readonly key: string;
  private readonly startedAt = new Date().toISOString();
  private current: LocalBackupUiRestoreWriterIdentity;
  private released = false;
  private ownershipLost = false;
  private heartbeat: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly ownerUserId: string,
    private readonly source: LocalBackupUiRestoreWriterSource,
    private readonly leaseMs: number,
  ) {
    this.key = activeWriterStorageKey(ownerUserId, this.runId);
    this.current = buildIdentity(ownerUserId, this.runId, source, this.startedAt, leaseMs);
  }

  claim(continuationAllowed: boolean): void {
    this.persist();
    try {
      assertWriterMayContinue(this.ownerUserId, this.source, continuationAllowed);
    } catch (error) {
      releaseOwnedRecord(this.key, this.current);
      localActiveWriters.delete(this.key);
      throw error;
    }
  }

  startHeartbeat(enabled: boolean): void {
    if (!enabled) return;
    this.heartbeat = setInterval(() => {
      if (this.released || this.ownershipLost) return;
      try {
        this.persist();
      } catch {
        this.ownershipLost = true;
      }
    }, Math.max(1, Math.floor(this.leaseMs / 3)));
  }

  toHandle(): LocalBackupUiRestoreWriterHandle {
    return {
      identity: () => ({ ...this.current }),
      renew: () => this.renew(),
      release: () => this.release(),
    };
  }

  private persist(): void {
    const storage = requireLocalStorage();
    const next = buildIdentity(
      this.ownerUserId, this.runId, this.source, this.startedAt, this.leaseMs,
    );
    storage.setItem(this.key, JSON.stringify(next));
    const readBack = parseActiveWriter(storage.getItem(this.key));
    if (!readBack || !hasSameIdentity(readBack, next)) {
      this.ownershipLost = true;
      throw new Error('local backup UI restore writer ownership lost');
    }
    this.current = next;
    localActiveWriters.set(this.key, next);
  }

  private renew(): void {
    if (this.released || this.ownershipLost) {
      throw new Error('local backup UI restore writer ownership lost');
    }
    this.persist();
  }

  private release(): void {
    if (this.released) return;
    if (this.heartbeat !== null) clearInterval(this.heartbeat);
    if (this.ownershipLost || !releaseOwnedRecord(this.key, this.current)) {
      this.ownershipLost = true;
      throw new Error('local backup UI restore writer ownership lost');
    }
    this.released = true;
    localActiveWriters.delete(this.key);
  }
}

export function runLocalBackupUiRestoreWriterContinuationSync<T>(
  ownerUserId: string,
  source: LocalBackupUiRestoreWriterSource,
  write: () => T,
): T {
  const handle = beginLocalBackupUiRestoreWriter(ownerUserId, source, {
    allowContinuationOfActiveWriter: true,
    heartbeat: false,
  });
  try {
    return write();
  } finally {
    handle.release();
  }
}

export function beginLocalBackupUiRestoreWriterContinuation(
  ownerUserId: string,
  source: LocalBackupUiRestoreWriterSource,
): LocalBackupUiRestoreWriterHandle {
  return beginLocalBackupUiRestoreWriter(ownerUserId, source, {
    allowContinuationOfActiveWriter: true,
  });
}

export function trackLocalBackupUiRestoreWriterPromise<T>(
  ownerUserId: string,
  source: LocalBackupUiRestoreWriterSource,
  start: () => Promise<T>,
  options: { continuation?: boolean } = {},
): Promise<T> {
  const handle = beginLocalBackupUiRestoreWriter(ownerUserId, source, {
    allowContinuationOfActiveWriter: options.continuation === true,
  });
  let promise: Promise<T>;
  try {
    promise = start();
  } catch (error) {
    handle.release();
    throw error;
  }
  return promise.finally(() => handle.release());
}

export function readActiveLocalBackupUiRestoreWriters(
  ownerUserId: string,
): LocalBackupUiRestoreWriterIdentity[] {
  assertOwner(ownerUserId);
  const storage = requireLocalStorage();
  const prefix = `${ACTIVE_WRITER_PREFIX}.${encodeURIComponent(ownerUserId)}.`;
  const records: LocalBackupUiRestoreWriterIdentity[] = [];
  for (let index = storage.length - 1; index >= 0; index -= 1) {
    const key = storage.key(index);
    if (!key?.startsWith(prefix)) continue;
    const record = parseActiveWriter(storage.getItem(key));
    if (!record || record.ownerUserId !== ownerUserId || key !== activeWriterStorageKey(ownerUserId, record.runId)) {
      throw new Error('local backup UI restore active writer record failed schema validation');
    }
    const local = localActiveWriters.get(key);
    if (local && !hasSameIdentity(local, record)) {
      throw new Error('local backup UI restore active writer ownership lost');
    }
    if (Date.parse(record.leaseExpiresAt) <= Date.now() && !local) {
      storage.removeItem(key);
      continue;
    }
    records.push(local ?? record);
  }
  for (const [key, record] of localActiveWriters) {
    if (record.ownerUserId === ownerUserId && !records.some(candidate => candidate.runId === record.runId)) {
      if (storage.getItem(key) === null) throw new Error('local backup UI restore active writer ownership lost');
      records.push(record);
    }
  }
  return records;
}

function assertWriterMayContinue(
  ownerUserId: string,
  source: LocalBackupUiRestoreWriterSource,
  continuationAllowed: boolean,
): void {
  const sentinel = readQuiescenceSentinel(ownerUserId);
  if (sentinel !== null
    && !continuationAllowed
    && !hasPreparedWriterAuthorization(ownerUserId, sentinel.runId, source)) {
    throw new LocalBackupUiRestoreWriterPausedError(ownerUserId);
  }
}

function hasPreparedWriterAuthorization(
  ownerUserId: string,
  restoreRunId: string,
  source: LocalBackupUiRestoreWriterSource,
): boolean {
  return preparedWriterAuthorizations.has(
    preparedAuthorizationKey(ownerUserId, restoreRunId, source),
  );
}

function preparedAuthorizationKey(
  ownerUserId: string,
  restoreRunId: string,
  source: LocalBackupUiRestoreWriterSource,
): string {
  return `${ownerUserId}\u0000${restoreRunId}\u0000${source}`;
}

function readQuiescenceSentinel(
  ownerUserId: string,
): { ownerUserId: string; runId: string; state: string } | null {
  const raw = requireLocalStorage().getItem(
    getLocalBackupUiRestoreQuiescenceSentinelStorageKey(ownerUserId),
  );
  if (raw === null) return null;
  const value = parseJsonObject(raw);
  if (!value
    || value['ownerUserId'] !== ownerUserId
    || !isNonEmptyString(value['runId'])
    || !isNonEmptyString(value['state'])) {
    return { ownerUserId, runId: '', state: 'malformed' };
  }
  return {
    ownerUserId,
    runId: value['runId'],
    state: value['state'],
  };
}

function hasLocalActiveWriter(
  ownerUserId: string,
  source: LocalBackupUiRestoreWriterSource,
): boolean {
  return Array.from(localActiveWriters.values()).some(
    writer => writer.ownerUserId === ownerUserId && writer.source === source,
  );
}

function buildIdentity(
  ownerUserId: string,
  runId: string,
  source: LocalBackupUiRestoreWriterSource,
  startedAt: string,
  leaseMs: number,
): LocalBackupUiRestoreWriterIdentity {
  return {
    schemaVersion: ACTIVE_WRITER_SCHEMA_VERSION,
    ownerUserId,
    runId,
    source,
    startedAt,
    leaseExpiresAt: new Date(Date.now() + leaseMs).toISOString(),
  };
}

function activeWriterStorageKey(ownerUserId: string, runId: string): string {
  return `${ACTIVE_WRITER_PREFIX}.${encodeURIComponent(ownerUserId)}.${runId}`;
}

function releaseOwnedRecord(
  key: string,
  expected: LocalBackupUiRestoreWriterIdentity,
): boolean {
  const storage = requireLocalStorage();
  const current = parseActiveWriter(storage.getItem(key));
  if (!current || !hasSameIdentity(current, expected)) return false;
  storage.removeItem(key);
  return storage.getItem(key) === null;
}

function parseActiveWriter(raw: string | null): LocalBackupUiRestoreWriterIdentity | null {
  if (!raw) return null;
  const value = parseJsonObject(raw);
  if (!value || Object.keys(value).sort().join(',')
    !== 'leaseExpiresAt,ownerUserId,runId,schemaVersion,source,startedAt') return null;
  if (value['schemaVersion'] !== ACTIVE_WRITER_SCHEMA_VERSION
    || !isNonEmptyString(value['ownerUserId'])
    || !isNonEmptyString(value['runId'])
    || !isWriterSource(value['source'])
    || !isIsoTimestamp(value['startedAt'])
    || !isIsoTimestamp(value['leaseExpiresAt'])) return null;
  return value as unknown as LocalBackupUiRestoreWriterIdentity;
}

function parseJsonObject(raw: string): Record<string, unknown> | null {
  let value: unknown = null;
  try {
    value = JSON.parse(raw);
  } catch {
    value = null;
  }
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function hasSameIdentity(
  left: LocalBackupUiRestoreWriterIdentity,
  right: LocalBackupUiRestoreWriterIdentity,
): boolean {
  return left.ownerUserId === right.ownerUserId
    && left.runId === right.runId
    && left.source === right.source
    && left.startedAt === right.startedAt;
}

export function isExactActiveQueueBackupState(
  state: Awaited<ReturnType<LocalBackupUiRestoreQueueBackupPort['readPersonalRestoreIdentityState']>>,
  identity: QueueBackupPersonalRestoreIdentityV2,
): boolean {
  if (state.status !== 'active') return false;
  const prepared = state.transition.preparedReceipt;
  return prepared.ownerUserId === identity.ownerUserId
    && prepared.restoreRunId === identity.restoreRunId
    && prepared.participant === identity.participant
    && prepared.sourceDigest === identity.sourceDigest
    && prepared.token === identity.token
    && prepared.recordId === identity.recordId
    && prepared.identityDigest === identity.identityDigest
    && prepared.receiptId === identity.receiptId;
}

export async function settleAndVerifyLocalBackupUiRestoreQueueBackup(
  identity: QueueBackupPersonalRestoreIdentityV2,
  ownerUserId: string,
  queueBackup: LocalBackupUiRestoreQueueBackupPort,
  expectedOutcome: 'finalized' | 'rolled-back',
): Promise<VerifiedQueueBackupTerminal> {
  const state = await queueBackup.readPersonalRestoreIdentityState(identity, ownerUserId);
  if (state.status === 'absent-for-identity') {
    await queueBackup.abandonPersonalRestoreBeforePrepare({
      kind: 'abandon-before-prepare',
      identity,
      absenceProof: state.absenceProof,
    }, ownerUserId);
  } else if (state.status === 'active') {
    await queueBackup.applyPersonalBackupRestoreTransitionV2({
      kind: expectedOutcome === 'finalized' ? 'finalize' : 'rollback',
      identity,
    }, ownerUserId);
  } else if (state.status !== 'terminal') {
    throw new Error('local backup UI restore queue terminal state is unknown');
  }
  const evidence = await queueBackup.readPersonalRestoreProviderEvidence(identity, ownerUserId);
  return requireExactQueueBackupTerminal(evidence, identity, expectedOutcome);
}

export async function finalizeLocalBackupUiRestoreTerminal(
  context: LocalBackupUiRestoreTerminalContext,
  outcome: LocalBackupUiRestoreFinalOutcome,
): Promise<void> {
  try {
    if (!await context.verifyOwnership()) throw new LocalBackupUiRestoreOwnershipLostError();
    await context.quiescence.prepareFinalization(outcome);
    if (!await context.state.markerHeartbeat.verifyOwnership()) {
      throw new LocalBackupUiRestoreOwnershipLostError();
    }
    const marker = context.state.markerHeartbeat.marker();
    const terminal = await settleAndVerifyLocalBackupUiRestoreQueueBackup(
      marker.actionQueueRestoreIdentity,
      marker.ownerUserId,
      context.queueBackup,
      outcome === 'completed' ? 'finalized' : 'rolled-back',
    );
    await context.state.markerHeartbeat.stop();
    await verifyQueueBackupTerminalReadback(
      marker.actionQueueRestoreIdentity,
      marker.ownerUserId,
      context.queueBackup,
      terminal,
    );
    if (!await context.journal.clear(marker)) {
      throw new LocalBackupUiRestoreOwnershipLostError('restore marker final clear failed');
    }
    if (await context.journal.read() !== null) {
      throw new LocalBackupUiRestoreOwnershipLostError('restore marker final absence read-back failed');
    }
    await context.quiescence.releaseFinalized();
    context.state.closed = true;
  } catch (error) {
    await retainLocalBackupUiRestoreEvidenceForStartup(context, error);
    throw error;
  }
}

export async function abortLocalBackupUiRestoreTerminal(
  context: LocalBackupUiRestoreTerminalContext,
): Promise<void> {
  try {
    if (!await context.verifyOwnership()) {
      throw new Error('local backup UI restore prepared transaction ownership lost');
    }
    const marker = context.state.markerHeartbeat.marker();
    const terminal = await settleAndVerifyLocalBackupUiRestoreQueueBackup(
      marker.actionQueueRestoreIdentity,
      marker.ownerUserId,
      context.queueBackup,
      'rolled-back',
    );
    await context.state.markerHeartbeat.stop();
    await verifyQueueBackupTerminalReadback(
      marker.actionQueueRestoreIdentity,
      marker.ownerUserId,
      context.queueBackup,
      terminal,
    );
    if (!await context.journal.clear(marker)) {
      throw new Error('local backup UI restore prepared marker clear failed');
    }
    if (await context.journal.read() !== null) {
      throw new Error('local backup UI restore prepared marker absence read-back failed');
    }
    await context.quiescence.abortBeforeMutation();
    context.state.closed = true;
  } catch (error) {
    await retainLocalBackupUiRestoreEvidenceForStartup(context, error);
    throw error;
  }
}

async function retainLocalBackupUiRestoreEvidenceForStartup(
  context: LocalBackupUiRestoreTerminalContext,
  cause: unknown,
): Promise<void> {
  const cleanupErrors: unknown[] = [];
  try {
    await context.state.markerHeartbeat.stop();
  } catch (error) {
    cleanupErrors.push(error);
  }
  try {
    await context.quiescence.deferForStartupRecovery();
  } catch (error) {
    cleanupErrors.push(error);
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(
      [cause, ...cleanupErrors],
      'local backup UI restore evidence could not be handed off to startup recovery',
    );
  }
}

interface VerifiedQueueBackupTerminal {
  outcome: QueueBackupPersonalRestoreTerminalReceiptV2['outcome'];
  receiptSignature: string;
  resultDigest: string;
  snapshotSignature: string;
}

async function verifyQueueBackupTerminalReadback(
  identity: QueueBackupPersonalRestoreIdentityV2,
  ownerUserId: string,
  queueBackup: LocalBackupUiRestoreQueueBackupPort,
  expected: VerifiedQueueBackupTerminal,
): Promise<void> {
  const evidence = await queueBackup.readPersonalRestoreProviderEvidence(identity, ownerUserId);
  const readBack = requireExactQueueBackupTerminal(evidence, identity, expected.outcome);
  if (readBack.receiptSignature !== expected.receiptSignature
    || readBack.resultDigest !== expected.resultDigest
    || readBack.snapshotSignature !== expected.snapshotSignature) {
    throw new Error('local backup UI restore queue terminal evidence changed');
  }
}

function requireExactQueueBackupTerminal(
  evidence: QueueBackupRestoreProviderResult,
  identity: QueueBackupPersonalRestoreIdentityV2,
  expectedOutcome: QueueBackupPersonalRestoreTerminalReceiptV2['outcome'],
): VerifiedQueueBackupTerminal {
  if (evidence.status !== 'READABLE' || evidence.storage !== 'READBACK_CONFIRMED'
    || evidence.snapshotSignature === null
    || !sameCanonicalValue(evidence.identity, identity)
    || evidence.catalog.status !== 'PRESENT_VALID'
    || evidence.receipt.status !== 'PRESENT_VALID'
    || evidence.terminal.status !== 'TERMINAL_CONFIRMED') {
    throw new Error('local backup UI restore queue terminal evidence is not authoritative');
  }
  const receipt = evidence.terminal.receipt;
  const catalogReceipt = evidence.catalog.value.receipts[identity.receiptId];
  if (receipt.outcome !== expectedOutcome
    && !(expectedOutcome === 'rolled-back' && receipt.outcome === 'abandoned-before-prepare')) {
    throw new Error('local backup UI restore queue terminal outcome mismatch');
  }
  if (!sameCanonicalValue(receipt, evidence.receipt.value)
    || !sameCanonicalValue(receipt, catalogReceipt)
    || !sameCanonicalValue(captureReceiptIdentity(receipt), identity)
    || evidence.terminal.resultDigest !== receipt.resultDigest) {
    throw new Error('local backup UI restore queue terminal receipt mismatch');
  }
  return {
    outcome: receipt.outcome,
    receiptSignature: canonicalizePersistedValue(receipt),
    resultDigest: receipt.resultDigest,
    snapshotSignature: evidence.snapshotSignature,
  };
}

function captureReceiptIdentity(
  receipt: QueueBackupPersonalRestoreTerminalReceiptV2,
): QueueBackupPersonalRestoreIdentityV2 {
  return {
    ownerUserId: receipt.ownerUserId,
    restoreRunId: receipt.restoreRunId,
    participant: receipt.participant,
    sourceDigest: receipt.sourceDigest,
    token: receipt.token,
    recordId: receipt.recordId,
    identityDigest: receipt.identityDigest,
    receiptId: receipt.receiptId,
  };
}

function sameCanonicalValue(left: unknown, right: unknown): boolean {
  try {
    return canonicalizePersistedValue(left) === canonicalizePersistedValue(right);
  } catch {
    return false;
  }
}

function requireLocalStorage(): Storage {
  if (typeof localStorage === 'undefined') {
    throw new Error('local backup UI restore writer tracking requires localStorage');
  }
  return localStorage;
}

function assertOwner(ownerUserId: string): void {
  if (!isNonEmptyString(ownerUserId)) throw new Error('local backup UI restore owner is required');
}

function isWriterSource(value: unknown): value is LocalBackupUiRestoreWriterSource {
  return value === 'action-queue'
    || value === 'attachment-outbox'
    || value === 'conflicts'
    || value === 'retry-queue'
    || value === 'external-source'
    || value === 'dock-snapshot'
    || value === 'launch-snapshot'
    || value === 'parked-task-cache'
    || value === 'black-box';
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}
