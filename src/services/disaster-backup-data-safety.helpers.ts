import type {
  BackupDataSafetySnapshot,
} from '../../supabase/functions/_shared/backup-utils';
import type { DataSafetyAuditPersistence } from './data-safety-audit-persistence';

export function buildDisasterBackupDataSafetySnapshot(context: {
  ownerUserId: string | null;
  retryQueue: unknown[];
  actionQueue: unknown;
  deadLetters: unknown[];
  dataSafetyAuditPersistence: DataSafetyAuditPersistence;
}): BackupDataSafetySnapshot | undefined {
  if (!context.ownerUserId) {
    return undefined;
  }

  const actionQueue = Array.isArray(context.actionQueue) ? context.actionQueue : [];
  const persistedAudit =
    context.dataSafetyAuditPersistence.load(context.ownerUserId);
  const replayLog = [
    ...persistedAudit.replayLog,
    ...context.retryQueue.map(item => toDataSafetyReplayEntry(item, 'retryQueue')),
    ...actionQueue.map(item => toDataSafetyReplayEntry(item, 'actionQueue')),
  ].filter((entry): entry is BackupDataSafetySnapshot['replayLog'][number] =>
    entry !== null);
  const exportedAt = new Date().toISOString();
  const replayPlan = buildBackupReplayPlan({
    ownerUserId: context.ownerUserId,
    exportedAt,
    replayLog,
  });

  return {
    schemaVersion: '1.0.0',
    exportedAt,
    ownerUserId: context.ownerUserId,
    syncSnapshot: {
      syncState: {
        lastSyncTime: null,
        pendingCount: context.retryQueue.length + actionQueue.length,
      },
      projectCursors: [],
      queueCounts: {
        retryQueue: context.retryQueue.length,
        actionQueue: actionQueue.length,
        deadLetters: context.deadLetters.length,
      },
    },
    replayLog,
    replayPlan,
    lastWriteExplain: persistedAudit.lastWriteExplain ?? (replayLog.length > 0
      ? toDataSafetyLastWriteExplain(replayLog[replayLog.length - 1], context.ownerUserId)
      : null),
  };
}

function buildBackupReplayPlan(input: {
  ownerUserId: string;
  exportedAt: string;
  replayLog: BackupDataSafetySnapshot['replayLog'];
}): BackupDataSafetySnapshot['replayPlan'] {
  const steps = input.replayLog
    .map(toBackupReplayPlanStep)
    .sort(compareBackupReplayPlanSteps);

  return {
    idempotencyKey: calculateBackupReplayPlanIdempotencyKey({
      ownerUserId: input.ownerUserId,
      exportedAt: input.exportedAt,
      steps,
    }),
    ownerUserId: input.ownerUserId,
    exportedAt: input.exportedAt,
    steps,
    summary: {
      replayable: steps.filter(step => step.replayable).length,
      inspectOnly: steps.filter(step => !step.replayable).length,
      retryQueue: steps.filter(step => step.source === 'retryQueue').length,
      actionQueue: steps.filter(step => step.source === 'actionQueue').length,
      auditLog: steps.filter(step => step.source === 'auditLog').length,
    },
  };
}

function toBackupReplayPlanStep(
  entry: BackupDataSafetySnapshot['replayLog'][number],
): BackupDataSafetySnapshot['replayPlan']['steps'][number] {
  const source = entry.lww.reason === 'retryQueue'
    ? 'retryQueue'
    : entry.lww.reason === 'actionQueue'
      ? 'actionQueue'
      : 'auditLog';

  return {
    source,
    operationId: entry.operationId,
    entityType: entry.entityType,
    entityId: entry.entityId,
    operation: entry.operation,
    replayable: source !== 'auditLog',
    reason: source === 'retryQueue'
      ? 'retry-queue-restored'
      : source === 'actionQueue'
        ? 'action-queue-restored'
        : 'recent-audit-inspection-only',
    localTimestamp: entry.localCommittedAt,
    updatedAtBaseline: entry.baseUpdatedAt,
    retryCount: entry.queue.retryCount,
    queue: entry.queue,
    rpc: entry.rpc,
    lww: entry.lww,
    lastSyncTime: entry.lastSyncTime,
  };
}

