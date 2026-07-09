import { describe, expect, it } from 'vitest';
import {
  buildDataSafetyExportPackage,
  buildLastWriteExplain,
  buildReplayPlan,
  buildRestorePlan,
  summarizeReplayableActions,
  validateDataSafetyExportPackage,
  type DataSafetyExportPackage,
} from './data-safety-package';

function makePackage(overrides: Partial<DataSafetyExportPackage> = {}): DataSafetyExportPackage {
  const pkg = buildDataSafetyExportPackage({
    exportedAt: '2026-06-16T00:00:00.000Z',
    ownerUserId: 'user-1',
    app: {
      appVersion: '1.0.0',
      syncProtocolVersion: 1,
      deploymentEpoch: 0,
    },
    localData: {
      projects: [{ id: 'project-1', name: 'P1' }],
      tasks: [{ id: 'task-1', projectId: 'project-1', content: 'keep content', updatedAt: '2026-06-16T00:00:00.000Z' }],
      connections: [{ id: 'connection-1', projectId: 'project-1', source: 'task-1', target: 'task-1' }],
      syncCursors: [{ key: 'project:user-1:project-1', cursor: { updatedAt: '2026-06-16T00:00:00.000Z', entityType: 'task', id: 'task-1' } }],
      meta: { activeProjectId: 'project-1' },
    },
    localState: {
      retryQueue: [
        {
          id: 'retry-1',
          operationId: 'op-1',
          type: 'task',
          operation: 'upsert',
          data: { id: 'task-1', updatedAt: '2026-06-16T00:00:00.000Z' },
          retryCount: 0,
          createdAt: 1781539200000,
          sourceUserId: 'user-1',
          projectId: 'project-1',
          writeIntent: 'task_text_update',
        },
      ],
      actionQueue: [],
      deadLetters: [],
      conflicts: [],
      taskTombstones: {},
      connectionTombstones: [],
    },
    syncSnapshot: {
      syncState: {
        isSyncing: false,
        isOnline: true,
        offlineMode: false,
        sessionExpired: false,
        lastSyncTime: '2026-06-16T00:00:00.000Z',
        pendingCount: 1,
        syncError: null,
        backgroundSyncNotice: null,
        hasConflict: false,
        conflictData: null,
      },
      projectCursors: [{ projectId: 'project-1', userId: 'user-1', cursor: { updatedAt: '2026-06-16T00:00:00.000Z', entityType: 'task', id: 'task-1' } }],
      queueCounts: { retryQueue: 1, actionQueue: 0, deadLetters: 0 },
    },
    replayLog: [
      {
        operationId: 'op-1',
        entityType: 'task',
        entityId: 'task-1',
        operation: 'upsert',
        sourceUserId: 'user-1',
        localCommittedAt: 1781539200000,
        baseUpdatedAt: '2026-06-15T23:59:00.000Z',
        queue: { enteredRetryQueue: true, retryCount: 0 },
        rpc: { status: 'remote-newer', remoteUpdatedAt: '2026-06-16T00:01:00.000Z' },
        lww: { decision: 'remote-kept', reason: 'remote-newer' },
        lastSyncTime: { before: '2026-06-15T23:58:00.000Z', after: '2026-06-15T23:58:00.000Z', advanced: false },
      },
    ],
    lastWriteExplain: {
      operationId: 'op-1',
      actor: { sourceUserId: 'user-1' },
      entity: { type: 'task', id: 'task-1' },
      operation: 'upsert',
      localTimestamp: 1781539200000,
      updatedAtBaseline: '2026-06-15T23:59:00.000Z',
      beforeVersion: '2026-06-15T23:59:00.000Z',
      afterVersion: '2026-06-16T00:01:00.000Z',
      queueResult: { enteredRetryQueue: true, retryCount: 0 },
      rpcResult: { status: 'remote-newer', remoteUpdatedAt: '2026-06-16T00:01:00.000Z' },
      lwwDecision: { decision: 'remote-kept', reason: 'remote-newer' },
      lastSyncTime: { before: '2026-06-15T23:58:00.000Z', after: '2026-06-15T23:58:00.000Z', advanced: false },
    },
  });

  return {
    ...pkg,
    ...overrides,
  };
}

