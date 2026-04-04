import { TestBed } from '@angular/core/testing';
import { NgZone, signal } from '@angular/core';
import { afterEach, describe, expect, it, beforeEach, vi } from 'vitest';
import * as go from 'gojs';

import { FlowDragDropService } from './flow-drag-drop.service';
import { ProjectStateService } from '../../../../services/project-state.service';
import { TaskOperationAdapterService } from '../../../../services/task-operation-adapter.service';
import { DockEngineService } from '../../../../services/dock-engine.service';
import { FlowLayoutService } from './flow-layout.service';
import { LoggerService } from '../../../../services/logger.service';
import { ToastService } from '../../../../services/toast.service';
import type { Task } from '../../../../models';

describe('FlowDragDropService', () => {
  let service: FlowDragDropService;
  const tasksSignal = signal<Task[]>([]);
  const mockProjectState = {
    tasks: tasksSignal,
    getTask: vi.fn((_: string) => null),
    unassignedTasks: vi.fn(() => [] as Task[]),
  };

  const createTask = (overrides: Partial<Task> = {}): Task => ({
    id: 'task-1',
    title: 'Task',
    content: '',
    status: 'active',
    stage: null,
    order: 0,
    projectId: 'project-1',
    parentId: null,
    level: 0,
    path: 'task-1',
    sortKey: 'task-1',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    userId: 'local-user',
    isExpanded: false,
    attachments: [],
    tags: [],
    parkingMeta: null,
    ...overrides,
  });

  const mockTaskOps = {
    isHintOnlyStartupReadOnly: vi.fn(() => false),
    updateTaskPosition: vi.fn(),
    detachTask: vi.fn(),
    insertTaskBetween: vi.fn(() => ({ ok: true })),
    moveTaskToStage: vi.fn(() => ({ ok: true })),
  };

  const mockLayoutService = {
    setNodePosition: vi.fn(),
  };

  const mockDockEngine = {
    dockTaskFromExternalDrag: vi.fn(),
    dockExpanded: vi.fn(() => true),
    setDockExpanded: vi.fn(),
  };

  const mockToast = {
    info: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockTaskOps.isHintOnlyStartupReadOnly.mockReturnValue(false);
    mockTaskOps.moveTaskToStage.mockReturnValue({ ok: true });
    mockTaskOps.insertTaskBetween.mockReturnValue({ ok: true });
    tasksSignal.set([]);
    mockProjectState.getTask.mockImplementation((_: string) => null);
    mockProjectState.unassignedTasks.mockReturnValue([]);

    TestBed.configureTestingModule({
      providers: [
        FlowDragDropService,
        { provide: ProjectStateService, useValue: mockProjectState },
        { provide: TaskOperationAdapterService, useValue: mockTaskOps },
        { provide: DockEngineService, useValue: mockDockEngine },
        { provide: FlowLayoutService, useValue: mockLayoutService },
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
        { provide: NgZone, useValue: new NgZone({ enableLongStackTrace: false }) },
      ],
    });

    service = TestBed.inject(FlowDragDropService);
  });

  afterEach(() => {
    vi.useRealTimers();
    TestBed.resetTestingModule();
  });

  it('hint-only 时待分配任务拖放不应产生视觉位移', () => {
    mockTaskOps.isHintOnlyStartupReadOnly.mockReturnValue(true);

    service.processDrop(createTask({ stage: null }), {}, new go.Point(120, 220));

    expect(mockTaskOps.updateTaskPosition).not.toHaveBeenCalled();
    expect(mockLayoutService.setNodePosition).not.toHaveBeenCalled();
    expect(mockToast.info).toHaveBeenCalledWith('会话确认中', '移动任务暂不可用，owner 确认完成前保持只读');
  });

  it('非 hint-only 时待分配任务拖放应同步更新数据与视觉位置', () => {
    service.processDrop(createTask({ stage: null }), {}, new go.Point(120, 220));

    expect(mockTaskOps.updateTaskPosition).toHaveBeenCalledWith('task-1', 120, 220);
    expect(mockLayoutService.setNodePosition).toHaveBeenCalledWith('task-1', 120, 220);
  });

  it('结构移动失败时不应继续调度位置更新', () => {
    vi.useFakeTimers();
    const parentTask = createTask({ id: 'parent-1', stage: 1 });
    const movedTask = createTask({ id: 'task-1', stage: 2 });
    tasksSignal.set([movedTask, parentTask]);
    mockProjectState.getTask.mockImplementation((taskId: string) => {
      if (taskId === 'parent-1') return parentTask;
      if (taskId === 'task-1') return movedTask;
      return null;
    });
    mockTaskOps.moveTaskToStage.mockReturnValue({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'invalid move' } });

    service.processDrop(movedTask, { parentId: 'parent-1' }, new go.Point(80, 160));
    vi.advanceTimersByTime(200);

    expect(mockTaskOps.updateTaskPosition).not.toHaveBeenCalled();
    expect(mockToast.error).toHaveBeenCalledWith('移动任务失败', '数据验证失败');
  });

  it('插入连接线失败时不应显示成功提示或调度位置更新', () => {
    vi.useFakeTimers();
    const sourceTask = createTask({ id: 'source-1', stage: 1 });
    const targetTask = createTask({ id: 'target-1', stage: 2, parentId: 'source-1' });
    mockProjectState.getTask.mockImplementation((taskId: string) => {
      if (taskId === 'source-1') return sourceTask;
      if (taskId === 'target-1') return targetTask;
      return null;
    });
    mockTaskOps.insertTaskBetween.mockReturnValue({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'invalid link insert' } });

    const inserted = service.insertTaskBetweenNodes('task-1', 'source-1', 'target-1', new go.Point(40, 60));
    vi.advanceTimersByTime(200);

    expect(inserted).toBe(false);
    expect(mockTaskOps.updateTaskPosition).not.toHaveBeenCalled();
    expect(mockToast.success).not.toHaveBeenCalledWith('任务已插入', '任务已插入到两个节点之间');
    expect(mockToast.error).toHaveBeenCalledWith('插入失败', '数据验证失败');
  });

  it('hint-only 时拖入停泊坞不应执行真实停泊', () => {
    mockTaskOps.isHintOnlyStartupReadOnly.mockReturnValue(true);
    const task = createTask({ id: 'task-1', stage: 1 });
    mockProjectState.getTask.mockReturnValue(task);

    const dockPanel = document.createElement('div');
    dockPanel.setAttribute('data-testid', 'dock-v3-panel');
    vi.spyOn(dockPanel, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      right: 200,
      bottom: 200,
      width: 200,
      height: 200,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);
    document.body.appendChild(dockPanel);

    try {
      const internal = service as unknown as {
        dragToDockTaskIds: string[];
        onAltDragUp: (event: PointerEvent) => void;
      };
      internal.dragToDockTaskIds = ['task-1'];

      internal.onAltDragUp({ clientX: 100, clientY: 100 } as PointerEvent);

      expect(mockDockEngine.dockTaskFromExternalDrag).not.toHaveBeenCalled();
      expect(mockToast.info).toHaveBeenCalledWith('会话确认中', '拖入停泊坞暂不可用，owner 确认完成前保持只读');
    } finally {
      dockPanel.remove();
    }
  });
});