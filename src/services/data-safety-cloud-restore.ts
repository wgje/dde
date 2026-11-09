import type { Connection, Project, Task } from '../models';
import {
  validateDataSafetyExportPackage,
  type DataSafetyEntityRecord,
  type DataSafetyEntityType,
  type DataSafetyExportPackage,
  type DataSafetyLastSyncTimeEffect,
  type DataSafetyLwwDecision,
  type DataSafetyQueueResult,
  type DataSafetyRpcSnapshot,
} from './data-safety-package';
import type { SyncRpcResult, SyncRpcStatus, TaskWriteIntent } from './sync-rpc-client.service';

export type DataSafetyCloudRestoreEntityType = 'project' | 'task' | 'connection';
export type DataSafetyCloudRestoreStepStatus =
  | 'planned'
  | 'applied'
  | 'idempotent-replay'
  | 'blocked'
  | 'failed';

export interface DataSafetyCloudRestoreRpcAdapter {
  upsertProject(params: {
    operationId: string;
    project: Project;
    ownerId: string;
    baseUpdatedAt: string | null;
  }): Promise<SyncRpcResult>;
  upsertTask(params: {
    operationId: string;
    task: Task;
    projectId?: string;
    baseUpdatedAt: string | null;
    writeIntent?: TaskWriteIntent;
  }): Promise<SyncRpcResult>;
  upsertConnection(params: {
    operationId: string;
    connection: Connection;
    projectId?: string;
    baseUpdatedAt: string | null;
  }): Promise<SyncRpcResult>;
}

export interface DataSafetyCloudRestoreOptions {
  ownerUserId: string;
  dryRun?: boolean;
}

export interface DataSafetyCloudRestorePlanStep {
  entityType: DataSafetyCloudRestoreEntityType;
  entityId: string;
  operation: 'upsert';
  operationId: string;
  projectId?: string;
  baseUpdatedAt: string | null;
  status: DataSafetyCloudRestoreStepStatus;
  rpcResult: DataSafetyRpcSnapshot | null;
  lwwDecision: DataSafetyLwwDecision;
  queueResult: DataSafetyQueueResult;
  lastSyncTime: DataSafetyLastSyncTimeEffect;
  error?: string;
}

export interface DataSafetyCloudRestorePlan {
  ownerUserId: string;
  exportedAt: string;
  dryRun: boolean;
  steps: DataSafetyCloudRestorePlanStep[];
  summary: {
    total: number;
    planned: number;
    executed: number;
    blocked: number;
    failed: number;
  };
}

export interface DataSafetyCloudRestoreResult {
  success: boolean;
  dryRun: boolean;
  plan: DataSafetyCloudRestorePlan;
  errors: string[];
}

type RestoreEntityRecord = DataSafetyEntityRecord & {
  projectId?: string;
  updatedAt?: string | null;
};

const RESTORE_OPERATION_PREFIX = 'data-safety-restore';

export async function restoreDataSafetyPackageToCloud(
  pkg: DataSafetyExportPackage,
  adapter: DataSafetyCloudRestoreRpcAdapter,
  options: DataSafetyCloudRestoreOptions,
): Promise<DataSafetyCloudRestoreResult> {
  const dryRun = options.dryRun ?? true;
  const errors = validateCloudRestoreInput(pkg, options);
  const plan = buildCloudRestorePlan(pkg, dryRun);
  if (errors.length > 0) {
    return {
      success: false,
      dryRun,
      plan,
      errors,
    };
  }

  if (dryRun) {
    return {
      success: true,
      dryRun: true,
      plan,
      errors: [],
    };
  }

  await executeCloudRestorePlan(pkg, adapter, plan);
  const executionErrors = collectPlanErrors(plan);

  return {
    success: executionErrors.length === 0,
    dryRun: false,
    plan,
    errors: executionErrors,
  };
}

function validateCloudRestoreInput(
  pkg: DataSafetyExportPackage,
  options: DataSafetyCloudRestoreOptions,
): string[] {
  const validation = validateDataSafetyExportPackage(pkg);
  const errors = [...validation.errors];

  if (pkg.ownerUserId !== options.ownerUserId) {
    errors.push('ownerUserId does not match current restore user');
  }

  pkg.localData.tasks.forEach((task, index) => {
    if (typeof task['content'] !== 'string') {
      errors.push(`localData.tasks[${index}].content is required for cloud restore`);
    }
  });

  return errors;
}

function buildCloudRestorePlan(
  pkg: DataSafetyExportPackage,
  dryRun: boolean,
): DataSafetyCloudRestorePlan {
  const lastSyncTime = readLastSyncTime(pkg);
  const steps = [
    ...pkg.localData.projects.map(project => toPlanStep(pkg, 'project', project, lastSyncTime)),
    ...pkg.localData.tasks.map(task => toPlanStep(pkg, 'task', task, lastSyncTime)),
    ...pkg.localData.connections.map(connection => toPlanStep(pkg, 'connection', connection, lastSyncTime)),
  ];

  return {
    ownerUserId: pkg.ownerUserId,
    exportedAt: pkg.exportedAt,
    dryRun,
    steps,
    summary: summarizeSteps(steps),
  };
}

