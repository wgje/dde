import type { Project } from '../models';
import type { CategoryLogger } from './logger.service';
import type { TaskRecordTrackingService } from './task-record-tracking.service';

export interface TaskPositionPatch {
  taskId: string;
  x: number;
  y: number;
}

export async function recordTaskPositionBatchDurably(
  positions: TaskPositionPatch[],
  recorder: Pick<TaskRecordTrackingService, 'lastUpdateType' | 'recordAndUpdateDurably'>,
  logger: Pick<CategoryLogger, 'warn'>,
): Promise<boolean> {
  const positionByTaskId = new Map<string, { x: number; y: number }>();
  for (const position of positions) {
    positionByTaskId.set(position.taskId, { x: position.x, y: position.y });
  }

  recorder.lastUpdateType = 'position';
  const now = new Date().toISOString();
  const saved = await recorder.recordAndUpdateDurably(project => ({
    ...project,
    tasks: updateTaskPositions(project, positionByTaskId, now),
  }), { updateType: 'position', debouncedUndo: true });

  if (!saved) {
    logger.warn('批量任务位置本地持久化失败，未提交 UI 更新', {
      taskIds: positions.map(position => position.taskId),
    });
  }
  return saved;
}

function updateTaskPositions(
  project: Project,
  positionByTaskId: Map<string, { x: number; y: number }>,
  now: string,
): Project['tasks'] {
  return project.tasks.map(task => {
    const nextPosition = positionByTaskId.get(task.id);
    if (!nextPosition) {
      return task;
    }
    if (Math.abs(task.x - nextPosition.x) < 1 && Math.abs(task.y - nextPosition.y) < 1) {
      return task;
    }
    return { ...task, x: nextPosition.x, y: nextPosition.y, updatedAt: now };
  });
}
