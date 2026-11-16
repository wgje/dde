import {
  buildDataSafetyExportPackage,
  type DataSafetyEntityRecord,
  type DataSafetyExportPackage,
  type DataSafetyLastWriteExplain,
  type DataSafetyLocalDataSnapshot,
  type DataSafetyLocalStateSnapshot,
  type DataSafetyReplayEntry,
  type DataSafetySyncSnapshot,
  type DataSafetyAppSnapshot,
} from '../data-safety-package';
import {
  createOfflineCommandStore,
  type OfflineCommandStore,
  type OfflineCommandRecord,
  OfflineCommandStoreExport,
  OfflineConflictEvidenceRecord,
  OfflineProjectionRecord,
  OfflineAuditRecord,
} from './offline-command-store';
import type {
  OfflineSyncCommandEnvelope,
  OfflineSyncCommandStatus,
} from './offline-sync-command-envelope';

const OFFLINE_COMMAND_STORE_META_KEY = 'offlineCommandStore';

type JsonRecord = Record<string, unknown>;

export interface BuildOfflineCommandDataSafetyPackageInput<TProjection = unknown> {
  readonly storeExport: OfflineCommandStoreExport<OfflineSyncCommandEnvelope, TProjection>;
  readonly exportedAt: string;
  readonly ownerUserId: string;
  readonly app: DataSafetyAppSnapshot;
  readonly syncSnapshot: DataSafetySyncSnapshot;
  readonly localData?: DataSafetyLocalDataSnapshot;
  readonly localState?: Partial<DataSafetyLocalStateSnapshot>;
  readonly replayLog?: DataSafetyReplayEntry[];
  readonly lastWriteExplain?: DataSafetyLastWriteExplain | null;
}

export function buildOfflineCommandDataSafetyPackage<TProjection = unknown>(
  input: BuildOfflineCommandDataSafetyPackageInput<TProjection>,
): DataSafetyExportPackage {
  assertStoreOwner(input.storeExport, input.ownerUserId);
  const localData = mergeProjectionData(input.localData, input.storeExport.projections, input.storeExport);
  const localState = mergeLocalState(input.localState, input.storeExport);
  const replayLog = [
    ...(input.replayLog ?? []),
    ...buildCommandReplayEntries(input.storeExport.commands),
    ...buildAuditReplayEntries(input.storeExport.audits, input.storeExport.commands),
    ...buildConflictReplayEntries(input.storeExport.conflictEvidence ?? []),
  ];

  return buildDataSafetyExportPackage({
    exportedAt: input.exportedAt,
    ownerUserId: input.ownerUserId,
    app: input.app,
    localData,
    localState,
    syncSnapshot: input.syncSnapshot,
    replayLog,
    lastWriteExplain: input.lastWriteExplain,
  });
}

/**
 * Recover the complete command-store payload without asking the legacy restore
 * adapter to understand the new stores. The caller can feed this payload back
 * into OfflineCommandStore after the primary package restore succeeds.
 */
export function hasEmbeddedOfflineCommandStoreExport(pkg: DataSafetyExportPackage): boolean {
  const localData = pkg?.localData;
  if (!isRecord(localData)) return false;
  const meta = isRecord(localData.meta) ? localData.meta : null;
  return meta !== null && Object.prototype.hasOwnProperty.call(meta, OFFLINE_COMMAND_STORE_META_KEY);
}

export async function restoreOfflineCommandStoreFromPackage(
  pkg: DataSafetyExportPackage,
  store: OfflineCommandStore = createOfflineCommandStore(),
): Promise<boolean> {
  const payload = extractOfflineCommandStoreExportForRestore(pkg);
  if (!payload) {
    if (hasEmbeddedOfflineCommandStoreExport(pkg)) {
      throw new Error('Embedded offline command store export is malformed or owner-mismatched');
    }
    return false;
  }
  await store.restoreOwner(payload);
  return true;
}

export function extractOfflineCommandStoreExportForRestore(
  pkg: DataSafetyExportPackage,
): OfflineCommandStoreExport<OfflineSyncCommandEnvelope, unknown> | null {
  const localData = pkg?.localData;
  if (!isRecord(localData)) return null;
  const meta = isRecord(localData.meta) ? localData.meta : null;
  const value = meta?.[OFFLINE_COMMAND_STORE_META_KEY];
  if (!isRecord(value) || value.schemaVersion !== 1) return null;
  if (value.ownerUserId !== pkg.ownerUserId) return null;
  if (!Array.isArray(value.projections)
    || !Array.isArray(value.commands)
    || !Array.isArray(value.audits)
    || !Array.isArray(value.quarantine)
    || (value.conflictEvidence !== undefined && !Array.isArray(value.conflictEvidence))) {
    return null;
  }
  return {
    ...(value as unknown as OfflineCommandStoreExport<OfflineSyncCommandEnvelope, unknown>),
    ...(Array.isArray(value.conflictEvidence)
      ? { conflictEvidence: value.conflictEvidence as OfflineConflictEvidenceRecord[] }
      : {}),
  };
}

