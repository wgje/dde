import type { DataSafetyAuditLogSnapshot } from './data-safety-audit-log';
import type { DataSafetyLastWriteExplain, DataSafetyReplayEntry, LwwDecision } from './data-safety-package';

const DEFAULT_MAX_ENTRIES = 100;
const STORAGE_KEY_PREFIX = 'nanoflow.data-safety-audit';

export interface DataSafetyAuditPersistenceOptions {
  maxEntries?: number;
  storage?: Storage;
}

export class DataSafetyAuditPersistence {
  private static readonly volatileSnapshots = new Map<string, DataSafetyAuditLogSnapshot>();
  private readonly maxEntries: number;
  private readonly storage: Storage | null;
  constructor(options: DataSafetyAuditPersistenceOptions = {}) {
    this.maxEntries = Math.max(1, Math.floor(options.maxEntries ?? DEFAULT_MAX_ENTRIES));
    this.storage = options.storage ?? (typeof localStorage === 'undefined' ? null : localStorage);
  }
  load(ownerUserId: string | null | undefined): DataSafetyAuditLogSnapshot {
    const key = this.resolveKey(ownerUserId);
    if (!key) return this.emptySnapshot();
    if (!this.storage) return this.readVolatileSnapshot(key);
    try {
      const raw = this.storage.getItem(key);
      if (!raw) return this.readVolatileSnapshot(key);
      return this.normalizeSnapshot(JSON.parse(raw));
    } catch {
      return this.readVolatileSnapshot(key);
    }
  }
  loadForExport(ownerUserId: string): DataSafetyAuditLogSnapshot {
    const key = this.resolveKey(ownerUserId);
    if (!key) throw new Error('Data safety audit owner is required');
    if (!this.storage) throw new Error('Data safety audit storage is unavailable');
    const raw = this.storage.getItem(key);
    if (raw === null) {
      const volatileSnapshot = DataSafetyAuditPersistence.volatileSnapshots.get(key);
      return volatileSnapshot ? this.normalizeSnapshotForExport(volatileSnapshot) : this.emptySnapshot();
    }
    try {
      return this.normalizeSnapshotForExport(JSON.parse(raw));
    } catch {
      throw new Error('Data safety audit evidence is malformed');
    }
  }
  save(ownerUserId: string | null | undefined, snapshot: DataSafetyAuditLogSnapshot): boolean {
    const key = this.resolveKey(ownerUserId);
    if (!key) return false;
    const normalized = this.normalizeSnapshot(snapshot);
    if (!this.storage) {
      DataSafetyAuditPersistence.volatileSnapshots.set(key, cloneSnapshot(normalized));
      return false;
    }
    try {
      this.storage.setItem(key, JSON.stringify(normalized));
      DataSafetyAuditPersistence.volatileSnapshots.delete(key);
      return true;
    } catch {
      DataSafetyAuditPersistence.volatileSnapshots.set(key, cloneSnapshot(normalized));
      return false;
    }
  }
  private normalizeSnapshot(value: unknown): DataSafetyAuditLogSnapshot {
    if (!isRecord(value)) return this.emptySnapshot();
    const replayLog = Array.isArray(value['replayLog'])
      ? value['replayLog'].filter(isReplayEntry).slice(-this.maxEntries)
      : [];
    const lastWriteExplain = isLastWriteExplain(value['lastWriteExplain'])
      ? value['lastWriteExplain']
      : null;
    return { replayLog, lastWriteExplain };
  }
  private normalizeSnapshotForExport(value: unknown): DataSafetyAuditLogSnapshot {
    if (!isRecord(value)) throw new Error('Invalid audit snapshot');
    const replayLog = value['replayLog'];
    const lastWriteExplain = value['lastWriteExplain'];
    if (!Array.isArray(replayLog)
      || !replayLog.every(isStrictReplayEntry)
      || (lastWriteExplain !== null && !isStrictLastWriteExplain(lastWriteExplain))) {
      throw new Error('Invalid audit snapshot');
    }
    return cloneSnapshot({ replayLog: replayLog.slice(-this.maxEntries), lastWriteExplain });
  }
  private emptySnapshot(): DataSafetyAuditLogSnapshot { return { replayLog: [], lastWriteExplain: null }; }
  private resolveKey(ownerUserId: string | null | undefined): string | null { return ownerUserId ? `${STORAGE_KEY_PREFIX}.${ownerUserId}` : null; }
  private readVolatileSnapshot(key: string): DataSafetyAuditLogSnapshot {
    const snapshot = DataSafetyAuditPersistence.volatileSnapshots.get(key);
    return snapshot ? cloneSnapshot(snapshot) : this.emptySnapshot();
  }
}

function cloneSnapshot(snapshot: DataSafetyAuditLogSnapshot): DataSafetyAuditLogSnapshot {
  return {
    replayLog: snapshot.replayLog.map(entry => ({ ...entry })),
    lastWriteExplain: snapshot.lastWriteExplain ? { ...snapshot.lastWriteExplain } : null,
  };
}

type ValueGuard = (value: unknown) => boolean;
const TASK_WRITE_INTENTS = new Set<string>([
  'task_full_upsert', 'task_text_update', 'task_structure_update', 'task_soft_delete',
  'task_attachment_update',
]);
const LWW_DECISIONS: ReadonlySet<string> = new Set<LwwDecision>(['local-applied', 'remote-kept', 'idempotent-replay', 'blocked', 'unknown']);
const isString: ValueGuard = value => typeof value === 'string';
const isNonemptyString: ValueGuard = value => typeof value === 'string' && value.length > 0;
const isNullableString: ValueGuard = value => value === null || typeof value === 'string';
const isFiniteNumber: ValueGuard = value => typeof value === 'number' && Number.isFinite(value);
const isBoolean: ValueGuard = value => typeof value === 'boolean';

