import { Injector, runInInjectionContext, signal } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';

import type { Task } from '../../../models';
import { ProjectStateService } from '../../../services/project-state.service';
import { TaskOperationAdapterService } from '../../../services/task-operation-adapter.service';
import { ToastService } from '../../../services/toast.service';
import { TrashModalComponent } from './trash-modal.component';

function createTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    title: '恢复目标',
    content: '',
    status: 'archived',
    stage: 1,
    order: 0,
    parentId: null,
    rank: 0,
    x: 0,
    y: 0,
    createdDate: '2026-06-16T00:00:00.000Z',
    updatedAt: '2026-06-16T00:00:00.000Z',
    displayId: '1',
    deletedAt: null,
    ...overrides,
  };
}

function createComponent() {
  const taskOpsAdapter = {
    restoreTask: vi.fn().mockResolvedValue(true),
    updateTaskStatus: vi.fn().mockResolvedValue(true),
    permanentlyDeleteTask: vi.fn().mockResolvedValue(true),
    emptyTrash: vi.fn().mockResolvedValue(true),
  };
  const toast = {
    success: vi.fn(),
    warning: vi.fn(),
  };
  const projectState = {
    deletedTasks: signal<Task[]>([]),
    tasks: signal<Task[]>([]),
  };

  const injector = Injector.create({
    providers: [
      { provide: ProjectStateService, useValue: projectState },
      { provide: TaskOperationAdapterService, useValue: taskOpsAdapter },
      { provide: ToastService, useValue: toast },
    ],
  });

  const component = runInInjectionContext(injector, () => new TrashModalComponent());
  return { component, taskOpsAdapter, toast };
}

describe('TrashModalComponent', () => {
  it('restoreTask should warn when durable restore fails', async () => {
    const { component, taskOpsAdapter, toast } = createComponent();
    taskOpsAdapter.restoreTask.mockResolvedValueOnce(false);

    await component.restoreTask(createTask({ id: 'task-restore' }));

    expect(taskOpsAdapter.restoreTask).toHaveBeenCalledWith('task-restore');
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.warning).toHaveBeenCalledWith(
      '恢复失败',
      '任务恢复本地保存失败，请释放浏览器存储空间后重试',
    );
  });

  it('unarchiveTask should warn when durable status update fails', async () => {
    const { component, taskOpsAdapter, toast } = createComponent();
    taskOpsAdapter.updateTaskStatus.mockResolvedValueOnce(false);

    await component.unarchiveTask(createTask({ id: 'task-archive', title: '归档目标' }));

    expect(taskOpsAdapter.updateTaskStatus).toHaveBeenCalledWith('task-archive', 'active');
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.warning).toHaveBeenCalledWith(
      '取消归档失败',
      '任务状态本地保存失败，请释放浏览器存储空间后重试',
    );
  });
});
