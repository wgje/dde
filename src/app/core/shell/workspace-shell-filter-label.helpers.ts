export interface WorkspaceFilterLabelTask {
  title?: string | null;
  displayId?: string | null;
}

export interface WorkspaceFilterLabelInput {
  filterId: string;
  getTask: (taskId: string) => WorkspaceFilterLabelTask | null | undefined;
}

export function resolveWorkspaceFilterLabel(input: WorkspaceFilterLabelInput): string {
  if (input.filterId === 'all') {
    return '全部任务';
  }

  const task = input.getTask(input.filterId);
  if (!task) {
    return '全部任务';
  }

  return task.title || task.displayId || '未命名任务';
}
