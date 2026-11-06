import { Injector } from '@angular/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Attachment, Project, Task, type TaskAttentionDraftItem } from '../models';
import { LayoutService } from './layout.service';
import { LoggerService } from './logger.service';
import { ParkingService } from './parking.service';
import { ProjectStateService } from './project-state.service';
import { TaskAttributeService } from './task-attribute.service';
import { TaskRecordTrackingService } from './task-record-tracking.service';
import { ToastService } from './toast.service';

function createTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    title: '任务',
    content: '',
    stage: 1,
    parentId: null,
    order: 0,
    rank: 0,
    status: 'active',
    x: 0,
    y: 0,
    createdDate: '2026-06-05T00:00:00.000Z',
    updatedAt: '2026-06-05T00:00:00.000Z',
    displayId: '1',
    ...overrides,
  };
}

function createProject(task: Task): Project {
  return {
    id: 'project-1',
    name: '项目',
    description: '',
    createdDate: '2026-06-05T00:00:00.000Z',
    tasks: [task],
    connections: [],
  };
}

function createAttachment(overrides: Partial<Attachment> = {}): Attachment {
  return {
    id: 'attachment-1',
    type: 'file',
    name: 'note.txt',
    url: 'https://example.com/note.txt',
    createdAt: '2026-06-05T00:00:00.000Z',
    ...overrides,
  };
}

function createDeferred<T = unknown>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve: ((value: T | PromiseLike<T>) => void) | null = null;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve: resolve! };
}

