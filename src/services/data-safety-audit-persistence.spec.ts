import { beforeEach, describe, expect, it } from 'vitest';
import { DataSafetyAuditLog } from './data-safety-audit-log';
import { DataSafetyAuditPersistence } from './data-safety-audit-persistence';

describe('DataSafetyAuditPersistence', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('persists and restores bounded replay log plus latest write explanation by owner', () => {
    const log = new DataSafetyAuditLog({ maxEntries: 3 });
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
      lastSyncTimeBefore: null,
      lastSyncTimeAfter: '2026-06-16T00:00:01.000Z',
    });

    const persistence = new DataSafetyAuditPersistence();
    persistence.save('user-1', log.snapshot());

    const restored = persistence.load('user-1');
    expect(restored.replayLog.map(entry => entry.operationId)).toEqual(['op-1']);
    expect(restored.lastWriteExplain?.operationId).toBe('op-1');
    expect(restored.lastWriteExplain?.lastSyncTime.advanced).toBe(true);
    expect(persistence.load('user-2')).toEqual({ replayLog: [], lastWriteExplain: null });
  });

  it('returns an empty snapshot for malformed persisted data', () => {
    localStorage.setItem('nanoflow.data-safety-audit.user-1', '{bad-json');

    const persistence = new DataSafetyAuditPersistence();

    expect(persistence.load('user-1')).toEqual({ replayLog: [], lastWriteExplain: null });
  });

  it('trims replay log on save to the configured maximum', () => {
    const persistence = new DataSafetyAuditPersistence({ maxEntries: 1 });

    persistence.save('user-1', {
      replayLog: [
        {
          operationId: 'op-1',
          entityType: 'task',
          entityId: 'task-1',
          operation: 'upsert',
          sourceUserId: 'user-1',
          localCommittedAt: 1781539200000,
          queue: { enteredRetryQueue: false, retryCount: 0 },
          rpc: { status: 'applied' },
          lww: { decision: 'local-applied', reason: 'applied' },
          lastSyncTime: { before: null, after: '2026-06-16T00:00:01.000Z', advanced: true },
        },
        {
          operationId: 'op-2',
          entityType: 'task',
          entityId: 'task-2',
          operation: 'upsert',
          sourceUserId: 'user-1',
          localCommittedAt: 1781539300000,
          queue: { enteredRetryQueue: true, retryCount: 1 },
          rpc: { status: 'remote-newer' },
          lww: { decision: 'remote-kept', reason: 'remote-newer' },
          lastSyncTime: { before: null, after: null, advanced: false },
        },
      ],
      lastWriteExplain: null,
    });

    expect(persistence.load('user-1').replayLog.map(entry => entry.operationId)).toEqual(['op-2']);
  });
});
