import { describe, expect, it } from 'vitest';

import {
  buildTaskDeleteBatches,
  executeTaskDeleteBatchesSequentially,
} from './task-sync-delete-batching.helpers';

const PARENT_OPERATION_ID = '11111111-1111-4111-8111-111111111111';

describe('task sync delete batching helpers', () => {
  it('buildTaskDeleteBatches 应稳定生成 100/100/5 子批次并收窄基线映射', () => {
    const taskIds = Array.from({ length: 205 }, (_, index) => `task-${index}`);
    const baseUpdatedAtMap = Object.fromEntries(
      taskIds.map(taskId => [taskId, `2026-07-16T00:00:${taskId.slice(5).padStart(2, '0')}Z`]),
    );
    const options = {
      parentOperationId: PARENT_OPERATION_ID,
      projectId: 'project-1',
      deleteMode: 'purge' as const,
      taskIds,
      baseUpdatedAtMap,
    };

    const first = buildTaskDeleteBatches(options);
    const replay = buildTaskDeleteBatches(options);

    expect(first.map(batch => batch.taskIds.length)).toEqual([100, 100, 5]);
    expect(first.flatMap(batch => batch.taskIds)).toEqual(taskIds);
    expect(first.map(batch => Object.keys(batch.baseUpdatedAtMap ?? {}).length)).toEqual([100, 100, 5]);
    expect(first.map(batch => batch.operationId)).toEqual(replay.map(batch => batch.operationId));
    expect(new Set(first.map(batch => batch.operationId)).size).toBe(3);
  });

  it('executeTaskDeleteBatchesSequentially 不应并发执行数据库写批次', async () => {
    const batches = buildTaskDeleteBatches({
      parentOperationId: PARENT_OPERATION_ID,
      projectId: 'project-1',
      deleteMode: 'soft',
      taskIds: Array.from({ length: 205 }, (_, index) => `task-${index}`),
    });
    let active = 0;
    let maxActive = 0;
    const started: string[] = [];

    const counts = await executeTaskDeleteBatchesSequentially(batches, async batch => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      started.push(batch.taskIds[0]);
      await Promise.resolve();
      active -= 1;
      return batch.taskIds.length;
    });

    expect(counts).toEqual([100, 100, 5]);
    expect(started).toEqual(['task-0', 'task-100', 'task-200']);
    expect(maxActive).toBe(1);
  });
});
