import type { SyncRpcResult, SyncRpcStatus, TaskWriteIntent } from './sync-rpc-client.service';
import { buildStoreRestoreOperations } from './data-safety-package-restore-plan.helpers';
import { validateDataSafetyPackageContents } from './data-safety-package-validation.helpers';

export const DATA_SAFETY_PACKAGE_SCHEMA_VERSION = '1.0.0' as const;

type UnknownRecord = Record<string, unknown>;

export interface DataSafetyAppSnapshot {
  appVersion: string;
  syncProtocolVersion: number;
  deploymentEpoch: number;
  deploymentTarget?: string | null;
}

export interface DataSafetyEntityRecord extends UnknownRecord {
  id: string;
}

export interface DataSafetySyncCursorRecord extends UnknownRecord {
  key: string;
}

export interface DataSafetyLocalDataSnapshot {
  projects: DataSafetyEntityRecord[];
  tasks: DataSafetyEntityRecord[];
  connections: DataSafetyEntityRecord[];
  syncCursors: DataSafetySyncCursorRecord[];
  meta?: unknown;
}

export interface DataSafetyRetryQueueItem extends UnknownRecord {
  id: string;
  operationId: string;
  type: string;
  operation: string;
  data: UnknownRecord;
  retryCount: number;
  createdAt: number;
  sourceUserId: string;
  projectId?: string;
  writeIntent?: TaskWriteIntent;
}

export interface DataSafetyQueuedAction extends UnknownRecord {
  id: string;
  operationId: string;
  entityType: string;
  entityId: string;
}

export interface DataSafetyDeadLetterItem extends UnknownRecord {
  action?: DataSafetyQueuedAction;
}

export interface DataSafetyOfflineSnapshotMirrors {
  localStorage?: string | null;
  indexedDb?: string | null;
}

export interface DataSafetyLocalStateSnapshot {
  retryQueue: DataSafetyRetryQueueItem[];
  actionQueue: DataSafetyQueuedAction[];
  deadLetters: DataSafetyDeadLetterItem[];
  conflicts: unknown[];
  taskTombstones: unknown;
  connectionTombstones: unknown;
  offlineSnapshots?: DataSafetyOfflineSnapshotMirrors | null;
}

export interface DataSafetySyncStateSnapshot extends UnknownRecord {
  lastSyncTime: string | null;
  pendingCount: number;
}

export interface DataSafetyProjectCursorSnapshot {
  projectId: string;
  userId: string | null;
  cursor: unknown;
}

export interface DataSafetySyncSnapshot {
  syncState: DataSafetySyncStateSnapshot;
  projectCursors: DataSafetyProjectCursorSnapshot[];
  queueCounts: {
    retryQueue: number;
    actionQueue: number;
    deadLetters: number;
  };
}

export type DataSafetyEntityType =
  | 'project'
  | 'task'
  | 'connection'
  | 'blackbox'
  | 'preference'
  | 'focus-session'
  | 'routine-task'
  | 'routine-completion'
  | string;

export type DataSafetyOperation = 'create' | 'update' | 'delete' | 'upsert' | string;

export type LwwDecision = 'local-applied' | 'remote-kept' | 'idempotent-replay' | 'blocked' | 'unknown';

export interface DataSafetyLwwDecision {
  decision: LwwDecision;
  reason: string;
}

export interface DataSafetyConflictSnapshot {
  status: 'conflict-detected';
  reason: 'remote-newer' | 'remote-tombstone' | 'version_mismatch' | string;
  localSnapshot: unknown;
  remoteSnapshot?: unknown;
}

export interface DataSafetyQueueResult {
  enteredRetryQueue: boolean;
  retryCount: number;
  deadLettered?: boolean;
}

export type DataSafetyRpcSnapshot = Omit<Partial<SyncRpcResult>, 'status'> & {
  status: SyncRpcStatus | string;
};

export interface DataSafetyLastSyncTimeEffect {
  before: string | null;
  after: string | null;
  advanced: boolean;
}

export interface DataSafetyReplayEntry {
  operationId: string;
  entityType: DataSafetyEntityType;
  entityId: string;
  operation: DataSafetyOperation;
  writeIntent?: TaskWriteIntent;
  sourceUserId?: string;
  localCommittedAt: number;
  baseUpdatedAt?: string | null;
  queue: DataSafetyQueueResult;
  rpc: DataSafetyRpcSnapshot;
  lww: DataSafetyLwwDecision;
  lastSyncTime: DataSafetyLastSyncTimeEffect;
  conflict?: DataSafetyConflictSnapshot;
}