function toDataSafetyReplayEntry(
  item: unknown,
  source: 'retryQueue' | 'actionQueue',
): BackupDataSafetySnapshot['replayLog'][number] | null {
  if (!item || typeof item !== 'object') {
    return null;
  }

  const record = item as Record<string, unknown>;
  const data = record['data'];
  const payload = record['payload'];
  const entityId = readDataSafetyEntityId(record, data, payload);
  const entityType = readString(record['entityType']) ?? readString(record['type']);
  const operation = readString(record['operation']) ?? readString(record['type']);

  return {
    operationId: readString(record['operationId'])
      ?? `${source}:${readString(record['id']) ?? entityId}`,
    entityType: entityType ?? 'unknown',
    entityId,
    operation: operation ?? 'unknown',
    sourceUserId: readString(record['sourceUserId']),
    localCommittedAt: readNumber(record['localCommittedAt'])
      ?? readNumber(record['createdAt'])
      ?? Date.now(),
    baseUpdatedAt: readString(record['baseUpdatedAt']) ?? null,
    queue: {
      enteredRetryQueue: source === 'retryQueue',
      retryCount: readNumber(record['retryCount']) ?? 0,
      deadLettered: false,
    },
    rpc: {
      status: source === 'retryQueue' ? 'pending-retry' : 'pending-action',
    },
    lww: {
      decision: 'unknown',
      reason: source,
    },
    lastSyncTime: {
      before: null,
      after: null,
      advanced: false,
    },
  };
}

function readDataSafetyEntityId(
  record: Record<string, unknown>,
  data: unknown,
  payload: unknown,
): string {
  return readString(record['entityId'])
    ?? readString(data, 'id')
    ?? readString(payload, 'taskId')
    ?? readString(payload, 'projectId')
    ?? readString(record['id'])
    ?? 'unknown';
}

function toDataSafetyLastWriteExplain(
  entry: BackupDataSafetySnapshot['replayLog'][number],
  ownerUserId: string,
): BackupDataSafetySnapshot['lastWriteExplain'] {
  return {
    operationId: entry.operationId,
    actor: {
      sourceUserId: entry.sourceUserId ?? ownerUserId,
    },
    entity: {
      type: entry.entityType,
      id: entry.entityId,
    },
    operation: entry.operation,
    localTimestamp: entry.localCommittedAt,
    updatedAtBaseline: entry.baseUpdatedAt,
    beforeVersion: entry.baseUpdatedAt,
    afterVersion: null,
    queueResult: entry.queue,
    rpcResult: entry.rpc,
    lwwDecision: entry.lww,
    lastSyncTime: entry.lastSyncTime,
  };
}

function compareBackupReplayPlanSteps(
  a: BackupDataSafetySnapshot['replayPlan']['steps'][number],
  b: BackupDataSafetySnapshot['replayPlan']['steps'][number],
): number {
  return a.localTimestamp - b.localTimestamp
    || replaySourceRank(a.source) - replaySourceRank(b.source)
    || a.operationId.localeCompare(b.operationId)
    || a.entityType.localeCompare(b.entityType)
    || a.entityId.localeCompare(b.entityId);
}

function replaySourceRank(source: BackupDataSafetySnapshot['replayPlan']['steps'][number]['source']): number {
  if (source === 'auditLog') return 0;
  if (source === 'actionQueue') return 1;
  return 2;
}

function calculateBackupReplayPlanIdempotencyKey(input: {
  ownerUserId: string;
  exportedAt: string;
  steps: BackupDataSafetySnapshot['replayPlan']['steps'];
}): string {
  const json = stableStringify(input);
  let hash = 0x811c9dc5;
  for (let i = 0; i < json.length; i += 1) {
    hash ^= json.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  const part = hash.toString(16).padStart(8, '0');
  return part.repeat(8);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(item => stableStringify(item)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .sort()
      .map(key => `${JSON.stringify(key)}:${stableStringify(record[key])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

function readString(source: unknown, key?: string): string | undefined {
  const value = key && source && typeof source === 'object'
    ? (source as Record<string, unknown>)[key]
    : source;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readNumber(source: unknown, key?: string): number | undefined {
  const value = key && source && typeof source === 'object'
    ? (source as Record<string, unknown>)[key]
    : source;
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
