import { vi, describe, it, expect, beforeEach } from 'vitest';
import { Injector } from '@angular/core';
import { resolveCreatedTaskTitle, TaskCreationService } from './task-creation.service';
import { LayoutService } from './layout.service';
import { SubtreeOperationsService } from './subtree-operations.service';
import { ProjectStateService } from './project-state.service';
import { TaskRecordTrackingService } from './task-record-tracking.service';
import { LoggerService } from './logger.service';
import { Task, Project } from '../models';
import { ErrorCodes } from '../utils/result';

function createTask(overrides: Partial<Task> = {}): Task {
  const now = new Date().toISOString();
  return {
    id: overrides.id ?? crypto.randomUUID(),
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
    displayId: overrides.displayId ?? '?',
    shortId: overrides.shortId,
    deletedAt: overrides.deletedAt,
    attachments: overrides.attachments,
    tags: overrides.tags,
    priority: overrides.priority,
    dueDate: overrides.dueDate,
  };
}

function createProject(overrides: Partial<Project> = {}): Project {
  const now = new Date().toISOString();
  return {
    id: overrides.id ?? 'proj-1',
    name: overrides.name ?? 'Test Project',
    description: overrides.description ?? '',
    createdDate: overrides.createdDate ?? now,
    tasks: overrides.tasks ?? [],
    connections: overrides.connections ?? [],
    updatedAt: overrides.updatedAt,
    version: overrides.version,
    viewState: overrides.viewState,
  };
}

