import { Injector, runInInjectionContext, signal } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';

import type { Task } from '../../../models';
import type { PermanentDeleteOutcome } from '../../../services/task-operation-trash-adapter.controller';
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
    permanentlyDeleteTaskWithOutcome: vi.fn<
      (taskId: string, canPublishUi?: () => boolean) => Promise<PermanentDeleteOutcome>
    >().mockResolvedValue({ status: 'success' }),
    emptyTrash: vi.fn().mockResolvedValue(true),
  };
  const toast = {
    success: vi.fn(),
    warning: vi.fn(),
  };
  let activeProject = { id: 'project-a', tasks: [createTask()] };
  const projectState = {
    deletedTasks: signal<Task[]>([]),
    tasks: signal<Task[]>([]),
    activeProject: vi.fn(() => activeProject),
  };

  const injector = Injector.create({
    providers: [
      { provide: ProjectStateService, useValue: projectState },
      { provide: TaskOperationAdapterService, useValue: taskOpsAdapter },
      { provide: ToastService, useValue: toast },
    ],
  });

  const component = runInInjectionContext(injector, () => new TrashModalComponent());
  let publishUi = true;
  component.projectOwner = Object.freeze({ projectId: 'project-a', generation: 1 });
  component.canPublishUi = () => publishUi;
  return {
    component,
    setActiveProject: (projectId: string, tasks: Task[]) => {
      activeProject = { id: projectId, tasks };
      projectState.tasks.set(tasks);
    },
    setCanPublishUi: (value: boolean) => { publishUi = value; },
    taskOpsAdapter,
    toast,
  };
}