export interface DataSafetyLastWriteExplain {
  operationId: string;
  actor: {
    sourceUserId?: string;
  };
  entity: {
    type: DataSafetyEntityType;
    id: string;
  };
  operation: DataSafetyOperation;
  writeIntent?: TaskWriteIntent;
  localTimestamp: number;
  updatedAtBaseline?: string | null;
  beforeVersion?: string | null;
  afterVersion?: string | null;
  queueResult: DataSafetyQueueResult;
  rpcResult: DataSafetyRpcSnapshot;
  lwwDecision: DataSafetyLwwDecision;
  lastSyncTime: DataSafetyLastSyncTimeEffect;
  conflict?: DataSafetyConflictSnapshot;
}

export interface DataSafetyIntegritySnapshot {
  tableCounts: {
    projects: number;
    tasks: number;
    connections: number;
    syncCursors: number;
    retryQueue: number;
    actionQueue: number;
    deadLetters: number;
  };
  checksum: string;
}

export interface DataSafetyExportPackage {
  schemaVersion: typeof DATA_SAFETY_PACKAGE_SCHEMA_VERSION;
  exportedAt: string;
  ownerUserId: string;
  app: DataSafetyAppSnapshot;
  localData: DataSafetyLocalDataSnapshot;
  localState: DataSafetyLocalStateSnapshot;
  syncSnapshot: DataSafetySyncSnapshot;
  replayLog: DataSafetyReplayEntry[];
  replayPlan: DataSafetyReplayPlan;
  lastWriteExplain: DataSafetyLastWriteExplain | null;
  integrity: DataSafetyIntegritySnapshot;
}

export interface BuildDataSafetyExportPackageInput {
  exportedAt: string;
  ownerUserId: string;
  app: DataSafetyAppSnapshot;
  localData: DataSafetyLocalDataSnapshot;
  localState: DataSafetyLocalStateSnapshot;
  syncSnapshot: DataSafetySyncSnapshot;
  replayLog?: DataSafetyReplayEntry[];
  lastWriteExplain?: DataSafetyLastWriteExplain | null;
}

export interface DataSafetyValidationResult {
  valid: boolean;
  errors: string[];
}

export type DataSafetyRestoreStore = 'projects' | 'tasks' | 'connections' | 'syncCursors';
export type DataSafetyRestoreAction = 'put' | 'skip' | 'delete';

export interface DataSafetyRestoreOperation {
  store: DataSafetyRestoreStore;
  action: DataSafetyRestoreAction;
  id: string;
}

export interface DataSafetyRestorePlan {
  idRemappingRequired: boolean;
  operations: DataSafetyRestoreOperation[];
  summary: {
    writes: number;
    skips: number;
    deletes: number;
  };
  errors: string[];
}

export interface DataSafetyCurrentLocalData {
  projects: DataSafetyEntityRecord[];
  tasks: DataSafetyEntityRecord[];
  connections: DataSafetyEntityRecord[];
  syncCursors: DataSafetySyncCursorRecord[];
}

export interface DataSafetyReplaySummary {
  pendingOperations: string[];
  recentOperations: string[];
  retryQueueOperations: string[];
  byEntity: Record<string, number>;
}

export type DataSafetyReplaySource = 'retryQueue' | 'actionQueue' | 'auditLog';

export interface DataSafetyReplayPlanStep {
  source: DataSafetyReplaySource;
  operationId: string;
  entityType: DataSafetyEntityType;
  entityId: string;
  operation: DataSafetyOperation;
  replayable: boolean;
  reason: string;
  localTimestamp: number;
  updatedAtBaseline?: string | null;
  retryCount: number;
  queue: DataSafetyQueueResult;
  rpc: DataSafetyRpcSnapshot;
  lww: DataSafetyLwwDecision;
  lastSyncTime: DataSafetyLastSyncTimeEffect;
}

export interface DataSafetyReplayPlan {
  idempotencyKey: string;
  ownerUserId: string;
  exportedAt: string;
  steps: DataSafetyReplayPlanStep[];
  summary: {
    replayable: number;
    inspectOnly: number;
    retryQueue: number;
    actionQueue: number;
    auditLog: number;
  };
}

