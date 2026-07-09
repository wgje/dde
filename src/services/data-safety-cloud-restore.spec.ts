import { describe, expect, it } from 'vitest';
import type { Connection, Project, Task } from '../models';
import {
  buildDataSafetyExportPackage,
  type DataSafetyExportPackage,
} from './data-safety-package';
import {
  restoreDataSafetyPackageToCloud,
  type DataSafetyCloudRestoreRpcAdapter,
} from './data-safety-cloud-restore';
import type { SyncRpcResult } from './sync-rpc-client.service';

type RpcCall =
  | {
      method: 'upsertProject';
      operationId: string;
      id: string;
      ownerId: string;
      baseUpdatedAt: string | null;
    }
  | {
      method: 'upsertTask';
      operationId: string;
      id: string;
      projectId?: string;
      content: string;
      baseUpdatedAt: string | null;
    }
  | {
      method: 'upsertConnection';
      operationId: string;
      id: string;
      projectId?: string;
      baseUpdatedAt: string | null;
    };

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
      projects: [
        {
          id: 'project-1',
          name: 'P1',
          description: 'project one',
          createdDate: '2026-06-15T23:00:00.000Z',
          updatedAt: '2026-06-16T00:00:00.000Z',
        },
      ],
      tasks: [
        {
          id: 'task-1',
          projectId: 'project-1',
          title: 'Task 1',
          content: 'keep content',
          stage: 0,
          parentId: null,
          order: 0,
          rank: 10000,
          status: 'active',
          x: 0,
          y: 0,
          createdDate: '2026-06-15T23:30:00.000Z',
          updatedAt: '2026-06-16T00:01:00.000Z',
          displayId: 'T-1',
        },
      ],
      connections: [
        {
          id: 'connection-1',
          projectId: 'project-1',
          source: 'task-1',
          target: 'task-1',
          updatedAt: '2026-06-16T00:02:00.000Z',
        },
      ],
      syncCursors: [],
      meta: { activeProjectId: 'project-1' },
    },
    localState: {
      retryQueue: [],
      actionQueue: [],
      deadLetters: [],
      conflicts: [],
      taskTombstones: {},
      connectionTombstones: [],
    },
    syncSnapshot: {
      syncState: {
        lastSyncTime: '2026-06-16T00:03:00.000Z',
        pendingCount: 0,
      },
      projectCursors: [],
      queueCounts: { retryQueue: 0, actionQueue: 0, deadLetters: 0 },
    },
    replayLog: [],
    lastWriteExplain: null,
  });

  return {
    ...pkg,
    ...overrides,
  };
}

function makePackageWithTasks(tasks: DataSafetyExportPackage['localData']['tasks']): DataSafetyExportPackage {
  const base = makePackage();
  return buildDataSafetyExportPackage({
    exportedAt: base.exportedAt,
    ownerUserId: base.ownerUserId,
    app: base.app,
    localData: {
      ...base.localData,
      tasks,
    },
    localState: base.localState,
    syncSnapshot: base.syncSnapshot,
    replayLog: base.replayLog,
    lastWriteExplain: base.lastWriteExplain,
  });
}

function createAdapter(results: SyncRpcResult[] = []): DataSafetyCloudRestoreRpcAdapter & { calls: RpcCall[] } {
  const calls: RpcCall[] = [];
  let index = 0;
  const nextResult = (): SyncRpcResult => results[index++] ?? { status: 'applied', entityId: 'ok', raw: { status: 'applied' } };

  return {
    calls,
    async upsertProject(params) {
      calls.push({
        method: 'upsertProject',
        operationId: params.operationId,
        id: params.project.id,
        ownerId: params.ownerId,
        baseUpdatedAt: params.baseUpdatedAt,
      });
      return nextResult();
    },
    async upsertTask(params) {
      calls.push({
        method: 'upsertTask',
        operationId: params.operationId,
        id: params.task.id,
        projectId: params.projectId,
        content: params.task.content,
        baseUpdatedAt: params.baseUpdatedAt,
      });
      return nextResult();
    },
    async upsertConnection(params) {
      calls.push({
        method: 'upsertConnection',
        operationId: params.operationId,
        id: params.connection.id,
        projectId: params.projectId,
        baseUpdatedAt: params.baseUpdatedAt,
      });
      return nextResult();
    },
  };
}

