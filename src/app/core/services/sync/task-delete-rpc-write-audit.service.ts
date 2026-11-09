import { Injectable } from '@angular/core';

import { DataSafetyWriteAuditService } from '../../../../services/data-safety-write-audit.service';
import type { SyncRpcResult } from '../../../../services/sync-rpc-client.service';

export interface TaskDeleteRpcWriteAuditInput {
  operationId: string;
  sourceUserId: string | undefined;
  taskIds: string[];
  result: SyncRpcResult;
  localTimestamp: number;
  baseUpdatedAtMap?: Record<string, string | null | undefined>;
  queuedTaskIds: string[];
  lastSyncTimeBefore: string | null;
  lastSyncTimeAfter: string | null;
}

@Injectable({ providedIn: 'root' })
export class TaskDeleteRpcWriteAuditService {
  private readonly dataSafetyWriteAudit = new DataSafetyWriteAuditService();

  recordTaskDeleteRpcWriteAudit(input: TaskDeleteRpcWriteAuditInput): void {
    const queuedTaskIds = new Set(input.queuedTaskIds);
    for (const taskId of input.taskIds) {
      const enteredRetryQueue = queuedTaskIds.has(taskId);
      const baseUpdatedAt = input.baseUpdatedAtMap?.[taskId] ?? null;
      this.dataSafetyWriteAudit.recordWrite({
        ownerUserId: input.sourceUserId,
        operationId: input.operationId,
        sourceUserId: input.sourceUserId,
        entityType: 'task',
        entityId: taskId,
        operation: 'delete',
        localTimestamp: input.localTimestamp,
        updatedAtBaseline: baseUpdatedAt,
        beforeVersion: baseUpdatedAt,
        rpcResult: input.result,
        enteredRetryQueue,
        retryCount: enteredRetryQueue ? 1 : 0,
        lastSyncTimeBefore: input.lastSyncTimeBefore,
        lastSyncTimeAfter: input.lastSyncTimeAfter,
      });
    }
  }
}