describe('TrashModalComponent', () => {
  it('restoreTask should warn when durable restore fails', async () => {
    const { component, setActiveProject, taskOpsAdapter, toast } = createComponent();
    taskOpsAdapter.restoreTask.mockResolvedValueOnce(false);
    const task = createRestorableDeletedTask({ id: 'task-restore' });
    setActiveProject('project-a', [task]);

    await component.restoreTask(task);

    expect(taskOpsAdapter.restoreTask).toHaveBeenCalledWith('task-restore');
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.warning).toHaveBeenCalledWith(
      '恢复失败',
      '任务恢复本地保存失败，请释放浏览器存储空间后重试',
    );
  });

  it('restoreTask should report success after valid trash metadata is restored', async () => {
    const { component, setActiveProject, taskOpsAdapter, toast } = createComponent();
    const task = createRestorableDeletedTask({ id: 'task-restore-success', title: '恢复成功' });
    setActiveProject('project-a', [task]);

    await component.restoreTask(task);

    expect(taskOpsAdapter.restoreTask).toHaveBeenCalledWith(task.id);
    expect(toast.success).toHaveBeenCalledWith('已恢复', '任务 "恢复成功" 已恢复');
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it('explains missing structure metadata without attempting a restore', async () => {
    const { component, setActiveProject, taskOpsAdapter, toast } = createComponent();
    const task = createTask({ id: 'task-missing-meta', deletedAt: '2026-06-15T00:00:00.000Z' });
    setActiveProject('project-a', [task]);

    await component.restoreTask(task);

    expect(taskOpsAdapter.restoreTask).not.toHaveBeenCalled();
    expect(toast.warning).toHaveBeenCalledWith(
      '无法恢复任务',
      '原始结构信息缺失，任务仍保留在回收站中。',
    );
  });

  it('unarchiveTask should warn when durable status update fails', async () => {
    const { component, setActiveProject, taskOpsAdapter, toast } = createComponent();
    taskOpsAdapter.updateTaskStatus.mockResolvedValueOnce(false);
    const task = createTask({ id: 'task-archive', title: '归档目标' });
    setActiveProject('project-a', [task]);

    await component.unarchiveTask(task);

    expect(taskOpsAdapter.updateTaskStatus).toHaveBeenCalledWith('task-archive', 'active', 'project-a');
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.warning).toHaveBeenCalledWith(
      '取消归档失败',
      '任务状态本地保存失败，请释放浏览器存储空间后重试',
    );
  });

  it('unarchiveTask should report success after the active status is saved', async () => {
    const { component, setActiveProject, taskOpsAdapter, toast } = createComponent();
    const task = createTask({ id: 'task-unarchive-success', title: '取消归档目标' });
    setActiveProject('project-a', [task]);

    await component.unarchiveTask(task);

    expect(taskOpsAdapter.updateTaskStatus).toHaveBeenCalledWith(task.id, 'active', 'project-a');
    expect(toast.success).toHaveBeenCalledWith('已取消归档', '任务 "取消归档目标" 已恢复到主视图');
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it('rejects a task action that is not a member of the captured active project', async () => {
    const { component, setActiveProject, taskOpsAdapter } = createComponent();
    setActiveProject('project-b', [createTask({ id: 'task-b' })]);

    await component.restoreTask(createTask({ id: 'task-a' }));
    await component.unarchiveTask(createTask({ id: 'task-a' }));
    component.confirmPermanentDelete(createTask({ id: 'task-a' }));
    component.confirmEmptyTrash();

    expect(taskOpsAdapter.restoreTask).not.toHaveBeenCalled();
    expect(taskOpsAdapter.updateTaskStatus).not.toHaveBeenCalled();
    expect(component.confirmDeleteTask()).toBeNull();
    expect(component.showEmptyConfirm()).toBe(false);
  });

  it('suppresses a stale restore tail after A switches to B', async () => {
    let resolveRestore!: (saved: boolean) => void;
    const { component, setActiveProject, setCanPublishUi, taskOpsAdapter, toast } = createComponent();
    const taskA = createRestorableDeletedTask({ id: 'task-a' });
    setActiveProject('project-a', [taskA]);
    taskOpsAdapter.restoreTask.mockReturnValueOnce(new Promise(resolve => { resolveRestore = resolve; }));

    const completion = component.restoreTask(taskA);
    setCanPublishUi(false);
    setActiveProject('project-b', [createTask({ id: 'task-b' })]);
    resolveRestore(true);
    await completion;

    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it('passes owner fencing to permanent delete and does not close stale confirmation UI', async () => {
    let resolveDelete!: (outcome: PermanentDeleteOutcome) => void;
    const { component, setActiveProject, setCanPublishUi, taskOpsAdapter, toast } = createComponent();
    const taskA = createTask({ id: 'task-a' });
    setActiveProject('project-a', [taskA]);
    taskOpsAdapter.permanentlyDeleteTaskWithOutcome.mockReturnValueOnce(
      new Promise(resolve => { resolveDelete = resolve; }),
    );
    component.confirmPermanentDelete(taskA);

    const completion = component.executePermanentDelete();
    const canPublishUi = taskOpsAdapter.permanentlyDeleteTaskWithOutcome.mock.calls[0]?.[1];
    setCanPublishUi(false);
    setActiveProject('project-b', [createTask({ id: 'task-b' })]);
    resolveDelete({ status: 'operation-failure' });
    await completion;

    expect(canPublishUi).toBeTypeOf('function');
    if (typeof canPublishUi !== 'function') throw new Error('Expected permanent-delete owner fence');
    expect(canPublishUi()).toBe(false);
    expect(component.confirmDeleteTask()).toBe(taskA);
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it('executePermanentDelete closes the confirmation after a successful delete', async () => {
    const { component, setActiveProject, taskOpsAdapter, toast } = createComponent();
    const task = createTask({ id: 'task-permanent-delete-success', title: '永久删除目标' });
    setActiveProject('project-a', [task]);
    component.confirmPermanentDelete(task);

    await component.executePermanentDelete();

    expect(taskOpsAdapter.permanentlyDeleteTaskWithOutcome).toHaveBeenCalledWith(task.id, expect.any(Function));
    expect(component.confirmDeleteTask()).toBeNull();
    expect(toast.success).toHaveBeenCalledWith('已删除', '任务 "永久删除目标" 已永久删除');
  });

  it('executePermanentDelete keeps the confirmation and allows retry after the delete operation fails', async () => {
    const { component, setActiveProject, taskOpsAdapter, toast } = createComponent();
    const task = createTask({ id: 'task-permanent-delete-retry', title: '重试删除目标' });
    setActiveProject('project-a', [task]);
    taskOpsAdapter.permanentlyDeleteTaskWithOutcome.mockResolvedValueOnce({ status: 'operation-failure' });
    component.confirmPermanentDelete(task);

    await component.executePermanentDelete();

    expect(taskOpsAdapter.permanentlyDeleteTaskWithOutcome).toHaveBeenCalledWith(task.id, expect.any(Function));
    expect(component.confirmDeleteTask()).toBe(task);
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.warning).toHaveBeenCalledWith(
      '永久删除未完成',
      '任务仍保留在回收站中，请稍后重试。',
    );

    await component.executePermanentDelete();

    expect(taskOpsAdapter.permanentlyDeleteTaskWithOutcome).toHaveBeenCalledTimes(2);
    expect(component.confirmDeleteTask()).toBeNull();
    expect(toast.success).toHaveBeenCalledWith('已删除', '任务 "重试删除目标" 已永久删除');
  });

  it('keeps the confirmation without a storage warning when local mutation is policy-blocked', async () => {
    const { component, setActiveProject, taskOpsAdapter, toast } = createComponent();
    const task = createTask({ id: 'task-permanent-delete-blocked', title: '只读状态任务' });
    setActiveProject('project-a', [task]);
    taskOpsAdapter.permanentlyDeleteTaskWithOutcome.mockResolvedValueOnce({ status: 'blocked' });
    component.confirmPermanentDelete(task);

    await component.executePermanentDelete();

    expect(component.confirmDeleteTask()).toBe(task);
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it('passes owner fencing to empty trash and suppresses stale dialog and toast commits', async () => {
    let resolveEmpty!: (saved: boolean) => void;
    const { component, setActiveProject, setCanPublishUi, taskOpsAdapter, toast } = createComponent();
    taskOpsAdapter.emptyTrash.mockReturnValueOnce(new Promise(resolve => { resolveEmpty = resolve; }));
    component.confirmEmptyTrash();

    const completion = component.executeEmptyTrash();
    const canPublishUi = taskOpsAdapter.emptyTrash.mock.calls[0]?.[0];
    setCanPublishUi(false);
    setActiveProject('project-b', []);
    resolveEmpty(true);
    await completion;

    expect(canPublishUi).toBeTypeOf('function');
    expect(canPublishUi()).toBe(false);
    expect(component.showEmptyConfirm()).toBe(true);
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('executeEmptyTrash closes the confirmation after a successful clear', async () => {
    const { component, setActiveProject, taskOpsAdapter, toast } = createComponent();
    setActiveProject('project-a', [createTask({ id: 'task-empty-trash-success' })]);
    component.confirmEmptyTrash();

    await component.executeEmptyTrash();

    expect(taskOpsAdapter.emptyTrash).toHaveBeenCalledWith(expect.any(Function));
    expect(component.showEmptyConfirm()).toBe(false);
    expect(toast.success).toHaveBeenCalledWith('已清空', '回收站已清空');
  });
});

function createRestorableDeletedTask(overrides: Partial<Task> = {}): Task {
  return createTask({
    ...overrides,
    deletedAt: '2026-06-15T00:00:00.000Z',
    deletedMeta: {
      parentId: null,
      stage: 1,
      order: 0,
      rank: 0,
      x: 0,
      y: 0,
      parkingMeta: null,
    },
  });
}
