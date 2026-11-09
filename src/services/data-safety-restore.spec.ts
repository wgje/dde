import { describe, expect, it } from 'vitest';
import { buildDataSafetyExportPackage, type DataSafetyExportPackage } from './data-safety-package';
import { restoreDataSafetyPackage } from './data-safety-restore';

function makePackage(): DataSafetyExportPackage {
  const task = {
    id: 'task-1',
    title: 'Task 1',
    content: 'content survives restore',
    stage: 1,
    parentId: null,
    order: 0,
    rank: 1,
    status: 'active' as const,
    x: 0,
    y: 0,
    createdDate: '2026-06-16T00:00:00.000Z',
    updatedAt: '2026-06-16T00:00:00.000Z',
  };
  return buildDataSafetyExportPackage({
    exportedAt: '2026-06-16T00:00:00.000Z',
    ownerUserId: 'user-1',
    app: { appVersion: '1.0.0', syncProtocolVersion: 1, deploymentEpoch: 0 },
    localData: {
      projects: [{ id: 'project-1', name: 'P1' }],
      tasks: [{ ...task, projectId: 'project-1' }],
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
          data: task,
          retryCount: 0,
          createdAt: 1781539200000,
          sourceUserId: 'user-1',
          projectId: 'project-1',
        },
      ],
      actionQueue: [{
        id: 'action-1',
        operationId: 'op-2',
        entityType: 'task',
        entityId: 'task-1',
        type: 'update',
        payload: { projectId: 'project-1', task },
        timestamp: 1781539200000,
        retryCount: 0,
      }],
      deadLetters: [],
      conflicts: [{ id: 'conflict-1' }],
      taskTombstones: { project: ['task-deleted'] },
      connectionTombstones: ['connection-deleted'],
    },
    syncSnapshot: {
      syncState: { lastSyncTime: '2026-06-16T00:00:00.000Z', pendingCount: 2 },
      projectCursors: [{ projectId: 'project-1', userId: 'user-1', cursor: { updatedAt: '2026-06-16T00:00:00.000Z', entityType: 'task', id: 'task-1' } }],
      queueCounts: { retryQueue: 1, actionQueue: 1, deadLetters: 0 },
    },
    replayLog: [],
    lastWriteExplain: null,
  });
}

describe('restoreDataSafetyPackage', () => {
  it('restores local working state and queue snapshots without ID remapping', async () => {
    const writes: Array<{ store: string; id: string; value: unknown }> = [];
    const stateWrites: Array<{ key: string; value: unknown }> = [];

    const result = await restoreDataSafetyPackage(makePackage(), {
      current: { projects: [], tasks: [], connections: [], syncCursors: [] },
      put: async (store, id, value) => {
        writes.push({ store, id, value });
      },
      saveState: async (key, value) => {
        stateWrites.push({ key, value });
      },
    });

    expect(result.success).toBe(true);
    expect(result.plan.idRemappingRequired).toBe(false);
    expect(writes.map(write => `${write.store}:${write.id}`)).toEqual([
      'projects:project-1',
      'tasks:task-1',
      'connections:connection-1',
      'syncCursors:project:user-1:project-1',
    ]);
    expect(stateWrites.map(write => write.key)).toEqual([
      'meta',
      'retryQueue',
      'legacyRetryReview',
      'actionQueue',
      'deadLetters',
      'conflicts',
      'taskTombstones',
      'connectionTombstones',
      'syncSnapshot',
      'replayLog',
      'replayPlan',
      'lastWriteExplain',
    ]);
  });

  it('is idempotent when current stores already match the package', async () => {
    const pkg = makePackage();
    const writes: unknown[] = [];

    const result = await restoreDataSafetyPackage(pkg, {
      current: {
        projects: pkg.localData.projects,
        tasks: pkg.localData.tasks,
        connections: pkg.localData.connections,
        syncCursors: pkg.localData.syncCursors,
      },
      put: async () => {
        writes.push('unexpected write');
      },
      saveState: async () => undefined,
    });

    expect(result.success).toBe(true);
    expect(result.plan.summary).toMatchObject({ writes: 0, skips: 4 });
    expect(writes).toEqual([]);
  });

  it('stops before writing when validation fails', async () => {
    const invalidPackage = { ...makePackage(), ownerUserId: '' };
    const writes: unknown[] = [];

    const result = await restoreDataSafetyPackage(invalidPackage, {
      current: { projects: [], tasks: [], connections: [], syncCursors: [] },
      put: async () => {
        writes.push('unexpected write');
      },
      saveState: async () => undefined,
    });

    expect(result.success).toBe(false);
    expect(result.errors).toContain('ownerUserId is required');
    expect(writes).toEqual([]);
  });
});
