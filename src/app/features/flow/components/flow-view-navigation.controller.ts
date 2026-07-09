import type { Task } from '../../../../models';

export interface FlowViewNavigationControllerOptions {
  centerOnNode: (taskId: string, openDetail: boolean) => void;
  getTask: (taskId: string) => Task | undefined | null;
  warn: (message: string, context: Record<string, unknown>) => void;
}

export class FlowViewNavigationController {
  constructor(private readonly options: FlowViewNavigationControllerOptions) {}

  centerOnNode(taskId: string, openDetail = true): void {
    const task = taskId ? this.options.getTask(taskId) : undefined;
    if (!this.isNavigableTask(task)) {
      this.options.warn('目标任务不存在，忽略流程图链接跳转', { taskId });
      return;
    }

    this.options.centerOnNode(taskId, openDetail);
  }

  private isNavigableTask(task: Task | undefined | null): task is Task {
    return !!task && !task.deletedAt && task.status !== 'archived';
  }
}
