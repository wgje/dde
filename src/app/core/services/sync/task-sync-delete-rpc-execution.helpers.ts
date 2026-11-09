import type { SupabaseClient } from '@supabase/supabase-js';

import type { CategoryLogger } from '../../../../services/logger.service';
import type { SyncRpcResult } from '../../../../services/sync-rpc-client.service';
import type { TaskDeleteConflictCaptureService } from './task-delete-conflict-capture.service';
import type { TaskDeleteRpcRejectionReporterService } from './task-delete-rpc-rejection-reporter.service';
import type { TaskDeleteRpcWriteAuditService } from './task-delete-rpc-write-audit.service';
import { createSettledTaskPurgeResult, selectAppliedTaskDeleteIds } from './task-sync-delete.helpers';
import type { TaskPurgeResult } from './task-sync-operations.types';
import type { TombstoneService } from './tombstone.service';

interface SuccessfulTaskDeleteRpcInput {
  client: SupabaseClient;
  result: SyncRpcResult;
  projectId: string;
  taskIds: string[];
  tombstoneTimestamps?: Record<string, string | number | null | undefined>;
  tombstoneService: Pick<TombstoneService, 'deleteAttachmentFilesFromStorage' | 'addLocalTombstones'>;
  settleDeletedTaskDependencies: (projectId: string, taskIds: string[]) => void;
  logger: CategoryLogger;
}

interface AppliedPurgeTaskDeleteRpcInput extends SuccessfulTaskDeleteRpcInput {
  sourceUserId: string | undefined;
  baseUpdatedAtMap: Record<string, string | null>;
  operationId: string;
  localTimestamp: number;
  lastSyncTimeBefore: string | null;
  getLastSyncTime: () => string | null;
  taskDeleteRpcRejectionReporter: Pick<
    TaskDeleteRpcRejectionReporterService,
    'reportSkippedTaskDeletes'
  >;
  taskDeleteRpcWriteAudit: Pick<TaskDeleteRpcWriteAuditService, 'recordTaskDeleteRpcWriteAudit'>;
  taskDeleteConflictCapture: Pick<TaskDeleteConflictCaptureService, 'capture'>;
}

export async function applySuccessfulTaskDeleteRpc(
  input: SuccessfulTaskDeleteRpcInput,
): Promise<void> {
  if (input.result.attachmentPaths && input.result.attachmentPaths.length > 0) {
    await input.tombstoneService.deleteAttachmentFilesFromStorage(
      input.client,
      input.result.attachmentPaths,
    );
  }

  const { deletedTaskIds, skippedTaskIds } = selectAppliedTaskDeleteIds(input.result, input.taskIds);

  input.tombstoneService.addLocalTombstones(
    input.projectId,
    deletedTaskIds,
    input.tombstoneTimestamps,
  );
  input.settleDeletedTaskDependencies(input.projectId, deletedTaskIds);
  input.logger.info('sync_delete_tasks 成功', {
    projectId: input.projectId,
    taskCount: input.taskIds.length,
    deletedCount: deletedTaskIds.length,
    skippedCount: skippedTaskIds.length,
    affectedCount: input.result.affectedCount ?? null,
    status: input.result.status,
  });
}

export async function executeAppliedPurgeTaskDeleteRpc(
  input: AppliedPurgeTaskDeleteRpcInput,
): Promise<TaskPurgeResult> {
  await applySuccessfulTaskDeleteRpc(input);
  const { deletedTaskIds, skippedTaskIds } = selectAppliedTaskDeleteIds(input.result, input.taskIds);
  input.taskDeleteRpcRejectionReporter.reportSkippedTaskDeletes(
    input.result,
    input.projectId,
    'purgeTasksFromCloud',
    input.logger,
  );
  input.taskDeleteRpcWriteAudit.recordTaskDeleteRpcWriteAudit({
    operationId: input.operationId,
    sourceUserId: input.sourceUserId,
    taskIds: deletedTaskIds,
    result: input.result,
    localTimestamp: input.localTimestamp,
    baseUpdatedAtMap: input.baseUpdatedAtMap,
    queuedTaskIds: [],
    lastSyncTimeBefore: input.lastSyncTimeBefore,
    lastSyncTimeAfter: input.getLastSyncTime(),
  });
  const conflictPersisted = skippedTaskIds.length === 0
    ? undefined
    : await input.taskDeleteConflictCapture.capture({
        projectId: input.projectId,
        taskIds: skippedTaskIds,
        sourceUserId: input.sourceUserId,
        baseUpdatedAtMap: input.baseUpdatedAtMap,
      });
  const purgeResult = createSettledTaskPurgeResult(
    deletedTaskIds,
    skippedTaskIds,
    [],
    skippedTaskIds,
  );
  return conflictPersisted === undefined
    ? purgeResult
    : { ...purgeResult, conflictPersisted };
}
