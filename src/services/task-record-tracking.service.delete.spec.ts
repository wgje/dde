import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createProject,
  createTask,
  createTaskRecordTrackingSpecHarness,
  type TaskRecordTrackingSpecHarness,
} from './task-record-tracking.service.spec-helpers';

const SYNC_OPERATION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[45][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe('TaskRecordTrackingService triggerServerSideDelete', () => {
  let harness: TaskRecordTrackingSpecHarness;
  let service: TaskRecordTrackingSpecHarness['service'];
  let mockProjectState: TaskRecordTrackingSpecHarness['mockProjectState'];
  let mockSyncCoordinator: TaskRecordTrackingSpecHarness['mockSyncCoordinator'];
  let mockOptimisticState: TaskRecordTrackingSpecHarness['mockOptimisticState'];
  let mockToastService: TaskRecordTrackingSpecHarness['mockToastService'];

  beforeEach(() => {
    harness = createTaskRecordTrackingSpecHarness();
    service = harness.service;
    mockProjectState = harness.mockProjectState;
    mockSyncCoordinator = harness.mockSyncCoordinator;
    mockOptimisticState = harness.mockOptimisticState;
    mockToastService = harness.mockToastService;
  });

  afterEach(() => {
    harness.restoreConsole();
  });

  it('should call softDeleteTasksBatch for deleted tasks', async () => {
    const deletedTask = createTask({ id: 'task-del', deletedAt: new Date().toISOString() });
    mockProjectState.activeProject.mockReturnValue(
      createProject({ tasks: [deletedTask] }),
    );

    await service.triggerServerSideDelete('proj-1', ['task-del'], 'snap-1');

    expect(mockSyncCoordinator.softDeleteTasksBatch).toHaveBeenCalledWith(
      'proj-1',
      ['task-del'],
      expect.objectContaining({
        'task-del': deletedTask.deletedAt,
      }),
      undefined,
      expect.stringMatching(SYNC_OPERATION_ID_PATTERN),
    );
  });

  it('should reuse the same operation id when the same delete snapshot is retried', async () => {
    const deletedTask = createTask({
      id: 'task-stable-operation-id',
      deletedAt: '2026-07-15T02:00:00.000Z',
    });
    mockProjectState.activeProject.mockReturnValue(
      createProject({ tasks: [deletedTask] }),
    );

    await service.triggerServerSideDelete(
      'proj-1',
      ['task-stable-operation-id'],
      'snap-stable-operation-id',
    );
    await service.triggerServerSideDelete(
      'proj-1',
      ['task-stable-operation-id'],
      'snap-stable-operation-id',
    );

    const firstOperationId = mockSyncCoordinator.softDeleteTasksBatch.mock.calls[0]?.[4];
    const secondOperationId = mockSyncCoordinator.softDeleteTasksBatch.mock.calls[1]?.[4];
    expect(firstOperationId).toMatch(SYNC_OPERATION_ID_PATTERN);
    expect(secondOperationId).toBe(firstOperationId);
  });

  it('should send pre-delete updatedAt from the optimistic snapshot as the delete CAS base', async () => {
    const deletedTask = createTask({
      id: 'task-del',
      deletedAt: '2026-04-01T00:00:03.000Z',
      updatedAt: '2026-04-01T00:00:03.000Z',
    });
    mockProjectState.activeProject.mockReturnValue(createProject({ tasks: [deletedTask] }));
    mockOptimisticState.getTaskFromSnapshot.mockReturnValue(
      createTask({
        id: 'task-del',
        updatedAt: '2026-04-01T00:00:00.000Z',
      }),
    );

    await service.triggerServerSideDelete('proj-1', ['task-del'], 'snap-1');

    expect(mockOptimisticState.getTaskFromSnapshot).toHaveBeenCalledWith('snap-1', 'task-del');
    expect(mockSyncCoordinator.softDeleteTasksBatch).toHaveBeenCalledWith(
      'proj-1',
      ['task-del'],
      expect.objectContaining({
        'task-del': '2026-04-01T00:00:03.000Z',
      }),
      {
        'task-del': '2026-04-01T00:00:00.000Z',
      },
      expect.stringMatching(SYNC_OPERATION_ID_PATTERN),
    );
  });

  it('should rollback when server rejects batch delete', async () => {
    const deletedTask = createTask({ id: 'task-del', deletedAt: new Date().toISOString() });
    mockProjectState.activeProject.mockReturnValue(
      createProject({ tasks: [deletedTask] }),
    );
    mockSyncCoordinator.softDeleteTasksBatch.mockResolvedValue(-1);

    await service.triggerServerSideDelete('proj-1', ['task-del'], 'snap-1');

    // 【根因修复 2026-05-15】不再调用 rollbackSnapshot 整库回滚，
    // 改为 restoreTasksFromSnapshot 只回滚被拒任务，保留其它回收站项。
    expect(mockOptimisticState.rollbackSnapshot).not.toHaveBeenCalled();
    expect(mockOptimisticState.restoreTasksFromSnapshot).toHaveBeenCalledWith(
      'snap-1',
      ['task-del'],
      expect.objectContaining({ showToast: false }),
    );
    expect(mockToastService.warning).toHaveBeenCalled();
  });

  it('should do nothing when no active project', async () => {
    mockProjectState.activeProject.mockReturnValue(null);

    await service.triggerServerSideDelete('proj-1', ['task-1'], 'snap-1');

    expect(mockSyncCoordinator.softDeleteTasksBatch).not.toHaveBeenCalled();
  });
});