type DataSafetyReplayPlanSource = {
  schemaVersion: typeof DATA_SAFETY_PACKAGE_SCHEMA_VERSION;
  exportedAt: string;
  ownerUserId: string;
  localState: DataSafetyLocalStateSnapshot;
  replayLog: DataSafetyReplayEntry[];
};

export interface BuildLastWriteExplainInput {
  operationId: string;
  sourceUserId?: string;
  entityType: DataSafetyEntityType;
  entityId: string;
  operation: DataSafetyOperation;
  writeIntent?: TaskWriteIntent;
  localTimestamp: number;
  updatedAtBaseline?: string | null;
  beforeVersion?: string | null;
  rpcResult: DataSafetyRpcSnapshot;
  enteredRetryQueue: boolean;
  retryCount: number;
  lastSyncTimeBefore: string | null;
  lastSyncTimeAfter: string | null;
  conflict?: DataSafetyConflictSnapshot;
}

export function buildDataSafetyExportPackage(input: BuildDataSafetyExportPackageInput): DataSafetyExportPackage {
  const replaySource = {
    schemaVersion: DATA_SAFETY_PACKAGE_SCHEMA_VERSION,
    exportedAt: input.exportedAt,
    ownerUserId: input.ownerUserId,
    localState: input.localState,
    replayLog: input.replayLog ?? [],
  };
  const packageWithoutChecksum: DataSafetyExportPackage = {
    schemaVersion: DATA_SAFETY_PACKAGE_SCHEMA_VERSION,
    exportedAt: input.exportedAt,
    ownerUserId: input.ownerUserId,
    app: input.app,
    localData: input.localData,
    localState: input.localState,
    syncSnapshot: input.syncSnapshot,
    replayLog: input.replayLog ?? [],
    replayPlan: buildReplayPlan(replaySource),
    lastWriteExplain: input.lastWriteExplain ?? null,
    integrity: {
      tableCounts: buildTableCounts(input.localData, input.localState),
      checksum: '',
    },
  };

  return {
    ...packageWithoutChecksum,
    integrity: {
      ...packageWithoutChecksum.integrity,
      checksum: calculateDeterministicChecksum(packageWithoutChecksum),
    },
  };
}

export function validateDataSafetyExportPackage(value: unknown): DataSafetyValidationResult {
  const errors: string[] = [];
  if (!isRecord(value)) {
    return { valid: false, errors: ['package must be an object'] };
  }

  validateDataSafetyPackageContents(value, DATA_SAFETY_PACKAGE_SCHEMA_VERSION, errors);

  if (errors.length === 0 && isDataSafetyExportPackageShape(value)) {
    const expectedChecksum = calculateDeterministicChecksum(value);
    if (value.integrity.checksum !== expectedChecksum) {
      errors.push('integrity.checksum does not match package contents');
    }
  }

  return { valid: errors.length === 0, errors };
}

export function buildRestorePlan(
  pkg: DataSafetyExportPackage,
  current: DataSafetyCurrentLocalData,
): DataSafetyRestorePlan {
  const operations: DataSafetyRestoreOperation[] = [
    ...buildStoreRestoreOperations('projects', pkg.localData.projects, current.projects, stableStringify),
    ...buildStoreRestoreOperations('tasks', pkg.localData.tasks, current.tasks, stableStringify),
    ...buildStoreRestoreOperations('connections', pkg.localData.connections, current.connections, stableStringify),
    ...buildStoreRestoreOperations('syncCursors', pkg.localData.syncCursors, current.syncCursors, stableStringify),
  ];
  const summary = {
    writes: operations.filter(operation => operation.action === 'put').length,
    skips: operations.filter(operation => operation.action === 'skip').length,
    deletes: operations.filter(operation => operation.action === 'delete').length,
  };

  return {
    idRemappingRequired: false,
    operations,
    summary,
    errors: validateDataSafetyExportPackage(pkg).errors,
  };
}

export function summarizeReplayableActions(pkg: DataSafetyExportPackage): DataSafetyReplaySummary {
  const pendingOperations = uniqueStrings(pkg.localState.retryQueue.map(item => item.operationId));
  const recentOperations = uniqueStrings(pkg.replayLog.map(entry => entry.operationId));
  const retryQueueOperations = uniqueStrings(pkg.localState.retryQueue.map(item => item.operationId));
  const byEntity: Record<string, number> = {};

  for (const entry of pkg.replayLog) {
    byEntity[entry.entityType] = (byEntity[entry.entityType] ?? 0) + 1;
  }

  return {
    pendingOperations,
    recentOperations,
    retryQueueOperations,
    byEntity,
  };
}