function assertStoreOwner<TProjection>(
  storeExport: OfflineCommandStoreExport<OfflineSyncCommandEnvelope, TProjection>,
  ownerUserId: string,
): void {
  if (storeExport.ownerUserId !== ownerUserId) {
    throw new Error('Offline command data-safety owner mismatch');
  }
  const businessRecords = [
    ...storeExport.projections,
    ...storeExport.commands,
    ...storeExport.audits,
    ...(storeExport.conflictEvidence ?? []),
  ];
  if (businessRecords.some(record => record.ownerUserId !== ownerUserId)) {
    throw new Error('Offline command data-safety record owner mismatch');
  }
  if (storeExport.quarantine.some(record => record.ownerUserId !== null
    && record.ownerUserId !== ownerUserId)) {
    throw new Error('Offline command data-safety quarantine owner mismatch');
  }
}

function mergeProjectionData<TProjection>(
  existing: DataSafetyLocalDataSnapshot | undefined,
  projections: readonly OfflineProjectionRecord<TProjection>[],
  storeExport: OfflineCommandStoreExport<OfflineSyncCommandEnvelope, TProjection>,
): DataSafetyLocalDataSnapshot {
  const base: DataSafetyLocalDataSnapshot = existing ?? {
    projects: [],
    tasks: [],
    connections: [],
    syncCursors: [],
  };
  const byType = new Map<string, DataSafetyEntityRecord[]>();
  byType.set('project', [...base.projects]);
  byType.set('task', [...base.tasks]);
  byType.set('connection', [...base.connections]);

  for (const projection of projections) {
    const bucket = byType.get(projection.entityType);
    if (!bucket) continue;
    const entity = toEntityRecord(projection);
    const index = bucket.findIndex(item => item.id === entity.id);
    if (index >= 0) bucket[index] = entity;
    else bucket.push(entity);
  }

  const existingMeta = isRecord(base.meta) ? base.meta : { legacyMeta: base.meta };
  return {
    ...base,
    projects: byType.get('project') ?? [],
    tasks: byType.get('task') ?? [],
    connections: byType.get('connection') ?? [],
    meta: { ...existingMeta, [OFFLINE_COMMAND_STORE_META_KEY]: storeExport },
  };
}

function toEntityRecord<TProjection>(
  projection: OfflineProjectionRecord<TProjection>,
): DataSafetyEntityRecord {
  const value: JsonRecord = isRecord(projection.value)
    ? { ...projection.value }
    : { value: projection.value as unknown };
  return {
    ...value,
    id: typeof value.id === 'string' ? value.id : projection.entityId,
    updatedAt: projection.updatedAt,
    ...(projection.tombstone ? { deleted: true } : {}),
  } as DataSafetyEntityRecord;
}

function mergeLocalState<TProjection>(
  existing: Partial<DataSafetyLocalStateSnapshot> | undefined,
  storeExport: OfflineCommandStoreExport<OfflineSyncCommandEnvelope, TProjection>,
): DataSafetyLocalStateSnapshot {
  const pendingCommands = storeExport.commands.filter(command => isReplayPending(command.status));
  const retryQueue = [
    ...(existing?.retryQueue ?? []),
    ...pendingCommands.map(toRetryQueueItem),
  ];
  // Keep the legacy conflict restore contract strict: quarantine and the new
  // command-store evidence are carried in meta/replayLog, not masqueraded as
  // legacy ConflictRecord values.
  const conflicts = [...(existing?.conflicts ?? [])];
  return {
    retryQueue,
    legacyRetryReview: existing?.legacyRetryReview ?? [],
    actionQueue: existing?.actionQueue ?? [],
    deadLetters: existing?.deadLetters ?? [],
    conflicts,
    taskTombstones: existing?.taskTombstones ?? [],
    connectionTombstones: existing?.connectionTombstones ?? [],
    offlineSnapshots: existing?.offlineSnapshots ?? null,
  };
}

function isReplayPending(status: OfflineSyncCommandStatus): boolean {
  return status === 'pending' || status === 'sent' || status === 'unknown' || status === 'rejected';
}

function toRetryQueueItem(command: OfflineCommandRecord<OfflineSyncCommandEnvelope>) {
  const payload: JsonRecord = {
    ...command.command.normalizedResultPatch,
    id: command.entityId,
  };
  return {
    id: command.operationId,
    operationId: command.operationId,
    type: command.entityType,
    operation: command.command.command,
    data: payload,
    retryCount: 0,
    createdAt: parseTimestamp(command.createdAt),
    sourceUserId: command.ownerUserId,
    ...(command.command.projectId ? { projectId: command.command.projectId } : {}),
  };
}