describe('data safety export package', () => {
  it('builds an exportable package with local data, cursors, queues, replay log, and last write explain', () => {
    const pkg = buildDataSafetyExportPackage({
      exportedAt: '2026-06-16T00:00:00.000Z',
      ownerUserId: 'user-1',
      app: { appVersion: '1.0.0', syncProtocolVersion: 1, deploymentEpoch: 0 },
      localData: makePackage().localData,
      localState: makePackage().localState,
      syncSnapshot: makePackage().syncSnapshot,
      replayLog: makePackage().replayLog,
      lastWriteExplain: makePackage().lastWriteExplain,
    });

    expect(pkg.schemaVersion).toBe('1.0.0');
    expect(pkg.localData.tasks[0]).toMatchObject({ id: 'task-1', content: 'keep content' });
    expect(pkg.localData.syncCursors).toHaveLength(1);
    expect(pkg.localState.retryQueue).toHaveLength(1);
    expect(pkg.replayLog[0].lww.decision).toBe('remote-kept');
    expect(pkg.replayPlan.steps.map(step => `${step.source}:${step.operationId}`)).toEqual([
      'auditLog:op-1',
      'retryQueue:op-1',
    ]);
    expect(pkg.lastWriteExplain?.lastSyncTime.advanced).toBe(false);
    expect(pkg.integrity.tableCounts).toMatchObject({ tasks: 1, retryQueue: 1 });
    expect(pkg.integrity.checksum).toMatch(/^[a-f0-9]{64}$/);
  });

  it('rejects invalid import packages before restore', () => {
    expect(validateDataSafetyExportPackage({ schemaVersion: '1.0.0' }).valid).toBe(false);
    expect(validateDataSafetyExportPackage(makePackage()).valid).toBe(true);
    expect(
      validateDataSafetyExportPackage(makePackage({ ownerUserId: '' })).errors,
    ).toContain('ownerUserId is required');
  });

  it('rejects packages whose integrity checksum no longer matches the payload', () => {
    const pkg = buildDataSafetyExportPackage({
      exportedAt: '2026-06-16T00:00:00.000Z',
      ownerUserId: 'user-1',
      app: makePackage().app,
      localData: makePackage().localData,
      localState: makePackage().localState,
      syncSnapshot: makePackage().syncSnapshot,
      replayLog: makePackage().replayLog,
      lastWriteExplain: makePackage().lastWriteExplain,
    });
    const tampered: DataSafetyExportPackage = {
      ...pkg,
      localData: {
        ...pkg.localData,
        tasks: [{ ...pkg.localData.tasks[0], content: 'tampered after export' }],
      },
    };

    expect(validateDataSafetyExportPackage(tampered).errors).toContain('integrity.checksum does not match package contents');
  });

  it('rejects packages missing a replay plan before restore', () => {
    const { replayPlan: _replayPlan, ...withoutReplayPlan } = makePackage();

    expect(validateDataSafetyExportPackage(withoutReplayPlan).errors).toContain('replayPlan is required');
  });

  it('builds an idempotent restore plan without ID remapping', () => {
    const pkg = makePackage();
    const plan = buildRestorePlan(pkg, {
      projects: pkg.localData.projects,
      tasks: pkg.localData.tasks,
      connections: pkg.localData.connections,
      syncCursors: pkg.localData.syncCursors,
    });

    expect(plan.idRemappingRequired).toBe(false);
    expect(plan.operations).toEqual([
      { store: 'projects', action: 'skip', id: 'project-1' },
      { store: 'tasks', action: 'skip', id: 'task-1' },
      { store: 'connections', action: 'skip', id: 'connection-1' },
      { store: 'syncCursors', action: 'skip', id: 'project:user-1:project-1' },
    ]);
    expect(plan.summary).toMatchObject({ writes: 0, skips: 4, deletes: 0 });
  });

  it('summarizes pending and recent sync actions for deterministic replay inspection', () => {
    const summary = summarizeReplayableActions(makePackage());

    expect(summary.pendingOperations).toEqual(['op-1']);
    expect(summary.recentOperations).toEqual(['op-1']);
    expect(summary.byEntity.task).toBe(1);
    expect(summary.retryQueueOperations).toEqual(['op-1']);
  });

  it('builds a deterministic replay plan from pending queues and recent audit entries', () => {
    const base = makePackage();
    const pkg = buildDataSafetyExportPackage({
      exportedAt: base.exportedAt,
      ownerUserId: base.ownerUserId,
      app: base.app,
      localData: base.localData,
      localState: {
        ...base.localState,
        retryQueue: [
          {
            id: 'retry-newer',
            operationId: 'op-retry-newer',
            type: 'task',
            operation: 'upsert',
            data: { id: 'task-1', updatedAt: '2026-06-16T00:05:00.000Z' },
            retryCount: 1,
            createdAt: 1781539500000,
            sourceUserId: 'user-1',
            projectId: 'project-1',
          },
          {
            id: 'retry-older',
            operationId: 'op-retry-older',
            type: 'connection',
            operation: 'delete',
            data: { id: 'connection-1', updatedAt: '2026-06-16T00:04:00.000Z' },
            retryCount: 0,
            createdAt: 1781539400000,
            sourceUserId: 'user-1',
            projectId: 'project-1',
          },
        ],
        actionQueue: [
          {
            id: 'action-1',
            operationId: 'op-action-1',
            entityType: 'project',
            entityId: 'project-1',
            type: 'update',
            timestamp: 1781539300000,
          },
        ],
      },
      syncSnapshot: base.syncSnapshot,
      replayLog: [
        {
          operationId: 'op-audit-1',
          entityType: 'task',
          entityId: 'task-1',
          operation: 'upsert',
          sourceUserId: 'user-1',
          localCommittedAt: 1781539200000,
          baseUpdatedAt: '2026-06-15T23:59:00.000Z',
          queue: { enteredRetryQueue: false, retryCount: 0 },
          rpc: { status: 'applied', serverUpdatedAt: '2026-06-16T00:00:01.000Z' },
          lww: { decision: 'local-applied', reason: 'applied' },
          lastSyncTime: { before: null, after: '2026-06-16T00:00:01.000Z', advanced: true },
        },
      ],
      lastWriteExplain: base.lastWriteExplain,
    });

    const plan = buildReplayPlan(pkg);

    expect(plan.idempotencyKey).toMatch(/^[a-f0-9]{64}$/);
    expect(plan.summary).toEqual({
      replayable: 3,
      inspectOnly: 1,
      retryQueue: 2,
      actionQueue: 1,
      auditLog: 1,
    });
    expect(plan.steps.map(step => `${step.source}:${step.operationId}`)).toEqual([
      'auditLog:op-audit-1',
      'actionQueue:op-action-1',
      'retryQueue:op-retry-older',
      'retryQueue:op-retry-newer',
    ]);
    expect(plan.steps[0]).toMatchObject({
      source: 'auditLog',
      replayable: false,
      reason: 'recent-audit-inspection-only',
      entityType: 'task',
      entityId: 'task-1',
      localTimestamp: 1781539200000,
      lww: { decision: 'local-applied', reason: 'applied' },
    });
    expect(plan.steps[2]).toMatchObject({
      source: 'retryQueue',
      replayable: true,
      reason: 'retry-queue-restored',
      entityType: 'connection',
      entityId: 'connection-1',
      operation: 'delete',
      retryCount: 0,
      updatedAtBaseline: '2026-06-16T00:04:00.000Z',
    });
  });

  it('explains an LWW remote-newer write including RetryQueue and lastSyncTime effects', () => {
    const explain = buildLastWriteExplain({
      operationId: 'op-2',
      sourceUserId: 'user-1',
      entityType: 'task',
      entityId: 'task-2',
      operation: 'upsert',
      localTimestamp: 1781539300000,
      updatedAtBaseline: '2026-06-16T00:00:00.000Z',
      beforeVersion: '2026-06-16T00:00:00.000Z',
      rpcResult: { status: 'remote-newer', remoteUpdatedAt: '2026-06-16T00:02:00.000Z' },
      enteredRetryQueue: true,
      retryCount: 1,
      lastSyncTimeBefore: '2026-06-16T00:00:30.000Z',
      lastSyncTimeAfter: '2026-06-16T00:00:30.000Z',
    });

    expect(explain.afterVersion).toBe('2026-06-16T00:02:00.000Z');
    expect(explain.queueResult.enteredRetryQueue).toBe(true);
    expect(explain.rpcResult.status).toBe('remote-newer');
    expect(explain.lwwDecision).toEqual({ decision: 'remote-kept', reason: 'remote-newer' });
    expect(explain.lastSyncTime).toEqual({
      before: '2026-06-16T00:00:30.000Z',
      after: '2026-06-16T00:00:30.000Z',
      advanced: false,
    });
  });
});