describe('data safety cloud restore', () => {
  it('defaults to dry-run and builds a deterministic cloud restore plan without invoking RPC', async () => {
    const pkg = makePackage();
    const adapter = createAdapter();

    const result = await restoreDataSafetyPackageToCloud(pkg, adapter, { ownerUserId: 'user-1' });

    const hash = pkg.integrity.checksum.slice(0, 16);
    expect(result.success).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(adapter.calls).toEqual([]);
    expect(result.plan.steps.map(step => `${step.entityType}:${step.entityId}`)).toEqual([
      'project:project-1',
      'task:task-1',
      'connection:connection-1',
    ]);
    expect(result.plan.steps.map(step => step.operationId)).toEqual([
      `data-safety-restore:${hash}:project:project-1`,
      `data-safety-restore:${hash}:task:task-1`,
      `data-safety-restore:${hash}:connection:connection-1`,
    ]);
    expect(result.plan.summary).toMatchObject({
      total: 3,
      planned: 3,
      executed: 0,
      blocked: 0,
      failed: 0,
    });
  });

  it('rejects invalid packages before any cloud RPC', async () => {
    const pkg = {
      ...makePackage(),
      ownerUserId: 'other-user',
    };
    const adapter = createAdapter();

    const result = await restoreDataSafetyPackageToCloud(pkg, adapter, {
      ownerUserId: 'user-1',
      dryRun: false,
    });

    expect(result.success).toBe(false);
    expect(result.errors).toContain('integrity.checksum does not match package contents');
    expect(result.errors).toContain('ownerUserId does not match current restore user');
    expect(adapter.calls).toEqual([]);
  });

  it('rejects task restore packages missing content before any cloud RPC', async () => {
    const pkg = makePackageWithTasks([
      {
        id: 'task-1',
        projectId: 'project-1',
        title: 'Task 1',
        updatedAt: '2026-06-16T00:01:00.000Z',
      },
    ]);
    const adapter = createAdapter();

    const result = await restoreDataSafetyPackageToCloud(pkg, adapter, {
      ownerUserId: 'user-1',
      dryRun: false,
    });

    expect(result.success).toBe(false);
    expect(result.errors).toContain('localData.tasks[0].content is required for cloud restore');
    expect(adapter.calls).toEqual([]);
  });

  it('executes project, task, then connection RPCs with original IDs and updatedAt baselines', async () => {
    const pkg = makePackage();
    const adapter = createAdapter([
      { status: 'applied', entityId: 'project-1', serverUpdatedAt: '2026-06-16T00:10:00.000Z', raw: {} },
      { status: 'applied', entityId: 'task-1', serverUpdatedAt: '2026-06-16T00:10:01.000Z', raw: {} },
      { status: 'idempotent-replay', entityId: 'connection-1', serverUpdatedAt: '2026-06-16T00:10:02.000Z', raw: {} },
    ]);

    const result = await restoreDataSafetyPackageToCloud(pkg, adapter, {
      ownerUserId: 'user-1',
      dryRun: false,
    });

    const hash = pkg.integrity.checksum.slice(0, 16);
    expect(result.success).toBe(true);
    expect(result.dryRun).toBe(false);
    expect(adapter.calls).toEqual([
      {
        method: 'upsertProject',
        operationId: `data-safety-restore:${hash}:project:project-1`,
        id: 'project-1',
        ownerId: 'user-1',
        baseUpdatedAt: '2026-06-16T00:00:00.000Z',
      },
      {
        method: 'upsertTask',
        operationId: `data-safety-restore:${hash}:task:task-1`,
        id: 'task-1',
        projectId: 'project-1',
        content: 'keep content',
        baseUpdatedAt: '2026-06-16T00:01:00.000Z',
      },
      {
        method: 'upsertConnection',
        operationId: `data-safety-restore:${hash}:connection:connection-1`,
        id: 'connection-1',
        projectId: 'project-1',
        baseUpdatedAt: '2026-06-16T00:02:00.000Z',
      },
    ]);
    expect(result.plan.steps.map(step => step.status)).toEqual(['applied', 'applied', 'idempotent-replay']);
    expect(result.plan.steps[2].lwwDecision).toEqual({ decision: 'idempotent-replay', reason: 'idempotent-replay' });
  });

  it('reports remote-newer as a blocked LWW decision and does not retry blindly', async () => {
    const pkg = makePackage();
    const adapter = createAdapter([
      { status: 'applied', entityId: 'project-1', raw: {} },
      {
        status: 'remote-newer',
        entityId: 'task-1',
        remoteUpdatedAt: '2026-06-16T00:11:00.000Z',
        raw: {},
      },
      { status: 'applied', entityId: 'connection-1', raw: {} },
    ]);

    const result = await restoreDataSafetyPackageToCloud(pkg, adapter, {
      ownerUserId: 'user-1',
      dryRun: false,
    });

    const taskStep = result.plan.steps[1];
    expect(result.success).toBe(false);
    expect(adapter.calls.map(call => call.method)).toEqual(['upsertProject', 'upsertTask']);
    expect(result.plan.summary).toMatchObject({ executed: 2, blocked: 1, failed: 0 });
    expect(taskStep.status).toBe('blocked');
    expect(taskStep.rpcResult).toMatchObject({ status: 'remote-newer', remoteUpdatedAt: '2026-06-16T00:11:00.000Z' });
    expect(taskStep.lwwDecision).toEqual({ decision: 'remote-kept', reason: 'remote-newer' });
    expect(taskStep.queueResult).toEqual({ enteredRetryQueue: false, retryCount: 0 });
    expect(taskStep.lastSyncTime).toEqual({
      before: '2026-06-16T00:03:00.000Z',
      after: '2026-06-16T00:03:00.000Z',
      advanced: false,
    });
  });
});
