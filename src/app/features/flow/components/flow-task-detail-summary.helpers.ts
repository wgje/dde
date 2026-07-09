import type { Task } from '../../../../models';
import { buildTaskSidecarSummary, type TaskSidecarSummary } from '../../../../utils/task-sidecar';

const EMPTY_TASK_FOR_DETAIL_SIDECAR: Task = {
  id: '',
  title: '',
  content: '',
  stage: null,
  parentId: null,
  order: 0,
  rank: 0,
  status: 'active',
  x: 0,
  y: 0,
  createdDate: '',
  displayId: '',
};

export function buildFlowTaskDetailSidecarSummary(task: Task | null): TaskSidecarSummary {
  return buildTaskSidecarSummary(task ?? EMPTY_TASK_FOR_DETAIL_SIDECAR);
}
