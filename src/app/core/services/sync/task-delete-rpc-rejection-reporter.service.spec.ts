import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DataSafetyAuditPersistence } from '../../../../services/data-safety-audit-persistence';
import type { CategoryLogger } from '../../../../services/logger.service';
import { SentryLazyLoaderService } from '../../../../services/sentry-lazy-loader.service';
import type { SyncRpcResult } from '../../../../services/sync-rpc-client.service';
import { SyncStateService } from './sync-state.service';
import { TaskDeleteRpcWriteAuditService } from './task-delete-rpc-write-audit.service';
import { TaskDeleteRpcRejectionReporterService } from './task-delete-rpc-rejection-reporter.service';

describe('TaskDeleteRpcRejectionReporterService', () => {
  const captureMessage = vi.fn();
  const setSyncError = vi.fn();
  const syncState = vi.fn(() => ({ lastSyncTime: '2026-06-16T02:00:00.000Z' }));
  const logger: Pick<CategoryLogger, 'warn'> = {
    warn: vi.fn(),
  };

  beforeEach(() => {
    localStorage.clear();
    captureMessage.mockReset();
    setSyncError.mockReset();
    syncState.mockClear();
    vi.mocked(logger.warn).mockReset();

    TestBed.configureTestingModule({
      providers: [
        TaskDeleteRpcRejectionReporterService,
        TaskDeleteRpcWriteAuditService,
        { provide: SentryLazyLoaderService, useValue: { captureMessage } },
        { provide: SyncStateService, useValue: { setSyncError, syncState } },
      ],
    });
  });

  it('reports skipped stale task deletes as warning telemetry', () => {
    const service = TestBed.inject(TaskDeleteRpcRejectionReporterService);

    service.reportSkippedTaskDeletes(
      {
        status: 'applied',
        raw: {},
        skippedIds: ['task-skipped-a', 'task-skipped-b'],
      },
      'project-1',
      'purgeTasksFromCloud',
      logger as CategoryLogger,
    );

    expect(logger.warn).toHaveBeenCalledWith('sync_delete_tasks 跳过陈旧 task 删除（远端版本更新）', {
      projectId: 'project-1',
      operation: 'purgeTasksFromCloud',
      skippedIds: ['task-skipped-a', 'task-skipped-b'],
    });
    expect(captureMessage).toHaveBeenCalledWith('sync_rpc_task_delete_skipped_stale', {
      level: 'warning',
      tags: {
        operation: 'purgeTasksFromCloud',
        entityType: 'task',
        status: 'applied',
      },
      extra: {
        projectId: 'project-1',
        skippedIds: ['task-skipped-a', 'task-skipped-b'],
      },
    });
  });

  it('maps remote-newer rejections to conflict message and telemetry', () => {
    const service = TestBed.inject(TaskDeleteRpcRejectionReporterService);

    const message = service.reportRejectedTaskDeleteRpc(
      {
        status: 'deleted-remote-newer',
        raw: {},
        remoteUpdatedAt: '2026-06-16T01:30:00.000Z',
      },
      'project-1',
      ['task-rpc-rejected'],
      'purgeTasksFromCloud',
    );

    expect(message).toBe('远端版本更新，删除意图已保留等待拉取合并');
    expect(captureMessage).toHaveBeenCalledWith('sync_rpc_task_delete_remote_newer', {
      level: 'warning',
      tags: {
        operation: 'purgeTasksFromCloud',
        entityType: 'task',
        status: 'deleted-remote-newer',
      },
      extra: {
        projectId: 'project-1',
        taskIds: ['task-rpc-rejected'],
        remoteUpdatedAt: '2026-06-16T01:30:00.000Z',
        reason: undefined,
        minProtocolVersion: undefined,
      },
    });
  });

  it('handles rejected delete RPC by setting sync error, reporting, queueing, and auditing', async () => {
    const service = TestBed.inject(TaskDeleteRpcRejectionReporterService);
    const result: SyncRpcResult = {
      status: 'deleted-remote-newer',
      raw: {},
      remoteUpdatedAt: '2026-06-16T01:30:00.000Z',
    };
    const queueTaskDeletesForRetry = vi.fn(async () => ['task-rpc-rejected']);

    await service.handleRejectedTaskDeleteRpc({
      result,
      projectId: 'project-1',
      taskIds: ['task-rpc-rejected'],
      fromRetryQueue: false,
      sourceUserId: 'user-1',
      operation: 'purgeTasksFromCloud',
      baseUpdatedAtMap: { 'task-rpc-rejected': '2026-06-16T01:00:00.000Z' },
      operationId: 'op-delete-rpc-rejected',
      localTimestamp: 1781550000000,
      lastSyncTimeBefore: '2026-06-16T00:00:00.000Z',
      queueTaskDeletesForRetry,
    });

    expect(setSyncError).toHaveBeenCalledWith('远端版本更新，删除意图已保留等待拉取合并');
    expect(queueTaskDeletesForRetry).toHaveBeenCalledWith(
      ['task-rpc-rejected'],
      'project-1',
      false,
      'user-1',
      false,
      { 'task-rpc-rejected': '2026-06-16T01:00:00.000Z' },
      'op-delete-rpc-rejected',
    );
    expect(captureMessage).toHaveBeenCalledWith('sync_rpc_task_delete_remote_newer', {
      level: 'warning',
      tags: {
        operation: 'purgeTasksFromCloud',
        entityType: 'task',
        status: 'deleted-remote-newer',
      },
      extra: {
        projectId: 'project-1',
        taskIds: ['task-rpc-rejected'],
        remoteUpdatedAt: '2026-06-16T01:30:00.000Z',
        reason: undefined,
        minProtocolVersion: undefined,
      },
    });
    expect(new DataSafetyAuditPersistence().load('user-1').lastWriteExplain).toMatchObject({
      operationId: 'op-delete-rpc-rejected',
      entity: { type: 'task', id: 'task-rpc-rejected' },
      queueResult: { enteredRetryQueue: true, retryCount: 1 },
      rpcResult: {
        status: 'deleted-remote-newer',
        remoteUpdatedAt: '2026-06-16T01:30:00.000Z',
      },
      lastSyncTime: {
        before: '2026-06-16T00:00:00.000Z',
        after: '2026-06-16T02:00:00.000Z',
      },
    });
  });
});