function buildCommandReplayEntries(
  commands: readonly OfflineCommandRecord<OfflineSyncCommandEnvelope>[],
): DataSafetyReplayEntry[] {
  return commands
    .filter(command => !isReplayPending(command.command.status))
    .map(command => {
      const envelope = command.command;
      const status = envelope.remoteResult?.decision ?? envelope.status;
      return {
        operationId: envelope.operationId,
        entityType: toDataSafetyEntityType(envelope.entityType),
        entityId: envelope.entityId,
        operation: envelope.command,
        sourceUserId: envelope.ownerUserId,
        localCommittedAt: parseTimestamp(envelope.createdAtIso),
        baseUpdatedAt: envelope.baseUpdatedAt ?? null,
        queue: { enteredRetryQueue: false, retryCount: 0 },
        rpc: {
          status,
          decision: envelope.remoteResult?.decision,
          rawResponse: envelope.remoteResult?.rawResponse,
        },
        lww: toLwwDecision(envelope.status),
        lastSyncTime: { before: null, after: null, advanced: false },
      };
    });
}

function buildAuditReplayEntries(
  audits: readonly OfflineAuditRecord[],
  commands: readonly OfflineCommandRecord<OfflineSyncCommandEnvelope>[],
): DataSafetyReplayEntry[] {
  const commandIds = new Set(commands.map(command => command.operationId));
  return audits
    .filter(audit => !commandIds.has(audit.operationId))
    .map(audit => ({
      operationId: audit.operationId,
      entityType: toDataSafetyEntityType(audit.entityType),
      entityId: audit.entityId,
      operation: audit.operation,
      sourceUserId: audit.ownerUserId,
      localCommittedAt: parseTimestamp(audit.localTimestamp),
      baseUpdatedAt: audit.updatedAtBaseline ?? null,
      queue: { enteredRetryQueue: false, retryCount: 0 },
      rpc: { status: audit.queueResult ?? 'audit-only', decision: audit.conflictDecision },
      lww: { decision: 'unknown', reason: audit.conflictDecision ?? 'audit-only' },
      lastSyncTime: { before: null, after: audit.lastSyncTimeEffect ?? null, advanced: audit.lastSyncTimeEffect !== undefined },
    }));
}

function buildConflictReplayEntries(
  records: readonly OfflineConflictEvidenceRecord[],
): DataSafetyReplayEntry[] {
  return records.map(record => {
    const evidence = isRecord(record.evidence) ? record.evidence : { evidence: record.evidence };
    const reason = typeof evidence['reason'] === 'string' ? evidence['reason'] : 'conflict-evidence-retained';
    const losingCommand = isRecord(evidence['losingCommand']) ? evidence['losingCommand'] : null;
    const losingValue = evidence['losingValue'];
    const winningValue = evidence['winningValue'];
    return {
      operationId: record.conflictId,
      entityType: toDataSafetyEntityType(record.entityType),
      entityId: record.entityId,
      operation: 'conflict-evidence',
      sourceUserId: record.ownerUserId,
      localCommittedAt: parseTimestamp(record.capturedAt),
      baseUpdatedAt: typeof losingCommand?.['baseUpdatedAt'] === 'string' ? losingCommand['baseUpdatedAt'] : null,
      queue: { enteredRetryQueue: false, retryCount: 0 },
      rpc: {
        status: 'conflict-evidence-retained',
        decision: 'preserved-both-versions',
        raw: record.evidence,
      },
      lww: { decision: 'unknown', reason },
      lastSyncTime: { before: null, after: null, advanced: false },
      conflict: {
        status: 'conflict-detected',
        reason,
        localSnapshot: {
          operationId: record.losingOperationId,
          command: losingCommand,
          value: losingValue,
        },
        remoteSnapshot: {
          operationId: record.winningOperationId,
          command: evidence['winningCommand'],
          value: winningValue,
        },
      },
    };
  });
}

function toDataSafetyEntityType(entityType: string): string {
  if (entityType === 'black_box_entry') return 'blackbox';
  if (entityType === 'focus_routine') return 'focus-session';
  return entityType;
}

function toLwwDecision(status: OfflineSyncCommandStatus) {
  if (status === 'acked') return { decision: 'local-applied' as const, reason: 'offline-command-acked' };
  if (status === 'rejected') return { decision: 'blocked' as const, reason: 'offline-command-rejected' };
  if (status === 'superseded') return { decision: 'blocked' as const, reason: 'offline-command-superseded' };
  return { decision: 'unknown' as const, reason: `offline-command-${status}` };
}

function parseTimestamp(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}