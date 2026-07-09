import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FlowTaskOperationsService } from './flow-task-operations.service';
import { TaskOperationAdapterService } from '../../../../services/task-operation-adapter.service';
import { ProjectStateService } from '../../../../services/project-state.service';
import { ToastService } from '../../../../services/toast.service';
import { ParkingService } from '../../../../services/parking.service';
import { DockEngineService } from '../../../../services/dock-engine.service';
import { Task } from '../../../../models';
import { success } from '../../../../utils/result';

function createTask(overrides: Partial<Task> = {}): Task {
  const now = new Date().toISOString();
  return {
    id: overrides.id ?? 'task-1',
    title: overrides.title ?? 'Task',
    content: overrides.content ?? '',
    stage: 'stage' in overrides ? overrides.stage! : 1,
    parentId: overrides.parentId ?? null,
    order: overrides.order ?? 1,
    rank: overrides.rank ?? 1000,
    status: overrides.status ?? 'active',
    x: overrides.x ?? 0,
    y: overrides.y ?? 0,
    createdDate: overrides.createdDate ?? now,
    updatedAt: overrides.updatedAt ?? now,
    displayId: overrides.displayId ?? '1',
    deletedAt: overrides.deletedAt ?? null,
  };
}

describe('FlowTaskOperationsService', () => {
  let service: FlowTaskOperationsService;

  const mockTaskOps = {
    addTask: vi.fn(),
    updateTaskTitle: vi.fn(),
    updateTaskContent: vi.fn(),
    updateTaskPriority: vi.fn(),
    updateTaskDueDate: vi.fn(),
    updateTaskAttentionItems: vi.fn(),
    updateTaskStatus: vi.fn(),
    addTodoItem: vi.fn(),
    addTaskTag: vi.fn(),
    removeTaskTag: vi.fn(),
    detachTask: vi.fn(),
    deleteTaskKeepChildren: vi.fn(),
    deleteTask: vi.fn(),
    deleteTasksBatch: vi.fn(),
    calculateBatchDeleteImpact: vi.fn(),
    updateTaskAttachments: vi.fn(),
    addTaskAttachment: vi.fn(),
    removeTaskAttachment: vi.fn(),
    core: {
      addTaskTag: vi.fn(),
      removeTaskTag: vi.fn(),
    },
  };
  const mockProjectState = {
    tasks: vi.fn(() => []),
    getTask: vi.fn(),
    updateTask: vi.fn(),
  };
  const mockToast = {
    success: vi.fn(),
    error: vi.fn(),
  };
  const mockParking = {
    parkTask: vi.fn(),
  };
  const mockDockEngine = {
    dockTask: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockTaskOps.addTask.mockResolvedValue(success('new-flow-task'));
    mockTaskOps.deleteTask.mockResolvedValue(true);
    mockTaskOps.deleteTaskKeepChildren.mockResolvedValue(true);
    mockTaskOps.deleteTasksBatch.mockResolvedValue(2);
    mockTaskOps.updateTaskAttachments.mockResolvedValue(true);
    mockTaskOps.updateTaskStatus.mockResolvedValue(true);

    TestBed.configureTestingModule({
      providers: [
        FlowTaskOperationsService,
        { provide: TaskOperationAdapterService, useValue: mockTaskOps },
        { provide: ProjectStateService, useValue: mockProjectState },
        { provide: ToastService, useValue: mockToast },
        { provide: ParkingService, useValue: mockParking },
        { provide: DockEngineService, useValue: mockDockEngine },
      ],
    });

    service = TestBed.inject(FlowTaskOperationsService);
  });

  it('waits for durable sibling creation before returning the new task id', async () => {
    const result = await service.addSiblingTask(createTask({ stage: 2, parentId: 'parent-1' }));

    expect(result).toBe('new-flow-task');
    expect(mockTaskOps.addTask).toHaveBeenCalledWith('', '', 2, 'parent-1', true);
  });

  it('waits for durable task deletion before returning success', async () => {
    const deleted = await service.deleteTask('task-1');

    expect(deleted).toBe(true);
    expect(mockTaskOps.deleteTask).toHaveBeenCalledWith('task-1');
    expect(mockTaskOps.deleteTaskKeepChildren).not.toHaveBeenCalled();
  });

  it('waits for durable keep-children deletion before returning success', async () => {
    const deleted = await service.deleteTask('task-1', true);

    expect(deleted).toBe(true);
    expect(mockTaskOps.deleteTaskKeepChildren).toHaveBeenCalledWith('task-1');
    expect(mockTaskOps.deleteTask).not.toHaveBeenCalled();
  });

  it('waits for durable batch deletion count', async () => {
    const deletedCount = await service.deleteTasksBatch(['task-1', 'task-2']);

    expect(deletedCount).toBe(2);
    expect(mockTaskOps.deleteTasksBatch).toHaveBeenCalledWith(['task-1', 'task-2']);
  });

  it('returns durable attachment update result to callers', async () => {
    mockTaskOps.updateTaskAttachments.mockResolvedValueOnce(false);
    const attachment = {
      id: 'attachment-1',
      type: 'file',
      name: 'attachment.txt',
      url: 'nanoflow-local-attachment://attachment-1',
      createdAt: '2026-06-01T00:00:00.000Z',
    } as const;

    const persisted = await service.updateTaskAttachments('task-1', [attachment]);

    expect(persisted).toBe(false);
    expect(mockTaskOps.updateTaskAttachments).toHaveBeenCalledWith('task-1', [attachment]);
  });

  it('returns durable field edit results to callers', async () => {
    mockTaskOps.updateTaskTitle.mockResolvedValueOnce(true);
    mockTaskOps.updateTaskContent.mockResolvedValueOnce(false);
    mockTaskOps.updateTaskPriority.mockResolvedValueOnce(true);
    mockTaskOps.updateTaskDueDate.mockResolvedValueOnce(false);
    mockTaskOps.updateTaskAttentionItems.mockResolvedValueOnce(true);

    await expect(service.updateTaskTitle('task-1', 'Title')).resolves.toBe(true);
    await expect(service.updateTaskContent('task-1', 'Content')).resolves.toBe(false);
    await expect(service.updateTaskPriority('task-1', 'urgent')).resolves.toBe(true);
    await expect(service.updateTaskDueDate('task-1', null)).resolves.toBe(false);
    await expect(service.updateTaskAttentionItems('task-1', [])).resolves.toBe(true);

    expect(mockTaskOps.updateTaskTitle).toHaveBeenCalledWith('task-1', 'Title');
    expect(mockTaskOps.updateTaskContent).toHaveBeenCalledWith('task-1', 'Content');
    expect(mockTaskOps.updateTaskPriority).toHaveBeenCalledWith('task-1', 'urgent');
    expect(mockTaskOps.updateTaskDueDate).toHaveBeenCalledWith('task-1', null);
    expect(mockTaskOps.updateTaskAttentionItems).toHaveBeenCalledWith('task-1', []);
  });

  it('returns durable todo and tag edit results to callers', async () => {
    mockTaskOps.addTodoItem.mockResolvedValueOnce(true);
    mockTaskOps.addTaskTag.mockResolvedValueOnce(false);
    mockTaskOps.removeTaskTag.mockResolvedValueOnce(true);

    await expect(service.addQuickTodo('task-1', '  review offline queue  ')).resolves.toBe(true);
    await expect(service.addTaskTag('task-1', '  urgent  ')).resolves.toBe(false);
    await expect(service.removeTaskTag('task-1', 'urgent')).resolves.toBe(true);

    expect(mockTaskOps.addTodoItem).toHaveBeenCalledWith('task-1', 'review offline queue');
    expect(mockTaskOps.addTaskTag).toHaveBeenCalledWith('task-1', 'urgent');
    expect(mockTaskOps.removeTaskTag).toHaveBeenCalledWith('task-1', 'urgent');
    expect(mockTaskOps.core.addTaskTag).not.toHaveBeenCalled();
    expect(mockTaskOps.core.removeTaskTag).not.toHaveBeenCalled();
  });

  it('skips empty quick todo without treating it as a durable write', async () => {
    await expect(service.addQuickTodo('task-1', '   ')).resolves.toBe(false);

    expect(mockTaskOps.addTodoItem).not.toHaveBeenCalled();
  });

  it('returns durable single attachment edit results to callers', async () => {
    const attachment = {
      id: 'attachment-1',
      type: 'file',
      name: 'attachment.txt',
      url: 'nanoflow-local-attachment://attachment-1',
      createdAt: '2026-06-01T00:00:00.000Z',
    } as const;
    mockTaskOps.addTaskAttachment.mockResolvedValueOnce(false);
    mockTaskOps.removeTaskAttachment.mockResolvedValueOnce(true);

    await expect(service.addTaskAttachment('task-1', attachment)).resolves.toBe(false);
    await expect(service.removeTaskAttachment('task-1', 'attachment-1')).resolves.toBe(true);

    expect(mockTaskOps.addTaskAttachment).toHaveBeenCalledWith('task-1', attachment);
    expect(mockTaskOps.removeTaskAttachment).toHaveBeenCalledWith('task-1', 'attachment-1');
  });

  it('shows detach success only after the local durable write succeeds', async () => {
    mockProjectState.getTask.mockReturnValueOnce(createTask({ id: 'task-1', title: 'Detached task' }));
    mockTaskOps.detachTask.mockResolvedValueOnce(false);

    await expect(service.detachTask('task-1')).resolves.toBe(false);

    expect(mockTaskOps.detachTask).toHaveBeenCalledWith('task-1');
    expect(mockToast.success).not.toHaveBeenCalled();

    mockProjectState.getTask.mockReturnValueOnce(createTask({ id: 'task-1', title: 'Detached task' }));
    mockTaskOps.detachTask.mockResolvedValueOnce(true);

    await expect(service.detachTask('task-1')).resolves.toBe(true);

    expect(mockToast.success).toHaveBeenCalledWith('已移至待分配', '任务 "Detached task" 已解除分配');
  });

  it('waits for durable status toggle before completing the foreground operation', async () => {
    let resolveStatusWrite!: () => void;
    mockTaskOps.updateTaskStatus.mockReturnValueOnce(new Promise<boolean>(resolve => {
      resolveStatusWrite = () => resolve(true);
    }));

    let completed = false;
    const pending = service.toggleTaskStatus(createTask({ status: 'active' })).then(() => {
      completed = true;
    });

    await Promise.resolve();
    expect(completed).toBe(false);

    expect(mockTaskOps.updateTaskStatus).toHaveBeenCalledWith('task-1', 'completed');

    resolveStatusWrite();
    await pending;

    expect(completed).toBe(true);

    await service.toggleTaskStatus(createTask({ status: 'completed' }));
    expect(mockTaskOps.updateTaskStatus).toHaveBeenCalledWith('task-1', 'active');
  });

  it('returns archived status only after durable archive write completes', async () => {
    let resolveStatusWrite!: () => void;
    mockTaskOps.updateTaskStatus.mockReturnValueOnce(new Promise<boolean>(resolve => {
      resolveStatusWrite = () => resolve(true);
    }));

    let returnedStatus: 'active' | 'archived' | null = null;
    const pending = service.archiveTask(createTask({ status: 'active' })).then(status => {
      returnedStatus = status;
    });

    await Promise.resolve();
    expect(returnedStatus).toBeNull();

    expect(mockTaskOps.updateTaskStatus).toHaveBeenCalledWith('task-1', 'archived');

    resolveStatusWrite();
    await pending;

    expect(returnedStatus).toBe('archived');

    const active = await service.archiveTask(createTask({ status: 'archived' }));

    expect(active).toBe('active');
    expect(mockTaskOps.updateTaskStatus).toHaveBeenCalledWith('task-1', 'active');
  });

  it('returns null when durable archive write fails', async () => {
    mockTaskOps.updateTaskStatus.mockResolvedValueOnce(false);

    const returnedStatus = await service.archiveTask(createTask({ status: 'active' }));

    expect(returnedStatus).toBeNull();
    expect(mockTaskOps.updateTaskStatus).toHaveBeenCalledWith('task-1', 'archived');
  });
});
