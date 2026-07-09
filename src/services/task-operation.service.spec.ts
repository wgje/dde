/**
 * TaskOperationService 单元测试
 *
 * 使用 Injector 隔离模式，无需 TestBed。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Injector, runInInjectionContext } from '@angular/core';

import { TaskOperationService } from './task-operation.service';
import { TaskTrashService } from './task-trash.service';
import { LayoutService } from './layout.service';
import { LoggerService } from './logger.service';
import { ToastService } from './toast.service';
import { SubtreeOperationsService } from './subtree-operations.service';
import { TaskCreationService } from './task-creation.service';
import { TaskMoveService } from './task-move.service';
import { TaskAttributeService } from './task-attribute.service';
import { TaskConnectionService } from './task-connection.service';
import { ParkingService } from './parking.service';
import { ProjectStateService } from './project-state.service';
import { TaskRecordTrackingService } from './task-record-tracking.service';
import { TombstoneService } from '../core-bridge';
import { Project, Task, Connection } from '../models';
import { success } from '../utils/result';
import { registerTaskOperationMoveStageSpecs } from './task-operation-move-stage.spec-helpers';

const mockLoggerCategory = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

const mockLoggerService = {
  category: vi.fn(() => mockLoggerCategory),
};

const mockParkingService = {
  handleTaskSoftDelete: vi.fn(),
  handleTaskStatusChange: vi.fn(),
};

const mockTombstoneService = {
  clearLocalTombstones: vi.fn(),
};

function createTask(overrides: Partial<Task>): Task {
  const now = new Date().toISOString();
  return {
    id: overrides.id ?? crypto.randomUUID(),
    title: overrides.title ?? 'T',
    content: overrides.content ?? '',
    stage: overrides.stage ?? 1,
    parentId: overrides.parentId ?? null,
    order: overrides.order ?? 1,
    rank: overrides.rank ?? 1000,
    status: overrides.status ?? 'active',
    x: overrides.x ?? 0,
    y: overrides.y ?? 0,
    createdDate: overrides.createdDate ?? now,
    updatedAt: overrides.updatedAt ?? now,
    displayId: overrides.displayId ?? '?',
    shortId: overrides.shortId,
    hasIncompleteTask: overrides.hasIncompleteTask,
    deletedAt: overrides.deletedAt,
    deletedConnections: overrides.deletedConnections,
    deletedMeta: overrides.deletedMeta,
    attachments: overrides.attachments,
    tags: overrides.tags,
    priority: overrides.priority,
    dueDate: overrides.dueDate,
  };
}

function createProject(overrides: Partial<Project>): Project {
  const now = new Date().toISOString();
  return {
    id: overrides.id ?? 'p1',
    name: overrides.name ?? 'P',
    description: overrides.description ?? '',
    createdDate: overrides.createdDate ?? now,
    tasks: overrides.tasks ?? [],
    connections: overrides.connections ?? [],
    updatedAt: overrides.updatedAt,
    version: overrides.version,
    viewState: overrides.viewState,
    flowchartUrl: overrides.flowchartUrl,
    flowchartThumbnailUrl: overrides.flowchartThumbnailUrl,
  };
}

registerTaskOperationMoveStageSpecs({ createTask, createProject });

describe('TaskOperationService (deletedMeta restore)', () => {
  let service: TaskOperationService;
  let project: Project;
  let consoleLogSpy: ReturnType<typeof vi.spyOn> | undefined;
  let consoleInfoSpy: ReturnType<typeof vi.spyOn> | undefined;
  let consoleDebugSpy: ReturnType<typeof vi.spyOn> | undefined;

  beforeEach(() => {
    // 测试默认静默：避免内部调试日志写入 stdout。
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleInfoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    consoleDebugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});

    // 默认项目会在每个测试里初始化
    project = createProject({});

    // 子服务的 DI mock：ProjectStateService 和 TaskRecordTrackingService
    const mockProjectState = {
      activeProject: () => project,
      getTask: (taskId: string) => project?.tasks.find(t => t.id === taskId),
    };
    const mockRecorder = {
      recordAndUpdate: (mutator: (p: Project) => Project) => {
        project = mutator(project);
      },
      recordAndUpdateDebounced: (mutator: (p: Project) => Project) => {
        project = mutator(project);
      },
      recordAndUpdateDurably: async (mutator: (p: Project) => Project) => {
        project = mutator(project);
        return true;
      },
      lastUpdateType: 'structure' as const,
    };

    const injector = Injector.create({
      providers: [
        { provide: LayoutService, useClass: LayoutService },
        { provide: ToastService, useClass: ToastService },
        { provide: LoggerService, useValue: mockLoggerService },
        { provide: ParkingService, useValue: mockParkingService },
        { provide: TombstoneService, useValue: mockTombstoneService },
        { provide: TaskTrashService, useClass: TaskTrashService },
        { provide: SubtreeOperationsService, useClass: SubtreeOperationsService },
        { provide: TaskCreationService, useClass: TaskCreationService },
        { provide: TaskMoveService, useClass: TaskMoveService },
        { provide: TaskAttributeService, useClass: TaskAttributeService },
        { provide: TaskConnectionService, useClass: TaskConnectionService },
        { provide: ProjectStateService, useValue: mockProjectState },
        { provide: TaskRecordTrackingService, useValue: mockRecorder },
      ],
    });

    service = runInInjectionContext(injector, () => new TaskOperationService());
  });

  afterEach(() => {
    consoleLogSpy?.mockRestore();
    consoleInfoSpy?.mockRestore();
    consoleDebugSpy?.mockRestore();
  });

  it('deleteTask() 会写入 deletedMeta，restoreTask() 会消费并清除 deletedMeta', async () => {
    const parent = createTask({
      id: 'parent',
      stage: 1,
      order: 1,
      rank: 1100,
      x: 10,
      y: 20,
      parentId: null,
      displayId: '1,a',
      shortId: 'NF-PARENT',
      deletedAt: null,
    });

    const child = createTask({
      id: 'child',
      stage: 1,
      order: 2,
      rank: 1200,
      x: 30,
      y: 40,
      parentId: 'parent',
      displayId: '1,a.1',
      shortId: 'NF-CHILD',
      deletedAt: null,
    });

    const other = createTask({
      id: 'other',
      stage: 1,
      order: 3,
      rank: 1300,
      x: 50,
      y: 60,
      parentId: null,
      displayId: '1,b',
      shortId: 'NF-OTHER',
      deletedAt: null,
    });

    const connections: Connection[] = [
      { id: 'c-parent-child', source: 'parent', target: 'child' },
      { id: 'c-parent-other', source: 'parent', target: 'other' },
      { id: 'c-child-other', source: 'child', target: 'other' },
    ];

    project = createProject({
      tasks: [parent, child, other],
      connections,
    });

    await service.deleteTask('parent');

    const afterDeleteParent = project.tasks.find(t => t.id === 'parent')!;
    const afterDeleteChild = project.tasks.find(t => t.id === 'child')!;
    const afterDeleteOther = project.tasks.find(t => t.id === 'other')!;

    expect(afterDeleteParent.deletedAt).toBeTruthy();
    expect(afterDeleteParent.stage).toBeNull();
    expect(afterDeleteParent.deletedMeta).toEqual({
      parentId: null,
      stage: 1,
      order: 1,
      rank: 1100,
      x: 10,
      y: 20,
      parkingMeta: null,
    });
    expect(afterDeleteParent.deletedConnections?.length).toBe(3);

    expect(afterDeleteChild.deletedAt).toBeTruthy();
    expect(afterDeleteChild.stage).toBeNull();
    expect(afterDeleteChild.deletedMeta).toEqual({
      parentId: 'parent',
      stage: 1,
      order: 2,
      rank: 1200,
      x: 30,
      y: 40,
      parkingMeta: null,
    });

    // 未删除任务不应受影响
    expect(afterDeleteOther.deletedAt ?? null).toBeNull();

    // 连接应从项目中移除（避免引用已删除任务）
    expect(project.connections.length).toBe(0);

    service.restoreTask('parent');

    const afterRestoreParent = project.tasks.find(t => t.id === 'parent')!;
    const afterRestoreChild = project.tasks.find(t => t.id === 'child')!;

    expect(afterRestoreParent.deletedAt ?? null).toBeNull();
    expect(afterRestoreParent.deletedMeta).toBeUndefined();
    expect(afterRestoreParent.parentId).toBeNull();
    expect(afterRestoreParent.stage).toBe(1);

    expect(afterRestoreChild.deletedAt ?? null).toBeNull();
    expect(afterRestoreChild.deletedMeta).toBeUndefined();
    expect(afterRestoreChild.parentId).toBe('parent');
    // rebalance 会强制子任务 stage = parent.stage + 1
    expect(afterRestoreChild.stage).toBe(2);

    // 删除时保存的连接应被恢复（包含父子连线）
    const connKeys = new Set(project.connections.map(c => `${c.source}->${c.target}`));
    expect(connKeys.has('parent->child')).toBe(true);
    expect(connKeys.has('parent->other')).toBe(true);
    expect(connKeys.has('child->other')).toBe(true);
  });
});

describe('TaskOperationService (database constraint validation)', () => {
  let service: TaskOperationService;
  let project: Project;
  let recordAndUpdateDurably: ReturnType<typeof vi.fn>;
  let consoleLogSpy: ReturnType<typeof vi.spyOn> | undefined;
  let consoleInfoSpy: ReturnType<typeof vi.spyOn> | undefined;
  let consoleDebugSpy: ReturnType<typeof vi.spyOn> | undefined;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleInfoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    consoleDebugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});

    project = createProject({});

    const mockProjectState = {
      activeProject: () => project,
      getTask: (taskId: string) => project?.tasks.find(t => t.id === taskId),
    };
    const mockRecorder = {
      recordAndUpdate: (mutator: (p: Project) => Project) => {
        project = mutator(project);
      },
      recordAndUpdateDebounced: (mutator: (p: Project) => Project) => {
        project = mutator(project);
      },
      recordAndUpdateDurably: recordAndUpdateDurably = vi.fn(async (mutator: (p: Project) => Project) => {
        project = mutator(project);
        return true;
      }),
      lastUpdateType: 'structure' as const,
    };

    const injector = Injector.create({
      providers: [
        { provide: LayoutService, useClass: LayoutService },
        { provide: ToastService, useClass: ToastService },
        { provide: LoggerService, useValue: mockLoggerService },
        { provide: ParkingService, useValue: mockParkingService },
        { provide: TombstoneService, useValue: mockTombstoneService },
        { provide: TaskTrashService, useClass: TaskTrashService },
        { provide: SubtreeOperationsService, useClass: SubtreeOperationsService },
        { provide: TaskCreationService, useClass: TaskCreationService },
        { provide: TaskMoveService, useClass: TaskMoveService },
        { provide: TaskAttributeService, useClass: TaskAttributeService },
        { provide: TaskConnectionService, useClass: TaskConnectionService },
        { provide: ProjectStateService, useValue: mockProjectState },
        { provide: TaskRecordTrackingService, useValue: mockRecorder },
      ],
    });

    service = runInInjectionContext(injector, () => new TaskOperationService());
  });

  afterEach(() => {
    consoleLogSpy?.mockRestore();
    consoleInfoSpy?.mockRestore();
    consoleDebugSpy?.mockRestore();
  });

  it('addTask 当 title 和 content 都为空时应设置默认 title', async () => {
    const result = await service.addTask({
      title: '',
      content: '',
      targetStage: 1,
      parentId: null,
      isSibling: false
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      const newTask = project.tasks.find(t => t.id === result.value);
      expect(newTask).toBeDefined();
      expect(newTask!.title).toBe('新任务');
    }
  });

  it('addTaskDurably 应通过本地持久化路径创建任务', async () => {
    const result = await service.addTaskDurably({
      title: '本地优先创建',
      content: 'offline-first',
      targetStage: 1,
      parentId: null,
      isSibling: false
    });

    expect(result.ok).toBe(true);
    expect(recordAndUpdateDurably).toHaveBeenCalledTimes(1);
    if (result.ok) {
      const newTask = project.tasks.find(t => t.id === result.value);
      expect(newTask).toBeDefined();
      expect(newTask!.title).toBe('本地优先创建');
      expect(newTask!.content).toBe('offline-first');
    }
  });

  it('updateTaskTitle 当 title 为空且 content 为空时应设置默认 title', () => {
    const task = createTask({ id: 'task-1', title: '原标题', content: '' });
    project = createProject({ tasks: [task] });

    service.updateTaskTitle('task-1', '');

    const updatedTask = project.tasks.find(t => t.id === 'task-1')!;
    expect(updatedTask.title).toBe('新任务');
  });

  it('updateTaskContent 当 content 为空且 title 为空时应设置默认 title', () => {
    const task = createTask({ id: 'task-1', title: '', content: '原内容' });
    project = createProject({ tasks: [task] });

    service.updateTaskContent('task-1', '');

    const updatedTask = project.tasks.find(t => t.id === 'task-1')!;
    expect(updatedTask.title).toBe('新任务');
  });

  it('addTask 当 title 有值但 content 为空时不应修改 title', async () => {
    const result = await service.addTask({
      title: '我的标题',
      content: '',
      targetStage: 1,
      parentId: null,
      isSibling: false
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      const newTask = project.tasks.find(t => t.id === result.value);
      expect(newTask!.title).toBe('我的标题');
    }
  });

  it('addFloatingTask 当 title 和 content 都为空时应设置默认 title', async () => {
    await service.addFloatingTask('', '', 100, 200);

    const floatingTasks = project.tasks.filter(t => t.stage === null);
    expect(floatingTasks.length).toBeGreaterThan(0);
    const newTask = floatingTasks[floatingTasks.length - 1];
    expect(newTask.title).toBe('新任务');
    expect(newTask.x).toBe(100);
    expect(newTask.y).toBe(200);
  });

  it('addFloatingTaskDurably 应通过本地持久化路径创建浮动任务', async () => {
    const saved = await service.addFloatingTaskDurably('本地浮动', '', 100, 200);

    expect(saved).toBe(true);
    expect(recordAndUpdateDurably).toHaveBeenCalledTimes(1);
    const floatingTasks = project.tasks.filter(t => t.stage === null);
    expect(floatingTasks.length).toBeGreaterThan(0);
    const newTask = floatingTasks[floatingTasks.length - 1];
    expect(newTask.title).toBe('本地浮动');
    expect(newTask.x).toBe(100);
    expect(newTask.y).toBe(200);
  });

  it('deleteTaskDurably 应通过本地持久化路径软删除任务', async () => {
    const task = createTask({ id: 'task-delete', title: '本地删除', deletedAt: null });
    project = createProject({ tasks: [task] });

    const result = await service.deleteTaskDurably('task-delete');

    expect(result.saved).toBe(true);
    expect(recordAndUpdateDurably).toHaveBeenCalledTimes(1);
    expect(result.deletedTaskIds).toEqual(new Set(['task-delete']));
    expect(project.tasks.find(t => t.id === 'task-delete')?.deletedAt).toBeTruthy();
  });

  it('deleteTaskKeepChildrenDurably 应软删除父任务并保留子任务', async () => {
    const parent = createTask({ id: 'parent', stage: 1, parentId: null, deletedAt: null });
    const child = createTask({ id: 'child', stage: 2, parentId: 'parent', deletedAt: null });
    project = createProject({ tasks: [parent, child] });

    const result = await service.deleteTaskKeepChildrenDurably('parent');

    expect(result.saved).toBe(true);
    expect(recordAndUpdateDurably).toHaveBeenCalledTimes(1);
    expect(result.deletedTaskIds).toEqual(new Set(['parent']));
    expect(project.tasks.find(t => t.id === 'parent')?.deletedAt).toBeTruthy();
    expect(project.tasks.find(t => t.id === 'child')?.deletedAt).toBeNull();
    expect(project.tasks.find(t => t.id === 'child')?.parentId).toBeNull();
  });

  it('trash restore and hard-delete durable wrappers 应复用本地持久化路径', async () => {
    const deletedAt = '2026-06-01T00:00:00.000Z';
    const deletedTask = createTask({
      id: 'task-restore',
      title: '恢复',
      deletedAt,
      deletedMeta: { parentId: null, stage: 1, order: 1, rank: 1000, x: 0, y: 0, parkingMeta: null },
    });
    const hardDeleteTask = createTask({ id: 'task-hard-delete', deletedAt });
    const emptyTrashTask = createTask({ id: 'task-empty-trash', deletedAt });
    project = createProject({ tasks: [deletedTask, hardDeleteTask, emptyTrashTask] });

    const restoreResult = await service.restoreTaskDurably('task-restore');
    const permanentResult = await service.permanentlyDeleteTaskDurably('task-hard-delete');
    const emptyResult = await service.emptyTrashDurably();

    expect(restoreResult.saved).toBe(true);
    expect(permanentResult.saved).toBe(true);
    expect(emptyResult.saved).toBe(true);
    expect(recordAndUpdateDurably).toHaveBeenCalledTimes(3);
    expect(project.tasks.map(task => task.id)).toEqual(['task-restore']);
    expect(project.tasks[0].deletedAt).toBeNull();
  });

  it('moveTaskToStageDurably 应通过本地持久化路径移动任务', async () => {
    const root = createTask({ id: 'root', stage: 1, parentId: null, rank: 1000 });
    const task = createTask({ id: 'move-task', stage: 2, parentId: 'root', rank: 2000 });
    project = createProject({ tasks: [root, task] });

    const result = await service.moveTaskToStageDurably({ taskId: 'move-task', newStage: 5 });

    expect(result.ok).toBe(true);
    expect(recordAndUpdateDurably).toHaveBeenCalledTimes(1);
    expect(project.tasks.find(t => t.id === 'move-task')?.stage).toBe(5);
    expect(project.tasks.find(t => t.id === 'move-task')?.parentId).toBeNull();
  });

  it('insertTaskBetweenDurably 应通过本地持久化路径插入任务', async () => {
    const source = createTask({ id: 'source', stage: 1, parentId: null, rank: 1000 });
    const target = createTask({ id: 'target', stage: 2, parentId: 'source', rank: 2000 });
    const inserted = createTask({ id: 'inserted', stage: null, parentId: null, rank: 3000 });
    project = createProject({ tasks: [source, target, inserted] });

    const result = await service.insertTaskBetweenDurably({
      taskId: 'inserted',
      sourceId: 'source',
      targetId: 'target',
    });

    expect(result.ok).toBe(true);
    expect(recordAndUpdateDurably).toHaveBeenCalledTimes(1);
    expect(project.tasks.find(t => t.id === 'inserted')?.parentId).toBe('source');
    expect(project.tasks.find(t => t.id === 'target')?.parentId).toBe('inserted');
  });

  it('insertTaskBetweenAtPositionDurably 应在同一次本地持久化提交中插入任务并写入落点', async () => {
    const source = createTask({ id: 'source', stage: 1, parentId: null, rank: 1000 });
    const target = createTask({ id: 'target', stage: 2, parentId: 'source', rank: 2000 });
    const inserted = createTask({ id: 'inserted', stage: null, parentId: null, rank: 3000, x: 0, y: 0 });
    project = createProject({ tasks: [source, target, inserted] });

    const result = await service.insertTaskBetweenAtPositionDurably({
      taskId: 'inserted',
      sourceId: 'source',
      targetId: 'target',
      x: 40,
      y: 60,
    });

    expect(result.ok).toBe(true);
    expect(recordAndUpdateDurably).toHaveBeenCalledTimes(1);
    expect(project.tasks.find(t => t.id === 'inserted')).toMatchObject({
      parentId: 'source',
      stage: 2,
      rank: 2000,
      x: 40,
      y: 60,
    });
    expect(project.tasks.find(t => t.id === 'target')?.parentId).toBe('inserted');
  });

  it('insertTaskBetweenDurably 在本地持久化失败时不提交 UI 变更', async () => {
    const source = createTask({ id: 'source', stage: 1, parentId: null, rank: 1000 });
    const target = createTask({ id: 'target', stage: 2, parentId: 'source', rank: 2000 });
    const inserted = createTask({ id: 'inserted', stage: null, parentId: null, rank: 3000 });
    project = createProject({ tasks: [source, target, inserted] });
    recordAndUpdateDurably.mockResolvedValueOnce(false);

    const result = await service.insertTaskBetweenDurably({
      taskId: 'inserted',
      sourceId: 'source',
      targetId: 'target',
    });

    expect(result.ok).toBe(false);
    expect(project.tasks.find(t => t.id === 'inserted')?.parentId).toBeNull();
    expect(project.tasks.find(t => t.id === 'target')?.parentId).toBe('source');
  });

  it('reorderStageDurably 应通过本地持久化路径重排阶段任务', async () => {
    const first = createTask({ id: 'first', stage: 1, parentId: null, rank: 1000 });
    const second = createTask({ id: 'second', stage: 1, parentId: null, rank: 2000 });
    project = createProject({ tasks: [first, second] });

    const saved = await service.reorderStageDurably(1, ['second', 'first']);

    expect(saved).toBe(true);
    expect(recordAndUpdateDurably).toHaveBeenCalledTimes(1);
    expect(project.tasks.find(t => t.id === 'second')?.rank).toBeLessThan(
      project.tasks.find(t => t.id === 'first')!.rank,
    );
  });

  it('repairMissingStageOne 默认入口应通过本地持久化路径修复缺失阶段 1', async () => {
    const stageTwoRoot = createTask({ id: 'stage-two-root', stage: 2, parentId: null, rank: 2000 });
    project = createProject({ tasks: [stageTwoRoot] });

    const saved = await service.repairMissingStageOne();

    expect(saved).toBe(true);
    expect(recordAndUpdateDurably).toHaveBeenCalledTimes(1);
  });

  it('repairMissingStageOne 默认入口在本地持久化失败时不提交 UI 变更', async () => {
    const stageTwoRoot = createTask({ id: 'stage-two-root', stage: 2, parentId: null, rank: 2000 });
    project = createProject({ tasks: [stageTwoRoot] });
    recordAndUpdateDurably.mockResolvedValueOnce(false);

    const saved = await service.repairMissingStageOne();

    expect(saved).toBe(false);
    expect(recordAndUpdateDurably).toHaveBeenCalledTimes(1);
  });

  it('repairMissingStageOneDurably 应通过本地持久化路径修复缺失阶段 1', async () => {
    const stageTwoRoot = createTask({ id: 'stage-two-root', stage: 2, parentId: null, rank: 2000 });
    project = createProject({ tasks: [stageTwoRoot] });

    const saved = await service.repairMissingStageOneDurably();

    expect(saved).toBe(true);
    expect(recordAndUpdateDurably).toHaveBeenCalledTimes(1);
  });

  it('updateTaskPositionWithRankSyncDurably 应通过本地持久化路径更新坐标和 rank', async () => {
    const moving = createTask({ id: 'moving', stage: 1, parentId: null, rank: 1000, x: 0, y: 0 });
    const after = createTask({ id: 'after', stage: 1, parentId: null, rank: 2000, x: 0, y: 200 });
    project = createProject({ tasks: [moving, after] });

    const saved = await service.updateTaskPositionWithRankSyncDurably('moving', 40, 300);

    expect(saved).toBe(true);
    expect(recordAndUpdateDurably).toHaveBeenCalledTimes(1);
    const updated = project.tasks.find(task => task.id === 'moving');
    expect(updated).toEqual(expect.objectContaining({
      x: 40,
      y: 300,
      rank: expect.any(Number),
    }));
    expect(updated?.rank).toBeGreaterThan(after.rank);
  });

  it('detach and subtree durable wrappers 应复用本地持久化路径', async () => {
    const root = createTask({ id: 'root', stage: 1, parentId: null, rank: 1000 });
    const child = createTask({ id: 'child', stage: 2, parentId: 'root', rank: 2000 });
    const newParent = createTask({ id: 'new-parent', stage: 1, parentId: null, rank: 3000 });
    const moving = createTask({ id: 'moving', stage: 2, parentId: 'root', rank: 4000 });
    project = createProject({ tasks: [root, child, newParent, moving] });

    const detached = await service.detachTaskDurably('child');
    const subtreeDetached = await service.detachTaskWithSubtreeDurably('root');
    const moved = await service.moveSubtreeToNewParentDurably('moving', 'new-parent');

    expect(detached).toBe(true);
    expect(subtreeDetached.ok).toBe(true);
    expect(moved.ok).toBe(true);
    expect(recordAndUpdateDurably).toHaveBeenCalledTimes(3);
    expect(project.tasks.find(t => t.id === 'child')?.stage).toBeNull();
    expect(project.tasks.find(t => t.id === 'root')?.stage).toBeNull();
    expect(project.tasks.find(t => t.id === 'moving')?.parentId).toBe('new-parent');
  });

  it('assignment durable wrappers 应复用本地持久化路径', async () => {
    const taskMove = (service as unknown as { taskMove: TaskMoveService }).taskMove;
    const replaceSpy = vi.spyOn(taskMove, 'replaceChildSubtreeWithUnassignedDurably')
      .mockResolvedValue(success({ detachedSubtreeRootId: null }));
    const assignSpy = vi.spyOn(taskMove, 'assignUnassignedToTaskDurably')
      .mockResolvedValue(success(undefined));

    const replaceResult = await service.replaceChildSubtreeWithUnassignedDurably('source', 'replace-target', 'old-child');
    const assignResult = await service.assignUnassignedToTaskDurably('source', 'assign-target');

    expect(replaceResult.ok).toBe(true);
    expect(assignResult.ok).toBe(true);
    expect(replaceSpy).toHaveBeenCalledWith('source', 'replace-target', 'old-child');
    expect(assignSpy).toHaveBeenCalledWith('source', 'assign-target');
  });

  it('connection durable wrappers 应复用本地持久化路径', async () => {
    project = createProject({
      tasks: [
        createTask({ id: 'task-1', stage: 1 }),
        createTask({ id: 'task-2', stage: 2 }),
        createTask({ id: 'task-3', stage: 1 }),
        createTask({ id: 'task-4', stage: 2 }),
      ],
      connections: [
        {
          id: 'conn-old',
          source: 'task-1',
          target: 'task-2',
          updatedAt: '2026-04-10T00:00:00.000Z',
        },
      ],
    });

    const addSaved = await service.addCrossTreeConnectionDurably('task-3', 'task-4');
    const updateSaved = await service.updateConnectionContentDurably('task-3', 'task-4', '标题', '描述');
    const relinkSaved = await service.relinkCrossTreeConnectionDurably('task-1', 'task-2', 'task-3', 'task-4');
    const removeSaved = await service.removeConnectionDurably('task-3', 'task-4');

    expect(addSaved).toBe(true);
    expect(updateSaved).toBe(true);
    expect(relinkSaved).toBe(true);
    expect(removeSaved).toBe(true);
    expect(recordAndUpdateDurably).toHaveBeenCalledTimes(4);
    expect(project.connections.find(connection => connection.source === 'task-3' && connection.target === 'task-4')).toEqual(
      expect.objectContaining({
        deletedAt: expect.any(String),
      })
    );
  });

  it('updateTaskTitle 和 updateTaskContent 组合清空时应设置默认 title', () => {
    const task = createTask({ id: 'task-combo', title: '有标题', content: '有内容' });
    project = createProject({ tasks: [task] });

    // 先清空 content
    service.updateTaskContent('task-combo', '');
    let updatedTask = project.tasks.find(t => t.id === 'task-combo')!;
    expect(updatedTask.title).toBe('有标题'); // title 还有值，不应修改

    // 再清空 title，此时两者都为空
    service.updateTaskTitle('task-combo', '');
    updatedTask = project.tasks.find(t => t.id === 'task-combo')!;
    expect(updatedTask.title).toBe('新任务'); // 应设置默认值
  });

  it('updateTaskDraftDurably 应在一次本地持久化写入中保存标题和正文', async () => {
    const task = createTask({ id: 'task-draft', title: '旧标题', content: '旧正文' });
    project = createProject({ tasks: [task] });

    const saved = await service.updateTaskDraftDurably('task-draft', {
      title: '新标题',
      content: '- [ ] 新正文',
    });

    expect(saved).toBe(true);
    expect(recordAndUpdateDurably).toHaveBeenCalledTimes(1);
    const updatedTask = project.tasks.find(t => t.id === 'task-draft')!;
    expect(updatedTask).toEqual(expect.objectContaining({
      title: '新标题',
      content: '- [ ] 新正文',
      hasIncompleteTask: true,
      updatedAt: expect.any(String),
    }));
  });

  it('updateTaskDraftDurably 在标题和正文都清空时应保持默认 title', async () => {
    const task = createTask({ id: 'task-empty-draft', title: '旧标题', content: '旧正文' });
    project = createProject({ tasks: [task] });

    const saved = await service.updateTaskDraftDurably('task-empty-draft', {
      title: '',
      content: '',
    });

    expect(saved).toBe(true);
    expect(recordAndUpdateDurably).toHaveBeenCalledTimes(1);
    expect(project.tasks.find(t => t.id === 'task-empty-draft')?.title).toBe('新任务');
  });
});
