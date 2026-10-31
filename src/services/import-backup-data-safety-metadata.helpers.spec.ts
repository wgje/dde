import { describe, expect, it, vi } from 'vitest';
import type { BackupData } from '../../supabase/functions/_shared/backup-utils';
import {
  buildDataSafetyMetadataRestorePlan,
  restoreDataSafetyMetadataFromBackup,
} from './import-backup-data-safety-metadata.helpers';

describe('buildDataSafetyMetadataRestorePlan', () => {
  function createReplayEntry(operationId: string, localCommittedAt: number) {
    return {
      operationId,
      entityType: 'task',
      entityId: `task-${operationId}`,
      operation: 'upsert',
      sourceUserId: 'user-1',
      localCommittedAt,
      baseUpdatedAt: '2026-06-18T00:00:20.000Z',
      queue: { enteredRetryQueue: false, retryCount: 0 },
      rpc: { status: 'success' },
      lww: { decision: 'local-won', reason: 'newer-local-write' },
      lastSyncTime: {
        before: null,
        after: '2026-06-18T00:00:20.000Z',
        advanced: true,
      },
    };
  }

  function createMetadataBackup(overrides: {
    replayLog?: ReturnType<typeof createReplayEntry>[];
    replayPlanOwnerUserId?: string;
  } = {}): BackupData {
    const replayLog = overrides.replayLog ?? [createReplayEntry('op-incoming', 20)];
    return {
      projects: [{ id: 'project-1', userId: 'user-1' }],
      tasks: [],
      connections: [],
      localState: {
        taskTombstones: { 'project-1': { 'task-deleted': 20 } },
        connectionTombstones: [{
          projectId: 'project-1',
          connectionId: 'connection-deleted',
          timestamp: 20,
        }],
        dataSafety: {
          schemaVersion: '1.0.0',
          exportedAt: '2026-06-18T00:00:20.000Z',
          ownerUserId: 'user-1',
          syncSnapshot: {
            syncState: {
              lastSyncTime: '2026-06-18T00:00:20.000Z',
              pendingCount: 0,
            },
            projectCursors: [{
              projectId: 'project-1',
              userId: 'user-1',
              cursor: {
                updatedAt: '2026-06-18T00:00:20.000Z',
                entityType: 'task',
                id: 'task-1',
              },
            }],
            queueCounts: { retryQueue: 0, actionQueue: 0, deadLetters: 0 },
          },
          replayLog,
          replayPlan: {
            idempotencyKey: 'restore-plan-1',
            ownerUserId: overrides.replayPlanOwnerUserId ?? 'user-1',
            exportedAt: '2026-06-18T00:00:20.000Z',
            steps: [],
            summary: {
              replayable: 0,
              inspectOnly: 0,
              retryQueue: 0,
              actionQueue: 0,
              auditLog: replayLog.length,
            },
          },
          lastWriteExplain: {
            operationId: 'op-incoming',
            actor: { sourceUserId: 'user-1' },
            entity: { type: 'task', id: 'task-1' },
            operation: 'upsert',
            localTimestamp: 20,
            queueResult: { enteredRetryQueue: false, retryCount: 0 },
            rpcResult: { status: 'success' },
            lwwDecision: { decision: 'local-won', reason: 'newer-local-write' },
            lastSyncTime: {
              before: null,
              after: '2026-06-18T00:00:20.000Z',
              advanced: true,
            },
          },
        },
      },
    } as unknown as BackupData;
  }

  function createEmptyMetadataState() {
    return {
      projectCursors: [],
      lastSyncTime: null,
      replayLog: [],
      lastWriteExplain: null,
      taskTombstones: {},
      connectionTombstones: [],
    };
  }

  it('merges owner-scoped cursors, audit history, and tombstones without regressing newer local state', () => {
    const incomingReplayEntry = {
      operationId: 'op-incoming',
      entityType: 'task',
      entityId: 'task-1',
      operation: 'upsert',
      sourceUserId: 'user-1',
      localCommittedAt: 20,
      baseUpdatedAt: '2026-06-18T00:00:20.000Z',
      queue: { enteredRetryQueue: false, retryCount: 0 },
      rpc: { status: 'success' },
      lww: { decision: 'local-won', reason: 'newer-local-write' },
      lastSyncTime: {
        before: '2026-06-18T00:00:10.000Z',
        after: '2026-06-18T00:00:20.000Z',
        advanced: true,
      },
    };
    const backup = {
      projects: [{ id: 'project-1', userId: 'user-1' }],
      tasks: [],
      connections: [],
      localState: {
        taskTombstones: {
          'project-1': {
            'task-deleted': 20,
          },
        },
        connectionTombstones: [{
          projectId: 'project-1',
          connectionId: 'connection-deleted',
          timestamp: 20,
        }],
        dataSafety: {
          schemaVersion: '1.0.0',
          exportedAt: '2026-06-18T00:00:20.000Z',
          ownerUserId: 'user-1',
          syncSnapshot: {
            syncState: {
              lastSyncTime: '2026-06-18T00:00:20.000Z',
              pendingCount: 0,
            },
            projectCursors: [{
              projectId: 'project-1',
              userId: 'user-1',
              cursor: {
                updatedAt: '2026-06-18T00:00:20.000Z',
                entityType: 'task',
                id: 'task-1',
              },
            }],
            queueCounts: { retryQueue: 0, actionQueue: 0, deadLetters: 0 },
          },
          replayLog: [incomingReplayEntry],
          replayPlan: {
            idempotencyKey: 'restore-plan-1',
            ownerUserId: 'user-1',
            exportedAt: '2026-06-18T00:00:20.000Z',
            steps: [],
            summary: {
              replayable: 0,
              inspectOnly: 0,
              retryQueue: 0,
              actionQueue: 0,
              auditLog: 1,
            },
          },
          lastWriteExplain: {
            operationId: 'op-incoming',
            actor: { sourceUserId: 'user-1' },
            entity: { type: 'task', id: 'task-1' },
            operation: 'upsert',
            localTimestamp: 20,
            updatedAtBaseline: '2026-06-18T00:00:20.000Z',
            beforeVersion: 'v1',
            afterVersion: 'v2',
            queueResult: { enteredRetryQueue: false, retryCount: 0 },
            rpcResult: { status: 'success' },
            lwwDecision: { decision: 'local-won', reason: 'newer-local-write' },
            lastSyncTime: {
              before: '2026-06-18T00:00:10.000Z',
              after: '2026-06-18T00:00:20.000Z',
              advanced: true,
            },
          },
        },
      },
    } as unknown as BackupData;
    const currentReplayEntry = {
      ...incomingReplayEntry,
      operationId: 'op-current',
      entityId: 'task-current',
      localCommittedAt: 15,
    };

    const plan = buildDataSafetyMetadataRestorePlan(backup, 'user-1', {
      projectCursors: [{
        projectId: 'project-1',
        userId: 'user-1',
        cursor: {
          updatedAt: '2026-06-18T00:00:10.000Z',
          entityType: 'project',
          id: 'project-1',
        },
      }],
      lastSyncTime: '2026-06-18T00:00:10.000Z',
      replayLog: [currentReplayEntry],
      lastWriteExplain: null,
      taskTombstones: {
        'project-1': {
          'task-deleted': 10,
          'task-current': 15,
        },
      },
      connectionTombstones: [{
        projectId: 'project-1',
        connectionId: 'connection-deleted',
        timestamp: 10,
      }],
    });

    expect(plan.counts).toEqual({
      projectCursors: 1,
      lastSyncTime: 1,
      replayLog: 1,
      lastWriteExplain: 1,
      taskTombstones: 1,
      connectionTombstones: 1,
    });
    expect(plan.target.projectCursors[0]?.cursor).toEqual(expect.objectContaining({
      updatedAt: '2026-06-18T00:00:20.000Z',
      entityType: 'task',
      id: 'task-1',
    }));
    expect(plan.target.replayLog.map(entry => entry.operationId)).toEqual([
      'op-current',
      'op-incoming',
    ]);
    expect(plan.target.lastWriteExplain?.operationId).toBe('op-incoming');
    expect(plan.target.taskTombstones).toEqual({
      'project-1': {
        'task-deleted': 20,
        'task-current': 15,
      },
    });
    expect(plan.target.connectionTombstones).toEqual([{
      projectId: 'project-1',
      connectionId: 'connection-deleted',
      timestamp: 20,
    }]);
  });

  it('is idempotent when the same metadata is restored from a freshly parsed package', () => {
    const first = buildDataSafetyMetadataRestorePlan(
      createMetadataBackup(),
      'user-1',
      createEmptyMetadataState(),
    );
    const reparsedBackup = JSON.parse(JSON.stringify(createMetadataBackup())) as BackupData;

    const second = buildDataSafetyMetadataRestorePlan(reparsedBackup, 'user-1', first.target);

    expect(second.counts).toEqual({
      projectCursors: 0,
      lastSyncTime: 0,
      replayLog: 0,
      lastWriteExplain: 0,
      taskTombstones: 0,
      connectionTombstones: 0,
    });
  });

  it('keeps only the latest 100 replay entries after merging current and incoming audit history', () => {
    const currentReplayLog = Array.from({ length: 100 }, (_, index) =>
      createReplayEntry(`op-${index.toString().padStart(3, '0')}`, index));
    const backup = createMetadataBackup({
      replayLog: [createReplayEntry('op-100', 100)],
    });

    const plan = buildDataSafetyMetadataRestorePlan(backup, 'user-1', {
      ...createEmptyMetadataState(),
      replayLog: currentReplayLog,
    });

    expect(plan.target.replayLog).toHaveLength(100);
    expect(plan.target.replayLog[0]?.operationId).toBe('op-001');
    expect(plan.target.replayLog.at(-1)?.operationId).toBe('op-100');
    expect(plan.counts.replayLog).toBe(1);
  });

  it('rejects a replay plan owned by another account before producing a restore target', () => {
    const backup = createMetadataBackup({ replayPlanOwnerUserId: 'user-2' });

    expect(() => buildDataSafetyMetadataRestorePlan(
      backup,
      'user-1',
      createEmptyMetadataState(),
    )).toThrow('replayPlan.ownerUserId does not match restore owner');
  });
});