describe('TaskCreationService', () => {
  let service: TaskCreationService;
  let mockLayoutService: Record<string, ReturnType<typeof vi.fn>>;
  let mockSubtreeOps: Record<string, ReturnType<typeof vi.fn>>;
  let mockProjectState: { activeProject: ReturnType<typeof vi.fn>; getTask: ReturnType<typeof vi.fn> };
  let mockRecorder: {
    recordAndUpdate: ReturnType<typeof vi.fn>;
    recordAndUpdateDebounced: ReturnType<typeof vi.fn>;
    recordAndUpdateDurably: ReturnType<typeof vi.fn>;
  };
  let mockLoggerCategory: { warn: ReturnType<typeof vi.fn> };
  let project: Project;
  let lastMutator: ((p: Project) => Project) | null;
  let lastDurableMutator: ((p: Project) => Project) | null;

  beforeEach(() => {
    lastMutator = null;
    lastDurableMutator = null;

    mockLayoutService = {
      getSmartPosition: vi.fn().mockReturnValue({ x: 100, y: 200 }),
      computeInsertRank: vi.fn().mockReturnValue({ rank: 2000, needsRebalance: false }),
      applyRefusalStrategy: vi.fn().mockReturnValue({ ok: true, rank: 2000 }),
      generateShortId: vi.fn().mockReturnValue('NF-TEST'),
      detectIncomplete: vi.fn().mockReturnValue(false),
      rebalance: vi.fn((p: Project) => p),
      detectCycle: vi.fn().mockReturnValue(false),
      isStageRebalancing: vi.fn().mockReturnValue(false),
    };

    mockSubtreeOps = {
      validateParentChildStageConsistency: vi.fn().mockReturnValue({ ok: true }),
      fixSubtreeRanks: vi.fn(),
    };

    project = createProject({
      tasks: [
        createTask({ id: 'root-1', title: 'Root', stage: 1, rank: 1000 }),
        createTask({ id: 'child-1', title: 'Child', stage: 2, parentId: 'root-1', rank: 1500 }),
      ],
      connections: [{ id: 'conn-1', source: 'root-1', target: 'child-1' }],
    });

    mockProjectState = {
      activeProject: vi.fn(() => project),
      getTask: vi.fn((taskId: string) => project?.tasks.find(t => t.id === taskId) ?? null),
    };

    mockRecorder = {
      recordAndUpdate: vi.fn((mutator: (p: Project) => Project) => { lastMutator = mutator; }),
      recordAndUpdateDebounced: vi.fn(),
      recordAndUpdateDurably: vi.fn(async (mutator: (p: Project) => Project) => {
        lastDurableMutator = mutator;
        return true;
      }),
    };
    mockLoggerCategory = { warn: vi.fn() };

    const injector = Injector.create({
      providers: [
        { provide: TaskCreationService, useClass: TaskCreationService },
        { provide: LayoutService, useValue: mockLayoutService },
        { provide: SubtreeOperationsService, useValue: mockSubtreeOps },
        { provide: ProjectStateService, useValue: mockProjectState },
        { provide: TaskRecordTrackingService, useValue: mockRecorder },
        { provide: LoggerService, useValue: { category: () => mockLoggerCategory } },
      ],
    });

    service = injector.get(TaskCreationService);
  });

  describe('addTask', () => {
    it('创建根任务（无父节点）成功返回新任务 ID', async () => {
      const result = await service.addTask({
        title: 'New Task',
        content: 'Some content',
        targetStage: 1,
        parentId: null,
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(typeof result.value).toBe('string');
        expect(result.value.length).toBeGreaterThan(0);
      }
      expect(mockRecorder.recordAndUpdateDurably).toHaveBeenCalledTimes(1);
      expect(mockRecorder.recordAndUpdate).not.toHaveBeenCalled();
      expect(lastDurableMutator).not.toBeNull();
    });

    it('创建子任务时不再写入与 parentId 重复的 shadow connection', async () => {
      const result = await service.addTask({
        title: 'Child Task',
        content: '',
        targetStage: 2,
        parentId: 'root-1',
      });

      expect(result.ok).toBe(true);
      expect(lastDurableMutator).not.toBeNull();
      const updated = lastDurableMutator!(project);
      expect(mockLayoutService['rebalance']).toHaveBeenCalled();
      expect(updated.connections).toEqual(project.connections);
    });

    it('title 和 content 均为空时默认标题为"新任务"', async () => {
      const result = await service.addTask({
        title: '',
        content: '',
        targetStage: 1,
        parentId: null,
      });

      expect(result.ok).toBe(true);
      const updated = lastDurableMutator!(project);
      const newTask = updated.tasks[updated.tasks.length - 1];
      expect(newTask.title).toBe('新任务');
    });

    it('没有活动项目时返回 DATA_NOT_FOUND', async () => {
      mockProjectState.activeProject.mockReturnValue(null);

      const result = await service.addTask({
        title: 'Test',
        content: '',
        targetStage: 1,
        parentId: null,
      });

      expect(result.ok).toBe(false);
    });

    it('阶段正在重平衡时返回 LAYOUT_RANK_CONFLICT', async () => {
      mockLayoutService['isStageRebalancing'].mockReturnValue(true);

      const result = await service.addTask({
        title: 'Test',
        content: '',
        targetStage: 1,
        parentId: null,
      });

      expect(result.ok).toBe(false);
    });

    it('待分配区任务（stage=null）不调用 rebalance', async () => {
      const result = await service.addTask({
        title: 'Floating',
        content: '',
        targetStage: null,
        parentId: null,
      });

      expect(result.ok).toBe(true);
      expect(mockLayoutService['rebalance']).not.toHaveBeenCalled();
      // Verify task was added directly
      const updated = lastDurableMutator!(project);
      const newTask = updated.tasks[updated.tasks.length - 1];
      expect(newTask.stage).toBe(null);
    });

    it('父子阶段一致性校验失败时返回错误', async () => {
      mockSubtreeOps['validateParentChildStageConsistency'].mockReturnValue({
        ok: false,
        error: { code: 'CROSS_BOUNDARY_VIOLATION', message: '跨阶段约束违规' },
      });

      const result = await service.addTask({
        title: 'Bad Child',
        content: '',
        targetStage: 1,
        parentId: 'root-1',
      });

      expect(result.ok).toBe(false);
    });

    it('生成的任务包含 UUID 和 shortId', async () => {
      await service.addTask({
        title: 'Test',
        content: '',
        targetStage: 1,
        parentId: null,
      });

      const updated = lastDurableMutator!(project);
      const newTask = updated.tasks[updated.tasks.length - 1];
      expect(newTask.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(newTask.shortId).toBe('NF-TEST');
    });

    it('放置策略拒绝时返回 LAYOUT_NO_SPACE', async () => {
      mockLayoutService['applyRefusalStrategy'].mockReturnValue({ ok: false, rank: 0 });

      const result = await service.addTask({
        title: 'Test',
        content: '',
        targetStage: 1,
        parentId: null,
      });

      expect(result.ok).toBe(false);
    });

    it('默认入口本地持久化失败时返回失败且不提交旧同步路径', async () => {
      mockRecorder.recordAndUpdateDurably.mockResolvedValueOnce(false);

      const result = await service.addTask({
        title: 'Lost?',
        content: '',
        targetStage: null,
        parentId: null,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.OPERATION_FAILED);
      }
      expect(mockRecorder.recordAndUpdateDurably).toHaveBeenCalledTimes(1);
      expect(mockRecorder.recordAndUpdate).not.toHaveBeenCalled();
      expect(lastMutator).toBeNull();
    });
  });

  describe('addTaskDurably', () => {
    it('先写入本地持久化队列，成功后才返回新任务 ID', async () => {
      const result = await service.addTaskDurably({
        title: 'Durable Task',
        content: 'local first',
        targetStage: 1,
        parentId: null,
      });

      expect(result.ok).toBe(true);
      expect(mockRecorder.recordAndUpdateDurably).toHaveBeenCalledTimes(1);
      expect(mockRecorder.recordAndUpdate).not.toHaveBeenCalled();
      expect(lastDurableMutator).not.toBeNull();
      const updated = lastDurableMutator!(project);
      const createdTask = updated.tasks[updated.tasks.length - 1];
      if (result.ok) {
        expect(result.value).toBe(createdTask.id);
      }
      expect(createdTask.title).toBe('Durable Task');
      expect(mockLayoutService['rebalance']).toHaveBeenCalled();
    });

    it('本地持久化失败时返回失败且不提交旧同步路径', async () => {
      mockRecorder.recordAndUpdateDurably.mockResolvedValueOnce(false);

      const result = await service.addTaskDurably({
        title: 'Lost?',
        content: '',
        targetStage: null,
        parentId: null,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCodes.OPERATION_FAILED);
      }
      expect(mockRecorder.recordAndUpdateDurably).toHaveBeenCalledTimes(1);
      expect(mockRecorder.recordAndUpdate).not.toHaveBeenCalled();
      expect(lastMutator).toBeNull();
    });
  });

  describe('addFloatingTask', () => {
    it('创建浮动任务，使用指定坐标', async () => {
      const saved = await service.addFloatingTask('Float', 'Content', 300, 400);

      expect(saved).toBe(true);
      expect(mockRecorder.recordAndUpdateDurably).toHaveBeenCalledTimes(1);
      expect(mockRecorder.recordAndUpdate).not.toHaveBeenCalled();
      expect(lastDurableMutator).not.toBeNull();
      const updated = lastDurableMutator!(project);
      const newTask = updated.tasks[updated.tasks.length - 1];
      expect(newTask.stage).toBe(null);
      expect(newTask.parentId).toBe(null);
      expect(newTask.x).toBe(300);
      expect(newTask.y).toBe(400);
      expect(newTask.title).toBe('Float');
    });

    it('没有活动项目时返回 false', async () => {
      mockProjectState.activeProject.mockReturnValue(null);

      const saved = await service.addFloatingTask('Float', '', 0, 0);
      expect(saved).toBe(false);
      expect(lastMutator).toBeNull();
    });

    it('空 title 和 content 默认为"新任务"', async () => {
      await service.addFloatingTask('', '', 0, 0);
      const updated = lastDurableMutator!(project);
      const newTask = updated.tasks[updated.tasks.length - 1];
      expect(newTask.title).toBe('新任务');
    });

    it('默认入口本地持久化失败时返回 false 且不提交旧同步路径', async () => {
      mockRecorder.recordAndUpdateDurably.mockResolvedValueOnce(false);

      const saved = await service.addFloatingTask('Float', '', 0, 0);

      expect(saved).toBe(false);
      expect(mockRecorder.recordAndUpdateDurably).toHaveBeenCalledTimes(1);
      expect(mockRecorder.recordAndUpdate).not.toHaveBeenCalled();
      expect(lastMutator).toBeNull();
    });
  });

  describe('addFloatingTaskDurably', () => {
    it('通过本地持久化路径创建浮动任务', async () => {
      const saved = await service.addFloatingTaskDurably('Durable Float', 'Content', 300, 400);

      expect(saved).toBe(true);
      expect(mockRecorder.recordAndUpdateDurably).toHaveBeenCalledTimes(1);
      expect(mockRecorder.recordAndUpdate).not.toHaveBeenCalled();
      expect(lastDurableMutator).not.toBeNull();
      const updated = lastDurableMutator!(project);
      const newTask = updated.tasks[updated.tasks.length - 1];
      expect(newTask.stage).toBe(null);
      expect(newTask.parentId).toBe(null);
      expect(newTask.x).toBe(300);
      expect(newTask.y).toBe(400);
      expect(newTask.title).toBe('Durable Float');
    });

    it('本地持久化失败时返回 false 且不提交旧同步路径', async () => {
      mockRecorder.recordAndUpdateDurably.mockResolvedValueOnce(false);

      const saved = await service.addFloatingTaskDurably('Float', '', 0, 0);

      expect(saved).toBe(false);
      expect(mockRecorder.recordAndUpdateDurably).toHaveBeenCalledTimes(1);
      expect(mockRecorder.recordAndUpdate).not.toHaveBeenCalled();
      expect(lastMutator).toBeNull();
    });
  });

  describe('copyTask', () => {
    it('默认入口通过本地持久化路径复制任务，标题添加"(副本)"后缀', async () => {
      const newId = await service.copyTask('root-1', '');

      expect(newId).toBeTruthy();
      expect(typeof newId).toBe('string');
      expect(mockRecorder.recordAndUpdateDurably).toHaveBeenCalledTimes(1);
      expect(mockRecorder.recordAndUpdate).not.toHaveBeenCalled();
      const updated = lastDurableMutator!(project);
      const copied = updated.tasks[updated.tasks.length - 1];
      expect(copied.title).toBe('Root (副本)');
      expect(copied.stage).toBe(1);
      expect(copied.content).toBe('');
    });

    it('复制任务时使用自定义标题', async () => {
      const newId = await service.copyTask('root-1', 'Custom Title');

      expect(newId).toBeTruthy();
      const updated = lastDurableMutator!(project);
      const copied = updated.tasks[updated.tasks.length - 1];
      expect(copied.title).toBe('Custom Title');
    });

    it('没有活动项目时返回 null', async () => {
      mockProjectState.activeProject.mockReturnValue(null);

      const result = await service.copyTask('root-1', 'Copy');
      expect(result).toBeNull();
    });

    it('任务不存在时返回 null', async () => {
      const result = await service.copyTask('nonexistent', 'Copy');
      expect(result).toBeNull();
    });

    it('复制待分配区任务不调用 rebalance', async () => {
      project.tasks.push(createTask({ id: 'float-1', title: 'Float', stage: null }));

      await service.copyTask('float-1', '');

      expect(mockLayoutService['rebalance']).not.toHaveBeenCalled();
    });

    it('rank 放置失败时使用 Logger 记录并回退 candidateRank', async () => {
      mockLayoutService['applyRefusalStrategy'].mockReturnValue({ ok: false, rank: 0 });
      mockLayoutService['computeInsertRank'].mockReturnValue({ rank: 3000, needsRebalance: false });

      const newId = await service.copyTask('root-1', '');

      expect(newId).toBeTruthy();
      expect(mockLoggerCategory.warn).toHaveBeenCalledWith(
        'copyTask: rank 分配失败，使用 candidateRank',
        expect.objectContaining({ candidateRank: 3000 }),
      );
      const updated = lastDurableMutator!(project);
      expect(updated.tasks[updated.tasks.length - 1].rank).toBe(3000);
    });

    it('本地持久化失败时返回 null 且不提交旧同步路径', async () => {
      mockRecorder.recordAndUpdateDurably.mockResolvedValueOnce(false);

      const newId = await service.copyTask('root-1', '');

      expect(newId).toBeNull();
      expect(mockRecorder.recordAndUpdateDurably).toHaveBeenCalledTimes(1);
      expect(mockRecorder.recordAndUpdate).not.toHaveBeenCalled();
      expect(lastMutator).toBeNull();
    });
  });
});

describe('resolveCreatedTaskTitle', () => {
  it('uses the fallback title only when title and content are both blank', () => {
    expect(resolveCreatedTaskTitle('', '')).toBe('新任务');
    expect(resolveCreatedTaskTitle('   ', '  \n')).toBe('新任务');
  });

  it('preserves a blank title when content exists', () => {
    expect(resolveCreatedTaskTitle('', 'body')).toBe('');
  });

  it('preserves a provided title', () => {
    expect(resolveCreatedTaskTitle('Task', '')).toBe('Task');
  });
});