describe('TaskAttributeService attention meta', () => {
  let service: TaskAttributeService;
  let recordAndUpdate: ReturnType<typeof vi.fn>;
  let recordAndUpdateDebounced: ReturnType<typeof vi.fn>;
  let recordAndUpdateDurably: ReturnType<typeof vi.fn>;
  let recordAndUpdateProjectDurably: ReturnType<typeof vi.fn>;
  let handleTaskStatusChange: ReturnType<typeof vi.fn>;
  let getTask: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    recordAndUpdate = vi.fn();
    recordAndUpdateDebounced = vi.fn();
    recordAndUpdateDurably = vi.fn().mockResolvedValue(true);
    recordAndUpdateProjectDurably = vi.fn().mockResolvedValue(true);
    handleTaskStatusChange = vi.fn();
    getTask = vi.fn(() => createTask());
    const injector = Injector.create({
      providers: [
        TaskAttributeService,
        { provide: LayoutService, useValue: { detectIncomplete: vi.fn(() => false) } },
        { provide: LoggerService, useValue: { category: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) } },
        { provide: ProjectStateService, useValue: {
          getTask,
          getProjectWithCurrentData: vi.fn(() => createProject(createTask({ id: 'shared-task' }))),
        } },
        { provide: TaskRecordTrackingService, useValue: {
          recordAndUpdate, recordAndUpdateDebounced, recordAndUpdateDurably, recordAndUpdateProjectDurably,
        } },
        { provide: ParkingService, useValue: { handleTaskStatusChange } },
        { provide: ToastService, useValue: { info: vi.fn() } },
      ],
    });
    service = injector.get(TaskAttributeService);
  });

  it('updateTaskTitleDurably 应通过 durable-first 记录器更新标题', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-05T08:00:00.000Z'));
    const project = createProject(createTask({ id: 'task-title', title: '旧标题' }));

    const result = await service.updateTaskTitleDurably('task-title', '新标题');

    expect(result).toBe(true);
    expect(recordAndUpdateDebounced).not.toHaveBeenCalled();
    expect(recordAndUpdateDurably).toHaveBeenCalledWith(expect.any(Function), {
      updateType: 'content',
      debouncedUndo: true,
    });
    const mutator = recordAndUpdateDurably.mock.calls[0]?.[0] as (current: Project) => Project;
    expect(mutator(project).tasks[0]).toEqual(expect.objectContaining({
      id: 'task-title',
      title: '新标题',
      updatedAt: '2026-06-05T08:00:00.000Z',
    }));
    vi.useRealTimers();
  });

  it('updateTaskTitle 默认入口应通过 durable-first 记录器更新标题', async () => {
    const result = await service.updateTaskTitle('task-title', '新标题');

    expect(result).toBe(true);
    expect(recordAndUpdateDebounced).not.toHaveBeenCalled();
    expect(recordAndUpdateDurably).toHaveBeenCalledWith(expect.any(Function), {
      updateType: 'content',
      debouncedUndo: true,
    });
  });

  it('updateTaskTitle 默认入口本地持久化失败时应返回 false 且不走旧 debounced 路径', async () => {
    recordAndUpdateDurably.mockResolvedValueOnce(false);

    const result = await service.updateTaskTitle('task-title', '新标题');

    expect(result).toBe(false);
    expect(recordAndUpdateDebounced).not.toHaveBeenCalled();
  });

  it('updateTaskStatusDurably 应在同一次 durable mutation 中完成状态切换和 parkingMeta 清理', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-05T08:00:00.000Z'));
    const project = createProject(createTask({
      id: 'task-status',
      status: 'active',
      completedAt: null,
      parkingMeta: {
        state: 'parked',
        parkedAt: '2026-06-01T00:00:00.000Z',
        lastVisitedAt: '2026-06-02T00:00:00.000Z',
        contextSnapshot: null,
        reminder: null,
        pinned: false,
      },
    }));

    const result = await service.updateTaskStatusDurably('task-status', 'completed');

    expect(result).toBe(true);
    expect(recordAndUpdate).not.toHaveBeenCalled();
    expect(recordAndUpdateDurably).toHaveBeenCalledWith(expect.any(Function), {
      updateType: 'content',
    });
    const mutator = recordAndUpdateDurably.mock.calls[0]?.[0] as (current: Project) => Project;
    expect(mutator(project).tasks[0]).toEqual(expect.objectContaining({
      id: 'task-status',
      status: 'completed',
      completedAt: '2026-06-05T08:00:00.000Z',
      parkingMeta: undefined,
      updatedAt: '2026-06-05T08:00:00.000Z',
    }));
    expect(handleTaskStatusChange).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('updateTaskStatusDurably 本地持久化失败时不应触发停泊联动', async () => {
    recordAndUpdateDurably.mockResolvedValue(false);

    const result = await service.updateTaskStatusDurably('task-status', 'completed');

    expect(result).toBe(false);
    expect(handleTaskStatusChange).not.toHaveBeenCalled();
  });

  it('updateTaskStatus 应等待默认 durable 写入成功后再触发停泊联动', async () => {
    const queueWrite = createDeferred<boolean>();
    recordAndUpdateDurably.mockReturnValueOnce(queueWrite.promise);

    const resultPromise = service.updateTaskStatus('task-status', 'completed');

    expect(recordAndUpdate).not.toHaveBeenCalled();
    expect(recordAndUpdateDurably).toHaveBeenCalledWith(expect.any(Function), {
      updateType: 'content',
    });
    expect(handleTaskStatusChange).not.toHaveBeenCalled();

    queueWrite.resolve(true);
    await expect(resultPromise).resolves.toBe(true);
    expect(handleTaskStatusChange).toHaveBeenCalledWith('task-status', 'completed');
  });

  it('updateTaskStatus 默认 durable 写入失败时不应触发停泊联动', async () => {
    recordAndUpdateDurably.mockResolvedValueOnce(false);

    const result = await service.updateTaskStatus('task-status', 'completed');

    expect(result).toBe(false);
    expect(handleTaskStatusChange).not.toHaveBeenCalled();
  });

  it('updateTaskParkingMetaBatchDurably 应在一次 durable 记录中更新多个任务停泊状态', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-05T08:00:00.000Z'));
    const focusedMeta = {
      state: 'parked' as const,
      parkedAt: '2026-06-05T07:00:00.000Z',
      lastVisitedAt: '2026-06-05T08:00:00.000Z',
      contextSnapshot: null,
      reminder: null,
      pinned: false,
    };
    const targetMeta = {
      ...focusedMeta,
      state: 'focused' as const,
    };
    const project: Project = {
      ...createProject(createTask({ id: 'focused-task' })),
      tasks: [
        createTask({ id: 'focused-task', parkingMeta: null }),
        createTask({ id: 'target-task', parkingMeta: null }),
        createTask({ id: 'other-task', parkingMeta: null }),
      ],
    };

    const result = await service.updateTaskParkingMetaBatchDurably([
      { taskId: 'focused-task', parkingMeta: focusedMeta },
      { taskId: 'target-task', parkingMeta: targetMeta },
    ]);

    expect(result).toBe(true);
    expect(recordAndUpdateDurably).toHaveBeenCalledWith(expect.any(Function), {
      updateType: 'content',
    });
    const mutator = recordAndUpdateDurably.mock.calls[0]?.[0] as (current: Project) => Project;
    const updated = mutator(project);
    expect(updated.tasks.find(task => task.id === 'focused-task')).toEqual(expect.objectContaining({
      parkingMeta: focusedMeta,
      updatedAt: '2026-06-05T08:00:00.000Z',
    }));
    expect(updated.tasks.find(task => task.id === 'target-task')).toEqual(expect.objectContaining({
      parkingMeta: targetMeta,
      updatedAt: '2026-06-05T08:00:00.000Z',
    }));
    expect(updated.tasks.find(task => task.id === 'other-task')?.parkingMeta).toBeNull();
    vi.useRealTimers();
  });

  it('explicit parking metadata mutations target only the captured project recorder', async () => {
    const updates = [{ taskId: 'shared-task', parkingMeta: null }];

    await service.updateTaskParkingMetaDurably('project-a', 'shared-task', null);
    await service.updateTaskParkingMetaBatchDurably('project-a', updates);

    expect(recordAndUpdateProjectDurably).toHaveBeenNthCalledWith(
      1, 'project-a', expect.any(Function), { updateType: 'content' },
    );
    expect(recordAndUpdateProjectDurably).toHaveBeenNthCalledWith(
      2, 'project-a', expect.any(Function), { updateType: 'content' },
    );
    expect(recordAndUpdateDurably).not.toHaveBeenCalled();
  });

  it('updateTaskPositionDurably 应通过 durable-first 记录器更新坐标', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-05T08:00:00.000Z'));
    const project = createProject(createTask({ id: 'task-position', x: 0, y: 0 }));

    const result = await service.updateTaskPositionDurably('task-position', 120, 240);

    expect(result).toBe(true);
    expect(recordAndUpdateDebounced).not.toHaveBeenCalled();
    expect(recordAndUpdateDurably).toHaveBeenCalledWith(expect.any(Function), {
      updateType: 'position',
      debouncedUndo: true,
    });
    const mutator = recordAndUpdateDurably.mock.calls[0]?.[0] as (current: Project) => Project;
    expect(mutator(project).tasks[0]).toEqual(expect.objectContaining({
      id: 'task-position',
      x: 120,
      y: 240,
      updatedAt: '2026-06-05T08:00:00.000Z',
    }));
    vi.useRealTimers();
  });

  it('updateTaskPosition 默认入口应通过 durable-first 记录器更新坐标', async () => {
    const result = await service.updateTaskPosition('task-position', 120, 240);

    expect(result).toBe(true);
    expect(recordAndUpdateDebounced).not.toHaveBeenCalled();
    expect(recordAndUpdateDurably).toHaveBeenCalledWith(expect.any(Function), {
      updateType: 'position',
      debouncedUndo: true,
    });
  });

  it('附件 durable 方法应通过 durable-first 记录器更新 set/add/remove', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-05T08:00:00.000Z'));
    const first = createAttachment({ id: 'att-1' });
    const second = createAttachment({ id: 'att-2', name: 'diagram.png' });
    const project = createProject(createTask({ id: 'task-attachments', attachments: [first] }));

    await service.updateTaskAttachmentsDurably('task-attachments', [second]);
    let mutator = recordAndUpdateDurably.mock.calls[0]?.[0] as (current: Project) => Project;
    expect(mutator(project).tasks[0]).toEqual(expect.objectContaining({
      attachments: [second],
      updatedAt: '2026-06-05T08:00:00.000Z',
    }));

    recordAndUpdateDurably.mockClear();
    await service.addTaskAttachmentDurably('task-attachments', second);
    mutator = recordAndUpdateDurably.mock.calls[0]?.[0] as (current: Project) => Project;
    expect(mutator(project).tasks[0]?.attachments).toEqual([first, second]);

    recordAndUpdateDurably.mockClear();
    await service.removeTaskAttachmentDurably('task-attachments', 'att-1');
    mutator = recordAndUpdateDurably.mock.calls[0]?.[0] as (current: Project) => Project;
    expect(mutator(project).tasks[0]?.attachments).toEqual([]);

    expect(recordAndUpdateDurably).toHaveBeenLastCalledWith(expect.any(Function), {
      updateType: 'content',
    });
    vi.useRealTimers();
  });

  it('标签 durable 方法应通过 durable-first 记录器更新 set/add/remove 并保持去重', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-05T08:00:00.000Z'));
    const project = createProject(createTask({ id: 'task-tags', tags: ['alpha'] }));

    await service.updateTaskTagsDurably('task-tags', ['beta']);
    let mutator = recordAndUpdateDurably.mock.calls[0]?.[0] as (current: Project) => Project;
    expect(mutator(project).tasks[0]).toEqual(expect.objectContaining({
      tags: ['beta'],
      updatedAt: '2026-06-05T08:00:00.000Z',
    }));

    recordAndUpdateDurably.mockClear();
    await service.addTaskTagDurably('task-tags', 'beta');
    mutator = recordAndUpdateDurably.mock.calls[0]?.[0] as (current: Project) => Project;
    expect(mutator(project).tasks[0]?.tags).toEqual(['alpha', 'beta']);

    recordAndUpdateDurably.mockClear();
    await service.addTaskTagDurably('task-tags', 'alpha');
    mutator = recordAndUpdateDurably.mock.calls[0]?.[0] as (current: Project) => Project;
    expect(mutator(project).tasks[0]?.tags).toEqual(['alpha']);

    recordAndUpdateDurably.mockClear();
    await service.removeTaskTagDurably('task-tags', 'alpha');
    mutator = recordAndUpdateDurably.mock.calls[0]?.[0] as (current: Project) => Project;
    expect(mutator(project).tasks[0]?.tags).toEqual([]);

    expect(recordAndUpdateDurably).toHaveBeenLastCalledWith(expect.any(Function), {
      updateType: 'content',
    });
    vi.useRealTimers();
  });

  it('priority 和 dueDate durable 方法应通过 durable-first 记录器更新表单字段', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-05T08:00:00.000Z'));
    const project = createProject(createTask({ id: 'task-form' }));

    await service.updateTaskPriorityDurably('task-form', 'urgent');
    let mutator = recordAndUpdateDurably.mock.calls[0]?.[0] as (current: Project) => Project;
    expect(mutator(project).tasks[0]).toEqual(expect.objectContaining({
      priority: 'urgent',
      updatedAt: '2026-06-05T08:00:00.000Z',
    }));

    recordAndUpdateDurably.mockClear();
    await service.updateTaskDueDateDurably('task-form', '2026-06-30');
    mutator = recordAndUpdateDurably.mock.calls[0]?.[0] as (current: Project) => Project;
    expect(mutator(project).tasks[0]).toEqual(expect.objectContaining({
      dueDate: '2026-06-30',
      updatedAt: '2026-06-05T08:00:00.000Z',
    }));

    expect(recordAndUpdateDurably).toHaveBeenLastCalledWith(expect.any(Function), {
      updateType: 'content',
    });
    vi.useRealTimers();
  });

  it('planner durable 方法应通过 durable-first 记录器保留规划字段校正规则', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-05T08:00:00.000Z'));
    getTask.mockReturnValue(createTask({
      id: 'task-planner',
      expected_minutes: 30,
      wait_minutes: 20,
      cognitive_load: 'low',
    }));
    const project = createProject(createTask({ id: 'task-planner' }));

    await service.updateTaskExpectedMinutesDurably('task-planner', 60);
    let mutator = recordAndUpdateDurably.mock.calls[0]?.[0] as (current: Project) => Project;
    expect(mutator(project).tasks[0]).toEqual(expect.objectContaining({
      expected_minutes: 60,
      wait_minutes: 20,
      updatedAt: '2026-06-05T08:00:00.000Z',
    }));

    recordAndUpdateDurably.mockClear();
    await service.updateTaskWaitMinutesDurably('task-planner', 90);
    mutator = recordAndUpdateDurably.mock.calls[0]?.[0] as (current: Project) => Project;
    expect(mutator(project).tasks[0]).toEqual(expect.objectContaining({
      expected_minutes: 90,
      wait_minutes: 90,
      updatedAt: '2026-06-05T08:00:00.000Z',
    }));

    recordAndUpdateDurably.mockClear();
    await service.updateTaskCognitiveLoadDurably('task-planner', 'high');
    mutator = recordAndUpdateDurably.mock.calls[0]?.[0] as (current: Project) => Project;
    expect(mutator(project).tasks[0]).toEqual(expect.objectContaining({
      cognitive_load: 'high',
      updatedAt: '2026-06-05T08:00:00.000Z',
    }));

    expect(recordAndUpdateDurably).toHaveBeenLastCalledWith(expect.any(Function), {
      updateType: 'content',
    });
    vi.useRealTimers();
  });

  it('addTodoItemDurably 应通过 durable-first 记录器追加待办内容并刷新未完成状态', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-05T08:00:00.000Z'));
    const project = createProject(createTask({
      id: 'task-todo',
      content: '已有内容',
      hasIncompleteTask: false,
    }));

    await service.addTodoItemDurably('task-todo', '补充验收');

    expect(recordAndUpdate).not.toHaveBeenCalled();
    expect(recordAndUpdateDurably).toHaveBeenCalledWith(expect.any(Function), {
      updateType: 'content',
    });
    const mutator = recordAndUpdateDurably.mock.calls[0]?.[0] as (current: Project) => Project;
    expect(mutator(project).tasks[0]).toEqual(expect.objectContaining({
      content: '已有内容\n- [ ] 补充验收',
      hasIncompleteTask: true,
      updatedAt: '2026-06-05T08:00:00.000Z',
    }));
    vi.useRealTimers();
  });

  it('updateTaskAttentionItemsDurably 应复用注意事项规范化并 durable-first 记录', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-05T08:00:00.000Z'));
    getTask.mockReturnValue(createTask({
      id: 'task-attention',
      attentionMeta: {
        pinned: true,
        updatedAt: '2026-06-04T00:00:00.000Z',
        items: [{
          id: 'existing',
          text: '旧内容',
          level: 'warning',
          done: false,
          createdAt: '2026-06-01T00:00:00.000Z',
          updatedAt: '2026-06-04T00:00:00.000Z',
        }],
      },
    }));
    const project = createProject(createTask({ id: 'task-attention' }));

    const result = await service.updateTaskAttentionItemsDurably('task-attention', [
      { id: 'existing', text: '  复核离线队列  ', level: 'critical' as TaskAttentionDraftItem['level'], done: true },
      { text: '新增检查', level: 'blocker', done: false },
      { text: '   ', level: 'info', done: false },
    ]);

    expect(result).toBe(true);
    expect(recordAndUpdateDebounced).not.toHaveBeenCalled();
    expect(recordAndUpdateDurably).toHaveBeenCalledWith(expect.any(Function), {
      updateType: 'content',
      debouncedUndo: true,
    });
    const mutator = recordAndUpdateDurably.mock.calls[0]?.[0] as (current: Project) => Project;
    expect(mutator(project).tasks[0]?.attentionMeta).toEqual({
      pinned: true,
      updatedAt: '2026-06-05T08:00:00.000Z',
      items: [
        {
          id: 'existing',
          text: '复核离线队列',
          level: 'info',
          done: true,
          createdAt: '2026-06-01T00:00:00.000Z',
          updatedAt: '2026-06-05T08:00:00.000Z',
        },
        {
          id: expect.any(String),
          text: '新增检查',
          level: 'blocker',
          done: false,
          createdAt: '2026-06-05T08:00:00.000Z',
          updatedAt: '2026-06-05T08:00:00.000Z',
        },
      ],
    });
    vi.useRealTimers();
  });

  it('updateTaskContentDurably 应通过 durable-first 记录器更新内容和待办状态', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-05T08:00:00.000Z'));
    const project = createProject(createTask({ id: 'task-content', content: '' }));

    const result = await service.updateTaskContentDurably('task-content', '- [ ] check');

    expect(result).toBe(true);
    expect(recordAndUpdateDebounced).not.toHaveBeenCalled();
    expect(recordAndUpdateDurably).toHaveBeenCalledWith(expect.any(Function), {
      updateType: 'content',
      debouncedUndo: true,
    });
    const mutator = recordAndUpdateDurably.mock.calls[0]?.[0] as (current: Project) => Project;
    expect(mutator(project).tasks[0]).toEqual(expect.objectContaining({
      id: 'task-content',
      content: '- [ ] check',
      updatedAt: '2026-06-05T08:00:00.000Z',
    }));
    vi.useRealTimers();
  });

  it('updateTaskContent 默认入口应通过 durable-first 记录器更新内容', async () => {
    const result = await service.updateTaskContent('task-content', '- [ ] check');

    expect(result).toBe(true);
    expect(recordAndUpdateDebounced).not.toHaveBeenCalled();
    expect(recordAndUpdateDurably).toHaveBeenCalledWith(expect.any(Function), {
      updateType: 'content',
      debouncedUndo: true,
    });
  });

  it('completeUnfinishedItemDurably 应通过 durable-first 记录器勾选待办并刷新状态', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-05T08:00:00.000Z'));
    const project = createProject(createTask({
      id: 'task-todo',
      content: '- [ ] first\n- [ ] second',
      hasIncompleteTask: true,
    }));

    const result = await service.completeUnfinishedItemDurably('task-todo', 0);

    expect(result).toBe(true);
    expect(recordAndUpdate).not.toHaveBeenCalled();
    expect(recordAndUpdateDurably).toHaveBeenCalledWith(expect.any(Function), {
      updateType: 'content',
    });
    const mutator = recordAndUpdateDurably.mock.calls[0]?.[0] as (current: Project) => Project;
    expect(mutator(project).tasks[0]).toEqual(expect.objectContaining({
      content: '- [x] first\n- [ ] second',
      hasIncompleteTask: true,
      updatedAt: '2026-06-05T08:00:00.000Z',
    }));
    vi.useRealTimers();
  });

  it('completeUnfinishedItem 默认入口应复用 durable-first 路径', async () => {
    const result = await service.completeUnfinishedItem('task-todo', 0);

    expect(result).toBe(true);
    expect(recordAndUpdate).not.toHaveBeenCalled();
    expect(recordAndUpdateDurably).toHaveBeenCalledWith(expect.any(Function), {
      updateType: 'content',
    });
  });

  it('updateTaskAttentionItems 应规范化注意事项并刷新 updatedAt', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-05T08:00:00.000Z'));
    const task = createTask();
    const project = createProject(task);

    const saved = await service.updateTaskAttentionItems('task-1', [
      { id: 'existing', text: '  Token 过期需刷新  ', level: 'warning', done: false },
      { text: '', level: 'info', done: false },
      { text: '接口字段未冻结', level: 'blocker', done: true },
    ]);

    expect(saved).toBe(true);
    expect(recordAndUpdate).not.toHaveBeenCalled();
    expect(recordAndUpdateDebounced).not.toHaveBeenCalled();
    expect(recordAndUpdateDurably).toHaveBeenCalledWith(expect.any(Function), {
      updateType: 'content',
      debouncedUndo: true,
    });
    const mutator = recordAndUpdateDurably.mock.calls[0]?.[0] as (current: Project) => Project;
    const result = mutator(project);
    const updatedTask = result.tasks[0];

    expect(updatedTask.attentionMeta).toEqual({
      items: [
        {
          id: 'existing',
          text: 'Token 过期需刷新',
          level: 'warning',
          done: false,
          createdAt: '2026-06-05T08:00:00.000Z',
          updatedAt: '2026-06-05T08:00:00.000Z',
        },
        {
          id: expect.any(String),
          text: '接口字段未冻结',
          level: 'blocker',
          done: true,
          createdAt: '2026-06-05T08:00:00.000Z',
          updatedAt: '2026-06-05T08:00:00.000Z',
        },
      ],
      pinned: false,
      updatedAt: '2026-06-05T08:00:00.000Z',
    });
    expect(updatedTask.updatedAt).toBe('2026-06-05T08:00:00.000Z');
    vi.useRealTimers();
  });

  it('updateTaskAttentionItems 在所有项为空白时应将 attentionMeta 置空', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-05T08:00:00.000Z'));
    const project = createProject(createTask());

    await service.updateTaskAttentionItems('task-1', [
      { text: '   ', level: 'info', done: false },
    ]);

    const mutator = recordAndUpdateDurably.mock.calls[0]?.[0] as (current: Project) => Project;
    const updatedTask = mutator(project).tasks[0];

    expect(updatedTask.attentionMeta).toBeNull();
    expect(updatedTask.updatedAt).toBe('2026-06-05T08:00:00.000Z');
    vi.useRealTimers();
  });

  it('updateTaskAttentionItems 应将非法 level 归一为 info', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-05T08:00:00.000Z'));
    const project = createProject(createTask());

    await service.updateTaskAttentionItems('task-1', [
      { text: '复核接口契约', level: 'critical' as unknown as TaskAttentionDraftItem['level'], done: false },
    ]);

    const mutator = recordAndUpdateDurably.mock.calls[0]?.[0] as (current: Project) => Project;
    const updatedTask = mutator(project).tasks[0];

    expect(updatedTask.attentionMeta?.items[0]?.level).toBe('info');
    vi.useRealTimers();
  });
});