describe('restoreDataSafetyMetadataFromBackup', () => {
  it('reads current metadata and delegates one atomic replacement with the validated merge target', async () => {
    const backup = {
      projects: [{ id: 'project-1', userId: 'user-1' }],
      tasks: [],
      connections: [],
      localState: {
        dataSafety: {
          schemaVersion: '1.0.0',
          exportedAt: '2026-06-18T00:00:20.000Z',
          ownerUserId: 'user-1',
          syncSnapshot: {
            syncState: { lastSyncTime: null, pendingCount: 0 },
            projectCursors: [],
            queueCounts: { retryQueue: 0, actionQueue: 0, deadLetters: 0 },
          },
          replayLog: [],
          replayPlan: {
            idempotencyKey: 'restore-plan-1',
            ownerUserId: 'user-1',
            exportedAt: '2026-06-18T00:00:20.000Z',
            steps: [],
            summary: {
              replayable: 0,
              inspectOnly: 0,
              retryQueue: 0,
              actionQueue: 0,
              auditLog: 0,
            },
          },
          lastWriteExplain: null,
        },
      },
    } as unknown as BackupData;
    const current = {
      projectCursors: [],
      lastSyncTime: null,
      replayLog: [],
      lastWriteExplain: null,
      taskTombstones: {},
      connectionTombstones: [],
    };
    const adapter = {
      readCurrent: vi.fn().mockResolvedValue(current),
      replaceAtomically: vi.fn().mockResolvedValue(undefined),
    };

    const counts = await restoreDataSafetyMetadataFromBackup(backup, 'user-1', adapter);

    expect(adapter.readCurrent).toHaveBeenCalledWith('user-1', new Set(['project-1']));
    expect(adapter.replaceAtomically).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({
        projectCursors: [],
        replayLog: [],
        taskTombstones: {},
      }),
      current,
    );
    expect(counts).toEqual({
      projectCursors: 0,
      lastSyncTime: 0,
      replayLog: 0,
      lastWriteExplain: 0,
      taskTombstones: 0,
      connectionTombstones: 0,
    });
  });
});