function isReplayEntry(value: unknown): value is DataSafetyReplayEntry {
  return isRecord(value)
    && hasStringFields(value, ['operationId', 'entityType', 'entityId', 'operation'])
    && typeof value['localCommittedAt'] === 'number'
    && ['queue', 'rpc', 'lww', 'lastSyncTime'].every(key => !!value[key]);
}
function isLastWriteExplain(value: unknown): value is DataSafetyLastWriteExplain {
  return isRecord(value) && hasStringFields(value, ['operationId', 'operation'])
    && typeof value['localTimestamp'] === 'number'
    && ['actor', 'entity', 'queueResult', 'rpcResult', 'lwwDecision', 'lastSyncTime']
      .every(key => !!value[key]);
}
function isStrictReplayEntry(value: unknown): value is DataSafetyReplayEntry { return isRecord(value) && isReplayEntry(value) && hasStrictAuditEvidence(value, true); }
function isStrictLastWriteExplain(value: unknown): value is DataSafetyLastWriteExplain { return isRecord(value) && isLastWriteExplain(value) && hasStrictAuditEvidence(value, false); }

function hasStrictAuditEvidence(value: Record<string, unknown>, replay: boolean): boolean {
  const queue = value[replay ? 'queue' : 'queueResult'];
  const rpc = value[replay ? 'rpc' : 'rpcResult'];
  const lww = value[replay ? 'lww' : 'lwwDecision'];
  const sync = value['lastSyncTime'];
  const fields = replay
    ? ['operationId', 'entityType', 'entityId', 'operation']
    : ['operationId', 'operation'];
  const checks = [
    () => hasStringFields(value, fields, true),
    () => isFiniteNumber(value[replay ? 'localCommittedAt' : 'localTimestamp']),
    () => isQueueResult(queue), () => isRpcSnapshot(rpc),
    () => isRecord(lww) && hasStringFields(lww, ['reason'], true)
      && typeof lww['decision'] === 'string' && LWW_DECISIONS.has(lww['decision']),
    () => isSyncEffect(sync),
    () => replay || (isRecord(value['actor']) && isRecord(value['entity'])
      && hasStringFields(value['entity'], ['type', 'id'], true)),
    () => hasValidOptionalEvidence(value, replay),
  ];
  return checks.every(check => check());
}
function hasValidOptionalEvidence(value: Record<string, unknown>, replay: boolean): boolean {
  const actor = value['actor'];
  const common = optionalFields(value, ['writeIntent'], isWriteIntent)
    && (value['conflict'] === undefined || isConflict(value['conflict']));
  if (replay) {
    return common && optionalFields(value, ['sourceUserId'], isNonemptyString)
      && optionalFields(value, ['baseUpdatedAt'], isNullableString);
  }
  return common && isRecord(actor) && optionalFields(actor, ['sourceUserId'], isNonemptyString)
    && optionalFields(value, ['updatedAtBaseline', 'beforeVersion', 'afterVersion'], isNullableString);
}
function isQueueResult(value: unknown): boolean {
  return isRecord(value) && typeof value['enteredRetryQueue'] === 'boolean'
    && Number.isInteger(value['retryCount']) && (value['retryCount'] as number) >= 0
    && optionalFields(value, ['deadLettered'], isBoolean);
}
function isRpcSnapshot(value: unknown): boolean {
  return isRecord(value) && hasStringFields(value, ['status'], true)
    && optionalFields(value, ['reason', 'decision', 'remoteUpdatedAt', 'serverUpdatedAt', 'entityId'], isString)
    && optionalFields(value, ['operationId', 'quarantineId', 'auditId', 'payloadDigest',
      'existingPayloadDigest', 'replayPayloadDigest'], isNullableString)
    && optionalFields(value, ['changedFields', 'attachmentPaths', 'skippedIds'], isStringArray)
    && optionalFields(value, ['originUnverified', 'stalePayload'], isBoolean)
    && optionalFields(value, ['minProtocolVersion', 'affectedCount'], isFiniteNumber);
}
function isSyncEffect(value: unknown): boolean {
  return isRecord(value) && typeof value['advanced'] === 'boolean'
    && isNullableString(value['before']) && isNullableString(value['after']);
}
function isConflict(value: unknown): boolean {
  return isRecord(value) && value['status'] === 'conflict-detected'
    && typeof value['reason'] === 'string' && Object.hasOwn(value, 'localSnapshot');
}
function isRecord(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function hasStringFields(record: Record<string, unknown>, keys: string[], nonempty = false): boolean {
  return keys.every(key => typeof record[key] === 'string' && (!nonempty || record[key] !== ''));
}

function optionalFields(record: Record<string, unknown>, keys: string[], guard: ValueGuard): boolean {
  return keys.every(key => record[key] === undefined || guard(record[key]));
}
const isStringArray: ValueGuard = value => Array.isArray(value) && value.every(item => typeof item === 'string');
const isWriteIntent: ValueGuard = value => typeof value === 'string' && TASK_WRITE_INTENTS.has(value);
