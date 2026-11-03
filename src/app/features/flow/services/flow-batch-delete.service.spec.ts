import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FlowBatchDeleteService } from './flow-batch-delete.service';
import { ProjectStateService } from '../../../../services/project-state.service';
import { ToastService } from '../../../../services/toast.service';
import { LoggerService } from '../../../../services/logger.service';
import { FlowSelectionService } from './flow-selection.service';
import { FlowTaskOperationsService } from './flow-task-operations.service';
import { Task } from '../../../../models';
import { FlowRightPanelComponent } from '../components/flow-right-panel.component';

const taskA = { id: 'task-a', title: 'Task A' } as Task;
const taskB = { id: 'task-b', title: 'Task B' } as Task;

describe('FlowBatchDeleteService', () => {
  let service: FlowBatchDeleteService;
  let selectedIds: Set<string>;
  let beforeActiveProjectChange: ((previousId: string | null, nextId: string | null) => void) | null;
  const activeProjectId = signal<string | null>('project-a');

  const mockProjectState = {
    activeProjectId,
    registerBeforeActiveProjectChange: vi.fn((listener: typeof beforeActiveProjectChange) => {
      beforeActiveProjectChange = listener;
      return () => { if (beforeActiveProjectChange === listener) beforeActiveProjectChange = null; };
    }),
    setActiveProjectId: vi.fn((nextId: string | null) => {
      const previousId = activeProjectId();
      if (previousId === nextId) return;
      beforeActiveProjectChange?.(previousId, nextId);
      activeProjectId.set(nextId);
    }),
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
    beforeActiveProjectChange = null;
    activeProjectId.set('project-a');
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
    expect(mockTaskOps.deleteTasksBatch).toHaveBeenCalledWith(['task-a', 'task-b'], expect.any(Function));
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

  it('retires the dialog on a real project change but preserves it for a duplicate owner', () => {
    service.requestBatchDelete();
    mockProjectState.setActiveProjectId('project-a');
    expect(service.dialogData()).not.toBeNull();

    mockProjectState.setActiveProjectId('project-b');

    expect(service.dialogData()).toBeNull();
    expect(mockSelection.clearSelection).toHaveBeenCalledOnce();
  });

  it('routes the inline Flow project switch through the canonical synchronous boundary', () => {
    const directSet = vi.fn();
    const setActiveProjectId = vi.fn();
    const context = {
      projectState: {
        activeProjectId: Object.assign(vi.fn(() => 'project-a'), { set: directSet }),
        setActiveProjectId,
      },
      uiState: { activeView: vi.fn(() => 'flow') },
      router: { navigate: vi.fn() },
    } as unknown as FlowRightPanelComponent;

    FlowRightPanelComponent.prototype.onProjectClick.call(context, 'project-b');

    expect(setActiveProjectId).toHaveBeenCalledWith('project-b');
    expect(directSet).not.toHaveBeenCalled();
  });

  it('returns zero and preserves the replacement dialog when A completes after switching to B', async () => {
    let resolveDelete!: (count: number) => void;
    mockTaskOps.deleteTasksBatch.mockReturnValueOnce(new Promise(resolve => { resolveDelete = resolve; }));
    service.requestBatchDelete();
    const clearDetail = vi.fn();

    const pendingA = service.confirmBatchDelete(clearDetail);
    const canPublishA = mockTaskOps.deleteTasksBatch.mock.calls[0]?.[1] as () => boolean;
    mockProjectState.setActiveProjectId('project-b');
    selectedIds = new Set(['task-a', 'task-b']);
    service.requestBatchDelete();

    expect(canPublishA()).toBe(false);
    resolveDelete(2);
    await expect(pendingA).resolves.toBe(0);
    expect(service.dialogData()).not.toBeNull();
    expect(clearDetail).not.toHaveBeenCalled();
    expect(mockToast.success).not.toHaveBeenCalled();
  });

  it('does not revive an A owner after A to B to A', async () => {
    let resolveDelete!: (count: number) => void;
    mockTaskOps.deleteTasksBatch.mockReturnValueOnce(new Promise(resolve => { resolveDelete = resolve; }));
    service.requestBatchDelete();
    const pendingA = service.confirmBatchDelete();

    mockProjectState.setActiveProjectId('project-b');
    mockProjectState.setActiveProjectId('project-a');
    resolveDelete(2);

    await expect(pendingA).resolves.toBe(0);
    expect(mockToast.success).not.toHaveBeenCalled();
  });

  it('does not let stale A finally unlock an in-flight B confirmation', async () => {
    let resolveA!: (count: number) => void;
    let resolveB!: (count: number) => void;
    mockTaskOps.deleteTasksBatch
      .mockReturnValueOnce(new Promise(resolve => { resolveA = resolve; }))
      .mockReturnValueOnce(new Promise(resolve => { resolveB = resolve; }));
    service.requestBatchDelete();
    const pendingA = service.confirmBatchDelete();
    mockProjectState.setActiveProjectId('project-b');
    service.requestBatchDelete();
    const pendingB = service.confirmBatchDelete();

    resolveA(2);
    await expect(pendingA).resolves.toBe(0);
    await expect(service.confirmBatchDelete()).resolves.toBe(0);
    expect(mockTaskOps.deleteTasksBatch).toHaveBeenCalledTimes(2);

    resolveB(2);
    await expect(pendingB).resolves.toBe(2);
  });

  it('reset retires pending ownership without permanently disabling the singleton', async () => {
    let resolveA!: (count: number) => void;
    mockTaskOps.deleteTasksBatch.mockReturnValueOnce(new Promise(resolve => { resolveA = resolve; }));
    service.requestBatchDelete();
    const pendingA = service.confirmBatchDelete();

    service.reset();
    service.requestBatchDelete();
    expect(service.dialogData()).not.toBeNull();
    resolveA(2);

    await expect(pendingA).resolves.toBe(0);
    expect(service.dialogData()).not.toBeNull();
  });
});
