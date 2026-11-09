import { describe, expect, it } from 'vitest';
import { DataSafetyAuditLog } from './data-safety-audit-log';

describe('DataSafetyAuditLog', () => {
  it('keeps a bounded replay log and exposes the latest write explanation', () => {
    const log = new DataSafetyAuditLog({ maxEntries: 2 });

    log.recordWrite({
      operationId: 'op-1',
      sourceUserId: 'user-1',
      entityType: 'task',
      entityId: 'task-1',
      operation: 'upsert',
      localTimestamp: 1781539200000,
      updatedAtBaseline: '2026-06-16T00:00:00.000Z',
      beforeVersion: '2026-06-16T00:00:00.000Z',
      rpcResult: { status: 'applied', serverUpdatedAt: '2026-06-16T00:00:01.000Z' },
      enteredRetryQueue: false,
      retryCount: 0,
      lastSyncTimeBefore: '2026-06-16T00:00:00.000Z',
      lastSyncTimeAfter: '2026-06-16T00:00:01.000Z',
    });
    log.recordWrite({
      operationId: 'op-2',
      sourceUserId: 'user-1',
      entityType: 'task',
      entityId: 'task-2',
      operation: 'upsert',
      writeIntent: 'task_text_update',
      localTimestamp: 1781539300000,
      updatedAtBaseline: '2026-06-16T00:00:02.000Z',
      beforeVersion: '2026-06-16T00:00:02.000Z',
      rpcResult: { status: 'remote-newer', remoteUpdatedAt: '2026-06-16T00:00:03.000Z' },
      enteredRetryQueue: true,
      retryCount: 1,
      lastSyncTimeBefore: '2026-06-16T00:00:01.000Z',
      lastSyncTimeAfter: '2026-06-16T00:00:01.000Z',
    });
    log.recordWrite({
      operationId: 'op-3',
      sourceUserId: 'user-1',
      entityType: 'connection',
      entityId: 'connection-1',
      operation: 'upsert',
      localTimestamp: 1781539400000,
      updatedAtBaseline: null,
      beforeVersion: null,
      rpcResult: { status: 'unauthorized', reason: 'session_expired' },
      enteredRetryQueue: true,
      retryCount: 0,
      lastSyncTimeBefore: '2026-06-16T00:00:01.000Z',
      lastSyncTimeAfter: '2026-06-16T00:00:01.000Z',
    });

    expect(log.replayLog.map(entry => entry.operationId)).toEqual(['op-2', 'op-3']);
    expect(log.lastWriteExplain?.operationId).toBe('op-3');
    expect(log.lastWriteExplain?.lwwDecision).toEqual({ decision: 'blocked', reason: 'unauthorized' });
    expect(log.replayLog[0].lastSyncTime.advanced).toBe(false);
    expect(log.replayLog[0].writeIntent).toBe('task_text_update');
  });

  it('can hydrate from persisted replay entries and latest explanation', () => {
    const log = new DataSafetyAuditLog({ maxEntries: 3 });

    log.hydrate({
      replayLog: [
        {
          operationId: 'op-1',
          entityType: 'task',
          entityId: 'task-1',
          operation: 'upsert',
          sourceUserId: 'user-1',
          localCommittedAt: 1781539200000,
          queue: { enteredRetryQueue: false, retryCount: 0 },
          rpc: { status: 'applied', serverUpdatedAt: '2026-06-16T00:00:01.000Z' },
          lww: { decision: 'local-applied', reason: 'applied' },
          lastSyncTime: { before: null, after: '2026-06-16T00:00:01.000Z', advanced: true },
        },
      ],
      lastWriteExplain: null,
    });

    expect(log.replayLog).toHaveLength(1);
    expect(log.lastWriteExplain).toBeNull();
  });

  it('preserves both local and remote snapshots for unresolved remote-newer conflicts', () => {
    const log = new DataSafetyAuditLog({ maxEntries: 3 });
    const localSnapshot = {
      id: 'task-1',
      content: 'local offline edit',
      updatedAt: '2026-06-16T00:00:00.000Z',
    };
    const remoteSnapshot = {
      id: 'task-1',
      content: 'remote concurrent edit',
      updatedAt: '2026-06-16T00:00:05.000Z',
    };

    log.recordWrite({
      operationId: 'op-conflict-1',
      sourceUserId: 'user-1',
      entityType: 'task',
      entityId: 'task-1',
      operation: 'upsert',
      localTimestamp: 1781539200000,
      updatedAtBaseline: '2026-06-16T00:00:00.000Z',
      beforeVersion: '2026-06-16T00:00:00.000Z',
      rpcResult: { status: 'remote-newer', remoteUpdatedAt: '2026-06-16T00:00:05.000Z' },
      enteredRetryQueue: true,
      retryCount: 1,
      lastSyncTimeBefore: '2026-06-16T00:00:01.000Z',
      lastSyncTimeAfter: '2026-06-16T00:00:01.000Z',
      conflict: {
        status: 'conflict-detected',
        reason: 'remote-newer',
        localSnapshot,
        remoteSnapshot,
      },
    });

    expect(log.replayLog[0].conflict).toEqual({
      status: 'conflict-detected',
      reason: 'remote-newer',
      localSnapshot,
      remoteSnapshot,
    });
    expect(log.lastWriteExplain?.conflict).toEqual({
      status: 'conflict-detected',
      reason: 'remote-newer',
      localSnapshot,
      remoteSnapshot,
    });
  });
});
