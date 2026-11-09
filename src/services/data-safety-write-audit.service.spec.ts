import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DataSafetyAuditPersistence } from './data-safety-audit-persistence';
import { DataSafetyWriteAuditService } from './data-safety-write-audit.service';

describe('DataSafetyWriteAuditService', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('records latest write explain and replay log to owner-scoped persistence', () => {
    const persistence = new DataSafetyAuditPersistence();
    const service = new DataSafetyWriteAuditService({ persistence, maxEntries: 3 });

    const explain = service.recordWrite({
      ownerUserId: 'user-1',
      operationId: 'op-1',
      sourceUserId: 'user-1',
      entityType: 'task',
      entityId: 'task-1',
      operation: 'upsert',
      localTimestamp: 1781539200000,
      updatedAtBaseline: '2026-06-16T00:00:00.000Z',
      beforeVersion: '2026-06-16T00:00:00.000Z',
      rpcResult: { status: 'remote-newer', remoteUpdatedAt: '2026-06-16T00:00:02.000Z' },
      enteredRetryQueue: true,
      retryCount: 1,
      lastSyncTimeBefore: '2026-06-16T00:00:01.000Z',
      lastSyncTimeAfter: '2026-06-16T00:00:01.000Z',
    });

    expect(explain.operationId).toBe('op-1');
    const persisted = persistence.load('user-1');
    expect(persisted.replayLog.map(entry => entry.operationId)).toEqual(['op-1']);
    expect(persisted.lastWriteExplain?.lwwDecision).toEqual({ decision: 'remote-kept', reason: 'remote-newer' });
  });

  it('hydrates existing owner log before appending a new write', () => {
    const persistence = new DataSafetyAuditPersistence();
    const service = new DataSafetyWriteAuditService({ persistence, maxEntries: 3 });

    service.recordWrite({
      ownerUserId: 'user-1',
      operationId: 'op-1',
      entityType: 'task',
      entityId: 'task-1',
      operation: 'upsert',
      localTimestamp: 1781539200000,
      rpcResult: { status: 'applied' },
      enteredRetryQueue: false,
      retryCount: 0,
      lastSyncTimeBefore: null,
      lastSyncTimeAfter: '2026-06-16T00:00:01.000Z',
    });
    service.recordWrite({
      ownerUserId: 'user-1',
      operationId: 'op-2',
      entityType: 'connection',
      entityId: 'connection-1',
      operation: 'upsert',
      localTimestamp: 1781539300000,
      rpcResult: { status: 'unauthorized' },
      enteredRetryQueue: true,
      retryCount: 0,
      lastSyncTimeBefore: '2026-06-16T00:00:01.000Z',
      lastSyncTimeAfter: '2026-06-16T00:00:01.000Z',
    });

    expect(persistence.load('user-1').replayLog.map(entry => entry.operationId)).toEqual(['op-1', 'op-2']);
  });

  it('does not persist when owner is unavailable', () => {
    const persistence = new DataSafetyAuditPersistence();
    const service = new DataSafetyWriteAuditService({ persistence });

    service.recordWrite({
      ownerUserId: null,
      operationId: 'op-1',
      entityType: 'task',
      entityId: 'task-1',
      operation: 'upsert',
      localTimestamp: 1781539200000,
      rpcResult: { status: 'applied' },
      enteredRetryQueue: false,
      retryCount: 0,
      lastSyncTimeBefore: null,
      lastSyncTimeAfter: null,
    });

    expect(localStorage.length).toBe(0);
  });

  it('reports owner-scoped persistence failure without rejecting the completed write', () => {
    const onPersistenceFailure = vi.fn();
    const persistence = {
      load: vi.fn(() => ({ replayLog: [], lastWriteExplain: null })),
      save: vi.fn(() => false),
    } as unknown as DataSafetyAuditPersistence;
    const service = new DataSafetyWriteAuditService({
      persistence,
      onPersistenceFailure,
    });

    const explain = service.recordWrite({
      ownerUserId: 'user-1',
      operationId: 'op-persistence-failed',
      entityType: 'task',
      entityId: 'task-1',
      operation: 'upsert',
      localTimestamp: 1781539200000,
      rpcResult: { status: 'applied' },
      enteredRetryQueue: false,
      retryCount: 0,
      lastSyncTimeBefore: null,
      lastSyncTimeAfter: null,
    });

    expect(explain.operationId).toBe('op-persistence-failed');
    expect(onPersistenceFailure).toHaveBeenCalledWith({
      ownerUserId: 'user-1',
      operationId: 'op-persistence-failed',
    });
  });
});
