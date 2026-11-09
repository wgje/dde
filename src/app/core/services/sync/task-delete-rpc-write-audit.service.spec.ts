import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DataSafetyAuditPersistence } from '../../../../services/data-safety-audit-persistence';
import type { SyncRpcResult } from '../../../../services/sync-rpc-client.service';
import { TaskDeleteRpcWriteAuditService } from './task-delete-rpc-write-audit.service';

describe('TaskDeleteRpcWriteAuditService', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('records remote-newer delete rejection write audit after queue handoff', () => {
    const service = new TaskDeleteRpcWriteAuditService();
    const result: SyncRpcResult = {
      status: 'deleted-remote-newer',
      raw: {},
      remoteUpdatedAt: '2026-06-16T01:30:00.000Z',
    };

    service.recordTaskDeleteRpcWriteAudit({
      operationId: 'op-delete-rpc-rejected',
      sourceUserId: 'user-1',
      taskIds: ['task-rpc-rejected'],
      result,
      localTimestamp: 1781550000000,
      baseUpdatedAtMap: { 'task-rpc-rejected': '2026-06-16T01:00:00.000Z' },
      queuedTaskIds: ['task-rpc-rejected'],
      lastSyncTimeBefore: '2026-06-16T00:00:00.000Z',
      lastSyncTimeAfter: '2026-06-16T02:00:00.000Z',
    });

    const audit = new DataSafetyAuditPersistence().load('user-1');
    expect(audit.lastWriteExplain).toMatchObject({
      operationId: 'op-delete-rpc-rejected',
      actor: { sourceUserId: 'user-1' },
      entity: { type: 'task', id: 'task-rpc-rejected' },
      operation: 'delete',
      updatedAtBaseline: '2026-06-16T01:00:00.000Z',
      queueResult: { enteredRetryQueue: true, retryCount: 1 },
      rpcResult: {
        status: 'deleted-remote-newer',
        remoteUpdatedAt: '2026-06-16T01:30:00.000Z',
      },
      lwwDecision: { decision: 'remote-kept', reason: 'deleted-remote-newer' },
      lastSyncTime: {
        before: '2026-06-16T00:00:00.000Z',
        after: '2026-06-16T02:00:00.000Z',
        advanced: true,
      },
    });
  });
});
