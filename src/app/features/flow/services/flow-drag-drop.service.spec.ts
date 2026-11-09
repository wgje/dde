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

type MockOperationResult = { ok: boolean; error?: { code: string; message: string } };
type MockOperationReturn = MockOperationResult | Promise<MockOperationResult>;

describe('FlowDragDropService', () => {
  let service: FlowDragDropService;
  let projectOwner = { projectId: 'project-a' as string | null, generation: 1 };
  const tasksSignal = signal<Task[]>([]);
  const mockProjectState = {
    tasks: tasksSignal,
    activeProjectId: vi.fn(() => projectOwner.projectId),
    captureActiveProjectOwner: vi.fn(() => ({ ...projectOwner })),
    isActiveProjectOwnerCurrent: vi.fn((owner: typeof projectOwner) =>
      owner.projectId === projectOwner.projectId && owner.generation === projectOwner.generation),
    getTask: vi.fn((_: string): Task | null => null),
    unassignedTasks: vi.fn(() => [] as Task[]),
  };

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

  const createTaskDragEvent = (taskId: string, target: EventTarget | null): DragEvent => {
    const dataTransfer = new DataTransfer();
    dataTransfer.setData('application/x-nanoflow-task', JSON.stringify({
      v: 1,
      type: 'task',
      taskId,
      projectId: projectOwner.projectId,
      projectOwner,
      source: 'flow',
    }));
    return {
      preventDefault: vi.fn(),
      dataTransfer,
      target,
    } as unknown as DragEvent;
  };

  const mockTaskOps = {
    isHintOnlyStartupReadOnly: vi.fn(() => false),
    updateTaskPosition: vi.fn(),
    detachTask: vi.fn(),
    insertTaskBetween: vi.fn((): MockOperationReturn => ({ ok: true })),
    insertTaskBetweenAtPosition: vi.fn((): MockOperationReturn => ({ ok: true })),
    moveTaskToStage: vi.fn((): MockOperationReturn => ({ ok: true })),
    moveTaskToStageAtPosition: vi.fn((): MockOperationReturn => ({ ok: true })),
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
  const mockLoggerCategory = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  const createDockPanel = (): HTMLDivElement => {
    const panel = document.createElement('div');
    panel.setAttribute('data-testid', 'dock-v3-panel');
    vi.spyOn(panel, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, right: 200,
      bottom: 200, width: 200, height: 200, x: 0, y: 0, toJSON: () => ({}) } as DOMRect);
    document.body.appendChild(panel);
    return panel;
  };

  const dockDragInternal = () => service as unknown as {
    dragToDockTaskIds: string[];
    dragToDockOwner: typeof projectOwner | null;
    onAltDragUp: (event: PointerEvent) => void;
  };
  const releaseDockDrag = (): void => {
    dockDragInternal().onAltDragUp({ clientX: 100, clientY: 100 } as PointerEvent);
  };

  beforeEach(() => {
    vi.clearAllMocks();
    projectOwner = { projectId: 'project-a', generation: 1 };
    mockTaskOps.isHintOnlyStartupReadOnly.mockReturnValue(false);
    mockTaskOps.detachTask.mockResolvedValue(true);
    mockTaskOps.updateTaskPosition.mockReset();
    mockTaskOps.updateTaskPosition.mockResolvedValue(true);
    mockTaskOps.moveTaskToStage.mockReturnValue({ ok: true });
    mockTaskOps.moveTaskToStageAtPosition.mockReturnValue({ ok: true });
    mockTaskOps.insertTaskBetween.mockReturnValue({ ok: true });
    mockTaskOps.insertTaskBetweenAtPosition.mockReturnValue({ ok: true });
    tasksSignal.set([]);
    mockProjectState.getTask.mockImplementation((_: string) => null);
    mockProjectState.unassignedTasks.mockReturnValue([]);
    mockLoggerCategory.debug.mockClear();
    mockLoggerCategory.info.mockClear();
    mockLoggerCategory.warn.mockClear();
    mockLoggerCategory.error.mockClear();

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
            category: () => mockLoggerCategory,
          },
        },
        { provide: ToastService, useValue: mockToast },
        { provide: NgZone, useValue: new NgZone({ enableLongStackTrace: false }) },
      ],
    });

    service = TestBed.inject(FlowDragDropService);
  });

  it('suppresses stale move UI after A-B-A and releases the operation claim', async () => {
    const task = createTask({ stage: 1 });
    let finish!: (result: MockOperationResult) => void;
    mockProjectState.getTask.mockReturnValue(createTask({ id: 'parent', stage: 1 }));
    mockTaskOps.moveTaskToStageAtPosition.mockReturnValueOnce(
      new Promise<MockOperationResult>(resolve => { finish = resolve; }));
    const first = service.processDrop(task, { parentId: 'parent' }, new go.Point(4, 8));
    projectOwner = { projectId: 'project-b', generation: 2 };
    projectOwner = { projectId: 'project-a', generation: 3 };
    finish({ ok: false, error: { code: 'FAILED', message: 'late A' } });
    await first;
    expect(mockToast.error).not.toHaveBeenCalled();
    await service.processDrop(task, { parentId: 'parent' }, new go.Point(4, 8));
    expect(mockTaskOps.moveTaskToStageAtPosition).toHaveBeenCalledTimes(2);
  });

  afterEach(() => {
    vi.useRealTimers();
    TestBed.resetTestingModule();
  });

  it('hint-only 时待分配任务拖放不应产生视觉位移', async () => {
    mockTaskOps.isHintOnlyStartupReadOnly.mockReturnValue(true);

    await service.processDrop(createTask({ stage: null }), {}, new go.Point(120, 220));

    expect(mockTaskOps.updateTaskPosition).not.toHaveBeenCalled();
    expect(mockLayoutService.setNodePosition).not.toHaveBeenCalled();
    expect(mockToast.info).toHaveBeenCalledWith('会话确认中', '移动任务暂不可用，owner 确认完成前保持只读');
  });

  it('非 hint-only 时待分配任务拖放应在本地位置持久化后更新视觉位置', async () => {
    mockTaskOps.updateTaskPosition.mockResolvedValueOnce(true);

    await service.processDrop(createTask({ stage: null }), {}, new go.Point(120, 220));

    expect(mockTaskOps.updateTaskPosition).toHaveBeenCalledWith('task-1', 120, 220);
    expect(mockLayoutService.setNodePosition).toHaveBeenCalledWith('task-1', 120, 220);
  });

  it('待分配任务拖放应保持重复保护直到位置持久化完成', async () => {
    let resolvePersist!: () => void;
    const persistPromise = new Promise<boolean>(resolve => {
      resolvePersist = () => resolve(true);
    });
    mockTaskOps.updateTaskPosition
      .mockReturnValueOnce(persistPromise)
      .mockResolvedValue(true);
    const task = createTask({ id: 'task-1', stage: null });
    const dropPoint = new go.Point(120, 220);

    const firstDrop = service.processDrop(task, {}, dropPoint);
    await Promise.resolve();

    expect(mockTaskOps.updateTaskPosition).toHaveBeenCalledTimes(1);

    const duplicateDrop = service.processDrop(task, {}, dropPoint);
    await Promise.resolve();

    expect(mockTaskOps.updateTaskPosition).toHaveBeenCalledTimes(1);

    resolvePersist();
    await Promise.all([firstDrop, duplicateDrop]);

    await service.processDrop(task, {}, dropPoint);

    expect(mockTaskOps.updateTaskPosition).toHaveBeenCalledTimes(2);
  });

  it('服务销毁后晚到的待分配任务位置持久化结果不应更新视觉位置', async () => {
    let resolvePersist!: () => void;
    mockTaskOps.updateTaskPosition.mockReturnValue(new Promise<boolean>(resolve => {
      resolvePersist = () => resolve(true);
    }));

    const dropping = service.processDrop(createTask({ stage: null }), {}, new go.Point(120, 220));
    await Promise.resolve();

    service.ngOnDestroy();
    resolvePersist();
    await dropping;

    expect(mockLayoutService.setNodePosition).not.toHaveBeenCalled();
  });

  it('待分配任务位置持久化失败时不应更新视觉位置', async () => {
    mockTaskOps.updateTaskPosition.mockRejectedValueOnce(new Error('idb failed'));

    await expect(
      service.processDrop(createTask({ stage: null }), {}, new go.Point(120, 220)),
    ).rejects.toThrow('idb failed');

    expect(mockLayoutService.setNodePosition).not.toHaveBeenCalled();
  });

  it('待分配任务位置持久化返回 false 时不应更新视觉位置', async () => {
    mockTaskOps.updateTaskPosition.mockResolvedValueOnce(false);

    await expect(
      service.processDrop(createTask({ stage: null }), {}, new go.Point(120, 220)),
    ).rejects.toThrow('Task position local persistence failed');

    expect(mockLayoutService.setNodePosition).not.toHaveBeenCalled();
  });

  it('交互入口安全提交 drop 时应记录失败而不让 reject 外溢', async () => {
    const dropError = new Error('idb failed');
    const processDrop = vi.spyOn(service, 'processDrop').mockRejectedValueOnce(dropError);
    const task = createTask({ stage: null });
    const dropPoint = new go.Point(120, 220);

    service.processDropFromInteraction(task, {}, dropPoint);
    await Promise.resolve();

    expect(processDrop).toHaveBeenCalledWith(task, {}, dropPoint, 100);
    expect(mockLoggerCategory.error).toHaveBeenCalledWith('拖放处理失败', dropError);
  });

  it('已分配任务拖到空白画布时应保持重复保护直到位置持久化完成', async () => {
    let resolvePersist!: () => void;
    const persistPromise = new Promise<boolean>(resolve => {
      resolvePersist = () => resolve(true);
    });
    mockTaskOps.updateTaskPosition.mockReturnValue(persistPromise);
    const movedTask = createTask({ id: 'task-1', stage: 1 });
    const dropPoint = new go.Point(120, 220);

    const firstDrop = service.processDrop(movedTask, {}, dropPoint);
    await Promise.resolve();

    expect(mockTaskOps.updateTaskPosition).toHaveBeenCalledTimes(1);

    await service.processDrop(movedTask, {}, dropPoint);

    expect(mockTaskOps.updateTaskPosition).toHaveBeenCalledTimes(1);

    resolvePersist();
    await firstDrop;

    await service.processDrop(movedTask, {}, dropPoint);

    expect(mockTaskOps.updateTaskPosition).toHaveBeenCalledTimes(2);
  });

  it('已分配任务空白画布位置持久化失败后应释放重复保护并允许重试', async () => {
    const movedTask = createTask({ id: 'task-1', stage: 1 });
    const dropPoint = new go.Point(120, 220);
    mockTaskOps.updateTaskPosition
      .mockRejectedValueOnce(new Error('idb failed'))
      .mockResolvedValueOnce(true);

    await expect(service.processDrop(movedTask, {}, dropPoint)).rejects.toThrow('idb failed');
    await service.processDrop(movedTask, {}, dropPoint);

    expect(mockTaskOps.updateTaskPosition).toHaveBeenCalledTimes(2);
  });

  it('已分配任务空白画布位置持久化返回 false 后应释放重复保护并允许重试', async () => {
    const movedTask = createTask({ id: 'task-1', stage: 1 });
    const dropPoint = new go.Point(120, 220);
    mockTaskOps.updateTaskPosition
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    await expect(service.processDrop(movedTask, {}, dropPoint))
      .rejects.toThrow('Task position local persistence failed');
    await service.processDrop(movedTask, {}, dropPoint);

    expect(mockTaskOps.updateTaskPosition).toHaveBeenCalledTimes(2);
  });

  it('结构移动失败时不应继续调度位置更新', async () => {
    vi.useFakeTimers();
    const parentTask = createTask({ id: 'parent-1', stage: 1 });
    const movedTask = createTask({ id: 'task-1', stage: 2 });
    tasksSignal.set([movedTask, parentTask]);
    mockProjectState.getTask.mockImplementation((taskId: string) => {
      if (taskId === 'parent-1') return parentTask;
      if (taskId === 'task-1') return movedTask;
      return null;
    });
    mockTaskOps.moveTaskToStageAtPosition.mockReturnValue({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'invalid move' } });

    await service.processDrop(movedTask, { parentId: 'parent-1' }, new go.Point(80, 160));
    vi.advanceTimersByTime(200);

    expect(mockTaskOps.updateTaskPosition).not.toHaveBeenCalled();
    expect(mockToast.error).toHaveBeenCalledWith('移动任务失败', '数据验证失败');
  });

  it('拖到同级任务之后时应以单次 durable 提交持久化结构移动和落点位置', async () => {
    const movedTask = createTask({ id: 'task-1', stage: 2, parentId: 'parent-1', rank: 50 });
    const afterTask = createTask({ id: 'after-1', stage: 2, parentId: 'parent-1', rank: 100 });
    const nextSibling = createTask({ id: 'next-1', stage: 2, parentId: 'parent-1', rank: 200 });
    tasksSignal.set([movedTask, afterTask, nextSibling]);
    mockProjectState.getTask.mockImplementation((taskId: string) => {
      if (taskId === 'after-1') return afterTask;
      if (taskId === 'next-1') return nextSibling;
      if (taskId === 'task-1') return movedTask;
      return null;
    });

    await service.processDrop(movedTask, { afterTaskId: 'after-1' }, new go.Point(80, 160));

    expect(mockTaskOps.moveTaskToStageAtPosition).toHaveBeenCalledWith('task-1', 2, 'next-1', 'parent-1', 80, 160);
    expect(mockTaskOps.moveTaskToStage).not.toHaveBeenCalled();
    expect(mockTaskOps.updateTaskPosition).not.toHaveBeenCalled();
  });

  it('结构和落点位置的单次 durable 提交失败时不应执行第二次位置提交', async () => {
    const movedTask = createTask({ id: 'task-1', stage: 2, parentId: 'parent-1', rank: 50 });
    const afterTask = createTask({ id: 'after-1', stage: 2, parentId: 'parent-1', rank: 100 });
    const nextSibling = createTask({ id: 'next-1', stage: 2, parentId: 'parent-1', rank: 200 });
    tasksSignal.set([movedTask, afterTask, nextSibling]);
    mockProjectState.getTask.mockImplementation((taskId: string) => {
      if (taskId === 'after-1') return afterTask;
      if (taskId === 'next-1') return nextSibling;
      if (taskId === 'task-1') return movedTask;
      return null;
    });
    mockTaskOps.moveTaskToStageAtPosition.mockReturnValueOnce({
      ok: false,
      error: { code: 'OPERATION_FAILED', message: 'local persist failed' },
    });

    await service.processDrop(movedTask, { afterTaskId: 'after-1' }, new go.Point(80, 160));

    expect(mockTaskOps.moveTaskToStageAtPosition).toHaveBeenCalledWith('task-1', 2, 'next-1', 'parent-1', 80, 160);
    expect(mockTaskOps.moveTaskToStage).not.toHaveBeenCalled();
    expect(mockTaskOps.updateTaskPosition).not.toHaveBeenCalled();
    expect(mockToast.error).toHaveBeenCalledWith('移动任务失败', '操作失败');
  });

  it('重复同一插入 drop 在落点位置持久化完成前只执行一次结构移动', async () => {
    let resolvePositionPersist!: () => void;
    const positionPersist = new Promise<{ ok: boolean }>(resolve => {
      resolvePositionPersist = () => resolve({ ok: true });
    });
    mockTaskOps.moveTaskToStageAtPosition.mockReturnValue(positionPersist);
    const movedTask = createTask({ id: 'task-1', stage: 2, parentId: 'parent-1', rank: 50 });
    const afterTask = createTask({ id: 'after-1', stage: 2, parentId: 'parent-1', rank: 100 });
    const nextSibling = createTask({ id: 'next-1', stage: 2, parentId: 'parent-1', rank: 200 });
    const dropPoint = new go.Point(80, 160);
    tasksSignal.set([movedTask, afterTask, nextSibling]);
    mockProjectState.getTask.mockImplementation((taskId: string) => {
      if (taskId === 'after-1') return afterTask;
      if (taskId === 'next-1') return nextSibling;
      if (taskId === 'task-1') return movedTask;
      return null;
    });

    const firstDrop = service.processDrop(movedTask, { afterTaskId: 'after-1' }, dropPoint);
    await Promise.resolve();
    await service.processDrop(movedTask, { afterTaskId: 'after-1' }, dropPoint);

    expect(mockTaskOps.moveTaskToStageAtPosition).toHaveBeenCalledTimes(1);
    expect(mockTaskOps.moveTaskToStage).not.toHaveBeenCalled();
    expect(mockTaskOps.updateTaskPosition).not.toHaveBeenCalled();

    resolvePositionPersist();
    await firstDrop;

    await service.processDrop(movedTask, { afterTaskId: 'after-1' }, dropPoint);

    expect(mockTaskOps.moveTaskToStageAtPosition).toHaveBeenCalledTimes(2);
  });

  it('结构移动抛错后应释放重复保护，允许同一 drop 后续重试', async () => {
    const parentTask = createTask({ id: 'parent-1', stage: 1 });
    const movedTask = createTask({ id: 'task-1', stage: 2 });
    const dropPoint = new go.Point(80, 160);
    tasksSignal.set([movedTask, parentTask]);
    mockProjectState.getTask.mockImplementation((taskId: string) => {
      if (taskId === 'parent-1') return parentTask;
      if (taskId === 'task-1') return movedTask;
      return null;
    });
    mockTaskOps.moveTaskToStageAtPosition
      .mockRejectedValueOnce(new Error('move failed'))
      .mockResolvedValueOnce({ ok: true });

    await expect(
      service.processDrop(movedTask, { parentId: 'parent-1' }, dropPoint),
    ).rejects.toThrow('move failed');

    await service.processDrop(movedTask, { parentId: 'parent-1' }, dropPoint);

    expect(mockTaskOps.moveTaskToStageAtPosition).toHaveBeenCalledTimes(2);
    expect(mockTaskOps.moveTaskToStage).not.toHaveBeenCalled();
  });

  it('拖回待分配区应等待本地持久化成功后再显示成功提示', async () => {
    const assignedTask = createTask({ id: 'task-1', title: 'Assigned task', stage: 1 });
    tasksSignal.set([assignedTask]);
    mockProjectState.getTask.mockReturnValue(assignedTask);
    mockTaskOps.detachTask.mockResolvedValueOnce(false);
    const dataTransfer = new DataTransfer();
    dataTransfer.setData('application/x-nanoflow-task', JSON.stringify({
      v: 1,
      type: 'task',
      taskId: 'task-1',
      projectId: projectOwner.projectId,
      projectOwner,
      source: 'flow',
    }));

    const failed = await service.handleDropToUnassigned({
      preventDefault: vi.fn(),
      dataTransfer,
    } as unknown as DragEvent);

    expect(failed).toBe(false);
    expect(mockTaskOps.detachTask).toHaveBeenCalledWith('task-1');
    expect(mockToast.success).not.toHaveBeenCalled();

    mockTaskOps.detachTask.mockResolvedValueOnce(true);
    const succeeded = await service.handleDropToUnassigned({
      preventDefault: vi.fn(),
      dataTransfer,
    } as unknown as DragEvent);

    expect(succeeded).toBe(true);
    expect(mockToast.success).toHaveBeenCalledWith('已移至待分配', '任务 "Assigned task" 已解除分配');
  });

  it('待分配任务应挂到实际落点卡片，而不是候选列表首项', async () => {
    const draggedTask = createTask({ id: 'dragged-task' });
    const firstCandidate = createTask({ id: 'first-candidate' });
    const targetTask = createTask({ id: 'actual-target' });
    const tasksById = new Map([draggedTask, firstCandidate, targetTask].map(task => [task.id, task]));
    mockProjectState.getTask.mockImplementation((taskId: string) => tasksById.get(taskId) ?? null);
    mockProjectState.unassignedTasks.mockReturnValue([draggedTask, firstCandidate, targetTask]);
    const targetCard = document.createElement('div');
    targetCard.dataset['unassignedTaskId'] = targetTask.id;
    const targetText = document.createElement('span');
    targetCard.append(targetText);

    const moved = await service.handleFullUnassignedDrop(
      createTaskDragEvent(draggedTask.id, targetText),
    );

    expect(moved).toBe(true);
    expect(mockTaskOps.moveTaskToStage).toHaveBeenCalledWith(
      draggedTask.id,
      null,
      undefined,
      targetTask.id,
    );
  });

  it('待分配任务落在空白区域时不应猜测目标并改变父子关系', async () => {
    const draggedTask = createTask({ id: 'dragged-task' });
    const candidate = createTask({ id: 'candidate-task' });
    mockProjectState.getTask.mockImplementation((taskId: string) => (
      taskId === draggedTask.id ? draggedTask : candidate
    ));
    mockProjectState.unassignedTasks.mockReturnValue([draggedTask, candidate]);

    const moved = await service.handleFullUnassignedDrop(
      createTaskDragEvent(draggedTask.id, document.createElement('div')),
    );

    expect(moved).toBe(false);
    expect(mockTaskOps.moveTaskToStage).not.toHaveBeenCalled();
  });

  it('卡片身份指向非待分配任务时不应执行重挂载', async () => {
    const draggedTask = createTask({ id: 'dragged-task' });
    const candidate = createTask({ id: 'candidate-task' });
    const assignedTarget = createTask({ id: 'assigned-target', stage: 2 });
    const tasksById = new Map([draggedTask, candidate, assignedTarget].map(task => [task.id, task]));
    mockProjectState.getTask.mockImplementation((taskId: string) => tasksById.get(taskId) ?? null);
    mockProjectState.unassignedTasks.mockReturnValue([draggedTask, candidate]);
    const targetCard = document.createElement('div');
    targetCard.dataset['unassignedTaskId'] = assignedTarget.id;

    const moved = await service.handleFullUnassignedDrop(
      createTaskDragEvent(draggedTask.id, targetCard),
    );

    expect(moved).toBe(false);
    expect(mockTaskOps.moveTaskToStage).not.toHaveBeenCalled();
  });

  it('插入连接线应以单次 durable 提交持久化结构和落点位置', async () => {
    const sourceTask = createTask({ id: 'source-1', stage: 1 });
    const targetTask = createTask({ id: 'target-1', stage: 2, parentId: 'source-1' });
    mockProjectState.getTask.mockImplementation((taskId: string) => {
      if (taskId === 'source-1') return sourceTask;
      if (taskId === 'target-1') return targetTask;
      return null;
    });

    const inserted = await service.insertTaskBetweenNodes('task-1', 'source-1', 'target-1', new go.Point(40, 60));

    expect(inserted).toBe(true);
    expect(mockTaskOps.insertTaskBetweenAtPosition).toHaveBeenCalledWith('task-1', 'source-1', 'target-1', 40, 60);
    expect(mockTaskOps.insertTaskBetween).not.toHaveBeenCalled();
    expect(mockTaskOps.updateTaskPosition).not.toHaveBeenCalled();
    expect(mockToast.success).toHaveBeenCalledWith('任务已插入', '任务已插入到两个节点之间');
  });

  it('插入连接线失败时不应显示成功提示或调度位置更新', async () => {
    vi.useFakeTimers();
    const sourceTask = createTask({ id: 'source-1', stage: 1 });
    const targetTask = createTask({ id: 'target-1', stage: 2, parentId: 'source-1' });
    mockProjectState.getTask.mockImplementation((taskId: string) => {
      if (taskId === 'source-1') return sourceTask;
      if (taskId === 'target-1') return targetTask;
      return null;
    });
    mockTaskOps.insertTaskBetweenAtPosition.mockReturnValue({
      ok: false,
      error: { code: 'VALIDATION_ERROR', message: 'invalid link insert' },
    });

    const inserted = await service.insertTaskBetweenNodes('task-1', 'source-1', 'target-1', new go.Point(40, 60));
    vi.advanceTimersByTime(200);

    expect(inserted).toBe(false);
    expect(mockTaskOps.insertTaskBetweenAtPosition).toHaveBeenCalledWith('task-1', 'source-1', 'target-1', 40, 60);
    expect(mockTaskOps.insertTaskBetween).not.toHaveBeenCalled();
    expect(mockTaskOps.updateTaskPosition).not.toHaveBeenCalled();
    expect(mockToast.success).not.toHaveBeenCalledWith('任务已插入', '任务已插入到两个节点之间');
    expect(mockToast.error).toHaveBeenCalledWith('插入失败', '数据验证失败');
  });

  it('hint-only 时拖入停泊坞不应执行真实停泊', () => {
    mockTaskOps.isHintOnlyStartupReadOnly.mockReturnValue(true);
    const task = createTask({ id: 'task-1', stage: 1 });
    mockProjectState.getTask.mockReturnValue(task);

    const dockPanel = createDockPanel();

    try {
      service.startDragToDock(['task-1'], 0, 0);
      releaseDockDrag();

      expect(mockDockEngine.dockTaskFromExternalDrag).not.toHaveBeenCalled();
      expect(mockToast.info).toHaveBeenCalledWith('会话确认中', '拖入停泊坞暂不可用，owner 确认完成前保持只读');
    } finally {
      dockPanel.remove();
    }
  });

  it('拖入停泊坞失败时不应计为成功或显示成功提示', () => {
    const task = createTask({ id: 'task-1', stage: 1 });
    mockProjectState.getTask.mockReturnValue(task);
    mockDockEngine.dockTaskFromExternalDrag.mockReturnValue(false);

    const dockPanel = createDockPanel();

    try {
      service.startDragToDock(['task-1'], 0, 0);
      releaseDockDrag();

      expect(mockDockEngine.dockTaskFromExternalDrag).toHaveBeenCalledWith('task-1', 'flow');
      expect(mockToast.success).not.toHaveBeenCalled();
    } finally {
      dockPanel.remove();
    }
  });

  it('拖入停泊坞提交未完成时应忽略同一任务的重复释放', async () => {
    const task = createTask({ id: 'task-1', stage: 1 });
    let resolveDock!: (docked: boolean) => void;
    mockProjectState.getTask.mockReturnValue(task);
    mockDockEngine.dockTaskFromExternalDrag.mockReturnValue(new Promise<boolean>(resolve => {
      resolveDock = resolve;
    }));

    const dockPanel = createDockPanel();

    try {
      service.startDragToDock(['task-1'], 0, 0);
      releaseDockDrag();
      await Promise.resolve();

      service.startDragToDock(['task-1'], 0, 0);
      releaseDockDrag();
      await Promise.resolve();

      expect(mockDockEngine.dockTaskFromExternalDrag).toHaveBeenCalledTimes(1);

      resolveDock(true);
      await flushAsyncWork();
      expect(mockToast.success).toHaveBeenCalledWith('已加入停泊坞', '任务已从流程图拖入停泊坞');
    } finally {
      dockPanel.remove();
    }
  });

  it.each([
    ['A to B', { projectId: 'project-b', generation: 2 }, false],
    ['A to B to A', { projectId: 'project-a', generation: 3 }, false],
    ['duplicate A', { projectId: 'project-a', generation: 1 }, true],
  ] as const)('release-time ownership rejects %s before same-id task resolution', (_label, nextOwner, valid) => {
    mockProjectState.getTask.mockReturnValue(createTask({ id: 'task-1', stage: 1 }));
    const dockPanel = createDockPanel();
    try {
      service.startDragToDock(['task-1'], 0, 0);
      mockProjectState.getTask.mockClear();
      projectOwner = { ...nextOwner };
      releaseDockDrag();
      expect(mockProjectState.getTask).toHaveBeenCalledTimes(valid ? 1 : 0);
      expect(mockDockEngine.dockTaskFromExternalDrag).toHaveBeenCalledTimes(valid ? 1 : 0);
    } finally {
      dockPanel.remove();
    }
  });

  it('rejects ownerless pointer release and clears task-owner state together', () => {
    mockProjectState.getTask.mockReturnValue(createTask({ id: 'task-1', stage: 1 }));
    const dockPanel = createDockPanel();
    try {
      dockDragInternal().dragToDockTaskIds = ['task-1'];
      releaseDockDrag();
      expect(mockProjectState.getTask).not.toHaveBeenCalled();
      expect(mockDockEngine.dockTaskFromExternalDrag).not.toHaveBeenCalled();
      expect(dockDragInternal().dragToDockTaskIds).toEqual([]);
      expect(dockDragInternal().dragToDockOwner).toBeNull();
    } finally {
      dockPanel.remove();
    }
  });

  it('lets durable A docking finish after A-B-A but suppresses its stale success UI', async () => {
    let resolveDock!: (docked: boolean) => void;
    mockProjectState.getTask.mockReturnValue(createTask({ id: 'task-1', stage: 1 }));
    mockDockEngine.dockTaskFromExternalDrag.mockReturnValue(new Promise<boolean>(resolve => {
      resolveDock = resolve;
    }));
    const dockPanel = createDockPanel();
    try {
      service.startDragToDock(['task-1'], 0, 0);
      releaseDockDrag();
      await Promise.resolve();
      projectOwner = { projectId: 'project-a', generation: 3 };
      resolveDock(true);
      await flushAsyncWork();
      expect(mockDockEngine.dockTaskFromExternalDrag).toHaveBeenCalledOnce();
      expect(mockToast.success).not.toHaveBeenCalled();
      expect(dockDragInternal().dragToDockOwner).toBeNull();
      expect(dockDragInternal().dragToDockTaskIds).toEqual([]);
    } finally {
      dockPanel.remove();
    }
  });

  it('拖入停泊坞部分任务 rejected 时应记录失败并保留已成功任务提示', async () => {
    const failedTask = createTask({ id: 'task-1', title: 'Failed task', stage: 1 });
    const succeededTask = createTask({ id: 'task-2', title: 'Succeeded task', stage: 1 });
    const dockError = new Error('dock failed');
    mockProjectState.getTask.mockImplementation((taskId: string) => {
      if (taskId === 'task-1') return failedTask;
      if (taskId === 'task-2') return succeededTask;
      return null;
    });
    mockDockEngine.dockTaskFromExternalDrag.mockImplementation(async (taskId: string) => {
      if (taskId === 'task-1') {
        throw dockError;
      }
      return true;
    });

    const dockPanel = createDockPanel();

    try {
      service.startDragToDock(['task-1', 'task-2'], 0, 0);
      releaseDockDrag();
      await Promise.resolve();
      await Promise.resolve();

      expect(mockDockEngine.dockTaskFromExternalDrag).toHaveBeenCalledTimes(2);
      expect(mockLoggerCategory.warn).toHaveBeenCalledWith(
        '拖入停泊坞任务失败',
        { taskId: 'task-1', error: dockError },
      );
      expect(mockToast.success).toHaveBeenCalledWith('已加入停泊坞', '任务已从流程图拖入停泊坞');
    } finally {
      dockPanel.remove();
    }
  });

  it('服务销毁后晚到的拖入停泊坞结果不应显示成功提示', async () => {
    const task = createTask({ id: 'task-1', title: 'Dock later', stage: 1 });
    let resolveDock!: (docked: boolean) => void;
    mockProjectState.getTask.mockReturnValue(task);
    mockDockEngine.dockTaskFromExternalDrag.mockReturnValue(new Promise<boolean>(resolve => {
      resolveDock = resolve;
    }));

    const dockPanel = createDockPanel();

    try {
      service.startDragToDock(['task-1'], 0, 0);
      releaseDockDrag();
      await Promise.resolve();

      expect(mockDockEngine.dockTaskFromExternalDrag).toHaveBeenCalledWith('task-1', 'flow');
      service.ngOnDestroy();
      resolveDock(true);
      await flushAsyncWork();

      expect(mockToast.success).not.toHaveBeenCalled();
    } finally {
      dockPanel.remove();
    }
  });
});

async function flushAsyncWork(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await new Promise(resolve => setTimeout(resolve, 0));
}
