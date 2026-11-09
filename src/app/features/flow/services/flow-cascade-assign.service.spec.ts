import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FlowCascadeAssignService } from './flow-cascade-assign.service';
import { ProjectStateService } from '../../../../services/project-state.service';
import { TaskOperationAdapterService } from '../../../../services/task-operation-adapter.service';
import { ToastService } from '../../../../services/toast.service';
import { ErrorCodes, failure, success, type OperationError, type Result } from '../../../../utils/result';
import type { Task } from '../../../../models';

describe('FlowCascadeAssignService', () => {
  let service: FlowCascadeAssignService;
  const tasksSignal = signal<Task[]>([]);

  const createTask = (overrides: Partial<Task> = {}): Task => ({
    id: 'task-1',
    title: 'Task',
    content: '',
    status: 'active',
    stage: null,
    order: 0,
    rank: 0,
    x: 0,
    y: 0,
    parentId: null,
    displayId: 'T1',
    createdDate: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    attachments: [],
    tags: [],
    parkingMeta: null,
    ...overrides,
  });

  const mockProjectState = {
    tasks: tasksSignal,
    getTask: vi.fn((taskId: string): Task | null =>
      tasksSignal().find(task => task.id === taskId) ?? null
    ),
  };

  const mockTaskOpsAdapter = {
    moveTaskToStage: vi.fn<(
      taskId: string,
      newStage: number | null,
      beforeTaskId?: string | null,
      newParentId?: string | null,
    ) => Promise<Result<void, OperationError>>>(),
  };

  const mockToast = {
    success: vi.fn(),
    error: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    tasksSignal.set([
      createTask({ id: 'task-1', title: 'Root task' }),
      createTask({ id: 'child-1', title: 'Child task', parentId: 'task-1' }),
      createTask({ id: 'parent-1', title: 'Parent task', stage: 2 }),
    ]);
    mockProjectState.getTask.mockImplementation((taskId: string): Task | null =>
      tasksSignal().find(task => task.id === taskId) ?? null
    );
    mockTaskOpsAdapter.moveTaskToStage.mockResolvedValue(success(undefined));

    TestBed.configureTestingModule({
      providers: [
        FlowCascadeAssignService,
        { provide: ProjectStateService, useValue: mockProjectState },
        { provide: TaskOperationAdapterService, useValue: mockTaskOpsAdapter },
        { provide: ToastService, useValue: mockToast },
      ],
    });

    service = TestBed.inject(FlowCascadeAssignService);
  });

  it('waits for durable local stage move before closing dialog and showing success', async () => {
    let resolveMove!: (result: Result<void, OperationError>) => void;
    const movePromise = new Promise<Result<void, OperationError>>(resolve => {
      resolveMove = resolve;
    });
    mockTaskOpsAdapter.moveTaskToStage.mockReturnValueOnce(movePromise);
    service.showDialog('task-1', 2, 'parent-1');

    const confirmPromise = service.confirm();

    expect(mockTaskOpsAdapter.moveTaskToStage).toHaveBeenCalledWith('task-1', 2, undefined, 'parent-1');
    expect(service.dialogData()).not.toBeNull();
    expect(mockToast.success).not.toHaveBeenCalled();

    resolveMove(success(undefined));
    await expect(confirmPromise).resolves.toBe(true);

    expect(service.dialogData()).toBeNull();
    expect(mockToast.success).toHaveBeenCalledWith('分配成功', '已将 2 个任务分配到阶段 2');
  });

  it('double-click on 确认分配 during the pending durable move dispatches the stage move only once', async () => {
    let resolveMove!: (result: Result<void, OperationError>) => void;
    const movePromise = new Promise<Result<void, OperationError>>(resolve => {
      resolveMove = resolve;
    });
    mockTaskOpsAdapter.moveTaskToStage.mockReturnValueOnce(movePromise);
    service.showDialog('task-1', 2, 'parent-1');

    const firstConfirm = service.confirm();
    // 首次 confirm 尚在 await 期间，对话框仍渲染可点击：第二次点击必须被重入守卫短路
    const secondConfirm = service.confirm();

    await expect(secondConfirm).resolves.toBe(false);
    expect(mockTaskOpsAdapter.moveTaskToStage).toHaveBeenCalledTimes(1);

    resolveMove(success(undefined));
    await expect(firstConfirm).resolves.toBe(true);

    expect(mockTaskOpsAdapter.moveTaskToStage).toHaveBeenCalledTimes(1);
    expect(mockToast.success).toHaveBeenCalledTimes(1);
    expect(service.dialogData()).toBeNull();
  });

  it('allows a fresh confirm after the previous confirmation settles', async () => {
    service.showDialog('task-1', 2, 'parent-1');
    await expect(service.confirm()).resolves.toBe(true);

    service.showDialog('child-1', 3, null);
    await expect(service.confirm()).resolves.toBe(true);

    expect(mockTaskOpsAdapter.moveTaskToStage).toHaveBeenCalledTimes(2);
    expect(mockTaskOpsAdapter.moveTaskToStage).toHaveBeenLastCalledWith('child-1', 3, undefined, null);
  });

  it('keeps dialog open and avoids success toast when local stage move fails', async () => {
    mockTaskOpsAdapter.moveTaskToStage.mockResolvedValueOnce(
      failure(ErrorCodes.VALIDATION_ERROR, 'invalid move')
    );
    service.showDialog('task-1', 2, 'parent-1');

    const confirmed = await service.confirm();

    expect(confirmed).toBe(false);
    expect(service.dialogData()).not.toBeNull();
    expect(mockToast.success).not.toHaveBeenCalled();
    expect(mockToast.error).toHaveBeenCalledWith('分配失败', '数据验证失败');
  });
});
