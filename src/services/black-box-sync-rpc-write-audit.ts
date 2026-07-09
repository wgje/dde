import type { BlackBoxEntry } from '../models/focus';
import { DataSafetyWriteAuditService } from './data-safety-write-audit.service';
import type { SyncRpcResult } from './sync-rpc-client.service';

export interface BlackBoxRpcWriteAuditInput {
  operationId: string;
  sourceUserId: string | undefined;
  entry: BlackBoxEntry;
  result: SyncRpcResult;
  localTimestamp: number;
  updatedAtBaseline: string | null;
  beforeVersion: string | null;
  enteredRetryQueue: boolean;
  retryCount: number;
  lastSyncTimeBefore: string | null;
  lastSyncTimeAfter: string | null;
}

export class BlackBoxRpcWriteAuditRecorder {
  private readonly dataSafetyWriteAudit = new DataSafetyWriteAuditService();

  record(input: BlackBoxRpcWriteAuditInput): void {
    const ownerUserId = input.sourceUserId ?? input.entry.userId;
    this.dataSafetyWriteAudit.recordWrite({
      ownerUserId,
      operationId: input.operationId,
      sourceUserId: ownerUserId,
      entityType: 'blackbox',
      entityId: input.entry.id,
      operation: 'upsert',
      localTimestamp: input.localTimestamp,
      updatedAtBaseline: input.updatedAtBaseline,
      beforeVersion: input.beforeVersion,
      rpcResult: input.result,
      enteredRetryQueue: input.enteredRetryQueue,
      retryCount: input.retryCount,
      lastSyncTimeBefore: input.lastSyncTimeBefore,
      lastSyncTimeAfter: input.lastSyncTimeAfter,
    });
  }
}
