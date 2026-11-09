import { TestBed } from '@angular/core/testing';
import { signal, type WritableSignal } from '@angular/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FlowLinkRelinkService } from './flow-link-relink.service';
import { ProjectStateService } from '../../../../services/project-state.service';
import { TaskOperationAdapterService } from '../../../../services/task-operation-adapter.service';
import { LoggerService } from '../../../../services/logger.service';
import { ToastService } from '../../../../services/toast.service';
import type { Connection, Project, Task } from '../../../../models';

type TaskOverrides = Omit<Partial<Task>, 'id' | 'title'> & Pick<Task, 'id' | 'title'>;

const createTask = ({ id, title, ...overrides }: TaskOverrides): Task => ({
  content: '',
  stage: 1,
  parentId: null,
  order: 0,
  rank: 0,
  status: 'active',
  x: 0,
  y: 0,
  createdDate: '2026-01-01T00:00:00.000Z',
  displayId: id,
  ...overrides,
  id,
  title,
});

describe('FlowLinkRelinkService', () => {
  let service: FlowLinkRelinkService;
  let tasksById: Map<string, Task>;
  const tasksSignal: WritableSignal<Task[]> = signal<Task[]>([]);

  const mockProjectState = {
    tasks: tasksSignal,
    activeProject: vi.fn<() => Pick<Project, 'connections'>>(() => ({ connections: [] })),
    getTask: vi.fn((taskId: string) => tasksById.get(taskId) ?? null),
  };

  const mockTaskOps = {
    isHintOnlyStartupReadOnly: vi.fn(() => false),
    connectionAdapter: {
      relinkCrossTreeConnection: vi.fn().mockResolvedValue(true),
    },
    getDirectChildren: vi.fn<() => Task[]>(() => []),
    replaceChildSubtreeWithUnassigned: vi.fn(() => ({ ok: true })),
    assignUnassignedToTask: vi.fn(() => ({ ok: true })),
    moveSubtreeToNewParent: vi.fn(() => ({ ok: true })),
    detachTaskWithSubtree: vi.fn(() => ({ ok: true })),
    moveTaskToStage: vi.fn(() => ({ ok: true })),
  };

  const mockToast = {
    success: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockTaskOps.isHintOnlyStartupReadOnly.mockReturnValue(false);
    mockTaskOps.moveTaskToStage.mockReturnValue({ ok: true });
    mockTaskOps.moveSubtreeToNewParent.mockReturnValue({ ok: true });
    mockTaskOps.assignUnassignedToTask.mockReturnValue({ ok: true });
    mockTaskOps.replaceChildSubtreeWithUnassigned.mockReturnValue({ ok: true });
    mockTaskOps.connectionAdapter.relinkCrossTreeConnection.mockResolvedValue(true);
    mockProjectState.activeProject.mockReturnValue({ connections: [] });

    tasksById = new Map<string, Task>([
      ['old-source', createTask({ id: 'old-source', title: '旧起点', stage: 1 })],
      ['new-source', createTask({ id: 'new-source', title: '新起点', stage: 1 })],
      ['old-target', createTask({ id: 'old-target', title: '旧终点', stage: 2 })],
      ['new-target', createTask({ id: 'new-target', title: '新终点', stage: 2 })],
      ['child', createTask({ id: 'child', title: '子任务', stage: 2, parentId: 'old-parent' })],
      ['grandchild', createTask({ id: 'grandchild', title: '孙任务', stage: 3, parentId: 'child' })],
      ['old-parent', createTask({ id: 'old-parent', title: '旧父任务', stage: 1 })],
      ['new-parent', createTask({ id: 'new-parent', title: '新父任务', stage: 1 })],
      ['unassigned-parent', createTask({ id: 'unassigned-parent', title: '待分配父任务', stage: null })],
      ['unassigned-child', createTask({ id: 'unassigned-child', title: '待分配子任务', stage: null })],
      ['replacement', createTask({ id: 'replacement', title: '替换任务', stage: null })],
      ['root-target', createTask({ id: 'root-target', title: '根任务目标', stage: 2 })],
      ['nested-target', createTask({ id: 'nested-target', title: '已有父任务目标', stage: 2, parentId: 'other-parent' })],
    ]);
    mockProjectState.tasks.set(Array.from(tasksById.values()));

    TestBed.configureTestingModule({
      providers: [
        FlowLinkRelinkService,
        { provide: ProjectStateService, useValue: mockProjectState },
        { provide: TaskOperationAdapterService, useValue: mockTaskOps },
        {
          provide: LoggerService,
          useValue: {
            category: () => ({
              debug: vi.fn(),
              info: vi.fn(),
              warn: vi.fn(),
              error: vi.fn(),
            }),
          },
        },
        { provide: ToastService, useValue: mockToast },
      ],
    });

    service = TestBed.inject(FlowLinkRelinkService);
  });

  it('hint-only 时跨树重连不应显示成功提示', async () => {
    mockTaskOps.isHintOnlyStartupReadOnly.mockReturnValue(true);

    const result = await service.handleCrossTreeRelink('old-source', 'old-target', 'new-source', 'new-target', 'to');

    expect(result).toBe('cancelled');
    expect(mockTaskOps.connectionAdapter.relinkCrossTreeConnection).not.toHaveBeenCalled();
    expect(mockToast.info).toHaveBeenCalledWith('会话确认中', '重连关联暂不可用，owner 确认完成前保持只读');
    expect(mockToast.success).not.toHaveBeenCalled();
  });

  it('hint-only 时父子重连不应迁移子树', async () => {
    mockTaskOps.isHintOnlyStartupReadOnly.mockReturnValue(true);

    const result = await service.handleParentChildRelink('child', 'old-parent', 'new-parent');

    expect(result).toBe('cancelled');
    expect(mockTaskOps.moveSubtreeToNewParent).not.toHaveBeenCalled();
    expect(mockToast.info).toHaveBeenCalledWith('会话确认中', '迁移任务暂不可用，owner 确认完成前保持只读');
    expect(mockToast.success).not.toHaveBeenCalled();
  });

  it('父子重连到新父任务时迁移整棵子树并提示子任务数量', async () => {
    const result = await service.handleParentChildRelink('child', 'old-parent', 'new-parent');

    expect(result).toBe('success');
    expect(mockTaskOps.moveSubtreeToNewParent).toHaveBeenCalledWith('child', 'new-parent');
    expect(mockToast.success).toHaveBeenCalledWith(
      '子树迁移成功',
      '已将 "子任务" 及其 1 个子任务移动到 "新父任务" 下'
    );
  });

  it('拒绝待分配块成为已分配任务的父节点', async () => {
    const result = await service.handleParentChildRelink('child', 'old-parent', 'unassigned-parent');

    expect(result).toBe('error');
    expect(mockTaskOps.moveSubtreeToNewParent).not.toHaveBeenCalled();
    expect(mockToast.warning).toHaveBeenCalledWith('无法连接', '待分配块无法成为任务块的父节点');
  });

  it('父子连接下游端点重连到待分配块时只替换原子任务', async () => {
    const child = tasksById.get('child');
    expect(child).toBeDefined();
    mockTaskOps.getDirectChildren.mockReturnValue([child as Task]);

    const result = await service.handleParentChildRelinkToEnd('old-parent', 'child', 'replacement');

    expect(result).toBe('replace-subtree');
    expect(mockTaskOps.replaceChildSubtreeWithUnassigned).toHaveBeenCalledWith(
      'old-parent',
      'replacement',
      'child'
    );
  });

  it('hint-only 时父子连接下游端点重连不应替换子树', async () => {
    const child = tasksById.get('child');
    expect(child).toBeDefined();
    mockTaskOps.isHintOnlyStartupReadOnly.mockReturnValue(true);
    mockTaskOps.getDirectChildren.mockReturnValue([child as Task]);

    const result = await service.handleParentChildRelinkToEnd('old-parent', 'child', 'replacement');

    expect(result).toBe('cancelled');
    expect(mockTaskOps.replaceChildSubtreeWithUnassigned).not.toHaveBeenCalled();
    expect(mockTaskOps.assignUnassignedToTask).not.toHaveBeenCalled();
    expect(mockToast.info).toHaveBeenCalledWith('会话确认中', '替换子任务暂不可用，owner 确认完成前保持只读');
  });

  it('父子连接下游端点拒绝连接到已有父节点的已分配任务', async () => {
    const result = await service.handleParentChildRelinkToEnd('old-parent', 'child', 'nested-target');

    expect(result).toBe('error');
    expect(mockTaskOps.moveTaskToStage).not.toHaveBeenCalled();
    expect(mockTaskOps.replaceChildSubtreeWithUnassigned).not.toHaveBeenCalled();
    expect(mockToast.warning).toHaveBeenCalledWith('无法连接', '目标任务已有父节点，无法建立新的父子关系');
  });

  it('跨树重连成功时原子替换关联并提示变化端点', async () => {
    const result = await service.handleCrossTreeRelink('old-source', 'old-target', 'new-source', 'new-target', 'from');

    expect(result).toBe('success');
    expect(mockTaskOps.connectionAdapter.relinkCrossTreeConnection).toHaveBeenCalledWith(
      'old-source',
      'old-target',
      'new-source',
      'new-target'
    );
    expect(mockToast.success).toHaveBeenCalledWith(
      '关联重连成功',
      '已将关联起点从 "旧起点" 移动到 "新起点"'
    );
  });

  it('跨树重连本地持久化失败时不显示成功提示', async () => {
    mockTaskOps.connectionAdapter.relinkCrossTreeConnection.mockResolvedValueOnce(false);

    const result = await service.handleCrossTreeRelink('old-source', 'old-target', 'new-source', 'new-target', 'from');

    expect(result).toBe('error');
    expect(mockToast.success).not.toHaveBeenCalled();
    expect(mockToast.error).toHaveBeenCalledWith('重连失败', '关联变更未能写入本地队列');
  });

  it('跨树重连发现未删除的重复关联时取消操作', async () => {
    mockProjectState.activeProject.mockReturnValue({
      connections: [{ id: 'existing', source: 'new-source', target: 'new-target', deletedAt: null } satisfies Connection],
    });

    const result = await service.handleCrossTreeRelink('old-source', 'old-target', 'new-source', 'new-target', 'to');

    expect(result).toBe('cancelled');
    expect(mockTaskOps.connectionAdapter.relinkCrossTreeConnection).not.toHaveBeenCalled();
    expect(mockToast.warning).toHaveBeenCalledWith('连接已存在', '"新起点" 到 "新终点" 的关联已存在');
  });
});