export function buildReplayPlan(pkg: DataSafetyReplayPlanSource): DataSafetyReplayPlan {
  const steps = [
    ...pkg.replayLog.map(toAuditReplayPlanStep),
    ...pkg.localState.actionQueue.map(toActionQueueReplayPlanStep),
    ...pkg.localState.retryQueue.map(toRetryQueueReplayPlanStep),
  ].sort(compareReplayPlanSteps);

  return {
    idempotencyKey: calculateReplayPlanIdempotencyKey(pkg, steps),
    ownerUserId: pkg.ownerUserId,
    exportedAt: pkg.exportedAt,
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

export function buildLastWriteExplain(input: BuildLastWriteExplainInput): DataSafetyLastWriteExplain {
  const afterVersion = resolveAfterVersion(input.rpcResult, input.beforeVersion);
  const lwwDecision = resolveLwwDecision(input.rpcResult.status);

  return {
    operationId: input.operationId,
    actor: { sourceUserId: input.sourceUserId },
    entity: { type: input.entityType, id: input.entityId },
    operation: input.operation,
    writeIntent: input.writeIntent,
    localTimestamp: input.localTimestamp,
    updatedAtBaseline: input.updatedAtBaseline,
    beforeVersion: input.beforeVersion,
    afterVersion,
    queueResult: {
      enteredRetryQueue: input.enteredRetryQueue,
      retryCount: input.retryCount,
    },
    rpcResult: input.rpcResult,
    lwwDecision,
    lastSyncTime: {
      before: input.lastSyncTimeBefore,
      after: input.lastSyncTimeAfter,
      advanced: input.lastSyncTimeBefore !== input.lastSyncTimeAfter,
    },
    conflict: input.conflict,
  };
}

function buildTableCounts(
  localData: DataSafetyLocalDataSnapshot,
  localState: DataSafetyLocalStateSnapshot,
): DataSafetyIntegritySnapshot['tableCounts'] {
  return {
    projects: localData.projects.length,
    tasks: localData.tasks.length,
    connections: localData.connections.length,
    syncCursors: localData.syncCursors.length,
    retryQueue: localState.retryQueue.length,
    actionQueue: localState.actionQueue.length,
    deadLetters: localState.deadLetters.length,
  };
}

function calculateDeterministicChecksum(pkg: DataSafetyExportPackage): string {
  const json = stableStringify({
    ...pkg,
    integrity: {
      ...pkg.integrity,
      checksum: '',
    },
  });
  let hash = 0x811c9dc5;
  for (let i = 0; i < json.length; i += 1) {
    hash ^= json.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  const part = hash.toString(16).padStart(8, '0');
  return part.repeat(8);
}

function calculateReplayPlanIdempotencyKey(
  pkg: DataSafetyReplayPlanSource,
  steps: DataSafetyReplayPlanStep[],
): string {
  const json = stableStringify({
    schemaVersion: pkg.schemaVersion,
    ownerUserId: pkg.ownerUserId,
    exportedAt: pkg.exportedAt,
    steps: steps.map(step => ({
      source: step.source,
      operationId: step.operationId,
      entityType: step.entityType,
      entityId: step.entityId,
      operation: step.operation,
      localTimestamp: step.localTimestamp,
      retryCount: step.retryCount,
      replayable: step.replayable,
      reason: step.reason,
    })),
  });
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
  if (isRecord(value)) {
    const entries = Object.keys(value)
      .sort()
      .map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

function isDataSafetyExportPackageShape(value: unknown): value is DataSafetyExportPackage {
  if (!isRecord(value)) {
    return false;
  }

  return value['schemaVersion'] === DATA_SAFETY_PACKAGE_SCHEMA_VERSION
    && typeof value['exportedAt'] === 'string'
    && typeof value['ownerUserId'] === 'string'
    && isRecord(value['app'])
    && isRecord(value['localData'])
    && isRecord(value['localState'])
    && isRecord(value['syncSnapshot'])
    && isRecord(value['replayPlan'])
    && isRecord(value['integrity'])
    && typeof value['integrity']['checksum'] === 'string';
}

function toAuditReplayPlanStep(entry: DataSafetyReplayEntry): DataSafetyReplayPlanStep {
  return {
    source: 'auditLog',
    operationId: entry.operationId,
    entityType: entry.entityType,
    entityId: entry.entityId,
    operation: entry.operation,
    replayable: false,
    reason: 'recent-audit-inspection-only',
    localTimestamp: entry.localCommittedAt,
    updatedAtBaseline: entry.baseUpdatedAt,
    retryCount: entry.queue.retryCount,
    queue: entry.queue,
    rpc: entry.rpc,
    lww: entry.lww,
    lastSyncTime: entry.lastSyncTime,
  };
}

function toActionQueueReplayPlanStep(item: DataSafetyQueuedAction): DataSafetyReplayPlanStep {
  const record = item as UnknownRecord;
  const timestamp = readNumber(record['timestamp'])
    ?? readNumber(record['localCommittedAt'])
    ?? 0;
  return {
    source: 'actionQueue',
    operationId: item.operationId,
    entityType: item.entityType,
    entityId: item.entityId,
    operation: readString(record['type']) ?? readString(record['operation']) ?? 'unknown',
    replayable: true,
    reason: 'action-queue-restored',
    localTimestamp: timestamp,
    updatedAtBaseline: readUpdatedAt(record['payload']) ?? readString(record['baseUpdatedAt']) ?? null,
    retryCount: readNumber(record['retryCount']) ?? 0,
    queue: {
      enteredRetryQueue: false,
      retryCount: readNumber(record['retryCount']) ?? 0,
    },
    rpc: { status: 'pending-action' },
    lww: { decision: 'unknown', reason: 'actionQueue' },
    lastSyncTime: { before: null, after: null, advanced: false },
  };
}

function toRetryQueueReplayPlanStep(item: DataSafetyRetryQueueItem): DataSafetyReplayPlanStep {
  return {
    source: 'retryQueue',
    operationId: item.operationId,
    entityType: item.type,
    entityId: readString(item.data['id']) ?? item.id,
    operation: item.operation,
    replayable: true,
    reason: 'retry-queue-restored',
    localTimestamp: item.createdAt,
    updatedAtBaseline: readUpdatedAt(item.data) ?? readString(item['baseUpdatedAt']) ?? null,
    retryCount: item.retryCount,
    queue: {
      enteredRetryQueue: true,
      retryCount: item.retryCount,
    },
    rpc: { status: 'pending-retry' },
    lww: { decision: 'unknown', reason: 'retryQueue' },
    lastSyncTime: { before: null, after: null, advanced: false },
  };
}

function compareReplayPlanSteps(a: DataSafetyReplayPlanStep, b: DataSafetyReplayPlanStep): number {
  return a.localTimestamp - b.localTimestamp
    || replaySourceRank(a.source) - replaySourceRank(b.source)
    || a.operationId.localeCompare(b.operationId)
    || a.entityType.localeCompare(b.entityType)
    || a.entityId.localeCompare(b.entityId);
}

function replaySourceRank(source: DataSafetyReplaySource): number {
  if (source === 'auditLog') return 0;
  if (source === 'actionQueue') return 1;
  return 2;
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter(value => value.length > 0)));
}

function resolveAfterVersion(
  rpcResult: DataSafetyRpcSnapshot,
  beforeVersion?: string | null,
): string | null | undefined {
  if (typeof rpcResult.serverUpdatedAt === 'string') return rpcResult.serverUpdatedAt;
  if (typeof rpcResult.remoteUpdatedAt === 'string') return rpcResult.remoteUpdatedAt;
  return beforeVersion;
}

function resolveLwwDecision(status: SyncRpcStatus | string): DataSafetyLwwDecision {
  if (status === 'applied') return { decision: 'local-applied', reason: status };
  if (status === 'idempotent-replay') return { decision: 'idempotent-replay', reason: status };
  if (status === 'remote-newer' || status === 'deleted-remote-newer') {
    return { decision: 'remote-kept', reason: status };
  }
  if (status === 'client-version-rejected' || status === 'quarantined' || status === 'unauthorized') {
    return { decision: 'blocked', reason: status };
  }
  return { decision: 'unknown', reason: status };
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readUpdatedAt(value: unknown): string | null {
  if (!isRecord(value)) return null;
  return readString(value['updatedAt'])
    ?? readString(value['updated_at'])
    ?? null;
}

function isRecord(value: unknown): value is UnknownRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