function toPlanStep(
  pkg: DataSafetyExportPackage,
  entityType: DataSafetyCloudRestoreEntityType,
  record: RestoreEntityRecord,
  lastSyncTime: string | null,
): DataSafetyCloudRestorePlanStep {
  return {
    entityType,
    entityId: record.id,
    operation: 'upsert',
    operationId: buildRestoreOperationId(pkg, entityType, record.id),
    projectId: typeof record.projectId === 'string' ? record.projectId : undefined,
    baseUpdatedAt: normalizeUpdatedAt(record.updatedAt),
    status: 'planned',
    rpcResult: null,
    lwwDecision: { decision: 'unknown', reason: 'dry-run' },
    queueResult: { enteredRetryQueue: false, retryCount: 0 },
    lastSyncTime: {
      before: lastSyncTime,
      after: lastSyncTime,
      advanced: false,
    },
  };
}

async function executeCloudRestorePlan(
  pkg: DataSafetyExportPackage,
  adapter: DataSafetyCloudRestoreRpcAdapter,
  plan: DataSafetyCloudRestorePlan,
): Promise<void> {
  for (const step of plan.steps) {
    try {
      const rpcResult = await executeStep(pkg, adapter, step);
      applyRpcResult(step, rpcResult);
      if (step.status === 'blocked') {
        break;
      }
    } catch (error) {
      step.status = 'failed';
      step.error = (error as Error)?.message ?? String(error);
      step.lwwDecision = { decision: 'blocked', reason: 'rpc-error' };
      break;
    } finally {
      plan.summary = summarizeSteps(plan.steps);
    }
  }
}

async function executeStep(
  pkg: DataSafetyExportPackage,
  adapter: DataSafetyCloudRestoreRpcAdapter,
  step: DataSafetyCloudRestorePlanStep,
): Promise<SyncRpcResult> {
  if (step.entityType === 'project') {
    const project = findRecord<Project>(pkg.localData.projects, step.entityId, 'project');
    return adapter.upsertProject({
      operationId: step.operationId,
      project,
      ownerId: pkg.ownerUserId,
      baseUpdatedAt: step.baseUpdatedAt,
    });
  }

  if (step.entityType === 'task') {
    const task = findRecord<Task>(pkg.localData.tasks, step.entityId, 'task');
    return adapter.upsertTask({
      operationId: step.operationId,
      task,
      projectId: step.projectId,
      baseUpdatedAt: step.baseUpdatedAt,
      writeIntent: 'task_full_upsert',
    });
  }

  const connection = findRecord<Connection>(pkg.localData.connections, step.entityId, 'connection');
  return adapter.upsertConnection({
    operationId: step.operationId,
    connection,
    projectId: step.projectId,
    baseUpdatedAt: step.baseUpdatedAt,
  });
}

function applyRpcResult(
  step: DataSafetyCloudRestorePlanStep,
  rpcResult: SyncRpcResult,
): void {
  step.rpcResult = rpcResult;
  step.lwwDecision = lwwDecisionForRpcStatus(rpcResult.status);
  step.status = restoreStatusForRpcStatus(rpcResult.status);
  if (step.status === 'failed') {
    step.error = `cloud restore RPC returned ${rpcResult.status}`;
  }
}

function restoreStatusForRpcStatus(status: SyncRpcStatus): DataSafetyCloudRestoreStepStatus {
  if (status === 'applied' || status === 'idempotent-replay') {
    return status;
  }
  if (status === 'remote-newer' || status === 'deleted-remote-newer' || status === 'client-version-rejected') {
    return 'blocked';
  }
  return 'failed';
}

function lwwDecisionForRpcStatus(status: SyncRpcStatus): DataSafetyLwwDecision {
  if (status === 'applied') {
    return { decision: 'local-applied', reason: 'applied' };
  }
  if (status === 'idempotent-replay') {
    return { decision: 'idempotent-replay', reason: 'idempotent-replay' };
  }
  if (status === 'remote-newer' || status === 'deleted-remote-newer') {
    return { decision: 'remote-kept', reason: status };
  }
  return { decision: 'blocked', reason: status };
}

function summarizeSteps(
  steps: DataSafetyCloudRestorePlanStep[],
): DataSafetyCloudRestorePlan['summary'] {
  return {
    total: steps.length,
    planned: steps.filter(step => step.status === 'planned').length,
    executed: steps.filter(step => step.rpcResult !== null || step.status === 'failed').length,
    blocked: steps.filter(step => step.status === 'blocked').length,
    failed: steps.filter(step => step.status === 'failed').length,
  };
}

function collectPlanErrors(plan: DataSafetyCloudRestorePlan): string[] {
  return plan.steps
    .filter(step => step.status === 'blocked' || step.status === 'failed')
    .map(step => step.error ?? `${step.entityType}:${step.entityId} restore ${step.status}`);
}

function buildRestoreOperationId(
  pkg: DataSafetyExportPackage,
  entityType: DataSafetyEntityType,
  entityId: string,
): string {
  return `${RESTORE_OPERATION_PREFIX}:${pkg.integrity.checksum.slice(0, 16)}:${entityType}:${entityId}`;
}

function readLastSyncTime(pkg: DataSafetyExportPackage): string | null {
  const value = pkg.syncSnapshot.syncState.lastSyncTime;
  return typeof value === 'string' ? value : null;
}

function normalizeUpdatedAt(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function findRecord<T>(
  records: DataSafetyEntityRecord[],
  id: string,
  entityType: DataSafetyCloudRestoreEntityType,
): T {
  const record = records.find(item => item.id === id);
  if (!record) {
    throw new Error(`Cloud restore record not found for ${entityType}:${id}`);
  }
  return record as T;
}
