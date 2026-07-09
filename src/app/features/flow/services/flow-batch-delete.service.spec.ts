import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FlowBatchDeleteService } from './flow-batch-delete.service';
import { ProjectStateService } from '../../../../services/project-state.service';
import { ToastService } from '../../../../services/toast.service';
import { LoggerService } from '../../../../services/logger.service';
import { FlowSelectionService } from './flow-selection.service';
import { FlowTaskOperationsService } from './flow-task-operations.service';
import { Task } from '../../../../models';

const taskA = { id: 'task-a', title: 'Task A' } as Task;
const taskB = { id: 'task-b', title: 'Task B' } as Task;

describe('FlowBatchDeleteService', () => {
  let service: FlowBatchDeleteService;
  let selectedIds: Set<string>;

  const mockProjectState = {
    getTask: vi.fn((taskId: string) => taskId === 'task-a' ? taskA : taskId === 'task-b' ? taskB : null),
  };
  const mockSelection = {
    selectedTaskIds: vi.fn(() => selectedIds),
    clearSelection: vi.fn(),
  };
  const mockTaskOps = {
    calculateBatchDeleteImpact: vi.fn(() => ({ total: 2, explicit: 2, cascaded: 0 })),
    deleteTasksBatch: vi.fn().mockResolvedValue(2),
  };
  const mockToast = {
    success: vi.fn(),
  };
  const mockLogger = {
    category: vi.fn(() => ({
      warn: vi.fn(),
      debug: vi.fn(),
    })),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    selectedIds = new Set(['task-a', 'task-b']);
    mockTaskOps.deleteTasksBatch.mockResolvedValue(2);

    TestBed.configureTestingModule({
      providers: [
        FlowBatchDeleteService,
        { provide: ProjectStateService, useValue: mockProjectState },
        { provide: FlowSelectionService, useValue: mockSelection },
        { provide: FlowTaskOperationsService, useValue: mockTaskOps },
        { provide: ToastService, useValue: mockToast },
        { provide: LoggerService, useValue: mockLogger },
      ],
    });

    service = TestBed.inject(FlowBatchDeleteService);
  });

  it('waits for durable batch deletion before clearing selection and closing dialog', async () => {
    service.requestBatchDelete();

    const deletedCount = await service.confirmBatchDelete();

    expect(deletedCount).toBe(2);
    expect(mockTaskOps.deleteTasksBatch).toHaveBeenCalledWith(['task-a', 'task-b']);
    expect(mockSelection.clearSelection).toHaveBeenCalled();
    expect(service.dialogData()).toBeNull();
    expect(mockToast.success).toHaveBeenCalledWith('操作成功', '已删除 2 个任务');
  });

  it('keeps dialog and selection when local batch deletion is not persisted', async () => {
    mockTaskOps.deleteTasksBatch.mockResolvedValueOnce(0);
    service.requestBatchDelete();

    const deletedCount = await service.confirmBatchDelete();

    expect(deletedCount).toBe(0);
    expect(mockSelection.clearSelection).not.toHaveBeenCalled();
    expect(service.dialogData()).not.toBeNull();
    expect(mockToast.success).not.toHaveBeenCalled();
  });

  it('ignores duplicate confirmations while durable batch deletion is in flight', async () => {
    let resolveDelete: (deletedCount: number) => void = () => undefined;
    mockTaskOps.deleteTasksBatch.mockReturnValueOnce(new Promise<number>(resolve => {
      resolveDelete = resolve;
    }));
    service.requestBatchDelete();

    const firstConfirm = service.confirmBatchDelete();
    const duplicateConfirm = service.confirmBatchDelete();

    await expect(duplicateConfirm).resolves.toBe(0);
    expect(mockTaskOps.deleteTasksBatch).toHaveBeenCalledTimes(1);
    expect(mockSelection.clearSelection).not.toHaveBeenCalled();
    expect(service.dialogData()).not.toBeNull();

    resolveDelete(2);
    await expect(firstConfirm).resolves.toBe(2);

    expect(mockSelection.clearSelection).toHaveBeenCalledOnce();
    expect(service.dialogData()).toBeNull();
    expect(mockToast.success).toHaveBeenCalledWith('操作成功', '已删除 2 个任务');
  });
});
